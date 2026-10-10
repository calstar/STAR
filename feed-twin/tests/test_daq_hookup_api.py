"""The DAQ box and the stand's own state table over the API.

The Hookup page shows every drawing as a DAQ box: a hookup nobody wired comes
with the box the twin's name matching amounts to, and saving that box as it
stands changes nothing. Once wired, a state-table row drives the valve on the
connector of its name and nothing else. The state table can be edited and
saved with the hookup; a stand runs it, a run records it, and a rebuilt run
runs it again.

Each check is against what the unwired, shipped-table stand would have done.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator

import pytest

from fastapi.testclient import TestClient

from backend.library import LibraryError
from backend.main import (
    _SESSIONS,
    HOOKUPS,
    _hookup_inputs,
    _lineage,
    _session_from_inputs,
    app,
    library,
)
from backend.runs import group_of

client = TestClient(app)
STAND = (
    Path(__file__).resolve().parents[1] / "backend" / "diagrams" / "ethalox_stand.json"
)
#: LE4 (6): the rocket and a GSE page whose cart charges the COPV and presses
#: a fuel transfer tank.
LE4 = (
    Path(__file__).resolve().parents[2]
    / "lib"
    / "feedtwin"
    / "tests"
    / "fixtures"
    / "le4_rocket_and_gse.json"
)

#: What these tests put in the shared test library, taken out again after each:
#: other tests open "the newest drawing", and a stand left here would become it.
UPLOADED: list[str] = []
#: Sessions these tests opened, dropped again after each.
OPENED: list[str] = []


def upload(name: str, drawing: Path = STAND) -> str:
    """The shipped stand (or ``drawing``) under a name of its own. A node is
    nudged so the bytes -- and so the artifact -- are this test's alone (the
    library is content-addressed: the same bytes come back as whoever
    uploaded them first, lineage and saved hookup included)."""
    payload = json.loads(drawing.read_text())
    payload["nodes"][0]["position"] = {"x": 7000 + len(name), "y": sum(map(ord, name))}
    response = client.post(
        "/api/library/diagrams",
        files={"file": (name, json.dumps(payload).encode(), "application/json")},
    )
    assert response.status_code == 200, response.text
    artifact = response.json()["artifact"]["id"]
    UPLOADED.append(artifact)
    return artifact


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
    for sid in OPENED:
        _SESSIONS.pop(sid, None)
    OPENED.clear()


def get(diagram: str) -> dict[str, Any]:
    response = client.get("/api/hookup", params={"diagram": diagram})
    assert response.status_code == 200, response.text
    out: dict[str, Any] = response.json()
    return out


def save(diagram: str, body: dict[str, Any]) -> dict[str, Any]:
    response = client.put("/api/hookup", params={"diagram": diagram}, json=body)
    assert response.status_code == 200, response.text
    out: dict[str, Any] = response.json()
    return out


def open_stand(diagram: str) -> dict[str, Any]:
    response = client.post(
        "/api/session", params={"diagram": diagram}, json={"state": "Idle"}
    )
    assert response.status_code == 200, response.text
    out: dict[str, Any] = response.json()
    OPENED.append(out["id"])
    return out


def command(sid: str, body: dict[str, Any]) -> Any:
    return client.post(f"/api/session/{sid}/command", json=body)


def go(sid: str, *states: str) -> None:
    for state in states:
        response = command(sid, {"state": state})
        assert response.status_code == 200, (state, response.text)


def opened_valves(sid: str, state: str) -> set[str]:
    """The drawing's valves the session opens in ``state``, by drawing id: the
    state's command with every valve snapped to it. (A Fire that opens no
    main burns out at once and the stand vents itself, so the state is put
    back for the reading.)"""
    session = _SESSIONS[sid]
    built = session.model.built
    session.state = state
    signals = session.signals()
    return {
        d
        for d, s in built.actuators.items()
        if not s.endswith(".dome") and signals[s] > 0.5
    }


def box(*channels: tuple[str, int, str, str]) -> list[dict[str, Any]]:
    return [
        {"board": b, "slot": s, "name": n, "symbol": sym} for b, s, n, sym in channels
    ]


def purge_table(shipped: dict[str, Any]) -> dict[str, Any]:
    """The shipped table with a "Purge" state: opens the fuel vent, reached from
    Idle and back, placed at row 6."""
    table = json.loads(json.dumps(shipped))
    table["states"].append({"name": "Purge", "row": 6, "col": 0, "abort": False})
    table["open"]["Purge"] = ["Fuel Vent"]
    table["allowed"]["Idle"].append("Purge")
    table["allowed"]["Purge"] = ["Idle"]
    return table


# ------------------------------------------------------------------ the box


def test_an_unwired_drawing_shows_the_box_its_matching_amounts_to() -> None:
    diagram = upload("daq box derived.json")
    first = get(diagram)
    assert first["saved"] is False and first["wired"] is False
    channels = first["hookup"]["channels"]
    assert isinstance(channels, list) and channels
    kinds = {s["id"]: s["kind"] for s in first["symbols"]}
    assert {"valve", "pt"} <= set(kinds.values())
    assert kinds["MVO"] == "valve" and kinds["PT_HI"] == "pt"
    assert all(s["board"] for s in first["symbols"])
    assert {b["id"] for b in first["boards"]} >= {"sol12", "sol24", "pt_low"}
    on_valves = {
        c["name"]: c["symbol"] for c in channels if kinds[c["symbol"]] == "valve"
    }
    assert on_valves == first["bound"], "a row's connector is the valve it binds"
    assert first["bound"]["LOX Main"] == "MVO"
    assert any(kinds[c["symbol"]] == "pt" for c in channels), "PTs on their board"

    saved = save(diagram, first["hookup"])
    assert saved["saved"] is True and saved["wired"] is True
    assert saved["bound"] == first["bound"], "saving the box as it is changes nothing"
    assert saved["unmatched"] == first["unmatched"]
    assert saved["hookup"]["channels"] == channels


def test_an_empty_box_commands_no_valve() -> None:
    diagram = upload("daq box empty.json")
    first = get(diagram)
    assert len(first["bound"]) > 2, "matched by name, the rows bind"
    empty = save(diagram, {**first["hookup"], "channels": []})
    assert empty["wired"] is True
    assert empty["bound"] == {}
    assert empty["unmatched"] == empty["actuators"]
    assert empty["hookup"]["channels"] == []

    opened = open_stand(diagram)
    sm = client.get(f"/api/session/{opened['id']}/statemachine").json()
    assert sm["bound"] == {}
    assert all(positions == {} for positions in sm["positions"].values())
    go(opened["id"], "Armed", "Press Standby", "Ready", "Fire")
    assert opened_valves(opened["id"], "Fire") == set()

    # The same drawing unwired opens its mains in Fire: the test can fail.
    client.delete("/api/hookup", params={"diagram": diagram})
    plain = open_stand(diagram)
    go(plain["id"], "Armed", "Press Standby", "Ready", "Fire")
    assert {"MVO", "MVF"} <= opened_valves(plain["id"], "Fire")


def test_one_connector_binds_exactly_that_valve() -> None:
    diagram = upload("daq box one.json")
    one = save(
        diagram,
        {**get(diagram)["hookup"], "channels": box(("sol12", 1, "LOX Main", "MVO"))},
    )
    assert one["bound"] == {"LOX Main": "MVO"}
    assert "Fuel Main" in one["unmatched"]

    opened = open_stand(diagram)
    assert opened["wired"] == ["MVO"]
    assert opened["aliases"]["MVO"] == "LOX Main"
    go(opened["id"], "Armed", "Press Standby", "Ready", "Fire")
    assert opened_valves(opened["id"], "Fire") == {"MVO"}


@pytest.mark.parametrize(
    "channel, said",
    [
        (("sol12", 1, "Bottle", "PT_HI"), "does not plug into"),
        (("sol48", 1, "LOX Main", "MVO"), "no board"),
        (("sol12", 1, "LOX Main", "NOPE"), "not on this drawing"),
    ],
)
def test_a_box_the_drawing_cannot_have_is_refused(
    channel: tuple[str, int, str, str], said: str
) -> None:
    diagram = upload(f"daq box refused {channel[0]} {channel[3]}.json")
    first = get(diagram)
    response = client.put(
        "/api/hookup",
        params={"diagram": diagram},
        json={**first["hookup"], "channels": box(channel)},
    )
    assert response.status_code == 422 and said in response.text, response.text
    assert get(diagram)["saved"] is False, "nothing was written"


def test_two_connectors_of_one_name_are_refused() -> None:
    diagram = upload("daq box twice.json")
    first = get(diagram)
    twice = box(("sol12", 1, "LOX Main", "MVO"), ("sol12", 2, "lox MAIN", "MVF"))
    response = client.put(
        "/api/hookup",
        params={"diagram": diagram},
        json={**first["hookup"], "channels": twice},
    )
    assert response.status_code == 422 and "two connectors" in response.text
    once = box(("sol12", 1, "LOX Main", "MVO"), ("sol12", 2, "Fuel Main", "MVF"))
    assert save(diagram, {**first["hookup"], "channels": once})["bound"] == {
        "LOX Main": "MVO",
        "Fuel Main": "MVF",
    }


# ------------------------------------------------------- the stand's own table


def test_an_edited_table_is_saved_with_the_hookup_and_run() -> None:
    diagram = upload("daq box purge.json")
    first = get(diagram)
    shipped = first["machine_shipped"]
    assert "Purge" not in [s["name"] for s in shipped["states"]]
    saved = save(diagram, {**first["hookup"], "machine": purge_table(shipped)})
    assert saved["hookup"]["machine"] is not None
    assert "Purge" in [s["name"] for s in saved["hookup"]["machine"]["states"]]
    assert saved["machine_shipped"] == shipped, "the DAQ's table is still the DAQ's"
    assert saved["actuators"] == first["actuators"]

    sm = client.get("/api/statemachine", params={"diagram": diagram}).json()
    assert sm["edited"] is True
    assert sm["layout"]["Purge"] == [6, 0]
    assert sm["layout"]["Idle"] == [0, 0]
    assert "Purge" in sm["transitions"]["Idle"]
    assert sm["positions"]["Purge"]["SV_FUEL_VENT"] is True
    assert sorted(sm["aborts"]) == ["Emergency Abort", "Engine Abort", "GSE Abort"]

    opened = open_stand(diagram)
    assert "Purge" in opened["reachable"]
    go(opened["id"], "Purge")
    assert _SESSIONS[opened["id"]].state == "Purge"
    assert opened_valves(opened["id"], "Purge") == {"SV_FUEL_VENT"}
    live = client.get(f"/api/session/{opened['id']}/statemachine").json()
    assert live["edited"] is True and live["table"]["open"]["Purge"] == ["Fuel Vent"]

    # On the shipped table there is no Purge to go to.
    client.delete("/api/hookup", params={"diagram": diagram})
    assert (
        client.get("/api/statemachine", params={"diagram": diagram}).json()["edited"]
        is False
    )
    plain = open_stand(diagram)
    assert command(plain["id"], {"state": "Purge"}).status_code == 404


def test_a_contradictory_table_is_refused_on_save() -> None:
    diagram = upload("daq box bad table.json")
    first = get(diagram)
    table = purge_table(first["machine_shipped"])
    table["allowed"]["Purge"].append("Nowhere")
    response = client.put(
        "/api/hookup",
        params={"diagram": diagram},
        json={**first["hookup"], "machine": table},
    )
    assert response.status_code == 422 and "Nowhere" in response.text
    assert get(diagram)["saved"] is False


def test_checking_a_table_says_what_is_wrong_with_it() -> None:
    diagram = upload("daq box check.json")
    shipped = get(diagram)["machine_shipped"]
    assert set(shipped["open"]["Idle"]) == {"Fuel Main", "LOX Press"}
    checked = client.post("/api/statemachine/check", json=shipped).json()
    assert checked["ok"] is True and checked["error"] == ""
    assert any("Idle commands" in w for w in checked["warnings"]), checked

    quiet = json.loads(json.dumps(shipped))
    quiet["open"]["Idle"] = []
    calm = client.post("/api/statemachine/check", json=quiet).json()
    assert calm["ok"] is True
    assert not any("Idle commands" in w for w in calm["warnings"])

    broken = json.loads(json.dumps(shipped))
    broken["open"]["Nowhere"] = ["LOX Main"]
    refused = client.post("/api/statemachine/check", json=broken).json()
    assert refused["ok"] is False and "Nowhere" in refused["error"]
    assert refused["warnings"] == []


# ---------------------------------------------------------------- live names


def test_a_running_stand_takes_a_new_name_but_not_new_wiring() -> None:
    diagram = upload("daq box names.json")
    first = get(diagram)
    saved = save(diagram, first["hookup"])
    channels = saved["hookup"]["channels"]
    (pt,) = [c for c in channels if c["symbol"] == "PT_HI"]
    opened = open_stand(diagram)
    sid = opened["id"]
    assert opened["aliases"]["PT_HI"] == pt["name"]
    before = dict(_SESSIONS[sid].binding.to_symbol)

    renamed = [
        {**c, "name": "Bottle pressure"} if c["symbol"] == "PT_HI" else c
        for c in channels
    ]
    response = command(sid, {"names": {"aliases": {}, "channels": renamed}})
    assert response.status_code == 200, response.text
    out = response.json()
    assert out["id"] == sid and out["t"] >= opened["t"], "the same stand"
    assert out["aliases"]["PT_HI"] == "Bottle pressure"
    assert dict(_SESSIONS[sid].binding.to_symbol) == before

    # Names alone, without the box: the box stays as it is.
    aliased = command(sid, {"names": {"aliases": {"engine.pc": "Pc"}}})
    assert aliased.status_code == 200, aliased.text
    assert aliased.json()["aliases"]["engine.pc"] == "Pc"
    assert aliased.json()["aliases"]["PT_HI"] == "Bottle pressure"

    moved = [
        {**c, "name": "Ox Main"} if c["name"] == "LOX Main" else c for c in renamed
    ]
    refused = command(sid, {"names": {"aliases": {}, "channels": moved}})
    assert refused.status_code == 409, refused.text
    hookup = _SESSIONS[sid].hookup
    assert hookup is not None
    assert hookup.names()["MVO"] == "LOX Main", "refused, not half done"
    assert hookup.names()["PT_HI"] == "Bottle pressure"


# ----------------------------------------------------------- a stand's own


def test_viewing_a_stands_hookup_binds_it_and_writes_nothing() -> None:
    diagram = upload("daq box view.json")
    first = get(diagram)
    assert len(first["bound"]) > 1
    body = {**first["hookup"], "channels": box(("sol12", 1, "LOX Main", "MVO"))}
    response = client.post("/api/hookup/view", params={"diagram": diagram}, json=body)
    assert response.status_code == 200, response.text
    view = response.json()
    assert view["bound"] == {"LOX Main": "MVO"} and view["wired"] is True
    after = get(diagram)
    assert after["saved"] is False and after["wired"] is False
    assert after["bound"] == first["bound"]


# ---------------------------------------------------------------- run records


def test_a_run_records_an_edited_table_and_a_replay_runs_it() -> None:
    diagram = upload("daq box run.json")
    first = get(diagram)
    plain = open_stand(diagram)
    shipped_inputs = _hookup_inputs(_SESSIONS[plain["id"]])
    assert "machine_table" not in shipped_inputs
    assert "machine" not in shipped_inputs["hookup"]

    save(diagram, {**first["hookup"], "machine": purge_table(first["machine_shipped"])})
    edited = open_stand(diagram)
    inputs = _hookup_inputs(_SESSIONS[edited["id"]])
    assert "machine" not in inputs["hookup"], "the table is not the drawing's"
    table = inputs["machine_table"]
    assert "Purge" in [s["name"] for s in table["states"]]
    # Swapped with the hookup: the box's connector names are the table's rows.
    # Named for both, so a rung that swapped only the table does not read as
    # a different drawing.
    together = group_of("machine_table.states")
    assert together == group_of("hookup.channels") == group_of("diagram")
    assert together == "drawing & hookup"
    assert group_of("machine") == "state machine"

    replay = _session_from_inputs({"diagram": diagram, **inputs})
    assert "Purge" in replay.machine.states
    assert replay.binding.positions_for(replay.machine, "Purge")["SV_FUEL_VENT"] == 1.0
    # Without the recorded table the replay runs the shipped one, whatever
    # the drawing's saved hookup says now.
    bare = _session_from_inputs({"diagram": diagram, **shipped_inputs})
    assert "Purge" not in bare.machine.states


def test_rows_the_twin_reads_by_name_are_named() -> None:
    """The built-in COPV charge and dump follow table rows by name with no
    valve wired to them. The editor must not call them "wired to nothing", so
    the API says which they are -- and only those the stand acts on: the
    shipped stand has no cart transfer tank, so nothing presses one in Fuel
    Fill and Fuel Fill Press is a row like any other."""
    diagram = upload("daq box builtin.json")
    builtin = get(diagram)["builtin"]
    assert set(builtin) == {"GSE High Press Control", "GSE High Press Vent"}
    table = client.get("/api/statemachine", params={"diagram": diagram}).json()
    assert table["builtin"] == builtin
    stand = open_stand(diagram)
    running = client.get(f"/api/session/{stand['id']}/statemachine").json()
    assert running["builtin"] == builtin


@pytest.mark.skipif(not LE4.exists(), reason="LE4 (6) fixture absent")
def test_a_drawn_cart_fill_is_not_built_in_unless_the_cart_is_cut() -> None:
    """LE4 (6) draws the cart charging the COPV: the built-in charge stands
    aside and an unwired GSE High Press Control would charge nothing, so it
    is not built-in -- the cart's transfer tank press is. Rocket only, the
    cart is cut, the built-in charge fills the COPV again and there is no
    transfer tank to press."""
    diagram = upload("daq box builtin LE4.json", LE4)
    for rocket_only in (False, True):
        params = {"diagram": diagram, "ignore_gse": str(rocket_only).lower()}
        builtin = client.get("/api/hookup", params=params).json()["builtin"]
        assert ("GSE High Press Control" in builtin) is rocket_only
        assert ("GSE High Press Vent" in builtin) is rocket_only
        assert ("Fuel Fill Press" in builtin) is not rocket_only
        table = client.get("/api/statemachine", params=params).json()
        assert table["builtin"] == builtin
        opened = client.post(
            "/api/session",
            params={"diagram": diagram},
            json={"state": "Idle", "ignore_gse": rocket_only},
        )
        assert opened.status_code == 200, opened.text
        OPENED.append(opened.json()["id"])
        running = client.get(f"/api/session/{opened.json()['id']}/statemachine")
        assert running.json()["builtin"] == builtin


def test_a_connector_to_a_symbol_the_drawing_lost_is_said_and_matched_by_name() -> None:
    """A redrawn main valve and fuel transducer with new ids: the box still
    names the old ones. The stand opens with LOX Main matched by name, and
    says why; the transducer is matched by nothing, and that is said too."""
    diagram = upload("daq box lost.json")
    first = get(diagram)
    body = {
        **first["hookup"],
        "channels": box(
            ("sol12", 1, "LOX Main", "MVO-old"), ("pt_low", 1, "Fuel tank", "PT-old")
        ),
    }
    # Saving refuses it (not on the drawing); a stand's own hookup carries it.
    assert (
        client.put("/api/hookup", params={"diagram": diagram}, json=body).status_code
        == 422
    )
    opened = client.post(
        "/api/session",
        params={"diagram": diagram},
        json={"state": "Idle", "hookup": body},
    ).json()
    OPENED.append(opened["id"])
    assert _SESSIONS[opened["id"]].binding.to_symbol.get("LOX Main") == "MVO"
    (said,) = [n for n in opened["notes"] if "no longer has" in n]
    assert "matched by name instead: LOX Main (MVO-old)." in said
    assert "not shown until rewired: Fuel tank (PT-old)." in said
    assert "Fuel tank (PT-old)" not in said.split("Sensors")[0], "not matched"
    # Said once: not again as a connector the drawing cannot take.
    assert not [n for n in opened["notes"] if "cannot take" in n]


def test_an_edited_table_without_the_states_the_twin_needs_is_warned() -> None:
    shipped = get(upload("daq box keyed.json"))["machine_shipped"]
    table = {**shipped, "states": [s for s in shipped["states"] if s["name"] != "Vent"]}
    table["open"] = {k: v for k, v in shipped["open"].items() if k != "Vent"}
    table["allowed"] = {
        k: [t for t in v if t != "Vent"]
        for k, v in shipped["allowed"].items()
        if k != "Vent"
    }
    said = client.post("/api/statemachine/check", json=table).json()
    (vent,) = [w for w in said["warnings"] if "keys on" in w]
    assert said["ok"] and "no Vent" in vent
    # Its own reason, not all five.
    assert "Vent" in vent and "Idle" not in vent and "ENG ABORT" not in vent


def test_an_edited_table_with_no_ox_fill_state_is_warned() -> None:
    """The twin loads a tank only in a state named for its fill; renamed, Ox
    Fill loads nothing and the LOX tank is never filled. Said, for the LOX
    side alone."""
    shipped = get(upload("daq box no ox fill.json"))["machine_shipped"]
    table = json.loads(json.dumps(shipped))
    for row in table["states"]:
        if row["name"] == "Ox Fill":
            row["name"] = "Oxidiser Load"
    table["open"] = {
        ("Oxidiser Load" if k == "Ox Fill" else k): v for k, v in table["open"].items()
    }
    table["allowed"] = {
        ("Oxidiser Load" if k == "Ox Fill" else k): [
            "Oxidiser Load" if t == "Ox Fill" else t for t in v
        ]
        for k, v in table["allowed"].items()
    }
    said = client.post("/api/statemachine/check", json=table).json()
    assert said["ok"], said
    (lox,) = [w for w in said["warnings"] if "No state loads" in w]
    assert "LOX tank" in lox and "fuel" not in lox
    shipped_said = client.post("/api/statemachine/check", json=shipped).json()
    assert not [w for w in shipped_said["warnings"] if "No state loads" in w]


def test_viewing_a_stands_hookup_refuses_what_a_save_would() -> None:
    """The panels check a stand's own hookup here before keeping it with the
    stand: a cable on the wrong board must be refused, as a save refuses it.
    A stand that carries one anyway still opens on it -- a stand's own
    hookup is not refused at the door -- and says what is wrong with it."""
    diagram = upload("daq box view refuses.json")
    body = {
        **get(diagram)["hookup"],
        "channels": box(("sol12", 1, "LOX Main", "PT_FUU")),
    }
    refused = client.post("/api/hookup/view", params={"diagram": diagram}, json=body)
    assert refused.status_code == 422, refused.text
    opened = client.post(
        "/api/session",
        params={"diagram": diagram},
        json={"state": "Idle", "hookup": body},
    )
    assert opened.status_code == 200, opened.text
    OPENED.append(opened.json()["id"])
    (said,) = [n for n in opened.json()["notes"] if "cannot take" in n]
    assert "LOX Main" in said and "does not plug into Solenoids 12V" in said
    assert "no longer has" not in " ".join(opened.json()["notes"])


def test_a_stands_hookup_with_a_lost_cable_still_shows_so_it_can_be_unplugged() -> None:
    """A stand kept a cable to a symbol a later drawing dropped. The panels
    load it with ``check=false`` and say what is wrong, or the user could
    never reach the DAQ box to unplug it; a save still refuses it."""
    diagram = upload("daq box lost view.json")
    body = {
        **get(diagram)["hookup"],
        "channels": box(("sol12", 1, "LOX Main", "MVO-old")),
    }
    params = {"diagram": diagram}
    assert client.post("/api/hookup/view", params=params, json=body).status_code == 422
    shown = client.post(
        "/api/hookup/view", params={**params, "check": "false"}, json=body
    )
    assert shown.status_code == 200, shown.text
    problems = shown.json()["problems"]
    assert len(problems) == 1 and "MVO-old" in problems[0]
    # Unplugged, nothing is wrong.
    clean = client.post(
        "/api/hookup/view",
        params={**params, "check": "false"},
        json={**body, "channels": []},
    ).json()
    assert clean["problems"] == []


@pytest.mark.skipif(not LE4.exists(), reason="LE4 (6) fixture absent")
def test_a_disconnect_is_never_on_the_daq_box() -> None:
    """LE4 (6)'s LOX tank vents through a QD to the cart's vent valves. No
    cable runs to a QD: it is not a symbol the box takes, the suggested box
    does not plug a row onto it (rocket only it still stands in for the cut
    cart's vent, by the binding), and a cable to it is refused."""
    diagram = upload("daq box no QD.json", LE4)
    doc = json.loads(LE4.read_text())
    qds = {
        n["id"]
        for n in doc["nodes"]
        if (n.get("data") or {}).get("componentType", n.get("type")) == "QD"
    }
    assert qds
    for rocket_only in (False, True):
        params = {"diagram": diagram, "ignore_gse": str(rocket_only).lower()}
        out = client.get("/api/hookup", params=params).json()
        assert not qds & {s["id"] for s in out["symbols"]}
        assert not qds & {c["symbol"] for c in out["hookup"]["channels"]}
    # Rocket only, the vent row still reaches the capped disconnect.
    cut = client.get(
        "/api/hookup", params={"diagram": diagram, "ignore_gse": "true"}
    ).json()
    assert qds & set(cut["bound"].values())
    qd = sorted(qds)[0]
    body = {**get(diagram)["hookup"], "channels": box(("sol12", 1, "LOX Vent", qd))}
    refused = client.put("/api/hookup", params={"diagram": diagram}, json=body)
    assert refused.status_code == 422 and "disconnect" in refused.text
