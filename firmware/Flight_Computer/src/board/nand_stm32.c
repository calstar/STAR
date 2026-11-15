/*
 * emmc_port_t on SPI4 for U10, the ZDSD01GLGEAG SD NAND, in SD SPI mode.
 *
 * Datasheet facts this file relies on (Zetta ZDSD01G/02G/04G, LCSC C2830323):
 *   - SD 2.0 compliant; 1 Gbit SLC with its own controller (ECC, wear
 *     levelling): the MCU sees 512-byte blocks, like the eMMC (pp. 1-2).
 *   - SPI mode: CS low during CMD0; >= 74 clocks with CS high after power-up
 *     (p. 16, 8.1). Init flow CMD0, CMD8, ACMD41, CMD58 (p. 9, 6.2.2).
 *   - Up to 50 MHz in SD mode; SPI mode runs default speed (<= 25 MHz). We
 *     use <= 8 MHz: ~1 MB/s, ~35x what the log needs (~28 kB/s).
 *   - Single-block erase is not allowed (CSD ERASE_BLK_EN, p. 14). The log
 *     never erases: it only ever writes forward.
 *   - 15-30 mA reading or writing, 150 uA standby (p. 10).
 *
 * The SD protocol pieces (frames, CRCs, CSD) are portable and host-tested
 * in src/chips/sd_spi.c. This file moves the bytes over board_spi.
 */
#include "nand_stm32.h"

#include <string.h>

#include "FreeRTOS.h"
#include "board.h"
#include "board_spi.h"
#include "board_time.h"
#include "cmsis_os2.h"
#include "main.h"
#include "sd_spi.h"
#include "task.h"

extern SPI_HandleTypeDef hspi4;

#define DEV BOARD_SPI_NAND
#define LOG_CHUNKS 3U         /* 48 KB: ~1.7 s of NAND stall at ~28 kB/s */
#define DATA_MAX_HZ 8000000UL /* SPI4 after init */
#define INIT_MAX_HZ 400000UL  /* identification */
#define INIT_MS 1000U         /* ACMD41 loop (SD spec: 1 s) */
#define TOKEN_TRIES 2000U     /* bytes to wait for a read data token */
#define DATA_START 2048UL     /* 1 MB: the log starts here, check gap below */

/* Not DMA buffers (SPI here is polled), but DTCM is tight: AXI SRAM. */
static emmc_log_chunk_t chunks[LOG_CHUNKS] BOARD_DMA_BUFFER;
static uint8_t scratch[EMMC_BLOCK_SIZE] BOARD_DMA_BUFFER;
static uint8_t read_buf[EMMC_BLOCK_SIZE] BOARD_DMA_BUFFER;

static emmc_log_t flight_log;
static osMutexId_t queue_mutex;
static bool block_addressed; /* SDHC (OCR CCS): LBA, else byte address */
static osMutexId_t call_lock;
static osSemaphoreId_t call_done;
static void (*volatile call_fn)(void* ctx);
static void* volatile call_ctx;
static osThreadId_t writer;
#define EV_CALL 1U

/* ---- SPI4 clock ---------------------------------------------------------- */

/* Slowest prescaler code whose SCK is <= max_hz (H7 MBR: divide by
 * 2^(code+1)). SPI must be disabled to change CFG1; HAL leaves it so. */
static void set_clock(uint32_t max_hz) {
    uint32_t kernel = HAL_RCCEx_GetPeriphCLKFreq(RCC_PERIPHCLK_SPI45);
    uint32_t code = 0;
    while (code < 7U && (kernel >> (code + 1U)) > max_hz) {
        ++code;
    }
    __HAL_SPI_DISABLE(&hspi4);
    MODIFY_REG(hspi4.Instance->CFG1, SPI_CFG1_MBR, code << SPI_CFG1_MBR_Pos);
    hspi4.Init.BaudRatePrescaler = code << SPI_CFG1_MBR_Pos;
}

/* ---- SD commands, caller holds the bus lock ------------------------------ */

static bool byte_in(uint8_t* b, uint32_t deadline) {
    return board_spi_shift(DEV, NULL, b, 1, deadline) == BOARD_SPI_OK;
}

/* MISO held low while the card programs; wait for it to let go. */
static bool wait_ready(uint32_t deadline) {
    uint8_t b = 0;
    for (uint32_t n = 0;; ++n) {
        if (!byte_in(&b, deadline)) {
            return false;
        }
        if (b == 0xFFU) {
            return true;
        }
        if ((n & 255U) == 255U) {
            osDelay(1U); /* long programs: let other low tasks run */
        }
    }
}

/* CS low, wait ready, frame, R1. CS stays low: the caller ends with end(). */
static bool command(uint8_t index, uint32_t arg, uint8_t* r1,
                    uint32_t deadline) {
    uint8_t frame[6];
    sd_command_frame(frame, index, arg);
    board_spi_select(DEV);
    *r1 = 0xFF;
    if (index != SD_CMD0_GO_IDLE && !wait_ready(deadline)) {
        return false;
    }
    if (board_spi_shift(DEV, frame, NULL, 6, deadline) != BOARD_SPI_OK) {
        return false;
    }
    if (index == SD_CMD12_STOP_TRANSMISSION && !byte_in(r1, deadline)) {
        return false; /* a stuff byte follows CMD12 */
    }
    for (int i = 0; i < 10 && !sd_is_r1(*r1); ++i) {
        if (!byte_in(r1, deadline)) {
            return false;
        }
    }
    return sd_is_r1(*r1);
}

static void end(uint32_t deadline) {
    board_spi_deselect(DEV);
    (void)board_spi_shift(DEV, NULL, NULL, 1, deadline); /* 8 clocks */
}

/* One command with R1 (and extra_len more response bytes), CS released. */
static bool simple(uint8_t index, uint32_t arg, uint8_t* r1, uint8_t* extra,
                   uint8_t extra_len, uint32_t deadline) {
    bool ok = command(index, arg, r1, deadline);
    if (ok && extra_len) {
        ok = board_spi_shift(DEV, NULL, extra, extra_len, deadline) ==
             BOARD_SPI_OK;
    }
    end(deadline);
    return ok;
}

/* After R1: the 0xFE token, len bytes, CRC16 (checked). */
static bool data_in(uint8_t* out, uint16_t len, uint32_t deadline) {
    uint8_t token = 0xFF, crc[2];
    for (uint32_t i = 0; i < TOKEN_TRIES && token == 0xFFU; ++i) {
        if (!byte_in(&token, deadline)) {
            return false;
        }
    }
    if (token != SD_DATA_TOKEN ||
        board_spi_shift(DEV, NULL, out, len, deadline) != BOARD_SPI_OK ||
        board_spi_shift(DEV, NULL, crc, 2, deadline) != BOARD_SPI_OK) {
        return false;
    }
    return sd_crc16(out, len) == (uint16_t)(crc[0] << 8 | crc[1]);
}

static uint32_t address(uint32_t lba) {
    return block_addressed ? lba : lba * EMMC_BLOCK_SIZE;
}

/* ---- the port ------------------------------------------------------------ */

static emmc_status_t port_start(void* context, uint32_t* block_count) {
    (void)context;
    uint32_t deadline = board_now_ms() + 3000U;
    if (board_spi_lock(DEV, deadline) != BOARD_SPI_OK) {
        return EMMC_ERR_TIMEOUT;
    }
    emmc_status_t st = EMMC_ERR_IO;
    uint8_t r1, r7[4], ocr[4], csd[16];
    set_clock(INIT_MAX_HZ);
    (void)board_spi_idle_clocks(DEV, 10, deadline); /* >= 74 clocks, CS high */
    bool ok = false;
    for (int i = 0; i < 5 && !ok; ++i) {
        ok = simple(SD_CMD0_GO_IDLE, 0, &r1, NULL, 0, deadline) &&
             r1 == SD_R1_IDLE;
    }
    if (!ok ||
        !simple(SD_CMD8_SEND_IF_COND, SD_CMD8_ARG, &r1, r7, 4, deadline) ||
        r1 != SD_R1_IDLE || !sd_r7_ok(r7)) {
        goto done;
    }
    uint32_t init_end = board_now_ms() + INIT_MS;
    do {
        if (simple(SD_CMD55_APP_CMD, 0, &r1, NULL, 0, deadline) &&
            (r1 & ~SD_R1_IDLE) == 0U &&
            simple(SD_ACMD41_SD_SEND_OP_COND, SD_ACMD41_HCS, &r1, NULL, 0,
                   deadline) &&
            r1 == 0x00U) {
            break;
        }
        osDelay(10U);
    } while (!board_deadline_passed(init_end));
    if (r1 != 0x00U || !simple(SD_CMD58_READ_OCR, 0, &r1, ocr, 4, deadline) ||
        r1 != 0x00U) {
        st = EMMC_ERR_TIMEOUT;
        goto done;
    }
    block_addressed = (ocr[0] & 0x40U) != 0U; /* OCR bit 30, CCS */
    if (!block_addressed && (!simple(SD_CMD16_SET_BLOCKLEN, EMMC_BLOCK_SIZE,
                                     &r1, NULL, 0, deadline) ||
                             r1 != 0x00U)) {
        goto done;
    }
    ok = command(SD_CMD9_SEND_CSD, 0, &r1, deadline) && r1 == 0x00U &&
         data_in(csd, sizeof csd, deadline);
    end(deadline);
    if (!ok || (*block_count = sd_csd_blocks(csd)) == 0U) {
        goto done;
    }
    st = EMMC_OK;
done:
    set_clock(st == EMMC_OK ? DATA_MAX_HZ : INIT_MAX_HZ);
    board_spi_unlock(DEV);
    return st;
}

static emmc_status_t port_read(void* context, uint32_t lba, void* buffer,
                               uint32_t count, uint32_t budget_ms) {
    (void)context;
    if (count == 0U || !buffer) {
        return EMMC_ERR_PARAM;
    }
    uint32_t deadline = board_now_ms() + budget_ms;
    if (board_spi_lock(DEV, deadline) != BOARD_SPI_OK) {
        return EMMC_ERR_TIMEOUT;
    }
    uint8_t r1, *out = buffer;
    bool multi = count > 1U;
    bool ok = command(multi ? SD_CMD18_READ_MULTIPLE_BLOCK
                            : SD_CMD17_READ_SINGLE_BLOCK,
                      address(lba), &r1, deadline) &&
              r1 == 0x00U;
    for (uint32_t i = 0; ok && i < count; ++i) {
        ok = data_in(out + i * EMMC_BLOCK_SIZE, EMMC_BLOCK_SIZE, deadline);
    }
    if (multi) {
        uint8_t r1_stop;
        end(deadline);
        ok = simple(SD_CMD12_STOP_TRANSMISSION, 0, &r1_stop, NULL, 0,
                    deadline) &&
             ok;
    } else {
        end(deadline);
    }
    board_spi_unlock(DEV);
    if (ok) {
        return EMMC_OK;
    }
    return board_deadline_passed(deadline) ? EMMC_ERR_TIMEOUT : EMMC_ERR_IO;
}

static emmc_status_t port_write(void* context, uint32_t lba, const void* buffer,
                                uint32_t count, uint32_t budget_ms) {
    (void)context;
    if (count == 0U || !buffer) {
        return EMMC_ERR_PARAM;
    }
    uint32_t deadline = board_now_ms() + budget_ms;
    if (board_spi_lock(DEV, deadline) != BOARD_SPI_OK) {
        return EMMC_ERR_TIMEOUT;
    }
    const uint8_t* in = buffer;
    bool multi = count > 1U;
    uint8_t r1, resp = 0xFF, gap = 0xFF;
    uint8_t token = multi ? SD_MULTI_WRITE_TOKEN : SD_DATA_TOKEN;
    bool ok =
        command(multi ? SD_CMD25_WRITE_MULTIPLE_BLOCK : SD_CMD24_WRITE_BLOCK,
                address(lba), &r1, deadline) &&
        r1 == 0x00U &&
        board_spi_shift(DEV, &gap, NULL, 1, deadline) == BOARD_SPI_OK;
    for (uint32_t i = 0; ok && i < count; ++i) {
        const uint8_t* block = in + i * EMMC_BLOCK_SIZE;
        uint16_t crc = sd_crc16(block, EMMC_BLOCK_SIZE);
        uint8_t crc_bytes[2] = {(uint8_t)(crc >> 8), (uint8_t)crc};
        ok = board_spi_shift(DEV, &token, NULL, 1, deadline) == BOARD_SPI_OK &&
             board_spi_shift(DEV, block, NULL, EMMC_BLOCK_SIZE, deadline) ==
                 BOARD_SPI_OK &&
             board_spi_shift(DEV, crc_bytes, NULL, 2, deadline) ==
                 BOARD_SPI_OK &&
             byte_in(&resp, deadline) && sd_data_accepted(resp) &&
             wait_ready(deadline);
    }
    if (multi && r1 == 0x00U) {
        uint8_t stop = SD_STOP_TRAN_TOKEN;
        bool stopped =
            board_spi_shift(DEV, &stop, NULL, 1, deadline) == BOARD_SPI_OK &&
            board_spi_shift(DEV, NULL, NULL, 1, deadline) == BOARD_SPI_OK &&
            wait_ready(deadline);
        ok = ok && stopped;
    }
    end(deadline);
    /* CMD13: R2's second byte is 0 when programming went through. */
    uint8_t status = 0xFF;
    ok = simple(SD_CMD13_SEND_STATUS, 0, &r1, &status, 1, deadline) && ok &&
         r1 == 0x00U && status == 0x00U;
    board_spi_unlock(DEV);
    if (ok) {
        return EMMC_OK;
    }
    return board_deadline_passed(deadline) ? EMMC_ERR_TIMEOUT : EMMC_ERR_IO;
}

static void port_lock(void* context) {
    (void)context;
    (void)osMutexAcquire(queue_mutex, osWaitForever);
}

static void port_unlock(void* context) {
    (void)context;
    (void)osMutexRelease(queue_mutex);
}

static const emmc_port_t port = {port_start, port_read, port_write, port_lock,
                                 port_unlock};

/* ---- public -------------------------------------------------------------- */

emmc_status_t nand_stm32_init(void) {
    queue_mutex = osMutexNew(NULL);
    call_lock = osMutexNew(NULL);
    call_done = osSemaphoreNew(1U, 0U, NULL);
    if (!queue_mutex || !call_lock || !call_done) {
        return EMMC_ERR_NOT_READY;
    }
    emmc_log_config_t config = emmc_log_default_config();
    config.data_start_lba = DATA_START;
    return emmc_log_init(&flight_log, &port, NULL, &config, chunks, LOG_CHUNKS,
                         scratch);
}

emmc_log_t* nand_stm32_log(void) {
    return &flight_log;
}

/* Run fn in the writer task between transfers (as emmc_stm32_call). */
static bool call(void (*fn)(void* ctx), void* ctx) {
    if (!writer || !call_lock) {
        return false;
    }
    (void)osMutexAcquire(call_lock, osWaitForever);
    (void)osSemaphoreAcquire(call_done, 0U);
    call_ctx = ctx;
    call_fn = fn;
    (void)osThreadFlagsSet(writer, EV_CALL);
    bool ok = osSemaphoreAcquire(call_done, 4000U) == osOK;
    if (!ok) {
        taskENTER_CRITICAL();
        ok = call_fn == NULL;
        call_fn = NULL;
        taskEXIT_CRITICAL();
    }
    (void)osMutexRelease(call_lock);
    return ok;
}

static struct {
    emmc_status_t st;
    uint32_t start, max, k;
    uint32_t *n, *total;
    emmc_log_session_t* out;
    uint8_t* block;
    uint32_t seed, elapsed_ms;
    emmc_log_check_t check;
} req;

static void do_open(void* ctx) {
    (void)ctx;
    req.st = emmc_log_open(&flight_log);
}

static void do_sessions(void* ctx) {
    (void)ctx;
    req.st = emmc_log_sessions(&flight_log, req.start, req.out, req.max, req.n,
                               req.total);
}

static void do_read(void* ctx) {
    (void)ctx;
    req.st = emmc_log_read(&flight_log, req.k, read_buf);
    if (req.st == EMMC_OK) {
        memcpy(req.block, read_buf, EMMC_BLOCK_SIZE);
    }
}

static void do_wipe(void* ctx) {
    (void)ctx;
    req.st = emmc_log_wipe(&flight_log);
}

static void do_check(void* ctx) {
    (void)ctx;
    uint32_t t0 = osKernelGetTickCount();
    req.st = emmc_log_check(&flight_log, req.seed, &req.check);
    req.elapsed_ms = osKernelGetTickCount() - t0;
}

static emmc_status_t run(void (*fn)(void* ctx)) {
    req.st = EMMC_ERR_TIMEOUT;
    return call(fn, NULL) ? req.st : EMMC_ERR_TIMEOUT;
}

emmc_status_t nand_stm32_open(void) {
    return run(do_open);
}

emmc_status_t nand_stm32_sessions(uint32_t start, emmc_log_session_t* out,
                                  uint32_t max, uint32_t* n, uint32_t* total) {
    req.start = start;
    req.out = out;
    req.max = max;
    req.n = n;
    req.total = total;
    return run(do_sessions);
}

emmc_status_t nand_stm32_read(uint32_t k, uint8_t out[EMMC_BLOCK_SIZE]) {
    req.k = k;
    req.block = out;
    return run(do_read);
}

emmc_status_t nand_stm32_wipe(void) {
    return run(do_wipe);
}

emmc_status_t nand_stm32_check(uint32_t seed, emmc_log_check_t* out,
                               uint32_t* elapsed_ms) {
    req.seed = seed;
    req.elapsed_ms = 0;
    emmc_status_t st = run(do_check);
    *out = req.check;
    *elapsed_ms = req.elapsed_ms;
    return st;
}

void nand_stm32_writer_task(void* argument) {
    (void)argument;
    writer = osThreadGetId();
    for (;;) {
        (void)emmc_log_service(&flight_log, osKernelGetTickCount());
        void (*fn)(void* ctx) = call_fn;
        if (fn) {
            fn(call_ctx);
            call_fn = NULL;
            (void)osSemaphoreRelease(call_done);
        }
        if (emmc_log_backlog(&flight_log) == 0U) {
            (void)osThreadFlagsWait(EV_CALL, osFlagsWaitAny, 10U);
        }
    }
}
