"""The .ork export: the file OpenRocket opens must have the app's shape, CP and CG.

Synthetic rocket: a tangent-ogive nose on a tube, three swept trapezoidal fins with
both sides modelled (so they have a thickness), and two point masses. The checks
here are on what is *written*; ``test_ork_openrocket.py`` loads the same file in
OpenRocket itself when a JDK and the jar are available.
"""

from __future__ import annotations

import io
import math
import xml.etree.ElementTree as ET
import zipfile

import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend import main
from backend.onshape.aero.barrowman_fins import DIVISIONS
from backend.onshape.aero.fins import extract_fin_section, is_fin_face
from backend.onshape.aero.ork_export import (
    LaunchConditions,
    _strips,
    airframe_segments,
    export_from_cad,
    fin_points,
)
from backend.onshape.aero.outer_surface import detect_outer_surface
from backend.onshape.aero.stability import aero_core, compute_stability
from backend.onshape.geometry_store import FaceGeometry
from physics.schema import ConstantWind, Device, ProfileWind, Site
from test_aero_body import surface_of_revolution
from test_aero_stability import StubStore, _sor_face

L_NOSE, L_TUBE, R = 0.30, 0.90, 0.05
ROOT, TIP, SWEEP, SPAN = 0.16, 0.06, 0.09, 0.07
FIN_LE = L_NOSE + L_TUBE - ROOT  # fins flush with the base
THICK = 0.004
PARTS = [
    {"key": "occ:body", "mass": 1.5, "centroidWorld": [0.0, 0.0, 0.62]},
    {"key": "occ:avionics", "mass": 0.5, "centroidWorld": [0.0, 0.0, 0.35]},
]


def _body_face() -> FaceGeometry:
    rho = (R * R + L_NOSE * L_NOSE) / (2 * R)
    z_nose = np.linspace(0, L_NOSE, 200)
    r_nose = np.sqrt(rho * rho - (L_NOSE - z_nose) ** 2) - (rho - R)
    r_nose[0] = 0.0
    z_tube = np.linspace(L_NOSE, L_NOSE + L_TUBE, 60)[1:]
    z = np.concatenate([z_nose, z_tube])
    r = np.concatenate([r_nose, np.full_like(z_tube, R)])
    return _sor_face("occ:body", "F_outer", surface_of_revolution(z, r, segments=96), R)


def _half_thickness(f: np.ndarray, section: str) -> np.ndarray:
    if section == "airfoil":  # NACA 00xx, scaled so its maximum is THICK/2
        t = 5 * (0.2969 * np.sqrt(f) - 0.1260 * f - 0.3516 * f**2 + 0.2843 * f**3 - 0.1015 * f**4)
        return t / t.max() * THICK / 2
    return np.full_like(f, THICK / 2)


def _fin_side(phi_deg: float, side: int, section: str) -> FaceGeometry:
    """One side of one fin, tessellated over a grid so an airfoil has interior vertices."""
    phi = np.radians(phi_deg)
    radial = np.array([np.cos(phi), np.sin(phi), 0.0])
    normal = np.array([-np.sin(phi), np.cos(phi), 0.0])
    z = np.array([0.0, 0.0, 1.0])
    ys = np.linspace(0.0, SPAN, 15)
    fr = np.linspace(0.0, 1.0, 41)
    grid = np.empty((len(ys), len(fr), 3))
    for iy, y in enumerate(ys):
        lead = FIN_LE + SWEEP * y / SPAN
        chord = ROOT + (TIP - ROOT) * y / SPAN
        w = side * _half_thickness(fr, section)
        for jf, f in enumerate(fr):
            grid[iy, jf] = (lead + f * chord) * z + (R + y) * radial + w[jf] * normal
    tris = []
    for iy in range(len(ys) - 1):
        for jf in range(len(fr) - 1):
            a, b, c, d = grid[iy, jf], grid[iy, jf + 1], grid[iy + 1, jf], grid[iy + 1, jf + 1]
            tris += [[a, b, c], [b, d, c]]
    return FaceGeometry(
        occurrence_key=f"occ:fin{phi_deg:.0f}",
        part_id="fin",
        face_id=f"F{phi_deg:.0f}{'+' if side > 0 else '-'}",
        triangles=np.asarray(tris),
        surface_type="PLANE" if section == "square" else "SPLINE",
        axis_origin=None,
        axis_dir=None,
        radius=None,
    )


def rocket(section: str = "square") -> StubStore:
    fins = [_fin_side(phi, side, section) for phi in (0, 120, 240) for side in (1, -1)]
    return StubStore([_body_face(), *fins])


def _export(store, **kw):
    faces = detect_outer_surface(store).faces
    return export_from_cad(store, PARTS, faces, name="Synthetic", source="test", **kw)


def _masses(root: ET.Element) -> list[tuple[str, float, float]]:
    """(name, mass, axial CG from the nose) of every mass component in the file.

    Airframe sections stack nose to tail, and a mass component's CG is the middle of
    its length (``MassObject.getComponentCG``) -- the same reading OpenRocket does.
    """
    out, x0 = [], 0.0
    for seg in root.find("rocket/subcomponents/stage/subcomponents"):
        for mc in seg.findall("subcomponents/masscomponent"):
            top = x0 + float(mc.findtext("axialoffset"))
            out.append((mc.findtext("name"), float(mc.findtext("mass")),
                        top + float(mc.findtext("packedlength")) / 2))
        x0 += float(seg.findtext("length"))
    return out


def _mass_cg(root: ET.Element) -> tuple[float, float]:
    ms = _masses(root)
    total = sum(m for _, m, _ in ms)
    return total, sum(m * x for _, m, x in ms) / total


def _rocket_xml(data: bytes) -> ET.Element:
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        assert zf.namelist() == ["rocket.ork"]
        return ET.fromstring(zf.read("rocket.ork"))


# -- airframe ----------------------------------------------------------------


def test_profile_simplification_keeps_the_shape_within_tolerance():
    store = rocket()
    core = aero_core(store, detect_outer_surface(store).faces)
    p = core.profile
    segs = airframe_segments(p.s_grid, p.r_grid, p.x_fore, tol=1e-4)
    x = p.s_grid - p.x_fore
    for xi, ri in zip(x, p.r_grid):
        seg = next(s for s in segs if s.x0 <= xi <= s.x1 + 1e-12)
        assert abs(seg.radius_at(xi) - ri) <= 2e-4
    # Contiguous from tip to base, and the straight tube is one bodytube.
    assert segs[0].x0 == 0.0
    assert abs(segs[-1].x1 - (p.x_aft - p.x_fore)) < 1e-12
    assert all(a.x1 == b.x0 for a, b in zip(segs, segs[1:]))
    assert sum(s.is_tube and s.length > 0.5 for s in segs) == 1
    assert len(segs) < 40


# -- fins --------------------------------------------------------------------


def test_fin_outline_reproduces_the_strips_openrocket_integrates():
    store = rocket()
    core = aero_core(store, detect_outer_surface(store).faces)
    pts = fin_points(core)
    assert pts[0] == (0.0, 0.0) and pts[-1][1] == 0.0
    lead, trail = _strips(pts, core.fin_pf.span)
    x0 = core.fin_pf.chord_lead[0]
    assert np.max(np.abs(lead - (core.fin_pf.chord_lead - x0))) < 2e-6
    assert np.max(np.abs(trail - (core.fin_pf.chord_trail - x0))) < 2e-6


def test_fin_outline_has_no_collinear_runs():
    """OpenRocket throws away an outline with collinear neighbours (see fin_points).

    Every interior point of each edge must bend the edge by more than the drop
    tolerance, and a mostly-straight edge must collapse to a handful of points.
    """
    from backend.onshape.aero.ork_export import FIN_POINT_TOLERANCE

    store = rocket()
    core = aero_core(store, detect_outer_surface(store).faces)
    pts = fin_points(core)
    tip = max(range(len(pts)), key=lambda i: pts[i][1])
    for edge in (pts[: tip + 1], pts[tip + 1 :][::-1]):
        for (x0, y0), (x1, y1), (x2, y2) in zip(edge, edge[1:], edge[2:]):
            on_line = x0 + (x2 - x0) * (y1 - y0) / (y2 - y0)
            assert abs(x1 - on_line) > FIN_POINT_TOLERANCE / 2
    assert len(pts) < DIVISIONS


@pytest.mark.parametrize("section", ["square", "airfoil"])
def test_fin_section_thickness_and_shape(section):
    store = rocket(section)
    core = aero_core(store, detect_outer_surface(store).faces)
    fins = [f for f in store.iter_faces() if f.occurrence_key.startswith("occ:fin")]
    got = extract_fin_section([f for f in fins if is_fin_face(f, core.axis)], core.axis, core.fin_pf)
    assert got is not None
    assert got.shape == section
    assert got.thickness == pytest.approx(THICK, rel=0.02)


def test_one_sided_fin_has_no_section():
    store = rocket()
    core = aero_core(store, detect_outer_surface(store).faces)
    one_side = [f for f in store.iter_faces() if f.face_id.endswith("+")]
    assert extract_fin_section(one_side, core.axis, core.fin_pf) is None


# -- the whole file ----------------------------------------------------------


def test_exported_cp_and_cg_match_the_app():
    store = rocket()
    faces = detect_outer_surface(store).faces
    app = compute_stability(store, PARTS, faces)
    data, plan = _export(store)

    assert plan.cp_app == pytest.approx(app.cp_from_nose, abs=1e-12)
    # What the simplified airframe costs, measured: well under a millimetre.
    assert abs(plan.cp_ork - app.cp_from_nose) < 5e-4
    assert plan.structure_cg == pytest.approx(app.cg_from_nose, abs=1e-12)
    assert plan.structure_mass == pytest.approx(app.mass)
    # Nothing but the inertia note (these parts carry no recorded tensor).
    assert [w for w in plan.warnings if "Rebuild the model" not in w] == []

    root = _rocket_xml(data)
    stage = root.find("rocket/subcomponents/stage")
    # No lumped override: the parts carry the mass, each at its own centroid...
    assert stage.find("overridemass") is None
    assert sorted(n for n, _, _ in _masses(root)) == ["occ:avionics", "occ:body"]
    mass, cg = _mass_cg(root)
    assert mass == pytest.approx(app.mass, rel=1e-12)
    assert cg == pytest.approx(app.cg_from_nose, abs=1e-12)
    # ...and every other component is a shape with its mass overridden to zero.
    shapes = [c for c in stage.iter() if c.find("material") is not None or c.tag == "parachute"]
    assert shapes and all(c.findtext("overridemass") == "0.0" for c in shapes)
    assert all(c.findtext("overridesubcomponentsmass") == "false" for c in shapes)

    finset = stage.find(".//freeformfinset")
    assert finset.findtext("fincount") == "3"
    assert finset.findtext("crosssection") == "square"
    assert float(finset.findtext("thickness")) == pytest.approx(THICK, rel=0.02)
    pts = [(float(p.get("x")), float(p.get("y"))) for p in finset.find("finpoints")]
    assert pts == pytest.approx(fin_points(aero_core(store, faces)))


def test_motor_is_mounted_at_its_placed_aft_end():
    from backend.motors.motor import Motor
    from backend.onshape.aero.stability import MotorPlacement

    motor = Motor(
        manufacturer="AeroTech",
        designation="J350W",
        diameter=0.038,
        length=0.337,
        delays=[],
        motor_type="RELOAD",
        time=[0.0, 1.0, 2.0],
        thrust=[0.0, 350.0, 0.0],
        cg_x=[0.17, 0.17, 0.17],
        mass=[0.665, 0.5, 0.38],
        digest="1f46c34b33e99cd357a9b9134cebc9b0",
    )
    placement = MotorPlacement(
        mass=motor.launch_mass, length=motor.length, cmx=motor.launch_cgx,
        diameter=motor.diameter, aft_offset=-0.01,
    )
    store = rocket()
    faces = detect_outer_surface(store).faces
    app = compute_stability(store, PARTS, faces, motor=placement)
    data, plan = _export(store, motor_placement=placement, motor_record=motor)

    # The mass components are the structure alone; OpenRocket adds the motor.
    assert plan.structure_mass == pytest.approx(app.mass - motor.launch_mass)
    assert plan.launch_cg == pytest.approx(app.cg_from_nose, abs=1e-12)

    root = _rocket_xml(data)
    mount = root.find(".//innertube")
    m = mount.find("motormount/motor")
    assert m.findtext("designation") == "J350W"
    assert m.findtext("digest") == motor.digest
    assert m.findtext("type") == "reload"
    assert m.findtext("delay") == "none"  # plugged: the parachutes deploy themselves
    assert m.get("configid") == root.find("rocket/motorconfiguration").get("configid")
    # Aft end of the mount = aft end of the placed motor (overhang 0).
    segs = plan.segments
    parent = next(i for i, t in enumerate(root.find("rocket/subcomponents/stage/subcomponents"))
                  if t.find("subcomponents/innertube") is not None)
    fore = segs[parent].x0 + float(mount.findtext("axialoffset"))
    assert fore + motor.length == pytest.approx(app.body_length + (-0.01), abs=1e-9)


def test_part_sizes_come_from_their_geometry():
    store = rocket()
    _, plan = _export(store)
    body = next(p for p in plan.parts if p.name == "occ:body")
    assert body.length == pytest.approx(L_NOSE + L_TUBE, rel=1e-9)
    assert body.radius == pytest.approx(R, rel=1e-3)
    # A typed-in mass with no geometry still gets a (small) size, for its inertia.
    avionics = next(p for p in plan.parts if p.name == "occ:avionics")
    assert avionics.length == avionics.radius == 0.01


# A thin tube the length of the airframe, and an off-axis avionics box, each with
# the tensor Onshape would give (per kg, about the centroid, axis along +z).
TUBE_L = L_NOSE + L_TUBE
PARTS_WITH_INERTIA = [
    {"key": "occ:body", "mass": 1.5, "centroidWorld": [0.0, 0.0, 0.62],
     "inertiaPerKgWorld": np.diag([R * R / 2 + TUBE_L**2 / 12] * 2 + [R * R]).reshape(-1).tolist()},
    {"key": "occ:avionics", "mass": 0.5, "centroidWorld": [0.02, -0.01, 0.35],
     "inertiaPerKgWorld": np.diag([4e-4, 2e-4, 1e-4]).reshape(-1).tolist()},
]


def test_a_thin_tube_becomes_a_cylinder_with_its_exact_inertia():
    from backend.onshape.aero.ork_export import cylinder_for_inertia

    r, length = 0.05, 0.6
    got_l, got_r = cylinder_for_inertia(r * r, r * r / 2 + length**2 / 12)
    assert got_r == pytest.approx(math.sqrt(2) * r)
    assert got_l == pytest.approx(length)


def test_parts_carry_their_own_inertia_and_position():
    from backend.onshape.aero.ork_export import part_masses

    store = rocket()
    core = aero_core(store, detect_outer_surface(store).faces)
    parts = {p.name: p for p in part_masses(store, core.axis, core.profile.x_fore, PARTS_WITH_INERTIA)}
    for spec in PARTS_WITH_INERTIA:
        p = parts[spec["key"]]
        tensor = np.asarray(spec["inertiaPerKgWorld"]).reshape(3, 3)
        assert p.exact
        assert p.rotational_unit_inertia == pytest.approx(tensor[2, 2])
        assert p.longitudinal_unit_inertia == pytest.approx((tensor[0, 0] + tensor[1, 1]) / 2)
    # Off the axis where the part is, so its m r^2 reaches OpenRocket's sums.
    box = parts["occ:avionics"]
    assert box.radial_position == pytest.approx(math.hypot(0.02, -0.01))
    assert parts["occ:body"].radial_position == pytest.approx(0.0, abs=1e-9)


def test_inertia_follows_a_typed_in_mass():
    from backend.onshape.aero.ork_export import part_masses

    store = rocket()
    core = aero_core(store, detect_outer_surface(store).faces)
    a = {p.name: p for p in part_masses(store, core.axis, core.profile.x_fore, PARTS_WITH_INERTIA)}
    b = {p.name: p for p in part_masses(store, core.axis, core.profile.x_fore, PARTS_WITH_INERTIA,
                                        overrides={"occ:avionics": 1.0})}
    # Per-kg geometry is the part's; only the mass scales.
    assert b["occ:avionics"].mass == 1.0
    assert (b["occ:avionics"].length, b["occ:avionics"].radius) == (a["occ:avionics"].length, a["occ:avionics"].radius)


def test_a_model_without_recorded_inertia_says_it_is_approximate():
    _, plan = _export(rocket())  # PARTS has no inertiaPerKgWorld
    assert not any(p.exact for p in plan.parts)
    assert any("Rebuild the model" in w for w in plan.warnings)


def test_massless_model_is_refused():
    store = rocket()
    faces = detect_outer_surface(store).faces
    with pytest.raises(ValueError, match="no mass"):
        export_from_cad(store, [], faces)


def test_export_endpoint_serves_a_zip(monkeypatch, tmp_path):
    from test_stability_api import _write_model

    _write_model(tmp_path / "m1", parts=PARTS)
    monkeypatch.setattr(main, "CACHE_ROOT", tmp_path)
    resp = TestClient(main.app).post("/api/models/m1/export.ork", json={"finFaces": []})
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-disposition"] == 'attachment; filename="m1.ork"'
    root = _rocket_xml(resp.content)
    assert root.find(".//freeformfinset") is None
    assert _mass_cg(root)[0] == pytest.approx(2.0)


def test_export_endpoint_422_without_mass(monkeypatch, tmp_path):
    from test_stability_api import _write_model

    _write_model(tmp_path / "m1", parts=[])
    monkeypatch.setattr(main, "CACHE_ROOT", tmp_path)
    resp = TestClient(main.app).post("/api/models/m1/export.ork", json={})
    assert resp.status_code == 422
    assert "no mass" in resp.json()["detail"]



# -- recovery and launch conditions -------------------------------------------

DEVICES = [
    Device(name="Drogue", CdS=0.15, D0=0.6, m_c=0.1, trigger={"kind": "TIME", "value": 1.0}, delay=0.5),
    Device(name="Main", CdS=2.0, D0=1.8, m_c=0.4, trigger={"kind": "ALTITUDE", "value": 300.0}, delay=0.3),
]
PROFILE = ProfileWind(heights_msl=[630.0, 1500.0, 3000.0], u=[3.0, 6.0, -2.0], v=[0.0, 4.0, 8.0])


def _conditions(root):
    return root.find("simulations/simulation/conditions")


def test_parachutes_carry_the_drag_area_and_deployment():
    data, _ = _export(rocket(), launch=LaunchConditions(devices=DEVICES))
    chutes = {c.findtext("name"): c for c in _rocket_xml(data).iter("parachute")}
    for dev in DEVICES:
        c = chutes[dev.name]
        d0 = float(c.findtext("diameter"))
        assert d0 == dev.D0
        assert float(c.findtext("cd")) * math.pi * d0 * d0 / 4 == pytest.approx(dev.CdS, rel=1e-12)
    # TIME counts from apogee: an apogee event delayed by trigger + charge-to-line-stretch.
    assert chutes["Drogue"].findtext("deployevent") == "apogee"
    assert float(chutes["Drogue"].findtext("deploydelay")) == pytest.approx(1.5)
    assert chutes["Main"].findtext("deployevent") == "altitude"
    assert float(chutes["Main"].findtext("deployaltitude")) == 300.0
    assert float(chutes["Main"].findtext("deploydelay")) == pytest.approx(0.3)


def test_parachutes_do_not_move_the_cg():
    """They carry no mass, so the CG stays the app's."""
    _, bare = _export(rocket())
    data, plan = _export(rocket(), launch=LaunchConditions(devices=DEVICES))
    assert plan.structure_cg == bare.structure_cg
    assert _mass_cg(_rocket_xml(data))[1] == pytest.approx(bare.structure_cg, abs=1e-12)


def test_profile_wind_is_written_level_for_level():
    data, _ = _export(rocket(), launch=LaunchConditions(wind=PROFILE))
    cond = _conditions(_rocket_xml(data))
    assert cond.findtext("windmodeltype") == "MultiLevel"
    multi = next(w for w in cond.findall("wind") if w.get("model") == "multilevel")
    assert multi.get("altituderef") == "msl"
    levels = multi.findall("windlevel")
    assert [float(lv.get("altitude")) for lv in levels] == PROFILE.heights_msl
    for lv, u, v in zip(levels, PROFILE.u, PROFILE.v):
        speed, frm = float(lv.get("speed")), float(lv.get("direction"))
        # Direction is where it blows FROM: the air moves the opposite way.
        assert -speed * math.sin(frm) == pytest.approx(u, abs=1e-12)
        assert -speed * math.cos(frm) == pytest.approx(v, abs=1e-12)


def test_profile_wind_average_is_the_altitude_weighted_vector_mean():
    data, _ = _export(rocket(), launch=LaunchConditions(wind=PROFILE))
    avg = next(w for w in _conditions(_rocket_xml(data)).findall("wind") if w.get("model") == "average")
    speed, frm = float(avg.findtext("speed")), float(avg.findtext("direction"))
    # Trapezoids over 630-1500-3000 m.
    u = (870 * (3 + 6) / 2 + 1500 * (6 - 2) / 2) / 2370
    v = (870 * (0 + 4) / 2 + 1500 * (4 + 8) / 2) / 2370
    assert -speed * math.sin(frm) == pytest.approx(u)
    assert -speed * math.cos(frm) == pytest.approx(v)


def test_constant_wind_is_the_average_model():
    wind = ConstantWind(speed=7.0, direction=270.0)  # a westerly
    data, _ = _export(rocket(), launch=LaunchConditions(wind=wind))
    cond = _conditions(_rocket_xml(data))
    assert cond.findtext("windmodeltype") == "Average"
    assert [w.get("model") for w in cond.findall("wind")] == ["average"]
    assert float(cond.findtext("windaverage")) == 7.0
    assert float(cond.findtext("winddirection")) == pytest.approx(math.radians(270.0))


def test_site_and_rail():
    launch = LaunchConditions(site=Site(T_pad=305.0, p_pad=93000.0), rail_length=5.18,
                              inclination=85.0, heading=30.0)
    data, _ = _export(rocket(), launch=launch)
    cond = _conditions(_rocket_xml(data))
    atm = cond.find("atmosphere")
    assert atm.get("model") == "extendedisa"
    assert float(atm.findtext("basetemperature")) == 305.0
    assert float(atm.findtext("basepressure")) == 93000.0
    assert float(cond.findtext("launchrodlength")) == 5.18
    assert float(cond.findtext("launchrodangle")) == pytest.approx(5.0)  # from vertical
    assert float(cond.findtext("launchroddirection")) == 30.0
    assert float(cond.findtext("launchaltitude")) == 630.0


def test_standard_site_is_isa_and_a_temperature_alone_fills_in_pressure():
    from physics.atmosphere import Atmosphere

    data, _ = _export(rocket(), launch=LaunchConditions())
    assert _conditions(_rocket_xml(data)).find("atmosphere").get("model") == "isa"
    data, _ = _export(rocket(), launch=LaunchConditions(site=Site(T_pad=310.0)))
    atm = _conditions(_rocket_xml(data)).find("atmosphere")
    assert float(atm.findtext("basepressure")) == pytest.approx(Atmosphere(630.0).p_pad)


def test_measured_lapse_is_reported_not_dropped_silently():
    data, plan = _export(rocket(), launch=LaunchConditions(site=Site(T_pad=305.0, lapse=-0.008)))
    assert any("lapse" in w for w in plan.warnings)
    assert "lapse" in _rocket_xml(data).findtext("rocket/comment")


def test_no_launch_conditions_writes_no_simulation():
    data, _ = _export(rocket())
    assert _rocket_xml(data).find("simulations") is None


def test_export_endpoint_takes_devices_site_and_wind(monkeypatch, tmp_path):
    from test_stability_api import _write_model

    _write_model(tmp_path / "m1", parts=PARTS)
    monkeypatch.setattr(main, "CACHE_ROOT", tmp_path)
    body = {
        "finFaces": [],
        "railLength": 5.0,
        "inclination": 88.0,
        "heading": 10.0,
        "site": {"T_pad": 300.0},
        "wind": {"kind": "constant", "speed": 4.0, "direction": 180.0},
        "devices": [d.model_dump(mode="json") for d in DEVICES],
    }
    resp = TestClient(main.app).post("/api/models/m1/export.ork", json=body)
    assert resp.status_code == 200, resp.text
    root = _rocket_xml(resp.content)
    assert [c.findtext("name") for c in root.iter("parachute")] == ["Drogue", "Main"]
    assert float(_conditions(root).findtext("launchrodangle")) == pytest.approx(2.0)
