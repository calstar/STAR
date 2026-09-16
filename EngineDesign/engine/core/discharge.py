"""Injector discharge coefficient model Cd(Re, orifice geometry).

Cd_inf baseline follows thin-plate sharp-orifice data (ASME / ISO 5167: Cd ≈ 0.60–0.61
at high Re). For impinging doublets, LOX and fuel use the same correlation keyed to
jet diameter d_jet; propellant-specific discharge configs only change baseline/a_Re
when explicitly set — not legacy pintle 0.40/0.65 defaults.
"""

from __future__ import annotations

import math
from typing import Dict, Optional

import numpy as np
from engine.pipeline.config_schemas import DischargeConfig


def cd_inf_from_orifice_diameter(
    d_hyd_m: Optional[float],
    config: DischargeConfig,
) -> float:
    """Geometry-based asymptotic Cd at high Re for a circular injector hole.

    Model (research-backed assumptions):
    - **d = d_ref** (default 2 mm): ``Cd_inf`` equals config baseline (default **0.60**),
      matching thin-plate sharp-edged orifice data (Cd ≈ 0.595–0.602, Re > 10⁴).
    - **d < d_ref**: mild penalty ``(d/d_ref)^cd_small_hole_exponent`` for smaller EDM /
      drilled holes (rougher relative edges, higher effective L/t in a fixed plate).
    - **d > d_ref**: small logarithmic rise toward ``cd_inf_max`` (≤ ~0.62, well-rounded
      large ports).
    - Result clamped to ``[cd_inf_min_geom, cd_inf_max]`` (typical rocket injector band
      0.48–0.62 for machined holes).

    When ``use_geometry_cd`` is False or diameter is missing, returns ``config.Cd_inf``.
    """
    # Inlet treatment, when declared, is the physical determinant and wins over both the
    # diameter scaling and the raw Cd_inf. Checked FIRST because the impinging injector calls
    # this function directly (impinging.py:174) and never goes through cd_from_re, so putting
    # the override only there left the solve on the old path.
    _cd_inlet = cd_inf_from_inlet_geometry(config)
    if _cd_inlet is not None:
        return float(_cd_inlet)
    if not getattr(config, "use_geometry_cd", False):
        return float(config.Cd_inf)
    if d_hyd_m is None or not np.isfinite(float(d_hyd_m)) or float(d_hyd_m) <= 0.0:
        return float(config.Cd_inf)

    d_min = float(getattr(config, "d_min_m", 4.0e-4))
    d_ref = float(getattr(config, "d_ref_m", 2.0e-3))
    cd_base = float(config.Cd_inf)
    exp_small = float(getattr(config, "cd_small_hole_exponent", 0.20))
    log_gain = float(getattr(config, "cd_large_hole_log_gain", 0.015))
    cd_max = float(getattr(config, "cd_inf_max", 0.62))
    cd_floor = float(getattr(config, "cd_inf_min_geom", 0.48))

    d = float(max(d_min, float(d_hyd_m)))
    if d_ref <= 0.0:
        return float(np.clip(cd_base, cd_floor, cd_max))

    ratio = d / d_ref
    if ratio < 1.0:
        cd_geom = cd_base * (ratio ** max(0.0, exp_small))
    else:
        cd_geom = cd_base + log_gain * math.log(ratio)

    return float(np.clip(cd_geom, cd_floor, cd_max))


def discharge_cd_inf_ratio(
    d_hyd_O: float,
    d_hyd_F: float,
    discharge_O: DischargeConfig,
    discharge_F: DischargeConfig,
) -> float:
    """High-Re Cd_inf,O / Cd_inf,F from orifice diameters (≈1 when jets share the same hole style)."""
    cd_f = cd_inf_from_orifice_diameter(d_hyd_F, discharge_F)
    if cd_f <= 0.0:
        return 1.0
    cd_o = cd_inf_from_orifice_diameter(d_hyd_O, discharge_O)
    return float(cd_o / cd_f)


def cd_from_re(
    Re: float,
    config: DischargeConfig,
    P_inlet: float = None,
    T_inlet: float = None,
    d_hyd_m: Optional[float] = None,
) -> float:
    """
    Calculate discharge coefficient as function of Reynolds number, optional orifice
    diameter, pressure, and temperature.

    Base formula: Cd(Re) = Cd_inf,eff - a_Re / √Re

    ``Cd_inf,eff`` is ``cd_inf_from_orifice_diameter(d_hyd_m, config)`` when geometry
    mode is enabled; otherwise ``config.Cd_inf``.

    With corrections:
    - Pressure correction: Cd(P) = Cd(Re) × [1 + a_P × (P/P_ref - 1)]
    - Temperature correction: Cd(T) = Cd(Re) × [1 + a_T × (T/T_ref - 1)]

    Clamped to [Cd_min, Cd_inf,eff]
    """
    # Inlet geometry, when the config declares one, is the PHYSICAL determinant of Cd and
    # overrides the diameter-scaled value. See cd_inf_from_inlet_geometry: it returns None
    # unless inlet_geometry / inlet_radius_ratio is set, so old configs are untouched.
    cd_inf_eff = cd_inf_from_orifice_diameter(d_hyd_m, config)

    if Re <= 0:
        return float(config.Cd_min)

    Cd = cd_inf_eff - config.a_Re / np.sqrt(max(Re, 1e-6))

    if config.use_pressure_correction and P_inlet is not None and config.P_ref > 0:
        P_correction = 1.0 + config.a_P * (P_inlet / config.P_ref - 1.0)
        Cd *= P_correction

    if config.use_temperature_correction and T_inlet is not None and config.T_ref > 0:
        T_correction = 1.0 + config.a_T * (T_inlet / config.T_ref - 1.0)
        Cd *= T_correction

    Cd = np.clip(Cd, config.Cd_min, cd_inf_eff)
    return float(Cd)


def calculate_reynolds_number(
    rho: float,
    u: float,
    d_hyd: float,
    mu: float
) -> float:
    """
    Calculate Reynolds number.

    Re = (ρ × u × d_hyd) / μ
    """
    if mu <= 0:
        return 1e6

    Re = (rho * u * d_hyd) / mu
    return float(Re)


# =====================================================================================
# ORIFICE INLET GEOMETRY -> Cd.  This is a DESIGN KNOB, not a fudge factor.
#
# The model above scales Cd_inf by hole DIAMETER, which is a manufacturing proxy, not
# physics -- diameter enters the real problem only through Reynolds number and relative
# roughness. What actually sets an orifice's discharge coefficient is (a) what the INLET
# edge looks like and (b) the length-to-diameter ratio.
#
# INLET EDGE. A sharp edge separates the flow at entry, forming a vena contracta the
# stream never fully recovers from: Cd ~ 0.61 for a thin plate. Rounding or chamfering the
# entry lets the flow hug the wall instead, and Cd climbs to 0.85-0.95 at r/d = 0.1-0.2.
# Nurick (1976) showed inlet condition also sets cavitation inception -- the critical
# pressure ratio rises linearly with inlet roundness -- so rounding buys cavitation margin
# as well as flow.
#
# LENGTH. Lichtarowicz, Duggins & Markland (1965), "Discharge Coefficients for
# Incompressible Non-Cavitating Flow through Long Orifices": Cd rises steeply from L/d = 0,
# peaks near L/d ~ 2 where the controlled expansion recovers part of the dynamic pressure
# lost at the vena contracta, then falls slowly as wall friction takes over. Above
# Re ~ 1e4 Cd is essentially Reynolds-independent for a given orifice, which is the regime
# every one of these injectors runs in.
#
# WHY THIS IS USEFUL: Cd is per-orifice, and `discharge.oxidizer` / `discharge.fuel` are
# already separate config blocks. So you can deliberately give one propellant a higher Cd
# than the other by filleting only that side's inlet -- a way to move the momentum ratio or
# trim O/F WITHOUT changing hole size, element count or angles. It is a real tuning knob
# that costs one extra machining op.
#
# Values below are the practitioner table (Huzel & Huang, "Modern Engineering for Design of
# Liquid-Propellant Rocket Engines", injector orifice Cd) cross-checked against the rounded
# -inlet range reported in the cold-flow literature.
# =====================================================================================

#: Named inlet treatments -> Cd for a SHORT TUBE (L/d ~ 2-5, i.e. a normally drilled hole
#: in a plate) at Re > 1e4. Apply cd_length_factor() for other L/d.
#:
#: CAREFUL -- the widely-quoted "sharp-edged orifice, Cd = 0.61" is the THIN-PLATE value
#: (L/d -> 0), where the jet leaves at the vena contracta and never recovers. A drilled hole
#: of L/d 2-5 with the same sharp entry reattaches inside the bore and recovers to ~0.80.
#: Conflating the two under-predicts a real injector's flow by ~24%. Both anchors are
#: reproduced here: 0.80 at L/d 2-5, and 0.80 * cd_length_factor(0) = 0.61 at the plate limit.
INLET_GEOMETRY_CD: Dict[str, float] = {
    "sharp": 0.80,            # plain drilled hole, sharp entry, reattached
    "chamfered": 0.84,        # ~45 deg x 0.1d break on the entry edge
    "conical": 0.86,          # conical/countersunk entrance, included ~60-90 deg
    "rounded_light": 0.85,    # r/d ~ 0.05
    "rounded": 0.88,          # r/d ~ 0.1-0.15 -- "short tube with rounded entrance"
    "bellmouth": 0.95,        # r/d >= 0.2, fully faired entry
}

#: r/d at which each named treatment is nominally achieved (for the continuous model).
INLET_GEOMETRY_RD: Dict[str, float] = {
    "sharp": 0.0, "chamfered": 0.03, "conical": 0.04,
    "rounded_light": 0.05, "rounded": 0.125, "bellmouth": 0.20,
}


def cd_from_inlet_radius_ratio(r_over_d: float) -> float:
    """Cd at Re > 1e4 and L/d ~ 2-5 as a continuous function of inlet rounding r/d.

    Saturating fit through the practitioner anchors for a SHORT TUBE: 0.80 sharp entry
    (r/d = 0), ~0.88 at r/d = 0.1-0.125, 0.95 at r/d >= 0.2. Rounding past r/d ~ 0.2 buys
    almost nothing, which is why bellmouth entries are specified at that ratio, not deeper.
    For the thin-plate limit multiply by cd_length_factor(L/d), which recovers 0.61 at L/d 0.
    """
    x = max(0.0, float(r_over_d))
    # k fitted so r/d = 0.10 lands on the published 0.88 ("short tube with rounded
    # entrance"), with the asymptote near 0.95-0.96 reached by r/d ~ 0.25-0.3.
    cd_sharp, cd_max, k = 0.80, 0.96, 7.622
    return float(cd_sharp + (cd_max - cd_sharp) * (1.0 - np.exp(-k * x)))


def cd_length_factor(l_over_d: float) -> float:
    """Multiplier on Cd for orifice length, normalised to 1.0 over L/d = 2-5.

    Lichtarowicz et al. (1965): steep rise from L/d = 0, maximum near L/d ~ 2 where the
    expansion downstream of the vena contracta recovers dynamic pressure, then a slow decline
    from wall friction. Below L/d ~ 1 the orifice behaves as a thin plate and loses that
    recovery; above ~10 friction dominates.
    """
    x = float(l_over_d)
    if not np.isfinite(x) or x <= 0.0:
        return 1.0
    if x < 2.0:                       # thin-plate end: lose the reattachment recovery
        # 0.7625 at L/d -> 0 so that sharp (0.80) * 0.7625 = 0.61, the thin-plate anchor.
        return float(0.7625 + 0.11875 * x)     # 0.7625 at L/d->0, 1.00 at L/d=2
    if x <= 5.0:
        return 1.0
    return float(max(0.85, 1.0 - 0.012 * (x - 5.0)))   # friction roll-off


def cd_inf_from_inlet_geometry(config) -> Optional[float]:
    """Asymptotic Cd from the orifice's INLET treatment and L/d, or None if not configured.

    Returns None when neither ``inlet_geometry`` nor ``inlet_radius_ratio`` is set, so the
    caller keeps its existing diameter-based behaviour and nothing changes for old configs.
    """
    name = getattr(config, "inlet_geometry", None)
    rd = getattr(config, "inlet_radius_ratio", None)
    if name is None and rd is None:
        return None
    if rd is not None and np.isfinite(float(rd)):
        cd = cd_from_inlet_radius_ratio(float(rd))
    else:
        key = str(name).strip().lower()
        if key not in INLET_GEOMETRY_CD:
            raise ValueError(
                f"Unknown inlet_geometry {name!r}. Valid: {', '.join(sorted(INLET_GEOMETRY_CD))}, "
                f"or give inlet_radius_ratio (r/d) for a continuous value."
            )
        cd = INLET_GEOMETRY_CD[key]
    lod = getattr(config, "orifice_l_over_d", None)
    if lod is not None and np.isfinite(float(lod)):
        cd *= cd_length_factor(float(lod))
    return float(min(cd, 0.98))
