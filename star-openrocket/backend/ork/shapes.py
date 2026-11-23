"""OpenRocket's nose cone / transition shapes, as radius at a station.

Each function is OpenRocket's ``Transition.Shape.getRadius(x, radius, length, param)``
(core/src/main/java/info/openrocket/core/rocketcomponent/Transition.java, 24.12):
the radius at distance ``x`` from the pointed end of a shape of base ``radius`` and
``length``. Kept formula for formula so a number that disagrees with OpenRocket is
a transcription fault here, not a modelling choice.
"""

from __future__ import annotations

import math
from collections.abc import Callable

import numpy as np

Shape = Callable[[np.ndarray, float, float, float], np.ndarray]


def conical(x, radius, length, param):
    return radius * x / length


def ogive(x, radius, length, param):
    if param < 0.001:
        return conical(x, radius, length, param)
    # Radius of the ogive's generating circle, and its centre's offset.
    big_r = math.sqrt(
        (length**2 + radius**2) * (((2 - param) * length) ** 2 + (param * radius) ** 2)
        / (4 * (param * radius) ** 2)
    )
    big_l = length / param
    y0 = math.sqrt(max(big_r**2 - big_l**2, 0.0))
    return np.sqrt(np.maximum(big_r**2 - (big_l - x) ** 2, 0.0)) - y0


def ellipsoid(x, radius, length, param):
    x = x * radius / length
    return np.sqrt(np.maximum(2 * radius * x - x * x, 0.0))


def power(x, radius, length, param):
    if param <= 0.00001:
        return np.where(x <= 0.00001, 0.0, radius)
    return radius * np.power(np.clip(x / length, 0.0, None), param)


def parabolic(x, radius, length, param):
    u = x / length
    return radius * ((2 * u - param * u * u) / (2 - param))


def haack(x, radius, length, param):
    theta = np.arccos(np.clip(1 - 2 * x / length, -1.0, 1.0))
    if param == 0:
        return radius * np.sqrt(np.maximum((theta - np.sin(2 * theta) / 2) / math.pi, 0.0))
    return radius * np.sqrt(
        np.maximum((theta - np.sin(2 * theta) / 2 + param * np.sin(theta) ** 3) / math.pi, 0.0)
    )


SHAPES: dict[str, Shape] = {
    "conical": conical,
    "ogive": ogive,
    "ellipsoid": ellipsoid,
    "power": power,
    "parabolic": parabolic,
    "haack": haack,
}

#: OpenRocket's default shape parameter per shape, used when the file omits it.
DEFAULT_PARAM = {"ogive": 1.0, "power": 0.5, "parabolic": 1.0, "haack": 0.0}


def _clip_length(fn: Shape, r_small: float, r_big: float, length: float, param: float) -> float:
    """OpenRocket's ``Transition.calculateClip``: how much of a full nose of base
    ``r_big`` to cut off so the remainder starts at ``r_small``. Bisection, as there."""
    if r_small <= 0:
        return 0.0
    lo, hi = 0.0, length
    # Grow the bracket until the clipped tip is wide enough.
    while float(fn(np.array(hi), r_big, hi + length, param)) < r_small:
        lo, hi = hi, hi * 2
        if hi > 1e6 * max(length, 1e-9):
            return lo
    for _ in range(100):
        mid = (lo + hi) / 2
        if float(fn(np.array(mid), r_big, mid + length, param)) > r_small:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2


def profile(
    shape: str,
    param: float,
    length: float,
    r_fore: float,
    r_aft: float,
    n: int,
    clipped: bool = False,
) -> tuple[np.ndarray, np.ndarray]:
    """Stations ``x`` (0 = fore end) and radius for a nose cone or transition.

    OpenRocket's ``Transition.getRadius``: measured from the narrow end, an unclipped
    transition is ``r_small + shape(x, r_big - r_small, L)``; a clipped one is the
    full shape of base ``r_big`` with its tip cut off where it reaches ``r_small``.
    A nose cone is the case ``r_small = 0``, where the two agree.
    """
    fn = SHAPES[shape]
    # Cluster stations toward both ends, where the curvature is.
    u = (1 - np.cos(np.linspace(0.0, math.pi, n))) / 2
    x = u * length
    r_small, r_big = min(r_fore, r_aft), max(r_fore, r_aft)
    if abs(r_big - r_small) < 1e-12:
        return x, np.full_like(x, r_fore)
    from_narrow = x if r_fore <= r_aft else length - x
    if clipped and r_small > 0 and shape != "conical":
        clip = _clip_length(fn, r_small, r_big, length, param)
        r = fn(clip + from_narrow, r_big, clip + length, param)
    else:
        r = r_small + fn(from_narrow, r_big - r_small, length, param)
    return x, np.asarray(r, dtype=np.float64)
