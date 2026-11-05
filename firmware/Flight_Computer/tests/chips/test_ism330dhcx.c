#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "dev_ism330dhcx.h"
#include "fake_regs.h"

#define CHECK(c)                                                    \
    do {                                                            \
        if (!(c)) {                                                 \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #c); \
            exit(1);                                                \
        }                                                           \
    } while (0)

/* A chip that answers WHO_AM_I and finishes its reset after two reads. */
static void healthy(fake_regs_t* f) {
    fake_regs_init(f, false);
    f->regs[0x0F] = 0x6B;
    f->self_clear_reg = 0x12;
    f->self_clear_bits = 0x01;
    f->clear_after_reads = 2;
}

static void test_init_writes_the_datasheet_configuration(void) {
    fake_regs_t f;
    healthy(&f);
    dev_bus_t bus = fake_regs_bus(&f);
    CHECK(ism330_init(&bus) == DEV_OK);
    /* Reset first, then the configuration in this order (DS13012 Rev 7). */
    static const uint8_t reg[] = {0x12, 0x12, 0x13, 0x10, 0x11, 0x0B, 0x0D};
    static const uint8_t val[] = {0x01, 0x44, 0x04, 0x74, 0x71, 0x80, 0x01};
    CHECK(f.writes == sizeof(reg));
    for (unsigned i = 0; i < sizeof(reg); ++i) {
        CHECK(f.write_reg[i] == reg[i]);
        CHECK(f.write_val[i] == val[i]);
    }
    CHECK(f.delays_ms >= 1);
}

static void test_wrong_identity_is_refused_before_any_write(void) {
    fake_regs_t f;
    healthy(&f);
    f.regs[0x0F] = 0x6A;
    dev_bus_t bus = fake_regs_bus(&f);
    CHECK(ism330_init(&bus) == DEV_ERR_ID);
    CHECK(f.writes == 0);
}

static void test_dead_bus_reads_ff_and_is_refused(void) {
    fake_regs_t f;
    fake_regs_init(&f, false);
    memset(f.regs, 0xFF, sizeof(f.regs));
    dev_bus_t bus = fake_regs_bus(&f);
    CHECK(ism330_init(&bus) == DEV_ERR_ID);
}

static void test_reset_that_never_finishes_times_out(void) {
    fake_regs_t f;
    healthy(&f);
    f.clear_after_reads = 0; /* SW_RESET stays set */
    dev_bus_t bus = fake_regs_bus(&f);
    CHECK(ism330_init(&bus) == DEV_ERR_TIMEOUT);
    CHECK(f.writes == 1); /* only the reset itself */
}

static void test_register_that_does_not_read_back_fails(void) {
    fake_regs_t f;
    healthy(&f);
    f.stuck[0x10] = 0x0F; /* low bits of CTRL1_XL ignore writes */
    f.regs[0x10] = 0x0A;
    dev_bus_t bus = fake_regs_bus(&f);
    CHECK(ism330_init(&bus) == DEV_ERR_VERIFY);
}

static void test_bus_error_is_reported(void) {
    fake_regs_t f;
    healthy(&f);
    f.fail_after = 3;
    dev_bus_t bus = fake_regs_bus(&f);
    CHECK(ism330_init(&bus) == DEV_ERR_BUS);
}

static void test_read_decodes_the_burst(void) {
    fake_regs_t f;
    healthy(&f);
    /* 20h..2Dh: temp 0x0100 (+1 degC), gyro x/y/z, accel x/y/z,
     * little-endian, two's complement. */
    static const uint8_t out[14] = {0x00, 0x01, 0x34, 0x12, 0xCC, 0xED, 0x00,
                                    0x80, 0xFF, 0x7F, 0x01, 0x00, 0x00, 0xF8};
    memcpy(&f.regs[0x20], out, sizeof(out));
    dev_bus_t bus = fake_regs_bus(&f);
    ism330_sample_t s;
    CHECK(ism330_read(&bus, &s) == DEV_OK);
    CHECK(s.temp == 256);
    CHECK(s.gyro[0] == 0x1234);
    CHECK(s.gyro[1] == -0x1234);
    CHECK(s.gyro[2] == -32768);
    CHECK(s.accel[0] == 32767);
    CHECK(s.accel[1] == 1);
    CHECK(s.accel[2] == -2048); /* -2048 x 0.488 mg = -1.0 g */
    CHECK(f.transfers == 1);    /* one burst, not 7 reads */
}

static void test_missing_arguments_are_refused(void) {
    CHECK(ism330_init(NULL) == DEV_ERR_PARAM);
    fake_regs_t f;
    healthy(&f);
    dev_bus_t bus = fake_regs_bus(&f);
    CHECK(ism330_read(&bus, NULL) == DEV_ERR_PARAM);
}

int main(void) {
    test_init_writes_the_datasheet_configuration();
    test_wrong_identity_is_refused_before_any_write();
    test_dead_bus_reads_ff_and_is_refused();
    test_reset_that_never_finishes_times_out();
    test_register_that_does_not_read_back_fails();
    test_bus_error_is_reported();
    test_read_decodes_the_burst();
    test_missing_arguments_are_refused();
    puts("ism330dhcx: all tests passed");
    return 0;
}
