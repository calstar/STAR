r"""Why the mixture ratio is what it is.

A coupled run reports an O/F. On its own that number is nearly useless as a
design input, because it says nothing about *what set it* -- and the two things
that could have are owned by different people. The injector face is the engine
designer's; the pressure the two legs arrive at is the stand's. Told only that
O/F came out at 2.19 against a 1.65 target, the engine designer redrills the
face and the stand builder does nothing, and the redrilled face is then wrong
for the day the fuel line gets shortened.

The decomposition is exact, not a correlation
---------------------------------------------
Each side of an injector is an orifice::

    mdot = Cd . A . sqrt(2 . rho . dp)

so the ratio of the two is, with no approximation at all,

.. code-block:: text

    O/F  =  Cd_ox A_ox sqrt(rho_ox)     .   sqrt( dp_ox )
            -------------------------       ------------
            Cd_f  A_f  sqrt(rho_f )         sqrt( dp_f  )

            \______ face ratio ______/       \_ feed _/

Two multiplicative terms. The **face ratio** is what the injector would deliver
if both sides saw the same pressure difference -- pure geometry, discharge
coefficient and propellant density, and the number the engine was drilled to.
The **feed term** is everything the stand does to that, and it is one at
equal injector drop, above one when the fuel leg is the more restrictive, below
when the ox leg is.

Because the split is exact, it is a *fault localisation* rather than a summary:
a face ratio that is off tells the engine designer to redrill, a feed term that
is off tells the stand builder to re-plumb, and neither has to wonder.

Stiffness is the other half of the same picture
-----------------------------------------------
The injector's share of the total pressure drop, ``dp_inj / p_c``, is the
classic design rule -- roughly 20% and up, and both legs, not the average. Below
it the chamber starts talking back to the feed system faster than the feed
system can answer, which is where coupled instability lives. It is reported per
side here because an average hides exactly the case that matters: one stiff leg
and one soft one is not a healthy injector, it is a healthy leg next to the leg
that will chug.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from feedtwin.engine.design import EngineDesign

#: Injector stiffness below which a leg is called soft [-]. The usual rule of
#: thumb, and a rule of thumb is what it is: 20% is where the literature puts
#: the knee for stable pressure-fed operation, not a cliff edge. A leg at 0.18
#: is a note; a leg at 0.05 is a finding.
SOFT_STIFFNESS = 0.20

#: Below this, the leg is barely metering at all and the feed system is setting
#: the flow. Reported at a higher severity.
VERY_SOFT_STIFFNESS = 0.10

#: Relative disagreement with the design mixture ratio worth reporting [-].
MIXTURE_TOLERANCE = 0.05


@dataclass(frozen=True, slots=True)
class SideBalance:
    """One propellant's arrival at the face.

    Args:
        propellant: Species name.
        mdot: Delivered mass flow [kg/s].
        density: Liquid density at the face [kg/m^3].
        area: Geometric injector area, all elements [m^2].
        cd: Discharge coefficient at this operating point [-].
        injector_dp: Pressure difference across the face [Pa].
        supply_pressure: Pressure at the tank outlet [Pa]. The head of the
            budget, so ``supply - injector_dp - p_c`` is what the plumbing ate.
    """

    propellant: str
    mdot: float
    density: float
    area: float
    cd: float
    injector_dp: float
    supply_pressure: float = 0.0
    band: tuple[float, float] = (0.0, 0.0)
    """``(min, max)`` stiffness this side was designed to, from the engine
    config. ``(0, 0)`` falls back to :data:`SOFT_STIFFNESS`."""

    @property
    def effective_area(self) -> float:
        """``Cd . A`` [m^2] -- the area the flow actually sees."""
        return self.cd * self.area

    @property
    def velocity(self) -> float:
        """Mean injection velocity [m/s]. Sets atomisation, so it is worth
        seeing next to the pressure drop rather than derived later."""
        if self.density <= 0.0 or self.area <= 0.0:
            return 0.0
        return abs(self.mdot) / (self.density * self.area)

    def feed_loss(self, chamber_pressure: float) -> float:
        """What the plumbing spent between tank outlet and face [Pa].

        Zero when no supply pressure was supplied, rather than a negative
        number that would read as the feed system adding pressure.
        """
        if self.supply_pressure <= 0.0:
            return 0.0
        return max(self.supply_pressure - chamber_pressure - self.injector_dp, 0.0)

    def stiffness(self, chamber_pressure: float) -> float:
        """``dp_injector / p_c`` [-]. The design rule's number."""
        if chamber_pressure <= 0.0:
            return 0.0
        return self.injector_dp / chamber_pressure

    @property
    def floor(self) -> float:
        """The stiffness this side must clear: its own band, else the rule."""
        return self.band[0] if self.band[0] > 0.0 else SOFT_STIFFNESS

    @property
    def ceiling(self) -> float:
        """The top of the design band, or zero when none was stated.

        A real upper bound, not a formality: past it the injector is spending
        tank pressure the vehicle carried structural mass to hold, and the
        optimiser that chose the band was trading exactly that.
        """
        return self.band[1]


@dataclass(frozen=True, slots=True)
class MixtureBalance:
    """The O/F, split into the half the engine owns and the half the stand does.

    ``mixture_ratio == face_ratio * feed_term`` holds to solver tolerance. It is
    an identity, not a fit, so a discrepancy between the two sides of it means
    the flows and pressure drops handed in are not self-consistent -- which is
    itself worth knowing, and is what :attr:`residual` reports.
    """

    oxidiser: SideBalance
    fuel: SideBalance
    chamber_pressure: float
    design_ratio: float = 0.0

    # ------------------------------------------------------------- the split

    @property
    def mixture_ratio(self) -> float:
        """Delivered O/F, straight from the flows."""
        if self.fuel.mdot <= 0.0:
            return 0.0
        return self.oxidiser.mdot / self.fuel.mdot

    @property
    def face_ratio(self) -> float:
        """O/F the face alone would deliver, at equal injector pressure drop.

        The number the injector was drilled to. Independent of the stand, the
        tanks, and the run -- change the plumbing and this does not move.
        """
        ox, fu = self.oxidiser, self.fuel
        denominator = fu.effective_area * math.sqrt(max(fu.density, 0.0))
        if denominator <= 0.0:
            return 0.0
        return ox.effective_area * math.sqrt(max(ox.density, 0.0)) / denominator

    @property
    def feed_term(self) -> float:
        """``sqrt(dp_ox / dp_fuel)`` [-]. Everything the stand contributes.

        One when both legs drop the same across the face. Above one when the
        fuel leg is the more restrictive one upstream, because then the fuel
        arrives at a lower pressure and spends less of it at the face.
        """
        if self.fuel.injector_dp <= 0.0:
            return 0.0
        return math.sqrt(self.oxidiser.injector_dp / self.fuel.injector_dp)

    @property
    def residual(self) -> float:
        """Relative gap between the identity and the delivered ratio [-].

        Should be at solver tolerance. Anything larger means the pressure drops
        and the flows disagree, so the decomposition below is not describing
        the run it claims to.
        """
        predicted = self.face_ratio * self.feed_term
        actual = self.mixture_ratio
        if actual <= 0.0:
            return 0.0
        return abs(predicted - actual) / actual

    @property
    def design_error(self) -> float:
        """Relative distance from the design mixture ratio [-]."""
        if self.design_ratio <= 0.0:
            return 0.0
        return (self.mixture_ratio - self.design_ratio) / self.design_ratio

    # --------------------------------------------------------- what to do now

    @property
    def feed_term_for_design(self) -> float:
        """The feed term that would land the design O/F on this face.

        What the stand would have to do, taking the injector as built. Compared
        against :attr:`feed_term`, it says how far the plumbing is from
        delivering what the engine was drilled for.
        """
        face = self.face_ratio
        if face <= 0.0 or self.design_ratio <= 0.0:
            return 0.0
        return self.design_ratio / face

    def trim_pressure(self) -> float:
        """Extra fuel-side supply pressure that would restore the design O/F [Pa].

        Holding the ox leg where it is, the fuel injector drop has to rise to
        ``dp_ox / feed_target^2``; every pascal of that has to come from the
        fuel tank, *plus* the extra the fuel plumbing eats at the higher flow.
        The second part is why this is a first step and not an answer: it is
        computed at the present flow, so it under-states the true requirement.
        Positive means the fuel side needs more pressure.
        """
        target = self.feed_term_for_design
        if target <= 0.0 or self.oxidiser.injector_dp <= 0.0:
            return 0.0
        wanted = self.oxidiser.injector_dp / (target * target)
        return wanted - self.fuel.injector_dp

    def notes(self) -> list[str]:
        """Findings, in the order an operator would want to read them.

        Written as sentences rather than codes because they land in a report
        that a person reads once, before a test, and the cost of a
        misinterpreted code there is higher than the cost of a long line.
        """
        out: list[str] = []
        pc = self.chamber_pressure

        if self.design_ratio > 0.0 and abs(self.design_error) > MIXTURE_TOLERANCE:
            face_off = (
                abs(self.face_ratio - self.design_ratio) / self.design_ratio
                > MIXTURE_TOLERANCE
            )
            direction = "rich" if self.design_error < 0.0 else "lean"
            blame = (
                "the injector face itself: at equal pressure drop it would "
                f"deliver {self.face_ratio:.2f}, so redrilling is the lever"
                if face_off
                else (
                    f"the feed system, not the face: the face would deliver "
                    f"{self.face_ratio:.2f} at equal drop and the plumbing "
                    f"multiplies it by {self.feed_term:.2f}"
                )
            )
            out.append(
                f"O/F is {self.mixture_ratio:.2f} against a design "
                f"{self.design_ratio:.2f} "
                f"({abs(self.design_error) * 100:.0f}% {direction}). "
                f"That is {blame}."
            )

        for side, label in ((self.oxidiser, "oxidiser"), (self.fuel, "fuel")):
            stiffness = side.stiffness(pc)
            if stiffness <= 0.0:
                continue
            floor = side.floor
            # Against the engine's own band where it states one. The rule of
            # thumb is the fallback, and saying which was used matters: "under
            # 20%" is an opinion, "under the 20-30% this engine was optimised
            # to" is the config talking.
            against = (
                f"the {floor * 100:.0f}"
                + (f"-{side.ceiling * 100:.0f}" if side.ceiling > 0.0 else "")
                + "% this engine was designed to"
                if side.band[0] > 0.0
                else f"a {floor * 100:.0f}% rule of thumb"
            )
            if stiffness < min(floor, VERY_SOFT_STIFFNESS * (floor / SOFT_STIFFNESS)):
                out.append(
                    f"The {label} leg is barely metering: {stiffness * 100:.0f}% "
                    f"injector stiffness against {against}. At that authority "
                    "the feed system sets the flow and the chamber sets it "
                    "back, which is where coupled instability lives."
                )
            elif stiffness < floor:
                out.append(
                    f"The {label} leg is soft: {stiffness * 100:.0f}% injector "
                    f"stiffness against {against}."
                )
            elif side.ceiling > 0.0 and stiffness > side.ceiling:
                out.append(
                    f"The {label} leg is stiffer than designed: "
                    f"{stiffness * 100:.0f}% against {against}. Not a stability "
                    "risk, but it is tank pressure being spent at the face that "
                    "the design did not intend to spend there."
                )

        loss_ox = self.oxidiser.feed_loss(pc)
        loss_fuel = self.fuel.feed_loss(pc)
        if loss_ox > 0.0 and loss_fuel > 0.0:
            for loss, side, label in (
                (loss_ox, self.oxidiser, "oxidiser"),
                (loss_fuel, self.fuel, "fuel"),
            ):
                budget = loss + side.injector_dp
                if budget > 0.0 and loss / budget > 0.5:
                    out.append(
                        f"The {label} plumbing eats {loss / budget * 100:.0f}% of "
                        f"that leg's pressure budget before the face "
                        f"({loss / 6894.757:.0f} psi of "
                        f"{budget / 6894.757:.0f}). The line is the meter here, "
                        "not the injector."
                    )

        if self.residual > 1.0e-3:
            out.append(
                f"The flows and the injector pressure drops disagree by "
                f"{self.residual * 100:.1f}%, so this split does not describe "
                "the run it was taken from. Treat it as indicative."
            )
        return out


def balance_from(
    design: EngineDesign,
    *,
    mdot_oxidiser: float,
    mdot_fuel: float,
    density_oxidiser: float,
    density_fuel: float,
    injector_dp_oxidiser: float,
    injector_dp_fuel: float,
    chamber_pressure: float,
    supply_oxidiser: float = 0.0,
    supply_fuel: float = 0.0,
) -> MixtureBalance:
    """Assemble a balance from a solved operating point.

    ``Cd`` is recovered from the flow and the pressure drop rather than
    re-evaluated from the Reynolds model, so the identity closes on the numbers
    the solver actually produced. Re-evaluating it would make the residual
    report the difference between two ``Cd`` models instead of a real
    inconsistency, which is the one thing the residual exists to catch.
    """

    def recovered_cd(mdot: float, rho: float, area: float, dp: float) -> float:
        if area <= 0.0 or rho <= 0.0 or dp <= 0.0:
            return 0.0
        return abs(mdot) / (area * math.sqrt(2.0 * rho * dp))

    ox = SideBalance(
        propellant=design.oxidiser.propellant,
        mdot=mdot_oxidiser,
        density=density_oxidiser,
        area=design.oxidiser.area,
        cd=recovered_cd(
            mdot_oxidiser, density_oxidiser, design.oxidiser.area, injector_dp_oxidiser
        ),
        injector_dp=injector_dp_oxidiser,
        supply_pressure=supply_oxidiser,
        band=design.oxidiser.stiffness_band,
    )
    fuel = SideBalance(
        propellant=design.fuel.propellant,
        mdot=mdot_fuel,
        density=density_fuel,
        area=design.fuel.area,
        cd=recovered_cd(mdot_fuel, density_fuel, design.fuel.area, injector_dp_fuel),
        injector_dp=injector_dp_fuel,
        supply_pressure=supply_fuel,
        band=design.fuel.stiffness_band,
    )
    return MixtureBalance(
        oxidiser=ox,
        fuel=fuel,
        chamber_pressure=chamber_pressure,
        design_ratio=design.design_mixture_ratio,
    )
