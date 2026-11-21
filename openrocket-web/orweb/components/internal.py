"""Internal structure: rings, inner tubes, couplers, bulkheads, engine blocks.

Ported from OpenRocket 24.12 (GPLv3): info.openrocket.core.rocketcomponent.InternalComponent,
StructuralComponent, RingComponent, ThicknessRingComponent, RadiusRingComponent,
InnerTube, TubeCoupler, EngineBlock, CenteringRing, Bulkhead, ClusterConfiguration.
"""

from __future__ import annotations

import math

from .. import material as mat
from ..util import mathutil as mu
from ..util.coordinate import NUL, ZERO, BoundingBox, Coordinate
from .base import (RocketComponent, ring_longitudinal_unit_inertia, ring_mass,
                   ring_rotational_unit_inertia)
from .position import AxialMethod


class InternalComponent(RocketComponent):
    def __init__(self):
        super().__init__(AxialMethod.BOTTOM)

    def is_aerodynamic(self) -> bool:
        return False

    def is_massive(self) -> bool:
        return True


class StructuralComponent(InternalComponent):
    def __init__(self):
        super().__init__()
        self.material: mat.Material = mat.DEFAULT_BULK

    def get_material(self) -> mat.Material:
        return self.material

    def set_material(self, m: mat.Material) -> None:
        if m.type != mat.BULK:
            raise ValueError("Attempted to set non-bulk material")
        if m == self.material:
            return
        self.material = m
        self._fire()


def _is_radial_parent(c) -> bool:
    from .symmetric import SymmetricComponent
    return isinstance(c, (SymmetricComponent, InnerTube, TubeCoupler))


def _radial_parent_inner_radius(c, x: float) -> float:
    """RadialParent.getInnerRadius(x)."""
    from .symmetric import SymmetricComponent
    if isinstance(c, SymmetricComponent):
        return c.get_inner_radius(x)
    return c.get_inner_radius()


class RingComponent(StructuralComponent):
    def __init__(self):
        super().__init__()
        self.outer_radius_automatic = False
        self.inner_radius_automatic = False
        self.radial_direction = 0.0
        self.radial_position = 0.0
        self.shift_y = 0.0
        self.shift_z = 0.0

    def is_outer_radius_automatic(self) -> bool:
        return self.outer_radius_automatic

    def set_outer_radius_automatic(self, auto: bool) -> None:
        if auto == self.outer_radius_automatic:
            return
        self.outer_radius_automatic = auto
        self._fire()

    def is_inner_radius_automatic(self) -> bool:
        return self.inner_radius_automatic

    def set_inner_radius_automatic(self, auto: bool) -> None:
        if auto == self.inner_radius_automatic:
            return
        self.inner_radius_automatic = auto
        self._fire()

    def set_length(self, length: float) -> None:
        l = max(length, 0.0)
        if self.length == l:
            return
        self.length = l
        self._fire()

    def get_radial_direction(self) -> float:
        return self.radial_direction

    def set_radial_direction(self, d: float) -> None:
        d = mu.reduce_pi(d)
        if self.radial_direction == d:
            return
        self.radial_direction = d
        self.shift_y = self.radial_position * math.cos(self.radial_direction)
        self.shift_z = self.radial_position * math.sin(self.radial_direction)
        self._fire()

    def get_radial_position(self) -> float:
        return self.radial_position

    def set_radial_position(self, p: float) -> None:
        p = max(p, 0.0)
        if self.radial_position == p:
            return
        self.radial_position = p
        self.shift_y = self.radial_position * math.cos(self.radial_direction)
        self.shift_z = self.radial_position * math.sin(self.radial_direction)
        self._fire()

    def get_radial_shift_y(self) -> float:
        return self.shift_y

    def get_radial_shift_z(self) -> float:
        return self.shift_z

    def _auto_outer_radius(self):
        """The shared outerRadiusAutomatic branch of getOuterRadius()."""
        parent = self.parent
        pos1 = self.to_relative(NUL, parent)[0].x
        pos2 = self.to_relative(Coordinate(self.get_length()), parent)[0].x
        pos1 = mu.clamp(pos1, 0, parent.get_length())
        pos2 = mu.clamp(pos2, 0, parent.get_length())
        return min(_radial_parent_inner_radius(parent, pos1), _radial_parent_inner_radius(parent, pos2))

    def get_component_bounds(self) -> list[Coordinate]:
        out: list[Coordinate] = []
        self.add_bound(out, 0, self.get_outer_radius())
        self.add_bound(out, self.length, self.get_outer_radius())
        return out

    def get_instance_bounding_box(self) -> BoundingBox:
        b = BoundingBox()
        b.update(Coordinate(self.get_length(), 0.0, 0.0))
        r = self.get_outer_radius()
        b.update(Coordinate(0.0, r, r))
        b.update(Coordinate(0.0, -r, -r))
        return b

    def get_component_cg(self) -> Coordinate:
        cg = ZERO
        n = self.get_instance_count()
        m = ring_mass(self.get_outer_radius(), self.get_inner_radius(), self.get_length(), self.get_material().density)
        if n == 1:
            return Coordinate(self.length / 2, 0.0, 0.0, m)
        for c in self.get_instance_offsets():
            cg = cg.average(c.set_weight(m))
        return cg.add_xyz(self.length / 2, 0.0, 0.0)

    def get_component_mass(self) -> float:
        return ring_mass(self.get_outer_radius(), self.get_inner_radius(), self.get_length(),
                         self.get_material().density) * self.get_instance_count()

    def get_longitudinal_unit_inertia(self) -> float:
        return ring_longitudinal_unit_inertia(self.get_outer_radius(), self.get_inner_radius(), self.get_length())

    def get_rotational_unit_inertia(self) -> float:
        return ring_rotational_unit_inertia(self.get_outer_radius(), self.get_inner_radius())


class ThicknessRingComponent(RingComponent):
    def __init__(self):
        super().__init__()
        self.outer_radius = 0.0
        self.thickness = 0.0

    def get_outer_radius(self, x: float | None = None) -> float:
        if self.is_outer_radius_automatic() and _is_radial_parent(self.parent):
            self.outer_radius = self._auto_outer_radius()
        return self.outer_radius

    def set_outer_radius(self, r: float) -> None:
        r = max(r, 0.0)
        if mu.equals(self.outer_radius, r) and not self.is_outer_radius_automatic():
            return
        self.outer_radius = r
        self.outer_radius_automatic = False
        if self.thickness > self.outer_radius:
            self.thickness = self.outer_radius
        self._fire()

    def get_thickness(self) -> float:
        return min(self.thickness, self.get_outer_radius())

    def set_thickness(self, thickness: float) -> None:
        outer = self.get_outer_radius()
        thickness = mu.clamp(thickness, 0, outer)
        if mu.equals(self.get_thickness(), thickness):
            return
        self.thickness = thickness
        self._fire()

    def get_inner_radius(self, x: float | None = None) -> float:
        return max(self.get_outer_radius() - self.thickness, 0.0)

    def set_inner_radius(self, r: float) -> None:
        r = max(r, 0.0)
        self.set_thickness(self.get_outer_radius() - r)


class RadiusRingComponent(RingComponent):
    def __init__(self):
        super().__init__()
        self.outer_radius = 0.0
        self.inner_radius = 0.0
        self.instance_count = 1
        self.instance_separation = 0.0

    def get_outer_radius(self) -> float:
        if self.outer_radius_automatic and _is_radial_parent(self.parent):
            self.outer_radius = self._auto_outer_radius()
        return self.outer_radius

    def set_outer_radius(self, r: float) -> None:
        r = max(r, 0.0)
        if mu.equals(self.outer_radius, r) and not self.is_outer_radius_automatic():
            return
        self.outer_radius = r
        self.outer_radius_automatic = False
        if self.get_inner_radius() > r:
            self.inner_radius = r
            self.inner_radius_automatic = False
        self._fire()

    def get_inner_radius(self) -> float:
        return self.inner_radius

    def set_inner_radius(self, r: float) -> None:
        r = max(r, 0.0)
        if mu.equals(self.inner_radius, r):
            return
        self.inner_radius = r
        self.inner_radius_automatic = False
        if self.get_outer_radius() < r:
            self.outer_radius = r
            self.outer_radius_automatic = False
        self._fire()

    def get_thickness(self) -> float:
        return max(self.get_outer_radius() - self.get_inner_radius(), 0.0)

    def set_thickness(self, thickness: float) -> None:
        outer = self.get_outer_radius()
        thickness = mu.clamp(thickness, 0, outer)
        self.set_inner_radius(outer - thickness)

    def get_instance_separation(self) -> float:
        return self.instance_separation

    def set_instance_separation(self, s: float) -> None:
        self.instance_separation = s
        self._fire()

    def get_instance_count(self) -> int:
        return self.instance_count

    def set_instance_count(self, n: int) -> None:
        if 0 < n:
            self.instance_count = n
            self._fire()

    def get_instance_offsets(self) -> list[Coordinate]:
        return [Coordinate(i * self.instance_separation, 0.0, 0.0) for i in range(self.get_instance_count())]

    def get_pattern_name(self) -> str:
        return f"{self.get_instance_count()}-Line"


class TubeCoupler(ThicknessRingComponent):
    ORK_TYPE = "tubecoupler"

    def __init__(self):
        super().__init__()
        # setOuterRadiusAutomatic(true); setThickness(0.002) (clamps to the 0 outer radius); setLength(0.06)
        self.outer_radius_automatic = True
        self.length = 0.06

    def get_component_name(self) -> str:
        return "Tube coupler"

    def allows_children(self) -> bool:
        return True

    def is_compatible(self, component) -> bool:
        return isinstance(component, InternalComponent)


class EngineBlock(ThicknessRingComponent):
    ORK_TYPE = "engineblock"

    def __init__(self):
        super().__init__()
        self.outer_radius_automatic = True
        self.length = 0.005

    def get_component_name(self) -> str:
        return "Engine block"


class CenteringRing(RadiusRingComponent):
    ORK_TYPE = "centeringring"

    def __init__(self):
        super().__init__()
        self.outer_radius_automatic = True
        self.inner_radius_automatic = True
        self.length = 0.002

    def get_component_name(self) -> str:
        return "Centering ring"

    def get_inner_radius(self) -> float:
        if self.is_inner_radius_automatic():
            self.inner_radius = 0.0
            if self.parent is not None:
                for sib in self.parent.children:
                    if not isinstance(sib, InnerTube):
                        continue
                    pos1 = self.to_relative(NUL, sib)[0].x
                    pos2 = self.to_relative(Coordinate(self.get_length()), sib)[0].x
                    if pos2 < 0 or pos1 > sib.get_length():
                        continue
                    self.inner_radius = max(self.inner_radius, sib.get_outer_radius())
                self.inner_radius = min(self.inner_radius, self.get_outer_radius())
        return self.inner_radius


class Bulkhead(RadiusRingComponent):
    ORK_TYPE = "bulkhead"

    def __init__(self):
        super().__init__()
        self.outer_radius_automatic = True
        self.length = 0.002

    def get_component_name(self) -> str:
        return "Bulkhead"

    def get_inner_radius(self) -> float:
        return 0.0

    def set_inner_radius(self, r: float) -> None:
        pass


# ------------------------------------------------------------------------------ clusters

_R5 = 1.0 / (2 * math.sin(2 * math.pi / 10))
_SQRT2 = 1.4142135623730951
_SQRT3 = 1.7320508075688772


class ClusterConfiguration:
    def __init__(self, xml_name: str, *points: float):
        if len(points) == 0 or len(points) % 2 == 1:
            raise ValueError("Illegal number of points specified")
        self.xml_name = xml_name
        self.points = list(points)

    def get_xml_name(self) -> str:
        return self.xml_name

    def get_cluster_count(self) -> int:
        return len(self.points) // 2

    def get_points(self, rotation: float | None = None) -> list[float]:
        if rotation is None:
            return list(self.points)
        c, s = math.cos(rotation), math.sin(rotation)
        out = []
        for i in range(len(self.points) // 2):
            x, y = self.points[2 * i], self.points[2 * i + 1]
            out.append(x * c + y * s)
            out.append(-x * s + y * c)
        return out

    def __repr__(self) -> str:
        return self.xml_name


_s, _c = math.sin, math.cos
_P = math.pi
CLUSTER_SINGLE = ClusterConfiguration("single", 0, 0)
CLUSTER_CONFIGURATIONS = [
    CLUSTER_SINGLE,
    ClusterConfiguration("double", -0.5, 0, 0.5, 0),
    ClusterConfiguration("3-row", -1.0, 0, 0.0, 0, 1.0, 0),
    ClusterConfiguration("4-row", -1.5, 0, -0.5, 0, 0.5, 0, 1.5, 0),
    ClusterConfiguration("3-ring", -0.5, -1.0 / (2 * _SQRT3), 0.5, -1.0 / (2 * _SQRT3), 0, 1.0 / _SQRT3),
    ClusterConfiguration("4-ring", -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, -0.5, -0.5),
    ClusterConfiguration("5-ring", 0, _R5,
                         _R5 * _s(2 * _P / 5), _R5 * _c(2 * _P / 5),
                         _R5 * _s(2 * _P * 2 / 5), _R5 * _c(2 * _P * 2 / 5),
                         _R5 * _s(2 * _P * 3 / 5), _R5 * _c(2 * _P * 3 / 5),
                         _R5 * _s(2 * _P * 4 / 5), _R5 * _c(2 * _P * 4 / 5)),
    ClusterConfiguration("6-ring", 0, 1, _SQRT3 / 2, 0.5, _SQRT3 / 2, -0.5, 0, -1, -_SQRT3 / 2, -0.5, -_SQRT3 / 2, 0.5),
    ClusterConfiguration("3-star", 0, 0, 0, 1, _SQRT3 / 2, -0.5, -_SQRT3 / 2, -0.5),
    ClusterConfiguration("4-star", 0, 0, -1 / _SQRT2, 1 / _SQRT2, 1 / _SQRT2, 1 / _SQRT2,
                         1 / _SQRT2, -1 / _SQRT2, -1 / _SQRT2, -1 / _SQRT2),
    ClusterConfiguration("5-star", 0, 0, 0, 1,
                         _s(2 * _P / 5), _c(2 * _P / 5),
                         _s(2 * _P * 2 / 5), _c(2 * _P * 2 / 5),
                         _s(2 * _P * 3 / 5), _c(2 * _P * 3 / 5),
                         _s(2 * _P * 4 / 5), _c(2 * _P * 4 / 5)),
    ClusterConfiguration("6-star", 0, 0, 0, 1, _SQRT3 / 2, 0.5, _SQRT3 / 2, -0.5,
                         0, -1, -_SQRT3 / 2, -0.5, -_SQRT3 / 2, 0.5),
    ClusterConfiguration("9-grid", -1.4, 1.4, 0, 1.4, 1.4, 1.4, -1.4, 0, 0, 0, 1.4, 0, -1.4, -1.4, 0, -1.4, 1.4, -1.4),
    ClusterConfiguration("9-star", 0, 0, 1.4, 0, 1.4 / _SQRT2, -1.4 / _SQRT2, 0, -1.4, -1.4 / _SQRT2, -1.4 / _SQRT2,
                         -1.4, 0, -1.4 / _SQRT2, 1.4 / _SQRT2, 0, 1.4, 1.4 / _SQRT2, 1.4 / _SQRT2),
]
CLUSTERS_BY_NAME = {c.xml_name: c for c in CLUSTER_CONFIGURATIONS}


class InnerTube(ThicknessRingComponent):
    ORK_TYPE = "innertube"

    def __init__(self):
        super().__init__()
        # setOuterRadius(0.019/2); setInnerRadius(0.018/2); setLength(0.070)
        self.outer_radius = 0.019 / 2
        self.thickness = 0.019 / 2 - 0.018 / 2
        self.length = 0.070
        self.cluster = CLUSTER_SINGLE
        self.cluster_scale = 1.0
        self.cluster_rotation = 0.0
        self.overhang = 0.0
        self.is_acting_mount = False

    def get_component_name(self) -> str:
        return "Inner Tube"

    def allows_children(self) -> bool:
        return True

    def is_compatible(self, component) -> bool:
        return isinstance(component, InternalComponent)

    def is_after(self) -> bool:
        return False

    def get_cluster_configuration(self) -> ClusterConfiguration:
        return self.cluster

    def set_cluster_configuration(self, cluster: ClusterConfiguration) -> None:
        if cluster is self.cluster:
            return
        self.cluster = cluster
        self._fire()

    def get_instance_count(self) -> int:
        return self.cluster.get_cluster_count()

    def get_cluster_count(self) -> int:
        return self.cluster.get_cluster_count()

    def get_cluster_scale(self) -> float:
        return self.cluster_scale

    def set_cluster_scale(self, scale: float) -> None:
        scale = max(scale, 0.0)
        if mu.equals(self.cluster_scale, scale):
            return
        self.cluster_scale = scale
        self._fire()

    def get_cluster_rotation(self) -> float:
        return self.cluster_rotation

    def set_cluster_rotation(self, rotation: float) -> None:
        rotation = mu.reduce_pi(rotation)
        if self.cluster_rotation == rotation:
            return
        self.cluster_rotation = rotation
        self._fire()

    def get_cluster_separation(self) -> float:
        return 2 * self.get_outer_radius() * self.cluster_scale

    def get_cluster_points(self) -> list[Coordinate]:
        pts = self.cluster.get_points(self.cluster_rotation - self.get_radial_direction())
        sep = self.get_cluster_separation()
        y_off = self.radial_position * math.cos(self.radial_direction)
        z_off = self.radial_position * math.sin(self.radial_direction)
        return [Coordinate(0.0, pts[2 * i] * sep + y_off, pts[2 * i + 1] * sep + z_off)
                for i in range(len(pts) // 2)]

    def get_instance_offsets(self) -> list[Coordinate]:
        return self.get_cluster_points()

    def get_pattern_name(self) -> str:
        return self.cluster.get_xml_name()

    # -- motor mount -----------------------------------------------------------------------
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
        return self.cluster.get_cluster_count()
