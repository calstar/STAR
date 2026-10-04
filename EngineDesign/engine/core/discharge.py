"""Injector discharge coefficient model Cd(Re, orifice geometry).

A declared orifice inlet (``inlet_geometry`` / ``inlet_radius_ratio``) and L/d set Cd_inf: the
short-tube table with the Lichtarowicz (1965) length fit, which is what a drilled doublet hole
is (the shipped configs declare sharp, L/d 4). Without one, Cd_inf is the thin-plate
sharp-orifice value (ASME / ISO 5167: Cd ≈ 0.60–0.61 at high Re), keyed to d_jet.
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
    """Asymptotic Cd at high Re for a circular injector hole.

    A declared inlet (``inlet_geometry`` / ``inlet_radius_ratio``) wins: the short-tube value at
    the hole's L/d (cd_inf_from_inlet_geometry). Otherwise this is a THIN-PLATE model:
    - **d = d_ref** (default 2 mm): ``Cd_inf`` equals config baseline (default **0.60**),
      matching thin-plate sharp-edged orifice data (Cd ≈ 0.595–0.602, Re > 10⁴).
    - **d < d_ref**: ``(d/d_ref)^cd_small_hole_exponent``, default 0 (no change). ISO 5167 and
      Sutton & Biblarz Table 8-2 have small sharp holes flowing slightly MORE; the old 0.2
      penalty had the wrong sign.
    - **d > d_ref**: small logarithmic rise toward ``cd_inf_max`` (≤ ~0.62).
    - Result clamped to ``[cd_inf_min_geom, cd_inf_max]``.
    A drilled hole of L/d 2-10 is not a thin plate (0.79 at L/d 4, Lichtarowicz 1965); this
    path under-predicts its flow by ~24%.

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

    ``Re`` is on the bulk hole velocity mdot/(rho A) and the hole diameter.

    Re law, when the block declares an inlet, an ``orifice_l_over_d`` and
    ``length_model: lichtarowicz`` (the default) -- Lichtarowicz, Duggins & Markland (1965):
        1/Cd = 1/Cd_u + 20 (1 + 2.25 L/d)/Re - 0.0015 (L/d) / (1 + 7.5 [log10(0.00015 Re)]^2)
    with Cd_u the orifice's own high-Re Cd as this module anchors it (inlet table x
    cd_length_factor, cd_u_from_inlet_geometry), then the counterbore approach
    (approach_beta) and the 0.98 cap exactly as cd_inf_from_inlet_geometry applies them.

    Otherwise (``length_model: piecewise``, or no declared inlet / L/d): the LEGACY, unsourced
    form Cd(Re) = Cd_inf,eff - a_Re / √Re. ``a_Re`` is a tuned coefficient with no reference
    and is ignored whenever the Lichtarowicz law applies.

    ``Cd_inf,eff`` is ``cd_inf_from_orifice_diameter(d_hyd_m, config)`` when geometry
    mode is enabled; otherwise ``config.Cd_inf``.

    Corrections (unsourced; off by default):
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

    lich = lichtarowicz_re_inputs(config)
    if lich is not None:
        cd_u, lod, beta = lich
        Cd = min(cd_with_approach(cd_lichtarowicz_re(cd_u, Re, lod), beta), 0.98)
    else:
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


#: Lichtarowicz, Duggins & Markland (1965), ultimate (high-Re) Cd of a sharp-inlet long
#: orifice, valid 2 <= L/d <= 10: Cd_u = A - B L/d.
LICHTAROWICZ_A = 0.827
LICHTAROWICZ_B = 0.0085
#: L/d at which that fit equals the inlet table's short-tube value (0.80 sharp), so the table
#: stays the anchor and the fit supplies the slope.
LICHTAROWICZ_REF_LD = (LICHTAROWICZ_A - 0.80) / LICHTAROWICZ_B
#: Longest L/d in the fit's data.
LICHTAROWICZ_LD_MAX = 10.0
#: Sharp-edged entrance from a large plenum into the counterbore (Idelchik, Handbook of
#: Hydraulic Resistance, diagram 3-1, thin-walled flush inlet: 0.5).
COUNTERBORE_ENTRANCE_K = 0.5


def cd_length_factor(l_over_d: float, model: str = "lichtarowicz") -> float:
    """Multiplier on Cd for orifice length.

    ``lichtarowicz`` (default): the published sharp-inlet fit Cd_u = 0.827 - 0.0085 L/d over
    2 <= L/d <= 10, divided by its value at LICHTAROWICZ_REF_LD so the inlet table stays the
    anchor. Past 10 (outside the data) the same slope continues, floored at 0.85, and the
    extrapolation is recorded. Below 2 it blends linearly to the thin-plate anchor at L/d 0.

    ``piecewise`` (legacy, unsourced): 1.0 over L/d = 2-5, a steep rise from the thin-plate end
    below 2 and a 1.2 %/L/d decline above 5.

    Lichtarowicz et al. (1965): steep rise from L/d = 0, maximum near L/d ~ 2 where the
    expansion downstream of the vena contracta recovers dynamic pressure, then a slow decline
    from wall friction. Below L/d ~ 1 the orifice behaves as a thin plate and loses that
    recovery; above ~10 friction dominates.
    """
    x = float(l_over_d)
    if not np.isfinite(x) or x <= 0.0:
        return 1.0
    if model == "lichtarowicz":
        ref = LICHTAROWICZ_A - LICHTAROWICZ_B * LICHTAROWICZ_REF_LD
        at2 = (LICHTAROWICZ_A - LICHTAROWICZ_B * 2.0) / ref
        if x < 2.0:
            return float(0.7625 + (at2 - 0.7625) * x / 2.0)
        if x > LICHTAROWICZ_LD_MAX:
            from engine.pipeline.assumptions import assume
            assume("discharge.orifice_l_over_d_past_fit", x,
                   reason="Lichtarowicz (1965) fit covers 2 <= L/d <= 10; extrapolated at its slope")
        return float(max(0.85, (LICHTAROWICZ_A - LICHTAROWICZ_B * x) / ref))
    if x < 2.0:                       # thin-plate end: lose the reattachment recovery
        # 0.7625 at L/d -> 0 so that sharp (0.80) * 0.7625 = 0.61, the thin-plate anchor.
        return float(0.7625 + 0.11875 * x)     # 0.7625 at L/d->0, 1.00 at L/d=2
    if x <= 5.0:
        return 1.0
    return float(max(0.85, 1.0 - 0.012 * (x - 5.0)))   # friction roll-off


def cd_with_approach(cd: float, beta: Optional[float], k_entrance: float = COUNTERBORE_ENTRANCE_K) -> float:
    """Cd of an orifice fed through a counterbore of diameter d / beta, referred to the
    plenum-to-chamber drop.

    Energy from the plenum: the counterbore entrance costs (1 + K) of the counterbore's
    velocity head, and the orifice, with its static tap in the counterbore, discharges
    Cd A sqrt(2 rho dp / (1 - beta^4)). Adding the two drops:

        dp_total = rho v^2 / 2 * [ (1 - beta^4) / Cd^2 + beta^4 (1 + K) ]

    Wall friction in the counterbore (f L/D ~ 0.05) is neglected: it adds under 0.2 % of the
    already-small beta^4 term.
    """
    if beta is None or not np.isfinite(beta) or beta <= 0.0 or cd <= 0.0:
        return float(cd)
    b4 = float(beta) ** 4
    return float(1.0 / math.sqrt((1.0 - b4) / cd ** 2 + b4 * (1.0 + k_entrance)))


def cd_inf_from_inlet_geometry(config) -> Optional[float]:
    """Asymptotic Cd from the orifice's INLET treatment and L/d, or None if not configured.

    Returns None when neither ``inlet_geometry`` nor ``inlet_radius_ratio`` is set, so the
    caller keeps its existing diameter-based behaviour and nothing changes for old configs.
    This is the orifice's own ultimate Cd (cd_u_from_inlet_geometry) seen through the
    counterbore approach, capped at 0.98.
    """
    cd = cd_u_from_inlet_geometry(config)
    if cd is None:
        return None
    cd = cd_with_approach(cd, getattr(config, "approach_beta", None))
    return float(min(cd, 0.98))


def cd_u_from_inlet_geometry(config) -> Optional[float]:
    """The ORIFICE's high-Re Cd, inlet table x length factor, before any counterbore approach.

    This is Cd_u of Lichtarowicz et al. (1965) as anchored here (sharp 0.80 at
    LICHTAROWICZ_REF_LD). None when the config declares no inlet.
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
        cd *= cd_length_factor(float(lod), getattr(config, "length_model", "lichtarowicz"))
    return float(cd)


#: Lichtarowicz, Duggins & Markland (1965), J. Mech. Eng. Sci. 7(2):210-219, eq. for a
#: sharp-inlet long orifice (2 <= L/d <= 10), non-cavitating:
#:   1/Cd = 1/Cd_u + A (1 + B L/d)/Re - C (L/d) / (1 + D [log10(E Re)]^2)
LICHTAROWICZ_RE_A = 20.0
LICHTAROWICZ_RE_B = 2.25
LICHTAROWICZ_RE_C = 0.0015
LICHTAROWICZ_RE_D = 7.5
LICHTAROWICZ_RE_E = 0.00015


def cd_lichtarowicz_re(cd_u: float, Re: float, l_over_d: float) -> float:
    """Lichtarowicz et al. (1965) Cd at Reynolds number ``Re`` (bulk velocity mdot/(rho A), hole
    diameter) for an orifice whose ultimate (high-Re) Cd is ``cd_u`` and length is ``l_over_d``.

    Mirrored by ``engine.accel.kernels._cd_lichtarowicz_re``; keep the operation order identical.
    """
    x = float(l_over_d)
    lg = math.log10(LICHTAROWICZ_RE_E * Re)
    inv = (1.0 / cd_u
           + LICHTAROWICZ_RE_A * (1.0 + LICHTAROWICZ_RE_B * x) / Re
           - LICHTAROWICZ_RE_C * x / (1.0 + LICHTAROWICZ_RE_D * lg * lg))
    return float(1.0 / inv)


def lichtarowicz_re_inputs(config) -> Optional[tuple]:
    """``(Cd_u, L/d, approach_beta)`` when cd_from_re uses the Lichtarowicz Re law, else None.

    It applies when the block declares an inlet (so Cd_u exists), an L/d, and
    ``length_model: lichtarowicz`` (the default). Otherwise cd_from_re keeps the legacy a_Re form.
    """
    if getattr(config, "length_model", "lichtarowicz") != "lichtarowicz":
        return None
    lod = getattr(config, "orifice_l_over_d", None)
    if lod is None or not np.isfinite(float(lod)) or float(lod) <= 0.0:
        return None
    cd_u = cd_u_from_inlet_geometry(config)
    if cd_u is None:
        return None
    return float(cd_u), float(lod), getattr(config, "approach_beta", None)


# =====================================================================================
# CAVITATION / HYDRAULIC FLIP (reporting only -- nothing here changes a flow)
#
# Nurick (1976), "Orifice Cavitation and Its Effect on Spray Mixing": once the static
# pressure at the vena contracta reaches the vapour pressure, flow through a sharp orifice
# stops depending on the downstream pressure and follows Cd = Cc * sqrt(K), with the
# cavitation number K = (P_in - P_v) / (P_in - P_c) and Cc the contraction coefficient.
# The orifice therefore cavitates once Cc sqrt(K) falls below its non-cavitating Cd, i.e.
# below K_crit = (Cd / Cc)^2. A cavitating short orifice can go on to hydraulic flip -- the
# jet detaches from the bore, Cd drops toward Cc, and the doublet's momentum ratio is gone.
# Nurick's inlet-rounding fit for the contraction: Cc = (1/Cc0^2 - 11.4 r/d)^-1/2, Cc0 = 0.62,
# for r/d up to ~0.14.
# =====================================================================================

NURICK_CC0 = 0.62
NURICK_RD_GAIN = 11.4


def contraction_coefficient(r_over_d: float) -> float:
    """Vena-contracta contraction coefficient for inlet rounding r/d (Nurick 1976)."""
    rd = max(0.0, float(r_over_d)) if np.isfinite(r_over_d) else 0.0
    inv2 = 1.0 / NURICK_CC0 ** 2 - NURICK_RD_GAIN * rd
    return float(min(0.98, 1.0 / math.sqrt(inv2))) if inv2 > 1.0 / 0.98 ** 2 else 0.98


def cavitation_margin(*, P_in: float, Pc: float, Pv: float, Cd: float, r_over_d: float = 0.0) -> Dict[str, float]:
    """K, K_crit = (Cd/Cc)^2 and their ratio for one orifice. Ratio < 1 means it cavitates."""
    Cc = contraction_coefficient(r_over_d)
    dp = float(P_in) - float(Pc)
    if not (np.isfinite(dp) and dp > 0 and np.isfinite(Cd) and Cd > 0):
        return {"K": float("nan"), "K_crit": float("nan"), "margin": float("nan"), "Cc": Cc, "Pv": float(Pv)}
    K = (float(P_in) - float(Pv)) / dp
    K_crit = (float(Cd) / Cc) ** 2
    return {"K": K, "K_crit": K_crit, "margin": K / K_crit, "Cc": Cc, "Pv": float(Pv)}


def inlet_radius_ratio_of(config) -> float:
    """r/d a discharge block describes: inlet_radius_ratio, else the named inlet's, else 0 (sharp)."""
    rd = getattr(config, "inlet_radius_ratio", None)
    if rd is not None and np.isfinite(float(rd)):
        return float(rd)
    name = getattr(config, "inlet_geometry", None)
    return float(INLET_GEOMETRY_RD.get(str(name).strip().lower(), 0.0)) if name else 0.0
