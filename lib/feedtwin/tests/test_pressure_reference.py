"""A drawing's pressures: absolute ones read as gauge unless they say psia, and
differences never carry a reference (feedtwin.model.pressure).

Checked against what the drawing's author wrote, not against the code: a tank
drawn "at 500 psi" sits at 500 on its gauge; a dome loader drawn at 500 and the
dome knob turned to 500 lock the tanks up at the same pressure; a 50 psi bias is
50 psi whatever reference anyone thinks of.
"""

from __future__ import annotations

import json
import tomllib
from importlib.resources import files
from pathlib import Path

import pytest
from test_pid_drawn_freely import P, node

from feedtwin.model.pressure import (
    ABSOLUTE,
    DIFFERENCE,
    PressureReferenceError,
    drawn_unit,
)
from feedtwin.pid import DiagramError, read_diagram

PSI = 6894.757293168361
ATM = 101325.0
STAR = Path(__file__).resolve().parents[3]


def _read(*nodes: dict) -> dict:  # type: ignore[type-arg]
    drawing = read_diagram({"nodes": list(nodes), "edges": []}, name="t")
    return {n.id: n.params for n in drawing.nodes}


def test_a_bare_absolute_pressure_is_what_its_gauge_reads() -> None:
    params = _read(
        node("T", "TANK", "TK", params={"pressure": P(500, "psi")}),
        node("B", "KBOTTLE", "KB", params={"pressure": P(300, "bar")}),
        node("R", "PR", "PR", params={"setpoint": P(560, "psi")}),
    )
    assert params["T"]["pressure"].si == pytest.approx(500 * PSI + ATM)
    assert params["B"]["pressure"].si == pytest.approx(300e5 + ATM)
    assert params["R"]["setpoint"].si == pytest.approx(560 * PSI + ATM)


def test_psia_says_absolute_and_atm_is_absolute() -> None:
    params = _read(
        node("T", "TANK", "TK", params={"pressure": P(514.7, "psia")}),
        node("U", "TANK", "TK2", params={"pressure": P(1, "atm")}),
    )
    assert params["T"]["pressure"].si == pytest.approx(514.7 * PSI)
    assert params["U"]["pressure"].si == pytest.approx(ATM)


def test_a_difference_is_the_same_size_and_refuses_a_reference() -> None:
    params = _read(
        node(
            "R",
            "PR",
            "PR",
            params={"dome_bias": P(50, "psi"), "flow_droop": P(20, "psi")},
        )
    )
    assert params["R"]["dome_bias"].si == pytest.approx(50 * PSI)
    assert params["R"]["flow_droop"].si == pytest.approx(20 * PSI)
    with pytest.raises(DiagramError, match="dome_bias is a pressure difference"):
        _read(node("R", "PR", "PR", params={"dome_bias": P(50, "psig")}))
    with pytest.raises(PressureReferenceError):
        drawn_unit("set_pressure", "psia")


def test_the_chamber_is_quoted_absolute() -> None:
    params = _read(
        node("E", "ENGINE", "ENG", params={"chamber_pressure": P(385, "psi")})
    )
    assert params["E"]["chamber_pressure"].si == pytest.approx(385 * PSI)


def test_a_drawn_dome_and_the_dome_knob_at_the_same_number_agree() -> None:
    """The case that found this. The shipped stand's control regulator is drawn at
    450 and the dome-loaded one's dome comes from it; the cockpit's dome knob at
    450 psig drives the same dome. Read as psia, the drawing's 450 was an atmosphere
    under the knob's, and the same stand locked up 14.7 psi apart."""
    from feedtwin.pid import build_network
    from feedtwin.session.gauge import from_psig

    stand = STAR / "feed-twin" / "backend" / "diagrams" / "ethalox_stand.json"
    built = build_network(read_diagram(json.loads(stand.read_text()), name="s"))
    (loader,) = built.dome_loaders.values()
    loaded = loader.signal.split(".")[0]
    dome = next(
        b.component.p["dome_pressure"]
        for b in built.network.branches.values()
        if getattr(b.component, "id", "") == loaded
    )
    assert dome == pytest.approx(from_psig(450.0))
    # ...and a plain regulator's drawn setpoint is gauge too.
    plain = _read(node("R", "PR", "PR", params={"setpoint": P(560, "psi")}))
    assert plain["R"]["setpoint"].si == pytest.approx(from_psig(560.0))


def test_every_pressure_the_catalogue_and_the_drawings_use_is_classified() -> None:
    """The lists in feedtwin.model.pressure are complete: every pressure parameter
    the component catalogue declares, and every one on a shipped or saved drawing,
    is either absolute or a difference. A new one fails here until it is placed."""
    catalogue = tomllib.loads(
        files("feedtwin.model").joinpath("components.toml").read_text()
    )
    names = {
        name
        for spec in catalogue.values()
        if isinstance(spec, dict)
        for name, param in (spec.get("params") or {}).items()
        if isinstance(param, dict) and param.get("dimension") == "pressure"
    }
    pressure_units = {"psi", "bar", "Pa", "kPa", "MPa", "atm", "psia", "psig"}
    drawings = list((STAR / "feed-twin" / "backend" / "diagrams").glob("*.json"))
    for path in drawings:
        payload = json.loads(path.read_text())
        for item in payload.get("nodes", []) + payload.get("edges", []):
            for name, param in ((item.get("data") or {}).get("params") or {}).items():
                if isinstance(param, dict) and param.get("unit") in pressure_units:
                    names.add(name)
    assert names, "found no pressure parameters to check"
    unplaced = sorted(names - ABSOLUTE - DIFFERENCE)
    assert not unplaced, f"place these in feedtwin.model.pressure: {unplaced}"
    assert not ABSOLUTE & DIFFERENCE
