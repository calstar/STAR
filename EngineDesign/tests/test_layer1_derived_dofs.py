"""Guards for the Layer-1 DOFs that are solved rather than searched.

``expansion_ratio`` and ``A_throat`` are determined by requirements the user
already stated (expand to ambient; hit the thrust target), so Layer 1 solves
them and collapses their CMA-ES bounds. These tests pin the parts that are easy
to break silently:

  * the closed-form expansion-ratio inversion actually reproduces the target
    exit pressure when pushed back through the isentropic relation;
  * the solver respects its clamps and degrades safely on nonsense input;
  * both toggles are real config fields, so the frontend checkboxes reach the
    optimizer instead of being dropped by the schema.
"""
from __future__ import annotations

import numpy as np
import pytest

from engine.optimizer.layers.layer1_static_optimization import (
    _layer1_eps_for_exit_pressure,
    _layer1_solve_derived_geometry,
    _requirement_bool,
)
from engine.pipeline.config_schemas import DesignRequirementsConfig

PSI = 6894.76


def _exit_pressure_from_eps(eps: float, Pc: float, gamma: float) -> float:
    """Invert the area-ratio relation numerically: eps -> Pe.

    Deliberately independent of the production formula so this is a real check
    and not a restatement of the code under test.
    """
    g = gamma

    def area_ratio(M: float) -> float:
        return (1.0 / M) * (
            (2.0 / (g + 1.0)) * (1.0 + 0.5 * (g - 1.0) * M * M)
        ) ** ((g + 1.0) / (2.0 * (g - 1.0)))

    lo, hi = 1.0 + 1e-9, 50.0
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if area_ratio(mid) < eps:
            lo = mid
        else:
            hi = mid
    M = 0.5 * (lo + hi)
    return Pc / (1.0 + 0.5 * (g - 1.0) * M * M) ** (g / (g - 1.0))


@pytest.mark.parametrize("Pc_psi", [200.0, 395.6, 450.0, 700.0])
@pytest.mark.parametrize("gamma", [1.10, 1.1367, 1.20])
def test_derived_eps_reproduces_target_exit_pressure(Pc_psi, gamma):
    Pc = Pc_psi * PSI
    Pe_target = 13.6436 * PSI

    eps = _layer1_eps_for_exit_pressure(Pc, gamma, Pe_target)
    assert eps is not None and eps > 1.0

    Pe_actual = _exit_pressure_from_eps(eps, Pc, gamma)
    # Exact by construction; the tolerance only covers the bisection above.
    assert Pe_actual == pytest.approx(Pe_target, rel=1e-6)


def test_derived_eps_rejects_unphysical_inputs():
    Pe = 13.6 * PSI
    # Chamber below ambient, zero/negative pressures, and a gamma outside the
    # ideal-gas range must all decline rather than return a garbage area ratio.
    assert _layer1_eps_for_exit_pressure(0.5 * Pe, 1.2, Pe) is None
    assert _layer1_eps_for_exit_pressure(-1.0, 1.2, Pe) is None
    assert _layer1_eps_for_exit_pressure(400 * PSI, 1.2, 0.0) is None
    assert _layer1_eps_for_exit_pressure(400 * PSI, 0.9, Pe) is None
    assert _layer1_eps_for_exit_pressure(400 * PSI, float("nan"), Pe) is None


def test_solver_clamps_to_search_range_when_target_unreachable():
    """An unreachable thrust target must clamp to the bound, not run away.

    The residual is then carried by the ordinary thrust penalty, which the
    infeasibility gradient can still descend.
    """
    x = np.array([1.5e-3, 1.0, 5.0, 0.15, 20, 2e-3, 45.0, 5e-3,
                  1.7e-3, 45.0, 5e-3, 550.0, 550.0], dtype=float)
    at_lo, at_hi = 1.0e-3, 2.0e-3
    constants = {
        "layer1_derive_expansion_ratio": False,
        "layer1_derive_throat_from_thrust": True,
        "layer1_derive_max_iters": 6,
        "derive_At_min": at_lo,
        "derive_At_max": at_hi,
        "derive_eps_min": 2.0,
        "derive_eps_max": 20.0,
        "P_ambient": 13.6 * PSI,
        # Absurd target: no throat area in range can deliver this.
        "target_thrust": 1.0e9,
        "max_nozzle_exit": 0.2,
        "TOTAL_WALL_THICKNESS_M": 0.006,
    }

    class _Cfg:
        chamber_geometry = None
        chamber = None
        nozzle = None
        combustion = type("C", (), {})()

    calls = {"n": 0}

    def _evaluate():
        calls["n"] += 1
        return {"F": 7000.0, "Pc": 400 * PSI, "gamma": 1.14}

    # A stub config would blow up inside the geometry writer, so only exercise
    # the clamp when the writer is a no-op.
    import engine.optimizer.layers.layer1_static_optimization as L1

    original = L1._layer1_apply_chamber_geometry_to_config
    L1._layer1_apply_chamber_geometry_to_config = lambda *a, **k: 5.0
    try:
        _layer1_solve_derived_geometry(x, _Cfg(), constants, _evaluate,
                                       {"F": 7000.0, "Pc": 400 * PSI, "gamma": 1.14})
    finally:
        L1._layer1_apply_chamber_geometry_to_config = original

    assert at_lo <= x[0] <= at_hi, "solved A_throat escaped its search range"
    assert x[0] == pytest.approx(at_hi), "unreachable target should pin to the upper bound"
    assert calls["n"] <= int(constants["layer1_derive_max_iters"])


def test_solver_is_a_noop_when_both_toggles_are_off():
    x = np.array([1.5e-3, 1.0, 5.0, 0.15], dtype=float)
    before = x.copy()
    res = {"F": 1.0, "Pc": 400 * PSI, "gamma": 1.14}
    out = _layer1_solve_derived_geometry(
        x, object(),
        {"layer1_derive_expansion_ratio": False,
         "layer1_derive_throat_from_thrust": False},
        lambda: (_ for _ in ()).throw(AssertionError("must not evaluate")),
        res,
    )
    assert out is res
    np.testing.assert_array_equal(x, before)


def test_toggles_are_real_schema_fields_so_the_frontend_reaches_the_optimizer():
    req = DesignRequirementsConfig(
        layer1_derive_expansion_ratio=False,
        layer1_derive_throat_from_thrust=False,
    )
    dumped = req.model_dump()
    assert dumped["layer1_derive_expansion_ratio"] is False
    assert dumped["layer1_derive_throat_from_thrust"] is False
    # Unset must mean "use the default", not "off".
    assert DesignRequirementsConfig().model_dump()["layer1_derive_expansion_ratio"] is None
    assert _requirement_bool(dumped, "layer1_derive_expansion_ratio", True) is False
    assert _requirement_bool({}, "layer1_derive_expansion_ratio", True) is True


@pytest.mark.parametrize(
    "raw,expected",
    [("false", False), ("False", False), ("0", False), ("no", False), ("off", False),
     ("true", True), ("1", True), ("yes", True), (0, False), (1, True), (None, True)],
)
def test_requirement_bool_parses_the_forms_yaml_and_the_ui_produce(raw, expected):
    assert _requirement_bool({"k": raw}, "k", True) is expected


# ---------------------------------------------------------------------------
# Manufacturability snapping
# ---------------------------------------------------------------------------

from engine.optimizer.layers.layer1_static_optimization import (  # noqa: E402
    _quantize_chamber_od_m,
    _tank_pressure_equal_squared,
)

IN = 0.0254


def test_snap_outer_puts_the_tube_on_a_stock_size():
    wall = 1.1299 * IN
    od = _quantize_chamber_od_m(5.9629 * IN, 0.5, wall_m=wall, snap_target="outer")
    assert od / IN == pytest.approx(6.0, abs=1e-9)


def test_snap_bore_puts_the_gas_side_on_a_stock_size():
    wall = 1.1299 * IN
    od = _quantize_chamber_od_m(5.9629 * IN, 0.5, wall_m=wall, snap_target="bore")
    assert (od - wall) / IN == pytest.approx(5.0, abs=1e-9)
    # ...and then the OD is NOT a stock size. That is the whole point of the choice:
    # bore = OD - wall, so only one of the two can land on the increment.
    assert abs(round((od / IN) / 0.5) * 0.5 - od / IN) > 1e-6


def test_snapping_disabled_passes_the_value_through():
    for inc in (0.0, -1.0, None, float("nan")):
        assert _quantize_chamber_od_m(0.1234, inc) == pytest.approx(0.1234)


def test_unknown_snap_target_falls_back_to_outer():
    wall = 1.0 * IN
    od = _quantize_chamber_od_m(5.9 * IN, 0.5, wall_m=wall, snap_target="nonsense")
    assert od / IN == pytest.approx(6.0, abs=1e-9)


def test_tank_deadband_is_free_inside_the_band_by_default():
    """The in-band pull is OFF by default.

    It scales with W_TANK_EQUAL, so at W=30000 it charged 300 objective points for a delta
    sitting INSIDE the tolerance -- most of the reported residual, for a design that met the
    spec. It exists only to stop the optimizer parking just outside the band, and a large
    W_TANK_EQUAL already does that.
    """
    kw = dict(scale_psi=10.0, tol_psi=10.0)
    assert _tank_pressure_equal_squared(600.0, 598.0, **kw) == 0.0
    assert _tank_pressure_equal_squared(600.0, 590.1, **kw) == 0.0
    # ...and it is still available when explicitly asked for.
    near = _tank_pressure_equal_squared(600.0, 598.0, inband_frac=0.01, **kw)
    edge = _tank_pressure_equal_squared(600.0, 590.1, inband_frac=0.01, **kw)
    assert edge > near > 0.0

    # ...but the pull stays negligible against a real violation.
    out = _tank_pressure_equal_squared(600.0, 570.0, **kw)
    assert out > 20.0 * edge

    # inband_frac=0 restores the original flat deadband exactly.
    flat_near = _tank_pressure_equal_squared(600.0, 598.0, inband_frac=0.0, **kw)
    flat_edge = _tank_pressure_equal_squared(600.0, 590.1, inband_frac=0.0, **kw)
    assert flat_near == 0.0 and flat_edge == 0.0


def test_integer_jet_angles_only_apply_to_impinging():
    """Index 6 is the LOX angle for doublets but n_orifices for a pintle.

    Snapping [6, 9] on a pintle vector would quantise an orifice diameter, so the
    injector-type guard is load-bearing, not cosmetic.
    """
    import inspect
    import engine.optimizer.layers.layer1_static_optimization as L1

    src = inspect.getsource(L1.run_layer1_optimization)
    idx = src.index("layer1_integer_jet_angles")
    guard = src[max(0, idx - 400):idx]
    assert 'l1_injector_type == "impinging"' in guard


# ---------------------------------------------------------------------------
# Discrete DOFs handed to CMA-ES as discrete
# ---------------------------------------------------------------------------

from engine.optimizer.layers.layer1_static_optimization import (  # noqa: E402
    _layer1_cma_discrete_options,
)


def test_unit_granularity_dims_become_cma_integer_variables():
    """Element counts and whole-degree angles have granularity 1 -> integer_variables."""
    iv, minstd = _layer1_cma_discrete_options(13, [4, 6, 9])
    assert iv == [4, 6, 9]
    assert [i for i, v in enumerate(minstd) if v > 0] == [4, 6, 9]
    assert all(minstd[i] == pytest.approx(0.2) for i in (4, 6, 9))


def test_chamber_od_gets_a_std_floor_but_is_NOT_an_integer_variable():
    """Its granularity is one stock increment in METRES, not 1.

    Declaring it an integer variable would centre it on integer metres, which is
    meaningless. It only needs a std floor so sigma cannot collapse inside one cell.
    """
    step = 0.5 * 0.0254
    iv, minstd = _layer1_cma_discrete_options(13, [4, 6, 9], od_index=3, od_step_m=step)
    assert 3 not in iv, "chamber OD must not be declared an integer variable"
    assert minstd[3] == pytest.approx(0.2 * step)
    assert minstd[3] < 0.2, "floor must be in metres, not integer units"


def test_no_od_floor_when_stock_snapping_is_off():
    """With snapping disabled the coordinate really is continuous."""
    iv, minstd = _layer1_cma_discrete_options(13, [4], od_index=3, od_step_m=0.0)
    assert minstd[3] == 0.0
    assert iv == [4]


def test_out_of_range_discrete_indices_are_dropped():
    iv, minstd = _layer1_cma_discrete_options(5, [1, 9, -2], od_index=99, od_step_m=0.01)
    assert iv == [1]
    assert len(minstd) == 5


def test_block_subproblems_remap_discrete_indices():
    """A block optimizes a SUBSET, so global indices do not address the sub-vector.

    Guards the remap in run_hybrid_optimization: passing the global list would mark the
    wrong coordinates as integers.
    """
    import inspect
    import engine.optimizer.layers.layer1_static_optimization as L1

    src = inspect.getsource(L1.run_hybrid_optimization)
    assert "_blk_int_dims = [j for j, g in enumerate(_blk) if g in set(integer_dims or [])]" in src
    assert "_blk_od_index = _blk.index(od_index) if od_index in _blk else -1" in src

    # and the remap itself is correct
    block_indices = [1, 3, 4, 7, 9]
    integer_dims = [4, 6, 9]
    blk_int = [j for j, g in enumerate(block_indices) if g in set(integer_dims)]
    assert blk_int == [2, 4]                    # global 4 and 9 sit at sub-indices 2 and 4
    assert block_indices.index(3) == 1          # the chamber OD lands at sub-index 1


# ---------------------------------------------------------------------------
# Impingement standoff
# ---------------------------------------------------------------------------

def test_L_imp_reaches_the_reported_geometry():
    """It must be in optimized_parameters -- that dict IS the frontend's geometry table.

    Also pins the canonical SEED: both rings used to sit on the same 38.2 mm pitch circle,
    which is a zero radial offset, i.e. a doublet whose two jets never converge. The old
    standoff formula reported a plausible number for that degenerate geometry; this one
    returns NaN, so a finite value here is the guard.
    """
    from engine.optimizer.utils import extract_all_parameters
    from engine.pipeline.io import load_config

    cfg = load_config("configs/canonical/impinging.yaml")
    params = extract_all_parameters(cfg)
    assert "L_imp" in params
    assert np.isfinite(params["L_imp"]) and params["L_imp"] > 0.0
    assert params["ring_radial_offset"] > 0.0, "seed doublet rings must not be coincident"
    assert params["D_pitch_F"] > params["D_pitch_O"], "seed must put fuel outboard"
    d_avg = 0.5 * (params["d_jet_O"] + params["d_jet_F"])
    assert 3.0 <= params["L_imp"] / d_avg <= 7.0, "seed must start inside the L/d band"


# ---------------------------------------------------------------------------
# Doublet ring geometry
# ---------------------------------------------------------------------------

def test_standoff_uses_the_RADIAL_ring_offset_not_the_hole_pitch():
    """The offset a doublet closes is the gap between the two RINGS.

    ``spacing`` is the arc between adjacent holes on ONE ring -- it says how densely that
    ring is populated and nothing about how far the O and F jets of a single doublet are
    from each other. Using it as the offset (the old behaviour) under-reports the standoff.
    """
    from engine.core.injectors.impinging import impingement_standoff_m
    import math

    n, s_O, s_F, a_O, a_F = 30, 0.006716, 0.004889, 43.0, 47.0
    dr = 0.5 * abs(n * s_O / math.pi - n * s_F / math.pi)
    tan_sum = math.tan(math.radians(a_O)) + math.tan(math.radians(a_F))
    assert impingement_standoff_m(n, s_O, s_F, a_O, a_F) == pytest.approx(dr / tan_sum)

    # The discarded formula, for contrast -- it is a different, smaller number.
    wrong = 0.5 * (s_O + s_F) / tan_sum
    assert impingement_standoff_m(n, s_O, s_F, a_O, a_F) > wrong

    # Element count now matters, because it sets the pitch circles.
    assert impingement_standoff_m(60, s_O, s_F, a_O, a_F) == pytest.approx(
        2 * impingement_standoff_m(30, s_O, s_F, a_O, a_F))

    # Coincident rings never cross.
    assert not np.isfinite(impingement_standoff_m(n, s_O, s_O, a_O, a_F))


def test_ring_penalty_charges_for_lox_outboard_of_fuel():
    from engine.optimizer.layers.layer1_static_optimization import (
        _impinging_ring_geometry_squared,
    )

    common = dict(
        n_elements=30, d_jet_O_m=0.00196, d_jet_F_m=0.00168,
        D_chamber_inner_m=0.1016, angle_O_deg=43.0, angle_F_deg=47.0,
        Ld_min=3.0, Ld_max=7.0,
    )
    # LOX ring outboard (larger pitch) -- what we do NOT want.
    lox_out = _impinging_ring_geometry_squared(
        spacing_O_m=0.0067, spacing_F_m=0.0049, **common)
    # Fuel ring outboard -- same |dr|, so identical impingement physics.
    fuel_out = _impinging_ring_geometry_squared(
        spacing_O_m=0.0049, spacing_F_m=0.0067, **common)
    assert lox_out > fuel_out, "fuel-outboard must be the cheaper arrangement"

    # ...and the preference is switchable, for anyone who wants the other order.
    off_lox_out = _impinging_ring_geometry_squared(
        spacing_O_m=0.0067, spacing_F_m=0.0049,
        ring_order_fuel_outboard=False, **common)
    off_fuel_out = _impinging_ring_geometry_squared(
        spacing_O_m=0.0049, spacing_F_m=0.0067,
        ring_order_fuel_outboard=False, **common)
    assert off_lox_out == pytest.approx(off_fuel_out)


def test_ring_geometry_is_enforced_by_default():
    """It was opt-in while the infeasibility plateau made a hard constraint stall the
    search. The gradient fixed that, so leaving it off silences a weight the user set."""
    from engine.optimizer.layers.layer1_static_optimization import _requirement_bool
    assert _requirement_bool({}, "layer1_enforce_ring_geometry", True) is True
    assert _requirement_bool(
        {"layer1_enforce_ring_geometry": False}, "layer1_enforce_ring_geometry", True) is False


def test_pitch_circles_are_reported_alongside_hole_pitch():
    """Both numbers, so 'spacing' can't be misread as the ring diameter."""
    from engine.optimizer.utils import extract_all_parameters
    from engine.pipeline.io import load_config
    import math

    cfg = load_config("configs/canonical/impinging.yaml")
    p = extract_all_parameters(cfg)
    n = p["n_doublets"]
    assert p["D_pitch_O"] == pytest.approx(n * p["spacing_O"] / math.pi)
    assert p["D_pitch_F"] == pytest.approx(n * p["spacing_F"] / math.pi)
    assert p["ring_radial_offset"] == pytest.approx(0.5 * abs(p["D_pitch_O"] - p["D_pitch_F"]))
    # The pitch circle is much larger than the hole pitch -- that is the whole confusion.
    assert p["D_pitch_O"] > 5 * p["spacing_O"]


# ---------------------------------------------------------------------------
# L* target correlated to spray SMD
# ---------------------------------------------------------------------------

from engine.optimizer.layers.layer1_static_optimization import (  # noqa: E402
    _layer1_lstar_target_from_smd,
    _layer1_lstar_band_term,
    _layer1_resolve_lstar_target,
    _effective_smd_um,
)


def test_lstar_target_hits_the_anchor_band():
    """SMD 99 um must give a 1.05-1.15 m window."""
    t = _layer1_lstar_target_from_smd(99.0)
    assert t == pytest.approx(1.10, abs=1e-9)
    assert (t - 0.05, t + 0.05) == pytest.approx((1.05, 1.15))


def test_lstar_target_follows_the_d_squared_law():
    """tau_vap ~ D32^2 and tau_res ~ L*, so L*_target ~ SMD^2 -- not linear, not a fit."""
    base = _layer1_lstar_target_from_smd(50.0)
    assert _layer1_lstar_target_from_smd(100.0) == pytest.approx(4.0 * base)
    assert _layer1_lstar_target_from_smd(150.0) == pytest.approx(9.0 * base)
    # finer spray => shorter chamber
    assert _layer1_lstar_target_from_smd(70.0) < _layer1_lstar_target_from_smd(99.0)


def test_lstar_target_clamps_to_the_allowed_envelope():
    """A target pinned at the ceiling is information: the spray is too coarse to vaporise
    inside the chamber the requirements allow."""
    t = _layer1_lstar_target_from_smd(150.0, Lstar_min_m=0.5, Lstar_max_m=1.2)
    assert t == pytest.approx(1.2)
    assert _layer1_lstar_target_from_smd(30.0, Lstar_min_m=0.5, Lstar_max_m=1.2) == pytest.approx(0.5)


def test_lstar_band_term_is_free_inside_and_two_sided_outside():
    tgt, db = 1.10, 0.1
    assert _layer1_lstar_band_term(1.10, tgt, db) == 0.0
    # Band edges: exactly free up to float round-off on |L*-target| - half.
    assert _layer1_lstar_band_term(1.05, tgt, db) == pytest.approx(0.0, abs=1e-30)
    assert _layer1_lstar_band_term(1.15, tgt, db) == pytest.approx(0.0, abs=1e-30)
    # Under-shooting now costs too: droplets do not finish evaporating.
    assert _layer1_lstar_band_term(0.90, tgt, db) > 0.0
    assert _layer1_lstar_band_term(1.40, tgt, db) > 0.0
    # Saturating, so an unreachable target can never dominate a hard gate.
    assert _layer1_lstar_band_term(50.0, tgt, db) < 1.0


def test_resolver_treats_explicit_None_as_unset():
    """model_dump() emits None for every unset Optional -- .get(key, default) returns None,
    not the default. This crashed every run until the resolver handled it."""
    req = {
        "layer1_Lstar_deadband_m": None,
        "layer1_Lstar_from_smd": None,
        "layer1_Lstar_smd_ref_um": None,
        "layer1_Lstar_ref_m": None,
        "layer1_Lstar_smd_exponent": None,
        "min_Lstar": None,
        "max_Lstar": None,
    }
    tgt, db = _layer1_resolve_lstar_target(99.0, req, req.get, 1.0)
    assert tgt == pytest.approx(1.10)
    assert db == pytest.approx(0.1)


def test_resolver_falls_back_rather_than_silently_disabling():
    req = {}
    # No SMD available -> fixed target, penalty still active.
    tgt, _ = _layer1_resolve_lstar_target(float("nan"), req, req.get, 0.85)
    assert tgt == pytest.approx(0.85)
    # Explicit opt-out -> fixed target.
    req = {"layer1_Lstar_from_smd": False}
    tgt, _ = _layer1_resolve_lstar_target(99.0, req, req.get, 0.85)
    assert tgt == pytest.approx(0.85)


def test_effective_smd_is_the_mass_flux_weighted_blend():
    diag = {"D32_O": 110e-6, "D32_F": 80e-6}
    mr = 1.69
    expected = (mr / (1 + mr) * 110e-6 + 1 / (1 + mr) * 80e-6) * 1e6
    assert _effective_smd_um(diag, mr) == pytest.approx(expected)
    assert not np.isfinite(_effective_smd_um({}, mr))
    assert not np.isfinite(_effective_smd_um(None, mr))


def test_impingement_target_defaults_to_four_jet_diameters():
    from engine.pipeline.config_schemas import DesignRequirementsConfig
    import inspect
    import engine.optimizer.layers.layer1_static_optimization as L1

    assert "layer1_impingement_Ld_target" in DesignRequirementsConfig.model_fields
    src = inspect.getsource(L1.run_layer1_optimization)
    assert '"layer1_impingement_Ld_target", 4.0' in src


def test_fuel_spacing_is_solved_to_hit_the_target_exactly():
    """One equation, one unknown -- the standoff must land ON the number, not near it."""
    import engine.optimizer.layers.layer1_static_optimization as L1
    from engine.core.injectors.impinging import impingement_standoff_m

    for k in (3.0, 4.0, 5.5, 7.0):
        x = np.array([1.6e-3, 1.13, 5.2, 0.152, 30, 1.965e-3, 43.0, 3.0e-3,
                      1.685e-3, 47.0, 9.9e-3, 590.0, 600.0], dtype=float)
        c = {"injector_type": "impinging", "layer1_derive_impingement_spacing": True,
             "layer1_impingement_Ld_target": k, "layer1_ring_order_fuel_outboard": True,
             "derive_spacing_F_min": 1e-4, "derive_spacing_F_max": 0.05}
        L1._layer1_derive_fuel_spacing(x, c)
        d_avg = 0.5 * (x[5] + x[8])
        L = impingement_standoff_m(x[4], x[7], x[10], x[6], x[9])
        assert L / d_avg == pytest.approx(k, rel=1e-9), f"k={k}"
        assert x[10] > x[7], "fuel ring must end up outboard"


def test_fuel_spacing_derivation_snaps_the_doublet_count_in_place():
    """The worker truncates int(x[4]) while apply_x_to_config rounds; the derivation divides
    by n, so the two must be made to agree or the solved standoff misses."""
    import engine.optimizer.layers.layer1_static_optimization as L1

    x = np.array([1.6e-3, 1.13, 5.2, 0.152, 29.7, 1.965e-3, 43.0, 3.0e-3,
                  1.685e-3, 47.0, 9.9e-3, 590.0, 600.0], dtype=float)
    c = {"injector_type": "impinging", "layer1_derive_impingement_spacing": True,
         "layer1_impingement_Ld_target": 4.0, "layer1_ring_order_fuel_outboard": True,
         "derive_spacing_F_min": 1e-4, "derive_spacing_F_max": 0.05}
    L1._layer1_derive_fuel_spacing(x, c)
    assert x[4] == 30.0
    assert int(x[4]) == int(round(x[4]))


def test_fuel_spacing_derivation_respects_ring_order_and_opt_out():
    import engine.optimizer.layers.layer1_static_optimization as L1

    base = np.array([1.6e-3, 1.13, 5.2, 0.152, 30, 1.965e-3, 43.0, 3.0e-3,
                     1.685e-3, 47.0, 9.9e-3, 590.0, 600.0], dtype=float)
    c = {"injector_type": "impinging", "layer1_derive_impingement_spacing": True,
         "layer1_impingement_Ld_target": 4.0, "derive_spacing_F_min": 1e-6,
         "derive_spacing_F_max": 0.05}

    x = base.copy(); L1._layer1_derive_fuel_spacing(x, {**c, "layer1_ring_order_fuel_outboard": True})
    assert x[10] > x[7]
    x = base.copy(); L1._layer1_derive_fuel_spacing(x, {**c, "layer1_ring_order_fuel_outboard": False})
    assert x[10] < x[7]

    # Opt-out leaves the searched value untouched.
    x = base.copy()
    L1._layer1_derive_fuel_spacing(x, {**c, "layer1_derive_impingement_spacing": False})
    assert x[10] == pytest.approx(9.9e-3)

    # Pintle vectors have no fuel ring; must be a no-op.
    x = base.copy()
    L1._layer1_derive_fuel_spacing(x, {**c, "injector_type": "pintle"})
    assert x[10] == pytest.approx(9.9e-3)


def test_clamped_fuel_ring_reports_the_miss_instead_of_hiding_it():
    """If the solved ring will not fit the bore it clamps -- and L/d then misses, which the
    ring-geometry penalty is there to report. Silently producing an unbuildable ring, or
    silently pretending the target was met, would both be worse."""
    import engine.optimizer.layers.layer1_static_optimization as L1
    from engine.core.injectors.impinging import impingement_standoff_m

    x = np.array([1.6e-3, 1.13, 5.2, 0.152, 30, 1.965e-3, 43.0, 3.0e-3,
                  1.685e-3, 47.0, 9.9e-3, 590.0, 600.0], dtype=float)
    c = {"injector_type": "impinging", "layer1_derive_impingement_spacing": True,
         "layer1_impingement_Ld_target": 4.0, "layer1_ring_order_fuel_outboard": True,
         "derive_spacing_F_min": 1e-4, "derive_spacing_F_max": 0.004}
    L1._layer1_derive_fuel_spacing(x, c)
    assert x[10] == pytest.approx(0.004)
    d_avg = 0.5 * (x[5] + x[8])
    assert impingement_standoff_m(x[4], x[7], x[10], x[6], x[9]) / d_avg < 4.0


# ---------------------------------------------------------------------------
# Momentum ratio: fail toward the core, never toward the wall
# ---------------------------------------------------------------------------

from engine.optimizer.layers.layer1_static_optimization import (  # noqa: E402
    _impinging_momentum_asymmetric_squared as _mom,
)


def test_momentum_band_is_free_and_symmetric():
    """R's only job was the liner guard, and it did it wrong. It is now a mild symmetric
    mixing preference; the resultant tilt owns the liner."""
    for r in (0.96, 0.98, 1.0, 1.02, 1.04, 1.05):
        assert _mom(r) == 0.0
    assert _mom(0.90) > 0.0
    assert _mom(1.12) > 0.0
    # symmetric: equal log-distance outside the band costs the same
    assert _mom(1.0 / 0.90) == pytest.approx(_mom(0.90), rel=1e-6)


def test_momentum_multiplier_is_clamped_against_legacy_ban_values():
    """A config left over from the ban era can still carry 999999. Unclamped, that put a
    quality term at 1e7..1e11 against BASE_INFEAS = 1e6 and stopped the run in ~1 s."""
    huge = _mom(1.20, wall_side_multiplier=999999.0)
    assert 0.0 < huge <= 1.0e3 * _mom(1.20, wall_side_multiplier=1.0) + 1e-9


def test_superseded_R_wall_violation_still_behaves_for_back_compat():
    """Retained only so older configs/tests keep working; the live guard is the tilt."""
    from engine.optimizer.layers.layer1_static_optimization import (
        _impinging_momentum_wall_violation as _viol,
    )
    assert _viol(1.01, safe_side_is_below_one=False) == 0.0
    assert _viol(0.99, safe_side_is_below_one=False) > 0.0


def test_outside_band_is_discouraged_not_banned():
    """A momentum miss is a mixing loss, not a hazard -- it must stay negotiable.

    The liner hazard is the resultant tilt, which is a separate, one-sided constraint.
    """
    assert 0.0 < _mom(0.88) < 10.0
    assert 0.0 < _mom(1.14) < 10.0


def test_momentum_penalty_ignores_garbage():
    assert _mom(None) == 0.0
    assert _mom(float("nan")) == 0.0
    assert _mom(-1.0) == 0.0
    assert _mom(0.0) == 0.0


def test_momentum_gate_is_symmetric_and_widened():
    """R is no longer the liner gate (the resultant tilt is), so its gate is symmetric.

    A one-sided gate failed tilt-balanced designs, which sit at R ~ 1.05: every other check
    green, pressure_candidate_valid False.
    """
    import inspect
    import engine.optimizer.layers.layer1_static_optimization as L1

    src = inspect.getsource(L1.run_layer1_optimization)
    assert "_mom_slack" in src
    assert "1.0 - (1.0 - float(layer1_impinging_R_mom_lo)) * _mom_slack" in src

    # the widening itself
    lo, hi, slack = 0.95, 1.05, 3.0
    assert max(0.0, 1.0 - (1.0 - lo) * slack) == pytest.approx(0.85)
    assert 1.0 + (hi - 1.0) * slack == pytest.approx(1.15)


def test_pinned_dimensions_get_no_cma_std_floor():
    """A frozen or derived-pinned coordinate must be left out of minstd/integer_variables.

    Its domain is ~2e-12 wide. Handing cma a floor of 0.2 (or 0.00254 m for the chamber OD)
    against that makes it inflate the sampling std by ~1e9 to satisfy the floor -- 'sigma0 x
    stds is larger than the bounded domain size in variable 3' -- which wrecks the covariance
    matrix on a coordinate that cannot move anyway. Freezing the chamber OD at 6.5 in took the
    objective from ~40 to ~14700 before this guard.
    """
    from engine.optimizer.layers.layer1_static_optimization import (
        _layer1_cma_discrete_options,
    )
    PIN = 1e-12
    free = [(0.0, 1.0)] * 3 + [(0.08, 0.20)] + [(10.0, 50.0), (0.0, 1.0), (20.0, 80.0),
            (0.0, 1.0), (0.0, 1.0), (20.0, 80.0), (0.0, 1.0), (0.0, 1.0), (0.0, 1.0)]

    # baseline: everything free
    iv, ms = _layer1_cma_discrete_options(13, [4, 6, 9], od_index=3, od_step_m=0.0127,
                                          bounds=free)
    assert iv == [4, 6, 9]
    assert ms[3] == pytest.approx(0.2 * 0.0127)

    # chamber OD frozen -> no std floor on it, integers untouched
    frozen_od = list(free)
    frozen_od[3] = (0.1651 - PIN, 0.1651 + PIN)
    iv, ms = _layer1_cma_discrete_options(13, [4, 6, 9], od_index=3, od_step_m=0.0127,
                                          bounds=frozen_od)
    assert ms[3] == 0.0, "frozen coordinate must not get a std floor"
    assert iv == [4, 6, 9]

    # a frozen integer dim drops out of integer_variables too
    frozen_n = list(free)
    frozen_n[4] = (30.0 - 0.01, 30.0 + 0.01)
    iv, ms = _layer1_cma_discrete_options(13, [4, 6, 9], od_index=3, od_step_m=0.0127,
                                          bounds=frozen_n)
    assert 4 not in iv and ms[4] == 0.0
    assert iv == [6, 9]

    # no bounds supplied -> behave as before (nothing to check against)
    iv, ms = _layer1_cma_discrete_options(13, [4, 6, 9], od_index=3, od_step_m=0.0127)
    assert iv == [4, 6, 9] and ms[3] > 0.0


# ---------------------------------------------------------------------------
# Thrust deadband follows whether the throat is solved
# ---------------------------------------------------------------------------

def test_thrust_deadband_is_tight_when_throat_is_derived():
    from engine.optimizer.layers.layer1_static_optimization import _layer1_thrust_deadband as db
    assert db({}) == pytest.approx(0.001)                                   # default: derived
    assert db({"layer1_derive_throat_from_thrust": True}) == pytest.approx(0.001)
    assert db({"layer1_derive_throat_from_thrust": False}) == pytest.approx(0.02)
    assert db({"layer1_thrust_deadband_rel": 0.005}) == pytest.approx(0.005)  # explicit wins
    assert db({"layer1_thrust_deadband_rel": None}) == pytest.approx(0.001)   # None == unset
    assert db(object()) == pytest.approx(0.02)                                # no .get -> legacy


def test_solve_restores_x_and_config_when_a_step_fails():
    """x and the config must always describe the RETURNED result.

    A failed last step used to leave x/config on the geometry that had just failed while
    returning the result from the one before -- the finalised design then did not evaluate.
    """
    import engine.optimizer.layers.layer1_static_optimization as L1

    x = np.array([1.5e-3, 1.0, 5.0, 0.15, 20, 2e-3, 45.0, 5e-3,
                  1.7e-3, 45.0, 5e-3, 550.0, 550.0], dtype=float)
    c = {"layer1_derive_expansion_ratio": False, "layer1_derive_throat_from_thrust": True,
         "layer1_derive_max_iters": 3, "derive_At_min": 1e-4, "derive_At_max": 1e-2,
         "derive_eps_min": 2.0, "derive_eps_max": 20.0, "P_ambient": 13.6 * PSI,
         "target_thrust": 9000.0, "max_nozzle_exit": 0.2, "TOTAL_WALL_THICKNESS_M": 0.006}
    first = {"F": 7000.0, "Pc": 400 * PSI, "gamma": 1.14}

    L1._layer1_apply_chamber_geometry_to_config, _orig = (lambda *a, **k: 5.0), L1._layer1_apply_chamber_geometry_to_config
    try:
        out = L1._layer1_solve_derived_geometry(x, object(), c, lambda: None, first)   # every step fails
    finally:
        L1._layer1_apply_chamber_geometry_to_config = _orig
    assert out is first
    assert x[0] == pytest.approx(1.5e-3), "x must be restored to the state the returned result describes"
    assert first.get("_derive_restored_after_failed_step") is True


# ---------------------------------------------------------------------------
# Ablative guard: the spray RESULTANT, not the momentum-flux ratio
# ---------------------------------------------------------------------------

from engine.optimizer.layers.layer1_static_optimization import (  # noqa: E402
    _impinging_resultant_tilt_deg as _tilt,
    _impinging_resultant_wall_violation as _tviol,
)


def test_R_equal_one_is_not_a_balanced_doublet():
    """The whole reason the old guard was wrong: p_O/p_F = R^2 * (A_O/A_F).

    Equal jets at equal angles balance; unequal AREAS do not, no matter what R is.
    """
    kw = dict(rho_O=1141.0, rho_F=789.0, n_elements=18, angle_O_deg=45.0, angle_F_deg=45.0)
    # EQUAL STREAM MOMENTA -> axial. p = mdot^2/(rho*A), so equal mdot with unequal density
    # is NOT balanced; matching p is what matters.
    import math as _m
    d_O = 2e-3
    d_F = _m.sqrt(1141.0 / 789.0) * d_O          # A_F/A_O = rho_O/rho_F  =>  p_O = p_F
    assert _tilt(mdot_O=1.0, mdot_F=1.0, d_jet_O_m=d_O, d_jet_F_m=d_F, **kw) == pytest.approx(0.0, abs=1e-9)
    # the real design: LOX-heavy stream momentum -> fan thrown OUTWARD even though R ~ 1
    t = _tilt(mdot_O=2.05, mdot_F=0.94, d_jet_O_m=2.73e-3, d_jet_F_m=2.02e-3, **kw)
    assert t > 10.0, f"expected a large outward tilt, got {t}"


def test_angle_asymmetry_is_the_lever_that_balances_the_fan():
    """sin(th_O)/sin(th_F) = p_F/p_O -> alpha = 0. This is what the optimizer found (29/62)."""
    kw = dict(rho_O=1141.0, rho_F=789.0, n_elements=18, d_jet_O_m=2.73e-3, d_jet_F_m=2.02e-3)
    sym = _tilt(mdot_O=2.05, mdot_F=0.94, angle_O_deg=45.0, angle_F_deg=45.0, **kw)
    asym = _tilt(mdot_O=2.05, mdot_F=0.94, angle_O_deg=29.0, angle_F_deg=62.0, **kw)
    assert abs(asym) < abs(sym) / 4.0, f"asymmetry must flatten the fan: {sym} -> {asym}"


def test_tilt_sign_follows_the_ring_order():
    kw = dict(rho_O=1141.0, rho_F=789.0, n_elements=18, d_jet_O_m=2.73e-3, d_jet_F_m=2.02e-3,
              angle_O_deg=45.0, angle_F_deg=45.0, mdot_O=2.05, mdot_F=0.94)
    assert _tilt(lox_inboard=True, **kw) > 0        # LOX inboard, LOX-heavy -> outward
    assert _tilt(lox_inboard=False, **kw) < 0       # flip the rings, flip the direction


def test_tilt_violation_is_one_sided_and_ignores_garbage():
    assert _tviol(-5.0) == 0.0          # inward: a mixing loss, not a hazard
    assert _tviol(0.0) == 0.0
    assert _tviol(2.0) > 0.0
    assert _tviol(8.0) > _tviol(2.0)
    for bad in (None, float("nan")):
        assert _tviol(bad) == 0.0
    assert not np.isfinite(_tilt(mdot_O=0.0, mdot_F=0.0, rho_O=1141.0, rho_F=789.0,
                                 n_elements=18, d_jet_O_m=2e-3, d_jet_F_m=2e-3,
                                 angle_O_deg=45.0, angle_F_deg=45.0))


def test_momentum_band_is_symmetric_now_that_tilt_owns_the_guard():
    """A one-sided R band taxed exactly the tilt-balanced designs (R ~ 1.05)."""
    assert _mom(1.03, band_width=0.05) == 0.0
    assert _mom(0.97, band_width=0.05) == 0.0
    assert _mom(1.08, band_width=0.05) > 0.0
    assert _mom(0.92, band_width=0.05) > 0.0


def test_design_point_is_stamped_from_the_solved_engine():
    """chamber_geometry.design_* must describe THIS engine, not the template it came from.

    Nothing ever wrote these: config_schemas builds them with
    `getattr(chamber, 'design_MR', 2.55)`, so an optimised config carried the template's values
    forward forever. A real emitted design was stamped MR 2.55 / 350 psi / 7000 N while actually
    solving at O/F ~1.65 / 416 psi / 7200 N -- and backend/routers/geometry.py feeds design_MR
    straight into solve_chamber_geometry_with_cea, so the geometry tab drew the contour at the
    stale ratio.
    """
    import logging
    from engine.pipeline.io import load_config
    from engine.optimizer.layers.layer1_static_optimization import _layer1_stamp_design_point

    cfg = load_config("configs/canonical/impinging.yaml")
    cfg.chamber_geometry.design_MR = 2.55          # the stale template values
    cfg.chamber_geometry.design_pressure = 2.413166e6
    cfg.chamber_geometry.design_thrust = 7000.0

    solved = {"MR": 1.6461, "Pc": 2.8690e6, "F": 7200.0}
    _layer1_stamp_design_point(cfg, solved, None)

    assert cfg.chamber_geometry.design_MR == pytest.approx(solved["MR"])
    assert cfg.chamber_geometry.design_pressure == pytest.approx(solved["Pc"])
    assert cfg.chamber_geometry.design_thrust == pytest.approx(solved["F"])


def test_design_point_stamp_warns_outside_the_cea_cache_range():
    """An MR outside combustion.cea.MR_range means anything reading it extrapolates."""
    import logging
    from engine.pipeline.io import load_config
    from engine.optimizer.layers.layer1_static_optimization import _layer1_stamp_design_point

    cfg = load_config("configs/canonical/impinging.yaml")
    lo, hi = [float(v) for v in cfg.combustion.cea.MR_range]

    seen = []
    logger = logging.getLogger("stamp_range_test")
    logger.warning = lambda msg, *a, **k: seen.append(msg % a if a else msg)

    _layer1_stamp_design_point(cfg, {"MR": (lo + hi) / 2.0, "Pc": 2.8e6, "F": 7200.0}, logger)
    assert not seen, "in-range MR must not warn"

    _layer1_stamp_design_point(cfg, {"MR": hi + 1.0, "Pc": 2.8e6, "F": 7200.0}, logger)
    assert seen and "outside the CEA cache" in seen[0]


def test_design_point_stamp_ignores_non_finite_performance():
    """A failed evaluate must not overwrite a good design point with NaN."""
    from engine.pipeline.io import load_config
    from engine.optimizer.layers.layer1_static_optimization import _layer1_stamp_design_point

    cfg = load_config("configs/canonical/impinging.yaml")
    cfg.chamber_geometry.design_MR = 1.65
    _layer1_stamp_design_point(cfg, {"MR": float("nan"), "Pc": 0.0, "F": None}, None)
    assert cfg.chamber_geometry.design_MR == pytest.approx(1.65)


def test_stale_pressure_curves_are_flagged():
    """The initial tank pressure exists twice, owned by different layers, never reconciled.

    Layer 1 writes lox_tank/fuel_tank.initial_pressure_psi; Layer 2 writes
    pressure_curves.initial_lox/fuel_pressure_pa. Re-running Layer 1 silently leaves the curves
    describing the previous design (observed 11.3 psi out on LOX, 24.9 psi on fuel). Tank
    pressure is the upstream boundary condition for the feed-system twin (docs/adr/0001), so a
    disagreement must not cross that boundary unannounced.
    """
    import logging
    from engine.pipeline.io import load_config
    from engine.optimizer.layers.layer1_static_optimization import (
        _layer1_warn_stale_pressure_curves,
    )

    cfg = load_config("configs/canonical/impinging.yaml")
    if getattr(cfg, "pressure_curves", None) is None or getattr(cfg, "lox_tank", None) is None:
        pytest.skip("config has no pressure_curves / lox_tank to compare")

    seen = []
    logger = logging.getLogger("stale_curves_test")
    logger.warning = lambda msg, *a, **k: seen.append(msg % a if a else msg)

    PSI = 6894.76
    cfg.lox_tank.initial_pressure_psi = 548.6
    cfg.pressure_curves.initial_lox_pressure_pa = 548.6 * PSI       # agrees
    cfg.fuel_tank.initial_pressure_psi = 548.6
    cfg.pressure_curves.initial_fuel_pressure_pa = 548.6 * PSI      # agrees
    _layer1_warn_stale_pressure_curves(cfg, logger)
    assert not seen, "matching pressures must not warn"

    cfg.pressure_curves.initial_lox_pressure_pa = 537.3 * PSI       # 11.3 psi stale
    _layer1_warn_stale_pressure_curves(cfg, logger)
    assert seen and "LOX tank pressure disagrees" in seen[0]
