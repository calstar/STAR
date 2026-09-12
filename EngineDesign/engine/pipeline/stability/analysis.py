"""Stability analysis for combustion and feed system dynamics.

This module provides:

1. Combustion stability analysis (chugging, acoustic modes)

2. Feed system stability (POGO, surge, water hammer)

3. Overall stability classification at a given operating point

All "margins" and "scores" here are heuristic indicators intended for

pre-test design guidance, not a substitute for detailed CFD or test data.

"""

from __future__ import annotations

import os
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
    return {
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

    # Longitudinal modes for open-closed approximation
    longitudinal_modes: List[float] = []
    for n in range(1, 6):
        freq = (2 * n - 1) * sound_speed / (4.0 * L)
        longitudinal_modes.append(float(freq))

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
    pressure_drop: float,
) -> Dict[str, float]:
    """
    Feed-line acoustics and the water-hammer bound for one propellant line.

    Parameters
    ----------
    feed_line_length : float
        Feed line length [m]
    feed_line_diameter : float
        Feed line bore [m]
    propellant_density : float
        Liquid density [kg/m^3]
    bulk_modulus : float
        Liquid bulk modulus [Pa]
    flow_velocity : float
        Mean line velocity [m/s]
    pressure_drop : float
        Tank-to-chamber pressure drop [Pa]

    Returns
    -------
    dict
        - pogo_frequency: quarter-wave line mode (closed-open) [Hz]
        - surge_frequency: half-wave line mode (closed-closed) [Hz]
        - water_hammer_pressure: Joukowsky spike for an instantaneous stop, rho*a*dv [Pa]
        - water_hammer_margin: pressure_drop / spike [-]
        - sound_speed: wave speed in the liquid [m/s]

    The feed-coupled *stability* margin is the chug gain margin from ``chug.py``; the caller writes
    it into this dict as ``stability_margin``. The piecewise water-hammer-to-margin mapping that used
    to live here (tuned so "typical optimized designs meet the 1.20 requirement", including a branch
    that was literally a constant) was not a stability criterion and has been removed.
    """
    L = max(feed_line_length, 1.0e-3)
    rho = propellant_density
    K = bulk_modulus

    sound_speed = float(np.sqrt(K / rho))
    pogo_frequency = float(sound_speed / (4.0 * L))   # closed-open
    surge_frequency = float(sound_speed / (2.0 * L))  # closed-closed

    delta_v = max(flow_velocity, 0.0)
    water_hammer_pressure = float(rho * sound_speed * delta_v)
    water_hammer_margin = float(pressure_drop / water_hammer_pressure) if water_hammer_pressure > 0.0 else float("inf")

    return {
        "pogo_frequency": pogo_frequency,
        "surge_frequency": surge_frequency,
        "water_hammer_pressure": water_hammer_pressure,
        "water_hammer_margin": water_hammer_margin,
        "sound_speed": sound_speed,
    }


# ---------------------------------------------------------------------------
# Physical stability margins (new model) — fast tiers for the per-eval path
# ---------------------------------------------------------------------------
# Gate-margin mappings, monotone in the physical quantity and centred on the physical criterion:
#   * chug: Nyquist gain margin GM. GM = 1 is the stability boundary, so it maps to a neutral gate
#     margin of 1.0 (the old centre of 0.80 called a GM of 0.85 -- an unstable loop -- "stable").
#   * acoustic: net growth rate alpha of the worst mode. alpha = 0 is the boundary, but the a-priori
#     damping coefficients are un-measured, so a configurable allowance
#     (stability.acoustic_gate_alpha_offset, default 350 1/s) keeps the gate's calibration explicit
#     rather than hidden. Set it to 0 for the strict criterion.
_CHUG_GATE_CENTER = 1.00      # chug gain margin at the stability boundary -> gate margin 1.0
_CHUG_GATE_SCALE = 0.20
_GATE_SPAN = 0.30             # gate margin ranges ~[0.7, 1.3]
_ACOUSTIC_GATE_OFFSET = 350.0  # [1/s] default allowance; overridden by StabilityConfig
_ACOUSTIC_GATE_SCALE = 1000.0  # [1/s]


def _chug_gate_margin(gain_margin: float) -> float:
    if not np.isfinite(gain_margin):
        return 1.10  # neutral-pass when unknown (do not spuriously fail)
    return float(1.0 + _GATE_SPAN * np.tanh((gain_margin - _CHUG_GATE_CENTER) / _CHUG_GATE_SCALE))


def _acoustic_gate_margin(alpha_max: float, alpha_offset: float = _ACOUSTIC_GATE_OFFSET) -> float:
    if not np.isfinite(alpha_max):
        return 1.10
    return float(1.0 + _GATE_SPAN * np.tanh((float(alpha_offset) - alpha_max) / _ACOUSTIC_GATE_SCALE))


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
#                         density kg/m^3   latent heat J/kg   boiling point K (1 atm)
_FLUID_THERMO_FALLBACKS = {
    "lox":          (1140.0,  213000.0,  90.2),
    "methane":      ( 422.6,  510000.0, 111.65),
    "ethanol":      ( 789.0,  838000.0, 351.4),
    "rp1":          ( 810.0,  246000.0, 489.0),
    "ipa":          ( 786.0,  665000.0, 355.6),
    "nitrousoxide": (1220.0,  376000.0, 184.7),
}
_THERMO_INDEX = {"density": (0, "kg/m^3"), "latent_heat": (1, "J/kg"), "boiling_point": (2, "K")}
_GENERIC_THERMO = {"fuel": (800.0, 300000.0, 450.0), "oxidizer": (1140.0, 213000.0, 90.2)}


def _fluid_thermo(config, key: str, attr: str) -> float:
    """``fluids[key].attr`` from the config; else the handbook value for that named fluid; else a
    generic value. Both fallbacks are recorded, and the generic one says the fluid was unrecognised."""
    v = _fluid_attr(getattr(config, "fluids", None), key, attr, None)
    if v is not None:
        return v
    from engine.pipeline.assumptions import assume
    from engine.pipeline.io import _canon_fluid
    idx, unit = _THERMO_INDEX[attr]
    try:
        f = config.fluids[key] if isinstance(config.fluids, dict) else getattr(config.fluids, key)
        name = getattr(f, "name", "") or ""
    except Exception:
        name = ""
    canon = _canon_fluid(name)
    if canon in _FLUID_THERMO_FALLBACKS:
        return assume(f"stability.fluids.{key}.{attr}", _FLUID_THERMO_FALLBACKS[canon][idx], unit=unit,
                      reason=f"fluids.{key}.{attr} missing from config; handbook value for {name}")
    return assume(f"stability.fluids.{key}.{attr}", _GENERIC_THERMO["oxidizer" if key == "oxidizer" else "fuel"][idx],
                  unit=unit, reason=f"fluids.{key}.{attr} missing and fluid {name!r} is not in the handbook table -- set it in the config")


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


def _stability_config(config) -> StabilityConfig:
    sc = getattr(config, "stability", None)
    return sc if isinstance(sc, StabilityConfig) else StabilityConfig()


def build_stability_inputs(config, Pc: float, MR: float, mdot_total: float, cstar: float,
                           gamma: float, R: float, Tc: float, diagnostics: Dict[str, Any],
                           cg: Any, *, overrides: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
    """Extract chug/acoustic model inputs from config + diagnostics. Shared by the fast path
    (compute_physical_stability) and the rich report (report.py) so they use IDENTICAL extraction.
    [Phys §3.2, §4, §5]

    Sources, in order: solved geometry (``cg``), the closure diagnostics of this evaluation, the
    config (``fluids`` for the propellants, ``feed_system`` for the plumbing, ``stability`` for the
    model calibration), and finally recorded assumptions -- never a silent constant.
    """
    from engine.pipeline.stability import core, chug, acoustic
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
    a_snd = core.sound_speed(gamma, R, Tc)

    mdot_O = float(diagnostics.get("mdot_O") or mdot_total * MR / (1.0 + MR))
    mdot_F = float(diagnostics.get("mdot_F") or mdot_total / (1.0 + MR))
    dpiO = float(diagnostics.get("delta_p_injector_O") or 0.30 * Pc)
    dpiF = float(diagnostics.get("delta_p_injector_F") or 0.30 * Pc)
    dpfO = float(diagnostics.get("delta_p_feed_O") or 0.10 * Pc)
    dpfF = float(diagnostics.get("delta_p_feed_F") or 0.10 * Pc)
    D32_O = float(diagnostics.get("D32_O") or 80e-6)
    D32_F = float(diagnostics.get("D32_F") or 60e-6)
    ov = overrides or {}
    if ov.get("smd_um") is not None:
        D32_O = float(ov["smd_um"]) * 1e-6
    if ov.get("eta_inj_O") is not None:
        eta_O = float(ov["eta_inj_O"])
        dpiO = eta_O * Pc
    else:
        eta_O = dpiO / Pc if Pc > 0 else 0.3
    eta_F = dpiF / Pc if Pc > 0 else 0.3

    rho_O = _fluid_thermo(config, "oxidizer", "density")
    rho_F = _fluid_thermo(config, "fuel", "density")
    hfg_O = _fluid_thermo(config, "oxidizer", "latent_heat")
    hfg_F = _fluid_thermo(config, "fuel", "latent_heat")
    tbO = _fluid_thermo(config, "oxidizer", "boiling_point")
    tbF = _fluid_thermo(config, "fuel", "boiling_point")
    K_bulk_O = _fluid_attr(config.fluids, "oxidizer", "bulk_modulus_pa", None)
    if K_bulk_O is None:
        K_bulk_O = assume("stability.fluids.oxidizer.bulk_modulus_pa", 1.5e9, unit="Pa",
                          reason="fluids.oxidizer.bulk_modulus_pa missing (set via propellant preset); measure via water-hammer test T5")
    tau_conv_O, _, K_v_O = core.lags_from_smd(D32_O, k_g=k_g, rho_l=rho_O, cp_g=cp_g, T_inf=Tc,
                                              T_boil=tbO, h_fg=hfg_O, chi=1.0)
    tau_conv_F, _, K_v_F = core.lags_from_smd(D32_F, k_g=k_g, rho_l=rho_F, cp_g=cp_g, T_inf=Tc,
                                              T_boil=tbF, h_fg=hfg_F, chi=1.0)
    if not np.isfinite(tau_conv_O):
        tau_conv_O = assume("stability.tau_conv_O", 2.0e-3, unit="s",
                            reason="d^2-law oxidizer lag non-finite (check T_boil < Tc and h_fg)")
    if not np.isfinite(tau_conv_F):
        tau_conv_F = assume("stability.tau_conv_F", 1.5e-3, unit="s",
                            reason="d^2-law fuel lag non-finite (check T_boil < Tc and h_fg)")

    L_feed_O, A_feed_O = _feed_geometry(config, "oxidizer")
    L_feed_F, A_feed_F = _feed_geometry(config, "fuel")
    reg_kw = dict(enabled=bool(sc.regulator_enabled), corner_hz=float(sc.regulator_corner_hz),
                  Z_hf=float(sc.regulator_Z_hf), max_excursion_pa=float(sc.regulator_max_excursion_psi) * 6894.757)
    streams = [
        chug.ChugStream("O", mdot=mdot_O, eta_inj=max(eta_O, 1e-3), Pc=Pc, dP_feed=dpfO,
                        feed_length=L_feed_O, feed_area=A_feed_O, tau_conv=tau_conv_O,
                        regulator=chug.Regulator(**reg_kw)),
        chug.ChugStream("F", mdot=mdot_F, eta_inj=max(eta_F, 1e-3), Pc=Pc, dP_feed=dpfF,
                        feed_length=L_feed_F, feed_area=A_feed_F, tau_conv=tau_conv_F,
                        regulator=chug.Regulator(**reg_kw)),
    ]
    chamber = chug.ChugChamber(cstar=cstar, A_t=A_t, Lstar=Lstar, gamma=gamma)
    chi_ac = float(ov.get("chi_acoustic", sc.chi_acoustic))
    n_int = float(ov.get("n_interaction", sc.n_interaction))
    tau_sens = chi_ac * tau_conv_O      # LOX-side rate-limiting; sensitive lag << transport lag [Phys §5]

    # Nozzle-entrance Mach sets the convective (nozzle) damping. Config value if given, else the
    # subsonic isentropic solution for the actual contraction ratio (a fixed 0.2 corresponds to a
    # contraction ratio of ~2.9 and overstated nozzle damping for every wider chamber).
    M_ne = sc.mach_nozzle_entrance
    if M_ne is None:
        M_ne = core.mach_from_area_ratio_subsonic(contraction_ratio, gamma) if np.isfinite(contraction_ratio) else float("nan")
        if not np.isfinite(M_ne) or M_ne <= 0.0:
            M_ne = assume("stability.mach_nozzle_entrance", 0.2, unit="-",
                          reason="contraction ratio unavailable for the isentropic solve")
    gas = acoustic.GasState(gamma=gamma, a_sound=a_snd, nu_g=nu_g, mach_nozzle_entrance=float(M_ne))
    coeffs = acoustic.DampingCoeffs(injector_frac=float(sc.damping_injector_frac),
                                    twophase_frac=float(sc.damping_twophase_frac),
                                    droplet_loading=float(sc.droplet_loading))

    return {
        "streams": streams, "chamber": chamber, "gas": gas, "damping_coeffs": coeffs,
        "acoustic_gate_alpha_offset": float(sc.acoustic_gate_alpha_offset),
        "D_ch": D_ch, "L_ch": L_ch, "Lstar": Lstar, "contraction_ratio": contraction_ratio,
        "mach_nozzle_entrance": float(M_ne),
        "tau_conv_O": tau_conv_O, "tau_conv_F": tau_conv_F, "tau_sens": tau_sens,
        "chi_acoustic": chi_ac, "n_interaction": n_int,
        "eta_inj_O": eta_O, "eta_inj_F": eta_F,
        "D32_O": D32_O, "D32_F": D32_F, "K_v_O": K_v_O, "K_v_F": K_v_F,
        "rho_O": rho_O, "rho_F": rho_F, "K_bulk_O": K_bulk_O,
        "feed_length_O": L_feed_O, "feed_length_F": L_feed_F,
        "u_O": diagnostics.get("u_O"), "Cd_O": diagnostics.get("Cd_O"),
        "Pc": Pc, "wh_pressure_pa": None,
    }


def compute_physical_stability(config, Pc: float, MR: float, mdot_total: float, cstar: float,
                               gamma: float, R: float, Tc: float, diagnostics: Dict[str, Any],
                               cg: Any) -> Optional[Dict[str, Any]]:
    """Build inputs and run the FAST tiers (per-eval path). Returns physical margins/freqs or None on
    failure (caller falls back). [Phys §3.2 fast, §4.2 fast; plan A4]
    """
    from engine.pipeline.stability import chug, acoustic
    inp = build_stability_inputs(config, Pc, MR, mdot_total, cstar, gamma, R, Tc, diagnostics, cg)
    # Accelerated fast path: the 200-pt complex chug sweep is the dominant
    # per-eval stability cost. Run the compiled kernel when the accelerator is
    # enabled; fall back to the (now vectorised) Python sweep on any issue.
    from engine import accel
    chug_fast = None
    if accel.enabled():
        try:
            # attribute access, not a direct import -- see the note in
            # tests/test_accel_is_actually_used.py
            chug_fast = accel.chug_margin_fast(inp["streams"], inp["chamber"])
        except Exception:
            chug_fast = None
    if chug_fast is None:
        chug_fast = chug.chug_margin_fast(inp["streams"], inp["chamber"])

    # fast_acoustic stays pure Python on purpose: 10.5 us here vs 4.2 us in C, and
    # acoustic.fast_acoustic is two mode_growth_rate calls with no loop. A ~6 us
    # difference does not earn a kernel. (The chug sweep did: 200 complex points,
    # measured at ~8.8% of Layer-1 wall time when left unaccelerated.)
    ac_fast = acoustic.fast_acoustic(inp["D_ch"], inp["L_ch"], inp["gas"],
                                     n=inp["n_interaction"], tau_sens=inp["tau_sens"],
                                     coeffs=inp["damping_coeffs"])

    return {
        "chug": chug_fast,
        "acoustic": ac_fast,
        "chug_gate_margin": _chug_gate_margin(chug_fast.get("gain_margin", float("nan"))),
        "acoustic_gate_margin": _acoustic_gate_margin(ac_fast.get("alpha_max", float("nan")),
                                                      inp["acoustic_gate_alpha_offset"]),
        "f_chug_hz": chug_fast.get("f_chug_hz"),
        "tau_conv_O": inp["tau_conv_O"], "tau_conv_F": inp["tau_conv_F"], "tau_sens": inp["tau_sens"],
        "eta_inj_O": inp["eta_inj_O"], "eta_inj_F": inp["eta_inj_F"], "D_ch": inp["D_ch"], "L_ch": inp["L_ch"],
        "mach_nozzle_entrance": inp["mach_nozzle_entrance"],
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
        - stability_state: "stable", "marginal", or "unstable"
        - stability_score: 0 to 1
        - is_stable: backward compatibility boolean
        - chugging: dict from calculate_chugging_frequency
        - acoustic: dict with modes and acoustic margin (backward compatibility)
        - feed_system: dict from analyze_feed_system_stability
        - mode_coupling: list of potentially coupled mode pairs
        - issues: list of human readable issues
        - recommendations: list of design recommendations
        - Lstar: characteristic length [m]
    """
    # Chamber geometry
    from engine.pipeline.config_schemas import ensure_chamber_geometry
    cg = ensure_chamber_geometry(config)
    V_chamber = float(cg.volume)
    A_throat = float(cg.A_throat)
    Lstar = V_chamber / A_throat if A_throat > 0.0 else cg.Lstar
    L_chamber, D_chamber = _chamber_dims(config, cg)

    # Combustion stability
    chugging = calculate_chugging_frequency(
        chamber_volume=V_chamber,
        throat_area=A_throat,
        cstar=cstar,
        gamma=gamma,
        Pc=Pc,
        R=R,
        Tc=Tc,
    )

    acoustic_raw = calculate_acoustic_modes(
        chamber_length=L_chamber,
        chamber_diameter=D_chamber,
        gas_temperature=Tc,
        gamma=gamma,
        R=R,
    )

    # Feed-line acoustics on the oxidizer line (the stiffer, denser side; representative). Length
    # and bore come from feed_system.oxidizer -- the old lookup asked for a "lox" branch and a
    # "length" attribute that never existed, so it always fell through to 1.0 m x 10 mm.
    feed_length, A_feed = _feed_geometry(config, "oxidizer")
    feed_diameter = float(np.sqrt(4.0 * A_feed / np.pi))

    # Oxidizer density / bulk modulus from config.fluids (the old `config.propellants` lookup was a
    # dead key — it ALWAYS fell through to 1140. UNIFICATION P2c: config-first, recorded fallback.)
    prop_density = _fluid_attr(config.fluids, "oxidizer", "density", None)
    if prop_density is None:
        from engine.pipeline.assumptions import assume
        prop_density = assume("stability.feed.rho_oxidizer", 1140.0, unit="kg/m^3",
                              reason="fluids.oxidizer.density missing")
    bulk_modulus = _fluid_attr(config.fluids, "oxidizer", "bulk_modulus_pa", None)
    if bulk_modulus is None:
        from engine.pipeline.assumptions import assume
        bulk_modulus = assume("stability.feed.bulk_modulus_O", 1.5e9, unit="Pa",
                              reason="fluids.oxidizer.bulk_modulus_pa missing (set via propellant preset); measure via water-hammer test T5")

    # Mean oxidizer line velocity
    mdot_ox = float(diagnostics.get("mdot_O", mdot_total * MR / (1.0 + MR)))
    flow_velocity = float(mdot_ox / (prop_density * A_feed)) if A_feed > 0.0 else 0.0

    # Pressure drop from tank to chamber
    P_tank_O = float(diagnostics.get("P_tank_O", Pc * 2.0))
    pressure_drop = max(P_tank_O - Pc, 0.0)

    feed_stability = analyze_feed_system_stability(
        feed_line_length=feed_length,
        feed_line_diameter=feed_diameter,
        propellant_density=prop_density,
        bulk_modulus=bulk_modulus,
        flow_velocity=flow_velocity,
        pressure_drop=pressure_drop,
    )

    # Build acoustic mode dictionary
    acoustic_modes_dict: Dict[str, float] = {}
    for i, freq in enumerate(acoustic_raw["longitudinal_modes"]):
        acoustic_modes_dict[f"L{i+1}"] = freq
    for i, freq in enumerate(acoustic_raw["transverse_modes"]):
        acoustic_modes_dict[f"T{i+1}"] = freq

    issues: List[str] = []

    # -------------------------------------------------------------------
    # Physical margins (new model) — replaces the heuristic score/margins. [plan A4, M4]
    # -------------------------------------------------------------------
    phys = None
    try:
        phys = compute_physical_stability(config, Pc, MR, mdot_total, cstar, gamma, R, Tc, diagnostics, cg)
    except Exception:   # defensive: never fail the eval on a stability-model error
        phys = None

    if phys is not None:
        chug_margin = float(phys["chug_gate_margin"])
        acoustic_margin = float(phys["acoustic_gate_margin"])
        _fch = phys.get("f_chug_hz")
        if _fch is not None and np.isfinite(_fch) and _fch > 0:
            chugging["frequency"] = float(_fch)        # physical chug freq, not L*/c* placeholder
        chugging["stability_margin"] = chug_margin
        chugging["chug_gain_margin"] = phys["chug"].get("gain_margin")
        feed_stability["stability_margin"] = chug_margin   # feed-coupled instability IS chug (un-rig)
        if not phys["chug"].get("stable", True):
            issues.append("Chug (feed-coupled LF) margin low: stiffen injector or improve atomization")
        if not phys["acoustic"].get("stable", True):
            issues.append(f"Acoustic mode {phys['acoustic'].get('limiting_mode')} driven (alpha>0)")
    else:
        # The physical model could not be evaluated: margins are UNKNOWN. Neutral-pass so a
        # stability-model error never fails an evaluation, and say so in the issues list rather
        # than reporting a heuristic as if it were a margin.
        chug_margin = 1.10
        acoustic_margin = 1.10
        chugging["stability_margin"] = chug_margin
        feed_stability["stability_margin"] = chug_margin
        issues.append("Stability model could not be evaluated for this point; margins shown are neutral placeholders")

    # -------------------------------------------------------------------
    # Mode coupling analysis
    # -------------------------------------------------------------------

    # Collect representative modes for coupling checks
    modes: List[Dict[str, Any]] = []

    # The physical chug frequency when the model ran; the geometric placeholder is not a chug mode.
    if phys is not None and np.isfinite(chugging["frequency"]):
        modes.append({"name": "chugging", "type": "combustion", "frequency": chugging["frequency"]})
    modes.append({"name": "pogo", "type": "feed", "frequency": feed_stability["pogo_frequency"]})
    modes.append({"name": "surge", "type": "feed", "frequency": feed_stability["surge_frequency"]})

    # Use first 3 longitudinal and first 2 transverse modes
    for i, f in enumerate(acoustic_raw["longitudinal_modes"][:3]):
        modes.append({"name": f"L{i+1}", "type": "acoustic_long", "frequency": f})
    for i, f in enumerate(acoustic_raw["transverse_modes"][:2]):
        modes.append({"name": f"T{i+1}", "type": "acoustic_trans", "frequency": f})

    mode_coupling: List[Dict[str, Any]] = []
    coupling_tol_rel = 0.10  # 10 percent separation considered risky

    for i in range(len(modes)):
        for j in range(i + 1, len(modes)):
            f1 = modes[i]["frequency"]
            f2 = modes[j]["frequency"]
            fmax = max(f1, f2)
            if fmax <= 0.0:
                continue
            rel_diff = abs(f1 - f2) / fmax
            if rel_diff < coupling_tol_rel:
                mode_coupling.append(
                    {
                        "mode_a": modes[i]["name"],
                        "mode_b": modes[j]["name"],
                        "freq_a": float(f1),
                        "freq_b": float(f2),
                        "relative_difference": float(rel_diff),
                    }
                )

    # -------------------------------------------------------------------
    # Stability classification
    # -------------------------------------------------------------------

    # NOTE: chug/acoustic issues come from the PHYSICAL model above (not the old heuristic chugging
    # stability_index), and water-hammer is handled below as a separate valve-transient note.

    # Mode coupling
    if mode_coupling:
        issues.append("Potential mode coupling between combustion, acoustic, and feed system modes")

    # L* sanity check (very short or very long residence time)
    if Lstar < 0.5 or Lstar > 3.0:
        issues.append(f"L* outside typical range (0.5 m to 3.0 m). Current L* = {Lstar:.2f} m")

    # Numeric score in [0,1] monotone in the limiting gate margin (1.05 ~ gate threshold).
    min_margin = min(chug_margin, acoustic_margin)
    score = float(np.clip((min_margin - 0.85) / 0.45, 0.0, 1.0))

    has_severe_mode_coupling = any(p.get("relative_difference", 1.0) < 0.05 for p in mode_coupling)

    # State from physical margins (growth-rate based, not heuristic).
    chug_ok = (phys is None) or phys["chug"].get("stable", True)
    ac_ok = (phys is None) or phys["acoustic"].get("stable", True)
    if chug_margin >= 1.05 and acoustic_margin >= 1.05 and chug_ok and ac_ok:
        stability_state = "stable"
    elif chug_margin >= 0.95 and acoustic_margin >= 0.95:
        stability_state = "marginal"
    else:
        stability_state = "unstable"

    recommendations = _generate_stability_recommendations(
        stability_state=stability_state,
        chugging=chugging,
        acoustic=acoustic_raw,
        feed_system=feed_stability,
        mode_coupling=mode_coupling,
        Lstar=Lstar,
    )

    acoustic = {
        **acoustic_raw,
        "modes": acoustic_modes_dict,
        "stability_margin": float(acoustic_margin),
    }
    if phys is not None:
        acoustic["alpha_max"] = phys["acoustic"].get("alpha_max")
        acoustic["limiting_mode"] = phys["acoustic"].get("limiting_mode")

    # Backward compatibility: is_stable boolean
    is_stable = (stability_state == "stable")

    return {
        "stability_state": stability_state,
        "stability_score": score,
        "is_stable": is_stable,  # Backward compatibility
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

    if stability_state == "unstable":
        recs.append("High risk of instability at this operating point. Consider design changes before test.")
    elif stability_state == "marginal":
        recs.append("Stability margin is limited. Plan to instrument heavily and ramp up cautiously in testing.")
    else:
        recs.append("System appears reasonably stable for this point. Still monitor during hot fire.")

    # Chug: Nyquist gain margin of the feed-coupled loop (>1 stable; <1.5 is thin)
    gm = chugging.get("chug_gain_margin")
    if gm is not None and np.isfinite(gm) and gm < 1.5:
        recs.append("Chug gain margin is thin: stiffen the injector (raise dP_inj/Pc) or shorten the vaporization lag (finer SMD).")
        recs.append("Consider injector or chamber damping features such as baffles or acoustic liners.")

    if chugging["frequency"] < 10.0:
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
