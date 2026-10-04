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
    (regulator can't keep up). Z_hf = 0 means the regulator is NOT MODELLED: the feed sees an ideal
    pressure source, which is what a dome regulator plus ullage is at the ~100 Hz chug band. The
    forcing bound ``max_excursion_pa`` is reported, NOT used in the characteristic equation.  [Phys §6.1]
    """
    corner_hz: float = 3.0
    Z_hf: float = 0.0          # Pa·s/kg, high-frequency series impedance (unset until the T6 step test)
    max_excursion_pa: float = 0.0   # forcing bound (reporting only)
    enabled: bool = True

    @property
    def modelled(self) -> bool:
        """True only when the regulator can change the loop: enabled AND a measured Z_hf."""
        return bool(self.enabled and self.Z_hf > 0.0)

    def impedance(self, s: complex) -> complex:
        """Series impedance Z_reg(s) [Pa·s/kg]. High-pass toward Z_hf above the corner."""
        if not self.modelled:
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
    R_gas: Optional[float] = None   # J/(kg K), chamber gas constant; with T_c gives theta from the state
    T_c: Optional[float] = None     # K, chamber temperature the rest of the model uses

    def theta_c(self) -> float:
        """Gas residence time m_gas/mdot. From the chamber state, L* c*/(R T), when R and T are
        given; otherwise the ideal-c* identity L*/(Gamma^2 c*)."""
        if self.R_gas is not None and self.T_c is not None and self.R_gas > 0 and self.T_c > 0:
            th = core.chamber_residence_time_from_state(self.Lstar, self.cstar, self.R_gas, self.T_c)
        else:
            th = core.chamber_residence_time(self.Lstar, self.cstar, self.gamma)
        return self.theta_factor * th

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
        if with_regulator and st.regulator.modelled:
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


def _negative_axis_crossings(omega: np.ndarray, L: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """(omega_c, |L|_c) where L(iw) crosses the negative real axis: Im L changes sign with Re L < 0.

    Every such crossing is a phase of -pi - 2*pi*k. Testing the unwrapped phase against -pi alone
    (the old rule) misses k >= 1, where a slow second stream can put the loop's largest gain.
    """
    im, re = L.imag, L.real
    i0, i1 = im[:-1], im[1:]
    hits = np.flatnonzero((i0 == 0.0) | (i0 * i1 < 0.0))
    if hits.size == 0:
        return np.empty(0), np.empty(0)
    di = im[hits] - im[hits + 1]
    safe = di != 0.0
    frac = np.where(safe, im[hits] / np.where(safe, di, 1.0), 0.0)
    re_c = re[hits] + frac * (re[hits + 1] - re[hits])
    w_c = omega[hits] + frac * (omega[hits + 1] - omega[hits])
    neg = re_c < 0.0
    return w_c[neg], -re_c[neg]


def chug_margin_fast(streams: List[ChugStream], chamber: ChugChamber,
                     *, with_regulator: bool = True,
                     f_lo: float = 2.0, f_hi: float = 2000.0) -> Dict[str, float]:
    """Fast chug margin via the Nyquist gain margin of L(iw). No root-find.  [Phys §3.2 fast form]

    Char. eq 1+L=0 => instability when L(iw) encircles -1. L is open-loop stable (chamber and feed
    poles are real and negative; delays add none), so the loop is stable when L stays inside the
    unit circle wherever it crosses the negative real axis: GM = 1 / max |L| over ALL those
    crossings (phase -pi, -3pi, ...), and GM < 1 means encirclement.

    Returns dict: ``gain_margin`` (>1 stable), ``stable`` (bool), ``f_chug_hz`` (frequency of the
    worst crossing, the chug-frequency estimate), ``crossings_hz`` (every negative-axis crossing,
    for seeding the root-find), ``phase_margin_deg``, ``margin`` (= gain_margin).
    """
    omega = _freq_grid(f_lo, f_hi)
    L = _open_loop_grid(omega, streams, chamber, with_regulator=with_regulator)
    phase = np.unwrap(np.angle(L))
    mag = np.abs(L)

    gm_best = np.inf
    f_pc = float("nan")
    w_c, mag_c = _negative_axis_crossings(omega, L)
    if w_c.size:
        k = int(np.argmax(mag_c))       # worst-case (smallest) gain margin; first on a tie
        gm_best = float(1.0 / mag_c[k]) if mag_c[k] > 0 else np.inf
        f_pc = float(w_c[k] / (2.0 * np.pi))

    # Phase margin: the smallest angular distance to the negative real axis over every gain
    # crossover (|L| = 1). Wrapped, so a crossover near -3pi reads as near 0, not -360 deg.
    pm_deg = float("nan")
    h = mag - 1.0
    h0, h1 = h[:-1], h[1:]
    gain_hits = np.flatnonzero((h0 == 0.0) | (h0 * h1 < 0.0))
    if gain_hits.size:
        dh = h[gain_hits] - h[gain_hits + 1]
        frac = np.where(dh != 0.0, h[gain_hits] / np.where(dh != 0.0, dh, 1.0), 0.0)
        ph_c = phase[gain_hits] + frac * (phase[gain_hits + 1] - phase[gain_hits])
        dist = np.mod(ph_c + np.pi, 2.0 * np.pi)          # angle above the negative axis, [0, 2pi)
        dist = np.where(dist > np.pi, dist - 2.0 * np.pi, dist)
        pm_deg = float(np.degrees(dist[np.argmin(np.abs(dist))]))

    if not np.isfinite(gm_best):
        # No negative-axis crossing in band. Conservative: 1/max|L| (the old behaviour), which can
        # only understate the margin.
        gm_best = float(1.0 / max(mag.max(), 1e-12))
        gm_best = max(gm_best, 1.0) if mag.max() < 1.0 else gm_best

    stable = gm_best > 1.0
    return {
        "gain_margin": float(gm_best),
        "stable": bool(stable),
        "f_chug_hz": float(f_pc),
        "crossings_hz": [float(w / (2.0 * np.pi)) for w in w_c],
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
        # fsolve probes far into the left half-plane, where exp(-s*tau) overflows; that trial
        # point is simply rejected, so the warning is noise.
        with np.errstate(over="ignore", invalid="ignore"):
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


def _dominant_root(streams: List[ChugStream], chamber: ChugChamber, fast_res: Dict[str, float],
                   *, with_regulator: bool = True) -> Tuple[float, float, float]:
    """The most unstable root of F(s) = 0: seeded at every negative-real-axis crossing of L(iw)
    (``fast_res``, from ``chug_margin_fast``), the largest alpha kept. (alpha, omega, |F|)."""
    seeds = [2 * np.pi * f for f in fast_res.get("crossings_hz", []) if np.isfinite(f) and f > 0]
    if not seeds:
        f0 = fast_res.get("f_chug_hz", float("nan"))
        seeds = [2 * np.pi * f0 if np.isfinite(f0) else 2 * np.pi * 100.0]
    best = (float("nan"), float("nan"), float("inf"))
    for w0 in seeds:
        a, w, r = _solve_dominant_root(streams, chamber, with_regulator=with_regulator, omega_seed=w0)
        if np.isfinite(a) and (not np.isfinite(best[0]) or a > best[0]):
            best = (a, w, r)
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


def damping_ratio(sigma: float, omega: float) -> float:
    """Damping ratio of a complex pole ``s = sigma + j*omega``: ``zeta = -sigma / |s|``.

    This is the standard definition — the cosine of the pole's angle from the negative real axis —
    and it is what a constant-zeta ray on a root locus means. (An earlier version of this module
    reported ``-sigma/omega``, which is ``zeta/sqrt(1-zeta^2)``: indistinguishable below zeta ~ 0.1
    and 15 % off by zeta = 0.5, so a pole plotted against its own reported zeta did not sit on the
    ray. Fixed here so the diagram and the number agree.)
    """
    mag = float(np.hypot(sigma, omega))
    if not np.isfinite(mag) or mag <= 0:
        return float("nan")
    return float(-sigma / mag)


def _solve_root_near(streams: List[ChugStream], chamber: ChugChamber, s0: complex,
                     *, with_regulator: bool = True) -> Tuple[float, float, float]:
    """Single-seed Newton solve for the root of F(s)=0 nearest ``s0``. (alpha, omega, |F|).

    The continuation step of the root locus: each point seeds from its predecessor, so one fsolve
    per point is enough. ``_solve_dominant_root`` fans out over nine seeds because it has no
    predecessor to start from; doing that per locus point would cost ~40x for no extra accuracy.
    """
    from scipy.optimize import fsolve

    def residual(x):
        with np.errstate(over="ignore", invalid="ignore"):
            F = chug_characteristic(complex(x[0], x[1]), streams, chamber,
                                    with_regulator=with_regulator)
        return [F.real, F.imag]

    try:
        sol, _, ier, _ = fsolve(residual, [s0.real, s0.imag], full_output=True)
    except Exception:
        return float("nan"), float("nan"), float("inf")
    if ier != 1:
        return float("nan"), float("nan"), float("inf")
    resF = abs(complex(*residual(sol)))
    if resF > 1e-6 or sol[1] <= 0:
        return float("nan"), float("nan"), float("inf")
    return float(sol[0]), float(sol[1]), float(resF)


def mean_eta(streams: List[ChugStream]) -> float:
    """Mass-flow-weighted injector stiffness of the streams."""
    m = sum(max(float(s.mdot), 0.0) for s in streams)
    return float(sum(float(s.mdot) * float(s.eta_inj) for s in streams) / m) if m > 0 else float("nan")


def chug_root_locus(streams: List[ChugStream], chamber: ChugChamber,
                    *, eta_values: Optional[np.ndarray] = None,
                    with_regulator: bool = True, scale_design: bool = False) -> List[Dict[str, float]]:
    """Track the dominant chug pole through the s-plane as injector stiffness sweeps.

    This is a root locus in the textbook sense: ``eta_inj = dP_inj/Pc`` is the swept gain, and each
    returned point is the eigenvalue ``s = sigma + j*omega`` of the closed-loop characteristic
    equation ``1 + L(s) = 0`` at that gain. The imaginary axis is the stability boundary — the
    branch crosses it where the loop goes neutrally stable, and the crossing frequency is the chug
    frequency the engine would ring at.

    Solved by continuation from the softest injector upward, each point seeded on its predecessor,
    which is the standard way to follow a branch rather than re-discover it. Honest caveat: on every
    case tried so far (lags 0.8-9 ms, feed runs 0.08-1.5 m, eta from 0.02 to 1.2) a single fixed seed
    found the same branch, so the continuation is insurance against branch-hopping rather than a
    demonstrated fix for it. ``test_locus_is_continuous_in_frequency`` checks the OUTPUT is a branch;
    it does not, and cannot currently, distinguish the two seeding strategies.

    ``scale_design``: each value is the streams' mass-weighted mean stiffness, reached by scaling
    every stream's OWN drop by one factor, so the design (unequal drops and all) sits exactly on
    the branch at its own mean. Off, every stream is set to the same eta.

    Returns points in ascending ``eta`` with keys ``eta``, ``real``, ``imag``, ``f_hz``, ``zeta``.
    Points where the branch could not be followed are dropped, so the caller gets a clean polyline.
    """
    import copy
    eta0 = mean_eta(streams) if scale_design else float("nan")

    if eta_values is None:
        eta_values = np.linspace(0.05, 0.60, 28)
    etas = np.asarray(sorted(float(e) for e in eta_values if np.isfinite(e) and e > 0))
    if etas.size == 0:
        return []

    def scaled(eta: float) -> List[ChugStream]:
        out = []
        for st in streams:
            st2 = copy.copy(st)
            st2.eta_inj = float(st.eta_inj) * eta / eta0 if scale_design else float(eta)
            out.append(st2)
        return out

    # Seed the branch from the fast tier's phase crossover at the softest injector, where the loop
    # is most strongly coupled and the dominant root is least ambiguous.
    seed_streams = scaled(etas[0])
    fast = chug_margin_fast(seed_streams, chamber, with_regulator=with_regulator)
    w0 = 2 * np.pi * fast["f_chug_hz"] if np.isfinite(fast["f_chug_hz"]) else 2 * np.pi * 100.0
    s_prev = complex(0.0, w0)

    pts: List[Dict[str, float]] = []
    for eta in etas:
        st = scaled(eta)
        a, w, res = _solve_root_near(st, chamber, s_prev, with_regulator=with_regulator)
        # The branch that matters is the DOMINANT root (the one chug_growth_rate reports for the
        # design). Following one seed from the softest injector can stay on a subdominant root:
        # on a design with LOX at eta 0.25 and fuel at 0.10 it passed the design at -79 s^-1,
        # 50 Hz while the design's own pole was -40 s^-1, 23 Hz. So each point also runs the
        # dominant-root search and keeps whichever root grows faster.
        ad, wd, rd = _dominant_root(st, chamber, chug_margin_fast(st, chamber, with_regulator=with_regulator),
                                    with_regulator=with_regulator)
        if np.isfinite(ad) and np.isfinite(wd) and wd > 0 and (not np.isfinite(a) or ad > a + 1e-9):
            a, w, res = ad, wd, rd
        if not (np.isfinite(a) and np.isfinite(w) and w > 0):
            # Lost the branch: re-acquire from the frequency scan rather than abandoning the sweep.
            f2 = chug_margin_fast(st, chamber, with_regulator=with_regulator)
            if not np.isfinite(f2["f_chug_hz"]):
                continue
            a, w, res = _solve_root_near(st, chamber, complex(0.0, 2 * np.pi * f2["f_chug_hz"]),
                                         with_regulator=with_regulator)
            if not (np.isfinite(a) and np.isfinite(w) and w > 0):
                continue
        s_prev = complex(a, w)
        pts.append({
            "eta": float(eta), "real": float(a), "imag": float(w),
            "f_hz": float(w / (2 * np.pi)), "zeta": damping_ratio(a, w),
        })
    return pts


def chug_growth_rate(streams: List[ChugStream], chamber: ChugChamber,
                     *, with_regulator: bool = True) -> Dict[str, float]:
    """Rich chug analysis: dominant growth rate alpha and frequency from root-find of (3.3).

    The root-find is seeded at EVERY negative-real-axis crossing of L(iw) and keeps the root with
    the largest alpha; seeding only at the -pi crossing found a stable root while a -3pi one grew.

    Returns dict: ``alpha`` [1/s], ``f_chug_hz``, ``zeta`` (= -alpha/|s|), ``margin`` (= 1+zeta),
    ``stable``, ``regulator_status``, ``alpha_no_reg`` (only when a regulator is modelled; None
    otherwise), ``driver``, ``residual``.
    """
    fast = chug_margin_fast(streams, chamber, with_regulator=with_regulator)

    def dominant(with_reg: bool, fast_res: Dict[str, float]) -> Tuple[float, float, float]:
        return _dominant_root(streams, chamber, fast_res, with_regulator=with_reg)

    alpha, omega, resF = dominant(with_regulator, fast)
    out: Dict[str, float] = {
        "alpha": alpha,
        "f_chug_hz": float(omega / (2 * np.pi)) if np.isfinite(omega) else float("nan"),
        "residual": resF,
    }
    if np.isfinite(alpha) and np.isfinite(omega) and omega > 0:
        zeta = damping_ratio(alpha, omega)
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

    # Regulator: a with/without comparison only means something when Z_reg is modelled. With
    # Z_hf unset both solves are the same equation, and printing two equal alphas implied a check
    # that never happened.
    if with_regulator and any(st.regulator.modelled for st in streams):
        out["regulator_status"] = "modelled"
        a_nr, _, _ = dominant(False, chug_margin_fast(streams, chamber, with_regulator=False))
        out["alpha_no_reg"] = a_nr
    else:
        out["regulator_status"] = "not_modelled"
        out["alpha_no_reg"] = None
    return out
