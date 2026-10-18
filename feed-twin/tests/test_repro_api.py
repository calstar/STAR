"""The repro (Solver tab -> "export repro") and its replay.

A problem seen on the server could not be looked at here: the drawing lived in
the server's library and nobody wrote down what was clicked (2026-10-11). The
repro carries both -- the drawing and engine themselves, the setup, the hookup,
every command and T-0 at its stand time -- and ``scripts/replay_repro.py``
plays it in a scratch library. The Solver tab's flags come with it.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Iterator

import pytest

from fastapi.testclient import TestClient

from backend.library import LibraryError
from backend.main import HOOKUPS, _lineage, app, library

client = TestClient(app)
ROOT = Path(__file__).resolve().parents[2]
DRAWING = ROOT / "lib" / "feedtwin" / "tests" / "fixtures" / "le4_rocket_and_gse.json"
TABLES = ROOT / "feed-twin" / "backend" / "statemachines"

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


def _stand() -> tuple[str, dict]:
    response = client.post(
        "/api/library/diagrams",
        files={"file": ("repro LE4.json", DRAWING.read_bytes(), "application/json")},
    )
    assert response.status_code == 200, response.text
    diagram = response.json()["artifact"]["id"]
    UPLOADED.append(diagram)
    opened = client.post(
        "/api/session",
        params={"diagram": diagram},
        json={"state": "Idle", "ignore_gse": True},
    )
    assert opened.status_code == 200, opened.text
    sid = opened.json()["id"]
    for step in (
        {"command": {"state": "Armed"}},
        {"tick": 1.0},
        {"command": {"state": "Fuel Fill"}},
        {"tick": 3.0},
        {"t0": True},
        {"tick": 1.0},
    ):
        if "command" in step:
            assert (
                client.post(
                    f"/api/session/{sid}/command", json=step["command"]
                ).status_code
                == 200
            )
        elif "t0" in step:
            assert client.post(f"/api/session/{sid}/t0").status_code == 200
        else:
            for _ in range(int(step["tick"] / 0.5)):
                client.post(f"/api/session/{sid}/tick", json={"dt": 0.5})
    repro = client.get(f"/api/session/{sid}/repro")
    assert repro.status_code == 200, repro.text
    return sid, repro.json()


def test_the_repro_carries_the_drawing_the_setup_and_every_command() -> None:
    sid, repro = _stand()
    assert repro["kind"] == "feedtwin-repro"
    assert repro["drawing"] == json.loads(DRAWING.read_text())
    assert repro["opened"]["body"]["ignore_gse"] is True
    assert repro["hookup"], "the hookup the stand ran"
    kinds = [
        ("command" in e and e["command"].get("state"))
        or ("t0" if e.get("t0") else None)
        for e in repro["events"]
    ]
    assert kinds == ["Armed", "Fuel Fill", "t0"]
    times = [e["t"] for e in repro["events"]]
    assert times == sorted(times) and times[-1] > 3.0
    assert repro["end"]["t"] > times[-1]
    assert isinstance(repro["end"]["flags"], list)
    solver = client.get(f"/api/session/{sid}/solver").json()
    assert solver["flags"] == repro["end"]["flags"]


def test_a_repro_replays_to_where_it_ended(tmp_path: Path) -> None:
    _, repro = _stand()
    path = tmp_path / "repro.json"
    path.write_text(json.dumps(repro))
    out = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "replay_repro.py"), str(path)],
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert out.returncode == 0, out.stderr[-2000:]
    assert "T-0" in out.stdout
    for label, tank in repro["end"]["tanks"].items():
        line = next(l for l in out.stdout.splitlines() if l.strip().startswith(label))
        replayed = float(line.split()[len(label.split())])
        assert replayed == pytest.approx(tank["pressure_psi"] + 14.696, abs=5.0), line
