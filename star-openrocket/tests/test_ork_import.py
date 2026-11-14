""".ork import: OpenRocket's placement and mass rules, the model it writes, the API.

Expected numbers are worked by hand from the sample's dimensions (OpenRocket's
``AxialMethod`` rules, annulus / disc / trapezoid formulas), never read back from
the importer. ``test_ork_openrocket.py`` holds the same sample against OpenRocket.
"""

from __future__ import annotations

import io
import json
import math
import zipfile
from pathlib import Path

import numpy as np
import pytest

from backend.motors.db import MotorDB
from backend.onshape.aero.outer_surface import detect_outer_surface
from backend.onshape.aero.stability import compute_stability
from backend.onshape.geometry_store import GeometryStore
from backend.ork import shapes
from backend.ork.document import OrkError, parse_ork
from backend.ork.importer import common_name, import_ork, match_motor, model_id_for
from ork_samples import LOWER_L, NOSE_L, R, T, TAIL_L, UPPER_L, sample_ork_xml

DATA = sample_ork_xml().encode()


def annulus(r_out, r_in, length, rho):
    return math.pi * (r_out**2 - r_in**2) * length * rho


@pytest.fixture(scope="module")
def doc():
    return parse_ork(DATA)


def comp(doc, cid):
    return next(c for c in doc.components if c.id == cid)


# -- OpenRocket's shapes, against their closed forms ---------------------------------


@pytest.mark.parametrize(
    "shape,param,x,expected",
    [
        ("conical", 0.0, 0.25, 0.25),
        # Von Karman (Haack C=0) at mid-length: theta = pi/2 -> sqrt(1/2).
        ("haack", 0.0, 0.5, math.sqrt(0.5)),
        ("ellipsoid", 0.0, 0.5, math.sqrt(3) / 2),
        ("parabolic", 1.0, 0.5, 0.75),
        ("power", 0.5, 0.25, 0.5),
    ],
)
def test_nose_shapes_match_their_closed_forms(shape, param, x, expected):
    """Unit base radius, unit length."""
    assert float(shapes.SHAPES[shape](np.array(x), 1.0, 1.0, param)) == pytest.approx(expected, rel=1e-9)


def test_tangent_ogive_is_its_circle():
    """A tangent ogive is an arc of radius rho = (R^2 + L^2) / 2R, tangent at the base."""
    L, Rb = 1.0, 0.1
    rho = (Rb * Rb + L * L) / (2 * Rb)
    for x in (0.1, 0.4, 0.9):
        exact = math.sqrt(rho * rho - (L - x) ** 2) + Rb - rho
        assert float(shapes.ogive(np.array(x), Rb, L, 1.0)) == pytest.approx(exact, rel=1e-9)


def test_unclipped_transition_scales_the_radius_difference():
    """OpenRocket: r = r_small + shape(x, r_big - r_small). Not linear for an ogive."""
    x, r = shapes.profile("ogive", 1.0, 1.0, 0.03, 0.05, 11, clipped=False)
    expected = 0.03 + shapes.ogive(x, 0.02, 1.0, 1.0)
    assert np.allclose(r, expected)


# -- placement --------------------------------------------------------------------------


def test_airframe_stacks_nose_to_tail_and_resolves_bare_auto(doc):
    assert comp(doc, "nose").x == 0
    assert comp(doc, "upper").x == pytest.approx(NOSE_L)
    assert comp(doc, "lower").x == pytest.approx(NOSE_L + UPPER_L)
    assert comp(doc, "tail").x == pytest.approx(NOSE_L + UPPER_L + LOWER_L)
    assert doc.length == pytest.approx(NOSE_L + UPPER_L + LOWER_L + TAIL_L)
    # "Upper" is <radius>auto</radius> (from the nose) and the tail's fore radius too.
    assert float(comp(doc, "upper").shapes[0].r_out[0]) == pytest.approx(R)
    assert float(comp(doc, "tail").shapes[0].r_out[0]) == pytest.approx(R)


def test_every_axial_method(doc):
    upper, lower = NOSE_L, NOSE_L + UPPER_L
    assert comp(doc, "main").x == pytest.approx(upper + 0.1)  # top
    assert comp(doc, "cord").x == pytest.approx(upper + 0.1 + 0.12)  # after the chute
    assert comp(doc, "upperbulk").x == pytest.approx(upper + UPPER_L - 0.01)  # bottom
    assert comp(doc, "avionics").x == pytest.approx(lower + (LOWER_L - 0.1) / 2 - 0.2)  # middle
    assert comp(doc, "tracker").x == pytest.approx(1.5)  # absolute
    assert comp(doc, "ring2").x == pytest.approx(lower + LOWER_L - 0.006 - 0.05)  # bottom, negative
    assert comp(doc, "fins").x == pytest.approx(lower + LOWER_L - 0.2)


def test_auto_ring_radii_come_from_the_tube_and_the_motor_tube(doc):
    bulk = comp(doc, "upperbulk")
    assert float(bulk.shapes[0].r_out[0]) == pytest.approx(R - T)
    ring = comp(doc, "ring1")
    assert float(ring.shapes[0].r_out[0]) == pytest.approx(R - T)
    assert float(ring.shapes[0].r_in[0]) == pytest.approx(0.0275)


# -- mass and CG ------------------------------------------------------------------------


def test_masses_computed_from_materials(doc):
    lower = NOSE_L + UPPER_L
    assert comp(doc, "lower").mass == pytest.approx(annulus(R, R - T, LOWER_L, 1250), rel=1e-9)
    assert comp(doc, "lower").cg == pytest.approx(lower + LOWER_L / 2)
    assert comp(doc, "mmt").mass == pytest.approx(annulus(0.0275, 0.026, 0.4, 1250), rel=1e-9)
    assert comp(doc, "ring1").mass == pytest.approx(annulus(R - T, 0.0275, 0.006, 680), rel=1e-9)
    # Trapezoid fins: area x thickness x density x count; CG at the planform centroid.
    cr, ct, s, h = 0.2, 0.08, 0.12, 0.1
    fins = comp(doc, "fins")
    assert fins.mass == pytest.approx((cr + ct) / 2 * h * 0.004 * 680 * 3, rel=1e-9)
    x_bar = (cr * cr + cr * ct + ct * ct + s * (cr + 2 * ct)) / (3 * (cr + ct))
    assert fins.cg == pytest.approx(fins.x + x_bar, abs=1e-9)


def test_overrides(doc):
    assert comp(doc, "nose").mass == 0.8 and comp(doc, "nose").mass_overridden
    avionics = comp(doc, "avionics")
    assert avionics.mass == 0.5
    assert avionics.cg == pytest.approx(avionics.x + 0.02)  # overridecg, from its top


def test_subtree_override_keeps_the_subtree_cg(doc):
    """overridesubcomponentsmass: 2.0 kg is the tube *and* its contents, and the
    contents keep their own CG (each scaled by the same factor)."""
    upper = NOSE_L
    chute = math.pi * 1.2**2 / 4 * 0.067 + 8 * 1.0 * 0.0023
    raw = {
        "upper": (annulus(R, R - T, UPPER_L, 1250), upper + UPPER_L / 2),
        "main": (chute, upper + 0.1 + 0.06),
        "cord": (5.0 * 0.02, upper + 0.22 + 0.025),
        "upperbulk": (math.pi * (R - T) ** 2 * 0.01 * 680, upper + UPPER_L - 0.005),
    }
    total_raw = sum(m for m, _ in raw.values())
    cg_raw = sum(m * x for m, x in raw.values()) / total_raw
    members = [comp(doc, k) for k in raw]
    assert sum(c.mass for c in members) == pytest.approx(2.0, rel=1e-12)
    assert sum(c.mass * c.cg for c in members) / 2.0 == pytest.approx(cg_raw, abs=1e-9)
    for c in members:
        assert c.mass == pytest.approx(raw[c.id][0] * 2.0 / total_raw, rel=1e-9)


def test_motor_mount(doc):
    (motor,) = doc.motors
    assert motor.default and motor.designation == "1395I205-14A"
    assert motor.aft_x == pytest.approx(NOSE_L + UPPER_L + LOWER_L + 0.02)  # mount end + overhang
    assert motor.mount == "Motor tube"


# -- reading the file -----------------------------------------------------------------


def test_zipped_and_bare_xml_read_the_same():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("rocket.ork", DATA)
    a, b = parse_ork(DATA), parse_ork(buf.getvalue())
    assert a.mass == pytest.approx(b.mass) and a.cg == pytest.approx(b.cg)


@pytest.mark.parametrize("data", [b"", b"not xml", b"<openrocket/>", b"PK\x03\x04broken"])
def test_unreadable_files_are_refused(data):
    with pytest.raises(OrkError):
        parse_ork(data)


def test_unsupported_parts_are_reported_not_dropped_silently():
    xml = sample_ork_xml().replace(
        "<masscomponent>\n                <name>Tracker</name>",
        "<podset><name>Pods</name><id>pods</id></podset>\n              <masscomponent>\n                <name>Tracker</name>",
    )
    assert any("pods" in w.lower() for w in parse_ork(xml.encode()).warnings)


# -- the model it writes ----------------------------------------------------------------


@pytest.fixture(scope="module")
def imported(tmp_path_factory):
    root = tmp_path_factory.mktemp("cache")
    manifest = import_ork(DATA, "sample.ork", root)
    return root / manifest["source"]["modelId"], manifest


def test_model_id_is_the_files_hash(imported):
    model_dir, manifest = imported
    assert manifest["source"]["modelId"] == model_id_for(DATA) == model_dir.name
    assert manifest["source"]["kind"] == "ork"
    assert (model_dir / "source.ork").read_bytes() == DATA


def test_manifest_totals_are_the_documents(imported, doc):
    _, manifest = imported
    assert manifest["totals"]["mass"] == pytest.approx(doc.mass, rel=1e-12)
    assert manifest["totals"]["reconciled"] is True
    assert -manifest["totals"]["centroid"][2] == pytest.approx(doc.cg, abs=1e-12)
    # The nose's own override, and the Upper subtree's (the tube and everything in it,
    # scaled to it). The avionics has a <mass> -- a mass component's mass, not an override.
    overridden = {p["name"] for p in manifest["parts"] if p["massOverridden"]}
    assert overridden == {"Nose", "Upper", "Main", "Cord", "Upper bulkhead"}


def test_only_the_airframe_is_offered_as_skin(imported):
    """Internal parts (shoulders, bulkheads, the motor tube) are not aerodynamic in
    OpenRocket, and must not become the outer surface here either."""
    model_dir, manifest = imported
    names = {p["key"]: p["name"] for p in manifest["parts"]}
    store = GeometryStore.load(model_dir)
    skin = {names[k] for k, _ in detect_outer_surface(store).faces}
    assert skin == {"Nose", "Upper", "Lower", "Tail"}


def test_the_apps_stability_reads_the_imported_rocket(imported, doc):
    model_dir, manifest = imported
    store = GeometryStore.load(model_dir)
    r = compute_stability(store, manifest["parts"], detect_outer_surface(store).faces)
    assert r.mass == pytest.approx(doc.mass, rel=1e-12)
    assert r.cg_from_nose == pytest.approx(doc.cg, abs=1e-6)
    assert r.body_length == pytest.approx(NOSE_L + UPPER_L + LOWER_L + TAIL_L, abs=1e-6)
    assert r.ref_diameter == pytest.approx(2 * R, rel=1e-6)
    assert r.n_fins == 3
    assert r.fin_root_chord == pytest.approx(0.2, abs=1e-3)
    assert r.fin_tip_chord == pytest.approx(0.08, abs=1e-3)
    assert r.fin_sweep == pytest.approx(0.12, abs=2e-3)
    assert r.fin_span == pytest.approx(0.1, abs=1e-3)
    assert r.static_margin > 0


def test_meshes_are_closed_and_weigh_what_they_should(imported, doc):
    """Each drawn solid's volume x density is its computed mass: the mesh and the
    mass come from the same shape."""
    from backend.onshape.geometry import volume_and_centroid

    model_dir, manifest = imported
    lower = next(p for p in manifest["parts"] if p["name"] == "Lower")
    # 64-gon cross-section: area factor n/(2 pi) sin(2 pi/n).
    facet = 64 / (2 * math.pi) * math.sin(2 * math.pi / 64)
    assert lower["volume"] * 1250 == pytest.approx(comp(doc, "lower").mass * facet, rel=1e-9)
    store = GeometryStore.load(model_dir)
    assert store.occurrence_keys()


# -- motors -------------------------------------------------------------------------------


def test_common_name_from_openrocket_designations():
    assert common_name("17631N3800-P") == "N3800"
    assert common_name("O5500X-PS") == "O5500"
    assert common_name("1395I205-14A") == "I205"
    assert common_name("") is None


def _motor_db(tmp_path: Path, digest: str) -> MotorDB:
    (tmp_path / "data").mkdir(parents=True)
    meta = {"motorId": "m1", "manufacturer": "Cesaroni Technology", "manufacturerAbbrev": "CTI",
            "designation": "I205-14A", "commonName": "I205", "diameter": 54, "length": 404}
    (tmp_path / "index.json").write_text(json.dumps({"motors": [meta]}))
    sim = {"manufacturer": "CTI", "designation": "I205", "diameter": 0.054, "length": 0.404, "delays": [],
           "motor_type": "reload", "time": [0, 1], "thrust": [0, 0], "cg_x": [0.2, 0.2], "mass": [0.6, 0.3],
           "digest": digest, "quality": "basic", "file_format": "RASP", "comment": "", "common_name": "I205",
           "impulse_class": "I", "motor_id": "m1", "simfile_id": "s1"}
    (tmp_path / "data" / "m1.json").write_text(json.dumps({"motorId": "m1", "simfiles": [sim]}))
    return MotorDB(tmp_path)


def test_motor_matched_by_digest(tmp_path, doc):
    db = _motor_db(tmp_path, "0123456789abcdef0123456789abcdef")
    assert match_motor(doc.motors[0], db) == {"motorId": "m1", "simfileId": "s1", "matchedBy": "digest"}


def test_motor_matched_by_designation_when_the_digest_differs(tmp_path, doc):
    db = _motor_db(tmp_path, "something-else")
    assert match_motor(doc.motors[0], db) == {"motorId": "m1", "simfileId": None, "matchedBy": "designation"}


def test_imported_motor_placement_is_the_apps_aft_offset(tmp_path):
    db = _motor_db(tmp_path / "motors", "0123456789abcdef0123456789abcdef")
    manifest = import_ork(DATA, "sample.ork", tmp_path / "cache", db)
    (motor,) = manifest["ork"]["motors"]
    # Aft end 2.42 m from the tip, the airframe ends at 2.48 m: 60 mm inside.
    assert motor["aftOffset"] == pytest.approx(-0.06)
    assert motor["motorId"] == "m1" and motor["matchedBy"] == "digest"


# -- the API ------------------------------------------------------------------------------


@pytest.fixture
def api(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    import backend.main as main

    monkeypatch.setattr(main, "CACHE_ROOT", tmp_path)
    return TestClient(main.app)


def test_import_endpoint(api):
    r = api.post("/api/import/ork?filename=sample.ork", content=DATA)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["modelId"] == model_id_for(DATA)
    assert body["rocketName"] == "Sample"
    listed = {m["id"]: m for m in api.get("/api/models").json()}
    assert listed[body["modelId"]]["kind"] == "ork"
    # Importing the same file again is the same model.
    assert api.post("/api/import/ork", content=DATA).json()["modelId"] == body["modelId"]


def test_import_endpoint_refuses(api):
    assert api.post("/api/import/ork", content=b"").status_code == 400
    assert api.post("/api/import/ork", content=b"garbage").status_code == 422
    too_big = api.post("/api/import/ork", content=b"x", headers={"content-length": str(10**9)})
    assert too_big.status_code in (413, 400)


def test_compare_endpoint_against_itself_differs_nowhere(api):
    model_id = api.post("/api/import/ork", content=DATA).json()["modelId"]
    r = api.post("/api/compare", json={"a": {"modelId": model_id}, "b": {"modelId": model_id}})
    assert r.status_code == 200, r.text
    rows = {row["key"]: row for row in r.json()["rows"]}
    assert not any(row["differs"] for row in rows.values())
    assert rows["airframe.noseLength"]["a"] == pytest.approx(NOSE_L, abs=2e-3)
    assert rows["airframe.length"]["a"] == pytest.approx(NOSE_L + UPPER_L + LOWER_L + TAIL_L, abs=1e-6)


def test_compare_flags_a_real_difference(api, tmp_path):
    a = api.post("/api/import/ork", content=DATA).json()["modelId"]
    longer = sample_ork_xml().replace("<rootchord>0.2</rootchord>", "<rootchord>0.25</rootchord>").encode()
    b = api.post("/api/import/ork", content=longer).json()["modelId"]
    rows = {row["key"]: row for row in api.post("/api/compare", json={"a": {"modelId": a}, "b": {"modelId": b}}).json()["rows"]}
    assert rows["fins.rootChord"]["differs"]
    assert rows["fins.rootChord"]["delta"] == pytest.approx(0.05, abs=2e-3)
    assert not rows["airframe.length"]["differs"]
