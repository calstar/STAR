"""Test coupled blowdown solver with mock engine callback."""
import numpy as np
import sys
from types import SimpleNamespace

sys.path.insert(0, '/home/adnan/EngineDesign')

from copv.blowdown_solver import simulate_coupled_blowdown

# Valid mock config structure
mock_config = SimpleNamespace(
    fluids={
        'oxidizer': SimpleNamespace(density=1140.0),
        'fuel': SimpleNamespace(density=800.0)
    },
    lox_tank=SimpleNamespace(tank_volume_m3=0.1, mass=50.0),
    fuel_tank=SimpleNamespace(tank_volume_m3=0.1, mass=40.0)
)

def mock_engine_evaluator(P_lox, P_fuel):
    # Simple impedance model: mdot = C * sqrt(P)
    # k = 1.0 kg/s at 500 psi
    P_ref = 500 * 6894.76
    mdot_lox = 1.0 * np.sqrt(P_lox / P_ref)
    mdot_fuel = 0.8 * np.sqrt(P_fuel / P_ref)
    return mdot_lox, mdot_fuel

# Run simulation
times = np.linspace(0, 5, 51)  # 0.1s steps
results = simulate_coupled_blowdown(
    times=times,
    evaluate_engine_fn=mock_engine_evaluator,
    P_lox_initial_Pa=600 * 6894.76,
    P_fuel_initial_Pa=600 * 6894.76,
    config=mock_config,
    use_real_gas=False
)

print("\n✓ Coupled Blowdown Solver Test")
print("------------------------------")
print(f"Time steps: {len(times)}")
print(f"LOX Pressure:  {results['lox']['P_Pa'][0]/6894.76:.1f} -> {results['lox']['P_Pa'][-1]/6894.76:.1f} psi")
print(f"Fuel Pressure: {results['fuel']['P_Pa'][0]/6894.76:.1f} -> {results['fuel']['P_Pa'][-1]/6894.76:.1f} psi")
print(f"LOX Mass:      {results['lox']['m_prop_kg'][0]:.1f} -> {results['lox']['m_prop_kg'][-1]:.1f} kg")

# Verify mass flow decreased as pressure dropped (coupling check)
mdot_0 = results['lox']['mdot_kg_s'][0]
mdot_end = results['lox']['mdot_kg_s'][-1]
print(f"LOX Flow Rate: {mdot_0:.3f} -> {mdot_end:.3f} kg/s")

if mdot_end < mdot_0:
    print("✓ Flow rate decreased with pressure (Coupling verified)")
else:
    print("✗ Flow rate did not decrease correctly!")

# Validation check
assert results['lox']['P_Pa'][0] > results['lox']['P_Pa'][-1], "Pressure should decrease"
assert results['lox']['m_prop_kg'][0] > results['lox']['m_prop_kg'][-1], "Mass should decrease"
