"""Launch lugs and rail buttons.

Ported from OpenRocket 24.12 (GPLv3): info.openrocket.core.rocketcomponent.LaunchLug, RailButton.
"""

from __future__ import annotations

import math

import numpy as np

from .. import material as mat
from ..util import mathutil as mu
from ..util.coordinate import NUL, BoundingBox, Coordinate
from .base import RocketComponent
from .external import ExternalComponent, Tube
from .position import AngleMethod, AxialMethod

#: Java's ``2.0f / 3``: a float32 quotient promoted to double.
TWO_THIRDS_F = float(np.float32(2.0) / np.float32(3.0))


class LaunchLug(Tube):
    ORK_TYPE = "launchlug"

    def __init__(self):
        super().__init__(AxialMethod.MIDDLE)
        self.radius = 0.01 / 2
        self.thickness = 0.001
        self.angle_offset_rad = math.pi
        self.radial_offset = 0.0
        self.instance_count = 1
        self.length = 0.03
        self.instance_separation = self.length * 2

    def get_component_name(self) -> str:
        return "Launch lug"

    def is_after(self) -> bool:
        return False

    def component_changed(self) -> None:
        from .symmetric import SymmetricComponent
        RocketComponent.component_changed(self)
        body = self.parent
        while body is not None and not isinstance(body, SymmetricComponent):
            body = body.parent
        if body is None:
            parent_radius = 0.0
        else:
            x1 = self.to_relative(NUL, body)[0].x
            x2 = self.to_relative(Coordinate(self.length, 0.0, 0.0), body)[0].x
            x1 = mu.clamp(x1, 0, body.get_length())
            x2 = mu.clamp(x2, 0, body.get_length())
            parent_radius = max(body.get_radius(x1), body.get_radius(x2))
        self.radial_offset = parent_radius + self.radius

    def get_outer_radius(self) -> float:
        return self.radius

    def set_outer_radius(self, r: float) -> None:
        if mu.equals(self.radius, r):
            return
        self.radius = r
        self.thickness = min(self.thickness, self.radius)
        self._fire()

    def get_inner_radius(self) -> float:
        return self.radius - self.thickness

    def set_inner_radius(self, r: float) -> None:
        self.set_outer_radius(r + self.thickness)

    def get_thickness(self) -> float:
        return self.thickness

    def set_thickness(self, t: float) -> None:
        if mu.equals(self.thickness, t):
            return
        self.thickness = mu.clamp(t, 0, self.radius)
        self._fire()

    def get_angle_offset(self) -> float:
        return self.angle_offset_rad

    def set_angle_offset(self, a: float) -> None:
        c = mu.clamp(a, -math.pi, math.pi)
        if mu.equals(self.angle_offset_rad, c):
            return
        self.angle_offset_rad = c
        self._fire()

    def get_angle_method(self) -> AngleMethod:
        return AngleMethod.RELATIVE

    def set_angle_method(self, m) -> None:
        pass

    def set_length(self, length: float) -> None:
        if mu.equals(self.length, length):
            return
        self.length = length
        self._fire()

    def get_instance_separation(self) -> float:
        return self.instance_separation

    def set_instance_separation(self, s: float) -> None:
        if mu.equals(self.instance_separation, s):
            return
        self.instance_separation = s
        self._fire()

    def get_instance_count(self) -> int:
        return self.instance_count

    def set_instance_count(self, n: int) -> None:
        if n == self.instance_count or n <= 0:
            return
        self.instance_count = n
        self._fire()

    def get_instance_offsets(self) -> list[Coordinate]:
        y = math.cos(self.angle_offset_rad) * self.radial_offset
        z = math.sin(self.angle_offset_rad) * self.radial_offset
        return [Coordinate(i * self.instance_separation, y, z) for i in range(self.get_instance_count())]

    def get_component_volume(self) -> float:
        return (self.length * math.pi * (mu.pow2(self.radius) - mu.pow2(self.radius - self.thickness))
                * self.get_instance_count())

    def get_component_cg(self) -> Coordinate:
        from .symmetric import SymmetricComponent
        pr = self.parent.get_radius(self.get_axial_offset()) if isinstance(self.parent, SymmetricComponent) else 0.0
        cmx = self.length / 2 + (self.instance_separation * (self.instance_count - 1)) / 2
        cmy = math.cos(self.angle_offset_rad) * (pr + self.get_outer_radius())
        cmz = math.sin(self.angle_offset_rad) * (pr + self.get_outer_radius())
        return Coordinate(cmx, cmy, cmz, self.get_component_mass())

    def get_longitudinal_unit_inertia(self) -> float:
        return (3 * (mu.pow2(self.get_outer_radius()) + mu.pow2(self.get_inner_radius())) + mu.pow2(self.get_length())) / 12

    def get_rotational_unit_inertia(self) -> float:
        return (mu.pow2(self.get_inner_radius()) + mu.pow2(self.get_outer_radius())) / 2

    def get_component_bounds(self) -> list[Coordinate]:
        out: list[Coordinate] = []
        self.add_bound(out, 0, self.radius)
        self.add_bound(out, self.length, self.radius)
        return out

    def get_instance_bounding_box(self) -> BoundingBox:
        b = BoundingBox()
        b.update(Coordinate(self.get_length(), 0.0, 0.0))
        r = self.get_outer_radius()
        b.update(Coordinate(0.0, r, r))
        b.update(Coordinate(0.0, -r, -r))
        return b


class RailButton(ExternalComponent):
    ORK_TYPE = "railbutton"

    def __init__(self):
        super().__init__(AxialMethod.MIDDLE)
        self.outer_diameter = 0.0097
        self.total_height = 0.0097
        self.inner_diameter = 0.008
        self.flange_height = 0.002
        self.base_height = 0.002  # setBaseHeight(0.002), within its clamp
        self.screw_height = 0.0
        self.radial_distance = 0.0
        self.angle_offset_rad = math.pi
        self.instance_count = 1
        self.instance_separation = self.outer_diameter * 6
        self.material = mat.DELRIN

    def get_component_name(self) -> str:
        return "Rail button"

    def component_changed(self) -> None:
        from .symmetric import BodyTube
        RocketComponent.component_changed(self)
        pr = 0.0
        body = self.parent
        while body is not None:
            if isinstance(body, BodyTube):
                pr = body.get_outer_radius()
                break
            body = body.parent
        self.radial_distance = pr

    # -- dimensions --------------------------------------------------------------------
    def get_outer_diameter(self) -> float:
        return self.outer_diameter

    def get_inner_diameter(self) -> float:
        return self.inner_diameter

    def get_total_height(self) -> float:
        return self.total_height

    def get_base_height(self) -> float:
        return self.base_height

    def get_flange_height(self) -> float:
        return self.flange_height

    def get_screw_height(self) -> float:
        return self.screw_height

    def get_inner_height(self) -> float:
        return self.total_height - self.flange_height - self.base_height

    def get_max_base_height(self) -> float:
        return self.total_height - self.flange_height

    def get_max_flange_height(self) -> float:
        return self.total_height - self.base_height

    def get_min_total_height(self) -> float:
        return self.base_height + self.flange_height

    def set_base_height(self, h: float) -> None:
        self.base_height = max(h, 0.0)
        self.base_height = min(self.base_height, self.get_max_base_height())
        self._fire()

    def set_flange_height(self, h: float) -> None:
        self.flange_height = max(h, 0.0)
        self.flange_height = min(self.flange_height, self.get_max_flange_height())
        self._fire()

    def set_total_height(self, h: float) -> None:
        self.total_height = max(h, self.get_min_total_height())
        self._fire()

    def set_screw_height(self, h: float) -> None:
        self.screw_height = max(h, 0.0)
        self._fire()

    def set_inner_diameter(self, d: float) -> None:
        self.inner_diameter = min(d, self.outer_diameter)
        self._fire()

    def set_outer_diameter(self, d: float) -> None:
        self.outer_diameter = d
        self.set_inner_diameter(self.inner_diameter)
        self._fire()

    def get_angle_offset(self) -> float:
        return self.angle_offset_rad

    def get_angle_method(self) -> AngleMethod:
        return AngleMethod.RELATIVE

    def set_angle_method(self, m) -> None:
        pass

    def set_angle_offset(self, a: float) -> None:
        c = mu.clamp(a, -math.pi, math.pi)
        if mu.equals(self.angle_offset_rad, c):
            return
        self.angle_offset_rad = c
        self._fire()

    def get_instance_separation(self) -> float:
        return self.instance_separation

    def set_instance_separation(self, s: float) -> None:
        if mu.equals(self.instance_separation, s):
            return
        self.instance_separation = s
        self._fire()

    def get_instance_count(self) -> int:
        return self.instance_count

    def set_instance_count(self, n: int) -> None:
        if n == self.instance_count or n <= 0:
            return
        self.instance_count = n
        self._fire()

    def get_instance_offsets(self) -> list[Coordinate]:
        y = math.cos(self.angle_offset_rad) * self.radial_distance
        z = math.sin(self.angle_offset_rad) * self.radial_distance
        return [Coordinate(i * self.instance_separation, y, z) for i in range(self.get_instance_count())]

    # -- mass --------------------------------------------------------------------------
    def get_component_volume(self) -> float:
        od, idd = self.outer_diameter, self.inner_diameter
        v_outer = math.pi * math.pow(od / 2, 2) * self.flange_height
        v_inner = math.pi * math.pow(idd / 2, 2) * self.get_inner_height()
        v_standoff = math.pi * math.pow(od / 2, 2) * self.base_height
        v_screw = TWO_THIRDS_F * math.pi * mu.pow2(od / 2) * self.screw_height
        return (v_outer + v_inner + v_standoff + v_screw) * self.get_instance_count()

    def get_component_cg(self) -> Coordinate:
        from .symmetric import SymmetricComponent
        od, idd = self.outer_diameter, self.inner_diameter
        m_base = math.pow(od / 2, 2) * self.base_height
        m_inner = math.pow(idd / 2, 2) * self.get_inner_height()
        m_flange = math.pow(od / 2, 2) * self.flange_height
        m_screw = TWO_THIRDS_F * mu.pow2(od / 2) * self.screw_height
        total = m_flange + m_inner + m_base + m_screw
        base_cm = self.base_height / 2
        inner_cm = self.base_height + self.get_inner_height() / 2
        flange_cm = self.total_height - self.get_flange_height() / 2
        screw_cm = self.total_height + 4 * self.screw_height / (3 * math.pi)
        height_cm = (m_base * base_cm + m_inner * inner_cm + m_flange * flange_cm + m_screw * screw_cm) / total
        pr = self.parent.get_radius(self.get_axial_offset()) if isinstance(self.parent, SymmetricComponent) else 0.0
        cmx = (self.instance_separation * (self.instance_count - 1)) / 2
        cmy = math.cos(self.angle_offset_rad) * (pr + height_cm)
        cmz = math.sin(self.angle_offset_rad) * (pr + height_cm)
        return Coordinate(cmx, cmy, cmz, self.get_component_mass())

    def get_longitudinal_unit_inertia(self) -> float:
        return 0.0

    def get_rotational_unit_inertia(self) -> float:
        return 0.0

    def get_instance_bounding_box(self) -> BoundingBox:
        b = BoundingBox()
        b.update(Coordinate(0.0, self.total_height + self.screw_height, 0.0))
        b.update(Coordinate(0.0, -self.total_height - self.screw_height, 0.0))
        r = self.get_outer_diameter() / 2
        b.update(Coordinate(r, 0.0, r))
        b.update(Coordinate(-r, 0.0, -r))
        return b

    def get_component_bounds(self) -> list[Coordinate]:
        r = self.outer_diameter / 2.0
        h = self.total_height
        return [Coordinate(r, h, r), Coordinate(r, h, -r), Coordinate(r, 0, r), Coordinate(r, 0, -r),
                Coordinate(-r, 0, r), Coordinate(-r, 0, -r), Coordinate(-r, h, r), Coordinate(-r, h, -r)]
