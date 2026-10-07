"""The opt-in full-network recorder (``Probes(network=True)``).

Two claims to hold it to. Off, a burn's trace is exactly what it always was, and
on, recording changes no physics: every probe column is bit-for-bit the same.
And the ladder it records is one solve's: along each side's path the rungs
telescope to the first node minus the last, the path really is contiguous from
a bottle to the chamber, and every rung's drop is what its own component gives
at the flow recorded beside it -- which is the check that flows, pressures and
orientation were read off the same solve and the same way round.
"""

from __future__ import annotations

import json
from dataclasses import fields, replace
from pathlib import Path

import pytest

from feedtwin.comps import conditions_from_fluid
from feedtwin.pid import read_diagram
from feedtwin.session import PSI, assemble_model, load_machine
from feedtwin.session.burn import (
    BurnPlan,
    BurnTrace,
    burn,
    burn_setup,
    find_probes,
    network_record,
    open_session,
    prime_at_t0,
    run_burn,
)

STAR = Path(__file__).resolve().parents[3]
STAND = STAR / "feed-twin" / "backend" / "diagrams" / "ethalox_stand.json"
TABLES = STAR / "feed-twin" / "backend" / "statemachines"
ENGINE = STAR / "EngineDesign" / "configs" / "ethalox_doublet_7000N.yaml"
CEA = STAR / "EngineDesign" / "output" / "cache" / "cea_cache_LOX_Ethanol_3D.npz"

pytestmark = pytest.mark.skipif(
    not (STAND.exists() and TABLES.is_dir() and ENGINE.exists() and CEA.exists()),
    reason="stand drawing, tables, engine config or CEA table absent",
)

PLAN = BurnPlan(
    tank_psi=550.0, loads={"OXT": 6.0, "FUT": 4.0}, settle=False, lead_in_s=0.1,
    horizon_s=0.3,
)  # fmt: skip


def _session(flip: tuple[str, ...] = (), **setup):  # type: ignore[no-untyped-def]
    """A session on the stand; ``flip`` names lines to draw the other way round."""
    import yaml

    from feedtwin.engine.importer import engine_from_config

    payload = json.loads(STAND.read_text())
    for edge in payload["edges"]:
        if edge["id"] in flip:
            edge["source"], edge["target"] = edge["target"], edge["source"]
    diagram = read_diagram(payload, name="ethalox_stand")
    design = engine_from_config(yaml.safe_load(ENGINE.read_text()), name="7000N")
    model = assemble_model(
        diagram, diagram_id="ethalox_stand.json", engine=design, cea_cache=str(CEA)
    )
    return open_session(model, load_machine(tables=TABLES), setup=burn_setup(**setup))


def _burn(network: bool, flip: tuple[str, ...] = (), **setup):  # type: ignore[no-untyped-def]
    session = _session(flip, **setup)
    prime_at_t0(session, PLAN)
    trace = BurnTrace(probes=replace(find_probes(session), network=network))
    trace.end = burn(session, PLAN, trace.recorder(session))
    return session, trace


#: The tight numerics Layer X burns with, so a rung's drop can be checked against
#: its own component to a few hundredths of a psi.
TIGHT = {
    "network_tolerance": 1.0e-7,
    "chamber_tolerance_psi": 0.02,
}


@pytest.fixture(scope="module")
def recorded():  # type: ignore[no-untyped-def]
    return _burn(True, **TIGHT)


def test_off_is_the_old_trace_and_on_changes_no_physics() -> None:
    _, off = _burn(False)
    _, on = _burn(True)
    assert off.network is None
    assert network_record(off)["available"] is False
    assert on.network is not None
    for f in fields(BurnTrace):
        if f.name in ("network", "end", "probes"):
            continue
        assert getattr(on, f.name) == getattr(off, f.name), f.name
    assert on.end is not None and off.end is not None
    assert (on.end.depleted_s, on.end.tank, on.end.steps, on.end.failed_steps) == (
        off.end.depleted_s,
        off.end.tank,
        off.end.steps,
        off.end.failed_steps,
    )


def test_run_burn_records_the_network_only_when_asked() -> None:
    plan = BurnPlan(
        tank_psi=550.0, loads={"OXT": 6.0, "FUT": 4.0}, settle=False, lead_in_s=0.05,
        horizon_s=0.05,
    )  # fmt: skip
    off = run_burn(_session(), plan)
    on = run_burn(_session(), plan, network=True)
    assert off.network is None and not off.probes.network
    assert on.network is not None and on.probes.network
    assert network_record(on)["t"] == on.t
    assert on.pressure == off.pressure and on.tank == off.tank


def test_each_path_runs_bottle_to_chamber_and_telescopes(recorded) -> None:  # type: ignore[no-untyped-def]
    session, trace = recorded
    rec = network_record(trace)
    nodes, branches, paths = rec["nodes"], rec["branches"], rec["paths"]
    assert set(paths) == {"ox", "fuel"}
    assert rec["t"] == trace.t
    n = len(trace.t)
    for side, path in paths.items():
        first, last = branches[path[0]]["from"], branches[path[-1]]["to"]
        assert nodes[first]["kind"] == "bottle", side
        assert nodes[last]["kind"] == "chamber", side
        kinds = [branches[e]["kind"] for e in path]
        assert "regulator" in kinds and kinds.count("tank_head") == 1, kinds
        assert kinds[-1] == "injector", kinds
        for here, there in zip(path, path[1:]):
            assert branches[here]["to"] == branches[there]["from"], (here, there)
        liquid = path[path.index(next(e for e in path if ".head" in e)) :]
        assert all(branches[e]["side"] == side for e in liquid), side
        for k in range(n):
            rungs = sum(branches[e]["dp_psi"][k] for e in path)
            ends = nodes[first]["p_psia"][k] - nodes[last]["p_psia"][k]
            assert rungs == pytest.approx(ends, abs=1e-9), (side, k)
        for column in (nodes[first]["p_psia"], branches[path[0]]["mdot"]):
            assert len(column) == n


def test_every_rung_is_its_own_component_at_the_recorded_flow(recorded) -> None:  # type: ignore[no-untyped-def]
    """The drop recorded across a line or valve is the component's own loss at
    the flow recorded beside it, priced at the upstream node of the same solve.
    Reading a vessel node's post-step state instead, or a flow the wrong way
    round, fails here.

    The recorded temperature is the step's enthalpy walk, which runs *after* its
    solve: the solve priced gas at the previous walk's temperature. So samples
    where a gas node is still cooling fast (the first 0.1 s after Fire, 10-25 K a
    step) are left out; elsewhere the two agree to ~0.1 %."""
    session, trace = recorded
    net = session.model.built.network
    rec = network_record(trace)
    branches = rec["branches"]
    checked = 0
    firing = [k for k, f in enumerate(trace.firing) if f and trace.converged[k]]
    assert firing
    for side, path in rec["paths"].items():
        for element in path:
            info = branches[element]
            if info["kind"] not in ("line", "solenoid", "valve"):
                continue
            component = net.branches[element].component
            for k in firing[1:]:
                temperatures = rec["nodes"][info["from"]]["T_K"]
                if abs(temperatures[k] - temperatures[k - 1]) > 3.0:
                    continue
                upstream = net.nodes[info["from"]]
                # The upstream state as the step recorded it, and the valve
                # positions the step solved with.
                p_up = rec["nodes"][info["from"]]["p_psia"][k] * PSI
                T_up = rec["nodes"][info["from"]]["T_K"][k]
                signals = {}
                if "state" in info:
                    signals[f"{component.id}.command"] = info["state"][k]
                flow = conditions_from_fluid(
                    net.fluid(upstream.fluid),
                    p_up,
                    T_up,
                    signals,
                    multiphase=net.multiphase,
                    phase=upstream.phase,
                    gravity=net.gravity,
                )
                own = component.total_dp(info["mdot"][k], flow) / PSI
                assert own == pytest.approx(info["dp_psi"][k], rel=2e-3, abs=0.01), (
                    element,
                    k,
                )
                checked += 1
    assert checked > 20


def test_tank_head_carries_the_outflow_and_is_a_gain(recorded) -> None:  # type: ignore[no-untyped-def]
    session, trace = recorded
    rec = network_record(trace)
    branches = rec["branches"]
    for side, path in rec["paths"].items():
        head = next(e for e in path if e.endswith(".head"))
        line = path[path.index(head) + 1]
        firing = [k for k, f in enumerate(trace.firing) if f]
        for k in firing:
            assert branches[head]["mdot"][k] == pytest.approx(
                branches[line]["mdot"][k], rel=1e-9, abs=1e-12
            )
            assert branches[head]["dp_psi"][k] < 0.0  # the column adds pressure
        tank = head[: -len(".head")]
        assert rec["nodes"][tank]["kind"] == "tank"
        assert rec["nodes"][tank]["side"] == "gas"
        assert rec["nodes"][branches[head]["to"]]["side"] == side


def test_metadata_reads_the_drawing(recorded) -> None:  # type: ignore[no-untyped-def]
    session, trace = recorded
    rec = network_record(trace)
    nodes, branches = rec["nodes"], rec["branches"]
    regulator = next(b for b in branches.values() if b["kind"] == "regulator")
    assert regulator["side"] == "gas" and regulator["cv"] > 0.0
    solenoids = [b for b in branches.values() if b["kind"] == "solenoid"]
    assert solenoids and all("state" in b and "cv" in b for b in solenoids)
    assert all(0.0 <= s <= 1.0 for b in solenoids for s in b["state"])
    assert {nodes[n]["side"] for n in session.tanks} == {"gas"}
    assert {nodes[sim.outlet_node]["side"] for sim in session.tanks.values()} == {
        "ox",
        "fuel",
    }
    for node in nodes.values():
        assert node["phase"] in ("gas", "liquid")
    # psia, absolute: the bottle node sits near the 4500 psig it was primed to.
    bottle = next(n for n in nodes.values() if n["kind"] == "bottle")
    assert 4000.0 < bottle["p_psia"][0] < 4600.0
    # The mains' opening is the command the step solved with: shut through the
    # lead-in, open by the end of the burn -- not "no signal, so open".
    for side, path in rec["paths"].items():
        main = next(
            e
            for e in path[path.index(f"{e_tank(path)}.head") :]
            if "state" in branches[e]
        )
        state = branches[main]["state"]
        lead_in = [k for k, f in enumerate(trace.firing) if not f]
        assert lead_in and all(state[k] == 0.0 for k in lead_in), (side, main)
        assert state[-1] == 1.0, (side, main)


def e_tank(path: list[str]) -> str:
    """The tank a path's head element belongs to."""
    head = next(e for e in path if e.endswith(".head"))
    return head[: -len(".head")]


def test_a_line_drawn_backwards_is_reported_along_the_feed(recorded) -> None:  # type: ignore[no-untyped-def]
    """The bottle's line drawn manifold-to-bottle: the network branch runs
    against the feed, so the path must report it the feed's way round -- from
    the bottle, positive flow, positive drop -- and flag it, with the same
    numbers the line drawn the right way gives."""
    _, flipped = _burn(True, flip=("l_kb",), **TIGHT)
    _, plain = recorded
    rec, ref = network_record(flipped), network_record(plain)
    assert flipped.network is not None
    assert flipped.network.branches["l_kb"].reversed
    line, want = rec["branches"]["l_kb"], ref["branches"]["l_kb"]
    assert line.get("reversed") is True and "reversed" not in want
    assert (line["from"], line["to"]) == (want["from"], want["to"])
    assert rec["nodes"][line["from"]]["kind"] == "bottle"
    firing = [k for k, f in enumerate(flipped.firing) if f]
    assert all(line["mdot"][k] > 0.0 for k in firing)
    assert line["mdot"] == pytest.approx(want["mdot"], rel=1e-6, abs=1e-9)
    # The solve itself differs in the last digits with the branch turned round
    # (1.5e-5 psi on a 0.3 psi drop); the sign and size are what matter here.
    assert line["dp_psi"] == pytest.approx(want["dp_psi"], rel=1e-3, abs=1e-4)
    for side, path in rec["paths"].items():
        assert path[0] == "l_kb", side
        for here, there in zip(path, path[1:]):
            assert rec["branches"][here]["to"] == rec["branches"][there]["from"]
