"""Feed loss ⇄ Bernoulli fixed point for impinging injector."""

import unittest
from pathlib import Path

import numpy as np

from engine.pipeline.io import load_config
from engine.core.injectors.impinging import ImpingingInjector

ROOT = Path(__file__).resolve().parents[1]


class TestImpingingFeedOrificeClosure(unittest.TestCase):
    def test_mdot_matches_bernoulli_with_reported_delta_p_injector(self):
        """Regression: returned ṁ must satisfy ṁ = Cd A √(2 ρ Δp_inj) for final diagnostics."""
        cfg = load_config(str(ROOT / "configs" / "impinging_smoke.yaml"))
        Pc = 1.55e6
        Po = float(cfg.lox_tank.initial_pressure_psi) * 6894.76
        Pf = float(cfg.fuel_tank.initial_pressure_psi) * 6894.76

        mdot_O, mdot_F, diag = ImpingingInjector(cfg).solve(Po, Pf, Pc)
        self.assertGreater(mdot_O + mdot_F, 0.0)

        rho_O = cfg.fluids["oxidizer"].density
        rho_F = cfg.fluids["fuel"].density
        geo = cfg.injector.geometry
        A_O = geo.oxidizer.n_elements * np.pi * (geo.oxidizer.d_jet / 2.0) ** 2
        A_F = geo.fuel.n_elements * np.pi * (geo.fuel.d_jet / 2.0) ** 2

        dpi_O = diag["delta_p_injector_O"]
        dpi_F = diag["delta_p_injector_F"]
        Cd_O = diag["Cd_O"]
        Cd_F = diag["Cd_F"]

        expect_O = float(Cd_O * A_O * np.sqrt(2.0 * rho_O * dpi_O)) if dpi_O > 0 else 0.0
        expect_F = float(Cd_F * A_F * np.sqrt(2.0 * rho_F * dpi_F)) if dpi_F > 0 else 0.0

        np.testing.assert_allclose(diag["mdot_from_bernoulli_O"], expect_O, rtol=1e-14, atol=1e-12)
        np.testing.assert_allclose(diag["mdot_from_bernoulli_F"], expect_F, rtol=1e-14, atol=1e-12)
        np.testing.assert_allclose(mdot_O, expect_O, rtol=1e-12, atol=1e-12)
        np.testing.assert_allclose(mdot_F, expect_F, rtol=1e-12, atol=1e-12)
        self.assertGreater(diag["feed_orifice_coupling_iterations"], 0)


if __name__ == "__main__":
    unittest.main()
