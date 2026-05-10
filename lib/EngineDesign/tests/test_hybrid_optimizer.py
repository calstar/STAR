
import numpy as np
import sys
import os

# Add project root to path
sys.path.append(os.getcwd())

from engine.optimizer.layers.layer1_static_optimization import run_hybrid_optimization
from engine.pipeline.config_schemas import HybridOptimizerConfig

def rosenbrock(x):
    """Rosenbrock function (standard benchmark)."""
    return sum(100.0*(x[1:]-x[:-1]**2.0)**2.0 + (1-x[:-1])**2.0)

def test_hybrid():
    print("Testing Hybrid Optimizer on Rosenbrock function (dim=5)...")
    
    dim = 5
    bounds = [(-5.0, 5.0)] * dim
    x0 = np.zeros(dim)
    
    config = HybridOptimizerConfig(
        elite_k=20,
        block_method="corr_greedy", # Test correlation method
        num_blocks=2,
        cycles=2,
        per_block_budget_fraction=0.6,
        lambda0=0.1,
        refresh_every_pass=True,
        refresh_budget_fraction=0.1,
        refresh_sigma_scale=0.2
    )
    
    # Run with small budget
    best_x, best_f, evals = run_hybrid_optimization(
        rosenbrock,
        bounds,
        x0,
        config,
        total_budget=500,
        logger=None # Print to stdout
    )
    
    print(f"\nOptimization Complete:")
    print(f"Best f: {best_f:.6f}")
    print(f"Best x: {best_x}")
    print(f"Evals: {evals}")
    
    if best_f < 1.0:
        print("SUCCESS: Found reasonable solution.")
    else:
        print("WARNING: Solution might be suboptimal (expected for very low budget).")

if __name__ == "__main__":
    test_hybrid()
