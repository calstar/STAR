"""The injector face has finite real estate, and the optimizer must respect it.

Until these constraints existed, WHERE the doublet ring pair sat radially was an exactly
flat direction in the Layer-1 objective: ``_layer1_derive_fuel_spacing`` solves the fuel
pitch so the standoff hits its target, and it does so by fixing the ring GAP, so ``dr`` is
independent of ``s_O`` and the pair slides radially at zero cost. ``s_O`` fell onto its own
lower bound (0.003 m).

Measured on configs/ethalox_8kN_FINAL.yaml before the fix:

    D_pitch_O   26.90 mm      (28 holes at a 3.018 mm pitch -- a 1.44 mm web)
    D_pitch_F   88.01 mm
    impingement 41.79 mm circle, inside a 127.00 mm bore and NARROWER THAN THE
                49.57 mm THROAT -- 10.8 % of the chamber area was fed directly
    centre      24.83 mm clear, against 27.15 mm needed for a 3/8-18 NPT igniter boss

None of that violated a single constraint, because none of those constraints existed.
"""
import math
import numpy as np
import pytest

from engine.optimizer.layers.layer1_static_optimization import (
    _impinging_ring_geometry_squared,
    _impinging_hard_geometry_blocks_eval,
)

# The shipped FINAL design, in SI.
FINAL = dict(
    n_elements=28.0,
    spacing_O_m=0.0030182972100858507,
    spacing_F_m=0.009875029755263455,
    d_jet_O_m=0.0015821116699998301,
    d_jet_F_m=0.001375132476863662,
    D_chamber_inner_m=0.127,
    angle_O_deg=40.0,
    angle_F_deg=69.0,
)
IGNITER_BOSS_M = 0.0280          # 3/8-18 NPT: 17.15 mm thread crest + ~5 mm wall each side


def _dp(n, s):
    return n * s / math.pi


# ---------------------------------------------------------------------------------------
# Centre clearance
# ---------------------------------------------------------------------------------------

def test_shipped_design_has_no_room_for_the_igniter():
    """Documents the defect: the FINAL face cannot take a 3/8 NPT boss."""
    half_major = 0.5 * FINAL["d_jet_O_m"] / math.cos(math.radians(FINAL["angle_O_deg"]))
    inner_edge = 0.5 * _dp(FINAL["n_elements"], FINAL["spacing_O_m"]) - half_major
    assert 2 * inner_edge < IGNITER_BOSS_M, "fixture stale: FINAL now clears the boss"


def test_centre_clearance_penalises_the_shipped_design():
    free = _impinging_ring_geometry_squared(**FINAL, center_clear_dia_m=0.0)
    held = _impinging_ring_geometry_squared(**FINAL, center_clear_dia_m=IGNITER_BOSS_M)
    assert held > free, "reserving the centre circle must cost the shipped layout something"


def test_centre_clearance_is_free_once_the_ring_moves_out():
    """Same design, LOX ring opened to a 60 mm pitch circle: the term must go to zero."""
    moved = dict(FINAL)
    moved["spacing_O_m"] = math.pi * 0.060 / FINAL["n_elements"]
    moved["spacing_F_m"] = moved["spacing_O_m"] + (
        FINAL["spacing_F_m"] - FINAL["spacing_O_m"])      # same ring gap => same standoff
    base = _impinging_ring_geometry_squared(**moved, center_clear_dia_m=0.0)
    held = _impinging_ring_geometry_squared(**moved, center_clear_dia_m=IGNITER_BOSS_M)
    assert held == pytest.approx(base), "a ring well clear of the boss must pay nothing"


def test_centre_clearance_hard_blocks_the_shipped_design():
    kw = dict(
        d_jet_O=FINAL["d_jet_O_m"], d_jet_F=FINAL["d_jet_F_m"],
        sp_O=FINAL["spacing_O_m"], sp_F=FINAL["spacing_F_m"],
        D_chamber_inner=FINAL["D_chamber_inner_m"],
        D_throat_check=0.0496, A_chamber_check=0.012668, A_throat_check=0.00193,
        n_elements=FINAL["n_elements"],
        angle_O_deg=FINAL["angle_O_deg"], angle_F_deg=FINAL["angle_F_deg"],
    )
    assert _impinging_hard_geometry_blocks_eval(**kw) is False, "FINAL was accepted before"
    assert _impinging_hard_geometry_blocks_eval(**kw, center_clear_dia_m=IGNITER_BOSS_M) is True


# ---------------------------------------------------------------------------------------
# The elliptical face trace
# ---------------------------------------------------------------------------------------

def test_radial_extent_uses_the_ellipse_not_the_drill_diameter():
    """A hole inclined theta from the axis prints as an ellipse of major axis d/cos(theta).

    At 69 deg that is 2.79x the drill diameter. Using d would under-state the radial reach
    of every orifice, which is exactly the number the clearance terms are made of.
    """
    d, bore = 0.001375, 0.127
    n, sp = 28.0, math.pi * 0.030 / 28.0            # 30 mm pitch circle, fuel INBOARD
    kw = dict(n_elements=n, spacing_O_m=math.pi * 0.090 / n, spacing_F_m=sp,
              d_jet_O_m=0.0015821, d_jet_F_m=d, D_chamber_inner_m=bore,
              angle_O_deg=40.0, ring_order_fuel_outboard=False)
    # Clear circle sized to sit exactly between the round diameter and the ellipse.
    edge_round = 0.5 * 0.030 - 0.5 * d
    edge_ellipse = 0.5 * 0.030 - 0.5 * d / math.cos(math.radians(69.0))
    clear = 2 * 0.5 * (edge_round + edge_ellipse)
    assert edge_ellipse < 0.5 * clear < edge_round
    # Isolate the clearance term: theta_F also moves tan_sum, hence L_imp, hence the standoff
    # term, which is ~1e5 larger. Difference the same angle against its own zero-clearance run.
    def _clearance_only(theta_F_deg):
        with_c = _impinging_ring_geometry_squared(
            **kw, angle_F_deg=theta_F_deg, center_clear_dia_m=clear)
        without = _impinging_ring_geometry_squared(
            **kw, angle_F_deg=theta_F_deg, center_clear_dia_m=0.0)
        return with_c - without

    steep, shallow = _clearance_only(69.0), _clearance_only(5.0)
    assert shallow == pytest.approx(0.0, abs=1e-15), (
        "a nearly-axial hole prints ~round, so its edge clears the circle and it pays nothing"
    )
    assert steep > 0.0, (
        "a 69 deg hole reaches 2.79x further radially than its drill diameter; the clearance "
        "term must see that"
    )


# ---------------------------------------------------------------------------------------
# Web
# ---------------------------------------------------------------------------------------

def test_web_floor_catches_a_land_thinner_than_asked():
    """spacing >= d_jet alone permits a web of exactly zero."""
    web = FINAL["spacing_O_m"] - FINAL["d_jet_O_m"]
    assert web == pytest.approx(0.001436, abs=1e-5), "fixture stale"
    assert _impinging_ring_geometry_squared(**FINAL, min_web_m=0.001) == pytest.approx(
        _impinging_ring_geometry_squared(**FINAL, min_web_m=0.0)), "1.0 mm floor is met"
    assert _impinging_ring_geometry_squared(**FINAL, min_web_m=0.002) > \
        _impinging_ring_geometry_squared(**FINAL, min_web_m=0.0), "2.0 mm floor is not"


def test_web_floor_hard_blocks():
    kw = dict(
        d_jet_O=FINAL["d_jet_O_m"], d_jet_F=FINAL["d_jet_F_m"],
        sp_O=FINAL["spacing_O_m"], sp_F=FINAL["spacing_F_m"],
        D_chamber_inner=FINAL["D_chamber_inner_m"],
        D_throat_check=0.0496, A_chamber_check=0.012668, A_throat_check=0.00193,
        n_elements=FINAL["n_elements"],
        angle_O_deg=FINAL["angle_O_deg"], angle_F_deg=FINAL["angle_F_deg"],
    )
    assert _impinging_hard_geometry_blocks_eval(**kw, min_web_m=0.001) is False
    assert _impinging_hard_geometry_blocks_eval(**kw, min_web_m=0.002) is True


# ---------------------------------------------------------------------------------------
# Wall clearance
# ---------------------------------------------------------------------------------------

def test_wall_clearance_costs_a_ring_crowding_the_bore():
    crowd = dict(FINAL)
    crowd["spacing_F_m"] = math.pi * 0.120 / FINAL["n_elements"]   # 120 mm ring in a 127 bore
    assert _impinging_ring_geometry_squared(**crowd, wall_clearance_m=0.008) > \
        _impinging_ring_geometry_squared(**crowd, wall_clearance_m=0.0)
    # 88 mm ring in a 127 bore has 17.6 mm of land -- 8 mm must be free
    assert _impinging_ring_geometry_squared(**FINAL, wall_clearance_m=0.008) == pytest.approx(
        _impinging_ring_geometry_squared(**FINAL, wall_clearance_m=0.0))


# ---------------------------------------------------------------------------------------
# Defaults must not move
# ---------------------------------------------------------------------------------------

def test_unset_keys_change_nothing():
    """CLAUDE.md: new physics is opt-in and defaults to the previous behaviour, exactly."""
    base = _impinging_ring_geometry_squared(**FINAL)
    assert _impinging_ring_geometry_squared(
        **FINAL, center_clear_dia_m=0.0, min_web_m=0.0, wall_clearance_m=0.0
    ) == pytest.approx(base)
    kw = dict(
        d_jet_O=FINAL["d_jet_O_m"], d_jet_F=FINAL["d_jet_F_m"],
        sp_O=FINAL["spacing_O_m"], sp_F=FINAL["spacing_F_m"],
        D_chamber_inner=FINAL["D_chamber_inner_m"],
        D_throat_check=0.0496, A_chamber_check=0.012668, A_throat_check=0.00193,
        n_elements=FINAL["n_elements"],
    )
    assert _impinging_hard_geometry_blocks_eval(**kw) is False


# ---------------------------------------------------------------------------------------
# Machining: face incidence
# ---------------------------------------------------------------------------------------

def test_face_incidence_blocks_a_jet_the_drill_cannot_start():
    """theta is from the AXIS, so the drill meets the face at (90 - theta).

    The shipped FINAL put the fuel jet at 69 deg -- 21 deg of incidence. A twist drill
    entering a flat that shallow walks off the spot.
    """
    kw = dict(
        d_jet_O=FINAL["d_jet_O_m"], d_jet_F=FINAL["d_jet_F_m"],
        sp_O=FINAL["spacing_O_m"], sp_F=FINAL["spacing_F_m"],
        D_chamber_inner=FINAL["D_chamber_inner_m"],
        D_throat_check=0.0496, A_chamber_check=0.012668, A_throat_check=0.00193,
        n_elements=FINAL["n_elements"],
        angle_O_deg=FINAL["angle_O_deg"], angle_F_deg=FINAL["angle_F_deg"],
    )
    assert _impinging_hard_geometry_blocks_eval(**kw) is False, "inert when unset"
    assert _impinging_hard_geometry_blocks_eval(**kw, min_face_incidence_deg=20.0) is False, \
        "21 deg of incidence clears a 20 deg floor"
    assert _impinging_hard_geometry_blocks_eval(**kw, min_face_incidence_deg=40.0) is True, \
        "21 deg of incidence must not clear a 40 deg floor"


def test_face_incidence_passes_the_replacement_design():
    """40 / 49 deg -> 50 / 41 deg of incidence, both above a 40 deg floor."""
    assert _impinging_hard_geometry_blocks_eval(
        d_jet_O=0.0016380, d_jet_F=0.0014330,
        sp_O=0.0090639037305711, sp_F=0.0119080988215582,
        D_chamber_inner=0.127, D_throat_check=0.0488,
        A_chamber_check=0.012668, A_throat_check=0.00187,
        n_elements=27.0, angle_O_deg=40.0, angle_F_deg=49.0,
        center_clear_dia_m=0.0381, min_web_m=0.002, wall_clearance_m=0.008,
        min_face_incidence_deg=40.0,
    ) is False


# ---------------------------------------------------------------------------------------
# The tilt allowance must follow the geometry, not sit still while it moves
# ---------------------------------------------------------------------------------------

from engine.optimizer.layers.layer1_static_optimization import (  # noqa: E402
    _resultant_tilt_breakeven_deg,
    _resolve_tilt_allowance_deg,
)

SHIP = dict(n_elements=27.0, spacing_O_m=0.0090639037305711,
            spacing_F_m=0.0119080988215582, angle_O_deg=40.0, angle_F_deg=49.0,
            D_chamber_inner_m=0.127, L_chamber_m=0.15340)


def test_breakeven_is_where_the_fan_arrives_at_the_throat_plane():
    be = _resultant_tilt_breakeven_deg(**SHIP)
    r_imp = 0.5 * 0.08821                      # from the emitted design
    assert math.degrees(math.atan2(0.0635 - r_imp, SHIP["L_chamber_m"])) == pytest.approx(be, abs=0.05)
    # and a fan at exactly that angle lands exactly one chamber length downstream
    assert (0.0635 - r_imp) / math.tan(math.radians(be)) == pytest.approx(SHIP["L_chamber_m"], rel=2e-3)


def test_derived_allowance_tracks_the_impingement_radius():
    """A ring pair further out has less room, so it must be allowed less tilt."""
    near = _resultant_tilt_breakeven_deg(**SHIP)
    out = dict(SHIP)
    out["spacing_O_m"] *= 1.25                  # push both rings outward
    out["spacing_F_m"] *= 1.25
    far = _resultant_tilt_breakeven_deg(**out)
    assert far < near, "a ring closer to the liner must earn a smaller allowance"
    a_near = _resolve_tilt_allowance_deg(from_reach=True, constant_deg=6.0,
                                         breakeven_deg=near, margin=1.5)
    a_far = _resolve_tilt_allowance_deg(from_reach=True, constant_deg=6.0,
                                        breakeven_deg=far, margin=1.5)
    assert a_far < a_near < near, "the margin must cut the allowance below break-even"


def test_margin_means_chamber_lengths():
    """margin = 1.5 => the fan reaches the liner at 1.5 chamber lengths, not 1.0."""
    be = _resultant_tilt_breakeven_deg(**SHIP)
    allowed = _resolve_tilt_allowance_deg(from_reach=True, constant_deg=0.0,
                                          breakeven_deg=be, margin=1.5)
    r_imp = 0.5 * 0.08821
    reach = (0.0635 - r_imp) / math.tan(math.radians(allowed))
    assert reach == pytest.approx(1.5 * SHIP["L_chamber_m"], rel=5e-3)


def test_derived_mode_is_opt_in_and_falls_back_safely():
    """CLAUDE.md: defaults to the previous behaviour, exactly."""
    assert _resolve_tilt_allowance_deg(
        from_reach=False, constant_deg=6.0, breakeven_deg=7.21, margin=1.5) == 6.0
    # degenerate geometry must not silently forbid every candidate
    for bad in (float("nan"), 0.0, -3.0):
        assert _resolve_tilt_allowance_deg(
            from_reach=True, constant_deg=6.0, breakeven_deg=bad, margin=1.5) == 6.0


# ---------------------------------------------------------------------------------------
# Where the propellant actually lands
# ---------------------------------------------------------------------------------------

EQUAL_AREA = 1.0 / math.sqrt(2.0)          # splits the chamber cross-section in half


def _r_imp(kw):
    n = kw["n_elements"]
    dpo, dpf = n * kw["spacing_O_m"] / math.pi, n * kw["spacing_F_m"] / math.pi
    tan_sum = math.tan(math.radians(kw["angle_O_deg"])) + math.tan(math.radians(kw["angle_F_deg"]))
    L = 0.5 * abs(dpo - dpf) / tan_sum
    th_in = kw["angle_O_deg"] if dpo <= dpf else kw["angle_F_deg"]
    return 0.5 * min(dpo, dpf) + L * math.tan(math.radians(th_in))


def test_the_shipped_bug_is_a_third_of_the_way_out():
    """FINAL put every element on a circle at 0.33 of the bore radius."""
    assert _r_imp(FINAL) / (0.5 * FINAL["D_chamber_inner_m"]) == pytest.approx(0.329, abs=0.005)


def test_spray_radius_term_is_inert_unless_asked():
    base = _impinging_ring_geometry_squared(**FINAL)
    assert _impinging_ring_geometry_squared(**FINAL, spray_radius_frac=0.0) == pytest.approx(base)


def test_spray_radius_penalises_a_core_jet():
    """0.33 of the radius is 10.8 % of the area -- it must cost something against 0.707."""
    free = _impinging_ring_geometry_squared(**FINAL)
    held = _impinging_ring_geometry_squared(**FINAL, spray_radius_frac=EQUAL_AREA)
    assert held > free


def test_spray_radius_is_free_inside_the_band():
    """A ring pair at the equal-area radius must pay exactly nothing."""
    kw = dict(FINAL)
    # slide BOTH rings out together: same gap, same standoff, same L/d -- only the radius moves
    target_r = EQUAL_AREA * 0.5 * FINAL["D_chamber_inner_m"]
    shift = target_r - _r_imp(FINAL)
    d_spacing = 2.0 * shift * math.pi / FINAL["n_elements"]
    kw["spacing_O_m"] = FINAL["spacing_O_m"] + d_spacing
    kw["spacing_F_m"] = FINAL["spacing_F_m"] + d_spacing
    assert _r_imp(kw) / (0.5 * kw["D_chamber_inner_m"]) == pytest.approx(EQUAL_AREA, abs=1e-6)
    base = _impinging_ring_geometry_squared(**kw)
    held = _impinging_ring_geometry_squared(**kw, spray_radius_frac=EQUAL_AREA)
    assert held == pytest.approx(base), "on target must be free"


def test_spray_radius_band_has_width():
    """Just outside the band costs; just inside does not."""
    def at(frac_target, tol):
        return _impinging_ring_geometry_squared(
            **FINAL, spray_radius_frac=frac_target, spray_radius_tol=tol)
    base = _impinging_ring_geometry_squared(**FINAL)
    actual = _r_imp(FINAL) / (0.5 * FINAL["D_chamber_inner_m"])   # 0.329
    assert at(actual + 0.05, 0.08) == pytest.approx(base), "inside the band is free"
    assert at(actual + 0.20, 0.08) > base, "outside the band is not"


def test_spray_radius_is_hard_not_merely_priced():
    """The soft term cost 1.5 points against an objective of ~2690, so every seed bought a
    spray circle outside its own declared band. Hard, like ring fit."""
    kw = dict(
        d_jet_O=FINAL["d_jet_O_m"], d_jet_F=FINAL["d_jet_F_m"],
        sp_O=FINAL["spacing_O_m"], sp_F=FINAL["spacing_F_m"],
        D_chamber_inner=FINAL["D_chamber_inner_m"],
        D_throat_check=0.0496, A_chamber_check=0.012668, A_throat_check=0.00193,
        n_elements=FINAL["n_elements"],
        angle_O_deg=FINAL["angle_O_deg"], angle_F_deg=FINAL["angle_F_deg"],
    )
    assert _impinging_hard_geometry_blocks_eval(**kw) is False, "inert when unset"
    # FINAL sits at 0.329 of the bore radius; the equal-area target is 0.707
    assert _impinging_hard_geometry_blocks_eval(
        **kw, spray_radius_frac=EQUAL_AREA, spray_radius_tol=0.08) is True
    # a band wide enough to contain it must let it through
    assert _impinging_hard_geometry_blocks_eval(
        **kw, spray_radius_frac=EQUAL_AREA, spray_radius_tol=0.40) is False


def test_both_optimizer_paths_enforce_the_same_face_limits():
    """A limit only one path applies is not a limit.

    The serial loop's _impinging_hard_geometry_blocks_eval never ran in the parallel CMA
    workers, where essentially every candidate is scored. Two of three seeds converged
    outside their own declared spray-radius band and reported ALL GATES PASS.
    """
    import inspect
    from engine.optimizer.layers import layer1_static_optimization as L1
    src = inspect.getsource(L1)
    worker = src[src.index("def _compute_objective_value"):]
    worker = worker[:worker.index("\ndef ", 10)]
    assert "_impinging_face_infeasibility_terms(" in worker, (
        "_compute_objective_value does not apply the face limits; the parallel workers "
        "would score a violating candidate as feasible"
    )
    for key in ("layer1_injector_spray_radius_frac", "layer1_injector_center_clear_dia_m",
                "layer1_injector_wall_clearance_m", "layer1_injector_min_web_m"):
        assert key in worker, f"worker path never reads {key}"


def test_face_infeasibility_is_graded_not_binary():
    """A binary block puts the whole violating region on one flat 1e6 plateau.

    Measured: with `infeasibility_score += 1.0`, 2 of 3 seeds never found the feasible set
    at all (converged O/F 2.09 and 25.6 against a 1.65 target). The term must carry a
    gradient pointing back toward the band.
    """
    from engine.optimizer.layers.layer1_static_optimization import (
        _impinging_face_infeasibility_terms,
    )
    base = dict(
        n_elements=FINAL["n_elements"], spacing_O_m=FINAL["spacing_O_m"],
        spacing_F_m=FINAL["spacing_F_m"], d_jet_O_m=FINAL["d_jet_O_m"],
        d_jet_F_m=FINAL["d_jet_F_m"], D_chamber_inner_m=FINAL["D_chamber_inner_m"],
        angle_O_deg=FINAL["angle_O_deg"], angle_F_deg=FINAL["angle_F_deg"],
    )
    assert _impinging_face_infeasibility_terms(**base) == 0.0, "inert when nothing is declared"

    # Walk the ring pair outward toward the target. Declare ONLY the spray band, so the
    # monotonicity claim is about that term and is not confounded by the wall-clearance term
    # taking over once the outer ring runs out of chamber (which it correctly does).
    scores = []
    for mult in (1.0, 1.4, 1.8, 2.2):
        kw = dict(base)
        kw["spacing_O_m"] = FINAL["spacing_O_m"] * mult
        kw["spacing_F_m"] = FINAL["spacing_F_m"] + (kw["spacing_O_m"] - FINAL["spacing_O_m"])
        scores.append(_impinging_face_infeasibility_terms(
            **kw, spray_radius_frac=EQUAL_AREA, spray_radius_tol=0.08))
    assert scores[0] > 0.0, "the shipped bug must register as infeasible"
    for a, b in zip(scores, scores[1:]):
        assert b < a, f"no gradient: {scores} -- CMA cannot descend a flat plateau"


def test_face_terms_compete_rather_than_cancel():
    """Pushing the rings out to hit the spray target must not smuggle them past the wall.

    At a fixed ring GAP, sliding the pair out far enough to reach the equal-area radius puts
    the fuel ring at 136 mm on a 127 mm bore. The spray term is then satisfied and the wall
    term is not, and the total must rise -- the sum is a constraint set, not a score to game.
    """
    from engine.optimizer.layers.layer1_static_optimization import (
        _impinging_face_infeasibility_terms,
    )
    kw = dict(
        n_elements=FINAL["n_elements"], d_jet_O_m=FINAL["d_jet_O_m"],
        d_jet_F_m=FINAL["d_jet_F_m"], D_chamber_inner_m=FINAL["D_chamber_inner_m"],
        angle_O_deg=FINAL["angle_O_deg"], angle_F_deg=FINAL["angle_F_deg"],
    )
    kw["spacing_O_m"] = FINAL["spacing_O_m"] * 2.8
    kw["spacing_F_m"] = FINAL["spacing_F_m"] + (kw["spacing_O_m"] - FINAL["spacing_O_m"])
    assert _r_imp(dict(kw, spacing_O_m=kw["spacing_O_m"], spacing_F_m=kw["spacing_F_m"])) \
        / (0.5 * kw["D_chamber_inner_m"]) == pytest.approx(EQUAL_AREA, abs=0.01)
    spray_only = _impinging_face_infeasibility_terms(
        **kw, spray_radius_frac=EQUAL_AREA, spray_radius_tol=0.08)
    with_wall = _impinging_face_infeasibility_terms(
        **kw, spray_radius_frac=EQUAL_AREA, spray_radius_tol=0.08, wall_clearance_m=0.008)
    assert spray_only == pytest.approx(0.0, abs=1e-12), "on the spray target"
    # fuel ring at 136.43 mm + a 1.92 mm elliptical half-trace = 70.13 mm of radius, 8 mm of
    # land wanted, against a 63.50 mm bore radius: (70.13 + 8 - 63.50)/127 = 0.1152, squared.
    assert with_wall == pytest.approx(0.01328, rel=1e-3), (
        "the fuel ring is 14.6 mm outside where the wall land allows, and that must be what "
        "the total reports once the spray term is satisfied")
    assert with_wall > spray_only


def test_face_infeasibility_zero_for_the_shipped_design():
    from engine.optimizer.layers.layer1_static_optimization import (
        _impinging_face_infeasibility_terms,
    )
    import yaml as _yaml
    c = _yaml.safe_load(open("configs/ethalox_8kN_SHIP.yaml"))
    g = c["injector"]["geometry"]
    assert _impinging_face_infeasibility_terms(
        n_elements=float(g["oxidizer"]["n_elements"]),
        spacing_O_m=g["oxidizer"]["spacing"], spacing_F_m=g["fuel"]["spacing"],
        d_jet_O_m=g["oxidizer"]["d_jet"], d_jet_F_m=g["fuel"]["d_jet"],
        D_chamber_inner_m=c["chamber_geometry"]["chamber_diameter"],
        angle_O_deg=g["oxidizer"]["impingement_angle"],
        angle_F_deg=g["fuel"]["impingement_angle"],
        center_clear_dia_m=0.0381, min_web_m=0.002, wall_clearance_m=0.008,
        spray_radius_frac=0.7071, spray_radius_tol=0.08,
    ) == 0.0, "the shipped design must violate none of its own declared face limits"
