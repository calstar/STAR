"""Validate chamber intrinsics against Huzel and Huang reference data"""

import numpy as np
import matplotlib.pyplot as plt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from engine.pipeline.io import load_config
from engine.core.runner import PintleEngineRunner
from engine.pipeline.combustion_eff import (
    eta_cstar, 
    calculate_Lstar, 
    calculate_actual_chamber_temp,
    calculate_frozen_flow_correction
)

# Load configuration
config_path = Path(__file__).parent.parent / "configs" / "default.yaml"
config = load_config(str(config_path))

# Initialize runner
runner = PintleEngineRunner(config)

print("=" * 70)
print("VALIDATING CHAMBER INTRINSICS vs HUZEL & HUANG")
print("=" * 70)

# Test chamber pressures (typical range)
chamber_pressures = [300, 500, 700]  # psia (will convert to Pa)

# Get actual MR range from cache (don't plot outside data range!)
cache = runner.solver.cea_cache
MR_min = cache.MR_min
MR_max = cache.MR_max
print(f"Cache MR range: {MR_min:.2f} to {MR_max:.2f}")

# Mixture ratio range (only within cache bounds)
MR_range = np.linspace(MR_min, MR_max, 30)

# Universal gas constant
R_UNIVERSAL = 8314.462618  # J/(kmol·K)

# Calculate L* for chamber-driven corrections (use config value if provided)
from engine.pipeline.config_schemas import ensure_chamber_geometry
cg = ensure_chamber_geometry(config)
Lstar = calculate_Lstar(
    cg.volume,
    cg.A_throat,
    Lstar_override=cg.Lstar
)
print(f"L* = {Lstar:.3f} m (for chamber-driven corrections)")
if cg.Lstar is not None:
    print(f"  (Using L* from config: {cg.Lstar:.3f} m)")
else:
    print(f"  (Calculated from V={cg.volume:.6f} m³, At={cg.A_throat:.6f} m²)")

# Storage for results at different chamber pressures
results_by_Pc = {}

for Pc_psia in chamber_pressures:
    Pc_Pa = Pc_psia * 6894.76  # Convert to Pa
    
    Tc_ideal_values = []
    Tc_actual_values = []
    cstar_ideal_values = []
    cstar_actual_values = []
    gamma_ideal_values = []
    gamma_actual_values = []
    R_values = []
    M_values = []  # Molecular weight
    eta_values = []
    
    print(f"\nEvaluating at Pc = {Pc_psia} psia ({Pc_Pa/1e6:.2f} MPa)...")
    
    for MR in MR_range:
        try:
            # Get IDEAL CEA properties (infinite-area equilibrium)
            cea_props = runner.solver.cea_cache.eval(MR, Pc_Pa)
            
            Tc_ideal = cea_props['Tc']  # K
            cstar_ideal = cea_props['cstar_ideal']  # m/s
            gamma_ideal = cea_props['gamma']
            R = cea_props['R']  # J/(kg·K)
            
            # Apply CHAMBER-DRIVEN corrections
            # 1. Combustion efficiency (L* correction)
            # Build minimal advanced_params for validation
            from engine.pipeline.constants import DEFAULT_TURBULENCE_INTENSITY_ND
            advanced_params = {
                "Pc": Pc_Pa,
                "Tc": Tc_ideal,
                "cstar_ideal": cstar_ideal,
                "gamma": gamma_ideal,
                "R": R,
                "MR": MR,
                "Ac": cg.area_cross,
                "At": cg.A_throat,
                "chamber_length": cg.length,
                "Dinj": 0.002,  # Typical injector diameter for validation
                "m_dot_total": 3.0,  # Typical mass flow for validation
                "spray_diagnostics": None,
                "turbulence_intensity": DEFAULT_TURBULENCE_INTENSITY_ND,
            }
            eta = eta_cstar(
                Lstar,
                config.combustion.efficiency,
                cooling_efficiency=1.0,  # No cooling losses for validation
                advanced_params=advanced_params,
            )
            
            # 2. Actual c* accounting for finite chamber
            cstar_actual = eta * cstar_ideal
            
            # 3. Actual chamber temperature (incomplete combustion)
            Tc_actual = calculate_actual_chamber_temp(
                Tc_ideal,
                eta,
                gamma_ideal
            )
            
            # 4. Frozen flow correction for gamma
            gamma_frozen_factor = calculate_frozen_flow_correction(Lstar, gamma_ideal)
            gamma_actual = gamma_ideal * gamma_frozen_factor
            
            # Store both ideal and actual values
            Tc_ideal_values.append(Tc_ideal)
            Tc_actual_values.append(Tc_actual)
            cstar_ideal_values.append(cstar_ideal)
            cstar_actual_values.append(cstar_actual)
            gamma_ideal_values.append(gamma_ideal)
            gamma_actual_values.append(gamma_actual)
            R_values.append(R)
            eta_values.append(eta)
            
            # Calculate molecular weight from R
            # R = R_universal / M  →  M = R_universal / R
            M = R_UNIVERSAL / R  # kg/kmol
            M_values.append(M)
            
        except Exception as e:
            print(f"  Warning: Failed at MR={MR:.2f}: {e}")
            Tc_ideal_values.append(np.nan)
            Tc_actual_values.append(np.nan)
            cstar_ideal_values.append(np.nan)
            cstar_actual_values.append(np.nan)
            gamma_ideal_values.append(np.nan)
            gamma_actual_values.append(np.nan)
            R_values.append(np.nan)
            M_values.append(np.nan)
            eta_values.append(np.nan)
    
    results_by_Pc[Pc_psia] = {
        'Tc_ideal': np.array(Tc_ideal_values),
        'Tc_actual': np.array(Tc_actual_values),
        'cstar_ideal': np.array(cstar_ideal_values),
        'cstar_actual': np.array(cstar_actual_values),
        'gamma_ideal': np.array(gamma_ideal_values),
        'gamma_actual': np.array(gamma_actual_values),
        'R': np.array(R_values),
        'M': np.array(M_values),
        'eta': np.array(eta_values)
    }

# Convert to imperial units for comparison with Huzel & Huang
print("\nConverting to imperial units...")

for Pc_psia in chamber_pressures:
    results = results_by_Pc[Pc_psia]
    
    # Temperature: K → °F (both ideal and actual)
    results['Tc_ideal_F'] = (results['Tc_ideal'] - 273.15) * 9/5 + 32
    results['Tc_actual_F'] = (results['Tc_actual'] - 273.15) * 9/5 + 32
    
    # Characteristic velocity: m/s → ft/s (both ideal and actual)
    results['cstar_ideal_fps'] = results['cstar_ideal'] * 3.28084
    results['cstar_actual_fps'] = results['cstar_actual'] * 3.28084
    
    # Molecular weight: kg/kmol → lb/lbmol (same numerically)
    results['M_lb_lbmol'] = results['M']
    
    # R: J/(kg·K) → ft·lbf/(lbm·°R)
    # R_imperial = R_SI * 0.0053566
    results['R_imperial'] = results['R'] * 0.0053566

# Create validation plots
fig, axes = plt.subplots(3, 2, figsize=(16, 14))
fig.suptitle("Chamber Intrinsics Validation vs Huzel & Huang (LOX/RP-1)", 
             fontsize=16, fontweight="bold")

# Plot 1: Combustion Chamber Temperature (ACTUAL - chamber-driven)
ax = axes[0, 0]
for Pc_psia in chamber_pressures:
    results = results_by_Pc[Pc_psia]
    # Only plot valid (non-NaN) data - use ACTUAL (chamber-driven) values
    valid_mask = ~np.isnan(results['Tc_actual_F'])
    if np.any(valid_mask):
        ax.plot(MR_range[valid_mask], results['Tc_actual_F'][valid_mask], 
                linewidth=2, marker='o', markersize=4,
                label=f'Pc = {Pc_psia} psia (actual)')
        # Also show ideal as dashed line for comparison
        ideal_mask = ~np.isnan(results['Tc_ideal_F'])
        if np.any(ideal_mask):
            ax.plot(MR_range[ideal_mask], results['Tc_ideal_F'][ideal_mask], 
                    linewidth=1, linestyle='--', alpha=0.5,
                    label=f'Pc = {Pc_psia} psia (ideal CEA)')
ax.set_xlabel('Mixture Ratio (O/F)')
ax.set_ylabel('Chamber Temperature [°F]')
ax.set_title('Chamber Temperature (ACTUAL - chamber-driven)')
ax.grid(True, alpha=0.3)
ax.legend(fontsize=8)
ax.set_xlim(MR_min, MR_max)
ax.set_ylim(3000, 7000)
# Add reference annotation
ax.text(0.05, 0.95, 'H&H Peak: ~6000°F @ MR≈2.75', 
        transform=ax.transAxes, fontsize=10, verticalalignment='top',
        bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.5))

# Plot 2: Characteristic Velocity (c*) - ACTUAL
ax = axes[0, 1]
for Pc_psia in chamber_pressures:
    results = results_by_Pc[Pc_psia]
    # Only plot valid (non-NaN) data - use ACTUAL (chamber-driven) values
    valid_mask = ~np.isnan(results['cstar_actual_fps'])
    if np.any(valid_mask):
        ax.plot(MR_range[valid_mask], results['cstar_actual_fps'][valid_mask], 
                linewidth=2, marker='o', markersize=4,
                label=f'Pc = {Pc_psia} psia (actual)')
        # Also show ideal as dashed line for comparison
        ideal_mask = ~np.isnan(results['cstar_ideal_fps'])
        if np.any(ideal_mask):
            ax.plot(MR_range[ideal_mask], results['cstar_ideal_fps'][ideal_mask], 
                    linewidth=1, linestyle='--', alpha=0.5,
                    label=f'Pc = {Pc_psia} psia (ideal CEA)')
ax.set_xlabel('Mixture Ratio (O/F)')
ax.set_ylabel('Characteristic Velocity [ft/s]')
ax.set_title('Characteristic Velocity (c* - ACTUAL)')
ax.grid(True, alpha=0.3)
ax.legend(fontsize=8)
ax.set_xlim(MR_min, MR_max)
ax.set_ylim(5000, 6000)
ax.text(0.05, 0.95, 'H&H Peak: ~5850 ft/s @ MR≈2.25', 
        transform=ax.transAxes, fontsize=10, verticalalignment='top',
        bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.5))

# Plot 3: Specific Heat Ratio (gamma) - ACTUAL
ax = axes[1, 0]
for Pc_psia in chamber_pressures:
    results = results_by_Pc[Pc_psia]
    # Only plot valid (non-NaN) data - use ACTUAL (frozen flow corrected) values
    valid_mask = ~np.isnan(results['gamma_actual'])
    if np.any(valid_mask):
        ax.plot(MR_range[valid_mask], results['gamma_actual'][valid_mask], 
                linewidth=2, marker='o', markersize=4,
                label=f'Pc = {Pc_psia} psia (actual)')
        # Also show ideal as dashed line for comparison
        ideal_mask = ~np.isnan(results['gamma_ideal'])
        if np.any(ideal_mask):
            ax.plot(MR_range[ideal_mask], results['gamma_ideal'][ideal_mask], 
                    linewidth=1, linestyle='--', alpha=0.5,
                    label=f'Pc = {Pc_psia} psia (ideal CEA)')
ax.set_xlabel('Mixture Ratio (O/F)')
ax.set_ylabel('Specific Heat Ratio (gamma)')
ax.set_title('Specific Heat Ratio (gamma - ACTUAL with frozen flow)')
ax.grid(True, alpha=0.3)
ax.legend(fontsize=8)
ax.set_xlim(MR_min, MR_max)
ax.set_ylim(1.15, 1.30)
ax.text(0.05, 0.95, 'H&H Range: 1.28→1.21 (decreasing)', 
        transform=ax.transAxes, fontsize=10, verticalalignment='top',
        bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.5))

# Plot 4: Molecular Weight
ax = axes[1, 1]
for Pc_psia in chamber_pressures:
    results = results_by_Pc[Pc_psia]
    # Only plot valid (non-NaN) data
    valid_mask = ~np.isnan(results['M_lb_lbmol'])
    if np.any(valid_mask):
        ax.plot(MR_range[valid_mask], results['M_lb_lbmol'][valid_mask], 
                linewidth=2, marker='o', markersize=4,
                label=f'Pc = {Pc_psia} psia')
ax.set_xlabel('Mixture Ratio (O/F)')
ax.set_ylabel('Molecular Weight [lb/lbmol]')
ax.set_title('Molecular Weight of Combustion Products (M)')
ax.grid(True, alpha=0.3)
ax.legend()
ax.set_xlim(MR_min, MR_max)
ax.set_ylim(15, 30)
ax.text(0.05, 0.95, 'H&H Range: 17.5→24.5 (increasing)', 
        transform=ax.transAxes, fontsize=10, verticalalignment='top',
        bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.5))

# Plot 5: Gas Constant R (SI units)
ax = axes[2, 0]
for Pc_psia in chamber_pressures:
    results = results_by_Pc[Pc_psia]
    # Only plot valid (non-NaN) data
    valid_mask = ~np.isnan(results['R'])
    if np.any(valid_mask):
        ax.plot(MR_range[valid_mask], results['R'][valid_mask], 
                linewidth=2, marker='o', markersize=4,
                label=f'Pc = {Pc_psia} psia')
ax.set_xlabel('Mixture Ratio (O/F)')
ax.set_ylabel('Gas Constant R [J/(kg·K)]')
ax.set_title('Gas Constant (R = R_universal / M)')
ax.grid(True, alpha=0.3)
ax.legend()
ax.set_xlim(MR_min, MR_max)

# Plot 6: Summary Table at MR = 2.2 (target)
ax = axes[2, 1]
ax.axis('off')

# Create comparison table
MR_target = 2.2
idx_target = np.argmin(np.abs(MR_range - MR_target))

table_data = []
table_data.append(['Parameter', 'Our Model', 'H&H Ref', 'Units'])
table_data.append(['─' * 15, '─' * 12, '─' * 12, '─' * 10])

# Get values at MR = 2.2, Pc = 500 psia (ACTUAL chamber-driven)
results_500 = results_by_Pc[500]
Tc_actual_F = results_500['Tc_actual_F'][idx_target]
cstar_actual_fps = results_500['cstar_actual_fps'][idx_target]
gamma_actual = results_500['gamma_actual'][idx_target]
M = results_500['M_lb_lbmol'][idx_target]
eta = results_500['eta'][idx_target]

table_data.append(['Tc (actual)', f'{Tc_actual_F:.0f}', '~5800', '°F'])
table_data.append(['c* (actual)', f'{cstar_actual_fps:.0f}', '~5850', 'ft/s'])
table_data.append(['gamma (actual)', f'{gamma_actual:.3f}', '~1.23', '-'])
table_data.append(['M', f'{M:.1f}', '~22', 'lb/lbmol'])
table_data.append(['eta_c*', f'{eta:.3f}', '-', '-'])

# Format table
table_text = 'Comparison at MR = 2.2, Pc = 500 psia\n\n'
for row in table_data:
    table_text += f'{row[0]:15s} {row[1]:>12s} {row[2]:>12s} {row[3]:>10s}\n'

ax.text(0.1, 0.5, table_text, fontsize=11, family='monospace',
        verticalalignment='center',
        bbox=dict(boxstyle='round', facecolor='lightblue', alpha=0.3))

plt.tight_layout()
output_path = Path(__file__).parent / "chamber_intrinsics_validation.png"
plt.savefig(str(output_path), dpi=300, bbox_inches='tight')
print(f"\n[OK] Saved validation plots to {output_path}")

# Print summary statistics
print("\n" + "=" * 70)
print("VALIDATION SUMMARY (at Pc = 500 psia, MR = 2.2)")
print("=" * 70)

results_500 = results_by_Pc[500]
idx = np.argmin(np.abs(MR_range - 2.2))

print(f"\nOur Model (CHAMBER-DRIVEN - actual):")
print(f"  Tc_actual = {results_500['Tc_actual'][idx]:.1f} K ({results_500['Tc_actual_F'][idx]:.0f} °F)")
print(f"  c*_actual = {results_500['cstar_actual'][idx]:.1f} m/s ({results_500['cstar_actual_fps'][idx]:.0f} ft/s)")
print(f"  gamma_actual  = {results_500['gamma_actual'][idx]:.4f}")
print(f"  M         = {results_500['M'][idx]:.2f} kg/kmol")
print(f"  R         = {results_500['R'][idx]:.2f} J/(kg·K)")
print(f"  eta_c*      = {results_500['eta'][idx]:.4f}")
print(f"\n  (Ideal CEA for comparison:)")
print(f"  Tc_ideal  = {results_500['Tc_ideal'][idx]:.1f} K ({results_500['Tc_ideal_F'][idx]:.0f} °F)")
print(f"  c*_ideal  = {results_500['cstar_ideal'][idx]:.1f} m/s ({results_500['cstar_ideal_fps'][idx]:.0f} ft/s)")
print(f"  gamma_ideal   = {results_500['gamma_ideal'][idx]:.4f}")

print(f"\nHuzel & Huang Reference (approximate from graph):")
print(f"  Tc approx 5800 degF (peak ~6000 degF @ MR approx 2.75)")
print(f"  c* approx 5850 ft/s (peak @ MR approx 2.25)")
print(f"  gamma  approx 1.23 (decreasing with MR)")
print(f"  M  approx 22 lb/lbmol (increasing with MR)")

print("\n[OK] Validation complete!")
print("=" * 70)

