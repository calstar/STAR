"""The metal a line is made of, and the heat it gives the gas flowing through it.

Every component in this library is otherwise adiabatic, and for a liquid leg over
a five-second burn that is fine. For the pressurant path it is not, and the
evidence is visible on the stand: **icicles form on the fittings downstream of
the regulator.**

Those icicles are worth reading carefully, because they point at the mechanism
that matters and not the one they look like. Frost on the outside proves the
*metal got cold*. The metal got cold because the gas took its heat. Heat coming
back the other way -- room air into a frosted fitting -- is the small term:
measured against the drawn press path it is 6 W in still air and 32 W with a
generous frosting coefficient, which is **0.04 to 0.18 K** of gas warming. The
frost cannot carry much either; ambient at 50% RH holds about 4.3 g of water per
cubic metre, so even 10 W of latent heat would need cubic metres per second of
air stripped dry by natural convection.

The line's own thermal mass is the real term. Nitrogen leaves the regulator at
251 K into metal sitting at 293 K, and on the drawn 255 mm press path that is
about 420 g of tube and fittings holding 200 J/K. Worked through as a heat
exchanger it is **6.1 K at ignition and 4.4 K averaged over the burn -- 14% of
the 30.3 K Joule-Thomson drop.** On a plausible real stand, a metre of line with
ten fittings, it is 11.3 K, or 37%.

What this deliberately does *not* model
---------------------------------------
**Soak.** No heat transfer with no flow, and no tracking of how a line drifts
towards ambient while a stand sits. That was a considered scope decision rather
than an omission: modelling it well means an ambient boundary, insulation state
and an hours-long clock on every line, and modelling it badly means inventing a
starting temperature and dressing it as physics.

Instead the wall **starts at the temperature of the fluid its line holds at
rest**, which is what a soak model would converge to anyway and needs no clock.
That single choice is what makes a cryogenic stand come out right: a line full of
liquid oxygen has been sitting at about 90 K and its fittings are cold, a line
off the *top* of that tank holds ullage gas and is at whatever the ullage is --
cool if the tank has been sitting, near ambient if it was just pressed -- and a
pressurant line that has only ever seen bottle gas is at ambient. Three very
different wall temperatures, none of them assumed: each is just the line's own
fluid, read off the network once its temperatures have settled.

Read off the network, specifically, and not off the drawing. At build time a
tank node still carries whatever the drawing declared, which for a LOX tank is
liquid temperature -- so seeding there would put the metal of a vent line 200 K
below the vapour actually standing in it. `Session._propagate_temperatures`
seeds each wall on the first tick it has real node temperatures to seed from,
which costs one tick of no wall heat and gets all three tiers right.

The consequence is that this is a **first-run effect**, correctly. Fire twice
back to back and the second run sees a wall already near the gas temperature, so
it warms the gas by under 2 K instead of 6. The stand behaves that way too.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from feedtwin.comps.correlations import LAMINAR_LIMIT

#: Specific heat of austenitic stainless [J/(kg.K)] against temperature [K].
#:
#: Not a constant, and the reason is cryogenic: 316 falls from about 500 J/(kg.K)
#: at room temperature to roughly 190 at liquid-nitrogen temperature. A LOX
#: line's wall holds **two and a half times less** heat than a room-temperature
#: constant would claim, so using one would overstate what a cold line can give
#: back by that factor. Piecewise-linear through NIST's cryogenic material
#: values, which is well inside the spread between 304 and 316 anyway.
_STAINLESS_CP = (
    (20.0, 16.0),
    (50.0, 80.0),
    (77.0, 190.0),
    (100.0, 230.0),
    (150.0, 320.0),
    (200.0, 400.0),
    (250.0, 460.0),
    (300.0, 500.0),
    (400.0, 530.0),
)

#: Density of austenitic stainless [kg/m^3]. Varies by under 1% over this range.
STAINLESS_DENSITY = 8000.0

#: Mass of one 1/2 in. tube union in 316 [kg], and the bore it belongs to [m].
#:
#: Measured points on the Swagelok range are 32 g at 1/4 in., 62 g at 3/8 in. and
#: 113 g at 1/2 in.; fitted, a body goes as bore^1.82, which is near enough the
#: square to write it that way and say so.
UNION_MASS = 0.113
UNION_BORE = 0.01092


def fitting_metal(count: float, bore: float) -> float:
    """Metal in ``count`` tube fittings on a line of this ``bore`` [kg].

    A *tube* fitting, which is the thing most of a stand is made of and the
    wrong answer in two places. A fitting on the high-pressure side of the
    regulator carries much more metal for the same bore, because it is holding
    4500 psi rather than 500; and a valve body is several unions' worth. Both
    are why `fitting_mass` exists as an override -- count on the low-pressure
    side, weigh on the high.
    """
    if count <= 0.0 or bore <= 0.0:
        return 0.0
    return count * UNION_MASS * (bore / UNION_BORE) ** 2


def stainless_capacity(temperature: float) -> float:
    """``c_p`` of the wall [J/(kg.K)] at a temperature."""
    if temperature <= _STAINLESS_CP[0][0]:
        return _STAINLESS_CP[0][1]
    if temperature >= _STAINLESS_CP[-1][0]:
        return _STAINLESS_CP[-1][1]
    for (t0, c0), (t1, c1) in zip(_STAINLESS_CP, _STAINLESS_CP[1:]):
        if t0 <= temperature <= t1:
            return c0 + (c1 - c0) * (temperature - t0) / (t1 - t0)
    return _STAINLESS_CP[-1][1]


@dataclass(frozen=True, slots=True)
class WallExchange:
    """What one line's metal did to the gas crossing it."""

    heat: float = 0.0
    """Heat into the fluid [W]. Positive warms the fluid and cools the wall."""

    outlet_temperature: float = 0.0
    """Fluid temperature leaving the line [K]."""

    effectiveness: float = 0.0
    """``1 - exp(-NTU)``. The fraction of the wall-to-fluid temperature
    difference the fluid actually picks up in one pass; near zero for a short
    line at high flow, near one for a long line at low flow."""


@dataclass(frozen=True, slots=True)
class LineWall:
    """A lumped thermal mass wrapped around one line.

    One temperature for the whole run, and **the honest justification for that
    covers the tube but not the fittings.** Across a 0.9 mm tube wall the Biot
    number is 0.17 and the metal really is near enough isothermal: against a
    1-D conduction solution the lumped answer is exact to two figures. A
    fitting body is 5-8 mm of steel, which is Bi 0.9 to 1.5, and there the
    lumped model **over-credits the heat by 19% at 5 mm and 32% at 8 mm** over
    a six-second burn, because the core cannot reach the bore in time. Steel's
    diffusion depth is 1.9 mm at 1 s and 4.7 mm at 6 s.

    That error is knowingly carried, for a reason that has to be measured
    rather than assumed: **the model is film-limited, not mass-limited.**
    Doubling the metal on the shipped stand moves end-of-burn tank pressure by
    6 psi out of 52, so a 20% over-credit on the fitting mass is worth two or
    three. Resolving it would mean a second node, a fitting-thickness
    parameter, and a conduction coupling, to move a number by less than the
    uncertainty in how many fittings are actually on the stand. If a drawing
    ever lands in the mass-limited regime -- thin lines, few fittings, high
    flow -- that trade stops holding, and the benchmark's saturation check is
    what catches it.

    Args:
        mass: Metal in thermal contact with the flow [kg].
        area: Wetted internal area [m^2].
        bore: Internal diameter [m], for the convection correlation.
    """

    mass: float
    area: float
    bore: float

    @property
    def capacity_at(self) -> float:
        """Placeholder to keep the dataclass slotted; use :meth:`capacity`."""
        return self.mass

    def capacity(self, temperature: float) -> float:
        """Thermal capacity of the wall [J/K] at its current temperature."""
        return self.mass * stainless_capacity(temperature)

    def exchange(
        self,
        *,
        mdot: float,
        wall_temperature: float,
        inlet_temperature: float,
        density: float,
        viscosity: float,
        conductivity: float,
        heat_capacity: float,
    ) -> WallExchange:
        """Heat the wall gives the stream, and the temperature it leaves at.

        Treated as a single-stream heat exchanger against a wall at one
        temperature: the film coefficient comes from Dittus-Boelter, and the
        outlet follows from the number of transfer units rather than from
        applying a heat rate to an inlet state. Using ``Q = h.A.dT`` directly
        would let a long line at low flow hand the gas more than the wall-to-gas
        difference, which is not a small error -- it is thermodynamically
        impossible.

        **No flow, no exchange.** A still line does not trade heat with its
        metal here; see the module docstring for why soak is out of scope.
        """
        if abs(mdot) < 1e-9 or self.area <= 0.0 or heat_capacity <= 0.0:
            return WallExchange(outlet_temperature=inlet_temperature)
        if density <= 0.0 or viscosity <= 0.0 or conductivity <= 0.0:
            return WallExchange(outlet_temperature=inlet_temperature)

        area_flow = math.pi * self.bore * self.bore / 4.0
        velocity = abs(mdot) / (density * area_flow)
        reynolds = density * velocity * self.bore / viscosity
        prandtl = heat_capacity * viscosity / conductivity
        if reynolds < LAMINAR_LIMIT:
            # Laminar, constant wall temperature. A fully developed round tube
            # sits at Nu = 3.66 and no correlation improves on that.
            nusselt = 3.66
        else:
            # Dittus-Boelter with the cooling exponent: the fluid here is
            # usually colder than the wall on the pressurant path and warmer on
            # a chilled one, so the exponent is chosen per direction.
            exponent = 0.4 if wall_temperature > inlet_temperature else 0.3
            nusselt = 0.023 * reynolds**0.8 * prandtl**exponent
        film = nusselt * conductivity / self.bore

        ntu = film * self.area / (abs(mdot) * heat_capacity)
        effectiveness = 1.0 - math.exp(-min(ntu, 40.0))
        rise = effectiveness * (wall_temperature - inlet_temperature)
        return WallExchange(
            heat=abs(mdot) * heat_capacity * rise,
            outlet_temperature=inlet_temperature + rise,
            effectiveness=effectiveness,
        )
