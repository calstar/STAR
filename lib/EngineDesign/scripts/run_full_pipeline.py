"""Run full pipeline and display all performance metrics"""

import numpy as np
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from engine.pipeline.io import load_config
from engine.core.runner import PintleEngineRunner
from ui.flight_sim import setup_flight

print("=" * 80)
print("FULL PIPELINE PERFORMANCE ANALYSIS")
print("=" * 80)

# Load configuration
config_path = Path(__file__).parent.parent / "configs" / "default.yaml"
config = load_config(str(config_path))

# Initialize runner
runner = PintleEngineRunner(config)

# Test at target operating point from engine specs
P_tank_O = 400 * 6894.76  # psi to Pa (from previous analysis)
P_tank_F = 300 * 6894.76   # psi to Pa (from previous analysis)

print(f"\nINPUT CONDITIONS:")
print(f"  P_tank_O = {P_tank_O/6894.76:.0f} psi ({P_tank_O/1e6:.2f} MPa)")
print(f"  P_tank_F = {P_tank_F/6894.76:.0f} psi ({P_tank_F/1e6:.2f} MPa)")

# Run pipeline
print(f"\n{'='*80}")
print("SOLVING FOR CHAMBER PRESSURE AND CALCULATING PERFORMANCE...")
print(f"{'='*80}")

results = runner.evaluate(P_tank_O, P_tank_F)

# Extract diagnostics if available
diagnostics = results.get('diagnostics', {})
if isinstance(diagnostics, list):
    diagnostics = diagnostics[0] if diagnostics else {}

print(f"\n{'='*80}")
print("CHAMBER PERFORMANCE")
print(f"{'='*80}")

Pc = results['Pc']
print(f"  Solved Pc = {Pc/6894.76:.1f} psi ({Pc/1e6:.3f} MPa)")

# Mass flow rates
mdot_O = results['mdot_O']
mdot_F = results['mdot_F']
mdot_total = mdot_O + mdot_F
MR = results['MR']

print(f"\n  Mass Flow Rates:")
print(f"    Oxidizer: {mdot_O:.4f} kg/s")
print(f"    Fuel:     {mdot_F:.4f} kg/s")
print(f"    Total:    {mdot_total:.4f} kg/s")
print(f"    Mixture Ratio (O/F): {MR:.3f}")

# Combustion properties
cstar_actual = results['cstar_actual']
eta_cstar = diagnostics.get('eta_cstar', np.nan)

print(f"\n  Combustion Properties:")
print(f"    c*_actual = {cstar_actual:.1f} m/s ({cstar_actual*3.28084:.0f} ft/s)")
if not np.isnan(eta_cstar):
    print(f"    η_c* (combustion efficiency) = {eta_cstar:.4f}")

# Chamber intrinsics
Tc = diagnostics.get('Tc', np.nan)
gamma = diagnostics.get('gamma', np.nan)
R = diagnostics.get('R', np.nan)
M = diagnostics.get('M', np.nan)

if not np.isnan(Tc):
    print(f"    Chamber Temperature: {Tc:.1f} K ({Tc*9/5-459.67:.0f} °F)")
if not np.isnan(gamma):
    print(f"    Gamma: {gamma:.4f}")
if not np.isnan(R):
    print(f"    Gas Constant R: {R:.2f} J/(kg·K)")
if np.isfinite(M):
    print(f"    Molecular Weight: {M:.2f} kg/kmol ({M:.2f} lb/lbmol)")
else:
    print("    Molecular Weight: unavailable from CEA cache")

# Performance metrics
F = results['F']
Isp = results['Isp']
F_momentum = results.get('F_momentum', np.nan)
F_pressure = results.get('F_pressure', np.nan)
P_exit = results.get('P_exit', np.nan)
v_exit = results.get('v_exit', np.nan)

print(f"\n  Performance Metrics:")
print(f"    Thrust: {F/1000:.3f} kN ({F:.1f} N)")
if not np.isnan(F_momentum):
    print(f"      Momentum component: {F_momentum/1000:.3f} kN")
if not np.isnan(F_pressure):
    print(f"      Pressure component: {F_pressure/1000:.3f} kN")
print(f"    Specific Impulse: {Isp:.2f} s")
if not np.isnan(v_exit):
    print(f"    Exit Velocity: {v_exit:.1f} m/s")
if not np.isnan(P_exit):
    print(f"    Exit Pressure: {P_exit/6894.76:.2f} psi ({P_exit/1e6:.3f} MPa)")

print(f"\n{'='*80}")
print("INJECTOR PERFORMANCE")
print(f"{'='*80}")

# Calculate injector pressures
from engine.pipeline.feed_loss import delta_p_feed

delta_p_feed_O = delta_p_feed(mdot_O, config.fluids["oxidizer"].density, 
                               config.feed_system["oxidizer"], P_tank_O)

# For fuel: add regenerative cooling pressure drop if enabled
delta_p_feed_F_base = delta_p_feed(mdot_F, config.fluids["fuel"].density,
                                   config.feed_system["fuel"], P_tank_F)

delta_p_regen = 0.0
if config.regen_cooling is not None and config.regen_cooling.enabled:
    from engine.pipeline.thermal.regen_cooling import delta_p_regen_channels
    mu_F = config.fluids["fuel"].viscosity
    delta_p_regen = delta_p_regen_channels(
        mdot_F, config.fluids["fuel"].density, mu_F, config.regen_cooling, P_tank_F
    )
    delta_p_feed_F = delta_p_feed_F_base + delta_p_regen
else:
    delta_p_feed_F = delta_p_feed_F_base

P_inj_O = P_tank_O - delta_p_feed_O
P_inj_F = P_tank_F - delta_p_feed_F

delta_p_inj_O = P_inj_O - Pc
delta_p_inj_F = P_inj_F - Pc

print(f"\n  Pressure Drops:")
print(f"    Feed System (LOX):")
print(f"      P_tank = {P_tank_O/6894.76:.1f} psi")
print(f"      Δp_feed = {delta_p_feed_O/6894.76:.2f} psi")
print(f"      P_injector = {P_inj_O/6894.76:.1f} psi")
print(f"      Δp_injector = {delta_p_inj_O/6894.76:.1f} psi")
print(f"    Feed System (Fuel):")
print(f"      P_tank = {P_tank_F/6894.76:.1f} psi")
print(f"      Δp_feed_base = {delta_p_feed_F_base/6894.76:.2f} psi")
if config.regen_cooling is not None and config.regen_cooling.enabled:
    print(f"      Δp_regen_cooling = {delta_p_regen/6894.76:.2f} psi")
    print(f"      Δp_feed_total = {delta_p_feed_F/6894.76:.2f} psi")
print(f"      P_injector = {P_inj_F/6894.76:.1f} psi")
print(f"      Δp_injector = {delta_p_inj_F/6894.76:.1f} psi")

# Injector geometry
from engine.core.geometry import get_effective_areas, get_hydraulic_diameters

A_LOX, A_fuel = get_effective_areas(config.injector.geometry)
d_hyd_O, d_hyd_F = get_hydraulic_diameters(config.injector.geometry)

print(f"\n  Injector Geometry:")
print(f"    LOX:")
print(f"      Number of orifices: {config.injector.geometry.lox.n_orifices}")
print(f"      Orifice diameter: {config.injector.geometry.lox.d_orifice*1000:.2f} mm")
print(f"      Total area: {A_LOX*1e6:.4f} mm²")
print(f"      Hydraulic diameter: {d_hyd_O*1000:.2f} mm")
print(f"    Fuel:")
print(f"      Pintle tip diameter: {config.injector.geometry.fuel.d_pintle_tip*1000:.2f} mm")
print(f"      Gap height: {config.injector.geometry.fuel.h_gap*1000:.2f} mm")
print(f"      Total area: {A_fuel*1e6:.4f} mm²")
print(f"      Hydraulic diameter: {d_hyd_F*1000:.2f} mm")

# Flow velocities
rho_O = config.fluids["oxidizer"].density
rho_F = config.fluids["fuel"].density

u_O = mdot_O / (rho_O * A_LOX)
u_F = mdot_F / (rho_F * A_fuel)

print(f"\n  Flow Velocities:")
print(f"    LOX: {u_O:.2f} m/s")
print(f"    Fuel: {u_F:.2f} m/s")

# Discharge coefficients
from engine.core.discharge import cd_from_re, calculate_reynolds_number

mu_O = config.fluids["oxidizer"].viscosity
mu_F = config.fluids["fuel"].viscosity

Re_O = calculate_reynolds_number(rho_O, u_O, d_hyd_O, mu_O)
Re_F = calculate_reynolds_number(rho_F, u_F, d_hyd_F, mu_F)

Cd_O = cd_from_re(Re_O, config.discharge["oxidizer"])
Cd_F = cd_from_re(Re_F, config.discharge["fuel"])

print(f"\n  Discharge Coefficients:")
print(f"    LOX: Cd = {Cd_O:.4f} (Re = {Re_O:.0f})")
print(f"    Fuel: Cd = {Cd_F:.4f} (Re = {Re_F:.0f})")

# Spray diagnostics
J = diagnostics.get('J', np.nan)
TMR = diagnostics.get('TMR', np.nan)
theta = diagnostics.get('theta', np.nan)
We_O = diagnostics.get('We_O', np.nan)
We_F = diagnostics.get('We_F', np.nan)
D32_O = diagnostics.get('D32_O', np.nan)
D32_F = diagnostics.get('D32_F', np.nan)
x_star = diagnostics.get('x_star', np.nan)

print(f"\n{'='*80}")
print("SPRAY DIAGNOSTICS")
print(f"{'='*80}")

if not np.isnan(J):
    print(f"  Momentum Flux Ratio (J): {J:.3f}")
if not np.isnan(TMR):
    print(f"  Thrust/Momentum Ratio (TMR): {TMR:.3f}")
if not np.isnan(theta):
    print(f"  Spray Angle (θ): {theta*180/np.pi:.1f}°")
if not np.isnan(We_O):
    print(f"  Weber Number (LOX): {We_O:.0f}")
if not np.isnan(We_F):
    print(f"  Weber Number (Fuel): {We_F:.0f}")
if not np.isnan(D32_O):
    print(f"  Sauter Mean Diameter (LOX): {D32_O*1e6:.2f} μm")
if not np.isnan(D32_F):
    print(f"  Sauter Mean Diameter (Fuel): {D32_F*1e6:.2f} μm")
if not np.isnan(x_star):
    print(f"  Evaporation Length (x*): {x_star*1000:.2f} mm")

constraints_satisfied = diagnostics.get('constraints_satisfied', False)
print(f"  Spray Constraints Satisfied: {constraints_satisfied}")

# Cooling diagnostics
cooling = results.get("cooling", {})
if cooling:
    print(f"\n{'='*80}")
    print("COOLING SUMMARY")
    print(f"{'='*80}")

    regen = cooling.get("regen")
    if regen and regen.get("enabled", False):
        print("  Regenerative Cooling:")
        print(f"    Coolant outlet temperature: {regen['coolant_outlet_temperature']:.1f} K")
        print(f"    Heat removed: {regen['heat_removed']/1000:.1f} kW")
        print(f"    Hot-side heat flux: {regen['overall_heat_flux']/1000:.1f} kW/m²")
        if 'mdot_coolant' in regen:
            print(f"    Coolant flow through channels: {regen['mdot_coolant']:.3f} kg/s")
        print(f"    Wall temperature (hot/cool): {regen['wall_temperature_hot']:.1f} K / {regen['wall_temperature_coolant']:.1f} K")
        if regen.get('film_effectiveness', 0.0) > 0:
            print(f"    Film effectiveness applied: {regen['film_effectiveness']:.2f}")

    film = cooling.get("film")
    if film and film.get("enabled", False):
        print("  Film Cooling:")
        print(f"    Mass fraction: {film['mass_fraction']:.3f}")
        print(f"    Effectiveness: {film['effectiveness']:.2f}")
        print(f"    Film mass flow: {film['mdot_film']:.3f} kg/s")
        print(f"    Heat-flux reduction factor: {film['heat_flux_factor']:.2f}")

    ablative = cooling.get("ablative")
    if ablative and ablative.get("enabled", False):
        print("  Ablative Cooling:")
        print(f"    Recession rate: {ablative['recession_rate']*1e6:.3f} µm/s")
        print(f"    Effective heat flux: {ablative['effective_heat_flux']/1000:.1f} kW/m²")

# ==============================================================================
# FLIGHT SIMULATION
# ==============================================================================
print(f"\n{'='*80}")
print("FLIGHT SIMULATION")
print(f"{'='*80}")

try:
    rocket = setup_flight(config, F, mdot_O, mdot_F)

    # Display summary results
    print(f"\n{'-'*80}")
    print("FLIGHT RESULTS")
    print(f"{'-'*80}")
    print(f"  Apogee:        {rocket.apogee:.2f} m")
    print(f"  Max Velocity:  {rocket.maxVelocity:.2f} m/s")
    print(f"  Flight Time:   {rocket.totalTime:.2f} s")
    print(f"  Burn Time:     {rocket.motor.burnOut:.2f} s")
    print(f"  Launch Rail Exit Velocity: {rocket.outOfRailVelocity:.2f} m/s")

except Exception as e:
    print(f"\n[ERROR] Flight simulation failed: {e}")
    print("Skipping flight simulation section.")

# Compare to target
print(f"\n{'='*80}")
print("COMPARISON TO TARGET (from engine specs)")
print(f"{'='*80}")

target_mdot = 1.81
target_F = 5.30753
target_MR = 2.36
target_Isp = 299.0

print(f"  Mass Flow:")
print(f"    Target: {target_mdot:.3f} kg/s")
print(f"    Actual: {mdot_total:.3f} kg/s")
print(f"    Difference: {mdot_total - target_mdot:.3f} kg/s ({abs(mdot_total - target_mdot)/target_mdot*100:.1f}%)")

print(f"\n  Thrust:")
print(f"    Target: {target_F:.3f} kN")
print(f"    Actual: {F/1000:.3f} kN")
print(f"    Difference: {F/1000 - target_F:.3f} kN ({abs(F/1000 - target_F)/target_F*100:.1f}%)")

print(f"\n  Mixture Ratio:")
print(f"    Target: {target_MR:.2f}")
print(f"    Actual: {MR:.2f}")
print(f"    Difference: {MR - target_MR:.2f} ({abs(MR - target_MR)/target_MR*100:.1f}%)")

print(f"\n  Specific Impulse:")
print(f"    Target: {target_Isp:.1f} s")
print(f"    Actual: {Isp:.1f} s")
print(f"    Difference: {Isp - target_Isp:.1f} s ({abs(Isp - target_Isp)/target_Isp*100:.1f}%)")

print(f"\n{'='*80}")
print("[OK] FULL PIPELINE ANALYSIS COMPLETE")
print(f"{'='*80}")

