"""The .ork export, opened in OpenRocket itself.

Every other export test checks what we *wrote*. This one checks what OpenRocket
*reads*: it loads the file through OpenRocket's own loader, mass calculator and
Barrowman calculator (``tools/openrocket-golden/OrkCheck.java``) and requires the
app's CP and CG back. It is how the silent fin-outline rejection in
``ork_export.fin_points`` was found -- the file was well-formed, and OpenRocket
quietly swapped in its default fin.

Skipped unless both are available, like the golden-CSV test (CI's
``openrocket-check`` job provides them and sets REQUIRE_OPENROCKET, which makes
their absence a failure there):

    OPENROCKET_JAR=/path/to/OpenRocket-24.12.jar   (release-24.12, see the README)
    a JDK 17+: ``javac``/``java`` on PATH, or JAVA_HOME
"""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from backend.onshape.aero.outer_surface import detect_outer_surface
from backend.onshape.aero.stability import compute_stability
from backend.onshape.aero.ork_export import LaunchConditions
from physics.schema import Site
from test_ork_export import DEVICES, PARTS, PROFILE, _export, rocket

TOOL = Path(__file__).resolve().parents[1] / "tools" / "openrocket-golden" / "OrkCheck.java"


def _java(name: str) -> str | None:
    home = os.environ.get("JAVA_HOME")
    if home and (Path(home) / "bin" / name).exists():
        return str(Path(home) / "bin" / name)
    return shutil.which(name)


JAR = os.environ.get("OPENROCKET_JAR")
_AVAILABLE = bool(JAR and Path(JAR).exists() and _java("javac") and _java("java"))
# CI's openrocket-check job sets this, so a missing jar or JDK fails the job
# instead of skipping every test and reporting green.
if os.environ.get("REQUIRE_OPENROCKET") and not _AVAILABLE:
    raise RuntimeError("REQUIRE_OPENROCKET is set but OPENROCKET_JAR or a JDK is missing")
pytestmark = pytest.mark.skipif(not _AVAILABLE, reason="needs OPENROCKET_JAR and a JDK (see module docstring)")


@pytest.fixture(scope="module")
def orkcheck(tmp_path_factory):
    out = tmp_path_factory.mktemp("orkcheck")
    subprocess.run([_java("javac"), "-cp", JAR, "-d", str(out), str(TOOL)], check=True)

    def run(path: Path, *extra: str) -> list[dict]:
        proc = subprocess.run(
            [_java("java"), "-Djava.awt.headless=true", "-cp", f"{JAR}{os.pathsep}{out}",
             "OrkCheck", str(path), *extra],
            capture_output=True, text=True, timeout=300,
        )
        lines = [json.loads(ln) for ln in proc.stdout.splitlines() if ln.startswith("{")]
        assert proc.returncode == 0 and lines, proc.stdout + proc.stderr
        return lines

    return run


@pytest.mark.parametrize("section", ["square", "airfoil"])
def test_openrocket_reads_back_the_apps_cp_and_cg(orkcheck, tmp_path, section):
    store = rocket(section)
    faces = detect_outer_surface(store).faces
    app = compute_stability(store, PARTS, faces)
    data, plan = _export(store)
    path = tmp_path / "rocket.ork"
    path.write_bytes(data)

    got = orkcheck(path)[0]

    assert got["loadWarnings"] == 0
    # The outline survived OpenRocket's validation (a rejected one is its 4-point default).
    assert got["finArea"] == pytest.approx(app.fin_area, rel=1e-6)
    # OpenRocket computes exactly what the exporter predicts...
    assert got["cp"] == pytest.approx(plan.cp_ork, abs=1e-9)
    assert got["cna"] == pytest.approx(plan.cna_ork, rel=1e-9)
    # ...which is the app's CP to well under a millimetre, and its CNa.
    assert abs(got["cp"] - app.cp_from_nose) < 5e-4
    assert got["cna"] == pytest.approx(app.cna, rel=1e-3)
    assert got["refLength"] == pytest.approx(app.ref_diameter, rel=1e-9)
    # The CG and mass are the app's, exactly.
    assert got["cgStructure"] == pytest.approx(app.cg_from_nose, abs=1e-9)
    assert got["massStructure"] == pytest.approx(app.mass, rel=1e-12)
    assert not got["hasMotor"]


def test_openrocket_reads_back_the_recovery_and_launch_conditions(orkcheck, tmp_path):
    launch = LaunchConditions(devices=DEVICES, site=Site(T_pad=305.0, p_pad=93000.0), wind=PROFILE,
                              rail_length=5.18, inclination=85.0, heading=30.0)
    data, _ = _export(rocket(), launch=launch)
    path = tmp_path / "rocket.ork"
    path.write_bytes(data)
    heights = [630.0, 1065.0, 1500.0, 2250.0, 3000.0, 4000.0]
    rows = orkcheck(path, "0.3", *map(str, heights))

    chutes = {r["parachute"]: r for r in rows if "parachute" in r}
    for dev in DEVICES:
        got = chutes[dev.name]
        assert got["cd"] * math.pi * got["diameter"] ** 2 / 4 == pytest.approx(dev.CdS, rel=1e-9)
    assert (chutes["Drogue"]["event"], chutes["Drogue"]["delay"]) == ("APOGEE", pytest.approx(1.5))
    assert chutes["Main"]["event"] == "ALTITUDE"
    assert (chutes["Main"]["altitude"], chutes["Main"]["delay"]) == (300.0, pytest.approx(0.3))

    (cond,) = [r for r in rows if "conditions" in r]
    assert cond["rodLength"] == pytest.approx(5.18)
    assert cond["rodAngleDeg"] == pytest.approx(5.0)
    assert cond["rodDirectionDeg"] == pytest.approx(30.0)
    assert (cond["temperature"], cond["pressure"], cond["isa"]) == (305.0, 93000.0, False)
    assert cond["launchAltitude"] == 630.0
    assert cond["windModel"] == "MultiLevel" and cond["windLevels"] == 3
    # OpenRocket's airspeed is v_rocket + wind (AbstractEulerStepper), so its wind
    # vector is minus where the air goes. Linear between levels, held past the top.
    for z, wx, wy in cond["wind"]:
        assert -wx == pytest.approx(float(np.interp(z, PROFILE.heights_msl, PROFILE.u)), abs=1e-9)
        assert -wy == pytest.approx(float(np.interp(z, PROFILE.heights_msl, PROFILE.v)), abs=1e-9)


@pytest.mark.parametrize("fixture", ["test1.eng", "test2.rse", "test3.rse"])
def test_openrocket_loads_written_motor_files_to_the_same_digest(orkcheck, tmp_path, fixture):
    from backend.motors import load_rasp
    from backend.motors.rocksim import load_rocksim
    from backend.motors.write import write_motor_file
    from test_motors_loader import _text

    motor = (load_rasp if fixture.endswith(".eng") else load_rocksim)(_text(fixture))[0]
    name, text = write_motor_file(motor)
    path = tmp_path / name
    path.write_text(text)
    (got,) = orkcheck(path)
    assert got["digest"] == motor.digest
