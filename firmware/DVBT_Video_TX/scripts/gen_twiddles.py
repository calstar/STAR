#!/usr/bin/env python3
"""Twiddle ROMs for rtl/dvbt_fft2048.v: one file per stage pair, sub-FFT size
M = 2048, 512, 128, 32, 8, entries e = 0 .. 3M/4 - 1 (the largest index the
pair's merged twiddle W_M^(n2 (h + 2b)) reaches is 3 (M/4 - 1)).

Each line is 9 hex digits: {re[17:0], im[17:0]} of W_M^e = exp(-j 2 pi e / M),
scaled by 2^16 and rounded (so 1.0 = 65536, inside an 18-bit signed word).

    python3 firmware/DVBT_Video_TX/scripts/gen_twiddles.py     # writes gateware/rtl/rom/tw_<M>.hex
"""
from math import cos, pi, sin
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "gateware" / "rtl" / "rom"
ONE = 1 << 16


def word(v: int) -> int:
    return v & 0x3FFFF


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for m in (2048, 512, 128, 32, 8):
        lines = []
        for e in range(3 * m // 4):
            re = round(ONE * cos(2 * pi * e / m))
            im = round(-ONE * sin(2 * pi * e / m))
            lines.append(f"{(word(re) << 18) | word(im):09x}")
        (OUT / f"tw_{m}.hex").write_text("\n".join(lines) + "\n")
        print(f"tw_{m}.hex: {len(lines)} entries")


if __name__ == "__main__":
    main()
