"""Layer-1 design vector for impinging injectors (13 DOF: paired unlike doublets, vs 10 DOF pintle)."""

import copy
import math
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
import logging

import numpy as np

from engine.pipeline.io import load_config
from engine.optimizer.injector_dp_penalty import (
    injector_dp_ratios_from_eval_result,
    injector_dp_ratio_penalty_weighted,
)
from engine.optimizer.layers.layer1_static_optimization import (
    TOTAL_WALL_THICKNESS_M,
    _LAYER1_DEFAULT_DP_F_BAND,
    _LAYER1_DEFAULT_DP_O_BAND,
    _LAYER1_DEFAULT_EXIT_PRESSURE_INSIDE_QUAD,
    _LAYER1_DEFAULT_MIN_STABILITY_MARGIN,
    _compute_objective_value,
    create_layer1_apply_x_to_config,
    run_layer1_optimization,
    _expected_geom_ao_af_for_unit_momentum_ratio,
    _geom_ao_af_momentum_hint_squared,
    _impinging_jet_pair_asymmetry_squared,
    _layer1_exit_pressure_sq_term,
    _impinging_momentum_band_violation_squared,
    _impinging_momentum_hinge_squared,
    _layer1_cma_warmstart_candidates,
    _merge_runner_eval_into_performance,
    _snap_integer_dims,
)
from engine.core.closure import flows
from engine.core.runner import PintleEngineRunner
from engine.core.injectors.impinging import momentum_ratio_R_from_bulk_velocities


ROOT = Path(__file__).resolve().parents[1]


def _impinging_bounds_placeholder(max_chamber_od: float = 0.18):
    """Loose bounds compatible with configs/impinging_smoke.yaml geometry.

    Vector: throat, L*, eps, OD, n_doublets (int), LOX jets (d_jet, θ, spacing),
    fuel jets (d_jet, θ, spacing), P_O_start, P_F_start.
    """
    min_a = 5e-5
    n_hi = 36.0
    return [
        (min_a, 4.0e-3),
        (0.3, 3.0),
        (6.0, 12.0),
        (max_chamber_od * 0.5, max_chamber_od),
        (6.0, n_hi + 0.99),
        (0.0005, 0.004),
        (15.0, 85.0),
        (0.003, 0.06),
        (0.0005, 0.004),
        (15.0, 85.0),
        (0.003, 0.06),
        (400.0, 600.0),
        (500.0, 720.0),
    ]


class TestLayer1ImpingingVector(unittest.TestCase):
    def test_worker_objective_impinging_indices_do_not_alias_fuel_spacing_with_pressure(self):
        """Regression: x[11] is P_O, not fuel spacing."""
        x_base = np.array(
            [
                0.0016,  # A_throat
                1.1,     # L*
                8.0,     # eps
                0.17,    # D_outer
                24.0,    # n_doublets
                0.0026,  # d_jet_O
                50.0,    # ang_O
                0.010,   # sp_O
                0.0019,  # d_jet_F
                60.0,    # ang_F
                0.009,   # sp_F
                620.0,   # P_O_start_psi
                700.0,   # P_F_start_psi
            ],
            dtype=float,
        )
        x_alt = x_base.copy()
        x_alt[11] = 860.0  # Change only P_O. Objective geometry terms should be unchanged.

        requirements = {
            "min_stability_margin": 0.0,
            "min_stability_score": 0.0,
            "require_stable_state": False,
            "layer1_infeasibility_gate_eps": 1.0,  # ignore tiny geometric residuals for this regression
        }
        constants = {
            "injector_type": "impinging",
            "idx_P_O": 11,
            "idx_P_F": 12,
            "target_thrust": 8000.0,
            "optimal_of": 3.5,
            "P_ambient": 101325.0,
            "max_lox_P_psi": 900.0,
            "max_fuel_P_psi": 900.0,
            "TOTAL_WALL_THICKNESS_M": TOTAL_WALL_THICKNESS_M,
            "max_nozzle_exit": 0.177,
            "layer1_W_THRUST": 8000.0,
            "layer1_W_OF": 200000.0,
            "layer1_W_OF_low_MR_scale": 1.0,
            "layer1_W_OF_high_MR_scale": 1.0,
        }
        result = {
            "F": 8000.0,
            "MR": 3.5,
            "Pc": 2.5e6,
            "Cf": 1.55,
            "Cf_actual": 1.55,
            "P_exit": 101325.0,
            "stability_results": {
                "stability_state": "stable",
                "stability_score": 1.0,
                "chugging": {"stability_margin": 1.0},
                "acoustic": {"stability_margin": 1.0},
                "feed_system": {"stability_margin": 1.0},
            },
            "diagnostics": {"momentum_ratio_R": 1.0},
        }

        obj_a = _compute_objective_value(result, x_base, requirements, constants)
        obj_b = _compute_objective_value(result, x_alt, requirements, constants)
        self.assertAlmostEqual(obj_a, obj_b, places=9)

    def test_momentum_hinge_zero_inside_log_deadband(self):
        """Zero hinge when |log R| <= log(1.1) i.e. R in [1/1.1, 1.1]."""
        tol_lo = 1.0 / 1.1
        tol_hi = 1.1
        for R in (1.0, tol_lo, tol_hi, 0.95, 1.05):
            v = _impinging_momentum_hinge_squared(R)
            self.assertAlmostEqual(v, 0.0, places=12, msg=f"R={R}")

    def test_momentum_hinge_positive_outside_band(self):
        self.assertGreater(_impinging_momentum_hinge_squared(0.5), 0.0)
        self.assertGreater(_impinging_momentum_hinge_squared(2.0), 0.0)

    def test_momentum_hinge_symmetry_R_and_reciprocal(self):
        pairs = [(0.5, 2.0), (1.2, 1.0 / 1.2), (0.7, 1.0 / 0.7)]
        for a, b in pairs:
            self.assertAlmostEqual(
                _impinging_momentum_hinge_squared(a),
                _impinging_momentum_hinge_squared(b),
                places=12,
                msg=f"pair ({a}, {b})",
            )

    def test_momentum_hinge_skips_invalid_R(self):
        self.assertEqual(_impinging_momentum_hinge_squared(None), 0.0)
        self.assertEqual(_impinging_momentum_hinge_squared(-0.5), 0.0)
        self.assertEqual(_impinging_momentum_hinge_squared(0.0), 0.0)

    def test_momentum_hinge_ratio_band_deadband(self):
        """Custom [0.85, 1.15] band: zero inside, quadratic outside."""
        lo, hi = 0.85, 1.15
        self.assertAlmostEqual(
            _impinging_momentum_hinge_squared(1.0, r_band_lo=lo, r_band_hi=hi), 0.0, places=12
        )
        self.assertAlmostEqual(
            _impinging_momentum_hinge_squared(0.85, r_band_lo=lo, r_band_hi=hi), 0.0, places=12
        )
        self.assertAlmostEqual(
            _impinging_momentum_hinge_squared(1.15, r_band_lo=lo, r_band_hi=hi), 0.0, places=12
        )
        self.assertGreater(_impinging_momentum_hinge_squared(0.84, r_band_lo=lo, r_band_hi=hi), 0.0)
        self.assertGreater(_impinging_momentum_hinge_squared(1.16, r_band_lo=lo, r_band_hi=hi), 0.0)

    def test_momentum_band_violation_squared_zero_inside(self):
        self.assertAlmostEqual(
            _impinging_momentum_band_violation_squared(1.0, r_band_lo=0.8, r_band_hi=1.2),
            0.0,
            places=12,
        )

    def test_momentum_band_violation_squared_positive_outside(self):
        v = _impinging_momentum_band_violation_squared(0.619, r_band_lo=0.8, r_band_hi=1.2)
        self.assertGreater(v, 0.0)

    def test_expected_geom_ao_af_matches_mr_over_sqrt_density_ratio(self):
        rho_o = 1141.0
        rho_f = 423.0
        mr = 3.5
        exp = _expected_geom_ao_af_for_unit_momentum_ratio(mr, rho_o, rho_f)
        self.assertAlmostEqual(exp, mr / math.sqrt(rho_o / rho_f), places=9)

    def test_geom_ao_af_hint_squared_zero_when_matching_expected(self):
        rho_o = 1000.0
        rho_f = 250.0
        mr = 2.0
        exp = _expected_geom_ao_af_for_unit_momentum_ratio(mr, rho_o, rho_f)
        A_f = 1e-5
        A_o = exp * A_f
        sq, ao_af, exp2 = _geom_ao_af_momentum_hint_squared(A_o, A_f, mr, rho_o, rho_f)
        self.assertAlmostEqual(sq, 0.0, places=12)
        self.assertAlmostEqual(ao_af, exp, places=12)
        self.assertAlmostEqual(exp2, exp, places=12)

    def test_design_vector_length_is_13_for_paired_impinging_doublets(self):
        b = _impinging_bounds_placeholder()
        self.assertEqual(len(b), 13)

    def test_snap_integer_dims_index_4_only_n_doublets(self):
        x = np.arange(13.0)
        x[4] = 12.3
        out = _snap_integer_dims(x, [4])
        self.assertEqual(out[4], 12.0)

    def test_apply_x_impinging_preserves_type_and_geometry(self):
        cfg_path = ROOT / "configs" / "impinging_smoke.yaml"
        base = load_config(str(cfg_path))
        self.assertEqual(base.injector.type, "impinging")

        cg = base.chamber_geometry
        g = base.injector.geometry
        D_outer = float(cg.chamber_diameter) + TOTAL_WALL_THICKNESS_M

        n_d = min(int(g.oxidizer.n_elements), int(g.fuel.n_elements))
        x = np.array(
            [
                float(cg.A_throat),
                float(cg.Lstar),
                float(cg.expansion_ratio),
                D_outer,
                float(n_d),
                float(g.oxidizer.d_jet),
                float(g.oxidizer.impingement_angle),
                float(g.oxidizer.spacing),
                float(g.fuel.d_jet),
                float(g.fuel.impingement_angle),
                float(g.fuel.spacing),
                float(base.lox_tank.initial_pressure_psi),
                float(base.fuel_tank.initial_pressure_psi),
            ],
            dtype=float,
        )

        bounds = _impinging_bounds_placeholder(max_chamber_od=max(D_outer * 1.2, 0.18))
        apply_fn = create_layer1_apply_x_to_config(
            bounds,
            max_chamber_od=bounds[3][1],
            max_nozzle_exit=0.15,
            injector_type="impinging",
        )
        out_cfg, p_o, p_f = apply_fn(x, base)
        self.assertEqual(out_cfg.injector.type, "impinging")
        nd_snap = int(round(x[4]))
        self.assertEqual(out_cfg.injector.geometry.oxidizer.n_elements, nd_snap)
        self.assertEqual(out_cfg.injector.geometry.fuel.n_elements, nd_snap)
        self.assertAlmostEqual(p_o, float(np.clip(x[11], bounds[11][0], bounds[11][1])))
        self.assertAlmostEqual(p_f, float(np.clip(x[12], bounds[12][0], bounds[12][1])))

    def test_flows_includes_injection_velocities(self):
        cfg = load_config(str(ROOT / "configs" / "impinging_smoke.yaml"))
        Po = cfg.lox_tank.initial_pressure_psi * 6894.76
        Pf = cfg.fuel_tank.initial_pressure_psi * 6894.76
        Pc = 2.0e6
        _mdot_o, _mdot_f, diag = flows(Po, Pf, Pc, cfg)
        self.assertIn("u_O", diag)
        self.assertIn("u_F", diag)
        self.assertTrue(np.isfinite(diag["u_O"]))
        self.assertTrue(np.isfinite(diag["u_F"]))
        self.assertIn("turbulence_intensity_mix", diag)
        self.assertTrue(np.isfinite(diag["turbulence_intensity_mix"]))
        self.assertIn("momentum_ratio_R", diag)
        self.assertTrue(np.isfinite(diag["momentum_ratio_R"]))
        self.assertGreater(diag["momentum_ratio_R"], 0.0)
        self.assertIn("v_O_bulk", diag)
        self.assertIn("v_F_bulk", diag)
        self.assertIn("rho_O_momentum", diag)
        self.assertIn("rho_F_momentum", diag)

    def test_momentum_ratio_R_matches_analytic(self):
        rho_O, rho_F = 1000.0, 500.0
        v_O = 10.0
        v_F = v_O * np.sqrt(rho_O / rho_F)
        R1 = momentum_ratio_R_from_bulk_velocities(rho_O, rho_F, v_O, v_F)
        self.assertAlmostEqual(R1, 1.0, places=12)

        R2 = momentum_ratio_R_from_bulk_velocities(1000.0, 1000.0, 20.0, 10.0)
        self.assertAlmostEqual(R2, 2.0, places=12)

        R3 = momentum_ratio_R_from_bulk_velocities(1000.0, 1000.0, 10.0, 20.0)
        self.assertAlmostEqual(R3, 0.5, places=12)

    def test_flows_momentum_ratio_matches_bulk_formula(self):
        cfg = load_config(str(ROOT / "configs" / "impinging_smoke.yaml"))
        Po = cfg.lox_tank.initial_pressure_psi * 6894.76
        Pf = cfg.fuel_tank.initial_pressure_psi * 6894.76
        Pc = 2.0e6
        _mdot_o, _mdot_f, diag = flows(Po, Pf, Pc, cfg)
        R_calc = momentum_ratio_R_from_bulk_velocities(
            float(diag["rho_O_momentum"]),
            float(diag["rho_F_momentum"]),
            float(diag["v_O_bulk"]),
            float(diag["v_F_bulk"]),
        )
        np.testing.assert_allclose(diag["momentum_ratio_R"], R_calc, rtol=1e-9, atol=0.0)

    def test_runner_evaluate_impinging_smoke(self):
        cfg = load_config(str(ROOT / "configs" / "impinging_smoke.yaml"))
        r = PintleEngineRunner(cfg)
        Po = cfg.lox_tank.initial_pressure_psi * 6894.76
        Pf = cfg.fuel_tank.initial_pressure_psi * 6894.76
        res = r.evaluate(Po, Pf, P_ambient=101325.0, silent=True)
        self.assertGreater(float(res.get("Pc") or 0.0), 0.0)
        ip = res.get("injector_pressure") or {}
        self.assertIsNotNone(ip.get("P_injector_O"))
        self.assertIsNotNone(ip.get("P_injector_F"))
        dfull = res.get("diagnostics") or {}
        self.assertIn("momentum_ratio_R", dfull)
        self.assertTrue(np.isfinite(dfull["momentum_ratio_R"]))

    def test_layer1_impinging_mocked_one_iteration(self):
        real_cfg = load_config(str(ROOT / "configs" / "impinging_smoke.yaml"))
        mock_runner = MagicMock()

        x13 = [
            0.002,
            1.0,
            8.0,
            0.14,
            12.0,
            0.002,
            45.0,
            0.012,
            0.0022,
            45.0,
            0.011,
            550.0,
            650.0,
        ]

        def _dc(obj):
            if obj is real_cfg:
                return real_cfg
            return copy.deepcopy(obj)

        mock_engine = MagicMock()
        mock_engine.evaluate.return_value = {
            "F": 7000.0,
            "Pc": 2.5e6,
            "MR": 2.3,
            "Cf": 1.55,
            "Cf_actual": 1.55,
            "mdot_O": 1.0,
            "mdot_F": 0.45,
            "stability_results": {},
        }

        with patch(
            "engine.optimizer.layers.layer1_static_optimization.copy.deepcopy",
            side_effect=_dc,
        ), patch(
            "engine.optimizer.layers.layer1_static_optimization.PintleEngineRunner",
            return_value=mock_engine,
        ), patch(
            "engine.optimizer.layers.layer1_static_optimization.cma.CMAEvolutionStrategy"
        ) as mock_cma, patch(
            "engine.optimizer.layers.layer1_static_optimization.minimize"
        ) as mock_minimize, patch(
            "engine.optimizer.layers.layer1_static_optimization.ProcessPoolExecutor"
        ):
            mock_es = mock_cma.return_value
            mock_es.stop.return_value = True
            mock_es.result.xbest = x13
            mock_es.result.fbest = 0.1

            mock_lbfgs_res = MagicMock()
            mock_lbfgs_res.x = np.array(x13)
            mock_lbfgs_res.fun = 0.05
            mock_lbfgs_res.success = True
            mock_minimize.return_value = mock_lbfgs_res

            with patch(
                "engine.optimizer.layers.layer1_static_optimization.create_layer1_apply_x_to_config"
            ) as mock_create_apply:
                mock_apply = MagicMock()
                mock_apply.return_value = (real_cfg, 560.0, 660.0)
                mock_create_apply.return_value = mock_apply

                mock_update_progress = MagicMock()
                mock_log_status = MagicMock()
                requirements = real_cfg.design_requirements.model_dump()

                optimized_config, _results = run_layer1_optimization(
                    config_obj=real_cfg,
                    runner=mock_runner,
                    requirements=requirements,
                    target_burn_time=10.0,
                    tolerances={"thrust": 0.1, "apogee": 0.15},
                    pressure_config={"mode": "optimizer_controlled"},
                    update_progress=mock_update_progress,
                    log_status=mock_log_status,
                    layer1_max_iterations=1,
                    layer1_cma_restarts=1,
                )

        self.assertIsNotNone(optimized_config.lox_tank)
        self.assertIsNotNone(optimized_config.fuel_tank)
        self.assertTrue(np.isfinite(optimized_config.lox_tank.initial_pressure_psi))
        self.assertTrue(np.isfinite(optimized_config.fuel_tank.initial_pressure_psi))
        self.assertLessEqual(optimized_config.lox_tank.initial_pressure_psi, 700.0)
        self.assertLessEqual(optimized_config.fuel_tank.initial_pressure_psi, 850.0)

    def test_merge_runner_eval_enables_dp_and_momentum_metrics(self):
        """Stored-validation path must merge diagnostics/injector_pressure like runner.evaluate."""
        pc = 2.0e6
        initial_performance: dict = {"Pc": pc}
        eval_results = {
            "diagnostics": {
                "momentum_ratio_R": 1.05,
                "delta_p_injector_O": 0.26 * pc,
                "delta_p_injector_F": 0.28 * pc,
            },
            "injector_pressure": {"delta_p_injector_O": 0.26 * pc},
        }
        _merge_runner_eval_into_performance(initial_performance, eval_results)
        ro, rf = injector_dp_ratios_from_eval_result(pc, initial_performance)
        self.assertIsNotNone(ro)
        self.assertIsNotNone(rf)
        self.assertAlmostEqual(ro, 0.26, places=6)
        self.assertAlmostEqual(rf, 0.28, places=6)
        pen = injector_dp_ratio_penalty_weighted(ro, rf, 50.0, 50.0)
        self.assertTrue(np.isfinite(pen))
        mr = initial_performance["diagnostics"]["momentum_ratio_R"]
        self.assertAlmostEqual(mr, 1.05, places=6)
        w_mom = 75.0
        mbp = float(w_mom * _impinging_momentum_hinge_squared(mr))
        self.assertTrue(np.isfinite(mbp))

    def test_impinging_eval_mr_matches_mass_flow_ratio(self):
        """MR is mass-based O/F: must equal mdot_O/mdot_F everywhere (runner + chamber solver)."""
        cfg = load_config(ROOT / "configs" / "impinging_smoke.yaml")
        pc = cfg.pressure_curves
        runner = PintleEngineRunner(copy.deepcopy(cfg))
        out = runner.evaluate(
            float(pc.initial_lox_pressure_pa),
            float(pc.initial_fuel_pressure_pa),
            silent=True,
        )
        mo = float(out["mdot_O"])
        mf = float(out["mdot_F"])
        mr = float(out["MR"])
        self.assertGreater(mf, 0.0)
        self.assertAlmostEqual(mr, mo / mf, places=12)

    def test_cma_warmstart_zero_trials_skips_eval(self):
        """Warm-start with n_trials=0 must not call the executor (no fake objectives)."""
        ex = MagicMock()
        lo = np.zeros(3)
        hi = np.ones(3)
        x, f = _layer1_cma_warmstart_candidates(
            np.array([0.2, 0.5, 0.8]),
            lower_bounds=lo,
            upper_bounds=hi,
            span=hi - lo,
            integer_dims=[],
            rng=np.random.default_rng(0),
            executor=ex,
            n_trials=0,
            sigma_frac=0.04,
            eval_cache={},
            make_cache_key_fn=lambda a: tuple(np.round(a, 6)),
            opt_state={"function_evaluations": 0},
            logger=logging.getLogger("test"),
        )
        ex.map.assert_not_called()
        self.assertTrue(np.all(x >= lo) and np.all(x <= hi))
        self.assertTrue(np.isinf(f))

    def test_min_stability_margin_default_worker_parent_aligned(self):
        """Parallel workers score candidates with ``_compute_objective_value``; parent uses ``objective()``."""
        self.assertEqual(_LAYER1_DEFAULT_MIN_STABILITY_MARGIN, 1.2)
        self.assertEqual(_LAYER1_DEFAULT_DP_O_BAND, (0.15, 0.40))
        self.assertEqual(_LAYER1_DEFAULT_DP_F_BAND, (0.15, 0.40))
        self.assertEqual(_LAYER1_DEFAULT_EXIT_PRESSURE_INSIDE_QUAD, 0.35)

    def test_exit_pressure_inside_band_quad_scale(self):
        """Inside-rel quad steers toward P_target without changing the hinge outside the deadband."""
        target = 100_000.0
        flat = _layer1_exit_pressure_sq_term(103_000.0, target, inside_rel_quad_scale=0.0)
        self.assertAlmostEqual(flat, 0.0, places=15)
        rel = 0.03
        q = _layer1_exit_pressure_sq_term((1.0 + rel) * target, target, inside_rel_quad_scale=2.0)
        self.assertAlmostEqual(q, 2.0 * rel * rel)
        outs = _layer1_exit_pressure_sq_term(113_000.0, target, inside_rel_quad_scale=0.0)
        self.assertAlmostEqual(outs, 0.08**2)

    def test_impinging_jet_pair_asymmetry_squared(self):
        self.assertAlmostEqual(
            _impinging_jet_pair_asymmetry_squared(45.0, 45.0, max_delta_deg=26.0),
            0.0,
        )
        dd = abs(62.43 - 16.79)
        excess = dd - 26.0
        span = max(26.0, 5.0)
        self.assertAlmostEqual(
            _impinging_jet_pair_asymmetry_squared(62.43, 16.79, max_delta_deg=26.0),
            (excess / span) ** 2,
            places=12,
        )
        self.assertAlmostEqual(_impinging_jet_pair_asymmetry_squared(17.0, 42.0, max_delta_deg=28.0), 0.0)


if __name__ == "__main__":
    unittest.main()
