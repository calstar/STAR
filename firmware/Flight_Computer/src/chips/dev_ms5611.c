#include "dev_ms5611.h"

#include <stddef.h>

#define CMD_ADC_READ 0x00U
#define CMD_PROM_READ 0xA0U

uint8_t ms5611_crc4(const ms5611_prom_t* prom) {
    uint16_t remainder = 0;
    for (uint8_t byte = 0; byte < 16; ++byte) {
        uint16_t word = prom->word[byte / 2];
        if (byte / 2 == 7) {
            word &= 0xFF00U; /* CRC byte itself is not covered */
        }
        remainder ^=
            (byte & 1U) ? (uint16_t)(word & 0xFFU) : (uint16_t)(word >> 8);
        for (uint8_t bit = 0; bit < 8; ++bit) {
            /* Both arms uint16_t: GCC's -Wsign-compare rejects an int and an
             * unsigned int arm. AN520 keeps bits above 15, but only bits
             * 15..12 are read and higher bits never shift back down. */
            uint16_t shifted = (uint16_t)(remainder << 1);
            remainder =
                (remainder & 0x8000U) ? (uint16_t)(shifted ^ 0x3000U) : shifted;
        }
    }
    return (uint8_t)((remainder >> 12) & 0x0FU);
}

int ms5611_read_prom(const dev_bus_t* bus, ms5611_prom_t* prom) {
    if (!bus || !prom) {
        return DEV_ERR_PARAM;
    }
    uint16_t all_and = 0xFFFF, all_or = 0;
    for (uint8_t i = 0; i < 8; ++i) {
        const uint8_t tx[3] = {(uint8_t)(CMD_PROM_READ + 2U * i), 0, 0};
        uint8_t rx[3];
        if (bus->xfer(bus->ctx, tx, rx, sizeof(tx)) != DEV_OK) {
            return DEV_ERR_BUS;
        }
        prom->word[i] = (uint16_t)(rx[1] << 8 | rx[2]);
        all_and &= prom->word[i];
        all_or |= prom->word[i];
    }
    if (all_and == 0xFFFF || all_or == 0) {
        return DEV_ERR_DATA; /* dead bus: a CRC could match by chance */
    }
    return ms5611_crc4(prom) == (prom->word[7] & 0x0FU) ? DEV_OK : DEV_ERR_DATA;
}

int ms5611_start(const dev_bus_t* bus, ms5611_conversion_t which) {
    return ms5611_start_osr(bus, which, 4);
}

int ms5611_start_osr(const dev_bus_t* bus, ms5611_conversion_t which,
                     uint8_t osr_step) {
    if (!bus || osr_step > 4 ||
        (which != MS5611_D1_PRESSURE && which != MS5611_D2_TEMPERATURE)) {
        return DEV_ERR_PARAM;
    }
    /* 0x40/0x50 + 2 x step: OSR 256..4096 (AN520, datasheet p.10) */
    const uint8_t cmd = (uint8_t)((which & 0xF0U) | (2U * osr_step));
    return bus->xfer(bus->ctx, &cmd, NULL, 1) == DEV_OK ? DEV_OK : DEV_ERR_BUS;
}

int ms5611_read_adc(const dev_bus_t* bus, uint32_t* raw) {
    if (!bus || !raw) {
        return DEV_ERR_PARAM;
    }
    const uint8_t tx[4] = {CMD_ADC_READ, 0, 0, 0};
    uint8_t rx[4];
    if (bus->xfer(bus->ctx, tx, rx, sizeof(tx)) != DEV_OK) {
        return DEV_ERR_BUS;
    }
    *raw = (uint32_t)rx[1] << 16 | (uint32_t)rx[2] << 8 | rx[3];
    return *raw ? DEV_OK : DEV_ERR_DATA; /* 0: read before conversion ended */
}

void ms5611_compensate(const ms5611_prom_t* prom, uint32_t d1, uint32_t d2,
                       int32_t* temp_c100, int32_t* pressure_pa) {
    const int64_t c1 = prom->word[1], c2 = prom->word[2], c3 = prom->word[3];
    const int64_t c4 = prom->word[4], c5 = prom->word[5], c6 = prom->word[6];
    /* First order, p.8 */
    const int64_t dt = (int64_t)d2 - c5 * 256;
    int64_t temp = 2000 + dt * c6 / 8388608;   /* 2^23 */
    int64_t off = c2 * 65536 + c4 * dt / 128;  /* 2^16, 2^7 */
    int64_t sens = c1 * 32768 + c3 * dt / 256; /* 2^15, 2^8 */
    /* Second order below 20 degC, p.9 */
    if (temp < 2000) {
        const int64_t t2 = dt * dt / 2147483648LL; /* 2^31 */
        const int64_t low = (temp - 2000) * (temp - 2000);
        int64_t off2 = 5 * low / 2;
        int64_t sens2 = 5 * low / 4;
        if (temp < -1500) {
            const int64_t very_low = (temp + 1500) * (temp + 1500);
            off2 += 7 * very_low;
            sens2 += 11 * very_low / 2;
        }
        temp -= t2;
        off -= off2;
        sens -= sens2;
    }
    *temp_c100 = (int32_t)temp;
    *pressure_pa = (int32_t)(((int64_t)d1 * sens / 2097152 - off) /
                             32768); /* 2^21, 2^15 */
}
