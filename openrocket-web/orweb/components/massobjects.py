"""Mass objects: mass components, shock cords and recovery devices.

Ported from OpenRocket 24.12 (GPLv3): info.openrocket.core.rocketcomponent.MassObject,
MassComponent, ShockCord, RecoveryDevice, Parachute, Streamer.

MassObject's automatic radius is stateful in OpenRocket: ``getRadius()`` replaces
the stored radius with the parent's inner radius and rescales the stored length
to keep the packed volume, while ``getLength()`` rescales with whatever radius is
stored at the time. Both are reproduced as-is because positions computed during
a load see the length before the first ``getRadius()``.
"""

from __future__ import annotations

import math
from enum import Enum

from .. import material as mat
from ..util import mathutil as mu
from ..util.coordinate import Coordinate
from .internal import InternalComponent, RingComponent
from .position import AxialMethod


class MassObject(InternalComponent):
    def __init__(self, length: float = 0.025, radius: float = 0.0125):
        super().__init__()
        self.length = length
        self.radius = radius
        self.volume = math.pow(radius, 2) * length
        self.auto_radius = False
        self.radial_position = 0.0
        self.radial_direction = 0.0
        self.shift_y = 0.0
        self.shift_z = 0.0
        # setAxialMethod(TOP); setAxialOffset(0.0) with no parent
        self.axial_method = AxialMethod.TOP
        self.axial_offset = 0.0

    def is_after(self) -> bool:
        return False

    def _update_volume(self, radius: float) -> None:
        self.volume = math.pow(radius, 2) * self.length

    def get_length(self) -> float:
        if self.auto_radius:
            self.length = self._get_auto_length()
        return self.length

    def set_length(self, length: float) -> None:
        length = max(length, 0.0)
        if mu.equals(self.length, length):
            return
        self.length = length
        self._update_volume(self.get_auto_radius() if self.auto_radius else self.radius)
        self._fire()

    def _get_auto_length(self) -> float:
        if mu.equals(self.radius, 0):
            return self.length
        return self.volume / math.pow(self.radius, 2)

    def get_radius(self) -> float:
        if self.auto_radius:
            self.radius = self.get_auto_radius()
            self.length = self._get_auto_length()
        return self.radius

    def get_auto_radius(self) -> float:
        if self.parent is None:
            return self.radius
        r = self.get_max_parent_radius()
        return self.radius if mu.equals(r, 0) else r

    def get_max_parent_radius(self) -> float:
        from .external import BodyComponent
        from .symmetric import BodyTube, NoseCone, Transition
        p = self.parent
        if isinstance(p, NoseCone):
            return p.get_base_radius()
        if isinstance(p, Transition):
            return max(p.get_fore_radius(), p.get_aft_radius())
        if isinstance(p, BodyTube):
            return p.get_inner_radius()
        if isinstance(p, BodyComponent):
            return 0.0  # BodyComponent.getInnerRadius(): an unset field
        if isinstance(p, RingComponent):
            return p.get_inner_radius()
        return 0.0

    def set_radius(self, radius: float) -> None:
        radius = max(radius, 0.0)
        if mu.equals(self.radius, radius) and not self.auto_radius:
            return
        self.auto_radius = False
        self.radius = radius
        self._update_volume(radius)
        self._fire()

    def is_radius_automatic(self) -> bool:
        return self.auto_radius

    def set_radius_automatic(self, auto: bool) -> None:
        if self.auto_radius == auto:
            return
        self.auto_radius = auto
        self._fire()

    def get_radial_position(self) -> float:
        return self.radial_position

    def set_radial_position(self, p: float) -> None:
        p = max(p, 0.0)
        if mu.equals(self.radial_position, p):
            return
        self.radial_position = p
        self.shift_y = p * math.cos(self.radial_direction)
        self.shift_z = p * math.sin(self.radial_direction)
        self._fire()

    def get_radial_direction(self) -> float:
        return self.radial_direction

    def set_radial_direction(self, d: float) -> None:
        d = mu.reduce_pi(d)
        if mu.equals(self.radial_direction, d):
            return
        self.radial_direction = d
        self.shift_y = self.radial_position * math.cos(d)
        self.shift_z = self.radial_position * math.sin(d)
        self._fire()

    def get_component_cg(self) -> Coordinate:
        return Coordinate(self.get_length() / 2, self.shift_y, self.shift_z, self.get_component_mass())

    def get_longitudinal_unit_inertia(self) -> float:
        return (3 * mu.pow2(self.get_radius()) + mu.pow2(self.get_length())) / 12

    def get_rotational_unit_inertia(self) -> float:
        return mu.pow2(self.get_radius()) / 2

    def get_component_bounds(self) -> list[Coordinate]:
        out: list[Coordinate] = []
        self.add_bound(out, 0, self.get_radius())
        self.add_bound(out, self.get_length(), self.get_radius())
        return out


class MassComponentType(Enum):
    MASSCOMPONENT = "masscomponent"
    ALTIMETER = "altimeter"
    FLIGHTCOMPUTER = "flightcomputer"
    DEPLOYMENTCHARGE = "deploymentcharge"
    TRACKER = "tracker"
    PAYLOAD = "payload"
    RECOVERYHARDWARE = "recoveryhardware"
    BATTERY = "battery"


class MassComponent(MassObject):
    ORK_TYPE = "masscomponent"

    def __init__(self):
        super().__init__()
        self.mass = 0.0
        self.mass_component_type = MassComponentType.MASSCOMPONENT

    def get_component_name(self) -> str:
        return "Mass component"

    def get_component_mass(self) -> float:
        return self.mass

    def set_component_mass(self, m: float) -> None:
        m = max(m, 0.0)
        if mu.equals(self.mass, m):
            return
        self.mass = m
        self._fire()

    def set_mass_component_type(self, t: MassComponentType) -> None:
        if self.mass_component_type is t:
            return
        self.mass_component_type = t
        self._fire()


class ShockCord(MassObject):
    ORK_TYPE = "shockcord"

    def __init__(self):
        super().__init__()
        self.material: mat.Material = mat.DEFAULT_LINE
        self.cord_length = 0.4

    def get_component_name(self) -> str:
        return "Shock cord"

    def get_material(self) -> mat.Material:
        return self.material

    def set_material(self, m: mat.Material) -> None:
        if m.type != mat.LINE:
            raise ValueError("Attempting to set non-linear material.")
        if self.material == m:
            return
        self.material = m
        self._fire()

    def get_cord_length(self) -> float:
        return self.cord_length

    def set_cord_length(self, length: float) -> None:
        length = mu.jmax(length, 0)
        if mu.equals(length, self.length):  # (sic: compares with the packed length, as in Java)
            return
        self.cord_length = length
        self._fire()

    def get_component_mass(self) -> float:
        return self.material.density * self.cord_length


DEFAULT_PARACHUTE_CD = 0.8


class RecoveryDevice(MassObject):
    def __init__(self):
        super().__init__()
        self.cd = DEFAULT_PARACHUTE_CD
        self.cd_automatic = True
        self.material: mat.Material = mat.DEFAULT_SURFACE

    def get_area(self) -> float:
        raise NotImplementedError

    def get_component_cd(self, mach: float) -> float:
        raise NotImplementedError

    def get_cd(self, mach: float = 0.0) -> float:
        if self.cd_automatic:
            self.cd = self.get_component_cd(mach)
        return self.cd

    def set_cd(self, cd: float) -> None:
        if mu.equals(self.cd, cd) and not self.is_cd_automatic():
            return
        self.cd = cd
        self.cd_automatic = False
        self._fire()

    def is_cd_automatic(self) -> bool:
        return self.cd_automatic

    def set_cd_automatic(self, auto: bool) -> None:
        if self.cd_automatic == auto:
            return
        self.cd_automatic = auto
        self._fire()

    def get_material(self) -> mat.Material:
        return self.material

    def set_material(self, m: mat.Material) -> None:
        if m.type != mat.SURFACE:
            raise ValueError("Attempted to set non-surface material")
        if m == self.material:
            return
        self.material = m
        self._fire()

    def get_component_mass(self) -> float:
        return self.get_area() * self.get_material().density


class Parachute(RecoveryDevice):
    ORK_TYPE = "parachute"

    def __init__(self):
        super().__init__()
        self.diameter = 0.3
        self.line_count = 6
        self.line_length = 0.3
        self.line_material: mat.Material = mat.DEFAULT_LINE

    def get_component_name(self) -> str:
        return "Parachute"

    def get_diameter(self) -> float:
        return self.diameter

    def set_diameter(self, d: float) -> None:
        if mu.equals(self.diameter, d):
            return
        self.diameter = d
        self._fire()

    def get_area(self) -> float:
        return math.pi * mu.pow2(self.diameter / 2)

    def get_component_cd(self, mach: float) -> float:
        return self.cd

    def get_line_count(self) -> int:
        return self.line_count

    def set_line_count(self, n: int) -> None:
        if self.line_count == n:
            return
        self.line_count = n
        self._fire()

    def get_line_length(self) -> float:
        return self.line_length

    def set_line_length(self, l: float) -> None:
        if mu.equals(self.line_length, l):
            return
        self.line_length = l
        self._fire()

    def get_line_material(self) -> mat.Material:
        return self.line_material

    def set_line_material(self, m: mat.Material) -> None:
        if m.type != mat.LINE:
            raise ValueError("Attempted to set non-line material")
        if m == self.line_material:
            return
        self.line_material = m
        self._fire()

    def get_component_mass(self) -> float:
        return (RecoveryDevice.get_component_mass(self)
                + self.get_line_count() * self.get_line_length() * self.get_line_material().density)


class Streamer(RecoveryDevice):
    ORK_TYPE = "streamer"
    DEFAULT_CD = 0.6
    MAX_COMPUTED_CD = 0.4

    def __init__(self):
        super().__init__()
        self.strip_length = 0.5
        self.strip_width = 0.05

    def get_component_name(self) -> str:
        return "Streamer"

    def get_strip_length(self) -> float:
        return self.strip_length

    def set_strip_length(self, l: float) -> None:
        if mu.equals(self.strip_length, l):
            return
        self.strip_length = l
        self._fire()

    def get_strip_width(self) -> float:
        return self.strip_width

    def set_strip_width(self, w: float) -> None:
        if mu.equals(self.strip_width, w):
            return
        self.strip_width = w
        self._fire()

    def get_aspect_ratio(self) -> float:
        if self.strip_width > 0.0001:
            return self.strip_length / self.strip_width
        return 1000.0

    def get_area(self) -> float:
        return self.strip_width * self.strip_length

    def get_component_cd(self, mach: float) -> float:
        density = self.get_material().density
        cd = 0.034 * ((density + 0.025) / 0.105) * (self.strip_length + 1) / self.strip_length
        return mu.jmin(cd, self.MAX_COMPUTED_CD)
