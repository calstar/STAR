#!/usr/bin/env python3
"""Parameter sweep to validate gasification efficiency model"""

import numpy as np
from engine.pipeline.combustion_physics import calculate_gasification_efficiency

# Reference conditions (from converged solution)
Tc = 3410.0  # K
Pc = 2.95e6  # Pa
rho_l = 780.0  # kg/m³ (RP-1)
cp_l = 2000.0  # J/(kg·K)
L_eff = 300e3  # J/kg
T_inj = 293.0  # K
cp_g = 2200.0  # J/(kg·K)
rho_g = 2.235  # kg/m³
mu_g = 7e-5  # Pa·s
U_slip = 50.0  # m/s (capped)
Pr = 0.8

# Fuel props with T_star cap
fuel_props = {"T_star_fuel_cap_K": 1000.0}

print("="*80)
print("GASIFICATION EFFICIENCY SENSITIVITY ANALYSIS")
print("="*80)

# SMD Sweep (at fixed tau_res = 1.0 ms)
print("\n1. SMD Sweep (tau_res = 1.0 ms)")
print("-" * 80)
print(f"{'SMD [μm]':>10} {'tau_vap [ms]':>15} {'eta_vap':>10} {'tau_res/tau_vap':>18}")
print("-" * 80)

tau_res_fixed = 1.0e-3  # 1.0 ms
SMD_range = [20e-6, 40e-6, 60e-6, 80e-6, 100e-6, 150e-6, 200e-6]

for SMD in SMD_range:
    eta, diag = calculate_gasification_efficiency(
        Tc=Tc, Pc=Pc, tau_res=tau_res_fixed, SMD=SMD,
        rho_l=rho_l, cp_l=cp_l, L_eff=L_eff, T_inj=T_inj,
        cp_g=cp_g, rho_g=rho_g, mu_g=mu_g, U_slip=U_slip,
        Pr=Pr, fuel_props=fuel_props, debug=False
    )
    tau_vap = diag["tau_vap"]
    ratio = tau_res_fixed / tau_vap
    print(f"{SMD*1e6:10.1f} {tau_vap*1e3:15.4f} {eta:10.4f} {ratio:18.2f}")

# tau_res Sweep (at fixed SMD = 100 μm - large droplet)
print("\n2. Residence Time Sweep (SMD = 100 μm)")
print("-" * 80)
print(f"{'tau_res [ms]':>12} {'tau_vap [ms]':>15} {'eta_vap':>10} {'tau_res/tau_vap':>18}")
print("-" * 80)

SMD_fixed = 100e-6  # 100 μm (large droplet)
tau_res_range = [0.2e-3, 0.5e-3, 1.0e-3, 1.5e-3, 2.0e-3]

for tau_res in tau_res_range:
    eta, diag = calculate_gasification_efficiency(
        Tc=Tc, Pc=Pc, tau_res=tau_res, SMD=SMD_fixed,
        rho_l=rho_l, cp_l=cp_l, L_eff=L_eff, T_inj=T_inj,
        cp_g=cp_g, rho_g=rho_g, mu_g=mu_g, U_slip=U_slip,
        Pr=Pr, fuel_props=fuel_props, debug=False
    )
    tau_vap = diag["tau_vap"]
    ratio = tau_res / tau_vap
    print(f"{tau_res*1e3:12.2f} {tau_vap*1e3:15.4f} {eta:10.4f} {ratio:18.2f}")

# Worst-case corner: Large droplet + short residence time
print("\n3. Corner Cases")
print("-" * 80)
print(f"{'Condition':>30} {'SMD [μm]':>12} {'tau_res [ms]':>15} {'eta_vap':>10}")
print("-" * 80)

cases = [
    ("Best: Small droplet, long time", 20e-6, 2.0e-3),
    ("Good: Small droplet, short time", 20e-6, 0.2e-3),
    ("Moderate: Large droplet, long time", 200e-6, 2.0e-3),
    ("Worst: Large droplet, short time", 200e-6, 0.2e-3),
]

for name, SMD, tau_res in cases:
    eta, diag = calculate_gasification_efficiency(
        Tc=Tc, Pc=Pc, tau_res=tau_res, SMD=SMD,
        rho_l=rho_l, cp_l=cp_l, L_eff=L_eff, T_inj=T_inj,
        cp_g=cp_g, rho_g=rho_g, mu_g=mu_g, U_slip=U_slip,
        Pr=Pr, fuel_props=fuel_props, debug=False
    )
    print(f"{name:>30} {SMD*1e6:12.1f} {tau_res*1e3:15.2f} {eta:10.4f}")

print("\n" + "="*80)
print("VALIDATION SUMMARY")
print("="*80)
print("✓ Model should show η near 1.0 for small droplets / long residence times")
print("✓ Model should show η significantly < 1.0 for large droplets / short times")
print("✓ Model should show smooth transitions (no discontinuities)")
print("="*80)
