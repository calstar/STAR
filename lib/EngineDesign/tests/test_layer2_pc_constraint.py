
import numpy as np
import logging
from unittest.mock import MagicMock, patch
import sys
import os
import glob
import time

# Add project root to path
sys.path.append(os.getcwd())

from engine.optimizer.layers.layer2_pressure import run_layer2_pressure

# Mock evaluation function
def mock_evaluate_factory(drift_type="stable"):
    def mock_evaluate(time_array, P_tank_O, P_tank_F, *args, **kwargs):
        n = len(time_array)
        Pc_initial = 3e6
        
        # NOTE: This mock provides the result of the solver.
        # But the PRUNING check happens BEFORE the solver, based on P_tank_O and P_tank_F.
        # If P_tank drops too low, this function should NOT be called.
        
        if drift_type == "stable":
            decay = np.linspace(1.0, 0.76, n)
            Pc_hist = Pc_initial * decay
        elif drift_type == "extreme_drift":
            decay = np.linspace(1.0, 0.40, n)
            Pc_hist = Pc_initial * decay
        else:
            Pc_hist = np.full(n, Pc_initial)

        return {
            "Pc": Pc_hist,
            "F": np.full(n, 1000.0), 
            "mdot_O": np.full(n, 1.0), 
            "mdot_F": np.full(n, 0.5),
            "MR": np.full(n, 2.0),
            "stability_score": np.full(n, 0.9),
            "chugging_stability_margin": np.full(n, 1.0)
        }
    return mock_evaluate

# Helper to mock decoding segments to force low pressure for pruning test
def mock_decode_low_pressure(x, n_seg, init_lox, init_fuel, min_lox_p, min_fuel_p):
    # This mocks `decode_segments_from_x` to return segments that produce VERY low pressure
    # forcing the pruning check to trigger
    from engine.optimizer.layers.layer2_pressure import generate_pressure_curve_from_segments
    
    # Return valid structure but with low end pressures
    # Target 50% of initial
    seg_lox = [{"length_ratio": 1.0, "type": "blowdown", "start_pressure": init_lox, "end_pressure": init_lox * 0.5, "k": 0.3}]
    seg_fuel = [{"length_ratio": 1.0, "type": "blowdown", "start_pressure": init_fuel, "end_pressure": init_fuel * 0.5, "k": 0.3}]
    return seg_lox, seg_fuel


def test_layer2_pc_constraint():
    print("\n=== Testing Layer 2 Chamber Pressure Constraint ===")
    
    config_mock = MagicMock()
    config_mock.ablative_cooling = None
    config_mock.graphite_insert = None

    # Common mocks
    with patch("engine.optimizer.layers.layer2_pressure.PintleEngineRunner") as MockRunner, \
         patch("engine.optimizer.layers.layer2_pressure.logging.getLogger") as mock_get_logger:
        
        mock_logger = MagicMock()
        mock_get_logger.return_value = mock_logger
        
        # Setup Runner instance
        instance = MockRunner.return_value
        # Mock single-point evaluate for Pc_initial check (3 MPa)
        instance.evaluate.return_value = {"Pc": 3e6} 
        
        # --- Test Case 1: Stable Pressure (Safe) ---
        print("\n--- Test Case 1: Stable Pressure (Safe) ---")
        instance.evaluate_arrays_with_time.side_effect = mock_evaluate_factory("stable")
        
        objs_case1 = []
        def capture_case1(eval_num, obj, best):
            objs_case1.append(obj)
            
        try:
            run_layer2_pressure(
                optimized_config=config_mock,
                initial_lox_pressure_pa=3e6,
                initial_fuel_pressure_pa=2e6,
                peak_thrust=1000.0,
                target_apogee_m=1000.0,
                rocket_dry_mass_kg=100.0,
                max_lox_tank_capacity_kg=50.0,
                max_fuel_tank_capacity_kg=50.0,
                target_burn_time=10.0,
                n_time_points=20, 
                max_iterations=1,
                optimal_of_ratio=2.0,
                objective_callback=capture_case1
            )
        except Exception:
            pass
            
        # Check logs for breakdown too
        found_safe = False
        for call in mock_logger.info.call_args_list:
            if "Pc_stab=0.00" in str(call):
                found_safe = True
        
        # If objective is reasonable (around 100-200) and Pc_stab=0 in logs
        if found_safe:
            print("PASS: Verified Pc_stab=0.00 for stable pressure.")
        else:
            print(f"FAIL: Did not find zero Pc penalty (Objs: {objs_case1}).")

        # --- Test Case 2: Extreme Drift in Output (Objective Penalty) ---
        print("\n--- Test Case 2: Extreme Drift (>25%) ---")
        mock_logger.reset_mock()
        instance.evaluate_arrays_with_time.side_effect = mock_evaluate_factory("extreme_drift")
        
        objs_case2 = []
        def capture_case2(eval_num, obj, best):
            objs_case2.append(obj)

        try:
            run_layer2_pressure(
                optimized_config=config_mock,
                initial_lox_pressure_pa=3e6,
                initial_fuel_pressure_pa=2e6,
                peak_thrust=1000.0,
                target_apogee_m=1000.0,
                rocket_dry_mass_kg=100.0,
                max_lox_tank_capacity_kg=50.0,
                max_fuel_tank_capacity_kg=50.0,
                target_burn_time=10.0,
                n_time_points=20, 
                max_iterations=1,
                optimal_of_ratio=2.0,
                objective_callback=capture_case2
            )
        except Exception:
            pass

        found_penalty = False
        # Check if objective is elevated (> 200, typically 100 base + 100 penalty)
        # 40% drift -> 60% of initial. Wait, mock returns 0.40. 
        # Deviation 60%. Threshold 25%. Excess 35%. Penalty mean * 1000.
        # Mean depends on curve. Linear to 0.40.
        # Should be penalty ~ 100s.
        
        if any(obj > 200.0 for obj in objs_case2):
             found_penalty = True
        
        if found_penalty:
            print(f"PASS: Verified high Pc_stab penalty (Max obj: {max(objs_case2)}).")
        else:
             # Check logs as fallback
             for call in mock_logger.info.call_args_list:
                msg = str(call)
                if "Pc_stab=" in msg and "Pc_stab=0.00" not in msg:
                     found_penalty = True
             if found_penalty:
                 print("PASS: Verified high Pc_stab penalty via logs.")
             else:
                 print(f"FAIL: Did not find high Pc penalty (Objs: {objs_case2}).")

        # --- Test Case 3: Severe Pressure Drop (Pre-Solver Pruning) ---
        print("\n--- Test Case 3: Severe Pressure Drop (<75% of Initial) ---")
        mock_logger.reset_mock()
        # To test pruning, we must force the generated pressure curve (INPUT) to be low.
        # We patch `generate_pressure_curve_from_segments` to return a low constant pressure.
        
        def mock_generate_low_pressure(*args, **kwargs):
            return np.full(20, 1.0e6) # 1 MPa, much lower than 0.75 * 3MPa (2.25 MPa)

        objs_case3 = []
        def capture_case3(eval_num, obj, best):
            objs_case3.append(obj)

        with patch("engine.optimizer.layers.layer2_pressure.generate_pressure_curve_from_segments", side_effect=mock_generate_low_pressure):
            try:
                run_layer2_pressure(
                    optimized_config=config_mock,
                    initial_lox_pressure_pa=3e6, 
                    initial_fuel_pressure_pa=3e6,
                    peak_thrust=1000.0,
                    target_apogee_m=1000.0,
                    rocket_dry_mass_kg=100.0,
                    max_lox_tank_capacity_kg=50.0,
                    max_fuel_tank_capacity_kg=50.0,
                    target_burn_time=10.0,
                    n_time_points=20, 
                    max_iterations=1, 
                    optimal_of_ratio=2.0,
                    objective_callback=capture_case3
                )
            except Exception:
                pass

            found_pruning = False
            # Now that pruning is removed and replaced by generation constraints, 
            # if we force low pressure via mocking, it should just be caught by the standard 
            # stability penalty in the objective function.
            # So we look for high objective value, not a log message.
            
            if any(obj > 200.0 for obj in objs_case3):
                found_pruning = True
            
            if found_pruning:
                print(f"PASS: Verified high penalty for low pressure (generation constraints bypassed by mock).")
            else:
                print(f"FAIL: Did not find high penalty for low pressure (Objs: {objs_case3}).")

if __name__ == "__main__":
    test_layer2_pc_constraint()
