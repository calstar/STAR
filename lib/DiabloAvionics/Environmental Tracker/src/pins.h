#pragma once

// I2C — BME280
#define PIN_SDA       0
#define PIN_SCL       1

// SPI — W5500 Ethernet
#define PIN_ETH_MISO  4
// GPIO 5 (ETH_RST) — not driven; hotfire boards do not use the reset line
#define PIN_ETH_SCLK  6
#define PIN_ETH_CS    2
// GPIO 7 (ETH_INT) — not used; W5500 polled via parsePacket()
#define PIN_ETH_MOSI  10
