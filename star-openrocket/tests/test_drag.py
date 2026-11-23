"""Drag models against hand calculation -- not against themselves.

A simple rocket built by hand (a 0.3 m cone on a 1.3 m tube of radius 50 mm, four
trapezoidal fins, a 25 mm nozzle): each term is computed here from the textbook
formula, with the numbers written out, and the model must agree. A second rocket is
LE4 SD as its .ork describes it (lengths, radii and finishes typed in from the file),
held to the totals of an independent hand port of OpenRocket's drag that was itself
checked by hand (body friction 0.245 by hand, 0.249 ported).
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from backend.onshape.aero import drag, drag_buildup, drag_openrocket as orc
from backend.onshape.aero.drag_geometry import (
    BodySegment,
    DragGeometry,
    FinSetDrag,
    Protuberance,
    planform_from_chords,
    segments_from_profile,
    sinphi_at_aft,
    trapezoid_chords,
)

R = 0.05
A_REF = math.pi * R**2
NOSE_L, TUBE_L = 0.3, 1.3
L = NOSE_L + TUBE_L
SMOOTH = 20e-6
# Air: 100 m/s through nu = 1.5e-5 m^2/s.
V, NU = 100.0, 1.5e-5
V_NU = V / NU
MACH = 0.3

CONE_SINPHI = R / math.hypot(R, NOSE_L)


def _fins(section: str = "square", thickness: float = 0.003) -> FinSetDrag:
    lead, trail = trapezoid_chords(0.12, 0.06, 0.06)
    area, mac, cos_lead = planform_from_chords(lead, trail, 0.10)
    return FinSetDrag(name="fins", count=4, area=area, span=0.10, mac=mac, cos_lead=cos_lead,
                      thickness=thickness, section=section, roughness=SMOOTH, root_chord=0.12,
                      x_root_lead=L - 0.12)


def _rocket(**kw) -> DragGeometry:
    nose = BodySegment("nose", 0.0, NOSE_L, 0.0, R, math.pi * R * math.hypot(NOSE_L, R), SMOOTH,
                       shape="conical", param=0.0, sinphi=CONE_SINPHI)
    tube = BodySegment("tube", NOSE_L, L, R, R, 2 * math.pi * R * TUBE_L, SMOOTH)
    return DragGeometry(ref_radius=R, segments=(nose, tube), fins=(_fins(**kw),), nozzle_radius=0.025)


# -- the planform, as FinSetCalc reads it -------------------------------------------


def test_trapezoid_planform_area_mac_and_sweep():
    lead, trail = trapezoid_chords(0.12, 0.06, 0.06)
    area, mac, cos_lead = planform_from_chords(lead, trail, 0.10)
    # The exact trapezoid, (0.12 + 0.06)/2 * 0.1; FinSetCalc's MAC, sum(c^2)/sum(c)
    # over its 48 span stations -- within 0.01 % of the continuous 2/3 (cr + ct -
    # cr ct/(cr + ct)) = 0.09333 m.
    chords = 0.12 - 0.06 * np.linspace(0, 1, 48)
    assert area == pytest.approx(0.009, rel=1e-12)
    assert mac == pytest.approx((chords**2).sum() / chords.sum(), rel=1e-12)
    assert mac == pytest.approx(2 / 3 * (0.18 - 0.0072 / 0.18), rel=2e-3)
    # A straight leading edge: every strip has the same cosine, 0.1 / hypot(0.06, 0.1).
    assert cos_lead == pytest.approx(0.1 / math.hypot(0.06, 0.1))


# -- OpenRocket 24.12, term by term --------------------------------------------------


def test_openrocket_body_friction_by_hand():
    re = V_NU * L  # 1.0667e7
    cf_smooth = 1 / (1.5 * math.log(re) - 5.6) ** 2 * (1 - 0.1 * MACH**2)
    cf_rough = 0.032 * (SMOOTH / L) ** 0.2 * (1 - 0.1 * MACH**2)
    cf = max(cf_smooth, cf_rough)
    assert cf == pytest.approx(0.0033159, rel=1e-4)  # the roughness limit governs
    wet = math.pi * R * math.hypot(NOSE_L, R) + 2 * math.pi * R * TUBE_L
    expected = (1 + 1 / (2 * (L + 0.0001) / R)) * cf * wet / A_REF
    got = orc.drag(_rocket(), MACH, V_NU).terms["friction: body"]
    assert got == pytest.approx(expected, rel=1e-9)


def test_openrocket_base_drag_by_hand():
    # The tube ends at the full radius: base CD 0.12 + 0.13 M^2 on the reference area.
    assert orc.drag(_rocket(), MACH, V_NU).terms["base"] == pytest.approx(0.12 + 0.13 * 0.09)


def test_openrocket_square_fin_pressure_by_hand():
    stag = 0.85 * (1 + MACH**2 / 4 + MACH**4 / 40)
    base = 0.12 + 0.13 * MACH**2
    cos2 = 0.1**2 / (0.06**2 + 0.1**2)
    expected = 4 * (stag * cos2 + base) * 0.10 * 0.003 / A_REF
    assert orc.drag(_rocket(), MACH, V_NU).terms["pressure: fins"] == pytest.approx(expected, rel=1e-9)


def test_openrocket_fin_friction_uses_the_rocket_length():
    re = V_NU * L
    cf = max(1 / (1.5 * math.log(re) - 5.6) ** 2, 0.032 * (SMOOTH / L) ** 0.2) * (1 - 0.1 * MACH**2)
    f = _fins()
    expected = 4 * cf * (1 + 2 * f.thickness / f.mac) * 2 * f.area / A_REF
    assert orc.drag(_rocket(), MACH, V_NU).terms["friction: fins"] == pytest.approx(expected, rel=1e-9)


def test_openrocket_cone_pressure_at_mach_zero_is_point_eight_sin2():
    # SymmetricComponentCalc's subsonic fit starts at 0.8 sin^2(phi) at Mach 0 and
    # reaches the ogive formula's sin(phi) (times 1.0 for a cone) at Mach 1.
    g = _rocket()
    assert orc.drag(g, 0.0, 1e-3).terms["pressure: nose"] == pytest.approx(0.8 * CONE_SINPHI**2, rel=1e-9)
    assert orc.drag(g, 1.0, V_NU).terms["pressure: nose"] == pytest.approx(CONE_SINPHI, rel=1e-9)


def test_openrocket_boattail_drag_from_base_drag_by_fineness():
    # A 0.1 m boattail from 50 to 30 mm: fineness 0.1 / (2 * 0.02) = 2.5, so CD is
    # base drag on its frontal annulus times (3 - 2.5)/2.
    bt = BodySegment("boattail", 0.0, 0.1, R, 0.03, 0.0, SMOOTH)
    frontal = math.pi * (R**2 - 0.03**2)
    expected = (0.12 + 0.13 * MACH**2) * frontal / A_REF * 0.25
    assert orc.segment_pressure_cd(bt, MACH, A_REF) == pytest.approx(expected, rel=1e-12)


def test_openrocket_rail_button_by_hand():
    # A 10 mm tall button at 1 m: boundary layer 0.37 x / Re_x^0.2 = 0.37 / (6.67e6)^0.2
    # = 15.8 mm, taller than the button, so the mean Mach is (h/2)/delta * M.
    p = Protuberance("button", "bluff", 1, height=0.01, width=0.01, length=0.01, x=1.0, frontal_area=1e-4)
    delta = 0.37 * 1.0 / (V_NU * 1.0) ** 0.2
    m_mean = 0.005 / delta * MACH
    cd_cyl = float(np.interp(m_mean, [0.0, 0.2, 0.3], [1.2, 1.22, 1.25]))
    stag = 0.85 * (1 + MACH**2 / 4 + MACH**4 / 40)
    expected = cd_cyl * m_mean**2 / MACH**2 * stag * 1e-4 / A_REF
    assert orc.bluff_protuberance_cd(p, MACH, V_NU, A_REF) == pytest.approx(expected, rel=1e-9)


# -- the buildup's corrections, one at a time ---------------------------------------


def test_buildup_fin_friction_runs_at_the_mean_chord():
    f = _fins()
    re_c = V_NU * f.mac
    cf = 1 / (1.5 * math.log(re_c) - 5.6) ** 2 * (1 - 0.1 * MACH**2)
    k_plus = V_NU * math.sqrt(cf / 2) * SMOOTH  # ~5.4: just past smooth
    rough = 0.032 * (SMOOTH / f.mac) ** 0.2 * (1 - 0.1 * MACH**2)
    w = math.log(k_plus / 5) / math.log(70 / 5)
    cf_used = cf + w * (rough - cf) if rough > cf and k_plus > 5 else cf
    tc = f.thickness / f.mac
    expected = 4 * cf_used * (1 + 2 * tc + 60 * tc**4) * 2 * f.area / A_REF
    assert drag_buildup.drag(_rocket(), MACH, V_NU).terms["friction: fins"] == pytest.approx(expected, rel=1e-9)


@pytest.mark.parametrize(
    ("speed", "roughness", "length", "regime"),
    [(20.0, 20e-6, L, "smooth"), (300.0, 500e-6, L, "rough"), (100.0, 60e-6, L, "between"),
     # Slow and rough: OpenRocket's fully rough value is the larger, but k+ ~ 2.2 says
     # the grains sit inside the viscous sublayer -- hydraulically smooth.
     (5.0, 150e-6, 5.0, "smooth, though rough is larger")],
)
def test_buildup_roughness_follows_the_sand_grain_regime(speed, roughness, length, regime):
    v_nu = speed / NU
    cf, k_plus = drag_buildup.part_cf(v_nu, length, roughness, 0.0)
    smooth = 1 / (1.5 * math.log(v_nu * length) - 5.6) ** 2
    rough = 0.032 * (roughness / length) ** 0.2
    if regime.startswith("smooth"):
        assert k_plus < 5 and cf == pytest.approx(smooth)
        if regime != "smooth":
            assert rough > smooth
    elif regime == "rough":
        assert k_plus > 70 and cf == pytest.approx(rough)
    else:
        assert 5 < k_plus < 70 and smooth < cf < rough


def test_buildup_body_form_factor_is_hoerners():
    # l/d = 16: 1 + 1.5/16^1.5 + 7/16^3.
    assert drag_buildup.body_form_factor(1.6, 0.1) == pytest.approx(1 + 1.5 / 64 + 7 / 4096)


def test_buildup_base_drag_is_hoerners_on_the_forebody():
    b = drag_buildup.drag(_rocket(), MACH, V_NU)
    forebody = sum(v for k, v in b.terms.items() if k != "base")
    assert b.terms["base"] == pytest.approx(0.029 / math.sqrt(forebody), rel=1e-12)
    # At Mach 1 and above it is OpenRocket's again.
    assert drag_buildup.drag(_rocket(), 1.2, V_NU).terms["base"] == pytest.approx(0.25 / 1.2)


def test_buildup_power_on_base_is_the_annulus_outside_the_nozzle():
    off = drag_buildup.drag(_rocket(), MACH, V_NU).terms["base"]
    on = drag_buildup.drag(_rocket(), MACH, V_NU, power_on=True).terms["base"]
    assert on == pytest.approx(off * (1 - (0.025 / R) ** 2))


# -- the registry and the tables RocketPy flies --------------------------------------


def test_stub_is_the_old_curve_exactly():
    for m in (0.0, 0.3, 0.95, 1.1, 3.0):
        expected = np.interp(m, [p[0] for p in drag.STUB_CURVE], [p[1] for p in drag.STUB_CURVE])
        assert drag.breakdown(_rocket(), "stub", m, V_NU).cd == expected
    assert drag.rocketpy_drag(None) == (drag.STUB_CURVE, drag.STUB_CURVE)


def test_rocketpy_lookup_reproduces_the_model_at_the_grid_nodes():
    g = _rocket()
    tables = drag.drag_tables(g, "buildup")
    off, on = drag.rocketpy_drag(tables)
    d = 2 * R
    for m in (0.3, 0.9, 1.5):
        for re_d in drag.RE_D_GRID[[3, 6]]:
            want_off = drag.breakdown(g, "buildup", m, re_d / d).cd
            want_on = drag.breakdown(g, "buildup", m, re_d / d, power_on=True).cd
            assert off(0, 0, m, re_d, 0, 0, 0) == pytest.approx(want_off, rel=1e-9)
            assert on(0, 0, m, re_d, 0, 0, 0) == pytest.approx(want_on, rel=1e-9)


def test_unknown_model_is_refused():
    with pytest.raises(ValueError):
        drag.breakdown(_rocket(), "rasaero", 0.3, V_NU)


# -- profile segmentation -------------------------------------------------------------


def test_profile_splits_into_nose_tube_and_boattail_without_steps():
    s = np.concatenate([np.linspace(0, 0.3, 31), np.linspace(0.31, 1.5, 50), np.linspace(1.51, 1.6, 10)])
    r = np.where(s <= 0.3, R * s / 0.3, np.where(s <= 1.5, R, R - (s - 1.5) * 0.2))
    r = r + np.where((s > 0.8) & (s < 0.9), 0.004, 0.0)  # a shroud's bump on the tube
    segs = segments_from_profile(s, r, SMOOTH, R)
    assert [sg.kind for sg in segs] == ["nose", "tube", "boattail"]
    # Contiguous, no step for the stagnation term to rate, and the bump is not body.
    for a, b in zip(segs, segs[1:]):
        assert a.x_aft == b.x_fore and a.r_aft == b.r_fore
    assert segs[1].r_fore == segs[1].r_aft == R
    assert segs[0].sinphi == pytest.approx(sinphi_at_aft(s[:31], r[:31]))
    assert "pressure: forward steps" not in orc.drag(DragGeometry(R, tuple(segs)), MACH, V_NU).terms


# -- LE4 SD as its .ork describes it --------------------------------------------------


def _le4_ork() -> DragGeometry:
    """Typed in from the LE4 SD .ork: a 1.016 m tangent ogive, 3.896 m of 203.3 mm tube
    (0.406 m of it the "normal"-finish T2, the rest smooth), a 0.1397 m conical
    boattail to 139.7 mm, four 4.76 mm airfoil fins and four 25.4 mm rounded camera
    shrouds. The ogive's wetted area, 0.4353 m^2, is integrated off its profile."""
    from backend.ork.shapes import ogive

    r = 0.1016635
    x = np.linspace(0, 1.016, 4001)
    rr = ogive(x, r, 1.016, 1.0)
    nose_wet = float(np.sum(math.pi * (rr[1:] + rr[:-1]) * np.hypot(np.diff(rr), np.diff(x))))
    tube = 0.2032 + 0.4064 + 0.4572 + 1.311402 + 1.51765
    k_tube = (0.4064 * 60e-6 + (tube - 0.4064) * 20e-6) / tube
    segs = (
        BodySegment("nose", 0.0, 1.016, 0.0, r, nose_wet, SMOOTH, "ogive", 1.0, sinphi_at_aft(x, rr)),
        BodySegment("tube", 1.016, 1.016 + tube, r, r, 2 * math.pi * r * tube, k_tube),
        BodySegment("boattail", 1.016 + tube, 1.016 + tube + 0.1397, r, 0.06985,
                    math.pi * (r + 0.06985) * math.hypot(0.1397, r - 0.06985), SMOOTH, "conical", 0.0),
    )

    def fin(name, n, root, tip, sweep, h, t, section):
        lead, trail = trapezoid_chords(root, tip, sweep)
        area, mac, cos_lead = planform_from_chords(lead, trail, h)
        return FinSetDrag(name, n, area, h, mac, cos_lead, t, section, SMOOTH, root, 0.0)

    fins = (fin("fins", 4, 0.4064, 0.3048, 0.2032, 0.1524, 0.0047625, "airfoil"),
            fin("shrouds", 4, 0.0780034, 0.0050038, 0.0510032, 0.016002, 0.0254, "rounded"))
    return DragGeometry(ref_radius=r, segments=segs, fins=fins)


def _air(h: float) -> tuple[float, float]:
    T = 288.15 - 0.0065 * h
    rho = 101325 * (T / 288.15) ** 5.25588 / (287.053 * T)
    return math.sqrt(1.4 * 287.053 * T), 1.458e-6 * T**1.5 / (T + 110.4) / rho


@pytest.mark.parametrize(("mach", "cd"), [(0.2, 0.379), (0.47, 0.394), (0.9, 0.464)])
def test_openrocket_port_on_le4_matches_the_hand_port(mach, cd):
    """The independent hand port's totals at 1000 m (scratch or_drag.py, Nov 2026).
    It rated the body friction on the tubes' exact areas; agreement to 1 % is the
    transcription holding, the residual the strip-sum fin planform."""
    a, nu = _air(1000.0)
    assert orc.drag(_le4_ork(), mach, mach * a / nu).cd == pytest.approx(cd, rel=0.01)


def test_buildup_on_le4_lands_below_openrocket_for_the_stated_reasons():
    a, nu = _air(1000.0)
    m = 0.47
    o = orc.drag(_le4_ork(), m, m * a / nu)
    b = drag_buildup.drag(_le4_ork(), m, m * a / nu)
    assert 0.31 < b.cd < 0.35 and 0.38 < o.cd < 0.41
    assert b.terms["base"] < o.terms["base"] / 3  # Hoerner sees the long forebody
    assert b.terms["friction: fins"] > 1.3 * o.terms["friction: fins"]  # chord, not rocket, Reynolds
    assert b.terms["friction: body"] < o.terms["friction: body"]  # transitional, not fully rough


def test_fin_form_factor_is_held_at_the_edge_of_its_fit():
    assert drag_buildup.fin_form_factor(0.01, 0.1) == pytest.approx(1 + 0.2 + 60e-4)
    assert drag_buildup.fin_form_factor(0.03, 0.02) == drag_buildup.fin_form_factor(0.025, 0.1)
