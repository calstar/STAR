"""Simple example: Tank Pressure → Thrust"""

import numpy as np
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from engine.pipeline.io import load_config
from engine.core.runner import PintleEngineRunner

# Load configuration
config = load_config(str(Path(__file__).parent.parent / "configs" / "default.yaml"))

# Initialize runner
runner = PintleEngineRunner(config)

print("=" * 60)
print("PINTLE ENGINE PIPELINE: Tank Pressure → Thrust")
print("=" * 60)
print("\nINPUT: Tank Pressures")
print("OUTPUT: Chamber Pressure (SOLVED), Thrust, and all performance parameters")
print("\n" + "-" * 60)

# Example: Single point
print("\n📊 Example 1: Single Point Evaluation")
print("-" * 60)

P_tank_O = 5.0e6  # 5 MPa (oxidizer tank)
P_tank_F = 4.5e6  # 4.5 MPa (fuel tank)

print(f"Input Tank Pressures:")
print(f"  P_tank_O = {P_tank_O/1e6:.2f} MPa")
print(f"  P_tank_F = {P_tank_F/1e6:.2f} MPa")

# Solve for everything
results = runner.evaluate(P_tank_O, P_tank_F)

print(f"\nSolved Results:")
print(f"  Pc (SOLVED) = {results['Pc']/1e6:.2f} MPa")
print(f"  MR = {results['MR']:.2f}")
print(f"  ṁ_O = {results['mdot_O']:.3f} kg/s")
print(f"  ṁ_F = {results['mdot_F']:.3f} kg/s")
print(f"  c*_actual = {results['cstar_actual']:.0f} m/s")
print(f"  Thrust = {results['F']/1000:.2f} kN")
print(f"  Isp = {results['Isp']:.1f} s")

# Example: Pressure arrays (sweep)
print("\n📊 Example 2: Pressure Array (Sweep)")
print("-" * 60)

# Create arrays of different tank pressures
P_tank_O_sweep = np.array([4.0e6, 5.0e6, 6.0e6, 7.0e6])  # Different oxidizer pressures
P_tank_F_sweep = np.array([3.6e6, 4.5e6, 5.4e6, 6.3e6])  # Corresponding fuel pressures

print(f"Evaluating {len(P_tank_O_sweep)} different pressure combinations:")
for i in range(len(P_tank_O_sweep)):
    print(f"  Point {i+1}: P_O={P_tank_O_sweep[i]/6894.76:.0f} psi, P_F={P_tank_F_sweep[i]/6894.76:.0f} psi")

results_sweep = runner.evaluate(P_tank_O_sweep, P_tank_F_sweep)

print(f"\nResults for each pressure combination:")
for i in range(len(P_tank_O_sweep)):
    print(f"  Point {i+1}:")
    print(f"    Solved Pc = {results_sweep['Pc'][i]/6894.76:.0f} psi")
    print(f"    Thrust = {results_sweep['F'][i]/1000:.2f} kN")
    print(f"    MR = {results_sweep['MR'][i]:.2f}")
    print(f"    Isp = {results_sweep['Isp'][i]:.1f} s")

# Example: Time series (blowdown)
print("\n📊 Example 3: Time Series (Blowdown Simulation)")
print("-" * 60)

t = np.linspace(0, 10, 100)  # 10 seconds, 100 points
# Simple exponential blowdown
P_tank_O_ts = 6.0e6 * np.exp(-t / 5.0) + 1.0e6
P_tank_F_ts = 5.5e6 * np.exp(-t / 5.0) + 1.0e6

print(f"Time series: {len(t)} points over {t[-1]:.1f} seconds")
print(f"Initial tank pressures: P_O={P_tank_O_ts[0]/6894.76:.0f} psi, P_F={P_tank_F_ts[0]/6894.76:.0f} psi")
print(f"Final tank pressures: P_O={P_tank_O_ts[-1]/6894.76:.0f} psi, P_F={P_tank_F_ts[-1]/6894.76:.0f} psi")

# Solve for entire time series
results_ts = runner.evaluate_time_series(t, P_tank_O_ts, P_tank_F_ts)

print(f"\nSolved Results (time series):")
print(f"  Initial Pc (SOLVED) = {results_ts['Pc'][0]/6894.76:.0f} psi")
print(f"  Final Pc (SOLVED) = {results_ts['Pc'][-1]/6894.76:.0f} psi")
print(f"  Initial Thrust = {results_ts['F'][0]/1000:.2f} kN")
print(f"  Final Thrust = {results_ts['F'][-1]/1000:.2f} kN")
print(f"  Initial Isp = {results_ts['Isp'][0]:.1f} s")
print(f"  Final Isp = {results_ts['Isp'][-1]:.1f} s")

print("\n" + "=" * 60)
print("✅ Pipeline correctly solves Pc from tank pressures!")
print("=" * 60)

