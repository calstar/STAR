"""Launch rail, angle and heading from the config; rail exit and static margin reported (FLT-8);
pressure thrust with altitude (FLT-10).

The flight flew Flight(rail_length=3.35, inclination=90, heading=0) from literals and reported
neither the rail-exit velocity nor the static margin, though RocketPy computes both. The thrust
curve reached RocketPy without a reference pressure, so (p_ref - p(z)) A_exit was zero all the
way up.

Independent checks: a hand integration of the rail run, a hand Barrowman CP and the audit's hand
static margin (CG 2.693 m, CP 1.541 m, 7.35 cal), a rail-then-gravity-turn point mass, and the
isothermal barometric formula.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

rocketpy = pytest.importorskip("rocketpy")

from flight_cases import fly, header_curve, shipped  # noqa: E402

G0 = 9.80665


@pytest.fixture(scope="module")
def shipped_flight():
    return fly(shipped())


def test_launch_comes_from_the_config(monkeypatch):
    import ui.flight_sim as fs

    seen = {}
    real = fs.Flight

    def spy(*a, **k):
        seen.update(k)
        return real(*a, **k)

    monkeypatch.setattr(fs, "Flight", spy)
    cfg = shipped()
    cfg.environment.rail_length_m = 6.1
    cfg.environment.launch_inclination_deg = 84.0
    cfg.environment.launch_heading_deg = 45.0
    fly(cfg)
    assert (seen["rail_length"], seen["inclination"], seen["heading"]) == (6.1, 84.0, 45.0)


def test_rail_exit_velocity_against_a_hand_rail_run(shipped_flight):
    """Along a vertical rail: dv/dt = F/m - g - D/m, dm/dt = -mdot, to s = rail length."""
    cfg = shipped()
    t_c, F, mO, mF = header_curve()
    m = shipped_flight["flight_report"]["wet_mass_kg"]
    A, rho = math.pi * cfg.rocket.radius**2, 1.1175  # ISA at 626.67 m, kg/m3
    s = v = t = 0.0
    dt = 1e-5
    while s < cfg.environment.rail_length_m:
        Fk = np.interp(t, t_c, F)
        a = Fk / m - G0 - 0.5 * rho * v * v * 0.85 * A / m
        v += a * dt
        s += v * dt
        m -= np.interp(t, t_c, mO + mF) * dt
        t += dt
    rep = shipped_flight["flight_report"]["launch"]
    assert rep["rail_exit_velocity_m_s"] == pytest.approx(v, rel=0.01)
    assert rep["rail_exit_velocity_m_s"] == pytest.approx(21.7, abs=0.2)  # the audit's number
    assert rep["rail_buttons_declared"] is False and rep["effective_rail_length_m"] == 3.35


def _barrowman_cp(cfg, nose_tip, nose_len):
    """Barrowman (TIR-33): nose CN_a = 2 at L - V/A_base from the tip (L/2 for von Karman);
    trapezoidal fins with body interference 1 + R/(s + R)."""
    R, fins = cfg.rocket.radius, cfg.rocket.fins
    d = 2 * R
    cr, ct, s, n = fins.root_chord, fins.tip_chord, fins.fin_span, fins.no_fins
    sweep = cr - ct  # leading edge swept, trailing edge square to the body
    l_f = math.hypot(s, sweep + ct / 2 - cr / 2)  # mid-chord line
    cn_f = (1 + R / (s + R)) * 4 * n * (s / d) ** 2 / (1 + math.sqrt(1 + (2 * l_f / (cr + ct)) ** 2))
    x_f_from_le = sweep * (cr + 2 * ct) / (3 * (cr + ct)) + (cr + ct - cr * ct / (cr + ct)) / 6
    x_fins = fins.fin_position - x_f_from_le  # tail_to_nose coordinates
    x_nose = nose_tip - nose_len / 2
    return (2.0 * x_nose + cn_f * x_fins) / (2.0 + cn_f)


def test_static_margin_at_liftoff_is_hand_barrowman(shipped_flight):
    cfg = shipped()
    rocket = shipped_flight["flight"].rocket
    rep = shipped_flight["flight_report"]
    nose_len = cfg.rocket.nose_fineness_ratio * 2 * cfg.rocket.radius
    cp = _barrowman_cp(cfg, rep["stack_length_m"], nose_len)
    cg = float(rocket.center_of_mass(0.0))
    assert rep["stability"]["static_margin_liftoff_cal"] == pytest.approx((cg - cp) / (2 * cfg.rocket.radius), abs=0.15)
    assert rep["stability"]["static_margin_liftoff_cal"] == pytest.approx(7.35, abs=0.3)  # the audit's hand number
    assert rep["stability"]["static_margin_burnout_cal"] > rep["stability"]["static_margin_rail_exit_cal"]


def test_requirement_checks_fire_only_when_declared(shipped_flight):
    assert shipped_flight["flight_report"]["checks"] == []
    cfg = shipped()
    cfg.design_requirements.min_rail_exit_velocity_m_s = 30.48  # 100 ft/s
    cfg.design_requirements.min_static_margin_cal = 1.5
    rep = fly(cfg)["flight_report"]
    by = {c["name"]: c for c in rep["checks"]}
    assert by["rail_exit_velocity"]["passed"] is False
    assert by["static_margin_rail_exit"]["passed"] is True
    assert any("rail_exit_velocity" in w for w in rep["warnings"])


def _gravity_turn_loss(cfg, drag, incl_deg):
    """Point-mass 2-DOF: along the rail at incl_deg to its end, then thrust along the velocity
    (a gravity turn, what an overstable vehicle does in still air). Returns h(90) - h(incl)."""
    from fluids.atmosphere import ATMOSPHERE_1976
    from scipy.integrate import solve_ivp

    t_c, F, mO, mF = header_curve()
    md = mO + mF
    A = math.pi * cfg.rocket.radius**2
    m0 = 81.706
    elev, rail = cfg.environment.elevation, cfg.environment.rail_length_m

    def apogee(incl):
        th0 = math.radians(incl)

        def forces(t, h, V, m):
            burning = t < t_c[-1]
            atm = ATMOSPHERE_1976(elev + max(h, 0.0))
            T = np.interp(t, t_c, F) if burning else 0.0
            D = 0.5 * atm.rho * V * V * drag.at(V / atm.v_sonic, burning) * A
            return T - D, (np.interp(t, t_c, md) if burning else 0.0)

        def on_rail(t, y):
            s_, v, m = y
            f, mdot = forces(t, s_ * math.sin(th0), v, m)
            return [v, f / m - G0 * math.sin(th0), -mdot]

        off = lambda t, y: y[0] - rail  # noqa: E731
        off.terminal = True
        r = solve_ivp(on_rail, (0, 5), [0, 0, m0], events=off, max_step=1e-3, rtol=1e-9)
        t1, (s1, v1, m1) = r.t_events[0][0], r.y_events[0][0]

        def flight(t, y):
            x, h, vx, vh, m = y
            V = math.hypot(vx, vh)
            f, mdot = forces(t, h, V, m)
            return [vx, vh, f * vx / V / m, f * vh / V / m - G0, -mdot]

        top = lambda t, y: y[3]  # noqa: E731
        top.terminal, top.direction = True, -1
        y0 = [s1 * math.cos(th0), s1 * math.sin(th0), v1 * math.cos(th0), v1 * math.sin(th0), m1]
        sol = solve_ivp(flight, (t1, 80), y0, events=top, max_step=0.05, rtol=1e-8)
        return sol.y_events[0][0][1]

    return apogee(90.0) - apogee(incl_deg)


def test_launch_angle_costs_what_a_gravity_turn_says(shipped_flight):
    pytest.importorskip("fluids")
    from engine.pipeline.vehicle_drag import DragCurves

    cfg = shipped()
    cfg.environment.launch_inclination_deg = 84.0
    h84 = fly(cfg)["apogee"]
    loss = shipped_flight["apogee"] - h84
    d = shipped_flight["flight_report"]["drag"]
    drag = DragCurves(tuple(d["mach"]), tuple(d["cd_power_off"]), tuple(d["cd_power_on"]), d["model"], d["source"])
    bound = _gravity_turn_loss(cfg, drag, 84.0)
    assert 0.0 < loss < 1.2 * bound, (loss, bound)


# ---- FLT-10: pressure thrust


def test_thrust_curve_reference_is_the_solvers_ambient(shipped_flight):
    """The time-varying solver computes the curve at 101325 exp(-M g h / (R T0)) for the pad."""
    elev = shipped().environment.elevation
    p_ref = 101325.0 * math.exp(-0.0289644 * G0 * elev / (8.31447 * 288.15))
    motor = shipped_flight["flight"].rocket.motor
    assert motor.reference_pressure == pytest.approx(p_ref, rel=1e-9)
    assert shipped_flight["flight_report"]["reference_pressure_pa"] == pytest.approx(p_ref, rel=1e-9)


def test_pressure_thrust_grows_with_altitude(shipped_flight):
    """F(z) = F_curve + (p_ref - p(z)) A_exit, Sutton & Biblarz eq. 3-21: ~55 N at 1.2 km MSL."""
    from engine.pipeline.config_schemas import ensure_chamber_geometry

    cfg = shipped()
    fl = shipped_flight["flight"]
    A_e = ensure_chamber_geometry(cfg).A_exit
    p = fl.env.pressure(1200.0)
    dF = fl.rocket.motor.pressure_thrust(p)
    assert dF == pytest.approx((fl.rocket.motor.reference_pressure - p) * A_e, abs=0.01)
    assert dF == pytest.approx(54.6, abs=1.0)
