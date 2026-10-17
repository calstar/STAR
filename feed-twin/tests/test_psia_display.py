"""People read psia; the wire and the files stay gauge (ADR 0007).

Checked against arithmetic and against a record the old code wrote, not against
the code that formats them: a standard atmosphere is 101,325 Pa, a psi is
6,894.757 Pa, so the shipped stand's 1000 psig MAWP is 1,014.7 psia, and a run
record written before 2026-10-17 -- gauge in its inputs and in its notes --
still rebuilds the stand it ran on, diffs clean against a record written now,
and replays to the numbers the old code replayed it to.
"""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from backend import main
from backend import runs as run_records
from backend.session import Setup
from backend.tunables import wire_setup
from feedtwin.session.gauge import ATMOSPHERE_PSI, from_psig, say

DATA = Path(__file__).resolve().parent / "data"
OLD = json.loads((DATA / "run_record_before_adr0007.json").read_text())

#: The Configuration rows that are pressures at a place, carried gauge, and
#: the Setup fields they set.
GAUGE_WIRE = {
    "dome": "dome_psi",
    "copv_target": "copv_target_psi",
    "dewar_psi": "dewar_psi",
}

#: What no text a person reads may say.
SAYS_PSIG = re.compile(r"psig", re.IGNORECASE)

client = TestClient(main.app)


def _stand() -> str:
    return next(
        a
        for a in main.library.list("diagram")
        if a.source == "shipped:ethalox_stand.json"
    ).id


# ------------------------------------------------------------ the settings


def test_no_setting_is_shown_in_psig_and_the_gauge_ones_say_psia() -> None:
    rows = client.get("/api/tunables").json()
    for row in rows:
        assert row["unit"] != "psig", row["key"]
        assert not SAYS_PSIG.search(row["label"] + row["explains"]), row["key"]
    marked = {row["key"]: row for row in rows if row.get("gauge_wire")}
    assert set(marked) == set(GAUGE_WIRE)
    defaults = Setup()
    for key, field in GAUGE_WIRE.items():
        row = marked[key]
        assert row["unit"] == "psia", key
        # Shown psia, carried gauge: the default on the wire is the Setup's own
        # gauge number (500 for the dome), not 514.7.
        assert row["default"] == getattr(defaults, field), key
    assert not any(row.get("gauge_wire") for row in rows if row["key"] not in marked)


# ------------------------------------------------ T-0, a trip, and the hovers


def _all_text(out: dict[str, Any]) -> Iterator[str]:
    yield from out.get("notes") or []
    if out.get("tripped"):
        yield out["tripped"]


def test_t0_says_psia_and_the_wire_stays_gauge() -> None:
    sid = client.post(
        "/api/session", params={"diagram": _stand()}, json={"dome": 500.0}
    ).json()["id"]
    out = client.post(f"/api/session/{sid}/t0").json()
    assert out["state"] == "Ready" and not out["tripped"]
    session = main._SESSIONS[sid]
    said = [a for a in session.assumptions if a.startswith("Jumped to T-0")]
    assert len(said) == 1, session.assumptions
    # The shipped regulator holds its dome plus a 50 psi spring bias: 500 psig
    # on the dial is 550 psig in the tanks. The wire carries that, gauge...
    assert out["setup"]["dome"] == 500.0
    for tank in out["tanks"]:
        assert tank["pressure_psi"] == pytest.approx(550.0, abs=1.0), tank["label"]
    # ...and a person reads it an atmosphere higher, and is told which.
    assert said[0].startswith("Jumped to T-0: tanks primed at 564.7 psia"), said[0]
    assert "bottle at 4,514.7 psia." in said[0], said[0]
    for text in [*_all_text(out), *session.assumptions]:
        assert not SAYS_PSIG.search(text), text


def test_a_trip_says_psia() -> None:
    """Dome turned to 1,114.7 psia: T-0 primes the tanks over their drawn
    1,014.7 psia MAWP and the stand trips on the first frame."""
    sid = client.post(
        "/api/session", params={"diagram": _stand()}, json={"dome": 1100.0}
    ).json()["id"]
    # T-0 refuses to prime over MAWP (D-33), and says so in psia...
    refused = client.post(f"/api/session/{sid}/t0")
    assert refused.status_code == 422
    assert "1,014.7 psia MAWP" in refused.json()["detail"], refused.json()
    # ...so the tanks are put over it by hand, and the stand trips.
    main._SESSIONS[sid].prime(
        fill_fraction=0.5, tank_psi=1100.0, copv_psi=4500.0, state="Ready"
    )
    out = client.post(f"/api/session/{sid}/tick", json={"dt": 0.02}).json()
    trip = main._SESSIONS[sid].trip
    assert out["tripped"] and trip is not None, out["tripped"]
    assert say(trip.limit, 1) == "1,014.7 psia"
    assert f"reached {say(trip.pressure, 1)} against a 1,014.7 psia MAWP" in (
        out["tripped"]
    )
    for text in _all_text(out):
        assert not SAYS_PSIG.search(text), text


def test_the_limit_hovers_say_psia_over_gauge_lines() -> None:
    sid = client.post("/api/session", params={"diagram": _stand()}, json={}).json()[
        "id"
    ]
    client.post(f"/api/session/{sid}/tick", json={"dt": 0.05})
    channels = client.get(f"/api/session/{sid}/history").json()["channels"]
    hovered = {c["tag"]: c for c in channels if c.get("limits")}
    assert hovered, "the shipped stand draws MAWPs on its tanks and bottle"
    for channel in hovered.values():
        assert not SAYS_PSIG.search(channel["limits"]), channel["limits"]
        # The red line is gauge on the wire, like the values it marks; the
        # hover gives the same line in psia.
        shown = f"{channel['meop'] + ATMOSPHERE_PSI:,.1f} psia (MAWP)"
        assert shown in channel["limits"], channel["limits"]
        assert channel["unit"] == "psig", "the wire's tag for a gauge value"
    assert hovered["PT-OX-UP"]["meop"] == pytest.approx(1000.0)
    assert "trips at 1,014.7 psia (MAWP)" in hovered["PT-OX-UP"]["limits"]


# ------------------------------------------------------------------- runs


def test_a_pressure_change_is_a_share_of_psia() -> None:
    """10 psi on a 350 psia chamber is 2.857 %, not the 2.98 % of its gauge
    reading; a thrust change is a share of the thrust, as before."""
    a = {"outcome": {"pc_mean_psi": 350.0 - ATMOSPHERE_PSI, "thrust_mean_N": 7000.0}}
    b = {"outcome": {"pc_mean_psi": 360.0 - ATMOSPHERE_PSI, "thrust_mean_N": 7070.0}}
    rows = {o["key"]: o for o in run_records.diff(a, b)["outcome"]}
    assert rows["pc_mean_psi"]["delta"] == pytest.approx(10.0)
    assert rows["pc_mean_psi"]["pct"] == pytest.approx(10.0 / 350.0 * 100.0)
    assert rows["thrust_mean_N"]["pct"] == pytest.approx(1.0)
    assert rows["pc_mean_psi"]["unit"] == "psig", "gauge on the wire, shown psia"


@pytest.fixture
def old_stand() -> Iterator[dict[str, Any]]:
    """The old record's drawing and engine, in the library under the ids it
    names (content hashes, so the same bytes are the same artifacts)."""
    added: list[str] = []
    for route, name, kind in (
        ("diagrams", OLD["diagram_file"], "application/json"),
        ("engines", OLD["engine_file"], "application/x-yaml"),
    ):
        raw = (DATA / name).read_bytes()
        result = client.post(
            f"/api/library/{route}", files={"file": (name, raw, kind)}
        ).json()
        if not result["already_present"]:
            added.append(result["artifact"]["id"])
    record = copy.deepcopy(OLD["record"])
    ids = {a.id for a in main.library.list()}
    assert record["inputs"]["diagram"] in ids and record["inputs"]["engine"] in ids
    try:
        yield record
    finally:
        for artifact in added:
            main.library.remove(artifact)


def test_an_old_record_rebuilds_its_stand_in_gauge_and_diffs_clean(
    old_stand: dict[str, Any],
) -> None:
    """Its dome of 450 is 450 psig -- 464.7 psia -- not 450 psia: the stand
    rebuilt from it puts the same pascals on the regulator, and the inputs a
    record written now would carry are the old record's, to the digit."""
    inputs = old_stand["inputs"]
    assert inputs["setup"]["dome"] == 450.0 and inputs["knobs"] == {"dome": 450.0}
    session = main._session_from_inputs(inputs)
    assert session.setup.dome_psi == 450.0
    domes = [
        v
        for k, v in session.peek_signals(loaded_dome=True).items()
        if k.endswith(".dome")
    ]
    assert domes and all(v == pytest.approx(from_psig(450.0)) for v in domes), domes

    # The replay turns the cockpit's automatic vent off (it would act after the
    # window being compared); every other setting comes back as it went in.
    setup = {k: v for k, v in wire_setup(session.setup).items() if k in inputs["setup"]}
    assert setup.pop("auto_vent") is False
    rewritten = {
        **inputs,
        "setup": {**setup, "auto_vent": inputs["setup"]["auto_vent"]},
        **main._hookup_inputs(session),
        "knobs": {k: round(float(v), 3) for k, v in session.knobs.items()},
    }
    now = {**old_stand, "inputs": rewritten}
    difference = run_records.diff(old_stand, now)
    assert difference["inputs"] == [], difference["inputs"]
    assert all(o["delta"] == 0.0 for o in difference["outcome"])
    # Its notes are the old words, kept as written: evidence is never edited.
    assert any("psig" in n for n in old_stand["notes"])


def test_an_old_record_replays_to_what_it_replayed_to_when_written(
    old_stand: dict[str, Any],
) -> None:
    """Zero difference against the old code's own replay. Pinned to the drawing
    and engine kept in tests/data, so only a change in how the twin reads a
    record -- or in its physics -- can move it; the record's dome read as psia
    takes 2.8 % off the thrust. After a deliberate physics change, regenerate
    the fixture the way its "about" says."""
    replayed, _ = main._replay(old_stand["inputs"], lambda: False, horizon_s=20.0)
    then = OLD["replayed"]
    for key in ("thrust_mean_N", "pc_mean_psi", "of_mean"):
        assert replayed[key] == pytest.approx(then[key], rel=5e-3), key
    # Since D-80 a replay burns to empty, as the cockpit burn it replays did,
    # not to BurnPlan's 60 g residual: the old replay stopped 0.05 s (20 %)
    # short of the recording; this one lands on it.
    recorded = OLD["record"]["outcome"]
    for key in ("thrust_mean_N", "pc_mean_psi", "of_mean"):
        assert replayed[key] == pytest.approx(recorded[key], rel=1e-3), key
    assert replayed["duration_s"] == pytest.approx(recorded["duration_s"], abs=0.01)
    assert abs(replayed["duration_s"] - recorded["duration_s"]) < abs(
        then["duration_s"] - recorded["duration_s"]
    )
    difference = run_records.diff(
        {**old_stand, "outcome": recorded}, {**old_stand, "outcome": replayed}
    )
    assert difference["inputs"] == []
    pct = {o["key"]: abs(o["pct"] or 0.0) for o in difference["outcome"]}
    assert max(pct[k] for k in ("thrust_mean_N", "pc_mean_psi", "of_mean")) < 0.1
