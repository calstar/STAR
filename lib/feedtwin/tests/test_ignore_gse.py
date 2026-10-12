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
from feedtwin.pid.roles import ground_ids, unpaired_vents, vehicle_only, vent_branches
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
    """Everything off the vehicle goes but the cart's vent line, which stays
    plugged into the rocket until launch; every other coupling is capped."""
    ids = _ids()
    diagram = read_diagram(_payload(), name="LE4 (6)")
    ground = ground_ids(diagram)
    vents = vent_branches(diagram)
    assert vents == {ids[x] for x in ("FV-QD-A", "FV-SOL", "FV-MAN", "junc_o5qqb5_95")}
    cut, gone = vehicle_only(diagram)
    kept = {n.id for n in cut.nodes}
    assert ground and ground & kept == vents
    assert ground_ids(cut) == vents, "the rocket and its vent line"
    assert set(gone) == {"LOX-DW-350 PSI", "6K-GN2", "2K-GN2", "Fuel Transfer Tank"}
    cart = ground - vents
    assert all(e.source not in cart and e.target not in cart for e in cut.edges)
    mates = {
        n.label: n.options.get("pairedWith", "") for n in cut.nodes if n.type == "QD"
    }
    assert mates["FV-QD-B"] == ids["FV-QD-A"], "the vent stays coupled"
    assert not any(
        m in cart for m in mates.values()
    ), "no other half paired to the cart"
    assert ids["COPV"] in kept

    model = _model(True)
    assert model.meta["vehicle_only"] is True
    assert set(model.meta["ground_cut"]) == set(gone)
    # The one coupling left mated is the vent's; nothing on the cart supplies.
    assert model.built.mated == ((ids["FV-QD-B"], ids["FV-QD-A"]),)
    assert not model.built.supplies


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


@needs_tables
def test_the_cart_vent_stays_plugged_in_and_vents_the_rocket() -> None:
    """The cart's vents are a small part of the GSE that stays plugged into the
    rocket until the last moment before launch (the team, 2026-10-10). Rocket
    only, the fuel tank's vent coupling stays mated to the cart's vent line,
    Fuel Vent drives the cart's FV-SOL -- not a stand-in on the capped
    coupling -- and venting through it empties the pressed tank."""
    ids = _ids()
    model = _model(True)
    assert ids["FV-QD-B"] not in model.meta["capped"]
    session = _session(True)
    assert session.binding.to_symbol["Fuel Vent"] == ids["FV-SOL"]
    fuel = session.tanks[ids["Eth-Tank"]]
    for state, steps in (("GN2 High Press", 30), ("Fuel Fill", 40), ("Fuel Press", 20)):
        session.state = state
        for _ in range(steps):
            session.step(0.5)
    pressed = psig(fuel.pressure)
    assert pressed > 400.0
    session.state = "Fuel Vent"
    for _ in range(20):
        session.step(0.5)
    assert psig(fuel.pressure) < 0.1 * pressed, "it vents through the cart's line"


def test_a_vent_drawn_unpaired_is_said_and_once_paired_it_stays() -> None:
    """LE4 (6) draws the LOX vent's halves -- the rocket's QD-OV-B and the
    cart's OV-QD-A in front of OV-MOT -- paired with nothing. The twin does
    not guess the pair; it says so. Paired, the warning goes and the LOX vent
    line stays plugged into the rocket only like the fuel's."""
    payload = _payload()
    ids = _ids()
    warned = unpaired_vents(read_diagram(payload, name="LE4 (6)"))
    assert len(warned) == 1 and "QD-OV-B" in warned[0] and "OV-MOT" in warned[0]
    assert warned[0] in _model(False).report.warnings
    for node in payload["nodes"]:
        label = node["data"]["label"]
        if label in ("QD-OV-B", "OV-QD-A"):
            other = "OV-QD-A" if label == "QD-OV-B" else "QD-OV-B"
            node["data"].setdefault("options", {})["pairedWith"] = ids[other]
    paired = read_diagram(payload, name="LE4 (6) paired")
    assert unpaired_vents(paired) == []
    assert {ids["OV-QD-A"], ids["OV-MOT"]} <= vent_branches(paired)
    cut = _model(True, payload)
    assert ids["QD-OV-B"] not in cut.meta["capped"]


def test_a_gas_swap_puts_helium_in_the_bottles_lines_and_ullages() -> None:
    """``gas_swap`` replaces the pressurant wherever it is declared: the
    network's bottles, press lines and the ullages they fill hold helium; the
    tanks keep their propellants. Without it, the drawing's nitrogen."""
    from feedtwin.session.model import swap_gases

    ids = _ids()
    diagram = read_diagram(_payload(), name="LE4 (6)")
    swapped = swap_gases(diagram, {"nitrogen": "helium"})
    by_id = {n.id: n for n in swapped.nodes}
    assert by_id[ids["COPV"]].fluid == "helium"
    assert by_id[ids["Eth-Tank"]].fluid == next(
        n.fluid for n in diagram.nodes if n.id == ids["Eth-Tank"]
    )
    assert not any(n.fluid == "nitrogen" for n in swapped.nodes)
    for gas in ("nitrogen", "helium"):
        model = assemble_model(
            read_diagram(_payload(), name="LE4 (6)"),
            diagram_id="le4",
            gas_swap=None if gas == "nitrogen" else {"nitrogen": gas},
        )
        nodes = model.built.network.nodes
        assert nodes[ids["COPV"]].fluid == gas
        # The ullages it presses (a tank's node is its ullage; ``.out`` its
        # liquid), and the tanks still hold their propellants.
        for tank in ("Eth-Tank", "LOX-Tank"):
            assert nodes[ids[tank]].fluid == gas
            assert nodes[f"{ids[tank]}.out"].fluid in ("ethanol", "oxygen")
