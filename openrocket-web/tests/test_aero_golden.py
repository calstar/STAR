"""orweb.aero against OpenRocket 24.12 itself (tests/golden/*.json, from tools/oracle).

For every golden rocket, loaded through the real orweb model from its .ork,
every component's (and every assembly's) CP x, CNa, CN, Cm, CD, CD axial and
friction/pressure/base/override CD over the oracle's Mach x AoA grid, and the
roll coefficients over its roll-rate x theta grid, must match OpenRocket to
1e-9 relative. These are closed forms evaluated in the same order as the Java;
the only expected differences are last-bit rounding (and the oracle prints 15
significant digits), so 1e-9 leaves six orders of margin. A value that is zero
in OpenRocket must be zero to 1e-12 absolute.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from orweb.aero import BarrowmanCalculator, flight_conditions, resolve_configuration
from orweb.aero import _compat as compat

HERE = Path(__file__).parent
# OpenRocket's examples (shared with the mass/model tests), then the aerodynamics
# test-bed (tools/oracle/aero_testbed.py: noses, finishes, fin counts, boattails,
# CD overrides the examples never reach).
GOLDEN = sorted((HERE / "golden").glob("*.json")) + sorted((HERE / "golden_aero").glob("*.json"))
ROCKET_DIR = {"golden": "rockets", "golden_aero": "rockets_aero"}
REL = 1e-9
ABS = 1e-12

FIELDS = {  # golden key -> AerodynamicForces getter
    "cpx": lambda f: f.get_cp().x,
    "cna": lambda f: f.get_cp().weight,
    "CN": lambda f: f.get_cn(),
    "Cm": lambda f: f.get_cm(),
    "CD": lambda f: f.get_cd(),
    "CDaxial": lambda f: f.get_cd_axial(),
    "frictionCD": lambda f: f.get_friction_cd(),
    "pressureCD": lambda f: f.get_pressure_cd(),
    "baseCD": lambda f: f.get_base_cd(),
    "overrideCD": lambda f: f.get_override_cd(),
}
ROLL_FIELDS = {
    "Croll": lambda f: f.get_croll(),
    "CrollDamp": lambda f: f.get_croll_damp(),
    "CrollForce": lambda f: f.get_croll_force(),
}


def load(golden_path: Path):
    """The rocket through the real orweb model: .ork -> document -> components."""
    from orweb.build import build_rocket
    from orweb.ork import read_ork

    ork = HERE / ROCKET_DIR[golden_path.parent.name] / f"{golden_path.stem}.ork"
    return build_rocket(read_ork(ork))


def close(a, b) -> bool:
    if b is None:  # oracle prints NaN/inf as null
        return a is None or math.isnan(a) or math.isinf(a)
    if a is None or math.isnan(a):
        return False
    return abs(a - b) <= max(REL * max(abs(a), abs(b)), ABS)


def compare_grid(config, points, fields, with_roll: bool):
    calc = BarrowmanCalculator()  # one calculator across the grid, as the oracle does
    bad = []
    n = 0
    for p in points:
        fc = flight_conditions(config, p["mach"], math.radians(p["aoaDeg"]),
                               p.get("rollRate", 0.0) if with_roll else 0.0,
                               p.get("theta", 0.0) if with_roll else 0.0)
        assert fc.get_velocity() == pytest.approx(p["velocity"], rel=1e-12)
        fmap = {compat.id_of(c): f for c, f in calc.get_force_analysis(config, fc, []).items()}
        want = {g["id"]: g for g in p["forces"]}
        missing = set(want) ^ set(fmap)
        if missing:
            bad.append(f"M{p['mach']} a{p['aoaDeg']}: component sets differ: {sorted(missing)}")
            continue
        for cid, g in want.items():
            for key, get in fields.items():
                n += 1
                got = get(fmap[cid])
                if not close(got, g[key]):
                    bad.append(f"M{p['mach']} a{p['aoaDeg']} r{p.get('rollRate', 0)} t{p.get('theta', 0)} "
                               f"{g['name']}.{key}: port {got!r} OpenRocket {g[key]!r}")
    return n, bad


@pytest.mark.parametrize("path", GOLDEN, ids=[p.stem for p in GOLDEN])
def test_force_analysis_matches_openrocket(path):
    golden = json.loads(path.read_text())
    config = resolve_configuration(load(path))
    n, bad = compare_grid(config, golden["aero"], FIELDS, with_roll=False)
    assert not bad, f"{len(bad)}/{n} values off:\n" + "\n".join(bad[:40])


@pytest.mark.parametrize("path", GOLDEN, ids=[p.stem for p in GOLDEN])
def test_roll_and_theta_match_openrocket(path):
    golden = json.loads(path.read_text())
    if "aeroRoll" not in golden:
        pytest.skip("golden file predates the aeroRoll grid; rerun tools/oracle/run.sh")
    config = resolve_configuration(load(path))
    n, bad = compare_grid(config, golden["aeroRoll"], {**FIELDS, **ROLL_FIELDS}, with_roll=True)
    assert not bad, f"{len(bad)}/{n} values off:\n" + "\n".join(bad[:40])


@pytest.mark.parametrize("path", GOLDEN, ids=[p.stem for p in GOLDEN])
def test_reference_and_analyze_entry_point(path):
    golden = json.loads(path.read_text())
    rocket = load(path)
    from orweb.aero import analyze

    out = analyze(rocket, 0.3, 0.0)
    assert out["reference"]["length"] == pytest.approx(golden["rocket"]["refLength"], rel=REL)
    assert out["reference"]["area"] == pytest.approx(golden["rocket"]["refArea"], rel=REL)
    rocket_id = golden["components"][0]["id"]
    g = next(p for p in golden["aero"] if p["mach"] == 0.3 and p["aoaDeg"] == 0.0)
    total = next(f for f in g["forces"] if f["id"] == rocket_id)
    assert close(out["cp"]["x"], total["cpx"]) and close(out["cp"]["cna"], total["cna"])
    assert close(out["cd"]["total"], total["CD"])
    assert close(out["cd"]["friction"], total["frictionCD"])
    assert close(out["cd"]["pressure"], total["pressureCD"])
    assert close(out["cd"]["base"], total["baseCD"])
    rows = {r["id"]: r for r in out["components"]}
    for f in g["forces"]:
        assert close(rows[f["id"]]["cpx"], f["cpx"]) and close(rows[f["id"]]["cd"], f["CD"]), f["name"]
