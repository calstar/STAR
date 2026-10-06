"""The Flight tab's router: the apogee ceiling (FLT-5), the masses it forwards (FLT-6), and the
thrust curve's reference pressure (FLT-10).

FLT-5: the only altitude requirement was a lower target; a 15,000 ft MSL waiver appeared only in
a config comment, with no datum. FLT-6: engine and tank-structure masses edited on the Flight
tab were written only into propulsion_dry_mass, which the flight never reads once engine_mass is
set, so every such edit flew the config's masses. FLT-10: the time series runs at the SESSION
config's pad, so the thrust curve's reference is that elevation, not one the tab overrides.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import math
import types

import pytest

pytest.importorskip("rocketpy")
pytest.importorskip("stardesign", reason="backend.session needs lib/stardesign on PYTHONPATH")

from flight_cases import header_curve, shipped  # noqa: E402


def _request(cfg, **over):
    from backend.routers.flight import FlightSimRequest

    t, F, mO, mF = header_curve()
    body = dict(time_array=t.tolist(), thrust_array=F.tolist(), mdot_O_array=mO.tolist(), mdot_F_array=mF.tolist(),
                lox_mass_kg=cfg.lox_tank.mass, fuel_mass_kg=cfg.fuel_tank.mass)
    body.update(over)
    return FlightSimRequest(**body)


def _simulate(cfg, request):
    from backend.routers.flight import _execute_flight_simulation

    with contextlib.redirect_stdout(io.StringIO()):
        return _execute_flight_simulation(cfg, request)


# ---- FLT-5


def test_a_ceiling_needs_a_datum():
    from engine.pipeline.config_schemas import DesignRequirementsConfig

    base = shipped().design_requirements.model_dump()
    with pytest.raises(ValueError, match="max_apogee_datum"):
        DesignRequirementsConfig(**{**base, "max_apogee_m": 4572.0})
    assert DesignRequirementsConfig(**base).max_apogee_m is None  # unset by default: nothing is invented


def test_msl_ceiling_is_converted_at_the_pad():
    from backend.routers.flight import ceiling_agl_m

    assert ceiling_agl_m({"max_apogee_m": 15000 * 0.3048, "max_apogee_datum": "MSL"}, 626.67) == pytest.approx(3945.33, abs=0.01)
    assert ceiling_agl_m({"max_apogee_m": 3000.0, "max_apogee_datum": "AGL"}, 626.67) == pytest.approx(3000.0)
    assert ceiling_agl_m({"max_apogee_m": None}, 626.67) is None


def test_no_ceiling_no_check():
    cfg = shipped()
    r = _simulate(cfg, _request(cfg))
    assert r.status == "success" and r.ceiling is None


def test_ceiling_is_checked_at_the_high_apogee_corner():
    cfg = shipped()
    cfg.design_requirements.max_apogee_m = 15000 * 0.3048
    cfg.design_requirements.max_apogee_datum = "MSL"
    r = _simulate(cfg, _request(cfg))
    c = r.ceiling
    assert r.status == "success"
    assert c["ceiling_agl_m"] == pytest.approx(3945.33, abs=0.01)
    assert c["nominal_apogee_agl_m"] == pytest.approx(r.apogee_m)
    assert "surface_roughness_m 0" in c["corner"]
    assert c["corner_apogee_agl_m"] > c["nominal_apogee_agl_m"] + 100.0, "a smooth skin flies higher"
    assert c["corner_margin_m"] == pytest.approx(c["ceiling_agl_m"] - c["corner_apogee_agl_m"])
    assert c["violated"] is False
    assert r.apogee_msl_m == pytest.approx(r.apogee_m + 626.67)


def test_ceiling_violation_is_flagged_not_hidden():
    cfg = shipped()
    cfg.design_requirements.max_apogee_m = 3000.0
    cfg.design_requirements.max_apogee_datum = "AGL"
    r = _simulate(cfg, _request(cfg))
    assert r.status == "success" and r.ceiling["violated"] is True
    assert any("ceiling exceeded" in w for w in r.propellant.warnings)


def test_optimize_refuses_a_target_above_the_ceiling():
    from backend.routers.flight import FlightOptimizeRequest, optimize_flight_altitude

    cfg = shipped()
    cfg.design_requirements.max_apogee_m = 3000.0
    cfg.design_requirements.max_apogee_datum = "AGL"
    t, F, mO, mF = header_curve()
    req = FlightOptimizeRequest(time_array=t.tolist(), thrust_array=F.tolist(), mdot_O_array=mO.tolist(),
                                mdot_F_array=mF.tolist(), target_apogee_m=3500.0, apogee_tolerance_m=15.0)
    session = types.SimpleNamespace(app_state=types.SimpleNamespace(has_config=lambda: True, config=cfg))
    out = asyncio.run(optimize_flight_altitude(req, session))
    assert out.success is False and "ceiling" in out.infeasible_reason and out.simulations_run == 0


# ---- FLT-6


def test_request_masses_reach_the_flight_config():
    from backend.routers.flight import RocketConfig, build_flight_config
    from engine.pipeline.config_schemas import PintleEngineConfig

    cfg = shipped()
    rk = RocketConfig(airframe_mass=43.43, engine_mass=24.54, lox_tank_structure_mass=4.1, fuel_tank_structure_mass=5.0,
                      copv_dry_mass=3.2, radius=0.078359, inertia=[8.0, 8.0, 0.5])
    d = build_flight_config(cfg, _request(cfg, rocket=rk))
    PintleEngineConfig(**d)
    r = d["rocket"]
    assert (r["engine_mass"], r["lox_tank_structure_mass"], r["fuel_tank_structure_mass"], r["copv_dry_mass"]) == (24.54, 4.1, 5.0, 3.2)
    assert r["propulsion_dry_mass"] == pytest.approx(24.54 + 4.1 + 5.0 + 3.2)
    assert r["nose_kind"] == cfg.rocket.nose_kind, "a field the request omits keeps the config's value"


def test_engine_mass_edit_changes_the_apogee():
    """+10 kg of engine: the 1-DOF (engine/pipeline/flight_1dof, checked against Sutton) predicts
    the loss with the same drag; the flight must move by about as much, not by zero."""
    from backend.routers.flight import RocketConfig
    from engine.pipeline.flight_1dof import vertical_apogee_agl
    from engine.pipeline.vehicle_drag import DragCurves

    cfg = shipped()
    rk = dict(airframe_mass=cfg.rocket.airframe_mass, lox_tank_structure_mass=cfg.rocket.lox_tank_structure_mass,
              fuel_tank_structure_mass=cfg.rocket.fuel_tank_structure_mass, copv_dry_mass=cfg.rocket.copv_dry_mass,
              radius=cfg.rocket.radius, inertia=list(cfg.rocket.inertia), fins=cfg.rocket.fins.model_dump())
    light = _simulate(cfg, _request(cfg, rocket=RocketConfig(engine_mass=cfg.rocket.engine_mass, **rk)))
    heavy = _simulate(cfg, _request(cfg, rocket=RocketConfig(engine_mass=cfg.rocket.engine_mass + 10.0, **rk)))
    d = light.report["drag"]
    drag = DragCurves(tuple(d["mach"]), tuple(d["cd_power_off"]), tuple(d["cd_power_on"]), d["model"], d["source"])
    t, F, mO, mF = header_curve()
    m0 = light.report["wet_mass_kg"]
    kw = dict(area_m2=math.pi * cfg.rocket.radius**2, drag=drag, elevation_m=626.67)
    predicted = vertical_apogee_agl(t, F, mO + mF, m0, **kw) - vertical_apogee_agl(t, F, mO + mF, m0 + 10.0, **kw)
    moved = light.apogee_m - heavy.apogee_m
    assert heavy.report["wet_mass_kg"] == pytest.approx(m0 + 10.0, abs=1e-6)
    assert moved == pytest.approx(predicted, rel=0.1), (moved, predicted)


# ---- FLT-10


def test_reference_pressure_is_the_session_pad_not_the_tabs():
    from backend.routers.flight import EnvironmentConfig

    cfg = shipped()
    env = EnvironmentConfig(latitude=35.35, longitude=-117.81, elevation=1500.0, date=[2026, 1, 30, 18])
    r = _simulate(cfg, _request(cfg, environment=env))
    p_pad = 101325.0 * math.exp(-0.0289644 * 9.80665 * cfg.environment.elevation / (8.31447 * 288.15))
    assert r.report["reference_pressure_pa"] == pytest.approx(p_pad, rel=1e-9)
    stated = _simulate(cfg, _request(cfg, reference_pressure_pa=90000.0))
    assert stated.report["reference_pressure_pa"] == 90000.0
