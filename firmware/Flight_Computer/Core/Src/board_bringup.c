#include "board_bringup.h"

#include "board.h"
#include "board_spi.h"
#include "cmsis_os2.h"
#include "gnss_frame.h"
#include "main.h"
#include "sd_spi.h"

extern UART_HandleTypeDef huart9;

static void enable(board_bringup_t* b, uint16_t device_id) {
    b->devices.configured_mask |= SELF_TEST_DEVICE_ENABLED(device_id);
}

/* Sleep until at least ms after reset (the HAL tick starts at reset). */
static void wait_since_boot(uint32_t ms) {
    uint32_t now = board_now_ms();
    if (now < ms) {
        osDelay(ms - now);
    }
}

/*
 * MS5611 reset (0x1E), required once after power-on so the calibration PROM
 * is loaded (datasheet p.10, "Reset sequence"). Figure 5 holds CSB low through
 * the 2.8 ms reload; osDelay(4) guarantees >= 3 ms on a 1 kHz tick.
 */
static bool ms5611_reset(void) {
    static const uint8_t reset_cmd = 0x1E;
    uint32_t deadline = board_now_ms() + 50U;
    if (board_spi_lock(BOARD_SPI_BARO, deadline) != BOARD_SPI_OK) {
        return false;
    }
    board_spi_select(BOARD_SPI_BARO);
    board_spi_status_t st =
        board_spi_shift(BOARD_SPI_BARO, &reset_cmd, NULL, 1, deadline);
    if (st == BOARD_SPI_OK) {
        osDelay(4);
    }
    board_spi_deselect(BOARD_SPI_BARO);
    board_spi_unlock(BOARD_SPI_BARO);
    return st == BOARD_SPI_OK;
}

static self_test_reply_t reply(self_test_result_t result, int32_t diag) {
    self_test_reply_t r = {result, diag};
    return r;
}

static bool uart9_set_baud(uint32_t baud) {
    if (huart9.Init.BaudRate == baud) {
        return true;
    }
    huart9.Init.BaudRate = baud;
    return HAL_UART_Init(&huart9) == HAL_OK;
}

/*
 * MAX-M10S on UART9 (PD14 RX <- GPS TXD, PD15 TX -> GPS RXD; schematic p.10).
 * Out of the box it sends NMEA at 1 Hz, so listening is enough: PASS on one
 * complete frame with a valid checksum (NMEA or UBX). No fix is required
 * (#137). The startup baud is still open (38400 per the M10 defaults and the
 * .ioc; 9600 per the R03 datasheet), so attempts alternate: 1 and 3 listen at
 * 38400, 2 at 9600. Nothing is sent to the module.
 */
static self_test_reply_t gnss_probe(board_bringup_t* b, uint8_t attempt,
                                    uint32_t budget_ms) {
    if (!b->gnss_powered) {
        return reply(SELF_TEST_NOT_CONFIGURED, 0);
    }
    uint32_t baud = (attempt % 2U == 0U) ? 9600U : 38400U;
    if (!uart9_set_baud(baud)) {
        return reply(SELF_TEST_FAIL, 0);
    }
    uint32_t listen =
        budget_ms < BOARD_GNSS_LISTEN_MS ? budget_ms : BOARD_GNSS_LISTEN_MS;
    uint32_t deadline = board_now_ms() + listen;
    gnss_frame_parser_t parser;
    gnss_frame_init(&parser);
    __HAL_UART_CLEAR_FLAG(&huart9, UART_CLEAR_OREF | UART_CLEAR_FEF |
                                       UART_CLEAR_NEF | UART_CLEAR_PEF);
    while (!board_deadline_passed(deadline)) {
        uint32_t left = board_ms_left(deadline);
        uint8_t byte;
        if (HAL_UART_Receive(&huart9, &byte, 1, left < 20U ? left : 20U) ==
            HAL_OK) {
            if (gnss_frame_feed(&parser, byte) != GNSS_FRAME_NONE) {
                return reply(SELF_TEST_PASS, (int32_t)baud);
            }
        } else {
            /* an overrun stalls reception until cleared */
            __HAL_UART_CLEAR_FLAG(&huart9, UART_CLEAR_OREF | UART_CLEAR_FEF |
                                               UART_CLEAR_NEF | UART_CLEAR_PEF);
        }
    }
    bool antenna_short = HAL_GPIO_ReadPin(GPS_ANT_STATUS_GPIO_Port,
                                          GPS_ANT_STATUS_Pin) == GPIO_PIN_RESET;
    return reply(SELF_TEST_TIMEOUT,
                 antenna_short ? BOARD_GNSS_DIAG_ANTENNA_SHORT : 0);
}

/*
 * One SD command in SPI mode, CS low for the whole exchange: the 6-byte
 * frame, up to 8 bytes of 0xFF until R1 (bit 7 clear) appears, then
 * extra_len more bytes (R7/OCR). CS high and 8 more clocks afterwards.
 * Caller holds the SPI4 lock.
 */
static board_spi_status_t sd_command(uint8_t index, uint32_t arg, uint8_t* r1,
                                     uint8_t* extra, uint8_t extra_len,
                                     uint32_t deadline) {
    uint8_t frame[6];
    sd_command_frame(frame, index, arg);
    *r1 = 0xFF;
    board_spi_select(BOARD_SPI_NAND);
    board_spi_status_t st =
        board_spi_shift(BOARD_SPI_NAND, frame, NULL, 6, deadline);
    for (uint8_t i = 0; st == BOARD_SPI_OK && i < 8 && !sd_is_r1(*r1); ++i) {
        st = board_spi_shift(BOARD_SPI_NAND, NULL, r1, 1, deadline);
    }
    if (st == BOARD_SPI_OK && sd_is_r1(*r1) && extra_len) {
        st = board_spi_shift(BOARD_SPI_NAND, NULL, extra, extra_len, deadline);
    }
    board_spi_deselect(BOARD_SPI_NAND);
    if (st == BOARD_SPI_OK) {
        st = board_spi_shift(BOARD_SPI_NAND, NULL, NULL, 1, deadline);
    }
    return st;
}

/* CMD10: R1, then wait for the 0xFE data token, then 16 CID bytes + CRC16. */
static board_spi_status_t sd_read_cid(uint8_t* r1, uint8_t cid[16],
                                      uint32_t deadline) {
    uint8_t frame[6], token = 0xFF, crc16[2];
    sd_command_frame(frame, SD_CMD10_SEND_CID, 0);
    *r1 = 0xFF;
    board_spi_select(BOARD_SPI_NAND);
    board_spi_status_t st =
        board_spi_shift(BOARD_SPI_NAND, frame, NULL, 6, deadline);
    for (uint8_t i = 0; st == BOARD_SPI_OK && i < 8 && !sd_is_r1(*r1); ++i) {
        st = board_spi_shift(BOARD_SPI_NAND, NULL, r1, 1, deadline);
    }
    if (st == BOARD_SPI_OK && *r1 == 0x00U) {
        for (uint16_t i = 0;
             st == BOARD_SPI_OK && i < 512 && token != SD_DATA_TOKEN; ++i) {
            st = board_spi_shift(BOARD_SPI_NAND, NULL, &token, 1, deadline);
        }
        if (st == BOARD_SPI_OK && token == SD_DATA_TOKEN) {
            st = board_spi_shift(BOARD_SPI_NAND, NULL, cid, 16, deadline);
            if (st == BOARD_SPI_OK) {
                st = board_spi_shift(BOARD_SPI_NAND, NULL, crc16, 2, deadline);
            }
        } else if (st == BOARD_SPI_OK) {
            *r1 = 0xFF; /* no data token: treat as no answer */
        }
    }
    board_spi_deselect(BOARD_SPI_NAND);
    if (st == BOARD_SPI_OK) {
        st = board_spi_shift(BOARD_SPI_NAND, NULL, NULL, 1, deadline);
    }
    return st;
}

static self_test_reply_t sd_fail(board_spi_status_t st, int stage, uint8_t r1) {
    int32_t diag = (int32_t)((stage << 8) | r1);
    if (st == BOARD_SPI_TIMEOUT) {
        return reply(SELF_TEST_TIMEOUT, diag);
    }
    return reply(SELF_TEST_FAIL, diag);
}

/*
 * ZDSD01GLGEAG SD NAND (U10) on SPI4, SD SPI mode, read-only: wake clocks,
 * CMD0, CMD8, ACMD41 (initialize), CMD58 (OCR), CMD10 (CID). Nothing is
 * written. SPI4 stays at 250 kHz, inside the 400 kHz init limit.
 */
static self_test_reply_t sd_nand_probe(uint32_t budget_ms) {
    uint32_t deadline = board_now_ms() + budget_ms;
    uint8_t r1 = 0xFF, r7[4], ocr[4], cid[16];
    board_spi_status_t st = board_spi_lock(BOARD_SPI_NAND, deadline);
    if (st != BOARD_SPI_OK) {
        return sd_fail(st, 0, 0xFF);
    }
    self_test_reply_t result;
    /* >= 74 clocks with CS high put the card in a known state. */
    st = board_spi_idle_clocks(BOARD_SPI_NAND, 10, deadline);
    if (st == BOARD_SPI_OK) {
        st = sd_command(SD_CMD0_GO_IDLE, 0, &r1, NULL, 0, deadline);
    }
    if (st != BOARD_SPI_OK || r1 != SD_R1_IDLE) {
        result = sd_fail(st, BOARD_SD_STAGE_CMD0, r1);
        goto done;
    }
    st = sd_command(SD_CMD8_SEND_IF_COND, SD_CMD8_ARG, &r1, r7, 4, deadline);
    if (st != BOARD_SPI_OK || r1 != SD_R1_IDLE || !sd_r7_ok(r7)) {
        result = sd_fail(st, BOARD_SD_STAGE_CMD8, r1);
        goto done;
    }
    uint32_t init_deadline = board_now_ms() + BOARD_SD_INIT_MS;
    if ((int32_t)(init_deadline - deadline) > 0) {
        init_deadline = deadline;
    }
    do {
        st = sd_command(SD_CMD55_APP_CMD, 0, &r1, NULL, 0, deadline);
        if (st == BOARD_SPI_OK && (r1 & ~SD_R1_IDLE) == 0U) {
            st = sd_command(SD_ACMD41_SD_SEND_OP_COND, SD_ACMD41_HCS, &r1, NULL,
                            0, deadline);
        }
        if (st != BOARD_SPI_OK || r1 == 0x00U) {
            break;
        }
        osDelay(10);
    } while (!board_deadline_passed(init_deadline));
    if (st != BOARD_SPI_OK || r1 != 0x00U) {
        result = sd_fail(st == BOARD_SPI_OK ? BOARD_SPI_TIMEOUT : st,
                         BOARD_SD_STAGE_ACMD41, r1);
        goto done;
    }
    st = sd_command(SD_CMD58_READ_OCR, 0, &r1, ocr, 4, deadline);
    if (st != BOARD_SPI_OK || r1 != 0x00U) {
        result = sd_fail(st, BOARD_SD_STAGE_CMD58, r1);
        goto done;
    }
    st = sd_read_cid(&r1, cid, deadline);
    if (st != BOARD_SPI_OK || r1 != 0x00U || !sd_cid_ok(cid)) {
        result = sd_fail(st, BOARD_SD_STAGE_CMD10, r1);
        goto done;
    }
    {
        uint32_t ocr_word = ((uint32_t)ocr[0] << 24) |
                            ((uint32_t)ocr[1] << 16) | ((uint32_t)ocr[2] << 8) |
                            ocr[3];
        result =
            reply(SELF_TEST_PASS,
                  (int32_t)(cid[0] | ((ocr_word & SD_OCR_CCS) ? 0x100U : 0U)));
    }
done:
    board_spi_unlock(BOARD_SPI_NAND);
    return result;
}

void board_bringup_power_up(board_bringup_t* b) {
    b->devices.exchange = board_spi_self_test_exchange;
    b->devices.io_context = NULL;
    b->devices.configured_mask = 0;
    b->gnss_powered = false;
    if (!board_spi_init()) {
        return; /* no bus locks: no SPI device is enabled */
    }

    /* ISM330DHCX (U4): on the always-on 3V3 rail. Its boot sequence takes
     * about 10 ms after power-up; 20 ms gives margin. SPI needs no setup: CS
     * is driven high by MX_GPIO_Init and goes low only for a transfer. */
    wait_since_boot(20);
    enable(b, SELF_TEST_DEVICE_IMU);

    /* H3LIS100DL (U3), high-g: same rail and bus as the IMU. At power-up it
     * loads its trimming from internal flash (DocID027504 p.27); no separate
     * boot time is specified, and the 20 ms above covers it. It starts in
     * power-down (CTRL_REG1 = 0x07), which still answers WHO_AM_I. */
    enable(b, SELF_TEST_DEVICE_HIGH_G);

    /* MS5611 (U5), barometer: same rail and bus. Its PROM check is only
     * meaningful after the power-on reset, so the check is enabled only if
     * the reset command went out. */
    if (ms5611_reset()) {
        enable(b, SELF_TEST_DEVICE_BAROMETER);
    }

    /* W5500 (U6), Ethernet: held in reset by ETH_RST (PE13), which
     * MX_GPIO_Init drives low. RSTn low >= 500 us (TRC), then the internal
     * PLL locks <= 1 ms after RSTn rises (TPL) (datasheet v1.0.2 p.61).
     * It has been low since boot; osDelay(3) guarantees >= 2 ms. */
    HAL_GPIO_WritePin(ETH_RST_GPIO_Port, ETH_RST_Pin, GPIO_PIN_SET);
    osDelay(3);
    enable(b, SELF_TEST_DEVICE_ETHERNET);

    /* Wio-SX1262 (U8), LoRa: held in reset by RADIO_NRST (PB0), driven low
     * by MX_GPIO_Init. NRESET low typ. 100 us (SX1262 DS 8.1, p.50); after
     * release BUSY (PC5) stays high through STARTUP and falls once the chip
     * is in STDBY_RC and accepts commands (8.2.2, 9.1). Wait up to 50 ms.
     * The check is enabled either way: board_spi waits on BUSY before every
     * radio command, so a radio that never starts reports TIMEOUT instead of
     * being hidden as "not configured". RF_SW (PB1) stays low; nothing here
     * transmits. */
    HAL_GPIO_WritePin(RADIO_NRST_GPIO_Port, RADIO_NRST_Pin, GPIO_PIN_SET);
    uint32_t radio_deadline = board_now_ms() + 50U;
    while (HAL_GPIO_ReadPin(RADIO_BUSY_GPIO_Port, RADIO_BUSY_Pin) ==
               GPIO_PIN_SET &&
           !board_deadline_passed(radio_deadline)) {
        osDelay(1);
    }
    enable(b, SELF_TEST_DEVICE_RADIO);

    /* MAX-M10S (MD1), GNSS: its 3V3A rail comes from the 3V6 buck (U15) and
     * LP5907 LDO (U16), off until REG_3V6_EN (PE11) goes high (#137 power
     * tree). GPS_RST (PD11, open drain) is already released by MX_GPIO_Init.
     * 10 ms covers both regulators' start-up; the module then needs up to a
     * second before its first sentence, which the probe's listen window
     * covers. */
    HAL_GPIO_WritePin(REG_3V6_EN_GPIO_Port, REG_3V6_EN_Pin, GPIO_PIN_SET);
    osDelay(10);
    b->gnss_powered = true;
}

self_test_reply_t board_bringup_probe(void* context, uint16_t device_id,
                                      uint8_t attempt, uint32_t now_ms,
                                      uint32_t budget_ms) {
    board_bringup_t* b = context;
    if (!b) {
        self_test_reply_t r = {SELF_TEST_NOT_CONFIGURED, 0};
        return r;
    }
    switch (device_id) {
        case SELF_TEST_DEVICE_GNSS:
            return gnss_probe(b, attempt, budget_ms);
        case SELF_TEST_DEVICE_NAND:
            /* 3V3 rail; CS has a 100k pull-up and is driven high since boot;
             * the SD power-up wait (>= 1 ms) has long passed. */
            return sd_nand_probe(budget_ms);
        default:
            /* SPI identity checks (IMU, high-g, baro, Ethernet, radio). */
            return self_test_devices_probe(&b->devices, device_id, attempt,
                                           now_ms, budget_ms);
    }
}
