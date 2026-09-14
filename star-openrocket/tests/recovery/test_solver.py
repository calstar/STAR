"""Solver event handling. PLAN.md §6.1, §6.1.4, §10.

The event model is the whole difficulty: three classes, one merge, resolved one
at a time because they interleave.
"""

import copy
import json
import os

import pytest

from physics.schema import (
    Config,
    Device,
    Site,
    Trigger,
    TriggerKind,
    Vehicle,
)
from pydantic import ValidationError

from physics.solver import LOAD_DT, integrate

# ISA temperature at the FAR pad, so the eq (7) re-fit stays the identity
# and the free regression test of §5 stays live inside every fixture.
FAR_ISA_T = 284.1854

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "fixtures", "worked_example.json")


def load_config():
    with open(FIXTURE, encoding="utf-8") as handle:
        return Config.model_validate(json.load(handle))


def _cfg(devices, h_a=914.0, v0=None, z0=None):
    return Config(
        vehicle=Vehicle(m=5.67, h_a=h_a, d_body=0.1016, l_body=1.44, v0=v0, z0=z0),
        site=Site(T_pad=FAR_ISA_T),
        devices=devices,
    )


def _dev(name, CdS, D0=0.6, kind=TriggerKind.TIME, value=2.0, delay=0.0,
         m_c=0.06):
    return Device(name=name, CdS=CdS, D0=D0, m_c=m_c, delay=delay,
                  trigger=Trigger(kind=kind, value=value), k_eff=20000.0)


# --- ordering and interleaving --------------------------------------------


def test_devices_fire_in_the_right_order():
    run = integrate(load_config(), "axial")
    drogue = run.state_of("drogue")
    main = run.state_of("main")
    assert drogue.t_d < main.t_d
    assert drogue.z_d > main.z_d


def test_a_device_can_trigger_inside_another_delay_window():
    """§6.1.4's reason line stretch must join the merge rather than being
    handled as 'integrate one extra segment and carry on': a drogue with a
    1.0 s delay whose main crosses its altitude inside that window."""
    cfg = _cfg([
        _dev("drogue", 0.15, delay=1.0, kind=TriggerKind.TIME, value=2.0),
        _dev("main", 2.489, D0=1.601, m_c=0.213,
             kind=TriggerKind.TIME, value=2.4),
    ])
    run = integrate(cfg, "axial")
    d, m = run.state_of("drogue"), run.state_of("main")
    assert d.t_x == pytest.approx(2.0)
    assert m.t_x == pytest.approx(2.4)   # fires inside the drogue's delay
    assert d.t_d == pytest.approx(3.0)   # ...and the drogue still stretches
    assert m.t_d == pytest.approx(2.4)
    assert d.stretched and m.stretched


def test_simultaneous_triggers_both_resolve():
    """§11.5's 'simultaneous' case fires two devices at the same instant by
    construction. A cap filter that drops ties silently loses one of them."""
    cfg = _cfg([
        _dev("a", 0.15, kind=TriggerKind.TIME, value=2.0),
        _dev("b", 2.489, D0=1.601, m_c=0.213, kind=TriggerKind.TIME, value=2.0),
    ])
    run = integrate(cfg, "axial")
    assert run.state_of("a").stretched
    assert run.state_of("b").stretched
    assert run.state_of("a").t_d == pytest.approx(run.state_of("b").t_d)
    assert run.warnings == []


# --- the descending guard, §6.1 -------------------------------------------


def test_altitude_triggers_ignore_ascending_crossings():
    """A vehicle passes its main deployment altitude on the way up as well,
    and accepting either crossing fires the main during boost at several
    hundred m/s. Inert while runs start at apogee with v = 0; a live bug the
    moment §4.0 permits v0 > 0."""
    cfg = _cfg(
        [_dev("main", 2.489, D0=1.601, m_c=0.213,
              kind=TriggerKind.ALTITUDE, value=600.0)],
        h_a=914.0, z0=400.0, v0=60.0,
    )
    run = integrate(cfg, "axial")
    s = run.state_of("main")
    # It must fire on the way DOWN, so after the vehicle has coasted over.
    assert s.stretched
    assert run.traj.v[0] > 0.0            # started climbing
    idx = int((abs(run.traj.t - s.t_d)).argmin())
    assert run.traj.v[idx] < 0.0          # deployed descending


# --- eq (8b): two distinct failures ---------------------------------------


def test_device_that_never_triggers_is_reported():
    cfg = _cfg([_dev("never", 0.15, kind=TriggerKind.TIME, value=1e5)])
    run = integrate(cfg, "axial")
    assert run.state_of("never").pending
    assert any("never reached its trigger" in w for w in run.warnings)


def test_device_that_fires_but_never_stretches_is_reported_separately():
    """The hole in a naive eq (8b): a device that fired above ground but whose
    lines would come taut below it. It is a distinct case from one that never
    triggered at all, and a post-loop sweep over *pending* devices misses it.
    """
    # Trigger at 5 s -- comfortably before this slick airframe reaches the
    # ground at ~14 s -- but with a delay that puts line stretch far below it.
    cfg = _cfg([_dev("late", 0.15, kind=TriggerKind.TIME, value=5.0,
                     delay=1e4)])
    run = integrate(cfg, "axial")
    s = run.state_of("late")
    assert s.triggered and not s.stretched
    assert any("never opened" in w for w in run.warnings)
    assert not any("never reached its trigger" in w for w in run.warnings)


# --- numerics --------------------------------------------------------------


def test_load_sampling_is_at_most_5ms():
    """§8.1: sample the dense output at <= 5 ms, not at integrator step
    boundaries -- the adaptive controller can step over the peak entirely."""
    run = integrate(load_config(), "axial")
    gaps = run.traj.t[1:] - run.traj.t[:-1]
    assert gaps.max() <= LOAD_DT + 1e-9


def test_trajectory_is_monotonic_in_time_and_reaches_the_ground():
    run = integrate(load_config(), "axial")
    assert (run.traj.t[1:] >= run.traj.t[:-1]).all()
    assert run.traj.z[-1] == pytest.approx(0.0, abs=0.5)
    assert run.traj.z[0] == pytest.approx(914.0)


def test_drag_area_is_never_below_the_airframe():
    """Eq (13) includes the airframe throughout, so the total can never dip
    under it -- including during the pre-deployment phase and every delay."""
    run = integrate(load_config(), "axial")
    assert (run.traj.CdS >= run.CdS_body - 1e-12).all()


def test_tolerance_is_tight_enough_that_halving_it_changes_nothing():
    """A cheap convergence check: if the answer moves when the tolerance
    moves, rtol=1e-8 is not tight enough for this problem."""
    import physics.solver as solver

    config = load_config()
    base = integrate(config, "axial")
    old = solver.RTOL, solver.ATOL
    try:
        solver.RTOL, solver.ATOL = 1e-10, 1e-12
        tight = integrate(config, "axial")
    finally:
        solver.RTOL, solver.ATOL = old

    assert tight.t_ground == pytest.approx(base.t_ground, rel=1e-6)
    assert tight.v_impact == pytest.approx(base.v_impact, rel=1e-6)
    assert tight.state_of("main").v_s == pytest.approx(
        base.state_of("main").v_s, rel=1e-6)


def test_canopy_mass_exceeding_vehicle_mass_is_rejected():
    cfg = _cfg([_dev("absurd", 0.15, m_c=10.0)])
    with pytest.raises(ValueError, match="exceed"):
        integrate(cfg, "axial")


def test_single_device_configuration_works():
    """§6.1.1: nothing in §6-§8 assumes two devices."""
    cfg = _cfg([_dev("main", 2.489, D0=1.601, m_c=0.213,
                     kind=TriggerKind.ALTITUDE, value=300.0)])
    run = integrate(cfg, "axial")
    assert run.state_of("main").stretched
    assert run.t_ground > 0
    assert run.warnings == []


def test_three_device_configuration_works():
    """...nor any particular number of them. A redundant backup main."""
    cfg = _cfg([
        _dev("drogue", 0.15, kind=TriggerKind.TIME, value=2.0),
        _dev("main", 2.489, D0=1.601, m_c=0.213,
             kind=TriggerKind.ALTITUDE, value=152.0),
        _dev("backup", 1.0, D0=1.0, m_c=0.1, kind=TriggerKind.TIME, value=45.0),
    ])
    run = integrate(cfg, "axial")
    assert all(s.stretched for s in run.states)


# --- the work budget -------------------------------------------------------


def test_a_canopy_that_is_not_a_canopy_is_refused_before_the_solver():
    """The typo must be refused by the schema, in microseconds, not integrated.

    Both of these are reachable by typing into the form: a drag area entered
    where the diameter goes, or a value pasted in the wrong unit. Neither had
    an upper bound at all -- `CdS` and `D0` were `gt=0.0` and nothing else --
    so the integrator was asked to find a descent that does not exist. It does
    not refuse: it takes smaller and smaller steps, for tens of seconds,
    pinning a core per case while the GUI re-runs on every keystroke.
    """
    # A billion square metres: caught by the absolute cap on CdS.
    with pytest.raises(ValidationError, match="less than or equal to 20000"):
        _dev("drogue", 1143851243.2142286, D0=0.6)

    # A 313 m canopy: caught by the absolute cap on D0.
    with pytest.raises(ValidationError, match="less than or equal to 200"):
        _dev("drogue", 1235.6104320000002, D0=313.5122)

    # 1000 m^2 on a 0.6 m drogue clears BOTH absolute caps and is still not a
    # canopy -- 3500x its own projected area. This is the case only the ratio
    # bound catches, and it is the shape of every real typo: one field wrong,
    # its neighbour right.
    with pytest.raises(ValidationError, match="projected area"):
        _dev("drogue", 1000.0, D0=0.6)

    # The worked example's own devices must still build, or the bound is wrong.
    assert _dev("drogue", 0.15, D0=0.6).CdS == 0.15
    assert _dev("main", 2.489, D0=1.601, m_c=0.213).CdS == 2.489


def test_the_solver_still_refuses_what_the_schema_lets_through():
    """The work budget is the backstop, and it has to stay reachable.

    The schema bounds what a canopy can be; it cannot bound how hard the
    resulting descent is to integrate. A 150 m canopy at the ratio cap is a
    legal config and still cannot be solved, so the budget -- not the schema
    -- is what stops it, and this asserts that layer is still load-bearing.
    """
    cfg = _cfg([_dev("drogue", 20000.0, D0=150.0,
                     kind=TriggerKind.TIME, value=2.0)])
    with pytest.raises(ValueError, match="did not converge to a descent"):
        integrate(cfg, "axial")


def test_the_budget_leaves_a_real_configuration_far_from_the_cap():
    """The guard must refuse only the unphysical, so assert the headroom.

    The worked example is the canonical run; if it ever lands near the cap,
    the cap is wrong and this goes red before a user meets it as a 422.
    """
    from physics import solver

    calls = [0]
    real = solver.make_deriv

    def counting(*args, **kwargs):
        f = real(*args, **kwargs)

        def wrapped(t_, y_):
            calls[0] += 1
            return f(t_, y_)

        return wrapped

    solver.make_deriv = counting
    try:
        integrate(load_config(), "axial")
    finally:
        solver.make_deriv = real

    assert calls[0] > 0, "the counter never ran, so this test proves nothing"
    assert calls[0] < solver.DERIV_BUDGET / 10, (
        f"the canonical run costs {calls[0]:,} evaluations against a budget "
        f"of {solver.DERIV_BUDGET:,} -- less than 10x headroom"
    )
