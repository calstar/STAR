"""RocketPy ascent assembly: a stable rocket produces a sane 6-DOF flight.

Skipped without rocketpy (optional dep). Tests ``run_flight`` with explicit geometry
so no Onshape store/fixtures are needed. Not a physics-accuracy check (drag/inertia are
stubs) -- it guards that the assembly runs and the outputs are well-formed and bounded.
"""

from __future__ import annotations

import numpy as np
import pytest

pytest.importorskip("rocketpy")

from backend.motors.motor import Motor  # noqa: E402
from backend.onshape.aero.rocketpy_flight import RocketGeom, run_flight  # noqa: E402
from physics.atmosphere import Atmosphere  # noqa: E402
from physics.wind import WindProfile  # noqa: E402

#: The pad elevation `_run` launches from; the shared-env objects live on the same grid.
_ELEV = 1400.0


def _motor() -> Motor:
    t = list(np.linspace(0, 2.0, 20))
    thrust = [600.0 if x < 1.8 else 0.0 for x in t]
    mass = [0.5 - 0.3 * (x / 1.8) if x < 1.8 else 0.2 for x in t]
    cg = [0.15] * len(t)
    return Motor(
        manufacturer="X", designation="K600", diameter=0.038, length=0.3, delays=[],
        motor_type="SINGLE", time=t, thrust=thrust, cg_x=cg, mass=mass, digest="d",
    )


def _stable_geom(surfaces=None, **kw) -> RocketGeom:
    # Nose (CNa 2 at 2/3 of a 0.3 m cone) and four fins (CNa 8 at 1.55 m); CG well
    # forward of the combined CP (1.25 m) -> statically stable, 2.25 calibres.
    return RocketGeom(
        radius=0.05, body_length=1.6, mass_without_motor=4.0, cg_from_nose=0.8,
        surfaces=surfaces or [("nose", lambda m: 2.0, 0.2), ("fins", lambda m: 8.0, 1.55)],
        **kw,
    )


def _run(**kw):
    return run_flight(
        kw.pop("geom", None) or _stable_geom(), _motor(), nozzle_position_from_nose=1.6, rail_length=3.0,
        inclination=88, heading=0, elevation=_ELEV, our_margin_fn=lambda t, m: 2.0, **kw,
    )


def _wind(speed: float, direction: float = 270.0) -> WindProfile:
    return WindProfile.constant(speed, direction, site_elev=_ELEV)


def test_stable_flight_is_well_formed():
    res = _run(wind_profile=_wind(6.0))
    assert res.launch_stable is True
    assert res.apogee > 100.0
    assert 0.0 < res.max_mach < 5.0
    assert res.out_of_rail_velocity > 0.0
    assert res.min_stability_margin > 0.0  # stable throughout
    assert res.max_dynamic_pressure > 0.0
    # series are all the same length and margins overlay is populated.
    n = len(res.times)
    assert n == len(res.stability_margin_rocketpy) == len(res.stability_margin_ours) == len(res.mach)
    assert all(m == 2.0 for m in res.stability_margin_ours)
    # angle of attack stays physical (guarded) -- never exceeds 180 deg.
    assert all(a is None or 0.0 <= a <= 180.0 for a in res.angle_of_attack)


def test_wind_drives_downwind_drift():
    calm = _run(wind_profile=_wind(0.0))
    windy = _run(wind_profile=_wind(8.0))
    assert windy.drift_distance > calm.drift_distance  # wind moves the apogee point


def test_shared_atmosphere_couples_to_apogee():
    """The ascent flies through the same Atmosphere the descent uses, so a warmer
    (thinner) pad column -> less drag -> a measurably higher apogee. This is the
    coupling the Environment tab exists to make real."""
    cold = _run(atmosphere=Atmosphere(_ELEV, T_pad=250.0))
    hot = _run(atmosphere=Atmosphere(_ELEV, T_pad=320.0))
    assert cold.apogee > 100.0 and hot.apogee > 100.0
    assert hot.apogee > cold.apogee


def test_burnout_mass_and_drag():
    """What the recovery tab sizes drag separation from. Mass: 4.0 kg dry plus
    the motor's 0.2 kg spent casing. Drag: q * Cd(M) * pi r^2 by hand, reading
    q and Mach off the result's own series at burnout and Cd off the stub
    curve the flight was run with."""
    from backend.onshape.aero.rocketpy_flight import _STUB_DRAG

    res = _run()
    assert res.burnout_mass == pytest.approx(4.2, abs=0.01)
    t_bo = res.burnout_time
    q = np.interp(t_bo, res.times, res.dynamic_pressure)
    mach = np.interp(t_bo, res.times, res.mach)
    cd = np.interp(mach, *zip(*_STUB_DRAG))
    assert res.burnout_drag == pytest.approx(q * cd * np.pi * 0.05 ** 2, rel=0.03)


# -- The 6-DOF flies the app's airframe ---------------------------------------------
#
# Hand numbers for _stable_geom + _motor: CP = (2*0.2 + 8*1.55)/10 = 1.28 m. The
# motor's nozzle is at 1.6 m; its propellant (chamber centre) and its casing
# (burnout CG 0.15 m from the fore end of a 0.3 m motor) both sit 0.15 m forward of
# the nozzle, at 1.45 m. At ignition: CG = (4.0*0.8 + 0.5*1.45)/4.5 = 0.87222 m.


def test_rocketpy_margin_is_the_components_margin():
    res = _run()
    cg0 = (4.0 * 0.8 + 0.5 * 1.45) / 4.5
    assert res.stability_margin_rocketpy[0] == pytest.approx((1.28 - cg0) / 0.1, abs=1e-3)


def test_a_boattail_counts_in_the_6dof():
    """The old 6-DOF flew a RocketPy nose + fins and nothing else, so a boattail
    never moved its margin. Its (negative) CNa now pulls the CP forward exactly."""
    tail = _stable_geom(surfaces=[("nose", lambda m: 2.0, 0.2), ("fins", lambda m: 8.0, 1.55),
                                  ("boattail", lambda m: -1.0, 1.58)])
    with_tail = _run(geom=tail)
    cg0 = (4.0 * 0.8 + 0.5 * 1.45) / 4.5
    cp = (2 * 0.2 + 8 * 1.55 - 1.0 * 1.58) / 9.0
    assert with_tail.stability_margin_rocketpy[0] == pytest.approx((cp - cg0) / 0.1, abs=1e-3)
    assert with_tail.stability_margin_rocketpy[0] < _run().stability_margin_rocketpy[0]


def test_the_inertia_flown_is_the_one_given():
    res = _run(geom=_stable_geom(inertia=(0.9, 0.9, 0.006)))
    assert res.inertia_transverse == 0.9 and res.inertia_source == "parts"
    rod = _run()
    assert rod.inertia_transverse == pytest.approx(4.0 * 1.6**2 / 12)
    assert rod.inertia_source == "uniform rod"
    assert any("uniform-rod" in a for a in rod.approximations)


def test_inertia_changes_the_pitch_dynamics():
    """Lower pitch inertia -> the rocket turns into a crosswind faster after the rail:
    the reason the rod estimate mattered. Measured as the time for the angle of
    attack to fall to half its rail-exit value."""
    def t_half(res):
        t = np.asarray(res.times)
        a = np.asarray([np.nan if x is None else x for x in res.angle_of_attack])
        start = int(np.argmax(np.asarray([s or 0 for s in res.speed]) >= res.out_of_rail_velocity))
        target = 0.5 * res.out_of_rail_angle_of_attack
        below = np.nonzero(a[start:] <= target)[0]
        return t[start + below[0]] - t[start]

    light = _run(geom=_stable_geom(inertia=(0.3, 0.3, 0.006)), wind_profile=_wind(6.0))
    heavy = _run(geom=_stable_geom(inertia=(3.0, 3.0, 0.006)), wind_profile=_wind(6.0))
    assert t_half(light) < t_half(heavy)


def test_the_nozzle_is_at_the_motors_aft_end():
    """Jet damping goes as mdot * (nozzle - CG)^2. The motor used to be placed by its
    CG with the nozzle at that point; it is now placed by its nozzle."""
    from rocketpy import Rocket

    from backend.onshape.aero.rocketpy_flight import _generic_motor

    rocket = Rocket(radius=0.05, mass=4.0, inertia=(1, 1, 0.01), power_off_drag=0.5,
                    power_on_drag=0.5, center_of_mass_without_motor=0.8,
                    coordinate_system_orientation="nose_to_tail")
    rocket.add_motor(_generic_motor(_motor()), position=1.6)
    assert rocket.nozzle_position == pytest.approx(1.6)
    # RocketPy measures the arm to the CG of the airframe plus the motor casing
    # (0.2 kg, 0.15 m forward of the nozzle): (4.0*0.8 + 0.2*1.45)/4.2 = 0.83095 m.
    assert rocket.nozzle_to_cdm == pytest.approx(1.6 - (4.0 * 0.8 + 0.2 * 1.45) / 4.2)
    # And the motor's CG is where its datafile puts it: 0.15 m forward of the nozzle.
    assert float(rocket.motor_center_of_mass_position(0)) == pytest.approx(1.45, abs=1e-6)
    assert float(rocket.center_of_mass(0)) == pytest.approx((4.0 * 0.8 + 0.5 * 1.45) / 4.5, abs=1e-9)


def test_max_angle_of_attack_ignores_the_rail_and_the_slow_end():
    res = _run(wind_profile=_wind(8.0))
    v = np.asarray([s or 0.0 for s in res.speed])
    fast = [a for a, s in zip(res.angle_of_attack, v) if a is not None and s >= 0.25 * v.max()]
    assert res.max_angle_of_attack <= max(fast) + 1e-9
    assert res.out_of_rail_angle_of_attack is not None
    # A crosswind of 8 m/s at the off-rail speed: AoA ~ atan(8 / v_rail).
    expected = np.degrees(np.arctan2(8.0, res.out_of_rail_velocity))
    assert res.out_of_rail_angle_of_attack == pytest.approx(expected, rel=0.25)


def test_imported_rocket_6dof_margin_tracks_the_stability_panel(tmp_path):
    """End to end on a real model: the 6-DOF's own margin and the panel's Barrowman
    margin, sample by sample, are the same number -- one airframe."""
    from backend.onshape.aero.outer_surface import detect_outer_surface
    from backend.onshape.aero.rocketpy_flight import simulate_flight_dynamics
    from backend.onshape.aero.stability import MotorPlacement
    from backend.onshape.geometry_store import GeometryStore
    from backend.ork.importer import import_ork
    from ork_samples import sample_ork_xml

    manifest = import_ork(sample_ork_xml().encode(), "sample.ork", tmp_path)
    store = GeometryStore.load(tmp_path / manifest["source"]["modelId"])
    motor = _motor()
    placement = MotorPlacement(mass=motor.launch_mass, length=motor.length, cmx=motor.launch_cgx,
                               diameter=motor.diameter, aft_offset=-0.06)
    res = simulate_flight_dynamics(
        store, manifest["parts"], detect_outer_surface(store).faces, motor, placement,
        rail_length=3.0, inclination=88.0, elevation=_ELEV,
    )
    assert res.inertia_source == "parts"
    pairs = [(rp, ours) for rp, ours, m in zip(res.stability_margin_rocketpy, res.stability_margin_ours, res.mach)
             if ours is not None and m and m > 0.05]
    assert len(pairs) > 50
    worst = max(abs(rp - ours) for rp, ours in pairs)
    assert worst < 0.02, worst


def test_injected_surfaces_fly_exactly_like_rocketpys_own():
    """The validation FUTURE_IMPROVEMENTS #3 asked for: a rocket built from RocketPy's
    native nose and fins, and the same rocket built from the app's surfaces carrying
    *those surfaces'* CNa(M) and CP, fly the same trajectory and the same gust response
    -- so the app's surfaces get RocketPy's lift and pitch damping, nothing less."""
    from rocketpy import Environment, Flight, Rocket

    from backend.onshape.aero.rocketpy_flight import _barrowman_surface, _generic_motor

    def base():
        r = Rocket(radius=0.05, mass=4.0, inertia=(0.9, 0.9, 0.006), power_off_drag=0.45,
                   power_on_drag=0.45, center_of_mass_without_motor=0.8,
                   coordinate_system_orientation="nose_to_tail")
        r.add_motor(_generic_motor(_motor()), position=1.6)
        return r

    native = base()
    nose = native.add_nose(length=0.3, kind="vonKarman", position=0.0)
    fins = native.add_trapezoidal_fins(n=4, root_chord=0.12, tip_chord=0.06, span=0.08,
                                       position=1.45, sweep_length=0.05)
    injected = base()
    surfaces, positions = [], []
    for surf, pos in native.aerodynamic_surfaces:
        cp = pos.z - native._csys * surf.cpz  # the surface's CP, from the nose
        surfaces.append(_barrowman_surface(surf.name, (lambda m, f=surf.clalpha: f(m)), 0.05))
        positions.append(cp)
    injected.add_surfaces(surfaces, positions)
    assert float(injected.static_margin(0)) == pytest.approx(float(native.static_margin(0)), abs=1e-9)

    env = Environment(latitude=35.0, longitude=-117.0, elevation=_ELEV)
    env.set_atmospheric_model(type="custom_atmosphere", wind_u=[[_ELEV, 6.0], [_ELEV + 8000, 6.0]],
                              wind_v=[[_ELEV, 0.0], [_ELEV + 8000, 0.0]])
    a, b = (Flight(rocket=r, environment=env, rail_length=3.0, inclination=88, heading=0,
                   terminate_on_apogee=True, max_time_step=0.5, verbose=False) for r in (native, injected))
    assert b.apogee == pytest.approx(a.apogee, rel=2e-3)
    ts = np.linspace(a.out_of_rail_time, 0.8 * a.apogee_time, 60)
    assert np.allclose([b.w2(t) for t in ts], [a.w2(t) for t in ts], atol=0.02)
    assert np.allclose([b.angle_of_attack(t) for t in ts], [a.angle_of_attack(t) for t in ts], atol=0.3)
    del nose, fins
