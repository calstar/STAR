"""Ignoring the drawn GSE over the API (``ignore_gse``, the Configuration and
GSE Controls tabs).

A stand opened with it is the rocket alone, even when the drawing's saved
hookup turns the cart's regulators; one opened without it is the drawing as
drawn. It is how the stand was built, so a command cannot flip it on a running
session -- the cockpit opens a fresh stand instead.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterator

import pytest

from fastapi.testclient import TestClient

from backend.library import LibraryError
from backend.main import HOOKUPS, _lineage, app, library

client = TestClient(app)
DRAWING = (
    Path(__file__).resolve().parents[2]
    / "lib"
    / "feedtwin"
    / "tests"
    / "fixtures"
    / "le4_rocket_and_gse.json"
)
TABLES = Path(__file__).resolve().parents[1] / "backend" / "statemachines"

pytestmark = pytest.mark.skipif(
    not (DRAWING.exists() and TABLES.is_dir()), reason="LE4 (6) fixture absent"
)

UPLOADED: list[str] = []


@pytest.fixture(autouse=True)
def tidy() -> Iterator[None]:
    yield
    for artifact in dict.fromkeys(UPLOADED):
        try:
            library.drop_record(HOOKUPS, _lineage(library.get(artifact)))
            library.remove(artifact)
        except LibraryError:
            pass
    UPLOADED.clear()


def _upload() -> str:
    response = client.post(
        "/api/library/diagrams",
        files={
            "file": ("ignore gse LE4.json", DRAWING.read_bytes(), "application/json")
        },
    )
    assert response.status_code == 200, response.text
    artifact = response.json()["artifact"]["id"]
    UPLOADED.append(artifact)
    return artifact


def _open(diagram: str, **setup: object) -> dict:
    response = client.post(
        "/api/session", params={"diagram": diagram}, json={"state": "Idle", **setup}
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_the_option_is_on_the_configuration_tab() -> None:
    rows = {t["key"]: t for t in client.get("/api/tunables").json()}
    assert rows["ignore_gse"]["kind"] == "flag"
    assert rows["ignore_gse"]["default"] is False


def test_a_stand_opened_ignoring_the_gse_is_the_rocket_alone() -> None:
    diagram = _upload()
    # The drawing's saved hookup turns the cart's regulators (DR-REG-G on the
    # dome knob, PR-1 on the COPV fill), as the suggestion does.
    suggested = client.get("/api/hookup", params={"diagram": diagram}).json()
    saved = client.put(
        "/api/hookup", params={"diagram": diagram}, json=suggested["suggested"]
    )
    assert saved.status_code == 200, saved.text
    labels = {
        n["id"]: n["data"]["label"] for n in json.loads(DRAWING.read_text())["nodes"]
    }

    drawn = _open(diagram)
    assert drawn["setup"]["ignore_gse"] is False
    assert "Fuel Transfer Tank" in {t["label"] for t in drawn["tanks"]}

    rocket = _open(diagram, ignore_gse=True)
    assert rocket["setup"]["ignore_gse"] is True
    assert {t["label"] for t in rocket["tanks"]} == {"Eth-Tank", "LOX-Tank"}
    assert {b["label"] for b in rocket["bottles"]} == {"COPV"}
    knobs = {k["id"]: k for k in rocket["knobs"]}
    assert set(knobs) == {"dome"}
    assert knobs["dome"]["regulators"] == ["DPR_HP"]
    assert "DR-REG-G" in {
        labels.get(r, r)
        for k in suggested["suggested"]["knobs"]
        for r in k["regulators"]
    }

    # The model view and the table read the same cut drawing.
    whole = client.get("/api/model", params={"diagram": diagram}).json()
    cut = client.get(
        "/api/model", params={"diagram": diagram, "ignore_gse": True}
    ).json()
    assert cut["report"]["symbols"] < whole["report"]["symbols"]
    table = client.get(
        "/api/statemachine", params={"diagram": diagram, "ignore_gse": True}
    ).json()
    assert "GSE High Press Control" not in table["bound"]

    # How the stand was built is not a live setting.
    flipped = client.post(
        f"/api/session/{rocket['id']}/command", json={"setup": {"ignore_gse": False}}
    ).json()
    assert flipped["setup"]["ignore_gse"] is True


def test_the_hookup_tab_shows_the_wiring_the_rocket_alone_runs() -> None:
    """Rocket only, a vent wired to the cart's solenoid opens the rocket's
    capped disconnect instead; the Hookup tab says so, while the hookup it
    saves stays the whole drawing's (the cart's knobs are not dropped)."""
    diagram = _upload()
    labels = {
        n["id"]: n["data"]["label"] for n in json.loads(DRAWING.read_text())["nodes"]
    }
    whole = client.get("/api/hookup", params={"diagram": diagram}).json()
    rocket = client.get(
        "/api/hookup", params={"diagram": diagram, "ignore_gse": True}
    ).json()
    assert whole["vehicle_only"] is False and rocket["vehicle_only"] is True
    assert labels[whole["bound"]["Fuel Vent"]] == "FV-SOL"
    assert labels[rocket["bound"]["Fuel Vent"]] == "FV-QD-B"
    assert "GSE High Press Control" in whole["bound"]
    assert "GSE High Press Control" not in rocket["bound"]
    assert rocket["hookup"] == whole["hookup"]
    assert "DR-REG-G" in {
        labels.get(r, r) for k in rocket["hookup"]["knobs"] for r in k["regulators"]
    }


def test_the_dome_knob_reads_the_lockup_range_and_the_drawn_mawp() -> None:
    """The GSE tab's lockup is the range a burn sweeps: the low end is where
    T-0 primes the tanks (COPV charged to its fill setting), the high end the
    same dome over an empty bottle. The redlines are the drawing's MAWPs."""
    diagram = _upload()
    rocket = _open(diagram, ignore_gse=True)
    tanks = {t["label"]: t for t in rocket["tanks"]}
    charged, empty = tanks["Eth-Tank"]["lockup_range_psi"]
    assert empty > charged + 10.0
    assert tanks["Eth-Tank"]["mawp_psi"] == pytest.approx(750.0)
    assert rocket["bottles"][0]["mawp_psi"] == pytest.approx(7500.0)
    primed = client.post(f"/api/session/{rocket['id']}/t0", json={})
    assert primed.status_code == 200, primed.text
    state = client.post(f"/api/session/{rocket['id']}/tick", json={"dt": 0.01}).json()
    tank = next(t for t in state["tanks"] if t["label"] == "Eth-Tank")
    assert tank["pressure_psi"] == pytest.approx(charged, abs=3.0)


def test_a_replay_rebuilds_the_stand_the_run_was_on() -> None:
    """A run record carries its setup; the Explain ladder and the Study rebuild
    from it, so a burn on the rocket alone replays on the rocket alone."""
    from backend.main import _session_from_inputs

    diagram = _upload()
    rocket = _session_from_inputs({"diagram": diagram, "setup": {"ignore_gse": True}})
    assert rocket.gse_ignored and rocket.setup.ignore_gse
    assert {t.label for t in rocket.tanks.values()} == {"Eth-Tank", "LOX-Tank"}
    drawn = _session_from_inputs({"diagram": diagram, "setup": {}})
    assert not drawn.gse_ignored and len(drawn.tanks) > 2


def test_a_fresh_stand_opens_at_the_drawings_settings() -> None:
    """The cart's regulators drawn at 3,750 (PR-1), 535 (DR-REG-G) and 150 (LP-PR):
    a stand opened without the operator turning anything starts every knob
    there, cart simulated or not. A knob the client sends still wins."""
    payload = json.loads(DRAWING.read_text())
    for node in payload["nodes"]:
        setting = {"PR-1": 3750, "DR-REG-G": 535, "LP-PR": 150}.get(
            node["data"]["label"]
        )
        if setting is not None:
            node["data"].setdefault("params", {})["setpoint"] = {
                "value": setting,
                "unit": "psi",
                "source": "estimated",
            }
    response = client.post(
        "/api/library/diagrams",
        files={
            "file": (
                "drawn knobs.json",
                json.dumps(payload).encode(),
                "application/json",
            )
        },
    )
    assert response.status_code == 200, response.text
    diagram = response.json()["artifact"]["id"]
    UPLOADED.append(diagram)

    drawn = _open(diagram)
    assert drawn["setup"]["dome"] == pytest.approx(535.0)
    assert drawn["setup"]["copv_target"] == pytest.approx(3750.0)
    assert {k["label"]: k["psig"] for k in drawn["knobs"]} == {
        "Dome control regulator (DR-REG-G)": pytest.approx(535.0),
        "COPV fill (PR-1)": pytest.approx(3750.0),
        "LP-PR": pytest.approx(150.0),
    }
    rocket = _open(diagram, ignore_gse=True)
    assert rocket["setup"]["copv_target"] == pytest.approx(3750.0), "the cart's PR-1"
    turned = _open(diagram, dome=480, copv_target=4000)
    assert turned["setup"]["dome"] == 480 and turned["setup"]["copv_target"] == 4000


def test_the_model_view_says_which_symbols_are_the_cart() -> None:
    """The console hides the cart's transducers and tanks by default and leaves
    its K-bottles and dewars off; it learns which they are from here."""
    diagram = _upload()
    labels = {
        n["id"]: n["data"]["label"] for n in json.loads(DRAWING.read_text())["nodes"]
    }
    view = client.get("/api/model", params={"diagram": diagram}).json()
    ground = {labels.get(i, i) for i in view["ground"]}
    assert {"6K-GN2", "Fuel Transfer Tank", "DR-REG-G"} <= ground
    assert not {"COPV", "Eth-Tank", "LOX-Tank", "DPR_HP"} & ground
    assert {labels[i] for i in view["ground_bottles"]} == {
        "LOX-DW-350 PSI",
        "6K-GN2",
        "2K-GN2",
    }
    rocket = client.get(
        "/api/model", params={"diagram": diagram, "ignore_gse": True}
    ).json()
    assert rocket["ground"] == [] and rocket["ground_bottles"] == []
