"""Injector discharge coefficient model Cd(Re, orifice geometry).

Cd_inf baseline follows thin-plate sharp-orifice data (ASME / ISO 5167: Cd ≈ 0.60–0.61
at high Re). For impinging doublets, LOX and fuel use the same correlation keyed to
jet diameter d_jet; propellant-specific discharge configs only change baseline/a_Re
when explicitly set — not legacy pintle 0.40/0.65 defaults.
"""

from __future__ import annotations

import math
from typing import Optional

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
