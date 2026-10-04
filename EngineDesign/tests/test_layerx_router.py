"""The Layer X routes beyond the happy path (backend/routers/layerx.py).

The router had one test, a burn that worked. These are the paths that decide whether a person
loses work or reads a wrong state: the one-job rule, what pruning keeps, pins, names and notes,
deleting, the listing's index, the study's refusals and the measurement bounds. They run without
a burn except where a preflight is the thing under test.
"""

from __future__ import annotations

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.routers import layerx as lx  # noqa: E402
from backend.session import UserSession, get_session  # noqa: E402


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("USERDATA_DIR", str(tmp_path))
    session = UserSession(f"router-{tmp_path.name}")
    app = FastAPI()
    app.include_router(lx.router)
    app.dependency_overrides[get_session] = lambda: session
    yield TestClient(app), session
    with lx._JOBS_LOCK:
        for job_id in [j.id for j in lx._JOBS.values() if j.user == session.user]:
            lx._JOBS.pop(job_id, None)


def _saved(session, run_id: str, kind: str = "run", impulse: float = 24000.0) -> lx.Job:
    job = lx.Job(session.user, lx.Settings(drawing_id="d"), "design", kind=kind)
    job.id = run_id
    job.status, job.finished = "done", 1.0
    job.result = {"summary": {"burn_time_s": 3.5, "total_impulse_Ns": impulse}, "provenance": {"drawing": {"name": "stand"}}}
    lx._persist(lx._runs_dir(session), job)
    return job


def test_one_job_at_a_time_is_a_409_before_any_work(api):
    client, session = api
    busy = lx.Job(session.user, lx.Settings(drawing_id="d"), "design")
    busy.status = "running"
    with lx._JOBS_LOCK:
        lx._JOBS[busy.id] = busy
    r = client.post("/api/layerx/runs", json={"drawing_id": "anything"})
    assert r.status_code == 409 and busy.id in r.json()["detail"]


def test_the_listing_reads_the_index_and_carries_names_and_pins(api):
    client, session = api
    _saved(session, "20261002-000001-aaaaaa", impulse=24100.0)
    runs_dir = lx._runs_dir(session)
    assert (runs_dir / "_index" / "20261002-000001-aaaaaa.json").is_file()
    # The listing never opens the run file: make it unreadable and the entry is still there.
    (runs_dir / "20261002-000001-aaaaaa.json").write_text(json.dumps({"id": "20261002-000001-aaaaaa", "result": "x" * 10}))
    listed = client.get("/api/layerx/runs").json()
    assert listed[0]["summary"]["total_impulse_Ns"] == 24100.0
    meta = client.patch("/api/layerx/runs/20261002-000001-aaaaaa", json={"name": "  600 psia, GN2 ", "pinned": True}).json()
    assert meta == {"name": "600 psia, GN2", "pinned": True}
    listed = client.get("/api/layerx/runs").json()
    assert listed[0]["meta"]["pinned"] is True
    assert client.patch("/api/layerx/runs/20261002-000009-ffffff", json={"pinned": True}).status_code == 404
    assert client.patch("/api/layerx/runs/../../etc", json={"pinned": True}).status_code == 404


def test_pruning_keeps_the_newest_per_kind_and_every_pinned_run(api, monkeypatch):
    client, session = api
    monkeypatch.setattr(lx, "KEEP_RUNS", 2)
    _saved(session, "20261002-000001-aaaaaa")
    client.patch("/api/layerx/runs/20261002-000001-aaaaaa", json={"pinned": True})
    _saved(session, "20261002-000002-bbbbbb")
    _saved(session, "20261002-000003-cccccc", kind="trade")      # another kind: not counted against runs
    _saved(session, "20261002-000004-dddddd")
    _saved(session, "20261002-000005-eeeeee")
    ids = {r["id"] for r in client.get("/api/layerx/runs").json()}
    assert ids == {"20261002-000001-aaaaaa", "20261002-000003-cccccc", "20261002-000004-dddddd", "20261002-000005-eeeeee"}
    assert not (lx._runs_dir(session) / "_index" / "20261002-000002-bbbbbb.json").exists()


def test_delete_removes_the_run_its_entry_and_its_notes_but_not_a_live_job(api):
    client, session = api
    _saved(session, "20261002-000001-aaaaaa")
    client.patch("/api/layerx/runs/20261002-000001-aaaaaa", json={"note": "first fire prediction"})
    assert client.delete("/api/layerx/runs/20261002-000001-aaaaaa").json()["deleted"]
    runs_dir = lx._runs_dir(session)
    assert not any(runs_dir.rglob("20261002-000001-aaaaaa*"))
    assert client.get("/api/layerx/runs").json() == []
    live = lx.Job(session.user, lx.Settings(drawing_id="d"), "design")
    live.status = "running"
    with lx._JOBS_LOCK:
        lx._JOBS[live.id] = live
    assert client.delete(f"/api/layerx/runs/{live.id}").status_code == 409


def test_a_restated_measurement_is_bounded():
    from engine.layerx.measurements import Override

    base = {"target": "node:OXT", "parameter": "volume", "value": 15.1, "unit": "L", "source": "weighed"}
    assert Override.from_dict(base).value == 15.1
    with pytest.raises(ValueError, match="negative"):
        Override.from_dict({**base, "value": -1.0})
    assert Override.from_dict({**base, "parameter": "elevation_change", "value": -0.3}).value == -0.3   # a height may fall
    with pytest.raises(ValueError, match="longer than"):
        Override.from_dict({**base, "source": "x" * 400})

