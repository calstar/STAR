"""PLAN.md §12 validation assertions, eqs (41)-(58).

These are cheap and they catch real bugs. The most valuable of them, eq (48),
cross-checks the numerical integrator against a closed form derived from
completely different assumptions -- Pflanz has no gravity and no airframe drag,
so agreement between the two is genuine evidence rather than a tautology.
"""

import copy
import json
import math
import os

import pytest

from physics.atmosphere import Atmosphere
from physics.constants import G0
from physics.devices import airframe_band
from physics.dynamics import v_terminal
from physics.loads import X1_of, ballistic_parameter, device_loads, tau_star_of
from physics.schema import Config, Device, Site, Trigger, TriggerKind, Vehicle
from physics.solver import integrate

# ISA temperature at the FAR pad, so the eq (7) re-fit stays the identity
# and the free regression test of §5 stays live inside every fixture.
FAR_ISA_T = 284.1854

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "fixtures", "worked_example.json")


def load_config():
    with open(FIXTURE, encoding="utf-8") as handle:
        return Config.model_validate(json.load(handle))


def _single_device_config(CdS=2.489, D0=1.601, n=8.0, z_d=152.0, Cx=1.8,
                          m=5.67, h_a=914.0, delay=0.0):
    """A one-device vehicle with the airframe effectively removed, so the
    scaling laws below isolate the canopy."""
    return Config(
        vehicle=Vehicle(m=m, h_a=h_a, d_body=0.1016, l_body=1.44,),
        site=Site(T_pad=FAR_ISA_T),
        devices=[Device(name="main", CdS=CdS, D0=D0, m_c=0.213, n=n, Cx=Cx,
                        trigger=Trigger(kind=TriggerKind.ALTITUDE, value=z_d),
                        delay=delay, k_eff=17400.0)],
    )


# --- (41) terminal velocity ------------------------------------------------


def test_41_descent_converges_to_terminal_velocity():
    """A single device at constant conditions must approach eq (18)."""
    config = load_config()
    run = integrate(config, "axial")
    # Sample the last second, by which time the main is long since inflated.
    tail = run.traj.t >= run.t_ground - 1.0
    v = abs(run.traj.v[tail]).mean()

    CdS = run.CdS_body + sum(d.CdS for d in run.devices)
    want = v_terminal(run.m, run.atm.g(0.0), run.atm.rho(0.0), CdS)
    assert v == pytest.approx(want, rel=2e-3)


def test_41_terminal_velocity_includes_every_deployed_device():
    """Eq (13): the drogue keeps flying after the main opens, and so does the
    airframe. OpenRocket drops both, which is a real error."""
    config = load_config()
    run = integrate(config, "axial")
    main_only = v_terminal(run.m, run.atm.g(0.0), run.atm.rho(0.0), 2.489)
    everything = v_terminal(
        run.m, run.atm.g(0.0), run.atm.rho(0.0),
        2.489 + 0.15 + run.CdS_body)
    assert everything < main_only
    assert run.v_impact == pytest.approx(everything, rel=2e-3)


# --- (42) infinite-mass limit ---------------------------------------------


def test_42_X1_approaches_one_as_A_grows():
    assert X1_of(50.0, 2) == pytest.approx(0.987, abs=5e-4)
    assert X1_of(1e6, 2) == pytest.approx(1.0, abs=1e-5)
    for A in (1.0, 10.0, 100.0, 1000.0):
        assert X1_of(A, 2) <= 1.0


def test_42_X1_is_bounded_by_one_everywhere():
    """X1 = max_tau (tau^j * u^2) with both factors bounded by 1, so this is
    true by construction -- which is exactly why F_pflanz can never govern
    eq (36) and must be reported separately (§8.7)."""
    for j in (1, 2):
        for A in (0.01, 0.1, 0.5, 2.0 / 3.0, 1.0, 5.0, 50.0):
            assert 0.0 < X1_of(A, j) <= 1.0


# --- (43) closed form vs numerical ----------------------------------------


def test_43_closed_form_matches_the_general_expression():
    """Eq (29) is a closed form of eqs (26)/(27) for j = 2. They must agree,
    including across the A = 2/3 branch point where tau* saturates at 1."""
    for A in (0.05, 0.2, 0.5, 0.6666, 0.6667, 0.7, 1.0, 5.0, 50.0):
        tau_star = tau_star_of(A, 2)
        B = 1.0 / (A * 3.0)
        general = tau_star ** 2 / (1.0 + B * tau_star ** 3) ** 2
        assert X1_of(A, 2) == pytest.approx(general, rel=1e-12)


def test_43_branch_point_is_where_tau_star_reaches_one():
    """For j = 2, tau* = (1.5A)^(1/3), so it hits 1 exactly at A = 2/3."""
    assert tau_star_of(2.0 / 3.0 - 1e-9, 2) < 1.0
    assert tau_star_of(2.0 / 3.0 + 1e-9, 2) == 1.0


def test_43_matches_numerical_integration_of_the_reduced_ode():
    """Eqs (24)-(28) come from non-dimensionalising the drag-only opening ODE,
    so they are derived rather than table-looked-up -- and must agree with a
    numerical integration of that same reduced problem.

    Reduced problem: du/dtau = -A^-1 * tau^j * u^2 with u(0) = 1, where u is
    speed normalised by v_s. Force is then tau^j * u^2, and X1 is its maximum.
    """
    for A in (0.2, 0.5, 1.0, 5.0):
        for j in (1, 2):
            steps = 200000
            dtau = 1.0 / steps
            u = 1.0
            peak = 0.0
            for k in range(steps + 1):
                tau = k * dtau
                peak = max(peak, tau ** j * u * u)
                u += -(1.0 / A) * tau ** j * u * u * dtau
            assert X1_of(A, j) == pytest.approx(peak, rel=3e-3)


# --- (44) F is exactly quadratic in v_s -----------------------------------


def test_44_force_scales_as_v_s_squared_at_fixed_s_f():
    """A is independent of v_s when s_f is fixed (eq 24 has no v_s in it), so
    F_inf is exactly proportional to v_s^2 and X1 does not move at all."""
    rho, CdS, s_f, Cx, m = 1.15, 2.489, 12.808, 1.8, 5.67
    A = ballistic_parameter(m, rho, CdS, s_f)
    X1 = X1_of(A, 2)
    base = None
    for v_s in (10.0, 20.0, 25.0, 40.0):
        q_s = 0.5 * rho * v_s ** 2
        F = q_s * CdS * Cx
        if base is None:
            base, base_v = F, v_s
        assert F / base == pytest.approx((v_s / base_v) ** 2, rel=1e-12)
        # And the finite-mass credit is untouched by deployment speed.
        assert X1_of(A, 2) == pytest.approx(X1, rel=1e-15)


# --- (45) drag-area scaling, AT FIXED s_f ---------------------------------


def test_45_X1_scales_as_CdS_to_the_minus_two_thirds():
    """In the finite-mass regime and at fixed s_f. See the §12 note: a
    geometrically scaled canopy gives a different (flat) answer, and only the
    fixed-s_f form is a property of eq (24)."""
    rho, s_f, m = 1.15, 12.808, 5.67
    ref = 2.489
    A_ref = ballistic_parameter(m, rho, ref, s_f)
    assert A_ref < 2.0 / 3.0, "must be in the finite-mass regime for this law"

    for factor in (0.5, 2.0, 4.0):
        A = ballistic_parameter(m, rho, ref * factor, s_f)
        ratio = X1_of(A, 2) / X1_of(A_ref, 2)
        assert ratio == pytest.approx(factor ** (-2.0 / 3.0), rel=1e-9)


def test_45_doubling_drag_area_raises_load_only_26_percent():
    rho, s_f, m, Cx, v_s = 1.15, 12.808, 5.67, 1.8, 25.0
    q_s = 0.5 * rho * v_s ** 2

    def F(CdS):
        A = ballistic_parameter(m, rho, CdS, s_f)
        return q_s * CdS * Cx * X1_of(A, 2)

    assert F(2 * 2.489) / F(2.489) == pytest.approx(2 ** (1.0 / 3.0), rel=1e-9)
    assert F(2 * 2.489) / F(2.489) == pytest.approx(1.26, abs=0.01)


def test_45_geometric_scaling_is_flat_which_is_why_the_clause_matters():
    """The statement eq (45) would make if 's_f fixed' were dropped."""
    rho, m, Cx, v_s = 1.15, 5.67, 1.8, 25.0
    q_s = 0.5 * rho * v_s ** 2

    def F_geometric(CdS):
        # D0 grows as sqrt(CdS), so s_f does too.
        s_f = 8.0 * 1.601 * math.sqrt(CdS / 2.489)
        A = ballistic_parameter(m, rho, CdS, s_f)
        return q_s * CdS * Cx * X1_of(A, 2)

    assert F_geometric(2 * 2.489) / F_geometric(2.489) == pytest.approx(1.0, rel=1e-9)


# --- (46) geometric scale factor ------------------------------------------


def test_46_load_factor_scales_as_sigma_to_the_minus_two_thirds():
    """All lengths x sigma, m proportional to sigma^2 at fixed descent rate.
    Small vehicles see higher load factors than large ones -- flag this when a
    proven design is scaled down."""
    rho, Cx, v_s = 1.15, 1.8, 25.0
    q_s = 0.5 * rho * v_s ** 2
    CdS0, s_f0, m0 = 2.489, 12.808, 5.67

    def load_factor(sigma):
        CdS = CdS0 * sigma ** 2
        s_f = s_f0 * sigma
        m = m0 * sigma ** 2
        A = ballistic_parameter(m, rho, CdS, s_f)
        F = q_s * CdS * Cx * X1_of(A, 2)
        return F / (m * G0)

    for sigma in (0.5, 2.0, 3.0):
        assert load_factor(sigma) / load_factor(1.0) == pytest.approx(
            sigma ** (-2.0 / 3.0), rel=1e-9)


# --- (47) filling-distance sensitivity ------------------------------------


def test_47_X1_scales_as_s_f_to_the_minus_two_thirds():
    """A 50% error in filling distance is a 30% error in load, which is what
    sets the cost of never having measured n."""
    rho, CdS, m = 1.15, 2.489, 5.67
    ref = 12.808
    for factor in (0.5, 1.5, 2.0):
        A = ballistic_parameter(m, rho, CdS, ref * factor)
        A_ref = ballistic_parameter(m, rho, CdS, ref)
        assert X1_of(A, 2) / X1_of(A_ref, 2) == pytest.approx(
            factor ** (-2.0 / 3.0), rel=1e-9)
    # The n = 6..12 sweep band, quoted in §15.3 as X1 x 0.63.
    assert (12.0 / 6.0) ** (-2.0 / 3.0) == pytest.approx(0.63, abs=0.005)


# --- (48)/(49) the two independent load paths -----------------------------


def _loads_for(config, which):
    run = integrate(config, which)
    per = [device_loads(d, s, run.m, run.m_b, run.traj)
           for d, s in zip(run.devices, run.states)]
    return run, per


def test_48_numerical_and_pflanz_agree_per_device():
    """THE test. The numerical path carries gravity and airframe drag; Pflanz
    carries neither. Agreement to ~10% is evidence both are right.

    Scoped per device over its own inflation window, and skipped below the
    eq (23) validity floor -- see the §12 note. A global max would be
    dominated by the main and say nothing about the drogue.
    """
    config = load_config()
    checked = 0
    for which in ("axial", "broadside"):
        run, per = _loads_for(config, which)
        for dl in per:
            if not dl.fired or not dl.bound_valid or dl.F_T_peak is None:
                continue
            device = next(d for d in run.devices if d.name == dl.name)
            ratio = device.Cx * dl.F_T_peak / dl.F_pflanz
            assert 0.8 < ratio < 1.3, (
                "%s/%s: Cx*maxF_T/F_pflanz = %.3f is outside (0.8, 1.3)"
                % (which, dl.name, ratio))
            checked += 1
    assert checked >= 2, "the cross-check must actually run on something"


def test_49_raw_numerical_peak_stays_below_pflanz():
    """The trajectory integration cannot produce the opening overshoot -- the
    tau^j law is a smooth monotonic ramp, so eq (20) yields only quasi-steady
    drag. If the raw peak exceeds Pflanz, Cx has leaked into eq (12)."""
    config = load_config()
    for which in ("axial", "broadside"):
        run, per = _loads_for(config, which)
        for dl in per:
            if not dl.fired or not dl.bound_valid or dl.F_T_peak is None:
                continue
            assert dl.F_T_peak < dl.F_pflanz, (
                "%s/%s: raw peak %.1f >= Pflanz %.1f -- Cx has leaked into "
                "the area law" % (which, dl.name, dl.F_T_peak, dl.F_pflanz))


def test_49_Cx_does_not_inflate_the_trajectory():
    """Keep Cx OUT of eq (12): inflating the drag area by Cx would
    over-decelerate the vehicle and corrupt the trajectory. The overshoot is a
    peak-force effect, so it scales the load and never the motion."""
    a = load_config()
    b = copy.deepcopy(a)
    for d in b.devices:
        d.Cx = 1.2
    run_a = integrate(a, "axial")
    run_b = integrate(b, "axial")
    assert run_a.t_ground == pytest.approx(run_b.t_ground, rel=1e-12)
    assert run_a.v_impact == pytest.approx(run_b.v_impact, rel=1e-12)


# --- (50)/(51) the ballistic phase has a closed form ----------------------


def test_50_51_ballistic_phase_matches_the_closed_form():
    """At constant rho and CdS, released from rest, eq (17) integrates to
    tanh/ln-cosh. This is a direct test of the integrator over the §6.1.2
    pre-deployment phase, where the vehicle falls on airframe drag alone.
    """
    m, CdS_body, z0 = 5.67, 0.00486, 914.0
    # A device that never fires, so the whole run is the ballistic phase.
    config = Config(
        vehicle=Vehicle(m=m, h_a=z0, d_body=0.1016, l_body=1.44,),
        site=Site(T_pad=FAR_ISA_T),
        devices=[Device(name="never", CdS=0.15, D0=0.6, m_c=0.0,
                        trigger=Trigger(kind=TriggerKind.TIME, value=1e6))],
    )
    run = integrate(config, "axial", CdS_body=CdS_body)

    # Evaluate the closed form at the run's own mean density, since the real
    # atmosphere is not constant over 900 m.
    rho = run.atm.rho(z0 / 2.0)
    g = run.atm.g(z0 / 2.0)
    v_t = v_terminal(m, g, rho, CdS_body)

    for t in (1.0, 2.0, 3.0, 5.0):
        idx = int(min(range(len(run.traj.t)),
                      key=lambda k: abs(run.traj.t[k] - t)))
        v_want = -v_t * math.tanh(g * t / v_t)
        z_want = z0 - (v_t ** 2 / g) * math.log(math.cosh(g * t / v_t))
        assert run.traj.v[idx] == pytest.approx(v_want, rel=5e-3)
        assert run.traj.z[idx] == pytest.approx(z_want, rel=5e-3)


def test_50_vacuum_free_fall_is_the_small_time_limit_not_the_model():
    """As t -> 0 the closed form reduces to v = -gt, confirming free fall is a
    limit rather than the model. §6.1.2: treating the whole pre-deployment
    phase as vacuum free fall overstates drogue opening load by up to 2.1x at
    the broadside bound."""
    m, z0 = 5.67, 914.0
    axial, broadside = airframe_band(0.1016, 1.44)
    atm = Atmosphere(500.0, T_pad=284.90)
    g = atm.g(z0)

    for CdS_body, expect_close in ((axial, True), (broadside, False)):
        config = Config(
            vehicle=Vehicle(m=m, h_a=z0, d_body=0.1016, l_body=1.44,),
            site=Site(T_pad=FAR_ISA_T),
            devices=[Device(name="never", CdS=0.15, D0=0.6, m_c=0.0,
                            trigger=Trigger(kind=TriggerKind.TIME, value=1e6))],
        )
        run = integrate(config, "axial", CdS_body=CdS_body)
        idx = int(min(range(len(run.traj.t)),
                      key=lambda k: abs(run.traj.t[k] - 3.0)))
        v = abs(run.traj.v[idx])
        vacuum = g * 3.0
        if expect_close:
            assert v / vacuum > 0.97  # nose-down: within ~1% of free fall
        else:
            assert v / vacuum < 0.75  # broadside: 31% below, a factor of 2 in load


# --- (52) trigger equivalence ---------------------------------------------


def test_52_altitude_and_time_triggers_agree():
    """A device set to ALTITUDE z_d and the same device set to TIME t_a must
    produce identical results when t_a is the time the altitude run reports
    for that crossing. Catches sign errors, off-by-one segment handling, and
    delay double-counting."""
    config = load_config()
    run_alt = integrate(config, "axial")
    t_x = run_alt.state_of("main").t_x

    as_time = copy.deepcopy(config)
    main = next(d for d in as_time.devices if d.name == "main")
    main.trigger = Trigger(kind=TriggerKind.TIME, value=t_x)
    run_time = integrate(as_time, "axial")

    a = run_alt.state_of("main")
    b = run_time.state_of("main")
    assert b.t_d == pytest.approx(a.t_d, abs=1e-6)
    assert b.v_s == pytest.approx(a.v_s, rel=1e-6)
    assert b.z_d == pytest.approx(a.z_d, rel=1e-6)
    assert b.t_f == pytest.approx(a.t_f, rel=1e-6)
    assert run_time.t_ground == pytest.approx(run_alt.t_ground, rel=1e-6)
    assert run_time.v_impact == pytest.approx(run_alt.v_impact, rel=1e-6)


# --- (57) the §6.1.4 delay regression -------------------------------------


def test_57_delay_raises_v_s_by_the_ballistic_closed_form():
    """Run one device twice, identical but for delta_t. During the delay the
    vehicle is in the §6.1.2 ballistic phase, so eq (50) gives the answer in
    closed form.

    Sampling v_s at the trigger instead of at line stretch makes this ratio
    identically 1 -- which is exactly the failure this assertion exists to
    catch. Note eq (48) still passes in that state, so (48) does NOT cover it.
    """
    base = load_config()
    run0 = integrate(base, "axial")
    s0 = run0.state_of("drogue")
    t_x = s0.t_x
    v_s0 = s0.v_s

    v_t = v_terminal(run0.m, run0.atm.g(s0.z_d), run0.atm.rho(s0.z_d),
                     run0.CdS_body)
    g = run0.atm.g(s0.z_d)

    for delay in (0.25, 0.5, 1.0):
        cfg = copy.deepcopy(base)
        drogue = next(d for d in cfg.devices if d.name == "drogue")
        drogue.delay = delay
        run = integrate(cfg, "axial")
        s = run.state_of("drogue")

        assert s.t_x == pytest.approx(t_x, abs=1e-9)
        assert s.t_d == pytest.approx(t_x + delay, abs=1e-9)

        want = (math.tanh(g * (t_x + delay) / v_t)
                / math.tanh(g * t_x / v_t))
        assert s.v_s / v_s0 == pytest.approx(want, rel=0.02)
        # And the load follows the square of it, which is the §6.1.3 table.
        assert s.v_s > v_s0


def test_57_bagged_drogue_load_matches_the_plan_table():
    """PLAN.md §6.1.3: +26% / +55% / +122% at 0.25 / 0.5 / 1.0 s."""
    base = load_config()
    loads = {}
    for delay in (0.0, 0.25, 0.5, 1.0):
        cfg = copy.deepcopy(base)
        next(d for d in cfg.devices if d.name == "drogue").delay = delay
        run, per = _loads_for(cfg, "axial")
        loads[delay] = next(d for d in per if d.name == "drogue").F_inf

    assert loads[0.25] / loads[0.0] == pytest.approx(1.26, abs=0.02)
    assert loads[0.5] / loads[0.0] == pytest.approx(1.55, abs=0.03)
    assert loads[1.0] / loads[0.0] == pytest.approx(2.22, abs=0.05)


# --- (58) the zero-delay collapse -----------------------------------------


def test_58_zero_delay_is_identical_to_the_scheduled_path():
    """delta_t = 0 collapses the trigger and line-stretch events. It must go
    through the same code path as a delayed deployment, not a second one with
    its own arithmetic.

    Compared against a tiny-but-nonzero delay, which exercises the scheduled
    path in full.
    """
    base = load_config()
    run0 = integrate(base, "axial")

    tiny = copy.deepcopy(base)
    for d in tiny.devices:
        d.delay = 1e-9
    run1 = integrate(tiny, "axial")

    for name in ("drogue", "main"):
        a, b = run0.state_of(name), run1.state_of(name)
        assert b.v_s == pytest.approx(a.v_s, rel=1e-6)
        assert b.t_f == pytest.approx(a.t_f, rel=1e-6)
        assert b.z_d == pytest.approx(a.z_d, rel=1e-6)
    assert run1.t_ground == pytest.approx(run0.t_ground, rel=1e-6)


def test_58_delay_is_a_segment_not_an_offset():
    """The structural claim of §6.1.4: during the delay the device contributes
    no drag (tau < 0, eq 12), so the vehicle is still on airframe drag alone
    and keeps accelerating."""
    cfg = load_config()
    next(d for d in cfg.devices if d.name == "drogue").delay = 1.0
    run = integrate(cfg, "axial")
    s = run.state_of("drogue")

    # Across the delay window the drag area must be exactly the airframe.
    mask = (run.traj.t >= s.t_x) & (run.traj.t < s.t_d - 1e-9)
    assert mask.any()
    assert run.traj.CdS[mask] == pytest.approx(run.CdS_body, rel=1e-12)
    # ...and speed must be strictly increasing through it.
    v = abs(run.traj.v[mask])
    assert v[-1] > v[0]
