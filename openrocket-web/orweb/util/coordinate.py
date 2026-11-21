"""Coordinate, Transformation and BoundingBox.

Ported from OpenRocket 24.12 (GPLv3): info.openrocket.core.util.Coordinate,
info.openrocket.core.util.Transformation, info.openrocket.core.util.BoundingBox.

Arithmetic is written in the same operation order as the Java so that results
agree to the last bit wherever that is possible.
"""

from __future__ import annotations

import math

from .mathutil import EPSILON, safe_sqrt

_TINY_W = EPSILON * EPSILON  # MathUtil.pow2(MathUtil.EPSILON), Coordinate.average


class Coordinate:
    """An immutable (x, y, z, weight) tuple; weight is mass where it is a CG."""

    __slots__ = ("x", "y", "z", "weight")

    def __init__(self, x: float = 0.0, y: float = 0.0, z: float = 0.0, weight: float = 0.0):
        self.x = x
        self.y = y
        self.z = z
        self.weight = weight

    # -- Java API (snake_case) -------------------------------------------------
    def is_weighted(self) -> bool:
        return self.weight != 0

    def is_nan(self) -> bool:
        return math.isnan(self.x) or math.isnan(self.y) or math.isnan(self.z) or math.isnan(self.weight)

    def set_x(self, x: float) -> "Coordinate":
        return Coordinate(x, self.y, self.z, self.weight)

    def set_y(self, y: float) -> "Coordinate":
        return Coordinate(self.x, y, self.z, self.weight)

    def set_z(self, z: float) -> "Coordinate":
        return Coordinate(self.x, self.y, z, self.weight)

    def set_weight(self, w: float) -> "Coordinate":
        return Coordinate(self.x, self.y, self.z, w)

    def add(self, other: "Coordinate") -> "Coordinate":
        """Coordinate.add(Coordinate): adds weights too."""
        return Coordinate(self.x + other.x, self.y + other.y, self.z + other.z, self.weight + other.weight)

    def add_xyz(self, x1: float, y1: float, z1: float, w1: float = 0.0) -> "Coordinate":
        return Coordinate(self.x + x1, self.y + y1, self.z + z1, self.weight + w1)

    def sub(self, other: "Coordinate") -> "Coordinate":
        """Coordinate.sub keeps this weight."""
        return Coordinate(self.x - other.x, self.y - other.y, self.z - other.z, self.weight)

    def multiply(self, m: float) -> "Coordinate":
        return Coordinate(self.x * m, self.y * m, self.z * m, self.weight * m)

    def dot(self, other: "Coordinate") -> float:
        return self.x * other.x + self.y * other.y + self.z * other.z

    def length(self) -> float:
        return safe_sqrt(self.x * self.x + self.y * self.y + self.z * self.z)

    def length2(self) -> float:
        return self.x * self.x + self.y * self.y + self.z * self.z

    def average(self, other: "Coordinate | None") -> "Coordinate":
        """Weighted average; plain midpoint when both weights are ~0."""
        if other is None:
            return self
        w1 = self.weight + other.weight
        if abs(w1) < _TINY_W:
            return Coordinate((self.x + other.x) / 2, (self.y + other.y) / 2, (self.z + other.z) / 2, 0.0)
        return Coordinate(
            (self.x * self.weight + other.x * other.weight) / w1,
            (self.y * self.weight + other.y * other.weight) / w1,
            (self.z * self.weight + other.z * other.weight) / w1,
            w1,
        )

    def equals(self, other: "Coordinate") -> bool:
        """Coordinate.equals: MathUtil.equals on every field."""
        from .mathutil import equals as eq
        return (eq(self.x, other.x) and eq(self.y, other.y) and eq(self.z, other.z)
                and eq(self.weight, other.weight))

    # -- Python conveniences ---------------------------------------------------
    def __iter__(self):
        yield self.x
        yield self.y
        yield self.z

    def __repr__(self) -> str:
        return f"Coordinate({self.x!r}, {self.y!r}, {self.z!r}, w={self.weight!r})"

    def to_list(self) -> list[float]:
        return [self.x, self.y, self.z]


ZERO = Coordinate(0.0, 0.0, 0.0, 0.0)
NUL = ZERO
NAN = Coordinate(math.nan, math.nan, math.nan, math.nan)
X_UNIT = Coordinate(1.0, 0.0, 0.0)
_MAXV = 1.7976931348623157e308
MAX = Coordinate(_MAXV, _MAXV, _MAXV, _MAXV)
MIN = Coordinate(-_MAXV, -_MAXV, -_MAXV, 0.0)


# --------------------------------------------------------------------------- Transformation

ANGLE_EPSILON = 0.000000001


class Transformation:
    """An affine map: ``rotation * v + translate``."""

    __slots__ = ("rotation", "translate")

    def __init__(self, rotation=None, translate: Coordinate | None = None):
        if rotation is None:
            rotation = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))
        self.rotation = rotation
        self.translate = translate if translate is not None else Coordinate(0.0, 0.0, 0.0)

    @staticmethod
    def translation(x, y=None, z=None) -> "Transformation":
        """getTranslationTransform(Coordinate) or (x, y, z)."""
        if isinstance(x, Coordinate):
            return Transformation(None, x)
        return Transformation(None, Coordinate(x, y, z))

    get_translation_transform = translation

    def transform(self, orig: Coordinate) -> Coordinate:
        r = self.rotation
        t = self.translate
        x = r[0][0] * orig.x + r[0][1] * orig.y + r[0][2] * orig.z + t.x
        y = r[1][0] * orig.x + r[1][1] * orig.y + r[1][2] * orig.z + t.y
        z = r[2][0] * orig.x + r[2][1] * orig.y + r[2][2] * orig.z + t.z
        return Coordinate(x, y, z, orig.weight)

    def transform_all(self, coords) -> list[Coordinate]:
        return [self.transform(c) for c in coords]

    def linear_transform(self, orig: Coordinate) -> Coordinate:
        r = self.rotation
        x = r[0][0] * orig.x + r[0][1] * orig.y + r[0][2] * orig.z
        y = r[1][0] * orig.x + r[1][1] * orig.y + r[1][2] * orig.z
        z = r[2][0] * orig.x + r[2][1] * orig.y + r[2][2] * orig.z
        return Coordinate(x, y, z, orig.weight)

    def apply_transformation(self, other: "Transformation") -> "Transformation":
        """this * other (other applied first)."""
        tr = self.linear_transform(other.translate).add(self.translate)
        a = self.rotation
        b = other.rotation
        rows = []
        for i in range(3):
            x, y, z = a[i][0], a[i][1], a[i][2]
            rows.append((
                x * b[0][0] + y * b[1][0] + z * b[2][0],
                x * b[0][1] + y * b[1][1] + z * b[2][1],
                x * b[0][2] + y * b[1][2] + z * b[2][2],
            ))
        return Transformation(tuple(rows), tr)

    @staticmethod
    def rotate_x(theta: float) -> "Transformation":
        if ANGLE_EPSILON > abs(theta):
            return IDENTITY
        c, s = math.cos(theta), math.sin(theta)
        return Transformation(((1.0, 0.0, 0.0), (0.0, c, -s), (0.0, s, c)))

    @staticmethod
    def rotate_y(theta: float) -> "Transformation":
        if ANGLE_EPSILON > abs(theta):
            return IDENTITY
        c, s = math.cos(theta), math.sin(theta)
        return Transformation(((c, 0.0, s), (0.0, 1.0, 0.0), (-s, 0.0, c)))

    @staticmethod
    def rotate_z(theta: float) -> "Transformation":
        if ANGLE_EPSILON > abs(theta):
            return IDENTITY
        c, s = math.cos(theta), math.sin(theta)
        return Transformation(((c, -s, 0.0), (s, c, 0.0), (0.0, 0.0, 1.0)))

    @staticmethod
    def get_axial_rotation(theta: float) -> "Transformation":
        return Transformation.rotate_x(theta)

    @staticmethod
    def get_rotation_transform(rotation: Coordinate, origin: Coordinate | None = None) -> "Transformation":
        t = IDENTITY
        if abs(rotation.x) > ANGLE_EPSILON:
            t = t.apply_transformation(Transformation.rotate_x(rotation.x))
        if abs(rotation.y) > ANGLE_EPSILON:
            t = t.apply_transformation(Transformation.rotate_y(rotation.y))
        if abs(rotation.z) > ANGLE_EPSILON:
            t = t.apply_transformation(Transformation.rotate_z(rotation.z))
        if origin is None:
            return t
        to_origin = Transformation.translation(-origin.x, -origin.y, -origin.z)
        back = Transformation.translation(origin)
        return back.apply_transformation(t.apply_transformation(to_origin))


IDENTITY = Transformation()


# --------------------------------------------------------------------------- BoundingBox

class BoundingBox:
    __slots__ = ("min", "max")

    def __init__(self, mn: Coordinate | None = None, mx: Coordinate | None = None):
        if mn is None:
            self.min = MAX.set_weight(0.0)
            self.max = MIN.set_weight(0.0)
        else:
            self.min = mn
            self.max = mx

    def is_empty(self) -> bool:
        return self.min.x > self.max.x or self.min.y > self.max.y or self.min.z > self.max.z

    def transform(self, t: Transformation) -> "BoundingBox":
        """BoundingBox.transform: only the two corners are mapped (as in Java)."""
        nb = BoundingBox()
        nb.update(t.transform(self.min))
        nb.update(t.transform(self.max))
        return nb

    def update(self, c) -> "BoundingBox":
        if isinstance(c, BoundingBox):
            if c.is_empty():
                return self
            self.update(c.min)
            self.update(c.max)
            return self
        if isinstance(c, (list, tuple)):
            for p in c:
                self.update(p)
            return self
        mn, mx = self.min, self.max
        if mn.x > c.x or mn.y > c.y or mn.z > c.z:
            self.min = Coordinate(min(mn.x, c.x), min(mn.y, c.y), min(mn.z, c.z), mn.weight)
        if mx.x < c.x or mx.y < c.y or mx.z < c.z:
            self.max = Coordinate(max(mx.x, c.x), max(mx.y, c.y), max(mx.z, c.z), mx.weight)
        return self

    def span(self) -> Coordinate:
        return self.max.sub(self.min)
