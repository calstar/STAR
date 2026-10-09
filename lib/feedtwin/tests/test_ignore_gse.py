"""Ignoring the drawn GSE (``Setup.ignore_gse``, ``assemble_model(vehicle_only=)``).

The twin misreads a complicated cart (the operator, 2026-10-08), and the burn
only needs the rocket. With the option on, everything off the vehicle is cut
before the build and the stand fills the way a drawing of the rocket alone
does: the built-in charge, the built-in loads, the dome knob on the tank
regulator itself. Each check is against what the drawn cart would have done
instead, so it fails if the cart were still there.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from feedtwin.pid import read_diagram
from feedtwin.pid.roles import ground_ids, vehicle_only
from feedtwin.session import Setup, assemble_model, load_machine
from feedtwin.session.burn import open_session
from feedtwin.session.gauge import psig
from feedtwin.session.hookup import DOME, Hookup, on_vehicle, suggest

HERE = Path(__file__).resolve().parent
DRAWING = HERE / "fixtures" / "le4_rocket_and_gse.json"
STAR = HERE.parents[2]
STAND = STAR / "feed-twin" / "backend" / "diagrams" / "ethalox_stand.json"
TABLES = STAR / "feed-twin" / "backend" / "statemachines"

needs_tables = pytest.mark.skipif(not TABLES.is_dir(), reason="no state machine tables")


def _payload() -> Any:
    return json.loads(DRAWING.read_text())


def _ids() -> dict[str, str]:
    return {n["data"]["label"]: n["id"] for n in _payload()["nodes"]}


def _model(cut: bool, payload: Any | None = None) -> Any:
    return assemble_model(
        read_diagram(payload or _payload(), name="LE4 (6)"),
        diagram_id="le4",
        vehicle_only=cut,
    )


def _session(cut: bool) -> Any:
    whole = _model(False)
    model = _model(cut)
    hookup = suggest(whole, 500.0, 4500.0)
    if cut:
        hookup = on_vehicle(hookup, model)
    return open_session(model, load_machine(tables=TABLES), hookup=hookup)


def test_the_cart_is_cut_and_its_disconnects_capped() -> None:
    ids = _ids()
    diagram = read_diagram(_payload(), name="LE4 (6)")
    ground = ground_ids(diagram)
    cut, gone = vehicle_only(diagram)
    assert ground and not ground & {n.id for n in cut.nodes}
    assert not ground_ids(cut), "what is left is one piece"
    assert set(gone) == {"LOX-DW-350 PSI", "6K-GN2", "2K-GN2", "Fuel Transfer Tank"}
    assert all(e.source not in ground and e.target not in ground for e in cut.edges)
    mates = {n.id: n.options.get("pairedWith", "") for n in cut.nodes if n.type == "QD"}
    assert not any(m in ground for m in mates.values()), "no half paired to the cart"
    assert ids["COPV"] in {n.id for n in cut.nodes}

    model = _model(True)
    assert model.meta["vehicle_only"] is True
    assert set(model.meta["ground_cut"]) == set(gone)
    assert not model.built.mated and not model.built.supplies


def test_a_drawing_of_the_rocket_alone_is_not_touched() -> None:
    """On, against a drawing with nothing off the vehicle: the same object."""
    diagram = read_diagram(_payload(), name="LE4 (6)")
    cut, _ = vehicle_only(diagram)
    again, gone = vehicle_only(cut)
    assert again is cut and gone == ()


@pytest.mark.skipif(
    not (STAND.exists() and TABLES.is_dir()), reason="stand drawing or tables absent"
)
def test_on_a_one_page_drawing_it_changes_nothing() -> None:
    """The shipped stand has no GSE drawn: built with the option on it runs the
    same pad, number for number, as with it off."""

    def run(cut: bool) -> Any:
        model = assemble_model(
            read_diagram(json.loads(STAND.read_text()), name="s"),
            diagram_id="s",
            vehicle_only=cut,
        )
        session = open_session(
            model, load_machine(tables=TABLES), setup=Setup(ignore_gse=cut)
        )
        for state, steps in (("GN2 High Press", 10), ("Fuel Fill", 10), ("Ready", 10)):
            session.state = state
            for _ in range(steps):
                session.step(0.5)
        return session

    on, off = run(True), run(False)
    assert on.setup.ignore_gse and not off.setup.ignore_gse
    assert on.model.diagram.nodes == off.model.diagram.nodes
    for a, b in zip(on.history, off.history, strict=True):
        assert a.pressures == b.pressures
        assert a.signals == b.signals


@needs_tables
def test_the_rocket_fills_at_the_settings_not_through_the_cart() -> None:
    """GN2 High Press charges the COPV to the COPV fill setting by the built-in
    charge, Fuel Fill pours the built-in load, and the dome knob sets DPR_HP's
    dome itself: the tanks lock up at it with no GN2 Low Press. With the cart
    simulated, the COPV fills through PR-1, the fuel through the transfer tank,
    and the dome stays unloaded until GN2 Low Press -- the tanks hold the spring
    bias less the supply effect, which on a charged COPV is shut."""
    ids = _ids()
    for cut in (True, False):
        session = _session(cut)
        session.setup = replace(session.setup, copv_target_psi=4000.0, dome_psi=450.0)
        copv = session.bottles[ids["COPV"]]
        fuel = session.tanks[ids["Eth-Tank"]]
        assert session.setup.ignore_gse is cut

        session.state = "GN2 High Press"
        for _ in range(40):
            session.step(0.5)
        assert psig(copv.pressure) == pytest.approx(4000.0, abs=40.0)
        assert (ids["COPV"] in session._drawn_fill) is not cut

        session.state = "Fuel Fill"
        for _ in range(60):
            session.step(0.5)
        assert fuel.state.liquid_mass == pytest.approx(fuel._wanted(), rel=0.02)
        assert (ids["Eth-Tank"] in session._drawn_fill) is not cut

        session.state = "Fuel Press"
        for _ in range(30):
            session.step(0.5)
        if not cut:
            assert psig(fuel.pressure) < 5.0, "the drawn dome is not loaded yet"
            continue
        lockup = 450.0 + 50.0 - 14.7e-3 * psig(copv.pressure)
        assert psig(fuel.pressure) == pytest.approx(lockup, abs=8.0)
        dome_pt = next(i for i in session.model.built.instruments if i.tag == "DP-PT-R")
        assert psig(session.history[-1].pressures[dome_pt.node]) == pytest.approx(450.0)
        assert any("drawn GSE is ignored" in a for a in session.assumptions)


@needs_tables
def test_the_cart_actuators_drive_nothing() -> None:
    bound = _session(True).binding.to_symbol
    assert "GSE High Press Control" not in bound, "the built-in charge's command"
    assert "GSE Med Press Control" not in bound
    assert {"Fuel Press", "LOX Press", "Fuel Main", "LOX Main"} <= set(bound)


def test_the_hookup_keeps_the_vehicle_and_drops_the_cart() -> None:
    ids = _ids()
    whole, model = _model(False), _model(True)
    saved = Hookup(
        valves={
            "Fuel Main": ids["FM-R"],
            "GSE High Press Control": ids["HPC_SOL"],
            "LOX Dump": "",
        },
        knobs=suggest(whole, 500.0, 4500.0).knobs,
    )
    cut = on_vehicle(saved, model)
    assert cut.valves == {"Fuel Main": ids["FM-R"], "LOX Dump": ""}
    assert [(k.id, k.regulators) for k in cut.knobs] == [(DOME, (ids["DPR_HP"],))]


@needs_tables
def test_the_setup_says_what_the_stand_was_built_from() -> None:
    machine = load_machine(tables=TABLES)
    whole = open_session(_model(False), machine, setup=Setup(ignore_gse=True))
    assert whole.setup.ignore_gse is False and not whole.gse_ignored
    cut = open_session(_model(True), machine, setup=Setup())
    assert cut.setup.ignore_gse is True and cut.gse_ignored
