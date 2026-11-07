#include "board_devbus.h"

#include "board.h"
#include "cmsis_os2.h"

/* One context per SPI device: the device id is the context. */
static board_spi_device_t devices[BOARD_SPI_COUNT] = {
    BOARD_SPI_IMU, BOARD_SPI_HIGH_G, BOARD_SPI_BARO,
    BOARD_SPI_ETH, BOARD_SPI_RADIO,  BOARD_SPI_NAND,
};

static int xfer(void* ctx, const uint8_t* tx, uint8_t* rx, uint16_t len) {
    board_spi_device_t device = *(const board_spi_device_t*)ctx;
    uint32_t deadline = board_now_ms() + BOARD_DEVBUS_FRAME_MS;
    return board_spi_transfer(device, tx, rx, len, deadline) == BOARD_SPI_OK
               ? DEV_OK
               : DEV_ERR_BUS;
}

static void delay_ms(void* ctx, uint32_t ms) {
    (void)ctx;
    /* osDelay(n) waits until the n-th tick boundary, which can be up to one
     * tick (1 ms) short; one extra tick guarantees at least ms. */
    osDelay(ms + 1U);
}

dev_bus_t board_devbus(board_spi_device_t device) {
    dev_bus_t bus = {xfer, delay_ms, &devices[device]};
    return bus;
}
