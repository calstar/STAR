#include <stdio.h>
#include <stdlib.h>

#include "dev_ism330dhcx.h"
#include "fake_regs.h"
#include "idle_mlc.h"

/*
 * Host tests for Idle ↔ MLC power-down policy.
 * Same fake_regs style as test_ism330dhcx.c.
 */

#define CHECK(c)                                                    \
    do {                                                            \
        if (!(c)) {                                                 \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #c); \
            exit(1);                                                \
        }                                                           \
    } while (0)

static void healthy(fake_regs_t* f) {
    fake_regs_init(f, false);
    f->regs[0x0F] = 0x6B;
    f->self_clear_reg = 0x12;
    f->self_clear_bits = 0x01;
    f->clear_after_reads = 2;
}

static void test_wake_enabled_blocks_power_down(void) {
#if STAR_MLC_IDLE_WAKE
    CHECK(idle_mlc_wake_enabled() == true);
    CHECK(idle_mlc_imu_power_down_allowed() == false);

    fake_regs_t f;
    healthy(&f);
    dev_bus_t bus = fake_regs_bus(&f);
    CHECK(ism330_init(&bus) == DEV_OK);
    unsigned after_init = f.writes;
    CHECK(f.regs[0x10] == 0x74);
    CHECK(f.regs[0x11] == 0x71);

    CHECK(idle_mlc_maybe_power_down_imu(&bus) == DEV_OK);
    /* No CTRL power-down writes when MLC Idle wake is enabled. */
    CHECK(f.writes == after_init);
    CHECK(f.regs[0x10] == 0x74);
    CHECK(f.regs[0x11] == 0x71);
#else
    CHECK(idle_mlc_wake_enabled() == false);
    CHECK(idle_mlc_imu_power_down_allowed() == true);

    fake_regs_t f;
    healthy(&f);
    dev_bus_t bus = fake_regs_bus(&f);
    CHECK(ism330_init(&bus) == DEV_OK);
    CHECK(idle_mlc_maybe_power_down_imu(&bus) == DEV_OK);
    CHECK(f.regs[0x10] == 0x00);
    CHECK(f.regs[0x11] == 0x00);
#endif
}

static void test_policy_consistency(void) {
    CHECK(idle_mlc_imu_power_down_allowed() == !idle_mlc_wake_enabled());
}

int main(void) {
    test_policy_consistency();
    test_wake_enabled_blocks_power_down();
    puts("idle_mlc: all tests passed");
    return 0;
}
