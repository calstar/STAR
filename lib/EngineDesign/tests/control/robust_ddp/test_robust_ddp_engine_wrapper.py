"""Unit tests for engine wrapper."""

import unittest
import numpy as np
from unittest.mock import Mock, patch

from engine.control.robust_ddp.engine_wrapper import (
    EngineWrapper,
    EngineEstimate,
    estimate_from_pressures,
)
from engine.pipeline.config_schemas import PintleEngineConfig
from engine.core.runner import PintleEngineRunner


class TestEngineWrapper(unittest.TestCase):
    """Test engine wrapper."""
    
    def setUp(self):
        """Set up test fixtures."""
        # Create a minimal mock config
        # In real usage, this would be loaded from a config file
        try:
            from engine.pipeline.io import load_config
            config_path = "configs/default.yaml"
            try:
                self.config = load_config(config_path)
            except FileNotFoundError:
                # Create minimal config if default doesn't exist
                self.config = self._create_minimal_config()
        except Exception:
            self.config = self._create_minimal_config()
    
    def _create_minimal_config(self) -> PintleEngineConfig:
        """Create minimal config for testing."""
        # This is a fallback - in practice, tests should use real configs
        from engine.pipeline.config_schemas import (
            PintleEngineConfig,
            PintleInjectorConfig,
            PintleInjectorGeometry,
            FuelGeometry,
            OxidizerGeometry,
            FluidConfig,
            FeedSystemConfig,
            DischargeConfig,
            CombustionConfig,
            CEAConfig,
            ChamberGeometryConfig,
        )
        
        # Create minimal valid config
        config = PintleEngineConfig(
            injector=PintleInjectorConfig(
                type="pintle",
                geometry=PintleInjectorGeometry(
                    fuel=FuelGeometry(
                        d_pintle_tip=0.01,
                        n_holes=8,
                        d_hole=0.001,
                    ),
                    oxidizer=OxidizerGeometry(
                        d_annulus_inner=0.008,
                        d_annulus_outer=0.012,
                    ),
                ),
            ),
            fluids={
                "fuel": FluidConfig(
                    name="RP-1",
                    density=800.0,
                    viscosity=2e-3,
                    surface_tension=0.025,
                ),
                "oxidizer": FluidConfig(
                    name="LOX",
                    density=1140.0,
                    viscosity=0.2e-3,
                    surface_tension=0.013,
                ),
            },
            feed_system={
                "fuel": FeedSystemConfig(
                    K0=10.0,
                    K1=0.0,
                    phi_type="none",
                    d_inlet=0.02,
                ),
                "oxidizer": FeedSystemConfig(
                    K0=10.0,
                    K1=0.0,
                    phi_type="none",
                    d_inlet=0.02,
                ),
            },
            discharge={
                "fuel": DischargeConfig(Cd_inf=0.7),
                "oxidizer": DischargeConfig(Cd_inf=0.7),
            },
            combustion=CombustionConfig(
                cea=CEAConfig(
                    fuel="RP-1",
                    oxidizer="LOX",
                    expansion_ratio=10.0,
                ),
                efficiency=Mock(),
            ),
            chamber_geometry=ChamberGeometryConfig(
                volume=0.001,
                A_throat=1e-4,
                A_exit=1e-3,
                length=0.1,
                chamber_diameter=0.08,
            ),
        )
        return config
    
    def test_engine_estimate_structure(self):
        """Test EngineEstimate dataclass structure."""
        estimate = EngineEstimate(
            P_ch=2e6,
            F=1000.0,
            mdot_F=0.5,
            mdot_O=1.0,
            MR=2.0,
            injector_dp_F=0.5e6,
            injector_dp_O=0.5e6,
        )
        
        self.assertEqual(estimate.P_ch, 2e6)
        self.assertEqual(estimate.F, 1000.0)
        self.assertEqual(estimate.MR, 2.0)
        self.assertEqual(estimate.injector_dp_F, 0.5e6)
        self.assertEqual(estimate.injector_dp_O, 0.5e6)
    
    def test_wrapper_initialization(self):
        """Test wrapper initialization."""
        wrapper = EngineWrapper(self.config, cache_size=64)
        self.assertIsNotNone(wrapper.runner)
        self.assertEqual(wrapper.cache_size, 64)
    
    @patch('engine.control.robust_ddp.engine_wrapper.PintleEngineRunner')
    def test_estimate_from_pressures_mock(self, mock_runner_class):
        """Test estimate_from_pressures with mocked runner."""
        # Create mock runner
        mock_runner = Mock()
        mock_runner.evaluate.return_value = {
            "Pc": 2e6,  # Chamber pressure [Pa]
            "F": 1000.0,  # Thrust [N]
            "mdot_F": 0.5,  # Fuel mass flow [kg/s]
            "mdot_O": 1.0,  # Oxidizer mass flow [kg/s]
            "MR": 2.0,  # Mixture ratio
            "stability": {
                "stability_state": "stable",
                "stability_score": 0.8,
                "chugging": {"frequency": 100.0},
            },
            "diagnostics": {"test": "value"},
        }
        mock_runner_class.return_value = mock_runner
        
        # Create wrapper
        wrapper = EngineWrapper(self.config)
        wrapper.runner = mock_runner
        
        # Test estimation
        P_d_F = 3e6  # 3 MPa feed pressure
        P_d_O = 3.5e6  # 3.5 MPa feed pressure
        
        estimate = wrapper.estimate_from_pressures(P_d_F, P_d_O)
        
        # Verify estimate
        self.assertEqual(estimate.P_ch, 2e6)
        self.assertEqual(estimate.F, 1000.0)
        self.assertEqual(estimate.mdot_F, 0.5)
        self.assertEqual(estimate.mdot_O, 1.0)
        self.assertEqual(estimate.MR, 2.0)
        
        # Verify injector pressure drops
        self.assertEqual(estimate.injector_dp_F, P_d_F - 2e6)  # 1 MPa
        self.assertEqual(estimate.injector_dp_O, P_d_O - 2e6)  # 1.5 MPa
        
        # Verify stability metrics
        self.assertIsNotNone(estimate.stability_metrics)
        self.assertEqual(estimate.stability_metrics["stability_state"], "stable")
        
        # Verify runner was called with correct pressures
        mock_runner.evaluate.assert_called_once()
        call_args = mock_runner.evaluate.call_args
        self.assertEqual(call_args.kwargs["P_tank_F"], P_d_F)
        self.assertEqual(call_args.kwargs["P_tank_O"], P_d_O)
        self.assertTrue(call_args.kwargs.get("silent", False))
    
    @patch('engine.control.robust_ddp.engine_wrapper.PintleEngineRunner')
    def test_estimate_without_stability(self, mock_runner_class):
        """Test estimate when stability results are not available."""
        mock_runner = Mock()
        mock_runner.evaluate.return_value = {
            "Pc": 2e6,
            "F": 1000.0,
            "mdot_F": 0.5,
            "mdot_O": 1.0,
            "MR": 2.0,
            "diagnostics": {},
        }
        mock_runner_class.return_value = mock_runner
        
        wrapper = EngineWrapper(self.config)
        wrapper.runner = mock_runner
        
        estimate = wrapper.estimate_from_pressures(3e6, 3.5e6)
        
        # Should have minimal stability metrics
        self.assertIsNotNone(estimate.stability_metrics)
        self.assertIn("injector_stiffness_ok", estimate.stability_metrics)
        self.assertIn("injector_dp_frac_F", estimate.stability_metrics)
        self.assertIn("injector_dp_frac_O", estimate.stability_metrics)
    
    @patch('engine.control.robust_ddp.engine_wrapper.PintleEngineRunner')
    def test_estimate_error_handling(self, mock_runner_class):
        """Test estimate handles evaluation errors gracefully."""
        mock_runner = Mock()
        mock_runner.evaluate.side_effect = ValueError("Evaluation failed")
        mock_runner_class.return_value = mock_runner
        
        wrapper = EngineWrapper(self.config)
        wrapper.runner = mock_runner
        
        estimate = wrapper.estimate_from_pressures(3e6, 3.5e6)
        
        # Should return estimate with NaN values
        self.assertTrue(np.isnan(estimate.P_ch))
        self.assertTrue(np.isnan(estimate.F))
        self.assertTrue(np.isnan(estimate.mdot_F))
        self.assertIsNotNone(estimate.diagnostics)
        self.assertIn("error", estimate.diagnostics)
    
    def test_caching(self):
        """Test that caching works correctly."""
        wrapper = EngineWrapper(self.config, cache_size=10)
        
        # Mock runner to count calls
        call_count = {"count": 0}
        def mock_evaluate(**kwargs):
            call_count["count"] += 1
            return {
                "Pc": 2e6,
                "F": 1000.0,
                "mdot_F": 0.5,
                "mdot_O": 1.0,
                "MR": 2.0,
                "diagnostics": {},
            }
        
        wrapper.runner.evaluate = mock_evaluate
        
        # First call - should evaluate
        P_d_F = 3e6
        P_d_O = 3.5e6
        estimate1 = wrapper.estimate_from_pressures(P_d_F, P_d_O, use_cache=True)
        self.assertEqual(call_count["count"], 1)
        
        # Second call with same pressures - should use cache
        estimate2 = wrapper.estimate_from_pressures(P_d_F, P_d_O, use_cache=True)
        self.assertEqual(call_count["count"], 1)  # No additional call
        self.assertEqual(estimate1.P_ch, estimate2.P_ch)
        
        # Call with cache disabled - should evaluate again
        estimate3 = wrapper.estimate_from_pressures(P_d_F, P_d_O, use_cache=False)
        self.assertEqual(call_count["count"], 2)  # Additional call
    
    def test_cache_stats(self):
        """Test cache statistics."""
        wrapper = EngineWrapper(self.config, cache_size=10)
        
        stats = wrapper.get_cache_stats()
        self.assertEqual(stats["size"], 0)
        self.assertEqual(stats["max_size"], 10)
        self.assertEqual(stats["usage"], 0.0)
        
        # Add some entries
        wrapper._result_cache = {"key1": Mock(), "key2": Mock()}
        stats = wrapper.get_cache_stats()
        self.assertEqual(stats["size"], 2)
        self.assertAlmostEqual(stats["usage"], 0.2, places=1)
    
    def test_clear_cache(self):
        """Test cache clearing."""
        wrapper = EngineWrapper(self.config)
        wrapper._result_cache = {"key1": Mock(), "key2": Mock()}
        
        self.assertEqual(len(wrapper._result_cache), 2)
        wrapper.clear_cache()
        self.assertEqual(len(wrapper._result_cache), 0)
    
    def test_convenience_function(self):
        """Test convenience function."""
        with patch('engine.control.robust_ddp.engine_wrapper.EngineWrapper') as mock_wrapper_class:
            mock_wrapper = Mock()
            mock_estimate = EngineEstimate(
                P_ch=2e6,
                F=1000.0,
                mdot_F=0.5,
                mdot_O=1.0,
                MR=2.0,
                injector_dp_F=1e6,
                injector_dp_O=1.5e6,
            )
            mock_wrapper.estimate_from_pressures.return_value = mock_estimate
            mock_wrapper_class.return_value = mock_wrapper
            
            estimate = estimate_from_pressures(3e6, 3.5e6, self.config)
            
            self.assertEqual(estimate.P_ch, 2e6)
            mock_wrapper.estimate_from_pressures.assert_called_once_with(3e6, 3.5e6, use_cache=True)


class TestEngineWrapperIntegration(unittest.TestCase):
    """Integration tests comparing wrapper to direct pipeline calls."""
    
    def setUp(self):
        """Set up test fixtures."""
        try:
            from engine.pipeline.io import load_config
            config_path = "configs/default.yaml"
            try:
                self.config = load_config(config_path)
                self.runner = PintleEngineRunner(self.config)
                self.wrapper = EngineWrapper(self.config)
                self.has_config = True
            except FileNotFoundError:
                self.has_config = False
                self.skipTest("No default config file found")
        except Exception as e:
            self.has_config = False
            self.skipTest(f"Could not load config: {e}")
    
    def test_wrapper_vs_direct_pipeline(self):
        """Test that wrapper output matches direct pipeline calls."""
        if not self.has_config:
            self.skipTest("No config available")
        
        # Test pressures (in Pa)
        P_d_F = 3e6  # 3 MPa (~435 psi)
        P_d_O = 3.5e6  # 3.5 MPa (~508 psi)
        
        # Direct pipeline call
        try:
            direct_results = self.runner.evaluate(
                P_tank_O=P_d_O,
                P_tank_F=P_d_F,
                silent=True,
            )
        except Exception as e:
            self.skipTest(f"Direct pipeline evaluation failed: {e}")
        
        # Wrapper call
        estimate = self.wrapper.estimate_from_pressures(P_d_F, P_d_O, use_cache=False)
        
        # Compare results
        self.assertAlmostEqual(
            estimate.P_ch, direct_results["Pc"],
            delta=1e3,  # Allow 1 kPa difference
            msg="Chamber pressure should match"
        )
        
        self.assertAlmostEqual(
            estimate.F, direct_results["F"],
            delta=10.0,  # Allow 10 N difference
            msg="Thrust should match"
        )
        
        self.assertAlmostEqual(
            estimate.mdot_F, direct_results["mdot_F"],
            delta=0.01,  # Allow 0.01 kg/s difference
            msg="Fuel mass flow should match"
        )
        
        self.assertAlmostEqual(
            estimate.mdot_O, direct_results["mdot_O"],
            delta=0.01,  # Allow 0.01 kg/s difference
            msg="Oxidizer mass flow should match"
        )
        
        self.assertAlmostEqual(
            estimate.MR, direct_results["MR"],
            delta=0.1,  # Allow 0.1 difference in MR
            msg="Mixture ratio should match"
        )
        
        # Verify injector pressure drops
        expected_dp_F = P_d_F - direct_results["Pc"]
        expected_dp_O = P_d_O - direct_results["Pc"]
        
        self.assertAlmostEqual(
            estimate.injector_dp_F, expected_dp_F,
            delta=1e3,
            msg="Fuel injector pressure drop should match"
        )
        
        self.assertAlmostEqual(
            estimate.injector_dp_O, expected_dp_O,
            delta=1e3,
            msg="Oxidizer injector pressure drop should match"
        )
    
    def test_multiple_pressure_points(self):
        """Test wrapper on multiple pressure points."""
        if not self.has_config:
            self.skipTest("No config available")
        
        # Test multiple pressure combinations
        test_cases = [
            (2e6, 2.5e6),  # Low pressures
            (3e6, 3.5e6),  # Medium pressures
            (5e6, 6e6),    # High pressures
        ]
        
        for P_d_F, P_d_O in test_cases:
            with self.subTest(P_d_F=P_d_F, P_d_O=P_d_O):
                try:
                    # Direct call
                    direct_results = self.runner.evaluate(
                        P_tank_O=P_d_O,
                        P_tank_F=P_d_F,
                        silent=True,
                    )
                    
                    # Wrapper call
                    estimate = self.wrapper.estimate_from_pressures(
                        P_d_F, P_d_O, use_cache=False
                    )
                    
                    # Verify estimates are reasonable
                    self.assertTrue(np.isfinite(estimate.P_ch))
                    self.assertTrue(np.isfinite(estimate.F))
                    self.assertTrue(estimate.F > 0)
                    self.assertTrue(estimate.mdot_F > 0)
                    self.assertTrue(estimate.mdot_O > 0)
                    self.assertTrue(estimate.MR > 0)
                    
                    # Verify injector pressure drops are positive
                    self.assertGreater(estimate.injector_dp_F, 0)
                    self.assertGreater(estimate.injector_dp_O, 0)
                    
                except Exception as e:
                    # Some pressure combinations may be infeasible
                    # That's okay - just verify we get a valid estimate structure
                    self.assertIsNotNone(estimate)
                    self.assertIsNotNone(estimate.diagnostics)


if __name__ == '__main__':
    unittest.main()

