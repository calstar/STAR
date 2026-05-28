"""Layer 2 max propellant mass [kg] from tank volume and config fluid densities."""

from __future__ import annotations

from typing import Optional, Tuple

import numpy as np

from engine.pipeline.config_schemas import PintleEngineConfig


def _tank_volume_m3_lox(config: PintleEngineConfig) -> Optional[float]:
    t = config.lox_tank
    if t is None:
        return None
    v = getattr(t, "tank_volume_m3", None)
    if v is not None:
        vf = float(v)
        if vf > 0:
            return vf
    try:
        r, h = float(t.lox_radius), float(t.lox_h)
        if r > 0 and h > 0:
            return float(np.pi * r * r * h)
    except (TypeError, ValueError, AttributeError):
        pass
    return None


def _tank_volume_m3_fuel(config: PintleEngineConfig) -> Optional[float]:
    t = config.fuel_tank
    if t is None:
        return None
    v = getattr(t, "tank_volume_m3", None)
    if v is not None:
        vf = float(v)
        if vf > 0:
            return vf
    try:
        r, h = float(t.rp1_radius), float(t.rp1_h)
        if r > 0 and h > 0:
            return float(np.pi * r * r * h)
    except (TypeError, ValueError, AttributeError):
        pass
    return None


def _branch_density_kg_m3(config: PintleEngineConfig, branch: str) -> Optional[float]:
    try:
        f = config.fluids.get(branch)
        if f is None:
            return None
        rho = float(f.density)
        return rho if rho > 0 else None
    except (TypeError, ValueError, AttributeError, KeyError):
        return None


def max_propellant_capacity_kg_from_config(
    config: PintleEngineConfig,
) -> Tuple[Optional[float], Optional[float]]:
    """
    Liquid-full propellant mass [kg] per tank: tank volume × branch fluid density.

    Volume: ``tank_volume_m3`` if set, else π r² h from ``lox_tank`` / ``fuel_tank``.
    Density: ``fluids['oxidizer'].density`` (LOX) and ``fluids['fuel'].density`` (fuel).

    Returns ``(lox_kg, fuel_kg)``; either entry may be ``None`` if volume or density is missing.
    """
    rho_o = _branch_density_kg_m3(config, "oxidizer")
    rho_f = _branch_density_kg_m3(config, "fuel")
    v_o = _tank_volume_m3_lox(config)
    v_f = _tank_volume_m3_fuel(config)
    m_lox = float(v_o * rho_o) if (v_o is not None and rho_o is not None) else None
    m_fuel = float(v_f * rho_f) if (v_f is not None and rho_f is not None) else None
    return m_lox, m_fuel


def resolve_layer2_tank_capacities_kg(
    config: PintleEngineConfig,
    *,
    design_lox_kg: Optional[float] = None,
    design_fuel_kg: Optional[float] = None,
    default_lox_kg: float = 20.0,
    default_fuel_kg: float = 10.0,
) -> Tuple[float, float]:
    """
    Prefer physical capacity from ``tank_volume_m3`` (or geometry) × ``fluids`` density;
    else ``design_*_kg`` if given; else numeric defaults.
    """
    from_vol, from_vol_f = max_propellant_capacity_kg_from_config(config)

    lox = float(from_vol) if from_vol is not None else None
    fuel = float(from_vol_f) if from_vol_f is not None else None

    if lox is None and design_lox_kg is not None:
        try:
            v = float(design_lox_kg)
            if v > 0:
                lox = v
        except (TypeError, ValueError):
            pass
    if fuel is None and design_fuel_kg is not None:
        try:
            v = float(design_fuel_kg)
            if v > 0:
                fuel = v
        except (TypeError, ValueError):
            pass

    if lox is None:
        lox = float(default_lox_kg)
    if fuel is None:
        fuel = float(default_fuel_kg)
    return lox, fuel
