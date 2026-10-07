"""Writing a parsed motor back out: it must load to the same digest it came from.

The digest is OpenRocket's (``motors/digest.py`` is its port), and the .ork
references its motor by that digest -- so a written file that re-digests
differently is a different motor as far as OpenRocket is concerned. Checked
against OpenRocket's own JUnit fixtures, all three of the shapes a file can take:
RASP, RockSim with mass and CG computed, RockSim with a real CG table.
"""

from __future__ import annotations

import pytest

from backend.motors import load_rasp
from backend.motors.rocksim import load_rocksim
from backend.motors.write import write_motor_file
from test_motors_loader import DIGEST1, DIGEST2, DIGEST3, _text


def _reload(name: str, text: str):
    return (load_rocksim(text) if name.endswith(".rse") else load_rasp(text))[0]


@pytest.mark.parametrize(
    "fixture, loader, digest, ext",
    [
        ("test1.eng", load_rasp, DIGEST1, ".eng"),
        ("test2.rse", load_rocksim, DIGEST2, ".rse"),
        ("test3.rse", load_rocksim, DIGEST3, ".rse"),
    ],
)
def test_written_file_reloads_to_openrockets_digest(fixture, loader, digest, ext):
    motor = loader(_text(fixture))[0]
    assert motor.digest == digest
    name, text = write_motor_file(motor)
    assert name.endswith(ext)
    back = _reload(name, text)
    assert back.digest == digest
    assert back.designation == motor.designation
    assert back.time == pytest.approx(motor.time)
    assert back.thrust == pytest.approx(motor.thrust)
    assert back.mass == pytest.approx(motor.mass)
    assert back.cg_x == pytest.approx(motor.cg_x)


def test_curve_openrocket_refuses_is_refused():
    motor = load_rasp(_text("test1.eng"))[0]
    motor.time[2] = motor.time[1]  # two thrust values at one instant
    with pytest.raises(ValueError, match="OpenRocket refuses"):
        write_motor_file(motor)
