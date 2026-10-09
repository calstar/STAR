"""Run records: a burn kept with everything it depended on, two of them diffed,
and the change between them attributed to the inputs that made it.

Checked against what the records must say, not against the code that writes
them: a burn the cockpit fired is recorded once, at burnout, with the stand's
T-0 and settings and a solver summary that says it converged; a diff names the
setting that changed; and the attribution of an additive model is exact, with
nothing left to interaction, while a coupled one leaves its coupling there
instead of spreading it across the groups.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend import main
from backend import runs as run_records
from feedtwin.session.burn import BurnPlan, run_burn

STAR = Path(__file__).resolve().parents[2]
CONFIG = STAR / "EngineDesign" / "configs" / "ethalox_doublet_7000N.yaml"
STAND = (
    Path(__file__).resolve().parents[1] / "backend" / "diagrams" / "ethalox_stand.json"
)


@pytest.fixture(autouse=True)
def _isolate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("USERDATA_DIR", str(tmp_path))


def _record(rid: str, inputs: dict[str, Any], **outcome: float) -> dict[str, Any]:
    return {"id": rid, "inputs": inputs, "outcome": outcome, "code": {"app": "0.2.0"}}


INPUTS: dict[str, Any] = {
    "diagram": "sha256:d1",
    "engine": "sha256:e1",
    "fluid_set": "hotfire",
    "machine": "diablo",
    "multiphase": False,
    "setup": {"vapour": True, "line_walls": True, "dome_psi": 500.0},
    "hookup": {"valves": {}, "knobs": []},
    "knobs": {"lox": 500.0},
    "t0": {"tanks": {"OXT": {"psig": 550.0, "liquid_kg": 6.0}}},
}


def _changed(**changes: Any) -> dict[str, Any]:
    out = run_records.with_swapped(INPUTS, INPUTS, ())
    for key, value in changes.items():
        if key.startswith("setup_"):
            out["setup"][key[6:]] = value
        else:
            out[key] = value
    return out


# ------------------------------------------------------------------- diffing


def test_a_diff_names_the_setting_and_the_outcome_change() -> None:
    a = _record("20261006T000000-aaaaaa", INPUTS, thrust_mean_N=6800.0, of_mean=1.58)
    b = _record(
        "20261006T000001-bbbbbb",
        _changed(setup_line_walls=False),
        thrust_mean_N=6700.0,
        of_mean=1.58,
    )
    d = run_records.diff(a, b)
    assert [c["key"] for c in d["inputs"]] == ["setup.line_walls"]
    assert d["groups"] == ["setting: line_walls"]
    thrust = next(o for o in d["outcome"] if o["key"] == "thrust_mean_N")
    assert thrust["delta"] == pytest.approx(-100.0)
    assert thrust["pct"] == pytest.approx(-100.0 / 6800.0 * 100.0)
    assert run_records.diff(a, a)["inputs"] == []


def test_the_list_says_what_each_run_ran_on() -> None:
    """Two burns on different drawings, or one with the GSE cut away, are not
    comparable; the list says which is which without opening them."""
    whole = run_records.summary(_record("a", INPUTS, thrust_mean_N=7000.0))
    cut = run_records.summary(
        _record("b", _changed(setup_ignore_gse=True), thrust_mean_N=7000.0)
    )
    assert (whole["diagram"], whole["engine"]) == ("sha256:d1", "sha256:e1")
    assert whole["rocket_only"] is False
    assert cut["rocket_only"] is True
    assert run_records.summary({"id": "old"})["diagram"] == ""


def test_swaps_are_one_rung_per_group_and_per_setting() -> None:
    b = _changed(engine="sha256:e2", setup_vapour=False, setup_dome_psi=520.0)
    rungs = dict(run_records.swaps(INPUTS, b))
    assert set(rungs) == {"engine", "setting: dome_psi", "setting: vapour"}
    swapped = run_records.with_swapped(INPUTS, b, rungs["setting: vapour"])
    assert swapped["setup"] == {**INPUTS["setup"], "vapour": False}
    assert swapped["engine"] == INPUTS["engine"], "only the rung's own key moves"


# ------------------------------------------------------------------ the ladder


def _ladder(
    b: Mapping[str, Any], model: Callable[[Mapping[str, Any]], float]
) -> dict[str, Any]:
    def replay(
        inputs: Mapping[str, Any], cancelled: Any
    ) -> tuple[dict[str, float], list[str]]:
        return {"thrust_mean_N": model(inputs)}, []

    explainer = run_records.Explainer()
    assert explainer.start(
        {"id": "a", "inputs": INPUTS}, {"id": "b", "inputs": b}, replay
    )
    assert explainer._thread is not None
    explainer._thread.join(10.0)
    assert explainer.state["stage"] == "done", explainer.state
    (thrust,) = explainer.state["attribution"]
    return thrust  # type: ignore[no-any-return]


def test_an_additive_change_is_attributed_exactly() -> None:
    def model(i: Mapping[str, Any]) -> float:
        return (
            6000.0
            + 2.0 * float(i["setup"]["dome_psi"])
            - (80.0 if not i["setup"]["vapour"] else 0.0)
        )

    thrust = _ladder(_changed(setup_dome_psi=520.0, setup_vapour=False), model)
    parts = {p["label"]: p["delta"] for p in thrust["parts"]}
    assert parts == pytest.approx({"setting: dome_psi": 40.0, "setting: vapour": -80.0})
    assert thrust["total"] == pytest.approx(-40.0)
    assert thrust["interaction"] == pytest.approx(0.0, abs=1e-9)


def test_a_coupled_change_leaves_its_coupling_as_interaction() -> None:
    def model(i: Mapping[str, Any]) -> float:
        dome = float(i["setup"]["dome_psi"]) - 500.0
        vapour = 0.0 if i["setup"]["vapour"] else 1.0
        return 6000.0 + 2.0 * dome - 80.0 * vapour + 3.0 * dome * vapour

    thrust = _ladder(_changed(setup_dome_psi=520.0, setup_vapour=False), model)
    assert thrust["total"] == pytest.approx(2.0 * 20 - 80 + 3.0 * 20)
    assert thrust["interaction"] == pytest.approx(60.0)


# ------------------------------------------------- a burn the cockpit fired


needs_engine = pytest.mark.skipif(
    not CONFIG.exists(), reason="EngineDesign configs absent"
)


@needs_engine
def test_a_cockpit_burn_is_recorded_once_at_burnout() -> None:
    client = TestClient(main.app)
    engine = client.post(
        "/api/library/engines",
        files={
            "file": (
                "runs.yaml",
                CONFIG.read_bytes() + b"\n# runs\n",
                "application/x-yaml",
            )
        },
    ).json()["artifact"]["id"]
    diagram = client.post(
        "/api/library/diagrams",
        files={"file": (STAND.name, STAND.read_bytes(), "application/json")},
    ).json()["artifact"]["id"]
    try:
        opened = client.post(
            "/api/session", params={"diagram": diagram, "engine": engine}, json={}
        )
        assert opened.status_code == 200, opened.text
        sid = opened.json()["id"]
        session = main._SESSIONS[sid]
        run_burn(
            session,
            BurnPlan(
                fill_fraction=0.04,
                horizon_s=4.0,
                end_on_depletion=True,
                settle_max_s=3.0,
            ),
        )
        # The cockpit saw the burn lit; it ticks on until the engine goes out.
        main._OPENED[sid].burning = True
        listed: list[dict[str, Any]] = []
        for _ in range(100):
            ticked = client.post(f"/api/session/{sid}/tick", json={"dt": 0.05})
            assert ticked.status_code == 200, ticked.text
            listed = client.get("/api/twin/runs").json()
            if listed:
                break
        assert len(listed) == 1, listed
        record = client.get(f"/api/twin/runs/{listed[0]['id']}").json()
        assert record["inputs"]["diagram"] == diagram
        assert record["inputs"]["engine"] == engine
        assert record["inputs"]["setup"]["line_walls"] is True
        tanks = record["inputs"]["t0"]["tanks"]
        assert tanks and all(t["liquid_kg"] > 0 for t in tanks.values())
        assert record["outcome"]["thrust_mean_N"] > 1000.0
        assert record["solver"]["ticks"] > 0
        assert record["solver"]["unconverged"] == 0
        # The balance holds on every tick of the burn, the one a tank runs dry
        # on included (test_a_tank_running_dry_burns_no_phantom_propellant).
        clock = record["clock"]
        window = [
            r for r in session.solver_log if clock["start_s"] <= r.t <= clock["end_s"]
        ]
        jumps = [
            b.t
            for a, b in zip(window, window[1:])
            if abs(b.mass_error_kg - a.mass_error_kg) > 1e-6
        ]
        assert not jumps, jumps
        series = record["series"]
        assert len(series["t"]) == len(series["thrust_N"]) > 10
        assert record["code"]["library"]

        # The Engine tab keeps the burn once the history has rolled past it:
        # the recorded one, with its run and its traces.
        live = client.get(f"/api/session/{sid}/burns").json()["burns"]
        assert [b["run_id"] for b in live] == [listed[0]["id"]]
        session.history.clear()
        kept = client.get(f"/api/session/{sid}/burns").json()["burns"]
        assert len(kept) == 1 and kept[0]["run_id"] == listed[0]["id"]
        assert kept[0]["impulse_Ns"] == record["outcome"]["impulse_Ns"]
        assert kept[0]["series"]["thrust_N"] == series["thrust_N"]

        # Another burnout edge records nothing new: a burn is recorded once.
        main._OPENED[sid].burning = True
        client.post(f"/api/session/{sid}/tick", json={"dt": 0.05})
        assert len(client.get("/api/twin/runs").json()) == 1
    finally:
        main.library.remove(engine)
        main.library.remove(diagram)


def test_a_burn_that_cannot_be_recorded_is_said_on_the_console(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A lost record must not stop the stand -- nor go unsaid. It was logged on
    the server and nowhere else: a burn could leave no provenance and the
    operator would never know. Once a record lands, the note goes."""
    client = TestClient(main.app)
    engine = client.post(
        "/api/library/engines",
        files={
            "file": (
                "unrecorded.yaml",
                CONFIG.read_bytes() + b"\n# unrecorded\n",
                "application/x-yaml",
            )
        },
    ).json()["artifact"]["id"]
    diagram = client.post(
        "/api/library/diagrams",
        files={"file": (STAND.name, STAND.read_bytes(), "application/json")},
    ).json()["artifact"]["id"]
    try:
        opened = client.post(
            "/api/session", params={"diagram": diagram, "engine": engine}, json={}
        )
        assert opened.status_code == 200, opened.text
        sid = opened.json()["id"]
        real = main._record_burns

        def full(*args: Any, **kwargs: Any) -> list[dict[str, Any]]:
            raise OSError("disk full")

        monkeypatch.setattr(main, "_record_burns", full)
        main._OPENED[sid].burning = True  # the cockpit saw a burn go out
        ticked = client.post(f"/api/session/{sid}/tick", json={"dt": 0.05})
        assert ticked.status_code == 200, ticked.text
        notes = ticked.json()["notes"]
        assert any("not recorded" in n and "disk full" in n for n in notes), notes

        # The next burnout records whatever the history still holds.
        monkeypatch.setattr(main, "_record_burns", real)
        main._OPENED[sid].burning = True
        notes = client.post(f"/api/session/{sid}/tick", json={"dt": 0.05}).json()[
            "notes"
        ]
        assert not any("not recorded" in n for n in notes), notes
    finally:
        main.library.remove(engine)
        main.library.remove(diagram)


@needs_engine
def test_a_tank_running_dry_burns_no_phantom_propellant() -> None:
    """The step a tank empties on delivers what it held, not the step's flow.

    It used to stop debiting the tank while the network went on delivering
    to the engine -- 17-25 g on the ethalox stand that no vessel gave
    (2026-10-06). The step now ends where the tank does (`Session._dry_cut`).
    Booking the overdraw as a guard would close the balance too, and is not
    a fix: the engine would still have burned it. So the guards must stay
    quiet as well.
    """
    from feedtwin.pid import read_diagram  # noqa: F401 - keeps the import cost here

    client = TestClient(main.app)
    engine = client.post(
        "/api/library/engines",
        files={
            "file": (
                "dry.yaml",
                CONFIG.read_bytes() + b"\n# dry\n",
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
        run_burn(session, BurnPlan(fill_fraction=0.04, horizon_s=4.0, settle_max_s=3.0))
        # The burn stops reading at dry_kg; the stand, like the cockpit, goes on.
        for _ in range(10):
            session.step(0.05)
        last = session.solver_log[-1]
        assert abs(last.mass_error_kg - last.guard_kg) < 1e-4 * last.throughput_kg
        assert abs(last.guard_kg) < 1e-4 * last.throughput_kg
    finally:
        main.library.remove(engine)
        main.library.remove(diagram)
