"""Low-frequency (chug) stability: lumped feed <-> chamber <-> combustion model.

Implements the impedance-form characteristic equation [Phys §3.2, eq 3.3]:

    F(s) = 1 + Y_ch(s) * sum_k  exp(-s*tau_conv_k) / Z_feed_k(s)  = 0

    Y_ch(s)   = K_c / (theta_c*s + 1)          chamber transfer function   (K_c = c*/A_t)
    Z_feed_k  = Z_reg_k(s) + I_k*s + R_k + 1/G_inj_k   series feed+injector+regulator impedance

All quantities use the **mass-flow** through-variable convention (impedances in Pa·s/kg). Pure numeric
module — params come in as dataclasses; config extraction lives in the integration layer (analysis.py).

Two tiers (plan A2):
  * ``chug_margin_fast``  — gain/phase-margin proxy from a 1-D frequency scan (no transcendental
    root-find). For the Layer-1 inner loop. Calibrated to the **sign** of alpha.
  * ``chug_growth_rate``  — complex root-find of (3.3) for the dominant (alpha, omega). For the report.

The regulator enters in **two separate roles** [Phys §3.2 / §6.1]:
  * impedance ``Z_reg(s)`` inside ``Z_feed`` — shifts the poles / alpha (homogeneous stability);
  * forcing bound ``max_excursion_pa`` — disturbance amplitude (reported separately, NOT a pole-shifter).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache
from typing import Dict, List, Optional, Tuple
import numpy as np

from engine.pipeline.stability import core


# ---------------------------------------------------------------------------
# Parameter containers
# ---------------------------------------------------------------------------

@dataclass
class Regulator:
    """Dome-regulator model. Z_reg(s) is a high-pass: ~0 below the corner (regulated), -> Z_hf above
    (regulator can't keep up). Z_hf defaults to 0 = perfect source (optimistic baseline). The forcing
    bound ``max_excursion_pa`` is reported, NOT used in the characteristic equation.  [Phys §6.1]
    """
    corner_hz: float = 3.0
    Z_hf: float = 0.0          # Pa·s/kg, high-frequency series impedance (ASSUMED; measure T6)
    max_excursion_pa: float = 0.0   # forcing bound (reporting only; the "±14 psi" assumption)
    enabled: bool = True

    def impedance(self, s: complex) -> complex:
        """Series impedance Z_reg(s) [Pa·s/kg]. High-pass toward Z_hf above the corner."""
        if not self.enabled or self.Z_hf <= 0.0:
            return 0.0 + 0.0j
        wc = 2.0 * np.pi * max(self.corner_hz, 1e-6)
        return complex(self.Z_hf) * (s / wc) / (1.0 + s / wc)


@dataclass
class ChugStream:
    """One propellant stream (O or F) feeding the shared chamber."""
    name: str
    mdot: float          # kg/s
    eta_inj: float       # dP_inj/Pc (injector stiffness ratio)
    Pc: float            # Pa
    dP_feed: float       # Pa, steady feed-line drop (for linearized resistance)
    feed_length: float   # m
    feed_area: float     # m^2 (feed line cross-section)
    tau_conv: float      # s, conversion/transport lag (= tau_vap; from core.lags_from_smd)
    regulator: Regulator = field(default_factory=Regulator)

    # --- derived primitives ---
    def G_inj(self) -> float:
        return core.injector_conductance(self.mdot, self.eta_inj, self.Pc)

    def inertance(self) -> float:
        return core.feed_inertance(self.feed_length, self.feed_area)

    def resistance(self) -> float:
        """Linearized feed resistance R = dDP_feed/dmdot ~ 2*DP_feed/mdot (quadratic loss) [Pa·s/kg]."""
        if self.mdot <= 0:
            return float("nan")
        return float(2.0 * max(self.dP_feed, 0.0) / self.mdot)

    def Z_feed(self, s: complex, *, with_regulator: bool = True) -> complex:
        """Series feed+injector(+regulator) impedance Z_feed_k(s) [Pa·s/kg]."""
        G = self.G_inj()
        Zr = self.regulator.impedance(s) if with_regulator else 0.0 + 0.0j
        return Zr + self.inertance() * s + self.resistance() + (1.0 / G if G > 0 else np.inf)


@dataclass
class ChugChamber:
    cstar: float
    A_t: float
    Lstar: float
    gamma: float
    theta_factor: float = 1.0   # O(1) calibration on theta_c (mass vs mass+energy) [Phys §3.1]

    def theta_c(self) -> float:
        return self.theta_factor * core.chamber_residence_time(self.Lstar, self.cstar, self.gamma)

    def K_c(self) -> float:
        return core.chamber_gain(self.cstar, self.A_t)

    def Y_ch(self, s: complex) -> complex:
        th = self.theta_c()
        return self.K_c() / (th * s + 1.0)


# ---------------------------------------------------------------------------
# Characteristic equation and open loop
# ---------------------------------------------------------------------------

def chug_open_loop(s: complex, streams: List[ChugStream], chamber: ChugChamber,
                   *, with_regulator: bool = True) -> complex:
    """Open-loop transfer L(s) = Y_ch(s) * sum_k exp(-s*tau_k)/Z_feed_k(s). Char. eq is 1 + L(s) = 0."""
    acc = 0.0 + 0.0j
    for st in streams:
        Zf = st.Z_feed(s, with_regulator=with_regulator)
        if Zf == 0:
            continue
        acc += np.exp(-s * st.tau_conv) / Zf
    return chamber.Y_ch(s) * acc


def _open_loop_grid(omega: np.ndarray, streams: List[ChugStream], chamber: ChugChamber,
                    *, with_regulator: bool = True) -> np.ndarray:
    """Vectorised L(iw) over a whole frequency grid.

    Same computation as calling chug_open_loop once per point: every operation in
    Z_feed and Y_ch is element-wise in s, and the per-stream primitives (G_inj,
    inertance, resistance, regulator corner) do not depend on s at all. The
    per-point version recomputed all of them at each of the 200 grid points, which
    made this the dominant per-eval stability cost.

    Term order is kept identical to Z_feed/chug_open_loop deliberately, since
    floating-point addition is not associative. Agreement is ~1 ULP rather than
    bit-for-bit: numpy's complex exp takes a different code path on arrays than on
    scalars, which is far below any tolerance here but is not exactly zero.
    """
    s_arr = 1j * np.asarray(omega, dtype=np.float64)
    acc = np.zeros_like(s_arr)
    for st in streams:
        G = st.G_inj()
        Zr = 0.0 + 0.0j
        if with_regulator and st.regulator.enabled and st.regulator.Z_hf > 0.0:
            wc = 2.0 * np.pi * max(st.regulator.corner_hz, 1e-6)
            Zr = complex(st.regulator.Z_hf) * (s_arr / wc) / (1.0 + s_arr / wc)
        Zf = Zr + st.inertance() * s_arr + st.resistance() + (1.0 / G if G > 0 else np.inf)
        with np.errstate(divide="ignore", invalid="ignore"):
            term = np.exp(-s_arr * st.tau_conv) / Zf
        # The scalar path skips a stream whose Z_feed is exactly 0 (`continue`);
        # element-wise that is a zero contribution at those frequencies.
        acc = acc + np.where(Zf == 0, 0.0 + 0.0j, term)
    return chamber.K_c() / (chamber.theta_c() * s_arr + 1.0) * acc


def chug_characteristic(s: complex, streams: List[ChugStream], chamber: ChugChamber,
                        *, with_regulator: bool = True) -> complex:
    """F(s) = 1 + L(s).  Roots s = alpha + i*omega give chug frequency/growth rate."""
    return 1.0 + chug_open_loop(s, streams, chamber, with_regulator=with_regulator)


# ---------------------------------------------------------------------------
# Fast tier: gain/phase-margin proxy (no transcendental root-find)
# ---------------------------------------------------------------------------

@lru_cache(maxsize=8)
def _freq_grid_cached(f_lo: float, f_hi: float, n: int) -> np.ndarray:
    grid = 2.0 * np.pi * np.logspace(np.log10(f_lo), np.log10(f_hi), n)
    grid.flags.writeable = False   # cached and shared: never mutate in place
    return grid


def _freq_grid(f_lo: float = 2.0, f_hi: float = 2000.0, n: int = 200) -> np.ndarray:
    # 200 log-spaced points spans the chug band finely enough for crossover detection while keeping
    # the per-eval cost inside the fast-tier budget. The rich tier refines via root-find anyway.
    # The grid depends only on its arguments, so it is memoised: rebuilding it per
    # call cost ~7 us of the ~135 us fast-tier budget, on every candidate.
    return _freq_grid_cached(f_lo, f_hi, n)


def chug_margin_fast(streams: List[ChugStream], chamber: ChugChamber,
                     *, with_regulator: bool = True,
                     f_lo: float = 2.0, f_hi: float = 2000.0) -> Dict[str, float]:
    """Fast chug margin via the Nyquist gain margin of L(iw). No root-find.  [Phys §3.2 fast form]

    Char. eq 1+L=0 => instability when L(iw) passes through -1. At the **phase crossover** (where L is
    real-negative, angle = -180 deg), the gain margin GM = 1/|L| < 1 means encirclement => unstable.

    Returns dict: ``gain_margin`` (>1 stable), ``stable`` (bool), ``f_chug_hz`` (phase-crossover freq,
    the chug-frequency estimate), ``phase_margin_deg``, ``margin`` (= gain_margin, gate-facing).
    """
    omega = _freq_grid(f_lo, f_hi)
    L = _open_loop_grid(omega, streams, chamber, with_regulator=with_regulator)
    phase = np.unwrap(np.angle(L))
    mag = np.abs(L)

    # Phase crossover: angle crosses -180 deg (-pi). Find sign changes of (phase + pi).
    target = -np.pi
    g = phase - target
    gm_best = np.inf
    f_pc = float("nan")
    # Vectorised sign-change scan. argmin returns the FIRST minimum, matching the
    # scalar loop's strict `gm < gm_best` (which also kept the earliest tie).
    g0, g1 = g[:-1], g[1:]
    hits = np.flatnonzero((g0 == 0.0) | (g0 * g1 < 0.0))
    if hits.size:
        dg = g[hits] - g[hits + 1]
        safe = dg != 0.0
        frac = np.where(safe, g[hits] / np.where(safe, dg, 1.0), 0.0)
        w_c = omega[hits] + frac * (omega[hits + 1] - omega[hits])
        mag_c = mag[hits] + frac * (mag[hits + 1] - mag[hits])
        pos = mag_c > 0
        gm = np.where(pos, 1.0 / np.where(pos, mag_c, 1.0), np.inf)
        k = int(np.argmin(gm))          # worst-case (smallest) gain margin
        gm_best = float(gm[k])
        f_pc = float(w_c[k] / (2.0 * np.pi))

    # Phase margin at gain crossover (|L|=1), if any
    pm_deg = float("nan")
    h = mag - 1.0
    h0, h1 = h[:-1], h[1:]
    gain_hits = np.flatnonzero((h0 == 0.0) | (h0 * h1 < 0.0))
    if gain_hits.size:
        i = int(gain_hits[0])           # scalar loop broke at the FIRST crossing
        dh = h[i] - h[i + 1]
        frac = h[i] / dh if dh != 0 else 0.0
        ph_c = phase[i] + frac * (phase[i + 1] - phase[i])
        pm_deg = float(np.degrees(ph_c - target))  # phase above -180

    if not np.isfinite(gm_best):
        # No phase crossover in band: stable if |L|<1 throughout (no encirclement possible)
        gm_best = float(1.0 / max(mag.max(), 1e-12))
        gm_best = max(gm_best, 1.0) if mag.max() < 1.0 else gm_best

    stable = gm_best > 1.0
    return {
        "gain_margin": float(gm_best),
        "stable": bool(stable),
        "f_chug_hz": float(f_pc),
        "phase_margin_deg": pm_deg,
        "margin": float(gm_best),
    }


# ---------------------------------------------------------------------------
# Rich tier: complex root-find for the dominant (alpha, omega)
# ---------------------------------------------------------------------------

def _solve_dominant_root(streams: List[ChugStream], chamber: ChugChamber,
                         *, with_regulator: bool, omega_seed: float) -> Tuple[float, float, float]:
    """Newton/fsolve for the dominant complex root of F(s)=0 near omega_seed. Returns (alpha, omega, |F|)."""
    from scipy.optimize import fsolve

    def residual(x):
        s = complex(x[0], x[1])
        F = chug_characteristic(s, streams, chamber, with_regulator=with_regulator)
        return [F.real, F.imag]

    w0 = omega_seed if (np.isfinite(omega_seed) and omega_seed > 0) else 2 * np.pi * 100.0
    best = None
    for a0 in (-0.05 * w0, 0.0, 0.05 * w0):     # try a few growth-rate seeds
        for wfac in (1.0, 0.6, 1.6):
            try:
                sol, info, ier, _ = fsolve(residual, [a0, w0 * wfac], full_output=True)
                if ier == 1:
                    resF = abs(complex(*residual(sol)))
                    if sol[1] > 0 and (best is None or sol[0] > best[0]):  # most unstable, omega>0
                        if resF < 1e-6:
                            best = (float(sol[0]), float(sol[1]), float(resF))
            except Exception:
                continue
    if best is None:
        return float("nan"), float("nan"), float("inf")
    return best


def _dominant_driver(streams: List[ChugStream], s: complex) -> str:
    """Heuristic: which feed term dominates |Z_feed| at the root -> the limiting physics."""
    drivers = {"feed_inertance": 0.0, "feed_resistance": 0.0, "injector_stiffness": 0.0, "regulator": 0.0}
    for st in streams:
        G = st.G_inj()
        drivers["feed_inertance"] += abs(st.inertance() * s)
        drivers["feed_resistance"] += abs(st.resistance())
        drivers["injector_stiffness"] += abs(1.0 / G) if G > 0 else 0.0
        drivers["regulator"] += abs(st.regulator.impedance(s))
    return max(drivers, key=drivers.get)


def chug_growth_rate(streams: List[ChugStream], chamber: ChugChamber,
                     *, with_regulator: bool = True) -> Dict[str, float]:
    """Rich chug analysis: dominant growth rate alpha and frequency from root-find of (3.3).

    Returns dict: ``alpha`` [1/s], ``f_chug_hz``, ``zeta`` (= -alpha/omega), ``margin`` (= 1+zeta),
    ``stable``, ``alpha_no_reg`` (Z_reg=0 comparison), ``driver``, ``residual``.
    """
    fast = chug_margin_fast(streams, chamber, with_regulator=with_regulator)
    omega_seed = 2 * np.pi * fast["f_chug_hz"] if np.isfinite(fast["f_chug_hz"]) else 2 * np.pi * 100.0

    alpha, omega, resF = _solve_dominant_root(streams, chamber, with_regulator=with_regulator,
                                              omega_seed=omega_seed)
    out: Dict[str, float] = {
        "alpha": alpha,
        "f_chug_hz": float(omega / (2 * np.pi)) if np.isfinite(omega) else float("nan"),
        "residual": resF,
    }
    if np.isfinite(alpha) and np.isfinite(omega) and omega > 0:
        zeta = -alpha / omega
        out["zeta"] = float(zeta)
        out["margin"] = float(1.0 + zeta)
        out["stable"] = bool(alpha < 0.0)
        out["driver"] = _dominant_driver(streams, complex(alpha, omega))
    else:
        # root-find failed; fall back to the fast-tier verdict (sign only)
        out["zeta"] = float("nan")
        out["margin"] = float(fast["gain_margin"])
        out["stable"] = bool(fast["stable"])
        out["driver"] = "unknown"

    # Regulator contribution: solve again with Z_reg = 0 for the with/without comparison
    if with_regulator:
        a_nr, _, _ = _solve_dominant_root(streams, chamber, with_regulator=False, omega_seed=omega_seed)
        out["alpha_no_reg"] = a_nr
    else:
        out["alpha_no_reg"] = alpha
    return out
