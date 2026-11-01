#!/usr/bin/env python3
"""Design the two 2x half-band interpolators (6.857 -> 13.71 -> 27.43 MS/s).

The DVB-T 6 MHz signal reaches +-2.854 MHz (1705 of 2048 carriers at 48/7
MS/s), so stage 1's transition band is only 2.854 -> 4.003 MHz. A half-band
filter's odd taps are zero except the centre (0.5), so per output sample only
the odd-phase coefficients g_k (symmetric, applied to pre-added sample pairs)
cost anything. Designed with the Type-II trick: g is a Remez lowpass of half
the length, which forces the half-band zeros exactly.

Prints the quantized odd-phase coefficients (1.0 = 2^17, sum 2^17 exactly so
DC gain is unity), the response achieved after quantization, and the number
of signed digits each costs (the RTL multiplies by shift-and-add).

    python3 dvbt-tx/scripts/gen_halfband.py
"""
from __future__ import annotations

import numpy as np
from scipy import signal

FS0 = 48e6 / 7
EDGE = 1705 / 2048 * FS0 / 2
ONE = 1 << 17
STAGES = {"st1": (2 * FS0, 28), "st2": (4 * FS0, 8)}  # (output rate, taps in g)


def csd(v: int) -> list[int]:
    """Canonical signed digits of v, LSB first."""
    out = []
    while v:
        if v & 1:
            d = 2 - (v & 3)  # +1 or -1
            v -= d
        else:
            d = 0
        out.append(d)
        v >>= 1
    return out


def design(fs: float, m: int) -> np.ndarray:
    fp = EDGE / fs
    g = signal.remez(m, [0, 2 * fp], [1], fs=1.0)
    q = np.round(g * ONE).astype(int)
    # Keep the DC gain exact: put the rounding residue on the middle pair.
    res = ONE - q.sum()
    q[m // 2 - 1] += res // 2
    q[m // 2] += res - res // 2
    return q


def response(q: np.ndarray, fs: float) -> tuple[float, float]:
    n = 2 * len(q) - 1
    h = np.zeros(n)
    h[0::2] = q / ONE / 2
    h[n // 2] = 0.5
    w, hh = signal.freqz(h, worN=1 << 15, fs=1.0)
    mag = np.abs(hh) * 2
    fp = EDGE / fs
    return np.ptp(20 * np.log10(mag[w <= fp])), 20 * np.log10(mag[w >= 0.5 - fp].max())


if __name__ == "__main__":
    for name, (fs, m) in STAGES.items():
        q = design(fs, m)
        assert q.sum() == ONE and np.all(q == q[::-1])
        rip, stop = response(q, fs)
        half = q[m // 2:]  # centre outwards: g at offsets 0.5, 1.5, 2.5 ... input samples
        digits = [sum(1 for d in csd(abs(int(v))) if d) for v in half]
        print(f"{name}: {2 * m - 1} taps, {len(half)} unique, ripple {rip:.4f} dB, "
              f"stopband {stop:.1f} dB, {sum(digits)} signed digits")
        print("  " + ", ".join(str(int(v)) for v in half))
