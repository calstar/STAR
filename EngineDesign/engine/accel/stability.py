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
    """Returns (gain_margin, f_chug_hz, phase_margin_deg, stable, crossings_omega).

    Per-stream inputs are the s-independent primitives already resolved by the
    Python wrapper: transport lag, feed inertance, linearised resistance, 1/G_inj
    (inf when G<=0), and the regulator high-frequency impedance and corner.

    Mirrors chug.chug_margin_fast: the gain margin is 1/max|L| over EVERY crossing of
    the negative real axis (Im L changes sign with interpolated Re L < 0 -- phases
    -pi, -3pi, ...), not only the unwrapped -pi one; the chug frequency is the worst
    crossing's; the phase margin is the wrapped distance to the negative axis at the
    gain crossover nearest to it.
    """
    n = omega.shape[0]
    ns = tau.shape[0]
    mag = np.empty(n)
    ang = np.empty(n)
    Lre = np.empty(n)
    Lim = np.empty(n)

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
        Lre[i] = L.real
        Lim[i] = L.imag
        mag[i] = abs(L)
        ang[i] = np.arctan2(L.imag, L.real)

    phase = _unwrap(ang)

    # --- negative-real-axis crossings (chug._negative_axis_crossings) ---
    w_all = np.empty(max(n - 1, 0))
    nc = 0
    gm_best = np.inf
    f_pc = np.nan
    mag_worst = -1.0
    for i in range(n - 1):
        i0 = Lim[i]
        i1 = Lim[i + 1]
        if i0 == 0.0 or i0 * i1 < 0.0:
            di = i0 - i1
            frac = i0 / di if di != 0.0 else 0.0
            re_c = Lre[i] + frac * (Lre[i + 1] - Lre[i])
            if re_c < 0.0:
                w_c = omega[i] + frac * (omega[i + 1] - omega[i])
                w_all[nc] = w_c
                nc += 1
                mag_c = -re_c
                if mag_c > mag_worst:          # argmax: first on a tie
                    mag_worst = mag_c
                    gm_best = 1.0 / mag_c if mag_c > 0 else np.inf
                    f_pc = w_c / _TWO_PI

    # --- gain crossovers (|L| = 1): wrapped distance to the negative axis, smallest wins ---
    pm_deg = np.nan
    best_abs = np.inf
    for i in range(n - 1):
        h0 = mag[i] - 1.0
        h1 = mag[i + 1] - 1.0
        if h0 == 0.0 or h0 * h1 < 0.0:
            dh = h0 - h1
            frac = h0 / dh if dh != 0.0 else 0.0
            ph_c = phase[i] + frac * (phase[i + 1] - phase[i])
            dist = (ph_c + np.pi) % _TWO_PI
            if dist > np.pi:
                dist = dist - _TWO_PI
            if abs(dist) < best_abs:           # argmin: first on a tie
                best_abs = abs(dist)
                pm_deg = np.degrees(dist)

    if not np.isfinite(gm_best):
        # No negative-axis crossing in band: 1/max|L|, floored at 1 when |L| < 1 throughout.
        mmax = mag.max()
        gm_best = 1.0 / (mmax if mmax > 1e-12 else 1e-12)
        if mmax < 1.0 and gm_best < 1.0:
            gm_best = 1.0

    return gm_best, f_pc, pm_deg, gm_best > 1.0, w_all[:nc].copy()


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

    gm, f_pc, pm, stable, w_c = chug_margin_kernel(
        omega, tau, inert, res, invG, Zhf, wc,
        float(chamber.K_c()), float(chamber.theta_c()))
    return {
        "gain_margin": float(gm),
        "stable": bool(stable),
        "f_chug_hz": float(f_pc),
        "crossings_hz": [float(w / (2.0 * np.pi)) for w in w_c],
        "phase_margin_deg": float(pm),
        "margin": float(gm),
    }
