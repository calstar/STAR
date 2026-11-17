"""The one entry point the API layer calls: forces at one flight condition.

Not a port of one Java class: it does what OpenRocket's component-analysis
dialog does -- a FlightConditions at the configuration's reference length and
OpenRocket's default atmosphere, then BarrowmanCalculator.getForceAnalysis --
and returns plain numbers shaped for docs/SCHEMA.md's Analysis.
"""

from __future__ import annotations

import math

from . import _compat as compat
from .barrowman_calculator import BarrowmanCalculator
from .flight_conditions import FlightConditions


def resolve_configuration(rocket_or_config):
    """A FlightConfiguration as given, or the rocket's selected one."""
    if hasattr(rocket_or_config, "get_rocket") and hasattr(rocket_or_config, "is_component_active"):
        return rocket_or_config
    for name in ("get_selected_configuration", "get_default_configuration"):
        f = getattr(rocket_or_config, name, None)
        if callable(f):
            return f()
    raise TypeError(f"not a rocket or a flight configuration: {type(rocket_or_config).__name__}")


def flight_conditions(config, mach: float, aoa_rad: float, roll_rate: float = 0.0,
                      theta: float = 0.0) -> FlightConditions:
    fc = FlightConditions(config)
    fc.set_mach(mach)
    fc.set_aoa(aoa_rad)
    fc.set_theta(theta)
    fc.set_roll_rate(roll_rate)
    return fc


def _num(v: float):
    return None if (v is None or math.isnan(v) or math.isinf(v)) else float(v)


def forces_dict(comp, f) -> dict:
    cp = f.get_cp()
    return {
        "id": compat.id_of(comp),
        "name": compat.name_of(comp),
        "type": type(comp).__name__,
        "assembly": compat.is_a(comp, "ComponentAssembly"),
        "cpx": _num(cp.x),
        "cna": _num(cp.weight),
        "cn": _num(f.get_cn()),
        "cm": _num(f.get_cm()),
        "croll": _num(f.get_croll()),
        "crollDamp": _num(f.get_croll_damp()),
        "crollForce": _num(f.get_croll_force()),
        "cd": _num(f.get_cd()),
        "cdAxial": _num(f.get_cd_axial()),
        "friction": _num(f.get_friction_cd()),
        "pressure": _num(f.get_pressure_cd()),
        "base": _num(f.get_base_cd()),
        "override": _num(f.get_override_cd()),
    }


def analyze(rocket_or_config, mach: float, aoa_rad: float, roll_rate: float = 0.0, theta: float = 0.0) -> dict:
    """OpenRocket's force analysis at (mach, aoa, roll rate, theta), default atmosphere.

    Returns::

        {"conditions": {mach, aoa, theta, rollRate, velocity, reynolds},
         "reference": {length, area},
         "cp": {x, cna}, "cn", "cm", "croll", "crollDamp", "crollForce",
         "cd": {total, axial, friction, pressure, base, override},
         "components": [ {id, name, type, assembly, cpx, cna, cn, cm, croll, crollDamp,
                          crollForce, cd, cdAxial, friction, pressure, base, override} ],
         "warnings": [str]}

    ``components`` is in tree order and holds every active aerodynamic component
    and every active assembly (rocket, stages, pods) -- the rocket's own row is
    the total. A component's drag is per instance, as OpenRocket reports it; the
    totals count every instance. Positions are absolute metres from the nose tip.
    """
    config = resolve_configuration(rocket_or_config)
    fc = flight_conditions(config, mach, aoa_rad, roll_rate, theta)
    warnings: list = []
    calc = BarrowmanCalculator()
    fmap = calc.get_force_analysis(config, fc, warnings)

    rocket = compat.get_rocket(config)
    order = {id(c): i for i, c in enumerate(compat.all_components(config))}
    rows = [forces_dict(c, f) for c, f in sorted(fmap.items(), key=lambda kv: order.get(id(kv[0]), 1 << 30))]
    total = fmap[rocket]
    cp = total.get_cp()
    velocity = fc.get_velocity()
    return {
        "conditions": {
            "mach": fc.get_mach(), "aoa": fc.get_aoa(), "theta": fc.get_theta(),
            "rollRate": fc.get_roll_rate(), "velocity": velocity,
            "reynolds": calc.calculate_reynolds_number(config, fc),
        },
        "reference": {"length": fc.get_ref_length(), "area": fc.get_ref_area()},
        "cp": {"x": _num(cp.x), "cna": _num(cp.weight)},
        "cn": _num(total.get_cn()),
        "cm": _num(total.get_cm()),
        "croll": _num(total.get_croll()),
        "crollDamp": _num(total.get_croll_damp()),
        "crollForce": _num(total.get_croll_force()),
        "cd": {
            "total": _num(total.get_cd()), "axial": _num(total.get_cd_axial()),
            "friction": _num(total.get_friction_cd()), "pressure": _num(total.get_pressure_cd()),
            "base": _num(total.get_base_cd()), "override": _num(total.get_override_cd()),
        },
        "components": rows,
        "warnings": sorted(set(map(str, warnings))),
    }
