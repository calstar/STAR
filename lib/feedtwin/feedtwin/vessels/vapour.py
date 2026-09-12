"""Propellant vapour in the ullage, and what it does to a pressure trace.

The tank model without this is two species with one interface: pressurant above,
liquid below, nothing crossing. That is a good model of a warm-gas system on a
short burn and a poor one of a cryogen, for a reason worth stating precisely.

**Where the interfacial heat goes.** The ullage loses heat to the cold surface --
:mod:`feedtwin.vessels.collapse` computes how much. Without a vapour model that
heat has exactly one place to go: raising the bulk liquid temperature. For
ethanol at 293 K that is right, and it is a few millikelvin over a burn. For LOX
sitting at its normal boiling point it is wrong, because a saturated liquid
cannot warm. It **boils**, at ``mdot = q / h_fg``, and the mass goes into the
ullage where it carries its own partial pressure.

That single difference is the one that decides three things a propulsion engineer
actually asks about:

* **A cryogenic tank vent.** Without vapour, opening a vent empties the ullage
  gas and the trace collapses in tens of milliseconds -- 2.65 g of helium is
  simply not much. With it, the falling pressure drives boil-off that replenishes
  the ullage, and the tank vents for as long as there is liquid and heat. The
  difference is not a correction, it is the shape of the curve.
* **Pressurant consumption.** Vapour is free ullage. A tank that boils needs less
  pressurant to hold pressure than one that does not, so a COPV sized against the
  no-vapour model is sized conservatively -- which is the safe direction, but not
  a free one when the bottle is already the limiting item.
* **Nitrogen over LOX.** Condensation, the case :mod:`collapse` names as moving
  "an order of magnitude more energy per unit area than sensible cooling does".
  It is the same interface running backwards, and it is why the GN2 curves in the
  COPV study are optimistic.

Why partial pressures and not a mixture EOS
-------------------------------------------
The ullage is treated as pressurant and vapour sharing a volume and a
temperature, each on its own equation of state, with **Dalton's law** summing the
partials. Not a real mixture EOS.

That is a deliberate approximation and it is a good one here: at ullage
conditions -- a few tens of bar, well above both species' critical temperature
for helium and far from the vapour's critical point -- the mixture is nearly
ideal in the sense that matters, while a real mixture EOS costs a CoolProp
mixture model per evaluation and a whole class of convergence failures at the
composition extremes this model spends most of its time at (pure pressurant at
t=0, pure vapour in a vented tank). The error is a percent-level fugacity
correction; the cost avoided is a solver that stops converging.

Off by default, and why
-----------------------
:class:`NoVapour` is the default, so nothing changes for an existing model unless
someone asks. Two reasons, and the second is the honest one:

1. For a storable at room temperature it genuinely is negligible -- ethanol's
   vapour pressure at 293 K is 5.8 kPa against a 38 bar ullage, 0.015%.
2. It is the more fragile model. Saturation properties near a critical point,
   a tank driven below its triple point by a fast vent, a liquid that runs out
   mid-step -- these are real states an integrator will visit, and a run that
   fails is worse than a run that is 2% optimistic. Turning it on should be a
   decision with a reason behind it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Protocol, runtime_checkable

from feedtwin.props import Fluid, PropertyError


@dataclass(frozen=True, slots=True)
class VapourExchange:
    """What crossed the interface this instant.

    Args:
        mdot: Evaporation rate [kg/s]. Positive leaves the liquid for the
            ullage; negative is condensation.
        latent_power: Heat consumed by the phase change [W]. Always the part of
            the interfacial heat that did *not* warm the liquid, so a caller can
            split the budget without recomputing ``h_fg``.
    """

    mdot: float = 0.0
    latent_power: float = 0.0


@runtime_checkable
class VapourModel(Protocol):
    """How a liquid surface exchanges mass with the ullage above it."""

    @property
    def name(self) -> str: ...

    def exchange(
        self,
        *,
        liquid: Fluid,
        liquid_temperature: float,
        ullage_pressure: float,
        vapour_partial_pressure: float,
        interface_area: float,
        heat_to_interface: float,
    ) -> VapourExchange:
        """Mass and latent heat crossing the surface.

        Args:
            liquid: The propellant, for its saturation properties.
            liquid_temperature: Bulk liquid temperature [K].
            ullage_pressure: Total ullage pressure [Pa].
            vapour_partial_pressure: The propellant's own partial pressure in
                the ullage [Pa]. Below saturation the surface evaporates; above
                it, it condenses.
            interface_area: Liquid surface area [m^2].
            heat_to_interface: Heat arriving at the surface from the ullage [W],
                positive into the liquid. This is the energy available to boil.
        """
        ...


@dataclass(frozen=True, slots=True)
class NoVapour:
    """The ullage is pressurant only. The default, and a named choice.

    Correct for a storable well below its boiling point, and the conservative
    choice for a cryogen: without boil-off the model demands more pressurant to
    hold a given pressure than reality will, so a COPV sized on it is sized
    large.
    """

    name: str = "none"

    def exchange(
        self,
        *,
        liquid: Fluid,
        liquid_temperature: float,
        ullage_pressure: float,
        vapour_partial_pressure: float,
        interface_area: float,
        heat_to_interface: float,
    ) -> VapourExchange:
        return VapourExchange()


@dataclass(frozen=True, slots=True)
class SaturatedVapour:
    """A saturated liquid surface: interfacial heat becomes latent heat.

    The physical statement is one line -- **a liquid at its saturation
    temperature cannot warm, so heat arriving at it boils liquid instead** --
    and everything else follows:

    .. code-block:: text

        mdot_evap = q_interface / h_fg(T_liquid)

    with ``h_fg`` the latent heat at the liquid's own temperature. Heat leaving
    the surface the other way (a cold ullage over warmer liquid, or a vapour
    partial pressure above saturation) condenses at the same rate with the sign
    reversed.

    ``saturated_fraction`` is the one knob, and it is a physical statement
    rather than a tuning factor: how much of the interfacial heat load the
    surface answers with phase change rather than sensible warming. It is 1.0
    for a liquid genuinely at its boiling point -- a vented LOX tank -- and less
    for a subcooled one, where the surface must first be brought to saturation.
    A subcooled liquid with this model at 1.0 will boil when it should warm, so
    the default is to compute the subcooling and let it fall out.
    """

    saturated_fraction: float = 1.0
    name: str = "saturated"

    def exchange(
        self,
        *,
        liquid: Fluid,
        liquid_temperature: float,
        ullage_pressure: float,
        vapour_partial_pressure: float,
        interface_area: float,
        heat_to_interface: float,
    ) -> VapourExchange:
        if interface_area <= 0.0:
            return VapourExchange()
        try:
            h_fg = latent_heat(liquid, liquid_temperature)
            p_sat = liquid.get("p", T=liquid_temperature, q=0.0)
        except (ValueError, PropertyError):
            # Off the saturation line entirely -- above the critical point, or
            # below the triple point after a violent vent. There is no phase
            # change to compute and saying so beats inventing one.
            return VapourExchange()
        if h_fg <= 0.0:
            return VapourExchange()

        # How saturated the surface actually is. A liquid whose own vapour
        # pressure already exceeds its partial pressure in the ullage is boiling;
        # one held well below is subcooled and warms instead.
        if p_sat <= 0.0:
            return VapourExchange()
        driving = (p_sat - vapour_partial_pressure) / p_sat
        share = self.saturated_fraction * max(min(driving, 1.0), -1.0)

        latent_power = heat_to_interface * share
        return VapourExchange(mdot=latent_power / h_fg, latent_power=latent_power)


def latent_heat(liquid: Fluid, temperature: float) -> float:
    """``h_fg`` [J/kg] at a temperature, from the saturation line.

    The difference of the two saturated enthalpies rather than a correlation, so
    it comes from the same equation of state as everything else and goes to zero
    at the critical point on its own.
    """
    h_vapour = liquid.get("h", T=temperature, q=1.0)
    h_liquid = liquid.get("h", T=temperature, q=0.0)
    return h_vapour - h_liquid


_MODELS: dict[str, Callable[[], VapourModel]] = {
    "none": NoVapour,
    "saturated": SaturatedVapour,
}


def register_vapour_model(name: str, build: Callable[[], VapourModel]) -> None:
    """Add a named vapour model.

    The registry exists for the same reason :mod:`feedtwin.vessels.collapse` has
    one: condensation of nitrogen over LOX, interfacial mass-transfer
    correlations and a fitted boil-off rate are all real models with different
    assumptions, and each should arrive as a named thing a run report can print
    rather than as a coefficient inside this one.
    """
    _MODELS[name] = build


def vapour_model(name: str) -> VapourModel:
    if name not in _MODELS:
        raise KeyError(
            f"no vapour model {name!r}; available: {', '.join(sorted(_MODELS))}"
        )
    return _MODELS[name]()


def registered_vapour_models() -> list[str]:
    return sorted(_MODELS)
