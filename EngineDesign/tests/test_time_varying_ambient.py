"""The time-varying solver must fire the nozzle into the same sky as the steady solve.

Found while integrating a flat dome-regulated burn: ``evaluate_arrays_with_time`` reported
6344.1 N at t=0 where ``evaluate()`` reported 6405.5 N for the same tank pressures and the
same geometry. Pc, mdot, O/F and c* agreed to four figures -- only thrust differed, by exactly
``(101325 - P_a(site)) * A_exit`` = 61.35 N. ``TimeVaryingCoupledSolver.solve_time_step``
hardcoded ``Pa = 101325.0`` while the steady path derives ambient from
``environment.elevation``. Every time-series thrust, impulse and burn-time number was low by
the site's altitude, and the two paths disagreed about the same engine.

At t=0 nothing has receded yet, so the two paths evaluate identical geometry and must agree.
"""
import copy
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.core.runner import PintleEngineRunner, compute_ambient_pressure_from_elevation  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402

# A shipped config, not a golden one: tests/golden/ is gitignored, so a test
# that leaned on it errored on every machine but the one it was written on,
# CI included. What the test needs is the coupled ablative path on an ethalox
# engine, and the 180 lb point ships with exactly that.
_CFG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "configs", "ethalox_180lb_8to1.yaml")
_PSI = 6894.757


@pytest.fixture(scope="module")
def cfg():
    c = load_config(_CFG)
    # Put the pad somewhere with real altitude so a sea-level default is visibly wrong:
    # 626.67 m is the elevation the shipped ethalox configs declare (94.07 kPa, 7.2 % below 1 atm).
    c.environment.elevation = 626.67
    assert c.ablative_cooling is not None and c.ablative_cooling.enabled
    assert getattr(c.ablative_cooling, "track_geometry_evolution", False), \
        "fixture must exercise the coupled time-varying path"
    return c


def test_time_varying_t0_matches_steady_thrust(cfg):
    P_O = cfg.lox_tank.initial_pressure_psi * _PSI
    P_F = cfg.fuel_tank.initial_pressure_psi * _PSI

    steady = PintleEngineRunner(copy.deepcopy(cfg)).evaluate(P_O, P_F, silent=True)

    t = np.array([0.0, 0.05])
    tv = PintleEngineRunner(copy.deepcopy(cfg)).evaluate_arrays_with_time(
        t, np.array([P_O, P_O]), np.array([P_F, P_F]), use_coupled_solver=True)

    # Same geometry, same chamber state -> the two paths must agree on thrust at t=0.
    # Chamber quantities are the control: they agreed before the fix, so if THEY move the
    # test is measuring something else.
    assert abs(float(tv["Pc"][0]) / float(steady["Pc"]) - 1.0) < 1e-3
    assert abs(float(tv["mdot_total"][0]) / float(steady["mdot_total"]) - 1.0) < 1e-3

    F_tv = float(tv["F"][0])
    F_st = float(steady["F"])
    # The bug was a fixed Pa*Ae offset; require agreement well inside that offset.
    Ae = float(cfg.chamber_geometry.A_exit)
    offset_if_sea_level = (101325.0 - compute_ambient_pressure_from_elevation(626.67)) * Ae
    assert abs(F_tv - F_st) < 0.1 * offset_if_sea_level, (
        f"t=0 thrust disagrees: time-varying {F_tv:.2f} N vs steady {F_st:.2f} N "
        f"(a sea-level ambient would put them {offset_if_sea_level:.2f} N apart)")


def test_explicit_ambient_is_respected(cfg):
    """Passing P_ambient must override the site elevation in both paths alike."""
    P_O = cfg.lox_tank.initial_pressure_psi * _PSI
    P_F = cfg.fuel_tank.initial_pressure_psi * _PSI
    Pa = 60000.0  # well above the pad, well away from either default
    steady = PintleEngineRunner(copy.deepcopy(cfg)).evaluate(P_O, P_F, P_ambient=Pa, silent=True)
    t = np.array([0.0, 0.05])
    tv = PintleEngineRunner(copy.deepcopy(cfg)).evaluate_arrays_with_time(
        t, np.array([P_O, P_O]), np.array([P_F, P_F]), P_ambient=Pa, use_coupled_solver=True)
    assert abs(float(tv["F"][0]) - float(steady["F"])) < 0.5
