"""Margin against angle of attack, and the critical angle.

Each expectation is solved here from the moment balance written out by hand (and
OpenRocket 24.12's constants, BODY_LIFT_K = 1.1 and a 20 deg fin stall), not read
back from the module.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from backend.onshape.aero import high_aoa as ha

R = 0.08                      # body radius, m
A_REF = math.pi * R * R
L = 3.0                       # a plain tube, nose at s = 0


def _tube(n: int = 301):
    s = np.linspace(0.0, L, n)
    return s, np.full_like(s, R)


def _bisect(f, lo: float, hi: float) -> float:
    assert f(lo) > 0 > f(hi)
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        lo, hi = (mid, hi) if f(mid) > 0 else (lo, mid)
    return 0.5 * (lo + hi)


def _tube_with_fins(fin_cna: float, fin_cp: float, cg: float) -> ha.HighAoA:
    s, r = _tube()
    return ha.high_aoa(body_cna=0.0, body_cp=0.0, fin_cna=fin_cna, fin_cp=fin_cp,
                       cg=cg, nose=0.0, s_grid=s, r_grid=r, r_ref=R)


def test_planform_of_a_tube_and_a_cone():
    s, r = _tube()
    area, xc = ha.body_planform(s, r)
    assert area == pytest.approx(2 * R * L)
    assert xc == pytest.approx(L / 2)
    # A cone from a point at s = 0 to radius R at s = 1: a triangle, centroid at 2/3.
    s = np.linspace(0.0, 1.0, 400)
    area, xc = ha.body_planform(s, R * s)
    assert area == pytest.approx(R * 1.0)
    assert xc == pytest.approx(2.0 / 3.0)


def test_critical_angle_solves_the_moment_balance():
    # Fins CNa 3 at 2.8 m, CG at 2.0 m, the tube's side area centred at 1.5 m:
    #   3 * a * 0.8  =  1.1 * (2 R L / A_ref) * sin(a)^2 * 0.5      (a below 20 deg)
    k = 1.1 * (2 * R * L / A_REF)
    want = math.degrees(_bisect(lambda a: 3.0 * a * 0.8 - k * math.sin(a) ** 2 * 0.5,
                                1e-4, math.radians(19.9)))
    h = _tube_with_fins(3.0, 2.8, 2.0)
    assert h.critical_aoa_deg == pytest.approx(want, abs=1e-6)
    assert 9.0 < want < 12.0  # the case is what it says: below stall
    assert h.side_area_ratio == pytest.approx(2 * R * L / A_REF)
    assert h.restoring_per_rad == pytest.approx(3.0 * 0.8)
    assert h.overturning_per_rad2 == pytest.approx(k * 0.5)
    # The margin curve crosses zero there.
    m = {c["aoa"]: c["margin"] for c in h.curve}
    assert m[math.floor(want)] > 0 > m[math.ceil(want)]


def test_fins_stop_growing_at_stall():
    # Larger fins push the crossing past 20 deg, where the fin force is held at
    # CNa * 20 deg while the body's keeps growing as sin^2.
    k = 1.1 * (2 * R * L / A_REF)
    stall = math.radians(20.0)
    fin, arm, body_arm = 6.0, 0.8, 0.5
    want = math.degrees(_bisect(lambda a: fin * min(a, stall) * arm - k * math.sin(a) ** 2 * body_arm,
                                1e-4, math.radians(80)))
    assert want > 20.0
    h = _tube_with_fins(fin, 2.8, 2.0)
    assert h.critical_aoa_deg == pytest.approx(want, abs=1e-6)
    # Without the cap the same fins would hold out further.
    unstalled = math.degrees(_bisect(lambda a: fin * a * arm - k * math.sin(a) ** 2 * body_arm,
                                     1e-4, math.radians(80)))
    assert unstalled > want + 1.0


def test_zero_angle_margin_is_the_barrowman_margin():
    # Nose CNa 2 at 0.5 m, fins CNa 6 at 2.9 m, CG 2.0 m: CP = (1 + 17.4) / 8 = 2.3 m.
    s, r = _tube()
    h = ha.high_aoa(body_cna=2.0, body_cp=0.5, fin_cna=6.0, fin_cp=2.9, cg=2.0,
                    nose=0.0, s_grid=s, r_grid=r, r_ref=R)
    c0 = h.curve[0]
    assert c0["aoa"] == 0.0
    assert c0["cpFromNose"] == pytest.approx(2.3)
    assert c0["margin"] == pytest.approx(0.3 / (2 * R))
    # One degree in, the body lift has already pulled the CP forward.
    assert h.curve[1]["cpFromNose"] < 2.3


def test_body_lift_aft_of_the_cg_never_destabilizes():
    # CG ahead of the planform centre: the crossflow pushes aft of the CG and helps.
    h = _tube_with_fins(3.0, 2.8, 1.2)
    assert h.critical_aoa_deg is None
    assert h.max_crosswind == []
    assert h.overturning_per_rad2 < 0


def test_unstable_at_zero_is_zero():
    h = _tube_with_fins(3.0, 2.8, 2.9)
    assert h.critical_aoa_deg == 0.0
    assert all(w["maxCrosswind"] == 0.0 for w in h.max_crosswind)


def test_max_crosswind_is_speed_times_tan_critical():
    h = _tube_with_fins(3.0, 2.8, 2.0)
    t = math.tan(math.radians(h.critical_aoa_deg))
    assert [w["railSpeed"] for w in h.max_crosswind] == list(ha.RAIL_SPEEDS)
    for w in h.max_crosswind:
        assert w["maxCrosswind"] == pytest.approx(w["railSpeed"] * t)


def test_stability_endpoint_reports_it(monkeypatch, tmp_path):
    """Through /stability: the curve starts at the panel's own static margin and the
    planform is the model's cone + tube."""
    from test_stability_api import _write_model, client

    parts = [{"key": "m", "mass": 1.0, "centroidWorld": [0, 0, 0.35], "hasGeometry": False}]
    L_nose = _write_model(tmp_path / "m1", parts=parts)
    body = client(monkeypatch, tmp_path).post("/api/models/m1/stability", json={"finFaces": []}).json()
    h = body["highAoa"]
    assert h["curve"][0]["margin"] == pytest.approx(body["staticMargin"], abs=1e-9)
    # Cone (0.3 m, R 0.05) + tube (0.7 m): side area R*0.3 + 2R*0.7.
    assert h["sideArea"] == pytest.approx(0.05 * 0.3 + 2 * 0.05 * 0.7, rel=2e-3)
    assert h["cgFromNose"] == pytest.approx(body["cg"]["fromNose"])
    assert L_nose == 0.3


def test_6dof_checks_the_rail_exit(tmp_path):
    """The 6-DOF reports the critical angle at the rail-exit CG, and the curve's zero
    angle is the margin the 6-DOF itself had at that instant."""
    pytest.importorskip("rocketpy")
    from backend.onshape.aero.outer_surface import detect_outer_surface
    from backend.onshape.aero.rocketpy_flight import simulate_flight_dynamics
    from backend.onshape.aero.stability import MotorPlacement
    from backend.onshape.geometry_store import GeometryStore
    from backend.ork.importer import import_ork
    from ork_samples import sample_ork_xml
    from test_rocketpy_flight import _ELEV, _motor

    manifest = import_ork(sample_ork_xml().encode(), "sample.ork", tmp_path)
    store = GeometryStore.load(tmp_path / manifest["source"]["modelId"])
    motor = _motor()
    placement = MotorPlacement(mass=motor.launch_mass, length=motor.length, cmx=motor.launch_cgx,
                               diameter=motor.diameter, aft_offset=-0.06)
    res = simulate_flight_dynamics(
        store, manifest["parts"], detect_outer_surface(store).faces, motor, placement,
        rail_length=3.0, inclination=88.0, elevation=_ELEV,
    )
    h = res.rail_exit_high_aoa
    assert h is not None and res.out_of_rail_time > 0
    # At zero angle the curve is the margin the 6-DOF itself had as the rail let go
    # (same CG, same Mach), read off its margin series at that instant.
    margin_rail = np.interp(res.out_of_rail_time, res.times,
                            [m if m is not None else np.nan for m in res.stability_margin_ours])
    assert h.curve[0]["margin"] == pytest.approx(margin_rail, abs=2e-3)

    from backend.main import _rail_exit_block
    block = _rail_exit_block(res)
    crit = h.critical_aoa_deg
    if crit is not None:
        assert block["maxCrosswind"] == pytest.approx(res.out_of_rail_velocity * math.tan(math.radians(crit)))
