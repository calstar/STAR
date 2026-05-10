
import sys
import os
import numpy as np

# Add project root to path
sys.path.append(os.getcwd())

from engine.core.chamber_geometry_solver import solve_chamber_geometry_with_cea
from engine.pipeline.cea_cache import CEACache
from engine.pipeline.config_schemas import CEAConfig

def test_override():
    print("Testing A_throat_override...")
    
    # Mock CEA cache (we don't need real values for this test, just structure)
    class MockCEACache:
        def __init__(self):
            self.use_3d = False
        def eval(self, MR, Pc, Pa, eps):
            return {"Cf_ideal": 1.5}
            
    cache = MockCEACache()
    
    # Target throat area (arbitrary)
    target_A_throat = 0.005
    target_thrust = 5000
    target_pc = 2e6
    
    # 1. Test WITHOUT override (should calculate based on thrust/pc)
    # Expected A_throat approx = F / (Pc * Cf) = 5000 / (2e6 * 1.5) = 0.00166...
    print("\nRunning WITHOUT override...")
    _, _, _, info_no_override = solve_chamber_geometry_with_cea(
        pc_design=target_pc,
        thrust_design=target_thrust,
        cea_cache=cache,
        MR=2.5,
        nozzle_efficiency=1.0,
        verbose=True
    )
    at_no_override = info_no_override['final_A_throat']
    print(f"Calculated A_throat: {at_no_override}")
    
    # 2. Test WITH override
    print("\nRunning WITH override...")
    _, _, _, info_override = solve_chamber_geometry_with_cea(
        pc_design=target_pc,
        thrust_design=target_thrust,
        cea_cache=cache,
        MR=2.5,
        nozzle_efficiency=1.0,
        A_throat_override=target_A_throat,
        verbose=True
    )
    at_override = info_override['final_A_throat']
    print(f"Override A_throat: {at_override}")
    
    # Assertions
    if abs(at_override - target_A_throat) < 1e-9:
        print("\nSUCCESS: Override respected.")
    else:
        print(f"\nFAILURE: Override ignored. Got {at_override}, expected {target_A_throat}")
        sys.exit(1)
        
    if abs(at_no_override - target_A_throat) > 1e-4:
        print("SUCCESS: Normal calculation is different from override (as expected).")
    else:
        print("WARNING: Normal calculation coincidentally matched override.")

if __name__ == "__main__":
    test_override()
