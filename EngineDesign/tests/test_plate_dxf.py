"""The injector plate read from its revolve sketch (engine/core/injectors/plate_dxf.py).

The synthetic plate is built from a chosen answer -- exits, passage lengths, facets normal to
the passages, a flat-bottomed groove -- and the reader must recover that answer from the lines
alone. The shipped drawing is checked against numbers worked by hand from its coordinates.
"""
import math

import pytest

ezdxf = pytest.importorskip("ezdxf")

IN = 0.0254
DRAWING = "configs/cad/ethalox_6500N_injector_revolve_2026-09-28.dxf"


def _s(a):
    return math.sin(math.radians(a))


def _c(a):
    return math.cos(math.radians(a))


# The answer, inches: face at y = 0, back at y = T.
T, R = 0.75, 3.0
TH_O, TH_F = 35.0, 48.0
E_O_R, F_O = 1.30, 0.05                       # LOX exit radius, half-flank
E_D = F_O * _s(TH_O)                          # exits at mid-flank, flank starts on the face
F_F = F_O * _s(TH_O) / _s(TH_F)               # fuel half-flank: same groove depth
E_F_R = 1.72
L_O, L_F = 0.33, 0.36                         # passage lengths
G = 0.04                                      # half-facet


def _geometry():
    P_O = (E_O_R - L_O * _s(TH_O), E_D + L_O * _c(TH_O))      # LOX goes inward to its channel
    P_F = (E_F_R + L_F * _s(TH_F), E_D + L_F * _c(TH_F))      # fuel outward
    fo = [(P_O[0] - G * _c(TH_O), P_O[1] - G * _s(TH_O)), (P_O[0] + G * _c(TH_O), P_O[1] + G * _s(TH_O))]
    ff = [(P_F[0] - G * _c(TH_F), P_F[1] + G * _s(TH_F)), (P_F[0] + G * _c(TH_F), P_F[1] - G * _s(TH_F))]
    r1, r2 = fo[0][0] - 0.3, ff[1][0] + 0.3
    loop = [
        (0.0, 0.0),
        (E_O_R - F_O * _c(TH_O), 0.0), (E_O_R + F_O * _c(TH_O), 2 * E_D),        # LOX flank
        (E_F_R - F_F * _c(TH_F), 2 * E_D), (E_F_R + F_F * _c(TH_F), 0.0),        # fuel flank
        (R, 0.0), (R, T),
        (r2, T), (r2, ff[1][1]), ff[1], ff[0], (ff[0][0], T),                   # fuel channel
        (fo[1][0], T), fo[1], fo[0], (r1, fo[0][1]), (r1, T),                   # LOX channel
        (0.0, T),
    ]
    return loop, P_O, P_F, fo, ff, r1, r2


def _write(path, loop):
    doc = ezdxf.new()
    doc.header["$INSUNITS"] = 1
    msp = doc.modelspace()
    for a, b in zip(loop, loop[1:] + loop[:1]):
        msp.add_line(a, b)
    doc.saveas(path)


@pytest.fixture
def synthetic(tmp_path):
    loop, *rest = _geometry()
    p = tmp_path / "plate.dxf"
    _write(str(p), loop)
    return str(p), rest


def test_the_plate_and_its_channels_come_back_from_the_lines(synthetic):
    from engine.core.injectors.plate_dxf import read_plate_profile
    path, (P_O, P_F, fo, ff, r1, r2) = synthetic
    prof = read_plate_profile(path)
    assert prof["thickness"] == pytest.approx(T * IN, rel=1e-9)
    assert prof["plate_radius"] == pytest.approx(R * IN, rel=1e-9)
    assert not prof["axis_hole"]
    lox, fuel = prof["channels"]
    # Area between the back face and the floor: flat floor, then the facet (trapezoid).
    a_lox = (fo[0][0] - r1) * (T - fo[0][1]) + (fo[1][0] - fo[0][0]) * (T - P_O[1])
    a_fuel = (r2 - ff[1][0]) * (T - ff[1][1]) + (ff[1][0] - ff[0][0]) * (T - P_F[1])
    assert lox["flow_area"] == pytest.approx(a_lox * IN ** 2, rel=1e-9)
    assert fuel["flow_area"] == pytest.approx(a_fuel * IN ** 2, rel=1e-9)
    assert lox["depth"] == pytest.approx((T - fo[0][1]) * IN, rel=1e-9)
    assert lox["ligament_min"] == pytest.approx(fo[0][1] * IN, rel=1e-9)
    assert prof["face_groove"]["depth"] == pytest.approx(2 * E_D * IN, rel=1e-9)


def test_passages_run_from_facet_to_flank_at_the_jet_angle(synthetic):
    from engine.core.injectors.plate_dxf import drilled_passages, read_plate_profile
    path, _ = synthetic
    h = drilled_passages(read_plate_profile(path), {"O": TH_O, "F": TH_F})
    assert h["O"]["exit_r"] == pytest.approx(E_O_R * IN, rel=1e-9)
    assert h["F"]["exit_r"] == pytest.approx(E_F_R * IN, rel=1e-9)
    assert h["O"]["exit_depth"] == pytest.approx(E_D * IN, rel=1e-9)
    assert h["O"]["length"] == pytest.approx(L_O * IN, rel=1e-9)
    assert h["F"]["length"] == pytest.approx(L_F * IN, rel=1e-9)
    assert h["O"]["entry_off_square_deg"] == pytest.approx(0.0, abs=1e-6)
    # Mid-flank: equal slant to each flank edge.
    a, b = h["F"]["flank_slant"]
    assert a == pytest.approx(b, rel=1e-9) and a == pytest.approx(F_F * IN, rel=1e-9)


def test_a_jet_angle_the_drawing_does_not_carry_locates_nothing(synthetic):
    from engine.core.injectors.plate_dxf import drilled_passages, read_plate_profile
    path, _ = synthetic
    assert drilled_passages(read_plate_profile(path), {"O": 30.0}) == {}


def test_section_thickness_is_the_metal_on_the_axial_line(synthetic):
    from engine.core.injectors.plate_dxf import read_plate_profile, section_thickness
    path, (P_O, P_F, fo, ff, r1, r2) = synthetic
    prof = read_plate_profile(path)
    r_floor = 0.5 * (r1 + fo[0][0])
    assert section_thickness(prof, r_floor * IN) == pytest.approx(fo[0][1] * IN, rel=1e-9)
    r_groove = 0.5 * (E_O_R + E_F_R)
    assert section_thickness(prof, r_groove * IN) == pytest.approx((T - 2 * E_D) * IN, rel=1e-9)
    assert section_thickness(prof, 0.2 * IN) == pytest.approx(T * IN, rel=1e-9)


def test_an_open_profile_is_refused(tmp_path):
    from engine.core.injectors.plate_dxf import read_plate_profile
    loop, *_ = _geometry()
    doc = ezdxf.new()
    doc.header["$INSUNITS"] = 1
    for a, b in zip(loop, loop[1:]):               # the closing line left out
        doc.modelspace().add_line(a, b)
    p = tmp_path / "open.dxf"
    doc.saveas(str(p))
    with pytest.raises(ValueError, match="close"):
        read_plate_profile(str(p))


def test_the_shipped_drawing_against_hand_numbers():
    """By hand from the sketch's coordinates (inches). LOX channel: 0.300 wide floor 0.4868 deep,
    then a facet 0.0819 across rising 0.0573: 0.300 x 0.4868 + 0.0819 x (0.4868 - 0.0573/2)
    = 0.18357 in^2. LOX exit at the flank midpoint, r = (1.209 + 1.291)/2 = 1.250 in; the passage
    to the facet midpoint (1.06575, 0.29185) from (1.250, 0.0287) is 0.3213 in = 8.16 mm."""
    from engine.core.injectors.plate_dxf import drilled_passages, load_plate_profile
    prof = load_plate_profile(DRAWING)
    assert prof["thickness"] == pytest.approx(0.75 * IN, rel=1e-6)
    lox, fuel = prof["channels"]
    assert lox["flow_area"] == pytest.approx(0.18357 * IN ** 2, rel=2e-3)
    assert lox["r_lo"] == pytest.approx(0.7248 * IN, rel=1e-4)
    assert fuel["r_hi"] == pytest.approx(2.2322 * IN, rel=1e-4)
    h = drilled_passages(prof, {"O": 35.0, "F": 48.0})
    assert h["O"]["exit_r"] == pytest.approx(1.250 * IN, rel=1e-4)
    assert h["O"]["length"] == pytest.approx(0.3213 * IN, rel=1e-3)
    assert h["O"]["channel"] == 0 and h["F"]["channel"] == 1


def _cfg():
    """The stand's config with its drawing as the geometry (the config itself only checks it)."""
    from engine.pipeline.io import load_config
    cfg = load_config("tests/fixtures/ethalox_6500N_doublet_cad_2026-09-28.yaml")
    cfg.injector.plate.profile_dxf_mode = "geometry"
    return cfg


def test_layout_takes_the_drawing_and_flags_what_the_config_contradicts():
    from engine.core.injectors.layout import layout_from_config
    cfg = _cfg()
    lay = layout_from_config(cfg, drawings=False)
    assert lay["drawing"]["thickness"] == pytest.approx(0.75 * IN, rel=1e-6)
    assert lay["passages"]["O"]["plate_l_over_d"] == pytest.approx(8.16e-3 / cfg.injector.geometry.oxidizer.d_jet, rel=2e-3)
    assert not [w for w in lay["warnings"] if w["code"].startswith("drawing_") and w["level"] == "bad"]
    # the igniter is the config's; the drawing has no centre port, and says so
    assert [w for w in lay["warnings"] if w["code"] == "drawing_igniter" and w["level"] == "warn"]
    # Move the LOX ring 0.5 mm: the drawing and the config now describe different plates.
    cfg.injector.geometry.oxidizer.spacing *= (31.75 + 0.5) / 31.75
    lay = layout_from_config(cfg, drawings=False)
    assert [w for w in lay["warnings"] if w["code"] == "drawing_ring_O" and w["level"] == "bad"]


def test_ring_manifold_uses_the_drawn_section():
    from engine.core.injectors.impinging import _ring_manifold_for
    cfg = _cfg()
    net = _ring_manifold_for(cfg, "oxidizer", 1140.0, 1.8e-4, 24, cfg.injector.geometry.oxidizer.d_jet)
    lox = __import__("engine.core.injectors.plate_dxf", fromlist=["x"]).load_plate_profile(DRAWING)["channels"][0]
    assert net.A_ch == pytest.approx(lox["flow_area"], rel=1e-12)
    assert net.D_h == pytest.approx(lox["hydraulic_diameter"], rel=1e-12)
    assert net.s == pytest.approx(2 * math.pi * lox["r_centroid"] / 24, rel=1e-12)   # hole pitch along the channel
