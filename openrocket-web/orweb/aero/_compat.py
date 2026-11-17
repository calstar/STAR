"""Adapters between the aerodynamics and the orweb component model.

Not a port: this is where orweb.aero meets ``orweb``'s component classes. The
calcs are written against OpenRocket's accessor names in snake_case and call
them directly where the model has them; everything here is either a type test
(``instanceof`` in Java) or a shim for an accessor the model spells differently
or lacks. Each shim says which Java method it stands in for.
"""

from __future__ import annotations

import math

from .coordinate import Coordinate, Transformation, IDENTITY, as_coordinate

# --------------------------------------------------------------------- types

# OpenRocket class -> the subclasses that count as one (for models that do not
# mirror OpenRocket's inheritance, or name a class differently).
_ALIASES = {
    "SymmetricComponent": {"SymmetricComponent", "BodyTube", "Transition", "NoseCone"},
    "Transition": {"Transition", "NoseCone"},
    "BodyTube": {"BodyTube"},
    "NoseCone": {"NoseCone"},
    "FinSet": {"FinSet", "TrapezoidFinSet", "EllipticalFinSet", "FreeformFinSet"},
    "TubeFinSet": {"TubeFinSet"},
    "LaunchLug": {"LaunchLug"},
    "RailButton": {"RailButton"},
    "Tube": {"Tube", "LaunchLug", "TubeFinSet"},
    "ComponentAssembly": {"ComponentAssembly", "Rocket", "AxialStage", "ParallelStage", "PodSet"},
    "AxialStage": {"AxialStage", "ParallelStage"},
    "ParallelStage": {"ParallelStage"},
    "PodSet": {"PodSet"},
    "Rocket": {"Rocket"},
    "ExternalComponent": {"ExternalComponent", "BodyTube", "Transition", "NoseCone", "FinSet",
                          "TrapezoidFinSet", "EllipticalFinSet", "FreeformFinSet", "TubeFinSet",
                          "LaunchLug", "RailButton"},
}


def class_names(c) -> set[str]:
    return {k.__name__ for k in type(c).__mro__}


def is_a(c, java_class: str) -> bool:
    """``c instanceof <java_class>``."""
    if c is None:
        return False
    names = class_names(c)
    return bool(names & _ALIASES.get(java_class, {java_class}))


def name_of(c) -> str:
    if c is None:
        return "None"
    get = getattr(c, "get_name", None)
    if callable(get):
        return str(get())
    return str(getattr(c, "name", type(c).__name__))


def id_of(c) -> str:
    get = getattr(c, "get_id", None)
    if callable(get):
        return str(get())
    return str(getattr(c, "id", id(c)))


def _call(c, *names, default=None):
    for n in names:
        f = getattr(c, n, None)
        if callable(f):
            return f()
        if f is not None and not callable(f):
            return f
    return default


# ----------------------------------------------------------- tree / position

def get_parent(c):
    return _call(c, "get_parent", "parent")


def get_children(c):
    ch = _call(c, "get_children", "children", default=[])
    return list(ch)


def is_aerodynamic(c) -> bool:
    return bool(_call(c, "is_aerodynamic", default=False))


def get_component_locations(c) -> list[Coordinate]:
    """RocketComponent.getComponentLocations(): absolute position of each instance."""
    return [as_coordinate(p) for p in c.get_component_locations()]


def to_absolute_x(c, local: Coordinate) -> float:
    """RocketComponent.toAbsolute(c)[0].x."""
    return get_component_locations(c)[0].x + local.x


def to_relative_x(c, local: Coordinate, dest) -> float:
    """RocketComponent.toRelative(c, dest)[0].x."""
    return get_component_locations(c)[0].x + local.x - get_component_locations(dest)[0].x


def axial_offset_absolute(c) -> float:
    """RocketComponent.getAxialOffset(AxialMethod.ABSOLUTE)."""
    return get_component_locations(c)[0].x


def get_position(c) -> Coordinate:
    """RocketComponent.getPosition(): offset of the component's front from its parent's."""
    return as_coordinate(c.get_position())


def get_instance_count(c) -> int:
    return int(_call(c, "get_instance_count", default=1))


def get_instance_offsets(c) -> list[Coordinate]:
    f = getattr(c, "get_instance_offsets", None)
    if not callable(f):  # shim: RocketComponent default, one instance at the origin
        return [Coordinate(0.0, 0.0, 0.0)] * get_instance_count(c)
    return [as_coordinate(p) for p in f()]


def get_instance_angles(c) -> list[float]:
    f = getattr(c, "get_instance_angles", None)
    if not callable(f):  # shim: RocketComponent default, no rotation
        return [0.0] * get_instance_count(c)
    return [float(a) for a in f()]


# ------------------------------------------------------------------ drag flags

def is_cd_overridden(c) -> bool:
    return bool(_call(c, "is_cd_overridden", default=False))


def is_cd_overridden_by_ancestor(c) -> bool:
    return bool(_call(c, "is_cd_overridden_by_ancestor", default=False))


def get_override_cd(c) -> float:
    return float(_call(c, "get_override_cd", default=0.0))


# Finish.getRoughnessSize() (ExternalComponent.Finish), by enum name
FINISH_ROUGHNESS = {
    "ROUGH": 500.0e-6,
    "ROUGHUNFINISHED": 250.0e-6,
    "UNFINISHED": 150.0e-6,
    "NORMAL": 60.0e-6,
    "SMOOTH": 20.0e-6,
    "OPTIMUM": 5.0e-6,
    "POLISHED": 2.0e-6,
}
FINISH_ORDER = list(FINISH_ROUGHNESS)


def _enum_name(v) -> str:
    if isinstance(v, str):
        return v.upper()
    n = getattr(v, "name", None)
    if isinstance(n, str):
        return n.upper()
    return str(v).split(".")[-1].upper()


def finish_key(c) -> str:
    return _enum_name(c.get_finish())


def finish_roughness(c) -> float:
    f = c.get_finish()
    for attr in ("get_roughness_size", "roughness_size"):
        v = getattr(f, attr, None)
        if v is not None:
            return float(v() if callable(v) else v)
    return FINISH_ROUGHNESS[_enum_name(f)]


def shape_type(c) -> str:
    """Transition.getShapeType() as its enum name (CONICAL, OGIVE, ...)."""
    return _enum_name(c.get_shape_type())


def cross_section(c) -> str:
    """FinSet.getCrossSection() as its enum name (SQUARE, ROUNDED, AIRFOIL)."""
    return _enum_name(c.get_cross_section())


def fin_points(c, with_root: bool = False) -> list[Coordinate]:
    pts = c.get_fin_points_with_root() if with_root else c.get_fin_points()
    return [as_coordinate(p) for p in pts]


# ------------------------------------------------------- symmetric neighbours

def previous_symmetric(c):
    return c.get_previous_symmetric_component()


def next_symmetric(c):
    return c.get_next_symmetric_component()


# -------------------------------------------------------------- configuration

def get_rocket(config):
    return config.get_rocket()


def is_stage_active(config, stage_number) -> bool:
    return bool(config.is_stage_active(stage_number))


def is_component_active(config, c) -> bool:
    return bool(config.is_component_active(c))


def get_stage_number(c) -> int:
    return int(c.get_stage_number())


def get_top_level_child_stages(c):
    return list(c.get_top_level_child_stages())


class InstanceContext:
    __slots__ = ("component", "instance_number", "transform")

    def __init__(self, component, instance_number: int, transform: Transformation):
        self.component = component
        self.instance_number = instance_number
        self.transform = transform


def active_instances(config) -> dict:
    """FlightConfiguration.getActiveInstances() (updateActiveInstances /
    getActiveContextListAt), rebuilt here so the transform -- whose x-rotation
    the fin calc reads -- is OpenRocket's matrix product exactly.

    Returns {component: [InstanceContext]} in depth-first tree order.
    """
    results: dict = {}

    def walk(component, parent_transform: Transformation) -> None:
        count = get_instance_count(component)
        offsets = get_instance_offsets(component)
        angles = get_instance_angles(component)
        comp_loc = Transformation.get_translation_transform(get_position(component))
        component_transform = parent_transform.apply_transformation(comp_loc)
        active = is_component_active(config, component)
        for n in range(count):
            offset_t = Transformation.get_translation_transform(offsets[n])
            angle_t = Transformation.get_axial_rotation(angles[n])
            current = component_transform.apply_transformation(offset_t).apply_transformation(angle_t)
            if active:
                results.setdefault(component, []).append(InstanceContext(component, n, current))
            for child in get_children(component):
                walk(child, current)

    walk(get_rocket(config), IDENTITY)
    return results


def all_components(config):
    """FlightConfiguration.getAllComponents(): every component, depth first."""
    f = getattr(config, "get_all_components", None)
    if callable(f):
        return list(f())
    out = []

    def walk(c):
        out.append(c)
        for ch in get_children(c):
            walk(ch)

    walk(get_rocket(config))
    return out


def active_components(config):
    f = getattr(config, "get_active_components", None)
    if callable(f):
        return list(f())
    return [c for c in all_components(config) if is_component_active(config, c)]


def nan_to(v: float, d: float = 0.0) -> float:
    return d if math.isnan(v) else v
