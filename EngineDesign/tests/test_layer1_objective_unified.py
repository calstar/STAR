"""One Layer-1 objective, scored on the chamber and engine that are actually drawn.

L1-03 / CN-3: the worker and inline objectives were two implementations that disagreed by
~300 points on one design (worker cone to R_t, clipped at 1 m; config cone to r_tan). Both now
call ``_compute_objective_value``. CN-9: engine length was cone + 0.8 D_exit instead of
face-to-throat + the 80 % Rao bell the contour draws. L1-06, L1-09, L1-10, L1-11 and INJ-7 are
defects in the same scoring function.

Expected numbers come from hand geometry (frustum + entrance arc, H&H ch. 4) and the Rao
contour generator, never from the function under test.
"""
from __future__ import annotations

import copy
import inspect
import math
from pathlib import Path

import numpy as np
import pytest

import engine.optimizer.layers.layer1_static_optimization as L1
from engine.pipeline.io import load_config

ROOT = Path(__file__).resolve().parents[1]

# The shipped 6500 N point (configs/ethalox_6500N.yaml chamber_geometry).
AT = 1.533694488707181e-3
BORE = 0.127
WALL = 0.0381
LSTAR = 1.0000002573548417
EPS = 5.598521540485944
PC = 2.972e6


def _x(eps=EPS, lstar=LSTAR, ang=(43.0, 46.0), n=24, P=583.1):
    return np.array([AT, lstar, eps, BORE + WALL, float(n), 2.4e-3, ang[0], 0.0126,
                     2.2e-3, ang[1], 0.0152, P, P], dtype=float)


def _constants(**over):
    c = {
        "injector_type": "impinging", "idx_P_O": 11, "idx_P_F": 12,
        "target_thrust": 6500.0, "optimal_of": 1.5, "P_ambient": 94070.0,
        "max_lox_P_psi": 600.0, "max_fuel_P_psi": 600.0,
        "TOTAL_WALL_THICKNESS_M": WALL, "max_nozzle_exit": 0.2032,
        "layer1_W_THRUST": 6e4, "layer1_W_OF": 2e4,
        "layer1_derive_impingement_spacing": False,
        "W_IMP_GEOM": 0.0, "W_CHAMBER_SHAPE": 0.0, "W_MOM": 0.0, "W_DP": 0.0,
        "W_DP_O": 0.0, "W_DP_F": 0.0, "W_DP_HIGH": 0.0, "W_DP_CENTER": 0.0,
        "layer1_W_EXIT": 0.0,
        "layer1_resultant_tilt_max_deg": 45.0,   # the liner tilt gate is not under test here
    }
    c.update(over)
    return c


def _req(**over):
    r = {"min_stability_margin": 0.0, "min_stability_score": 0.0,
         "require_stable_state": False, "layer1_infeasibility_gate_eps": 0.002,
         "max_engine_length": 0.40}
    r.update(over)
    return r


def _result(**over):
    r = {"F": 6500.0, "MR": 1.5, "Pc": PC, "Cf": 1.417, "Cf_actual": 1.417, "Isp": 235.0,
         "P_exit": 94070.0, "eps": EPS, "mdot_O": 1.69, "mdot_F": 1.13,
         "stability_results": {"stability_state": "stable", "stability_score": 1.0,
                               "chugging": {"stability_margin": 1.3},
                               "acoustic": {"stability_margin": 1.3},
                               "feed_system": {"stability_margin": 1.3}},
         "diagnostics": {"momentum_ratio_R": 1.0}}
    r.update(over)
    return r


def _hand_lengths(theta=math.radians(45.0)):
    """Frustum-plus-arc chamber, by hand (H&H ch. 4 geometry), independent of the module."""
    Rt = math.sqrt(AT / math.pi)
    Rc = BORE / 2.0
    r_tan = Rt * (1.0 + 1.5 * (1.0 - math.cos(theta)))
    L_cone = (Rc - r_tan) / math.tan(theta)
    # cone volume between Rc and r_tan, arc volume between r_tan and Rt (numerical)
    V_cone = math.pi * L_cone / 3.0 * (Rc ** 2 + Rc * r_tan + r_tan ** 2)
    t = np.linspace(-(math.pi / 2 + theta), -math.pi / 2, 20001)
    xa = 1.5 * Rt * np.cos(t)
    ya = 1.5 * Rt * np.sin(t) + 2.5 * Rt
    V_arc = float(np.sum(np.pi * 0.5 * (ya[1:] ** 2 + ya[:-1] ** 2) * np.diff(xa)))
    L_cyl = (LSTAR * AT - V_cone - V_arc) / (math.pi * Rc ** 2)
    L_arc = 1.5 * Rt * math.sin(theta)
    return L_cyl, L_cone, L_arc


def test_objective_scores_the_chamber_the_config_builds():
    """CN-3: the mass term uses the chamber length _layer1_apply_chamber_geometry_to_config
    writes. The worker used a cone to R_t (140.2 mm here) against 130.5 mm built."""
    L_cyl, L_cone, _ = _hand_lengths()
    cfg = load_config(str(ROOT / "configs" / "ethalox_6500N.yaml"))
    L1._layer1_apply_chamber_geometry_to_config(
        cfg, A_throat=AT, Lstar=LSTAR, expansion_ratio=EPS, D_chamber_outer=BORE + WALL,
        max_nozzle_exit=0.2032, wall_thickness_m=WALL)
    assert cfg.chamber_geometry.length == pytest.approx(L_cyl + L_cone, abs=2e-5)

    c_on = _constants(layer1_W_MASS=3000.0, layer1_chamber_wall_density_kg_m3=3400.0,
                      layer1_chamber_mass_ref_kg=5.0, layer1_target_Pc_pa=PC, layer1_W_PC=0.0)
    c_off = dict(c_on, layer1_W_MASS=0.0)
    d = (L1._compute_objective_value(_result(), _x(), _req(), c_on)
         - L1._compute_objective_value(_result(), _x(), _req(), c_off))
    m = L1._layer1_chamber_mass_kg(math.pi * BORE ** 2 / 4, L_cyl + L_cone, WALL, 3400.0, Pc_pa=PC)
    assert d == pytest.approx(3000.0 * (m / 5.0) ** 2, rel=1e-3)


def test_engine_length_is_face_to_throat_plus_the_rao_bell():
    """CN-9: face-to-exit length of the drawn engine is 244.1 mm here (CN-1 contour
    integration); the estimate used 214-224 mm and let a 240 mm limit through."""
    from engine.core.nozzle_solver import rao
    L_cyl, L_cone, L_arc = _hand_lengths()
    xs, _ = rao(AT, AT * EPS, bell_percent=0.8, do_plot=False, method="top")[:2]
    L_true = L_cyl + L_cone + L_arc + float(np.max(xs))
    assert L_true == pytest.approx(0.2441, abs=5e-4)
    c = _constants()
    over = L1._compute_objective_value(_result(), _x(), _req(max_engine_length=L_true - 0.004), c)
    under = L1._compute_objective_value(_result(), _x(), _req(max_engine_length=L_true + 0.004), c)
    assert over >= 1e6 > under


@pytest.mark.parametrize("eps", [3.0, 5.6, 20.0])
def test_bell_length_matches_the_drawn_rao_contour(eps):
    from engine.core.nozzle_solver import rao
    xs, _ = rao(AT, AT * eps, bell_percent=0.8, do_plot=False, method="top")[:2]
    assert L1._layer1_bell_length_m(AT, eps) == pytest.approx(float(np.max(xs)), abs=5e-4)


def test_inline_objective_is_the_worker_objective():
    """L1-03: the closure must not keep a second scoring (obj_quality sum of its own)."""
    src = inspect.getsource(L1.run_layer1_optimization)
    assert "_layer1_objective_terms(" in src
    assert "obj_quality = (" not in src


def test_mass_term_without_pc_target_does_not_crash():
    """L1-06: Pc_actual was bound only inside the Pc-target branch (UnboundLocalError)."""
    c = _constants(layer1_W_MASS=3000.0)
    v = L1._compute_objective_value(_result(), _x(), _req(), c)
    assert np.isfinite(v)


def test_configured_momentum_band_reaches_the_objective():
    """L1-09: the free band was [1/1.05, 1.05] whatever impinging_momentum_R_min/max said."""
    # layer1_momentum_band_width 0.05 is what run_layer1_optimization always passes
    c = _constants(W_MOM=75.0, impinging_momentum_R_min=0.98, impinging_momentum_R_max=1.02,
                   layer1_momentum_band_width=0.05)
    c0 = dict(c, W_MOM=0.0)
    res = _result(diagnostics={"momentum_ratio_R": 1.04})
    assert (L1._compute_objective_value(res, _x(), _req(), c)
            > L1._compute_objective_value(res, _x(), _req(), c0))
    res_in = _result(diagnostics={"momentum_ratio_R": 1.01})
    assert (L1._compute_objective_value(res_in, _x(), _req(), c)
            == L1._compute_objective_value(res_in, _x(), _req(), c0))


def test_require_stable_state_rejects_marginal():
    """L1-10: 'Require stable (not just marginal)' allowed {'stable', 'marginal'}."""
    sr = dict(_result()["stability_results"], stability_state="marginal")
    obj = L1._compute_objective_value(_result(stability_results=sr), _x(),
                                      _req(require_stable_state=True), _constants())
    assert obj >= 1e6
    ok = L1._compute_objective_value(_result(), _x(), _req(require_stable_state=True), _constants())
    assert ok < 1e6


def test_signoff_rejects_a_chug_margin_below_the_floor():
    """L1-10: a hidden 5 % let a chug gate margin of 0.9975 pass a 1.05 floor."""
    passed, parts = L1._layer1_stability_gate(
        "stable", 1.0, 0.9975, 1.3, 1.3,
        {"chugging": {"stability_margin": 0.9975, "chug_gain_margin": 0.998}},
        {"min_stability_score": 0.5, "require_stable_state": False}, 1.05)
    assert not passed and any("chugging_margin" in p for p in parts)
    passed_nan, parts_nan = L1._layer1_stability_gate(
        "stable", 1.0, 1.10, 1.3, 1.3, {"chugging": {"stability_margin": 1.10,
                                                    "chug_gain_margin": float("nan")}},
        {"min_stability_score": 0.5, "require_stable_state": False}, 1.05)
    assert not passed_nan and "chug gain margin unknown" in parts_nan


def test_free_jet_beyond_sp8089_is_infeasible():
    """INJ-7: axial standoff 4 d_avg at 60/60 deg is 8 d along each jet (> 7 d)."""
    n, d = 20.0, 2.0e-3
    s_O = 0.010
    tan_sum = 2.0 * math.tan(math.radians(60.0))
    s_F = s_O + 2.0 * math.pi * 4.0 * d * tan_sum / n     # axial L_imp = 4 d
    ld = L1._impinging_free_jet_ld(n_elements=n, spacing_O_m=s_O, spacing_F_m=s_F,
                                   d_jet_O_m=d, d_jet_F_m=d, angle_O_deg=60.0, angle_F_deg=60.0)
    assert ld == pytest.approx(8.0, rel=1e-9)
    x = _x(ang=(60.0, 60.0), n=int(n))
    x[5], x[7], x[8], x[10] = d, s_O, d, s_F
    obj = L1._compute_objective_value(_result(), x, _req(), _constants())
    assert obj >= 1e6
    x45 = x.copy()
    x45[6] = x45[9] = 40.0
    tan40 = 2.0 * math.tan(math.radians(40.0))
    x45[10] = s_O + 2.0 * math.pi * 4.0 * d * tan40 / n      # 4/cos40 = 5.2 d
    assert L1._compute_objective_value(_result(), x45, _req(), _constants()) < 1e6


def test_failed_evaluations_never_score_as_feasible():
    """L1-11: after 200 consecutive failures the inline objective returned 1e5, which
    counts as feasible and beats every infeasible-but-evaluable design."""
    from unittest.mock import MagicMock, patch
    real_cfg = load_config(str(ROOT / "configs" / "impinging_smoke.yaml"))
    engine_mock = MagicMock()
    engine_mock.evaluate.side_effect = ValueError("Supply < Demand at all Pc")
    x13 = [0.002, 1.0, 8.0, 0.14, 12.0, 0.002, 45.0, 0.012, 0.0022, 45.0, 0.011, 550.0, 650.0]

    def _dc(obj, memo=None):
        return real_cfg if obj is real_cfg else copy.deepcopy(obj)

    with patch("engine.optimizer.layers.layer1_static_optimization.copy.deepcopy", side_effect=_dc), \
            patch("engine.optimizer.layers.layer1_static_optimization.PintleEngineRunner",
                  return_value=engine_mock), \
            patch("engine.optimizer.layers.layer1_static_optimization.cma.CMAEvolutionStrategy") as mcma, \
            patch("engine.optimizer.layers.layer1_static_optimization.minimize") as mmin, \
            patch("engine.optimizer.layers.layer1_static_optimization.ProcessPoolExecutor"):
        mcma.return_value.stop.return_value = True
        mcma.return_value.result.xbest = x13
        mcma.return_value.result.fbest = 0.1
        lb = MagicMock(); lb.x = np.array(x13); lb.fun = 0.05; lb.success = True
        mmin.return_value = lb
        req = real_cfg.design_requirements.model_dump()
        try:
            L1.run_layer1_optimization(
                config_obj=real_cfg, runner=MagicMock(), requirements=req, target_burn_time=10.0,
                tolerances={"thrust": 0.1}, pressure_config={"mode": "optimizer_controlled"},
                layer1_max_iterations=1, layer1_cma_restarts=1)
        except Exception:
            pass       # validation cannot replay a design nothing evaluates; not under test
        assert mmin.call_args is not None
        objective = mmin.call_args[0][0]
        vals = [objective(np.array(x13, dtype=float)) for _ in range(205)]
    assert min(vals) >= 1e6


def test_closure_plate_is_sized_by_roark_fixed_edge():
    """The face-closure thickness in the chamber-mass proxy used t = a sqrt(0.3 p / sigma),
    37 % thinner than Roark's fixed-edge plate, sigma_max = 3 p a^2 / (4 t^2)."""
    a, p, sig, rho = 0.0635, 3.0e6, 205e6, 3400.0
    t = a * math.sqrt(3.0 * p / (4.0 * sig))
    A_c = math.pi * (2 * a) ** 2 / 4
    m_barrel_only = L1._layer1_chamber_mass_kg(A_c, 0.1, WALL, rho, Pc_pa=0.0)
    m = L1._layer1_chamber_mass_kg(A_c, 0.1, WALL, rho, Pc_pa=p)
    assert m - m_barrel_only == pytest.approx(math.pi * a * a * t * rho, rel=1e-12)
