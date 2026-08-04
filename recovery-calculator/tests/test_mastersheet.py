"""The mastersheet transcription, against the workbook cells it came from.

`physics/mastersheet.py` is a port of somebody else's model, so the only test
that means anything is whether it reproduces that model's own output. Every
expected value below is a **cell from `reference/mastersheets/`**, quoted with
its address, not a number this project computed.

The Camelot case is `2) Shockloading` rows 1-9 ("Option 2: Main 84" PDA,
Drogue 48" Ringsail"). Its inputs are in the fixture at the top and the
addresses are on each assertion, so a future re-scrape of the workbook can be
diffed against this file line by line.
"""

import math

import pytest

from physics.constants import G0, N_TO_LBF, SQFT_TO_SQM
from physics.mastersheet import (
    DESCENT_0_LAPSE,
    DESCENT_TIME,
    DESCENT_WITH_LAPSE,
    DIAMIN_AREAFT,
    POUND_SLUG,
    SHOCK_LOAD,
    TROP_DENSITY,
    TROP_DESCENT_TIME,
    evaluate,
    terminal_velocity,
)

# --- Camelot "2) Shockloading", Option 2 -----------------------------------
GROUND_FT = 4600.0      # C2
APOGEE_AGL = 10000.0    # C3
MAIN_AGL = 1000.0       # C4
WEIGHT_LB = 55.25       # C5
WIND_FTS = 32.0         # C9
V_DROGUE_FTS = 118.98   # E2, pasted from OpenRocket
DROGUE_D_IN, DROGUE_CD, DROGUE_CX, DROGUE_X = 48.0, 0.85, 1.1, 0.8
MAIN_D_IN, MAIN_CD, MAIN_CX, MAIN_X = 84.0, 2.2, 1.5, 0.5

# The sheet's own lapse/density/temperature triple, passed at every call site.
L, RHO0, T0 = 0.0019812, 0.002377, 288.15

# Six significant figures is what the workbook prints; the transcription
# actually agrees to ~1e-9, but asserting tighter than the source is published
# would be asserting against float noise rather than against the sheet.
REL = 1e-6


def _approx(want):
    return pytest.approx(want, rel=REL)


# --- the four functions the shockloading sheets call ------------------------


@pytest.mark.parametrize("d_in, want", [
    (48.0, 12.56636),        # E4
    (84.0, 38.4844775),      # G4
    (36.0, 7.0685775),       # E14, Option 3
    (30.0, 4.908734375),     # E24, Option 4
    (60.0, 19.6349375),      # G34, "Main 60 PDA"
])
def test_diamin_areaft(d_in, want):
    """Projected area, ft^2. The sheet hard-codes pi as 3.14159, which is why
    30 in gives 4.908734375 and not 4.9087385 -- one part in 1e6, and the
    reason `mastersheet.PI` is not `math.pi`."""
    assert DIAMIN_AREAFT(d_in) == _approx(want)


@pytest.mark.parametrize("alt_ft, want", [
    (14600.0, 0.00151532788),   # C6, apogee + ground
    (5600.0, 0.002011214817),   # C7, main deployment + ground
    (4600.0, 0.002073138232),   # C8, ground
])
def test_trop_density(alt_ft, want):
    assert TROP_DENSITY(alt_ft) == _approx(want)


def test_pound_slug():
    """Defined in both workbooks but never called -- they inline /32.174."""
    assert POUND_SLUG(55.25) == _approx(55.25 / 32.174)


def test_shock_load_reproduces_both_camelot_columns():
    """I3/I4 (drogue) and I5/I6 (main).

    Note the drogue opens at `E2 + C9` -- an OpenRocket velocity plus the wind
    speed added scalar-wise to a vertical speed -- while the main opens at the
    terminal speed under the drogue, evaluated at the main's own density.
    """
    Sd, Sm = DIAMIN_AREAFT(DROGUE_D_IN), DIAMIN_AREAFT(MAIN_D_IN)
    rho_ap = TROP_DENSITY(APOGEE_AGL + GROUND_FT)
    rho_main = TROP_DENSITY(MAIN_AGL + GROUND_FT)

    v_d = V_DROGUE_FTS + WIND_FTS
    assert SHOCK_LOAD(rho_ap, v_d, Sd, DROGUE_CD, DROGUE_CX, 1.0) \
        == _approx(202.9254736)                                      # I3
    assert SHOCK_LOAD(rho_ap, v_d, Sd, DROGUE_CD, DROGUE_CX, DROGUE_X) \
        == _approx(162.3403789)                                      # I4

    v_m = terminal_velocity(WEIGHT_LB, rho_main, Sd, DROGUE_CD)
    assert v_m == _approx(71.7195734)                                # G2
    assert SHOCK_LOAD(rho_main, v_m, Sm, MAIN_CD, MAIN_CX, 1.0) \
        == _approx(656.90625)                                        # I5
    assert SHOCK_LOAD(rho_main, v_m, Sm, MAIN_CD, MAIN_CX, MAIN_X) \
        == _approx(328.453125)                                       # I6


def test_terminal_velocities_and_impact_energy():
    """E8, G8, I2, I7."""
    Sd, Sm = DIAMIN_AREAFT(DROGUE_D_IN), DIAMIN_AREAFT(MAIN_D_IN)
    rho_ap = TROP_DENSITY(APOGEE_AGL + GROUND_FT)
    rho_main = TROP_DENSITY(MAIN_AGL + GROUND_FT)
    rho_g = TROP_DENSITY(GROUND_FT)

    assert terminal_velocity(WEIGHT_LB, rho_ap, Sd, DROGUE_CD) \
        == _approx(82.62540869)                                      # E8
    assert terminal_velocity(WEIGHT_LB, rho_main, Sm, MAIN_CD) \
        == _approx(25.47403677)                                      # G8
    v_land = terminal_velocity(WEIGHT_LB, rho_g, Sm, MAIN_CD)
    assert v_land == _approx(25.09070538)                            # I2
    assert 0.5 * POUND_SLUG(WEIGHT_LB) * v_land ** 2 \
        == _approx(540.5339432)                                      # I7


def test_descent_time_reproduces_e9():
    """E9 = the drogue leg plus the main leg, both in AGL.

    That the altitudes are AGL while `TROP_DENSITY` above is fed AMSL is the
    sheet's inconsistency, reproduced deliberately -- see the next test.
    """
    Sd, Sm = DIAMIN_AREAFT(DROGUE_D_IN), DIAMIN_AREAFT(MAIN_D_IN)
    total = (TROP_DESCENT_TIME(Sd, DROGUE_CD, WEIGHT_LB, APOGEE_AGL, MAIN_AGL,
                               L, RHO0, T0)
             + TROP_DESCENT_TIME(Sm, MAIN_CD, WEIGHT_LB, MAIN_AGL, 0.0,
                                 L, RHO0, T0))
    assert total == _approx(168.0967633)                             # E9


# --- structural facts about the functions, not cell values ------------------


def test_trop_descent_time_is_descent_with_lapse_at_sea_level():
    """The reason descent time ignores field elevation.

    `TROP_DESCENT_TIME` has no reference-altitude parameter because it *is*
    `DESCENT_WITH_LAPSE` with `ref_alt = 0`. The agreement is 2e-6 rather than
    exact because the sheet rounds `6.2558` and `0.010413` independently:
    6.2558*L = 0.01239271 where L + 0.010413 = 0.01239420. Asserting the
    identity at that tolerance is what pins down that they are one derivation
    and not two.
    """
    S = DIAMIN_AREAFT(DROGUE_D_IN)
    a = TROP_DESCENT_TIME(S, DROGUE_CD, WEIGHT_LB, APOGEE_AGL, MAIN_AGL,
                          L, RHO0, T0)
    b = DESCENT_WITH_LAPSE(S, DROGUE_CD, WEIGHT_LB, L, T0, RHO0, 0.0,
                           APOGEE_AGL, MAIN_AGL)
    assert b == pytest.approx(a, rel=5e-6)
    # ...and not exact, which is the part that would silently drift if someone
    # "tidied" the constants to their unrounded values.
    assert b != a


def test_field_elevation_costs_real_descent_time():
    """What the AGL/AMSL mix-up is worth, as a number rather than a remark.

    Same descent, once through the sheet's sea-level-anchored call and once
    with the field at 4600 ft where it belongs. The sheet's answer is the
    **long** one: the real descent happens higher up in thinner air, so the
    vehicle falls faster and lands sooner than the sheet says. 7.4% on this
    leg, and the drift computed from it is overstated by the same factor.
    """
    S = DIAMIN_AREAFT(DROGUE_D_IN)
    as_called = TROP_DESCENT_TIME(S, DROGUE_CD, WEIGHT_LB, APOGEE_AGL,
                                  MAIN_AGL, L, RHO0, T0)
    corrected = DESCENT_WITH_LAPSE(
        S, DROGUE_CD, WEIGHT_LB, L, T0, RHO0, 0.0,
        APOGEE_AGL + GROUND_FT, MAIN_AGL + GROUND_FT)
    assert corrected < as_called
    assert corrected / as_called == pytest.approx(0.9314, abs=1e-3)


def test_descent_time_trailing_term_is_unguarded():
    """The one transcription trap in `DESCENT_TIME`, pinned deliberately.

    Every layer term carries an `IF(max_alt > base, ..., 0)` guard except the
    tropospheric one at the bottom. For a descent that *ends* above 36089 ft
    that term gets `bottom > top` and returns a negative time, which is why
    `DESCENT_TIME(.., 50000, 40000)` is smaller than the isothermal leg alone.

    No flight this tool is for can trigger it -- 36089 ft is 11 km and every
    descent here ends at the ground -- but if someone "tidies" the guard later,
    this test says the behaviour changed on purpose rather than by accident.
    """
    S = DIAMIN_AREAFT(MAIN_D_IN)
    isothermal_only = DESCENT_0_LAPSE(S, MAIN_CD, WEIGHT_LB, 216.65, 7.0612e-4,
                                      36089.0, 50000.0, 40000.0)
    trailing = DESCENT_WITH_LAPSE(S, MAIN_CD, WEIGHT_LB, L, T0, 2.3769e-3,
                                  0.0, 36089.0, 40000.0)
    assert trailing < 0.0
    assert DESCENT_TIME(S, MAIN_CD, WEIGHT_LB, 50000.0, 40000.0) \
        == pytest.approx(isothermal_only + trailing, rel=1e-9)


def test_descent_time_is_continuous_across_a_layer_boundary():
    """`DESCENT_TIME` chains seven layers; the joins must not jump.

    36089 ft is the tropopause and the only boundary a rocket in this project's
    class can reach. Crossing it must cost the same as the two legs summed.
    """
    S = DIAMIN_AREAFT(MAIN_D_IN)
    whole = DESCENT_TIME(S, MAIN_CD, WEIGHT_LB, 40000.0, 30000.0)
    split = (DESCENT_TIME(S, MAIN_CD, WEIGHT_LB, 40000.0, 36089.0)
             + DESCENT_TIME(S, MAIN_CD, WEIGHT_LB, 36089.0, 30000.0))
    assert whole == pytest.approx(split, rel=1e-9)


def test_descent_0_lapse_is_positive_and_monotone():
    """The isothermal branch on its own, so a transcription error there cannot
    hide inside `DESCENT_TIME`'s summation. 36089-65617 ft is isothermal at
    216.65 K in the sheet's table."""
    S = DIAMIN_AREAFT(MAIN_D_IN)
    short = DESCENT_0_LAPSE(S, MAIN_CD, WEIGHT_LB, 216.65, 7.0612e-4,
                            36089.0, 45000.0, 40000.0)
    long_ = DESCENT_0_LAPSE(S, MAIN_CD, WEIGHT_LB, 216.65, 7.0612e-4,
                            36089.0, 50000.0, 40000.0)
    assert 0.0 < short < long_


# --- the SI boundary --------------------------------------------------------


def test_evaluate_round_trips_the_camelot_case_through_si():
    """`evaluate` is the only place units change. Feed it the Camelot vehicle
    in SI and it must land back on the same workbook cells.

    `CdS` goes in as the atomic drag area and comes out as the sheet's
    `area * cd` product -- the sheet never uses the two separately, which is
    what lets our schema (which has no projected diameter) drive it at all.
    """
    ft = 0.3048
    CdS_drogue = DIAMIN_AREAFT(DROGUE_D_IN) * DROGUE_CD * SQFT_TO_SQM
    CdS_main = DIAMIN_AREAFT(MAIN_D_IN) * MAIN_CD * SQFT_TO_SQM
    m_kg = WEIGHT_LB / N_TO_LBF / G0

    res = evaluate(
        phases_si=[
            ("drogue", CdS_drogue, DROGUE_CX, DROGUE_X,
             APOGEE_AGL * ft, MAIN_AGL * ft),
            ("main", CdS_main, MAIN_CX, MAIN_X, MAIN_AGL * ft, 0.0),
        ],
        m_kg=m_kg,
        ground_elev_m=GROUND_FT * ft,
        v_first_ms=V_DROGUE_FTS * ft,
        wind_ms=WIND_FTS * ft,
    )

    assert res.descent_time == _approx(168.0967633)                  # E9
    assert res.impact_velocity / ft == _approx(25.09070538)          # I2
    # I7, in ft-lbf. Looser than the rest at 1e-5, and the reason is the one
    # place SI and the sheet genuinely cannot agree: the sheet divides by a
    # rounded g_c of 32.174 where this round-trip goes through the exact
    # 9.80665 / 0.3048 = 32.17405. Worth 1.5e-6 in mass, and it shows up here
    # because this is the only assertion that carries mass rather than the
    # `area * cd` product.
    assert res.impact_ke * 0.73756214927727 == pytest.approx(540.5339432,
                                                             rel=1e-5)
    assert res.phases[0].F_inf * N_TO_LBF == _approx(202.9254736)    # I3
    assert res.phases[1].F_inf * N_TO_LBF == _approx(656.90625)      # I5
    assert res.phases[0].F_reduced * N_TO_LBF == _approx(162.3403789)  # I4
    assert res.phases[1].F_reduced * N_TO_LBF == _approx(328.453125)   # I6
    assert res.F_peak * N_TO_LBF == _approx(656.90625)
    assert res.governing_device == "main"
    assert res.drift / ft == _approx(168.0967633 * WIND_FTS)         # I8


def test_evaluate_reports_the_unused_layered_descent_time():
    """Their `DESCENT_TIME` answer travels alongside their `TROP_DESCENT_TIME`
    one, so the Cross-check tab can show the gap between what the sheet said
    and what its own never-called function would have said."""
    ft = 0.3048
    res = evaluate(
        phases_si=[
            ("drogue", DIAMIN_AREAFT(DROGUE_D_IN) * DROGUE_CD * SQFT_TO_SQM,
             DROGUE_CX, DROGUE_X, APOGEE_AGL * ft, MAIN_AGL * ft),
            ("main", DIAMIN_AREAFT(MAIN_D_IN) * MAIN_CD * SQFT_TO_SQM,
             MAIN_CX, MAIN_X, MAIN_AGL * ft, 0.0),
        ],
        m_kg=WEIGHT_LB / N_TO_LBF / G0,
        ground_elev_m=GROUND_FT * ft,
        v_first_ms=V_DROGUE_FTS * ft,
    )
    # The layered version places the field at 4600 ft, where the air is
    # thinner, so the vehicle descends FASTER and the honest answer is the
    # shorter one: 156.7 s against the 168.1 s the sheet reported. 6.8% of
    # descent time, and the same 6.8% off every drift number computed from it.
    assert res.descent_time_layered < res.descent_time
    assert res.descent_time_layered == pytest.approx(156.65, abs=0.05)
    # The gap has to travel as a warning, not just as a field nobody reads.
    assert any("layered" in w and "field elevation" in w for w in res.warnings)


def _camelot_result():
    ft = 0.3048
    return evaluate(
        phases_si=[
            ("drogue", DIAMIN_AREAFT(DROGUE_D_IN) * DROGUE_CD * SQFT_TO_SQM,
             DROGUE_CX, DROGUE_X, APOGEE_AGL * ft, MAIN_AGL * ft),
            ("main", DIAMIN_AREAFT(MAIN_D_IN) * MAIN_CD * SQFT_TO_SQM,
             MAIN_CX, MAIN_X, MAIN_AGL * ft, 0.0),
        ],
        m_kg=WEIGHT_LB / N_TO_LBF / G0,
        ground_elev_m=GROUND_FT * ft,
        v_first_ms=V_DROGUE_FTS * ft,
    )


def test_phase_sampling_ends_where_the_closed_form_says():
    """`sample` must agree with `t_descent` and the leg's own endpoints, or the
    curve drawn on the chart is not the model the table is reporting."""
    ft = 0.3048
    for phase in _camelot_result().phases:
        points = phase.sample(n=12)
        assert points[0][0] == pytest.approx(0.0, abs=1e-12)
        assert points[-1][0] == pytest.approx(phase.t_descent, rel=1e-9)
        assert points[0][1] == pytest.approx(phase.z_deploy_ft * ft, rel=1e-12)
        assert points[-1][1] == pytest.approx(phase.z_end_ft * ft, rel=1e-12)
        # Monotone descent, no doubling back.
        zs = [z for _, z, _ in points]
        ts = [t for t, _, _ in points]
        assert zs == sorted(zs, reverse=True)
        assert ts == sorted(ts)


def test_velocity_is_not_constant_within_a_leg():
    """The bug this sampling exists to fix.

    The sheet only ever *reports* terminal velocity at the deployment density,
    which makes it easy to assume the whole leg runs at that speed and draw a
    straight line. It does not: `v_t` goes as `1/sqrt(rho)`, so over Camelot's
    drogue leg -- 10000 ft down to 1000 ft AGL -- the vehicle is **15%** faster
    at the top than the bottom. A chord between the endpoints would show a
    model nobody wrote.
    """
    drogue, main = _camelot_result().phases

    vs = [v for _, _, v in drogue.sample(n=24)]
    assert max(vs) / min(vs) == pytest.approx(1.147, abs=0.005)
    # Fastest at the top, where the air is thinnest.
    assert vs[0] == max(vs)
    assert vs[-1] == min(vs)

    # The main's leg is short and low, so the same effect is an order of
    # magnitude smaller there -- 1.5% against 15%. Checking only the main would
    # have made a straight line look defensible.
    vs_main = [v for _, _, v in main.sample(n=24)]
    assert max(vs_main) / min(vs_main) == pytest.approx(1.015, abs=0.003)


def test_the_curve_satisfies_dz_dt_equals_v():
    """The sampled trajectory has to be a trajectory.

    A curve whose plotted velocity does not integrate to its own time axis is
    not a model of anything, and the mismatch is invisible on a chart. This is
    the assertion that keeps `sample` honest about which of the sheet's two
    contradictory density conventions it followed.
    """
    for phase in _camelot_result().phases:
        points = phase.sample(n=1500)
        total = 0.0
        for (t0, z0, v0), (t1, z1, v1) in zip(points, points[1:]):
            total += abs(z1 - z0) / (0.5 * (v0 + v1))
        assert total == pytest.approx(points[-1][0], rel=1e-4)


def test_the_reported_velocity_does_not_sit_on_the_curve():
    """The sheet's two density conventions, as a number.

    `v_terminal` is cell `E8`: `TROP_DENSITY(AGL + ground)`. The curve follows
    `TROP_DESCENT_TIME`, which gets bare AGL and has no field elevation. Both
    are the sheet's; they disagree by 7.1% at Camelot's 4600 ft pad, and the
    plotted dot therefore sits off the plotted line **on purpose**.

    If this ever starts passing at rel=1e-9, someone has quietly reconciled the
    two and the chart is no longer showing what the workbook does.
    """
    drogue = _camelot_result().phases[0]
    on_curve = drogue.sample(n=8)[0][2]

    assert on_curve != pytest.approx(drogue.v_terminal, rel=1e-3)
    assert on_curve / drogue.v_terminal == pytest.approx(0.929, abs=0.003)
    # The curve is the slower one: bare AGL puts the vehicle in denser air.
    assert on_curve < drogue.v_terminal


def test_holding_velocity_constant_would_break_their_descent_time():
    """Why the slope has to be drawn at all.

    The sheet reports one velocity per leg, so a flat line looks defensible.
    It is not: freeze `v_t` at the deployment value and Camelot's drogue leg
    comes out 13% short of the descent time the sheet itself reports. The
    variation is load-bearing inside their own function.
    """
    S = DIAMIN_AREAFT(DROGUE_D_IN) * DROGUE_CD
    integrated = TROP_DESCENT_TIME(S, 1.0, WEIGHT_LB, APOGEE_AGL, MAIN_AGL,
                                   L, RHO0, T0)
    v_flat = terminal_velocity(WEIGHT_LB, TROP_DENSITY(APOGEE_AGL + GROUND_FT),
                               S, 1.0)
    flat = (APOGEE_AGL - MAIN_AGL) / v_flat
    assert flat / integrated == pytest.approx(0.866, abs=0.005)


def test_evaluate_rejects_an_empty_canopy_list():
    with pytest.raises(ValueError, match="at least one canopy"):
        evaluate([], m_kg=25.0, ground_elev_m=630.0, v_first_ms=30.0)


# --- LE3 "2) 3 Parachute Shockloading", Option 1 ----------------------------
#
# A second vehicle through the same functions, so a transcription error that
# happened to be invisible at Camelot's altitude and mass has somewhere else to
# show up. Ground 2050 ft, apogee 10000 ft AGL, 161 lb, 22 ft/s wind, drogue
# 60" / main 1 84" / main 2 144", all Cd 2.2, Cx 1.5, X 0.5.

LE3_GROUND_FT = 2050.0    # C17
LE3_WEIGHT_LB = 161.0     # C21
LE3_WIND_FTS = 22.0       # C26
LE3_V_DROGUE = 100.0      # E17


def test_le3_drogue_and_descent_time():
    """The cells of the LE3 sheet that ARE internally consistent."""
    Sd = DIAMIN_AREAFT(60.0) * 2.2
    S1 = DIAMIN_AREAFT(84.0) * 2.2

    assert TROP_DENSITY(10000.0 + LE3_GROUND_FT) == _approx(0.001645058263)  # C22
    assert TROP_DENSITY(3000.0 + LE3_GROUND_FT) == _approx(0.002045094875)   # C23
    assert TROP_DENSITY(1200.0 + LE3_GROUND_FT) == _approx(0.002159036242)   # C24

    rho_ap = TROP_DENSITY(10000.0 + LE3_GROUND_FT)
    assert SHOCK_LOAD(rho_ap, LE3_V_DROGUE + LE3_WIND_FTS, Sd, 1.0, 1.5, 1.0) \
        == _approx(793.2579126)                                              # K18

    rho_m1 = TROP_DENSITY(3000.0 + LE3_GROUND_FT)
    assert terminal_velocity(LE3_WEIGHT_LB, rho_m1, Sd, 1.0) \
        == _approx(60.37332622)                                              # G17

    total = (TROP_DESCENT_TIME(DIAMIN_AREAFT(60.0), 2.2, LE3_WEIGHT_LB,
                               10000.0, 3000.0, L, RHO0, T0)
             + TROP_DESCENT_TIME(DIAMIN_AREAFT(84.0), 2.2, LE3_WEIGHT_LB,
                                 3000.0, 0.0, L, RHO0, T0))
    assert total == _approx(186.8076409)                                     # E24


def test_le3_three_canopy_columns_are_not_a_consistent_chain():
    """Why `evaluate` does not reproduce the LE3 sheet's third canopy.

    The 3-parachute sheet is a partially-edited copy of the 2-parachute
    template, and three cells did not get updated. Pinned here as arithmetic,
    because "the sheet is a bit muddled" is not something anyone can act on:

      * `K20`, main 1's opening load, is evaluated at `C24` -- the density at
        **main 2's** altitude, 1800 ft lower -- while using main 1's own
        velocity and area. Worth +5.6%.
      * `K17`, the landing speed, uses **main 1's** area even though main 2 is
        the canopy actually on the vehicle at touchdown. Worth 1.71x on speed
        and 2.9x on impact energy, in the conservative direction -- it would
        have them fail a 36 ft/s landing limit they actually pass.
      * `E24`, the descent time, integrates only the drogue and main 1 legs.
        Main 2 is not in it at all.

    `_phase_chain` implements the 2-canopy sheet's rule (each canopy opens at
    terminal under the previous one), which Camelot and LE3's drogue and main 1
    both follow exactly. It deliberately does NOT reproduce these three.
    """
    Sd = DIAMIN_AREAFT(60.0) * 2.2
    S1 = DIAMIN_AREAFT(84.0) * 2.2
    S2 = DIAMIN_AREAFT(144.0) * 2.2
    rho_m1 = TROP_DENSITY(3000.0 + LE3_GROUND_FT)
    rho_m2 = TROP_DENSITY(1200.0 + LE3_GROUND_FT)
    rho_g = TROP_DENSITY(LE3_GROUND_FT)
    v_m1 = terminal_velocity(LE3_WEIGHT_LB, rho_m1, Sd, 1.0)

    as_written = SHOCK_LOAD(rho_m2, v_m1, S1, 1.0, 1.5, 1.0)
    consistent = SHOCK_LOAD(rho_m1, v_m1, S1, 1.0, 1.5, 1.0)
    assert as_written == _approx(499.7118848)                                # K20
    assert consistent == pytest.approx(473.34, abs=0.05)
    assert as_written / consistent == pytest.approx(1.056, abs=0.002)

    sheet_landing = terminal_velocity(LE3_WEIGHT_LB, rho_g, S1, 1.0)
    real_landing = terminal_velocity(LE3_WEIGHT_LB, rho_g, S2, 1.0)
    assert sheet_landing == _approx(41.22659979)                             # K17
    assert real_landing == pytest.approx(24.05, abs=0.01)
    assert (sheet_landing / real_landing) ** 2 == pytest.approx(2.94, abs=0.02)
