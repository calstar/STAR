"""A stand's hookup: which valve each actuator drives, which knob sets which regulator.

Three promises, each checked against something it cannot fake:

* **The suggestion is the old behaviour, exactly.** A session given ``suggest()``
  emits the same signals, bit for bit, as one given no hookup -- so an imported
  drawing behaves as it always did until somebody changes it.
* **A knob moves the regulator it is linked to.** A plain hand-loaded regulator
  linked to a knob holds the knob's setting, and the tank it presses locks up
  there; unlinked, it holds the drawn setpoint.
* **A pin wins over the name match**, an empty pin leaves an actuator unbound,
  and a pin naming a valve the drawing lost is ignored rather than leaving a
  main valve uncommanded.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from test_press_path_coupling import _helium_stand

from feedtwin.pid import read_diagram
from feedtwin.session import Session, assemble_model, bind, load_machine
from feedtwin.session.burn import press_valves
from feedtwin.session.gauge import psig
from feedtwin.session.hookup import DOME, Hookup, Knob, binding, regulators, suggest

STAR = Path(__file__).resolve().parents[3]
STAND = STAR / "feed-twin" / "backend" / "diagrams" / "ethalox_stand.json"
TABLES = STAR / "feed-twin" / "backend" / "statemachines"

needs_stand = pytest.mark.skipif(
    not (STAND.exists() and TABLES.is_dir()), reason="stand drawing or tables absent"
)


def _session(hookup: Hookup | None) -> Session:
    model = assemble_model(
        read_diagram(json.loads(STAND.read_text()), name="s"), diagram_id="s"
    )
    machine = load_machine(tables=TABLES)
    return Session(model, machine, binding(model, machine, hookup), hookup=hookup)


@needs_stand
def test_the_suggestion_is_what_the_session_always_did() -> None:
    plain = _session(None)
    model = plain.model
    hookup = suggest(
        assemble_model(
            read_diagram(json.loads(STAND.read_text()), name="s"), diagram_id="s"
        ),
        plain.setup.dome_psi,
    )
    assert hookup.knobs and hookup.knobs[0].id == DOME, "the stand's dome knob"
    suggested = _session(hookup)
    for state in ("Idle", "Ready"):
        plain.state = suggested.state = state
        assert suggested.signals() == plain.signals()
    assert suggested.binding.to_symbol == plain.binding.to_symbol
    assert (
        model.built.dome_loaders.keys() <= set(hookup.knobs[0].regulators)
        or not model.built.dome_loaders
    )


def test_a_knob_sets_the_plain_regulator_it_is_linked_to() -> None:
    """LE4's layout with a hand-loaded regulator (drawn at 560). Linked to a knob at
    400 psig the tanks lock up near 400; unlinked they lock up near 560. The test
    can fail: a knob that drove nothing leaves both at 560."""

    def lockup(knob_psig: float | None) -> float:
        session = _helium_stand()
        if knob_psig is not None:
            (reg,) = [r for r in regulators(session.model) if r.label == "DPR_HP"]
            assert reg.kind == "plain"
            session.hookup = Hookup(
                knobs=(Knob("cart", "Cart regulator", (reg.id,), knob_psig),)
            )
            session.knobs = {"cart": knob_psig}
        session.prime(tank_psi=300.0, copv_psi=4500.0, state="Ready", hold_s=1.0)
        for symbol in press_valves(session):
            session.set_valve(symbol, True)
        for _ in range(150):
            session.step(0.02)
        ullage = session.model.built.tanks["OT"].ullage
        return psig(session.history[-1].pressures[ullage])

    drawn, turned = lockup(None), lockup(400.0)
    assert turned < drawn - 100.0
    assert turned == pytest.approx(400.0, abs=40.0)


@needs_stand
def test_a_pin_wins_an_empty_pin_unbinds_and_a_stale_pin_is_ignored() -> None:
    session = _session(None)
    machine, model = session.machine, session.model
    labels = {
        n.id: n.label or n.id
        for n in model.diagram.nodes
        if n.id in model.built.actuators
    }
    auto = bind(machine, labels, roles=model.built.valve_roles)
    actuator, symbol = sorted(auto.to_symbol.items())[0]
    other = next(s for s in labels if s != symbol)

    pinned = bind(
        machine, labels, roles=model.built.valve_roles, overrides={actuator: other}
    )
    assert pinned.to_symbol[actuator] == other
    assert actuator in pinned.by_user
    assert list(pinned.to_symbol.values()).count(other) == 1, "a valve is driven once"

    none = bind(
        machine, labels, roles=model.built.valve_roles, overrides={actuator: ""}
    )
    assert actuator not in none.to_symbol and actuator in none.unmatched

    stale = bind(
        machine, labels, roles=model.built.valve_roles, overrides={actuator: "gone"}
    )
    assert stale.to_symbol[actuator] == symbol and actuator not in stale.by_user


def test_a_regulator_cannot_be_on_two_knobs() -> None:
    raw = {
        "knobs": [
            {"id": "a", "regulators": ["PR1"]},
            {"id": "b", "regulators": ["PR1"]},
        ]
    }
    with pytest.raises(ValueError, match="two knobs"):
        Hookup.from_dict(raw)
    ok = Hookup.from_dict(
        {
            "valves": {"LOX Main": "OM"},
            "knobs": [{"id": "a", "regulators": ["PR1"], "psig": 300}],
        }
    )
    assert Hookup.from_dict(ok.to_dict()) == ok
