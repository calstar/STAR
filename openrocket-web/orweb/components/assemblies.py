"""Assemblies: the rocket, its stages, boosters and pods.

Ported from OpenRocket 24.12 (GPLv3): info.openrocket.core.rocketcomponent.ComponentAssembly,
Rocket, AxialStage, ParallelStage, PodSet.
"""

from __future__ import annotations

import math

from ..util import mathutil as mu
from ..util.coordinate import ZERO, Coordinate
from .base import RocketComponent
from .position import AngleMethod, AxialMethod, RadiusMethod


#: FlightConfigurationId.DEFAULT_VALUE_UUID (new UUID(0xFFFFFFFFF4F2F1F0L, 5676))
DEFAULT_CONFIG_ID = "ffffffff-f4f2-f1f0-0000-00000000162c"


class ComponentAssembly(RocketComponent):
    def __init__(self, axial_method: AxialMethod = AxialMethod.AFTER):
        super().__init__(axial_method)

    def allows_children(self) -> bool:
        return True

    def get_axial_offset(self, as_method: AxialMethod | None = None) -> float:
        if as_method is None:
            return RocketComponent.get_axial_offset(self, self.axial_method)
        return RocketComponent.get_axial_offset(self, as_method)

    def get_component_cg(self) -> Coordinate:
        return ZERO

    def get_component_mass(self) -> float:
        return 0.0

    def get_longitudinal_unit_inertia(self) -> float:
        return 0.0

    def get_rotational_unit_inertia(self) -> float:
        return 0.0

    def is_aerodynamic(self) -> bool:
        return False

    def is_massive(self) -> bool:
        return False

    def is_axisymmetric(self) -> bool:
        return not (2 == self.get_instance_count())

    def get_bounding_radius(self) -> float:
        from .symmetric import BodyTube, Transition
        outer = 0.0
        for comp in self.children:
            r = 0.0
            if isinstance(comp, BodyTube):
                r = comp.get_outer_radius()
            elif isinstance(comp, Transition):
                r = max(comp.get_fore_radius(), comp.get_aft_radius())
            outer = max(outer, r)
        return outer

    def get_instance_bounding_box(self):
        from ..util.coordinate import BoundingBox
        return BoundingBox()

    def set_axial_offset(self, pos: float) -> None:
        self.update_bounds()
        self._set_axial_offset(self.axial_method, pos)
        self._fire()

    def set_axial_method(self, new_method: AxialMethod) -> None:
        if self.parent is None:
            raise ValueError("a Stage requires a parent before any positioning!")
        if isinstance(self, (ParallelStage, PodSet)):
            if new_method is AxialMethod.AFTER:
                RocketComponent.set_axial_method(self, AxialMethod.TOP)
            else:
                RocketComponent.set_axial_method(self, new_method)
        elif type(self) is AxialStage:
            RocketComponent.set_axial_method(self, AxialMethod.AFTER)
        else:
            raise ValueError("Unrecognized subclass of Component Assembly.")

    def update(self) -> None:
        self.update_bounds()
        if self.is_after():
            self.set_after()
        else:
            RocketComponent.update(self)
        self.update_child_sequence()

    def update_bounds(self) -> None:
        self.length = 0.0
        for c in self.children:
            if c.is_after():
                self.length += c.get_length()

    def update_child_sequence(self) -> None:
        for c in self.children:
            if c.get_axial_method() is AxialMethod.AFTER:
                c.set_after()


class Rocket(ComponentAssembly):
    ORK_TYPE = "rocket"
    DEFAULT_REFERENCE_LENGTH = 0.01

    def __init__(self):
        super().__init__(AxialMethod.ABSOLUTE)
        from ..config import FlightConfiguration
        self.events_enabled = False
        self.reference_type = "maximum"  # ReferenceType: nosecone | maximum | custom
        self.custom_reference_length = self.DEFAULT_REFERENCE_LENGTH
        self.stage_map: dict[int, AxialStage] = {}
        # FlightConfigurationId.DEFAULT_VALUE_FCID: the configuration with no motors
        self.default_configuration = FlightConfiguration(self, DEFAULT_CONFIG_ID)
        self.configurations: dict[str, FlightConfiguration] = {}
        self.selected_configuration = self.default_configuration

    def get_component_name(self) -> str:
        return "Rocket"

    def is_compatible(self, component) -> bool:
        return type(component) is AxialStage

    # -- events ------------------------------------------------------------------
    def enable_events(self) -> None:
        if self.events_enabled:
            return
        self.events_enabled = True
        self._fire_event()

    def _fire_event(self) -> None:
        if not self.events_enabled:
            return
        for c in self.iterator(True):
            c.component_changed()

    # -- position ----------------------------------------------------------------
    def set_axial_method(self, new_method: AxialMethod) -> None:
        self.axial_method = AxialMethod.ABSOLUTE

    def set_axial_offset(self, pos: float) -> None:
        self.axial_offset = 0.0
        self.position = ZERO

    def get_stage_number(self) -> int:
        return -1

    def get_length(self) -> float:
        return self.selected_configuration.get_length()

    # -- stages --------------------------------------------------------------------
    def get_stage_count(self) -> int:
        return len(self.stage_map)

    def get_stage_list(self):
        return [self.stage_map[k] for k in sorted(self.stage_map)]

    def get_stage(self, stage_number=None):  # type: ignore[override]
        if stage_number is None:
            return RocketComponent.get_stage(self)
        return self.stage_map.get(stage_number)

    def track_stage(self, new_stage: "AxialStage") -> None:
        n = new_stage.get_stage_number()
        value = self.stage_map.get(n)
        if value is new_stage:
            return
        guess = 0
        while guess in self.stage_map:
            guess += 1
        new_stage.set_stage_number(guess)
        self.stage_map[guess] = new_stage

    def forget_stage(self, old_stage: "AxialStage") -> None:
        self.stage_map.pop(old_stage.get_stage_number(), None)

    def update(self) -> None:
        # updateStageNumbers, updateStageMap (updateConfigurations is FlightConfiguration's)
        for i, stage in enumerate(self.get_sub_stages()):
            self.forget_stage(stage)
            stage.set_stage_number(i)
        for stage in self.get_sub_stages():
            self.track_stage(stage)

    def get_bounding_radius(self) -> float:
        b = 0.0
        for c in self.children:
            if isinstance(c, ComponentAssembly):
                b = max(b, c.get_bounding_radius())
        return b

    # -- reference / configurations --------------------------------------------------
    def get_reference_type(self) -> str:
        return self.reference_type

    def get_custom_reference_length(self) -> float:
        return self.custom_reference_length

    def set_custom_reference_length(self, length: float) -> None:
        if mu.equals(self.custom_reference_length, length):
            return
        self.custom_reference_length = max(length, 0.001)

    def get_selected_configuration(self):
        return self.selected_configuration

    def get_flight_configuration(self, fcid: str):
        return self.configurations.get(fcid, self.default_configuration)

    def create_flight_configuration(self, fcid: str):
        from ..config import FlightConfiguration
        if fcid in self.configurations:
            return self.configurations[fcid]
        cfg = FlightConfiguration(self, fcid)
        self.configurations[fcid] = cfg
        return cfg

    def set_selected_configuration(self, fcid: str) -> None:
        self.selected_configuration = self.configurations.get(fcid, self.default_configuration)

    def get_bottom_core_stage(self, config):
        for c in reversed(self.children):
            if isinstance(c, AxialStage) and config.is_stage_active(c.get_stage_number()):
                return c
        return None


class AxialStage(ComponentAssembly):
    ORK_TYPE = "stage"

    def __init__(self):
        super().__init__(AxialMethod.AFTER)
        self.stage_number = 0

    def get_component_name(self) -> str:
        return "Stage"

    def is_compatible(self, component) -> bool:
        from .external import BodyComponent
        return isinstance(component, BodyComponent)

    def get_stage_number(self) -> int:
        return self.stage_number

    def set_stage_number(self, n: int) -> None:
        self.stage_number = n

    def is_after(self) -> bool:
        return True


class ParallelStage(AxialStage):
    ORK_TYPE = "parallelstage"

    def __init__(self, count: int = 2):
        super().__init__()
        self.instance_count = count
        self.axial_method = AxialMethod.BOTTOM
        self.angle_separation = math.pi * 2 / self.instance_count
        self.angle_method = AngleMethod.RELATIVE
        self.angle_offset = 0.0
        self.radius_method = RadiusMethod.RELATIVE
        self.radius_offset = 0.0

    def get_component_name(self) -> str:
        return "Boosters"

    def is_after(self) -> bool:
        return False

    def get_instance_count(self) -> int:
        return self.instance_count

    def set_instance_count(self, n: int) -> None:
        if n < 1:
            return
        self.instance_count = n
        self.angle_separation = math.pi * 2 / self.instance_count
        self._fire()

    def get_angle_offset(self) -> float:
        return self.angle_offset

    def set_angle_offset(self, angle: float) -> None:
        self.angle_offset = mu.reduce_pi(angle)
        self._fire()

    def get_angle_method(self) -> AngleMethod:
        return self.angle_method

    def set_angle_method(self, m: AngleMethod) -> None:
        self.angle_method = m
        self._fire()

    def get_radius_offset(self, method=None) -> float:
        if method is not None:
            return RocketComponent.get_radius_offset(self, method)
        return self.radius_offset

    def get_radius_method(self) -> RadiusMethod:
        return self.radius_method

    def set_radius_offset(self, r: float) -> None:
        if r == self.radius_offset:
            return
        self.radius_offset = 0.0 if self.radius_method.clamp_to_zero() else r
        self._fire()

    def set_radius(self, method: RadiusMethod, radius: float) -> None:
        new_r = 0.0 if method.clamp_to_zero() else radius
        self.radius_method = method
        self.radius_offset = method.get_as_offset(self.parent, self, new_r)
        self._fire()

    def set_radius_method(self, method: RadiusMethod) -> None:
        if method is self.radius_method:
            return
        r = self.radius_method.get_radius(self.parent, self, self.radius_offset)
        self.set_radius(method, r)

    def get_instance_angle_increment(self) -> float:
        return self.angle_separation

    def get_instance_angles(self) -> list[float]:
        base = self.get_angle_offset()
        inc = self.get_instance_angle_increment()
        return [base + inc * i for i in range(self.get_instance_count())]

    def get_instance_offsets(self) -> list[Coordinate]:
        radius = self.radius_method.get_radius(self.parent, self, self.radius_offset)
        angles = self.get_instance_angles()
        return [Coordinate(0.0, radius * math.cos(a), radius * math.sin(a)) for a in angles]

    def get_pattern_name(self) -> str:
        return f"{self.get_instance_count()}-ring"


class PodSet(ComponentAssembly):
    ORK_TYPE = "podset"

    def __init__(self):
        super().__init__(AxialMethod.BOTTOM)
        self.instance_count = 2
        self.angle_method = AngleMethod.RELATIVE
        self.angle_separation = math.pi
        self.angle_offset = 0.0
        self.radius_method = RadiusMethod.RELATIVE
        self.radius_offset = 0.0

    def get_component_name(self) -> str:
        return "Pods"

    def is_compatible(self, component) -> bool:
        from .external import BodyComponent
        return isinstance(component, BodyComponent)

    def is_after(self) -> bool:
        return False

    def get_axial_offset(self, as_method: AxialMethod | None = None) -> float:
        method = self.axial_method if as_method is None else as_method
        v = RocketComponent.get_axial_offset(self, method)
        if mu.EPSILON > abs(v):
            v = 0.0
        return v

    def get_instance_count(self) -> int:
        return self.instance_count

    def set_instance_count(self, n: int) -> None:
        if n < 1:
            return
        self.instance_count = n
        self.angle_separation = math.pi * 2 / self.instance_count
        self._fire()

    def get_instance_angle_increment(self) -> float:
        return self.angle_separation

    def get_instance_angles(self) -> list[float]:
        base = self.get_angle_offset()
        inc = self.get_instance_angle_increment()
        return [base + inc * i for i in range(self.get_instance_count())]

    def get_instance_offsets(self) -> list[Coordinate]:
        radius = self.radius_method.get_radius(self.parent, self, self.radius_offset)
        angles = self.get_instance_angles()
        return [Coordinate(0.0, radius * math.cos(a), radius * math.sin(a)) for a in angles]

    def get_angle_offset(self) -> float:
        return self.angle_offset

    def set_angle_offset(self, angle: float) -> None:
        self.angle_offset = angle
        self._fire()

    def get_angle_method(self) -> AngleMethod:
        return self.angle_method

    def set_angle_method(self, m: AngleMethod) -> None:
        self.angle_method = m
        self._fire()

    def get_radius_offset(self, method=None) -> float:
        if method is not None:
            return RocketComponent.get_radius_offset(self, method)
        return self.radius_offset

    def get_radius_method(self) -> RadiusMethod:
        return self.radius_method

    def set_radius_offset(self, r: float) -> None:
        if r == self.radius_offset:
            return
        self.radius_offset = 0.0 if self.radius_method.clamp_to_zero() else r
        self._fire()

    def set_radius(self, method: RadiusMethod, radius: float) -> None:
        new_r = 0.0 if self.radius_method.clamp_to_zero() else radius  # PodSet checks the old method
        self.radius_method = method
        self.radius_offset = method.get_as_offset(self.parent, self, new_r)
        self._fire()

    def set_radius_method(self, method: RadiusMethod) -> None:
        if method is self.radius_method:
            return
        r = self.radius_method.get_radius(self.parent, self, self.radius_offset)
        self.set_radius(method, r)

    def get_pattern_name(self) -> str:
        return f"{self.get_instance_count()}-ring"
