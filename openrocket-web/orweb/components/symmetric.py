"""Axisymmetric body components: transitions, nose cones, body tubes.

Ported from OpenRocket 24.12 (GPLv3): info.openrocket.core.rocketcomponent.SymmetricComponent,
Transition (and Transition.Shape), NoseCone, BodyTube.

SymmetricComponent's volume, CG, inertias, wetted and planform areas are a
128-division frustum integration (calculateProperties), reproduced step for step.
"""

from __future__ import annotations

import math
from enum import Enum

from ..util import mathutil as mu
from ..util.coordinate import BoundingBox, Coordinate
from .base import (RocketComponent, ring_cg, ring_longitudinal_unit_inertia, ring_rotational_unit_inertia,
                   ring_volume)
from .external import BodyComponent
from .position import AxialMethod

pow2 = mu.pow2

DEFAULT_RADIUS = 0.025
DEFAULT_THICKNESS = 0.002
DIVISIONS = 128


class SymmetricComponent(BodyComponent):
    def __init__(self):
        super().__init__()
        self.filled = False
        self.thickness = DEFAULT_THICKNESS
        self._props = None  # cached calculateProperties() result

    # -- abstract-ish ---------------------------------------------------------------
    def get_radius(self, x: float) -> float:
        raise NotImplementedError

    def get_inner_radius(self, x: float) -> float:
        raise NotImplementedError

    def get_fore_radius(self) -> float:
        raise NotImplementedError

    def get_aft_radius(self) -> float:
        raise NotImplementedError

    def is_fore_radius_automatic(self) -> bool:
        raise NotImplementedError

    def is_aft_radius_automatic(self) -> bool:
        raise NotImplementedError

    def get_front_auto_radius(self) -> float:
        raise NotImplementedError

    def get_rear_auto_radius(self) -> float:
        raise NotImplementedError

    def uses_previous_comp_automatic(self) -> bool:
        raise NotImplementedError

    def uses_next_comp_automatic(self) -> bool:
        raise NotImplementedError

    # -- simple accessors -------------------------------------------------------------
    def get_outer_radius(self, x: float) -> float:
        return self.get_radius(x)

    def get_max_radius(self) -> float:
        return mu.jmax(self.get_fore_radius(), self.get_aft_radius())

    def get_thickness(self) -> float:
        if self.filled:
            return max(self.get_fore_radius(), self.get_aft_radius())
        return self.thickness

    def set_thickness(self, thickness: float, do_clamping: bool = True) -> None:
        if self.thickness == thickness and not self.filled:
            return
        self.thickness = mu.clamp(thickness, 0, self.get_max_radius()) if do_clamping else thickness
        self.filled = False
        self._fire()

    def is_filled(self) -> bool:
        return self.filled

    def set_filled(self, filled: bool) -> None:
        if self.filled == filled:
            return
        self.filled = filled
        self._fire()

    def is_after(self) -> bool:
        return True

    def component_changed(self) -> None:
        RocketComponent.component_changed(self)
        self._props = None

    def get_component_bounds(self) -> list[Coordinate]:
        out: list[Coordinate] = []
        for n in range(6):
            x = n * self.get_length() / 5
            self.add_bound(out, x, self.get_radius(x))
        return out

    def get_instance_bounding_box(self) -> BoundingBox:
        b = BoundingBox()
        b.update(Coordinate(self.get_length(), 0.0, 0.0))
        r = max(self.get_fore_radius(), self.get_aft_radius())
        b.update(Coordinate(0.0, r, r))
        b.update(Coordinate(0.0, -r, -r))
        return b

    # -- integrated properties --------------------------------------------------------
    def _properties(self) -> dict:
        if self._props is None:
            self._props = self.calculate_properties()
        return self._props

    def get_component_volume(self) -> float:
        return self._properties()["volume"]

    def get_full_volume(self) -> float:
        return self._properties()["fullVolume"]

    def get_component_wet_area(self) -> float:
        return self._properties()["wetArea"]

    def get_component_planform_area(self) -> float:
        return self._properties()["planArea"]

    def get_component_planform_center(self) -> float:
        return self._properties()["planCenter"]

    def get_component_cg(self) -> Coordinate:
        return self._properties()["cg"]

    def get_longitudinal_unit_inertia(self) -> float:
        return self._properties()["long"]

    def get_rotational_unit_inertia(self) -> float:
        return self._properties()["rot"]

    @staticmethod
    def _calculate_cg(l: float, r1: float, r2: float) -> Coordinate:
        volume = l * (pow2(r1) + r1 * r2 + pow2(r2))
        if volume < mu.EPSILON:
            cg = l / 2.0
        else:
            cg = l * (pow2(r1) + 2.0 * r1 * r2 + 3 * pow2(r2)) / (4.0 * (pow2(r1) + r1 * r2 + pow2(r2)))
        return Coordinate(cg, 0.0, 0.0, volume)

    @staticmethod
    def _calculate_unit_rot_moi(r1: float, r2: float) -> float:
        if abs(r1 - r2) < mu.EPSILON:
            return 10.0 * pow2(r1) / 6.0
        return (math.pow(r2, 5) - math.pow(r1, 5)) / (math.pow(r2, 3) - math.pow(r1, 3))

    @staticmethod
    def _calculate_long_moi_cone(h: float, r: float) -> float:
        m = pow2(r) * h
        return 3 * m * (pow2(r) / 20.0 + pow2(h) / 5.0)

    @classmethod
    def _calculate_long_moi(cls, l: float, r1: float, r2: float, cg: Coordinate) -> float:
        if abs(r1 - r2) < mu.EPSILON:
            return cg.weight * (3 * pow2(r1) + pow2(l)) / 12.0
        shift_cg = cg.x
        if r1 > r2:
            r1, r2 = r2, r1
            shift_cg = l - cg.x
        h2 = l * r2 / (r2 - r1)
        h1 = h2 * r1 / r2
        moi1 = cls._calculate_long_moi_cone(h1, r1)
        moi2 = cls._calculate_long_moi_cone(h2, r2)
        moi = moi2 - moi1
        moi = moi - pow2(h1 + shift_cg) * cg.weight
        return moi

    def calculate_properties(self) -> dict:
        """SymmetricComponent.calculateProperties."""
        wet_area = plan_area = plan_center = full_volume = volume = 0.0
        long_i = rot_i = 0.0
        cgx = 0.0
        length = self.get_length()
        if length < mu.EPSILON:
            return {"wetArea": 0.0, "planArea": 0.0, "planCenter": 0.0, "fullVolume": 0.0, "volume": 0.0,
                    "long": 0.0, "rot": 0.0, "cg": Coordinate()}
        thickness = self.thickness
        filled = self.filled
        for n in range(DIVISIONS):
            x1 = n * length / DIVISIONS
            x2 = (n + 1) * length / DIVISIONS
            l = x2 - x1
            r1o = self.get_radius(x1)
            r2o = self.get_radius(x2)
            hyp = mu.hypot(r2o - r1o, l)
            height = thickness * hyp / l
            if filled:
                r1i = r2i = 0.0
            else:
                r1i = mu.jmax(r1o - height, 0)
                r2i = mu.jmax(r2o - height, 0)
            full_cg = self._calculate_cg(l, r1o, r2o)
            inner_cg = self._calculate_cg(l, r1i, r2i)
            d_full_v = full_cg.weight
            d_v = full_cg.weight - inner_cg.weight
            d_cg = _jdiv(full_cg.x * full_cg.weight - inner_cg.x * inner_cg.weight, d_v)
            d_cgx = d_v * (x1 + d_cg)
            ixxo = self._calculate_unit_rot_moi(r1o, r2o)
            ixxi = self._calculate_unit_rot_moi(r1i, r2i)
            ixx = ixxo * full_cg.weight - ixxi * inner_cg.weight
            iyy = self._calculate_long_moi(l, r1o, r2o, full_cg) - self._calculate_long_moi(l, r1i, r2i, inner_cg)
            iyy += d_v * pow2(x1 + d_cg)
            volume += d_v
            full_volume += d_full_v
            cgx += d_cgx
            rot_i += ixx
            long_i += iyy
            wet_area += (r1o + r2o) * math.sqrt(pow2(r1o - r2o) + pow2(l))
            d_a = l * (r1o + r2o)
            plan_area += d_a
            plan_center += d_a * x1 + 2.0 * pow2(l) * (r1o / 6.0 + r2o / 3.0)
        if plan_area > 0:
            plan_center /= plan_area
        rot_i = _jdiv(rot_i, volume)
        long_i = _jdiv(long_i, volume)
        volume *= math.pi / 3.0
        full_volume *= math.pi / 3.0
        cgx *= math.pi / 3.0
        wet_area *= math.pi
        rot_i *= 3.0 / 10.0
        if volume < 0.0000000001:
            volume = 0.0
            cg = Coordinate(length / 2, 0.0, 0.0, 0.0)
        else:
            cg = Coordinate(cgx / volume, 0.0, 0.0, self.get_material().density * volume)
        if mu.equals(volume, 0):
            rot_i = 0.0
            long_i = 0.0
        else:
            long_i = long_i - pow2(cg.x)
        return {"wetArea": wet_area, "planArea": plan_area, "planCenter": plan_center, "fullVolume": full_volume,
                "volume": volume, "long": long_i, "rot": rot_i, "cg": cg}

    # -- neighbours (auto radius) -------------------------------------------------------
    def get_previous_symmetric_component(self) -> "SymmetricComponent | None":
        from .assemblies import ComponentAssembly
        if self.parent is None or self.parent.parent is None:
            return None
        grand = self.parent.parent
        search_parent_index = grand.get_child_position(self.parent)
        search_sibling_index = self.parent.get_child_position(self) - 1
        while 0 <= search_parent_index:
            search_parent = grand.get_child(search_parent_index)
            if isinstance(search_parent, ComponentAssembly):
                while 0 <= search_sibling_index:
                    sib = search_parent.get_child(search_sibling_index)
                    if isinstance(sib, SymmetricComponent) and self._inline(sib):
                        return self._prev_from_assembly(sib, sib, 0.0)
                    search_sibling_index -= 1
            search_parent_index -= 1
            if 0 <= search_parent_index:
                search_sibling_index = grand.get_child(search_parent_index).get_child_count() - 1
        if isinstance(grand, SymmetricComponent) and self._inline(grand):
            if (self.parent.get_axial_offset(AxialMethod.TOP) + self.get_axial_offset(AxialMethod.TOP)) > 0:
                return grand
            return grand.get_previous_symmetric_component()
        return None

    def _prev_from_assembly(self, parent, previous, flush_offset: float):
        if previous is None:
            return parent
        if parent is None:
            return previous
        max_radius = 0.0 if previous.is_aft_radius_automatic() else previous.get_aft_radius()
        prev_comp = previous
        for assembly in parent.get_direct_child_assemblies():
            if assembly.get_child_count() == 0:
                continue
            last = assembly.get_child(assembly.get_child_count() - 1)
            if not (isinstance(last, SymmetricComponent) and parent._inline(last)):
                continue
            flush_dev = flush_offset + assembly.get_axial_offset(AxialMethod.BOTTOM)
            if mu.equals(flush_dev, 0) and not last.is_aft_radius_automatic() and last.get_aft_radius() > max_radius:
                prev_comp = last
                max_radius = prev_comp.get_aft_radius()
            prev_comp = self._prev_from_assembly(last, prev_comp, flush_dev)
            if prev_comp is not None and not prev_comp.is_aft_radius_automatic():
                max_radius = prev_comp.get_aft_radius()
        return prev_comp

    def get_next_symmetric_component(self) -> "SymmetricComponent | None":
        from .assemblies import ComponentAssembly
        if self.parent is None or self.parent.parent is None:
            return None
        grand = self.parent.parent
        search_parent_index = grand.get_child_position(self.parent)
        search_sibling_index = self.parent.get_child_position(self) + 1
        while search_parent_index < grand.get_child_count():
            search_parent = grand.get_child(search_parent_index)
            if isinstance(search_parent, ComponentAssembly):
                while search_sibling_index < search_parent.get_child_count():
                    sib = search_parent.get_child(search_sibling_index)
                    if isinstance(sib, SymmetricComponent) and self._inline(sib):
                        return self._next_from_assembly(sib, sib, 0.0)
                    search_sibling_index += 1
            search_parent_index += 1
            search_sibling_index = 0
        for child in self.children:
            if isinstance(child, ComponentAssembly):
                for gc in child.children:
                    if isinstance(gc, SymmetricComponent) and self._inline(gc):
                        if (self.parent.get_axial_offset(AxialMethod.BOTTOM)
                                + self.get_axial_offset(AxialMethod.BOTTOM)) < 0:
                            return gc
                        return gc.get_next_symmetric_component()
        return None

    def _next_from_assembly(self, parent, nxt, flush_offset: float):
        if nxt is None:
            return parent
        if parent is None:
            return nxt
        max_radius = 0.0 if nxt.is_fore_radius_automatic() else nxt.get_fore_radius()
        next_comp = nxt
        for assembly in parent.get_direct_child_assemblies():
            if assembly.get_child_count() == 0:
                continue
            first = assembly.get_child(0)
            if not (isinstance(first, SymmetricComponent) and parent._inline(first)):
                continue
            flush_dev = flush_offset + assembly.get_axial_offset(AxialMethod.TOP)
            if mu.equals(flush_dev, 0) and not first.is_fore_radius_automatic() and first.get_fore_radius() > max_radius:
                next_comp = first
                max_radius = next_comp.get_fore_radius()
            next_comp = self._next_from_assembly(first, next_comp, flush_dev)
            if next_comp is not None and not next_comp.is_fore_radius_automatic():
                max_radius = next_comp.get_fore_radius()
        return next_comp

    def _inline(self, candidate) -> bool:
        from .assemblies import ParallelStage, PodSet
        ring = (ParallelStage, PodSet)  # RingInstanceable assemblies
        if self.parent is candidate.parent:
            return True
        if isinstance(self.parent, ring) and not mu.equals(
                self.parent.get_radius_method().get_radius(self.parent.parent, self, self.parent.get_radius_offset()), 0):
            return False
        if isinstance(candidate.parent, ring):
            if candidate.parent.parent is self and (self.is_aft_radius_automatic() or self.is_fore_radius_automatic()):
                return False
            return mu.equals(candidate.parent.get_radius_method().get_radius(
                candidate.parent.parent, candidate, candidate.parent.get_radius_offset()), 0)
        return True


def _jdiv(a: float, b: float) -> float:
    """Java double division (no ZeroDivisionError)."""
    if b != 0:
        return a / b
    if a == 0 or math.isnan(a):
        return math.nan
    return math.copysign(math.inf, a) * (math.copysign(1.0, b))


# ---------------------------------------------------------------------------- Transition.Shape

MINFEATURE = 0.001
CLIP_PRECISION = 0.0001


class Shape(Enum):
    CONICAL = "conical"
    OGIVE = "ogive"
    ELLIPSOID = "ellipsoid"
    POWER = "power"
    PARABOLIC = "parabolic"
    HAACK = "haack"

    def is_clippable(self) -> bool:
        return self in (Shape.ELLIPSOID, Shape.POWER, Shape.HAACK)

    def uses_parameter(self) -> bool:
        return self in (Shape.OGIVE, Shape.POWER, Shape.PARABOLIC, Shape.HAACK)

    def min_parameter(self) -> float:
        return 0.0

    def max_parameter(self) -> float:
        return 1.0 / 3.0 if self is Shape.HAACK else 1.0

    def default_parameter(self) -> float:
        if self is Shape.OGIVE or self is Shape.PARABOLIC:
            return 1.0
        if self is Shape.POWER:
            return 0.5
        return 0.0

    def get_radius(self, x: float, radius: float, length: float, param: float) -> float:
        if self is Shape.CONICAL:
            return radius * x / length
        if self is Shape.OGIVE:
            if length < radius:
                x = x * radius / length
                length = radius
            if param < MINFEATURE:
                return Shape.CONICAL.get_radius(x, radius, length, param)
            R = mu.safe_sqrt((pow2(length) + pow2(radius))
                             * (pow2((2 - param) * length) + pow2(param * radius)) / (4 * pow2(param * radius)))
            L = length / param
            y0 = mu.safe_sqrt(R * R - L * L)
            return mu.safe_sqrt(R * R - (L - x) * (L - x)) - y0
        if self is Shape.ELLIPSOID:
            x = x * radius / length
            return mu.safe_sqrt(2 * radius * x - x * x)
        if self is Shape.POWER:
            if param <= 0.00001:
                if x <= 0.00001:
                    return 0.0
                return radius
            return radius * math.pow(x / length, param)
        if self is Shape.PARABOLIC:
            return radius * ((2 * x / length - param * pow2(x / length)) / (2 - param))
        # HAACK
        theta = math.acos(1 - 2 * x / length)
        if mu.equals(param, 0):
            return radius * mu.safe_sqrt((theta - math.sin(2 * theta) / 2) / math.pi)
        return radius * mu.safe_sqrt((theta - math.sin(2 * theta) / 2 + param * mu.pow3(math.sin(theta))) / math.pi)

    @staticmethod
    def parse(s: str) -> "Shape":
        s = s.strip()
        for sh in Shape:
            if sh.name.lower() == s:
                return sh
        raise ValueError(f"unknown transition shape {s!r}")


class Transition(SymmetricComponent):
    ORK_TYPE = "transition"

    def __init__(self):
        super().__init__()
        self.fore_radius = DEFAULT_RADIUS
        self.aft_radius = DEFAULT_RADIUS
        self.length = DEFAULT_RADIUS * 3
        self.auto_fore_radius = True
        self.auto_aft_radius = True
        self.type = Shape.CONICAL
        self.shape_parameter = 0.0
        self.clipped = True
        self.fore_shoulder_radius = 0.0
        self.fore_shoulder_thickness = 0.0
        self.fore_shoulder_length = 0.0
        self.fore_shoulder_capped = False
        self.aft_shoulder_radius = 0.0
        self.aft_shoulder_thickness = 0.0
        self.aft_shoulder_length = 0.0
        self.aft_shoulder_capped = False
        self.clip_length = -1.0

    def get_component_name(self) -> str:
        return "Transition"

    def component_changed(self) -> None:
        SymmetricComponent.component_changed(self)
        self.clip_length = -1.0

    def is_compatible(self, component) -> bool:
        from .fins import FreeformFinSet
        from .internal import InternalComponent
        return isinstance(component, (InternalComponent, FreeformFinSet))

    def set_length(self, length: float) -> None:
        if self.length == length:
            return
        BodyComponent.set_length(self, length)

    # -- radii --------------------------------------------------------------------------
    def get_fore_radius(self) -> float:
        if self.is_fore_radius_automatic():
            self.fore_radius = self.get_auto_fore_radius()
        return self.fore_radius

    def get_auto_fore_radius(self) -> float:
        c = self.get_previous_symmetric_component()
        if c is not None:
            return c.get_front_auto_radius()
        return DEFAULT_RADIUS

    def set_fore_radius(self, radius: float, do_clamping: bool = True) -> None:
        if self.fore_radius == radius and not self.auto_fore_radius:
            return
        self.auto_fore_radius = False
        self.fore_radius = max(radius, 0.0)
        if do_clamping and self.thickness > self.fore_radius and self.thickness > self.aft_radius:
            self.thickness = max(self.fore_radius, self.aft_radius)
        self.set_fore_shoulder_radius(self.get_fore_shoulder_radius(), do_clamping)
        self._fire()

    def is_fore_radius_automatic(self) -> bool:
        return self.auto_fore_radius

    def set_fore_radius_automatic(self, auto: bool, sanity_check: bool = False) -> None:
        if sanity_check:
            auto = auto and self.can_use_previous_comp_automatic()
        if self.auto_fore_radius == auto:
            return
        self.auto_fore_radius = auto
        self._fire()

    def get_aft_radius(self) -> float:
        if self.is_aft_radius_automatic():
            self.aft_radius = self.get_auto_aft_radius()
        return self.aft_radius

    def get_auto_aft_radius(self) -> float:
        c = self.get_next_symmetric_component()
        if c is not None:
            return c.get_rear_auto_radius()
        return DEFAULT_RADIUS

    def set_aft_radius(self, radius: float, do_clamping: bool = True) -> None:
        if self.aft_radius == radius and not self.auto_aft_radius:
            return
        self.auto_aft_radius = False
        self.aft_radius = max(radius, 0.0)
        if do_clamping and self.thickness > self.fore_radius and self.thickness > self.aft_radius:
            self.thickness = max(self.fore_radius, self.aft_radius)
        self.set_aft_shoulder_radius(self.get_aft_shoulder_radius())  # (always clamps, as in Java)
        self._fire()

    def is_aft_radius_automatic(self) -> bool:
        return self.auto_aft_radius

    def set_aft_radius_automatic(self, auto: bool, sanity_check: bool = False) -> None:
        if sanity_check:
            auto = auto and self.can_use_next_comp_automatic()
        if self.auto_aft_radius == auto:
            return
        self.auto_aft_radius = auto
        self._fire()

    def get_front_auto_radius(self) -> float:
        if self.is_aft_radius_automatic():
            return -1.0
        return self.get_aft_radius()

    def get_rear_auto_radius(self) -> float:
        if self.is_fore_radius_automatic():
            return -1.0
        return self.get_fore_radius()

    def uses_previous_comp_automatic(self) -> bool:
        return self.is_fore_radius_automatic()

    def uses_next_comp_automatic(self) -> bool:
        return self.is_aft_radius_automatic()

    def can_use_previous_comp_automatic(self) -> bool:
        ref = self.get_previous_symmetric_component()
        return ref is not None and not ref.uses_next_comp_automatic()

    def can_use_next_comp_automatic(self) -> bool:
        ref = self.get_next_symmetric_component()
        return ref is not None and not ref.uses_previous_comp_automatic()

    # -- shape ------------------------------------------------------------------------
    def get_shape_type(self) -> Shape:
        return self.type

    def set_shape_type(self, t: Shape) -> None:
        if self.type is t:
            return
        self.type = t
        self.clipped = t.is_clippable()
        self.shape_parameter = t.default_parameter()
        self._fire()

    def get_shape_parameter(self) -> float:
        return self.shape_parameter

    def set_shape_parameter(self, n: float) -> None:
        if self.shape_parameter == n:
            return
        self.shape_parameter = mu.clamp(n, self.type.min_parameter(), self.type.max_parameter())
        self._fire()

    def is_clipped(self) -> bool:
        if not self.type.is_clippable():
            return False
        return self.clipped

    def set_clipped(self, c: bool) -> None:
        if self.clipped == c:
            return
        self.clipped = c
        self._fire()

    # -- shoulders --------------------------------------------------------------------
    def get_fore_shoulder_radius(self) -> float:
        return self.fore_shoulder_radius

    def set_fore_shoulder_radius(self, r: float, do_clamping: bool = True) -> None:
        if do_clamping:
            r = min(r, self.get_fore_radius())
        if mu.equals(self.fore_shoulder_radius, r):
            return
        self.fore_shoulder_radius = r
        if do_clamping:
            self.fore_shoulder_thickness = min(self.fore_shoulder_radius, self.fore_shoulder_thickness)
        self._fire()

    def get_fore_shoulder_thickness(self) -> float:
        return self.fore_shoulder_thickness

    def set_fore_shoulder_thickness(self, t: float) -> None:
        if mu.equals(self.fore_shoulder_thickness, t):
            return
        self.fore_shoulder_thickness = t
        self._fire()

    def get_fore_shoulder_length(self) -> float:
        return self.fore_shoulder_length

    def set_fore_shoulder_length(self, l: float) -> None:
        if mu.equals(self.fore_shoulder_length, l):
            return
        self.fore_shoulder_length = l
        self._fire()

    def is_fore_shoulder_capped(self) -> bool:
        return self.fore_shoulder_capped

    def set_fore_shoulder_capped(self, c: bool) -> None:
        if self.fore_shoulder_capped == c:
            return
        self.fore_shoulder_capped = c
        self._fire()

    def get_aft_shoulder_radius(self) -> float:
        return self.aft_shoulder_radius

    def set_aft_shoulder_radius(self, r: float, do_clamping: bool = True) -> None:
        if do_clamping:
            r = min(r, self.get_aft_radius())
        if mu.equals(self.aft_shoulder_radius, r):
            return
        self.aft_shoulder_radius = r
        if do_clamping:
            self.aft_shoulder_thickness = min(self.aft_shoulder_radius, self.aft_shoulder_thickness)
        self._fire()

    def get_aft_shoulder_thickness(self) -> float:
        return self.aft_shoulder_thickness

    def set_aft_shoulder_thickness(self, t: float) -> None:
        if mu.equals(self.aft_shoulder_thickness, t):
            return
        self.aft_shoulder_thickness = t
        self._fire()

    def get_aft_shoulder_length(self) -> float:
        return self.aft_shoulder_length

    def set_aft_shoulder_length(self, l: float) -> None:
        if mu.equals(self.aft_shoulder_length, l):
            return
        self.aft_shoulder_length = l
        self._fire()

    def is_aft_shoulder_capped(self) -> bool:
        return self.aft_shoulder_capped

    def set_aft_shoulder_capped(self, c: bool) -> None:
        if self.aft_shoulder_capped == c:
            return
        self.aft_shoulder_capped = c
        self._fire()

    # -- geometry ---------------------------------------------------------------------
    def get_radius(self, x: float) -> float:
        if x < 0:
            return self.get_fore_radius()
        if x >= self.length:
            return self.get_aft_radius()
        r1 = self.get_fore_radius()
        r2 = self.get_aft_radius()
        if r1 == r2:
            return r1
        if r1 > r2:
            x = self.length - x
            r1, r2 = r2, r1
        if self.is_clipped():
            if self.clip_length < 0:
                self._calculate_clip(r1, r2)
            return self.type.get_radius(self.clip_length + x, r2, self.clip_length + self.length, self.shape_parameter)
        return r1 + self.type.get_radius(x, r2 - r1, self.length, self.shape_parameter)

    def _calculate_clip(self, r1: float, r2: float) -> None:
        lo, hi = 0.0, self.length
        if r1 >= r2:
            r1, r2 = r2, r1
        if r1 == 0:
            self.clip_length = 0.0
            return
        if self.length <= 0:
            self.clip_length = 0.0
            return
        n = 0
        while self.type.get_radius(hi, r2, hi + self.length, self.shape_parameter) - r1 < 0:
            lo = hi
            hi *= 2
            n += 1
            if n > 10:
                break
        while True:
            self.clip_length = (lo + hi) / 2
            if (hi - lo) < CLIP_PRECISION:
                return
            val = self.type.get_radius(self.clip_length, r2, self.clip_length + self.length, self.shape_parameter)
            if val - r1 > 0:
                hi = self.clip_length
            else:
                lo = self.clip_length

    def get_inner_radius(self, x: float) -> float:
        return max(self.get_radius(x) - self.thickness, 0.0)

    def get_component_bounds(self) -> list[Coordinate]:
        b = SymmetricComponent.get_component_bounds(self)
        if self.fore_shoulder_length > MINFEATURE:
            self.add_bound(b, -self.fore_shoulder_length, self.fore_shoulder_radius)
        if self.aft_shoulder_length > MINFEATURE:
            self.add_bound(b, self.get_length() + self.aft_shoulder_length, self.aft_shoulder_radius)
        return b

    def calculate_properties(self) -> dict:
        """Transition.calculateProperties: the frustum integral plus shoulders and caps."""
        p = SymmetricComponent.calculate_properties(self)
        if not (self.get_fore_shoulder_length() > MINFEATURE or self.get_aft_shoulder_length() > MINFEATURE):
            return p
        density = self.get_material().density
        trans_volume = p["volume"]
        trans_long = p["long"] * trans_volume
        trans_rot = p["rot"] * trans_volume
        trans_cg = p["cg"]

        fore_cap_volume = 0.0
        fore_cap_cg = Coordinate()
        fore_cap_long = fore_cap_rot = 0.0
        if self.is_fore_shoulder_capped():
            ir = max(self.get_fore_shoulder_radius() - self.get_fore_shoulder_thickness(), 0.0)
            fore_cap_cg = ring_cg(ir, 0, -self.get_fore_shoulder_length(),
                                  self.get_fore_shoulder_thickness() - self.get_fore_shoulder_length(), density)
            fore_cap_volume = ring_volume(ir, 0, self.get_fore_shoulder_thickness())
            fore_cap_long = ring_longitudinal_unit_inertia(ir, 0, self.get_fore_shoulder_thickness()) * fore_cap_volume
            fore_cap_rot += ring_rotational_unit_inertia(ir, 0.0) * fore_cap_volume

        fore_sh_volume = 0.0
        fore_sh_cg = Coordinate()
        fore_sh_long = fore_sh_rot = 0.0
        if self.get_fore_shoulder_length() > MINFEATURE:
            orad = self.get_fore_shoulder_radius()
            ir = max(self.get_fore_shoulder_radius() - self.get_fore_shoulder_thickness(), 0.0)
            fore_sh_cg = ring_cg(self.get_fore_shoulder_radius(), ir, -self.get_fore_shoulder_length(), 0, density)
            fore_sh_volume = ring_volume(orad, ir, self.get_fore_shoulder_length())
            fore_sh_long = ring_longitudinal_unit_inertia(orad, ir, self.get_fore_shoulder_length()) * fore_sh_volume
            fore_sh_rot = ring_rotational_unit_inertia(orad, ir) * fore_sh_volume

        aft_sh_volume = 0.0
        aft_sh_cg = Coordinate()
        aft_sh_long = aft_sh_rot = 0.0
        if self.get_aft_shoulder_length() > MINFEATURE:
            orad = self.get_aft_shoulder_radius()
            ir = max(self.get_aft_shoulder_radius() - self.get_aft_shoulder_thickness(), 0.0)
            aft_sh_cg = ring_cg(self.get_aft_shoulder_radius(), ir, self.get_length(),
                                self.get_length() + self.get_aft_shoulder_length(), density)
            aft_sh_volume = ring_volume(orad, ir, self.get_aft_shoulder_length())
            aft_sh_long = ring_longitudinal_unit_inertia(orad, ir, self.get_aft_shoulder_length()) * aft_sh_volume
            aft_sh_rot = ring_rotational_unit_inertia(orad, ir) * aft_sh_volume

        aft_cap_volume = 0.0
        aft_cap_cg = Coordinate()
        aft_cap_long = aft_cap_rot = 0.0
        if self.is_aft_shoulder_capped():
            ir = max(self.get_aft_shoulder_radius() - self.get_aft_shoulder_thickness(), 0.0)
            aft_cap_cg = ring_cg(ir, 0, self.get_length() + self.get_aft_shoulder_length() - self.get_aft_shoulder_thickness(),
                                 self.get_length() + self.get_aft_shoulder_length(), density)
            aft_cap_volume = ring_volume(ir, 0, self.get_aft_shoulder_thickness())
            # (Java uses the *fore* shoulder thickness here; kept.)
            aft_cap_long = ring_longitudinal_unit_inertia(ir, 0, self.get_fore_shoulder_thickness()) * aft_cap_volume
            aft_cap_rot = ring_rotational_unit_inertia(ir, 0.0) * aft_cap_volume

        volume = fore_cap_volume + fore_sh_volume + trans_volume + aft_sh_volume + aft_cap_volume
        cgx = (fore_cap_cg.x * fore_cap_cg.weight + fore_sh_cg.x * fore_sh_cg.weight + trans_cg.x * trans_cg.weight
               + aft_sh_cg.x * aft_sh_cg.weight + aft_cap_cg.x * aft_cap_cg.weight)
        mass = fore_cap_cg.weight + fore_sh_cg.weight + trans_cg.weight + aft_sh_cg.weight + aft_cap_cg.weight
        p = dict(p)
        p["volume"] = volume
        if mass < mu.EPSILON:
            p["cg"] = Coordinate(0.0, 0.0, 0.0, 0.0)
            p["long"] = 0.0
            p["rot"] = 0.0
            return p
        cg = Coordinate(cgx / mass, 0.0, 0.0, mass)
        fore_cap_long += pow2(cg.x - fore_cap_cg.x) * fore_cap_volume
        fore_sh_long += pow2(cg.x - fore_sh_cg.x) * fore_sh_volume
        trans_long += pow2(cg.x - trans_cg.x) * trans_volume
        aft_sh_long += pow2(cg.x - aft_sh_cg.x) * aft_sh_volume
        aft_cap_long += pow2(cg.x - aft_cap_cg.x) * aft_cap_volume
        long_moi = fore_cap_long + fore_sh_long + trans_long + aft_sh_long + aft_cap_long
        rot_moi = fore_cap_rot + fore_sh_rot + trans_rot + aft_sh_rot + aft_cap_rot
        p["cg"] = cg
        p["long"] = _jdiv(long_moi, volume)
        p["rot"] = _jdiv(rot_moi, volume)
        return p


class NoseCone(Transition):
    ORK_TYPE = "nosecone"

    def __init__(self):
        super().__init__()
        # The state NoseCone(Shape.OGIVE, 6*DEFAULT_RADIUS, DEFAULT_RADIUS) leaves behind.
        self.is_flipped_ = False
        self.type = Shape.OGIVE
        self.clipped = False
        self.shape_parameter = 1.0
        self.length = 6 * DEFAULT_RADIUS
        self.fore_radius = 0.0
        self.auto_fore_radius = False
        self.auto_aft_radius = False
        self.aft_radius = DEFAULT_RADIUS

    def get_component_name(self) -> str:
        return "Nose cone"

    def is_clipped(self) -> bool:
        return False

    def set_clipped(self, c: bool) -> None:
        pass

    def is_flipped(self) -> bool:
        return self.is_flipped_

    def get_base_radius(self) -> float:
        return self.get_fore_radius() if self.is_flipped_ else self.get_aft_radius()

    def is_base_radius_automatic(self) -> bool:
        return self.is_fore_radius_automatic() if self.is_flipped_ else self.is_aft_radius_automatic()

    def get_shoulder_length(self) -> float:
        return self.get_fore_shoulder_length() if self.is_flipped_ else self.get_aft_shoulder_length()

    def get_shoulder_radius(self) -> float:
        return self.get_fore_shoulder_radius() if self.is_flipped_ else self.get_aft_shoulder_radius()

    def get_shoulder_thickness(self) -> float:
        return self.get_fore_shoulder_thickness() if self.is_flipped_ else self.get_aft_shoulder_thickness()

    def is_shoulder_capped(self) -> bool:
        return self.is_fore_shoulder_capped() if self.is_flipped_ else self.is_aft_shoulder_capped()

    def set_flipped(self, flipped: bool, sanity_check: bool = True) -> None:
        if self.is_flipped_ == flipped:
            return
        previous = self._bypass
        self._bypass = True
        if flipped:
            self.set_fore_radius(self.get_aft_radius())
            self.set_fore_radius_automatic(self.is_aft_radius_automatic(), sanity_check)
            self.set_fore_shoulder_length(self.get_aft_shoulder_length())
            self.set_fore_shoulder_radius(self.get_aft_shoulder_radius())
            self.set_fore_shoulder_thickness(self.get_aft_shoulder_thickness())
            self.set_fore_shoulder_capped(self.is_aft_shoulder_capped())
            self._reset_aft_radius()
        else:
            self.set_aft_radius(self.get_fore_radius())
            self.set_aft_radius_automatic(self.is_fore_radius_automatic(), sanity_check)
            self.set_aft_shoulder_length(self.get_fore_shoulder_length())
            self.set_aft_shoulder_radius(self.get_fore_shoulder_radius())
            self.set_aft_shoulder_thickness(self.get_fore_shoulder_thickness())
            self.set_aft_shoulder_capped(self.is_fore_shoulder_capped())
            self._reset_fore_radius()
        self._bypass = previous
        self.is_flipped_ = flipped
        self._fire()

    def _reset_fore_radius(self) -> None:
        self.set_fore_radius(0)
        self.set_fore_radius_automatic(False)
        self.set_fore_shoulder_length(0)
        self.set_fore_shoulder_radius(0)
        self.set_fore_shoulder_thickness(0)
        self.set_fore_shoulder_capped(False)

    def _reset_aft_radius(self) -> None:
        self.set_aft_radius(0)
        self.set_aft_radius_automatic(False)
        self.set_aft_shoulder_length(0)
        self.set_aft_shoulder_radius(0)
        self.set_aft_shoulder_thickness(0)
        self.set_aft_shoulder_capped(False)


class BodyTube(SymmetricComponent):
    ORK_TYPE = "bodytube"

    def __init__(self):
        super().__init__()
        # BodyTube(): this(8*DEFAULT_RADIUS, DEFAULT_RADIUS); autoRadius = true
        self.outer_radius = DEFAULT_RADIUS
        self.length = 8 * DEFAULT_RADIUS
        self.auto_radius = True
        self.ref_comp = None
        self.overhang = 0.0
        self.is_acting_mount = False

    def get_component_name(self) -> str:
        return "Body tube"

    def is_compatible(self, component) -> bool:
        from .assemblies import ParallelStage, PodSet
        from .external import ExternalComponent
        from .internal import InternalComponent
        if isinstance(component, (ParallelStage, PodSet, InternalComponent)):
            return True
        return isinstance(component, ExternalComponent) and not isinstance(component, BodyComponent)

    def _on_child_added(self, component) -> None:
        from .fins import TubeFinSet
        if isinstance(component, TubeFinSet) and math.isnan(component.thickness):
            component.set_thickness(self.get_thickness())

    # -- radius -----------------------------------------------------------------------
    def get_outer_radius(self, x: float | None = None) -> float:  # type: ignore[override]
        if self.auto_radius:
            self.outer_radius = self._get_auto_outer_radius()
        return self.outer_radius

    def _get_auto_outer_radius(self) -> float:
        r = -1.0
        c = self.get_previous_symmetric_component()
        if c is not None and not c.uses_next_comp_automatic():
            r = c.get_front_auto_radius()
            self.ref_comp = c
        if r < 0:
            c = self.get_next_symmetric_component()
            if c is not None and not c.uses_previous_comp_automatic():
                r = c.get_rear_auto_radius()
                self.ref_comp = c
        if r < 0:
            r = DEFAULT_RADIUS
        return r

    def set_outer_radius(self, radius: float) -> None:
        if self.outer_radius == radius and not self.auto_radius:
            return
        self.auto_radius = False
        self.outer_radius = max(radius, 0.0)
        if self.thickness > self.outer_radius:
            self.thickness = self.outer_radius
        self._fire()

    def is_outer_radius_automatic(self) -> bool:
        return self.auto_radius

    def set_outer_radius_automatic(self, auto: bool) -> None:
        if self.auto_radius == auto:
            return
        self.auto_radius = auto
        self._fire()

    def uses_previous_comp_automatic(self) -> bool:
        return self.is_outer_radius_automatic() and self.ref_comp is self.get_previous_symmetric_component()

    def uses_next_comp_automatic(self) -> bool:
        return self.is_outer_radius_automatic() and self.ref_comp is self.get_next_symmetric_component()

    def get_aft_radius(self) -> float:
        return self.get_outer_radius()

    def get_fore_radius(self) -> float:
        return self.get_outer_radius()

    def is_aft_radius_automatic(self) -> bool:
        return self.is_outer_radius_automatic()

    def is_fore_radius_automatic(self) -> bool:
        return self.is_outer_radius_automatic()

    def get_front_auto_radius(self) -> float:
        if self.is_outer_radius_automatic():
            c = self.get_previous_symmetric_component()
            if c is not None:
                return c.get_front_auto_radius()
            return -1.0
        return self.get_outer_radius()

    def get_rear_auto_radius(self) -> float:
        if self.is_outer_radius_automatic():
            c = self.get_next_symmetric_component()
            if c is not None:
                return c.get_rear_auto_radius()
            return -1.0
        return self.get_outer_radius()

    def get_inner_radius(self, x: float | None = None) -> float:  # type: ignore[override]
        if self.filled:
            return 0.0
        return max(self.get_outer_radius() - self.thickness, 0.0)

    def set_inner_radius(self, r: float) -> None:
        self.set_thickness(self.get_outer_radius() - r)

    def get_radius(self, x: float) -> float:
        return self.get_outer_radius()

    # -- mass ---------------------------------------------------------------------------
    def get_component_cg(self) -> Coordinate:
        return Coordinate(self.length / 2, 0.0, 0.0, self.get_component_mass())

    @staticmethod
    def _filled_volume(r: float, l: float) -> float:
        return math.pi * r * r * l

    def get_component_volume(self) -> float:
        r = self.get_outer_radius()
        if self.filled:
            return self._filled_volume(r, self.length)
        return self._filled_volume(r, self.length) - self._filled_volume(self.get_inner_radius(0), self.length)

    def get_longitudinal_unit_inertia(self) -> float:
        return (3 * (pow2(self.get_outer_radius()) + pow2(self.get_inner_radius())) + pow2(self.get_length())) / 12

    def get_rotational_unit_inertia(self) -> float:
        return (pow2(self.get_inner_radius()) + pow2(self.get_outer_radius())) / 2

    def get_component_wet_area(self) -> float:
        return math.pi * self.get_outer_radius() * 2 * self.get_length()

    def get_component_planform_area(self) -> float:
        return self.get_outer_radius() * 2 * self.get_length()

    def get_instance_bounding_box(self) -> BoundingBox:
        b = BoundingBox()
        b.update(Coordinate(self.get_length(), 0.0, 0.0))
        r = self.get_outer_radius()
        b.update(Coordinate(0.0, r, r))
        b.update(Coordinate(0.0, -r, -r))
        return b

    # -- motor mount --------------------------------------------------------------------
    def is_motor_mount(self) -> bool:
        return self.is_acting_mount

    def set_motor_mount(self, active: bool) -> None:
        if self.is_acting_mount == active:
            return
        self.is_acting_mount = active
        self._fire()

    def get_motor_overhang(self) -> float:
        return self.overhang

    def set_motor_overhang(self, overhang: float) -> None:
        if mu.equals(self.overhang, overhang):
            return
        self.overhang = overhang
        self._fire()

    def get_motor_mount_diameter(self) -> float:
        return self.get_inner_radius() * 2

    def get_motor_count(self) -> int:
        return 1

    def get_cluster_count(self) -> int:
        return 1
