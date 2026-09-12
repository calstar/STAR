"""PLAN.md §13 as a golden fixture.

The document asserts specific numbers in eight sections. Rather than maintain a
second implementation to reproduce them, those numbers become assertions
against the real one: if the library and the plan disagree, CI says so.

`fixtures/worked_example.json` is the §13.1 input table verbatim.
"""

import json
import math
import os

import pytest

from physics.atmosphere import Atmosphere
from physics.constants import LBF_TO_N, M_TO_FT, N_TO_LBF, RHO0
from physics.devices import airframe_band
from physics.dynamics import v_terminal
from physics.loads import (
    coast_ceiling,
    delta_t_max,
    device_loads,
    equivalent_height,
    impact_energy,
    v_s_max,
)
from physics.schema import Config, Trigger, TriggerKind
from physics.solver import integrate
from physics.cases import evaluate_all

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "fixtures", "worked_example.json")


def load_config():
    with open(FIXTURE, encoding="utf-8") as handle:
        return Config.model_validate(json.load(handle))


def run_with_loads(which):
    config = load_config()
    run = integrate(config, which)
    per = {dl.name: dl for dl in
           (device_loads(d, s, run.m, run.m_b, run.traj)
            for d, s in zip(run.devices, run.states))}
    return run, per


# --- §13.1 inputs ----------------------------------------------------------


def test_13_1_inputs_are_self_consistent():
    config = load_config()
    assert config.vehicle.m == 5.67
    assert config.vehicle.h_a == 914.0
    assert config.site.z_site == 630.0  # FAR, physics/site.py

    # m_b = m - sum(m_c)
    m_b = config.vehicle.m - sum(d.m_c for d in config.devices)
    assert m_b == pytest.approx(5.397, abs=5e-4)

    # The §13.1 airframe band, and the 36.1x that §15.5 quotes.
    axial, broadside = airframe_band(config.vehicle.d_body, config.vehicle.l_body)
    assert axial == pytest.approx(0.00486, abs=5e-6)
    assert broadside == pytest.approx(0.17556, abs=5e-5)
    assert broadside / axial == pytest.approx(36.1, abs=0.1)


def test_13_1_pad_temperature_makes_the_refit_the_identity():
    """T_pad = 284.90 K is ISA at 500 m, so eq (7) must return -6.5 K/km
    exactly. That keeps §5's free regression test live inside the fixture."""
    config = load_config()
    atm = Atmosphere(config.site.z_site, config.site.T_pad, config.site.p_pad)
    assert atm.L0 == pytest.approx(-0.0065, abs=2e-7)
    assert atm.p_pad == pytest.approx(93983.0, abs=2.0)
    assert atm.rho(0.0) == pytest.approx(1.15261, abs=1e-4)


def test_13_1_harness_series_gives_the_8_4_ceiling():
    """The main's k_eff is the eq (32) series of a 44 545 N/m Kevlar cord and
    28 556 N/m nylon lines, which is what makes §8.4's event-B ceiling 0.625."""
    k_cord, k_lines = 44545.0, 28556.0
    series = 1.0 / (1.0 / k_cord + 1.0 / k_lines)
    assert series == pytest.approx(17400.0, abs=2.0)
    assert math.sqrt(series / k_cord) == pytest.approx(0.625, abs=0.001)


# --- §13.2 outputs, both bounds -------------------------------------------

EXPECTED = {
    "axial": {
        "drogue_v_s": 19.49, "drogue_F_inf": 54.1,
        "main_t_d": 31.3, "main_v_s": 25.18, "main_q_s": 360.0,
        "main_t_f": 0.509, "main_A": 0.3132, "main_X1": 0.2686,
        "main_F_inf": 1613.0, "main_F_pflanz": 433.3,
        "F_T_raw": 266.0, "F_T_Cx": 479.0,
        "descent_rate": 6.04, "descent_time": 54.8, "KE": 103.0,
        "F_design": 2420.0,
    },
    "broadside": {
        "drogue_v_s": 16.27, "drogue_F_inf": 37.7,
        "main_t_d": 44.2, "main_v_s": 17.35, "main_q_s": 171.0,
        "main_t_f": 0.738, "main_A": 0.3132, "main_X1": 0.2686,
        "main_F_inf": 766.0, "main_F_pflanz": 205.8,
        "F_T_raw": 133.0, "F_T_Cx": 240.0,
        "descent_rate": 5.85, "descent_time": 68.8, "KE": 97.0,
        "F_design": 1149.0,
    },
}


def _check_bound(which):
    want = EXPECTED[which]
    run, per = run_with_loads(which)
    drogue, main = per["drogue"], per["main"]

    assert drogue.v_s == pytest.approx(want["drogue_v_s"], abs=0.02)
    assert drogue.F_inf == pytest.approx(want["drogue_F_inf"], abs=1.0)

    assert main.t_f == pytest.approx(want["main_t_f"], abs=0.002)
    assert main.v_s == pytest.approx(want["main_v_s"], abs=0.02)
    assert main.q_s == pytest.approx(want["main_q_s"], abs=1.0)
    assert main.A == pytest.approx(want["main_A"], abs=5e-4)
    assert main.X1 == pytest.approx(want["main_X1"], abs=5e-4)
    assert main.F_inf == pytest.approx(want["main_F_inf"], abs=2.0)
    assert main.F_pflanz == pytest.approx(want["main_F_pflanz"], abs=1.0)
    assert main.ratio == pytest.approx(3.72, abs=0.01)

    peak = float(run.traj.F_T.max())
    assert peak == pytest.approx(want["F_T_raw"], abs=1.0)
    assert 1.8 * peak == pytest.approx(want["F_T_Cx"], abs=2.0)

    assert run.t_ground == pytest.approx(want["descent_time"], abs=0.15)
    assert run.v_impact == pytest.approx(want["descent_rate"], abs=0.02)
    assert impact_energy(run.m, run.v_impact) == pytest.approx(want["KE"], abs=1.0)

    # Snatch is the same at both bounds -- it depends on v_rel, k_eff and mu,
    # none of which the airframe touches.
    assert main.F_snatch == pytest.approx(597.1, abs=0.5)
    assert drogue.F_snatch == pytest.approx(385.2, abs=0.5)

    # eq (36)
    candidates = [main.F_inf, main.F_snatch, drogue.F_inf, drogue.F_snatch,
                  1.8 * peak]
    assert 1.5 * max(candidates) == pytest.approx(want["F_design"], abs=3.0)


def test_13_2_axial_bound():
    _check_bound("axial")


def test_13_2_broadside_bound():
    _check_bound("broadside")


def test_13_2_A_and_X1_do_not_depend_on_the_airframe():
    """Eq (24) contains no v_s, so the attitude band moves the load but not
    the finite-mass credit. This is eq (44) visible in a table."""
    _, ax = run_with_loads("axial")
    _, br = run_with_loads("broadside")
    assert ax["main"].A == pytest.approx(br["main"].A, rel=1e-9)
    assert ax["main"].X1 == pytest.approx(br["main"].X1, rel=1e-9)


def test_13_3_attitude_band_is_worth_2_1x_on_design_load():
    """§13.3 note 1: the single largest term in the model."""
    ratio = EXPECTED["axial"]["F_design"] / EXPECTED["broadside"]["F_design"]
    assert ratio == pytest.approx(2.1, abs=0.05)


def test_13_3_snatch_exceeds_the_realistic_opening_load():
    """§13.3 note 2: model only opening and you under-report the peak by
    1.3-2.5x. This is the argument for §8.4 in Phase 1."""
    for which in ("axial", "broadside"):
        run, per = run_with_loads(which)
        numerical = 1.8 * float(run.traj.F_T.max())
        assert per["main"].F_snatch > numerical


def test_13_3_bound_is_3_75x_the_pflanz_value():
    """§13.3 note 4. Report both so nobody over-builds a bulkhead fourfold
    without knowing it."""
    _, per = run_with_loads("axial")
    assert per["main"].ratio == pytest.approx(3.72, abs=0.01)


def test_13_3_drogue_keeps_flying_after_the_main_opens():
    """§13.3 note 5, eq (13). Easy to get wrong by hand."""
    run, _ = run_with_loads("axial")
    with_drogue = v_terminal(run.m, run.atm.g(0.0), run.atm.rho(0.0),
                             2.489 + 0.15 + run.CdS_body)
    main_alone = v_terminal(run.m, run.atm.g(0.0), run.atm.rho(0.0), 2.489)
    assert with_drogue * M_TO_FT == pytest.approx(19.8, abs=0.1)
    assert main_alone * M_TO_FT == pytest.approx(20.4, abs=0.1)
    assert with_drogue < main_alone


def test_13_vendor_cross_check_at_sea_level():
    """Fruity Chutes claims 19.8 fps at 12.5 lb for the IFC-48. Eq (18) with
    the main alone at sea-level density gives 19.81. Note this is deliberately
    NOT the site-elevation number -- the difference is density, not
    disagreement."""
    from physics.constants import G0

    v = v_terminal(5.67, G0, RHO0, 2.489)
    assert v * M_TO_FT == pytest.approx(19.81, abs=0.02)


# --- §11.5 off-nominal set -------------------------------------------------


def test_11_5_off_nominal_table():
    """Each case fails in a different category, which is why no single
    pass/fail number covers them."""
    config = load_config()
    results = evaluate_all(config, "axial")

    want = {
        "nominal": (54.8, 6.04, 103.0, 1613.0),
        "simultaneous": (145.5, 6.04, 103.0, 898.0),
        "no_main": (37.3, 25.00, 1771.0, 54.0),
        "no_drogue": (35.0, 6.22, 110.0, 27029.0),
    }
    for case, (t_g, v_i, ke, F_inf) in want.items():
        cr = results[case]
        assert cr.run.t_ground == pytest.approx(t_g, rel=0.01), case
        assert cr.run.v_impact == pytest.approx(v_i, abs=0.03), case
        assert impact_energy(cr.run.m, cr.run.v_impact) == pytest.approx(
            ke, rel=0.01), case
        peak = max(d.F_inf for d in cr.per_device if d.fired)
        assert peak == pytest.approx(F_inf, rel=0.01), case


def test_11_5_case_1_is_structurally_the_gentlest():
    """Counterintuitive and worth pinning: the main opens slower AND where the
    air is thinner, giving 56% of the nominal load -- while taking 2.7x as
    long to come down, which is the part that actually bites."""
    results = evaluate_all(load_config(), "axial")
    nom = max(d.F_inf for d in results["nominal"].per_device if d.fired)
    sim = max(d.F_inf for d in results["simultaneous"].per_device if d.fired)
    assert sim / nom == pytest.approx(0.56, abs=0.02)
    assert (results["simultaneous"].run.t_ground
            / results["nominal"].run.t_ground) == pytest.approx(2.7, abs=0.05)


def test_11_5_case_2_lands_at_17x_the_nominal_energy():
    results = evaluate_all(load_config(), "axial")
    nom = impact_energy(results["nominal"].run.m, results["nominal"].run.v_impact)
    fail = impact_energy(results["no_main"].run.m, results["no_main"].run.v_impact)
    assert fail / nom == pytest.approx(17.0, abs=0.5)
    assert equivalent_height(results["no_main"].run.v_impact) == pytest.approx(
        31.0, abs=1.0)


def test_11_5_case_3_is_the_structural_one():
    """17x nominal load. A slick airframe reaches ~103 m/s in the 762 m of
    free fall before the main's altitude, and F proportional to v_s^2 does the
    rest."""
    results = evaluate_all(load_config(), "axial")
    nom = max(d.F_inf for d in results["nominal"].per_device if d.fired)
    fail = max(d.F_inf for d in results["no_drogue"].per_device if d.fired)
    assert fail / nom == pytest.approx(16.9, abs=0.3)
    main = next(d for d in results["no_drogue"].per_device if d.name == "main")
    assert main.v_s == pytest.approx(103.0, abs=1.5)


def test_11_5_case_3_is_far_milder_broadside():
    """A tumbling airframe is its own drogue. The axial figure is the one to
    design against, since nothing guarantees the vehicle tumbles."""
    ax = evaluate_all(load_config(), "axial")["no_drogue"]
    br = evaluate_all(load_config(), "broadside")["no_drogue"]
    ax_F = max(d.F_inf for d in ax.per_device if d.fired)
    br_F = max(d.F_inf for d in br.per_device if d.fired)
    assert ax_F == pytest.approx(27029.0, rel=0.01)
    assert br_F == pytest.approx(1423.0, rel=0.02)


# --- §11.10 the main's load is altitude-independent ------------------------


def test_11_10_main_opening_load_is_independent_of_deploy_altitude():
    """q_s = mg/(CdS)_{d+b} once the vehicle is at drogue terminal velocity,
    so density cancels exactly. Verified at three altitudes: v_s rises and rho
    falls to compensate."""
    import copy

    config = load_config()
    loads, speeds = [], []
    for z_d in (152.0, 300.0, 500.0):
        cfg = copy.deepcopy(config)
        main = next(d for d in cfg.devices if d.name == "main")
        main.trigger = Trigger(kind=TriggerKind.ALTITUDE, value=z_d)
        run = integrate(cfg, "axial")
        dl = device_loads(main, run.state_of("main"), run.m, run.m_b, run.traj)
        loads.append(dl.F_inf)
        speeds.append(dl.v_s)

    assert loads[0] == pytest.approx(1613.3, abs=1.0)
    for F in loads[1:]:
        assert F == pytest.approx(loads[0], rel=1e-3)
    # v_s genuinely moves; it is the density that cancels it.
    assert speeds[-1] > speeds[0]


# --- §4.0 early deployment, eq (56) ---------------------------------------


def test_4_0_early_deployment_bounds():
    """With a 1000 lbf weakest link. The main is the binding constraint by
    3.3x, and the ceiling is set by coast dynamics rather than by what you
    build."""
    config = load_config()
    run = integrate(config, "axial")
    rho_a = run.atm.rho(config.vehicle.h_a)
    F_allow = 1000.0 * LBF_TO_N / 1.5

    dt, v_c = delta_t_max(
        v_s_max(F_allow, rho_a, 0.15, 1.8), run.m, rho_a, run.CdS_body)
    assert v_c == pytest.approx(147.2, abs=1.0)
    assert dt == pytest.approx(11.6, abs=0.2)

    dt_main, _ = delta_t_max(
        v_s_max(F_allow, rho_a, 2.489, 1.8), run.m, rho_a, run.CdS_body)
    assert v_s_max(F_allow, rho_a, 2.489, 1.8) == pytest.approx(35.4, abs=0.5)
    assert dt_main == pytest.approx(3.54, abs=0.1)
    assert dt / dt_main == pytest.approx(3.28, abs=0.1)

    assert coast_ceiling(run.m, rho_a, run.CdS_body) == pytest.approx(23.6, abs=0.2)


def test_4_0_doubling_hardware_strength_barely_moves_the_bound():
    """arctan saturates: 1000 -> 2000 lbf takes the main
    from 3.5 s to 4.9 s -- doubling the hardware buys 1.4 seconds."""
    config = load_config()
    run = integrate(config, "axial")
    rho_a = run.atm.rho(config.vehicle.h_a)

    def bound(lbf):
        F = lbf * LBF_TO_N / 1.5
        dt, _ = delta_t_max(v_s_max(F, rho_a, 2.489, 1.8), run.m, rho_a,
                            run.CdS_body)
        return dt

    assert bound(1000.0) == pytest.approx(3.54, abs=0.1)
    assert bound(2000.0) == pytest.approx(4.92, abs=0.1)


# --- §6.1.2 the pre-deployment phase --------------------------------------


def test_6_1_2_ballistic_terminal_velocities():
    """The §6.1.2 table: 146 m/s axial, 24.4 m/s broadside."""
    config = load_config()
    atm = Atmosphere(config.site.z_site, config.site.T_pad, config.site.p_pad)
    axial, broadside = airframe_band(config.vehicle.d_body, config.vehicle.l_body)
    z = config.vehicle.h_a
    assert v_terminal(config.vehicle.m, atm.g(z), atm.rho(z),
                      axial) == pytest.approx(147.1, abs=1.0)
    assert v_terminal(config.vehicle.m, atm.g(z), atm.rho(z),
                      broadside) == pytest.approx(24.5, abs=0.2)
