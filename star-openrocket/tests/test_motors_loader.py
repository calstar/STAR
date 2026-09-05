"""Motor parsers validated against OpenRocket's own JUnit fixtures.

``test1.eng``, ``test2.rse`` and ``test3.rse`` are copied verbatim from OpenRocket
release-24.12 (``core/src/test/resources/file/motor/``). Their expected digests are the
constants from ``TestMotorLoader.java``. Matching them proves our RASP/RockSim ports and
the MotorDigest port agree with OpenRocket **byte-for-byte**, which pins mass, CG, and the
thrust-curve clean-up all at once.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.motors import load_rasp, load_rocksim

FIXTURES = Path(__file__).parent / "fixtures" / "motor"

# From TestMotorLoader.java (release-24.12).
DIGEST1 = "e523030bc96d5e63313b5723aaea267d"  # test1.eng  (RASP)
DIGEST2 = "6a41f0f10b7283793eb0e6b389753729"  # test2.rse  (auto-calc mass + cg)
DIGEST3 = "e3164a735f9a50500f2725f0a33d246b"  # test3.rse  (auto-calc mass, real cg)


def _text(name: str) -> str:
    # RASP files are ISO-8859-1; RockSim files are UTF-8. Both fixtures are ASCII.
    encoding = "iso-8859-1" if name.endswith(".eng") else "utf-8"
    return (FIXTURES / name).read_text(encoding=encoding)


def test_rasp_digest_matches_openrocket():
    motors = load_rasp(_text("test1.eng"))
    assert len(motors) == 1
    assert motors[0].digest == DIGEST1


def test_rocksim_digest_matches_openrocket():
    motors = load_rocksim(_text("test2.rse"))
    assert len(motors) == 1
    assert motors[0].digest == DIGEST2


def test_rocksim_real_cg_digest_matches_openrocket():
    motors = load_rocksim(_text("test3.rse"))
    assert len(motors) == 1
    assert motors[0].digest == DIGEST3


def test_rasp_is_basic_with_midcasing_cg():
    """RASP has no CG data: constant length/2, and mass runs wet -> dry monotonically."""
    motor = load_rasp(_text("test1.eng"))[0]
    assert motor.quality == "basic"
    assert motor.diameter == pytest.approx(0.018)
    assert motor.length == pytest.approx(0.070)
    assert all(cg == pytest.approx(motor.length / 2) for cg in motor.cg_x)
    assert motor.launch_mass == pytest.approx(0.0259)  # header total weight (kg)
    assert motor.burnout_mass == pytest.approx(0.0259 - 0.0098)
    assert motor.propellant_mass == pytest.approx(0.0098)
    # Mass is non-increasing across the burn.
    assert all(b <= a + 1e-12 for a, b in zip(motor.mass, motor.mass[1:]))


def test_rocksim_auto_calc_cg_is_basic():
    """test2.rse sets auto-calc-cg, so CG collapses to length/2 -> basic quality."""
    motor = load_rocksim(_text("test2.rse"))[0]
    assert motor.quality == "basic"
    assert all(cg == pytest.approx(motor.length / 2) for cg in motor.cg_x)
    assert motor.launch_mass == pytest.approx(0.195)  # initWt
    assert motor.burnout_mass == pytest.approx(0.195 - 0.0618)


def test_rocksim_real_cg_is_full_and_shifts():
    """test3.rse keeps real per-time CG (auto-calc-cg=0) -> full quality, CG moves."""
    motor = load_rocksim(_text("test3.rse"))[0]
    assert motor.quality == "full"
    assert motor.launch_cgx != pytest.approx(motor.burnout_cgx)


def test_interpolation_endpoints_and_midpoint():
    motor = load_rasp(_text("test1.eng"))[0]
    # At t=0 and at burnout, interpolation returns the table endpoints exactly.
    assert motor.get_total_mass(0.0) == pytest.approx(motor.launch_mass)
    assert motor.get_total_mass(motor.burn_time) == pytest.approx(motor.burnout_mass)
    # Mid-burn mass lies strictly between the endpoints.
    mid = motor.get_total_mass(motor.burn_time / 2)
    assert motor.burnout_mass < mid < motor.launch_mass
