"""Numeric helpers.

Ported from OpenRocket 24.12 (GPLv3): info.openrocket.core.util.MathUtil,
info.openrocket.core.util.Inertia.

Java's semantics are kept where they differ from Python's: ``reduce_pi`` uses
``Math.rint`` (round half to even, which Python's ``round`` also does),
``hypot`` is ``sqrt(x*x + y*y)`` like MathUtil.hypot (not ``math.hypot``), and
``safe_sqrt`` returns 0 for negative arguments.
"""

from __future__ import annotations

import math

#: MathUtil.EPSILON -- "10 mm^3 in m^3"; the tolerance of MathUtil.equals.
EPSILON = 0.00000001

TWO_PI = 2 * math.pi


def pow2(x: float) -> float:
    return x * x


def pow3(x: float) -> float:
    return x * x * x


def pow4(x: float) -> float:
    return (x * x) * (x * x)


def clamp(x: float, lo: float, hi: float) -> float:
    if x < lo:
        return lo
    if x > hi:
        return hi
    return x


def jmax(a: float, b: float) -> float:
    """MathUtil.max: NaN-propagating like Math.max."""
    if math.isnan(a) or math.isnan(b):
        return float("nan")
    return a if a >= b else b


def jmin(a: float, b: float) -> float:
    if math.isnan(a) or math.isnan(b):
        return float("nan")
    return a if a <= b else b


def hypot(x: float, y: float) -> float:
    """MathUtil.hypot is sqrt(x*x + y*y), not Math.hypot."""
    return math.sqrt(x * x + y * y)


def safe_sqrt(d: float) -> float:
    if d < 0:
        return 0.0
    return math.sqrt(d)


def equals(a: float, b: float, epsilon: float = EPSILON) -> bool:
    """MathUtil.equals: relative comparison, absolute near zero."""
    absb = abs(b)
    if absb < epsilon / 2:
        return abs(a) < epsilon / 2
    return abs(a - b) < epsilon * absb


def rint(x: float) -> float:
    """Math.rint: round half to even."""
    return float(round(x))


def reduce_pi(x: float) -> float:
    """MathUtil.reducePi: reduce an angle to -pi..pi."""
    d = rint(x / (2 * math.pi))
    return x - d * 2 * math.pi


def reduce_2pi(x: float) -> float:
    """MathUtil.reduce2Pi: reduce an angle to 0..2pi."""
    d = math.floor(x / (2 * math.pi))
    return x - d * 2 * math.pi


def map_range(value: float, from_min: float, from_max: float, to_min: float, to_max: float) -> float:
    """MathUtil.map."""
    if equals(to_min, to_max):
        return to_min
    if equals(from_min, from_max):
        raise ValueError("from range is singular and to range is not")
    return (value - from_min) / (from_max - from_min) * (to_max - to_min) + to_min


def signum(x: float) -> float:
    if x > 0:
        return 1.0
    if x < 0:
        return -1.0
    return x


# Inertia (info.openrocket.core.util.Inertia)

def filled_cylinder_rotational(radius: float) -> float:
    return pow2(radius) / 2


def filled_cylinder_longitudinal(radius: float, length: float) -> float:
    return (3 * pow2(radius) + pow2(length)) / 12
