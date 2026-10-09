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
