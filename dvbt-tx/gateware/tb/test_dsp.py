"""cocotb tests for the sample-rate back end: gain/IQ trim + 4x interpolation.

References are the definitions, not a model of the RTL: the trim is
i' = g_i i, q' = g_q q + p i in floating point, and the filters are
scipy's upfirdn with the design coefficients (scripts/gen_halfband.py --
the filter's specification). The spectrum test checks the image rejection
the design promises against a DVB-T-shaped signal.
"""

from __future__ import annotations

import sys
from pathlib import Path

import cocotb
import numpy as np
from scipy import signal

from streams import reset, seed, stream

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import gen_halfband  # noqa: E402

FULL = 131071
EDGE = gen_halfband.EDGE
FS0 = gen_halfband.FS0


def _s18(v: int) -> int:
    return v - (1 << 18) if v >= (1 << 17) else v


def halfband_taps(q: np.ndarray) -> np.ndarray:
    """Full impulse response (gain 2, for zero-stuffing) from the odd-phase g
    (gen_halfband.design returns all of g, both halves)."""
    g = q / gen_halfband.ONE
    h = np.zeros(2 * len(g) - 1)
    h[0::2] = g
    h[len(h) // 2] = 1.0
    return h


H1 = halfband_taps(gen_halfband.design(*gen_halfband.STAGES["st1"]))
H2 = halfband_taps(gen_halfband.design(*gen_halfband.STAGES["st2"]))


def reference(x: np.ndarray, gi: int, gq: int, ph: int) -> np.ndarray:
    a = gi / 16384 * x.real + 1j * (gq / 16384 * x.imag + ph / 16384 * x.real)
    return signal.upfirdn(H2, signal.upfirdn(H1, a, up=2), up=2)


async def run(dut, x, gi, gq, ph, p_valid, p_ready):
    dut.gain_i.value = gi
    dut.gain_q.value = gq
    dut.phase.value = ph & 0xFFFF
    await reset(dut)
    ins = [{"s_i": int(v.real) & 0x3FFFF, "s_q": int(v.imag) & 0x3FFFF} for v in x]
    out = await stream(dut, ins, ["i", "q"], 4 * len(x) - 64, p_valid=p_valid, p_ready=p_ready)
    return np.array([_s18(o["i"]) + 1j * _s18(o["q"]) for o in out])


def align(got: np.ndarray, want: np.ndarray, max_lag: int = 200) -> tuple[int, float]:
    """Lag of the RTL behind the reference, and the worst error at that lag."""
    best = None
    for lag in range(max_lag):
        w = want[: len(got) - lag]
        err = np.max(np.abs(got[lag:] - w))
        if best is None or err < best[1]:
            best = (lag, err)
    return best


@cocotb.test()
async def interp(dut):
    """Random samples, random trims, random stalls: every output within 2 LSB
    of the floating-point definition, and the even phase exact."""
    rng = np.random.default_rng(seed())
    n = 600
    x = rng.integers(-40000, 40000, n) + 1j * rng.integers(-40000, 40000, n)
    gi, gq = int(rng.integers(12000, 20000)), int(rng.integers(12000, 20000))
    ph = int(rng.integers(-2000, 2000))
    got = await run(dut, x, gi, gq, ph, 0.9, 0.7)
    want = reference(x, gi, gq, ph)
    lag, err = align(got, want)
    cocotb.log.info("interp: lag %d, worst error %.2f LSB (gains %d %d, phase %d)", lag, err, gi, gq, ph)
    assert err <= 2.0, f"worst error {err:.2f} LSB"
    # Unity trim: every 4th output is the input itself, bit for bit.
    got1 = await run(dut, x, 16384, 16384, 0, 0.8, 0.9)
    lag1, err1 = align(got1, reference(x, 16384, 16384, 0))
    # upfirdn's own group delay: (len(H1)-1)/2 at 2x, i.e. len(H1)-1 at 4x, plus H2's
    d0 = lag1 + (len(H1) - 1) + (len(H2) - 1) // 2
    phase0 = got1[d0::4][: n - 20]
    assert np.array_equal(phase0, x[: len(phase0)]), "even phase does not pass samples through"


@cocotb.test()
async def interp_spectrum(dut):
    """DVB-T-shaped input (1705 random QPSK carriers): the output's images
    must sit >= 60 dB below the signal. (Passband accuracy is the sample-
    exact comparison above; Welch on random carriers is too noisy for it.)"""
    rng = np.random.default_rng(seed())
    sym = []
    for _ in range(6):
        bins = np.zeros(2048, complex)
        bins[[(k - 852) % 2048 for k in range(1705)]] = rng.choice([-1, 1], 1705) + 1j * rng.choice([-1, 1], 1705)
        sym.append(np.fft.ifft(bins) * 2048 * 5793 / 32)
    x = np.round(np.concatenate(sym))
    got = await run(dut, x, 16384, 16384, 0, 1.0, 1.0)
    fs = 4 * FS0
    f, p = signal.welch(got[400:], fs=fs, nperseg=4096, return_onesided=False, window="blackmanharris")
    inband = p[np.abs(f) < EDGE * 0.98]
    image = p[np.abs(f) > (FS0 - EDGE) * 1.0]
    rej = 10 * np.log10(np.mean(inband) / image.max())
    cocotb.log.info("spectrum: image rejection %.1f dB (worst bin vs in-band mean)", rej)
    assert rej >= 60, f"image rejection {rej:.1f} dB < 60"
