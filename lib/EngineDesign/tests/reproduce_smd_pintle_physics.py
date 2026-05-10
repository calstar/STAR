import sys
import os
import numpy as np

# Add project root to path
sys.path.append(os.getcwd())

from engine.pipeline.config_schemas import PintleEngineConfig, FluidConfig, PintleInjectorConfig, PintleGeometryConfig, PintleLOXConfig, PintleFuelConfig, SprayConfig, PintleSprayConfig
from engine.core.injectors.pintle import PintleInjector

def test_smd_physics():
    print("Initializing test configuration...")
    
    # Setup Fluid Properties (RP-1 and LOX)
    fluids = {
        "oxidizer": FluidConfig(
            name="LOX",
            density=1141.0,
            viscosity=1.9e-4,
            surface_tension=13.2e-3,
            vapor_pressure=1000.0
        ),
        "fuel": FluidConfig(
            name="RP-1",
            density=800.0,
            viscosity=2.0e-3,
            surface_tension=27.0e-3,
            vapor_pressure=100.0
        )
    }
    
    # Setup Geometry
    # h_gap = 1mm = 0.001m
    h_gap = 0.001
    geometry = PintleGeometryConfig(
        lox=PintleLOXConfig(
            n_orifices=40,
            d_orifice=0.001,
            theta_orifice=90.0,
            A_entry=1e-5,
            d_hydraulic=0.001
        ),
        fuel=PintleFuelConfig(
            d_pintle_tip=0.010,
            d_reservoir_inner=0.008,
            h_gap=h_gap,
            A_entry=1e-4,
            d_hydraulic=0.002
        )
    )
    
    # Setup Spray Config
    # C=1.0, B=0.0, n=0.5, p=0.0 -> SMD = L * We^-0.5
    pintle_spray = PintleSprayConfig(C=1.0, B=0.0, n=0.5, p=0.0)
    spray_cfg = SprayConfig(pintle=pintle_spray)
    
    # Config wrapper
    config = PintleEngineConfig(
        fluids=fluids,
        injector=PintleInjectorConfig(type="pintle", geometry=geometry),
        feed_system={
            "oxidizer": {"d_inlet": 0.01, "A_hydraulic": 7.85e-5, "K0": 1.0, "K1": 0.0},
            "fuel": {"d_inlet": 0.01, "A_hydraulic": 7.85e-5, "K0": 1.0, "K1": 0.0}
        },
        discharge={
            "oxidizer": {"Cd_inf": 0.7, "a_Re": 0.0},
            "fuel": {"Cd_inf": 0.7, "a_Re": 0.0}
        },
        spray=spray_cfg,
        combustion={"cea": {"expansion_ratio": 50.0}},
    )
    
    # Initialize Injector
    injector = PintleInjector(config)
    
    # Run Solve
    # We provide tank pressures high enough to drive flow
    print("Running injector solve...")
    mdot_O, mdot_F, diag = injector.solve(P_tank_O=2e6, P_tank_F=2e6, Pc=1e6)
    
    # Extract Results
    u_O = diag["u_O"]
    u_F = diag["u_F"]
    V_rel_diag = diag["V_rel"]
    L_open_diag = diag["L_open"]
    D32_diag = diag["D32_O"]  # Same as D32_F
    
    print(f"\nDiagnostic Outputs:")
    print(f"u_O: {u_O:.4f} m/s")
    print(f"u_F: {u_F:.4f} m/s")
    print(f"V_rel: {V_rel_diag:.4f} m/s")
    print(f"L_open: {L_open_diag:.6f} m")
    print(f"D32: {D32_diag:.6e} m ({D32_diag*1e6:.2f} um)")
    
    # Manual Verification
    V_rel_calc = np.sqrt(u_O**2 + u_F**2)
    assert abs(V_rel_calc - V_rel_diag) < 1e-6, f"V_rel mismatch: {V_rel_calc} vs {V_rel_diag}"
    
    assert abs(L_open_diag - h_gap) < 1e-9, f"L_open mismatch: {L_open_diag} vs {h_gap}"
    
    # Calculate We_rel using FUEL properties (sheet)
    # We = rho_f * V_rel^2 * L_open / sigma_f
    rho_f = fluids["fuel"].density
    sigma_f = fluids["fuel"].surface_tension
    We_rel_calc = (rho_f * V_rel_calc**2 * h_gap) / sigma_f
    
    print(f"\nManual Limits:")
    print(f"rho_f: {rho_f}")
    print(f"sigma_f: {sigma_f}")
    print(f"We_rel_calc: {We_rel_calc:.4f}")
    
    # Calculate expected SMD
    # SMD = C * L * We^-n * (1 + B*Oh)^p
    # With n=0.5, p=0.0 -> SMD = L * We^-0.5
    SMD_calc = 1.0 * h_gap * (We_rel_calc ** -0.5)
    
    print(f"SMD_calc: {SMD_calc:.6e} m")
    
    error_rel = abs(D32_diag - SMD_calc) / SMD_calc
    print(f"Relative Error: {error_rel:.2e}")
    
    if error_rel < 1e-4:
        print("\nSUCCESS: Implementation matches physics formula.")
    else:
        print("\nFAILURE: Mismatch detected.")
        sys.exit(1)

if __name__ == "__main__":
    try:
        test_smd_physics()
    except Exception as e:
        import traceback
        traceback.print_exc()
        # Create minimal config to allow instantiation if needed, but config_schemas handles required fields
        print(f"Test failed with error: {e}")
        sys.exit(1)
