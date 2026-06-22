"""Propellant tank capacity helpers for flight simulation.

Max loadable propellant mass is resolved from config — not a hardcoded fill fraction.
Priority:
  1. design_requirements.{lox,fuel}_tank_capacity_kg (explicit mass cap)
  2. tank_volume_m3 × density × fill_factor
  3. π r² h × density × fill_factor

Fill factor comes from design_requirements.propellant_tank_fill_factor (default 0.90).
"""

from __future__ import annotations

import math
from typing import Any, Optional, Tuple

DEFAULT_PROPELLANT_TANK_FILL_FACTOR = 0.90


def resolve_propellant_tank_fill_factor(config: Any) -> float:
    """Fill fraction of internal tank volume used for flight-sim mass caps (0–1)."""
    dr = getattr(config, "design_requirements", None)
    if dr is not None:
        ff = getattr(dr, "propellant_tank_fill_factor", None)
        if ff is not None:
            val = float(ff)
            if 0.0 < val <= 1.0:
                return val
    return DEFAULT_PROPELLANT_TANK_FILL_FACTOR


def resolve_cylindrical_tank_volume_m3(
    tank_section: Any,
    *,
    height_attr: str,
    radius_attr: str,
) -> float:
    if tank_section is None:
        raise ValueError("Tank section missing from config")

    explicit = getattr(tank_section, "tank_volume_m3", None)
    if explicit is not None and float(explicit) > 0:
        return float(explicit)

    height = getattr(tank_section, height_attr, None)
    radius = getattr(tank_section, radius_attr, None)
    if height is None or radius is None:
        raise ValueError(
            f"Tank volume undefined: set tank_volume_m3 or {height_attr}/{radius_attr}"
        )
    return float(math.pi * float(radius) ** 2 * float(height))


def resolve_max_propellant_mass_kg(
    config: Any,
    *,
    branch: str,
    density_kg_m3: float,
    tank_section: Any,
    height_attr: str,
    radius_attr: str,
    capacity_kg_attr: str,
) -> Tuple[float, float, float, bool]:
    """Return (max_mass_kg, volume_m3, fill_factor, used_explicit_capacity).

    If design_requirements.{branch}_tank_capacity_kg is set, that mass is used directly
    (fill_factor still reported for diagnostics).
    """
    fill_factor = resolve_propellant_tank_fill_factor(config)
    volume_m3 = resolve_cylindrical_tank_volume_m3(
        tank_section, height_attr=height_attr, radius_attr=radius_attr
    )

    dr = getattr(config, "design_requirements", None)
    explicit_cap: Optional[float] = None
    if dr is not None:
        raw = getattr(dr, capacity_kg_attr, None)
        if raw is not None and float(raw) > 0:
            explicit_cap = float(raw)

    if explicit_cap is not None:
        return explicit_cap, volume_m3, fill_factor, True

    max_mass = volume_m3 * float(density_kg_m3) * fill_factor
    return max_mass, volume_m3, fill_factor, False


def resolve_lox_tank_limits(config: Any, density_kg_m3: float) -> Tuple[float, float, float, bool]:
    return resolve_max_propellant_mass_kg(
        config,
        branch="lox",
        density_kg_m3=density_kg_m3,
        tank_section=getattr(config, "lox_tank", None),
        height_attr="lox_h",
        radius_attr="lox_radius",
        capacity_kg_attr="lox_tank_capacity_kg",
    )


def resolve_fuel_tank_limits(config: Any, density_kg_m3: float) -> Tuple[float, float, float, bool]:
    return resolve_max_propellant_mass_kg(
        config,
        branch="fuel",
        density_kg_m3=density_kg_m3,
        tank_section=getattr(config, "fuel_tank", None),
        height_attr="rp1_h",
        radius_attr="rp1_radius",
        capacity_kg_attr="fuel_tank_capacity_kg",
    )
