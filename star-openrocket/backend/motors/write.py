"""Write a parsed ``Motor`` back out as the file it came from (RASP ``.eng`` / RockSim ``.rse``).

The mirror keeps parsed curves, not the original text. An ``.ork`` cannot carry a
thrust curve -- OpenRocket's ``MotorHandler`` reads a motor *reference* (manufacturer,
designation, digest) and looks it up in its own database -- so when that database lacks
the motor, this file is what you load into OpenRocket to supply it.

Written in the source format so it re-digests to the same value
(``backend.motors.digest``, a port of OpenRocket's): a RASP motor's digest is its
time/thrust table and two header masses, a RockSim one's adds per-point mass and CG
unless the file asked OpenRocket to compute them. RockSim's two auto-calc flags are not
kept by the parser, so they are inferred from the data: a CG pinned at length/2 for
all time, or a mass table equal to ``calculate_mass`` of the curve, is what the flag
produces.
"""

from __future__ import annotations

import math
import re
from xml.sax.saxutils import quoteattr

from .loader_common import calculate_mass
from .motor import PLUGGED_DELAY, Motor


def _num(v: float) -> str:
    return repr(float(v))


def _points(motor: Motor) -> list[tuple[float, float, float, float]]:
    """(t, thrust, mass, cg) rows, refused where OpenRocket would refuse them.

    ``ThrustCurveMotor.Builder.build`` throws on a time that does not strictly
    increase ("Two thrust values for single time point"). A handful of catalogue
    curves do that; OpenRocket cannot load the original either, so writing one would
    only hand over a file that fails on import.
    """
    t = motor.time
    for i in range(len(t) - 1):
        if t[i + 1] <= t[i]:
            raise ValueError(
                f"{motor.manufacturer} {motor.designation}: the thrust curve has two values "
                f"at t = {t[i]:g} s, which OpenRocket refuses to load; pick another datafile "
                "for this motor"
            )
    return list(zip(motor.time, motor.thrust, motor.mass, motor.cg_x))


def _delays_rasp(delays: list[float]) -> str:
    if not delays:
        return "none"
    out = ["P" if d == PLUGGED_DELAY else str(int(round(d))) for d in delays]
    return "-".join(out)


def _token(s: str) -> str:
    """A RASP header field: one whitespace-free token."""
    return re.sub(r"\s+", "_", s.strip()) or "Unknown"


def write_rasp(motor: Motor) -> str:
    total = motor.mass[0]
    prop = motor.mass[0] - motor.mass[-1]
    lines = [f"; {line}" for line in (motor.comment or "").splitlines()]
    lines.append("; Written by STAR OpenRocket from its motor mirror.")
    lines.append(
        " ".join(
            [
                _token(motor.designation),
                _num(motor.diameter * 1000.0),
                _num(motor.length * 1000.0),
                _delays_rasp(motor.delays),
                _num(prop),
                _num(total),
                _token(motor.manufacturer),
            ]
        )
    )
    lines += [f"{_num(t)} {_num(f)}" for t, f, _, _ in _points(motor)]
    lines.append(";")
    return "\n".join(lines) + "\n"


def _close(a: list[float], b: list[float]) -> bool:
    return len(a) == len(b) and all(math.isclose(x, y, rel_tol=1e-12, abs_tol=1e-15) for x, y in zip(a, b))


def write_rocksim(motor: Motor) -> str:
    total = motor.mass[0]
    prop = motor.mass[0] - motor.mass[-1]
    auto_cg = all(c == motor.length / 2 for c in motor.cg_x)
    auto_mass = _close(motor.mass, calculate_mass(list(motor.time), list(motor.thrust), total, prop))
    mtype = {"SINGLE": "single-use", "RELOAD": "reloadable", "HYBRID": "hybrid"}.get(motor.motor_type, "")
    delays = ",".join(
        "P" if d == PLUGGED_DELAY else _num(d) for d in motor.delays
    )
    attrs = {
        "mfg": motor.manufacturer,
        "code": motor.designation,
        "Type": mtype,
        "dia": _num(motor.diameter * 1000.0),
        "len": _num(motor.length * 1000.0),
        "initWt": _num(total * 1000.0),
        "propWt": _num(prop * 1000.0),
        "delays": delays or "0",
        "auto-calc-mass": "1" if auto_mass else "0",
        "auto-calc-cg": "1" if auto_cg else "0",
    }
    head = " ".join(f"{k}={quoteattr(v)}" for k, v in attrs.items())
    points = "".join(
        f'        <eng-data t="{_num(t)}" f="{_num(f)}" m="{_num(m * 1000.0)}" cg="{_num(c * 1000.0)}"/>\n'
        for t, f, m, c in _points(motor)
    )
    comment = (motor.comment + "\n" if motor.comment else "") + "Written by STAR OpenRocket from its motor mirror."
    return (
        "<engine-database>\n  <engine-list>\n"
        f"    <engine {head}>\n"
        f"      <comments>{_escape(comment)}</comments>\n"
        f"      <data>\n{points}      </data>\n"
        "    </engine>\n  </engine-list>\n</engine-database>\n"
    )


def _escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def write_motor_file(motor: Motor) -> tuple[str, str]:
    """``(filename, text)`` for ``motor`` in the format it was parsed from."""
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "_", f"{motor.manufacturer}_{motor.designation}").strip("_")
    if motor.file_format == "RockSim":
        return f"{stem}.rse", write_rocksim(motor)
    return f"{stem}.eng", write_rasp(motor)
