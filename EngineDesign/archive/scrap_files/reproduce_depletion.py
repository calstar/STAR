
import numpy as np
import matplotlib.pyplot as plt
from engine.pipeline.time_varying_solver import TimeVaryingCoupledSolver
from engine.pipeline.config_schemas import PintleEngineConfig, FluidConfig, InjectorConfig, PintleInjectorConfig, PintleGeometryConfig
from backend.routers.timeseries import compute_timeseries_results
from copv.blowdown_solver import simulate_coupled_blowdown
from types import SimpleNamespace

# Mock Config
class MockConfig:
    def __init__(self):
        self.fluids = {
            'oxidizer': SimpleNamespace(density=1000.0), # Water-like
            'fuel': SimpleNamespace(density=800.0),
            'pressurant': SimpleNamespace(R=296.8)
        }
        self.lox_tank = SimpleNamespace(tank_volume_m3=0.01, mass=5.0) # Small tank
        self.fuel_tank = SimpleNamespace(tank_volume_m3=0.01, mass=4.0) 
        self.injector = SimpleNamespace(
            type='pintle',
            geometry=SimpleNamespace(
                lox=SimpleNamespace(n_orifices=10, A_entry=1e-5), # 10 * 1e-5 = 1e-4 m2
                fuel=SimpleNamespace(d_pintle_tip=0.02, h_gap=0.001) # pi * 0.02 * 0.001 ~ 6e-5 m2
            )
        )
        self.ablative_cooling = None
        self.graphite_insert = None

# Mock Engine Evaluator
def mock_engine_eval(P_lox, P_fuel):
    # Simple proportionality
    mdot_o = P_lox * 1e-6
    mdot_f = P_fuel * 1e-6
    if P_lox < 1e5 or P_fuel < 1e5:
        return 0.0, 0.0
    return mdot_o, mdot_f

def test_depletion():
    config = MockConfig()
    
    # Run long enough to deplete
    times = np.linspace(0, 10, 100) 
    
    print("Running depletion simulation...")
    results = simulate_coupled_blowdown(
        times=times,
        evaluate_engine_fn=mock_engine_eval,
        P_lox_initial_Pa=2e6, # 2 MPa (~300 psi)
        P_fuel_initial_Pa=2e6,
        config=config,
        use_real_gas=False
    )
    
    lox_P = results['lox']['P_Pa']
    lox_m = results['lox']['m_prop_kg']
    
    print(f"Initial LOX Mass: {lox_m[0]:.2f} kg")
    print(f"Final LOX Mass: {lox_m[-1]:.2f} kg")
    print(f"Initial LOX Pressure: {lox_P[0]/1e5:.2f} bar")
    print(f"Final LOX Pressure: {lox_P[-1]/1e5:.2f} bar")
    
    # Verify depletion
    if lox_m[-1] > 1e-4:
        print("FAIL: LOX did not deplete! Increase duration or decrease mass.")
        return

    # Verify venting (Pressure should drop significantly)
    # If no venting, P would stay at residual pressure (e.g. 2 bar expanded to full tank)
    # Residual P approx: P0 * (V_ullage_0 / V_tank)^1.2
    # V_ullage_0 = 0.01 - 5/1000 = 0.005
    # V_tank = 0.01
    # P_residual_no_vent = 20e5 * (0.005/0.01)^1.2 = 20e5 * 0.5^1.2 = 20e5 * 0.435 = ~8.7 bar
    
    # P_final is actually much lower if vented
    print(f"Expected unvented P: ~8.7 bar")
    
    is_venting = lox_P[-1] < 1e5 or (lox_P[-1] < lox_P[-10]) # Should be decaying
    if is_venting:
        print("SUCCESS: LOX Pressure is decaying (venting active)")
    else:
        print("FAIL: LOX Pressure is constant (venting failed)")

    # Verify flameout masking
    # We need a mock runner for compute_timeseries_results
    # or we can just check the logic manually
    pass

if __name__ == "__main__":
    test_depletion()
