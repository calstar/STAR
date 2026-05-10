#!/usr/bin/env python3
"""
Deep Physics Review - Diagnostic Trace Script

Traces all physics calculations through a single timestep evaluation
to validate physical correctness and identify any anomalies.
"""

import yaml
import numpy as np
from typing import Dict, Any
from engine.core.runner import PintleEngineRunner
from engine.pipeline.config_schemas import PintleEngineConfig


class PhysicsValidator:
    """Validates physics values against expected ranges and conservation laws."""
    
    def __init__(self):
        self.issues = []
        self.warnings = []
    
    def check_range(self, name: str, value: float, min_val: float, max_val: float, units: str = ""):
        """Check if value is within expected range."""
        if not (min_val <= value <= max_val):
            self.issues.append(f"⚠️  {name} = {value:.4g} {units} is outside expected range [{min_val}, {max_val}]")
            return False
        return True
    
    def check_positive(self, name: str, value: float, units: str = ""):
        """Check if value is positive."""
        if value <= 0:
            self.issues.append(f"⚠️  {name} = {value:.4g} {units} must be positive")
            return False
        return True
    
    def check_efficiency(self, name: str, eta: float):
        """Check if efficiency is physically bounded."""
        if not (0 < eta <= 1.0):
            self.issues.append(f"⚠️  {name} = {eta:.4f} is outside physical bounds (0, 1]")
            return False
        if eta > 0.99:
            self.warnings.append(f"ℹ️  {name} = {eta:.4f} is very high (>99%)")
        return True
    
    def check_conservation(self, name: str, value1: float, value2: float, tolerance: float = 0.01):
        """Check conservation law (relative error)."""
        if value1 == 0 and value2 == 0:
            return True
        
        rel_error = abs(value1 - value2) / max(abs(value1), abs(value2))
        if rel_error > tolerance:
            self.issues.append(
                f"⚠️  {name} conservation violated: {value1:.6g} vs {value2:.6g} "
                f"(error: {rel_error*100:.2f}%)"
            )
            return False
        return True
    
    def print_summary(self):
        """Print validation summary."""
        print("\n" + "="*80)
        print("PHYSICS VALIDATION SUMMARY")
        print("="*80)
        
        if not self.issues and not self.warnings:
            print("✅ All physics checks passed!")
        else:
            if self.issues:
                print(f"\n❌ Found {len(self.issues)} issue(s):")
                for issue in self.issues:
                    print(f"  {issue}")
            
            if self.warnings:
                print(f"\nℹ️  {len(self.warnings)} warning(s):")
                for warning in self.warnings:
                    print(f"  {warning}")
        
        print("="*80 + "\n")


def print_section(title: str):
    """Print a section header."""
    print("\n" + "="*80)
    print(f"  {title}")
    print("="*80)


def extract_and_display_injector_physics(result: Dict[str, Any], validator: PhysicsValidator):
    """Extract and validate injector physics."""
    print_section("PHASE 1: INJECTOR & ATOMIZATION PHYSICS")
    
    # Mass flow rates
    mdot_O = result.get('mdot_O', 0)
    mdot_F = result.get('mdot_F', 0)
    mdot_total = mdot_O + mdot_F
    
    print(f"\n📊 Mass Flow Rates:")
    print(f"  mdot_O:       {mdot_O:.4f} kg/s")
    print(f"  mdot_F:       {mdot_F:.4f} kg/s")
    print(f"  mdot_total:   {mdot_total:.4f} kg/s")
    
    validator.check_positive("mdot_O", mdot_O, "kg/s")
    validator.check_positive("mdot_F", mdot_F, "kg/s")
    validator.check_range("mdot_total", mdot_total, 0.1, 50, "kg/s")
    
    # Pressure drops
    dP_O = result.get('dP_O', 0)
    dP_F = result.get('dP_F', 0)
    Pc = result.get('Pc', 0)
    
    print(f"\n📊 Pressure Drops:")
    print(f"  dP_O:         {dP_O/1e6:.3f} MPa ({dP_O/6894.76:.1f} psi)")
    print(f"  dP_F:         {dP_F/1e6:.3f} MPa ({dP_F/6894.76:.1f} psi)")
    print(f"  dP_O/Pc:      {dP_O/Pc*100:.1f}%")
    print(f"  dP_F/Pc:      {dP_F/Pc*100:.1f}%")
    
    validator.check_positive("dP_O", dP_O, "Pa")
    validator.check_positive("dP_F", dP_F, "Pa")
    validator.check_range("dP_O/Pc", dP_O/Pc, 0.10, 0.40, "")
    validator.check_range("dP_F/Pc", dP_F/Pc, 0.10, 0.40, "")
    
    # Velocities
    U_o = result.get('U_o', 0)
    U_f = result.get('U_f', 0)
    V_rel = result.get('V_rel', 0)
    
    print(f"\n📊 Injection Velocities:")
    print(f"  U_o (LOX):    {U_o:.2f} m/s")
    print(f"  U_f (Fuel):   {U_f:.2f} m/s")
    print(f"  V_rel:        {V_rel:.2f} m/s")
    
    validator.check_positive("U_o", U_o, "m/s")
    validator.check_positive("U_f", U_f, "m/s")
    validator.check_range("U_o", U_o, 5, 200, "m/s")
    validator.check_range("U_f", U_f, 5, 200, "m/s")
    
    # SMD
    SMD = result.get('SMD', 0)
    if SMD > 0:
        SMD_microns = SMD * 1e6
        print(f"\n📊 Atomization:")
        print(f"  SMD:          {SMD_microns:.1f} μm ({SMD*1e3:.4f} mm)")
        
        validator.check_positive("SMD", SMD, "m")
        validator.check_range("SMD", SMD_microns, 10, 500, "μm")
    
    return mdot_total


def extract_and_display_chamber_physics(result: Dict[str, Any], validator: PhysicsValidator):
    """Extract and validate chamber state and CEA properties."""
    print_section("PHASE 2: CHAMBER STATE & THERMOCHEMISTRY")
    
    # Chamber pressure
    Pc = result.get('Pc', 0)
    print(f"\n📊 Chamber Pressure:")
    print(f"  Pc:           {Pc/1e6:.3f} MPa ({Pc/6894.76:.1f} psi)")
    
    validator.check_positive("Pc", Pc, "Pa")
    validator.check_range("Pc", Pc/1e6, 0.5, 20, "MPa")
    
    # CEA properties
    Tc = result.get('Tc', 0)
    gamma = result.get('gamma', 0)
    R = result.get('R', 0)
    cstar_ideal = result.get('cstar_ideal', 0)
    MR = result.get('MR', 0)
    
    print(f"\n📊 CEA Equilibrium Properties:")
    print(f"  Tc:           {Tc:.1f} K ({Tc-273.15:.1f} °C)")
    print(f"  gamma:        {gamma:.4f}")
    print(f"  R:            {R:.2f} J/(kg·K)")
    print(f"  c* (ideal):   {cstar_ideal:.1f} m/s")
    print(f"  MR:           {MR:.3f}")
    
    validator.check_positive("Tc", Tc, "K")
    validator.check_range("Tc", Tc, 2500, 4500, "K")
    validator.check_range("gamma", gamma, 1.1, 1.4, "")
    validator.check_range("R", R, 200, 500, "J/(kg·K)")
    validator.check_range("cstar_ideal", cstar_ideal, 1200, 2000, "m/s")
    
    # Actual c*
    cstar_actual = result.get('cstar_actual', 0)
    eta_cstar = result.get('eta_cstar', 0)
    
    print(f"\n📊 Actual Performance:")
    print(f"  c* (actual):  {cstar_actual:.1f} m/s")
    print(f"  eta_cstar:    {eta_cstar:.4f} ({eta_cstar*100:.1f}%)")
    print(f"  Δc*:          {cstar_ideal - cstar_actual:.1f} m/s")
    
    validator.check_positive("cstar_actual", cstar_actual, "m/s")
    
    return Pc, Tc, cstar_actual


def extract_and_display_efficiency_breakdown(result: Dict[str, Any], validator: PhysicsValidator):
    """Extract and validate combustion efficiency components."""
    print_section("PHASE 3: COMBUSTION EFFICIENCY BREAKDOWN")
    
    # Individual efficiency components
    eta_Lstar = result.get('eta_Lstar', None)
    eta_mixing = result.get('eta_mixing', None)
    eta_kinetics = result.get('eta_kinetics', None)
    eta_cooling = result.get('eta_cooling', None)
    eta_cstar = result.get('eta_cstar', 1.0)
    
    print(f"\n📊 Efficiency Components:")
    
    efficiencies = {}
    if eta_Lstar is not None:
        print(f"  η_Lstar (vaporization):  {eta_Lstar:.4f} ({eta_Lstar*100:.1f}%)")
        validator.check_efficiency("eta_Lstar", eta_Lstar)
        efficiencies['Lstar'] = eta_Lstar
    
    if eta_mixing is not None:
        print(f"  η_mixing:                {eta_mixing:.4f} ({eta_mixing*100:.1f}%)")
        validator.check_efficiency("eta_mixing", eta_mixing)
        efficiencies['mixing'] = eta_mixing
    
    if eta_kinetics is not None:
        print(f"  η_kinetics:              {eta_kinetics:.4f} ({eta_kinetics*100:.1f}%)")
        validator.check_efficiency("eta_kinetics", eta_kinetics)
        efficiencies['kinetics'] = eta_kinetics
    
    if eta_cooling is not None:
        print(f"  η_cooling:               {eta_cooling:.4f} ({eta_cooling*100:.1f}%)")
        validator.check_efficiency("eta_cooling", eta_cooling)
        efficiencies['cooling'] = eta_cooling
    
    print(f"\n  η_cstar (total):         {eta_cstar:.4f} ({eta_cstar*100:.1f}%)")
    validator.check_efficiency("eta_cstar", eta_cstar)
    
    # Check multiplicative consistency
    if len(efficiencies) > 0:
        eta_product = np.prod(list(efficiencies.values()))
        print(f"\n📊 Consistency Check:")
        print(f"  Product of components:   {eta_product:.4f}")
        print(f"  Reported eta_cstar:      {eta_cstar:.4f}")
        print(f"  Difference:              {abs(eta_product - eta_cstar):.6f}")
        
        # Allow some tolerance for additional factors
        if abs(eta_product - eta_cstar) > 0.05:
            validator.warnings.append(
                f"Efficiency product ({eta_product:.4f}) differs from eta_cstar ({eta_cstar:.4f})"
            )


def extract_and_display_nozzle_physics(result: Dict[str, Any], validator: PhysicsValidator):
    """Extract and validate nozzle expansion and thrust."""
    print_section("PHASE 5: NOZZLE EXPANSION & THRUST")
    
    # Nozzle expansion
    Me = result.get('Me', 0)
    P_exit = result.get('P_exit', 0)
    T_exit = result.get('T_exit', 0)
    v_exit = result.get('v_exit', 0)
    
    print(f"\n📊 Nozzle Exit Conditions:")
    print(f"  Me (exit Mach):   {Me:.3f}")
    if P_exit > 0:
        print(f"  P_exit:           {P_exit/1e3:.2f} kPa ({P_exit/6894.76:.2f} psi)")
    if T_exit > 0:
        print(f"  T_exit:           {T_exit:.1f} K")
    if v_exit > 0:
        print(f"  v_exit:           {v_exit:.1f} m/s")
    
    validator.check_range("Me", Me, 1.5, 5.0, "")
    if P_exit > 0:
        validator.check_positive("P_exit", P_exit, "Pa")
    
    # Thrust components
    thrust = result.get('thrust', 0)
    Isp = result.get('Isp', 0)
    Cf = result.get('Cf', 0)
    
    print(f"\n📊 Thrust Performance:")
    print(f"  Thrust:           {thrust:.2f} N ({thrust/1000:.3f} kN)")
    print(f"  Isp:              {Isp:.2f} s")
    if Cf > 0:
        print(f"  Cf:               {Cf:.4f}")
    
    validator.check_positive("Thrust", thrust, "N")
    validator.check_range("Thrust", thrust/1000, 0.5, 50, "kN")
    validator.check_range("Isp", Isp, 150, 400, "s")
    if Cf > 0:
        validator.check_range("Cf", Cf, 1.0, 2.0, "")


def check_mass_conservation(result: Dict[str, Any], mdot_injector: float, validator: PhysicsValidator):
    """Check mass conservation through the system."""
    print_section("CONSERVATION LAWS")
    
    # Throat mass flow
    Pc = result.get('Pc', 0)
    cstar_actual = result.get('cstar_actual', 1)
    A_throat = result.get('A_throat', 0)
    
    if A_throat > 0 and cstar_actual > 0:
        mdot_throat = Pc * A_throat / cstar_actual
        
        print(f"\n📊 Mass Conservation:")
        print(f"  mdot (injector):  {mdot_injector:.6f} kg/s")
        print(f"  mdot (throat):    {mdot_throat:.6f} kg/s")
        print(f"  Difference:       {abs(mdot_injector - mdot_throat):.8f} kg/s")
        print(f"  Relative error:   {abs(mdot_injector - mdot_throat)/mdot_injector*100:.4f}%")
        
        validator.check_conservation(
            "Mass flow (injector vs throat)",
            mdot_injector,
            mdot_throat,
            tolerance=0.001  # 0.1%
        )


def main():
    """Main diagnostic routine."""
    print("="*80)
    print("  DEEP PHYSICS REVIEW - DIAGNOSTIC TRACE")
    print("  Tracing all physics calculations through one timestep")
    print("="*80)
    
    # Load configuration
    print("\n📂 Loading configuration from configs/default.yaml...")
    with open('configs/default.yaml', 'r') as f:
        config_dict = yaml.safe_load(f)
    
    config = PintleEngineConfig(**config_dict)
    print(f"✅ Configuration loaded")
    
    # Create runner
    print("🚀 Creating runner...")
    runner = PintleEngineRunner(config)
    print(f"✅ Runner initialized")
    
    # Set tank pressures (nominal test point)
    P_tank_O = 650 * 6894.76  # 650 psi → Pa
    P_tank_F = 750 * 6894.76  # 750 psi → Pa
    
    print(f"\n📊 Test Conditions:")
    print(f"  P_tank_O:     {P_tank_O/6894.76:.1f} psi ({P_tank_O/1e6:.3f} MPa)")
    print(f"  P_tank_F:     {P_tank_F/6894.76:.1f} psi ({P_tank_F/1e6:.3f} MPa)")
    
    # Run evaluation with debug logging
    print(f"\n🔬 Running evaluation with debug logging enabled...")
    print("   (Check output/logs/evaluate.log for detailed trace)")
    result = runner.evaluate(P_tank_O, P_tank_F, debug=True)
    print(f"✅ Evaluation complete")
    
    # Create validator
    validator = PhysicsValidator()
    
    # Phase 1: Injector physics
    mdot_total = extract_and_display_injector_physics(result, validator)
    
    # Phase 2: Chamber physics
    Pc, Tc, cstar_actual = extract_and_display_chamber_physics(result, validator)
    
    # Phase 3: Efficiency breakdown
    extract_and_display_efficiency_breakdown(result, validator)
    
    # Phase 5: Nozzle and thrust
    extract_and_display_nozzle_physics(result, validator)
    
    # Conservation checks
    check_mass_conservation(result, mdot_total, validator)
    
    # Print validation summary
    validator.print_summary()
    
    # Final summary
    print("\n" + "="*80)
    print("  DIAGNOSTIC TRACE COMPLETE")
    print("="*80)
    print(f"\n📋 Review the following outputs:")
    print(f"  1. Above console output - Physics trace and validation")
    print(f"  2. output/logs/evaluate.log - Detailed debug trace")
    print(f"\n💡 Next Steps:")
    print(f"  - Review any flagged issues or warnings")
    print(f"  - Examine debug log for detailed calculations")
    print(f"  - Verify conservation laws and physical bounds")
    print("="*80 + "\n")


if __name__ == "__main__":
    main()
