#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "board.h"
#include "board_spi.h"
#include "cmsis_os2.h"
#include "daq_task.h"
#include "records.h"
#define CHECK(x)                                            \
    do {                                                    \
        if (!(x)) {                                         \
            fprintf(stderr, "line %d: %s\n", __LINE__, #x); \
            abort();                                        \
        }                                                   \
    } while (0)
#include "fake_w5500.h"
static fake_t fake;
static daq_sample_t queue[16];
static unsigned count, put_count, sends, heartbeats, samples_sent, opens;
static uint32_t now, stop_at;
static bool locked, selected, header_received, fail_shift, enabled = true,
                                                           injected;
static bool hold_send, foreign;
static uint8_t hdr[3];
static void (*task)(void*);
static jmp_buf done;
void daq_board_config(daq_config_t* c) {
    *c = (daq_config_t){.enabled = enabled,
                        .board_id = 99,
                        .network = net,
                        .server_ip = {192, 0, 2, 20},
                        .server_port = 5006,
                        .sources = {DAQ_HIGHG_X}};
}
uint32_t board_now_ms(void) {
    return now;
}
bool board_spi_routed(board_spi_device_t d) {
    (void)d;
    return true;
}
uint8_t board_spi_mode(board_spi_device_t d) {
    (void)d;
    return 0;
}
uint32_t board_spi_clock_hz(board_spi_device_t d) {
    (void)d;
    return 16000000;
}
board_spi_status_t board_spi_lock(board_spi_device_t d, uint32_t deadline) {
    (void)d;
    CHECK(!locked && (int32_t)(deadline - now) > 0);
    locked = true;
    return BOARD_SPI_OK;
}
void board_spi_unlock(board_spi_device_t d) {
    (void)d;
    CHECK(locked && !selected);
    locked = false;
}
void board_spi_select(board_spi_device_t d) {
    (void)d;
    CHECK(locked && !selected);
    selected = true;
    header_received = false;
}
void board_spi_deselect(board_spi_device_t d) {
    (void)d;
    CHECK(selected);
    selected = false;
}
board_spi_status_t board_spi_shift(board_spi_device_t d, const uint8_t* tx,
                                   uint8_t* rx, uint16_t n, uint32_t deadline) {
    (void)d;
    CHECK(locked && selected && (int32_t)(deadline - now) > 0);
    if (fail_shift) {
        fail_shift = false;
        return BOARD_SPI_TIMEOUT;
    }
    if (!header_received) {
        CHECK(tx && n == 3 && !rx);
        memcpy(hdr, tx, 3);
        header_received = true;
        return BOARD_SPI_OK;
    }
    bool write = (hdr[2] & 4) != 0;
    CHECK((hdr[2] & 3) == 0);
    uint16_t a = (uint16_t)((uint16_t)hdr[0] << 8 | hdr[1]);
    uint8_t b = hdr[2] >> 3;
    CHECK(write ? tx != NULL && rx == NULL : tx == NULL && rx != NULL);
    if (b == 1 && a == 1 && write && tx[0] == 1)
        ++opens;
    if (b == 1 && a == 1 && write && tx[0] == 0x20) {
        ++sends;
        /* All task test packets fit in the first 2 KiB; find start of the
           most recent write from the pointer and encoded size. */
        unsigned end = read16(fake.socket + 0x24), len = 0;
        if (end >= 41 && fake.tx[(end - 41) % 2048] == 1) {
            ++heartbeats;
            len = 41;
        } else {
            CHECK(end >= 17 && fake.tx[(end - 17) % 2048] == 3);
            ++samples_sent;
            len = 17;
        }
        CHECK(len > 0);
    }
    bool ok = io(&fake, a, b, write, write ? (uint8_t*)tx : rx, n);
    if (b == 1 && a == 1 && write && tx[0] == 0x20 && !hold_send)
        fake.socket[2] |= 0x10;
    return ok ? BOARD_SPI_OK : BOARD_SPI_TIMEOUT;
}
osMessageQueueId_t osMessageQueueNew(uint32_t n, uint32_t size,
                                     const void* attr) {
    (void)attr;
    CHECK(n == 16 && size == sizeof(daq_sample_t));
    count = 0;
    return queue;
}
osStatus_t osMessageQueuePut(osMessageQueueId_t id, const void* p, uint8_t pri,
                             uint32_t timeout) {
    CHECK(id == queue && pri == 0 && timeout == 0);
    if (count == 16)
        return osError;
    queue[count++] = *(const daq_sample_t*)p;
    ++put_count;
    return osOK;
}
osStatus_t osMessageQueueGet(osMessageQueueId_t id, void* p, uint8_t* pri,
                             uint32_t timeout) {
    (void)pri;
    CHECK(id == queue && timeout == 0);
    if (!count)
        return osError;
    *(daq_sample_t*)p = queue[0];
    memmove(queue, queue + 1, --count * sizeof(*queue));
    return osOK;
}
osStatus_t osMessageQueueReset(osMessageQueueId_t id) {
    CHECK(id == queue);
    count = 0;
    return osOK;
}
osStatus_t osMessageQueueDelete(osMessageQueueId_t id) {
    CHECK(id == queue);
    count = 0;
    return osOK;
}
osThreadId_t osThreadNew(void (*fn)(void*), void* arg,
                         const osThreadAttr_t* attr) {
    CHECK(!arg && attr->stack_size >= 2048);
    task = fn;
    return (void*)1;
}
osStatus_t osDelay(uint32_t ticks) {
    CHECK(!locked && !selected);
    now += ticks;
    if (!injected && now >= 10) {
        uint8_t config[] = {5, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0};
        datagram(&fake, 0, config, sizeof(config));
        if (foreign)
            fake.rx[3] = 21;
        injected = true;
    }
    if (now >= 12 && now < 30) {
        rec_highg_t r = {.accel = {-1, 0, 0}};
        daq_record(REC_HIGHG, &r, sizeof(r));
    }
    if (now >= stop_at)
        longjmp(done, 1);
    return osOK;
}
static void run(uint32_t duration) {
    stop_at = now + duration;
    if (!setjmp(done))
        task(NULL);
}
int main(void) {
    /* Disabled builds do not allocate a task or queue. */
    enabled = false;
    CHECK(daq_task_start() && !task);
    daq_sample_t s = {.count = 1, .values = {{1, 42}}};
    CHECK(!daq_publish(&s));
    enabled = true;
    CHECK(daq_task_start() && task);
    for (unsigned i = 0; i < 16; ++i)
        CHECK(daq_publish(&s));
    CHECK(!daq_publish(&s));
    init(&fake, &(w5500_udp_t){0});
    foreign = true;
    run(50);
    CHECK(heartbeats == 1 && samples_sent == 0);
    foreign = false;
    now = 0;
    injected = false;
    heartbeats = 0;
    run(50);
    CHECK(heartbeats == 1 && samples_sent > 0 && put_count > 16);
    /* A bus failure must release CS/mutex and force a bounded reconnect. */
    now = 0;
    injected = false;
    fail_shift = true;
    opens = 0;
    run(1100);
    CHECK(opens > 0 && !locked && !selected);
    /* No SEND_OK must trigger recovery, not stall acquisition forever. */
    now = 0;
    injected = false;
    hold_send = true;
    opens = 0;
    run(2100);
    CHECK(opens >= 2);
    /* Cable absent: no packets sent; queue is drained, task still yields. */
    now = 0;
    injected = false;
    fake.common[0x2e] = 0;
    unsigned before = sends;
    run(2200);
    CHECK(sends == before && count == 0);
    puts(
        "Network task queue, config, send timeout, SPI cleanup and cable-loss "
        "checks passed");
}
