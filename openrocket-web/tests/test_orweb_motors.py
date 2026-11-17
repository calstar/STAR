"""Motors: the loaders reproduce OpenRocket's digests, the bundled set resolves every
example's motors to OpenRocket's own curves, and interpolation is ThrustCurveMotor's."""

from __future__ import annotations

import json
import math

import pytest

from _orweb_check import HERE
from orweb import read_ork
from orweb.motors import PSEUDO_TIME_BURNOUT, MotorRegistry, ThrustCurveMotor, default_registry

FIXTURES = HERE / "motor_files"


@pytest.mark.parametrize("name,digest", [  # OpenRocket's TestMotorLoader DIGEST1/2/3
    ("test1.eng", "e523030bc96d5e63313b5723aaea267d"),
    ("test2.rse", "6a41f0f10b7283793eb0e6b389753729"),
    ("test3.rse", "e3164a735f9a50500f2725f0a33d246b"),
])
def test_loader_digests_match_openrocket(name, digest):
    (m,) = MotorRegistry().load_file(FIXTURES / name)
    assert m.digest == digest


def test_rasp_motor_mass_model():
    (m,) = MotorRegistry().load_file(FIXTURES / "test1.eng")
    assert m.time[0] == 0.0 and m.thrust[0] == 0.0  # the t=0 point RASP files leave out
    assert m.get_launch_mass() == pytest.approx(0.0259)
    assert m.get_burnout_mass() == pytest.approx(0.0259 - 0.0098)
    assert all(c == m.length / 2 for c in m.cg_x)


def _all_example_motors():
    out = []
    for ork in sorted((HERE / "rockets").glob("*.ork")):
        doc = read_ork(ork, keep_simulations=False)
        for cfg in doc["motorConfigs"]:
            for m in cfg["motors"].values():
                out.append((ork.stem, m))
    return out


@pytest.mark.parametrize("rocket,ref", _all_example_motors(),
                         ids=[f"{r}:{m['designation']}" for r, m in _all_example_motors()])
def test_bundled_set_resolves_every_example_motor(rocket, ref):
    w: list[str] = []
    m = default_registry().find(ref["designation"], ref["manufacturer"], ref["digest"], w)
    assert m is not None and w == []
    assert m.digest == ref["digest"]
    assert m.diameter == ref["diameter"] and m.length == ref["length"]


def _golden_motors():
    out = []
    for g in sorted((HERE / "golden").glob("*.json")):
        for d in json.loads(g.read_text())["allMotors"]:
            out.append(d)
    return out


@pytest.mark.parametrize("d", _golden_motors(), ids=[d["designation"] for d in _golden_motors()])
def test_interpolation(d):
    m = ThrustCurveMotor.from_dict(dict(d, type=d["motorType"]))
    assert m.get_total_mass(0.0) == d["mass"][0]
    assert m.get_cmx(0.0) == d["cgx"][0]
    assert m.get_total_mass(PSEUDO_TIME_BURNOUT) == d["mass"][-1]
    assert m.get_cmx(PSEUDO_TIME_BURNOUT) == d["cgx"][-1]
    i = len(d["time"]) // 2
    t = 0.5 * (d["time"][i] + d["time"][i + 1])  # mid-interval: an even blend of the two samples
    assert m.get_total_mass(t) == pytest.approx(0.5 * (d["mass"][i] + d["mass"][i + 1]), rel=1e-12)
    assert m.get_thrust(t) == pytest.approx(0.5 * (d["thrust"][i] + d["thrust"][i + 1]), rel=1e-12)
    assert m.get_total_impulse_estimate() > 0 and m.get_burn_time_estimate() > 0
    assert math.isnan(m.get_total_mass(-1.0))


def test_search():
    rows = default_registry().search("C6")
    assert rows and all("C6" in r["designation"] for r in rows)
    assert default_registry().search("", diameter=0.018)
