
import numpy as np
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

# Add project root to path
sys.path.insert(0, '/home/adnan/EngineDesign')

from copv.blowdown_solver import simulate_coupled_blowdown
from backend.routers.timeseries import compute_timeseries_results

# Mock dependencies
class MockRunner:
    def __init__(self):
        self.config = SimpleNamespace(
            ablative_cooling=SimpleNamespace(enabled=False),
            # Add other needed config bits if any
        )
    
    def evaluate_arrays_with_time(self, times, P_tank_O, P_tank_F, **kwargs):
        # Return fake results based on pressure
        n = len(times)
        # Fake thrust proportional to pressure (1 kN per 100 psi)
        F = (P_tank_O / 6894.76) * 1000.0 * 10 
        Pc = (P_tank_O / 6894.76) * 0.5 * 6894.76 # Pc is half tank pressure
        
        return {
            "Pc": Pc,
            "F": F,
            "Isp": np.full(n, 250.0),
            "mdot_O": np.full(n, 1.0),
            "mdot_F": np.full(n, 0.8),
            "mdot_total": np.full(n, 1.8),
            "MR": np.full(n, 1.25),
            "cstar_actual": np.full(n, 1500.0),
            "gamma": np.full(n, 1.2),
            "diagnostics": [{} for _ in range(n)]
        }
        
    def evaluate_arrays(self, P_tank_O, P_tank_F):
        return self.evaluate_arrays_with_time(np.zeros_like(P_tank_O), P_tank_O, P_tank_F)

# Setup Blowdown Simulation
mock_config = SimpleNamespace(
    fluids={
        'oxidizer': SimpleNamespace(density=1140.0),
        'fuel': SimpleNamespace(density=800.0)
    },
    lox_tank=SimpleNamespace(tank_volume_m3=0.05, mass=5.0), # 5kg LOX
    fuel_tank=SimpleNamespace(tank_volume_m3=0.05, mass=4.0), # 4kg Fuel
    injector=SimpleNamespace(
        type='pintle',
        geometry=SimpleNamespace(
            lox=SimpleNamespace(n_orifices=50, A_entry=1e-6), 
            fuel=SimpleNamespace(d_pintle_tip=0.02, h_gap=0.001) 
        )
    )
)

def mock_engine_evaluator(P_lox, P_fuel):
    P_ref = 500 * 6894.76
    mdot_lox = 1.0 * np.sqrt(max(0, P_lox / P_ref))
    mdot_fuel = 0.8 * np.sqrt(max(0, P_fuel / P_ref))
    return mdot_lox, mdot_fuel

# Run simulation
times = np.linspace(0, 20, 201)
print(f"Running simulation with {len(times)} points...")
results = simulate_coupled_blowdown(
    times=times,
    evaluate_engine_fn=mock_engine_evaluator,
    P_lox_initial_Pa=500 * 6894.76,
    P_fuel_initial_Pa=500 * 6894.76,
    config=mock_config,
    use_real_gas=False
)

lox_mass = results['lox']['m_prop_kg']
print(f"Final LOX Mass: {lox_mass[-1]}")
print(f"Indices with mass <= 1e-4: {np.sum(lox_mass <= 1e-4)}")

# Run compute_timeseries_results
print("\nRunning compute_timeseries_results with masking...")
data, summary = compute_timeseries_results(
    runner=MockRunner(),
    times=times,
    P_tank_O_psi=results['lox']['P_Pa'] / 6894.76,
    P_tank_F_psi=results['fuel']['P_Pa'] / 6894.76,
    run_copv=False,
    lox_mass_kg=lox_mass,
    fuel_mass_kg=results['fuel']['m_prop_kg']
)

# Check Thrust at the end
thrust_end = data['thrust_kN'][-1]
print(f"Final Thrust (kN): {thrust_end}")
print(f"Expected Thrust: 0.0")

if thrust_end == 0.0:
    print("SUCCESS: Thrust masked to 0.0")
else:
    print("FAILURE: Thrust NOT masked!")
    
# Debug masking logic
mask_lox = np.asarray(lox_mass) <= 1e-4
print(f"Mask LOX count: {np.sum(mask_lox)}")
print(f"Mask applied effectively? {thrust_end == 0}")
