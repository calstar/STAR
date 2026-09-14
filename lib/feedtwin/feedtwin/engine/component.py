"""The injector as a network branch, and the engine as a network boundary.

Two objects, and the split matters.

An **injector leg** is an ordinary hydraulic component: an orifice of known area
and discharge coefficient, one per propellant, sitting at the downstream end of
each feed line. Nothing about it is special except that its area came out of a
Layer-1 optimisation rather than off a drawing.

The **engine** is not a component at all. It is a boundary condition, and a
circular one: chamber pressure depends on the flows, and the flows depend on
chamber pressure through the injector's pressure difference. That loop is closed
by :class:`EngineCoupling`, which iterates the network solve to a self-consistent
chamber pressure -- the same coupled injector-to-chamber solve EngineDesign
performs, done here around a whole feed system instead of around two pressures.

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
from dataclasses import dataclass, field

from feedtwin.comps.base import (
    FlowConditions,
    HydraulicComponent,
    InfeasibleOperatingPoint,
    Violation,
)
from feedtwin.engine.chamber import Chamber, ChamberResult
from feedtwin.engine.design import EngineDesign, InjectorSide
from feedtwin.model.component import ComponentInstance


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
        """``Cd . A`` at this operating point [m^2]."""
        cd = self.side.cd_at(mdot, flow.rho, flow.mu, pressure=flow.p_upstream)
        return cd * self.side.area

    def pressure_drop(self, mdot: float, flow: FlowConditions) -> float:
        magnitude = abs(mdot)
        if magnitude == 0.0:
            return 0.0
        area = self.effective_area(mdot, flow)
        if area <= 0.0 or flow.rho <= 0.0:
            raise InfeasibleOperatingPoint(self.id, mdot, flow.p_upstream)
        return magnitude * magnitude / (2.0 * flow.rho * area * area)

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


@dataclass(slots=True)
class EngineCoupling:
    """Closes the chamber-pressure loop around a network solve.

    Args:
        chamber: The chamber physics.
        node: Network node representing the chamber. Its pressure is *set* by
            this coupling, so it must be a fixed-pressure node.
        oxidiser_branch: Branch carrying oxidiser into the chamber node.
        fuel_branch: Branch carrying fuel into the chamber node.
        relaxation: Under-relaxation for the first step and the fallback when
            the secant slope is unusable, in ``(0, 1]``. Plain relaxation alone
            converges linearly and needs twenty-odd network solves per
            right-hand-side evaluation, which an implicit integrator calling the
            RHS ten thousand times cannot afford.
        tolerance: Convergence tolerance on chamber pressure, **relative**.
            Absolute would mean something different on a 20 bar chamber and a
            200 bar one.
        max_iterations: Cap. Exceeding it is reported, not raised -- a
            non-converging chamber loop is a design finding, usually an
            injector too soft for its feed system, and the last iterate says
            more about it than an exception would.
    """

    chamber: Chamber
    node: str
    oxidiser_branch: str
    fuel_branch: str
    relaxation: float = 0.5
    tolerance: float = 1.0e-5
    max_iterations: int = 40
    result: ChamberResult | None = field(default=None, init=False)
    iterations: int = field(default=0, init=False)
    converged: bool = field(default=True, init=False)

    def evaluate(self, mdot_oxidiser: float, mdot_fuel: float) -> float:
        """Chamber pressure implied by these flows. One evaluation of ``g``."""
        self.result = self.chamber.evaluate(mdot_oxidiser, mdot_fuel)
        return self.result.pressure

    def update(self, mdot_oxidiser: float, mdot_fuel: float, guess: float) -> float:
        """One relaxed step. Kept for direct use and as the secant's fallback."""
        target = self.evaluate(mdot_oxidiser, mdot_fuel)
        return guess + self.relaxation * (target - guess)

    def outputs(self) -> dict[str, float]:
        """Everything a firing trace wants, per sample."""
        if self.result is None:
            return {}
        r = self.result
        return {
            "chamber_pressure": r.pressure,
            "mdot_total": r.mdot_total,
            "mdot_oxidiser": r.mdot_oxidiser,
            "mdot_fuel": r.mdot_fuel,
            "mixture_ratio": r.mixture_ratio,
            "cstar": r.combustion.cstar,
            "chamber_temperature": r.combustion.temperature,
            "gamma": r.combustion.gamma,
            "thrust": r.thrust,
            "specific_impulse": r.specific_impulse,
            "loop_iterations": float(self.iterations),
            "loop_converged": 1.0 if self.converged else 0.0,
            "outside_combustion_table": 1.0 if r.combustion.extrapolated else 0.0,
        }


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
