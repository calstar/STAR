"""The rocket document (docs/SCHEMA.md): JSON (de)serialisation and the mass analysis
the API serves.

Not a port of one OpenRocket class: this is where the document meets the model.
The numbers it reports come from orweb.masscalc (MassCalculator, OpenRocket 24.12, GPLv3).
"""

from __future__ import annotations

import copy
import json
import math

from .build import build_rocket
from .config import get_motor_config
from .masscalc import calculate_burnout, calculate_launch, calculate_motor, calculate_structure, get_cm_analysis

DOCUMENT_VERSION = 1


def _clean(o):
    """NaN/inf -> None, recursively (JSON has no NaN)."""
    if isinstance(o, float):
        return None if (math.isnan(o) or math.isinf(o)) else o
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_clean(v) for v in o]
    return o


def document_to_json(doc: dict, indent: int | None = None) -> str:
    return json.dumps(_clean(doc), indent=indent)


def document_from_json(data) -> dict:
    """Parse and sanity-check a document (str, bytes or dict)."""
    doc = json.loads(data) if isinstance(data, (str, bytes, bytearray)) else copy.deepcopy(data)
    if not isinstance(doc, dict) or "rocket" not in doc:
        raise ValueError("a document needs a 'rocket'")
    if doc["rocket"].get("type") != "rocket":
        raise ValueError("the document's root component must have type 'rocket'")
    doc.setdefault("version", DOCUMENT_VERSION)
    doc.setdefault("motorConfigs", [])
    doc.setdefault("selectedConfig", next((c["id"] for c in doc["motorConfigs"] if c.get("default")), None))

    def check(c, path):
        for k in ("id", "type"):
            if not c.get(k):
                raise ValueError(f"component at {path} has no {k}")
        c.setdefault("name", "")
        c.setdefault("params", {})
        c.setdefault("children", [])
        for i, ch in enumerate(c["children"]):
            check(ch, f"{path}/{i}")
    check(doc["rocket"], "rocket")
    return doc


def configuration_for(rocket, config_id: str | None = None):
    """The flight configuration with this id (default: the document's selected one)."""
    if config_id is None:
        return rocket.get_selected_configuration()
    if config_id not in rocket.configurations:
        raise KeyError(f"no flight configuration {config_id!r}")
    return rocket.configurations[config_id]


def analysis_components(rocket, config=None) -> list[dict]:
    """SCHEMA Analysis.components, mass part: per active component, absolute x of its first
    instance, length, mass (as the mass calculation counts it: overrides applied, all
    instances) and absolute CG x (OpenRocket's component analysis, getCMAnalysis)."""
    config = config or rocket.get_selected_configuration()
    cm = get_cm_analysis(config)
    out = []
    for c in rocket.iterator(False):
        if not config.is_component_active(c):
            continue
        e = cm.get(c.id)
        locs = c.get_component_locations()
        out.append({
            "id": c.id, "name": c.get_name(), "type": _doc_type(c),
            "x": locs[0].x, "length": c.get_length(),
            "mass": None if e is None else e.each_mass * c.get_instance_count() if not _is_assembly(c) else e.each_mass,
            "eachMass": None if e is None else e.each_mass,
            "cgx": None if e is None else e.total_cm.x,
            "instances": len(locs),
        })
    return out


def _is_assembly(c) -> bool:
    from .components.assemblies import ComponentAssembly
    return isinstance(c, ComponentAssembly)


def _doc_type(c) -> str:
    from .components.assemblies import Rocket
    return "rocket" if isinstance(c, Rocket) else c.ORK_TYPE


def mass_properties(rocket, config=None) -> dict:
    """Everything the mass calculation says about a configuration.

    ``launch`` (motors loaded), ``structure`` (no motors, = SCHEMA cgEmpty), ``burnout``
    (motor casings) and ``motor`` (motors only) are RigidBody dicts: mass (kg), cgx/cgy/cgz (m,
    absolute from the nose tip), Ixx (roll) and Iyy = Izz (pitch/yaw) about the CG (kg m^2).
    ``components`` is per component; ``motors`` lists each active motor where it sits.
    """
    config = config or rocket.get_selected_configuration()
    launch = calculate_launch(config)
    motors = []
    for mc in config.get_active_motors():
        m = mc.get_motor()
        mount = mc.get_mount()
        motors.append({
            "mount": mount.id, "designation": m.get_designation(), "manufacturer": m.get_manufacturer(),
            "digest": m.get_digest(), "diameter": m.get_diameter(), "length": m.get_length(),
            "x": mc.get_x(), "count": mc.get_motor_count(),
            "absoluteX": [loc.x + mc.get_x() for loc in mount.get_component_locations()],
            "launchMass": m.get_launch_mass(), "burnoutMass": m.get_burnout_mass(),
            "ejectionDelay": None if math.isinf(mc.get_ejection_delay()) else mc.get_ejection_delay(),
        })
    return {
        "configId": config.get_id(),
        "launch": launch.to_dict(),
        "structure": calculate_structure(config).to_dict(),
        "burnout": calculate_burnout(config).to_dict(),
        "motor": calculate_motor(config).to_dict(),
        "cg": {"x": launch.cm.x, "mass": launch.cm.weight},
        "components": analysis_components(rocket, config),
        "motors": motors,
        "referenceLength": config.get_reference_length(),
        "lengthAerodynamic": config.get_length_aerodynamic(),
    }


def resolve_auto_values(doc: dict, rocket=None) -> dict:
    """A copy of the document with every ``{"auto": true, "value": null}`` filled with the
    value OpenRocket resolves it to (an "auto" ring radius, an automatic recovery CD).
    Values already present are kept: for "auto <value>" params the value is input."""
    rocket = rocket or build_rocket(doc)
    out = copy.deepcopy(doc)
    from .build import model_params

    def walk(dc):
        c = rocket.by_id.get(dc["id"])
        if c is not None:
            resolved = None
            for k, v in dc.get("params", {}).items():
                if isinstance(v, dict) and v.get("auto") and v.get("value") is None:
                    if resolved is None:
                        resolved = model_params(c)
                    rv = resolved.get(k)
                    if isinstance(rv, dict) and rv.get("value") is not None:
                        v["value"] = rv["value"]
        for ch in dc.get("children", []):
            walk(ch)
    walk(out["rocket"])
    return out
