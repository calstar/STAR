#pragma once

// SPI — align with other IC_Testing C6 projects (same bus as MCP3201T / LIS3DH; CS = flash)
// SCK 2, MOSI 3, MISO 16, CS 0 (change if your wiring differs)
#define MX25_PIN_SCK 2
#define MX25_PIN_MISO 16
#define MX25_PIN_MOSI 3
#define MX25_PIN_CS 0

// Macronix MX25L25645G 256 Mb — full 24-bit JEDEC (RDID): C2 20 19
#define MX25_EXPECTED_JEDEC 0xC22019U

// Test payload size (one sector is 4 KiB on this family; stay within one sector for a single erase)
#define MX25_TEST_BYTES 256
