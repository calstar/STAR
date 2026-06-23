"""Keep burn-time fields aligned across config sections."""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from engine.pipeline.config_schemas import PintleEngineConfig


def canonical_burn_time_s(config: "PintleEngineConfig") -> Optional[float]:
    """Return the authoritative burn time [s] from config.

    Priority: design_requirements.target_burn_time, then pressure_curves.target_burn_time_s,
    then thrust.burn_time.
    """
    dr = getattr(config, "design_requirements", None)
    if dr is not None and getattr(dr, "target_burn_time", None) is not None:
        return float(dr.target_burn_time)

    pc = getattr(config, "pressure_curves", None)
    if pc is not None and getattr(pc, "target_burn_time_s", None) is not None:
        return float(pc.target_burn_time_s)

    thrust = getattr(config, "thrust", None)
    if thrust is not None and getattr(thrust, "burn_time", None) is not None:
        return float(thrust.burn_time)

    return None


def sync_burn_time_fields(config: "PintleEngineConfig") -> None:
    """In-place: set all present burn-time slots to the canonical value."""
    bt = canonical_burn_time_s(config)
    if bt is None:
        return

    dr = getattr(config, "design_requirements", None)
    if dr is not None:
        dr.target_burn_time = bt

    thrust = getattr(config, "thrust", None)
    if thrust is not None:
        thrust.burn_time = bt

    pc = getattr(config, "pressure_curves", None)
    if pc is not None:
        pc.target_burn_time_s = bt
