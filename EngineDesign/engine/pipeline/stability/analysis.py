"""Stability analysis for combustion and feed system dynamics.

1. Combustion stability: chug (feed-coupled, low frequency) and acoustic (chamber modes).
2. Feed-line acoustics and the water-hammer bound, both lines.
3. Overall classification at an operating point.

Every gate-facing margin is a physical ratio that is 1 at neutral stability:
  * chug: the Nyquist gain margin of the feed-chamber loop (the factor the loop gain can rise
    before a pole crosses into the right half-plane), taken at the low end of the unmeasured
    mixing-lag band;
  * acoustic: damping/driving for the worst mode (= n_crit/n), gated only when
    ``stability.acoustic_gate`` asks for it -- by default it is reported, not gated (acoustic.py).
They are compared directly with ``design_requirements.min_stability_margin``. The tanh remaps that
used to sit between the physics and the gate (and saturated at 1.3) are gone.
"""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Dict, Tuple, Optional, List, Any
import numpy as np
from engine.pipeline.config_schemas import PintleEngineConfig, StabilityConfig
from engine.pipeline.constants import DEFAULT_HOT_GAS_THERMAL_COND_W_M_K, DEFAULT_HOT_GAS_VISC_PA_S


# ---------------------------------------------------------------------------
# Combustion and acoustic stability
# ---------------------------------------------------------------------------

def calculate_chugging_frequency(
    chamber_volume: float,
    throat_area: float,
    cstar: float,
    gamma: float,
    Pc: float,
    R: Optional[float] = None,
    Tc: Optional[float] = None,
) -> Dict[str, float]:
    """
    Order-of-magnitude chug (bulk-mode) frequency estimates from chamber geometry alone.

    Two estimates: the residence-time frequency ``1 / (2 pi tau_res)`` with ``tau_res = L*/c*``, and
    a Helmholtz bulk mode using the throat as the neck. These are *placeholders* -- the physical chug
    frequency comes from the feed-coupled loop in ``chug.py`` and overwrites ``frequency`` in
    ``comprehensive_stability_analysis``. The old heuristic "stability_index" / "stability_margin"
    that used to ride along here (floored at 0.4 and mapped to a margin so that "reasonable designs
    achieve required margins") was not a physical quantity and has been removed; margins come from
    the gain-margin model only.

    Returns
    -------
    dict
        - frequency: Helmholtz estimate when gas properties are known, else the residence estimate [Hz]
        - frequency_residence, frequency_helmholtz: the two estimates [Hz] (nan if unavailable)
        - period: 1 / frequency [s]
        - tau_residence: L* / c* [s]
        - Lstar: characteristic length [m]
    """
    if throat_area <= 0.0 or chamber_volume <= 0.0 or cstar <= 0.0:
        return {"frequency": float("nan"), "frequency_residence": float("nan"),
                "frequency_helmholtz": float("nan"), "period": float("nan"),
                "tau_residence": float("nan"), "Lstar": float("nan")}
    Lstar = chamber_volume / throat_area
    tau_residence = Lstar / cstar
    freq_res = 1.0 / (2.0 * np.pi * tau_residence)

    # Helmholtz-like bulk mode: f_H = (a / 2pi) * sqrt(A_neck / (V * L_eff)), neck = throat,
    # L_eff ~ half a throat diameter.
    freq_helm = float("nan")
    if R is not None and Tc is not None and gamma * R * Tc > 0:
        a = float(np.sqrt(gamma * R * Tc))
        d_throat = np.sqrt(4.0 * throat_area / np.pi)
        L_eff = max(0.5 * d_throat, 1.0e-3)
        freq_helm = float((a / (2.0 * np.pi)) * np.sqrt(throat_area / (chamber_volume * L_eff)))

    freq = freq_helm if np.isfinite(freq_helm) else float(freq_res)
    # The gas residence time, m_gas / mdot = rho_c V / mdot = L* c* / (R T) -- what the chug
    # model's theta_c and the results' "Residence Time" are. L*/c* is not a residence time: it is
    # short of it by Gamma^2 (~0.4), and was shown as "tau residence" beside the real one.
    theta_c = (float(Lstar * cstar / (R * Tc)) if (R is not None and Tc is not None and R * Tc > 0)
               else float("nan"))
    return {
        "theta_c": theta_c,
        "frequency": float(freq),
        "frequency_residence": float(freq_res),
        "frequency_helmholtz": float(freq_helm),
        "period": float(1.0 / freq) if freq > 0 else float("inf"),
        "tau_residence": float(tau_residence),
        "Lstar": float(Lstar),
    }


def calculate_acoustic_modes(
    chamber_length: float,
    chamber_diameter: float,
    gas_temperature: float,
    gamma: float,
    R: float,
) -> Dict[str, Any]:
    """
    Calculate acoustic resonance frequencies for longitudinal and transverse modes.

    Parameters
    ----------
    chamber_length : float
        Chamber length [m]
    chamber_diameter : float
        Chamber diameter [m]
    gas_temperature : float
        Gas temperature [K]
    gamma : float
        Specific heat ratio [-]
    R : float
        Gas constant [J/(kg K)]

    Returns
    -------
    dict
        - longitudinal_modes: list of longitudinal mode frequencies [Hz]
        - transverse_modes: list of first few transverse mode frequencies [Hz]
        - sound_speed: sound speed [m/s]
    """
    # Sound speed
    sound_speed = float(np.sqrt(gamma * R * gas_temperature))

    # Guard against degenerate length or diameter
    L = max(chamber_length, 1.0e-3)
    D = max(chamber_diameter, 1.0e-3)

    # Longitudinal modes: closed-closed half-wave (rigid face, choked nozzle). core.longitudinal_mode_frequencies
    longitudinal_modes: List[float] = [float(n * sound_speed / (2.0 * L)) for n in range(1, 6)]

    # Transverse cylindrical modes: hard-wall eigenvalues are zeros of J'_m (velocity roots), NOT the
    # pressure roots of J_m. Previously used [2.405, ...] (J_m zeros) — that was wrong; the rigid-wall
    # transverse set is [1.841 (1T), 3.054 (2T), 3.832 (1R), 4.201 (3T), 5.331 (1T1R)]. [Phys §4.1]
    alpha_values = [1.84118, 3.05424, 3.83171, 4.20119, 5.33144]
    transverse_modes: List[float] = []
    for alpha in alpha_values:
        freq = alpha * sound_speed / (np.pi * D)
        transverse_modes.append(float(freq))

    return {
        "longitudinal_modes": longitudinal_modes,
        "transverse_modes": transverse_modes,
        "sound_speed": sound_speed,
    }


# ---------------------------------------------------------------------------
# Feed system stability
# ---------------------------------------------------------------------------

def analyze_feed_system_stability(
    feed_line_length: float,
    feed_line_diameter: float,
    propellant_density: float,
    bulk_modulus: float,
    flow_velocity: float,
    pressure_drop: Optional[float] = None,
    *,
    wall_modulus_pa: Optional[float] = None,
    wall_thickness_m: Optional[float] = None,
    valve_closure_time_s: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Feed-line acoustics and the water-hammer spike for one propellant line.

    Parameters
    ----------
    feed_line_length, feed_line_diameter : float
        Line length and bore [m]
    propellant_density, bulk_modulus : float
        Liquid density [kg/m^3] and isentropic bulk modulus [Pa]
    flow_velocity : float
        Mean line velocity [m/s]
    pressure_drop : float, optional
        Unused; kept so old callers still bind.
    wall_modulus_pa, wall_thickness_m : float, optional
        Tube Young's modulus and wall. With both, the wave speed carries the Korteweg wall
        compliance ``a = a_liquid / sqrt(1 + K D / (E e))`` (Wylie & Streeter, Fluid Transients);
        without, the rigid-wall ``sqrt(K/rho)`` is an upper bound.
    valve_closure_time_s : float, optional
        Valve closure time. None = instantaneous: the Joukowsky bound ``rho a v``. For a closure
        slower than the round trip ``2L/a`` the spike is ``rho a v (2L/a) / t_c`` (Michaud).

    Returns
    -------
    dict
        - pogo_frequency: quarter-wave line mode (tank end open, injector end closed) [Hz]
        - surge_frequency: half-wave line mode (closed-closed) [Hz]
        - sound_speed: wave speed in the line, wall compliance included when given [m/s]
        - sound_speed_liquid: sqrt(K/rho) [m/s]
        - korteweg_factor: a_liquid / a [-] (1 = rigid wall)
        - water_hammer_pressure: valve-closure spike [Pa]
        - water_hammer_basis: which formula produced it

    The feed-coupled *stability* margin is the chug gain margin from ``chug.py``; the caller writes
    it into this dict as ``stability_margin``. ``water_hammer_margin`` (steady drop over the
    instantaneous-closure spike) compared two unrelated pressures and has been removed.
    """
    L = max(feed_line_length, 1.0e-3)
    rho = propellant_density
    K = bulk_modulus

    a_liq = float(np.sqrt(K / rho))
    korteweg = 1.0
    if (wall_modulus_pa is not None and wall_thickness_m is not None
            and wall_modulus_pa > 0 and wall_thickness_m > 0 and feed_line_diameter > 0):
        korteweg = float(np.sqrt(1.0 + K * feed_line_diameter / (wall_modulus_pa * wall_thickness_m)))
    sound_speed = a_liq / korteweg
    pogo_frequency = float(sound_speed / (4.0 * L))   # closed-open
    surge_frequency = float(sound_speed / (2.0 * L))  # closed-closed

    delta_v = max(flow_velocity, 0.0)
    joukowsky = float(rho * sound_speed * delta_v)
    t_round = 2.0 * L / sound_speed
    if valve_closure_time_s is None or valve_closure_time_s <= t_round:
        water_hammer_pressure = joukowsky
        basis = ("Joukowsky rho*a*v, instantaneous closure (upper bound)" if valve_closure_time_s is None
                 else "Joukowsky rho*a*v, closure faster than the 2L/a round trip")
    else:
        water_hammer_pressure = float(joukowsky * t_round / valve_closure_time_s)
        basis = "Michaud rho*a*v*(2L/a)/t_c, closure slower than the 2L/a round trip"

    return {
        "pogo_frequency": pogo_frequency,
        "surge_frequency": surge_frequency,
        "sound_speed": float(sound_speed),
        "sound_speed_liquid": a_liq,
        "korteweg_factor": korteweg,
        "water_hammer_pressure": water_hammer_pressure,
        "water_hammer_basis": basis,
        "valve_closure_time_s": valve_closure_time_s,
    }


# ---------------------------------------------------------------------------
# Physical stability margins -- fast tiers for the per-eval path
# ---------------------------------------------------------------------------
# Both gate margins are 1 at neutral stability and compare directly with
# design_requirements.min_stability_margin: chug = Nyquist gain margin, acoustic = damping/driving.

#: stability.acoustic_gate -> which acoustic margin reaches the gate. "report_only" keeps the
#: acoustic model out of the gate (margin +inf there, i.e. no constraint); see acoustic.py.
ACOUSTIC_GATE_MODES = ("report_only", "nominal_phase", "worst_phase")


def gain_margin_db(gain_margin: float) -> float:
    """20 log10(GM) [dB]; NaN for a non-positive or non-finite margin."""
    if gain_margin is None or not np.isfinite(gain_margin) or gain_margin <= 0:
        return float("nan")
    return float(20.0 * np.log10(gain_margin))


def stability_score(min_margin: float) -> float:
    """Display score in [0, 1] of the limiting gate margin: ``clip((m - 0.85) / 0.45, 0, 1)``.

    A fixed linear map with no physics of its own: score s <=> margin 0.85 + 0.45 s, so a
    ``min_stability_score`` of 0.58 is a margin floor of 1.111. Non-finite margin -> 0 (fail closed).
    """
    if min_margin is None or not np.isfinite(min_margin):
        return 1.0 if (min_margin is not None and min_margin == float("inf")) else 0.0
    return float(np.clip((min_margin - 0.85) / 0.45, 0.0, 1.0))


def stability_state_ok(state: str, require_stable_state: bool) -> bool:
    """The state test Layer 1 means by ``require_stable_state``: True -> only 'stable' passes;
    False -> 'stable' or 'marginal'. 'unstable' and 'unknown' never pass."""
    return state == "stable" if require_stable_state else state in ("stable", "marginal")


def _stability_requirement(config) -> float:
    """Gate threshold for 'stable': design_requirements.min_stability_margin relaxed by
    stability_margin_handicap exactly as Layer 1 relaxes it; the schema default when absent."""
    from engine.pipeline.config_schemas import DesignRequirementsConfig
    dr = getattr(config, "design_requirements", None)
    m = getattr(dr, "min_stability_margin", None)
    if m is None or not np.isfinite(float(m)):
        m = DesignRequirementsConfig.model_fields["min_stability_margin"].default
    h = float(getattr(dr, "stability_margin_handicap", 0.0) or 0.0)
    return float(m) * max(0.0, 1.0 - h)


def classify_stability(chug_gm_nominal: float, chug_gate: float, acoustic_gate: float,
                       acoustic_alpha_nominal: float, acoustic_gated: bool,
                       requirement: float) -> str:
    """'unstable' / 'marginal' / 'stable' / 'unknown' from the physical margins.

    unstable: the model predicts growth at its nominal inputs (chug GM < 1, or a gated acoustic
              mode with alpha > 0 / margin < 1);
    stable:   every gated margin clears max(1, requirement);
    marginal: predicted stable, but some gated margin falls short of the requirement (for chug,
              possibly only at the pessimistic end of the mixing-lag band);
    unknown:  a gated number is missing -- never passes.
    """
    gated = [chug_gm_nominal, chug_gate] + ([acoustic_gate] if acoustic_gated else [])
    if any(v is None or np.isnan(v) for v in gated):
        return "unknown"
    if chug_gm_nominal <= 1.0 or (acoustic_gated and (acoustic_gate <= 1.0 or acoustic_alpha_nominal > 0.0)):
        return "unstable"
    floor = max(1.0, float(requirement))
    if chug_gate >= floor and (not acoustic_gated or acoustic_gate >= floor):
        return "stable"
    return "marginal"


def _fluid_attr(fluids, key, attr, default):
    """Config-first fluid property lookup. ``default=None`` is allowed and returned as-is when the
    property is missing — callers use that to route the fallback through the assumptions registry
    (UNIFICATION P2c) instead of silently substituting."""
    try:
        f = fluids[key] if isinstance(fluids, dict) else getattr(fluids, key)
        v = getattr(f, attr, None)
        if v is not None and np.isfinite(float(v)):
            return float(v)
        return None if default is None else float(default)
    except Exception:
        return None if default is None else float(default)


def _feed_attr(config, key, attr, default):
    try:
        fs = config.feed_system
        f = fs[key] if isinstance(fs, dict) else getattr(fs, key)
        v = getattr(f, attr, None)
        return float(v) if (v is not None and np.isfinite(float(v))) else float(default)
    except Exception:
        return float(default)


# Handbook thermodynamic fallbacks BY FLUID, used only when the config omits a property. Every use
# is recorded in the assumptions registry. Previously the fuel fallbacks were methane's (h_fg 510 kJ/kg,
# T_boil 111.6 K) regardless of which fuel the config named, and the oxidizer's were LOX's.
#                         density kg/m^3   latent heat J/kg   boiling point K   critical T K
_FLUID_THERMO_FALLBACKS = {
    "lox":          (1140.0,  213000.0,  90.2,  154.58),
    "methane":      ( 422.6,  510000.0, 111.65, 190.56),
    "ethanol":      ( 789.0,  838000.0, 351.4,  514.0),
    "rp1":          ( 810.0,  246000.0, 489.0,  678.0),   # n-dodecane surrogate
    "ipa":          ( 786.0,  665000.0, 355.6,  508.3),
    "nitrousoxide": (1220.0,  376000.0, 184.7,  309.52),
    "hydrogen":     (  70.8,  446000.0,  20.3,   33.15),
    "nitrogen":     ( 806.0,  199000.0,  77.36, 126.19),
}
_THERMO_INDEX = {"density": (0, "kg/m^3"), "latent_heat": (1, "J/kg"),
                 "boiling_point": (2, "K"), "critical_temperature": (3, "K")}
_GENERIC_THERMO = {"fuel": (800.0, 300000.0, 450.0, 600.0),
                   "oxidizer": (1140.0, 213000.0, 90.2, 154.58)}

#: Fluid name -> CoolProp fluid, for properties the config did not supply. Only names whose
#: thermodynamics CoolProp actually covers; RP-1 is a cut, not a compound, so it is left to the
#: n-dodecane surrogate in the handbook table above rather than asked of CoolProp under a name
#: CoolProp would silently resolve to something else.
_COOLPROP_NAMES = {
    "lox": "Oxygen", "methane": "Methane", "ethanol": "Ethanol", "ipa": "n-Propanol",
    "nitrousoxide": "NitrousOxide", "hydrogen": "Hydrogen", "nitrogen": "Nitrogen",
}


@lru_cache(maxsize=32)
def _coolprop_critical_temperature(canon: str) -> Optional[float]:
    """Critical temperature [K] from CoolProp for a canonical fluid name, or None.

    Cached: the fast stability tier runs on every optimizer candidate, and a PropsSI call per
    candidate would be a real cost for a value that cannot change within a process.
    """
    name = _COOLPROP_NAMES.get(canon)
    if not name:
        return None
    try:
        from CoolProp.CoolProp import PropsSI
        v = float(PropsSI("Tcrit", name))
        return v if np.isfinite(v) and v > 0 else None
    except Exception:
        return None


def _fluid_name(config, key: str) -> str:
    try:
        f = config.fluids[key] if isinstance(config.fluids, dict) else getattr(config.fluids, key)
        return str(getattr(f, "name", "") or "")
    except Exception:
        return ""


def _fluid_thermo(config, key: str, attr: str) -> float:
    """``fluids[key].attr`` from the config; else CoolProp for the named fluid; else the handbook
    table; else a generic value. Every fallback is recorded, and the generic one says outright that
    the fluid was unrecognised so it reads as "fix the config", not as a property."""
    v = _fluid_attr(getattr(config, "fluids", None), key, attr, None)
    if v is not None:
        return v
    from engine.pipeline.assumptions import assume
    from engine.pipeline.io import _canon_fluid
    idx, unit = _THERMO_INDEX[attr]
    name = _fluid_name(config, key)
    canon = _canon_fluid(name)
    if attr == "critical_temperature":
        cp = _coolprop_critical_temperature(canon)
        if cp is not None:
            return assume(f"stability.fluids.{key}.{attr}", cp, unit=unit,
                          reason=f"fluids.{key}.critical_temperature missing; CoolProp value for {name}")
    if canon in _FLUID_THERMO_FALLBACKS:
        return assume(f"stability.fluids.{key}.{attr}", _FLUID_THERMO_FALLBACKS[canon][idx], unit=unit,
                      reason=f"fluids.{key}.{attr} missing from config; handbook value for {name}")
    return assume(f"stability.fluids.{key}.{attr}", _GENERIC_THERMO["oxidizer" if key == "oxidizer" else "fuel"][idx],
                  unit=unit, reason=f"fluids.{key}.{attr} missing and fluid {name!r} is not in the handbook table -- set it in the config")


def _injection_phase(config, key: str) -> str:
    """``"liquid"`` or ``"gas"`` at the injector face.

    Explicit config wins. Otherwise: supercritical at the tank temperature is gas-like, and a fluid
    whose vapour pressure at its own bulk temperature exceeds the chamber pressure arrives as vapour.
    Both inferences are recorded — getting this wrong changes which time lags exist at all, so it
    must never be a silent guess.
    """
    from engine.pipeline.assumptions import assume
    explicit = None
    try:
        f = config.fluids[key] if isinstance(config.fluids, dict) else getattr(config.fluids, key)
        explicit = getattr(f, "injection_phase", None)
    except Exception:
        f = None
    if explicit in ("liquid", "gas"):
        return str(explicit)
    name = _fluid_name(config, key)
    T = _fluid_attr(getattr(config, "fluids", None), key, "temperature", None)
    T_crit = _fluid_thermo(config, key, "critical_temperature")
    if T is not None and np.isfinite(T_crit) and T >= T_crit:
        return assume(f"stability.fluids.{key}.injection_phase", "gas", unit="-",
                      reason=f"{name or key} is stored at {T:.0f} K, at or above its critical "
                             f"temperature {T_crit:.0f} K -- inferred to arrive as a gas")
    return "liquid"


def _feed_geometry(config, side: str) -> Tuple[float, float]:
    """(length [m], flow area [m^2]) of one feed line for the chug inertance L/A.

    Length comes from ``feed_system.<side>.length`` -- a field that did not exist until now, which is
    why the model used to carry a hardcoded 0.305 m for every engine. Area is the schema-derived
    ``A_hydraulic`` (pi d^2/4 unless the user gave a non-circular passage).
    """
    from engine.pipeline.assumptions import assume
    L = _feed_attr(config, side, "length", float("nan"))
    if not np.isfinite(L) or L <= 0.0:
        L = assume(f"stability.feed.{side}.length", 0.305, unit="m",
                   reason=f"feed_system.{side}.length not set (tank-outlet to manifold run)")
    A = _feed_attr(config, side, "A_hydraulic", float("nan"))
    if not np.isfinite(A) or A <= 0.0:
        d = _feed_attr(config, side, "d_inlet", float("nan"))
        if np.isfinite(d) and d > 0.0:
            A = float(np.pi * (d / 2.0) ** 2)
        else:
            A = float(np.pi * (assume(f"stability.feed.{side}.d_inlet", 0.0127, unit="m",
                                      reason=f"feed_system.{side} has no bore") / 2.0) ** 2)
    return float(L), float(A)


@lru_cache(maxsize=64)
def _coolprop_bulk_modulus(canon: str, T: float, P: float) -> Optional[float]:
    """Isentropic bulk modulus ``rho a^2`` [Pa] from CoolProp at (T, P), or None.

    Cached on the rounded state: the value cannot change within a process, and PropsSI per
    candidate would be a real cost."""
    name = _COOLPROP_NAMES.get(canon)
    if not name:
        return None
    try:
        from CoolProp.CoolProp import PropsSI
        rho = float(PropsSI("D", "T", T, "P", P, name))
        a = float(PropsSI("A", "T", T, "P", P, name))
        v = rho * a * a
        return v if np.isfinite(v) and v > 0 else None
    except Exception:
        return None


def _liquid_bulk_modulus(config, key: str, P_line: float, record_name: str) -> float:
    """``fluids[key].bulk_modulus_pa``; else CoolProp rho*a^2 at the fluid temperature and line
    pressure; else a recorded generic value. LOX at 90 K / 4 MPa is 0.98 GPa, not the 1.5 GPa
    order-of-magnitude figure that used to stand in for it."""
    from engine.pipeline.assumptions import assume
    from engine.pipeline.io import _canon_fluid
    v = _fluid_attr(getattr(config, "fluids", None), key, "bulk_modulus_pa", None)
    if v is not None and v > 0:
        return float(v)
    name = _fluid_name(config, key)
    T = _fluid_attr(getattr(config, "fluids", None), key, "temperature", None)
    if T is not None and np.isfinite(P_line) and P_line > 0:
        k = _coolprop_bulk_modulus(_canon_fluid(name), round(float(T), 1), round(float(P_line), -4))
        if k is not None:
            return assume(record_name, k, unit="Pa",
                          reason=f"fluids.{key}.bulk_modulus_pa missing; CoolProp rho*a^2 for {name} "
                                 f"at {T:.0f} K, {P_line / 1e6:.2f} MPa")
    return assume(record_name, 1.5e9, unit="Pa",
                  reason=f"fluids.{key}.bulk_modulus_pa missing and no CoolProp state for {name!r}; "
                         f"generic liquid value -- set it in the config (measure via water-hammer test T5)")


#: Young's modulus assumed for a feed tube whose material the config does not name [Pa].
_TUBE_E_STAINLESS = 193.0e9    # 300-series stainless, room temperature (ASM handbook)


def _feed_wall(config, side: str) -> Tuple[Optional[float], Optional[float], str]:
    """(Young's modulus [Pa], wall [m], note) for the Korteweg wave-speed correction.

    The wall comes from a ``*_TUBE_035``-style ``line_size`` (0.035 in); a pipe/fitting size or a
    bare bore carries no wall, and the line is then treated as rigid (an upper bound on a) and
    said so. The tube material is not in the config, so E is a recorded assumption."""
    import re
    from engine.pipeline.assumptions import assume
    try:
        fs = config.feed_system
        f = fs[side] if isinstance(fs, dict) else getattr(fs, side)
        size = str(getattr(f, "line_size", "") or "")
    except Exception:
        size = ""
    m = re.search(r"_TUBE_(\d{3})$", size.upper())
    if not m:
        return None, None, "rigid wall assumed: feed_system line_size names no tube wall"
    e = int(m.group(1)) * 1e-3 * 0.0254
    E = assume(f"stability.feed.{side}.wall_modulus", _TUBE_E_STAINLESS, unit="Pa",
               reason="feed tube material not in the config; 300-series stainless steel assumed")
    return float(E), float(e), f"{size}: {e * 1e3:.3f} mm wall, E {E / 1e9:.0f} GPa"


def _chamber_dims(config, cg) -> Tuple[float, float]:
    """(L_chamber, D_chamber) [m]. The solved unified geometry first: its ``length`` is the total
    chamber length and its ``chamber_diameter`` is the cylindrical bore, which is what the transverse
    acoustic modes live in. Legacy configs fall back to ``chamber.length`` and the volume-mean
    diameter; anything still missing is a recorded assumption."""
    from engine.pipeline.assumptions import assume
    L = float(getattr(cg, "length", None) or 0.0)
    if L <= 0.0:
        L = float(getattr(getattr(config, "chamber", None), "length", None) or 0.0)
    if L <= 0.0:
        L = assume("stability.chamber.length", 0.18, unit="m", reason="no solved or configured chamber length")
    D = float(getattr(cg, "chamber_diameter", None) or 0.0)
    if D <= 0.0:
        V = float(getattr(cg, "volume", None) or 0.0)
        if V > 0.0 and L > 0.0:
            D = float(np.sqrt(4.0 * V / (np.pi * L)))
        else:
            D = assume("stability.chamber.diameter", 0.1, unit="m", reason="no chamber diameter or volume")
    return L, D


def _jet_geometry(config, diagnostics: Dict[str, Any], side: str) -> Tuple[float, float]:
    """(jet/post inner diameter [m], injection velocity [m/s]) for one stream.

    These are Leonardi eq. 6-7's ``D_l`` and ``u_l``. Both come from whichever injector the config
    actually names -- the solved closure diagnostics first (every injector model publishes ``u_O``/
    ``u_F``), then the injector's own geometry block. Returns NaN rather than a stand-in when the
    injector type carries no equivalent dimension; the lag model then drops the atomization term and
    records it, instead of inventing a jet.

    Impinging -> the jet diameter. Coaxial -> the core port (oxidizer) and the annulus hydraulic
    diameter (fuel), which is what L17 calls the liquid post. Pintle -> the tip orifice (oxidizer)
    and the annular gap's hydraulic diameter, 2*h_gap (fuel).
    """
    key = "O" if side == "oxidizer" else "F"
    u = diagnostics.get(f"u_{key}")
    u = float(u) if (u is not None and np.isfinite(float(u)) and float(u) > 0.0) else float("nan")

    d = diagnostics.get(f"d_jet_{key}")
    if d is not None and np.isfinite(float(d)) and float(d) > 0.0:
        return float(d), u

    inj = getattr(config, "injector", None)
    geom = getattr(inj, "geometry", None)
    itype = str(getattr(inj, "type", "") or "")
    try:
        if itype == "impinging":
            elem = geom.oxidizer if side == "oxidizer" else geom.fuel
            return float(elem.d_jet), u
        if itype == "coaxial":
            if side == "oxidizer":
                return float(geom.core.d_port), u
            # Annulus hydraulic diameter = 2 * gap (outer minus inner diameter).
            return float(2.0 * geom.annulus.gap_thickness), u
        if itype == "pintle":
            if side == "oxidizer":
                return float(geom.lox.d_orifice), u
            return float(2.0 * geom.fuel.h_gap), u
    except Exception:
        pass
    return float("nan"), u


def _stability_config(config) -> StabilityConfig:
    sc = getattr(config, "stability", None)
    return sc if isinstance(sc, StabilityConfig) else StabilityConfig()


def _feed_override(feed: Optional[Dict[str, Dict[str, float]]], side: str) -> Dict[str, float]:
    """The caller's feed impedance for one side (``feed[side]`` or ``feed["O"/"F"]``), validated.

    Only ``inertance`` [1/m] and ``dP_feed`` [Pa] are read. A value that is not a finite,
    non-negative number is refused rather than clipped: it would otherwise move the chug margin
    with nothing in the payload saying why."""
    if not feed:
        return {}
    key = "O" if side == "oxidizer" else "F"
    f = feed.get(side) or feed.get(key) or {}
    out: Dict[str, float] = {}
    for name in ("inertance", "dP_feed"):
        v = f.get(name)
        if v is None:
            continue
        v = float(v)
        if not np.isfinite(v) or v < 0.0:
            raise ValueError(f"feed[{side!r}][{name!r}] must be finite and >= 0, got {v!r}")
        out[name] = v
    return out


def build_stability_inputs(config, Pc: float, MR: float, mdot_total: float, cstar: float,
                           gamma: float, R: float, Tc: float, diagnostics: Dict[str, Any],
                           cg: Any, *, overrides: Optional[Dict[str, float]] = None,
                           feed: Optional[Dict[str, Dict[str, float]]] = None) -> Dict[str, Any]:
    """Extract chug/acoustic model inputs from config + diagnostics. Shared by the fast path
    (compute_physical_stability) and the rich report (report.py) so they use IDENTICAL extraction.
    [Phys §3.2, §4, §5]

    Sources, in order: solved geometry (``cg``), the closure diagnostics of this evaluation, the
    config (``fluids`` for the propellants, ``feed_system`` for the plumbing, ``stability`` for the
    model calibration), and finally recorded assumptions -- never a silent constant.

    ``feed`` (opt-in, default None = the config's plumbing, exactly as before): the feed impedance
    of each side stated by the caller, ``{"oxidizer"|"O": {"inertance": I [1/m], "dP_feed": dp [Pa]},
    "fuel"|"F": {...}}``. ``inertance`` replaces ``feed_system.<side>.length / A_hydraulic`` (the
    caller has summed L/A over the lines it knows, e.g. a P&ID drawing's); ``dP_feed`` replaces the
    closure's feed drop as the steady drop the linearised resistance ``R = 2 dp / mdot`` is taken
    from, *whole*: the ``supply_K`` share is not subtracted from it, because the caller's drop runs
    from the tank outlet and the supply is upstream of the tank. Either key may be given alone.
    """
    from engine.pipeline.stability import core, chug, acoustic, timelag
    from engine.pipeline.assumptions import assume

    sc = _stability_config(config)
    A_t = float(cg.A_throat)
    V_c = float(cg.volume)
    Lstar = V_c / A_t if A_t > 0 else float(getattr(cg, "Lstar", 0.8))
    L_ch, D_ch = _chamber_dims(config, cg)
    A_c = float(np.pi * (D_ch / 2.0) ** 2)
    contraction_ratio = A_c / A_t if A_t > 0 else float("nan")

    # Hot-gas transport properties: the same ones the thermal model uses (regen_cooling block is the
    # engine's hot-gas property record, regardless of whether regen is enabled).
    rc = getattr(config, "regen_cooling", None)
    k_g = float(getattr(rc, "hot_gas_thermal_conductivity", 0.0) or 0.0) if rc is not None else 0.0
    if k_g <= 0.0:
        k_g = assume("stability.hot_gas_thermal_conductivity", DEFAULT_HOT_GAS_THERMAL_COND_W_M_K,
                     unit="W/(m*K)", reason="regen_cooling.hot_gas_thermal_conductivity not set")
    mu_g = float(getattr(rc, "hot_gas_viscosity", 0.0) or 0.0) if rc is not None else 0.0
    if mu_g <= 0.0:
        mu_g = assume("stability.hot_gas_viscosity", DEFAULT_HOT_GAS_VISC_PA_S,
                      unit="Pa*s", reason="regen_cooling.hot_gas_viscosity not set")
    # Product-gas cp from the CEA state of THIS evaluation (gamma, R). This used to read a fixed
    # regen_cooling.hot_gas_cp = 2200 J/(kg*K) for every propellant.
    cp_g = gamma * R / (gamma - 1.0)
    rho_g = Pc / (R * Tc) if (R > 0 and Tc > 0) else 2.0
    nu_g = mu_g / rho_g if rho_g > 0 else 2.0e-5
    Pr_g = mu_g * cp_g / k_g if k_g > 0 else float("nan")   # Kirchhoff thermal layer
    a_snd = core.sound_speed(gamma, R, Tc)

    mdot_O = float(diagnostics.get("mdot_O") or mdot_total * MR / (1.0 + MR))
    mdot_F = float(diagnostics.get("mdot_F") or mdot_total / (1.0 + MR))

    def _drop(key: str, frac: float, what: str, effect: str) -> float:
        # A published 0.0 is a real zero-stiffness injector, not a missing value; only an absent or
        # non-finite key falls back, and the fallback is recorded (coaxial publishes none today).
        v = diagnostics.get(key)
        if v is not None and np.isfinite(float(v)):
            return float(v)
        return assume(f"stability.{key}", frac * Pc, unit="Pa",
                      reason=f"closure diagnostics carry no {key}; {what} taken as {frac:.2f}*Pc, "
                             f"so {effect}")

    _inj = "the chug margin does not depend on this injector at all"
    _feed = "the linearised feed resistance is a placeholder"
    dpiO = _drop("delta_p_injector_O", 0.30, "oxidizer injector drop", _inj)
    dpiF = _drop("delta_p_injector_F", 0.30, "fuel injector drop", _inj)
    dpfO = _drop("delta_p_feed_O", 0.10, "oxidizer feed drop", _feed)
    dpfF = _drop("delta_p_feed_F", 0.10, "fuel feed drop", _feed)
    # SMD comes from whichever spray model the config's injector selected (Ingebo for impinging,
    # Lefebvre for coaxial, the sheet model for pintle) -- this layer must never pick one. When the
    # closure did not produce one, the substitution is recorded rather than silently applied; it was
    # a bare 80/60 um, i.e. a LOX/methane impinging spray asserted for every engine.
    D32_O = diagnostics.get("D32_O")
    if D32_O is None or not np.isfinite(float(D32_O)) or float(D32_O) <= 0.0:
        D32_O = assume("stability.D32_oxidizer", 80e-6, unit="m",
                       reason="closure produced no oxidizer SMD; order-of-magnitude liquid-oxidizer "
                              "spray. The chug lag scales as SMD^2, so this is a large lever")
    D32_O = float(D32_O)
    D32_F = diagnostics.get("D32_F")
    if D32_F is None or not np.isfinite(float(D32_F)) or float(D32_F) <= 0.0:
        D32_F = assume("stability.D32_fuel", 60e-6, unit="m",
                       reason="closure produced no fuel SMD; order-of-magnitude liquid-fuel spray")
    D32_F = float(D32_F)
    ov = overrides or {}
    # The SMD sliders. `smd_um` has always meant the OXIDIZER spray and keeps that meaning for
    # back-compatibility; `smd_F_um` was missing entirely, so on an engine whose FUEL is the
    # rate-limiting vaporizer (LOX/ethanol 6500 N: tau_F 5.7 ms vs tau_O 3.1 ms) the atomization
    # slider could not move the quantity that sets the lag.
    if ov.get("smd_um") is not None:
        D32_O = float(ov["smd_um"]) * 1e-6
    if ov.get("smd_F_um") is not None:
        D32_F = float(ov["smd_F_um"]) * 1e-6
    if ov.get("eta_inj_O") is not None:
        eta_O = float(ov["eta_inj_O"])
        dpiO = eta_O * Pc
    else:
        eta_O = dpiO / Pc if Pc > 0 else 0.3
    if ov.get("eta_inj_F") is not None:
        eta_F = float(ov["eta_inj_F"])
        dpiF = eta_F * Pc
    else:
        eta_F = dpiF / Pc if Pc > 0 else 0.3

    rho_O = _fluid_thermo(config, "oxidizer", "density")
    rho_F = _fluid_thermo(config, "fuel", "density")
    hfg_O = _fluid_thermo(config, "oxidizer", "latent_heat")
    hfg_F = _fluid_thermo(config, "fuel", "latent_heat")
    tbO = _fluid_thermo(config, "oxidizer", "boiling_point")
    tbF = _fluid_thermo(config, "fuel", "boiling_point")
    _P_line_O = diagnostics.get("P_tank_O")
    _P_line_O = float(_P_line_O) if _P_line_O is not None else Pc + dpiO + dpfO
    K_bulk_O = _liquid_bulk_modulus(config, "oxidizer", _P_line_O, "stability.fluids.oxidizer.bulk_modulus_pa")
    tcrO = _fluid_thermo(config, "oxidizer", "critical_temperature")
    tcrF = _fluid_thermo(config, "fuel", "critical_temperature")
    muO = _fluid_attr(config.fluids, "oxidizer", "viscosity", float("nan"))
    muF = _fluid_attr(config.fluids, "fuel", "viscosity", float("nan"))
    sigO = _fluid_attr(config.fluids, "oxidizer", "surface_tension", float("nan"))
    sigF = _fluid_attr(config.fluids, "fuel", "surface_tension", float("nan"))
    phaseO = _injection_phase(config, "oxidizer")
    phaseF = _injection_phase(config, "fuel")
    d_jet_O, u_inj_O = _jet_geometry(config, diagnostics, "oxidizer")
    d_jet_F, u_inj_F = _jet_geometry(config, diagnostics, "fuel")

    # Mean axial gas velocity in the chamber -- the ``u_g`` of the atomization Weber number.
    u_gas = float(mdot_total / (rho_g * A_c)) if (rho_g > 0 and A_c > 0) else float("nan")

    lag_streams = {
        "O": timelag.StreamThermo(
            name=_fluid_name(config, "oxidizer") or "oxidizer", phase=phaseO,
            rho_l=rho_O, mu_l=muO, sigma_l=sigO, T_boil=tbO, T_crit=tcrO, h_fg=hfg_O,
            D0=D32_O, u_inj=u_inj_O, d_orifice=d_jet_O),
        "F": timelag.StreamThermo(
            name=_fluid_name(config, "fuel") or "fuel", phase=phaseF,
            rho_l=rho_F, mu_l=muF, sigma_l=sigF, T_boil=tbF, T_crit=tcrF, h_fg=hfg_F,
            D0=D32_F, u_inj=u_inj_F, d_orifice=d_jet_F),
    }
    lag_chamber = timelag.ChamberThermo(Pc=Pc, Tc=Tc, MR=MR, rho_g=rho_g, u_g=u_gas,
                                        k_g=k_g, cp_g=cp_g)
    # `or` rather than a dict default: an override dict that carries the key with a None value
    # (a caller passing model_dump() unfiltered) must fall back to the config, not stringify None
    # into a model name the registry will reject.
    lag_model = str(ov.get("time_lag_model") or sc.time_lag_model)
    convection = str(ov.get("convection_model") or sc.convection_model)
    # The d^2-law is the historical model; it never carried a mixing lag, so selecting it must not
    # introduce one. Gate on the model having something to do, not merely on the field being set.
    mix_fraction = float(sc.mixing_lag_fraction) if lag_model == "leonardi_dtl" else 0.0
    if ov.get("mixing_lag_fraction") is not None:
        mix_fraction = float(ov["mixing_lag_fraction"])   # 0.0 is meaningful here, so test for None
    lags = timelag.compute_lags(
        lag_streams, lag_chamber, model=lag_model, mix_fraction=mix_fraction,
        convection=convection,
        on_fallback=lambda name, value, unit, reason: assume(name, value, unit=unit, reason=reason),
    )
    tau_conv_O = float(lags["O"].tau_total)
    tau_conv_F = float(lags["F"].tau_total)
    # The mixing lag is mix_fraction x this (compute_lags: slowest liquid tau_vap). Kept so the
    # chug margin can be taken over the unmeasured mixing-fraction band without re-running the lags.
    _vap = [lags[k].tau_vap for k in ("O", "F")
            if not lag_streams[k].is_gas and np.isfinite(lags[k].tau_vap) and lags[k].tau_vap > 0]
    tau_mix_basis = float(max(_vap)) if _vap else 0.0
    K_v_O, K_v_F = float(lags["O"].K_v), float(lags["F"].K_v)
    if not np.isfinite(tau_conv_O) or tau_conv_O <= 0.0:
        tau_conv_O = assume("stability.tau_conv_O", 2.0e-3, unit="s",
                            reason=f"{lag_model} oxidizer lag non-finite (check T_boil < Tc, h_fg, SMD)")
    if not np.isfinite(tau_conv_F) or tau_conv_F <= 0.0:
        tau_conv_F = assume("stability.tau_conv_F", 1.5e-3, unit="s",
                            reason=f"{lag_model} fuel lag non-finite (check T_boil < Tc, h_fg, SMD)")

    L_feed_O, A_feed_O = _feed_geometry(config, "oxidizer")
    L_feed_F, A_feed_F = _feed_geometry(config, "fuel")
    reg_kw = dict(enabled=bool(sc.regulator_enabled), corner_hz=float(sc.regulator_corner_hz),
                  Z_hf=float(sc.regulator_Z_hf), max_excursion_pa=float(sc.regulator_max_excursion_psi) * 6894.757)
    # The supply's share of the lumped feed loss (feed_system.<side>.supply_K): it sets the inlet
    # pressure above, but it is the regulator and ullage at chug frequencies, which the Regulator
    # model below carries. Counting it again as line resistance raised the gain margin (1.51 ->
    # 1.57 on the 6.8 kN stand fit), in the unsafe direction. Zero by default: K0 all line.
    dpfO = _chug_feed_drop(config, "oxidizer", dpfO, mdot_O, rho_O)
    dpfF = _chug_feed_drop(config, "fuel", dpfF, mdot_F, rho_F)
    # The caller's feed impedance (opt-in). The equivalent length is I * A on the config's own area,
    # so ChugStream.inertance() = length/area returns the caller's I and nothing else in the stream
    # changes. Without ``feed`` none of this runs and the streams are exactly the config's.
    feed_basis = "config"
    ovO, ovF = _feed_override(feed, "oxidizer"), _feed_override(feed, "fuel")
    if ovO or ovF:
        feed_basis = "caller"
        if "inertance" in ovO:
            L_feed_O = ovO["inertance"] * A_feed_O
        if "inertance" in ovF:
            L_feed_F = ovF["inertance"] * A_feed_F
        if "dP_feed" in ovO:
            dpfO = ovO["dP_feed"]
        if "dP_feed" in ovF:
            dpfF = ovF["dP_feed"]
    streams = [
        chug.ChugStream("O", mdot=mdot_O, eta_inj=max(eta_O, 1e-3), Pc=Pc, dP_feed=dpfO,
                        feed_length=L_feed_O, feed_area=A_feed_O, tau_conv=tau_conv_O,
                        regulator=chug.Regulator(**reg_kw)),
        chug.ChugStream("F", mdot=mdot_F, eta_inj=max(eta_F, 1e-3), Pc=Pc, dP_feed=dpfF,
                        feed_length=L_feed_F, feed_area=A_feed_F, tau_conv=tau_conv_F,
                        regulator=chug.Regulator(**reg_kw)),
    ]
    # theta_c from the chamber state (R, Tc) the rest of this model uses -- rho_g above -- with the
    # delivered c*. The Gamma-form assumed RT = (Gamma c*_act)^2 and ran ~10 % long.
    chamber = chug.ChugChamber(cstar=cstar, A_t=A_t, Lstar=Lstar, gamma=gamma,
                               R_gas=float(R) if R > 0 else None, T_c=float(Tc) if Tc > 0 else None)
    # Mixing-lag band the chug gate must hold over. Only the double-time-lag model has a mixing lag.
    _band_lo = getattr(sc, "chug_band_mixing_lag_fraction_min", 0.0)
    _band_hi = getattr(sc, "chug_band_mixing_lag_fraction_max", 1.0)
    chug_band = None
    if (lag_model == "leonardi_dtl" and tau_mix_basis > 0 and _band_lo is not None and _band_hi is not None
            and ov.get("mixing_lag_fraction") is None):
        chug_band = (float(min(_band_lo, _band_hi)), float(max(_band_lo, _band_hi)))
    chi_ac = float(ov.get("chi_acoustic", sc.chi_acoustic))
    n_int = float(ov.get("n_interaction", sc.n_interaction))
    # Sensitive lag for the acoustic n-tau driving. The rate-limiting stream is whichever LIQUID
    # stream converts slowest -- not "the oxidizer" (this read tau_conv_O unconditionally, which is
    # only right when the oxidizer happens to be both liquid and slower; on a gas/liquid pair such as
    # GOX/ethanol it priced the acoustic driving off a stream that has no droplets at all).
    # Uses the POST-fallback lags: a liquid stream whose lag was non-finite and got substituted is
    # still a liquid stream and still competes to be the rate-limiting one.
    _liquid_taus = [tau for k, tau in (("O", tau_conv_O), ("F", tau_conv_F))
                    if not lag_streams[k].is_gas and np.isfinite(tau) and tau > 0]
    tau_rate_limiting = max(_liquid_taus) if _liquid_taus else max(tau_conv_O, tau_conv_F)
    tau_sens = chi_ac * tau_rate_limiting      # [Phys §5]

    # Nozzle-entrance Mach sets the convective (nozzle) damping. Config value if given, else the
    # subsonic isentropic solution for the actual contraction ratio (a fixed 0.2 corresponds to a
    # contraction ratio of ~2.9 and overstated nozzle damping for every wider chamber).
    M_ne = sc.mach_nozzle_entrance
    if M_ne is None:
        M_ne = core.mach_from_area_ratio_subsonic(contraction_ratio, gamma) if np.isfinite(contraction_ratio) else float("nan")
        if not np.isfinite(M_ne) or M_ne <= 0.0:
            M_ne = assume("stability.mach_nozzle_entrance", 0.2, unit="-",
                          reason="contraction ratio unavailable for the isentropic solve")
    gas = acoustic.GasState(gamma=gamma, a_sound=a_snd, nu_g=nu_g, mach_nozzle_entrance=float(M_ne),
                            prandtl=float(Pr_g) if np.isfinite(Pr_g) and Pr_g > 0 else None)
    acoustic_gate = str(getattr(sc, "acoustic_gate", "report_only") or "report_only")
    if acoustic_gate not in ACOUSTIC_GATE_MODES:
        raise ValueError(f"stability.acoustic_gate {acoustic_gate!r}; known: {ACOUSTIC_GATE_MODES}")
    coeffs = acoustic.DampingCoeffs(injector_frac=float(sc.damping_injector_frac),
                                    twophase_frac=float(sc.damping_twophase_frac),
                                    droplet_loading=float(sc.droplet_loading))

    return {
        "streams": streams, "chamber": chamber, "gas": gas, "damping_coeffs": coeffs,
        "acoustic_gate": acoustic_gate,
        "chug_band": chug_band, "tau_mix_basis": tau_mix_basis,
        "dP_feed_O": dpfO, "dP_feed_F": dpfF, "dP_inj_O": dpiO, "dP_inj_F": dpiF,
        "mdot_O": mdot_O, "mdot_F": mdot_F, "prandtl_g": float(Pr_g),
        "D_ch": D_ch, "L_ch": L_ch, "Lstar": Lstar, "contraction_ratio": contraction_ratio,
        "mach_nozzle_entrance": float(M_ne),
        "tau_conv_O": tau_conv_O, "tau_conv_F": tau_conv_F, "tau_sens": tau_sens,
        "tau_rate_limiting": float(tau_rate_limiting),
        "lag_model": lag_model, "convection_model": convection, "mixing_lag_fraction": mix_fraction,
        "lag_breakdown": {k: v.as_dict() for k, v in lags.items()},
        "phase_O": phaseO, "phase_F": phaseF,
        "fluid_name_O": _fluid_name(config, "oxidizer") or "oxidizer",
        "fluid_name_F": _fluid_name(config, "fuel") or "fuel",
        "injector_type": str(getattr(getattr(config, "injector", None), "type", "") or "unknown"),
        "d_jet_O": d_jet_O, "d_jet_F": d_jet_F, "u_inj_O": u_inj_O, "u_inj_F": u_inj_F,
        "chi_acoustic": chi_ac, "n_interaction": n_int,
        "eta_inj_O": eta_O, "eta_inj_F": eta_F,
        "D32_O": D32_O, "D32_F": D32_F, "K_v_O": K_v_O, "K_v_F": K_v_F,
        "rho_O": rho_O, "rho_F": rho_F, "K_bulk_O": K_bulk_O,
        "feed_length_O": L_feed_O, "feed_length_F": L_feed_F,
        # "config" (the config's plumbing) or "caller" (``feed`` restated it, opt-in).
        "feed_basis": feed_basis,
        "u_O": diagnostics.get("u_O"), "Cd_O": diagnostics.get("Cd_O"),
        "u_F": diagnostics.get("u_F"), "Cd_F": diagnostics.get("Cd_F"),
        # Which stream actually paces the burn. Everything that reports "the" vaporization length,
        # "the" lag or "the" SMD has to follow this, not the oxidizer by position.
        "rate_limiting_stream": ("O" if (np.isfinite(tau_conv_O) and tau_conv_O >= tau_conv_F)
                                 else "F"),
        "Pc": Pc, "wh_pressure_pa": None,
    }


def _chug_fast(streams, chamber) -> Dict[str, Any]:
    """Fast chug margin through the compiled kernel when the accelerator is on, else Python."""
    from engine.pipeline.stability import chug
    from engine import accel
    if accel.enabled():
        try:
            # attribute access, not a direct import -- see the note in
            # tests/test_accel_is_actually_used.py
            return accel.chug_margin_fast(streams, chamber)
        except Exception:
            pass
    return chug.chug_margin_fast(streams, chamber)


def chug_band(inp: Dict[str, Any], nominal_gm: float, n_pts: int = 5) -> Optional[Dict[str, Any]]:
    """Chug gain margin over the unmeasured mixing-lag fraction band ``inp["chug_band"]``.

    tau_mix = f * tau_mix_basis is shared by both streams, so moving f shifts every stream's
    lag by (f - f_nominal) * basis. GM is not monotone in the lag in general, so the band is
    sampled rather than read off its ends. None when there is no band (d^2-law, or a fixed
    override)."""
    import copy
    band = inp.get("chug_band")
    if not band:
        return None
    f0 = float(inp["mixing_lag_fraction"])
    basis = float(inp["tau_mix_basis"])
    fracs = [float(f) for f in np.linspace(band[0], band[1], n_pts)]
    gms = []
    for f in fracs:
        if abs(f - f0) < 1e-12:
            gms.append(float(nominal_gm))
            continue
        st = []
        for s0 in inp["streams"]:
            s1 = copy.copy(s0)
            s1.tau_conv = max(float(s0.tau_conv) + (f - f0) * basis, 0.0)
            st.append(s1)
        gms.append(float(_chug_fast(st, inp["chamber"]).get("gain_margin", float("nan"))))
    all_gm = gms + [float(nominal_gm)]
    finite = [g for g in all_gm if np.isfinite(g)]
    k_min = int(np.nanargmin(gms)) if any(np.isfinite(gms)) else 0
    return {
        "parameter": "mixing_lag_fraction",
        "range": [float(band[0]), float(band[1])],
        "fractions": fracs, "gain_margins": gms,
        "min": float(min(finite)) if len(finite) == len(all_gm) else float("nan"),
        "max": float(max(finite)) if finite else float("nan"),
        "at_min_fraction": fracs[k_min],
        "nominal_fraction": f0,
    }


def _chug_feed_drop(config: Any, side: str, dp_feed: float, mdot: float, rho: float) -> float:
    """The feed drop the chug loop sees as resistance: the line's, without the supply's share."""
    fs = (getattr(config, "feed_system", None) or {}).get(side)
    k_supply = float(getattr(fs, "supply_K", 0.0) or 0.0) if fs is not None else 0.0
    area = float(getattr(fs, "A_hydraulic", 0.0) or 0.0) if fs is not None else 0.0
    if k_supply <= 0.0 or area <= 0.0 or rho <= 0.0 or not np.isfinite(dp_feed):
        return dp_feed
    supply = k_supply * mdot * mdot / (2.0 * rho * area * area)
    return max(dp_feed - supply, 0.0)


def compute_physical_stability(config, Pc: float, MR: float, mdot_total: float, cstar: float,
                               gamma: float, R: float, Tc: float, diagnostics: Dict[str, Any],
                               cg: Any) -> Optional[Dict[str, Any]]:
    """Build inputs and run the FAST tiers (per-eval path). [Phys §3.2 fast, §4.2 fast; plan A4]

    ``chug_gate_margin`` is the Nyquist GM at the low end of the mixing-lag band (the nominal GM
    when there is no band); ``acoustic_gate_margin`` is damping/driving per ``stability.acoustic_gate``,
    +inf when the acoustic model is report-only. Both are 1 at neutral stability.
    """
    from engine.pipeline.stability import acoustic
    inp = build_stability_inputs(config, Pc, MR, mdot_total, cstar, gamma, R, Tc, diagnostics, cg)
    # Accelerated fast path: the 200-pt complex chug sweep is the dominant per-eval stability cost.
    chug_fast = _chug_fast(inp["streams"], inp["chamber"])
    gm = float(chug_fast.get("gain_margin", float("nan")))
    band = chug_band(inp, gm)
    chug_gate = band["min"] if band is not None else gm

    # fast_acoustic stays pure Python on purpose: 10.5 us here vs 4.2 us in C, and
    # acoustic.fast_acoustic is two mode_growth_rate calls with no loop. A ~6 us
    # difference does not earn a kernel. (The chug sweep did: 200 complex points,
    # measured at ~8.8% of Layer-1 wall time when left unaccelerated.)
    ac_fast = acoustic.fast_acoustic(inp["D_ch"], inp["L_ch"], inp["gas"],
                                     n=inp["n_interaction"], tau_sens=inp["tau_sens"],
                                     coeffs=inp["damping_coeffs"])
    mode = inp["acoustic_gate"]
    if mode == "nominal_phase":
        ac_gate = float(ac_fast["margin"])
    elif mode == "worst_phase":
        ac_gate = float(ac_fast["margin_worst_phase"])
    else:
        ac_gate = float("inf")

    return {
        "chug": chug_fast,
        "chug_band": band,
        "acoustic": ac_fast,
        "acoustic_gate": mode,
        "chug_gate_margin": float(chug_gate),
        "acoustic_gate_margin": ac_gate,
        "f_chug_hz": chug_fast.get("f_chug_hz"),
        "tau_conv_O": inp["tau_conv_O"], "tau_conv_F": inp["tau_conv_F"], "tau_sens": inp["tau_sens"],
        "eta_inj_O": inp["eta_inj_O"], "eta_inj_F": inp["eta_inj_F"], "D_ch": inp["D_ch"], "L_ch": inp["L_ch"],
        "mach_nozzle_entrance": inp["mach_nozzle_entrance"],
        "inputs": inp,
    }


# ---------------------------------------------------------------------------
# Comprehensive stability analysis
# ---------------------------------------------------------------------------

def comprehensive_stability_analysis(
    config: PintleEngineConfig,
    Pc: float,
    MR: float,
    mdot_total: float,
    cstar: float,
    gamma: float,
    R: float,
    Tc: float,
    diagnostics: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Comprehensive stability analysis combining combustion, acoustic, and feed system.

    Returns
    -------
    dict with keys
        - stability_state: "stable", "marginal", "unstable", or "unknown" (model not evaluable;
          never passes a gate)
        - stability_score: display map of the limiting gate margin, see ``stability_score``
        - is_stable: backward compatibility boolean
        - chugging: frequencies, ``stability_margin`` (gate: GM at the low end of the mixing-lag
          band), ``chug_gain_margin`` (nominal GM), ``chug_gain_margin_db``, ``chug_gm_band``
        - acoustic: mode frequencies, ``stability_margin`` (gate; +inf when report-only),
          ``gate_status``, nominal and worst-phase margins
        - feed_system: oxidizer-line acoustics (legacy top level) and ``feed_lines`` for both
        - mode_coupling: list of potentially coupled mode pairs
        - issues, recommendations, Lstar
    """
    from engine.pipeline.config_schemas import ensure_chamber_geometry
    cg = ensure_chamber_geometry(config)
    V_chamber = float(cg.volume)
    A_throat = float(cg.A_throat)
    Lstar = V_chamber / A_throat if A_throat > 0.0 else cg.Lstar
    L_chamber, D_chamber = _chamber_dims(config, cg)

    chugging = calculate_chugging_frequency(
        chamber_volume=V_chamber, throat_area=A_throat, cstar=cstar, gamma=gamma, Pc=Pc, R=R, Tc=Tc,
    )
    acoustic_raw = calculate_acoustic_modes(
        chamber_length=L_chamber, chamber_diameter=D_chamber, gas_temperature=Tc, gamma=gamma, R=R,
    )

    issues: List[str] = []

    # -------------------------------------------------------------------
    # Physical margins
    # -------------------------------------------------------------------
    phys = None
    phys_error = None
    try:
        phys = compute_physical_stability(config, Pc, MR, mdot_total, cstar, gamma, R, Tc, diagnostics, cg)
    except Exception as exc:   # never fail the eval on a stability-model error -- but never pass it either
        phys = None
        phys_error = f"{type(exc).__name__}: {exc}"

    nan = float("nan")
    acoustic_gate_mode = "report_only"
    if phys is not None:
        chug_gm = float(phys["chug"].get("gain_margin", nan))
        chug_margin = float(phys["chug_gate_margin"])
        acoustic_margin = float(phys["acoustic_gate_margin"])
        acoustic_gate_mode = phys["acoustic_gate"]
        _fch = phys.get("f_chug_hz")
        if _fch is not None and np.isfinite(_fch) and _fch > 0:
            chugging["frequency"] = float(_fch)        # physical chug freq, not L*/c* placeholder
        band = phys.get("chug_band")
        chugging["chug_gm_band"] = band
        if chug_gm <= 1.0:
            issues.append(f"Chug (feed-coupled LF) loop predicted unstable: gain margin {chug_gm:.2f} < 1 at "
                          f"the nominal mixing lag. Stiffen the injector or improve atomization")
        elif band is not None and np.isfinite(band["min"]) and band["min"] <= 1.0:
            issues.append(f"Chug gain margin {chug_gm:.2f} at the nominal mixing lag, but {band['min']:.2f} "
                          f"at mixing_lag_fraction {band['at_min_fraction']:.2f}: the verdict hangs on an "
                          f"unmeasured lag")
        if acoustic_gate_mode != "report_only" and not phys["acoustic"].get("stable", True):
            issues.append(f"Acoustic mode {phys['acoustic'].get('limiting_mode')} driven (alpha>0)")
    else:
        chug_gm = chug_margin = acoustic_margin = nan
        issues.append("Stability model could not be evaluated for this point"
                      + (f" ({phys_error})" if phys_error else "") + "; state 'unknown' fails every gate")
    chugging["stability_margin"] = chug_margin
    chugging["chug_gain_margin"] = chug_gm
    chugging["chug_gain_margin_db"] = gain_margin_db(chug_gm)
    if acoustic_gate_mode == "report_only":
        issues.append("High-frequency (acoustic) stability is not assessed a priori: the damping budget is "
                      "uncalibrated, so the modes are reported, not gated. Rate it by test "
                      "(>= 25 kHz Pc, pulse/bomb; Harrje & Reardon SP-194)")

    # -------------------------------------------------------------------
    # Feed-line acoustics, both lines
    # -------------------------------------------------------------------
    inp = phys.get("inputs") if phys is not None else None
    feed_lines: Dict[str, Dict[str, Any]] = {}
    for side, key in (("oxidizer", "O"), ("fuel", "F")):
        L_line, A_line = _feed_geometry(config, side)
        d_line = float(np.sqrt(4.0 * A_line / np.pi))
        rho = _fluid_thermo(config, side, "density")
        mdot_k = diagnostics.get(f"mdot_{key}")
        if mdot_k is None:
            mdot_k = mdot_total * (MR if key == "O" else 1.0) / (1.0 + MR)
        P_line = diagnostics.get(f"P_tank_{key}")
        if P_line is None:
            P_line = Pc + (inp[f"dP_inj_{key}"] + inp[f"dP_feed_{key}"] if inp is not None else 0.0)
        K = _liquid_bulk_modulus(config, side, float(P_line), f"stability.feed.bulk_modulus_{key}")
        E_wall, e_wall, wall_note = _feed_wall(config, side)
        v_line = float(mdot_k) / (rho * A_line) if A_line > 0.0 and rho > 0 else 0.0
        line = analyze_feed_system_stability(
            feed_line_length=L_line, feed_line_diameter=d_line, propellant_density=rho,
            bulk_modulus=K, flow_velocity=v_line,
            wall_modulus_pa=E_wall, wall_thickness_m=e_wall, valve_closure_time_s=None,
        )
        line.update({"length_m": float(L_line), "bore_m": d_line, "bulk_modulus_pa": float(K),
                     "line_velocity_m_s": v_line, "wall": wall_note})
        feed_lines[side] = line
    # Top level stays the oxidizer line, which is what older readers expect.
    feed_stability: Dict[str, Any] = dict(feed_lines["oxidizer"])
    feed_stability["feed_lines"] = feed_lines
    # Feed-coupled instability IS chug; Layer 1 still reads this key (and so counts chug twice).
    feed_stability["stability_margin"] = chug_margin

    # Build acoustic mode dictionary
    acoustic_modes_dict: Dict[str, float] = {}
    for i, freq in enumerate(acoustic_raw["longitudinal_modes"]):
        acoustic_modes_dict[f"L{i+1}"] = freq
    for i, freq in enumerate(acoustic_raw["transverse_modes"]):
        acoustic_modes_dict[f"T{i+1}"] = freq

    # -------------------------------------------------------------------
    # Mode coupling (reporting only: a 10 % frequency proximity note, it gates nothing)
    # -------------------------------------------------------------------
    modes: List[Dict[str, Any]] = []
    if phys is not None and np.isfinite(chugging["frequency"]):
        modes.append({"name": "chugging", "type": "combustion", "frequency": chugging["frequency"]})
    for side, key in (("oxidizer", "O"), ("fuel", "F")):
        modes.append({"name": f"pogo_{key}", "type": "feed", "frequency": feed_lines[side]["pogo_frequency"]})
        modes.append({"name": f"surge_{key}", "type": "feed", "frequency": feed_lines[side]["surge_frequency"]})
    for i, f in enumerate(acoustic_raw["longitudinal_modes"][:3]):
        modes.append({"name": f"L{i+1}", "type": "acoustic_long", "frequency": f})
    for i, f in enumerate(acoustic_raw["transverse_modes"][:2]):
        modes.append({"name": f"T{i+1}", "type": "acoustic_trans", "frequency": f})

    mode_coupling: List[Dict[str, Any]] = []
    coupling_tol_rel = 0.10
    for i in range(len(modes)):
        for j in range(i + 1, len(modes)):
            f1 = modes[i]["frequency"]
            f2 = modes[j]["frequency"]
            fmax = max(f1, f2)
            if fmax <= 0.0:
                continue
            rel_diff = abs(f1 - f2) / fmax
            if rel_diff < coupling_tol_rel:
                mode_coupling.append({
                    "mode_a": modes[i]["name"], "mode_b": modes[j]["name"],
                    "freq_a": float(f1), "freq_b": float(f2), "relative_difference": float(rel_diff),
                })
    if mode_coupling:
        issues.append("Potential mode coupling between combustion, acoustic, and feed system modes")

    if Lstar < 0.5 or Lstar > 3.0:
        issues.append(f"L* outside typical range (0.5 m to 3.0 m). Current L* = {Lstar:.2f} m")

    # -------------------------------------------------------------------
    # Classification
    # -------------------------------------------------------------------
    acoustic_gated = acoustic_gate_mode != "report_only"
    requirement = _stability_requirement(config)
    if phys is None:
        stability_state = "unknown"
    else:
        stability_state = classify_stability(
            chug_gm, chug_margin, acoustic_margin,
            float(phys["acoustic"].get("alpha_max", nan)), acoustic_gated, requirement)
    gated_margins = [chug_margin] + ([acoustic_margin] if acoustic_gated else [])
    min_margin = float(min(gated_margins)) if all(np.isfinite(m) for m in gated_margins) else nan
    score = stability_score(min_margin) if stability_state != "unknown" else 0.0

    recommendations = _generate_stability_recommendations(
        stability_state=stability_state, chugging=chugging, acoustic=acoustic_raw,
        feed_system=feed_stability, mode_coupling=mode_coupling, Lstar=Lstar,
    )

    acoustic = {
        **acoustic_raw,
        "modes": acoustic_modes_dict,
        "stability_margin": float(acoustic_margin),
        "gate_status": acoustic_gate_mode,
    }
    if phys is not None:
        ac = phys["acoustic"]
        acoustic["alpha_max"] = ac.get("alpha_max")
        acoustic["limiting_mode"] = ac.get("limiting_mode")
        acoustic["margin_nominal_phase"] = ac.get("margin")
        acoustic["margin_nominal_phase_mode"] = ac.get("margin_mode")
        acoustic["margin_worst_phase"] = ac.get("margin_worst_phase")
        acoustic["margin_worst_phase_mode"] = ac.get("worst_phase_mode")

    return {
        "stability_state": stability_state,
        "stability_score": score,
        "stability_requirement": requirement,
        "is_stable": stability_state == "stable",  # Backward compatibility
        "chugging": chugging,
        "acoustic": acoustic,
        "feed_system": feed_stability,
        "mode_coupling": mode_coupling,
        "Lstar": Lstar,
        "issues": issues,
        "recommendations": recommendations,
    }


def _generate_stability_recommendations(
    stability_state: str,
    chugging: Dict[str, float],
    acoustic: Dict[str, Any],
    feed_system: Dict[str, float],
    mode_coupling: List[Dict[str, Any]],
    Lstar: float,
) -> List[str]:
    """Generate stability improvement recommendations based on analysis."""
    recs: List[str] = []

    if stability_state == "unknown":
        recs.append("The stability model could not be evaluated at this point; treat it as unassessed.")
    elif stability_state == "unstable":
        recs.append("High risk of instability at this operating point. Consider design changes before test.")
    elif stability_state == "marginal":
        recs.append("Stability margin is limited. Plan to instrument heavily and ramp up cautiously in testing.")
    else:
        recs.append("System appears reasonably stable for this point. Still monitor during hot fire.")

    # Chug: gate margin of the feed-coupled loop (>1 stable). A thin margin is one under 6 dB
    # (GM 2), the usual floor for a feedback loop.
    gm = chugging.get("stability_margin")
    if gm is not None and np.isfinite(gm) and gm < 2.0:
        recs.append("Chug gain margin is thin: stiffen the injector (raise dP_inj/Pc), shorten the "
                    "combustion lag (finer SMD), or add feed-line inertance or resistance.")
        # Baffles and acoustic liners damp chamber acoustic modes; they do nothing for chug, a
        # bulk mode whose loop runs through the feed. (This used to follow every chug warning.)

    if not np.isfinite(chugging["frequency"]):
        pass
    elif chugging["frequency"] < 10.0:
        recs.append("Very low chugging frequency. Check for strong coupling to vehicle or feed system modes.")
    elif chugging["frequency"] > 400.0:
        recs.append("High chugging frequency. Check sensor bandwidth and structure response in that band.")

    # L* tuning
    if Lstar < 0.5:
        recs.append("L* is quite short. Consider increasing chamber length or volume to improve stability and performance.")
    elif Lstar > 3.0:
        recs.append("L* is quite long. This can add mass and potentially introduce higher order acoustic issues.")

    # Mode coupling
    for pair in mode_coupling:
        recs.append(
            f"Potential mode coupling: {pair['mode_a']} at {pair['freq_a']:.1f} Hz "
            f"and {pair['mode_b']} at {pair['freq_b']:.1f} Hz differ by "
            f"{pair['relative_difference'] * 100:.1f} percent."
        )
        recs.append("Consider shifting one of these frequencies by adjusting geometry or feed system properties.")

    if not recs:
        recs.append("No obvious stability issues detected. Still validate with test data.")

    return recs
