"""Example: Pressure sweep - evaluate performance at different tank pressures"""

import numpy as np
import matplotlib.pyplot as plt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from engine.pipeline.io import load_config
from engine.core.runner import PintleEngineRunner
# from engine.pipeline.visualization import plot_all_validation  # Not needed for this script

# Load configuration
config_path = Path(__file__).parent.parent / "configs" / "default.yaml"
config = load_config(str(config_path))

# Initialize runner
runner = PintleEngineRunner(config)

print("=" * 70)
print("PRESSURE SWEEP: Evaluate Engine Performance at Different Tank Pressures")
print("=" * 70)
print("\nINPUT: Arrays of P_tank_O and P_tank_F")
print("OUTPUT: Solved Pc, Thrust, and all performance parameters")
print("\n" + "-" * 70)

# Example 1: 2D Pressure Grid (like reference file)
print("\n Example 1: 2D Pressure Grid (P_tank_O vs P_tank_F)")
print("-" * 70)

# Create 2D grid of tank pressures (like reference file)
# Realistic ranges: Oxidizer 3-8 MPa, Fuel 2.7-7.6 MPa (90-95% of oxidizer)
P_tank_O_grid = np.linspace(3.0e6, 8.0e6, 20)  # 20 points
P_tank_F_grid = np.linspace(2.7e6, 7.6e6, 20)  # 20 points

# Create meshgrid for all combinations
P_O_mesh, P_F_mesh = np.meshgrid(P_tank_O_grid, P_tank_F_grid)

# Flatten for evaluation
P_O_flat = P_O_mesh.flatten()
P_F_flat = P_F_mesh.flatten()

print(f"Pressure Grid:")
print(f"  P_tank_O: {len(P_tank_O_grid)} points from {P_tank_O_grid[0]/6894.76:.0f} to {P_tank_O_grid[-1]/6894.76:.0f} psi")
print(f"  P_tank_F: {len(P_tank_F_grid)} points from {P_tank_F_grid[0]/6894.76:.0f} to {P_tank_F_grid[-1]/6894.76:.0f} psi")
print(f"  Total combinations: {len(P_O_flat)}")

# Evaluate at all pressure combinations
print(f"\nSolving for Pc and calculating thrust at each point...")
results = runner.evaluate_arrays(P_O_flat, P_F_flat)

# Reshape results for plotting (convert to psi)
F_2d = results['F'].reshape(P_O_mesh.shape) / 1000  # kN
Pc_2d = results['Pc'].reshape(P_O_mesh.shape) / 6894.76  # psi
MR_2d = results['MR'].reshape(P_O_mesh.shape)
Isp_2d = results['Isp'].reshape(P_O_mesh.shape)
mdot_total_2d = (results['mdot_O'] + results['mdot_F']).reshape(P_O_mesh.shape)

# Filter out NaN values for summary
valid_mask = ~np.isnan(results['Pc'])
print(f"\nResults Summary (valid points only):")
print(f"  Valid points: {np.sum(valid_mask)}/{len(P_O_flat)}")
if np.sum(valid_mask) > 0:
    print(f"  Solved Pc range: {results['Pc'][valid_mask].min()/6894.76:.0f} - {results['Pc'][valid_mask].max()/6894.76:.0f} psi")
    print(f"  Thrust range: {results['F'][valid_mask].min()/1000:.2f} - {results['F'][valid_mask].max()/1000:.2f} kN")
    print(f"  MR range: {results['MR'][valid_mask].min():.2f} - {results['MR'][valid_mask].max():.2f}")
    print(f"  Isp range: {results['Isp'][valid_mask].min():.1f} - {results['Isp'][valid_mask].max():.1f} s")

# Plot 2D contour maps
fig, axes = plt.subplots(2, 2, figsize=(14, 12))
fig.suptitle("2D Pressure Grid Results (P_tank_O vs P_tank_F)", fontsize=16, fontweight="bold")

# Thrust map
ax = axes[0, 0]
contour = ax.contourf(P_O_mesh / 6894.76, P_F_mesh / 6894.76, F_2d, levels=20, cmap='viridis')
ax.set_xlabel('Oxidizer Tank Pressure [psi]')
ax.set_ylabel('Fuel Tank Pressure [psi]')
ax.set_title('Thrust [kN]')
plt.colorbar(contour, ax=ax, label='Thrust [kN]')

# Chamber pressure map
ax = axes[0, 1]
contour = ax.contourf(P_O_mesh / 6894.76, P_F_mesh / 6894.76, Pc_2d, levels=20, cmap='plasma')
ax.set_xlabel('Oxidizer Tank Pressure [psi]')
ax.set_ylabel('Fuel Tank Pressure [psi]')
ax.set_title('Chamber Pressure [psi] (SOLVED)')
plt.colorbar(contour, ax=ax, label='Pc [psi]')

# Mixture ratio map
ax = axes[1, 0]
contour = ax.contourf(P_O_mesh / 6894.76, P_F_mesh / 6894.76, MR_2d, levels=20, cmap='coolwarm')
ax.set_xlabel('Oxidizer Tank Pressure [psi]')
ax.set_ylabel('Fuel Tank Pressure [psi]')
ax.set_title('Mixture Ratio (O/F)')
plt.colorbar(contour, ax=ax, label='O/F Ratio')

# Isp map
ax = axes[1, 1]
contour = ax.contourf(P_O_mesh / 6894.76, P_F_mesh / 6894.76, Isp_2d, levels=20, cmap='inferno')
ax.set_xlabel('Oxidizer Tank Pressure [psi]')
ax.set_ylabel('Fuel Tank Pressure [psi]')
ax.set_title('Specific Impulse [s]')
plt.colorbar(contour, ax=ax, label='Isp [s]')

plt.tight_layout()
output_path = Path(__file__).parent / "pressure_sweep_results.png"
plt.savefig(str(output_path), dpi=300, bbox_inches='tight')
print(f"\n[OK] Saved 2D pressure grid plots to {output_path}")

# Example 2: 1D slices through the 2D grid (for comparison)
print("\n Example 2: 1D Slices Through Pressure Grid")
print("-" * 70)

# Take slices: fix one pressure, vary the other
# Slice 1: Fix fuel pressure, vary oxidizer
P_tank_F_fixed = 5.0e6  # 5 MPa
P_tank_O_slice = np.linspace(3.0e6, 8.0e6, 30)
P_tank_F_slice1 = np.full_like(P_tank_O_slice, P_tank_F_fixed)

# Slice 2: Fix oxidizer pressure, vary fuel
P_tank_O_fixed = 6.0e6  # 6 MPa
P_tank_F_slice = np.linspace(2.7e6, 7.6e6, 30)
P_tank_O_slice2 = np.full_like(P_tank_F_slice, P_tank_O_fixed)

print(f"Slice 1: P_tank_F fixed at {P_tank_F_fixed/1e6:.1f} MPa, varying P_tank_O")
results_slice1 = runner.evaluate_arrays(P_tank_O_slice, P_tank_F_slice1)

print(f"Slice 2: P_tank_O fixed at {P_tank_O_fixed/1e6:.1f} MPa, varying P_tank_F")
results_slice2 = runner.evaluate_arrays(P_tank_O_slice2, P_tank_F_slice)

# Plot slices
fig, axes = plt.subplots(2, 2, figsize=(12, 10))
fig.suptitle("1D Slices Through Pressure Grid", fontsize=16, fontweight="bold")

# Thrust slices
ax = axes[0, 0]
ax.plot(P_tank_O_slice / 6894.76, results_slice1['F'] / 1000, 'b-', linewidth=2, marker='o', markersize=4, 
        label=f'P_tank_F = {P_tank_F_fixed/6894.76:.0f} psi')
ax.plot(P_tank_F_slice / 6894.76, results_slice2['F'] / 1000, 'r--', linewidth=2, marker='s', markersize=4,
        label=f'P_tank_O = {P_tank_O_fixed/6894.76:.0f} psi')
ax.set_xlabel('Tank Pressure [psi]')
ax.set_ylabel('Thrust [kN]')
ax.legend()
ax.grid(True, alpha=0.3)
ax.set_title('Thrust vs Tank Pressure (Slices)')

# Chamber pressure slices
ax = axes[0, 1]
ax.plot(P_tank_O_slice / 6894.76, results_slice1['Pc'] / 6894.76, 'b-', linewidth=2, marker='o', markersize=4,
        label=f'P_tank_F = {P_tank_F_fixed/6894.76:.0f} psi')
ax.plot(P_tank_F_slice / 6894.76, results_slice2['Pc'] / 6894.76, 'r--', linewidth=2, marker='s', markersize=4,
        label=f'P_tank_O = {P_tank_O_fixed/6894.76:.0f} psi')
ax.set_xlabel('Tank Pressure [psi]')
ax.set_ylabel('Chamber Pressure [psi] (SOLVED)')
ax.legend()
ax.grid(True, alpha=0.3)
ax.set_title('Pc vs Tank Pressure (Slices)')

# Mixture ratio slices
ax = axes[1, 0]
ax.plot(P_tank_O_slice / 6894.76, results_slice1['MR'], 'b-', linewidth=2, marker='o', markersize=4,
        label=f'P_tank_F = {P_tank_F_fixed/6894.76:.0f} psi')
ax.plot(P_tank_F_slice / 6894.76, results_slice2['MR'], 'r--', linewidth=2, marker='s', markersize=4,
        label=f'P_tank_O = {P_tank_O_fixed/6894.76:.0f} psi')
ax.set_xlabel('Tank Pressure [psi]')
ax.set_ylabel('Mixture Ratio (O/F)')
ax.legend()
ax.grid(True, alpha=0.3)
ax.set_title('MR vs Tank Pressure (Slices)')

# Isp slices
ax = axes[1, 1]
ax.plot(P_tank_O_slice / 6894.76, results_slice1['Isp'], 'b-', linewidth=2, marker='o', markersize=4,
        label=f'P_tank_F = {P_tank_F_fixed/6894.76:.0f} psi')
ax.plot(P_tank_F_slice / 6894.76, results_slice2['Isp'], 'r--', linewidth=2, marker='s', markersize=4,
        label=f'P_tank_O = {P_tank_O_fixed/6894.76:.0f} psi')
ax.set_xlabel('Tank Pressure [psi]')
ax.set_ylabel('Specific Impulse [s]')
ax.legend()
ax.grid(True, alpha=0.3)
ax.set_title('Isp vs Tank Pressure (Slices)')

plt.tight_layout()
output_path_slices = Path(__file__).parent / "pressure_slices.png"
plt.savefig(str(output_path_slices), dpi=300, bbox_inches='tight')
print(f"[OK] Saved 1D slice plots to {output_path_slices}")

print("\n" + "=" * 70)
print("[OK] Pressure sweep complete!")
print("=" * 70)
print("\nKey Points:")
print("  • INPUT: Arrays of P_tank_O and P_tank_F")
print("  • Pc is SOLVED at each point (not input!)")
print("  • All performance parameters calculated from solved Pc")
print("  • Can evaluate any number of pressure combinations")

