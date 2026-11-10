#include "sdlog_stm32.h"

#include "board.h"
#include "board_bringup.h"
#include "board_devbus.h"
#include "board_spi.h"
#include "cmsis_os2.h"
#include "dev_sdnand.h"

#define HOLD_MS 20U /* bus lock wait for one SD command */
#define START_BUDGET_MS (BOARD_SD_INIT_MS + 500U)

static sdlog_t backup;
static osMutexId_t mutex;
static sdnand_card_t card;

/* ---- the SD bus: CS held by hold()/release(), xfer never touches it ---- */

static uint32_t deadline_for(uint16_t n) {
    uint32_t hz = board_spi_clock_hz(BOARD_SPI_NAND);
    return board_now_ms() + BOARD_DEVBUS_FRAME_MS +
           (hz ? (uint32_t)n * 8000U / hz + 1U : 0U);
}

static int sd_xfer(void* ctx, const uint8_t* tx, uint8_t* rx, uint16_t len) {
    (void)ctx;
    return board_spi_shift(BOARD_SPI_NAND, tx, rx, len, deadline_for(len)) ==
                   BOARD_SPI_OK
               ? DEV_OK
               : DEV_ERR_BUS;
}

static void sd_delay(void* ctx, uint32_t ms) {
    (void)ctx;
    osDelay(ms + 1U); /* osDelay(n) can be up to one tick short */
}

static int sd_hold(void* ctx) {
    (void)ctx;
    board_spi_status_t st =
        board_spi_lock(BOARD_SPI_NAND, board_now_ms() + HOLD_MS);
    if (st != BOARD_SPI_OK) {
        return st == BOARD_SPI_TIMEOUT ? DEV_ERR_TIMEOUT : DEV_ERR_BUS;
    }
    board_spi_select(BOARD_SPI_NAND);
    return DEV_OK;
}

static void sd_release(void* ctx) {
    (void)ctx;
    board_spi_deselect(BOARD_SPI_NAND);
    (void)board_spi_shift(BOARD_SPI_NAND, NULL, NULL, 1, deadline_for(1));
    board_spi_unlock(BOARD_SPI_NAND);
}

static const sdnand_bus_t bus = {{sd_xfer, sd_delay, NULL}, sd_hold,
                                 sd_release};

/* ---- emmc_port_t ------------------------------------------------------ */

static emmc_status_t status(int st) {
    switch (st) {
        case DEV_OK: return EMMC_OK;
        case DEV_ERR_TIMEOUT: return EMMC_ERR_TIMEOUT;
        case DEV_ERR_PARAM: return EMMC_ERR_PARAM;
        default: return EMMC_ERR_IO;
    }
}

/* Initialize at <= 400 kHz (the self-test probe), then data at 25 MHz. */
static emmc_status_t port_start(void* ctx, uint32_t* blocks) {
    (void)ctx;
    if (board_spi_set_max_hz(BOARD_SPI_NAND, SD_INIT_MAX_HZ,
                             board_now_ms() + HOLD_MS) != BOARD_SPI_OK ||
        board_sd_nand_probe(START_BUDGET_MS).result != SELF_TEST_PASS ||
        board_spi_set_max_hz(BOARD_SPI_NAND, SD_DEFAULT_SPEED_MAX_HZ,
                             board_now_ms() + HOLD_MS) != BOARD_SPI_OK) {
        return EMMC_ERR_NOT_READY;
    }
    int st = sdnand_prepare(&bus, &card);
    *blocks = card.block_count;
    return status(st);
}

static emmc_status_t port_read(void* ctx, uint32_t lba, void* buf,
                               uint32_t count, uint32_t budget_ms) {
    (void)ctx;
    (void)budget_ms; /* the driver bounds each block (SD_READ_TIMEOUT_MS) */
    int st = DEV_OK;
    for (uint32_t i = 0; st == DEV_OK && i < count; ++i) {
        st = sdnand_read_block(&bus, &card, lba + i,
                               (uint8_t*)buf + i * SD_BLOCK_SIZE);
    }
    return status(st);
}

static emmc_status_t port_write(void* ctx, uint32_t lba, const void* buf,
                                uint32_t count, uint32_t budget_ms) {
    (void)ctx;
    (void)budget_ms;
    return status(sdnand_write_blocks(&bus, &card, lba, buf, count));
}

static void port_lock(void* ctx) {
    (void)ctx;
    (void)osMutexAcquire(mutex, osWaitForever);
}

static void port_unlock(void* ctx) {
    (void)ctx;
    (void)osMutexRelease(mutex);
}

/* ---- public ------------------------------------------------------------- */

bool sdlog_stm32_init(void) {
    static const emmc_port_t port = {port_start, port_read, port_write,
                                     port_lock, port_unlock};
    mutex = osMutexNew(NULL);
    return mutex && sdlog_init(&backup, &port, NULL);
}

sdlog_t* sdlog_stm32_log(void) {
    return &backup;
}

void sdlog_stm32_task(void* argument) {
    (void)argument;
    for (;;) {
        (void)sdlog_service(&backup, osKernelGetTickCount());
        if (sdlog_backlog(&backup) == 0U) {
            osDelay(10U);
        }
    }
}
