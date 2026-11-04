#!/usr/bin/env python3
"""Plant integration bugs in the firmware and the RTL and confirm the
end-to-end test goes red for each. A test that cannot fail is not a test.

Each mutant copies esp32p4/components and gateware/rtl, applies one small
change of the kind that only shows up when the pieces meet, rebuilds the
harness and runs the scenario meant to catch it. The script fails if any
mutant survives or no longer applies.

    /usr/bin/python3.12 test/e2e/mutation_check.py [filter]
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
COMP, RTL = ROOT / "esp32p4/components", ROOT / "gateware/rtl"

# (tree, file, original, mutated, test, what it models)
MUTANTS = [
    ("fw", "tx_app/tx_app.c", "while (l->wait_dreq(l->ctx, 0)) {",
     "for (sb = DVBT_SB_DREQ; sb & DVBT_SB_DREQ;) {",
     "no_image", "FIFO priming trusts the stale status byte (bring-up hangs)"),
    ("fw", "tx_app/tx_app.c", "fpga_ts_send(a->b->link, a->pkts, 2, a->c.health_ms, &sb)",
     "fpga_ts_send(a->b->link, a->pkts, 2, 1000, &sb)",
     "fpga_loss", "the pump waits a second for DREQ with the FPGA gone, RF on"),
    ("fw", "tx_app/tx_app.c", "DVBT_CTRL_GUARD(c->guard);  // two's complement",
     "DVBT_CTRL_GUARD(c->guard) | DVBT_CTRL_DAC_UNSIGNED;",
     "no_image", "FPGA sends offset binary, DAC set for two's complement"),
    ("fw", "tx_app/tx_app.c", "while (!b->gpio_get(b->ctx, TX_PIN_LDET)) {", "while (0) {",
     "pll_never", "RF on without waiting for the PLL to lock"),
    ("fw", "tx_app/tx_app.c", "if (!b->gpio_get(b->ctx, TX_PIN_LDET)) f |= TX_F_LO_UNLOCK;", "",
     "lo_unlock", "health check ignores LDET"),
    ("fw", "tx_app/tx_app.c", "192000000ull, 7, 2, &a->clk", "192000000ull, 7, 1, &a->clk",
     "no_image", "Si5351A CLK1 (the DAC's CLKIN) never enabled"),
    ("fw", "tx_app/tx_app.c", "ts_dvbt_rate(c->bw_mhz, c->mod, c->rate, c->guard,",
     "ts_dvbt_rate(c->bw_mhz, c->mod, c->rate, 0,",
     "no_image", "mux rate for guard 1/32 while the FPGA runs 1/8 (PCR drift, FIFO starves)"),
    ("fw", "ad9116/ad9116.c", "uint8_t dc = AD9116_IFIRST | AD9116_IRISING |", "uint8_t dc = AD9116_IFIRST |",
     "no_image", "DAC latches Q on the rising edge: I and Q swapped"),
    ("fw", "adrf6755/adrf6755_plan.c", "{29, 0x80},", "{29, 0x81},",
     "no_image", "modulator powered up in the init sequence, before lock"),
    ("fw", "adrf6755/adrf6755_plan.c", "{1155000000ull, 0}, {577500000ull, 1},", "{1155000000ull, 1}, {577500000ull, 1},",
     "no_image", "RFDIV off by one: LO at half the carrier"),
    ("fw", "spi_bus_esp/spi_bus_pack.c", "f->rx_bits = nbits - wr_bits;", "f->rx_bits = nbits - wr_bits + 1;",
     "no_image", "3-wire read one bit long: AD9116 read-back shifted"),
    ("fw", "ecp5_cfg/ecp5_cfg_core.c", "h->delay_us(h->ctx, 10000);\n    if ((e = cmd(h, OP_RESET_CRC",
     "if ((e = cmd(h, OP_RESET_CRC", "rejected_bitstream", "(control: removing a delay changes nothing)"),
    ("rtl", "dvbt_tx_top.v", ".D0(1'b1), .D1(1'b0), .Q(dac_dclk)", ".D0(1'b0), .D1(1'b1), .Q(dac_dclk)",
     "no_image", "DCLKIO inverted: the DAC pairs Q with the next I"),
    ("rtl", "dvbt_tx_top.v", "ODDRX1F u_dclk (.SCLK(clk90)", "ODDRX1F u_dclk (.SCLK(clk)",
     "no_image", "DCLKIO in phase with the data: latched on the transition"),
    ("rtl", "dvbt_host.v", "dreq     <= (f_free >= 376);", "dreq     <= (f_free >= 188);",
     "p4_stall_longer", "DREQ promises room for one packet, the firmware sends two"),
    ("rtl", "dvbt_tx_core.v", "parameter integer TS_FIFO_AW = 14", "parameter integer TS_FIFO_AW = 11",
     "p4_under_load", "the 2 KB TS FIFO again: a busy P4 makes the FPGA insert nulls"),
    ("fw", "tx_app/tx_app.c", "ts_mux_skip(&a->mux, DVBT_ST_NULLS(st));", "",
     "p4_stall_longer", "mux clock not caught up after FPGA nulls: PCRs late for good"),
    ("fw", "adrf6755/adrf6755_plan.c", "uint64_t ref_max = refin_hz + ((uint64_t)refin_hz * tol_ppm + 999999) / 1000000;",
     "uint64_t ref_max = refin_hz;", "tcxo", "PFD sized for the nominal TCXO: a fast one never locks"),
    ("fw", "tx_app/tx_app.c", "TRY(fpga_reg_write(l, DVBT_REG_DCOFF,", "if (0) TRY(fpga_reg_write(l, DVBT_REG_DCOFF,",
     "lo_feedthrough", "the bench calibration never reaches the FPGA"),
    # Channels and hops (the flight computer's UART).
    ("fw", "tx_app/tx_app.c", "    esp_err_t e = lo_lock(a);\n    bool ok = e == ESP_OK;",
     "    esp_err_t e = adrf6755_init(&a->mod, &a->lo, a->c.atten_db);\n    bool ok = e == ESP_OK;",
     "hop_commands", "hop turns the modulator on without waiting for the new channel's lock"),
    ("fw", "tx_app/tx_app.c", "    announce(a);\n    logf_(a, 'I', \"hop %u: to", "    logf_(a, 'I', \"hop %u: to",
     "hop_commands", "hop never announced in the stream: the ground cannot follow"),
    ("fw", "ts_mux/ts_mux.c", "uint32_t nx = c->pending ? c->next_khz : c->cur_khz;", "uint32_t nx = c->cur_khz;",
     "hop_commands", "the table announces the current channel as the next one"),
    ("fw", "tx_app/tx_app.c", "a->hop.t27 + a->latency27", "a->hop.t27",
     "hop_commands", "hop when the mux reaches the time, not the air: 30 ms early"),
    ("fw", "tx_app/tx_app.c", "    if (!in_band(a, hz)) { fc_reply(a, \"NAK,%u,RANGE\", cmd->seq); return; }\n", "",
     "hop_commands", "a channel outside the band accepted"),
    ("fw", "tx_app/tx_app.c", "    if (a->done_valid && cmd->seq == a->done_seq) {", "    if (0) {",
     "hop_commands", "a retry of a finished hop treated as a new command"),
    ("fw", "fc_link/fc_link.c", "if (h < 0 || l < 0 || (uint8_t)(h << 4 | l) != fc_csum(line, (size_t)(star - line))) {",
     "if (h < 0 || l < 0) {", "hop_commands", "flight computer line checksum ignored"),
    ("fw", "tx_app/tx_app.c", "        if (a->b->keyframe) a->b->keyframe(a->b->ctx);\n", "",
     "hop_commands", "no key frame after a hop: the ground waits up to a GOP for a picture"),
    ("fw", "tx_app/tx_app.c", "        a->lo = old;\n        e = lo_lock(a);", "        e = ESP_FAIL;",
     "will_not_lock", "a channel that will not lock leaves the RF off instead of going back"),
    ("fw", "tx_app/tx_app.c", "    if (!in_band(a, c->lo_hz)) {", "    if (0) {",
     "out_of_band_boot", "an out-of-band boot channel transmitted"),
]
EXPECT_SURVIVE = {"(control: removing a delay changes nothing)"}


def main() -> int:
    filt = sys.argv[1] if len(sys.argv) > 1 else ""
    bad = 0
    for tree, f, a, b, test, what in MUTANTS:
        if filt and filt not in f and filt not in what:
            continue
        with tempfile.TemporaryDirectory() as tmp:
            comp, rtl = Path(tmp) / "components", Path(tmp) / "rtl"
            shutil.copytree(COMP, comp)
            shutil.copytree(RTL, rtl)
            p = (comp if tree == "fw" else rtl) / f
            src = p.read_text()
            if src.count(a) != 1:
                print(f"STALE        {f:28s} {what}")
                bad += 1
                continue
            p.write_text(src.replace(a, b))
            env = dict(os.environ, DVBT_E2E_FW_DIR=str(comp), DVBT_E2E_RTL_DIR=str(rtl),
                       DVBT_E2E_BUILD=str(Path(tmp) / "build"))
            r = subprocess.run([sys.executable, "-m", "pytest", "-q", "-x", "-p", "no:cacheprovider",
                                str(HERE / "test_e2e.py"), "-k", test], env=env, capture_output=True, text=True,
                               timeout=3600)
            survived = r.returncode == 0
            control = what in EXPECT_SURVIVE
            if survived and not control:
                bad += 1
            tag = ("survived" if survived else "killed") + (" (control)" if control else "")
            if control and not survived:
                bad += 1
                tag = "CONTROL FAILED"
            print(f"{tag:12s} {f:28s} {what}", flush=True)
    print("all mutants killed" if not bad else f"{bad} problem(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
