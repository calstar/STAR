"""Axial, radial and angular positioning methods.

Ported from OpenRocket 24.12 (GPLv3): info.openrocket.core.rocketcomponent.position.AxialMethod,
RadiusMethod, AngleMethod.
"""

from __future__ import annotations

import math
from enum import Enum

from ..util import mathutil as mu


class AxialMethod(Enum):
    ABSOLUTE = "absolute"
    AFTER = "after"
    TOP = "top"
    MIDDLE = "middle"
    BOTTOM = "bottom"

    def get_as_position(self, offset: float, inner_length: float, outer_length: float) -> float:
        if self is AxialMethod.ABSOLUTE or self is AxialMethod.TOP:
            return offset
        if self is AxialMethod.AFTER:
            return outer_length + offset
        if self is AxialMethod.MIDDLE:
            return offset + (outer_length - inner_length) / 2
        return offset + (outer_length - inner_length)  # BOTTOM

    def get_as_offset(self, position: float, inner_length: float, outer_length: float) -> float:
        if self is AxialMethod.ABSOLUTE or self is AxialMethod.TOP:
            return position
        if self is AxialMethod.AFTER:
            return position - outer_length
        if self is AxialMethod.MIDDLE:
            return position + (inner_length - outer_length) / 2
        return position + (inner_length - outer_length)  # BOTTOM

    def clamp_to_zero(self) -> bool:
        return False

    @staticmethod
    def parse(name: str | None) -> "AxialMethod | None":
        """DocumentConfig.findEnum."""
        if name is None:
            return None
        name = name.strip()
        for m in AxialMethod:
            if m.name.lower().replace("_", "") == name:
                return m
        return None


class RadiusMethod(Enum):
    COAXIAL = "coaxial"
    FREE = "free"
    RELATIVE = "relative"
    SURFACE = "surface"

    def clamp_to_zero(self) -> bool:
        return self in (RadiusMethod.COAXIAL, RadiusMethod.SURFACE)

    def get_radius(self, parent, this, requested_offset: float) -> float:
        from .symmetric import BodyTube  # local import: avoid a cycle
        if self is RadiusMethod.COAXIAL:
            return 0.0
        if self is RadiusMethod.FREE:
            return requested_offset
        radius = requested_offset if self is RadiusMethod.RELATIVE else 0.0
        if isinstance(parent, BodyTube):
            radius += parent.get_outer_radius()
        if hasattr(this, "get_bounding_radius"):  # RadiusPositionable
            radius += this.get_bounding_radius()
        return radius

    def get_as_offset(self, parent, this, radius: float) -> float:
        from .symmetric import BodyTube
        if self is RadiusMethod.COAXIAL or self is RadiusMethod.SURFACE:
            return 0.0
        if self is RadiusMethod.FREE:
            return radius
        offset = radius
        if isinstance(parent, BodyTube):
            offset -= parent.get_outer_radius()
        if hasattr(this, "get_bounding_radius"):
            offset -= this.get_bounding_radius()
        return offset

    @staticmethod
    def parse(name: str | None) -> "RadiusMethod | None":
        if name is None:
            return None
        for m in RadiusMethod:
            if m.name.lower() == name.strip():
                return m
        return None


class AngleMethod(Enum):
    RELATIVE = "relative"
    FIXED = "fixed"
    MIRROR_XY = "mirrorxy"

    def clamp_to_zero(self) -> bool:
        return self is not AngleMethod.MIRROR_XY

    def get_angle(self, parent, this, requested: float) -> float:
        if self is AngleMethod.RELATIVE:
            return parent.get_angle_offset() + requested
        if self is AngleMethod.FIXED:
            return 0.0
        combined = mu.reduce_2pi(parent.get_angle_offset() + requested)
        if math.pi > combined:
            combined = -(combined - math.pi)
        return combined

    @staticmethod
    def parse(name: str | None) -> "AngleMethod | None":
        if name is None:
            return None
        for m in AngleMethod:
            if m.name.lower().replace("_", "") == name.strip():
                return m
        return None
