"""An engine card: another tool's injector and chamber, tabulated for the twin.

feedtwin's own engine is deliberately simple:
* an orifice leg per side, with the config's Reynolds-law Cd;
* ``p_c = mdot c* eta / A_t`` on the CEA table, with ``eta = 1``.

EngineDesign's engine is not simple:
* its Cd comes from the plate's passages and a ring-network manifold;
* its c* efficiency comes from a spray march, Rupe stream-tube mixing and wall
  heat loss;
* its nozzle carries a Rayleigh stagnation loss and the real exit state.

Calling that physics from inside the twin's chamber closure would cost seconds
per step. A card is the same physics, sampled once and tabulated, in a form the
twin's network and chamber closure can evaluate in microseconds.

The boundary is the line exit
-----------------------------
The card starts where the drawing's feed line ends: the injector face node,
whose pressure is the line-end pressure in the lumped K-factor convention every
feedtwin line uses (``dp = (f L/D + sum K) rho v^2/2``, no acceleration term).
Everything downstream of that point is the card's:

* the discharge into the manifold (a Borda exit, K = 1 at the exit bore), which
  no drawing line models;
* the manifold;
* the orifices;
* the chamber;
* the nozzle.

Nothing upstream of it is the card's. The caller that builds a card samples its
engine with every feed-line loss removed, so the drawing's lines and the card
never count the same loss twice.

What is tabulated, and why in that form
---------------------------------------
* **Injector, per side.** The flow capacity ``phi = mdot / sqrt(dp)``
  [kg/(s Pa^0.5)] over ``(mdot, inlet pressure)``. For an incompressible
  orifice ``phi`` is nearly constant (``Cd A sqrt(2 rho)``), so the table holds
  the slow part. ``dp = (mdot / phi)^2`` keeps the quadratic exact at any
  flow, including flows outside the table.
* **Chamber.**
  * ``c*_eff = p_c A_t / mdot``: the effective characteristic velocity,
    efficiency and stagnation loss included.
  * ``v_vac = (F + p_a A_e) / mdot``: the vacuum exhaust velocity.
  * Both are tabulated over ``(O/F, mdot_total)``. Thrust at any ambient is then
    ``mdot v_vac - p_a A_e``. That is exact for a full-flowing nozzle, which is
    what lets a card built at one site serve another, or serve a vehicle
    climbing through the atmosphere.

Tables are uniform grids evaluated with Catmull-Rom (C1, interpolating, exact on
linear data, with linear ghost nodes at the edges). Outside the grid they clamp, which keeps every query physical. Every table also carries
the convex hull of the points it was fitted to. A query outside the hull is
reported as extrapolated, so a trace says when it left what the card knows.

Opt-in. An :class:`~feedtwin.engine.design.InjectorSide` without a card, and a
:class:`~feedtwin.engine.chamber.Chamber` that is not a :class:`CardChamber`,
behave exactly as before.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from typing import Any, Mapping, Sequence

from feedtwin.engine.chamber import (
    GRAVITY,
    MIN_CHAMBER_FLOW,
    Chamber,
    ChamberResult,
    CombustionState,
    unlit,
)
from feedtwin.engine.design import EngineDesign

#: Bumped whenever the serialised form changes meaning.
CARD_SCHEMA = 1


def _catmull_rom(p0: float, p1: float, p2: float, p3: float, t: float) -> float:
    """Uniform Catmull-Rom between ``p1`` (t=0) and ``p2`` (t=1)."""
    t2 = t * t
    return 0.5 * (
        2.0 * p1
        + (p2 - p0) * t
        + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
        + (3.0 * p1 - p0 - 3.0 * p2 + p3) * t2 * t
    )


@dataclass(frozen=True, slots=True)
class Table2D:
    """Values on a uniform grid, evaluated with clamped Catmull-Rom.

    ``values[i][j]`` is the value at ``(x0 + i dx, y0 + j dy)``.
    """

    x0: float
    dx: float
    nx: int
    y0: float
    dy: float
    ny: int
    values: tuple[tuple[float, ...], ...]

    def __post_init__(self) -> None:
        if self.nx < 2 or self.ny < 2 or self.dx <= 0.0 or self.dy <= 0.0:
            raise ValueError("a table needs at least 2 x 2 points on positive steps")
        if len(self.values) != self.nx or any(len(r) != self.ny for r in self.values):
            raise ValueError(
                f"table values are not {self.nx} x {self.ny} as its axes say"
            )

    @property
    def x_max(self) -> float:
        return self.x0 + (self.nx - 1) * self.dx

    @property
    def y_max(self) -> float:
        return self.y0 + (self.ny - 1) * self.dy

    def in_box(self, x: float, y: float) -> bool:
        return self.x0 <= x <= self.x_max and self.y0 <= y <= self.y_max

    def __call__(self, x: float, y: float) -> float:
        fx = (min(max(x, self.x0), self.x_max) - self.x0) / self.dx
        fy = (min(max(y, self.y0), self.y_max) - self.y0) / self.dy
        i = min(int(fx), self.nx - 2)
        j = min(int(fy), self.ny - 2)
        tx, ty = fx - i, fy - j
        cols = [_catmull_rom(*self._column(i + di, j), ty) for di in (-1, 0, 1, 2)]
        return _catmull_rom(cols[0], cols[1], cols[2], cols[3], tx)

    def _row(self, i: int) -> tuple[float, ...]:
        """Row ``i``, with a linear ghost beyond either end so the interpolant
        stays exact on linear data up to the edge of the table."""
        v = self.values
        if i < 0:
            return tuple(2.0 * a - b for a, b in zip(v[0], v[1]))
        if i > self.nx - 1:
            return tuple(2.0 * a - b for a, b in zip(v[-1], v[-2]))
        return v[i]

    def _column(self, i: int, j: int) -> tuple[float, float, float, float]:
        row = self._row(i)
        lo = 2.0 * row[0] - row[1] if j - 1 < 0 else row[j - 1]
        hi = 2.0 * row[-1] - row[-2] if j + 2 > self.ny - 1 else row[j + 2]
        return lo, row[j], row[j + 1], hi

    def to_dict(self) -> dict[str, Any]:
        return {
            "x0": self.x0,
            "dx": self.dx,
            "nx": self.nx,
            "y0": self.y0,
            "dy": self.dy,
            "ny": self.ny,
            "values": [list(r) for r in self.values],
        }

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "Table2D":
        return cls(
            x0=float(raw["x0"]),
            dx=float(raw["dx"]),
            nx=int(raw["nx"]),
            y0=float(raw["y0"]),
            dy=float(raw["dy"]),
            ny=int(raw["ny"]),
            values=tuple(tuple(float(v) for v in r) for r in raw["values"]),
        )


def _inside(polygon: Sequence[tuple[float, float]], x: float, y: float) -> bool:
    """Point in polygon by ray casting, the boundary included. An empty polygon
    contains nothing.

    Ray casting alone is half-open: of a square's four edges it keeps two, so a
    sample on the far edge of the hull -- the highest flow or pressure the card was
    built from -- read as outside it, and a query there counted as extrapolated.
    The edge test runs on each axis scaled to the hull's extent, since the axes
    differ by six orders of magnitude (kg/s against Pa).
    """
    n = len(polygon)
    if n == 0:
        return False
    xs = [p[0] for p in polygon]
    ys = [p[1] for p in polygon]
    x0, y0 = min(xs), min(ys)
    sx = (max(xs) - x0) or 1.0
    sy = (max(ys) - y0) or 1.0
    pts = [((px - x0) / sx, (py - y0) / sy) for px, py in polygon]
    u, v = (x - x0) / sx, (y - y0) / sy
    eps = 1e-9
    inside = False
    for k in range(n):
        x1, y1 = pts[k]
        x2, y2 = pts[(k + 1) % n]
        # On this edge: collinear with it and within its extent.
        if (
            abs((x2 - x1) * (v - y1) - (y2 - y1) * (u - x1)) <= eps
            and min(x1, x2) - eps <= u <= max(x1, x2) + eps
            and min(y1, y2) - eps <= v <= max(y1, y2) + eps
        ):
            return True
        if (y1 > v) != (y2 > v):
            cross = x1 + (v - y1) * (x2 - x1) / (y2 - y1)
            if u < cross:
                inside = not inside
    return inside


def _hull(raw: Any) -> tuple[tuple[float, float], ...]:
    return tuple((float(p[0]), float(p[1])) for p in (raw or ()))


@dataclass(frozen=True, slots=True)
class InjectorCard:
    """One side's injector, inlet node to chamber, as a flow capacity.

    ``capacity(mdot, p_inlet) = mdot / sqrt(dp)`` [kg/(s Pa^0.5)].
    """

    capacity: Table2D
    hull: tuple[tuple[float, float], ...] = ()
    """Convex hull of the ``(mdot, p_inlet)`` points the table was fitted to."""

    def pressure_drop(self, mdot: float, p_inlet: float) -> float:
        """Inlet-to-chamber pressure drop [Pa]. Signed with the flow."""
        if mdot == 0.0:
            return 0.0
        phi = self.capacity(abs(mdot), p_inlet)
        if phi <= 0.0:
            raise ValueError("engine card injector capacity is not positive")
        dp = (mdot / phi) ** 2
        return dp if mdot > 0.0 else -dp

    def covers(self, mdot: float, p_inlet: float) -> bool:
        return _inside(self.hull, abs(mdot), p_inlet)

    def to_dict(self) -> dict[str, Any]:
        return {
            "capacity": self.capacity.to_dict(),
            "hull": [list(p) for p in self.hull],
        }

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "InjectorCard":
        return cls(Table2D.from_dict(raw["capacity"]), _hull(raw.get("hull")))


@dataclass(frozen=True, slots=True)
class ChamberCard:
    """Chamber and nozzle over ``(O/F, mdot_total)``."""

    cstar: Table2D
    """``p_c A_t / mdot`` [m/s]."""
    vacuum_velocity: Table2D
    """``(F + p_a A_e) / mdot`` [m/s]."""
    hull: tuple[tuple[float, float], ...] = ()
    """Convex hull of the ``(O/F, mdot_total)`` points the tables were fitted to."""

    def covers(self, mixture_ratio: float, mdot_total: float) -> bool:
        return _inside(self.hull, mixture_ratio, mdot_total)

    def to_dict(self) -> dict[str, Any]:
        return {
            "cstar": self.cstar.to_dict(),
            "vacuum_velocity": self.vacuum_velocity.to_dict(),
            "hull": [list(p) for p in self.hull],
        }

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "ChamberCard":
        return cls(
            Table2D.from_dict(raw["cstar"]),
            Table2D.from_dict(raw["vacuum_velocity"]),
            _hull(raw.get("hull")),
        )


@dataclass(frozen=True, slots=True)
class EngineCard:
    """An engine downstream of its feed lines, tabulated.

    ``fit`` is the card's own measured error against the tool that built it,
    on points it was not fitted to, so a card that is wrong says so.
    """

    name: str
    throat_area: float
    exit_area: float
    oxidiser: InjectorCard
    fuel: InjectorCard
    chamber: ChamberCard
    provenance: Mapping[str, Any] = field(default_factory=dict)
    fit: Mapping[str, float] = field(default_factory=dict)

    def chamber_model(
        self, *, ambient_pressure: float = 101325.0, volume: float = 0.0
    ) -> "CardChamber":
        return CardChamber(self, ambient_pressure=ambient_pressure, volume=volume)

    def attach(self, design: EngineDesign) -> EngineDesign:
        """``design`` with this card's injector characteristics on its two sides.

        The throat has to be the one the card was built for: a card is a
        sampled engine, and the same flows through a different throat are a
        different chamber pressure.
        """
        if abs(design.throat_area - self.throat_area) > 1e-9 * max(
            self.throat_area, 1e-12
        ):
            raise ValueError(
                f"engine card {self.name!r} was built for a {self.throat_area * 1e6:.3f} "
                f"mm^2 throat; this design has {design.throat_area * 1e6:.3f} mm^2"
            )
        return replace(
            design,
            oxidiser=replace(design.oxidiser, card=self.oxidiser),
            fuel=replace(design.fuel, card=self.fuel),
        )

    @property
    def ambient_pressure(self) -> float:
        """The ambient the tool sampled the card at [Pa]; sea level if unsaid."""
        return float(self.provenance.get("ambient_pa_sampled", 101325.0))

    def install(
        self, design: EngineDesign, *, ambient_pressure: float | None = None
    ) -> tuple[EngineDesign, "CardChamber"]:
        """``design`` running this card: its injector on the two sides, and its
        chamber at ``ambient_pressure`` (the card's own site by default).

        The one way an engine card goes onto an engine. The feed-twin cockpit
        and EngineDesign's Layer X both install through here, so the same card
        is the same engine in both.
        """
        attached = self.attach(design)
        ambient = (
            self.ambient_pressure if ambient_pressure is None else ambient_pressure
        )
        return attached, self.chamber_model(
            ambient_pressure=ambient, volume=attached.chamber_volume
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": CARD_SCHEMA,
            "name": self.name,
            "throat_area": self.throat_area,
            "exit_area": self.exit_area,
            "oxidiser": self.oxidiser.to_dict(),
            "fuel": self.fuel.to_dict(),
            "chamber": self.chamber.to_dict(),
            "provenance": dict(self.provenance),
            "fit": dict(self.fit),
        }

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "EngineCard":
        schema = int(raw.get("schema", 0))
        if schema != CARD_SCHEMA:
            raise ValueError(
                f"engine card schema {schema}; this feedtwin reads {CARD_SCHEMA}"
            )
        return cls(
            name=str(raw["name"]),
            throat_area=float(raw["throat_area"]),
            exit_area=float(raw["exit_area"]),
            oxidiser=InjectorCard.from_dict(raw["oxidiser"]),
            fuel=InjectorCard.from_dict(raw["fuel"]),
            chamber=ChamberCard.from_dict(raw["chamber"]),
            provenance=dict(raw.get("provenance") or {}),
            fit={str(k): float(v) for k, v in (raw.get("fit") or {}).items()},
        )


class _CardCStar:
    """The card as a ``CStarModel``, for the callers that ask by pressure.

    :meth:`Chamber.fill_time` asks for ``c*`` at a chamber pressure. The card
    knows ``c*`` at a flow, so this finds the flow that makes that pressure.
    """

    def __init__(self, card: EngineCard) -> None:
        self.card = card

    def combustion(self, pressure: float, mixture_ratio: float) -> CombustionState:
        table = self.card.chamber.cstar
        mdot = pressure * self.card.throat_area / max(table(mixture_ratio, 1.0), 1.0)
        cstar = table(mixture_ratio, mdot)
        for _ in range(6):
            mdot = pressure * self.card.throat_area / max(cstar, 1.0)
            cstar = table(mixture_ratio, mdot)
        return CombustionState(
            cstar=cstar,
            extrapolated=not self.card.chamber.covers(mixture_ratio, mdot),
        )


class CardChamber(Chamber):
    """A chamber whose pressure and thrust come from an engine card.

    ``p_c = mdot c*_eff(O/F, mdot) / A_t``: no fixed point, because the card is
    tabulated over the flows themselves. Thrust is ``mdot v_vac - p_a A_e`` at
    this chamber's ``ambient_pressure``, which a caller may change as a vehicle
    climbs.
    """

    def __init__(
        self,
        card: EngineCard,
        *,
        ambient_pressure: float = 101325.0,
        volume: float = 0.0,
    ) -> None:
        super().__init__(
            card.throat_area,
            _CardCStar(card),
            volume=volume,
            ambient_pressure=ambient_pressure,
        )
        self.card = card

    def evaluate(self, mdot_oxidiser: float, mdot_fuel: float) -> ChamberResult:
        total = mdot_oxidiser + mdot_fuel
        mixture_ratio = mdot_oxidiser / mdot_fuel if mdot_fuel > 1e-12 else 0.0
        if total <= 0.0:
            return ChamberResult(
                pressure=self.ambient_pressure,
                mdot_total=0.0,
                mdot_oxidiser=mdot_oxidiser,
                mdot_fuel=mdot_fuel,
                mixture_ratio=mixture_ratio,
                combustion=CombustionState(cstar=0.0),
                thrust=0.0,
                specific_impulse=0.0,
            )
        if min(mdot_oxidiser, mdot_fuel) <= MIN_CHAMBER_FLOW:
            return unlit(self.ambient_pressure, mdot_oxidiser, mdot_fuel)
        chamber = self.card.chamber
        cstar = chamber.cstar(mixture_ratio, total)
        pressure = max(total * cstar / self.throat_area, self.ambient_pressure)
        firing = pressure > self.ambient_pressure * 1.001
        thrust = 0.0
        if firing:
            thrust = max(
                total * chamber.vacuum_velocity(mixture_ratio, total)
                - self.ambient_pressure * self.card.exit_area,
                0.0,
            )
        coefficient = thrust / (pressure * self.throat_area) if firing else 0.0
        return ChamberResult(
            pressure=pressure,
            mdot_total=total,
            mdot_oxidiser=mdot_oxidiser,
            mdot_fuel=mdot_fuel,
            mixture_ratio=mixture_ratio,
            combustion=CombustionState(
                cstar=cstar,
                thrust_coefficient=coefficient,
                extrapolated=not chamber.covers(mixture_ratio, total),
            ),
            thrust=thrust,
            specific_impulse=(
                thrust / (total * GRAVITY) if firing and thrust > 0.0 else 0.0
            ),
        )
