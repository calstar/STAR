
import warnings
import sys
import os

# Add project root to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../")))

from engine.pipeline.combustion_physics import calculate_combustion_efficiency_advanced
from engine.pipeline.config_schemas import CombustionEfficiencyConfig

def test_warning_suppression():
    print("Testing warning suppression logic...")
    
    # Mock config
    config = CombustionEfficiencyConfig(model="exponential")
    
    # Case 1: High pressure, low efficiency -> SHOULD WARN
    print("\nCase 1: High Pressure (3 MPa), Low Efficiency")
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        calculate_combustion_efficiency_advanced(
            Lstar=0.1, Pc=3.0e6, Tc=3000, cstar_ideal=1500, gamma=1.2, R=300, 
            MR=2.5, config=config, Ac=0.005, At=0.001, Dinj=0.05, m_dot_total=1.0, 
            u_fuel=100, u_lox=100, spray_diagnostics={"D32_O": 500e-6}, # Large SMD -> low efficiency
            turbulence_intensity=0.1,
            fuel_props={"latent_heat": 300e3, "specific_heat": 2000, "temperature": 298},
        )
        if len(w) > 0:
            print(f"Caught expected warning: {w[-1].message}")
        else:
            print("FAILED: No warning caught for high pressure case")

    # Case 2: Low pressure (blowdown tail), low efficiency -> SHOULD NOT WARN (after fix)
    print("\nCase 2: Low Pressure (1 MPa), Low Efficiency")
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        calculate_combustion_efficiency_advanced(
            Lstar=0.1, Pc=1.0e6, Tc=2500, cstar_ideal=1500, gamma=1.2, R=300, 
            MR=2.5, config=config, Ac=0.005, At=0.001, Dinj=0.05, m_dot_total=0.3, 
            u_fuel=30, u_lox=30, spray_diagnostics={"D32_O": 500e-6}, # Large SMD -> low efficiency
            turbulence_intensity=0.1,
            fuel_props={"latent_heat": 300e3, "specific_heat": 2000, "temperature": 298},
        )
        if len(w) > 0:
            print(f"Caught warning: {w[-1].message}")
            if "eta_Lstar" in str(w[-1].message):
                print("Note: This warning should be suppressed in the fix.")
        else:
            print("No warning caught (already suppressed?)")

if __name__ == "__main__":
    test_warning_suppression()
