"""Coordinate and Transformation, the parts the aerodynamics use.

Ported from OpenRocket 24.12 (GPLv3): info.openrocket.core.util.Coordinate,
info.openrocket.core.util.Transformation.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .mathutil import EPSILON, pow2


@dataclass(frozen=True)
class Coordinate:
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0
    weight: float = 0.0

    def is_nan(self) -> bool:
        return math.isnan(self.x) or math.isnan(self.y) or math.isnan(self.z) or math.isnan(self.weight)

    def set_x(self, x):
        return Coordinate(x, self.y, self.z, self.weight)

    def set_y(self, y):
        return Coordinate(self.x, y, self.z, self.weight)

    def set_z(self, z):
        return Coordinate(self.x, self.y, z, self.weight)

    def add(self, other: "Coordinate") -> "Coordinate":
        return Coordinate(self.x + other.x, self.y + other.y, self.z + other.z, self.weight + other.weight)

    def average(self, other: "Coordinate | None") -> "Coordinate":
        if other is None:
            return self
        w1 = self.weight + other.weight
        if abs(w1) < pow2(EPSILON):
            x1 = (self.x + other.x) / 2
            y1 = (self.y + other.y) / 2
            z1 = (self.z + other.z) / 2
            w1 = 0.0
        else:
            x1 = (self.x * self.weight + other.x * other.weight) / w1
            y1 = (self.y * self.weight + other.y * other.weight) / w1
            z1 = (self.z * self.weight + other.z * other.weight) / w1
        return Coordinate(x1, y1, z1, w1)


Coordinate.ZERO = Coordinate(0.0, 0.0, 0.0, 0.0)  # type: ignore[attr-defined]
Coordinate.NUL = Coordinate(0.0, 0.0, 0.0, 0.0)  # type: ignore[attr-defined]
ZERO = Coordinate.ZERO  # type: ignore[attr-defined]
NUL = Coordinate.NUL  # type: ignore[attr-defined]


def as_coordinate(c) -> Coordinate:
    """Accept the model's coordinate (object with x/y/z[/weight], or a sequence)."""
    if isinstance(c, Coordinate):
        return c
    if hasattr(c, "x"):
        return Coordinate(float(c.x), float(getattr(c, "y", 0.0)), float(getattr(c, "z", 0.0)),
                          float(getattr(c, "weight", 0.0)))
    seq = list(c)
    seq += [0.0] * (4 - len(seq))
    return Coordinate(float(seq[0]), float(seq[1]), float(seq[2]), float(seq[3]))


ANGLE_EPSILON = 0.000000001


class Transformation:
    """Affine transform: rotation matrix then translation (Transformation.java)."""

    __slots__ = ("rotation", "translate")

    def __init__(self, rotation=None, translate: Coordinate | None = None):
        self.rotation = [list(r) for r in rotation] if rotation is not None else [
            [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
        self.translate = translate if translate is not None else Coordinate(0.0, 0.0, 0.0)

    @staticmethod
    def get_translation_transform(t) -> "Transformation":
        return Transformation(None, as_coordinate(t))

    @staticmethod
    def rotate_x(theta: float) -> "Transformation":
        if ANGLE_EPSILON > abs(theta):
            return IDENTITY
        c, s = math.cos(theta), math.sin(theta)
        return Transformation([[1, 0, 0], [0, c, -s], [0, s, c]], Coordinate.NUL)  # type: ignore[attr-defined]

    get_axial_rotation = rotate_x

    def transform(self, orig: Coordinate) -> Coordinate:
        r, t = self.rotation, self.translate
        x = r[0][0] * orig.x + r[0][1] * orig.y + r[0][2] * orig.z + t.x
        y = r[1][0] * orig.x + r[1][1] * orig.y + r[1][2] * orig.z + t.y
        z = r[2][0] * orig.x + r[2][1] * orig.y + r[2][2] * orig.z + t.z
        return Coordinate(x, y, z, orig.weight)

    def linear_transform(self, orig: Coordinate) -> Coordinate:
        r = self.rotation
        x = r[0][0] * orig.x + r[0][1] * orig.y + r[0][2] * orig.z
        y = r[1][0] * orig.x + r[1][1] * orig.y + r[1][2] * orig.z
        z = r[2][0] * orig.x + r[2][1] * orig.y + r[2][2] * orig.z
        return Coordinate(x, y, z, orig.weight)

    def apply_transformation(self, other: "Transformation") -> "Transformation":
        combined = Transformation(None, self.linear_transform(other.translate).add(self.translate))
        o = other.rotation
        for i in range(3):
            x, y, z = self.rotation[i]
            combined.rotation[i][0] = x * o[0][0] + y * o[1][0] + z * o[2][0]
            combined.rotation[i][1] = x * o[0][1] + y * o[1][1] + z * o[2][1]
            combined.rotation[i][2] = x * o[0][2] + y * o[1][2] + z * o[2][2]
        return combined

    def get_xrotation(self) -> float:
        r = self.rotation
        return math.atan2((r[2][1] - r[1][2]) / 2.0, (r[1][1] + r[2][2]) / 2.0)


IDENTITY = Transformation()
