"""Two tanks on one helium press manifold, stepped finer than their press path.

Every LE4 helium burn plotted a 0.5-0.8 s tank-pressure sawtooth, 15-30 psi
deep, with gas running backwards from one tank to the other through the shared
manifold -- and GN2 runs were smooth. It was the coupling step. The session
solved the network once every 25 ms and held each flow for the whole step; the
only time constant it stepped under was the regulator's (~27 ms), but two
ullages trade gas through nothing but their solenoids, which on helium is a few
milliseconds. A solve that found a tank a tenth of a psi above the manifold
sent its gas out for the full 25 ms while the liquid drained, the tank fell,
the other dumped into it, and the pair handed the error back and forth. At a
2 ms step it was gone, and the mean thrust was 170 N higher.

``Session._press_path_timescale`` gives the guard that constant. These check
it is what it says, and that a stand like LE4's no longer rings.
"""

from __future__ import annotations

from typing import Any

import pytest
from test_pid_drawn_freely import P, _le4_like, _machine, line, node

from feedtwin.pid import read_diagram
from feedtwin.session import Session, assemble_model
from feedtwin.session import core as C
from feedtwin.session.gauge import psig
from feedtwin.session.statemachine import bind


def _helium_stand() -> Session:
    """LE4's layout: a helium bottle, a regulator, one manifold to two
    press solenoids, mains into a fixed-pressure engine."""
    payload: Any = _le4_like()
    for n in payload["nodes"]:
        if n["id"] == "KB":
            n["data"]["fluidType"] = "helium"
            n["data"]["params"] = {
                "pressure": P(4500, "psi"),
                "temperature": P(293, "K"),
                "volume": P(4.7, "L"),
            }
    payload["nodes"].append(
        node(
            "RG",
            "PR",
            "DPR_HP",
            params={
                "setpoint": P(560, "psi"),
                "Cv": P(0.8, "Cv"),
                "bore": P(7.75, "mm"),
                "flow_droop": P(20, "psi"),
                "rated_flow": P(0.02, "kg/s"),
            },
        )
    )
    payload["edges"] = [e for e in payload["edges"] if e["id"] != "kb-mf"] + [
        line("kb-rg", "KB", "RG", to_port="l"),
        line("rg-mf", "RG", "MF", from_port="r"),
    ]
    model = assemble_model(read_diagram(payload, name="he manifold"), diagram_id="t")
    machine = _machine()
    labels = {
        n.id: n.label for n in model.diagram.nodes if n.id in model.built.actuators
    }
    session = Session(
        model, machine, bind(machine, labels, roles=model.built.valve_roles)
    )
    session.prime(tank_psi=575.0, copv_psi=4500.0, state="Ready", hold_s=1.0)
    return session


def _burn(session: Session, seconds: float = 2.0) -> list[float]:
    for symbol in session.model.built.actuators:
        session.set_valve(symbol, True)
    ullage = session.model.built.tanks["OT"].ullage
    trace = []
    while session.t < seconds:
        trace.append(psig(session.step(0.02).pressures[ullage]))
    return trace[5:]  # past the mains opening


def _roughness(trace: list[float]) -> float:
    """Mean |second difference| [psi]: zero for a straight line."""
    return sum(
        abs(trace[i + 1] - 2 * trace[i] + trace[i - 1])
        for i in range(1, len(trace) - 1)
    ) / (len(trace) - 2)


def test_a_draining_helium_tank_is_stepped_under_its_press_path() -> None:
    session = _helium_stand()
    _burn(session, 0.3)
    regulator_only = float("inf")
    for branch in session.model.built.network.branches.values():
        comp = branch.component
        if "Regulator" in type(comp).__name__:
            slope = comp.p["flow_droop"] / comp.p["rated_flow"]
            for sim in session.tanks.values():
                regulator_only = min(
                    regulator_only, sim.state.ullage.mass / sim.pressure * slope
                )
    tau = session._coupling_timescale({}, 0.02)
    assert (
        0.0 < tau < regulator_only / 3
    ), "the press path is the stiffer loop on helium"


def test_a_tank_at_rest_asks_for_nothing() -> None:
    """No liquid leaving, no constant: a pad hold is not stepped at the
    solenoids' zero-flow slope."""
    session = _helium_stand()
    session.step(0.02)
    sim = session.tanks["OT"]
    assert session._press_path_timescale(sim, 1.0, {}) == float("inf")


def test_two_helium_tanks_on_one_manifold_do_not_ring(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    smooth = _roughness(_burn(_helium_stand()))
    assert smooth < 0.2

    # Either guard is enough on its own. The ullage storage closure
    # (`Session._ullage_storage`) solves the press path inside the step, so
    # without the press-path constant the pair still does not ring...
    monkeypatch.setattr(C.Session, "_press_path_timescale", lambda *a: float("inf"))
    assert _roughness(_burn(_helium_stand())) < 0.2

    # ...and the test can fail: without both, the pair rings.
    monkeypatch.setattr(C.Session, "_ullage_storage", lambda *a: {})
    ringing = _roughness(_burn(_helium_stand()))
    assert ringing > 1.0


def test_a_tank_draining_onto_a_vented_manifold_asks_for_nothing() -> None:
    """Engine Abort with the fuel loaded and the LOX tank empty (the whole LOX
    chill window): the fuel drains by gravity through its open main, and its
    press path is the manifold, vented through the empty LOX tank. That
    "supply" sits at atmosphere with the tank, so the band was met and the
    drain over a step beat a tenth of it: 0.27 ms couplings, 33-79 per 20 ms
    step, the panel 40x slower than real time. A vent one node further on
    carries nothing across a regulated supply."""
    from test_ignore_gse import TABLES, _ids, _session

    if not TABLES.is_dir():
        pytest.skip("no state machine tables")
    ids = _ids()
    session = _session(True)
    session.state = "Fuel Fill"
    for _ in range(40):
        session.step(0.5)
    fuel = session.tanks[ids["Eth-Tank"]]
    assert fuel.state.liquid_mass > 4.0
    assert session.tanks[ids["LOX-Tank"]].state.liquid_mass == 0.0
    session.command_state("Engine Abort")
    start = fuel.state.liquid_mass
    most = 0
    worst = 0.0
    for _ in range(10):
        session.step(0.02)
        most = max(most, session.solver_log[-1].couplings)
        worst = max(worst, abs(psig(fuel.pressure)))
    assert start - fuel.state.liquid_mass > 0.01, "the fuel drains"
    assert abs(psig(fuel.pressure)) < 0.1, "at atmosphere"
    assert most <= 2, f"{most} coupling steps in one 20 ms step"
    # One coupling a step leaves a two-step ring of one step's drain over the
    # ullage, -0.001/+0.013 psig on LE4: bounded, and under the panel's tenth of
    # a psi. It must not grow.
    assert worst < 0.05, f"the fuel ullage rang {worst:.3f} psi off the air"
