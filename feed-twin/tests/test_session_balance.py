"""The Engine page's O/F split comes from the cockpit itself.

Cockpit samples were built with ``balance=None``, so the split (face against
feed) only ever existed for the one-shot ``/api/fire`` run, and a person who
flowed the stand from the console saw an empty Mixture page. Checked against
the burn the same session totals: the split's O/F is the one the stand
delivered.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import main

STAR = Path(__file__).resolve().parents[2]
CONFIG = STAR / "EngineDesign" / "configs" / "ethalox_doublet_7000N.yaml"
STAND = (
    Path(__file__).resolve().parents[1] / "backend" / "diagrams" / "ethalox_stand.json"
)


@pytest.mark.skipif(not CONFIG.exists(), reason="EngineDesign configs absent")
def test_a_cockpit_flow_has_an_of_split_and_it_matches_the_burn() -> None:
    client = TestClient(main.app)
    engine = client.post(
        "/api/library/engines",
        files={
            "file": (
                "bal.yaml",
                CONFIG.read_bytes() + b"\n# bal\n",
                "application/x-yaml",
            )
        },
    ).json()["artifact"]["id"]
    diagram = client.post(
        "/api/library/diagrams",
        files={"file": (STAND.name, STAND.read_bytes(), "application/json")},
    ).json()["artifact"]["id"]
    try:
        sid = client.post(
            "/api/session", params={"diagram": diagram, "engine": engine}, json={}
        ).json()["id"]
        session = main._SESSIONS[sid]
        session.prime(fill_fraction=0.8, tank_psi=550, copv_psi=4500, state="Ready")
        assert client.get(f"/api/session/{sid}/history").json()["balance"] is None
        session.command_state("Fire")
        for _ in range(20):
            client.post(f"/api/session/{sid}/tick", json={"dt": 0.05})
        split = client.get(f"/api/session/{sid}/history").json()["balance"]
        assert split is not None, "a burning stand has an O/F split"
        of_now = session.history[-1].chamber.mixture_ratio
        assert split["mixture_ratio"] == pytest.approx(of_now, rel=0.02)
        assert split["oxidiser"] and split["fuel"]
    finally:
        main.library.remove(engine)
        main.library.remove(diagram)
