#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cmsis_os2.h"
#include "health_task.h"
#include "radio_task.h"
#include "selftest_radio.h"
#define CHECK(x)                                       \
    do {                                               \
        if (!(x)) {                                    \
            fprintf(stderr, "%d: %s\n", __LINE__, #x); \
            abort();                                   \
        }                                              \
    } while (0)
static uint32_t clock_ms;
static unsigned feeds, starts, depth;
static bool allocate = true, watchdog_ok = true;
static void (*worker)(void*);
static jmp_buf task_return;
static bool delay_returns; /* osDelay: true = plain wait, false = end pass */
static unsigned reads, records;
static rec_health_t recorded;
static uint32_t interval_ms = 100;
uint32_t board_now_ms(void) {
    return clock_ms;
}
uint32_t board_time_us(void) {
    return clock_ms * 1000U;
}
bool health_board_read(health_inputs_t* in) {
    ++reads;
    memset(in, 0, sizeof(*in));
    in->valid[0] = true;
    in->counts[0] = 49343; /* 7999 mV */
    return true;
}
void health_board_record(void* ctx, uint8_t type, const void* data,
                         uint8_t len) {
    (void)ctx;
    CHECK(type == REC_HEALTH && len == sizeof recorded);
    memcpy(&recorded, data, len);
    ++records;
}
uint32_t health_board_interval_ms(void) {
    return interval_ms;
}
uint32_t health_board_clock_ms(void) {
    return clock_ms;
}
static radio_send_result_t radio_results[8];
static unsigned radio_calls;
static uint8_t radio_type, radio_payload[4];
radio_send_result_t radio_task_send_frame(uint8_t type, const uint8_t* payload,
                                          uint8_t len) {
    CHECK(len == 4 && radio_calls < 8);
    radio_type = type;
    memcpy(radio_payload, payload, len);
    clock_ms += 400; /* SF9 TxDone */
    return radio_results[radio_calls++];
}
bool board_watchdog_start(void) {
    ++starts;
    return watchdog_ok;
}
void board_watchdog_refresh(void) {
    ++feeds;
}
void fake_enter(void) {
    ++depth;
}
void fake_exit(void) {
    CHECK(depth > 0);
    --depth;
}
uint32_t osKernelGetTickFreq(void) {
    return 1000;
}
osThreadId_t osThreadNew(void (*fn)(void*), void* arg,
                         const osThreadAttr_t* attr) {
    CHECK(!arg && attr->stack_size >= 1024);
    worker = fn;
    return allocate ? (void*)1 : NULL;
}
void osDelay(uint32_t ticks) {
    CHECK(depth == 0);
    clock_ms += ticks;
    if (!delay_returns)
        longjmp(task_return, 1);
}
static void once(void) {
    CHECK(worker);
    if (!setjmp(task_return))
        worker(NULL);
}
static void beat(void) {
    for (unsigned i = 0; i < HEALTH_COUNT; ++i)
        health_task_beat((health_id_t)i);
}
static void health_test(void) {
    health_task_init();
    CHECK(!health_task_prepare_sleep(10000));
    CHECK(health_task_start() && starts == 1);
    once();
    CHECK(feeds == 1);
    clock_ms = 1000;
    beat();
    CHECK(health_task_prepare_sleep(10000));
    CHECK(feeds == 2);
    /* HAL stopped for 10 seconds. resume must advance monitor time once. */
    CHECK(health_task_resume(10000));
    CHECK(feeds == 3);
    /* Without the RTC offset, health_resume sees zero elapsed time. The
     * next beat would incorrectly keep the pre-sleep age; force that case. */
    clock_ms = 1500;
    beat();
    once();
    CHECK(feeds == 4);
    CHECK(!health_task_resume(10000));
    CHECK(feeds == 4);
    clock_ms = 6500;
    once();
    CHECK(feeds == 4);
    CHECK(health_task_faults() == HEALTH_ALL);
    beat();
    once();
    CHECK(feeds == 4);  // faults stay latched
    CHECK(!health_task_prepare_sleep(10000));
    health_task_init();
    CHECK(health_task_start());
    CHECK(health_task_prepare_sleep(10000));
    unsigned before = feeds;
    CHECK(!health_task_resume(11001));
    CHECK(feeds == before);
    health_task_init();
    CHECK(health_task_start());
    CHECK(health_task_prepare_sleep(10000));
    clock_ms += 200;  // HAL ran during entry/exit
    CHECK(health_task_resume(1000));
    beat();
    once();
    CHECK(health_task_faults() == 0);
    health_task_init();
    CHECK(health_task_start());
    CHECK(health_task_prepare_sleep(10000));
    clock_ms += 200;
    before = feeds;
    CHECK(!health_task_resume(100));
    CHECK(feeds == before);
    CHECK(health_task_faults() == HEALTH_ALL);
    health_task_init();
    CHECK(health_task_start());
    CHECK(health_task_prepare_sleep(1000));
    before = feeds;
    CHECK(!health_task_resume(2001)); /* shorter requested sleep deadline */
    CHECK(feeds == before && health_task_faults() == HEALTH_ALL);
    health_task_init();
    allocate = false;
    before = starts;
    CHECK(!health_task_start() &&
          starts == before + 1);  // hardware still armed
    allocate = true;
    watchdog_ok = false;
    CHECK(!health_task_start());
    CHECK(health_task_faults() == HEALTH_ALL);
}
static void sample_test(void) {
    watchdog_ok = allocate = true;
    clock_ms = 0;
    health_task_init();
    rec_health_t r;
    CHECK(!health_task_latest(&r));
    CHECK(health_task_start());
    reads = records = 0;
    once();
    CHECK(reads == 1 && records == 1);
    CHECK(health_task_latest(&r) && r.battery_mv == 7999 && r.valid == 1);
    CHECK(memcmp(&r, &recorded, sizeof r) == 0);
    beat();
    once(); /* +100 ms: 10 Hz */
    CHECK(reads == 2);
    interval_ms = 5000; /* Idle: once per wake */
    beat();
    once();
    CHECK(reads == 2);
    interval_ms = 100;
    /* A parked worker is not a stall; the rest still must check in. */
    health_task_set_active(HEALTH_SENSORS, false);
    health_task_set_active(HEALTH_GNSS, false);
    unsigned before = feeds;
    for (unsigned i = 0; i < 100; ++i) { /* 10 s */
        health_task_beat(HEALTH_LOG);
        once();
    }
    CHECK(feeds == before + 100 && health_task_faults() == 0);
    health_task_set_active(HEALTH_SENSORS, true);
    for (unsigned i = 0; i < 60; ++i) { /* 6 s without a sensors beat */
        health_task_beat(HEALTH_LOG);
        once();
    }
    CHECK(health_task_faults() == (1U << HEALTH_SENSORS));
    CHECK(recorded.task_faults == (1U << HEALTH_SENSORS));
}
static void radio_test(void) {
    delay_returns = true;
    selftest_radio_t tx;
    /* Radio still configuring, then TxDone. */
    radio_calls = 0;
    radio_results[0] = RADIO_SEND_NO_RADIO;
    radio_results[1] = RADIO_SEND_OK;
    selftest_radio_send(&tx, 0x0155, 7999);
    CHECK(tx.finished && tx.result == SELFTEST_TX_DONE && tx.attempts == 2);
    CHECK(radio_calls == 2 && radio_type == 0x02);
    const uint8_t want[4] = {0x55, 0x01, 0x3F, 0x1F};
    CHECK(memcmp(radio_payload, want, 4) == 0);
    /* No TxDone: three tries, then reported as a timeout. */
    radio_calls = 0;
    for (unsigned i = 0; i < 8; ++i)
        radio_results[i] = RADIO_SEND_TIMEOUT;
    uint32_t t0 = clock_ms;
    selftest_radio_send(&tx, 0, 0);
    CHECK(tx.finished && tx.result == SELFTEST_TX_TIMEOUT);
    CHECK(radio_calls == SELFTEST_RADIO_MAX_ATTEMPTS);
    CHECK(clock_ms - t0 < 3U * 400U + 2U * SELFTEST_RADIO_RETRY_MS + 50U);
    radio_calls = 0;
    for (unsigned i = 0; i < 8; ++i)
        radio_results[i] = RADIO_SEND_BAD_FRAME;
    selftest_radio_send(&tx, 0, 0);
    CHECK(tx.result == SELFTEST_TX_ERROR && radio_calls == 3);
    radio_calls = 0;
    for (unsigned i = 0; i < 8; ++i)
        radio_results[i] = RADIO_SEND_NO_RADIO;
    selftest_radio_send(&tx, 0, 0);
    CHECK(tx.result == SELFTEST_TX_UNAVAILABLE && radio_calls == 3);
    delay_returns = false;
}
int main(void) {
    health_test();
    sample_test();
    radio_test();
    puts("RTOS adapter tests passed");
}
