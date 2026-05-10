import unittest
from unittest.mock import MagicMock, patch
import numpy as np
from engine.pipeline.config_schemas import PintleEngineConfig, LOXTankConfig, FuelTankConfig, DesignRequirementsConfig
from engine.optimizer.layers.layer1_static_optimization import run_layer1_optimization

class TestLayer1Pressures(unittest.TestCase):
    def test_pressures_in_config(self):
        # Setup mock config
        mock_config = MagicMock(spec=PintleEngineConfig)
        mock_config.design_requirements = DesignRequirementsConfig(
            target_thrust=7000,
            optimal_of_ratio=2.3,
            max_lox_tank_pressure_psi=700,
            max_fuel_tank_pressure_psi=850
        )
        mock_config.lox_tank = None
        mock_config.fuel_tank = None
        mock_config.chamber_geometry = MagicMock()
        mock_config.chamber = MagicMock()
        mock_config.nozzle = MagicMock()
        mock_config.injector = MagicMock()
        mock_config.injector.type = "pintle"
        mock_config.injector.geometry = MagicMock()
        mock_config.combustion = MagicMock()
        mock_config.optimizer = MagicMock()
        mock_config.optimizer.mode = "cma"
        mock_config.optimizer.num_workers = 1
        
        # Mock runner
        mock_runner = MagicMock()
        
        # Mock dependencies in run_layer1_optimization
        with patch('engine.optimizer.layers.layer1_static_optimization.PintleEngineRunner'), \
             patch('engine.optimizer.layers.layer1_static_optimization.cma.CMAEvolutionStrategy') as mock_cma, \
             patch('engine.optimizer.layers.layer1_static_optimization.minimize') as mock_minimize, \
             patch('engine.optimizer.layers.layer1_static_optimization.ProcessPoolExecutor'):
            
            # Setup CMA result
            mock_es = mock_cma.return_value
            mock_es.stop.return_value = True
            mock_es.result.xbest = [0.001, 1.0, 8.0, 0.1, 0.015, 0.0006, 16, 0.003, 550.0, 650.0]
            mock_es.result.fbest = 0.1
            
            # Setup L-BFGS-B result
            mock_lbfgs_res = MagicMock()
            mock_lbfgs_res.x = np.array([0.001, 1.0, 8.0, 0.1, 0.015, 0.0006, 16, 0.003, 560.0, 660.0])
            mock_lbfgs_res.fun = 0.05
            mock_lbfgs_res.success = True
            mock_minimize.return_value = mock_lbfgs_res
            
            # Mock create_layer1_apply_x_to_config to return our mock_config
            with patch('engine.optimizer.layers.layer1_static_optimization.create_layer1_apply_x_to_config') as mock_create_apply:
                mock_apply = MagicMock()
                mock_apply.return_value = (mock_config, 560.0, 660.0)
                mock_create_apply.return_value = mock_apply
                
                # Mock update_progress and log_status
                mock_update_progress = MagicMock()
                mock_log_status = MagicMock()
                
                requirements = mock_config.design_requirements.model_dump()
                
                # Run optimization
                optimized_config, results = run_layer1_optimization(
                    config_obj=mock_config,
                    runner=mock_runner,
                    requirements=requirements,
                    target_burn_time=10.0,
                    tolerances={"thrust": 0.1, "apogee": 0.15},
                    pressure_config={"mode": "optimizer_controlled"},
                    update_progress=mock_update_progress,
                    log_status=mock_log_status
                )
            
            # Verify results
            self.assertIsNotNone(optimized_config.lox_tank)
            self.assertIsNotNone(optimized_config.fuel_tank)
            self.assertEqual(optimized_config.lox_tank.initial_pressure_psi, 560.0)
            self.assertEqual(optimized_config.fuel_tank.initial_pressure_psi, 660.0)
            print(f"✓ LOX Pressure: {optimized_config.lox_tank.initial_pressure_psi} psi")
            print(f"✓ Fuel Pressure: {optimized_config.fuel_tank.initial_pressure_psi} psi")

if __name__ == "__main__":
    unittest.main()
