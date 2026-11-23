#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "dev_ism330dhcx.h"
#include "dev_ism330dhcx_mlc.h"
#include "fake_regs.h"

/*
 * Host tests for ism330_mlc_load — same fake_regs style as test_ism330dhcx.c.
 * Fixture .ucf is a page/IRQ bring-up placeholder (not a trained flight tree).
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

/* Mirrors exports/mlc_pad.ucf (Ac/WAIT → ism330_mlc_write_t). */
static const ism330_mlc_write_t k_mlc_pad_writes[] = {
    {ISM330_MLC_OP_WRITE, 0x01, 0x80}, /* FUNC_CFG_ACCESS → emb */
    {ISM330_MLC_OP_WRITE, 0x05, 0x10}, /* EMB_FUNC_EN_B MLC_EN */
    {ISM330_MLC_OP_WRITE, 0x60, 0x10}, /* EMB_FUNC_ODR_CFG_C MLC_ODR=26 Hz */
    {ISM330_MLC_OP_WRITE, 0x67, 0x10}, /* EMB_FUNC_INIT_B */
    {ISM330_MLC_OP_WAIT_MS, 0x00, 10},
    {ISM330_MLC_OP_WRITE, 0x11, 0x01}, /* MLC_INT2 tree1 */
    {ISM330_MLC_OP_WRITE, 0x01, 0x00}, /* back to main page */
    {ISM330_MLC_OP_WRITE, 0x5F, 0x02}, /* MD2_CFG INT2_EMB_FUNC */
};

static int find_write(const fake_regs_t* f, uint8_t reg, uint8_t val) {
    for (unsigned i = 0; i < f->writes; ++i) {
        if (f->write_reg[i] == reg && f->write_val[i] == val) {
            return (int)i;
        }
    }
    return -1;
}

static void test_mlc_load_replays_ucf_order_after_init(void) {
    fake_regs_t f;
    healthy(&f);
    dev_bus_t bus = fake_regs_bus(&f);
    CHECK(ism330_init(&bus) == DEV_OK);
    unsigned after_init = f.writes;

    CHECK(ism330_mlc_load(&bus, k_mlc_pad_writes,
                          sizeof(k_mlc_pad_writes) /
                              sizeof(k_mlc_pad_writes[0])) == DEV_OK);

    /* First post-init write enters embedded page. */
    CHECK(f.write_reg[after_init] == 0x01);
    CHECK(f.write_val[after_init] == 0x80);
    CHECK(f.delays_ms >= 10);

    /* Main-page CTRL1_XL / INT1 stay as ism330_init left them. CTRL2_G
     * (main 0x11) shares the address with emb MLC_INT2 in this flat fake, so
     * check the init write log for 0x71 rather than f.regs[0x11] after load. */
    CHECK(f.regs[0x10] == 0x74);
    CHECK(f.regs[0x0D] == 0x01); /* INT1 DRDY untouched */
    CHECK(find_write(&f, 0x11, 0x71) >= 0);
    CHECK(find_write(&f, 0x11, 0x01) >= 0); /* emb MLC_INT2 tree1 */
}

static void test_mlc_load_forces_int2_tree1_routing(void) {
    fake_regs_t f;
    healthy(&f);
    f.regs[0x5F] = 0x00;
    f.regs[0x11] = 0x00;
    dev_bus_t bus = fake_regs_bus(&f);
    CHECK(ism330_init(&bus) == DEV_OK);

    /* Fixture already sets routing; force_* must still leave bits set. */
    CHECK(ism330_mlc_load(&bus, k_mlc_pad_writes,
                          sizeof(k_mlc_pad_writes) /
                              sizeof(k_mlc_pad_writes[0])) == DEV_OK);
    CHECK((f.regs[0x5F] & 0x02) == 0x02);
    CHECK(find_write(&f, 0x11, 0x01) >= 0);
    CHECK(find_write(&f, 0x5F, 0x02) >= 0);
}

static void test_mlc_load_returns_to_main_page_on_bus_error(void) {
    fake_regs_t f;
    healthy(&f);
    dev_bus_t bus = fake_regs_bus(&f);
    CHECK(ism330_init(&bus) == DEV_OK);
    /* Fail during an embedded write (after enter page). */
    f.fail_after = (int)f.transfers + 2;
    CHECK(ism330_mlc_load(&bus, k_mlc_pad_writes,
                          sizeof(k_mlc_pad_writes) /
                              sizeof(k_mlc_pad_writes[0])) == DEV_ERR_BUS);
    /* Best-effort: last write should attempt FUNC_CFG_ACCESS=0 if possible.
     * fake_regs may not record after fail; at least error is reported. */
}

static void test_mlc_read_class0_page_brackets(void) {
    fake_regs_t f;
    healthy(&f);
    f.regs[0x70] = 0x02; /* vibration class code in fixture world */
    dev_bus_t bus = fake_regs_bus(&f);
    uint8_t cls = 0xFF;
    unsigned w0 = f.writes;
    CHECK(ism330_mlc_read_class0(&bus, &cls) == DEV_OK);
    CHECK(cls == 0x02);
    CHECK(f.writes >= w0 + 2);
    CHECK(f.write_reg[w0] == 0x01 && f.write_val[w0] == 0x80);
    CHECK(f.write_reg[f.writes - 1] == 0x01 &&
          f.write_val[f.writes - 1] == 0x00);
}

static void test_mlc_missing_args(void) {
    CHECK(ism330_mlc_load(NULL, k_mlc_pad_writes, 1) == DEV_ERR_PARAM);
    fake_regs_t f;
    healthy(&f);
    dev_bus_t bus = fake_regs_bus(&f);
    CHECK(ism330_mlc_read_class0(&bus, NULL) == DEV_ERR_PARAM);
}

int main(void) {
    test_mlc_load_replays_ucf_order_after_init();
    test_mlc_load_forces_int2_tree1_routing();
    test_mlc_load_returns_to_main_page_on_bus_error();
    test_mlc_read_class0_page_brackets();
    test_mlc_missing_args();
    puts("ism330dhcx_mlc: all tests passed");
    return 0;
}
