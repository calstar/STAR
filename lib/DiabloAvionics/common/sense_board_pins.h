#pragma once

namespace sense_board_pins {

// For any pins that are not present on a board, set them to -1
struct Layout {
    // Ethernet pins (same for all DAQv2 boards)
    int ETH_MOSI;
    int ETH_MISO;
    int ETH_SCLK;
    int ETH_CS;
    int ETH_INT;
    int ETH_RST;

    // ADC SPI bus
    int ADC_MOSI;
    int ADC_MISO;
    int ADC_SCLK;

    // ADC 1 GPIO pins
    int ADC_CS_1;
    int ADC_RESET_1;
    int ADC_START_1;
    int ADC_DRDY_1;

    // ADC 2 GPIO pins (only defined for LC / RTD boards)
    int ADC_CS_2;
    int ADC_RESET_2;
    int ADC_START_2;
    int ADC_DRDY_2;

    int LED;
};

// Order here MUST match the struct above.

constexpr Layout PT_Board{
    // ETH_MOSI, ETH_MISO, ETH_SCLK, ETH_CS, ETH_INT, ETH_RST
    40, 41, 39, 38, 37, 21,

    // ADC_MOSI, ADC_MISO, ADC_SCLK
    13, 21, 12,

    // ADC_CS_1, ADC_RESET_1, ADC_START_1, ADC_DRDY_1
    11, 9, 10, 14,

    // ADC_CS_2, ADC_RESET_2, ADC_START_2, ADC_DRDY_2
    -1, -1, -1, -1,

    // LED
    16,
};

constexpr Layout LC_Board{
    // ETH_MOSI, ETH_MISO, ETH_SCLK, ETH_CS, ETH_INT, ETH_RST
    40, 41, 39, 38, 37, 21,

    // ADC_MOSI, ADC_MISO, ADC_SCLK
    11, 10, 12,

    // ADC_CS_1, ADC_RESET_1, ADC_START_1, ADC_DRDY_1
    13, 8, 14, 9,

    // ADC_CS_2, ADC_RESET_2, ADC_START_2, ADC_DRDY_2
    47, 18, 48, 21,

    // LED
    16,
};

constexpr Layout RTD_Board{
    // ETH_MOSI, ETH_MISO, ETH_SCLK, ETH_CS, ETH_INT, ETH_RST
    40, 41, 39, 38, 37, 21,

    // ADC_MOSI, ADC_MISO, ADC_SCLK
    11, 10, 12,

    // ADC_CS_1, ADC_RESET_1, ADC_START_1, ADC_DRDY_1
    13, 8, 14, 9,

    // ADC_CS_2, ADC_RESET_2, ADC_START_2, ADC_DRDY_2
    47, 18, 48, 21,

    // LED
    15,
};

constexpr Layout TC_Board{
    // ETH_MOSI, ETH_MISO, ETH_SCLK, ETH_CS, ETH_INT, ETH_RST
    40, 41, 39, 38, 37, 21,

    // ADC_MOSI, ADC_MISO, ADC_SCLK
    11, 10, 12,

    // ADC_CS_1, ADC_RESET_1, ADC_START_1, ADC_DRDY_1
    13, -1, 14, 9,

    // ADC_CS_2, ADC_RESET_2, ADC_START_2, ADC_DRDY_2
    -1, -1, -1, -1,

    // LED
    16,
};

#ifndef PINS_ACTIVE_LAYOUT
#define PINS_ACTIVE_LAYOUT PT_Board
#endif

constexpr const Layout& Pins = PINS_ACTIVE_LAYOUT;

} // namespace sense_board_pins
