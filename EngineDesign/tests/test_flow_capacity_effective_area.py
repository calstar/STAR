"""Effective injector flow area A_eff = Cd × A_geom and integration checks."""

import unittest
from pathlib import Path

import numpy as np

from engine.core.injectors.flow_capacity import effective_flow_areas_from_cd
from engine.pipeline.io import load_config
from engine.core.runner import PintleEngineRunner


ROOT = Path(__file__).resolve().parents[1]


class TestFlowCapacityEffectiveArea(unittest.TestCase):
    def test_effective_area_scales_with_cd(self):
        ag_o, ag_f = 1e-4, 8e-5
        d1 = {"Cd_O": 0.5, "Cd_F": 0.6}
        d2 = {"Cd_O": 0.7, "Cd_F": 0.6}
        e1o, e1f, _ = effective_flow_areas_from_cd(d1, ag_o, ag_f)
        e2o, e2f, _ = effective_flow_areas_from_cd(d2, ag_o, ag_f)
        self.assertAlmostEqual(e2o / e1o, 0.7 / 0.5, places=7)
        self.assertAlmostEqual(e2f, e1f, places=12)

    def test_fallback_when_cd_missing(self):
        ag_o, ag_f = 2e-4, 2e-4
        eo, ef, w = effective_flow_areas_from_cd(None, ag_o, ag_f)
        self.assertEqual(eo, ag_o)
        self.assertEqual(ef, ag_f)
        self.assertIn("no_diagnostics", w)
        eo2, ef2, w2 = effective_flow_areas_from_cd({}, ag_o, ag_f)
        self.assertEqual(eo2, ag_o)
        self.assertTrue(any("fallback_geometric" in x for x in w2))

    def test_impinging_runner_has_cd_and_areas_and_momentum_R(self):
        cfg = load_config(str(ROOT / "configs" / "impinging_smoke.yaml"))
        r = PintleEngineRunner(cfg)
        Po = cfg.lox_tank.initial_pressure_psi * 6894.76
        Pf = cfg.fuel_tank.initial_pressure_psi * 6894.76
        res = r.evaluate(Po, Pf, P_ambient=101325.0, silent=True)
        self.assertIn("Cd_O", res)
        self.assertIn("Cd_F", res)
        self.assertTrue(np.isfinite(res["Cd_O"]) and float(res["Cd_O"]) > 0)
        self.assertTrue(np.isfinite(res["Cd_F"]) and float(res["Cd_F"]) > 0)
        for k in ("A_geom_O", "A_geom_F", "A_eff_O", "A_eff_F"):
            self.assertIn(k, res)
            self.assertTrue(np.isfinite(res[k]))
        self.assertAlmostEqual(float(res["A_eff_O"]), float(res["Cd_O"]) * float(res["A_geom_O"]), places=6)
        self.assertAlmostEqual(float(res["A_eff_F"]), float(res["Cd_F"]) * float(res["A_geom_F"]), places=6)
        d = res.get("diagnostics") or {}
        self.assertAlmostEqual(float(res["Cd_O"]), float(d.get("Cd_O")), places=7)
        diag_mr = d.get("momentum_ratio_R")
        self.assertIsNotNone(diag_mr)
        self.assertTrue(np.isfinite(diag_mr))

    def test_evaluate_arrays_pressure_sweep_changes_mdot(self):
        cfg = load_config(str(ROOT / "configs" / "impinging_smoke.yaml"))
        r = PintleEngineRunner(cfg)
        P0o = cfg.lox_tank.initial_pressure_psi * 6894.76
        P0f = cfg.fuel_tank.initial_pressure_psi * 6894.76
        n = 5
        Po = np.full(n, P0o)
        Pf = np.linspace(P0f * 0.85, P0f * 1.05, n)
        out = r.evaluate_arrays(Po, Pf, P_ambient=101325.0)
        md = out["mdot_total"]
        self.assertEqual(len(md), n)
        self.assertGreater(float(md[-1]), float(md[0]))


if __name__ == "__main__":
    unittest.main()
