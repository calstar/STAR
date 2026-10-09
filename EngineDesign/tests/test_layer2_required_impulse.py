"""Layer 2's required impulse is a vertical flight, not a formula (FLT-7).

It was (1.15 sqrt(2 g h) + 0.5 g t_b)(m_dry + m_p): 27,094 N s for the 6.5 kN vehicle against
22,537 N s with no drag (Sutton) and 25,025 N s at the flight sim's old Cd 0.45, with errors
that cancelled only near that point (+18 % at 40 kg / 40 kg / 15 s).

References: Sutton & Biblarz's closed form for vertical flight without drag (ch. 4), and an
independent point-mass integration (scipy solve_ivp, fluids' 1976 atmosphere) with drag.
"""

from __future__ import annotations

import math

import pytest
from scipy.optimize import brentq

from engine.optimizer.layers.layer2_pressure import calculate_required_impulse_from_mass

G0 = 9.80665


def _sutton_impulse(m0, mp, tb, h):
    def apogee(c):
        R = m0 / (m0 - mp)
        u = c * math.log(R) - G0 * tb
        hp = c * tb * (1 - math.log(R) / (R - 1)) - 0.5 * G0 * tb**2
        return hp + u * u / (2 * G0)

    return brentq(lambda c: apogee(c) - h, 100.0, 20000.0) * mp


def _ivp_impulse(m0, mp, tb, h, cd, area, elev):
    """Flat mdot, constant exhaust velocity, constant Cd, 1976 atmosphere: impulse to apogee h."""
    fluids = pytest.importorskip("fluids.atmosphere")
    from scipy.integrate import solve_ivp

    md = mp / tb

    def apogee(c):
        def rhs(t, y):
            z, v, m = y
            atm = fluids.ATMOSPHERE_1976(elev + max(z, 0.0))
            T = c * md if t < tb else 0.0
            return [v, (T - 0.5 * atm.rho * v * abs(v) * cd * area) / m - G0, -md if t < tb else 0.0]

        burn = solve_ivp(rhs, (0, tb), [0, 0, m0], max_step=0.005, rtol=1e-10, atol=1e-9)
        top = lambda t, y: y[1]  # noqa: E731
        top.terminal, top.direction = True, -1
        coast = solve_ivp(rhs, (tb, 400), burn.y[:, -1], events=top, max_step=0.05, rtol=1e-10, atol=1e-9)
        return coast.y_events[0][0][0]

    return brentq(lambda c: apogee(c) - h, 500.0, 6000.0, xtol=1e-4) * mp


def test_no_drag_is_sutton():
    I = calculate_required_impulse_from_mass(3890.7, 81.647 - 11.015, 11.015, 3.8978)
    assert I == pytest.approx(_sutton_impulse(81.647, 11.015, 3.8978, 3890.7), rel=1e-4)
    assert I == pytest.approx(22537.0, rel=5e-3)  # the audit's number


@pytest.mark.parametrize("m_dry,mp,tb,h", [(70.632, 11.015, 3.8978, 3890.7), (40.0, 40.0, 15.0, 9000.0)])
def test_with_drag_matches_an_independent_integration(m_dry, mp, tb, h):
    from engine.pipeline.vehicle_drag import DragCurves

    area, elev = math.pi * 0.078359**2, 626.67
    const = DragCurves((0.0, 5.0), (0.45, 0.45), (0.45, 0.45), "table", "constant 0.45")
    vehicle = {"flight": {"area_m2": area, "drag": const, "elevation_m": elev}, "gas_on_board_kg": 0.0}
    I = calculate_required_impulse_from_mass(h, m_dry, mp, tb, vehicle=vehicle)
    assert I == pytest.approx(_ivp_impulse(m_dry + mp, mp, tb, h, 0.45, area, elev), rel=2e-3)


def test_the_pressurant_on_board_is_weight():
    base = calculate_required_impulse_from_mass(3890.7, 69.320, 11.015, 3.8978)
    gas = calculate_required_impulse_from_mass(3890.7, 69.320, 11.015, 3.8978, vehicle={"gas_on_board_kg": 1.312})
    assert gas == pytest.approx(_sutton_impulse(69.320 + 1.312 + 11.015, 11.015, 3.8978, 3890.7), rel=1e-4)
    assert gas > base


def test_layer2_and_the_flight_agree_on_the_shipped_vehicle():
    """The same curve, drag and pad: the 1-DOF apogee and RocketPy's within 1 %."""
    pytest.importorskip("rocketpy")
    from engine.optimizer.layers.layer2_pressure import layer2_flight_vehicle
    from engine.pipeline.flight_1dof import vertical_apogee_agl
    from flight_cases import fly, header_curve, shipped

    cfg = shipped()
    res = fly(cfg)
    vehicle = layer2_flight_vehicle(cfg)
    t, F, mO, mF = header_curve()
    h = vertical_apogee_agl(t, F, mO + mF, res["flight_report"]["wet_mass_kg"], **vehicle["flight"])
    assert h == pytest.approx(res["apogee"], rel=0.01)
    assert vehicle["gas_on_board_kg"] == pytest.approx(cfg.press_tank.initial_gas_mass)
