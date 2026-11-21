"""Fin sets.

Ported from OpenRocket 24.12 (GPLv3): info.openrocket.core.rocketcomponent.FinSet,
TrapezoidFinSet, EllipticalFinSet, FreeformFinSet, TubeFinSet
(and java.awt.geom.Line2D.linesIntersect for FreeformFinSet.intersects).

Fin points are in the fin's own frame: x aft from the fin's leading root
point, y outward from the body surface at that point.
"""

from __future__ import annotations

import math
from enum import Enum

from .. import material as mat
from ..util import mathutil as mu
from ..util.coordinate import IDENTITY, NUL, ZERO, BoundingBox, Coordinate, Transformation
from .base import RocketComponent
from .external import ExternalComponent, Tube
from .position import AngleMethod, AxialMethod, RadiusMethod

MAX_CANT_RADIANS = 15.0 * math.pi / 180
MAX_ROOT_DIVISIONS = 100
MAX_ROOT_DIVISIONS_LOW_RES = MAX_ROOT_DIVISIONS // 5
MINIMUM_TAB_AREA = 1.0e-8


class CrossSection(Enum):
    SQUARE = 1.00
    ROUNDED = 0.99
    AIRFOIL = 0.85

    def get_relative_volume(self) -> float:
        return self.value

    @staticmethod
    def parse(s: str) -> "CrossSection":
        s = s.strip()
        for c in CrossSection:
            if c.name.lower() == s:
                return c
        raise ValueError(f"unknown cross section {s!r}")


def translate_points(inp, x_delta: float, y_delta: float) -> list[Coordinate]:
    return [Coordinate(p.x + x_delta, p.y + y_delta) for p in inp]


def combine_curves(c1, c2) -> list[Coordinate]:
    return list(c1) + list(reversed(list(c2)))


def calculate_curve_integral(points) -> Coordinate:
    """FinSet.calculateCurveIntegral: area centroid of a closed polyline."""
    s = Coordinate(0.0)
    if not points:
        return s
    prev = points[0]
    for cur in points[1:]:
        dx = cur.x - prev.x
        y_avg = (cur.y + prev.y) * 0.5
        area = dx * y_avg
        if mu.equals(0, area):
            prev = cur
            continue
        common = 1 / (3 * (cur.y + prev.y))
        x_ctr = common * (prev.x * (2 * prev.y + cur.y) + cur.x * (2 * cur.y + prev.y))
        y_ctr = common * (cur.y * prev.y + math.pow(cur.y, 2) + math.pow(prev.y, 2))
        s = s.average(Coordinate(x_ctr, y_ctr, 0.0, area))
        prev = cur
    if s.weight < 0:
        s = Coordinate(s.x, -s.y, s.z, abs(s.weight))
    return s


class FinSet(ExternalComponent):
    def __init__(self):
        super().__init__(AxialMethod.BOTTOM)
        self.fin_count = 3
        self.fin_rotation_increment = IDENTITY
        self.angle_method = AngleMethod.RELATIVE
        self.first_fin_offset = 0.0
        self.base_rotation = IDENTITY
        self.cant_radians = 0.0
        self.cant_rotation = None
        self.thickness = 0.003
        self.cross_section = CrossSection.SQUARE
        self.tab_height = 0.0
        self.tab_length = 0.05
        self.tab_position = 0.0
        self.tab_offset_method = AxialMethod.MIDDLE
        self.tab_offset = 0.0
        self.fillet_material = mat.DEFAULT_BULK
        self.fillet_radius = 0.0
        self._cm = None  # (single planform area, total volume, center of mass)

    def is_after(self) -> bool:
        return False

    def component_changed(self) -> None:
        self._cm = None
        self.cant_rotation = None
        RocketComponent.component_changed(self)

    # -- counts / angles ---------------------------------------------------------------
    def get_fin_count(self) -> int:
        return self.fin_count

    def set_fin_count(self, n: int) -> None:
        if self.fin_count == n:
            return
        n = max(1, min(8, n))
        self.fin_count = n
        self.fin_rotation_increment = Transformation.rotate_x(2 * math.pi / self.fin_count)
        self._fire()

    def get_instance_count(self) -> int:
        return self.fin_count

    def set_instance_count(self, n: int) -> None:
        self.set_fin_count(n)

    def get_bounding_radius(self) -> float:
        return 0.0

    def get_base_rotation(self) -> float:
        return self.get_angle_offset()

    def set_base_rotation(self, r: float) -> None:
        self.set_angle_offset(r)

    def get_angle_offset(self) -> float:
        return self.first_fin_offset

    def set_angle_offset(self, angle: float) -> None:
        reduced = mu.reduce_pi(angle)
        if mu.equals(reduced, self.first_fin_offset):
            return
        self.first_fin_offset = reduced
        if mu.equals(self.first_fin_offset, 0):
            self.base_rotation = IDENTITY
        else:
            self.base_rotation = Transformation.rotate_x(self.first_fin_offset)
        self._fire()

    def get_angle_method(self) -> AngleMethod:
        return self.angle_method

    def set_angle_method(self, m: AngleMethod) -> None:
        self.angle_method = m
        self._fire()

    def get_radius_method(self) -> RadiusMethod:
        return RadiusMethod.SURFACE

    def set_radius_method(self, m) -> None:
        pass  # final SURFACE

    def set_radius_offset(self, r: float) -> None:
        pass

    def get_instance_angle_increment(self) -> float:
        return 2 * math.pi / self.get_fin_count()

    def get_instance_angles(self) -> list[float]:
        inc = self.get_instance_angle_increment()
        return [mu.reduce_2pi(self.first_fin_offset + inc * k) for k in range(self.get_fin_count())]

    def get_cant_angle(self) -> float:
        return self.cant_radians

    def set_cant_angle(self, rad: float) -> None:
        c = mu.clamp(rad, -MAX_CANT_RADIANS, MAX_CANT_RADIANS)
        if mu.equals(c, self.cant_radians):
            return
        self.cant_radians = c
        self._fire()

    def get_cant_rotation(self) -> Transformation:
        if self.cant_rotation is None:
            if mu.equals(self.cant_radians, 0):
                self.cant_rotation = IDENTITY
            else:
                self.cant_rotation = Transformation.rotate_y(self.cant_radians)
        return self.cant_rotation

    # -- section ----------------------------------------------------------------------
    def get_thickness(self) -> float:
        return self.thickness

    def set_thickness(self, r: float) -> None:
        if self.thickness == r:
            return
        self.thickness = max(r, 0.0)
        self._fire()

    def get_cross_section(self) -> CrossSection:
        return self.cross_section

    def set_cross_section(self, cs: CrossSection) -> None:
        if self.cross_section is cs:
            return
        self.cross_section = cs
        self._fire()

    def get_fillet_radius(self) -> float:
        return self.fillet_radius

    def set_fillet_radius(self, r: float) -> None:
        if mu.equals(self.fillet_radius, r):
            return
        self.fillet_radius = r
        self._fire()

    def get_fillet_material(self) -> mat.Material:
        return self.fillet_material

    def set_fillet_material(self, m: mat.Material) -> None:
        if m.type != mat.BULK:
            raise ValueError("fillet requires a bulk material")
        if self.fillet_material == m:
            return
        self.fillet_material = m
        self._fire()

    # -- tabs ---------------------------------------------------------------------------
    def get_tab_height(self) -> float:
        return self.tab_height

    def set_tab_height(self, h: float, validate: bool = True) -> None:
        if mu.equals(self.tab_height, mu.jmax(h, 0)):
            return
        self.tab_height = h
        if validate:
            self.tab_height = min(self.tab_height, self.get_max_tab_height())
        self._fire()

    def get_tab_length(self) -> float:
        return self.tab_length

    def set_tab_length(self, l: float, update_position: bool = True) -> None:
        if mu.equals(self.tab_length, mu.jmax(l, 0)):
            return
        self.tab_length = l
        if update_position:
            self.update_tab_position()
        self._fire()

    def update_tab_position(self) -> None:
        self.tab_position = self.tab_offset_method.get_as_position(self.tab_offset, self.tab_length, self.length)

    def set_tab_offset(self, o: float) -> None:
        self.tab_offset = o
        self.update_tab_position()
        self._fire()

    def get_tab_offset(self, method: AxialMethod | None = None) -> float:
        method = method or self.tab_offset_method
        return method.get_as_offset(self.tab_position, self.tab_length, self.length)

    def get_tab_offset_method(self) -> AxialMethod:
        return self.tab_offset_method

    def set_tab_offset_method(self, m: AxialMethod) -> None:
        self.tab_offset_method = m
        self.tab_offset = m.get_as_offset(self.tab_position, self.tab_length, self.length)
        self._fire()

    def get_tab_front_edge(self) -> float:
        return self.tab_position

    def get_tab_trailing_edge(self) -> float:
        return self.tab_position + self.tab_length

    def validate_fin_tab_length(self) -> None:
        back = self.get_tab_trailing_edge()
        if self.length < back:
            self.tab_length -= (back - self.length)
        self.tab_length = max(0.0, self.tab_length)

    def get_max_tab_height(self) -> float:
        f = self.get_parent_front_radius()
        t = self.get_parent_trailing_radius()
        if f is not None and t is not None:
            return mu.jmin(f, t)
        return 1.7976931348623157e308

    def get_parent_front_radius(self):
        from .symmetric import SymmetricComponent
        if isinstance(self.parent, SymmetricComponent):
            return self.parent.get_radius(self.get_fin_front().x + self.get_tab_front_edge())
        return None

    def get_parent_trailing_radius(self):
        from .symmetric import SymmetricComponent
        if isinstance(self.parent, SymmetricComponent):
            return self.parent.get_radius(self.get_fin_front().x + self.get_tab_trailing_edge())
        return None

    def is_tab_trivial(self) -> bool:
        return MINIMUM_TAB_AREA > (self.get_tab_length() * self.get_tab_height())

    def has_tab(self) -> bool:
        return self.get_tab_height() > 0 and self.get_tab_length() > 0

    # -- geometry -----------------------------------------------------------------------
    def get_fin_points(self) -> list[Coordinate]:
        raise NotImplementedError

    def get_span(self) -> float:
        raise NotImplementedError

    def get_body_radius(self) -> float:
        return self.get_fin_front().y

    def get_fin_front(self) -> Coordinate:
        x = self.get_axial_front()
        if self.parent is None:
            return Coordinate(0.0, 0.0)
        return Coordinate(x, self.parent.get_radius(x))

    def is_root_straight(self) -> bool:
        from .symmetric import Shape, Transition
        if isinstance(self.parent, Transition):
            return self.parent.get_shape_type() is Shape.CONICAL
        return True

    def get_root_points(self, max_divisions: int = MAX_ROOT_DIVISIONS) -> list[Coordinate]:
        if self.parent is None:
            return [ZERO]
        lead = self.get_fin_front()
        x_end = lead.x + self.get_length()
        return self._get_mount_points(lead.x, x_end, -lead.x, -lead.y, max_divisions)

    def get_mount_points(self):
        if self.parent is None:
            return None
        return self._get_mount_points(0.0, self.parent.get_length(), 0, 0)

    def _get_mount_points(self, x_start: float, x_end: float, x_offset: float, y_offset: float,
                          max_divisions: int = MAX_ROOT_DIVISIONS) -> list[Coordinate]:
        from .symmetric import Shape, Transition
        if self.parent is None:
            return [ZERO]
        div = 1
        parent = self.parent
        interval = x_end - x_start
        if (not mu.equals(self.get_cant_angle(), 0)) or (
                isinstance(parent, Transition) and parent.get_shape_type() is not Shape.CONICAL):
            div = int(math.ceil(interval / 0.0025))
            div = min(max_divisions, div)
        inc = interval / div
        x = x_start
        pts: list[Coordinate] = []
        for _ in range(div + 1):
            y = parent.get_radius(x)
            y += self._get_fin_cant_y_offset(x_start, x_end, x)
            pts.append(Coordinate(x, y))
            x += inc
        if x_start < 0 and x_end > 0:
            pts.insert(1, Coordinate(0.0, pts[0].y))
        if x_end > parent.length and x_start < parent.length:
            pts.insert(len(pts) - 1, Coordinate(parent.length, pts[-1].y))
        last = len(pts) - 1
        if abs(pts[last].x - parent.get_length()) < mu.EPSILON:
            pts[last] = pts[last].set_x(parent.get_length())
        if (abs(x_offset) + abs(y_offset)) > mu.EPSILON:
            pts = translate_points(pts, x_offset, y_offset)
        return pts

    def _get_fin_cant_y_offset(self, x_start: float, x_end: float, x_curr: float) -> float:
        parent = self.parent
        cant = self.get_cant_angle()
        if mu.equals(cant, 0) or (x_start > parent.length and x_end > parent.length) or (x_start < 0 and x_end < 0):
            return 0.0
        x = max(x_curr, 0.0)
        x = min(x, parent.get_length())
        x_center = (x_start + x_end) / 2
        dx = x - x_center
        x_rot = x_center + dx * abs(math.cos(cant))
        r_rot = parent.get_radius(x_rot)
        dz = abs(math.sin(cant)) * dx
        if dz >= r_rot:
            dy = 0.0
        else:
            dy = r_rot - math.sqrt(math.pow(r_rot, 2) - math.pow(dz, 2))
        return -dy

    def get_fin_points_with_root(self) -> list[Coordinate]:
        return combine_curves(self.get_fin_points(), self.get_root_points())

    def get_fin_points_with_low_res_root(self) -> list[Coordinate]:
        return combine_curves(self.get_fin_points(), self.get_root_points(MAX_ROOT_DIVISIONS_LOW_RES))

    def get_tab_points(self) -> list[Coordinate]:
        front, trail = self.get_tab_front_edge(), self.get_tab_trailing_edge()
        ff = self.get_fin_front()
        body = self.parent
        yf = yt = yb = math.nan
        if body is not None:
            yf = body.get_radius(ff.x + front) - ff.y
            yt = body.get_radius(ff.x + trail) - ff.y
            yb = mu.jmin(yf, yt) - self.tab_height
        return [Coordinate(front, yf), Coordinate(front, yb), Coordinate(trail, yb), Coordinate(trail, yt)]

    def get_tab_points_with_root(self, max_divisions: int = MAX_ROOT_DIVISIONS) -> list[Coordinate]:
        if not self.has_tab():
            return []
        front, trail = self.get_tab_front_edge(), self.get_tab_trailing_edge()
        root = [p for p in self.get_root_points(max_divisions) if front < p.x < trail]
        tab = self.get_tab_points()
        root.insert(0, Coordinate(tab[0].x, tab[0].y))
        return combine_curves(tab, root)

    # -- mass ---------------------------------------------------------------------------
    def _calculate_single_planform_centroid(self) -> Coordinate:
        lead = self.get_fin_front()
        x_trail = lead.x + self.get_length()
        upper = translate_points(self.get_fin_points(), 0, lead.y)
        lower = self._get_mount_points(lead.x, x_trail, -lead.x, 0)
        return calculate_curve_integral(combine_curves(upper, lower))

    def _calculate_tab_centroid(self) -> Coordinate:
        from .symmetric import SymmetricComponent
        if not isinstance(self.parent, SymmetricComponent) or self.is_tab_trivial():
            return ZERO
        front, trail = self.get_tab_front_edge(), self.get_tab_trailing_edge()
        ff = self.get_fin_front()
        upper = self._get_mount_points(ff.x + front, ff.x + trail, -ff.x, 0)
        lower = translate_points(self.get_tab_points_with_root(), 0.0, ff.y)
        return calculate_curve_integral(combine_curves(upper, lower))

    @staticmethod
    def _fillet_cross_section(fillet_radius: float, body_radius: float) -> Coordinate:
        hyp = fillet_radius + body_radius
        inner_arc = math.asin(fillet_radius / hyp) if -1 <= fillet_radius / hyp <= 1 else math.nan
        outer_arc = math.acos(fillet_radius / hyp) if -1 <= fillet_radius / hyp <= 1 else math.nan
        tri = math.tan(outer_arc) * fillet_radius * fillet_radius / 2
        area = tri - outer_arc * fillet_radius * fillet_radius / 2 - inner_arc * body_radius * body_radius / 2
        if math.isnan(area):
            area = 0.0
        else:
            area *= 2
        return Coordinate(0.0, body_radius + fillet_radius / 5, 0.0, area)

    def _calculate_fillet_volume_centroid(self) -> Coordinate:
        from .symmetric import SymmetricComponent
        if self.fillet_radius == 0 or self.parent is None or not isinstance(self.parent, SymmetricComponent):
            return ZERO
        mount_points = self.get_root_points()
        sym = self.parent
        lead = self.get_fin_front()
        root_points = self._get_mount_points(lead.x, lead.x + self.get_length(), -lead.x, -lead.y)
        if len(root_points) == 0:
            return ZERO
        c = ZERO
        prev = mount_points[0]
        for cur in mount_points[1:]:
            x_avg = (prev.x + cur.x) / 2
            body_r = sym.get_radius(x_avg)
            seg = self._fillet_cross_section(self.fillet_radius, body_r).set_x(x_avg)
            seg_len = math.sqrt((prev.x - cur.x) ** 2 + (prev.y - cur.y) ** 2)
            c = c.average(seg.set_weight(seg_len * seg.weight))
            prev = cur
        if self.fin_count == 1:
            return Transformation.rotate_x(self.get_angle_offset()).transform(c)
        return c.set_y(0.0)

    def _calculate_cm(self):
        if self._cm is None:
            wetted = self._calculate_single_planform_centroid()
            plan_area = wetted.weight
            wetted_volume = wetted.weight * self.thickness * self.cross_section.get_relative_volume()
            fin_bulk_mass = wetted_volume * self.material.density
            wetted_cm = wetted.set_weight(fin_bulk_mass)
            tab = self._calculate_tab_centroid()
            tab_volume = tab.weight * self.thickness
            tab_mass = tab_volume * self.material.density
            tab_cm = tab.set_weight(tab_mass)
            fillet = self._calculate_fillet_volume_centroid()
            fillet_volume = fillet.weight
            fillet_mass = fillet_volume * self.fillet_material.density
            fillet_cm = fillet.set_weight(fillet_mass)
            total_volume = (wetted_volume + tab_volume + fillet_volume) * self.fin_count
            each_mass = fin_bulk_mass + tab_mass + fillet_mass
            each_cm = wetted_cm.average(tab_cm).average(fillet_cm).set_weight(each_mass)
            if self.fin_count == 1:
                cm = self.base_rotation.transform(each_cm)
            else:
                cm = each_cm.set_y(0.0).set_weight(each_mass * self.fin_count)
            self._cm = (plan_area, total_volume, cm)
        return self._cm

    def get_planform_area(self) -> float:
        return self._calculate_cm()[0]

    def get_component_volume(self) -> float:
        return self._calculate_cm()[1]

    def get_component_mass(self) -> float:
        return self._calculate_cm()[2].weight

    def get_component_cg(self) -> Coordinate:
        return self._calculate_cm()[2]

    def get_longitudinal_unit_inertia(self) -> float:
        area = self.get_planform_area()
        w = self.get_length()
        h = self.get_span()
        if mu.equals(h * w, 0):
            w2 = h2 = area
        else:
            w2 = w * area / h
            h2 = h * area / w
        inertia = (h2 + 2 * w2) / 24
        if self.fin_count == 1:
            return inertia
        return inertia + mu.pow2(mu.safe_sqrt(h2) / 2 + self.get_body_radius()) / 2

    def get_rotational_unit_inertia(self) -> float:
        area = self.get_planform_area()
        w = self.get_length()
        h = self.get_span()
        if mu.equals(w * h, 0):
            h2 = area
        else:
            h2 = h * area / w
        inertia = h2 / 12
        if self.fin_count == 1:
            return inertia
        return inertia + mu.pow2(mu.safe_sqrt(h2) / 2 + self.get_body_radius())

    # -- instances & bounds ---------------------------------------------------------------
    def get_instance_offsets(self) -> list[Coordinate]:
        body_radius = self.get_body_radius()
        angles = self.get_instance_angles()
        local_cant = (Transformation.translation(self.length / 2, 0.0, 0.0)
                      .apply_transformation(self.get_cant_rotation())
                      .apply_transformation(Transformation.translation(-self.length / 2, 0.0, 0.0)))
        out = []
        for a in angles:
            canted = local_cant.transform(Coordinate(0.0, body_radius, 0.0))
            out.append(Transformation.rotate_x(a).transform(canted))
        return out

    def get_instance_bounding_box(self) -> BoundingBox:
        b = BoundingBox()
        b.update(self.get_fin_points())
        b.update(Coordinate(0.0, 0.0, -self.thickness / 2))
        b.update(Coordinate(0.0, 0.0, self.thickness / 2))
        return b

    def get_pattern_name(self) -> str:
        return f"{self.get_instance_count()}-fin-ring"


class TrapezoidFinSet(FinSet):
    ORK_TYPE = "trapezoidfinset"
    MAX_SWEEP_ANGLE = 89 * math.pi / 180.0

    def __init__(self):
        super().__init__()
        # TrapezoidFinSet(3, 0.05, 0.05, 0.025, 0.03)
        self.length = 0.05
        self.tip_chord = 0.05
        self.sweep = 0.025
        self.height = 0.03

    def get_component_name(self) -> str:
        return "Trapezoidal fin set"

    def get_root_chord(self) -> float:
        return self.length

    def set_root_chord(self, r: float) -> None:
        if self.length == r:
            return
        self.length = max(r, 0.0)
        self.update_tab_position()
        self._fire()

    def get_tip_chord(self) -> float:
        return self.tip_chord

    def set_tip_chord(self, r: float) -> None:
        if self.tip_chord == r:
            return
        self.tip_chord = max(r, 0.0)
        self._fire()

    def get_sweep(self) -> float:
        return self.sweep

    def set_sweep(self, r: float) -> None:
        if self.sweep == r:
            return
        self.sweep = r
        self._fire()

    def get_sweep_angle(self) -> float:
        if self.height == 0:
            if self.sweep > 0:
                return math.pi / 2
            if self.sweep < 0:
                return -math.pi / 2
            return 0.0
        return math.atan2(self.sweep, self.height)

    def get_height(self) -> float:
        return self.height

    def set_height(self, r: float) -> None:
        if self.height == r:
            return
        self.height = max(r, 0.0)
        self._fire()

    def get_fin_points(self) -> list[Coordinate]:
        pts = [NUL, Coordinate(self.sweep, self.height)]
        if self.tip_chord > 0.0001:
            pts.append(Coordinate(self.sweep + self.tip_chord, self.height))
        pts.append(Coordinate(mu.jmax(self.length, 0.0001), 0.0))
        root = self.get_root_points()
        if len(root) > 1:
            pts[0] = pts[0].set_x(root[0].x).set_y(root[0].y)
            pts[-1] = pts[-1].set_x(root[-1].x).set_y(root[-1].y)
        return pts

    def get_span(self) -> float:
        return self.height


_EPOINTS = 31
_EX = [0.0] * _EPOINTS
_EY = [0.0] * _EPOINTS
for _i in range(_EPOINTS):
    _a = math.pi * (_EPOINTS - 1 - _i) / (_EPOINTS - 1)
    _EX[_i] = (math.cos(_a) + 1) / 2
    _EY[_i] = math.sin(_a)
_EX[0], _EY[0] = 0.0, 0.0
_EX[_EPOINTS - 1], _EY[_EPOINTS - 1] = 1.0, 0.0


class EllipticalFinSet(FinSet):
    ORK_TYPE = "ellipticalfinset"

    def __init__(self):
        super().__init__()
        self.height = 0.05
        self.length = 0.05

    def get_component_name(self) -> str:
        return "Elliptical fin set"

    def get_fin_points(self) -> list[Coordinate]:
        ln = mu.jmax(self.length, 0.0001)
        pts = [Coordinate(_EX[i] * ln, _EY[i] * self.height) for i in range(_EPOINTS)]
        root = self.get_root_points()
        if len(root) > 1:
            pts[0] = pts[0].set_x(root[0].x).set_y(root[0].y)
            pts[-1] = pts[-1].set_x(root[-1].x).set_y(root[-1].y)
        return pts

    def get_span(self) -> float:
        return self.height

    def get_height(self) -> float:
        return self.height

    def set_height(self, h: float) -> None:
        if mu.equals(self.height, h):
            return
        self.height = h
        self._fire()

    def set_length(self, length: float) -> None:
        if mu.equals(self.length, length):
            return
        self.length = length
        self.validate_fin_tab_length()
        self._fire()


SNAP_LARGER_THAN = 2.5
IGNORE_SMALLER_THAN = 1.0e-12


def _relative_ccw(x1, y1, x2, y2, px, py) -> int:
    x2 -= x1
    y2 -= y1
    px -= x1
    py -= y1
    ccw = px * y2 - py * x2
    if ccw == 0.0:
        ccw = px * x2 + py * y2
        if ccw > 0.0:
            px -= x2
            py -= y2
            ccw = px * x2 + py * y2
            if ccw < 0.0:
                ccw = 0.0
    return -1 if ccw < 0.0 else (1 if ccw > 0.0 else 0)


def lines_intersect(x1, y1, x2, y2, x3, y3, x4, y4) -> bool:
    """java.awt.geom.Line2D.linesIntersect."""
    return (_relative_ccw(x1, y1, x2, y2, x3, y3) * _relative_ccw(x1, y1, x2, y2, x4, y4) <= 0
            and _relative_ccw(x3, y3, x4, y4, x1, y1) * _relative_ccw(x3, y3, x4, y4, x2, y2) <= 0)


class FreeformFinSet(FinSet):
    ORK_TYPE = "freeformfinset"

    def __init__(self):
        super().__init__()
        self.points = [ZERO, Coordinate(0.025, 0.05), Coordinate(0.075, 0.05), Coordinate(0.05, 0.0)]
        self.length = 0.05

    def get_component_name(self) -> str:
        return "Freeform fin set"

    def get_point_count(self) -> int:
        return len(self.points)

    def set_points(self, new_points, validate_fin_tab: bool = True) -> None:
        new_points = list(new_points)
        delta = new_points[0].multiply(-1)
        if IGNORE_SMALLER_THAN < delta.length2():
            new_points = [c.add(delta) for c in new_points]
        for i, p in enumerate(new_points):
            if p.x > SNAP_LARGER_THAN:
                new_points[i] = p.set_x(SNAP_LARGER_THAN)
            if p.y > SNAP_LARGER_THAN:  # (from the original p, as in Java)
                new_points[i] = p.set_y(SNAP_LARGER_THAN)
        points_copy = list(self.points)
        length_copy = self.length
        self.points = new_points
        self._update_points(validate_fin_tab)
        if self.intersects():
            self.points = points_copy
            self.length = length_copy
        self._fire()

    def update(self) -> None:
        self._update_points(True)

    def _update_points(self, validate_fin_tab: bool) -> None:
        old_length = self.length
        self.length = self.points[-1].x - self.points[0].x
        self._set_axial_offset(self.axial_method, self.axial_offset)
        if self.parent is not None:
            self._clamp_first_point()
            for i in range(1, len(self.points) - 1):
                self._clamp_interior_point(i)
            self._clamp_last_point(0.0)
            if old_length != self.length and validate_fin_tab:
                self.validate_fin_tab_length()

    def _move_points(self, dx: float, dy: float) -> None:
        self.points[0] = ZERO
        for i in range(1, len(self.points)):
            self.points[i] = self.points[i].add_xyz(dx, dy, 0.0)

    def _clamp_first_point(self) -> None:
        body = self.parent
        ff = self.get_fin_front()
        p0 = self.points[0]
        if not ZERO.equals(p0):
            x_delta = p0.x
            x_trail = self.points[-1].x
            if x_delta > x_trail:
                x_delta = x_trail
            y_delta = body.get_radius(ff.x + x_delta) - ff.y
            self._move_points(-x_delta, -y_delta)
            if self.get_axial_method() is AxialMethod.TOP:
                self.axial_offset = self.axial_offset + x_delta
                self.position = self.position.add_xyz(x_delta, 0.0, 0.0)
            elif self.get_axial_method() is AxialMethod.MIDDLE:
                self.axial_offset = self.axial_offset + x_delta / 2
            self.length = self.points[-1].x

    def _clamp_interior_point(self, index: int) -> None:
        sym = self.parent
        ff = self.get_fin_front()
        x_body_front = -ff.x
        x_body_back = x_body_front + sym.get_length()
        xp, yp = self.points[index].x, self.points[index].y
        if x_body_front <= xp <= x_body_back:
            y_body = sym.get_radius(xp + ff.x) - ff.y
            if y_body > yp:
                self.points[index] = self.points[index].set_y(y_body)

    def _clamp_last_point(self, x_delta: float) -> None:
        body = self.parent
        ff = self.get_fin_front()
        last = self.points[-1]
        y_body = body.get_radius(ff.x + last.x) - ff.y
        if IGNORE_SMALLER_THAN < abs(y_body - last.y):
            self.points[-1] = Coordinate(last.x, y_body)
        if IGNORE_SMALLER_THAN < abs(x_delta):
            self.length = self.points[-1].x
            if self.get_axial_method() is AxialMethod.MIDDLE:
                self.axial_offset = self.axial_offset + x_delta / 2
            elif self.get_axial_method() is AxialMethod.BOTTOM:
                self.axial_offset = self.axial_offset + x_delta

    def intersects(self) -> bool:
        pts = self.points
        n = len(pts)
        for t in range(n - 1):
            p1, p2 = pts[t], pts[t + 1]
            for c in range(t + 1, n - 1):
                if 2 > abs(t - c):
                    continue
                q1, q2 = pts[c], pts[c + 1]
                if t == 0 and n == c + 2 and IGNORE_SMALLER_THAN > math.hypot(p1.x - q2.x, p1.y - q2.y):
                    continue
                if lines_intersect(p1.x, p1.y, p2.x, p2.y, q1.x, q1.y, q2.x, q2.y):
                    return True
        return False

    def get_fin_points(self) -> list[Coordinate]:
        pts = list(self.points)
        root = self.get_root_points()
        if len(root) > 1:
            pts[0] = pts[0].set_x(root[0].x).set_y(root[0].y)
            pts[-1] = pts[-1].set_x(root[-1].x).set_y(root[-1].y)
        return pts

    def get_span(self) -> float:
        mx = 0.0
        for c in self.points:
            if c.y > mx:
                mx = c.y
        return mx - min(self.points[-1].y, 0.0)


class TubeFinSet(Tube):
    ORK_TYPE = "tubefinset"
    DEFAULT_RADIUS = 0.025

    def __init__(self):
        super().__init__(AxialMethod.BOTTOM)
        self.auto_radius = True
        self.outer_radius = self.DEFAULT_RADIUS
        self.thickness = math.nan
        self.angle_method = AngleMethod.FIXED
        self.radius_method = RadiusMethod.RELATIVE
        self.first_fin_offset = 0.0
        self.fins = 6
        self.base_rotation = IDENTITY
        self.length = 0.10

    def get_component_name(self) -> str:
        return "Tube fin set"

    def is_after(self) -> bool:
        return False

    def set_length(self, length: float) -> None:
        if mu.equals(self.length, length):
            return
        self.length = length
        self._fire()

    def is_outer_radius_automatic(self) -> bool:
        return self.auto_radius

    def get_outer_radius(self) -> float:
        if self.auto_radius:
            if self.fins < 3:
                return self.get_body_radius()
            return self._get_touching_radius()
        return self.outer_radius

    def get_tube_separation(self) -> float:
        return 2.0 * (self._get_touching_radius() - self.get_outer_radius())

    def _get_touching_radius(self) -> float:
        r = self.get_body_radius()
        fin_sep = math.pi / self.fins
        r *= math.sin(fin_sep) / (1.0 - math.sin(fin_sep))
        return r

    def set_outer_radius(self, radius: float) -> None:
        if self.outer_radius == radius and not self.auto_radius:
            return
        self.auto_radius = False
        self.outer_radius = max(radius, 0.0)
        if self.thickness > self.outer_radius:
            self.thickness = self.outer_radius
        self._fire()

    def set_outer_radius_automatic(self, auto: bool) -> None:
        if self.auto_radius == auto:
            return
        self.auto_radius = auto
        self._fire()

    def get_inner_radius(self) -> float:
        return max(self.get_outer_radius() - self.thickness, 0.0)

    def get_thickness(self) -> float:
        return min(self.thickness, self.get_outer_radius())

    def set_thickness(self, thickness: float) -> None:
        if self.thickness == thickness:
            return
        self.thickness = mu.clamp(thickness, 0, self.get_outer_radius())
        self._fire()

    def get_fin_count(self) -> int:
        return self.fins

    def set_fin_count(self, n: int) -> None:
        if self.fins == n:
            return
        self.fins = max(1, min(8, n))
        self._fire()

    def get_instance_count(self) -> int:
        return self.fins

    def set_instance_count(self, n: int) -> None:
        self.set_fin_count(n)

    def get_base_rotation(self) -> float:
        return self.first_fin_offset

    def set_base_rotation(self, r: float) -> None:
        self.set_angle_offset(r)

    def get_angle_offset(self) -> float:
        return self.first_fin_offset

    def set_angle_offset(self, angle: float) -> None:
        reduced = mu.reduce_pi(angle)
        if mu.equals(reduced, self.first_fin_offset):
            return
        self.first_fin_offset = reduced
        self.base_rotation = IDENTITY if mu.equals(reduced, 0) else Transformation.rotate_x(reduced)
        self._fire()

    def get_angle_method(self) -> AngleMethod:
        return self.angle_method

    def set_angle_method(self, m: AngleMethod) -> None:
        self.angle_method = m
        self._fire()

    def get_radius_method(self) -> RadiusMethod:
        return self.radius_method

    def set_radius_method(self, m) -> None:
        pass

    def set_radius_offset(self, r: float) -> None:
        pass

    def get_component_volume(self) -> float:
        orad = self.get_outer_radius()
        ir = self.get_inner_radius()
        v = orad * orad - ir * ir
        v *= math.pi
        v *= self.length
        v *= self.fins
        return v

    def get_component_cg(self) -> Coordinate:
        mass = self.get_component_mass()
        half = self.length / 2
        if self.fins == 1:
            return self.base_rotation.transform(
                Coordinate(half, self.get_outer_radius() + self.get_body_radius(), 0.0, mass))
        return self.base_rotation.transform(Coordinate(half, 0.0, 0.0, mass))

    def get_longitudinal_unit_inertia(self) -> float:
        inertia = (3 * (mu.pow2(self.get_outer_radius()) + mu.pow2(self.get_inner_radius()))
                   + mu.pow2(self.get_length())) / 12
        if self.fins == 1:
            return inertia
        total = 0.0
        for _ in range(self.fins):
            total += inertia + mu.pow2(self.axial_offset)  # (sic: the axial offset, as in Java)
        return total

    def get_rotational_unit_inertia(self) -> float:
        icm = (mu.pow2(self.get_inner_radius()) + mu.pow2(self.get_outer_radius())) / 2
        if self.fins == 1:
            return icm
        return self.fins * (icm + mu.pow2(self.get_outer_radius()) + self.get_body_radius())  # (sic)

    def get_body_radius(self) -> float:
        from .symmetric import SymmetricComponent
        s = self.parent
        x = self.get_position().x
        while s is not None:
            if isinstance(s, SymmetricComponent):
                return s.get_radius(x)
            s = s.parent
        return 0.0

    def get_bounding_radius(self) -> float:
        return self.get_body_radius() + self.get_outer_radius()

    def get_instance_angle_increment(self) -> float:
        return 2 * math.pi / self.get_fin_count()

    def get_instance_angles(self) -> list[float]:
        inc = self.get_instance_angle_increment()
        return [mu.reduce_2pi(self.first_fin_offset + inc * k) for k in range(self.get_fin_count())]

    def get_instance_offsets(self) -> list[Coordinate]:
        r = self.get_body_radius()
        return [Transformation.get_axial_rotation(a).transform(Coordinate(0.0, r, 0.0))
                for a in self.get_instance_angles()]

    def get_instance_bounding_box(self) -> BoundingBox:
        b = BoundingBox()
        b.update(Coordinate(0.0, -self.get_outer_radius(), -self.get_outer_radius()))
        b.update(Coordinate(self.length, self.get_outer_radius(), self.get_outer_radius()))
        return b

    def get_pattern_name(self) -> str:
        return f"{self.get_instance_count()}-tubefin-ring"
