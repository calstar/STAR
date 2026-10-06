"""Measured values in place of the model's assumptions.

``apply_measurements(cfg)`` returns a copy of the config with every measurement written where the
assumed number used to enter, so every caller of the engine (forward mode, Time-Series, Layer 1)
uses it without knowing it exists. ``calibration_state(cfg)`` says, per forward-mode calibration
key, whether it is measured and by what.

  cd_O, cd_F         discharge.<side>: a fixed Cd (the discharge model's Re and inlet terms off)
  em                 combustion.efficiency: rupe_Em_opt = E_m, curvature 0 (E_m flat in M)
  d32_O_um, d32_F_um spray.smd.d32_measured_*: held at the measured value
  nozzle_efficiency  chamber_geometry.nozzle_efficiency
  chug_frequency_hz  reference only: forward mode shows it beside the model's
"""
from __future__ import annotations

from typing import Any, Dict


def _m(cfg: Any, key: str):
    ms = getattr(cfg, "measurements", None)
    return getattr(ms, key, None) if ms is not None else None


def apply_measurements(cfg: Any) -> Any:
    """A copy of ``cfg`` with its measurements applied; ``cfg`` itself when it has none."""
    if getattr(cfg, "measurements", None) is None:
        return cfg
    c = cfg.model_copy(deep=True)
    for k, side in (("cd_O", "oxidizer"), ("cd_F", "fuel")):
        mv = _m(c, k)
        if mv is not None:
            cd = float(mv.value)
            c.discharge[side] = c.discharge[side].model_copy(update={
                "inlet_geometry": None, "inlet_radius_ratio": None, "use_geometry_cd": False,
                "Cd_inf": cd, "Cd_min": cd, "a_Re": 0.0, "cd_inf_max": cd, "cd_inf_min_geom": cd})
    em = _m(c, "em")
    if em is not None:
        c.combustion.efficiency.rupe_Em_opt = float(em.value)
        c.combustion.efficiency.rupe_Em_curvature = 0.0
    for k, f in (("d32_O_um", "d32_measured_O"), ("d32_F_um", "d32_measured_F")):
        mv = _m(c, k)
        if mv is not None:
            setattr(c.spray.smd, f, float(mv.value) * 1e-6)
    zn = _m(c, "nozzle_efficiency")
    if zn is not None and getattr(c, "chamber_geometry", None) is not None:
        c.chamber_geometry.nozzle_efficiency = float(zn.value)
    return c


#: Forward-mode calibration key -> the measurements that close it (all of them needed).
CLOSES = {
    "cd": ("cd_O", "cd_F"),
    "em": ("em",),
    "smd": ("d32_O_um", "d32_F_um"),
    "nozzle": ("nozzle_efficiency",),
}


def calibration_state(cfg: Any) -> Dict[str, Dict[str, Any]]:
    """Per calibration key: ``{"state": "measured"|"partial"|"assumed", "sources": [...]}``."""
    out: Dict[str, Dict[str, Any]] = {}
    for key, needs in CLOSES.items():
        got = [(n, _m(cfg, n)) for n in needs]
        have = [(n, mv) for n, mv in got if mv is not None]
        state = "measured" if len(have) == len(needs) else ("partial" if have else "assumed")
        out[key] = {"state": state, "sources": [f"{n}: {mv.value:g} ({mv.source})" for n, mv in have]}
    return out
