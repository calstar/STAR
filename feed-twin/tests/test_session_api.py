"""The session API under abuse.

Everything here is a way somebody -- or a script, or a browser that was in a
background tab for a minute -- can hand the stand something it did not expect.
None of them may crash it, hang it, or produce a number that is not a number.
The physics is covered in test_session; this is about the edges of the door.
"""

from __future__ import annotations

import random
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.main import app

client = TestClient(app)


def ids() -> tuple[str, str]:
    library = client.get("/api/library").json()
    diagram = next(a for a in library if a["kind"] == "diagram")["id"]
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
    a minute of stand in one explicit step."""
    state = open_session()
    assert tick(state["id"], dt=1.0e6)["t"] < 5.0


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
    # The shipped Diablo transition table has 10 malformed rows, `Armed` among
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
    """An engine in the test library, imported if the seed did not bring one.

    The suite runs against a temp store (see conftest) which the shipped
    *drawings* seed into but no engine does, so a test needing one has to supply
    it rather than skip -- a skipped test is not a test.
    """
    library = client.get("/api/library").json()
    existing = next((a for a in library if a["kind"] == "engine"), None)
    if existing:
        return existing["id"]
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
    import backend.study as study

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
    import backend.study as study

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
