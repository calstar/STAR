"""The injector plug's half-section built from its parameters (layout.plate_profile): the drill-spot
channel, back-face grooves, the rim gland, the centre port and the cover plate's feed ports.

The acceptance test is the stand's own plate: built from the numbers in the config it must land
on the designer's revolve sketch (configs/cad/...dxf) to within a thou, everywhere.
"""
import copy
import json
import math
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
CFG = ROOT / "tests/fixtures/ethalox_6500N_doublet_cad_2026-09-28.yaml"
IN = 0.0254


def _cfg():
    return yaml.safe_load(CFG.read_text())


def _lay(cfg, drawings=False):
    from engine.core.injectors.layout import layout_from_config
    return layout_from_config(cfg, drawings=drawings)


def _codes(out):
    return {w["code"]: w["level"] for w in out["warnings"]}


# ---- the drill-spot channel ------------------------------------------------------------------

@pytest.mark.parametrize("inner", [True, False])
def test_spot_facet_is_square_to_the_passage_and_centred_on_its_end(inner):
    from engine.core.injectors.layout import channel_for_ring
    th, d, t, w, spot = (35.0 if inner else 48.0), 1.6e-3, 19.05e-3, 7.62e-3, 2.54e-3
    ch = channel_for_ring(r_exit=0.03, z_exit=-0.7e-3, d=d, theta_deg=th, is_inner=inner,
                          plate_thickness=t, passage_ld=5.0, width=w, floor="spot", spot_length=spot)
    near, far = ch["spot"]
    along = (far[0] - near[0], far[1] - near[1])
    k = -1.0 if inner else 1.0
    into = (k * math.sin(math.radians(th)), -math.cos(math.radians(th)))   # the passage, going in
    assert math.hypot(*along) == pytest.approx(spot, rel=1e-12)
    assert along[0] * into[0] + along[1] * into[1] == pytest.approx(0.0, abs=1e-15)
    assert 0.5 * (near[0] + far[0]) == pytest.approx(ch["end"][0], rel=1e-12)
    assert ch["length"] == pytest.approx(5.0 * d, rel=1e-12)
    # Flat floor w wide from the facet's face-side end, away from the exit side.
    floor = [p for p in ch["section"] if abs(p[1] - near[1]) < 1e-15]
    assert max(p[0] for p in floor) - min(p[0] for p in floor) == pytest.approx(w, rel=1e-12)
    # Area by hand: the floor's rectangle plus the trapezoid under the facet.
    a = w * (t + near[1]) + abs(far[0] - near[0]) * (t + 0.5 * (near[1] + far[1]))
    assert ch["flow_area"] == pytest.approx(a, rel=1e-12)
    assert ch["breakthrough"].startswith("square")


# ---- the stand's plate, against its drawing ---------------------------------------------------

def test_the_parameters_rebuild_the_designers_revolve_sketch():
    out = _lay(_cfg())
    assert out["drawing"]["mode"] == "check"
    assert out["drawing"]["deviation"]["max"] < 0.01e-3
    assert _codes(out)["drawing_profile"] == "info"
    for k in ("O", "F"):
        p = out["drawing"]["passages"][k]
        assert p["exit_offset"] < 0.005e-3 and abs(p["length_offset"]) < 0.005e-3


def test_a_parameter_off_the_drawing_is_caught_where_it_is():
    cfg = _cfg()
    cfg["injector"]["plate"]["channel_spot_length"] += 0.1e-3
    out = _lay(cfg)
    assert _codes(out)["drawing_profile"] == "bad"
    dev = out["drawing"]["deviation"]
    assert 0.02e-3 < dev["max"] < 0.2e-3
    # ... at a channel, not somewhere else on the plate
    r = dev["where_a"][0]
    chans = [out["passages"][k]["channel"] for k in ("O", "F")]
    assert any(c["r_lo"] - 1e-4 <= r <= c["r_hi"] + 1e-4 for c in chans)


def test_the_drawn_channels_feed_the_manifold_solve():
    from engine.pipeline.io import load_config
    from engine.core.injectors.impinging import _ring_manifold_for
    cfg = load_config(str(CFG))
    ch = _lay(cfg)["passages"]["O"]["channel"]
    net = _ring_manifold_for(cfg, "oxidizer", 1140.0, 1.8e-4, 24, cfg.injector.geometry.oxidizer.d_jet)
    assert ch["flow_area"] == pytest.approx(0.18357 * IN ** 2, rel=2e-3)     # by hand, see test_plate_dxf
    assert net.A_ch == ch["flow_area"] and net.D_h == ch["hydraulic_diameter"]


# ---- back-face features ------------------------------------------------------------------------

def test_a_groove_that_runs_into_a_channel_is_left_out_and_said():
    cfg = _cfg()
    lox = _lay(cfg)["passages"]["O"]["channel"]
    cfg["injector"]["plate"]["back_grooves"].append(
        {"r_inner": lox["r_hi"] - 1e-3, "r_outer": lox["r_hi"] + 2e-3, "depth": 1e-3})
    out = _lay(cfg)
    assert _codes(out)["back_groove"] == "bad"
    assert len(out["profile"]["grooves"]) == 6
    assert any("LOX channel" in m for m in out["profile"]["skipped"])


def test_the_centre_thread_cutting_a_groove_is_flagged():
    out = _lay(_cfg())
    assert _codes(out)["igniter_groove"] == "bad"          # 3/8 NPT OD 17.1 mm vs groove at r 7.65
    cfg = _cfg()
    cfg["injector"]["igniter"] = {"thread": "1/8 NPT"}      # OD 10.3 mm clears it
    assert "igniter_groove" not in _codes(_lay(cfg))


def test_a_port_bore_over_a_seal_groove_is_flagged_and_a_smaller_bore_clears_it():
    out = _lay(_cfg())
    assert _codes(out)["port_over_groove_O"] == "warn"
    ports = out["ports"]
    assert ports["per_ring"] == 2 and ports["rings"]["F"]["angles_deg"] == [90.0, 270.0]
    cfg = _cfg()
    cfg["injector"]["plate"]["port_bore"] = 0.0127
    assert "port_over_groove_O" not in _codes(_lay(cfg))


def test_bending_takes_the_section_as_built():
    """The grooves thin the section: 19.05 mm of plate, 19.05 - 1.956 mm under the outer groove
    (where the face is flat), and under groove 3 the face groove comes off too (1.458 mm)."""
    from engine.core.injectors.plate_dxf import loop_section
    out = _lay(_cfg())
    g3 = out["profile"]["grooves"][2]
    r3 = 0.5 * (g3["r_inner"] + g3["r_outer"])
    assert loop_section(out["profile"]["loop"], r3) == pytest.approx(0.673 * IN - 0.0574 * IN, rel=2e-3)
    g = out["profile"]["grooves"][4]
    r = 0.5 * (g["r_inner"] + g["r_outer"])
    assert loop_section(out["profile"]["loop"], r) == pytest.approx(0.75 * IN - 0.077 * IN, rel=1e-9)


def test_without_new_features_the_section_is_the_old_one():
    """Opt-in: a plate that declares no grooves, gland or ports has the section the bending
    check used before (face surface down to the channel floor)."""
    from engine.core.injectors.layout import face_z_at
    from engine.core.injectors.plate_dxf import loop_section
    cfg = yaml.safe_load((ROOT / "configs/ethalox_6500N.yaml").read_text())
    out = _lay(cfg)
    assert not out["profile"]["grooves"] and out["ports"] is None
    t = out["inputs"]["plate_thickness"]
    for k in ("O", "F"):
        ch = out["passages"][k]["channel"]
        for r in (ch["r_lo"] + 1e-4, ch["r_center"], ch["r_hi"] - 1e-4):
            old = face_z_at(out["face"]["profile"], r) - max(-t, ch["end"][1] + ch["floor_slope"] * (r - ch["r_center"]))
            assert loop_section(out["profile"]["loop"], r) == pytest.approx(min(t, old), rel=1e-9)


# ---- views --------------------------------------------------------------------------------------

def test_revolve_view_is_one_closed_profile_up_from_the_face():
    D = _lay(_cfg(), drawings=True)["drawings"]
    polys = [p for p in D["revolve"] if p["layer"] == "PLATE"]
    assert len(polys) == 1 and polys[0]["closed"]
    ys = [q[1] for q in polys[0]["pts"]]
    # As the designer's sketch: face at y = 0, the groove cut up into the plate, back at y = t.
    assert min(ys) == pytest.approx(0.0, abs=1e-12) and max(ys) == pytest.approx(0.75 * IN, rel=1e-6)
    face = [q for q in polys[0]["pts"] if 0 < q[1] < 0.1 * IN]
    assert max(q[1] for q in face) == pytest.approx(0.0574 * IN, rel=2e-3)


def test_port_view_has_every_port():
    D = _lay(_cfg(), drawings=True)["drawings"]
    ids = {p.get("id") for p in D["ports"] if p.get("id")}
    assert ids == {"PO0", "PO1", "PF0", "PF1"}


FIXTURE = ROOT / "frontend/src/components/__fixtures__/layout_doublet_6500N.json"


def test_frontend_doublet_fixture_is_current():
    """Regenerate: python3 scripts/injector_layout.py --no-flows tests/fixtures/ethalox_6500N_doublet_cad_2026-09-28.yaml > <fixture>"""
    want = json.loads(json.dumps(_lay(_cfg(), drawings=True)))
    got = json.loads(FIXTURE.read_text())
    assert got.keys() == want.keys()
    assert got["drawings"].keys() == want["drawings"].keys()
    flat = lambda L: [v for q in L for v in q]  # noqa: E731
    assert flat(got["profile"]["loop"]) == pytest.approx(flat(want["profile"]["loop"]), abs=1e-9)
    assert got["ports"] == want["ports"]


def test_the_flow_solves_geometry_is_the_full_layouts_without_the_checks():
    """The injector solve reads channel sections dozens of times per operating point; it takes the
    layout without the plate-bending check and drawing comparison (80 % of a solve before). The
    channels must be the same ones the full layout draws."""
    full = _lay(_cfg())
    from engine.core.injectors.layout import layout_from_config
    lean = layout_from_config(_cfg(), drawings=False, checks=False)
    assert "plate_bending" not in lean and "drawing" not in lean
    for k in ("O", "F"):
        a, b = full["passages"][k]["channel"], lean["passages"][k]["channel"]
        for f in ("flow_area", "hydraulic_diameter", "r_center", "r_lo", "r_hi"):
            assert b[f] == pytest.approx(a[f], rel=1e-12), (k, f)
    # geometry mode: the drawing's channels reach the lean path too
    cfg = _cfg()
    cfg["injector"]["plate"]["profile_dxf_mode"] = "geometry"
    assert layout_from_config(cfg, drawings=False, checks=False)["passages"]["O"]["channel"]["floor"] == "drawing"
