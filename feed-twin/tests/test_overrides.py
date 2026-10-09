"""Operator overrides on a drawing, and console visibility.

The properties that matter: nothing overridden is exactly the old behaviour; an
override reaches the physics, not just the listing; it survives a re-import of
the same drawing; it says who and why; and a re-import that moved the number
underneath it is flagged.
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from backend.main import app, library, overrides
from backend.overrides import apply_overrides
from feedtwin.pid import read_diagram

client = TestClient(app)


def stand_id() -> str:
    diagrams = client.get("/api/library?kind=diagram").json()
    return next(d["id"] for d in diagrams if "ethalox_stand" in d["source"])


def bottle_volume(view: dict) -> dict:
    kb = next(e for e in view["elements"] if e["id"] == "KB1")
    return next(p for p in kb["params"] if p["name"] == "volume")


def setup_function() -> None:
    overrides.path.unlink(missing_ok=True)


# ------------------------------------------------------------ the default


def test_nothing_stored_returns_the_same_drawing() -> None:
    raw = json.loads(library.read(stand_id()))
    diagram = read_diagram(raw)
    same, applied = apply_overrides(diagram, overrides.entry("nope"))
    assert same is diagram and applied == ()


def test_an_override_on_a_symbol_the_drawing_lacks_changes_nothing() -> None:
    diagram = read_diagram(json.loads(library.read(stand_id())))
    entry = {
        "params": {"GONE": {"volume": {"value": 9, "unit": "L", "source": "measured"}}}
    }
    same, applied = apply_overrides(diagram, entry)
    assert same is diagram and applied == ()


def test_the_model_report_is_clean_without_overrides() -> None:
    view = client.get("/api/model", params={"diagram": stand_id()}).json()
    assert view["report"]["overrides"] == []
    assert view["report"]["overrides_hash"] == ""
    assert view["console_hidden"] == []


# ------------------------------------------------------------- overriding


def put(element: str, parameter: str, value: float, unit: str, **extra):
    body = {
        "diagram": stand_id(),
        "element": element,
        "parameter": parameter,
        "value": value,
        "unit": unit,
        "source": "measured",
        "reference": "weighed it",
        **extra,
    }
    return client.put(
        "/api/drawing/override", json=body, headers={"X-Auth-Email": "a@b.c"}
    )


def test_the_drawing_view_lists_what_was_read() -> None:
    view = client.get("/api/drawing", params={"diagram": stand_id()}).json()
    volume = bottle_volume(view)
    assert volume["drawing"]["value"] == 4.6871
    assert volume["effective"] == volume["drawing"]
    assert volume["override"] is None
    assert "L" in volume["units"] and len(volume["units"]) > 1
    kb = next(e for e in view["elements"] if e["id"] == "KB1")
    assert kb["on_console"], "a bottle is drawn on the console"


def test_an_override_reaches_the_stand_and_the_report() -> None:
    sid = stand_id()
    before = client.post(
        "/api/session", params={"diagram": sid}, json={"state": "Idle"}
    ).json()
    assert put("KB1", "volume", 9.0, "L").status_code == 200

    view = client.get("/api/drawing", params={"diagram": sid}).json()
    volume = bottle_volume(view)
    assert volume["override"]["by"] == "a@b.c"
    assert volume["override"]["was"]["value"] == 4.6871
    assert volume["effective"]["value"] == 9.0
    assert not volume["stale"]
    assert view["overrides_hash"]

    after = client.post(
        "/api/session", params={"diagram": sid}, json={"state": "Idle"}
    ).json()
    bottle = lambda s: next(b for b in s["bottles"] if b["id"] == "KB1")  # noqa: E731
    assert bottle(before)["volume_L"] == 4.69
    assert (
        bottle(after)["volume_L"] == 9.0
    ), "the override must reach the vessel, not just the listing"
    assert after["overrides_hash"] == view["overrides_hash"] != before["overrides_hash"]

    model = client.get("/api/model", params={"diagram": sid}).json()
    [o] = model["report"]["overrides"]
    assert (o["component"], o["parameter"], o["value"]) == ("KB1", "volume", 9.0)

    assert (
        client.delete(
            "/api/drawing/override",
            params={"diagram": sid, "element": "KB1", "parameter": "volume"},
        ).status_code
        == 200
    )
    back = bottle_volume(client.get("/api/drawing", params={"diagram": sid}).json())
    assert back["override"] is None and back["effective"]["value"] == 4.6871
    assert not overrides.path.exists() or json.loads(overrides.path.read_text()) == {}


def test_an_override_needs_a_source_and_a_reference() -> None:
    assert put("KB1", "volume", 9.0, "L", source="default").status_code == 422
    assert put("KB1", "volume", 9.0, "L", reference="  ").status_code == 422
    assert put("KB1", "volume", 9.0, "psi").status_code == 422, "wrong dimension"
    assert put("NOPE", "volume", 9.0, "L").status_code == 404


def test_overrides_follow_the_drawing_across_a_reimport() -> None:
    sid = stand_id()
    name = library.get(sid).name
    assert put("KB1", "volume", 9.0, "L").status_code == 200

    raw = json.loads(library.read(sid))
    kb = next(n for n in raw["nodes"] if n["id"] == "KB1")
    kb["data"]["params"]["volume"]["value"] = 6.0
    files = {
        "file": (
            name.replace(" ", "_") + ".json",
            json.dumps(raw).encode(),
            "application/json",
        )
    }
    new = client.post("/api/library/diagrams", files=files).json()["artifact"]
    try:
        assert new["id"] != sid and new["name"] == name
        volume = bottle_volume(
            client.get("/api/drawing", params={"diagram": new["id"]}).json()
        )
        assert volume["override"]["value"] == 9.0, "kept under the drawing's name"
        assert volume["drawing"]["value"] == 6.0
        assert volume["stale"], "the drawing moved underneath the override"
    finally:
        library.remove(new["id"])


# ---------------------------------------------------------------- console


def test_console_visibility_is_shared() -> None:
    sid = stand_id()
    r = client.put(
        "/api/drawing/console",
        json={"diagram": sid, "element": "PT_HI", "hidden": True},
        headers={"X-Auth-Email": "a@b.c"},
    )
    assert r.json() == {"hidden": ["PT_HI"]}
    assert client.get("/api/drawing/console", params={"diagram": sid}).json()[
        "hidden"
    ] == ["PT_HI"]
    assert client.get("/api/model", params={"diagram": sid}).json()[
        "console_hidden"
    ] == ["PT_HI"]
    pt = next(
        e
        for e in client.get("/api/drawing", params={"diagram": sid}).json()["elements"]
        if e["id"] == "PT_HI"
    )
    assert pt["console_hidden"] and pt["hidden_by"] == "a@b.c"

    client.put(
        "/api/drawing/console",
        json={"diagram": sid, "element": "PT_HI", "hidden": False},
    )
    assert (
        client.get("/api/drawing/console", params={"diagram": sid}).json()["hidden"]
        == []
    )


LE4 = (
    Path(__file__).resolve().parents[2]
    / "lib"
    / "feedtwin"
    / "tests"
    / "fixtures"
    / "le4_rocket_and_gse.json"
)


def _le4() -> tuple[str, dict[str, str]]:
    r = client.post(
        "/api/library/diagrams",
        files={"file": ("console LE4.json", LE4.read_bytes(), "application/json")},
    )
    assert r.status_code == 200, r.text
    ids = {n["data"]["label"]: n["id"] for n in json.loads(LE4.read_text())["nodes"]}
    return r.json()["artifact"]["id"], ids


def test_the_cart_starts_off_the_console_and_can_be_put_on() -> None:
    """The ground support is hidden until somebody shows it; the rocket is
    shown until somebody hides it. Both for everyone."""
    diagram, ids = _le4()
    try:
        hidden = set(
            client.get("/api/drawing/console", params={"diagram": diagram}).json()[
                "hidden"
            ]
        )
        assert (
            ids["6K-GN2"] in hidden and ids["HPC_SOL"] in hidden
        ), "the cart starts off"
        assert (
            ids["COPV"] not in hidden and ids["FM-R"] not in hidden
        ), "the rocket starts on"

        shown = client.put(
            "/api/drawing/console",
            json={"diagram": diagram, "element": ids["HPC_SOL"], "hidden": False},
        ).json()["hidden"]
        assert ids["HPC_SOL"] not in shown and ids["6K-GN2"] in shown
        again = client.put(
            "/api/drawing/console",
            json={"diagram": diagram, "element": ids["HPC_SOL"], "hidden": True},
        ).json()["hidden"]
        assert ids["HPC_SOL"] in again
        view = client.get("/api/model", params={"diagram": diagram}).json()
        assert ids["HPC_SOL"] in view["console_hidden"]
    finally:
        library.remove(diagram)


def test_the_console_order_and_a_stands_view_are_kept() -> None:
    """Dragged order is kept for everyone; a stand's saved view put back makes
    the console exactly that, cart items included."""
    diagram, ids = _le4()
    try:
        order = {
            "pts": ["engine.pc", ids["FU-PT-R"]],
            "tanks": [ids["LOX-Tank"], ids["Eth-Tank"]],
        }
        r = client.put(
            "/api/drawing/console/order", json={"diagram": diagram, "order": order}
        )
        assert r.json()["order"] == order
        assert (
            client.get("/api/model", params={"diagram": diagram}).json()[
                "console_order"
            ]
            == order
        )

        saved = sorted(
            {ids["FM-R"], ids["6K-GN2"]}
        )  # one rocket item off, one cart item only
        r = client.put(
            "/api/drawing/console/view",
            json={
                "diagram": diagram,
                "hidden": saved,
                "order": {"pts": [], "tanks": []},
            },
        )
        assert sorted(r.json()["hidden"]) == saved, "exactly the stand's view"
        assert r.json()["order"] == {}
    finally:
        library.remove(diagram)
