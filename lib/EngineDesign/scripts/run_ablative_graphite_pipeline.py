"""Run full pipeline with ablative and graphite modeling to see thrust performance."""

from pathlib import Path
import sys
import numpy as np
import matplotlib.pyplot as plt

sys.path.insert(0, str(Path(__file__).parent.parent))

from engine.pipeline.io import load_config
from engine.core.runner import PintleEngineRunner

# Load configuration
config_path = Path(__file__).parent.parent / "configs" / "default.yaml"
config = load_config(str(config_path))

# Enable ablative cooling and geometry tracking
config.ablative_cooling.enabled = True
config.ablative_cooling.track_geometry_evolution = True

# Enable graphite insert if configured
if hasattr(config, 'graphite_insert'):
    config.graphite_insert.enabled = True
    print("Graphite insert: ENABLED")
else:
    print("Graphite insert: Not configured (check config file)")

print("=" * 80)
print("FULL PIPELINE: ABLATIVE + GRAPHITE MODELING")
print("=" * 80)

# Create runner
runner = PintleEngineRunner(config)

# Define time series (10 second burn)
burn_time = 10.0  # seconds
n_points = 100
times = np.linspace(0, burn_time, n_points)

# Constant tank pressures
P_tank_O_psi = 1305.0
P_tank_F_psi = 974.0
P_tank_O = np.full(n_points, P_tank_O_psi * 6894.76)
P_tank_F = np.full(n_points, P_tank_F_psi * 6894.76)

print(f"\nTest Conditions:")
print(f"  Burn time:          {burn_time:.1f} s")
print(f"  Time points:        {n_points}")
print(f"  LOX tank pressure:  {P_tank_O_psi:.0f} psi (constant)")
print(f"  Fuel tank pressure: {P_tank_F_psi:.0f} psi (constant)")

print(f"\nAblative Configuration:")
print(f"  Enabled:            {config.ablative_cooling.enabled}")
print(f"  Track geometry:     {config.ablative_cooling.track_geometry_evolution}")
print(f"  Material:           {config.ablative_cooling.material_density:.0f} kg/m³")
print(f"  Heat of ablation:   {config.ablative_cooling.heat_of_ablation/1e6:.1f} MJ/kg")

if hasattr(config, 'graphite_insert') and config.graphite_insert.enabled:
    print(f"\nGraphite Insert Configuration:")
    print(f"  Enabled:            {config.graphite_insert.enabled}")
    print(f"  Coverage:           {config.graphite_insert.coverage_fraction*100:.0f}%")
    if hasattr(config.graphite_insert, 'initial_thickness'):
        print(f"  Initial Thickness:  {config.graphite_insert.initial_thickness*1000:.2f} mm")

print(f"\n{'='*80}")
print("RUNNING TIME-SERIES SIMULATION WITH GEOMETRY EVOLUTION...")
print("=" * 80)

# Run time-varying simulation
results = runner.evaluate_arrays_with_time(times, P_tank_O, P_tank_F)

print(f"\n✅ Simulation complete!")

# Extract results
thrust_kN = results["F"] / 1000.0
Isp = results["Isp"]
Pc_psi = results["Pc"] / 6894.76
Lstar = results["Lstar"]
A_throat = results["A_throat"]
V_chamber = results["V_chamber"]
recession_chamber = results.get("recession_chamber", np.zeros_like(times))
recession_throat = results.get("recession_throat", np.zeros_like(times))

# Calculate performance metrics
thrust_loss_pct = (1.0 - results["F"][-1] / results["F"][0]) * 100
Lstar_change_pct = (results["Lstar"][-1] / results["Lstar"][0] - 1.0) * 100
throat_area_change_pct = (results["A_throat"][-1] / results["A_throat"][0] - 1.0) * 100

print(f"\n{'='*80}")
print("THRUST PERFORMANCE SUMMARY")
print("=" * 80)
print(f"Initial Thrust:       {thrust_kN[0]:.2f} kN")
print(f"Final Thrust:         {thrust_kN[-1]:.2f} kN")
print(f"Thrust Loss:          {thrust_loss_pct:.2f}%")
print(f"\nInitial Isp:          {Isp[0]:.1f} s")
print(f"Final Isp:            {Isp[-1]:.1f} s")
print(f"Isp Loss:             {(1.0 - Isp[-1]/Isp[0])*100:.2f}%")
print(f"\nInitial Chamber P:    {Pc_psi[0]:.1f} psi")
print(f"Final Chamber P:      {Pc_psi[-1]:.1f} psi")
print(f"Chamber P Change:     {(Pc_psi[-1]/Pc_psi[0] - 1.0)*100:.2f}%")
print(f"\nInitial L*:           {Lstar[0]*1000:.1f} mm")
print(f"Final L*:             {Lstar[-1]*1000:.1f} mm")
print(f"L* Change:            {Lstar_change_pct:.2f}%")
print(f"\nInitial Throat Area:  {A_throat[0]*1e6:.2f} mm²")
print(f"Final Throat Area:    {A_throat[-1]*1e6:.2f} mm²")
print(f"Throat Area Change:   {throat_area_change_pct:.2f}%")
print(f"\nMax Chamber Recession: {np.max(recession_chamber)*1e6:.2f} µm")
print(f"Max Throat Recession:  {np.max(recession_throat)*1e6:.2f} µm")

# Create plots
fig, axes = plt.subplots(2, 3, figsize=(18, 12))
fig.suptitle('Ablative + Graphite Pipeline: Thrust Performance', fontsize=16, fontweight='bold')

# Plot 1: Thrust over time
ax = axes[0, 0]
ax.plot(times, thrust_kN, 'b-', linewidth=2, label='Thrust')
ax.set_xlabel('Time (s)')
ax.set_ylabel('Thrust (kN)')
ax.set_title('Thrust vs Time')
ax.grid(True, alpha=0.3)
ax.legend()

# Plot 2: Isp over time
ax = axes[0, 1]
ax.plot(times, Isp, 'g-', linewidth=2, label='Isp')
ax.set_xlabel('Time (s)')
ax.set_ylabel('Specific Impulse (s)')
ax.set_title('Isp vs Time')
ax.grid(True, alpha=0.3)
ax.legend()

# Plot 3: Chamber Pressure
ax = axes[0, 2]
ax.plot(times, Pc_psi, 'r-', linewidth=2, label='Chamber Pressure')
ax.set_xlabel('Time (s)')
ax.set_ylabel('Chamber Pressure (psi)')
ax.set_title('Chamber Pressure vs Time')
ax.grid(True, alpha=0.3)
ax.legend()

# Plot 4: L* Evolution
ax = axes[1, 0]
ax.plot(times, Lstar * 1000, 'm-', linewidth=2, label='L*')
ax.set_xlabel('Time (s)')
ax.set_ylabel('L* (mm)')
ax.set_title('Characteristic Length Evolution')
ax.grid(True, alpha=0.3)
ax.legend()

# Plot 5: Throat Area Evolution
ax = axes[1, 1]
ax.plot(times, A_throat * 1e6, 'orange', linewidth=2, label='Throat Area')
ax.set_xlabel('Time (s)')
ax.set_ylabel('Throat Area (mm²)')
ax.set_title('Throat Area Evolution')
ax.grid(True, alpha=0.3)
ax.legend()

# Plot 6: Recession
ax = axes[1, 2]
ax.plot(times, recession_chamber * 1e6, 'purple', linewidth=2, label='Chamber Recession')
ax.plot(times, recession_throat * 1e6, 'orange', linewidth=2, label='Throat Recession')
ax.set_xlabel('Time (s)')
ax.set_ylabel('Recession (µm)')
ax.set_title('Cumulative Recession')
ax.grid(True, alpha=0.3)
ax.legend()

plt.tight_layout()

# Save plot
output_path = Path(__file__).parent / "ablative_graphite_thrust_performance.png"
plt.savefig(output_path, dpi=150, bbox_inches='tight')
print(f"\n✅ Plot saved to: {output_path}")

# Show plot
plt.show()

print(f"\n{'='*80}")
print("SIMULATION COMPLETE")
print("=" * 80)

