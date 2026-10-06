"""The T-0 ullage and the depletion cut (FLT-1, FLT-3).

FLT-1: both propellant tanks were seeded with 0.05 kg of gas at 50 kg/m3, 1.000 L whatever the
tank. The shipped 6.5 kN tanks, loaded to 90 %, have 0.644 L and 0.620 L of ullage, so RocketPy
refused both and the Flight tab could not fly the shipped vehicle at all. The gas that is there
fills V - m/rho_liquid at tank pressure (CoolProp N2).

FLT-3: a truncated burn lost 50 ms, and a fuel-only loop shrank loads within 1 mg of the
integral to 98 % of the fuel; which fired was floating-point noise, a 143 m apogee spread for
loads that differ by micrograms. The cut is now at the exact depletion.

Expected values are hand geometry, CoolProp and the trapezoid of the thrust curve; none of them
come from the flight sim.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

pytest.importorskip("rocketpy")
CP = pytest.importorskip("CoolProp.CoolProp")

from flight_cases import curve_integrals, fly, fly_helpers, header_curve, roomy_tanks, shipped  # noqa: E402

PSI = 6894.757293168


def _tank(res, name):
    return next(p["tank"] for p in res["flight"].rocket.motor.positioned_tanks if p["tank"].name == name)


def test_shipped_vehicle_flies_on_the_flight_tab_path():
    res = fly_helpers(shipped())
    assert res.get("success"), res.get("error")
    assert res["apogee"] > 1000.0


def test_ullage_gas_fills_the_real_ullage_at_tank_pressure():
    cfg = shipped()
    res = fly(cfg)
    for name, sec, rho_l in (("LOX Tank", cfg.lox_tank, 1140.0), ("Fuel Tank", cfg.fuel_tank, 789.0)):
        V = sec.tank_volume_m3
        V_ull = V - sec.mass / rho_l
        rho_g = CP.PropsSI("D", "P", sec.initial_pressure_psi * PSI, "T", 293.15, "Nitrogen")
        tank = _tank(res, name)
        assert tank.gas_volume(0) == pytest.approx(0.999 * V_ull, abs=1e-9)
        assert tank.gas_mass(0) == pytest.approx(0.999 * V_ull * rho_g, rel=1e-6)
    # the hand numbers the finding quotes: 0.644 L and 0.620 L of ullage, ~30 g of N2 each
    assert cfg.lox_tank.tank_volume_m3 - cfg.lox_tank.mass / 1140.0 == pytest.approx(0.6444e-3, abs=1e-6)
    assert cfg.fuel_tank.tank_volume_m3 - cfg.fuel_tank.mass / 789.0 == pytest.approx(0.6202e-3, abs=1e-6)


def test_small_tank_at_ninety_percent_flies():
    """A 5 L LOX tank at 90 % fill: 0.5 L of ullage, half what the old seed demanded."""
    cfg = roomy_tanks(shipped())
    V = 5.0e-3
    cfg.lox_tank.tank_volume_m3 = V
    cfg.lox_tank.lox_h = V / (math.pi * cfg.lox_tank.lox_radius**2)
    cfg.lox_tank.mass = 0.9 * V * 1140.0
    res = fly(cfg)
    assert _tank(res, "LOX Tank").gas_volume(0) == pytest.approx(0.999 * 0.1 * V, abs=1e-9)
    assert res["truncation_info"]["reason"] == "LOX"


def test_a_tank_with_no_ullage_is_refused_by_name():
    """An explicit capacity above what the tank holds lets 110 % of it through the cap (FLT-9);
    the flight names the tank instead of failing inside RocketPy."""
    cfg = shipped()
    full = cfg.lox_tank.tank_volume_m3 * 1140.0
    cfg.design_requirements.lox_tank_capacity_kg = 1.2 * full
    cfg.lox_tank.mass = 1.1 * full
    with pytest.raises(ValueError, match="LOX tank.*leaves no ullage"):
        fly(cfg)


@pytest.mark.parametrize("scale", [1 - 1e-9, 1.0, 1 + 1e-9, 1 + 1e-6])
def test_impulse_is_the_curve_integral_at_the_edge(scale):
    """Loads at the curve's own integral burn the whole curve, whichever side of it they fall."""
    I, IO, IF = curve_integrals()
    cfg = roomy_tanks(shipped())
    cfg.lox_tank.mass, cfg.fuel_tank.mass = IO * scale, IF * scale
    res = fly(cfg)
    motor = res["flight"].rocket.motor
    assert motor.total_impulse / I - 1 == pytest.approx(0.0, abs=5e-4)
    if res["truncation_info"]["truncated"]:
        assert res["truncation_info"]["cutoff_time"] == pytest.approx(motor.burn_out_time, abs=1e-3)


def test_apogee_is_continuous_in_the_load():
    """Was 3941 / 3890 / 4033 m for x(1, 1+1e-9, 1+1e-6). RocketPy's own integrator scatter on
    this vehicle is under 1 m, so that is the bound."""
    _, IO, IF = curve_integrals()
    apogees = []
    for scale in (1 - 1e-9, 1.0, 1 + 1e-9, 1 + 1e-6):
        cfg = roomy_tanks(shipped())
        cfg.lox_tank.mass, cfg.fuel_tank.mass = IO * scale, IF * scale
        apogees.append(fly(cfg)["apogee"])
    assert max(apogees) - min(apogees) < 1.0, apogees


def test_one_percent_short_loses_one_percent_of_impulse():
    I, IO, IF = curve_integrals()
    cfg = roomy_tanks(shipped())
    cfg.lox_tank.mass, cfg.fuel_tank.mass = IO * 0.99, IF * 0.99
    res = fly(cfg)
    motor = res["flight"].rocket.motor
    assert motor.total_impulse / I - 1 == pytest.approx(-0.0100, abs=5e-4)
    assert res["truncation_info"]["cutoff_time"] == pytest.approx(motor.burn_out_time, abs=1e-3)


def test_pressurant_moved_into_the_ullage_stays_on_board():
    """Vehicle mass falls by exactly the propellant burned: the refill is a transfer."""
    t, F, mO, mF = header_curve()
    res = fly(shipped())
    rocket = res["flight"].rocket
    tb = rocket.motor.burn_out_time
    md = mO + mF
    burned = float(np.interp(tb, t, np.concatenate([[0.0], np.cumsum(0.5 * (md[1:] + md[:-1]) * np.diff(t))])))
    assert rocket.total_mass(0.0) - rocket.total_mass(tb + 5.0) == pytest.approx(burned, abs=1e-4)
    copv = _tank(res, "Pressurant (N₂) Tank")
    refill = copv.fluid_mass(0.0) - copv.fluid_mass(tb)
    assert refill > 0.4, "the COPV should have refilled ~0.5 kg of ullage"
    assert res["flight_report"]["copv_refill_kg"] == pytest.approx(refill, rel=2e-3)
