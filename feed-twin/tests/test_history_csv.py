"""The Plots tab's CSV, written by the backend (GET /api/session/{id}/history.csv).

It used to be built in the browser (views/Plots.tsx), so the format is pinned to
what that code wrote: stand names over tags, pressures to psia at 3 places,
JavaScript number printing, the state walked from the transitions. The expected
strings are worked by hand from those rules (and Node for the number cases).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import main
from backend.history_csv import ATMOSPHERE_PSI, history_csv
from stardesign.jsformat import js_to_fixed

STAND = (
    Path(__file__).resolve().parents[1] / "backend" / "diagrams" / "ethalox_stand.json"
)


def test_format_matches_the_browsers():
    history = {
        "times_s": [0.0, 0.5, 1.0],
        "channels": [
            {
                "id": "pt1",
                "tag": "PT-101",
                "unit": "psig",
                "values": [0.0, 100.0, 250.5],
            },
            {
                "id": "tc1",
                "tag": "TC, tank",
                "unit": "K",
                "values": [290.0, 290.25, None],
            },
            {"id": "eng", "tag": "THRUST", "unit": "N", "values": [0, 1.5e-7, 7000]},
        ],
        "events": [{"t": 0.5, "label": "Fire"}],
    }
    out = history_csv(history, {"pt1": "LOX tank"}, "Ready")
    # 0 psig is one atmosphere: 101325 / 6894.757293168361 = 14.6959... psia.
    assert round(ATMOSPHERE_PSI, 4) == 14.6959
    assert out.split("\n") == [
        't_s,state,LOX tank [psia],"TC, tank [K]",THRUST [N]',
        "0.000,,14.696,290,0",
        "0.500,Fire,114.696,290.25,1.5e-7",
        "1.000,Fire,265.196,,7000",
    ]


def test_no_transitions_reads_the_current_state():
    out = history_csv({"times_s": [2.0], "channels": [], "events": []}, {}, "Ready")
    assert out.split("\n")[1] == "2.000,Ready"


@pytest.mark.parametrize(
    "x,d,node",
    # x.toFixed(d) in Node 20: a binary tie rounds away from zero, a near-tie by its exact value.
    [
        (0.125, 2, "0.13"),
        (-0.0001, 2, "-0.00"),
        (1.0005, 3, "1.000"),
        (2.5, 0, "3"),
        (-2.5, 0, "-3"),
        (123.4565, 3, "123.457"),
        (-1.005, 2, "-1.00"),
    ],
)
def test_to_fixed_is_javascripts(x, d, node):
    assert js_to_fixed(x, d) == node


def test_endpoint_serves_a_live_session():
    client = TestClient(main.app)
    diagram = client.post(
        "/api/library/diagrams",
        files={"file": (STAND.name, STAND.read_bytes(), "application/json")},
    ).json()["artifact"]["id"]
    try:
        sid = client.post("/api/session", params={"diagram": diagram}, json={}).json()[
            "id"
        ]
        for _ in range(3):
            client.post(f"/api/session/{sid}/tick", json={"dt": 0.05})
        r = client.get(f"/api/session/{sid}/history.csv")
        assert r.status_code == 200, r.text
        assert r.headers["content-type"].startswith("text/csv")
        assert f"feed-twin-{sid}-" in r.headers["content-disposition"]
        lines = r.text.split("\n")
        assert lines[0].startswith("t_s,state,")
        full = client.get(
            f"/api/session/{sid}/history", params={"seconds": 3600}
        ).json()
        assert len(lines) == 1 + len(
            full["times_s"]
        ), "one row per sample, at full rate"
        assert client.get("/api/session/nope/history.csv").status_code == 404
    finally:
        main.library.remove(diagram)
