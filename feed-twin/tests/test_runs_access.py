"""Whose runs a person sees, whose explanation they watch, and what an owner
may throw away.

* Runs follow the stand's sharing: on a stand, in its owner's folder, seen by
  everyone the stand is shared with (or everyone, on the featured stand); a
  run not on a stand stays its runner's. Bob read every record of Alice's
  private stand by putting ``?owner=alice`` on the URL (H037).
* An explanation is the asker's own, as a study is (D-51): Bob was refused
  with a 409 while Alice's ran, saw her run ids, and could cancel it (H006,
  H038).
* "An owner may delete one" -- and there was no route that did (H015).
* The list reads a small summary per run, not every whole record (H014).
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Mapping

import pytest
from fastapi.testclient import TestClient

from backend import main
from backend import runs as run_records

client = TestClient(main.app)
ALICE = {"X-Auth-Email": "alice@example.com"}
BOB = {"X-Auth-Email": "bob@example.com"}


@pytest.fixture(autouse=True)
def _isolate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("USERDATA_DIR", str(tmp_path))


def _stand(headers: Mapping[str, str], name: str) -> dict[str, Any]:
    made = client.post("/api/twin/stands", json={"name": name}, headers=headers)
    assert made.status_code in (200, 201), made.text
    out: dict[str, Any] = made.json()
    return out


def _run(owner: str, stand: Mapping[str, Any] | None, thrust: float) -> str:
    record = {
        "id": run_records.new_id(),
        "user": owner,
        "stand": (
            {"id": stand["id"], "owner": owner, "name": stand["name"]}
            if stand
            else None
        ),
        "inputs": {"diagram": "d", "t0": {}},
        "outcome": {"thrust_mean_N": thrust, "impulse_Ns": 100.0},
        "series": {"t": [0.0, 1.0], "thrust_N": [thrust, thrust]},
    }
    return str(run_records.store.save(owner, record)["id"])


def _ids(response: Any) -> set[str]:
    assert response.status_code == 200, response.text
    return {r["id"] for r in response.json()}


# ---------------------------------------------------------------------- access


def test_runs_follow_the_stands_sharing() -> None:
    private = _stand(ALICE, "alice private")
    shared = _stand(ALICE, "alice shared")
    hidden = _run("alice@example.com", private, 6000.0)
    seen = _run("alice@example.com", shared, 6100.0)
    own = _run("alice@example.com", None, 6200.0)
    share = client.put(
        f"/api/twin/stands/{shared['id']}/share",
        json={"sharedWith": ["bob@example.com"]},
        headers=ALICE,
    )
    assert share.status_code == 200, share.text
    owner = "alice@example.com"

    # Alice sees all of hers.
    assert _ids(client.get("/api/twin/runs", headers=ALICE)) == {hidden, seen, own}
    # Bob, only the shared stand's.
    assert _ids(client.get(f"/api/twin/runs?owner={owner}", headers=BOB)) == {seen}
    assert (
        client.get(f"/api/twin/runs/{seen}?owner={owner}", headers=BOB).status_code
        == 200
    )
    for run_id in (hidden, own):
        refused = client.get(f"/api/twin/runs/{run_id}?owner={owner}", headers=BOB)
        assert refused.status_code == 403, refused.text
    diff = client.get(
        f"/api/twin/runs/diff?a={seen}&b={hidden}&owner_a={owner}&owner_b={owner}",
        headers=BOB,
    )
    assert diff.status_code == 403


# --------------------------------------------------------------------- explain


def test_an_explanation_is_the_askers_own(monkeypatch: pytest.MonkeyPatch) -> None:
    release = threading.Event()

    def replay(
        inputs: Mapping[str, Any], cancelled: Any, *, horizon_s: float
    ) -> tuple[dict[str, float], list[str]]:
        while not cancelled() and not release.wait(0.01):
            pass
        return {"thrust_mean_N": 6000.0, "impulse_Ns": 100.0}, []

    monkeypatch.setattr(main, "_replay", replay)
    a1, a2 = _run("alice@example.com", None, 6000.0), _run(
        "alice@example.com", None, 6000.0
    )
    b1, b2 = _run("bob@example.com", None, 6000.0), _run(
        "bob@example.com", None, 6000.0
    )
    try:
        alice = client.post(
            "/api/twin/runs/explain", json={"a": a1, "b": a2}, headers=ALICE
        )
        assert alice.status_code == 200, alice.text
        # Bob sees his own (none), not Alice's run ids.
        assert client.get("/api/twin/runs/explain", headers=BOB).json().get("a") != a1
        # His own starts while hers runs.
        bob = client.post(
            "/api/twin/runs/explain", json={"a": b1, "b": b2}, headers=BOB
        )
        assert bob.status_code == 200, bob.text
        # His cancel is his.
        client.post("/api/twin/runs/explain/cancel", headers=BOB)
        mine = client.get("/api/twin/runs/explain", headers=ALICE).json()
        assert mine["a"] == a1 and mine["stage"] != "cancelled"
        # A second of her own while hers runs is refused, as before.
        again = client.post(
            "/api/twin/runs/explain", json={"a": a1, "b": a2}, headers=ALICE
        )
        assert again.status_code == 409
    finally:
        release.set()
        for headers in (ALICE, BOB):
            client.post("/api/twin/runs/explain/cancel", headers=headers)
        for job in main._EXPLAIN.values():
            if job._thread is not None:
                job._thread.join(5.0)


# ---------------------------------------------------------------------- delete


def test_an_owner_may_delete_a_run_and_nobody_else_may() -> None:
    stand = _stand(ALICE, "alice deletes")
    client.put(
        f"/api/twin/stands/{stand['id']}/share",
        json={"sharedWith": ["bob@example.com"]},
        headers=ALICE,
    )
    run = _run("alice@example.com", stand, 6000.0)
    owner = "alice@example.com"
    refused = client.delete(f"/api/twin/runs/{run}?owner={owner}", headers=BOB)
    assert refused.status_code == 403
    gone = client.delete(f"/api/twin/runs/{run}", headers=ALICE)
    assert gone.status_code == 200, gone.text
    assert client.get(f"/api/twin/runs/{run}", headers=ALICE).status_code == 404
    assert _ids(client.get("/api/twin/runs", headers=ALICE)) == set()
    assert client.delete(f"/api/twin/runs/{run}", headers=ALICE).status_code == 404


# ---------------------------------------------------------------------- listing


def test_the_list_reads_summaries_not_whole_records(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for thrust in (6000.0, 6100.0, 6200.0):
        _run("local", None, thrust)
    first = client.get("/api/twin/runs").json()
    assert sorted(r["outcome"]["thrust_mean_N"] for r in first) == [
        6000.0,
        6100.0,
        6200.0,
    ]
    read: list[str] = []
    real = Path.read_text

    def counted(path: Path, *args: Any, **kwargs: Any) -> str:
        read.append(path.name)
        return real(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", counted)
    again = client.get("/api/twin/runs").json()
    assert again == first
    whole = [n for n in read if n.endswith(".json") and ".summary." not in n]
    assert not whole, f"read whole records to list them: {whole}"
