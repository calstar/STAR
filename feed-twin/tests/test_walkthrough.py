"""The whole pad sequence, driven the way an operator drives it.

Open the shipped stand, and take it from a cold, empty, unpressurised state to a
lit engine using nothing but the state buttons and the tick -- Idle, Armed, fill
each tank, stand by, charge the bottle, press each tank, calibrate, ready, fire.
Every step asserts the physical consequence a person would look for on the
panel: liquid appearing, the bottle climbing, a tank coming up to pressure, a
chamber lighting.

This test exists because the stand could not be driven at all: ten transition
rows were refused and every fill and press state was a dead end. Nobody noticed
because nothing walked the sequence end to end.
"""

from __future__ import annotations

import pytest

from tests.test_session_api import an_engine, client, ids


def open_stand(**setup: object) -> dict:
    # The suite runs against a fresh library (see conftest.py), which has the
    # shipped drawings but no engine until one is uploaded. Without an engine
    # the chamber is a boundary and nothing can "light", so upload it first.
    diagram, _ = ids()
    engine = an_engine()
    response = client.post(
        f"/api/session?diagram={diagram}&engine={engine}",
        json={"state": "Idle", **setup},
    )
    assert response.status_code == 200, response.text
    return response.json()


def go(session_id: str, state: str) -> dict:
    response = client.post(f"/api/session/{session_id}/command", json={"state": state})
    assert response.status_code == 200, f"{state}: {response.text}"
    body = response.json()
    assert body["state"] == state, f"asked for {state}, stand is in {body['state']}"
    return body


def run(session_id: str, seconds: float, dt: float = 0.25) -> dict:
    body: dict = {}
    steps = max(int(seconds / dt), 1)
    for _ in range(steps):
        response = client.post(f"/api/session/{session_id}/tick", json={"dt": dt})
        assert response.status_code == 200, response.text
        body = response.json()
    return body


def tank(state: dict, key: str) -> dict:
    return next(t for t in state["tanks"] if t["id"] == key)


def test_an_operator_can_take_the_stand_from_cold_to_fire() -> None:
    # Fast fills, so the sequence runs in seconds rather than minutes.
    state = open_stand(copv_fill_s=2.0, tank_fill_s=2.0, fuel_fill_s=2.0, dome=500.0)
    sid = state["id"]
    assert state["state"] == "Idle"
    for vessel in state["tanks"] + state["bottles"]:
        assert vessel["pressure_psi"] == pytest.approx(0.0, abs=1.0), "cold stand"
    for t in state["tanks"]:
        assert t["liquid_mass_kg"] == 0.0

    # Arm, then load the oxidiser.
    go(sid, "Armed")
    go(sid, "Ox Fill")
    state = run(sid, 3.0)
    ox_id = next(
        t["id"]
        for t in state["tanks"]
        if "ox" in t["id"].lower() or "lox" in t["id"].lower()
    )
    fu_id = next(t["id"] for t in state["tanks"] if t["id"] != ox_id)
    assert tank(state, ox_id)["liquid_mass_kg"] > 1.0, "LOX should be arriving"
    assert tank(state, fu_id)["liquid_mass_kg"] == 0.0, "only the ox tank is filling"

    # Back through Armed to load the fuel.
    go(sid, "Armed")
    go(sid, "Fuel Fill")
    state = run(sid, 3.0)
    assert tank(state, fu_id)["liquid_mass_kg"] > 1.0, "ethanol should be arriving"

    # Charge the bottle.
    go(sid, "Armed")
    go(sid, "Press Standby")
    go(sid, "GN2 High Press")
    state = run(sid, 3.0)
    bottle = state["bottles"][0]
    assert (
        bottle["pressure_psi"] > 1000.0
    ), f"COPV should be charging, reads {bottle['pressure_psi']}"

    # Press each tank through its regulator.
    go(sid, "Press Standby")
    go(sid, "Ox Press")
    state = run(sid, 2.0)
    assert (
        tank(state, ox_id)["pressure_psi"] > 300.0
    ), "ox tank should come up to pressure"
    go(sid, "Press Standby")
    go(sid, "Fuel Press")
    state = run(sid, 2.0)
    assert (
        tank(state, fu_id)["pressure_psi"] > 300.0
    ), "fuel tank should come up to pressure"

    # Calibrate, ready, fire -- the only legitimate route to Fire.
    go(sid, "Press Standby")
    go(sid, "GN2 High Press")
    go(sid, "Calibrate")
    go(sid, "Ready")
    before = run(sid, 0.5)
    cold = (before.get("engine") or {}).get("chamber_psi", 0.0)
    assert cold == pytest.approx(0.0, abs=1.0), "cold chamber before Fire"
    go(sid, "Fire")
    # A burn is integrated live, like every other state -- the operator sees
    # the chamber light on the next ticks. (It used to be computed ahead and
    # replayed, and the ten-second "Running sim..." freeze read as Fire doing
    # nothing.)
    state = run(sid, 0.25)
    assert not state.get("computing"), "Fire integrates live; nothing is computed ahead"
    state = run(sid, 1.0, dt=0.05)
    engine = state.get("engine") or {}
    assert engine.get("chamber_psi", 0.0) > 100.0, f"the engine should light: {engine}"
    thrust = next((v for k, v in engine.items() if k.startswith("thrust")), 0.0)
    assert thrust > 1000.0, f"thrust should follow: {engine}"
    assert (
        tank(state, ox_id)["liquid_mass_kg"] < tank(before, ox_id)["liquid_mass_kg"]
    ), "LOX is being burned"

    # Burnout. The fuel tank (8.67 L, 6.5 kg) runs dry in about six seconds
    # and the sequence goes to Vent on its own, as the stand's timed fire
    # does: mains shut, both tank vents and the manifold vent open, so the
    # tanks dump instead of sitting at lockup with the regulator holding
    # them there.
    for _ in range(60):
        state = run(sid, 0.5)
        if state["state"] != "Fire":
            break
    assert (
        state["state"] == "Vent"
    ), f"Fire should end in Vent at burnout: {state['state']}"
    assert any("Burnout" in n for n in state["notes"]), state["notes"]
    state = run(sid, 3.0)
    assert (
        tank(state, fu_id)["pressure_psi"] < 100.0
    ), f"the fuel tank should be venting after burnout: {tank(state, fu_id)['pressure_psi']}"


def test_the_route_to_fire_goes_through_ready() -> None:
    """Idle can never reach Fire in two moves, whatever the ragged rows say."""
    state = open_stand()
    sid = state["id"]
    refused = client.post(f"/api/session/{sid}/command", json={"state": "Fire"})
    assert refused.status_code in (400, 409, 422), refused.text
    go(sid, "Armed")
    refused = client.post(f"/api/session/{sid}/command", json={"state": "Fire"})
    assert refused.status_code in (400, 409, 422), refused.text
