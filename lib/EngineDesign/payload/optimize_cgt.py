import numpy as np
from scipy.optimize import minimize_scalar

from payload.cold_gas_thruster import ColdGasThrusterConfig, ColdGasThruster


def objective(exit_diameter: float) -> float:
    """
    Objective function: minimize negative specific impulse (to maximize Isp/Thrust).
    We use the baseline configuration and only vary the exit_diameter.
    """
    cfg = ColdGasThrusterConfig(
        throat_diameter=0.005,    # 5 mm throat
        exit_diameter=exit_diameter,
        inlet_pressure=800_000,   # 800 kPa
        chamber_diameter=0.012,   # 12 mm
        chamber_length=0.020,     # 20 mm
        volume_chamber=np.pi / 4 * 0.012**2 * 0.020,
    )
    
    try:
        cgt = ColdGasThruster(cfg)
        result = cgt.compute()
        # Maximize specific impulse (or thrust, they are proportional here since mdot is fixed by throat & P0)
        return -result.specific_impulse
    except Exception:
        # Penalize if solver fails (e.g., non-converging expansion ratio)
        return 0.0

def main():
    print("Running super simple optimization on Cold Gas Thruster...")
    print("Baseline:")
    print("  throat_diameter = 5 mm")
    print("  inlet_pressure  = 800 kPa")
    print("Objective: Maximize Specific Impulse (Isp) by optimizing exit_diameter (expansion perfectly matched).\n")
    
    # Base throat is 0.005. Exit diameter must be > throat_diameter.
    # Set bounds from slightly above throat up to something very large.
    res = minimize_scalar(
        objective, 
        bounds=(0.00501, 0.050), 
        method='bounded'
    )
    
    if res.success:
        optimal_exit_diameter = res.x
        max_isp = -res.fun
        
        print("Optimization Successful!")
        print(f"Optimal Exit Diameter: {optimal_exit_diameter * 1000:.3f} mm")
        print(f"Maximum Isp Achieved:  {max_isp:.2f} s\n")
        
        # Evaluate and show the full summary for the optimal design
        cfg_opt = ColdGasThrusterConfig(
            throat_diameter=0.005,
            exit_diameter=optimal_exit_diameter,
            inlet_pressure=800_000,
            chamber_diameter=0.012,
            chamber_length=0.020,
            volume_chamber=np.pi / 4 * 0.012**2 * 0.020,
        )
        cgt_opt = ColdGasThruster(cfg_opt)
        result_opt = cgt_opt.compute()
        print("Optimal Configuration Summary:")
        print(result_opt.summary())
    else:
        print("Optimization failed:", res.message)

if __name__ == "__main__":
    main()
