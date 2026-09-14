"""Ullage collapse: what warm pressurant loses to cold liquid.

Pressurant enters a LOX tank at roughly ambient temperature and meets a surface
at 90 K. It cools. The pressure it was supplying falls with it, so more
pressurant is demanded, so the bottle drains faster -- and because the regulator
is holding tank pressure, **the effect never shows up as a pressure sag at all.
It shows up as pressurant consumption.** That is the trap: a tank pressure trace
can look perfect while the COPV empties 20% faster than predicted.

Why the model is transient, not a heat transfer coefficient
-----------------------------------------------------------
Heat does not enter the liquid uniformly; it diffuses into a thermal layer that
grows from the surface. The layer's depth goes as ``sqrt(pi alpha t)``, which for
LOX is about **1.1 mm after 5 s** and 3.8 mm after a minute. A steady coefficient
``h`` cannot represent that: whatever value reproduces a five-second burn is far
too small for a two-minute hold, and whatever reproduces the hold is far too
small at ignition. So the model is the transient conduction solution for a
semi-infinite solid, whose instantaneous flux

.. code-block:: text

    q(t) = A . dT . sqrt(k rho c / (pi t))

integrates to ``Q(t) = 2 A dT sqrt(k rho c t / pi)`` -- the familiar
square-root-of-time behaviour, and the reason a repressurisation immediately
before firing is worth doing: it resets ``t``.

That reset is why elapsed contact time is part of the tank's *state* rather than
a wall-clock reading. A scenario that repressurises at T-10 s starts the clock
again; one that has been sitting on the pad for an hour does not, and the two
consume materially different amounts of pressurant over the same burn.

Bounds, honestly
----------------
Pure conduction into quiescent liquid is a **lower** bound. Real ullages have
free convection, sloshing, and a spray of incoming gas that scrubs the interface,
and nitrogen over LOX can condense outright, which moves an order of magnitude
more energy per unit area than sensible cooling does. The
:data:`registered_collapse_models` registry exists so those can be added as
named models with their own assumptions rather than as a fudge factor on this
one. What this module will not do is pretend a single tuned coefficient covers
all of them.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, Protocol, runtime_checkable

#: Elapsed-time floor [s]. The exact solution's flux is singular at ``t = 0``
#: (integrably so -- the *energy* is finite), and an integrator that samples
#: there gets an infinity. One millisecond is far below any timescale in a feed
#: system and bounds the flux at a large but finite value.
MIN_CONTACT_TIME = 1e-3


@dataclass(frozen=True, slots=True)
class LiquidThermal:
    """The three liquid properties a conduction model needs.

    Bundled because they are always fetched together and always at the same
    state, and passed in rather than looked up so the model can be checked
    against a textbook with three floats.
    """

    conductivity: float
    """Thermal conductivity k [W/(m.K)]."""

    density: float
    """rho [kg/m^3]."""

    heat_capacity: float
    """c_p [J/(kg.K)]."""

    @property
    def effusivity(self) -> float:
        """``sqrt(k rho c)`` [J/(m^2.K.s^0.5)] -- how greedily a surface pulls heat.

        The single grouping that transient surface conduction depends on. Worth
        naming: it is why LOX is a much better heat sink than its conductivity
        alone suggests.
        """
        return math.sqrt(self.conductivity * self.density * self.heat_capacity)

    @property
    def diffusivity(self) -> float:
        """``alpha = k / (rho c)`` [m^2/s] -- how fast the thermal layer grows."""
        return self.conductivity / (self.density * self.heat_capacity)

    def penetration_depth(self, elapsed: float) -> float:
        """``sqrt(pi alpha t)`` [m]. How deep the liquid has noticed."""
        return math.sqrt(math.pi * self.diffusivity * max(elapsed, 0.0))


@runtime_checkable
class CollapseModel(Protocol):
    """How much heat the ullage loses to the liquid surface, and when."""

    @property
    def name(self) -> str: ...

    def heat_rate(
        self,
        area: float,
        gas_temperature: float,
        liquid_temperature: float,
        liquid: LiquidThermal,
        elapsed: float,
    ) -> float:
        """Heat leaving the ullage [W]. Positive means the gas is cooling.

        Args:
            area: Interfacial area [m^2] -- the tank's cross-section at the
                surface, which a head geometry makes a function of fill.
            gas_temperature: Bulk ullage temperature [K].
            liquid_temperature: Bulk liquid temperature [K].
            liquid: Liquid thermal properties.
            elapsed: Contact time since the interface was last reset [s].
        """
        ...


@dataclass(frozen=True, slots=True)
class NoCollapse:
    """Ullage exchanges nothing with the liquid.

    An honest choice for a short blowdown of a warm-gas system, and the right
    default only when someone has decided it is. It is a *named* model rather
    than a missing one so a run report can say which assumption produced the
    answer.
    """

    name: str = "none"

    def heat_rate(
        self,
        area: float,
        gas_temperature: float,
        liquid_temperature: float,
        liquid: LiquidThermal,
        elapsed: float,
    ) -> float:
        return 0.0


@dataclass(frozen=True, slots=True)
class ConductionCollapse:
    """Transient conduction into quiescent liquid. A lower bound, and the default.

    Args:
        enhancement: Multiplier on the conduction flux, 1.0 for pure quiescent
            conduction. Free convection and interfacial motion make the real
            value larger; this is where a *fitted* number from a cold-flow test
            goes, and it is deliberately a single dimensionless factor with an
            obvious meaning rather than a tuned coefficient with none.
    """

    enhancement: float = 1.0
    name: str = "conduction"

    def heat_rate(
        self,
        area: float,
        gas_temperature: float,
        liquid_temperature: float,
        liquid: LiquidThermal,
        elapsed: float,
    ) -> float:
        dt = gas_temperature - liquid_temperature
        if area <= 0.0 or dt == 0.0:
            return 0.0
        t = max(elapsed, MIN_CONTACT_TIME)
        flux = liquid.effusivity / math.sqrt(math.pi * t)
        return self.enhancement * area * dt * flux

    def heat_total(
        self,
        area: float,
        gas_temperature: float,
        liquid_temperature: float,
        liquid: LiquidThermal,
        elapsed: float,
    ) -> float:
        """Cumulative heat [J] after ``elapsed`` at constant area and ΔT.

        The closed-form integral of :meth:`heat_rate`. Not used by the
        integrator -- area and temperatures both move -- but it is what the
        model is validated against, and what answers "roughly how much does
        this cost me over a 5 s burn" without running anything.
        """
        dt = gas_temperature - liquid_temperature
        return (
            2.0
            * self.enhancement
            * area
            * dt
            * liquid.effusivity
            * math.sqrt(max(elapsed, 0.0) / math.pi)
        )


#: Builds a collapse model from keyword parameters, registered by name.
CollapseFactory = Callable[..., CollapseModel]

_MODELS: dict[str, CollapseFactory] = {
    "none": lambda **kw: NoCollapse(),
    "conduction": lambda **kw: ConductionCollapse(**kw),
}


def register_collapse_model(name: str, factory: CollapseFactory) -> None:
    _MODELS[name] = factory


def build_collapse_model(name: str, **kwargs: object) -> CollapseModel:
    if name not in _MODELS:
        raise KeyError(
            f"unknown ullage collapse model {name!r}; registered: "
            f"{', '.join(sorted(_MODELS))}"
        )
    return _MODELS[name](**kwargs)


def registered_collapse_models() -> list[str]:
    return sorted(_MODELS)
