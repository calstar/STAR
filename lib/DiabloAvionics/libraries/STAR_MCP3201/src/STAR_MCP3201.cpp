#include "STAR_MCP3201.h"

STAR_MCP3201::STAR_MCP3201(uint8_t cs_pin, SPIClass* spi)
    : _cs(cs_pin), _spi(spi) {}

uint16_t STAR_MCP3201::read() {
    _spi->beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
    digitalWrite(_cs, LOW);
    uint8_t hi = _spi->transfer(0);
    uint8_t lo = _spi->transfer(0);
    digitalWrite(_cs, HIGH);
    _spi->endTransaction();

    // Mask out the 2 don't-care bits and the null bit from byte 0,
    // then combine with byte 1 after stripping the repeated LSB.
    return (uint16_t)((hi & 0x1F) << 7) | (uint16_t)(lo >> 1);
}
