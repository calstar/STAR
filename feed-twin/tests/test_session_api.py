"""The session API under abuse.

Everything here is a way somebody -- or a script, or a browser that was in a
background tab for a minute -- can hand the stand something it did not expect.
None of them may crash it, hang it, or produce a number that is not a number.
The physics is covered in test_session; this is about the edges of the door.
"""

from __future__ import annotations

import random
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.main import app

client = TestClient(app)


#: The drawing these tests are written against: the shipped GN2 study stand.
#: Picked by name, never "the first drawing in the library": other tests upload
#: theirs, and under ``pytest -n`` one landed first and a walkthrough pressed a
#: different stand.
DRAWING_SOURCE = "shipped:copv_study_gn2.json"


def ids() -> tuple[str, str]:
    library = client.get("/api/library").json()
    drawings = [a for a in library if a["kind"] == "diagram"]
    diagram = next(
        (a for a in drawings if a.get("source") == DRAWING_SOURCE), drawings[0]
    )["id"]
    engine = next((a for a in library if a["kind"] == "engine"), {"id": ""})["id"]
    return diagram, engine


def open_session(**setup: object) -> dict:
    diagram, engine = ids()
    response = client.post(
        f"/api/session?diagram={diagram}&engine={engine}",
        json={"state": "Idle", **setup},
    )
    assert response.status_code == 200, response.text
    return response.json()


def tick(session_id: str, dt: float = 0.25) -> dict:
    response = client.post(f"/api/session/{session_id}/tick", json={"dt": dt})
    assert response.status_code == 200, response.text
    return response.json()


def command(session_id: str, **body: object) -> dict:
    response = client.post(f"/api/session/{session_id}/command", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def sane(state: dict) -> None:
    """Every number on screen is a number, and a plausible one."""
    for tag, value in state["pressure_psi"].items():
        assert value == value, f"{tag} is NaN"
        # Gauge: a vented line reads 0.0 and a stub a hair below ambient reads
        # slightly negative; what a gauge can never read is below vacuum.
        assert -14.7 <= value < 1.0e6, f"{tag} = {value}"
    for vessel in state["tanks"] + state["bottles"]:
        assert vessel["liquid_mass_kg"] >= 0.0
        # Gauge: an empty vessel open to atmosphere reads exactly 0.0.
        assert vessel["pressure_psi"] >= -14.7
        assert 0.0 <= vessel["fill_fraction"] <= 1.0


# ------------------------------------------------------------------ the door


def test_a_cold_stand_is_empty() -> None:
    state = open_session()
    for vessel in state["tanks"]:
        assert vessel["liquid_mass_kg"] == 0.0
        assert vessel["pressure_psi"] == pytest.approx(
            0.0, abs=1.0
        )  # gauge: vented reads zero
    for bottle in state["bottles"]:
        assert bottle["pressure_psi"] == pytest.approx(0.0, abs=2.0)
    assert any("not charged" in n for n in state["notes"])


def test_absurd_setup_is_clamped_not_obeyed() -> None:
    setup = open_session(copv_target=1e9, copv_fill_s=-5, tank_fill_s=0, dome=-100)[
        "setup"
    ]
    assert 100.0 <= setup["copv_target"] <= 10000.0
    assert setup["copv_fill_s"] >= 1.0 and setup["tank_fill_s"] >= 1.0
    assert setup["dome"] >= 0.0


def test_garbage_setup_is_ignored_rather_than_fatal() -> None:
    setup = open_session(copv_target="banana", dome=None)["setup"]
    assert setup["copv_target"] > 0.0


def test_a_huge_step_is_clamped() -> None:
    """A tab that was in the background for a minute must resume, not integrate
    a minute of stand in one explicit step. Time warp lets a tick carry a few
    seconds (MAX_TICK_S), but as the session's own small steps."""
    from backend.main import MAX_TICK_S

    state = open_session()
    after = tick(state["id"], dt=1.0e6)
    assert after["t"] <= MAX_TICK_S + 0.01
    solver = client.get(f"/api/session/{state['id']}/solver").json()
    assert solver["summary"]["ticks"] >= 0.8 * MAX_TICK_S / 0.02, "one big step"


@pytest.mark.parametrize("dt", [-1.0, 0.0, 1e-12])
def test_a_nonsense_step_survives(dt: float) -> None:
    state = open_session()
    sane(tick(state["id"], dt=dt))


def test_an_unknown_state_is_refused() -> None:
    state = open_session()
    response = client.post(
        f"/api/session/{state['id']}/command", json={"state": "Nonsense"}
    )
    assert response.status_code == 404


def test_an_illegal_transition_is_refused_with_the_legal_ones() -> None:
    state = open_session()
    response = client.post(
        f"/api/session/{state['id']}/command", json={"state": "Fire"}
    )
    assert response.status_code == 409
    assert "Armed" in response.json()["detail"]


def test_a_missing_session_is_a_404_not_a_crash() -> None:
    assert (
        client.post("/api/session/deadbeef/tick", json={"dt": 0.1}).status_code == 404
    )


# ----------------------------------------------------------------- the stand


def test_mashing_valves_never_produces_a_nonsense_reading() -> None:
    state = open_session(copv_fill_s=4, tank_fill_s=4, fuel_fill_s=4)
    valves = list(state["open"])
    random.seed(7)
    for _ in range(60):
        state = command(
            state["id"], valve=random.choice(valves), open=random.random() < 0.5
        )
        sane(tick(state["id"]))


def test_walking_the_state_machine_at_random_stays_sane() -> None:
    state = open_session(copv_fill_s=4, tank_fill_s=4, fuel_fill_s=4)
    random.seed(11)
    for _ in range(80):
        target = random.choice(state["reachable"]) if state["reachable"] else "Idle"
        state = command(state["id"], state=target)
        sane(tick(state["id"]))


def test_firing_empty_tanks_makes_no_thrust() -> None:
    """A pressurised stand with nothing loaded is a real mistake somebody can
    make, and it must not look like a successful burn."""
    # Placed directly rather than walked through Armed -> Press Standby -> ...
    #
    # The shipped engine transition table has 10 malformed rows, `Armed` among
    # them, and `can_go` now fails *closed* on a row it could not read -- so
    # that walk is refused, correctly. See
    # `backend/statemachines/NEEDS-REPAIR.md`. What this test is actually about
    # is that a dry stand does not look like a successful burn; the route to
    # Fire is scaffolding, and it should not be the thing that breaks when the
    # table is repaired either.
    state = open_session(copv_fill_s=4, state="Fire")
    for _ in range(12):
        state = tick(state["id"])
    # With an engine attached the claim is about thrust; without one it is
    # about flow. Either way a dry stand must not look like a successful burn.
    if state["engine"] is not None:
        assert state["engine"]["thrust_N"] < 100.0
    # The mains specifically. Pressurant still flows in Fire -- the press
    # valves are open -- and that is correct; what must not happen is
    # propellant leaving a tank that has none.
    mains = {k: v for k, v in state["flow_kg_s"].items() if k.startswith("MV")}
    assert mains, "the drawing should have main valves"
    assert all(abs(f) < 1e-4 for f in mains.values()), mains
    assert any("empty" in n for n in state["notes"])


def test_the_history_is_rectangular() -> None:
    state = open_session()
    for _ in range(25):
        tick(state["id"])
    history = client.get(f"/api/session/{state['id']}/history").json()
    assert len(history["times_s"]) > 10
    for channel in history["channels"]:
        assert len(channel["values"]) == len(history["times_s"])


def test_a_setting_the_client_did_not_send_is_kept() -> None:
    """`_setup`'s docstring promises "anything unsent is kept", and building the
    dataclass field by field made that false: every dial outside the four listed
    silently reverted to its class default. Nudging the dome turned ullage
    collapse back on."""
    from backend.main import _setup
    from backend.session import Setup

    base = Setup(ullage_collapse=False, ullage_vapour=True, chilldown=50.0)
    after = _setup({"dome": 480.0}, base)
    assert after.dome_psi == 480.0
    assert after.ullage_collapse is False
    assert after.ullage_vapour is True
    assert after.chilldown == 50.0


def test_the_phase_14_toggles_are_reachable_from_the_client() -> None:
    from backend.main import _setup
    from backend.session import Setup

    # On by default on the cockpit since 2026-09-11 -- a LOX tank that cannot
    # boil cannot climb with its vent shut -- and switchable from the client
    # either way. The library's own defaults are still off.
    assert Setup().ullage_vapour is True
    assert Setup().chilldown == 100.0
    assert Setup().ambient_leak == 8.0

    off = _setup(
        {"ullage_vapour": False, "chilldown": 0.0, "ambient_leak": 0.0}, Setup()
    )
    assert (
        off.ullage_vapour is False and off.chilldown == 0.0 and off.ambient_leak == 0.0
    )
    on = _setup({"ullage_vapour": True, "chilldown": 75.0}, off)
    assert on.ullage_vapour is True
    assert on.chilldown == 75.0
    # and clamped, like every other dial
    assert _setup({"chilldown": -5.0}, Setup()).chilldown == 0.0
    assert _setup({"chilldown": 1e9}, Setup()).chilldown == 5000.0


def shipped_stand() -> tuple[str, str]:
    """The stand as it ships, imported fresh.

    Deliberately not "whichever diagram is first in the library": the library
    accumulates artifacts across a run and the ordering is whatever the other
    tests left behind, so a test asserting particular *readings* has to say which
    drawing it means. Content addressing makes re-importing free.
    """
    source = (
        Path(__file__).resolve().parent.parent
        / "backend"
        / "diagrams"
        / "ethalox_stand.json"
    )
    response = client.post(
        "/api/library/diagrams",
        files={"file": (source.name, source.read_bytes(), "application/json")},
    )
    assert response.status_code == 200, response.text
    library = client.get("/api/library").json()
    engine = next((a for a in library if a["kind"] == "engine"), {"id": ""})["id"]
    return response.json()["artifact"]["id"], engine


def open_shipped(**setup: object) -> dict:
    diagram, engine = shipped_stand()
    response = client.post(
        f"/api/session?diagram={diagram}&engine={engine}",
        json={"state": "Idle", **setup},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_a_cold_stand_reads_atmosphere_on_every_gauge() -> None:
    """The frame the UI paints on open.

    Nothing is loaded, nothing is pressurised and every valve is shut, so every
    transducer must read atmosphere. Two of them used to read the *design chamber
    pressure* -- 420 psi on a stand holding nothing -- because the only clip that
    resolved past a main valve was the ENGINE symbol, which is a fixed-pressure
    boundary, and because the chamber node kept the drawing's design pressure
    until the first tick overwrote it.
    """
    state = open_shipped()
    assert state["state"] == "Idle"
    pressures = state["pressure_psi"]
    assert pressures, "the stand should have transducers"
    for tag, value in pressures.items():
        assert value == pytest.approx(
            0.0, abs=0.1
        ), f"{tag} reads {value:.2f} psi on a cold stand"


def test_the_gauges_stay_at_atmosphere_while_idle() -> None:
    """Not just the first frame -- nothing should drift while the stand sits."""
    state = open_shipped()
    for _ in range(8):
        state = tick(state["id"])
    for tag, value in state["pressure_psi"].items():
        assert value == pytest.approx(0.0, abs=0.1), f"{tag} drifted to {value:.2f} psi"


def an_engine() -> str:
    """The 7000N doublet in the test library, imported here.

    The suite runs against a temp store (see conftest) which the shipped
    *drawings* seed into but no engine does, so a test needing one has to supply
    it rather than skip -- a skipped test is not a test.

    Always this engine, never "whichever engine is in the library": other tests
    upload theirs, and under ``pytest -n`` which one a worker met first decided
    the fire load a walkthrough pressed. The store keys an artifact by its
    bytes, so importing it again returns the same one.
    """
    config = (
        Path(__file__).resolve().parents[2]
        / "EngineDesign"
        / "configs"
        / "ethalox_doublet_7000N.yaml"
    )
    if not config.exists():
        pytest.skip("EngineDesign configs are not present")
    response = client.post(
        "/api/library/engines",
        files={"file": (config.name, config.read_bytes(), "application/x-yaml")},
    )
    assert response.status_code == 200, response.text
    return response.json()["artifact"]["id"]


def test_node_temperatures_are_live_not_frozen_at_build() -> None:
    """Node temperatures were set once when the network was built and never
    written again, while the vessel models tracked cooling carefully -- a LOX
    ullage genuinely at 268.7 K reported as the 293.15 K it was born with. That
    is ~9% on density and ~4.5% on every flow out of that node, and it grew
    through a burn.
    """
    from backend.main import _cea_for, engine_from_bytes
    from backend.session import Session, Setup
    from backend.statemachine import bind, load_machine
    from backend.assembly import assemble
    import backend.main as api
    import backend.benchmark_study as study

    engine_id = an_engine()
    if study.find_diagram(api.library, "gn2") is None:
        pytest.skip("no gn2 study drawing")
    design = engine_from_bytes(api.library.path(engine_id).read_bytes(), name="e")
    session = study._stand(
        api.library, "gn2", engine_id, _cea_for(design), litres=None, collapse=False
    )
    session.state = "Fire"
    for _ in range(12):
        sample = session.step(0.05)

    tank = session.tanks["OXT"]
    ullage = tank.tank.gas_temperature(tank.state)
    assert ullage < 285.0, "the ullage should have cooled by now"
    assert sample.temperatures[tank.ullage_node] == pytest.approx(
        ullage, abs=1.0
    ), "the node must carry the temperature the vessel actually is"


def test_joule_thomson_falls_out_of_enthalpy_conservation() -> None:
    """Nitrogen cools through a throttle and helium warms, and neither is
    special-cased anywhere -- both come from carrying enthalpy across the
    regulator and re-solving T at the outlet pressure."""
    from backend.main import _cea_for, engine_from_bytes
    import backend.main as api
    import backend.benchmark_study as study

    engine_id = an_engine()
    design = engine_from_bytes(api.library.path(engine_id).read_bytes(), name="e")

    drop = {}
    for gas in ("gn2", "he"):
        if study.find_diagram(api.library, gas) is None:
            pytest.skip(f"no {gas} drawing")
        session = study._stand(
            api.library, gas, engine_id, _cea_for(design), litres=None, collapse=False
        )
        session.state = "Fire"
        for _ in range(12):
            sample = session.step(0.05)
        drop[gas] = sample.temperatures["MF2"] - sample.temperatures["MF1"]

    assert -34.0 < drop["gn2"] < -26.0, f"N2 should cool ~30 K, got {drop['gn2']:.1f}"
    assert 8.0 < drop["he"] < 22.0, f"He should warm, got {drop['he']:.1f}"
    assert drop["he"] > 0.0 > drop["gn2"], "the two gases must move opposite ways"


def test_each_tank_says_which_leg_it_is_on() -> None:
    """The pad guide finds the LOX tank by this. It used to match "ox" in the
    label, and on a drawing tagged TK-2 / TK-3 it watched the empty fuel tank
    for the LOX load forever."""
    state = open_session()
    sides = {t["label"]: t["side"] for t in state["tanks"]}
    assert sorted(sides.values()) == ["fuel", "lox"], sides
    assert all(b["side"] == "" for b in state["bottles"])


def test_a_lox_loads_chilldown_can_be_skipped() -> None:
    """Nobody rehearsing waits out the minutes a LOX load spends chilling the
    wall (the team, 2026-10-08). ``skip_chill`` puts it where the chill leaves
    it and the pour collects from there; an unknown tank is a 404."""
    sid = open_session()["id"]
    command(sid, state="Armed")
    command(sid, state="Ox Fill")
    for _ in range(4):
        state = tick(sid)
    lox = next(t for t in state["tanks"] if t["side"] == "lox")
    assert lox["chilling"] and lox["liquid_mass_kg"] == 0.0

    lox = next(t for t in command(sid, skip_chill=True)["tanks"] if t["side"] == "lox")
    assert not lox["chilling"] and lox["wall_temperature_K"] < 100.0
    for _ in range(8):
        state = tick(sid)
    lox = next(t for t in state["tanks"] if t["side"] == "lox")
    assert not lox["chilling"] and lox["liquid_mass_kg"] > 0.0

    unknown = client.post(
        f"/api/session/{sid}/command", json={"skip_chill": "no-such-tank"}
    )
    assert unknown.status_code == 404


def test_the_history_says_when_each_state_began() -> None:
    """The plots draw a rule where the stand changed state: every change in the
    window, from the unthinned history, however hard the trace is thinned."""
    state = open_session()
    tick(state["id"], dt=0.5)
    command(state["id"], state="Armed")
    tick(state["id"], dt=0.5)
    history = client.get(
        f"/api/session/{state['id']}/history", params={"seconds": 60, "max_points": 3}
    ).json()
    assert [e["label"] for e in history["events"]] == ["Armed"]
    assert 0.4 < history["events"][0]["t"] < 0.6


# ------------------------------------------------- what the door must refuse


def _raw(path: str, text: str) -> Any:
    """A body as a script or a stand file might send it: JSON with NaN in it,
    which Python's json reads (the TestClient's own would not write one)."""
    return client.post(path, content=text, headers={"content-type": "application/json"})


def test_a_setting_that_is_not_a_number_is_refused_and_changes_nothing() -> None:
    """NaN passed every clamp (``max(nan, low)`` is nan): a COPV target of
    'nan' made every later tick and command a 500 until a good one was sent,
    and a dome of NaN read psig null on every frame. Refused now,
    naming the row, before the stand is touched; it goes on ticking."""
    state = open_session()
    sid = state["id"]
    before = state["setup"]
    for body in (
        {"setup": {"copv_target": "nan"}},
        {"setup": {"dome": "inf"}},
        {"setup": {"copv_target": "lots"}},
        {"setup": {"line_walls": "maybe"}},
        {"setup": {"pressurant": "argon"}},
    ):
        r = client.post(f"/api/session/{sid}/command", json=body)
        assert r.status_code == 422, (body, r.text)
        key = next(iter(body["setup"]))
        assert key in r.json()["detail"], r.text
    r = _raw(f"/api/session/{sid}/command", '{"setup": {"live_step": NaN}}')
    assert r.status_code == 422 and "live_step" in r.json()["detail"], r.text
    r = _raw(f"/api/session/{sid}/command", '{"dome": NaN}')
    assert r.status_code == 422 and "dome" in r.json()["detail"], r.text
    after = tick(sid)
    assert after["setup"] == before
    command(sid, state="Armed")
    sane(tick(sid))


def test_a_knob_that_is_not_a_number_is_refused() -> None:
    """The knob clamp let NaN through too: a dome knob of 'nan' was a 200, the
    dial read null and T-0 primed the tanks off it with nothing said."""
    state = open_session()
    sid = state["id"]
    if not state["knobs"]:
        pytest.skip("this stand has no knob")
    knob = state["knobs"][0]
    for value in ("nan", "inf", "-inf"):
        r = client.post(
            f"/api/session/{sid}/command",
            json={"knob": {"id": knob["id"], "value": value}},
        )
        assert r.status_code == 422, (value, r.text)
    assert tick(sid)["knobs"][0]["psig"] == knob["psig"]


def test_a_flag_written_false_is_off() -> None:
    """``bool("false")`` is True: the string turned every flag on."""
    sid = open_session(line_walls=True, auto_vent=True)["id"]
    setup = command(sid, setup={"line_walls": "false", "auto_vent": "0"})["setup"]
    assert setup["line_walls"] is False and setup["auto_vent"] is False
    setup = command(sid, setup={"line_walls": "true", "auto_vent": 1})["setup"]
    assert setup["line_walls"] is True and setup["auto_vent"] is True


def test_a_saved_stand_with_an_unreadable_setting_still_opens() -> None:
    """Opening is lenient on purpose (test_garbage_setup_is_ignored...): a stand
    document is opened, an unreadable row in it kept at its default. NaN is one
    more such value, not a session that fails every tick."""
    from backend.session import Setup

    diagram, engine = ids()
    r = _raw(
        f"/api/session?diagram={diagram}&engine={engine}",
        '{"state": "Idle", "copv_target": NaN, "live_step": NaN, "line_walls": "no"}',
    )
    assert r.status_code == 200, r.text
    state = r.json()
    assert state["setup"]["live_step"] == Setup().live_step
    assert state["setup"]["copv_target"] is not None
    assert state["setup"]["line_walls"] is False
    sane(tick(state["id"]))


def test_a_setup_that_is_not_an_object_is_refused() -> None:
    sid = open_session()["id"]
    for setup in ([1], "x", 5):
        r = client.post(f"/api/session/{sid}/command", json={"setup": setup})
        assert r.status_code == 422, (setup, r.text)


def test_a_setting_the_stand_cannot_run_is_undone() -> None:
    """A value every clamp passes can still be one the stand cannot step with.
    It used to stay set, and every tick after failed. The first frame
    after the change is the test: if it fails, the stand keeps the setup it had
    and says why."""
    from backend import main

    state = open_session()
    sid = state["id"]
    session = main._SESSIONS[sid]
    real = session.step

    def step(dt: float) -> Any:
        if session.setup.ambient_leak == 7.25:
            raise ValueError("p=nan is not a finite number")
        return real(dt)

    session.step = step  # type: ignore[method-assign]
    r = client.post(
        f"/api/session/{sid}/command", json={"setup": {"ambient_leak": 7.25}}
    )
    assert r.status_code == 422, r.text
    assert "keeps" in r.json()["detail"]
    assert session.setup.ambient_leak == state["setup"]["ambient_leak"]
    sane(tick(sid))


def test_a_tick_that_cannot_be_read_is_refused_not_a_crash() -> None:
    sid = open_session()["id"]
    for dt in ('"abc"', "NaN", "Infinity", "[1]"):
        r = _raw(f"/api/session/{sid}/tick", '{"dt": %s}' % dt)
        assert r.status_code == 422, (dt, r.text)
        assert "dt" in r.json()["detail"], r.text
    sane(tick(sid))


def test_a_tick_that_fails_leaves_its_traceback_in_the_log(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Every exception in a step came back a 422 and nothing was logged: a
    physics crash in a live burn left no traceback on the server."""
    from backend import main

    sid = open_session()["id"]
    session = main._SESSIONS[sid]

    def step(dt: float) -> Any:
        raise RuntimeError("the solver fell over")

    session.step = step  # type: ignore[method-assign]
    with caplog.at_level("ERROR"):
        r = client.post(f"/api/session/{sid}/tick", json={"dt": 0.1})
    assert r.status_code == 422 and "fell over" in r.json()["detail"]
    logged = [rec for rec in caplog.records if rec.exc_info]
    assert logged and sid in logged[0].getMessage()


def test_an_unknown_valve_is_a_404_not_a_phantom_held_valve() -> None:
    """A valve id the drawing does not have was a 200 and listed as held: the
    console showed '1 held' with nothing to release."""
    state = open_session()
    sid = state["id"]
    for body in ({"valve": "nope", "open": True}, {"release": "nope"}):
        r = client.post(f"/api/session/{sid}/command", json=body)
        assert r.status_code == 404, (body, r.text)
        assert "nope" in r.json()["detail"]
    assert tick(sid)["held"] == []


def test_release_all_releases_every_held_valve() -> None:
    """The console's Release all sends ``release: '*'``, which the server read
    as a valve called '*': it released nothing."""
    state = open_session()
    sid = state["id"]
    valves = sorted(state["open"])[:2]
    for v in valves:
        command(sid, valve=v, open=True)
    assert sorted(tick(sid)["held"]) == valves
    assert command(sid, release="*")["held"] == []
    command(sid, valve=valves[0], open=True)
    assert command(sid, release=valves[0])["held"] == []
