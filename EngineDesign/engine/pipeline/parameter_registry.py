"""Every parameter a config carries, and what the schema says about it.

The Parameters workspace lists these: one row per leaf of ``PintleEngineConfig``, with its current
value, its schema default, whether it differs, its units (taken from the ``[unit]`` in its
description) and the description itself. It walks the pydantic models, so a field added to
``config_schemas.py`` appears here without anyone remembering to list it.

A block that is null in the config (``chamber: null``) is one row of kind ``block``; its fields
appear once it is set. Keys a config carries that the schema does not declare (models with
``extra="allow"``) are rows of kind ``undeclared``: they are passed through, so they are shown.
"""
from __future__ import annotations

import math
import re
from typing import Any, Dict, List, Optional, Tuple, Type, Union, get_args, get_origin

from pydantic import BaseModel
from pydantic_core import PydanticUndefined

_UNIT = re.compile(r"\[([^\[\]]{1,28})\]")
# A bracketed note such as "[DEPRECATED — no effect]" is not a unit.
_NOT_UNIT = re.compile(r"[A-Z]{4,}| — | - ")

#: Top-level sections in the order the workspace shows them, with the label it uses.
SECTIONS: List[Tuple[str, str]] = [
    ("design_requirements", "Requirements & optimizer"),
    ("fluids", "Propellants"),
    ("injector", "Injector"),
    ("discharge", "Discharge & Cd"),
    ("spray", "Spray & vaporisation"),
    ("combustion", "Combustion & CEA"),
    ("chamber_geometry", "Chamber & nozzle"),
    ("chamber", "Chamber (legacy)"),
    ("nozzle", "Nozzle (legacy)"),
    ("ablative_cooling", "Ablative liner"),
    ("graphite_insert", "Graphite insert"),
    ("stainless_steel_case", "Case"),
    ("regen_cooling", "Regenerative cooling"),
    ("film_cooling", "Film cooling"),
    ("stability", "Stability"),
    ("feed_system", "Feed system"),
    ("lox_tank", "LOX tank"),
    ("fuel_tank", "Fuel tank"),
    ("press_tank", "Pressurant"),
    ("rocket", "Vehicle"),
    ("environment", "Environment"),
    ("thrust", "Thrust profile"),
    ("pressure_curves", "Pressure curves"),
    ("solver", "Solver"),
    ("optimizer", "Optimizer"),
    ("propellant_preset", "Propellants"),
    ("design_valid_for", "Design state"),
]
_SECTION_LABEL = dict(SECTIONS)


def _models_in(annotation: Any) -> List[Type[BaseModel]]:
    """The BaseModel classes an annotation can hold (through Optional/Union)."""
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return [annotation]
    if get_origin(annotation) is Union:
        return [m for a in get_args(annotation) for m in _models_in(a)]
    return []


def _dict_value_model(annotation: Any) -> Optional[Type[BaseModel]]:
    """``Dict[str, Model]`` (possibly Optional) -> Model."""
    for a in ([annotation] + list(get_args(annotation)) if get_origin(annotation) is Union else [annotation]):
        if get_origin(a) in (dict, Dict):
            args = get_args(a)
            if len(args) == 2:
                ms = _models_in(args[1])
                if ms:
                    return ms[0]
    return None


def _type_name(annotation: Any) -> str:
    origin = get_origin(annotation)
    if origin is Union:
        parts = [a for a in get_args(annotation) if a is not type(None)]
        base = " | ".join(_type_name(a) for a in parts)
        return base + (" | null" if len(parts) < len(get_args(annotation)) else "")
    if origin is not None and getattr(origin, "__name__", "") == "Literal":
        return "enum"
    if str(annotation).startswith("typing.Literal") or getattr(annotation, "__origin__", None) is not None and "Literal" in str(annotation):
        return "enum"
    if origin in (list, List):
        return "list"
    if origin in (dict, Dict):
        return "dict"
    return getattr(annotation, "__name__", str(annotation))


def _choices(annotation: Any) -> Optional[List[Any]]:
    """Allowed values of a Literal (possibly Optional) annotation."""
    args = get_args(annotation) if get_origin(annotation) is Union else [annotation]
    out: List[Any] = []
    for a in args:
        if "Literal" in str(a):
            out.extend(get_args(a))
    return out or None


def _default(fi: Any) -> Any:
    if fi.default_factory is not None:
        try:
            v = fi.default_factory()
        except TypeError:
            return None
        return v.model_dump() if isinstance(v, BaseModel) else v
    return None if fi.default is PydanticUndefined else fi.default


def _plain(v: Any) -> Any:
    if isinstance(v, BaseModel):
        return v.model_dump()
    if isinstance(v, float) and not math.isfinite(v):
        return str(v)
    return v


def _differs(value: Any, default: Any) -> bool:
    if isinstance(value, float) and isinstance(default, (int, float)) and default is not None:
        return not math.isclose(value, float(default), rel_tol=1e-12, abs_tol=0.0)
    return _plain(value) != _plain(default)


def _leaf(path: str, section: str, fi: Any, value: Any) -> Dict[str, Any]:
    desc = (fi.description or "").strip()
    m = _UNIT.search(desc)
    default = _default(fi)
    required = fi.is_required()
    return {
        "path": path,
        "section": section,
        "kind": "field",
        "type": _type_name(fi.annotation),
        "choices": _choices(fi.annotation),
        "value": _plain(value),
        "default": default,
        "required": required,
        "modified": (not required) and _differs(value, default),
        "unit": m.group(1) if m and not _NOT_UNIT.search(m.group(1)) else None,
        "description": desc,
    }


def _walk(model: BaseModel, prefix: str, section: str, out: List[Dict[str, Any]]) -> None:
    cls = type(model)
    for name, fi in cls.model_fields.items():
        path = f"{prefix}{name}"
        value = getattr(model, name, None)
        dm = _dict_value_model(fi.annotation)
        if dm is not None:
            for key, sub in (value or {}).items():
                if isinstance(sub, BaseModel):
                    _walk(sub, f"{path}.{key}.", section, out)
            continue
        if _models_in(fi.annotation):
            if isinstance(value, BaseModel):
                _walk(value, f"{path}.", section, out)
            else:
                out.append({"path": path, "section": section, "kind": "block", "type": "block",
                            "value": None, "default": None, "modified": False, "unit": None,
                            "choices": None, "required": False,
                            "description": (fi.description or "").strip() or "not set"})
            continue
        out.append(_leaf(path, section, fi, value))
    for key, value in (model.model_extra or {}).items():
        out.append({"path": f"{prefix}{key}", "section": section, "kind": "undeclared",
                    "type": type(value).__name__, "value": _plain(value), "default": None,
                    "modified": False, "unit": None, "choices": None, "required": False,
                    "description": "not declared in the schema; passed through as written"})


def config_parameters(config: BaseModel) -> Dict[str, Any]:
    """All parameters of ``config`` (a PintleEngineConfig), grouped by section."""
    rows: List[Dict[str, Any]] = []
    for name, fi in type(config).model_fields.items():
        value = getattr(config, name, None)
        section = name
        dm = _dict_value_model(fi.annotation)
        if dm is not None:
            for key, sub in (value or {}).items():
                if isinstance(sub, BaseModel):
                    _walk(sub, f"{name}.{key}.", section, rows)
            continue
        if _models_in(fi.annotation):
            if isinstance(value, BaseModel):
                _walk(value, f"{name}.", section, rows)
            else:
                rows.append({"path": name, "section": section, "kind": "block", "type": "block",
                             "value": None, "default": None, "modified": False, "unit": None,
                             "choices": None, "required": False,
                             "description": (fi.description or "").strip() or "not set"})
            continue
        rows.append(_leaf(name, section, fi, value))
    order = {s: i for i, (s, _) in enumerate(SECTIONS)}
    sections = sorted({r["section"] for r in rows}, key=lambda s: order.get(s, len(order)))
    return {
        "sections": [{"key": s, "label": _SECTION_LABEL.get(s, s.replace("_", " ").capitalize()),
                      "count": sum(1 for r in rows if r["section"] == s),
                      "modified": sum(1 for r in rows if r["section"] == s and r["modified"])}
                     for s in sections],
        "parameters": rows,
    }
