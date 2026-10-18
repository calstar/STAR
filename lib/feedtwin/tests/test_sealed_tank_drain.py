"""A sealed tank with a drain open: it pulls a vacuum and stops.

The operator stopped a fuel fill (the vent shuts in Armed) with a line still
open below the liquid, and the fuel tank emptied slowly while the solver tab's
clamp energy climbed. Two faults, each enough on its own:

* The ullage's floor (``TankSim._settled``) held the pressurant at
  atmosphere's worth *in the ullage's present volume*, so as the liquid left,
  the floor put air in to keep it there. A tank cannot be refilled with air
  through a shut vent: it goes below atmosphere until the head can no longer
  push liquid out. A vented tank keeps the floor -- on a LOX load it stands in
  for the boil-off the built-in chill vents off the books.
* The network solve judged every branch's pressure residual against the
  highest pressure anywhere on the stand. With a 6,000 psi K-bottle drawn, a
  branch could sit half a psi off its relation and report converged, so a
  drain driven by 0.45 psi of head never left the solve's 1 g/s starting
  guess.
"""

from __future__ import annotations

from dataclasses import replace

import json
from pathlib import Path

import pytest

from feedtwin.comps import build_component
from feedtwin.model import ComponentInstance, Param, Provenance
from feedtwin.pid import read_diagram
from feedtwin.props import Fluid
from feedtwin.session import assemble_model, load_machine
from feedtwin.session.burn import open_session
from feedtwin.session.core import AMBIENT, TankSim
from feedtwin.session.gauge import from_psig
from feedtwin.solve import Network, solve_steady
from feedtwin.vessels import CylindricalTank, Tank

M = Provenance.MANUFACTURER
HERE = Path(__file__).resolve().parent
DRAWING = HERE / "fixtures" / "le4_rocket_and_gse.json"
TABLES = HERE.parents[2] / "feed-twin" / "backend" / "statemachines"


def _full_tank_at_atmosphere() -> TankSim:
    tank = Tank(
        Fluid("ethanol"),
        Fluid("nitrogen"),
        CylindricalTank(diameter=0.152, barrel_length=0.40),
    )
    state = tank.initial_state(
        pressure=from_psig(0.0),
        liquid_mass=5.5,
        liquid_temperature=293.15,
        gas_temperature=293.15,
    )
    return TankSim(
        id="T", label="T", tank=tank, state=state, ullage_node="u", outlet_node="o"
    )


def test_a_sealed_tank_draining_goes_below_atmosphere_without_gaining_gas() -> None:
    sim = _full_tank_at_atmosphere()
    sim.sealed = True
    air = sim.state.ullage.mass
    for _ in range(50):
        sim.advance(
            0.02,
            mdot_liquid_out=0.05,
            mdot_gas_in=0.0,
            mdot_gas_out=0.0,
            enthalpy_gas_in=sim.tank.gas_enthalpy(sim.state),
        )
    assert sim.state.ullage.mass == pytest.approx(air, rel=1e-12), "no air in"
    assert sim.pressure < AMBIENT - 0.05 * 6894.76, "a vacuum, not atmosphere"
    assert sim.fixed_kg == pytest.approx(0.0, abs=1e-12)
    assert sim.fixed_J == pytest.approx(0.0, abs=1e-6)


def test_a_vent_still_cannot_pull_a_tank_below_atmosphere() -> None:
    """The floor's own job: a vent asked for more gas than there is above
    atmosphere leaves the tank *at* atmosphere -- at the gas's own (expanded)
    temperature, not the wall's -- and what that takes is air the vent let in,
    booked as inflow, not as a clamp."""
    sim = _full_tank_at_atmosphere()
    sim.state = replace(
        sim.state, ullage=replace(sim.state.ullage, mass=sim.state.ullage.mass * 3.0)
    )
    sim.advance(
        0.02,
        mdot_liquid_out=0.0,
        mdot_gas_in=0.0,
        mdot_gas_out=sim.state.ullage.mass / 0.02,
        enthalpy_gas_in=sim.tank.gas_enthalpy(sim.state),
        vent_fraction=1.0,
    )
    assert sim.pressure == pytest.approx(AMBIENT, rel=1e-4)
    assert sim.vent_drawn_kg > 0.0
    assert sim.fixed_kg == pytest.approx(0.0, abs=1e-9), "not a clamp"


def _drain_network(with_bottle: bool) -> Network:
    """A drain valve between a tank outlet 0.45 psi above atmosphere and the
    air -- and, beside it, a 6,000 psi K-bottle line that has nothing to do
    with it."""
    valve = build_component(
        ComponentInstance.build(
            "drain",
            "valve",
            {"Cv": Param(0.8, "Cv", M, "datasheet"), "bore": Param(0.25, "in", M, "")},
        )
    )
    net = Network()
    head = 0.45 * 6894.76
    net.add_node("outlet", "ethanol", 293.15, pressure=AMBIENT + head)
    net.add_node("air", "ethanol", 293.15, pressure=AMBIENT)
    net.add_branch("drain", valve, "outlet", "air")  # type: ignore[arg-type]
    if with_bottle:
        line = build_component(
            ComponentInstance.build(
                "kline",
                "valve",
                {
                    "Cv": Param(0.1, "Cv", M, "datasheet"),
                    "bore": Param(0.25, "in", M, ""),
                },
            )
        )
        net.add_node("bottle", "nitrogen", 293.15, pressure=from_psig(6000.0))
        net.add_node("reg", "nitrogen", 293.15, pressure=from_psig(5990.0))
        net.add_branch("kline", line, "bottle", "reg")  # type: ignore[arg-type]
    return net


def test_a_low_pressure_branch_is_solved_beside_a_high_pressure_one() -> None:
    alone = solve_steady(_drain_network(False), tol=1e-10).flows["drain"]
    assert alone > 0.01, "0.45 psi through a Cv 0.8 valve is grams a second"
    beside = solve_steady(_drain_network(True), tol=1e-4)
    assert beside.converged
    # Held to a percent of its own pressure: within a fifth of the flow, where
    # the stand-wide scale left it at the 1 g/s it started from.
    assert beside.flows["drain"] == pytest.approx(alone, rel=0.2)


@pytest.mark.skipif(
    not (DRAWING.exists() and TABLES.is_dir()), reason="LE4 fixture or tables absent"
)
def test_a_full_fuel_tank_with_the_vent_shut_holds_against_an_open_drain() -> None:
    """The operator's case on LE4 (6): fill the fuel tank, stop the fill (Armed
    shuts the vent), and a drain teed into the tank's bottom port is open. The
    tank pulls its head's worth of vacuum and keeps its fuel; the old floor
    let it drain at 129 g/s and booked the air it made as clamp energy."""
    payload = json.loads(DRAWING.read_text())
    ids = {n["data"]["label"]: n["id"] for n in payload["nodes"]}
    tank, qd = ids["Eth-Tank"], ids["QD-FFB"]
    edge = next(
        e
        for e in payload["edges"]
        if e["source"] == tank and e.get("sourceHandle") == "b2"
    )
    assert edge["target"] == qd
    edge.update(target="drain_tee", targetHandle="t")
    payload["nodes"] += [
        {
            "id": "drain_tee",
            "type": "JUNCTION",
            "position": {"x": 0, "y": 0},
            "data": {"componentType": "JUNCTION", "label": "drain_tee"},
        },
        {
            "id": "drain",
            "type": "MAN",
            "position": {"x": 40, "y": 0},
            "data": {"componentType": "MAN", "label": "FD-MAN", "options": {}},
        },
    ]
    payload["edges"] += [
        {"id": "t-qd", "source": "drain_tee", "sourceHandle": "b", "target": qd},
        {"id": "t-dr", "source": "drain_tee", "sourceHandle": "r", "target": "drain"},
    ]
    for edge in payload["edges"][-2:]:
        edge.update(targetHandle="l", type="smoothstep", data={})
    model = assemble_model(read_diagram(payload, name="drain"), diagram_id="drain")
    session = open_session(model, load_machine(tables=TABLES))
    fuel = session.tanks[tank]
    for state, seconds in (("Armed", 1.0), ("Fuel Fill", 12.0), ("Armed", 1.0)):
        session.command_state(state)
        for _ in range(int(seconds / 0.5)):
            session.step(0.5)
    full = fuel.state.liquid_mass
    assert full > 5.0, "the fuel tank was filled"
    assert fuel.pressure == pytest.approx(AMBIENT, abs=0.5 * 6894.76)
    air, fixed = fuel.state.ullage.mass, fuel.fixed_J

    session.set_valve("drain", True)
    for _ in range(20):
        session.step(0.5)
    assert fuel.sealed
    assert full - fuel.state.liquid_mass < 0.05, "it holds, bar a few grams"
    assert fuel.state.ullage.mass == pytest.approx(air, rel=1e-6), "no air made"
    assert fuel.fixed_J - fixed == pytest.approx(0.0, abs=1.0)
    head = AMBIENT - fuel.pressure
    assert 0.2 * 6894.76 < head < 0.8 * 6894.76, "a column's worth of vacuum"
    # And at rest, not sloshing: the shut-in outlet is closed implicitly
    # (Session._close_outlet). Held at its start-of-step pressure it swung the
    # drain ~30 g/s each way and the tank refused the half that came back.
    assert fuel.refused_kg < 1e-4
    assert [f.to_dict() for f in session.watcher.flags] == []


@pytest.mark.skipif(
    not (DRAWING.exists() and TABLES.is_dir()), reason="LE4 fixture or tables absent"
)
def test_a_dry_transfer_tank_is_a_tee_the_fill_line_drains_through() -> None:
    """LE4 (6)'s unsized tee joins the fill line and the dump into the cart
    tank's outlet node. With both hand valves held open the transfer tank
    pushes into the fuel tank, then dumps itself dry -- and the fuel tank's
    pressure must then go out through the same tee. Cutting every branch on the
    dry tank's outlet froze it at 45 psig with the dump open."""
    payload = json.loads(DRAWING.read_text())
    ids = {n["data"]["label"]: n["id"] for n in payload["nodes"]}
    model = assemble_model(read_diagram(payload, name="dump"), diagram_id="dump")
    session = open_session(model, load_machine(tables=TABLES))
    fuel, cart = (
        session.tanks[ids["Eth-Tank"]],
        session.tanks[ids["Fuel Transfer Tank"]],
    )
    for state, seconds in (("Armed", 1.0), ("Fuel Fill", 10.0), ("Armed", 2.0)):
        session.command_state(state)
        for _ in range(int(seconds / 0.5)):
            session.step(0.5)
    session.set_valve(ids["FF-MAN-Output"], True)
    session.set_valve(ids["FF-MAN-Dump"], True)
    for _ in range(60):
        session.step(0.5)
    assert cart.state.liquid_mass < 1e-3, "the dump emptied the cart tank"
    assert fuel.pressure < AMBIENT + 0.5 * 6894.76, "and then the fuel tank"
    assert fuel.state.liquid_mass > 5.0, "down to its head, not drained"
    assert not [f for f in session.watcher.flags if f.check == "held_open"]
