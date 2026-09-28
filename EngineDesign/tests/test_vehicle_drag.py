"""Drag of the flown vehicle (FLT-2).

The flight sim flew Cd 0.45 at every Mach, motor on and off, whatever the length, fins or finish.
The shipped vehicle is 7.76 m long on a 0.157 m body, 226 wetted areas per reference area: fully
turbulent skin friction alone exceeds 0.45. The build-up is Barrowman's as the OpenRocket technical
documentation (Niskanen 2013) gives it, on the geometry the sim assembles.

Independent sources here: Prandtl-Schlichting's smooth flat plate 0.455 / (log10 Re)^2.58, hand
geometry of the stack and the fins, the base-drag formula (Niskanen eq. 3.94 / sec. 3.4.5), the
1976 standard atmosphere from `fluids`, Stoney's fineness-3 table, and a hand trapezoid.
"""

from __future__ import annotations

import math

import pytest

from flight_cases import fly, shipped

rocketpy = pytest.importorskip("rocketpy")


def _built_length(cfg) -> float:
    """Tail to nose tip as the sim stacks it, by hand: highest tank top + avionics length."""
    tops = [
        cfg.lox_tank.ox_tank_pos + cfg.lox_tank.lox_h / 2,
        cfg.fuel_tank.fuel_tank_pos + cfg.fuel_tank.rp1_h / 2,
        cfg.press_tank.pres_tank_pos + cfg.press_tank.press_h / 2,
    ]
    return max(tops) + cfg.rocket.avionics_payload_length_m


def _smooth_friction_floor(cfg, mach: float) -> float:
    """0.12 base + smooth turbulent plate friction on the wetted area, Prandtl-Schlichting."""
    from fluids.atmosphere import ATMOSPHERE_1976

    atm = ATMOSPHERE_1976(cfg.environment.elevation)
    L, r = _built_length(cfg), cfg.rocket.radius
    Re = mach * atm.v_sonic * L / (atm.mu / atm.rho)
    cf = 0.455 / math.log10(Re) ** 2.58
    fins = cfg.rocket.fins
    s_wet = 2 * math.pi * r * L + fins.no_fins * 2 * 0.5 * (fins.root_chord + fins.tip_chord) * fins.fin_span
    return 0.12 + cf * s_wet / (math.pi * r * r)


@pytest.fixture(scope="module")
def shipped_flight():
    pytest.importorskip("fluids")
    return fly(shipped())


def test_drag_is_above_the_smooth_friction_floor(shipped_flight):
    cfg = shipped()
    floor = _smooth_friction_floor(cfg, 0.3)
    assert floor > 0.55, "premise: friction alone rules out 0.45 for this vehicle"
    assert shipped_flight["flight"].rocket.power_off_drag(0.3) >= floor


def test_thrusting_removes_the_nozzle_exit_from_the_base(shipped_flight):
    """Cd_off - Cd_on = (0.12 + 0.13 M^2) A_exit / A_ref, nothing else changes with the motor."""
    from engine.pipeline.config_schemas import ensure_chamber_geometry

    cfg = shipped()
    rocket = shipped_flight["flight"].rocket
    A_e = ensure_chamber_geometry(cfg).A_exit
    A_ref = math.pi * cfg.rocket.radius**2
    for M in (0.3, 0.5, 0.8):
        assert rocket.power_off_drag(M) - rocket.power_on_drag(M) == pytest.approx((0.12 + 0.13 * M * M) * A_e / A_ref, rel=1e-6)


def test_drag_grows_with_the_vehicle(shipped_flight):
    cfg = shipped()
    cfg.rocket.avionics_payload_length_m = 5.0
    longer = fly(cfg)["flight"].rocket
    assert longer.power_off_drag(0.5) > shipped_flight["flight"].rocket.power_off_drag(0.5) + 0.02


def test_rougher_skin_more_drag(shipped_flight):
    cfg = shipped()
    cfg.rocket.surface_roughness_m = 0.0
    smooth = fly(cfg)
    assert smooth["flight"].rocket.power_off_drag(0.5) < shipped_flight["flight"].rocket.power_off_drag(0.5) - 0.1
    assert smooth["apogee"] > shipped_flight["apogee"] + 100.0


def test_flown_length_is_the_hand_stack(shipped_flight):
    cfg = shipped()
    assert shipped_flight["flight_report"]["stack_length_m"] == pytest.approx(_built_length(cfg), abs=1e-9)
    drag = shipped_flight["flight_report"]["drag"]
    assert drag["model"] == "openrocket_barrowman"
    assert drag["inputs"]["length_m"] == pytest.approx(_built_length(cfg), abs=1e-9)
    assert any("rocket_length" in w for w in shipped_flight["flight_report"]["warnings"])


def test_full_burn_apogee_is_below_the_constant_cd_answer(shipped_flight):
    """Most favourable plausible build-up (smooth, the 6.43 m length) gives 3803 m AGL by an
    independent 1-DOF (audit); Cd 0.45 gave 4033 m."""
    assert shipped_flight["apogee"] < 3850.0


def test_user_table_is_flown_as_given():
    cfg = shipped()
    cfg.rocket.drag_curve_power_off = [[0.0, 0.6], [1.0, 0.8], [2.0, 0.7]]
    cfg.rocket.drag_curve_power_on = [[0.0, 0.5], [1.0, 0.7], [2.0, 0.6]]
    cfg.rocket.drag_curve_source = "test table"
    res = fly(cfg)
    rocket = res["flight"].rocket
    assert rocket.power_off_drag(0.5) == pytest.approx(0.7)
    assert rocket.power_on_drag(0.5) == pytest.approx(0.6)
    assert res["flight_report"]["drag"]["model"] == "table"


def test_a_table_needs_its_pair_and_its_source():
    from engine.pipeline.config_schemas import RocketConfig

    base = shipped().rocket.model_dump()
    with pytest.raises(ValueError, match="go together"):
        RocketConfig(**{**base, "drag_curve_power_off": [[0.0, 0.5], [1.0, 0.6]]})
    with pytest.raises(ValueError, match="go together"):
        RocketConfig(**{**base, "drag_curve_power_off": [[0.0, 0.5], [1.0, 0.6]], "drag_curve_power_on": [[0.0, 0.5], [1.0, 0.6]]})
    with pytest.raises(ValueError, match="increase"):
        RocketConfig(**{**base, "drag_curve_power_off": [[1.0, 0.5], [0.5, 0.6]], "drag_curve_power_on": [[0.0, 0.5], [1.0, 0.6]], "drag_curve_source": "x"})


# ---- the build-up's pieces against their sources


def test_turbulent_cf_against_prandtl_schlichting():
    from engine.pipeline.vehicle_drag import skin_friction_cf

    for Re in (1e6, 1e7, 1e8):
        assert skin_friction_cf(Re, 0.0, 0.0, 7.0) == pytest.approx(0.455 / math.log10(Re) ** 2.58, rel=0.06)


def test_rough_cf_is_reynolds_independent():
    """(3.80): 0.032 (Rs/L)^0.2 above the critical Re, whatever Re."""
    from engine.pipeline.vehicle_drag import skin_friction_cf

    L, Rs = 7.0, 60e-6
    rough = 0.032 * (Rs / L) ** 0.2
    assert skin_friction_cf(5e8, 0.0, Rs, L) == pytest.approx(rough, rel=1e-12)
    assert skin_friction_cf(5e9, 0.0, Rs, L) == pytest.approx(rough, rel=1e-12)


def test_isa_against_fluids():
    fluids = pytest.importorskip("fluids.atmosphere")
    from engine.pipeline.vehicle_drag import isa_troposphere

    for h in (0.0, 626.67, 3000.0, 11000.0, 18000.0, 25000.0):
        T, p, rho, a, nu = isa_troposphere(h)
        atm = fluids.ATMOSPHERE_1976(h)
        assert (T, p, rho, a) == pytest.approx((atm.T, atm.P, atm.rho, atm.v_sonic), rel=1e-5)
        assert nu == pytest.approx(atm.mu / atm.rho, rel=1e-5)


def test_nose_wave_drag_at_fineness_three_is_stoneys_table():
    """(B.9) scales Stoney's fineness-3 curve by log4(fN + 1), which is 1 at fN = 3."""
    from engine.pipeline.vehicle_drag import nose_pressure_cd

    for M, cd in ((0.95, 0.010), (1.0, 0.027), (1.2, 0.081), (2.0, 0.091)):
        assert nose_pressure_cd(M, "vonKarman", 3.0) == pytest.approx(cd, rel=1e-12)
    assert nose_pressure_cd(0.5, "vonKarman", 4.5) == 0.0  # tangent joint, below the data


def test_haack_wetted_area_against_a_hand_trapezoid():
    from engine.pipeline.vehicle_drag import nose_wetted_area

    L, R, n = 0.705, 0.078359, 200001
    xs = [L * i / (n - 1) for i in range(n)]

    def y(x):
        th = math.acos(1 - 2 * x / L)
        return R * math.sqrt(max(th - math.sin(2 * th) / 2, 0.0)) / math.sqrt(math.pi)

    ys = [y(x) for x in xs]
    area = sum(math.pi * (ys[i] + ys[i + 1]) * math.hypot(xs[i + 1] - xs[i], ys[i + 1] - ys[i]) for i in range(n - 1))
    assert nose_wetted_area("vonKarman", L, R) == pytest.approx(area, rel=1e-4)
