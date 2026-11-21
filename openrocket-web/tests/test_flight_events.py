"""Stage separation, recovery deployment and motor ignition per flight configuration.

The Motors & Configuration tab edits these, and the .ork is the only place they
live, so a value we read or write wrong is a rocket that stages or deploys at the
wrong time in OpenRocket. Held to what OpenRocket itself resolves (the oracle's
configs[].events), on the file as read and on the file after our save.
"""

import json
import os
import subprocess
import tempfile
from pathlib import Path

import pytest

from orweb import read_ork, write_ork
from orweb.document import flight_events

ROOT = Path(__file__).resolve().parent
NAMES = sorted(p.stem for p in (ROOT / "rockets").glob("*.ork"))

# OpenRocket's enum names -> the .ork's lower-case names (SeparationEvent, DeployEvent, IgnitionEvent)
ALIASES = {"UPPER_IGNITION": "upperignition", "LOWER_BURNOUT": "lowerburnout"}


def norm(e):
    if e is None:
        return None
    return ALIASES.get(e, e).lower().replace("_", "")


def compare(doc, gold):
    for cfg in gold["configs"]:
        ours = {(e["id"], e["kind"]): e for e in flight_events(doc, cfg["id"])}
        for g in cfg["events"]:
            o = ours.get((g["id"], g["kind"]))
            assert o is not None, (cfg["id"], g)
            assert norm(o["event"]) == norm(g["event"]), (cfg["id"], g, o)
            assert o["delay"] == pytest.approx(g["delay"], rel=1e-12, abs=1e-12)
            if "altitude" in g:
                assert o["altitude"] == pytest.approx(g["altitude"], rel=1e-12, abs=1e-12)
        assert len(ours) == len(cfg["events"]), cfg["id"]


@pytest.mark.parametrize("name", NAMES)
def test_events_as_read_match_openrocket(name):
    compare(read_ork(ROOT / "rockets" / f"{name}.ork"),
            json.loads((ROOT / "golden" / f"{name}.json").read_text()))


def test_an_edited_override_is_what_gets_saved():
    """Edit one configuration's booster separation; the saved file must carry it, and only there."""
    doc = read_ork(ROOT / "rockets" / "Two stage high power rocket.ork")
    booster = next(c for c in doc["rocket"]["children"] if c["name"] == "Booster")
    cfg = doc["motorConfigs"][0]["id"]
    for o in booster["params"]["separationconfiguration"]:
        if o["configid"] == cfg:
            o["separationevent"], o["separationdelay"] = "altitudeascending", 1.5
            o["separationaltitude"] = 321.0
    back = read_ork(write_ork(doc))
    ev = {e["id"]: e for e in flight_events(back, cfg)}[booster["id"]]
    assert (ev["event"], ev["altitude"], ev["delay"]) == ("altitudeascending", 321.0, 1.5)
    other = doc["motorConfigs"][1]["id"]
    assert {e["id"]: e for e in flight_events(back, other)}[booster["id"]]["event"] != "altitudeascending"


@pytest.mark.oracle
@pytest.mark.parametrize("name", NAMES)
def test_events_survive_our_save_in_openrocket(name, tmp_path):
    jar = os.environ.get("OPENROCKET_JAR")
    if not jar:
        pytest.skip("OPENROCKET_JAR not set")
    saved = tmp_path / f"{name}.ork"
    saved.write_bytes(write_ork(read_ork(ROOT / "rockets" / f"{name}.ork")))
    out = tmp_path / "golden"
    out.mkdir()
    env = dict(os.environ, GOLDEN_DIR=str(out))
    subprocess.run([str(ROOT.parent / "tools/oracle/run.sh"), str(saved)], env=env, check=True,
                   capture_output=True)
    gold = json.loads((out / f"{name}.json").read_text())
    compare(read_ork(saved), gold)
    compare(read_ork(ROOT / "rockets" / f"{name}.ork"), gold)
