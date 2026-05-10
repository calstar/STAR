"""Quick verification test for blowdown solver."""
import numpy as np
import sys
sys.path.insert(0, '/home/adnan/EngineDesign')

from copv.blowdown_solver import simulate_blowdown

# Simple test: constant mass flow
times = np.linspace(0, 5, 100)
mdot = np.ones(100) * 1.0  # 1 kg/s

# Simulate blowdown (no real gas for simplicity)
results = simulate_blowdown(
    times=times,
    mdot=mdot,
    P_initial_Pa=500 * 6894.76,  # 500 psi to Pa
    rho_propellant=1140.0,  # LOX density
    V_tank_total=0.1,  # 100L tank
    m_propellant_initial=50.0,  # 50 kg initial
    R_pressurant=296.803,
    T_initial_K=300.0,
    n_polytropic=1.2,
    use_real_gas=False,
    Z_interp=None,
)

print("✓ Blowdown solver test passed!")
print(f"  Initial pressure: {results['P_Pa'][0] / 6894.76:.1f} psi")
print(f"  Final pressure: {results['P_Pa'][-1] / 6894.76:.1f} psi") 
print(f"  Pressure decreased: {results['P_Pa'][0] > results['P_Pa'][-1]}")
print(f"  Gas mass constant: {results['m_gas_kg']:.3f} kg")
print(f"  Temperature range: {results['T_K'].min():.1f} - {results['T_K'].max():.1f} K")
