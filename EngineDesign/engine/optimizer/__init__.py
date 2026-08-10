"""Optimization layers for full engine design optimization.

This package contains the modular layers of the optimization pipeline:

Modules:
- helpers.py: Pressure curve generation and variable conversion
- layers/layer1_static_optimization.py: Layer 1 geometry optimization
- layers/layer2_pressure.py: Layer 2 pressure curve optimization  
- layers/layer3_thermal_protection.py: Layer 3 thermal protection sizing
- layers/layer4_flight_simulation.py: Layer 4 flight simulation
- copv_flight_helpers.py: COPV and flight simulation utilities
- utils.py: Parameter extraction and misc utilities

Usage:
    from engine.optimizer import (
        # Pressure curve helpers
        generate_segmented_pressure_curve,
        segments_from_optimizer_vars,
        optimizer_vars_from_segments,
        # Layer functions
        create_layer1_apply_x_to_config,
        run_layer2_pressure,
        run_layer3_thermal_protection,
        run_layer4_flight_simulation,
        # Utilities
        extract_all_parameters,
        calculate_copv_pressure_curve,
        run_flight_simulation,
    )
"""

# Helper functions - pressure curves
from engine.optimizer.helpers import (
    generate_segmented_pressure_curve,
    segments_from_optimizer_vars,
    optimizer_vars_from_segments,
)

# Layer 1: Static optimization
from engine.optimizer.layers.layer1_static_optimization import (
    create_layer1_apply_x_to_config,
)

# Layer 2: Pressure curve optimization
from engine.optimizer.layers.layer2_pressure import (
    run_layer2a_minimum_pressures,
    run_layer2_pressure,
)

# Layer 3: Thermal protection optimization
from engine.optimizer.layers.layer3_thermal_protection import (
    run_layer3_thermal_protection,
)

# Layer 4: Flight simulation
from engine.optimizer.layers.layer4_flight_simulation import (
    run_layer4_flight_simulation,
)

# Display functions used to be re-exported here from display_results.py. That
# import ran on any `from engine.optimizer... import`, which dragged Streamlit
# into the FastAPI backend and its container. The Streamlit UI is retired --
# see archive/streamlit-ui/.

# COPV and flight helpers
from engine.optimizer.copv_flight_helpers import (
    calculate_copv_pressure_curve,
    run_flight_simulation,
)

# Utilities
from engine.optimizer.utils import (
    extract_all_parameters,
)

# Main optimizer
from engine.optimizer.main_optimizer import (
    run_full_engine_optimization_with_flight_sim,
)

__all__ = [
    # Pressure curve helpers
    'generate_segmented_pressure_curve',
    'segments_from_optimizer_vars',
    'optimizer_vars_from_segments',
    # Layer 1
    'create_layer1_apply_x_to_config',
    # Layer 2
    'run_layer2a_minimum_pressures',
    'run_layer2_pressure',
    # Layer 3
    'run_layer3_thermal_protection',
    # Layer 4
    'run_layer4_flight_simulation',
    # COPV and flight
    'calculate_copv_pressure_curve',
    'run_flight_simulation',
    # Utilities
    'extract_all_parameters',
    # Main optimizer
    'run_full_engine_optimization_with_flight_sim',
]

