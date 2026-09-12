"""Tank geometry: how much liquid is in there, and how much surface it shows.

Three numbers come out of a tank's shape and all three matter:

**Volume below a level.** A propellant load is a mass, and where the surface
sits follows from the shape. Treat a tank as a plain cylinder and you misplace
the surface by the whole height of the end caps -- 5 cm on a 6 in. tank with
2:1 ellipsoidal heads, which is 15% of the volume of a short tank.

**Cross-section at the surface.** This is the area across which warm pressurant
talks to cold liquid, and it is what
:mod:`~feedtwin.vessels.collapse` multiplies its heat flux by. In the barrel it
is constant; in a head it is not, and a nearly-empty tank has a much smaller
interface than a half-full one.

**Wetted wall area.** What the liquid can chill, and what an insulation model
needs. Carried now because Phase 14 wants it and because it is free once the
shape is described.

Shapes are registered by name, so a tank with a geometry nobody anticipated is
a registration rather than an edit to this module -- and the escape hatch below
that is :class:`TabulatedGeometry`, which takes a *V(h)* curve straight off a
CAD model and asks no questions about the shape at all.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, Protocol, Sequence, runtime_checkable

from scipy.optimize import brentq


@runtime_checkable
class TankGeometry(Protocol):
    """A tank shape, described by what a fluid model needs to ask of it."""

    @property
    def total_volume(self) -> float:
        """Internal volume [m^3]."""
        ...

    @property
    def height(self) -> float:
        """Inside height from the lowest point to the highest [m]."""
        ...

    def volume_below(self, level: float) -> float:
        """Liquid volume [m^3] with the surface at ``level`` above the bottom."""
        ...

    def cross_section(self, level: float) -> float:
        """Horizontal area [m^2] at ``level`` -- the liquid surface area."""
        ...

    def wetted_area(self, level: float) -> float:
        """Wall area [m^2] below ``level``."""
        ...


def level_of_volume(geometry: TankGeometry, volume: float) -> float:
    """Invert ``volume_below``: where the surface sits for a given fill [m].

    Numerically rather than analytically. ``volume_below`` is monotonic for any
    physical tank, so a bracketed root always exists and always converges; the
    alternative is a closed-form inverse per shape, which is three times the
    code and wrong the moment somebody registers a fourth shape.
    """
    total = geometry.total_volume
    if volume <= 0.0:
        return 0.0
    if volume >= total:
        return geometry.height
    return float(
        brentq(lambda h: geometry.volume_below(h) - volume, 0.0, geometry.height)
    )


# ------------------------------------------------------------------- the heads


@dataclass(frozen=True, slots=True)
class Head:
    """One end cap, described by how far it bulges past the barrel.

    ``ratio`` is the classical head ratio: the barrel radius divided by the
    head's depth. 2.0 is a 2:1 ellipsoidal head, the common pressure-vessel
    shape; 1.0 is hemispherical; a flat head is depth zero, spelled here as
    ``Head.flat()`` rather than an infinite ratio.
    """

    radius: float
    ratio: float = 2.0

    @staticmethod
    def flat() -> Head:
        return Head(radius=0.0, ratio=math.inf)

    @property
    def depth(self) -> float:
        """How far the head extends beyond the barrel [m]."""
        if not math.isfinite(self.ratio) or self.ratio <= 0.0:
            return 0.0
        return self.radius / self.ratio

    @property
    def volume(self) -> float:
        """Volume of the whole head [m^3]: half an ellipsoid."""
        return (2.0 / 3.0) * math.pi * self.radius * self.radius * self.depth

    def volume_filled(self, depth_filled: float) -> float:
        """Volume [m^3] of the head filled to ``depth_filled`` from its pole.

        Measured from the pole -- the tip of the dome -- because that is where
        a bottom head starts filling and where a top head finishes.

        The cap of a semi-ellipsoid of semi-axes ``(r, r, c)`` filled to depth
        ``d`` from the pole is ``pi r^2 d^2 (3c - d) / (3 c^2)``, which reduces
        to the spherical-cap formula when ``c == r``.
        """
        c = self.depth
        if c <= 0.0:
            return 0.0
        d = min(max(depth_filled, 0.0), c)
        return (
            math.pi * self.radius * self.radius * d * d * (3.0 * c - d) / (3.0 * c * c)
        )

    def cross_section(self, depth_filled: float) -> float:
        """Horizontal area [m^2] at ``depth_filled`` from the pole."""
        c = self.depth
        if c <= 0.0:
            return math.pi * self.radius * self.radius
        d = min(max(depth_filled, 0.0), c)
        # Ellipsoid: (x/r)^2 + ((c - d)/c)^2 = 1 at the free surface.
        frac = 1.0 - ((c - d) / c) ** 2
        return math.pi * self.radius * self.radius * max(frac, 0.0)

    def area_filled(self, depth_filled: float) -> float:
        """Wall area [m^2] of the head below ``depth_filled`` from the pole.

        Archimedes' hat-box result, ``A = 2 pi r d``: the lateral area of a
        spherical zone depends only on the slice thickness. Exact for a
        hemispherical head, and a few percent low for a 2:1 ellipsoidal one --
        comfortably inside the uncertainty of any heat-transfer coefficient
        that will multiply it.
        """
        c = self.depth
        if c <= 0.0:
            return 0.0
        d = min(max(depth_filled, 0.0), c)
        return 2.0 * math.pi * self.radius * d


@dataclass(frozen=True, slots=True)
class CylindricalTank:
    """A cylindrical barrel with a head at each end. The usual tank.

    Args:
        diameter: Inside diameter of the barrel [m].
        barrel_length: Straight length between the head tangent lines [m].
        bottom: Lower head. Defaults to 2:1 ellipsoidal.
        top: Upper head. Defaults to the same as the bottom.
    """

    diameter: float
    barrel_length: float
    bottom: Head | None = None
    top: Head | None = None

    def __post_init__(self) -> None:
        if self.diameter <= 0.0:
            raise ValueError(f"diameter must be positive, got {self.diameter}")
        if self.barrel_length < 0.0:
            raise ValueError(f"barrel_length must be >= 0, got {self.barrel_length}")
        r = self.diameter / 2.0
        object.__setattr__(self, "bottom", self.bottom or Head(radius=r))
        object.__setattr__(self, "top", self.top or Head(radius=r))
        for name in ("bottom", "top"):
            head: Head = getattr(self, name)
            if head.radius not in (0.0, r):
                raise ValueError(
                    f"{name} head radius {head.radius} does not match the "
                    f"barrel radius {r}; a head is a cap on this barrel"
                )

    # Narrowing for type checkers: __post_init__ guarantees these are set.
    @property
    def _bottom(self) -> Head:
        assert self.bottom is not None
        return self.bottom

    @property
    def _top(self) -> Head:
        assert self.top is not None
        return self.top

    @property
    def barrel_area(self) -> float:
        return math.pi * self.diameter * self.diameter / 4.0

    @property
    def total_volume(self) -> float:
        return (
            self._bottom.volume
            + self.barrel_area * self.barrel_length
            + self._top.volume
        )

    @property
    def height(self) -> float:
        return self._bottom.depth + self.barrel_length + self._top.depth

    def volume_below(self, level: float) -> float:
        b, t = self._bottom, self._top
        h = min(max(level, 0.0), self.height)
        if h <= b.depth:
            return b.volume_filled(h)
        if h <= b.depth + self.barrel_length:
            return b.volume + self.barrel_area * (h - b.depth)
        # In the top head: total minus the empty cap above the surface.
        empty_from_pole = self.height - h
        return self.total_volume - t.volume_filled(empty_from_pole)

    def cross_section(self, level: float) -> float:
        b, t = self._bottom, self._top
        h = min(max(level, 0.0), self.height)
        if h <= b.depth:
            return b.cross_section(h)
        if h <= b.depth + self.barrel_length:
            return self.barrel_area
        return t.cross_section(self.height - h)

    def wetted_area(self, level: float) -> float:
        b, t = self._bottom, self._top
        h = min(max(level, 0.0), self.height)
        if h <= b.depth:
            return b.area_filled(h)
        barrel = math.pi * self.diameter * min(h - b.depth, self.barrel_length)
        if h <= b.depth + self.barrel_length:
            return b.area_filled(b.depth) + barrel
        return (
            b.area_filled(b.depth)
            + barrel
            + t.area_filled(t.depth)
            - t.area_filled(self.height - h)
        )

    def __repr__(self) -> str:
        return (
            f"CylindricalTank({self.diameter * 1e3:.0f} mm x "
            f"{self.barrel_length * 1e3:.0f} mm, {self.total_volume * 1e3:.2f} L)"
        )


@dataclass(frozen=True, slots=True)
class TabulatedGeometry:
    """A tank described by a measured or CAD-derived *V(h)* table.

    The escape hatch, and for a real flight tank usually the right answer: a
    weld land, a sump, a baffle ring and an anti-vortex plate are all volume
    that no analytic shape has, and CAD already knows about every one of them.

    Args:
        levels: Heights above the lowest point [m], strictly increasing, the
            first at or below zero and the last the full height.
        volumes: Cumulative volume below each level [m^3], non-decreasing.
        areas: Optional horizontal cross-section at each level [m^2]. Derived
            by differencing the volume table when omitted, which is exactly
            ``dV/dh`` and needs no extra data.
        wall_areas: Optional cumulative wetted wall area [m^2].
    """

    levels: Sequence[float]
    volumes: Sequence[float]
    areas: Sequence[float] | None = None
    wall_areas: Sequence[float] | None = None

    def __post_init__(self) -> None:
        if len(self.levels) < 2:
            raise ValueError("a V(h) table needs at least two points")
        if len(self.levels) != len(self.volumes):
            raise ValueError(
                f"levels and volumes must be the same length, got "
                f"{len(self.levels)} and {len(self.volumes)}"
            )
        if any(b <= a for a, b in zip(self.levels, self.levels[1:])):
            raise ValueError("levels must be strictly increasing")
        if any(b < a for a, b in zip(self.volumes, self.volumes[1:])):
            raise ValueError(
                "volumes must be non-decreasing -- a tank cannot hold less "
                "liquid when the surface goes up"
            )
        for name in ("areas", "wall_areas"):
            table = getattr(self, name)
            if table is not None and len(table) != len(self.levels):
                raise ValueError(f"{name} must be the same length as levels")

    @property
    def total_volume(self) -> float:
        return float(self.volumes[-1])

    @property
    def height(self) -> float:
        return float(self.levels[-1])

    def _interp(self, table: Sequence[float], level: float) -> float:
        h = min(max(level, self.levels[0]), self.levels[-1])
        for i in range(len(self.levels) - 1):
            h0, h1 = self.levels[i], self.levels[i + 1]
            if h <= h1:
                f = (h - h0) / (h1 - h0)
                return float(table[i] + f * (table[i + 1] - table[i]))
        return float(table[-1])

    def volume_below(self, level: float) -> float:
        return self._interp(self.volumes, level)

    def cross_section(self, level: float) -> float:
        if self.areas is not None:
            return self._interp(self.areas, level)
        h = min(max(level, self.levels[0]), self.levels[-1])
        for i in range(len(self.levels) - 1):
            h0, h1 = self.levels[i], self.levels[i + 1]
            if h <= h1:
                return float((self.volumes[i + 1] - self.volumes[i]) / (h1 - h0))
        return 0.0

    def wetted_area(self, level: float) -> float:
        if self.wall_areas is None:
            return 0.0
        return self._interp(self.wall_areas, level)


#: Builds a geometry from keyword parameters. Registered by name so a shape
#: nobody anticipated is a registration, not an edit to this module.
GeometryFactory = Callable[..., TankGeometry]

_GEOMETRIES: dict[str, GeometryFactory] = {}


def register_geometry(name: str, factory: GeometryFactory) -> None:
    _GEOMETRIES[name] = factory


def build_geometry(name: str, **kwargs: object) -> TankGeometry:
    if name not in _GEOMETRIES:
        raise KeyError(
            f"unknown tank geometry {name!r}; registered: "
            f"{', '.join(sorted(_GEOMETRIES))}"
        )
    return _GEOMETRIES[name](**kwargs)


def registered_geometries() -> list[str]:
    return sorted(_GEOMETRIES)


def _cylindrical(
    diameter: float,
    barrel_length: float,
    head_ratio: float = 2.0,
    bottom_head_ratio: float | None = None,
    top_head_ratio: float | None = None,
) -> TankGeometry:
    r = diameter / 2.0

    def head(ratio: float | None) -> Head:
        chosen = head_ratio if ratio is None else ratio
        return (
            Head.flat() if not math.isfinite(chosen) else Head(radius=r, ratio=chosen)
        )

    return CylindricalTank(
        diameter=diameter,
        barrel_length=barrel_length,
        bottom=head(bottom_head_ratio),
        top=head(top_head_ratio),
    )


def cylindrical_from_volume(volume: float, diameter: float) -> CylindricalTank:
    """A barrel of the right volume at a stated diameter, 2:1 heads.

    What a drawing gives you: a volume and a diameter, not a barrel length.
    The heads are fixed at the pressure-vessel default and the barrel takes
    the remainder; a volume smaller than two heads gets a zero barrel rather
    than a negative one.
    """
    radius = diameter / 2.0
    head_volume = 2.0 * (2.0 / 3.0) * math.pi * radius**2 * (radius / 2.0)
    barrel = max((volume - head_volume) / (math.pi * radius**2), 0.0)
    return CylindricalTank(diameter=diameter, barrel_length=barrel)


register_geometry("cylindrical", _cylindrical)
register_geometry("tabulated", TabulatedGeometry)
