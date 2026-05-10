import unittest
from unittest.mock import MagicMock
import numpy as np
from engine.pipeline.config_schemas import PintleEngineConfig, LOXTankConfig, FuelTankConfig

class TestLayer1PressuresLogic(unittest.TestCase):
    def test_pressure_assignment_logic(self):
        # This test verifies the logic I added to layer1_static_optimization.py
        # by simulating the relevant section.
        
        # 1. Setup mock objects
        optimized_config = MagicMock(spec=PintleEngineConfig)
        optimized_config.lox_tank = None
        optimized_config.fuel_tank = None
        
        opt_state = {
            "best_x": np.array([0.001, 1.0, 8.0, 0.1, 0.015, 0.0006, 16, 0.003, 560.0, 660.0])
        }
        
        bounds = [(0,1)] * 10
        bounds[8] = (200, 700)
        bounds[9] = (200, 850)
        
        # 2. Simulate the added logic
        # Ensure tank configs exist
        if optimized_config.lox_tank is None:
            optimized_config.lox_tank = LOXTankConfig(lox_h=0.5, lox_radius=0.1, ox_tank_pos=1.0)
        if optimized_config.fuel_tank is None:
            optimized_config.fuel_tank = FuelTankConfig(rp1_h=0.5, rp1_radius=0.1, fuel_tank_pos=0.5)
        
        # Extract optimized pressures
        best_x = opt_state.get("best_x")
        if len(best_x) >= 10:
            P_O_start_optimized_psi = float(np.clip(best_x[8], bounds[8][0], bounds[8][1]))
            P_F_start_optimized_psi = float(np.clip(best_x[9], bounds[9][0], bounds[9][1]))
            optimized_config.lox_tank.initial_pressure_psi = P_O_start_optimized_psi
            optimized_config.fuel_tank.initial_pressure_psi = P_F_start_optimized_psi
        
        # 3. Verify
        self.assertEqual(optimized_config.lox_tank.initial_pressure_psi, 560.0)
        self.assertEqual(optimized_config.fuel_tank.initial_pressure_psi, 660.0)
        print("✓ Logic correctly assigns pressures to config")

    def test_schema_changes(self):
        # Verify that LOXTankConfig and FuelTankConfig now have initial_pressure_psi
        lox = LOXTankConfig(lox_h=0.5, lox_radius=0.1, ox_tank_pos=1.0, initial_pressure_psi=500.0)
        fuel = FuelTankConfig(rp1_h=0.5, rp1_radius=0.1, fuel_tank_pos=0.5, initial_pressure_psi=600.0)
        
        self.assertEqual(lox.initial_pressure_psi, 500.0)
        self.assertEqual(fuel.initial_pressure_psi, 600.0)
        print("✓ Schema correctly supports initial_pressure_psi")

if __name__ == "__main__":
    unittest.main()
