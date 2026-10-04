"""engine.core.injectors.layout -- the one place the injector's geometry is derived.

Reference engine: configs/ethalox_6500N.yaml (24 doublets, 43/46 deg, contoured face, channels
on the back, plug filling a 6.0 in sleeve bore). Every contoured-face and channel number below
is recomputed in the test from plain trigonometry, not read back from the module, so a wrong
formula in layout.py fails here rather than being agreed with.
"""

import json
import math
from pathlib import Path

import numpy as np
import pytest
import yaml

from engine.core.injectors.layout import (
    EXIT_LAND_DEFAULT, IMPINGEMENT_LD_TARGET_DEFAULT, compute_layout, impingement_ld_band,
    layout_from_config,
)

ROOT = Path(__file__).resolve().parents[1]
CASES = json.loads((ROOT / "tests/impingement_ld_band_cases.json").read_text())["cases"]
C6500 = ROOT / "configs/ethalox_6500N.yaml"
T = lambda a: math.tan(math.radians(a))  # noqa: E731
S = lambda a: math.sin(math.radians(a))  # noqa: E731
C = lambda a: math.cos(math.radians(a))  # noqa: E731


def _cfg(**plate):
    cfg = yaml.safe_load(C6500.read_text())
    cfg["injector"].setdefault("plate", {}).update(plate)
    return cfg


def _hole_ld(cfg, ld, **discharge):
    """Both propellants' hole L/d (discharge.<side>.orifice_l_over_d), and any other discharge keys."""
    for side in ("oxidizer", "fuel"):
        cfg["discharge"][side].update(orifice_l_over_d=ld, **discharge)
    return cfg


def _texts(out):
    return " | ".join(w["text"] for w in out["warnings"])


def _codes(out):
    return {w["code"]: w["level"] for w in out["warnings"]}


# =============================================================================================
# Standoff band
# =============================================================================================

@pytest.mark.parametrize("case", CASES, ids=[json.dumps(c["req"]) for c in CASES])
def test_band_table(case):
    assert tuple(impingement_ld_band(case["req"])) == pytest.approx(tuple(case["band"]))


def test_6500N_band_is_what_it_declares():
    req = yaml.safe_load(C6500.read_text())["design_requirements"]
    assert tuple(impingement_ld_band(req)) == pytest.approx((4.0, 3.0, 5.0))


def test_layer1_uses_the_resolver():
    src = (ROOT / "engine/optimizer/layers/layer1_static_optimization.py").read_text()
    assert "impingement_ld_band(" in src
    assert '"layer1_impingement_Ld_min", max(0.0' not in src


def test_ring_geometry_default_band_is_inert():
    from engine.optimizer.layers.layer1_static_optimization import _impinging_ring_geometry_squared
    kw = dict(n_elements=27, spacing_O_m=0.0081070, spacing_F_m=0.018, d_jet_O_m=0.0017094,
              d_jet_F_m=0.0015024, D_chamber_inner_m=0.25, angle_O_deg=40.0, angle_F_deg=50.0)
    assert _impinging_ring_geometry_squared(**kw) == 0.0
    assert _impinging_ring_geometry_squared(**kw, Ld_min=3.0, Ld_max=5.0) > 0.0


def test_default_constant_is_four():
    assert IMPINGEMENT_LD_TARGET_DEFAULT == 4.0


# =============================================================================================
# The envelope: the plug fills the sleeve bore, the liner fills the rest
# =============================================================================================

class TestEnvelope:
    out = layout_from_config(_cfg(), drawings=False)

    def test_sleeve_from_the_requirements(self):
        env = self.out["envelope"]
        # 6.5 in OD - 2 x 0.25 in wall = 6.0 in bore; 5.0 in gas bore + 2 x 0.5 in liner = 6.0 in
        assert env["r_sleeve_od"] == pytest.approx(0.5 * 0.1651)
        assert env["r_sleeve_id"] == pytest.approx(0.5 * 0.1524)
        assert env["r_bore"] + env["liner_thickness"] == pytest.approx(env["r_sleeve_id"])
        assert "liner_gap" not in _codes(self.out)

    def test_a_liner_that_does_not_fill_the_sleeve_is_called_out(self):
        cfg = _cfg()
        cfg["ablative_cooling"]["initial_thickness"] = 0.010
        assert "liner_gap" in _codes(layout_from_config(cfg, drawings=False))

    def test_the_plug_is_drawn_to_the_sleeve_bore(self):
        out = layout_from_config(_cfg())
        plate = [p for p in out["drawings"]["section_doublet"] if p["layer"] == "PLATE"][0]
        assert max(x for x, _ in plate["pts"]) == pytest.approx(0.0762, abs=1e-7)


# =============================================================================================
# Contoured face, against hand trigonometry
# =============================================================================================

def _hand_6500N(exit_land=EXIT_LAND_DEFAULT):
    g = yaml.safe_load(C6500.read_text())["injector"]["geometry"]
    O, F = g["oxidizer"], g["fuel"]
    n = O["n_elements"]
    rO, rF = n * O["spacing"] / (2 * math.pi), n * F["spacing"] / (2 * math.pi)
    dO, dF, tO, tF = O["d_jet"], F["d_jet"], O["impingement_angle"], F["impingement_angle"]
    dE = max((dO / 2 + exit_land) * S(tO), (dF / 2 + exit_land) * S(tF))
    L = (rF - rO) / (T(tO) + T(tF))
    return dict(rO=rO, rF=rF, dO=dO, dF=dF, tO=tO, tF=tF, n=n, dE=dE, L=L,
                r_imp=rO + L * T(tO), z_imp=L - dE, jO=L / C(tO), jF=L / C(tF),
                edge_in=rO - dE / T(tO), edge_out=rF + dE / T(tF))


class TestContouredFace:
    h = _hand_6500N()
    f = layout_from_config(_cfg(), drawings=False)["face"]

    def test_exits_share_one_recessed_plane(self):
        assert self.f["contoured"] is True
        assert self.f["z_exit"] == pytest.approx(-self.h["dE"], rel=1e-12)
        assert self.f["z_exit"] * 1000 == pytest.approx(-0.871, abs=1e-3)

    def test_the_jets_meet_where_trigonometry_says(self):
        assert self.f["l_imp"] == pytest.approx(self.h["L"], rel=1e-12)
        assert self.f["r_imp"] == pytest.approx(self.h["r_imp"], rel=1e-12)
        assert self.f["z_imp"] == pytest.approx(self.h["z_imp"], rel=1e-12)
        assert self.f["z_imp"] * 1000 == pytest.approx(5.022, abs=1e-3)   # in front of the face

    def test_free_jet_is_measured_along_the_jet(self):
        """SP-8089 measures impingement distance ALONG the jet: 5.2 d LOX, 6.0 d fuel -- not the
        3.97 axial figure the flat-face readout used to call the free-jet length."""
        assert self.f["free_jet_O"] == pytest.approx(self.h["jO"], rel=1e-12)
        assert self.f["free_jet_F"] == pytest.approx(self.h["jF"], rel=1e-12)
        assert self.f["free_jet_ld_O"] == pytest.approx(5.21, abs=0.01)
        assert self.f["free_jet_ld_F"] == pytest.approx(5.97, abs=0.01)
        assert self.f["l_over_d"] == pytest.approx(3.97, abs=0.01)

    def test_each_exit_is_square_on_its_flank(self):
        """The flank through each exit is normal to that jet: the inner flank descends outward at
        tan(th_O), the outer descends inward at tan(th_F). Check both profile segments."""
        prof = self.f["profile"]
        (r1, z1), (r2, z2) = prof[1], prof[2]            # inner flank
        assert (z2 - z1) / (r2 - r1) == pytest.approx(-T(self.h["tO"]), rel=1e-9)
        (r3, z3), (r4, z4) = prof[3], prof[4]            # outer flank
        assert (z4 - z3) / (r4 - r3) == pytest.approx(T(self.h["tF"]), rel=1e-9)
        # the exits lie on those flanks
        assert z1 + (self.h["rO"] - r1) * (z2 - z1) / (r2 - r1) == pytest.approx(-self.h["dE"], abs=1e-12)
        assert z3 + (self.h["rF"] - r3) * (z4 - z3) / (r4 - r3) == pytest.approx(-self.h["dE"], abs=1e-12)

    def test_groove_edges_and_depth(self):
        g = self.f["groove"]
        assert g["groove_edge_in"] == pytest.approx(self.h["edge_in"], rel=1e-12)
        assert g["groove_edge_out"] == pytest.approx(self.h["edge_out"], rel=1e-12)
        assert g["flank_included"] == pytest.approx(180 - 43 - 46)
        # shallowest flat bottom: each flank gives d/2 + land below its exit
        want = self.h["dE"] + max((self.h["dO"] / 2 + EXIT_LAND_DEFAULT) * S(43), (self.h["dF"] / 2 + EXIT_LAND_DEFAULT) * S(46))
        assert g["groove_depth"] == pytest.approx(want, rel=1e-12)
        # the sharp V is where the flanks meet
        x = (self.h["rF"] - self.h["rO"]) * T(46) / (T(43) + T(46))
        assert g["groove_v_r"] == pytest.approx(self.h["rO"] + x, rel=1e-12)
        assert g["groove_v_depth"] == pytest.approx(self.h["dE"] + x * T(43), rel=1e-12)

    def test_v_bottom_on_request(self):
        f = layout_from_config(_cfg(groove_bottom="v"), drawings=False)["face"]
        assert f["groove"]["groove_is_v"] and f["groove"]["groove_depth"] == pytest.approx(f["groove"]["groove_v_depth"])

    def test_clearances_are_to_the_groove_edges(self):
        assert self.f["centre_clear"] == pytest.approx(2 * self.h["edge_in"], rel=1e-12)
        assert self.f["wall_land"] == pytest.approx(0.0635 - self.h["edge_out"], rel=1e-12)

    def test_flat_face_keeps_the_old_geometry(self):
        """The same injector with a flat face: exits at the datum, the ellipse traces."""
        f = layout_from_config(_cfg(face="flat"), drawings=False)["face"]
        assert f["z_exit"] == 0.0 and f["z_imp"] == pytest.approx(self.h["L"])
        assert f["centre_clear"] == pytest.approx(2 * (self.h["rO"] - self.h["dO"] / (2 * C(43))))


# =============================================================================================
# Channels, against hand trigonometry
# =============================================================================================

class TestChannels:
    h = _hand_6500N()
    out = layout_from_config(_cfg())

    @pytest.mark.parametrize("k", ["O", "F"])
    def test_passage_runs_its_L_over_d_to_the_channel_floor(self, k):
        d, th, r0 = (self.h["dO"], 43, self.h["rO"]) if k == "O" else (self.h["dF"], 46, self.h["rF"])
        sgn = -1 if k == "O" else +1                     # LOX inner: goes inward; fuel out
        lam = 4.0 * d                                    # discharge orifice_l_over_d
        ch = self.out["passages"][k]["channel"]
        assert ch["length"] == pytest.approx(lam, rel=1e-12)
        assert ch["end"][0] == pytest.approx(r0 + sgn * lam * S(th), rel=1e-12)
        assert ch["end"][1] == pytest.approx(-self.h["dE"] - lam * C(th), rel=1e-12)
        # aligned: the channel is centred where the passage meets its floor
        assert ch["r_center"] == pytest.approx(ch["end"][0])
        assert ch["depth"] == pytest.approx(0.0127 + ch["end"][1], rel=1e-12)
        # the whole footprint sits on the floor with a land each side
        assert ch["width"] == pytest.approx(d / C(th) + 2 * EXIT_LAND_DEFAULT, rel=1e-12)

    def test_numbers_as_drawn(self):
        P = self.out["passages"]
        assert P["O"]["channel"]["r_center"] * 1000 == pytest.approx(30.19, abs=0.01)
        assert P["F"]["channel"]["r_center"] * 1000 == pytest.approx(50.11, abs=0.01)
        assert P["O"]["channel"]["depth"] * 1000 == pytest.approx(7.30, abs=0.01)
        assert P["F"]["channel"]["depth"] * 1000 == pytest.approx(7.88, abs=0.01)

    def test_drawn_passages_start_on_the_flank_and_end_on_the_floor(self):
        """Each hole wall runs from its exit on the flank to the channel floor, inside the channel.
        The openings themselves are not edges: the section draws the two walls, not a box."""
        from engine.core.injectors.layout import face_z_at
        f = self.out["face"]
        walls = [p for p in self.out["drawings"]["section_doublet"]
                 if p["layer"].startswith("PASSAGE") and p["t"] == "poly" and p["pts"][0][0] > 0]
        assert len(walls) == 4 and not any(p["closed"] for p in walls)
        for p in walls:
            ch = self.out["passages"][p["layer"][-1]]["channel"]
            start, end = [(-y, x) for x, y in (p["pts"][0], p["pts"][-1])]    # back to (z, r)
            assert start[0] == pytest.approx(face_z_at(f["profile"], start[1]), abs=2e-7)
            assert end[0] == pytest.approx(ch["end"][1], abs=2e-7)
            assert ch["r_lo"] - 1e-9 <= end[1] <= ch["r_hi"] + 1e-9

    def test_the_section_dimensions_each_channel_and_its_hole_axis_meets_it(self):
        """The half section gives each channel's width and depth, and draws the hole axis through
        to the channel floor, where the channel's centre line meets it."""
        sec = self.out["drawings"]["section_doublet"]
        dims = {p["text"] for p in sec if p["t"] == "dim"}
        for k in ("O", "F"):
            ch = self.out["passages"][k]["channel"]
            assert {f"{ch['width'] * 1000:.2f}", f"{ch['depth'] * 1000:.2f}"} <= dims
            q = [ch["end"][0], -ch["end"][1]]                  # entry point, drawing frame
            axis = [p for p in sec if p["layer"] == f"JET_{k}" and p["pts"][0][0] > 0][0]
            assert axis["pts"][-1] == pytest.approx(q, abs=2e-7)
            cl = [p for p in sec if p["layer"] == "CENTER" and p["pts"][0][0] == pytest.approx(ch["r_center"], abs=2e-7)]
            assert cl and cl[0]["pts"][-1] == pytest.approx(q, abs=2e-7)

    def test_lands_between_are_what_is_left(self):
        L = self.out["back"]["lands"]
        P = self.out["passages"]
        assert L["between"] == pytest.approx(P["F"]["channel"]["r_lo"] - P["O"]["channel"]["r_hi"])
        assert L["outer"] == pytest.approx(0.0762 - P["F"]["channel"]["r_hi"])
        assert L["inner"] == pytest.approx(P["O"]["channel"]["r_lo"] - 0.5 * 0.840 * 0.0254)

    def test_a_longer_passage_needs_a_thicker_plate(self):
        out = layout_from_config(_hole_ld(_cfg(), 12.0), drawings=False)
        assert "pierce_O" in _codes(out) and out["passages"]["O"]["land_ld"] < 12.0

    def test_coned_floor_is_normal_to_the_passage(self):
        out = layout_from_config(_cfg(channel_floor="coned"), drawings=False)
        for k, th in (("O", 43), ("F", 46)):
            ch = out["passages"][k]["channel"]
            # floor slope dz/dr perpendicular to the passage direction (-+sin, -cos)
            assert abs(ch["floor_slope"]) == pytest.approx(T(th), rel=1e-12)
            assert ch["breakthrough"] == "square"
        assert "oblique_inlet_O" not in _codes(out)

    def test_flat_floor_leaves_an_acute_inlet_lip_and_no_short_wall_rule(self):
        """On a flat floor the hole breaks in at the jet angle: the lip on its acute side is
        90 - 43 = 47 deg. SP-8089's L/d >= 4 is the axis length of a square-entry hole, so the
        oblique cut is not an L/d shortfall; it is an inlet the Cd model does not cover (info)."""
        ch = self.out["passages"]["O"]["channel"]
        assert ch["entry_lip_deg"] == pytest.approx(90.0 - 43.0)
        assert "short_wall_l_over_d" not in ch
        assert not [c for c in _codes(self.out) if c.startswith("short_wall")]
        assert _codes(self.out).get("oblique_inlet_O") == "info"
        coned = layout_from_config(_cfg(channel_floor="coned"), drawings=False)
        assert coned["passages"]["O"]["channel"]["entry_lip_deg"] == 90.0

    def test_channel_flow_area_is_reported_against_the_orifices(self):
        ch = self.out["passages"]["O"]["channel"]
        assert ch["flow_area"] == pytest.approx(ch["width"] * ch["depth"], rel=1e-9)
        assert ch["area_ratio"] == pytest.approx(ch["flow_area"] / (24 * math.pi * self.h["dO"] ** 2 / 4), rel=1e-9)
        assert "channel_area_O" in _codes(self.out)

    def test_a_coned_floor_cannot_break_out_of_the_back(self):
        """The coned floor tilts by theta, so its shallow wall sits (w/2) tan(theta) nearer the back
        face than the passage axis: the breakout test must use that wall."""
        out = layout_from_config(_hole_ld(_cfg(channel_floor="coned"), 9.8))
        ch = out["passages"]["O"]["channel"]
        assert ch["pierces_back"] and "pierce_O" in _codes(out)
        assert min(ch["floor_z_lo"], ch["floor_z_hi"]) >= -0.0127 - 1e-12
        plate = [p for p in out["drawings"]["section_doublet"] if p["layer"] == "PLATE"][0]
        assert min(x for x, _ in plate["pts"]) >= -0.0127 - 1e-9

    def test_overlapping_channels_are_impossible(self):
        out = layout_from_config(_cfg(channel_width=0.022), drawings=False)
        assert _codes(out).get("channels_cross") == "bad"


# =============================================================================================
# Plenum back (the flat-face plug many injectors use) still behaves
# =============================================================================================

def test_plenum_back_face_positions():
    out = layout_from_config(_cfg(face="flat", back="plenum"), drawings=False)
    h = _hand_6500N()
    P = out["passages"]
    assert P["O"]["r_back"] == pytest.approx(h["rO"] - 0.0127 * T(43), rel=1e-12)
    assert P["F"]["r_back"] == pytest.approx(h["rF"] + 0.0127 * T(46), rel=1e-12)
    assert out["back"]["mode"] == "plenum"


def test_flat_face_drill_entry_is_flagged_as_off_square():
    out = layout_from_config(_cfg(face="flat"), drawings=False)
    assert "flat_entry" in _codes(out)
    assert "flat_entry" not in _codes(layout_from_config(_cfg(), drawings=False))


# =============================================================================================
# Cd, from the hole as built
# =============================================================================================

class TestHoleCd:
    """One L/d per hole: it sets the Cd (the solver's own discharge model) and, with channels, the
    passage to the channel floor. The layout reports the Cd so a change shows where it is made."""

    def test_6500N_is_a_sharp_short_tube(self):
        cd = layout_from_config(_cfg(), drawings=False)["passages"]["O"]["cd"]
        # Lichtarowicz (1965) sharp inlet at L/d 4: Cd_u = 0.827 - 0.0085 x 4
        assert cd["value"] == pytest.approx(0.827 - 0.0085 * 4.0) and cd["inlet"] == "sharp"
        assert cd["length_factor"] == pytest.approx((0.827 - 0.0085 * 4.0) / 0.80) and cd["uses_ld"]

    def test_the_reported_cd_is_the_solvers(self):
        from engine.core.discharge import cd_inf_from_orifice_diameter
        from engine.core.injectors.layout import effective_discharge
        from engine.pipeline.config_schemas import PintleEngineConfig
        cfg = _hole_ld(_cfg(), 9.0, length_model="lichtarowicz")
        lay = layout_from_config(cfg, drawings=False)
        model = PintleEngineConfig.model_validate(cfg)
        for k, side in (("O", "oxidizer"), ("F", "fuel")):
            d = cfg["injector"]["geometry"][side]["d_jet"]
            want = cd_inf_from_orifice_diameter(d, effective_discharge(model, side))
            assert lay["passages"][k]["cd"]["value"] == pytest.approx(want, rel=1e-12)

    def test_a_longer_hole_lowers_cd_under_lichtarowicz(self):
        a = layout_from_config(_hole_ld(_cfg(), 4.0, length_model="lichtarowicz"), drawings=False)
        b = layout_from_config(_hole_ld(_cfg(), 8.0, length_model="lichtarowicz"), drawings=False)
        ca, cb = a["passages"]["O"]["cd"]["value"], b["passages"]["O"]["cd"]["value"]
        # Cd_u = 0.827 - 0.0085 L/d, normalised to 0.80 at L/d 3.18
        assert cb / ca == pytest.approx((0.827 - 0.0085 * 8) / (0.827 - 0.0085 * 4), rel=1e-9)
        # and the channel follows the same number
        assert b["passages"]["O"]["channel"]["l_over_d"] == pytest.approx(8.0)

    def test_without_an_inlet_the_hole_length_does_not_enter_cd(self):
        cfg = _hole_ld(_cfg(), 8.0, inlet_geometry=None)
        cd = layout_from_config(cfg, drawings=False)["passages"]["O"]["cd"]
        assert cd["inlet"] is None and cd["uses_ld"] is False

    def test_channels_never_ask_to_couple_the_cd(self):
        """With channels the hole is the passage: there is no second number to disagree with."""
        for ld in (3.0, 6.0, 9.0):
            assert not any(c.startswith("cd_ld") for c in _codes(layout_from_config(_hole_ld(_cfg(), ld), drawings=False)))

    def test_a_drilled_plate_still_asks(self):
        cfg = _cfg(face="flat", back="plenum")
        cfg["design_requirements"]["layer1_injector_counterbore_dia_m"] = None
        assert "cd_ld_O" in _codes(layout_from_config(cfg, drawings=False))


class TestInletShape:
    """The inlet declared for the Cd is cut into the hole's entry edge in the section (and the DXF),
    from the same r/d the Cd table is keyed to."""

    @staticmethod
    def _walls(inlet, **plate):
        cfg = _hole_ld(_cfg(**plate), 4.0, inlet_geometry=inlet)
        out = layout_from_config(cfg)
        return out, [p for p in out["drawings"]["section_doublet"]
                     if p["layer"] == "PASSAGE_O" and p["t"] == "poly" and p["pts"][0][0] > 0]

    def test_sharp_is_a_corner(self):
        _, walls = self._walls("sharp")
        assert [len(w["pts"]) for w in walls] == [2, 2]

    def test_a_rounded_inlet_is_an_arc_of_the_table_radius_tangent_to_wall_and_floor(self):
        out, walls = self._walls("rounded")
        d = out["inputs"]["oxidizer"]["d_jet"]
        r = 0.125 * d                                   # INLET_GEOMETRY_RD["rounded"]
        ch = out["passages"]["O"]["channel"]
        floor_y = -ch["end"][1]                          # drawing frame: Y = -z
        for w in walls:
            arc = np.array(w["pts"][1:])                 # after the exit point: tangent point .. floor
            # all arc points sit r from one centre
            A, B = arc[:, 0], arc[:, 1]
            M = np.c_[2 * A, 2 * B, np.ones(len(A))]
            cx, cy, c = np.linalg.lstsq(M, A ** 2 + B ** 2, rcond=None)[0]
            assert math.sqrt(c + cx ** 2 + cy ** 2) == pytest.approx(r, abs=3e-7)   # points kept to 0.1 um
            assert arc[-1][1] == pytest.approx(floor_y, abs=1e-7)      # ends on the floor
            assert abs(cy - floor_y) == pytest.approx(r, abs=3e-7)     # tangent to it

    def test_a_chamfer_is_one_straight_cut(self):
        out, walls = self._walls("chamfered")
        d = out["inputs"]["oxidizer"]["d_jet"]
        floor_y = -out["passages"]["O"]["channel"]["end"][1]
        for w in walls:
            assert len(w["pts"]) == 3                             # exit, cut start, cut end
            (x1, y1), (x2, y2) = w["pts"][1], w["pts"][2]
            assert y2 == pytest.approx(floor_y, abs=1e-7) and y1 < floor_y   # from the wall (below the floor, toward the face) to the floor
            # legs of 0.1 d each side of the corner: the cut face is 2 (0.1 d) sin(wedge / 2) long
            assert 0.05 * d < math.hypot(x2 - x1, y2 - y1) < 0.2 * d

    def test_the_hole_label_says_which_inlet(self):
        out, _ = self._walls("rounded")
        labels = [p["text"] for p in out["drawings"]["section_doublet"] if p["t"] == "text" and p["text"].startswith("LOX 43")]
        assert labels == ["LOX 43° ⌀1.548 L/d 4.0, rounded inlet r 0.19"]
        assert not any("inlet" in p.get("text", "") for p in self._walls("sharp")[0]["drawings"]["section_doublet"])

    def test_an_inlet_too_big_for_the_channel_says_how_wide_to_go(self):
        out, _ = self._walls("bellmouth")
        th, d = 43.0, out["inputs"]["oxidizer"]["d_jet"]
        reach = 0.20 * d / math.tan(math.radians(0.5 * (90 - th)))
        assert out["passages"]["O"]["inlet_reach"] == pytest.approx(reach, rel=1e-12)
        assert _codes(out)["inlet_fit_O"] == "warn"
        ch = out["passages"]["O"]["channel"]
        wide = _cfg(channel_width=ch["footprint"] + 2 * reach + 1e-6)
        assert "inlet_fit_O" not in _codes(layout_from_config(_hole_ld(wide, 4.0, inlet_geometry="bellmouth"), drawings=False))
        assert "inlet_fit_O" not in _codes(self._walls("rounded")[0])


# =============================================================================================
# Igniter
# =============================================================================================

class TestIgniter:
    def test_half_inch_npt_keepout(self):
        out = layout_from_config(_cfg(), drawings=False)
        # 21.336 thread OD + 2 x 2.00 mm web
        assert out["centre_keepout"]["dia"] * 1000 == pytest.approx(25.34, abs=0.01)
        assert out["centre_keepout"]["source"] == "igniter 1/2 NPT"

    def test_engagement_needs_the_centre_thicker(self):
        cfg = _cfg()
        assert "igniter_engagement" in _codes(layout_from_config(cfg, drawings=False))
        cfg["injector"]["igniter"]["hub_thickness"] = 0.01905
        assert "igniter_engagement" not in _codes(layout_from_config(cfg, drawings=False))

    @pytest.mark.parametrize("hub", [None, 0.01905])
    def test_the_thread_is_cut_into_the_plug_not_floating(self, hub):
        """The thread line starts on the plug's back face (or the boss's) and ends on the drilled
        wall: both ends lie on the plug outline."""
        cfg = _cfg()
        cfg["injector"]["igniter"]["hub_thickness"] = hub
        sec = layout_from_config(cfg)["drawings"]["section_doublet"]
        plate = [p for p in sec if p["layer"] == "PLATE" and max(x for x, _ in p["pts"]) > 0][0]["pts"]
        thread = [p for p in sec if p["layer"] in ("THREAD", "BAD") and p["t"] == "poly" and p["pts"][0][0] > 0][0]["pts"]

        def on_outline(q):
            for (x1, y1), (x2, y2) in zip(plate, plate[1:] + plate[:1]):
                cross = (x2 - x1) * (q[1] - y1) - (y2 - y1) * (q[0] - x1)
                if abs(cross) < 1e-10 and min(x1, x2) - 1e-9 <= q[0] <= max(x1, x2) + 1e-9 \
                        and min(y1, y2) - 1e-9 <= q[1] <= max(y1, y2) + 1e-9:
                    return True
            return False
        assert on_outline(thread[0]) and on_outline(thread[-1])

    def test_the_section_says_why_the_port_is_red(self):
        def port(cfg):
            sec = layout_from_config(cfg)["drawings"]["section_doublet"]
            bad = [p for p in sec if p["layer"] == "BAD"]
            labels = [p["text"] for p in sec if p["t"] == "text" and ("NPT port" in p["text"] or "needs" in p["text"])]
            return bad, labels
        cfg = _cfg()
        bad, labels = port(cfg)
        assert bad and labels == ["1/2 NPT port, L2 13.56", "needs 13.56, has 12.70"]
        cfg["injector"]["igniter"]["hub_thickness"] = 0.01905
        bad, labels = port(cfg)
        assert not bad and labels == ["1/2 NPT port, L2 13.56"]

    def test_an_explicit_reservation_wins_and_is_called_oversized(self):
        cfg = _cfg()
        cfg["design_requirements"]["layer1_injector_center_clear_dia_m"] = 0.0381
        out = layout_from_config(cfg, drawings=False)
        assert out["centre_keepout"]["dia"] == pytest.approx(0.0381)
        assert _codes(out).get("centre_reserve_oversized") == "info"


# =============================================================================================
# The old flat-face regressions (SHIP / FINAL fixtures), kept: they are why the checks exist
# =============================================================================================

BEFORE = dict(
    oxidizer=dict(n_elements=28, d_jet=0.0015821116699998301, impingement_angle=40, spacing=0.0030182972100858507),
    fuel=dict(n_elements=28, d_jet=0.001375132476863662, impingement_angle=69, spacing=0.009875029755263455),
    bore_diameter=0.127,
)
AFTER = dict(
    oxidizer=dict(n_elements=27, d_jet=0.0017094, impingement_angle=40.0, spacing=0.0081070167),
    fuel=dict(n_elements=27, d_jet=0.0015024, impingement_angle=50.0, spacing=0.0111428181),
    bore_diameter=0.127,
)
REQS = dict(center_clear_dia=0.0381, min_web=0.002, wall_clearance=0.008, ld_min=3, ld_max=5,
            plate_thickness=0.0127, counterbore_dia=0.004, land_ld_O=4,
            plate=dict(face="flat", back="plenum"))


class TestOldFlatDesigns:
    out = compute_layout(**BEFORE, **REQS)

    def test_crams_every_element_onto_a_circle_narrower_than_the_throat(self):
        assert self.out["face"]["r_imp"] * 2000 == pytest.approx(41.79, abs=0.05)
        assert self.out["face"]["core_frac"] < 0.11

    def test_leaves_no_room_at_the_axis(self):
        assert self.out["face"]["centre_clear"] * 1000 == pytest.approx(24.84, abs=0.05)
        assert "centre clear" in _texts(self.out)

    def test_calls_out_the_thin_lox_web(self):
        assert "web between holes on a ring 1.44 mm < 2.00 mm required" in _texts(self.out)

    def test_needs_a_counterbore_to_be_drillable(self):
        bare = compute_layout(**BEFORE, **dict(REQS, counterbore_dia=0.0))
        assert "L/d 21.8" in _texts(bare)

    def test_sp8089_included_angle(self):
        assert "SP-8089" in _texts(self.out)

    def test_the_replacement_raises_nothing_blocking(self):
        out = compute_layout(**AFTER, **REQS)
        assert [w for w in out["warnings"] if w["level"] == "bad"] == []


def test_degenerate_rings():
    same = dict(
        oxidizer=dict(n_elements=20, d_jet=0.002, impingement_angle=50, spacing=0.006),
        fuel=dict(n_elements=20, d_jet=0.002, impingement_angle=60, spacing=0.006),
        bore_diameter=0.0813,
    )
    out = compute_layout(**same)
    assert out["face"]["degenerate"]
    assert "same pitch circle" in _texts(out)
    assert "of the chamber area is fed" not in _texts(out)


# =============================================================================================
# Parity: Layer 1's inner-loop copies flip exactly where the layout says
# =============================================================================================

def _random_layouts(n=60, seed=7):
    rng = np.random.default_rng(seed)
    for _ in range(n):
        n_el = int(rng.integers(6, 40))
        d_O, d_F = rng.uniform(0.8e-3, 2.5e-3, 2)
        th_O, th_F = rng.uniform(20, 60, 2)
        s_O = rng.uniform(max(d_O * 1.5, 3e-3), 0.012)
        s_F = s_O + rng.uniform(1e-3, 6e-3)
        bore = (n_el * s_F / np.pi) * rng.uniform(1.15, 1.6)
        yield dict(
            oxidizer=dict(n_elements=n_el, d_jet=d_O, impingement_angle=th_O, spacing=s_O),
            fuel=dict(n_elements=n_el, d_jet=d_F, impingement_angle=th_F, spacing=s_F),
            bore_diameter=bore,
        )


def _l1_kwargs(g):
    return dict(
        n_elements=float(g["oxidizer"]["n_elements"]),
        spacing_O_m=g["oxidizer"]["spacing"], spacing_F_m=g["fuel"]["spacing"],
        d_jet_O_m=g["oxidizer"]["d_jet"], d_jet_F_m=g["fuel"]["d_jet"],
        D_chamber_inner_m=g["bore_diameter"],
        angle_O_deg=g["oxidizer"]["impingement_angle"], angle_F_deg=g["fuel"]["impingement_angle"],
    )


def _hard_kwargs(g):
    k = _l1_kwargs(g)
    return dict(
        d_jet_O=k["d_jet_O_m"], d_jet_F=k["d_jet_F_m"], sp_O=k["spacing_O_m"], sp_F=k["spacing_F_m"],
        D_chamber_inner=k["D_chamber_inner_m"], D_throat_check=0.0, A_chamber_check=0.0,
        A_throat_check=0.0, n_elements=k["n_elements"], angle_O_deg=k["angle_O_deg"],
        angle_F_deg=k["angle_F_deg"],
    )


EPS = 1e-6


@pytest.mark.parametrize("contoured", [False, True], ids=["flat", "contoured"])
@pytest.mark.parametrize("path", ["worker", "soft", "hard"])
def test_centre_and_wall_clearance_flip_where_the_layout_says(path, contoured):
    from engine.optimizer.layers.layer1_static_optimization import (
        _impinging_face_infeasibility_terms, _impinging_hard_geometry_blocks_eval,
        _impinging_ring_geometry_squared,
    )
    face = dict(face_contoured=contoured, exit_land=EXIT_LAND_DEFAULT)

    def violated(g, **lim):
        if path == "worker":
            return _impinging_face_infeasibility_terms(**_l1_kwargs(g), **lim, **face) > 0.0
        if path == "soft":
            return _impinging_ring_geometry_squared(**_l1_kwargs(g), **lim, **face) > 0.0
        return _impinging_hard_geometry_blocks_eval(**_hard_kwargs(g), **lim, **face)

    for g in _random_layouts():
        f = compute_layout(**g, plate={"face": "contoured" if contoured else "flat"})["face"]
        cc, wl = f["centre_clear"], f["wall_land"]
        if cc > 0:
            assert not violated(g, center_clear_dia_m=cc * (1 - EPS)), "centre clear: false alarm"
            assert violated(g, center_clear_dia_m=cc * (1 + EPS)), "centre clear: missed"
        if wl > 0:
            assert not violated(g, wall_clearance_m=wl * (1 - EPS)), "wall land: false alarm"
            assert violated(g, wall_clearance_m=wl * (1 + EPS)), "wall land: missed"


def test_channel_overlap_flips_where_the_layout_says():
    """Widen both channels until they meet: Layer 1's channel term turns on exactly where the
    layout starts calling them crossed."""
    from engine.optimizer.layers.layer1_static_optimization import _impinging_back_face_terms
    for g in _random_layouts():
        liner = 0.1 * g["bore_diameter"]
        env = {"r_sleeve_id": 0.5 * g["bore_diameter"] + liner, "liner_thickness": liner}
        base = compute_layout(**g, envelope=env, plate_thickness=0.02,
                              plate={"face": "contoured", "back": "channels"})
        P = base["passages"]
        if any(p["channel"]["pierces_back"] for p in P.values()):
            continue
        w_meet = abs(P["F"]["channel"]["r_center"] - P["O"]["channel"]["r_center"])
        outs = {}
        for f in (1 - EPS, 1 + EPS):
            outs[f] = compute_layout(**g, envelope=env, plate_thickness=0.02,
                                     plate={"face": "contoured", "back": "channels", "channel_width": w_meet * f})
        clear = outs[1 - EPS]
        if [w for w in clear["warnings"] if w["level"] == "bad"]:
            continue                               # something else already fails at that width
        assert "channels_cross" in _codes(outs[1 + EPS])
        kw = dict(_l1_kwargs(g), plate_thickness_m=0.02, face_contoured=True, back_channels=True,
                  liner_thickness_m=liner)
        assert _impinging_back_face_terms(**kw, channel_width_m=w_meet * (1 - EPS)) == 0.0
        assert _impinging_back_face_terms(**kw, channel_width_m=w_meet * (1 + EPS)) > 0.0


def test_worker_path_reads_the_plate_settings():
    import inspect
    import engine.optimizer.layers.layer1_static_optimization as L1
    src = inspect.getsource(L1._compute_objective_value)
    for key in ("layer1_injector_face_contoured", "layer1_injector_back_channels",
                "layer1_injector_land_ld_O", "layer1_injector_r_plate_m"):
        assert key in src, key


def test_standoff_matches_the_physics_helper():
    from engine.core.injectors.impinging import impingement_standoff_m
    for g in _random_layouts():
        out = compute_layout(**g)
        L = impingement_standoff_m(g["oxidizer"]["n_elements"], g["oxidizer"]["spacing"],
                                   g["fuel"]["spacing"], g["oxidizer"]["impingement_angle"],
                                   g["fuel"]["impingement_angle"])
        assert out["face"]["l_imp"] == pytest.approx(L, rel=1e-12)


# =============================================================================================
# The frontend renders from a fixture of this module's output; it must not go stale.
# =============================================================================================

FIXTURE = ROOT / "frontend/src/components/__fixtures__/layout_6500N.json"


def test_frontend_fixture_is_current():
    """Regenerate: python3 scripts/injector_layout.py --no-flows configs/ethalox_6500N.yaml > <fixture>"""
    want = json.loads(json.dumps(layout_from_config(yaml.safe_load(C6500.read_text()))))
    got = json.loads(FIXTURE.read_text())

    def same(a, b, path="$"):
        if isinstance(a, dict) and isinstance(b, dict):
            assert a.keys() == b.keys(), f"{path}: keys differ"
            for k in a:
                same(a[k], b[k], f"{path}.{k}")
        elif isinstance(a, list) and isinstance(b, list):
            assert len(a) == len(b), f"{path}: length differs"
            for i, (x, y) in enumerate(zip(a, b)):
                same(x, y, f"{path}[{i}]")
        elif isinstance(a, float) or isinstance(b, float):
            assert a == pytest.approx(b, rel=1e-5, abs=1e-9), path
        else:
            assert a == b, path

    same(got, want)


def test_an_undeclared_plate_draws_the_stands_plug_and_layer1_stays_as_it_was():
    """No injector.plate: the drawing is the contoured, channelled plug (what the stand machines)
    and says so; Layer 1 keeps the flat-face, plenum constraints it always had until declared."""
    from engine.optimizer.layers.layer1_static_optimization import _layer1_plate
    from engine.pipeline.config_schemas import InjectorPlateConfig
    cfg = yaml.safe_load(C6500.read_text())
    cfg["injector"]["plate"] = None
    out = layout_from_config(cfg)
    assert out["face"]["contoured"] and out["back"]["mode"] == "channels"
    assert out["face"]["plate_declared"] is False and _codes(out)["plate_default"] == "info"
    assert "plate_default" not in _codes(layout_from_config(_cfg(), drawings=False))

    class _Cfg:
        class injector:
            plate = None
    assert _layer1_plate(_Cfg) == {}
    # declared with nothing said, the schema gives the same plug the drawing assumed
    assert (InjectorPlateConfig().face, InjectorPlateConfig().back) == ("contoured", "channels")
