"""MathUtil bits the aerodynamics use.

Ported from OpenRocket 24.12 (GPLv3): info.openrocket.core.util.MathUtil.
"""

from __future__ import annotations

import math

EPSILON = 0.00000001  # MathUtil.EPSILON


def pow2(x: float) -> float:
    return x * x


def pow3(x: float) -> float:
    return x * x * x


def pow4(x: float) -> float:
    return (x * x) * (x * x)


def clamp(x, lo, hi):
    if x < lo:
        return lo
    if x > hi:
        return hi
    return x


def min_(*args: float) -> float:
    """MathUtil.min(x, y[, z]): NaN in a later argument is ignored."""
    if len(args) == 2:
        x, y = args
        if math.isnan(y):
            return x
        return x if x < y else y
    if len(args) == 3:
        x, y, z = args
        if x < y or math.isnan(y):
            return min_(x, z)
        return min_(y, z)
    if len(args) == 4:
        w, x, y, z = args
        return min_(min_(w, x), min_(y, z))
    raise TypeError("min_ takes 2..4 arguments")


def max_(*args: float) -> float:
    """MathUtil.max(x, y[, z]): NaN in the first argument is ignored."""
    if len(args) == 2:
        x, y = args
        if math.isnan(x):
            return y
        return y if x < y else x
    if len(args) == 3:
        x, y, z = args
        if x > y or math.isnan(y):
            return max_(x, z)
        return max_(y, z)
    raise TypeError("max_ takes 2..3 arguments")


def hypot(x: float, y: float) -> float:
    return math.sqrt(x * x + y * y)


def safe_sqrt(d: float) -> float:
    if d < 0:
        return 0.0
    return math.sqrt(d)


def equals(a: float, b: float, epsilon: float = EPSILON) -> bool:
    absb = abs(b)
    if absb < epsilon / 2:
        return abs(a) < epsilon / 2
    return abs(a - b) < epsilon * absb


def sign(x: float) -> float:
    return -1.0 if x < 0 else 1.0


def map_(value: float, from_min: float, from_max: float, to_min: float, to_max: float) -> float:
    if equals(to_min, to_max):
        return to_min
    if equals(from_min, from_max):
        raise ValueError("from range is singular and to range is not")
    return (value - from_min) / (from_max - from_min) * (to_max - to_min) + to_min


def interpolate(domain, range_, t: float) -> float:
    """MathUtil.interpolate(List domain, List range, double t)."""
    if domain is None or range_ is None or len(domain) != len(range_):
        return math.nan
    length = len(domain)
    if length <= 1 or t < domain[0] or t > domain[length - 1] + EPSILON:
        return math.nan
    right = 1
    while t > domain[right] + EPSILON:
        right += 1
    left = right - 1
    deltax = domain[right] - domain[left]
    deltay = range_[right] - range_[left]
    if abs(deltax) < EPSILON:
        if deltay < -1.0 * EPSILON:
            return -math.inf
        elif deltay > EPSILON:
            return math.inf
        else:
            return 0.0
    return range_[left] + (t - domain[left]) * deltay / deltax


# ---- Java double semantics where Python would raise instead ----------------

def jdiv(a: float, b: float) -> float:
    """a / b with IEEE-754 results (inf, nan) as Java gives, never ZeroDivisionError."""
    try:
        return a / b
    except ZeroDivisionError:
        if a != a or a == 0:
            return math.nan
        neg = (a < 0) != (math.copysign(1.0, b) < 0)
        return -math.inf if neg else math.inf


def jpow(a: float, b: float) -> float:
    """Math.pow: NaN for a negative base with a fractional exponent; inf for 0**-x."""
    try:
        r = math.pow(a, b)
    except ValueError:
        return math.nan
    except (ZeroDivisionError, OverflowError):
        return math.inf
    return r


def jlog(a: float) -> float:
    if a != a or a < 0:
        return math.nan
    if a == 0:
        return -math.inf
    return math.log(a)


def jlog10(a: float) -> float:
    if a != a or a < 0:
        return math.nan
    if a == 0:
        return -math.inf
    return math.log10(a)


def jsqrt(a: float) -> float:
    if a != a or a < 0:
        return math.nan
    return math.sqrt(a)
