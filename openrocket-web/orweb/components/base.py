"""The component tree: position, instances, overrides, change events.

Ported from OpenRocket 24.12 (GPLv3): info.openrocket.core.rocketcomponent.RocketComponent
(and the ring-geometry helpers it carries).

Change events. OpenRocket recomputes every component's position whenever any
component changes (Rocket.fireComponentChangeEvent calls componentChanged() ->
update() on the whole tree, depth first). Loading an .ork replays setters one
by one with those events live, and several setters clamp against the tree's
state at that moment, so the final numbers depend on that history. ``_fire``
reproduces it: a setter that fires in Java calls ``self._fire()``, which runs
the same depth-first update pass over the rocket.
"""

from __future__ import annotations

import math
import uuid

from ..util import mathutil as mu
from ..util.coordinate import ZERO, Coordinate, Transformation
from .position import AxialMethod, RadiusMethod


class RocketComponent:
    #: the .ork element name (DocumentConfig.constructors); set by each concrete class
    ORK_TYPE = ""

    def __init__(self, axial_method: AxialMethod):
        self.parent: RocketComponent | None = None
        self.children: list[RocketComponent] = []
        self.length = 0.0
        self.axial_method = axial_method
        self.axial_offset = 0.0
        self.position = Coordinate()
        self.override_mass = 0.0
        self.mass_overridden = False
        self.override_subcomponents_mass = False
        self.override_cgx = 0.0
        self.cg_overridden = False
        self.override_subcomponents_cg = False
        self.override_cd = 0.0
        self.cd_overridden = False
        self.override_subcomponents_cd = False
        self.name = self.get_component_name()
        self.comment = ""
        self.id = str(uuid.uuid4())
        self._bypass = False
        #: the document params this component was built from (set by orweb.build)
        self.params: dict | None = None

    # ------------------------------------------------------------------ abstract
    def get_component_name(self) -> str:
        return type(self).__name__

    def get_component_mass(self) -> float:
        raise NotImplementedError

    def get_component_cg(self) -> Coordinate:
        raise NotImplementedError

    def get_longitudinal_unit_inertia(self) -> float:
        raise NotImplementedError

    def get_rotational_unit_inertia(self) -> float:
        raise NotImplementedError

    def allows_children(self) -> bool:
        return False

    def is_aerodynamic(self) -> bool:
        raise NotImplementedError

    def is_massive(self) -> bool:
        raise NotImplementedError

    def is_axisymmetric(self) -> bool:
        return True

    def get_component_bounds(self) -> list[Coordinate]:
        return []

    def is_motor_mount(self) -> bool:
        return False

    # ------------------------------------------------------------------ events
    def _fire(self) -> None:
        """fireComponentChangeEvent: rerun the rocket's update pass."""
        if self.parent is None or self._bypass:
            return
        root = self.get_root()
        fire = getattr(root, "_fire_event", None)
        if fire is not None:
            fire()

    def set_bypass_change_event(self, value: bool) -> None:
        self._bypass = value

    def component_changed(self) -> None:
        """componentChanged(e): by default just update()."""
        self.update()

    def update(self) -> None:
        self._set_axial_offset(self.axial_method, self.axial_offset)

    # ------------------------------------------------------------------ identity
    def get_name(self) -> str:
        return self.name

    def set_name(self, name: str) -> None:
        if self.name == name:
            return
        if name is None or name.strip() == "":
            self.name = self.get_component_name()
        else:
            self.name = name
        self._fire()

    def get_id(self) -> str:
        return self.id

    def set_id(self, new_id: str) -> None:
        self.id = new_id

    def get_comment(self) -> str:
        return self.comment

    def set_comment(self, comment: str | None) -> None:
        if self.comment == comment:
            return
        self.comment = comment or ""
        self._fire()

    def __repr__(self) -> str:
        return f"<{type(self).__name__} {self.name!r} {self.id[:8]}>"

    # ------------------------------------------------------------------ tree
    def add_child(self, component: "RocketComponent", index: int | None = None, track_stage: bool = True) -> None:
        if component.parent is not None:
            raise ValueError(f"component {component.name} is already in a tree")
        if not self.is_compatible(component):
            raise ValueError(f"{type(component).__name__} cannot be a child of {type(self).__name__}")
        if index is None:
            index = len(self.children)
        self.children.insert(index, component)
        component.parent = self
        from .assemblies import AxialStage
        if track_stage and isinstance(component, AxialStage):
            self.get_rocket().track_stage(component)
        self._on_child_added(component)
        self._fire()  # fireAddRemoveEvent

    def _on_child_added(self, component: "RocketComponent") -> None:
        pass

    def is_compatible(self, component) -> bool:
        return False

    def get_children(self) -> list["RocketComponent"]:
        return list(self.children)

    def get_child_count(self) -> int:
        return len(self.children)

    def get_child(self, n: int) -> "RocketComponent":
        return self.children[n]

    def get_child_position(self, child: "RocketComponent") -> int:
        for i, c in enumerate(self.children):
            if c is child:
                return i
        return -1

    def get_parent(self) -> "RocketComponent | None":
        return self.parent

    def get_root(self) -> "RocketComponent":
        gp = self
        while gp.parent is not None:
            gp = gp.parent
        return gp

    def get_rocket(self):
        from .assemblies import Rocket
        r = self.get_root()
        if isinstance(r, Rocket):
            return r
        raise ValueError("getRocket() called with root component " + type(r).__name__)

    def get_stage(self):
        from .assemblies import AxialStage
        c = self
        while c is not None:
            if isinstance(c, AxialStage):
                return c
            c = c.parent
        raise ValueError("getStage() called on hierarchy without an AxialStage.")

    def get_stage_number(self) -> int:
        return self.get_stage().get_stage_number()

    def iterator(self, return_self: bool = True):
        """Depth-first, pre-order (RocketComponentIterator)."""
        if return_self:
            yield self
        stack = [iter(self.children)]
        while stack:
            try:
                c = next(stack[-1])
            except StopIteration:
                stack.pop()
                continue
            yield c
            if c.children:
                stack.append(iter(c.children))

    def __iter__(self):
        return self.iterator(True)

    def get_all_children(self) -> list["RocketComponent"]:
        return list(self.iterator(False))

    def get_sub_stages(self):
        from .assemblies import AxialStage
        return [c for c in self.iterator(False) if isinstance(c, AxialStage)]

    def get_direct_child_assemblies(self):
        from .assemblies import ComponentAssembly
        return [c for c in self.children if isinstance(c, ComponentAssembly)]

    def get_parent_assemblies(self):
        from .assemblies import ComponentAssembly
        out = []
        c = self.parent
        while c is not None:
            if isinstance(c, ComponentAssembly):
                out.append(c)
            c = c.parent
        return out

    def get_top_level_child_stages(self):
        from .assemblies import AxialStage
        out = []

        def walk(p):
            for ch in p.children:
                if isinstance(ch, AxialStage):
                    out.append(ch)
                else:
                    walk(ch)
        walk(self)
        return out

    def find_component(self, cid: str):
        for c in self.iterator(True):
            if c.id == cid:
                return c
        return None

    # ------------------------------------------------------------------ position
    def get_length(self) -> float:
        return self.length

    def get_axial_method(self) -> AxialMethod:
        return self.axial_method

    def is_after(self) -> bool:
        return self.axial_method is AxialMethod.AFTER

    def set_axial_method(self, new_method: AxialMethod) -> None:
        if new_method is self.axial_method:
            return
        self.axial_method = new_method
        self.axial_offset = self.get_axial_offset(new_method)

    def get_axial_offset(self, as_method: AxialMethod | None = None) -> float:
        if as_method is None:
            return self.axial_offset
        parent_length = 0.0
        from .assemblies import Rocket
        if self.parent is not None and not isinstance(self.parent, Rocket):
            parent_length = self.parent.get_length()
        if as_method is AxialMethod.ABSOLUTE:
            return self.get_component_locations()[0].x
        return as_method.get_as_offset(self.position.x, self.get_length(), parent_length)

    def get_axial_front(self) -> float:
        return self.position.x

    def set_axial_offset(self, new_offset: float) -> None:
        self._set_axial_offset(self.axial_method, new_offset)
        self._fire()

    def _is_layout_active(self, ref: "RocketComponent") -> bool:
        """getRocket().getSelectedConfiguration().isComponentActive(ref) as it is during
        a load: every stage is active, and a stage with no children is not."""
        from .assemblies import Rocket
        if isinstance(ref, Rocket):
            return True
        try:
            stage = ref.get_stage()
        except ValueError:
            return True
        return stage.get_child_count() > 0

    def set_after(self) -> None:
        if self.parent is None:
            return
        self.axial_method = AxialMethod.AFTER
        self.axial_offset = 0.0
        idx_self = self.parent.get_child_position(self)
        if idx_self == 0:
            self.position = self.position.set_x(0.0)
        elif idx_self > 0:
            idx = idx_self - 1
            ref = self.parent.get_child(idx)
            while not self._is_layout_active(ref) and idx > 0:
                idx -= 1
                ref = self.parent.get_child(idx)
            if not self._is_layout_active(ref):
                self.position = self.position.set_x(0.0)
                return
            self.position = self.position.set_x(ref.get_position().x + ref.get_length())

    def _set_axial_offset(self, requested_method: AxialMethod, requested_offset: float) -> None:
        if self.parent is None:
            new_x = requested_offset
        elif requested_method is AxialMethod.ABSOLUTE:
            new_x = requested_offset - self.parent.get_component_locations()[0].x
        elif self.is_after():
            self.set_after()
            return
        else:
            new_x = requested_method.get_as_position(requested_offset, self.get_length(), self.parent.get_length())
        if 0.000001 > abs(new_x):
            new_x = 0.0
        elif math.isnan(new_x):
            raise ValueError(f"setAxialOffset is broken -- attempted to update as NaN: {self.name}")
        self.axial_method = requested_method
        self.axial_offset = requested_offset
        self.position = self.position.set_x(new_x)

    def get_position(self) -> Coordinate:
        return self.position

    def get_radius_offset(self, method: RadiusMethod | None = None) -> float:
        if method is None:
            return 0.0
        radius = self.get_radius_method().get_radius(self.parent, self, self.get_radius_offset())
        return method.get_as_offset(self.parent, self, radius)

    def get_radius_method(self) -> RadiusMethod:
        return RadiusMethod.COAXIAL

    def get_angle_offset(self) -> float:
        return 0.0

    # ------------------------------------------------------------------ instances
    def get_instance_count(self) -> int:
        return 1

    def get_instance_offsets(self) -> list[Coordinate]:
        return [ZERO]

    def get_instance_angles(self) -> list[float]:
        return [0.0] * self.get_instance_count()

    def get_instance_locations(self) -> list[Coordinate]:
        center = self.position
        return [center.add(o) for o in self.get_instance_offsets()]

    def get_component_angles(self) -> list[Coordinate]:
        if self.parent is None:
            return [Coordinate(a, 0.0, 0.0) for a in self.get_instance_angles()]
        parent_angles = self.parent.get_component_angles()
        inst = [Coordinate(a, 0.0, 0.0) for a in self.get_instance_angles()]
        pc, ic = len(parent_angles), len(inst)
        if pc == 1 and ic == 1:
            return [parent_angles[0].add(inst[0])]
        out = [None] * (pc * ic)
        for pi in range(pc):
            for ii in range(ic):
                out[pi + pc * ii] = parent_angles[pi].add(inst[ii])
        return out

    def get_component_locations(self) -> list[Coordinate]:
        """Absolute location of every instance of this component."""
        if self.parent is None:
            return self.get_instance_offsets()
        parent_positions = self.parent.get_component_locations()
        pc = len(parent_positions)
        instance_locations = self.get_instance_locations()
        ic = len(instance_locations)
        parent_rotations = self.parent.get_component_angles()
        if pc == 1 and ic == 1:
            rot = Transformation.get_rotation_transform(parent_rotations[0], self.position)
            return [parent_positions[0].add(rot.transform(instance_locations[0]))]
        out = [None] * (pc * ic)
        for pi in range(pc):
            rot = Transformation.get_rotation_transform(parent_rotations[pi], self.position)
            for ii in range(ic):
                out[pi + pc * ii] = parent_positions[pi].add(rot.transform(instance_locations[ii]))
        return out

    def to_absolute(self, c: Coordinate) -> list[Coordinate]:
        return [p.add(c) for p in self.get_component_locations()]

    def to_relative(self, c: Coordinate, dest: "RocketComponent") -> list[Coordinate]:
        dest_locs = dest.get_component_locations()
        mine = self.get_component_locations()[0]
        return [mine.add(c).sub(d) for d in dest_locs]

    # ------------------------------------------------------------------ mass / overrides
    def get_mass(self) -> float:
        if self.mass_overridden:
            return self.override_mass
        return self.get_component_mass()

    def get_section_mass(self) -> float:
        m = self.get_mass()
        if self.mass_overridden and self.override_subcomponents_mass:
            return m
        for c in self.children:
            m += c.get_section_mass()
        return m

    def get_cg(self) -> Coordinate:
        if self.cg_overridden:
            return self.get_override_cg().set_weight(self.get_mass())
        if self.mass_overridden:
            return self.get_component_cg().set_weight(self.get_mass())
        return self.get_component_cg()

    def get_longitudinal_inertia(self) -> float:
        return self.get_longitudinal_unit_inertia() * self.get_mass()

    def get_rotational_inertia(self) -> float:
        return self.get_rotational_unit_inertia() * self.get_mass()

    def get_override_mass(self) -> float:
        if not self.mass_overridden:
            self.override_mass = self.get_component_mass()
        return self.override_mass

    def set_override_mass(self, m: float) -> None:
        if mu.equals(m, self.override_mass):
            return
        self.override_mass = max(m, 0.0)
        if self.mass_overridden:
            self._fire()

    def is_mass_overridden(self) -> bool:
        return self.mass_overridden

    def set_mass_overridden(self, o: bool) -> None:
        if self.mass_overridden == o:
            return
        self.mass_overridden = o
        if not o:
            self.override_mass = self.get_component_mass()
        self._fire()

    def get_override_cg(self) -> Coordinate:
        if not self.cg_overridden:
            self.override_cgx = self.get_component_cg().x
        return self.get_component_cg().set_x(self.override_cgx)

    def get_override_cgx(self) -> float:
        if not self.cg_overridden:
            self.override_cgx = self.get_component_cg().x
        return self.override_cgx

    def set_override_cgx(self, x: float) -> None:
        if mu.equals(self.override_cgx, x):
            return
        self.override_cgx = x
        self._fire()

    def is_cg_overridden(self) -> bool:
        return self.cg_overridden

    def set_cg_overridden(self, o: bool) -> None:
        if self.cg_overridden == o:
            return
        self.cg_overridden = o
        if not o:
            self.override_cgx = self.get_component_cg().x
        self._fire()

    def get_override_cd(self) -> float:
        """The stored override CD. (Java computes the component's own CD here when
        not overridden; the aerodynamics port owns that.)"""
        return self.override_cd

    def set_override_cd(self, x: float) -> None:
        if mu.equals(self.override_cd, x):
            return
        self.override_cd = x
        self._fire()

    def is_cd_overridden(self) -> bool:
        return self.cd_overridden

    def set_cd_overridden(self, o: bool) -> None:
        if self.cd_overridden == o:
            return
        self.cd_overridden = o
        self._fire()

    def is_cd_overridden_by_ancestor(self) -> bool:
        p = self.parent
        return p is not None and (p.is_cd_overridden_by_ancestor()
                                  or (p.is_cd_overridden() and p.is_subcomponents_overridden_cd()))

    def is_subcomponents_overridden_mass(self) -> bool:
        return self.override_subcomponents_mass

    def is_subcomponents_overridden_cg(self) -> bool:
        return self.override_subcomponents_cg

    def is_subcomponents_overridden_cd(self) -> bool:
        return self.override_subcomponents_cd

    def set_subcomponents_overridden_mass(self, v: bool) -> None:
        if self.override_subcomponents_mass == v:
            return
        self.override_subcomponents_mass = v
        self._fire()

    def set_subcomponents_overridden_cg(self, v: bool) -> None:
        if self.override_subcomponents_cg == v:
            return
        self.override_subcomponents_cg = v
        self._fire()

    def set_subcomponents_overridden_cd(self, v: bool) -> None:
        if self.override_subcomponents_cd == v:
            return
        self.override_subcomponents_cd = v
        self._fire()

    def set_subcomponents_overridden(self, v: bool) -> None:
        self.set_subcomponents_overridden_mass(v)
        self.set_subcomponents_overridden_cg(v)
        self.set_subcomponents_overridden_cd(v)

    # ------------------------------------------------------------------ bounds helpers
    @staticmethod
    def add_bound(bounds: list, x: float, r: float) -> None:
        bounds.append(Coordinate(x, -r, -r))
        bounds.append(Coordinate(x, r, -r))
        bounds.append(Coordinate(x, r, r))
        bounds.append(Coordinate(x, -r, r))

    @staticmethod
    def add_bounding_box(bounds: list, x_min: float, x_max: float, r: float) -> None:
        bounds.append(Coordinate(x_min, -r, -r))
        bounds.append(Coordinate(x_max, r, r))


# ---------------------------------------------------------------------- ring helpers (RocketComponent statics)

def ring_mass(outer: float, inner: float, length: float, density: float) -> float:
    return math.pi * max(mu.pow2(outer) - mu.pow2(inner), 0.0) * length * density


def ring_volume(outer: float, inner: float, length: float) -> float:
    return ring_mass(outer, inner, length, 1.0)


def ring_cg(outer: float, inner: float, x1: float, x2: float, density: float) -> Coordinate:
    return Coordinate((x1 + x2) / 2, 0.0, 0.0, ring_mass(outer, inner, x2 - x1, density))


def ring_longitudinal_unit_inertia(outer: float, inner: float, length: float) -> float:
    return (3 * (mu.pow2(inner) + mu.pow2(outer)) + mu.pow2(length)) / 12


def ring_rotational_unit_inertia(outer: float, inner: float) -> float:
    return (mu.pow2(inner) + mu.pow2(outer)) / 2
