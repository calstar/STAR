"""Offline MotorDB: serialization round-trip and search/resolve, no network.

Builds a tiny cache from the OpenRocket fixtures the same way ``fetch.py`` writes one, then
reads it back through ``MotorDB`` -- exercising the runtime path the API and stability code
use, with the socket block from conftest active.
"""

from __future__ import annotations

import json

import pytest

from backend.motors import load_rasp, load_rocksim
from backend.motors.db import MotorDB, motor_from_dict, motor_to_dict

from test_motors_loader import _text


@pytest.fixture
def db(tmp_path):
    """A cache with one Basic (RASP) and one Full (RockSim, real-CG) motor."""
    (tmp_path / "data").mkdir()

    basic = load_rasp(_text("test1.eng"))[0]
    basic.motor_id = "basic1"
    basic.simfile_id = "sf-basic"
    basic.common_name = "D10"
    full = load_rocksim(_text("test3.rse"))[0]
    full.motor_id = "full1"
    full.simfile_id = "sf-full"

    for motor in (basic, full):
        (tmp_path / "data" / f"{motor.motor_id}.json").write_text(
            json.dumps({"motorId": motor.motor_id, "simfiles": [motor_to_dict(motor)]})
        )

    index = {
        "fetchedAt": "2026-08-11T00:00:00+00:00",
        "count": 2,
        "motors": [
            {"motorId": "basic1", "manufacturer": "AeroTech", "manufacturerAbbrev": "AT",
             "designation": basic.designation, "commonName": "D10", "impulseClass": "D",
             "simfiles": [{"simfileId": "sf-basic", "format": "RASP", "quality": "basic"}]},
            {"motorId": "full1", "manufacturer": "Water", "manufacturerAbbrev": "H2O",
             "designation": full.designation, "commonName": full.designation,
             "impulseClass": "C",
             "simfiles": [{"simfileId": "sf-full", "format": "RockSim", "quality": "full"}]},
        ],
    }
    (tmp_path / "index.json").write_text(json.dumps(index))
    return MotorDB(tmp_path)


def test_serialization_round_trip_preserves_digest_and_arrays():
    motor = load_rocksim(_text("test3.rse"))[0]
    restored = motor_from_dict(motor_to_dict(motor))
    assert restored.digest == motor.digest
    assert restored.cg_x == motor.cg_x
    assert restored.mass == motor.mass
    assert restored.quality == "full"
    assert restored.get_total_mass(0.02) == pytest.approx(motor.get_total_mass(0.02))


def test_search_by_manufacturer_and_designation(db):
    assert {m["motorId"] for m in db.search("AeroTech")} == {"basic1"}
    assert {m["motorId"] for m in db.search("D10")} == {"basic1"}
    assert len(db.search("")) == 2  # empty query returns everything (up to limit)


def test_get_motor_prefers_full_quality(db):
    # full1 has a single Full simfile; resolving with no id returns it.
    resolved = db.get_motor("full1")
    assert resolved.quality == "full"
    assert resolved.launch_cgx != pytest.approx(resolved.burnout_cgx)


def test_get_motor_by_simfile_id(db):
    assert db.get_motor("basic1", "sf-basic").quality == "basic"
    assert db.get_motor("basic1", "nope") is None
    assert db.get_motor("missing") is None
