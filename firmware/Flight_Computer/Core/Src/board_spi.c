#include "board_spi.h"

#include <string.h>

#include "board.h"
#include "cmsis_os2.h"
#include "main.h"

extern SPI_HandleTypeDef hspi1;
extern SPI_HandleTypeDef hspi2;
extern SPI_HandleTypeDef hspi3;
extern SPI_HandleTypeDef hspi4;

typedef struct {
    SPI_HandleTypeDef* spi;
    GPIO_TypeDef* cs_port;
    uint16_t cs_pin;
    GPIO_TypeDef* busy_port; /* SX1262 only: commands wait for BUSY low */
    uint16_t busy_pin;
} board_spi_route_t;

/* Pin names come from the .ioc labels (main.h). A device with spi == NULL is
 * not routed yet and every call on it returns NOT_CONFIGURED. */
static const board_spi_route_t routes[BOARD_SPI_COUNT] = {
    [BOARD_SPI_IMU] = {&hspi3, IMU_CS_GPIO_Port, IMU_CS_Pin, NULL, 0},
    [BOARD_SPI_HIGH_G] = {&hspi3, ACCEL_CS_GPIO_Port, ACCEL_CS_Pin, NULL, 0},
    [BOARD_SPI_BARO] = {&hspi3, BARO_CS_GPIO_Port, BARO_CS_Pin, NULL, 0},
    [BOARD_SPI_ETH] = {&hspi2, ETH_CS_GPIO_Port, ETH_CS_Pin, NULL, 0},
    [BOARD_SPI_RADIO] = {0},
    [BOARD_SPI_NAND] = {0},
};

/* One lock per SPI peripheral, indexed SPI1..SPI4. */
static osMutexId_t bus_locks[4];

static int bus_index(const SPI_HandleTypeDef* spi) {
    if (spi == &hspi1)
        return 0;
    if (spi == &hspi2)
        return 1;
    if (spi == &hspi3)
        return 2;
    if (spi == &hspi4)
        return 3;
    return -1;
}

static const board_spi_route_t* route(board_spi_device_t device) {
    if ((unsigned)device >= BOARD_SPI_COUNT || !routes[device].spi) {
        return NULL;
    }
    return &routes[device];
}

bool board_spi_init(void) {
    static const osMutexAttr_t attr = {"spi_bus", osMutexPrioInherit, NULL, 0};
    for (int i = 0; i < 4; ++i) {
        if (!bus_locks[i]) {
            bus_locks[i] = osMutexNew(&attr);
            if (!bus_locks[i]) {
                return false;
            }
        }
    }
    return true;
}

bool board_spi_routed(board_spi_device_t device) {
    return route(device);
}

uint8_t board_spi_mode(board_spi_device_t device) {
    const board_spi_route_t* r = route(device);
    if (!r)
        return 0;
    uint8_t cpol = r->spi->Init.CLKPolarity == SPI_POLARITY_HIGH ? 2U : 0U;
    uint8_t cpha = r->spi->Init.CLKPhase == SPI_PHASE_2EDGE ? 1U : 0U;
    return (uint8_t)(cpol | cpha);
}

uint32_t board_spi_clock_hz(board_spi_device_t device) {
    const board_spi_route_t* r = route(device);
    if (!r)
        return 0;
    uint32_t kernel = HAL_RCCEx_GetPeriphCLKFreq(
        r->spi == &hspi4 ? RCC_PERIPHCLK_SPI45 : RCC_PERIPHCLK_SPI123);
    /* H7 SPI_CFG1_MBR: prescaler code n divides by 2^(n+1). */
    uint32_t code =
        (r->spi->Init.BaudRatePrescaler & SPI_CFG1_MBR) >> SPI_CFG1_MBR_Pos;
    return kernel >> (code + 1U);
}

board_spi_status_t board_spi_lock(board_spi_device_t device,
                                  uint32_t deadline_ms) {
    const board_spi_route_t* r = route(device);
    if (!r)
        return BOARD_SPI_NOT_CONFIGURED;
    osMutexId_t lock = bus_locks[bus_index(r->spi)];
    if (!lock)
        return BOARD_SPI_NOT_CONFIGURED;
    /* 1 kHz tick: ticks == ms. */
    return osMutexAcquire(lock, board_ms_left(deadline_ms)) == osOK
               ? BOARD_SPI_OK
               : BOARD_SPI_TIMEOUT;
}

void board_spi_unlock(board_spi_device_t device) {
    const board_spi_route_t* r = route(device);
    if (r && bus_locks[bus_index(r->spi)]) {
        osMutexRelease(bus_locks[bus_index(r->spi)]);
    }
}

static board_spi_status_t wait_busy_low(const board_spi_route_t* r,
                                        uint32_t deadline_ms) {
    if (!r->busy_port)
        return BOARD_SPI_OK;
    while (HAL_GPIO_ReadPin(r->busy_port, r->busy_pin) == GPIO_PIN_SET) {
        if (board_deadline_passed(deadline_ms))
            return BOARD_SPI_TIMEOUT;
    }
    return BOARD_SPI_OK;
}

/* Full-duplex transfer in chunks so tx/rx may be NULL without a len-sized
 * buffer. CS is not touched here. */
static board_spi_status_t shift(const board_spi_route_t* r, const uint8_t* tx,
                                uint8_t* rx, uint16_t len,
                                uint32_t deadline_ms) {
    static uint8_t ones[16];
    static uint8_t sink[16];
    memset(ones, 0xFF, sizeof(ones));
    while (len) {
        uint16_t n = len;
        const uint8_t* out = tx;
        uint8_t* in = rx;
        if (!tx || !rx) {
            n = n > sizeof(ones) ? (uint16_t)sizeof(ones) : n;
            if (!tx)
                out = ones;
            if (!rx)
                in = sink;
        }
        uint32_t left = board_ms_left(deadline_ms);
        if (!left)
            return BOARD_SPI_TIMEOUT;
        HAL_StatusTypeDef st =
            HAL_SPI_TransmitReceive(r->spi, (uint8_t*)out, in, n, left);
        if (st == HAL_TIMEOUT)
            return BOARD_SPI_TIMEOUT;
        if (st != HAL_OK)
            return BOARD_SPI_ERROR;
        len = (uint16_t)(len - n);
        if (tx)
            tx += n;
        if (rx)
            rx += n;
    }
    return BOARD_SPI_OK;
}

board_spi_status_t board_spi_frame(board_spi_device_t device, const uint8_t* tx,
                                   uint8_t* rx, uint16_t len,
                                   uint32_t deadline_ms) {
    const board_spi_route_t* r = route(device);
    if (!r)
        return BOARD_SPI_NOT_CONFIGURED;
    board_spi_status_t st = wait_busy_low(r, deadline_ms);
    if (st != BOARD_SPI_OK)
        return st;
    HAL_GPIO_WritePin(r->cs_port, r->cs_pin, GPIO_PIN_RESET);
    st = shift(r, tx, rx, len, deadline_ms);
    HAL_GPIO_WritePin(r->cs_port, r->cs_pin, GPIO_PIN_SET);
    return st;
}

board_spi_status_t board_spi_transfer(board_spi_device_t device,
                                      const uint8_t* tx, uint8_t* rx,
                                      uint16_t len, uint32_t deadline_ms) {
    board_spi_status_t st = board_spi_lock(device, deadline_ms);
    if (st != BOARD_SPI_OK)
        return st;
    st = board_spi_frame(device, tx, rx, len, deadline_ms);
    board_spi_unlock(device);
    return st;
}

void board_spi_select(board_spi_device_t device) {
    const board_spi_route_t* r = route(device);
    if (r)
        HAL_GPIO_WritePin(r->cs_port, r->cs_pin, GPIO_PIN_RESET);
}

void board_spi_deselect(board_spi_device_t device) {
    const board_spi_route_t* r = route(device);
    if (r)
        HAL_GPIO_WritePin(r->cs_port, r->cs_pin, GPIO_PIN_SET);
}

board_spi_status_t board_spi_shift(board_spi_device_t device, const uint8_t* tx,
                                   uint8_t* rx, uint16_t len,
                                   uint32_t deadline_ms) {
    const board_spi_route_t* r = route(device);
    if (!r)
        return BOARD_SPI_NOT_CONFIGURED;
    return shift(r, tx, rx, len, deadline_ms);
}

board_spi_status_t board_spi_idle_clocks(board_spi_device_t device,
                                         uint16_t len, uint32_t deadline_ms) {
    const board_spi_route_t* r = route(device);
    if (!r)
        return BOARD_SPI_NOT_CONFIGURED;
    HAL_GPIO_WritePin(r->cs_port, r->cs_pin, GPIO_PIN_SET);
    return shift(r, NULL, NULL, len, deadline_ms);
}

/* ---- self-test adapter ------------------------------------------------- */

static board_spi_device_t from_self_test(uint16_t device_id) {
    switch (device_id) {
        case SELF_TEST_DEVICE_IMU:
            return BOARD_SPI_IMU;
        case SELF_TEST_DEVICE_HIGH_G:
            return BOARD_SPI_HIGH_G;
        case SELF_TEST_DEVICE_BAROMETER:
            return BOARD_SPI_BARO;
        case SELF_TEST_DEVICE_ETHERNET:
            return BOARD_SPI_ETH;
        case SELF_TEST_DEVICE_RADIO:
            return BOARD_SPI_RADIO;
        default:
            return BOARD_SPI_COUNT;
    }
}

static self_test_reply_t st_reply(self_test_result_t result, int32_t diag) {
    self_test_reply_t r = {result, diag};
    return r;
}

self_test_reply_t board_spi_self_test_exchange(
    void* context, uint16_t device_id, uint8_t mode, uint32_t max_hz,
    self_test_spi_frame_t* frames, uint8_t count, uint32_t budget_ms) {
    (void)context;
    board_spi_device_t device = from_self_test(device_id);
    if (!board_spi_routed(device) || !frames) {
        return st_reply(SELF_TEST_NOT_CONFIGURED, 0);
    }
    /* Never talk to a chip with the wrong clock polarity/phase or too fast
     * a clock: the bus is configured once, in the .ioc. */
    if (board_spi_mode(device) != mode || board_spi_clock_hz(device) > max_hz) {
        return st_reply(SELF_TEST_NOT_CONFIGURED, 0);
    }
    uint32_t deadline = board_now_ms() + budget_ms;
    board_spi_status_t st = board_spi_lock(device, deadline);
    if (st != BOARD_SPI_OK) {
        return st_reply(st == BOARD_SPI_TIMEOUT ? SELF_TEST_TIMEOUT
                                                : SELF_TEST_NOT_CONFIGURED,
                        0);
    }
    /* Locked from here: every path below must unlock. */
    for (uint8_t i = 0; st == BOARD_SPI_OK && i < count; ++i) {
        st = board_spi_frame(device, frames[i].tx, frames[i].rx,
                             frames[i].length, deadline);
    }
    board_spi_unlock(device);
    switch (st) {
        case BOARD_SPI_OK:
            return st_reply(SELF_TEST_PASS, 0);
        case BOARD_SPI_TIMEOUT:
            return st_reply(SELF_TEST_TIMEOUT, 0);
        case BOARD_SPI_NOT_CONFIGURED:
            return st_reply(SELF_TEST_NOT_CONFIGURED, 0);
        default:
            return st_reply(SELF_TEST_FAIL, 0);
    }
}
