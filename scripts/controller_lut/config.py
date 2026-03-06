from __future__ import annotations

from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml


@dataclass
class LUTAxisConfig:
    """
    Configuration for a single LUT axis.

    The `name` should match a physical or controller variable. For interoperability
    with existing controller / engine_sim code, the following names are
    recommended for axes:

    - Pressures (Pa): ``P_copv``, ``P_reg``, ``P_u_fuel``, ``P_u_ox``,
      ``P_d_fuel``, ``P_d_ox``
    - Navigation: ``h`` (altitude [m]), ``vz`` (vertical velocity [m/s]),
      ``theta`` (tilt [rad]), ``mass_estimate`` [kg]
    - Commands: ``thrust_desired`` [N], ``altitude_goal`` [m]
    """

    name: str
    values: List[float]
    units: str = ""
    description: str = ""


@dataclass
class ControllerLUTConfig:
    """
    High-dimensional controller LUT configuration.

    This describes:
    - Which axes (state / command variables) span the LUT
    - Which engine/controller quantities are stored as outputs
    - Where to find the underlying engine configuration
    """

    axes: List[LUTAxisConfig]
    outputs: List[str]
    engine_config_path: str
    controller_config_path: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_yaml(cls, path: str | Path) -> "ControllerLUTConfig":
        """Load a LUT configuration from a YAML file."""
        path = Path(path)
        with path.open("r") as f:
            raw: Dict[str, Any] = yaml.safe_load(f)

        axes_cfg = [
            LUTAxisConfig(
                name=a["name"],
                values=list(a["values"]),
                units=a.get("units", ""),
                description=a.get("description", ""),
            )
            for a in raw.get("axes", [])
        ]

        return cls(
            axes=axes_cfg,
            outputs=list(raw.get("outputs", [])),
            engine_config_path=str(raw["engine_config_path"]),
            controller_config_path=raw.get("controller_config_path"),
            metadata=dict(raw.get("metadata", {})),
        )

    def to_dict(self) -> Dict[str, Any]:
        """Convert to a plain dict suitable for JSON/YAML serialization."""
        data = asdict(self)
        # Flatten axes dataclasses to simple dicts
        data["axes"] = [asdict(axis) for axis in self.axes]
        return data
