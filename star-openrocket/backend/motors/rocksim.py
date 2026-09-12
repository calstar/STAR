"""RockSim ``.rse`` loader -- a port of OpenRocket's ``RockSimMotorLoader`` (release-24.12).

RockSim files are XML and may carry real per-point mass and CG. They are "full" quality
when they provide real per-time CG; if ``auto-calc-cg`` is set (or CG values are missing),
OpenRocket falls back to the ``length/2`` assumption and the motor is "basic" for CG.
Mass falls back to ``calculate_mass`` under ``auto-calc-mass`` the same way.
"""

from __future__ import annotations

import math
from xml.etree import ElementTree as ET

from .digest import DataType, MotorDigest
from .loader_common import (
    calculate_mass,
    finalize_thrust_curve,
    remove_delay,
    sort_lists,
)
from .motor import PLUGGED_DELAY, Motor

_DELAY_LIMIT = 90


def _parse_double(value: str | None) -> float:
    if value is None:
        return float("nan")
    try:
        return float(value)
    except ValueError:
        return float("nan")


def _has_illegal_value(values: list[float]) -> bool:
    return any(v is None or math.isnan(v) or math.isinf(v) for v in values)


def _flag(value: str | None) -> bool:
    """RockSim auto-calc flag: '0'/'false' -> False, anything else -> True."""
    return not (value == "0" or (value or "").lower() == "false")


def load_rocksim(text: str) -> list[Motor]:
    """Parse every motor defined in a RockSim ``.rse`` file's text."""
    root = ET.fromstring(text)
    motors: list[Motor] = []
    for engine in root.iter("engine"):
        motors.append(_parse_engine(engine))
    return motors


def _parse_engine(engine: ET.Element) -> Motor:
    a = engine.attrib

    manufacturer = a.get("mfg")
    if manufacturer is None:
        raise ValueError("Manufacturer missing")

    code = a.get("code")
    if code is None:
        raise ValueError("Designation missing")
    designation = remove_delay(code)

    delays: list[float] = []
    delay_str = a.get("delays")
    if delay_str is not None:
        for token in delay_str.split(","):
            try:
                d = float(token)
                if d >= _DELAY_LIMIT:
                    d = PLUGGED_DELAY
                delays.append(d)
            except ValueError:
                if delay_str.lower() in ("p", "plugged"):
                    delays.append(PLUGGED_DELAY)

    diameter = _require_mm(a.get("dia"), "diameter")
    length = _require_mm(a.get("len"), "length")
    init_mass = _require_mm(a.get("initWt"), "initial mass")
    prop_mass = _require_mm(a.get("propWt"), "propellant mass")

    if prop_mass > init_mass:
        raise ValueError("Propellant weight exceeds total weight in RockSim engine format")

    type_str = (a.get("Type") or "").lower()
    motor_type = {
        "single-use": "SINGLE",
        "hybrid": "HYBRID",
        "reloadable": "RELOAD",
    }.get(type_str, "UNKNOWN")

    calculate_mass_flag = _flag(a.get("auto-calc-mass"))
    calculate_cg_flag = _flag(a.get("auto-calc-cg"))

    comment = ""
    comments_el = engine.find("comments")
    if comments_el is not None and comments_el.text:
        comment = comments_el.text.strip()

    time: list[float] = []
    force: list[float] = []
    mass: list[float] = []
    cg: list[float] = []
    for point in engine.iter("eng-data"):
        t = _parse_double(point.get("t"))
        f = _parse_double(point.get("f"))
        m = _parse_double(point.get("m")) / 1000.0
        g = _parse_double(point.get("cg")) / 1000.0
        if math.isnan(t) or math.isnan(f):
            raise ValueError("Illegal motor data point encountered")
        time.append(t)
        force.append(f)
        mass.append(m)
        cg.append(g)

    if not time:
        raise ValueError("Illegal motor data")

    sort_lists(time, force, mass, cg)
    if _has_illegal_value(mass):
        calculate_mass_flag = True
    if _has_illegal_value(cg):
        calculate_cg_flag = True

    finalize_thrust_curve(time, force, mass, cg)
    n = len(time)

    if _has_illegal_value(mass):
        calculate_mass_flag = True
    if _has_illegal_value(cg):
        calculate_cg_flag = True

    if calculate_mass_flag:
        mass = calculate_mass(time, force, init_mass, prop_mass)
    if calculate_cg_flag:
        cg = [length / 2] * n

    digest = MotorDigest()
    digest.update(DataType.TIME_ARRAY, *time)
    if not calculate_mass_flag:
        digest.update(DataType.MASS_PER_TIME, *mass)
    else:
        digest.update(DataType.MASS_SPECIFIC, init_mass, init_mass - prop_mass)
    if not calculate_cg_flag:
        digest.update(DataType.CG_PER_TIME, *cg)
    digest.update(DataType.FORCE_PER_TIME, *force)

    return Motor(
        manufacturer=manufacturer,
        designation=designation,
        diameter=diameter,
        length=length,
        delays=delays,
        motor_type=motor_type,
        time=time,
        thrust=force,
        cg_x=cg,
        mass=mass,
        digest=digest.hexdigest(),
        quality="basic" if calculate_cg_flag else "full",
        file_format="RockSim",
        comment=comment,
    )


def _require_mm(value: str | None, name: str) -> float:
    if value is None:
        raise ValueError(f"{name} missing")
    try:
        return float(value) / 1000.0
    except ValueError as exc:
        raise ValueError(f"Invalid {name} {value}") from exc
