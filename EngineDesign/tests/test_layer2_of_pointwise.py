
import numpy as np
import sys
import os
from unittest.mock import MagicMock, patch

# Add project root to path
sys.path.append(os.getcwd())

from engine.optimizer.layers.layer2_pressure import run_layer2a_minimum_pressures, run_layer2_pressure
from engine.pipeline.config_schemas import PintleEngineConfig

def test_layer2a_pointwise_mr():
    print("\n=== Testing Layer 2a Pointwise MR Check ===")
    
    config_mock = MagicMock(spec=PintleEngineConfig)
    config_mock.ablative_cooling = None
    config_mock.graphite_insert = None

    target_of = 2.0
    
    # Mock results with a spike in MR
    # Average error: (0*19 + 0.3*1)/20 = 0.015 (1.5% average error, well within 20% limit)
    # Pointwise max error: 0.3 (30%, exceeds 20% limit)
    mr_spike = np.full(20, target_of)
    mr_spike[10] = target_of * 1.3 
    
    mock_results = {
        "F": np.full(20, 1000.0),
        "mdot_O": np.full(20, 1.0),
        "mdot_F": np.full(20, 0.5),
        "MR": mr_spike,
        "chugging_stability_margin": np.full(20, 1.0)
    }

    with patch("engine.optimizer.layers.layer2_pressure.PintleEngineRunner") as MockRunner:
        runner_instance = MockRunner.return_value
        runner_instance.evaluate_arrays_with_time.return_value = mock_results
        
        # We expect this to fail because of the max pointwise error (30% > 20%)
        # but the average error is only 1.5%
        lox_min, fuel_min, summary, success = run_layer2a_minimum_pressures(
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
            optimal_of_ratio=target_of
        )
        
        if not success:
            print("PASS: run_layer2a_minimum_pressures correctly rejected spiked MR.")
        else:
            print("FAIL: run_layer2a_minimum_pressures accepted spiked MR despite 30% spike.")

def test_layer2_objective_weighted_penalty():
    print("\n=== Testing Layer 2 Objective Weighted MR Penalty ===")
    
    config_mock = MagicMock(spec=PintleEngineConfig)
    config_mock.ablative_cooling = None
    config_mock.graphite_insert = None

    target_of = 2.0
    
    # Case A: Flat MR with 10% error everywhere
    mr_flat = np.full(20, target_of * 1.1)
    
    # Case B: Spiked MR with 20% error at one point, 0% elsewhere
    # Mean error: (0.2 * 1 + 0 * 19) / 20 = 0.01 (1%)
    # Max error: 0.2 (20%)
    mr_spiked = np.full(20, target_of)
    mr_spiked[10] = target_of * 1.2
    
    # Case C: Even larger spike
    # Mean error: (0.4 * 1 + 0 * 19) / 20 = 0.02 (2%)
    # Max error: 0.4 (40%)
    mr_very_spiked = np.full(20, target_of)
    mr_very_spiked[10] = target_of * 1.4

    with patch("engine.optimizer.layers.layer2_pressure.PintleEngineRunner") as MockRunner:
        runner_instance = MockRunner.return_value
        
        # Helper to get objective for a given MR history
        def get_obj(mr_hist):
            runner_instance.evaluate_arrays_with_time.return_value = {
                "F": np.full(20, 1000.0),
                "mdot_O": np.full(20, 1.0),
                "mdot_F": np.full(20, 0.5),
                "MR": mr_hist,
                "chugging_stability_margin": np.full(20, 1.0),
                "Pc": np.full(20, 2.5e6),
                "press_tank": MagicMock()
            }
            runner_instance.evaluate.return_value = {"Pc": 3e6}
            
            objs = []
            def capture_obj(it, obj, best):
                objs.append(obj)
                
            # Run one iteration of DE
            # We use a dummy x vector [length, ratio, k, factor, k] * N_SEGMENTS
            x = np.array([0.1, 0.9, 0.3, 1.0, 0.3] * 8)
            
            run_layer2_pressure(
                optimized_config=config_mock,
                initial_lox_pressure_pa=3e6,
                initial_fuel_pressure_pa=2e6,
                peak_thrust=1000.0,
                target_apogee_m=1000.0,
                rocket_dry_mass_kg=100.0,
                max_lox_tank_capacity_kg=100.0,
                max_fuel_tank_capacity_kg=100.0,
                target_burn_time=10.0,
                n_time_points=20,
                max_iterations=1,
                optimal_of_ratio=target_of,
                objective_callback=capture_obj,
                de_popsize=1,
                de_maxiter=1
            )
            return objs[0] if objs else 1e9

        print("Calculating objective for flat MR (10% error everywhere)...")
        obj_flat = get_obj(mr_flat)
        print(f"Flat Objective: {obj_flat:.2f}")
        
        print("Calculating objective for spiked MR (20% max, 1% mean error)...")
        obj_spiked = get_obj(mr_spiked)
        print(f"Spiked Objective: {obj_spiked:.2f}")
        
        print("Calculating objective for very spiked MR (40% max, 2% mean error)...")
        obj_very_spiked = get_obj(mr_very_spiked)
        print(f"Very Spiked Objective: {obj_very_spiked:.2f}")
        
        # Before my changes, obj_spiked would have been MUCH smaller than obj_flat 
        # because the mean error was 1% vs 10%.
        # Now, Case B (20% max error) should have a significant penalty.
        # Case C (40% max error) should be even higher due to the weighted max component.
        
        if obj_very_spiked > obj_spiked:
            print("PASS: Objective correctly penalizes larger spikes more heavily.")
        else:
            print("FAIL: Objective did not penalize larger spike correctly.")
            
        # We can't easily compare to obj_flat without knowing exact base penalties,
        # but the jump from spiked to very spiked confirms the max-weight logic.

if __name__ == "__main__":
    test_layer2a_pointwise_mr()
    test_layer2_objective_weighted_penalty()
