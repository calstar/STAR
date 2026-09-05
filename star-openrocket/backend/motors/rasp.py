"""RASP ``.eng`` loader -- a port of OpenRocket's ``RASPMotorLoader`` (release-24.12).

RASP files carry only header total/propellant weight, so mass is reconstructed from the
thrust curve (``calculate_mass``) and the CG is pinned to ``length/2`` for all time. These
are therefore always "basic" quality motors: total mass is right, but the CG shift over the
burn is an assumption, not data.
"""

from __future__ import annotations

from .digest import DataType, MotorDigest
from .loader_common import (
    calculate_mass,
    finalize_thrust_curve,
    remove_delay,
    sort_lists,
    split,
)
from .motor import PLUGGED_DELAY, Motor


def load_rasp(text: str, remove_delay_from_designation: bool = True) -> list[Motor]:
    """Parse every motor defined in a RASP ``.eng`` file's text."""
    motors: list[Motor] = []
    lines = text.splitlines()
    pos = 0

    while pos < len(lines):
        comment = ""
        # Read leading comment / blank lines.
        while pos < len(lines) and (len(lines[pos]) == 0 or lines[pos][0] == ";"):
            if len(lines[pos]) > 0:
                comment += lines[pos][1:].strip() + "\n"
            pos += 1
        if pos >= len(lines):
            break
        comment = comment.strip()

        # Header: designation diameter length delays propW totalW manufacturer
        pieces = split(lines[pos])
        pos += 1
        if len(pieces) != 7:
            raise ValueError(
                "Illegal RASP header line, expected 7 fields: "
                "designation diameter length delays propellantWeight totalWeight manufacturer"
            )

        designation = pieces[0]
        diameter = float(pieces[1]) / 1000.0
        length = float(pieces[2]) / 1000.0

        delays: list[float] = []
        if not pieces[3].lower() == "none":
            for s in split(pieces[3], r"[-,]+"):
                if s.lower() in ("p", "plugged"):
                    delays.append(PLUGGED_DELAY)
                elif s.isdigit():
                    d = float(s)
                    if d < 99:  # many RASP files use "100" as a placeholder delay
                        delays.append(d)
            delays.sort()

        prop_w = float(pieces[4])
        total_w = float(pieces[5])
        manufacturer = pieces[6]

        if prop_w > total_w:
            raise ValueError("Propellant weight exceeds total weight in RASP file")

        # Data points: "time thrust" until a comment line or EOF.
        time: list[float] = []
        thrust: list[float] = []
        while pos < len(lines) and not (len(lines[pos]) > 0 and lines[pos][0] == ";"):
            buf = split(lines[pos])
            pos += 1
            if len(buf) == 0:
                continue
            if len(buf) == 2:
                time.append(float(buf[0]))
                thrust.append(float(buf[1]))
            else:
                raise ValueError("Illegal RASP data line, expected time and thrust only")

        if len(time) < 2:
            raise ValueError("Illegal RASP file, too short thrust-curve")

        motors.append(
            _create_rasp_motor(
                manufacturer,
                designation,
                comment,
                length,
                diameter,
                delays,
                prop_w,
                total_w,
                time,
                thrust,
                remove_delay_from_designation,
            )
        )

    return motors


def _create_rasp_motor(
    manufacturer, designation, comment, length, diameter, delays, prop_w, total_w,
    time, thrust, remove_delay_from_designation,
) -> Motor:
    sort_lists(time, thrust)
    finalize_thrust_curve(time, thrust)
    mass = calculate_mass(time, thrust, total_w, prop_w)
    cg_x = [length / 2] * len(time)

    if remove_delay_from_designation:
        designation = remove_delay(designation)

    digest = MotorDigest()
    digest.update(DataType.TIME_ARRAY, *time)
    digest.update(DataType.MASS_SPECIFIC, total_w, total_w - prop_w)
    digest.update(DataType.FORCE_PER_TIME, *thrust)

    return Motor(
        manufacturer=manufacturer,
        designation=designation,
        diameter=diameter,
        length=length,
        delays=delays,
        motor_type="UNKNOWN",
        time=time,
        thrust=thrust,
        cg_x=cg_x,
        mass=mass,
        digest=digest.hexdigest(),
        quality="basic",
        file_format="RASP",
        comment=comment,
    )
