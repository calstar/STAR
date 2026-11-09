/*
 * emmc_port_t on the STM32H723's SDMMC1 for U9 (THGBMTG5D1LBAIL).
 *
 * NOT YET COMPILED (the STM32 build comes with PR #165). On the first build,
 * put the three DMA buffers below in the RAM_D1 section
 * (EMMC-ARCHITECTURE.md section 7, item 5), and verify:
 * HAL_MMC_GetCardExtCSD() exists in FW_H7 V1.13.0, and the generated
 * SDMMC1_IRQHandler calls HAL_MMC_IRQHandler(&hmmc1).
 *
 * Datasheet facts this file relies on (KIOXIA rev 1.0, 2021-10-07):
 *   - Identification at <= 400 kHz; data <= 26 MHz until CMD6 selects
 *     high-speed timing (p. 17). We stay in legacy timing: 129 MHz / (2 x 3)
 *     = 21.5 MHz x 4 bits ~ 10 MB/s, far above the ~60 kB/s the log needs.
 *   - HS200/HS400 need VCCQ = 1.8 V; this board's VCCQ is 3V3, so 52 MHz
 *     SDR/DDR is the ceiling anyway (pp. 2, 12).
 *   - RST_n_FUNCTION (EXT_CSD[162]) ships 0: the RST_n pin is ignored. PA8
 *     is released anyway, in case someone enables it (one-time setting).
 *     tRSCA = 200 us from RST_n high to the first command (p. 26).
 *   - Avoid repeated CMD0/CMD1 init loops: read disturb (p. 28). start() is
 *     called once per power-up by the log.
 *
 * STM32 facts (DS13313): SDMMC1 is an AXI bus master with its own DMA
 * (IDMA, section 3.41, Figure 3), so its buffers must be in AXI SRAM
 * (0x2400_0000), not DTCM; and the Cortex-M7 D-cache must be cleaned before
 * a DMA write and invalidated after a DMA read, on 32-byte lines.
 */
#include "emmc_stm32.h"

#include <string.h>

#include "FreeRTOS.h"
#include "board.h"
#include "cmsis_os2.h"
#include "main.h"
#include "task.h"

extern MMC_HandleTypeDef hmmc1;

#define LEGACY_MAX_HZ 26000000UL
#define AXI_SRAM_START 0x24000000UL
#define AXI_SRAM_END 0x24050000UL /* 320 KB with the default TCM split */
#define LOG_CHUNKS 4U             /* 64 KB: ~1 s of card stall at ~60 kB/s */

/* DMA buffers. They must be in AXI SRAM: CubeMX's GCC script puts .bss in
 * DTCM, which the SDMMC IDMA cannot reach. BOARD_DMA_BUFFER (board.h) puts
 * them in the .dma_buffers NOLOAD section in RAM_D1; start() still checks
 * the addresses. NOLOAD is fine: none of the three is read before it is
 * written. */
static emmc_log_chunk_t chunks[LOG_CHUNKS] BOARD_DMA_BUFFER;
static uint8_t scratch[EMMC_BLOCK_SIZE] BOARD_DMA_BUFFER;
static uint8_t read_buf[EMMC_BLOCK_SIZE] BOARD_DMA_BUFFER; /* USB reads */
static uint32_t ext_csd[EMMC_BLOCK_SIZE / 4U] BOARD_DMA_BUFFER;

static emmc_log_t flight_log;
static osMutexId_t queue_mutex;
static osSemaphoreId_t transfer_done;
static volatile bool transfer_ok;
static emmc_card_info_t card;
static uint32_t card_issues;
static bool card_known;
static osMutexId_t call_lock;
static osSemaphoreId_t call_done;
static void (*volatile call_fn)(void* ctx);
static void* volatile call_ctx;
static osThreadId_t writer;
#define EV_CALL 1U

/* ---- helpers ---------------------------------------------------------- */

static bool dma_reachable(const void* p, uint32_t bytes) {
    uintptr_t a = (uintptr_t)p;
    return (a & 31U) == 0U && a >= AXI_SRAM_START && a + bytes <= AXI_SRAM_END;
}

/* Cache maintenance only when the D-cache is on. CubeMX leaves it off on
 * this board, and there DCIMVAC/DCCMVAC on AXI SRAM raised an imprecise
 * BusFault on the rev 1 board (CFSR 0x400, first DMA read at mount). */
static bool dcache_on(void) {
    return (SCB->CCR & SCB_CCR_DC_Msk) != 0U;
}

static uint32_t divider_for(uint32_t kernel_hz, uint32_t max_hz) {
    /* SDMMC_CK = kernel / (2 x CLKDIV) for CLKDIV > 0 (RM0468). */
    return (kernel_hz + 2U * max_hz - 1U) / (2U * max_hz);
}

/* Keep SDMMC_CK within legacy timing whatever CubeMX or HAL left in
 * CLKDIV. The .ioc has ClockDiv = 0, which is bypass: 129 MHz. */
static void clamp_clock(void) {
    uint32_t kernel = HAL_RCCEx_GetPeriphCLKFreq(RCC_PERIPHCLK_SDMMC);
    uint32_t div = READ_REG(hmmc1.Instance->CLKCR) & SDMMC_CLKCR_CLKDIV;
    uint32_t hz = div == 0U ? kernel : kernel / (2U * div);
    if (hz > LEGACY_MAX_HZ) {
        MODIFY_REG(hmmc1.Instance->CLKCR, SDMMC_CLKCR_CLKDIV,
                   divider_for(kernel, LEGACY_MAX_HZ));
    }
}

static emmc_status_t wait_transfer_state(uint32_t deadline) {
    while (HAL_MMC_GetCardState(&hmmc1) != HAL_MMC_CARD_TRANSFER) {
        if ((int32_t)(osKernelGetTickCount() - deadline) >= 0) {
            return EMMC_ERR_TIMEOUT;
        }
        osDelay(1U);
    }
    return EMMC_OK;
}

static emmc_status_t finish(uint32_t budget_ms) {
    uint32_t deadline = osKernelGetTickCount() + budget_ms;
    if (osSemaphoreAcquire(transfer_done, budget_ms) != osOK) {
        (void)HAL_MMC_Abort(&hmmc1);
        return EMMC_ERR_TIMEOUT;
    }
    if (!transfer_ok) {
        return EMMC_ERR_IO;
    }
    /* Writes: the card is busy programming until it is back in TRANSFER. */
    return wait_transfer_state(deadline);
}

/* ---- the port --------------------------------------------------------- */

static emmc_status_t port_start(void* context, uint32_t* block_count) {
    (void)context;
    if (!dma_reachable(chunks, sizeof chunks) ||
        !dma_reachable(scratch, sizeof scratch)) {
        return EMMC_ERR_PARAM; /* linker put the buffers in DTCM */
    }
    HAL_GPIO_WritePin(EMMC_RST_GPIO_Port, EMMC_RST_Pin, GPIO_PIN_SET);
    osDelay(1U); /* >= tRSCA 200 us */

    if (hmmc1.State == HAL_MMC_STATE_RESET) {
        /* main.c did not bring it up (CubeMX "do not generate call"). */
        uint32_t kernel = HAL_RCCEx_GetPeriphCLKFreq(RCC_PERIPHCLK_SDMMC);
        hmmc1.Instance = SDMMC1;
        hmmc1.Init.ClockEdge = SDMMC_CLOCK_EDGE_RISING;
        hmmc1.Init.ClockPowerSave = SDMMC_CLOCK_POWER_SAVE_DISABLE;
        hmmc1.Init.BusWide = SDMMC_BUS_WIDE_4B;
        hmmc1.Init.HardwareFlowControl = SDMMC_HARDWARE_FLOW_CONTROL_DISABLE;
        hmmc1.Init.ClockDiv = divider_for(kernel, LEGACY_MAX_HZ);
        if (HAL_MMC_Init(&hmmc1) != HAL_OK) {
            return EMMC_ERR_IO;
        }
    } else if (hmmc1.State != HAL_MMC_STATE_READY) {
        return EMMC_ERR_NOT_READY;
    }
    clamp_clock();
    /* Hardware flow control: SDMMC_CK stops while the FIFO is full, so a
     * polling read preempted by a higher-priority task (the sensors start
     * with recording) cannot overrun (seen on the rev 1 board: EXT_CSD read
     * failed with HAL_MMC_ERROR_RX_OVERRUN, 0x20). RM0468 SDMMC_CLKCR
     * HWFC_EN. */
    SET_BIT(hmmc1.Instance->CLKCR, SDMMC_CLKCR_HWFC_EN);

    /* Polling read of EXT_CSD: once, before any DMA, at bring-up. It runs
     * when the rocket arms, just as the sensors (realtime) and GPS start: a
     * preempted poll stops draining the FIFO, flow control holds the clock,
     * and the 100 ms timeout fires (seen on the bench: 128 of 512 bytes,
     * disk FAULT). No task switch for these few ms; interrupts still run. */
    vTaskSuspendAll();
    HAL_StatusTypeDef ext = HAL_MMC_GetCardExtCSD(&hmmc1, ext_csd, 100U);
    (void)xTaskResumeAll();
    if (ext != HAL_OK) {
        return EMMC_ERR_IO;
    }
    emmc_card_parse(hmmc1.CID, (const uint8_t*)ext_csd, &card);
    card_issues = emmc_card_check(&card);
    card_known = true;

    HAL_MMC_CardInfoTypeDef info;
    if (HAL_MMC_GetCardInfo(&hmmc1, &info) != HAL_OK ||
        info.BlockSize != EMMC_BLOCK_SIZE) {
        return EMMC_ERR_IO;
    }
    *block_count = info.LogBlockNbr;
    return EMMC_OK;
}

static emmc_status_t port_read(void* context, uint32_t lba, void* buffer,
                               uint32_t count, uint32_t budget_ms) {
    (void)context;
    uint32_t bytes = count * EMMC_BLOCK_SIZE;
    if (count == 0U || !dma_reachable(buffer, bytes)) {
        return EMMC_ERR_PARAM;
    }
    (void)osSemaphoreAcquire(transfer_done, 0U); /* drop a stale release */
    if (HAL_MMC_ReadBlocks_DMA(&hmmc1, buffer, lba, count) != HAL_OK) {
        return EMMC_ERR_IO;
    }
    emmc_status_t st = finish(budget_ms);
    if (dcache_on()) {
        SCB_InvalidateDCache_by_Addr(buffer, (int32_t)bytes);
    }
    return st;
}

static emmc_status_t port_write(void* context, uint32_t lba, const void* buffer,
                                uint32_t count, uint32_t budget_ms) {
    (void)context;
    uint32_t bytes = count * EMMC_BLOCK_SIZE;
    if (count == 0U || !dma_reachable(buffer, bytes)) {
        return EMMC_ERR_PARAM;
    }
    if (dcache_on()) {
        SCB_CleanDCache_by_Addr((uint32_t*)(uintptr_t)buffer, (int32_t)bytes);
    }
    (void)osSemaphoreAcquire(transfer_done, 0U);
    if (HAL_MMC_WriteBlocks_DMA(&hmmc1, (uint8_t*)(uintptr_t)buffer, lba,
                                count) != HAL_OK) {
        return EMMC_ERR_IO;
    }
    return finish(budget_ms);
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

/* ---- HAL callbacks (weak in stm32h7xx_hal_mmc.c) ------------------------ */

void HAL_MMC_TxCpltCallback(MMC_HandleTypeDef* hmmc) {
    if (hmmc == &hmmc1) {
        transfer_ok = true;
        (void)osSemaphoreRelease(transfer_done);
    }
}

void HAL_MMC_RxCpltCallback(MMC_HandleTypeDef* hmmc) {
    HAL_MMC_TxCpltCallback(hmmc);
}

void HAL_MMC_ErrorCallback(MMC_HandleTypeDef* hmmc) {
    if (hmmc == &hmmc1) {
        transfer_ok = false;
        (void)osSemaphoreRelease(transfer_done);
    }
}

/* ---- public ------------------------------------------------------------- */

emmc_status_t emmc_stm32_init(void) {
    queue_mutex = osMutexNew(NULL);
    transfer_done = osSemaphoreNew(1U, 0U, NULL);
    call_lock = osMutexNew(NULL);
    call_done = osSemaphoreNew(1U, 0U, NULL);
    if (!queue_mutex || !transfer_done || !call_lock || !call_done) {
        return EMMC_ERR_NOT_READY;
    }
    emmc_log_config_t config = emmc_log_default_config();
    return emmc_log_init(&flight_log, &port, NULL, &config, chunks, LOG_CHUNKS,
                         scratch);
}

emmc_log_t* emmc_stm32_log(void) {
    return &flight_log;
}

const emmc_card_info_t* emmc_stm32_card(uint32_t* issues) {
    if (!card_known) {
        return NULL;
    }
    if (issues) {
        *issues = card_issues;
    }
    return &card;
}

bool emmc_stm32_call(void (*fn)(void* ctx), void* ctx) {
    if (!writer || !call_lock) {
        return false;
    }
    (void)osMutexAcquire(call_lock, osWaitForever);
    (void)osSemaphoreAcquire(call_done, 0U); /* drop a stale release */
    call_ctx = ctx;
    call_fn = fn;
    (void)osThreadFlagsSet(writer, EV_CALL);
    bool ok = osSemaphoreAcquire(call_done, 2000U) == osOK;
    if (!ok) {
        taskENTER_CRITICAL();
        ok = call_fn == NULL; /* it ran just as the wait ended */
        call_fn = NULL;
        taskEXIT_CRITICAL();
    }
    (void)osMutexRelease(call_lock);
    return ok;
}

/* One read-back request at a time (emmc_stm32_call serializes callers). */
static struct {
    emmc_status_t st;
    uint32_t start, max, k;
    uint32_t *n, *total;
    emmc_log_session_t* out;
    uint8_t* block;
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

static emmc_status_t run(void (*fn)(void* ctx)) {
    req.st = EMMC_ERR_TIMEOUT;
    return emmc_stm32_call(fn, NULL) ? req.st : EMMC_ERR_TIMEOUT;
}

emmc_status_t emmc_stm32_open(void) {
    return run(do_open);
}

emmc_status_t emmc_stm32_sessions(uint32_t start, emmc_log_session_t* out,
                                  uint32_t max, uint32_t* n, uint32_t* total) {
    req.start = start;
    req.out = out;
    req.max = max;
    req.n = n;
    req.total = total;
    return run(do_sessions);
}

emmc_status_t emmc_stm32_read(uint32_t k, uint8_t out[EMMC_BLOCK_SIZE]) {
    req.k = k;
    req.block = out;
    return run(do_read);
}

void emmc_stm32_writer_task(void* argument) {
    (void)argument;
    writer = osThreadGetId();
    for (;;) {
        (void)emmc_log_service(&flight_log, osKernelGetTickCount());
        void (*fn)(void* ctx) = call_fn;
        if (fn) { /* between transfers: nothing else is on the card */
            fn(call_ctx);
            call_fn = NULL;
            (void)osSemaphoreRelease(call_done);
        }
        if (emmc_log_backlog(&flight_log) == 0U) {
            /* nothing sealed: check again in 10 ms, or at once for a call */
            (void)osThreadFlagsWait(EV_CALL, osFlagsWaitAny, 10U);
        }
    }
}
