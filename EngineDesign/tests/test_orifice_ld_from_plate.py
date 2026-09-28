"""Orifice L/d from the plate as built, and the Cd it gives (docs/injector_face_and_manifold_plan.md, phase 6).

The discharge block used to take L/d as a typed number while the plate thickness, hole angle
and counterbore that decide it lived elsewhere. On SHIP the declared 4.0 is right only
because a 4 mm counterbore is drilled; skip it and the small drill runs L/d 9.7 (LOX) and
13.2 (fuel), Cd falls to 0.745 / 0.715, and the engine makes 3.1 % less thrust at O/F 1.70.
"""
from __future__ import annotations

import copy
import math
from contextlib import contextmanager
from pathlib import Path

import pytest

from engine.core.discharge import (
    LICHTAROWICZ_A, LICHTAROWICZ_B, cd_inf_from_inlet_geometry, cd_length_factor, cd_with_approach,
)
from engine.core.injectors.layout import effective_discharge, realized_land

ROOT = Path(__file__).resolve().parents[1]
PSI = 6894.757
SHIP = ROOT / "configs/ethalox_8kN_SHIP.yaml"


def _ship(src=None, model=None, counterbore="keep"):
    from engine.pipeline.io import load_config
    from engine.pipeline.config_schemas import InjectorPlateConfig
    c = load_config(str(SHIP))
    # The ship is drilled through a flat plate into a plenum (an undeclared plate now draws the
    # stand's contoured, channelled plug).
    c.injector.plate = InjectorPlateConfig(face="flat", back="plenum")
    for side in ("oxidizer", "fuel"):
        if src:
            c.discharge[side].l_over_d_source = src
        if model:
            c.discharge[side].length_model = model
    if counterbore != "keep":
        c.design_requirements.layer1_injector_counterbore_dia_m = counterbore
    return c


# ---- the default moves nothing ---------------------------------------------------------------

def test_declared_returns_the_block_itself():
    c = _ship()
    assert effective_discharge(c, "oxidizer") is c.discharge["oxidizer"]


def test_piecewise_default_is_unchanged():
    # 'piecewise' is now a named legacy option; the default length model is Lichtarowicz.
    assert cd_length_factor(4.0, "piecewise") == 1.0
    assert cd_length_factor(10.0, "piecewise") == pytest.approx(0.94)
    assert cd_length_factor(0.0) == 1.0          # non-positive -> no correction, as before
    assert cd_with_approach(0.8, None) == 0.8


# ---- Lichtarowicz ------------------------------------------------------------------------------

@pytest.mark.parametrize("ld", [2.0, 4.0, 7.0, 10.0])
def test_lichtarowicz_reproduces_the_published_fit_for_a_sharp_inlet(ld):
    """Sharp inlet (table 0.80) x factor must equal Cd_u = 0.827 - 0.0085 L/d exactly."""
    assert 0.80 * cd_length_factor(ld, "lichtarowicz") == pytest.approx(0.827 - 0.0085 * ld, rel=1e-12)


def test_lichtarowicz_keeps_the_thin_plate_anchor():
    assert 0.80 * cd_length_factor(1e-9, "lichtarowicz") == pytest.approx(0.61, abs=1e-6)
    # continuous at L/d 2
    assert cd_length_factor(2.0 - 1e-9, "lichtarowicz") == pytest.approx(
        cd_length_factor(2.0, "lichtarowicz"), abs=1e-8)


# ---- counterbore velocity of approach -------------------------------------------------------

def test_approach_by_independent_energy_balance():
    """Plenum -> counterbore (entrance K) -> orifice; solve the drops for a mass flow, compare."""
    cd, beta, K = 0.80, 0.45, 0.5
    rho, A, dp_total = 1000.0, 1e-6, 1e6
    # unknown v (orifice velocity); counterbore velocity beta^2 v
    # dp_orifice (static, tap in the counterbore) = rho v^2 (1 - beta^4) / (2 cd^2)
    # dp_entrance = rho (beta^2 v)^2 (1 + K) / 2
    v = math.sqrt(2 * dp_total / (rho * ((1 - beta ** 4) / cd ** 2 + beta ** 4 * (1 + K))))
    mdot = rho * v * A
    cd_eff = mdot / (A * math.sqrt(2 * rho * dp_total))
    assert cd_with_approach(cd, beta, K) == pytest.approx(cd_eff, rel=1e-12)


# ---- the land the plate gives ----------------------------------------------------------------

def test_no_counterbore_means_the_small_drill_runs_the_whole_passage():
    rl = realized_land(d=0.0017094, theta_deg=40.0, plate_thickness=0.0127,
                       counterbore_dia=0.0, declared_land_ld=4.0)
    assert rl["land_ld"] == pytest.approx(0.0127 / math.cos(math.radians(40)) / 0.0017094)
    assert rl["beta"] is None


def test_a_counterbore_leaves_the_declared_land():
    rl = realized_land(d=0.0017094, theta_deg=40.0, plate_thickness=0.0127,
                       counterbore_dia=0.004, declared_land_ld=4.0)
    assert rl["land_ld"] == pytest.approx(4.0)
    assert rl["beta"] == pytest.approx(0.0017094 / 0.004)


def test_a_land_longer_than_the_passage_is_capped():
    rl = realized_land(d=0.001, theta_deg=0.0, plate_thickness=0.003,
                       counterbore_dia=0.004, declared_land_ld=10.0)
    assert rl["land_ld"] == pytest.approx(3.0) and rl["beta"] is None


def test_ship_without_its_counterbore():
    c = _ship(src="plate", model="lichtarowicz", counterbore=None)
    eO, eF = effective_discharge(c, "oxidizer"), effective_discharge(c, "fuel")
    assert eO.orifice_l_over_d == pytest.approx(9.70, abs=0.01)
    assert eF.orifice_l_over_d == pytest.approx(13.15, abs=0.01)
    assert cd_inf_from_inlet_geometry(eF) < cd_inf_from_inlet_geometry(eO) < 0.80


# ---- both solver paths agree -----------------------------------------------------------------

@contextmanager
def _python_only():
    from engine import accel
    real_enabled, real_require = accel.enabled, accel.require
    accel.enabled = lambda: False
    accel.require = lambda: False
    try:
        yield
    finally:
        accel.enabled, accel.require = real_enabled, real_require


@pytest.mark.parametrize("counterbore", ["keep", None], ids=["counterbored", "bare"])
def test_python_and_accelerator_agree_with_plate_ld(counterbore):
    from engine import accel
    from engine.core.runner import PintleEngineRunner
    if not accel.available():
        pytest.skip("numba unavailable")
    c = _ship(src="plate", model="lichtarowicz", counterbore=counterbore)
    runner = PintleEngineRunner(c)
    P = (c.lox_tank.initial_pressure_psi * PSI, c.fuel_tank.initial_pressure_psi * PSI)
    from engine.core.injectors import get_injector_model
    with _python_only():
        ref = runner.evaluate(*P, P_ambient=101325.0, silent=True)
    # The chamber kernels are gated off until they mirror the Python chamber physics
    # (accel.chamber_physics_not_mirrored); the injector kernel is what the default path runs,
    # so that is where the plate's L/d has to arrive.
    got = accel.solve(c, *P, ref["Pc"])
    assert got is not None
    mO, mF, _ = get_injector_model(c).solve(*P, ref["Pc"])
    assert got[0] == pytest.approx(mO, rel=1e-9)
    assert got[1] == pytest.approx(mF, rel=1e-9)
    assert mO == pytest.approx(ref["mdot_O"], rel=1e-6)
    # Bare, the drill runs L/d 9.7/13.2 against the declared 4.0: a different engine, or the
    # option did nothing. Counterbored, the plate gives the declared 4.0 (see the module
    # docstring) and the Cd model is the default Lichtarowicz, so the two must agree instead.
    base = PintleEngineRunner(_ship()).evaluate(*P, P_ambient=101325.0, silent=True)
    if counterbore is None:
        assert abs(ref["F"] - base["F"]) / base["F"] > 1e-3
    else:
        assert ref["F"] == pytest.approx(base["F"], rel=1e-3)


# ---- cavitation margin (Nurick 1976), reporting only ------------------------------------------

from engine.core.discharge import cavitation_margin, contraction_coefficient  # noqa: E402


def test_contraction_coefficient():
    assert contraction_coefficient(0.0) == pytest.approx(0.62)
    assert contraction_coefficient(0.1) == pytest.approx((1 / 0.62 ** 2 - 1.14) ** -0.5)
    assert contraction_coefficient(1.0) == pytest.approx(0.98)      # capped, well rounded


def test_margin_is_k_over_cd_over_cc_squared():
    m = cavitation_margin(P_in=4.0e6, Pc=3.0e6, Pv=1.0e5, Cd=0.80)
    assert m["K"] == pytest.approx((4.0e6 - 1.0e5) / 1.0e6)
    assert m["K_crit"] == pytest.approx((0.80 / 0.62) ** 2)
    assert m["margin"] == pytest.approx(m["K"] / m["K_crit"])


def test_ship_is_clear_and_warm_lox_is_not():
    from engine.core.runner import PintleEngineRunner
    c = _ship()
    P = (c.lox_tank.initial_pressure_psi * PSI, c.fuel_tank.initial_pressure_psi * PSI)
    cav = PintleEngineRunner(c).evaluate(*P, silent=True)["injector_cavitation"]
    assert cav["O"]["margin"] > 2.0 and cav["F"]["margin"] > 2.0
    # LOX sitting saturated at 500 psia -- the self-pressurisation case feed-twin models --
    # leaves the vena contracta at vapour pressure.
    c.fluids["oxidizer"].vapor_pressure = 500 * PSI
    cav = PintleEngineRunner(c).evaluate(*P, silent=True)["injector_cavitation"]
    assert cav["O"]["margin"] < 1.0


def test_the_report_changes_no_flow():
    from engine.core.runner import PintleEngineRunner
    c = _ship()
    P = (c.lox_tank.initial_pressure_psi * PSI, c.fuel_tank.initial_pressure_psi * PSI)
    base = PintleEngineRunner(c).evaluate(*P, silent=True)
    c.fluids["oxidizer"].vapor_pressure = 500 * PSI
    warm = PintleEngineRunner(c).evaluate(*P, silent=True)
    assert warm["F"] == pytest.approx(base["F"], rel=1e-12)
