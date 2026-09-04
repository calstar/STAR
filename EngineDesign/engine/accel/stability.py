"""Numba kernel for the chug gain/phase-margin scan.

This is the dominant per-evaluation stability cost: a 200-point complex frequency
sweep run on every candidate. Vectorising the pure-Python version in numpy took it
from 1537 us to 112 us (and that speed-up stands on its own -- it is what every
pintle and coaxial config runs today, since no accelerated injector path covers
them). But an end-to-end Layer-1 measurement still put the remaining gap at ~8.8%
of wall time versus the C kernel, above the 3% we were willing to absorb, so the
scan itself is compiled here.

Mirrors engine/pipeline/stability/chug.py exactly, including numpy's unwrap
semantics, which numba does not provide.
"""
from __future__ import annotations

import numpy as np
from numba import njit

_TWO_PI = 2.0 * np.pi


@njit(cache=True)
def _unwrap(p):
    """np.unwrap(p) for a 1-D float64 array (numba has no np.unwrap).

    Faithful to numpy: correct by the modulo-wrapped difference, zero the
    correction where the raw step is below the discontinuity threshold, and
    resolve the -pi boundary toward +pi when the raw step is positive.
    """
    n = p.shape[0]
    out = np.empty(n)
    if n == 0:
        return out
    out[0] = p[0]
    run = 0.0
    for i in range(1, n):
        dd = p[i] - p[i - 1]
        ddmod = (dd + np.pi) % _TWO_PI - np.pi
        if ddmod == -np.pi and dd > 0.0:
            ddmod = np.pi
        corr = ddmod - dd
        if abs(dd) < np.pi:          # below discont -> no correction
            corr = 0.0
        run += corr
        out[i] = p[i] + run
    return out


@njit(cache=True)
def chug_margin_kernel(omega, tau, inert, res, invG, Zhf, wc, K_c, theta_c):
    """Returns (gain_margin, f_chug_hz, phase_margin_deg, stable).

    Per-stream inputs are the s-independent primitives already resolved by the
    Python wrapper: transport lag, feed inertance, linearised resistance, 1/G_inj
    (inf when G<=0), and the regulator high-frequency impedance and corner.
    """
    n = omega.shape[0]
    ns = tau.shape[0]
    mag = np.empty(n)
    ang = np.empty(n)

    for i in range(n):
        s = complex(0.0, omega[i])
        acc = complex(0.0, 0.0)
        for k in range(ns):
            Zr = complex(0.0, 0.0)
            if Zhf[k] > 0.0:
                Zr = Zhf[k] * (s / wc[k]) / (1.0 + s / wc[k])
            Zf = Zr + inert[k] * s + res[k] + invG[k]
            if Zf == 0.0:
                continue          # scalar path skips a zero-impedance stream
            acc += np.exp(-s * tau[k]) / Zf
        L = K_c / (theta_c * s + 1.0) * acc
        mag[i] = abs(L)
        ang[i] = np.arctan2(L.imag, L.real)

    phase = _unwrap(ang)

    # --- phase crossover (angle through -pi): worst-case gain margin ---
    target = -np.pi
    gm_best = np.inf
    f_pc = np.nan
    for i in range(n - 1):
        g0 = phase[i] - target
        g1 = phase[i + 1] - target
        if g0 == 0.0 or g0 * g1 < 0.0:
            dg = g0 - g1
            frac = g0 / dg if dg != 0.0 else 0.0
            w_c = omega[i] + frac * (omega[i + 1] - omega[i])
            mag_c = mag[i] + frac * (mag[i + 1] - mag[i])
            gm = 1.0 / mag_c if mag_c > 0 else np.inf
            if gm < gm_best:
                gm_best = gm
                f_pc = w_c / _TWO_PI

    # --- gain crossover (|L| = 1): phase margin at the FIRST crossing ---
    pm_deg = np.nan
    for i in range(n - 1):
        h0 = mag[i] - 1.0
        h1 = mag[i + 1] - 1.0
        if h0 == 0.0 or h0 * h1 < 0.0:
            dh = h0 - h1
            frac = h0 / dh if dh != 0.0 else 0.0
            ph_c = phase[i] + frac * (phase[i + 1] - phase[i])
            pm_deg = np.degrees(ph_c - target)
            break

    if not np.isfinite(gm_best):
        # No phase crossover in band: stable if |L|<1 throughout (no encirclement).
        mmax = mag.max()
        gm_best = 1.0 / mmax if mmax > 1e-12 else 1.0 / 1e-12
        if mmax < 1.0 and gm_best < 1.0:
            gm_best = 1.0

    return gm_best, f_pc, pm_deg, gm_best > 1.0


def chug_margin_fast(streams, chamber, *, with_regulator: bool = True,
                     f_lo: float = 2.0, f_hi: float = 2000.0):
    """Drop-in for chug.chug_margin_fast / native_injector.chug_margin_fast.

    Resolves the s-independent per-stream primitives once here, in Python, then
    hands the kernel nothing but arrays and floats.
    """
    from engine.pipeline.stability.chug import _freq_grid

    omega = np.ascontiguousarray(_freq_grid(f_lo, f_hi), dtype=np.float64)
    ns = len(streams)
    tau = np.empty(ns); inert = np.empty(ns); res = np.empty(ns)
    invG = np.empty(ns); Zhf = np.zeros(ns); wc = np.ones(ns)
    for k, st in enumerate(streams):
        G = st.G_inj()
        tau[k] = st.tau_conv
        inert[k] = st.inertance()
        res[k] = st.resistance()
        invG[k] = (1.0 / G) if G > 0 else np.inf
        if with_regulator and st.regulator.enabled and st.regulator.Z_hf > 0.0:
            Zhf[k] = float(st.regulator.Z_hf)
            wc[k] = 2.0 * np.pi * max(st.regulator.corner_hz, 1e-6)

    gm, f_pc, pm, stable = chug_margin_kernel(
        omega, tau, inert, res, invG, Zhf, wc,
        float(chamber.K_c()), float(chamber.theta_c()))
    return {
        "gain_margin": float(gm),
        "stable": bool(stable),
        "f_chug_hz": float(f_pc),
        "phase_margin_deg": float(pm),
        "margin": float(gm),
    }
