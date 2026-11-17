"""Flight and motor configurations.

Ported from OpenRocket 24.12 (GPLv3): info.openrocket.core.rocketcomponent.FlightConfiguration,
info.openrocket.core.motor.MotorConfiguration, info.openrocket.core.rocketcomponent.ReferenceType,
info.openrocket.core.rocketcomponent.InstanceContext / InstanceMap.

A flight configuration says which stages are active and which motor sits in
each mount. Stage activeness is OpenRocket's: a stage counts only if it has
children.
"""

from __future__ import annotations

from dataclasses import dataclass

from .util import mathutil as mu
from .util.coordinate import IDENTITY, BoundingBox, Coordinate, Transformation, X_UNIT, ZERO

IGNITION_EVENTS = ("automatic", "launch", "ejection", "burnout", "never")


class MotorConfiguration:
    """A motor in a mount for one flight configuration."""

    def __init__(self, mount, fcid: str | None, source: "MotorConfiguration | None" = None):
        self.mount = mount
        self.fcid = fcid
        self.motor = None
        self.ejection_delay = 0.0
        self.ignition_event = "automatic"
        self.ignition_delay = 0.0
        if source is not None:
            self.motor = source.motor
            self.ejection_delay = source.ejection_delay
            self.ignition_event = source.ignition_event
            self.ignition_delay = source.ignition_delay

    def get_motor(self):
        return self.motor

    def get_mount(self):
        return self.mount

    def is_empty(self) -> bool:
        return self.motor is None

    def get_ejection_delay(self) -> float:
        return self.ejection_delay

    def get_ignition_event(self) -> str:
        return self.ignition_event

    def get_ignition_delay(self) -> float:
        return self.ignition_delay

    def get_x(self) -> float:
        if self.is_empty():
            return 0.0
        return self.mount.get_length() - self.motor.get_length() + self.mount.get_motor_overhang()

    def get_position(self) -> Coordinate:
        return Coordinate(self.get_x(), 0.0, 0.0)

    def get_motor_count(self) -> int:
        from .components.internal import InnerTube
        if isinstance(self.mount, InnerTube):
            return self.mount.get_cluster_configuration().get_cluster_count()
        return 1

    def get_unit_longitudinal_inertia(self) -> float:
        if self.motor is not None:
            return mu.filled_cylinder_longitudinal(self.motor.get_diameter() / 2, self.motor.get_length())
        return 0.0

    def get_unit_rotational_inertia(self) -> float:
        if self.motor is not None:
            return mu.filled_cylinder_rotational(self.motor.get_diameter() / 2)
        return 0.0


def motor_configs_of(mount) -> dict:
    """The mount's {fcid: MotorConfiguration} map (MotorConfigurationSet), created on demand."""
    d = getattr(mount, "_motor_configs", None)
    if d is None:
        d = {}
        mount._motor_configs = d
        mount._default_motor_config = MotorConfiguration(mount, None)
    return d


def default_motor_config(mount) -> MotorConfiguration:
    motor_configs_of(mount)
    return mount._default_motor_config


def get_motor_config(mount, fcid: str | None) -> MotorConfiguration:
    """MotorMount.getMotorConfig(fcid): the configured motor, else the (empty) default."""
    return motor_configs_of(mount).get(fcid, default_motor_config(mount))


@dataclass
class InstanceContext:
    component: object
    instance_number: int
    transform: Transformation


class FlightConfiguration:
    def __init__(self, rocket, fcid: str | None, name: str | None = None):
        self.rocket = rocket
        self.fcid = fcid
        self.name = name
        #: stage number -> active, as preloaded from the file; missing means active
        self.stage_flags: dict[int, bool] = {}

    # -- identity ----------------------------------------------------------------------
    def get_id(self) -> str | None:
        return self.fcid

    get_flight_configuration_id = get_id

    def get_rocket(self):
        return self.rocket

    # -- stages ----------------------------------------------------------------------------
    def set_stage_active(self, stage_number: int, active: bool) -> None:
        self.stage_flags[stage_number] = active

    def is_stage_active(self, stage_number: int) -> bool:
        if stage_number == -1:
            return True
        stage = self.rocket.get_stage(stage_number)
        return (stage is not None and stage.get_child_count() > 0
                and self.stage_flags.get(stage_number, True))

    def is_component_active(self, c) -> bool:
        return self.is_stage_active(c.get_stage_number())

    def get_active_stages(self):
        return [s for n, s in sorted(self.rocket.stage_map.items()) if self.is_stage_active(n)]

    def get_all_stages(self):
        return [s for _, s in sorted(self.rocket.stage_map.items())]

    def get_bottom_stage(self):
        b = None
        for s in self.get_active_stages():
            b = s
        return b

    # -- components ------------------------------------------------------------------------
    def get_all_components(self):
        return list(self.rocket.iterator(True))

    def get_all_active_components(self):
        out = []

        def walk(c):
            if not self.is_component_active(c):
                return
            out.append(c)
            for ch in c.children:
                walk(ch)
        walk(self.rocket)
        return out

    def get_active_components(self):
        """The deprecated breadth-first getActiveComponents (used by ReferenceType, updateMotors)."""
        from .components.assemblies import AxialStage
        queue = list(self.get_active_stages())
        out = []
        i = 0
        while i < len(queue):
            comp = queue[i]
            i += 1
            out.append(comp)
            for ch in comp.children:
                if not isinstance(ch, AxialStage):
                    queue.append(ch)
        return out

    def get_core_components(self):
        from .components.assemblies import AxialStage, ComponentAssembly, Rocket
        queue = [self.rocket]
        out = []
        i = 0
        while i < len(queue):
            comp = queue[i]
            i += 1
            if type(comp) is not Rocket:
                out.append(comp)
            for ch in comp.children:
                if type(ch) is AxialStage:
                    if self.is_stage_active(ch.get_stage_number()):
                        queue.append(ch)
                elif isinstance(ch, ComponentAssembly):
                    pass
                else:
                    queue.append(ch)
        return out

    def get_active_instances(self) -> dict:
        """{component: [InstanceContext]} for active components, depth first (getActiveContextListAt)."""
        results: dict = {}

        def walk(component, parent_transform: Transformation) -> None:
            n = component.get_instance_count()
            offsets = component.get_instance_offsets()
            angles = component.get_instance_angles()
            comp_t = parent_transform.apply_transformation(Transformation.translation(component.get_position()))
            active = self.is_component_active(component)
            for i in range(n):
                cur = (comp_t.apply_transformation(Transformation.translation(offsets[i]))
                       .apply_transformation(Transformation.get_axial_rotation(angles[i])))
                if active:
                    results.setdefault(component, []).append(InstanceContext(component, i, cur))
                for ch in component.children:
                    walk(ch, cur)

        walk(self.rocket, IDENTITY)
        return results

    # -- motors ------------------------------------------------------------------------------
    def get_active_motors(self) -> list[MotorConfiguration]:
        out = []
        for comp in self.get_active_components():
            if comp.is_motor_mount():
                mc = get_motor_config(comp, self.fcid)
                if not mc.is_empty() and self.is_component_active(comp):
                    out.append(mc)
        return out

    def has_motors(self) -> bool:
        return bool(self.get_active_motors())

    # -- bounds / reference ----------------------------------------------------------------------
    def calculate_bounds(self) -> tuple[BoundingBox, BoundingBox]:
        """(aerodynamic bounds, all bounds), as FlightConfiguration.calculateBounds -- including
        its use of untransformed local bounds for components that are not BoxBounded."""
        aero = BoundingBox()
        allb = BoundingBox()
        for component, contexts in self.get_active_instances().items():
            ca = BoundingBox()
            cb = BoundingBox()
            box = getattr(component, "get_instance_bounding_box", None)
            if box is not None:
                ib = box()
                if ib.is_empty():
                    continue
                for ctx in contexts:
                    t = ib.transform(ctx.transform)
                    if component.is_aerodynamic():
                        ca.update(t)
                    cb.update(t)
            else:
                coords = component.get_component_bounds()
                if contexts:
                    for tc in coords:  # (the untransformed copy, as Java does)
                        if component.is_aerodynamic():
                            ca.update(tc)
                        cb.update(tc)
            aero.update(ca)
            allb.update(cb)
        return aero, allb

    def get_length_aerodynamic(self) -> float:
        aero, _ = self.calculate_bounds()
        return 0.0 if aero.is_empty() else aero.span().x

    def get_length(self) -> float:
        _, allb = self.calculate_bounds()
        return 0.0 if allb.is_empty() else allb.span().x

    def get_bounding_box_aerodynamic(self) -> BoundingBox:
        aero, _ = self.calculate_bounds()
        if aero.is_empty():
            return BoundingBox(ZERO, X_UNIT)
        return aero

    def get_bounding_box(self) -> BoundingBox:
        _, allb = self.calculate_bounds()
        if allb.is_empty():
            return BoundingBox(ZERO, X_UNIT)
        return allb

    def get_reference_length(self) -> float:
        from .components.symmetric import SymmetricComponent
        rt = self.rocket.get_reference_type()
        if rt == "custom":
            return self.rocket.get_custom_reference_length()
        if rt == "nosecone":
            for c in self.get_active_components():
                if isinstance(c, SymmetricComponent):
                    if c.get_fore_radius() >= 0.0005:
                        return c.get_fore_radius() * 2
                    if c.get_aft_radius() >= 0.0005:
                        return c.get_aft_radius() * 2
            return self.rocket.DEFAULT_REFERENCE_LENGTH
        r = 0.0
        for c in self.get_active_components():
            if isinstance(c, SymmetricComponent):
                r = max(r, c.get_fore_radius())
                r = max(r, c.get_aft_radius())
        r *= 2
        if r < 0.001:
            r = self.rocket.DEFAULT_REFERENCE_LENGTH
        return r

    def get_reference_area(self) -> float:
        import math
        return math.pi * mu.pow2(self.get_reference_length() / 2)
