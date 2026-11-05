#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "dev_h3lis100dl.h"
#include "fake_regs.h"

#define CHECK(c)                                                    \
    do {                                                            \
        if (!(c)) {                                                 \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #c); \
            exit(1);                                                \
        }                                                           \
    } while (0)

static void healthy(fake_regs_t* f) {
    fake_regs_init(f, true); /* MS bit selects auto-increment */
    f->regs[0x0F] = 0x32;
    f->regs[0x20] = 0x07; /* power-on default: power-down (p.24) */
}

static void test_init_writes_the_datasheet_configuration(void) {
    fake_regs_t f;
    healthy(&f);
    dev_bus_t bus = fake_regs_bus(&f);
    CHECK(h3lis_init(&bus) == DEV_OK);
    static const uint8_t reg[] = {0x23, 0x22, 0x20};
    static const uint8_t val[] = {0x00, 0x02, 0x37};
    CHECK(f.writes == sizeof(reg));
    for (unsigned i = 0; i < sizeof(reg); ++i) {
        CHECK(f.write_reg[i] == reg[i]);
        CHECK(f.write_val[i] == val[i]);
    }
}

static void test_wrong_identity_is_refused_before_any_write(void) {
    fake_regs_t f;
    healthy(&f);
    f.regs[0x0F] = 0x33; /* not 0x32 (note: the H3LIS331DL also says 0x32) */
    dev_bus_t bus = fake_regs_bus(&f);
    CHECK(h3lis_init(&bus) == DEV_ERR_ID);
    CHECK(f.writes == 0);
}

static void test_read_back_mismatch_fails(void) {
    fake_regs_t f;
    healthy(&f);
    f.stuck[0x22] = 0x02; /* INT1 routing bit stuck low */
    dev_bus_t bus = fake_regs_bus(&f);
    CHECK(h3lis_init(&bus) == DEV_ERR_VERIFY);
}

static void test_bus_error_is_reported(void) {
    fake_regs_t f;
    healthy(&f);
    f.fail_after = 2;
    dev_bus_t bus = fake_regs_bus(&f);
    CHECK(h3lis_init(&bus) == DEV_ERR_BUS);
}

static void test_read_takes_x_y_z_from_29_2b_2d(void) {
    fake_regs_t f;
    healthy(&f);
    f.regs[0x29] = 0x81; /* -127: -99.06 g */
    f.regs[0x2A] = 0x55; /* reserved, must be skipped */
    f.regs[0x2B] = 0x01; /* +1: 0.78 g */
    f.regs[0x2C] = 0x55;
    f.regs[0x2D] = 0x7F; /* +127 */
    dev_bus_t bus = fake_regs_bus(&f);
    h3lis_sample_t s;
    CHECK(h3lis_read(&bus, &s) == DEV_OK);
    CHECK(s.accel[0] == -127);
    CHECK(s.accel[1] == 1);
    CHECK(s.accel[2] == 127);
    CHECK(f.transfers == 1);
}

static void test_read_without_ms_bit_would_read_x_three_times(void) {
    /* Guards the MS bit: with increment off the fake returns X for every
     * byte, so a correct driver must see distinct Y and Z. */
    fake_regs_t f;
    healthy(&f);
    f.regs[0x29] = 10;
    f.regs[0x2B] = 20;
    f.regs[0x2D] = 30;
    dev_bus_t bus = fake_regs_bus(&f);
    h3lis_sample_t s;
    CHECK(h3lis_read(&bus, &s) == DEV_OK);
    CHECK(s.accel[1] == 20 && s.accel[2] == 30);
}

int main(void) {
    test_init_writes_the_datasheet_configuration();
    test_wrong_identity_is_refused_before_any_write();
    test_read_back_mismatch_fails();
    test_bus_error_is_reported();
    test_read_takes_x_y_z_from_29_2b_2d();
    test_read_without_ms_bit_would_read_x_three_times();
    puts("h3lis100dl: all tests passed");
    return 0;
}
