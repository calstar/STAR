
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

def mock_evaluate(*args, **kwargs):
    # args[1] is time_array (based on signature in layer2_pressure: evaluate_arrays_with_time(self, time, ...))
    time_array = args[1]
    n = len(time_array)
    # Return valid dummy results
    return {
        "F": np.full(n, 1000.0), # Constant thrust
        "mdot_O": np.full(n, 1.0),
        "mdot_F": np.full(n, 0.5),
        "MR": np.full(n, 2.0),
        "stability_score": np.full(n, 0.9),
        "chugging_stability_margin": np.full(n, 1.0)
    }

def run_verification():
    print("Starting verification run...")

    # Mock config
    config_mock = MagicMock()
    config_mock.ablative_cooling = None
    config_mock.graphite_insert = None

    # Patch Runner
    with patch("engine.optimizer.layers.layer2_pressure.PintleEngineRunner") as MockRunner:
        instance = MockRunner.return_value
        instance.evaluate_arrays_with_time.side_effect = mock_evaluate

        # Run optimization
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
                n_time_points=100, # Fine grid
                max_iterations=1
            )
            print("Run finished successfully.")
        except Exception as e:
            print(f"Run failed: {e}")
            import traceback
            traceback.print_exc()
            return

    # Check logs
    log_dir = os.path.join(os.getcwd(), "output", "logs")
    log_files = glob.glob(os.path.join(log_dir, "layer2_pressure_*.log"))
    if not log_files:
        print("No log files found!")
        return
    
    # Get latest log file
    latest_log = max(log_files, key=os.path.getctime)
    print(f"Reading log file: {latest_log}")
    
    with open(latest_log, 'r') as f:
        content = f.read()
    
    required_msg = "Re-evaluating best DE solution on fine grid to establish baseline..."
    if required_msg in content:
        print("PASS: Re-evaluation message found.")
    else:
        print("FAIL: Re-evaluation message NOT found.")
        
    baseline_msg = "Fine-grid baseline objective:"
    if baseline_msg in content:
        print("PASS: Baseline objective logged.")
    else:
        print("FAIL: Baseline objective NOT logged.")

if __name__ == "__main__":
    run_verification()
