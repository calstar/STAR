
import numpy as np
import sys
from types import SimpleNamespace

# Add project root to path
sys.path.insert(0, '/home/adnan/EngineDesign')

from copv.blowdown_solver import simulate_coupled_blowdown

# Valid mock config structure with small mass to deplete quickly
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
            lox=SimpleNamespace(n_orifices=50, A_entry=1e-6), # 50 mm2 total
            fuel=SimpleNamespace(d_pintle_tip=0.02, h_gap=0.001) # ~60 mm2
        )
    )
)

def mock_engine_evaluator(P_lox, P_fuel):
    # Simple impedance model: mdot = C * sqrt(P)
    # k = 1.0 kg/s at 500 psi
    P_ref = 500 * 6894.76
    # If pressure is low, flow should be low
    mdot_lox = 1.0 * np.sqrt(max(0, P_lox / P_ref))
    mdot_fuel = 0.8 * np.sqrt(max(0, P_fuel / P_ref))
    return mdot_lox, mdot_fuel

# Run simulation for 20 seconds, should deplete in ~5s
times = np.linspace(0, 20, 201)  # 0.1s steps
results = simulate_coupled_blowdown(
    times=times,
    evaluate_engine_fn=mock_engine_evaluator,
    P_lox_initial_Pa=500 * 6894.76,
    P_fuel_initial_Pa=500 * 6894.76,
    config=mock_config,
    use_real_gas=False
)

print("\n--- Blowdown Depletion Test ---")
print(f"{'Time (s)':<10} | {'LOX Mass (kg)':<15} | {'LOX P (psi)':<15} | {'Fuel Mass (kg)':<15} | {'Fuel P (psi)':<15}")
print("-" * 80)

indices = np.linspace(0, len(times)-1, 21, dtype=int)
for i in indices:
    t = times[i]
    m_lox = results['lox']['m_prop_kg'][i]
    p_lox = results['lox']['P_Pa'][i] / 6894.76
    m_fuel = results['fuel']['m_prop_kg'][i]
    p_fuel = results['fuel']['P_Pa'][i] / 6894.76
    print(f"{t:<10.1f} | {m_lox:<15.3f} | {p_lox:<15.1f} | {m_fuel:<15.3f} | {p_fuel:<15.1f}")

print("\nFinal State:")
print(f"LOX Mass: {results['lox']['m_prop_kg'][-1]}")
print(f"Fuel Mass: {results['fuel']['m_prop_kg'][-1]}")
print(f"LOX Pressure: {results['lox']['P_Pa'][-1] / 6894.76} psi")

# Check if pressure is close to ambient (14.7 psi)
assert results['lox']['P_Pa'][-1] < 20 * 6894.76, "LOX Pressure did not drop near ambient!"
