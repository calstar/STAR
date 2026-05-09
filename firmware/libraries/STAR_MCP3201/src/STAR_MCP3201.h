#pragma once

#include <Arduino.h>
#include <SPI.h>

class STAR_MCP3201 {
public:
    // Pass the CS pin and an already-initialized SPIClass instance.
    STAR_MCP3201(uint8_t cs_pin, SPIClass* spi);

    // Read a single 12-bit sample. Returns raw counts (0–4095).
    // Bit layout per datasheet Figure 6-1:
    //   Byte 0: [?][?][NULL][B11][B10][B9][B8][B7]
    //   Byte 1: [B6][B5][B4][B3][B2][B1][B0][B1 repeated]
    uint16_t read();

private:
    uint8_t   _cs;
    SPIClass* _spi;
};
