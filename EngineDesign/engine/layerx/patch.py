"""An injector what-if on a private copy of the design: hole size, jet angle, passage L/d.

Shared by the router (a what-if run, a YAML export) and the trade study, which burns one per point.
"""

from __future__ import annotations

from typing import Any, Dict, Optional


def apply_design_patch(config: Any, patch: Optional[Dict[str, Dict[str, float]]]) -> Any:
    """A validated copy of ``config`` with the injector what-if written in. ``config`` is untouched."""
    if not patch:
        return config
    from engine.pipeline.config_schemas import PintleEngineConfig

    raw = config.model_dump()
    for side, fields in patch.items():
        geo = raw["injector"]["geometry"][side]
        for key in ("d_jet", "impingement_angle"):
            if key in fields:
                geo[key] = float(fields[key])
        if "orifice_l_over_d" in fields:
            raw["discharge"][side]["orifice_l_over_d"] = float(fields["orifice_l_over_d"])
    return PintleEngineConfig(**raw)
