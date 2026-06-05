"""Transient concentric-tank freezing model (ethanol / LOX / liquid methane).

Physics per ``EngineDesign/ethanol_lox_heat_flux_guide (1).md``, generalized
to selectable fluids in each section:

- **Role rule:** at the given tank pressure, the fluid with the lower
  saturation temperature is the boiling fixed-temperature SINK (pinned at its
  T_sat, R_2 ~ 0); the other fluid is the transient BULK that cools and may
  freeze. The section assignment only sets the geometry: bulk inside (ice
  grows inward from the common wall — the original problem) or bulk in the
  outer annulus (ice grows outward toward the outer tank wall r_t).
- Bulk-side natural convection: Churchill-Chu vertical-plate correlation,
  characteristic length = wetted height H (guide section 5.1).
- Quasi-steady log conduction through the frozen annulus (section 5.2).
- Stefan condition moves the front; bulk liquid cools sensibly (5.4 / 5.5).

Modes:
- FREEZE       — T_sink < T_fr(bulk): the Stefan march above.
- COOLING      — T_sink >= T_fr(bulk) (e.g. methane vs LOX above ~1.07 atm):
                 no front; the bulk just relaxes toward T_sink.
- NO_HEAT_FLOW — same fluid both sides: dT = 0, flat results.

State marched in time (FREEZE): y = [r_s, T_eth, m_liq, E_out, E_in], where
E_out/E_in are quadrature states (time integrals of Qout/Qin) used for the
energy-balance check — the adaptive stepper integrates the singular early
Qout spike far more accurately than post-hoc quadrature of recorded samples.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable, Optional

import numpy as np
from scipy.integrate import solve_ivp
from scipy.optimize import brentq

from .properties import (
    FLUIDS,
    SaturatedLiquidTable,
    chf_zuber,
    get_liquid_table,
    sat_temperature,
    solid_constants,
)

# ---------------------------------------------------------------------------
# Material constants (per-fluid solid constants live in properties.FLUIDS;
# DEFAULTS kept as the ethanol set for backward compatibility/tests).
# ---------------------------------------------------------------------------
DEFAULTS = dict(solid_constants("ethanol"), k_Al=167.0)

G = 9.81  # m/s^2

# Fixed sink-priority ordering: saturation curves of these fluids do not
# cross in their liquid ranges, so the colder-sink decision is
# pressure-independent (LOX < methane < ethanol).
SINK_RANK = {"lox": 0, "methane": 1, "ethanol": 2}

# Conservative h1 bias factors chosen by the user (guide section 8):
# h1 HIGH -> freeze time / bulk cool-down bound (predicts freezing sooner);
# h1 LOW  -> ice thickness bound (predicts more ice). NOTE: that thickness
# ordering is the quasi-static expectation; in deeply unbounded transients the
# faster bulk cool-down of the h1-high run can dominate and flip it — which is
# why both bounds are run and worst-case numbers should be taken across them.
H1_HIGH_DEFAULT = 1.25
H1_LOW_DEFAULT = 0.75

_FROZEN_MASS_NOTE = (
    "Full solidification was triggered by liquid exhaustion (m_liq -> 0) rather than the "
    "geometric front reaching the centerline: the model freezes liquid into denser solid "
    "(rho_s > rho_liq) without modeling shrinkage, so the mass runs out first. This is the "
    "earlier — i.e. freeze-time-conservative — criterion."
)
_FROZEN_MASS_NOTE_OUTWARD = (
    "Full solidification was triggered by liquid exhaustion (m_liq -> 0) rather than the "
    "geometric front filling the annulus: the model freezes liquid into denser solid "
    "(rho_s > rho_liq) without modeling shrinkage, so the mass runs out first. This is the "
    "earlier — i.e. freeze-time-conservative — criterion."
)


@dataclass
class TankFreezeInputs:
    # Geometry [m]
    r_i: float                  # inner section radius (inner fluid / wall interface)
    r_o: float                  # common-wall outer radius (wall / outer fluid)
    H: float                    # wetted height
    # Conditions
    P_tank_pa: float            # sink-side pressure -> T_sink = Tsat(P) of the sink fluid
    T_eth0: float               # initial bulk liquid temperature [K]
    m_liq0: float               # initial bulk liquid mass [kg]
    # Fuel(bulk)-side pressure [Pa]; None -> ambient (101325). Subcooled-liquid
    # properties are pressure-insensitive, but the freezing point shifts by
    # the Clausius-Clapeyron slope T_fr*(v_liq - v_sol)/L_fus (~0.02-0.04
    # K/bar). Negligible for ethanol/LOX (0.65 K at 500 psi on a 69 K driving
    # dT) but DECISIVE for the marginal methane/LOX case, where the whole
    # freezing margin is ~0.5 K.
    P_fuel_pa: Optional[float] = None
    # Run controls
    t_mission_s: float = 1200.0
    t_solidify_max_s: float = 10800.0
    delta_seed: float = 1e-5    # initial seeded ice thickness [m]
    r_min: float = 1e-4         # numerical floor on remaining front travel [m]
    h1_multiplier: float = 1.0  # conservatism bias on the convection coeff
    # Optional readout thresholds
    mu_pump_max: Optional[float] = None    # [Pa s]
    delta_ice_max: Optional[float] = None  # [m]
    # Output control
    plot_points: int = 400
    # Fluid selection
    fluid_inner: str = "ethanol"
    fluid_outer: str = "lox"
    r_t: Optional[float] = None  # outer tank radius [m]; required when the bulk is outside
    # Material overrides (None -> the bulk fluid's registry constants)
    k_s: Optional[float] = None
    rho_s: Optional[float] = None
    c_p_s: Optional[float] = None
    L_fus: Optional[float] = None
    T_fr: Optional[float] = None
    k_Al: float = 167.0
    lox_chf: Optional[float] = None  # sink CHF [W/m^2]; None -> Zuber at P_tank
    # Derived (filled in __post_init__)
    bulk_fluid: str = field(init=False)
    sink_fluid: str = field(init=False)
    bulk_inside: bool = field(init=False)
    same_fluid: bool = field(init=False)

    def __post_init__(self) -> None:
        for f in (self.fluid_inner, self.fluid_outer):
            if f not in FLUIDS:
                raise ValueError(f"Unknown fluid {f!r}; expected one of {sorted(FLUIDS)}")
        self.same_fluid = self.fluid_inner == self.fluid_outer
        if self.same_fluid:
            self.bulk_fluid = self.sink_fluid = self.fluid_inner
            self.bulk_inside = True
        elif SINK_RANK[self.fluid_inner] < SINK_RANK[self.fluid_outer]:
            self.sink_fluid, self.bulk_fluid = self.fluid_inner, self.fluid_outer
            self.bulk_inside = False
        else:
            self.sink_fluid, self.bulk_fluid = self.fluid_outer, self.fluid_inner
            self.bulk_inside = True
        # Fill material constants from the bulk fluid's registry entry
        sc = solid_constants(self.bulk_fluid)
        for name in ("k_s", "rho_s", "c_p_s", "L_fus", "T_fr"):
            if getattr(self, name) is None:
                setattr(self, name, sc[name])

    def validate(self) -> None:
        if not (0.0 < self.r_i < self.r_o):
            raise ValueError("Require 0 < r_i < r_o (sections share the common wall).")
        if self.H <= 0:
            raise ValueError("Wetted height H must be positive.")
        if self.m_liq0 <= 0:
            raise ValueError("Initial liquid mass must be positive.")
        if self.t_mission_s <= 0:
            raise ValueError("Mission time must be positive.")
        if self.same_fluid:
            return  # trivial run; geometry/temperature checks not meaningful
        if self.T_eth0 <= self.T_fr:
            raise ValueError(
                f"Initial {self.bulk_fluid} temperature ({self.T_eth0} K) must exceed the "
                f"freezing point ({self.T_fr} K)."
            )
        if self.bulk_inside:
            if not (0 < self.r_min < self.r_i - self.delta_seed):
                raise ValueError("Require 0 < r_min < r_i - delta_seed.")
        else:
            if self.r_t is None:
                raise ValueError(
                    "Outer tank radius r_t is required when the freezable fluid is in "
                    "the outer section (it bounds the annulus volume)."
                )
            if self.r_t <= self.r_o:
                raise ValueError("Outer tank radius r_t must exceed the common-wall radius r_o.")
            if not (0 < self.r_min < (self.r_t - self.r_o) - self.delta_seed):
                raise ValueError("Require 0 < r_min < (r_t - r_o) - delta_seed.")


@dataclass
class TankFreezeResult:
    bound_label: str
    h1_multiplier: float
    # Time series (decimated to ~plot_points)
    t_s: list = field(default_factory=list)
    ice_thickness_m: list = field(default_factory=list)
    Qin_W: list = field(default_factory=list)
    Qout_W: list = field(default_factory=list)
    T_eth_K: list = field(default_factory=list)
    mu_eth_Pa_s: list = field(default_factory=list)
    h1_W_m2K: list = field(default_factory=list)
    T_w_K: list = field(default_factory=list)
    q_lox_W_m2: list = field(default_factory=list)
    m_liq_kg: list = field(default_factory=list)
    # Headline scalars
    T_LOX_K: float = 0.0                    # sink temperature (wire name kept)
    delta_eq_m: Optional[float] = None      # quasi-steady equilibrium thickness at T_eth0
    classification: str = ""                # BOUNDED | UNBOUNDED | NO_FREEZING | NO_HEAT_FLOW
    ice_at_mission_m: Optional[float] = None
    T_eth_at_mission_K: Optional[float] = None
    mu_at_mission_Pa_s: Optional[float] = None
    t_to_95pct_eq_s: Optional[float] = None
    t_solidify_s: Optional[float] = None
    solidify_capped: bool = False           # True -> t_solidify > t_solidify_max
    t_mu_cross_s: Optional[float] = None
    t_ice_cross_s: Optional[float] = None
    energy_balance_error_pct: float = 0.0
    stefan_number: float = 0.0
    lox_chf_W_m2: float = 0.0
    flags: list = field(default_factory=list)
    # Configuration metadata
    bulk_fluid: str = "ethanol"
    sink_fluid: str = "lox"
    bulk_inside: bool = True
    mode: str = "freeze"                    # freeze | cooling | no_heat_flow


# ---------------------------------------------------------------------------
# Sub-models (guide section 5)
# ---------------------------------------------------------------------------

def convection(
    T_eth: float,
    r_s: float,
    inp: TankFreezeInputs,
    table: SaturatedLiquidTable,
    T_surface: Optional[float] = None,
) -> tuple[float, float, str, bool]:
    """Bulk natural-convection coefficient at the cold surface (5.1).

    T_surface defaults to the freeze front temperature T_fr; the cooling-only
    mode passes the sink temperature instead.

    Returns (h1, Ra_H, regime, cylinder_as_plate_ok).
    """
    T_s = inp.T_fr if T_surface is None else T_surface
    T_f = 0.5 * (T_eth + T_s)               # film temperature
    p = table.props(T_f)
    nu = p.mu / p.rho
    alpha = p.k / (p.rho * p.cp)
    Pr = nu / alpha
    dT = max(T_eth - T_s, 0.0)
    Ra = G * p.beta * dT * inp.H**3 / (nu * alpha)
    if Ra <= 0.0:
        return 0.0, 0.0, "laminar", True
    Gr = Ra / Pr
    # Vertical-cylinder-as-flat-plate criterion: D/H >= 35 / Gr^(1/4)
    cyl_ok = (2.0 * r_s / inp.H) >= 35.0 / Gr**0.25
    # Churchill-Chu, all-Ra form
    Nu = (0.825 + 0.387 * Ra ** (1.0 / 6.0) / (1.0 + (0.492 / Pr) ** (9.0 / 16.0)) ** (8.0 / 27.0)) ** 2
    h1 = inp.h1_multiplier * Nu * p.k / inp.H
    regime = "laminar" if Ra < 1e9 else "turbulent"
    return h1, Ra, regime, cyl_ok


def cold_path(
    r_s: float, inp: TankFreezeInputs, T_LOX: float
) -> tuple[float, float, float, float]:
    """Series conduction from the front (T_fr) out to the sink (5.2).

    Inward (bulk inside): ice occupies r_s..r_i. Outward (bulk in the outer
    annulus): ice occupies r_o..r_s. Returns (Qout, T_w, R_ice, R_w);
    R_2 (sink boiling) ~ 0.
    """
    if inp.bulk_inside:
        R_ice = math.log(inp.r_i / r_s) / (2.0 * math.pi * inp.k_s * inp.H)
    else:
        R_ice = math.log(r_s / inp.r_o) / (2.0 * math.pi * inp.k_s * inp.H)
    R_w = math.log(inp.r_o / inp.r_i) / (2.0 * math.pi * inp.k_Al * inp.H)
    Qout = (inp.T_fr - T_LOX) / (R_ice + R_w)
    T_w = T_LOX + Qout * R_w
    return Qout, T_w, R_ice, R_w


def _sink_wall_radius(inp: TankFreezeInputs) -> float:
    """Wall radius on the sink side (for the CHF flux check)."""
    return inp.r_o if inp.bulk_inside else inp.r_i


def _ice_thickness(r_s: float, inp: TankFreezeInputs) -> float:
    return inp.r_i - r_s if inp.bulk_inside else r_s - inp.r_o


def _clamped_state(y: np.ndarray, inp: TankFreezeInputs) -> tuple[float, float, float]:
    """Guarded (r_s, T_eth, m_liq) for derivative/diagnostic evaluation."""
    if inp.bulk_inside:
        r_s = min(max(float(y[0]), 0.5 * inp.r_min), inp.r_i - 1e-12)
    else:
        r_s = min(max(float(y[0]), inp.r_o + 1e-12), inp.r_t - 0.5 * inp.r_min)
    T_eth = max(float(y[1]), inp.T_fr)
    m_liq = max(float(y[2]), 1e-9)
    return r_s, T_eth, m_liq


def _step_quantities(y: np.ndarray, inp: TankFreezeInputs, table, T_LOX: float) -> dict:
    """All instantaneous quantities at a state (used by RHS and recording)."""
    r_s, T_eth, m_liq = _clamped_state(y, inp)
    h1, Ra, regime, cyl_ok = convection(T_eth, r_s, inp, table)
    Qout, T_w, R_ice, R_w = cold_path(r_s, inp, T_LOX)
    A_s = 2.0 * math.pi * r_s * inp.H
    Qin = h1 * A_s * (T_eth - inp.T_fr)             # 5.3
    if inp.bulk_inside:
        drs_dt = -(Qout - Qin) / (inp.rho_s * inp.L_fus * A_s)   # 5.4 Stefan
        # Front cannot melt past the wall
        if drs_dt > 0.0 and float(y[0]) >= inp.r_i - inp.delta_seed * 0.1:
            drs_dt = 0.0
        dmliq_dt = inp.rho_s * A_s * drs_dt         # 5.5 mass conversion
    else:
        drs_dt = (Qout - Qin) / (inp.rho_s * inp.L_fus * A_s)    # outward growth
        if drs_dt < 0.0 and float(y[0]) <= inp.r_o + inp.delta_seed * 0.1:
            drs_dt = 0.0
        dmliq_dt = -inp.rho_s * A_s * drs_dt
    dTeth_dt = -Qin / (m_liq * table.cp(T_eth))     # 5.5 bulk cooling
    return dict(
        r_s=r_s, T_eth=T_eth, m_liq=m_liq, h1=h1, Ra=Ra, regime=regime,
        cyl_ok=cyl_ok, Qin=Qin, Qout=Qout, T_w=T_w, R_ice=R_ice, R_w=R_w,
        drs_dt=drs_dt, dTeth_dt=dTeth_dt, dmliq_dt=dmliq_dt,
        q_lox=Qout / (2.0 * math.pi * _sink_wall_radius(inp) * inp.H),
    )


# ---------------------------------------------------------------------------
# Equilibrium ice thickness (guide 6a.1)
# ---------------------------------------------------------------------------

def equilibrium_front_radius(
    inp: TankFreezeInputs, table: SaturatedLiquidTable, T_LOX: float, T_eth: float
) -> Optional[float]:
    """Front radius where Qout = Qin at fixed bulk T (quasi-steady stall).

    k_s (T_fr - T_LOX) / |ln(r_front / r_wall)| = h1 * r_s * (T_eth - T_fr)

    Returns r_s_eq, or None when no equilibrium exists in the front's travel
    range — i.e. conduction out beats convection in everywhere and the ice
    grows until full solidification.
    """
    # Churchill-Chu h1 has characteristic length H, so it is independent of
    # r_s; evaluate once at the current bulk temperature.
    h1, _, _, _ = convection(T_eth, inp.r_i, inp, table)
    if h1 <= 0.0:
        return None
    if inp.bulk_inside:
        lhs_rhs = lambda r_s: (
            inp.k_s * (inp.T_fr - T_LOX) / math.log(inp.r_i / r_s)
            - h1 * r_s * (T_eth - inp.T_fr)
        )
        a, b = inp.r_min, inp.r_i - inp.delta_seed
        fa, fb = lhs_rhs(a), lhs_rhs(b)
        if fa > 0.0:
            return None  # Qout wins even with a nearly-full ice annulus
        if fb < 0.0:
            return inp.r_i  # convection wins immediately; no ice persists
        return float(brentq(lhs_rhs, a, b, xtol=1e-9))
    else:
        lhs_rhs = lambda r_s: (
            inp.k_s * (inp.T_fr - T_LOX) / math.log(r_s / inp.r_o)
            - h1 * r_s * (T_eth - inp.T_fr)
        )
        a, b = inp.r_o + inp.delta_seed, inp.r_t - inp.r_min
        fa, fb = lhs_rhs(a), lhs_rhs(b)
        if fb > 0.0:
            return None  # conduction wins all the way to the outer tank wall
        if fa < 0.0:
            return inp.r_o  # convection wins immediately; no ice persists
        return float(brentq(lhs_rhs, a, b, xtol=1e-9))


# ---------------------------------------------------------------------------
# Time marching (guide section 6) — adaptive RK45 in chunks for progress
# ---------------------------------------------------------------------------

ProgressCb = Callable[[float, float], None]  # (fraction_0_to_1, sim_time_s)


def _record_freeze(rec: dict, t: float, y: np.ndarray, inp, table, T_LOX: float) -> None:
    q = _step_quantities(y, inp, table, T_LOX)
    rec["t"].append(t)
    rec["r_s"].append(q["r_s"])
    rec["T_eth"].append(q["T_eth"])
    rec["m_liq"].append(q["m_liq"])
    rec["Qin"].append(q["Qin"])
    rec["Qout"].append(q["Qout"])
    rec["h1"].append(q["h1"])
    rec["T_w"].append(q["T_w"])
    rec["q_lox"].append(q["q_lox"])
    rec["mu"].append(table.mu(q["T_eth"]))
    rec["regime_turb"].append(q["regime"] == "turbulent")
    rec["cyl_ok"].append(q["cyl_ok"])
    rec["R_ice"].append(q["R_ice"])
    rec["R_w"].append(q["R_w"])


def _front_events(inp: TankFreezeInputs):
    """Terminal 'fully frozen' (geometric) event for the active direction."""
    if inp.bulk_inside:
        def ev_frozen(t, y):
            return y[0] - inp.r_min

        ev_frozen.direction = -1
    else:
        def ev_frozen(t, y):
            return (inp.r_t - inp.r_min) - y[0]

        ev_frozen.direction = -1
    ev_frozen.terminal = True
    return ev_frozen


def _march(
    inp: TankFreezeInputs,
    table: SaturatedLiquidTable,
    T_LOX: float,
    y0: np.ndarray,
    t0: float,
    t_end: float,
    rec: dict,
    progress_cb: Optional[Callable[[float], None]] = None,
    n_chunks: int = 50,
    samples_per_chunk: int = 8,
) -> tuple[np.ndarray, float, str]:
    """March y = [r_s, T_eth, m_liq, E_out, E_in] from t0 to t_end.

    Returns (y_final, t_final, stop_reason): 'horizon', 'frozen' (front hit
    its geometric bound), 'bulk_frozen' (T_eth hit T_fr), or 'frozen_mass'
    (liquid exhausted).
    """

    def rhs(t, y):
        q = _step_quantities(y, inp, table, T_LOX)
        return [q["drs_dt"], q["dTeth_dt"], q["dmliq_dt"], q["Qout"], q["Qin"]]

    ev_frozen = _front_events(inp)

    def ev_bulk(t, y):
        return y[1] - (inp.T_fr + 0.01)

    ev_bulk.terminal = True
    ev_bulk.direction = -1

    # The model converts liquid to solid at rho_s > rho_liq (a known guide
    # simplification), so the liquid runs out BEFORE the front reaches its
    # geometric bound. Treat liquid exhaustion as full solidification — it is
    # the earlier (and thus freeze-time-conservative) criterion, and it keeps
    # the latent-heat bookkeeping consistent for the energy-balance check.
    def ev_mass(t, y):
        return y[2] - 1e-3 * inp.m_liq0

    ev_mass.terminal = True
    ev_mass.direction = -1

    def record(t, y):
        _record_freeze(rec, t, y, inp, table, T_LOX)

    y = np.asarray(y0, dtype=float)
    if not rec["t"]:
        record(t0, y)

    edges = np.linspace(t0, t_end, n_chunks + 1)
    t_now = t0
    for a, b in zip(edges[:-1], edges[1:]):
        sol = solve_ivp(
            rhs,
            (a, b),
            y,
            method="RK45",
            t_eval=np.linspace(a, b, samples_per_chunk + 1)[1:],
            events=[ev_frozen, ev_bulk, ev_mass],
            rtol=1e-6,
            atol=[1e-9, 1e-5, 1e-7, 1.0, 1.0],
        )
        if not sol.success:
            raise RuntimeError(f"Integrator failed at t={a:.1f}s: {sol.message}")
        # NB: when an event fires before the first t_eval point of a chunk,
        # scipy returns sol.y as an empty list — hence the len() guard.
        if len(sol.t) > 0:
            for ti, yi in zip(sol.t, np.asarray(sol.y).T):
                record(float(ti), yi)
        if sol.status == 1:  # a terminal event fired
            for ev_idx, reason in ((0, "frozen"), (1, "bulk_frozen"), (2, "frozen_mass")):
                if len(sol.t_events[ev_idx]) > 0:
                    t_ev = float(sol.t_events[ev_idx][0])
                    y_ev = sol.y_events[ev_idx][0]
                    record(t_ev, y_ev)
                    return y_ev, t_ev, reason
        y = sol.y[:, -1]
        t_now = float(sol.t[-1])
        if progress_cb is not None:
            progress_cb((t_now - t0) / (t_end - t0))
    return y, t_now, "horizon"


def _march_pinned(
    inp: TankFreezeInputs,
    table: SaturatedLiquidTable,
    T_LOX: float,
    y0: np.ndarray,
    t0: float,
    t_end: float,
    rec: dict,
    progress_cb: Optional[Callable[[float], None]] = None,
) -> tuple[np.ndarray, float, str]:
    """Continue after the bulk reaches T_fr: T_eth pinned, Qin = 0, the
    remaining liquid freezes by pure conduction (fastest possible — the
    conservative direction for freeze time)."""

    def _clamp_r(r: float) -> float:
        if inp.bulk_inside:
            return min(max(r, 0.5 * inp.r_min), inp.r_i - 1e-12)
        return min(max(r, inp.r_o + 1e-12), inp.r_t - 0.5 * inp.r_min)

    def rhs(t, y):
        r_s = _clamp_r(float(y[0]))
        Qout, _, _, _ = cold_path(r_s, inp, T_LOX)
        A_s = 2.0 * math.pi * r_s * inp.H
        if inp.bulk_inside:
            drs = -Qout / (inp.rho_s * inp.L_fus * A_s)
            dm = inp.rho_s * A_s * drs
        else:
            drs = Qout / (inp.rho_s * inp.L_fus * A_s)
            dm = -inp.rho_s * A_s * drs
        return [drs, 0.0, dm, Qout, 0.0]

    ev_frozen = _front_events(inp)

    def ev_mass(t, y):
        return y[2] - 1e-3 * inp.m_liq0

    ev_mass.terminal = True
    ev_mass.direction = -1

    def record(t, y):
        r_s = _clamp_r(float(y[0]))
        Qout, T_w, R_ice, R_w = cold_path(r_s, inp, T_LOX)
        rec["t"].append(t)
        rec["r_s"].append(r_s)
        rec["T_eth"].append(inp.T_fr)
        rec["m_liq"].append(max(float(y[2]), 0.0))
        rec["Qin"].append(0.0)
        rec["Qout"].append(Qout)
        rec["h1"].append(0.0)
        rec["T_w"].append(T_w)
        rec["q_lox"].append(Qout / (2.0 * math.pi * _sink_wall_radius(inp) * inp.H))
        rec["mu"].append(table.mu(inp.T_fr))
        rec["regime_turb"].append(False)
        rec["cyl_ok"].append(True)
        rec["R_ice"].append(R_ice)
        rec["R_w"].append(R_w)

    y = np.asarray(y0, dtype=float)
    edges = np.linspace(t0, t_end, 26)
    t_now = t0
    for a, b in zip(edges[:-1], edges[1:]):
        sol = solve_ivp(
            rhs, (a, b), y, method="RK45",
            t_eval=np.linspace(a, b, 5)[1:],
            events=[ev_frozen, ev_mass], rtol=1e-6, atol=[1e-9, 1e-5, 1e-7, 1.0, 1.0],
        )
        if not sol.success:
            raise RuntimeError(f"Integrator failed at t={a:.1f}s: {sol.message}")
        if len(sol.t) > 0:
            for ti, yi in zip(sol.t, np.asarray(sol.y).T):
                record(float(ti), yi)
        if sol.status == 1:
            for ev_idx, reason in ((0, "frozen"), (1, "frozen_mass")):
                if len(sol.t_events[ev_idx]) > 0:
                    t_ev = float(sol.t_events[ev_idx][0])
                    record(t_ev, sol.y_events[ev_idx][0])
                    return sol.y_events[ev_idx][0], t_ev, reason
        y = sol.y[:, -1]
        t_now = float(sol.t[-1])
        if progress_cb is not None:
            progress_cb((t_now - t0) / (t_end - t0))
    return y, t_now, "horizon"


# ---------------------------------------------------------------------------
# Orchestration (guide 6a) — equilibrium, transient run, classification
# ---------------------------------------------------------------------------

def _first_crossing(t: np.ndarray, vals: np.ndarray, threshold: float) -> Optional[float]:
    """First time vals exceeds threshold, linearly interpolated."""
    above = vals >= threshold
    if not above.any():
        return None
    i = int(np.argmax(above))
    if i == 0:
        return float(t[0])
    t0, t1, v0, v1 = t[i - 1], t[i], vals[i - 1], vals[i]
    if v1 == v0:
        return float(t1)
    return float(t0 + (threshold - v0) / (v1 - v0) * (t1 - t0))


def _decimate_into(res: TankFreezeResult, inp: TankFreezeInputs, t_arr, rec) -> None:
    ice_arr = np.array([_ice_thickness(r, inp) for r in rec["r_s"]])
    n = len(t_arr)
    idx = np.unique(np.round(np.linspace(0, n - 1, min(inp.plot_points, n))).astype(int))
    res.t_s = t_arr[idx].tolist()
    res.ice_thickness_m = ice_arr[idx].tolist()
    res.Qin_W = np.array(rec["Qin"])[idx].tolist()
    res.Qout_W = np.array(rec["Qout"])[idx].tolist()
    res.T_eth_K = np.array(rec["T_eth"])[idx].tolist()
    res.mu_eth_Pa_s = np.array(rec["mu"])[idx].tolist()
    res.h1_W_m2K = np.array(rec["h1"])[idx].tolist()
    res.T_w_K = np.array(rec["T_w"])[idx].tolist()
    res.q_lox_W_m2 = np.array(rec["q_lox"])[idx].tolist()
    res.m_liq_kg = np.array(rec["m_liq"])[idx].tolist()


def _new_result(inp: TankFreezeInputs, bound_label: str, mode: str) -> TankFreezeResult:
    res = TankFreezeResult(bound_label=bound_label, h1_multiplier=inp.h1_multiplier)
    res.bulk_fluid = inp.bulk_fluid
    res.sink_fluid = inp.sink_fluid
    res.bulk_inside = inp.bulk_inside
    res.mode = mode
    return res


def _no_heat_flow_result(inp: TankFreezeInputs, bound_label: str) -> TankFreezeResult:
    """Same fluid in both sections: dT = 0 -> nothing happens. Flat output."""
    res = _new_result(inp, bound_label, "no_heat_flow")
    res.classification = "NO_HEAT_FLOW"
    table = get_liquid_table(inp.bulk_fluid, max(200.0, inp.T_eth0 + 10.0))
    mu0 = table.mu(inp.T_eth0)
    res.T_LOX_K = sat_temperature(inp.sink_fluid, inp.P_tank_pa)
    t = np.linspace(0.0, inp.t_mission_s, 21)
    res.t_s = t.tolist()
    res.ice_thickness_m = [0.0] * len(t)
    res.Qin_W = [0.0] * len(t)
    res.Qout_W = [0.0] * len(t)
    res.T_eth_K = [inp.T_eth0] * len(t)
    res.mu_eth_Pa_s = [mu0] * len(t)
    res.h1_W_m2K = [0.0] * len(t)
    res.T_w_K = [inp.T_eth0] * len(t)
    res.q_lox_W_m2 = [0.0] * len(t)
    res.m_liq_kg = [inp.m_liq0] * len(t)
    res.ice_at_mission_m = 0.0
    res.T_eth_at_mission_K = inp.T_eth0
    res.mu_at_mission_Pa_s = mu0
    res.flags.append(
        f"Both sections contain {inp.bulk_fluid} at the same tank conditions: there is no "
        "temperature difference across the common wall, so no heat flows and nothing "
        "freezes. All curves are flat by construction."
    )
    return res


def _run_cooling(
    inp: TankFreezeInputs,
    table: SaturatedLiquidTable,
    T_sink: float,
    lox_chf: float,
    progress_cb: Optional[ProgressCb],
    bound_label: str,
) -> TankFreezeResult:
    """COOL-ONLY mode: T_sink >= T_fr(bulk) — the bulk relaxes toward the sink
    with convection + wall conduction in series, but no ice can form
    (e.g. methane against LOX at tank pressures above ~1.07 atm)."""
    res = _new_result(inp, bound_label, "cooling")
    res.T_LOX_K = T_sink
    res.lox_chf_W_m2 = lox_chf

    r_wall_bulk = inp.r_i if inp.bulk_inside else inp.r_o
    A_wall = 2.0 * math.pi * r_wall_bulk * inp.H
    R_w = math.log(inp.r_o / inp.r_i) / (2.0 * math.pi * inp.k_Al * inp.H)

    def quantities(T: float) -> dict:
        # Natural convection against the wall held near T_sink (R_w is
        # negligible). Handle either sign of dT (cooling or warming).
        if T >= T_sink:
            h1, Ra, regime, cyl_ok = convection(T, r_wall_bulk, inp, table, T_surface=T_sink)
        else:
            h1, Ra, regime, cyl_ok = convection(T_sink, r_wall_bulk, inp, table, T_surface=T)
        Q = (T - T_sink) / (1.0 / max(h1 * A_wall, 1e-12) + R_w) if h1 > 0 else 0.0
        T_w = T_sink + Q * R_w
        return dict(h1=h1, Ra=Ra, regime=regime, cyl_ok=cyl_ok, Q=Q, T_w=T_w)

    def rhs(t, y):
        q = quantities(float(y[0]))
        return [-q["Q"] / (inp.m_liq0 * table.cp(float(y[0]))), q["Q"]]

    def ev_equilibrated(t, y):
        return abs(float(y[0]) - T_sink) - 0.05

    ev_equilibrated.terminal = True
    ev_equilibrated.direction = -1

    rec = {k: [] for k in ("t", "T_eth", "Q", "h1", "T_w", "mu", "regime_turb", "cyl_ok")}

    def record(t, y):
        T = float(y[0])
        q = quantities(T)
        rec["t"].append(t)
        rec["T_eth"].append(T)
        rec["Q"].append(q["Q"])
        rec["h1"].append(q["h1"])
        rec["T_w"].append(q["T_w"])
        rec["mu"].append(table.mu(T))
        rec["regime_turb"].append(q["regime"] == "turbulent")
        rec["cyl_ok"].append(q["cyl_ok"])

    y = np.array([inp.T_eth0, 0.0])
    record(0.0, y)
    edges = np.linspace(0.0, inp.t_mission_s, 51)
    for a, b in zip(edges[:-1], edges[1:]):
        sol = solve_ivp(
            rhs, (a, b), y, method="RK45",
            t_eval=np.linspace(a, b, 9)[1:],
            events=[ev_equilibrated], rtol=1e-6, atol=[1e-5, 1.0],
        )
        if not sol.success:
            raise RuntimeError(f"Integrator failed at t={a:.1f}s: {sol.message}")
        if len(sol.t) > 0:
            for ti, yi in zip(sol.t, np.asarray(sol.y).T):
                record(float(ti), yi)
        if sol.status == 1:
            t_ev = float(sol.t_events[0][0])
            record(t_ev, sol.y_events[0][0])
            break
        y = sol.y[:, -1]
        if progress_cb is not None:
            progress_cb(min(float(sol.t[-1]) / inp.t_mission_s, 1.0), float(sol.t[-1]))
    if progress_cb is not None:
        progress_cb(1.0, float(rec["t"][-1]))

    t_arr = np.array(rec["t"])
    T_arr = np.array(rec["T_eth"])
    mu_arr = np.array(rec["mu"])
    Q_arr = np.array(rec["Q"])

    res.classification = "NO_FREEZING"
    res.ice_at_mission_m = 0.0
    res.T_eth_at_mission_K = float(T_arr[-1])
    res.mu_at_mission_Pa_s = float(mu_arr[-1])
    if inp.mu_pump_max is not None:
        res.t_mu_cross_s = _first_crossing(t_arr, mu_arr, inp.mu_pump_max)

    # Energy balance: integral(Q) vs bulk sensible loss (no latent term)
    E_out = float(y[1]) if len(rec["t"]) else 0.0
    cp_mid = np.interp(0.5 * (T_arr[1:] + T_arr[:-1]), table.T_grid, table.cp_grid)
    E_sens = float(np.sum(inp.m_liq0 * cp_mid * -(np.diff(T_arr))))
    if abs(E_out) > 0:
        res.energy_balance_error_pct = 100.0 * (E_out - E_sens) / E_out

    res.flags.append(
        f"No freezing possible: the sink ({inp.sink_fluid}) boils at {T_sink:.1f} K, which is "
        f"at or above the {inp.bulk_fluid} freezing point ({inp.T_fr:.2f} K). The bulk only "
        "cools toward the sink temperature; no ice forms."
    )
    q_sink = np.abs(Q_arr) / (2.0 * math.pi * _sink_wall_radius(inp) * inp.H)
    q_max = float(q_sink.max()) if len(q_sink) else 0.0
    if q_max > lox_chf:
        res.flags.append(
            f"Sink-side heat flux peaked at {q_max:.2e} W/m^2, above the critical heat flux "
            f"({lox_chf:.2e} W/m^2); the fixed-T sink assumption is degraded early on."
        )
    if table.out_of_range:
        res.flags.append(
            f"{inp.bulk_fluid.capitalize()} property lookups left the tabulated range "
            f"({table.T_min:.1f}-{table.T_max:.0f} K) and were clamped."
        )
    res.flags.append(
        "Lumped-bulk model: a real vertical tank stratifies; local temperatures near the "
        "wall will be colder than this uniform prediction."
    )

    # Series (ice identically zero; Qin = Qout = Q through the wall)
    n = len(t_arr)
    idx = np.unique(np.round(np.linspace(0, n - 1, min(inp.plot_points, n))).astype(int))
    res.t_s = t_arr[idx].tolist()
    res.ice_thickness_m = [0.0] * len(idx)
    res.Qin_W = Q_arr[idx].tolist()
    res.Qout_W = Q_arr[idx].tolist()
    res.T_eth_K = T_arr[idx].tolist()
    res.mu_eth_Pa_s = mu_arr[idx].tolist()
    res.h1_W_m2K = np.array(rec["h1"])[idx].tolist()
    res.T_w_K = np.array(rec["T_w"])[idx].tolist()
    res.q_lox_W_m2 = q_sink[idx].tolist()
    res.m_liq_kg = [inp.m_liq0] * len(idx)
    return res


def run_tank_freeze(
    inp: TankFreezeInputs,
    progress_cb: Optional[ProgressCb] = None,
    bound_label: str = "nominal",
) -> TankFreezeResult:
    """Full single-bound run: resolve the configuration, then run the
    appropriate mode (freeze march / cooling relaxation / flat no-heat-flow),
    with equilibrium estimate, classification, and solidification search."""
    inp.validate()
    if inp.same_fluid:
        return _no_heat_flow_result(inp, bound_label)

    table = get_liquid_table(inp.bulk_fluid, max(350.0, inp.T_eth0 + 10.0))

    # --- Fuel-side pressurization: Clausius-Clapeyron freezing-point shift.
    # dT_fr/dP = T_fr (v_liq - v_sol) / L_fus, ~0.02-0.04 K/bar for these
    # fluids. The registry T_fr values are ~1-atm melting points, so the
    # shift is measured from ambient. Applied BEFORE mode dispatch — for the
    # marginal methane/LOX case the elevation can flip cooling-only into
    # freezing (and it is the conservative direction: more/sooner ice).
    P_fuel = inp.P_fuel_pa if inp.P_fuel_pa is not None else 101325.0
    tfr_shift = 0.0
    pressure_flag = None
    if P_fuel != 101325.0:
        from dataclasses import replace
        was_flagged = table.out_of_range
        rho_l_fr = table.props(inp.T_fr).rho  # liquid density at the melt line
        table.out_of_range = was_flagged      # edge clamp here is not a run warning
        dTdP = inp.T_fr * (1.0 / rho_l_fr - 1.0 / inp.rho_s) / inp.L_fus
        tfr_shift = dTdP * (P_fuel - 101325.0)
        inp = replace(inp, T_fr=inp.T_fr + tfr_shift)
        if abs(tfr_shift) > 0.01:
            pressure_flag = (
                f"Fuel-side pressure ({P_fuel/6894.757:.0f} psia) shifts the {inp.bulk_fluid} "
                f"freezing point by {tfr_shift:+.2f} K (Clausius-Clapeyron, "
                f"{dTdP*1e5:.3f} K/bar); using T_fr = {inp.T_fr:.2f} K."
            )

    T_LOX = sat_temperature(inp.sink_fluid, inp.P_tank_pa)
    lox_chf = inp.lox_chf if inp.lox_chf is not None else chf_zuber(inp.sink_fluid, inp.P_tank_pa)

    # The liquid must fit inside its section (2% slack for density
    # estimates). More mass would mean liquid beyond the jacketed section,
    # which this lumped model does not represent.
    rho0 = table.props(inp.T_eth0).rho
    if inp.bulk_inside:
        m_capacity = rho0 * math.pi * inp.r_i**2 * inp.H
        section_desc = f"a full r_i = {inp.r_i:.3f} m x H = {inp.H:.2f} m cylinder"
    else:
        m_capacity = rho0 * math.pi * (inp.r_t**2 - inp.r_o**2) * inp.H
        section_desc = (
            f"a full annulus between r_o = {inp.r_o:.3f} m and r_t = {inp.r_t:.3f} m "
            f"x H = {inp.H:.2f} m"
        )
    if inp.m_liq0 > 1.02 * m_capacity:
        raise ValueError(
            f"Initial liquid mass ({inp.m_liq0:.1f} kg) does not fit within the wetted height: "
            f"{section_desc} holds {m_capacity:.1f} kg "
            f"of {inp.bulk_fluid} at {inp.T_eth0:.0f} K. Reduce the mass or increase the geometry."
        )

    if T_LOX >= inp.T_fr:
        # e.g. methane bulk vs LOX sink above ~1.07 atm: cooling without ice
        res = _run_cooling(inp, table, T_LOX, lox_chf, progress_cb, bound_label)
        if pressure_flag:
            res.flags.insert(0, pressure_flag)
        return res

    res = _new_result(inp, bound_label, "freeze")
    res.T_LOX_K = T_LOX
    res.lox_chf_W_m2 = lox_chf
    res.stefan_number = inp.c_p_s * (inp.T_fr - T_LOX) / inp.L_fus
    if pressure_flag:
        res.flags.append(pressure_flag)

    def report(frac: float, t: float) -> None:
        if progress_cb is not None:
            progress_cb(min(max(frac, 0.0), 1.0), t)

    # --- Deliverable 1: quasi-steady equilibrium thickness at T_eth0 (6a.1)
    r_s_eq = equilibrium_front_radius(inp, table, T_LOX, inp.T_eth0)
    if r_s_eq is None:
        res.delta_eq_m = None  # no equilibrium: grows to full solidification
    else:
        res.delta_eq_m = max(_ice_thickness(r_s_eq, inp), 0.0)

    # --- Transient run to t_mission (6a.3). Mission maps to progress 0..0.7;
    #     the optional solidification search fills 0.7..1.0.
    rec = {k: [] for k in (
        "t", "r_s", "T_eth", "m_liq", "Qin", "Qout", "h1", "T_w", "q_lox",
        "mu", "regime_turb", "cyl_ok", "R_ice", "R_w",
    )}
    # y = [r_s, T_eth, m_liq, E_out, E_in] (E_* are energy quadrature states)
    r_s0 = inp.r_i - inp.delta_seed if inp.bulk_inside else inp.r_o + inp.delta_seed
    y0 = np.array([r_s0, inp.T_eth0, inp.m_liq0, 0.0, 0.0])
    y, t_now, reason = _march(
        inp, table, T_LOX, y0, 0.0, inp.t_mission_s, rec,
        progress_cb=lambda f: report(0.7 * f, f * inp.t_mission_s),
    )

    t_arr = np.array(rec["t"])
    ice_arr = np.array([_ice_thickness(r, inp) for r in rec["r_s"]])

    res.ice_at_mission_m = float(ice_arr[-1])
    res.T_eth_at_mission_K = float(rec["T_eth"][-1])
    res.mu_at_mission_Pa_s = table.mu(res.T_eth_at_mission_K)

    # --- Classification (6a.3)
    if reason in ("frozen", "frozen_mass"):
        res.classification = "UNBOUNDED"
        res.t_solidify_s = t_now
        res.flags.append(
            f"Ethanol fully solidified at t = {t_now:.0f} s — before the mission window closed."
            if inp.bulk_fluid == "ethanol" else
            f"{inp.bulk_fluid.capitalize()} fully solidified at t = {t_now:.0f} s — before "
            "the mission window closed."
        )
        if reason == "frozen_mass":
            res.flags.append(_FROZEN_MASS_NOTE if inp.bulk_inside else _FROZEN_MASS_NOTE_OUTWARD)
    elif reason == "bulk_frozen":
        res.classification = "UNBOUNDED"
        res.flags.append(
            f"Bulk {inp.bulk_fluid} reached the freezing point at t = {t_now:.0f} s; the remaining "
            "liquid freezes by pure conduction from there (modeled with Qin = 0, the "
            "conservative/fastest direction for freeze time)."
        )
    else:
        # plateau test over the last 5% of the mission window
        i95 = int(np.searchsorted(t_arr, 0.95 * inp.t_mission_s))
        i95 = min(max(i95, 0), len(ice_arr) - 1)
        growth_last5 = (ice_arr[-1] - ice_arr[i95]) / max(float(ice_arr[-1]), 1e-12)
        near_eq = (
            res.delta_eq_m is not None
            and res.delta_eq_m > 0.0
            and abs(float(ice_arr[-1]) - res.delta_eq_m) / res.delta_eq_m < 0.05
        )
        if growth_last5 < 0.01 and near_eq:
            res.classification = "BOUNDED"
        else:
            res.classification = "UNBOUNDED"

    if res.classification == "BOUNDED" and res.delta_eq_m is not None:
        res.t_to_95pct_eq_s = _first_crossing(t_arr, ice_arr, 0.95 * res.delta_eq_m)

    # --- Solidification search (6a.4) when unbounded and not yet frozen
    if res.classification == "UNBOUNDED" and res.t_solidify_s is None:
        if reason == "bulk_frozen":
            y, t_now, reason2 = _march_pinned(
                inp, table, T_LOX, y, t_now, inp.t_solidify_max_s, rec,
                progress_cb=lambda f: report(0.7 + 0.3 * f, t_now + f * (inp.t_solidify_max_s - t_now)),
            )
        else:
            y, t_now, reason2 = _march(
                inp, table, T_LOX, y, t_now, inp.t_solidify_max_s, rec,
                progress_cb=lambda f: report(0.7 + 0.3 * f, t_now + f * (inp.t_solidify_max_s - t_now)),
            )
            if reason2 == "bulk_frozen":
                y, t_now, reason2 = _march_pinned(
                    inp, table, T_LOX, y, t_now, inp.t_solidify_max_s, rec,
                    progress_cb=lambda f: report(0.7 + 0.3 * f, t_now),
                )
                res.flags.append(
                    f"Bulk {inp.bulk_fluid} reached the freezing point during the solidification "
                    "search; remaining liquid frozen by pure conduction (Qin = 0)."
                )
        if reason2 in ("frozen", "frozen_mass"):
            res.t_solidify_s = t_now
            if reason2 == "frozen_mass":
                res.flags.append(_FROZEN_MASS_NOTE if inp.bulk_inside else _FROZEN_MASS_NOTE_OUTWARD)
        else:
            res.solidify_capped = True

    report(1.0, t_now)

    # --- Recorded arrays (full resolution) for crossings + energy balance
    t_arr = np.array(rec["t"])
    ice_arr = np.array([_ice_thickness(r, inp) for r in rec["r_s"]])
    mu_arr = np.array(rec["mu"])
    qlox_arr = np.array(rec["q_lox"])
    m_arr = np.array(rec["m_liq"])

    if inp.mu_pump_max is not None:
        res.t_mu_cross_s = _first_crossing(t_arr, mu_arr, inp.mu_pump_max)
    if inp.delta_ice_max is not None:
        res.t_ice_cross_s = _first_crossing(t_arr, ice_arr, inp.delta_ice_max)

    # --- Energy balance (guide section 9): integral(Qout) vs sensible + latent.
    # E_out comes from the integrator's quadrature state (accurate through the
    # singular early spike); the bulk sensible loss is recomputed independently
    # from the recorded (m_liq, T_eth) trajectory.
    E_out = float(y[3])
    T_rec = np.array(rec["T_eth"])
    cp_mid = np.interp(0.5 * (T_rec[1:] + T_rec[:-1]), table.T_grid, table.cp_grid)
    m_mid = 0.5 * (m_arr[1:] + m_arr[:-1])
    E_sens = float(np.sum(m_mid * cp_mid * -(np.diff(T_rec))))
    E_latent = inp.L_fus * float(m_arr[0] - m_arr[-1])
    if E_out > 0:
        res.energy_balance_error_pct = 100.0 * (E_out - (E_sens + E_latent)) / E_out

    # --- Flags (guide section 7)
    turb = np.array(rec["regime_turb"])
    if turb.any():
        res.flags.append(
            f"Flow regime: turbulent (Ra_H > 1e9) for {100.0 * turb.mean():.0f}% of recorded steps."
        )
    else:
        res.flags.append("Flow regime: laminar (Ra_H < 1e9) throughout.")
    cyl = np.array(rec["cyl_ok"])
    if (~cyl).any():
        res.flags.append(
            f"Cylinder-as-plate criterion (D/H >= 35/Gr^0.25) violated for "
            f"{100.0 * (~cyl).mean():.0f}% of recorded steps — Churchill-Chu overestimates h1 there."
        )
    q_max = float(qlox_arr.max()) if len(qlox_arr) else 0.0
    above_chf = qlox_arr > lox_chf
    if above_chf.any():
        # First recorded sample at/below CHF after the above-CHF stretch
        last_above = int(np.where(above_chf)[0][-1])
        t_above_end = float(t_arr[min(last_above + 1, len(t_arr) - 1)])
        if t_above_end <= max(0.02 * inp.t_mission_s, 30.0):
            res.flags.append(
                f"LOX-side heat flux exceeds the critical heat flux ({lox_chf:.2e} W/m^2) only "
                f"during the initial quench (drops below CHF within the first {t_above_end:.1f} s, "
                "once ice insulates the wall). Real film boiling would slow the flux there, so this "
                "prediction is freeze-time conservative; the fixed-T_LOX assumption holds for the "
                "rest of the run."
            )
        else:
            res.flags.append(
                f"LOX-side heat flux is ABOVE the critical heat flux ({lox_chf:.2e} W/m^2) until "
                f"t = {t_above_end:.0f} s — a substantial part of the run. The nucleate-boiling / "
                "fixed-T_LOX assumption is invalid there (film boiling would slow the real flux)."
            )
    elif q_max > 0.5 * lox_chf:
        res.flags.append(
            f"LOX-side heat flux peaked at {q_max:.2e} W/m^2 (> 50% of CHF = {lox_chf:.2e} "
            "W/m^2); the fixed-T_LOX sink assumption is approaching its limit."
        )
    res.flags.append(
        f"Stefan number Ste = {res.stefan_number:.2f}: quasi-steady ice conduction is "
        "borderline; absolute thickness/time good to ~factor of 2 (guide sections 1, 7)."
    )
    if table.out_of_range:
        res.flags.append(
            f"{inp.bulk_fluid.capitalize()} property lookups left the tabulated range "
            f"({table.T_min:.1f}-{table.T_max:.0f} K) and were clamped — largest near the "
            "freezing point."
        )
    res.flags.append(
        "Lumped-bulk model: a real vertical tank stratifies and freezes bottom-first; "
        "local ice thickness can exceed this uniform prediction."
    )
    T_sat_bulk = sat_temperature(inp.bulk_fluid, P_fuel)
    if inp.T_eth0 > T_sat_bulk:
        res.flags.append(
            f"Initial {inp.bulk_fluid} temperature ({inp.T_eth0:.1f} K) exceeds its saturation "
            f"temperature at the fuel-side pressure ({T_sat_bulk:.1f} K) — the bulk would be "
            "boiling; results assume it stays liquid."
        )

    # --- Decimate time series for the response
    _decimate_into(res, inp, t_arr, rec)
    return res


def run_tank_freeze_bounds(
    inp: TankFreezeInputs,
    mode: str = "both",
    h1_high: float = H1_HIGH_DEFAULT,
    h1_low: float = H1_LOW_DEFAULT,
    progress_cb: Optional[Callable[[float, float, str], None]] = None,
) -> list[TankFreezeResult]:
    """Run the conservative bounds chosen for this tool (guide section 8).

    mode='both'        -> h1-high run (freeze-time bound) + h1-low run
                          (ice-thickness bound), overlaid by the UI.
    mode='freeze_time' -> single h1-high run.
    mode='nominal'     -> single unbiased run.
    """
    from dataclasses import replace

    if mode == "both":
        runs = [("h1_high", h1_high), ("h1_low", h1_low)]
    elif mode == "freeze_time":
        runs = [("h1_high", h1_high)]
    elif mode == "nominal":
        runs = [("nominal", 1.0)]
    else:
        raise ValueError(f"Unknown bound mode: {mode!r}")

    results = []
    for i, (label, mult) in enumerate(runs):
        def cb(frac: float, sim_t: float, _i=i, _label=label) -> None:
            if progress_cb is not None:
                progress_cb((_i + frac) / len(runs), sim_t, _label)

        results.append(
            run_tank_freeze(replace(inp, h1_multiplier=mult), progress_cb=cb, bound_label=label)
        )
    return results
