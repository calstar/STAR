"""The injector as a network branch, and the engine as a network boundary.

Two objects, and the split matters.

An **injector leg** is an ordinary hydraulic component: an orifice of known area
and discharge coefficient, one per propellant, sitting at the downstream end of
each feed line. Nothing about it is special except that its area came out of a
Layer-1 optimisation rather than off a drawing.

The **engine** is not a component at all. It is a boundary condition, and a
circular one: chamber pressure depends on the flows, and the flows depend on
chamber pressure through the injector's pressure difference. The session closes
that loop each coupling step (``Session._close_chamber``), root-finding the
chamber pressure the network and the engine agree on -- the same coupled
injector-to-chamber solve EngineDesign performs, done here around a whole feed
system instead of around two pressures.

Why the loop is worth having
----------------------------
It is the reason a pressure-fed engine is stable in the large. Raise tank
pressure and flow rises, so chamber pressure rises, so the injector's pressure
difference rises by *less* than the tank did -- the engine absorbs part of every
upstream change. That is also why injector stiffness is a design rule rather
than a preference: as the injector's share of the total pressure drop falls, the
loop gain rises, and below roughly 20% the engine starts responding to its own
chamber more than to its tanks.
"""

from __future__ import annotations

import math
from dataclasses import replace
from typing import TYPE_CHECKING, Mapping

from feedtwin.comps.base import (
    FlowConditions,
    HydraulicComponent,
    InfeasibleOperatingPoint,
    Violation,
)
from feedtwin.engine.chamber import ChamberResult
from feedtwin.engine.design import EngineDesign, InjectorSide
from feedtwin.model.component import ComponentInstance

if TYPE_CHECKING:
    from feedtwin.solve.network import Network


class InjectorLeg(HydraulicComponent):
    """One propellant's path through the injector face.

    ``dp = mdot^2 / (2 rho (Cd A)^2)`` -- the orifice relation, with ``Cd``
    coming from the Reynolds-dependent model in the engine config rather than
    being a constant. That dependence is not decoration: at low flow during
    startup the discharge coefficient is materially below its high-Reynolds
    value, and an injector modelled at a fixed ``Cd`` opens too fast.

    Built from an :class:`~feedtwin.engine.design.InjectorSide` rather than from
    a component config, because the whole point of Phase 08 is that these
    numbers arrive from Layer 1 and are not retyped.
    """

    def __init__(self, instance: ComponentInstance, side: InjectorSide) -> None:
        super().__init__(instance)
        self.side = side

    @property
    def id(self) -> str:
        return self.instance.id

    def effective_area(self, mdot: float, flow: FlowConditions) -> float:
        """``Cd . A`` at this operating point [m^2].

        With an engine card it is recovered from the card's pressure drop at the
        density this leg sees, so the diagnostics and the mixture balance read
        the same injector the solve used."""
        card = self.side.card
        if card is not None:
            phi = card.capacity(abs(mdot), flow.p_upstream)
            return phi / math.sqrt(2.0 * flow.rho) if flow.rho > 0.0 else 0.0
        cd = self.side.cd_at(mdot, flow.rho, flow.mu, pressure=flow.p_upstream)
        return cd * self.side.area

    def pressure_drop(self, mdot: float, flow: FlowConditions) -> float:
        card = self.side.card
        if card is not None:
            # The card is the injector, inlet node to chamber, including the
            # discharge into the manifold the drawing's line does not model.
            #
            # A magnitude, like every other pressure_drop: total_dp puts the
            # sign on. The card's own relation is signed, and passing that
            # through signed it twice, so a leg run backwards gained pressure
            # and the network had no root whenever the chamber closure tried a
            # chamber above that leg's tank.
            return card.pressure_drop(abs(mdot), flow.p_upstream)
        magnitude = abs(mdot)
        if magnitude == 0.0:
            return 0.0
        area = self.effective_area(mdot, flow)
        if area <= 0.0 or flow.rho <= 0.0:
            raise InfeasibleOperatingPoint(self.id, mdot, flow.p_upstream)
        return magnitude * magnitude / (2.0 * flow.rho * area * area)

    def off_card(self, mdot: float, flow: FlowConditions) -> bool:
        """True when this lookup is outside the hull the leg's card was fitted to.

        The card's table clamps outside its box, which keeps the number
        physical and says nothing; the hull is how a trace learns it left what
        the card knows (:func:`fold_injectors`). No card, nothing to be off.
        """
        card = self.side.card
        if card is None or mdot == 0.0:
            return False
        return not card.covers(mdot, flow.p_upstream)

    def diagnostics(self, mdot: float, flow: FlowConditions) -> dict[str, float]:
        area = self.effective_area(mdot, flow)
        velocity = abs(mdot) / (flow.rho * self.side.area) if flow.rho > 0.0 else 0.0
        return {
            "area_geometric": self.side.area,
            "area_effective": area,
            "Cd": area / self.side.area if self.side.area > 0.0 else 0.0,
            "velocity": velocity,
            "Re": (
                flow.rho * velocity * self.side.hydraulic_diameter / flow.mu
                if flow.mu > 0.0
                else 0.0
            ),
            "elements": float(self.side.element_count),
            "dp": self.pressure_drop(mdot, flow),
            "extrapolated": 1.0 if self.off_card(mdot, flow) else 0.0,
        }

    def check(self) -> list[Violation]:
        out: list[Violation] = []
        if self.side.area <= 0.0:
            out.append(
                Violation(self.id, "area", "injector area is zero and cannot flow")
            )
        if self.side.hydraulic_diameter <= 0.0:
            out.append(
                Violation(
                    self.id,
                    "hydraulic_diameter",
                    "no hydraulic diameter, so the Reynolds-dependent Cd is "
                    "pinned at its floor",
                    severity="warning",
                )
            )
        return out


def injector_legs(
    design: EngineDesign,
) -> tuple[InjectorLeg, InjectorLeg]:
    """Build the two injector branches from an imported engine design.

    Returns ``(oxidiser, fuel)``. The component ids are derived from the design
    name so a report can trace a branch back to the config it came from.
    """
    from feedtwin.model.param import Param, Provenance

    def leg(side: InjectorSide, tag: str) -> InjectorLeg:
        # A nominal bore for reporting: the single round hole of the same total
        # area. It is not used by the physics -- the area is -- but a diagnostic
        # that says "3.0 mm" is easier to sanity-check than one that says
        # "7.0e-6 m^2".
        bore = math.sqrt(4.0 * side.area / math.pi)
        instance = ComponentInstance.build(
            f"INJ-{tag}",
            "orifice",
            {
                "bore": Param(bore, "m", Provenance.MANUFACTURER, design.name),
                "pipe_bore": Param(bore, "m", Provenance.MANUFACTURER, design.name),
                "Cd": Param(
                    side.discharge.cd_inf, "-", Provenance.MANUFACTURER, design.name
                ),
            },
        )
        return InjectorLeg(instance, side)

    return leg(design.oxidiser, "OX"), leg(design.fuel, "FUEL")


def fold_injectors(
    chamber: ChamberResult,
    network: Network,
    ports: Mapping[str, str],
    flows: Mapping[str, float],
    pressures: Mapping[str, float],
) -> ChamberResult:
    """The chamber's answer, flagged extrapolated if either injector leg's card
    lookup was off its hull.

    A step's ``extrapolated`` flag is the chamber's, which only ever asked the
    chamber table; an injector card read below its sampled inlet pressures (a
    vent-down, a low-pressure firing) was clamped and never counted. The flag
    means "outside what the card knows", so the injectors fold into it.
    """
    if chamber.combustion.extrapolated:
        return chamber
    for side in ("oxidiser", "fuel"):
        branch_id = ports.get(side, "")
        branch = network.branches.get(branch_id) if branch_id else None
        if branch is None or not isinstance(branch.component, InjectorLeg):
            continue
        mdot = flows.get(branch_id, 0.0)
        p_inlet = pressures.get(branch.upstream)
        if mdot <= 0.0 or p_inlet is None:
            continue
        if branch.component.off_card(
            mdot, FlowConditions(rho=0.0, mu=0.0, p_upstream=p_inlet)
        ):
            return replace(
                chamber, combustion=replace(chamber.combustion, extrapolated=True)
            )
    return chamber
