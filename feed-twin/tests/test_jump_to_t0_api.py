"""Jump to T-0 from the cockpit: loaded, charged, at the lockup the knobs give.

Checked against the stand's own regulator law: the shipped stand's dome-loaded
regulator holds its dome plus a fixed spring bias, so turning the dome knob
down 50 psi moves T-0 down 50 psi; and the stand is left in Ready with both
tanks loaded and the bottle at the COPV target.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import main

STAND = (
    Path(__file__).resolve().parents[1] / "backend" / "diagrams" / "ethalox_stand.json"
)


def _t0(client: TestClient, diagram: str, dome: float) -> dict:  # type: ignore[type-arg]
    sid = client.post(
        "/api/session", params={"diagram": diagram}, json={"dome": dome}
    ).json()["id"]
    response = client.post(f"/api/session/{sid}/t0")
    assert response.status_code == 200, response.text
    out: dict = response.json()  # type: ignore[type-arg]
    return out


def test_t0_follows_the_dome_knob_and_lands_in_ready() -> None:
    client = TestClient(main.app)
    diagram = client.post(
        "/api/library/diagrams",
        files={"file": (STAND.name, STAND.read_bytes(), "application/json")},
    ).json()["artifact"]["id"]
    try:
        high = _t0(client, diagram, 500.0)
        low = _t0(client, diagram, 450.0)
        assert high["state"] == "Ready"
        for tank in high["tanks"]:
            assert tank["liquid_mass_kg"] > 0.5, tank["label"]
        assert high["bottles"][0]["pressure_psi"] == pytest.approx(
            high["setup"]["copv_target"], abs=10.0
        )
        by_label = {t["label"]: t["pressure_psi"] for t in high["tanks"]}
        for tank in low["tanks"]:
            drop = by_label[tank["label"]] - tank["pressure_psi"]
            assert drop == pytest.approx(50.0, abs=3.0), tank["label"]
    finally:
        main.library.remove(diagram)
