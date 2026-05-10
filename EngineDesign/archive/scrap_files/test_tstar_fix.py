#!/usr/bin/env python3
"""Test T* temperature fix"""

import yaml
from engine.core.runner import PintleEngineRunner
from engine.pipeline.config_schemas import PintleEngineConfig

# Load and parse config
with open('configs/default.yaml', 'r') as f:
    config_dict = yaml.safe_load(f)

config = PintleEngineConfig(**config_dict)

# Create runner
runner = PintleEngineRunner(config)

# Tank pressures (from original logs: ~650 psi LOX, ~750 psi Fuel)
P_tank_O = 650 * 6894.76  # psi to Pa
P_tank_F = 750 * 6894.76  # psi to Pa

# Run evaluation
result = runner.evaluate(P_tank_O, P_tank_F, debug=True)

print("\n" + "="*80)
print("VERIFICATION RESULTS")
print("="*80)
print(f"Thrust:     {result['thrust']:.2f} N")
print(f"Isp:        {result['Isp']:.2f} s")  
print(f"Pc:         {result['Pc']/1e6:.3f} MPa ({result['Pc']/6894.76:.1f} psi)")
print(f"eta_cstar:  {result['eta_cstar']:.4f} ({result['eta_cstar']*100:.1f}%)")
print("="*80)
