#!/usr/bin/env python3
"""Break each RTL stage on purpose and confirm its test goes red.

A test that cannot fail is not a test. For each mutation below, copy rtl/ to a
scratch directory, apply one small, plausible bug, and run the test meant to
catch it. The script fails if any mutant survives (its test still passes) or
if a mutation no longer applies (the code it targets moved).

    /usr/bin/python3.12 dvbt-tx/scripts/mutation_check.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

GW = Path(__file__).resolve().parents[1] / "gateware"

# (file, original text, mutated text, pytest -k expression, what it models)
MUTATIONS = [
    ("dvbt_energy_dispersal.v", "15'b000_0000_1010_1001", "15'b000_0000_1010_1011",
     "energy_dispersal and 1]", "wrong PRBS seed"),
    ("dvbt_energy_dispersal.v", "m_data <= ~s_data;", "m_data <= s_data;",
     "energy_dispersal and 1]", "sync byte not inverted"),
    ("dvbt_rs_encoder.v", "7: gcoef = 8'ha3;", "7: gcoef = 8'ha2;",
     "rs_encoder and 1]", "one generator coefficient wrong"),
    ("dvbt_outer_interleaver.v", "4'd7: last = 8'd118;", "4'd7: last = 8'd117;",
     "outer_interleaver and 1]", "one branch one byte short"),
    ("dvbt_inner_coder.v", "b ^ sr[1] ^ sr[2] ^ sr[4] ^ sr[5];", "b ^ sr[1] ^ sr[2] ^ sr[3] ^ sr[5];",
     "inner_coder-qpsk-12 and 1]", "wrong G2 tap"),
    ("dvbt_inner_coder.v", "keep_x = 7'b1010001", "keep_x = 7'b1000101",
     "inner_coder-qpsk-78 and 1]", "7/8 puncture pattern reversed"),
    ("dvbt_bit_interleaver.v", "raddr(rbank, rw, 7'd105)", "raddr(rbank, rw, 7'd104)",
     "bit_interleaver-16qam and 1]", "I2 offset off by one"),
    ("dvbt_bit_interleaver.v", "b[0] = s_sym[3]; b[2] = s_sym[2]; b[1] = s_sym[1];",
     "b[0] = s_sym[3]; b[1] = s_sym[2]; b[2] = s_sym[1];",
     "bit_interleaver-16qam and 1]", "16QAM demux in natural order"),
    ("dvbt_symbol_interleaver.v", "rp[0] ^ rp[3]", "rp[0] ^ rp[2]",
     "symbol_interleaver-qpsk and 1]", "wrong LFSR tap"),
    ("dvbt_symbol_interleaver.v", ".restart(rst || rdone), .next(give && rodd)",
     ".restart(rst || rdone), .next(give && !rodd)",
     "symbol_interleaver-qpsk and 1]", "even/odd direction swapped on read"),
    ("dvbt_mapper.v", "QAM16_3 = 16'sd7772", "QAM16_3 = 16'sd7700",
     "mapper-16qam and 1]", "16QAM outer level wrong"),
    ("dvbt_mapper.v", "m_q     <= y[1] ? -mq : mq;", "m_q     <= y[1] ? mq : -mq;",
     "mapper-qpsk and 1]", "Q sign inverted"),
    ("dvbt_frame_builder.v", "w   <= {w[9:0], w[10] ^ w[8]};", "w   <= {w[9:0], w[10] ^ w[7]};",
     "frame_builder-qpsk and 1]", "pilot PRBS wrong tap"),
    ("dvbt_frame_builder.v", "16'b0011010111101110", "16'b0011010111101111",
     "frame_builder-qpsk and 1]", "TPS sync word one bit wrong"),
    ("dvbt_frame_builder.v", "14'b00_0011_0111_0111", "14'b00_0011_0111_0110",
     "frame_builder-qpsk and 1]", "BCH generator one bit wrong"),
    ("dvbt_frame_builder.v", "{2'b00, l[1:0], 1'b0} + {3'b000, l[1:0]}", "{2'b00, l[1:0], 1'b0}",
     "frame_builder-qpsk and 1]", "scattered pilots at 2 (l mod 4), not 3"),
    ("dvbt_frame_builder.v", "40: cp_pos = 1323;", "40: cp_pos = 1324;",
     "frame_builder-qpsk and 1]", "one continual pilot moved"),
    ("dvbt_fft2048.v", "out_re <= d_im;\n                        out_im <= -d_re;",
     "out_re <= -d_im;\n                        out_im <= d_re;",
     "fft2048 and 1]", "-j rotation is +j"),
    ("dvbt_fft2048.v", "(b ? {n2[QW-2:0], 1'b0} : 0)", "(b ? n2 : 0)",
     "fft2048 and 1]", "twiddle exponent n2 (h + b), not n2 (h + 2b)"),
    ("dvbt_fft2048.v", "r = {v[18], v} + {19'd0, v[1]};", "r = {v[18], v} + 20'sd0;",
     "fft2048 and 1]", "truncating instead of rounding when halving"),
    ("dvbt_fft2048.v", "r = {v[18], v} + {19'd0, v[1]};", "r = {v[18], v} + 20'sd1;",
     "fft2048 and 1]", "round half up (biased) instead of half to even"),
    ("dvbt_ifft_in.v", "wire [10:0] bin = wk + 11'd1196;", "wire [10:0] bin = wk + 11'd1197;",
     "modulator-qpsk and 1]", "carriers one bin off"),
    ("dvbt_ifft_in.v", "m_re <= {{2{rword[15]}}, rword[15:0]};   // Q",
     "m_re <= {{2{rword[31]}}, rword[31:16]};  // Q",
     "modulator-qpsk and 1]", "IFFT input not swapped (I on both)"),
    ("dvbt_gi_insert.v", "(12'd2048 - ng + j)", "(12'd2047 - ng + j)",
     "modulator-qpsk and 1]", "cyclic prefix taken one sample early"),
]


def main() -> int:
    survivors, stale = [], []
    for fname, old, new, kexpr, what in MUTATIONS:
        with tempfile.TemporaryDirectory() as tmp:
            rtl = Path(tmp) / "rtl"
            shutil.copytree(GW / "rtl", rtl)
            src = (rtl / fname).read_text()
            if src.count(old) != 1:
                stale.append(f"{fname}: {what} (target text not found exactly once)")
                continue
            (rtl / fname).write_text(src.replace(old, new))
            env = dict(os.environ, DVBT_RTL_DIR=str(rtl), DVBT_SIM_BUILD=str(Path(tmp) / "sim"))
            r = subprocess.run(
                [sys.executable, "-m", "pytest", "-q", "-x", "test_rtl.py", "-k", kexpr],
                cwd=GW, env=env, capture_output=True, text=True,
            )
            ran = "passed" in r.stdout or "failed" in r.stdout
            killed = r.returncode != 0 and "failed" in r.stdout
            status = "killed" if killed else ("SURVIVED" if ran else "DID NOT RUN")
            print(f"{status:12s} {fname:28s} {what}")
            if not killed:
                survivors.append(f"{fname}: {what}\n{r.stdout[-800:]}")
    for s in stale:
        print("STALE       ", s)
    if survivors or stale:
        print(f"\n{len(survivors)} survived / did not run, {len(stale)} stale")
        return 1
    print(f"\nall {len(MUTATIONS)} mutants killed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
