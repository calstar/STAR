"""Mass, CG and moments of inertia of a rocket configuration.

Ported from OpenRocket 24.12 (GPLv3): info.openrocket.core.masscalc.MassCalculation,
MassCalculator, RigidBody, CMAnalysisEntry.

Entry points (MassCalculator's statics):

    calculate_launch(config)     structure + motors at ignition
    calculate_structure(config)  no motors
    calculate_burnout(config)    structure + motor casings
    calculate_motor(config)      motors only, at ignition
    get_cm_analysis(config)      {key: CMAnalysisEntry} per component and per motor designation

Each returns a RigidBody: ``cm`` (x, y, z, weight = mass), ``Ixx`` (roll) and
``Iyy`` = ``Izz`` (pitch/yaw), about the CG.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .config import get_motor_config
from .motors.motor import PSEUDO_TIME_BURNOUT, PSEUDO_TIME_EMPTY, PSEUDO_TIME_LAUNCH
from .util import mathutil as mu
from .util.coordinate import IDENTITY, NAN, ZERO, Coordinate, Transformation

MIN_MASS = mu.EPSILON


class RigidBody:
    __slots__ = ("cm", "Ixx", "Iyy", "Izz")

    def __init__(self, cm: Coordinate, ixx: float, iyy: float, izz: float | None = None):
        if izz is None:
            izz = iyy
        if 0 > ixx or 0 > iyy or 0 > izz:
            raise ValueError("attempted to initialize an InertiaMatrix with a negative inertia value.")
        self.cm = cm
        self.Ixx = ixx
        self.Iyy = iyy
        self.Izz = izz

    def get_mass(self) -> float:
        return self.cm.weight

    def get_cm(self) -> Coordinate:
        return self.cm

    get_center_of_mass = get_cm

    def get_ixx(self) -> float:
        return self.Ixx

    def get_iyy(self) -> float:
        return self.Iyy

    def get_izz(self) -> float:
        return self.Izz

    def get_longitudinal_inertia(self) -> float:
        return self.Iyy

    def get_rotational_inertia(self) -> float:
        return self.Ixx

    def rebase(self, new_location: Coordinate) -> "RigidBody":
        d = self.cm.sub(new_location)
        x2, y2, z2 = d.x * d.x, d.y * d.y, d.z * d.z
        w = self.cm.weight
        return RigidBody(new_location, self.Ixx + w * (y2 + z2), self.Iyy + w * (x2 + z2), self.Izz + w * (x2 + y2))

    def add(self, that: "RigidBody") -> "RigidBody":
        new_cm = self.cm.average(that.cm)
        a, b = self.rebase(new_cm), that.rebase(new_cm)
        return RigidBody(new_cm, a.Ixx + b.Ixx, a.Iyy + b.Iyy, a.Izz + b.Izz)

    def to_dict(self) -> dict:
        return {"mass": self.cm.weight, "cgx": self.cm.x, "cgy": self.cm.y, "cgz": self.cm.z,
                "Ixx": self.Ixx, "Iyy": self.Iyy, "Izz": self.Izz}

    def __repr__(self) -> str:
        return f"RigidBody(m={self.cm.weight!r} @ x={self.cm.x!r}, Ixx={self.Ixx!r}, Iyy={self.Iyy!r})"


EMPTY = RigidBody(ZERO, 0.0, 0.0, 0.0)


class CMAnalysisEntry:
    def __init__(self, source):
        from .components.base import RocketComponent
        self.source = source
        if isinstance(source, RocketComponent):
            self.name = source.get_name()
        elif hasattr(source, "get_designation"):
            self.name = source.get_designation()
        else:
            self.name = None
        self.each_mass = math.nan
        self.total_cm = NAN

    def update_each_mass(self, m: float) -> None:
        if math.isnan(self.each_mass):
            self.each_mass = m

    def update_average_cm(self, cm: Coordinate) -> None:
        if self.total_cm.is_nan():
            self.total_cm = cm
        else:
            self.total_cm = self.total_cm.average(cm)

    def to_dict(self) -> dict:
        from .components.base import RocketComponent
        return {"name": self.name, "id": self.source.get_id() if isinstance(self.source, RocketComponent) else None,
                "eachMass": self.each_mass, "cgx": self.total_cm.x, "totalMass": self.total_cm.weight}


@dataclass(frozen=True)
class CalcType:
    includes_structure: bool
    includes_casing: bool
    includes_propellant: bool


STRUCTURE = CalcType(True, False, False)
MOTOR = CalcType(False, True, True)
BURNOUT = CalcType(True, True, False)
LAUNCH = CalcType(True, True, True)


class MassCalculation:
    def __init__(self, ctype: CalcType, config, time: float, root, transform: Transformation, analysis_map):
        self.type = ctype
        self.config = config
        self.simulation_time = time
        self.root = root
        self.transform = transform
        self.analysis_map = analysis_map
        self.center_of_mass = ZERO
        self.bodies: list[RigidBody] = []

    def copy(self, root, transform: Transformation) -> "MassCalculation":
        return MassCalculation(self.type, self.config, self.simulation_time, root, transform, self.analysis_map)

    def merge(self, other: "MassCalculation") -> None:
        self.add_mass(other.center_of_mass)
        self.bodies.extend(other.bodies)

    def add_mass(self, point_mass: Coordinate) -> None:
        if MIN_MASS > self.center_of_mass.weight:
            self.center_of_mass = point_mass
        else:
            self.center_of_mass = self.center_of_mass.average(point_mass)

    def get_mass(self) -> float:
        return self.center_of_mass.weight

    # -- motors ------------------------------------------------------------------------------
    def calculate_mount_data(self) -> "MassCalculation":
        if not self.config.is_component_active(self.root):
            return self
        mount = self.root
        mc = get_motor_config(mount, self.config.get_id())
        if mc.is_empty():
            return self
        motor = mc.get_motor()
        motor_time = self.simulation_time
        mount_x = mount.get_position().x
        count = mount.get_instance_count()
        motor_x = mc.get_x()
        offsets = mount.get_instance_offsets()
        if self.type.includes_casing and self.type.includes_propellant:
            each_mass = motor.get_total_mass(motor_time)
            each_cmx = motor.get_cmx(motor_time)
        elif self.type.includes_casing:
            each_mass = motor.get_total_mass(PSEUDO_TIME_BURNOUT)
            each_cmx = motor.get_cmx(PSEUDO_TIME_BURNOUT)
        else:
            m_mass = motor.get_total_mass(motor_time)
            m_cmx = motor.get_cmx(motor_time)
            c_mass = motor.get_burnout_mass()
            c_cmx = motor.get_burnout_cgx()
            each_mass = m_mass - c_mass
            each_cmx = (m_cmx * m_mass - c_cmx * c_mass) / each_mass
        local_cm = Coordinate(mount_x + motor_x + each_cmx, 0.0, 0.0, each_mass * count)
        base_ir = mc.get_unit_rotational_inertia() * count * each_mass
        it = mc.get_unit_longitudinal_inertia() * count * each_mass
        ir = base_ir
        if 1 < count:
            for c in offsets:
                distance = math.hypot(c.y, c.z)
                ir += each_mass * math.pow(distance, 2)
        cluster_cm = self.transform.transform(local_cm)
        self.add_mass(cluster_cm)
        if self.analysis_map is not None:
            key = ("motor", motor.get_designation())
            entry = self.analysis_map.get(key)
            if entry is None:
                entry = CMAnalysisEntry(motor)
                self.analysis_map[key] = entry
            entry.update_each_mass(each_mass)
            entry.update_average_cm(cluster_cm)
        self.bodies.append(RigidBody(cluster_cm, ir, it, it))
        return self

    # -- assembly ----------------------------------------------------------------------------
    def calculate_assembly(self) -> "MassCalculation":
        if self.type.includes_structure:
            s = self.copy(self.root, self.transform)
            s.calculate_structure()
            self.merge(s)
        if self.type.includes_casing or self.type.includes_propellant:
            m = self.copy(self.root, self.transform)
            m.calculate_motors()
            self.merge(m)
        return self

    def calculate_structure(self) -> "MassCalculation":
        from .components.assemblies import ComponentAssembly
        component = self.root
        parent_t = self.transform
        count = component.get_instance_count()
        offsets = component.get_instance_locations()
        angles = component.get_instance_angles()
        active = self.config.is_component_active(component)
        if self.analysis_map is not None and active and component.id not in self.analysis_map:
            self.analysis_map[component.id] = CMAnalysisEntry(component)

        children = self.copy(component, parent_t)
        for i in range(count):
            cur = (parent_t.apply_transformation(Transformation.translation(offsets[i]))
                   .apply_transformation(Transformation.get_axial_rotation(angles[i])))
            for child in component.children:
                each = self.copy(child, cur)
                each.calculate_structure()
                children.merge(each)

        if active:
            comp_cm = component.get_component_cg()
            comp_cm = parent_t.transform(comp_cm.add(component.get_position()))
            comp_zero = parent_t.transform(component.get_position())
            if component.is_mass_overridden():
                if not component.is_massive():
                    comp_cm = children.center_of_mass
                comp_cm = comp_cm.set_weight(component.get_override_mass())
                if component.is_subcomponents_overridden_mass():
                    children.center_of_mass = children.center_of_mass.set_weight(0)
            if component.is_cg_overridden():
                comp_cm = comp_cm.set_x(comp_zero.x + component.get_override_cgx())
                if component.is_subcomponents_overridden_cg():
                    children.center_of_mass = children.center_of_mass.set_x(comp_cm.x)
            self.add_mass(comp_cm)
            if self.analysis_map is not None:
                entry = self.analysis_map[component.id]
                if isinstance(component, ComponentAssembly):
                    entry.update_each_mass(children.get_mass() / component.get_instance_count())
                    entry.update_average_cm(self.center_of_mass)
                else:
                    entry.update_each_mass(comp_cm.weight)
                    entry.update_average_cm(comp_cm)
            ix = component.get_rotational_unit_inertia() * comp_cm.weight
            it = component.get_longitudinal_unit_inertia() * comp_cm.weight
            self.bodies.append(RigidBody(comp_cm, ix, it, it))
        self.merge(children)
        return self

    def calculate_motors(self) -> "MassCalculation":
        component = self.root
        parent_t = self.transform
        count = component.get_instance_count()
        locations = component.get_instance_locations()
        if component.is_motor_mount():
            m = self.copy(component, parent_t)
            m.calculate_mount_data()
            self.merge(m)
        children = self.copy(component, parent_t)
        for i in range(count):
            cur = parent_t.apply_transformation(Transformation.translation(locations[i]))
            for child in component.children:
                each = self.copy(child, cur)
                each.calculate_motors()
                children.merge(each)
        if MIN_MASS < children.get_mass():
            self.merge(children)
        return self

    def calculate_moment_of_inertia(self) -> RigidBody:
        ir = it = 0.0
        for b in self.bodies:
            g = b.rebase(self.center_of_mass)
            ir += g.Ixx
            it += g.Iyy
        return RigidBody(self.center_of_mass, ir, it, it)


# ------------------------------------------------------------------------------ MassCalculator

def calculate(ctype: CalcType, config, time: float) -> RigidBody:
    calc = MassCalculation(ctype, config, time, config.get_rocket(), IDENTITY, None)
    calc.calculate_assembly()
    return calc.calculate_moment_of_inertia()


def calculate_structure(config) -> RigidBody:
    return calculate(STRUCTURE, config, PSEUDO_TIME_EMPTY)


def calculate_burnout(config) -> RigidBody:
    return calculate(BURNOUT, config, PSEUDO_TIME_BURNOUT)


def calculate_motor(config) -> RigidBody:
    return calculate(MOTOR, config, PSEUDO_TIME_LAUNCH)


def calculate_launch(config) -> RigidBody:
    return calculate(LAUNCH, config, PSEUDO_TIME_LAUNCH)


def get_cm_analysis(config) -> dict:
    """{component id | ("motor", designation) | "rocket": CMAnalysisEntry}."""
    analysis: dict = {}
    calc = MassCalculation(LAUNCH, config, PSEUDO_TIME_LAUNCH, config.get_rocket(), IDENTITY, analysis)
    calc.calculate_assembly()
    totals = CMAnalysisEntry(config.get_rocket())
    totals.total_cm = calc.center_of_mass
    totals.each_mass = calc.center_of_mass.weight
    analysis[config.get_rocket().id] = totals
    return analysis
