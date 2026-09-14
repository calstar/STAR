"""Diagnostics on a solved model: what set the mixture ratio, and how hard.

A run produces flows and pressures. Turning those into a *finding* takes one
more step, and it is the step that decides whether the tool is useful to
somebody standing at a stand or is just a nicer way to print numbers.

The one worth having is the mixture-ratio split -- see
:mod:`feedtwin.engine.balance` for why it is exact. This module's job is only
to dig the six numbers it needs out of a solved network without the physics
having to know what a P&ID is.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping

from feedtwin.engine.balance import MixtureBalance, balance_from
from feedtwin.solve.network import Network
from feedtwin.solve.steady import SteadyResult

from backend.assembly import Model


@dataclass(frozen=True, slots=True)
class LegTrace:
    """One propellant's path from its supply to the face, in pressure."""

    supply_node: str
    supply_pressure: float
    face_pressure: float
    injector_dp: float
    density: float
    mdot: float


def _pressure(result: SteadyResult, net: Network, node: str) -> float:
    """Pressure at a node, solved or fixed.

    A fixed node's pressure is a boundary the solve never had to find, so it is
    not in ``result.pressures`` -- the chamber and every tank port land here.
    """
    solved = result.pressures.get(node)
    if solved is not None:
        return float(solved)
    known = net.nodes.get(node)
    return float(getattr(known, "pressure", 0.0) or 0.0)


def _supply_of(
    net: Network, result: SteadyResult, face: str, chamber: str
) -> tuple[str, float]:
    """Walk upstream from the injector face to the pressure that feeds it.

    Breadth-first against the direction of flow, stopping at the first node the
    solve treated as fixed -- a tank outlet, a K-bottle, a dewar. Done as a walk
    rather than by looking up "the tank whose fluid matches" because a stand can
    have two tanks of the same propellant, a common run tank feeding both legs,
    or a purge cross-tie, and the walk is right in all three where the lookup
    is right only in the simple one.

    Returns ``("", 0.0)`` when no fixed node is reachable, which is a legitimate
    state for a leg fed from a free junction; the caller reports no feed loss
    rather than a wrong one.
    """
    fixed = set(net.fixed_nodes)
    seen = {face, chamber}
    frontier = [face]
    while frontier:
        nxt: list[str] = []
        for node in frontier:
            for branch in net.branches.values():
                if branch.downstream != node or branch.upstream in seen:
                    continue
                upstream = branch.upstream
                seen.add(upstream)
                if upstream in fixed:
                    return upstream, _pressure(result, net, upstream)
                nxt.append(upstream)
        frontier = nxt
    return "", 0.0


def _leg(
    model: Model,
    result: SteadyResult,
    signals: Mapping[str, float],
    branch_id: str,
    chamber: str,
) -> LegTrace | None:
    """Everything the balance needs about one injector leg."""
    net = model.built.network
    branch = net.branches.get(branch_id)
    if branch is None:
        return None

    face = branch.upstream if branch.downstream == chamber else branch.downstream
    face_p = _pressure(result, net, face)
    chamber_p = _pressure(result, net, chamber)
    supply_node, supply_p = _supply_of(net, result, face, chamber)

    # Density at the face, from the same property call the solve used, so the
    # recovered Cd is consistent with the flow that produced it.
    density = net.conditions(face, face_p, dict(signals)).rho

    return LegTrace(
        supply_node=supply_node,
        supply_pressure=supply_p,
        face_pressure=face_p,
        injector_dp=face_p - chamber_p,
        density=density,
        mdot=abs(float(result.flows.get(branch_id, 0.0))),
    )


def mixture_balance(
    model: Model, result: SteadyResult, signals: Mapping[str, float]
) -> MixtureBalance | None:
    """Split the delivered O/F into the face's half and the stand's half.

    ``None`` when the model has no engine, or when the drawing gave the engine
    only one leg -- half an injector cannot be balanced, and returning a
    one-sided number would read as an answer.
    """
    ports = model.built.engine_ports
    engine = model.engine
    if engine is None or "chamber" not in ports:
        return None
    if "oxidiser" not in ports or "fuel" not in ports:
        return None

    chamber = ports["chamber"]
    ox = _leg(model, result, signals, ports["oxidiser"], chamber)
    fuel = _leg(model, result, signals, ports["fuel"], chamber)
    if ox is None or fuel is None:
        return None
    if ox.mdot <= 0.0 or fuel.mdot <= 0.0:
        return None

    return balance_from(
        engine,
        mdot_oxidiser=ox.mdot,
        mdot_fuel=fuel.mdot,
        density_oxidiser=ox.density,
        density_fuel=fuel.density,
        injector_dp_oxidiser=ox.injector_dp,
        injector_dp_fuel=fuel.injector_dp,
        chamber_pressure=_pressure(result, model.built.network, chamber),
        supply_oxidiser=ox.supply_pressure,
        supply_fuel=fuel.supply_pressure,
    )
