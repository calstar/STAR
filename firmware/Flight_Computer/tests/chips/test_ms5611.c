#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "dev_ms5611.h"
#include "fake_baro.h"

#define CHECK(c)                                                    \
    do {                                                            \
        if (!(c)) {                                                 \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #c); \
            exit(1);                                                \
        }                                                           \
    } while (0)

#define kProm fake_baro_datasheet_prom

static void test_prom_read_and_crc(void) {
    fake_baro_t f = {0};
    memcpy(f.prom, kProm, sizeof(kProm));
    dev_bus_t bus = fake_baro_bus(&f);
    ms5611_prom_t p;
    CHECK(ms5611_read_prom(&bus, &p) == DEV_OK);
    CHECK(memcmp(p.word, kProm, sizeof(kProm)) == 0);
    CHECK(ms5611_crc4(&p) == 3);
    CHECK(f.transfers == 8);
}

static void test_prom_crc_mismatch_and_blank_are_rejected(void) {
    fake_baro_t f = {0};
    memcpy(f.prom, kProm, sizeof(kProm));
    f.prom[3] ^= 0x0100; /* one flipped bit */
    dev_bus_t bus = fake_baro_bus(&f);
    ms5611_prom_t p;
    CHECK(ms5611_read_prom(&bus, &p) == DEV_ERR_DATA);
    memset(f.prom, 0, sizeof(f.prom)); /* bus reads 0x00 */
    CHECK(ms5611_read_prom(&bus, &p) == DEV_ERR_DATA);
    memset(f.prom, 0xFF, sizeof(f.prom)); /* bus reads 0xFF */
    CHECK(ms5611_read_prom(&bus, &p) == DEV_ERR_DATA);
}

static void test_conversion_commands_and_adc(void) {
    fake_baro_t f = {0};
    f.d1 = 9085466;
    f.d2 = 8569150;
    dev_bus_t bus = fake_baro_bus(&f);
    uint32_t raw = 0;
    CHECK(ms5611_start(&bus, MS5611_D1_PRESSURE) == DEV_OK);
    CHECK(f.last_cmd == 0x48);
    CHECK(ms5611_read_adc(&bus, &raw) == DEV_OK && raw == 9085466);
    CHECK(ms5611_start(&bus, MS5611_D2_TEMPERATURE) == DEV_OK);
    CHECK(f.last_cmd == 0x58);
    CHECK(ms5611_read_adc(&bus, &raw) == DEV_OK && raw == 8569150);
    /* No conversion pending: the chip returns 0. */
    CHECK(ms5611_read_adc(&bus, &raw) == DEV_ERR_DATA);
    CHECK(ms5611_start(&bus, (ms5611_conversion_t)0x40) == DEV_ERR_PARAM);
    f.fail = 1;
    CHECK(ms5611_start(&bus, MS5611_D1_PRESSURE) == DEV_ERR_BUS);
}

static void compensate(uint32_t d1, uint32_t d2, int32_t* t, int32_t* p) {
    ms5611_prom_t prom;
    memcpy(prom.word, kProm, sizeof(kProm));
    ms5611_compensate(&prom, d1, d2, t, p);
}

static void test_datasheet_worked_example(void) {
    /* p.8: D1 9085466, D2 8569150 -> TEMP 2007 (20.07 C), P 100009 (Pa) */
    int32_t t, p;
    compensate(9085466, 8569150, &t, &p);
    CHECK(t == 2007);
    CHECK(p == 100009);
}

static void test_second_order_below_20c(void) {
    /* Vectors from an independent Python model of p.8-9 using C integer
     * division (truncation toward zero). */
    int32_t t, p;
    compensate(8900000, 8330000, &t, &p); /* 11.75 C: T2/OFF2/SENS2 */
    CHECK(t == 1175);
    CHECK(p == 94911);
    compensate(8500000, 7300000, &t, &p); /* -30.22 C: very-low branch */
    CHECK(t == -3022);
    CHECK(p == 79839);
}

int main(void) {
    test_prom_read_and_crc();
    test_prom_crc_mismatch_and_blank_are_rejected();
    test_conversion_commands_and_adc();
    test_datasheet_worked_example();
    test_second_order_below_20c();
    puts("ms5611: all tests passed");
    return 0;
}
