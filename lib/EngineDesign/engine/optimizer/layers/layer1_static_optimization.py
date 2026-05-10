"""Layer 1: Static Optimization

This layer implements the main optimization loop that optimizes ONLY
static (time‑independent) quantities:

- Engine geometry (throat, L*, expansion ratio, pintle geometry)
- Initial tank pressures for LOX and fuel (single value per tank)

All **time‑varying** pressure behavior (segments/curves over the burn)
is handled **exclusively** in Layer 2 (`layer2_pressure.py`). Layer 1
must NOT create or manipulate pressure segments or time arrays.
"""

from __future__ import annotations

from typing import Tuple, Callable, Dict, Any, Optional
import numpy as np
import copy
import logging
import time
import os
from datetime import datetime
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor

from engine.pipeline.config_schemas import PintleEngineConfig, HybridOptimizerConfig
from engine.core.runner import PintleEngineRunner

from scipy.optimize import minimize, differential_evolution

try:
    import cma
except ImportError:  # pragma: no cover - optional dependency
    cma = None
   

# Import utility function
try:
    from engine.optimizer.utils import extract_all_parameters
except ImportError:
    # Fallback if utils doesn't exist - extract basic parameters
    def extract_all_parameters(config):
        """Extract all parameters from config."""
        params = {}
        if hasattr(config, 'chamber'):
            params['A_throat'] = getattr(config.chamber, 'A_throat', None)
            params['Lstar'] = getattr(config.chamber, 'Lstar', None)
            params['chamber_length'] = getattr(config.chamber, 'length', None)
            params['chamber_diameter'] = getattr(config.chamber, 'chamber_inner_diameter', None)
        if hasattr(config, 'nozzle'):
            params['A_exit'] = getattr(config.nozzle, 'A_exit', None)
            params['expansion_ratio'] = getattr(config.nozzle, 'expansion_ratio', None)
        if hasattr(config, 'injector') and hasattr(config.injector, 'geometry'):
            if hasattr(config.injector.geometry, 'fuel'):
                params['d_pintle_tip'] = getattr(config.injector.geometry.fuel, 'd_pintle_tip', None)
                params['h_gap'] = getattr(config.injector.geometry.fuel, 'h_gap', None)
            if hasattr(config.injector.geometry, 'lox'):
                params['n_orifices'] = getattr(config.injector.geometry.lox, 'n_orifices', None)
                params['d_orifice'] = getattr(config.injector.geometry.lox, 'd_orifice', None)
        return params

from engine.core.chamber_geometry import (
    chamber_length_calc,
    contraction_length_horizontal_calc,
)


TOTAL_WALL_THICKNESS_M = 0.0254  # 1.0 inch total wall (0.5 inch per side: outer - inner diameter)


# ============================================================================
# Worker Process Globals (for parallel CMA-ES evaluation)
# ============================================================================
# These are set by _init_worker() in each worker process and reused across evaluations
_worker_runner = None
_worker_base_config = None
_worker_bounds = None
_worker_requirements = None
_worker_constants = None
_worker_debug_strict = False



def create_layer1_apply_x_to_config(
    bounds: list,
    max_chamber_od: float,
    max_nozzle_exit: float,
) -> Callable:
    """Create the apply_x_to_config function with dependencies.
    
    Returns a function that converts optimizer variables to engine config.
    """
    
    def apply_x_to_config(
        x: np.ndarray,
        base_config: PintleEngineConfig,
    ) -> Tuple[PintleEngineConfig, float, float]:
        """Apply optimization variables to config.

        Returns:
            config: Updated engine configuration
            P_O_start_psi: Initial LOX tank pressure [psi]
            P_F_start_psi: Initial fuel tank pressure [psi]

        Note:
            Layer 1 is **static only**. It chooses *single* initial tank
            pressures which Layer 2 then uses as the starting point for
            full time‑varying pressure‑curve optimization.
        """
        config = copy.deepcopy(base_config)
        
        # Clip all values to bounds to ensure we stay within limits
        A_throat = float(np.clip(x[0], bounds[0][0], bounds[0][1]))
        Lstar = float(np.clip(x[1], bounds[1][0], bounds[1][1]))
        expansion_ratio = float(np.clip(x[2], bounds[2][0], bounds[2][1]))
        D_chamber_outer = float(np.clip(x[3], bounds[3][0], bounds[3][1]))
        d_pintle_tip = float(np.clip(x[4], bounds[4][0], bounds[4][1]))
        h_gap = float(np.clip(x[5], bounds[5][0], bounds[5][1]))
        n_orifices = int(round(np.clip(x[6], bounds[6][0], bounds[6][1])))
        d_orifice = float(np.clip(x[7], bounds[7][0], bounds[7][1]))
        
        # CRITICAL: Extract initial pressures (absolute values in psi).
        # These are the ONLY pressure‑related quantities optimized at
        # this layer; no time‑varying curves or segments are created.
        # Note: Ablative/graphite thickness handled in downstream layers (Layer 2/3).
        P_O_start_psi = float(np.clip(x[8], bounds[8][0], bounds[8][1]))
        P_F_start_psi = float(np.clip(x[9], bounds[9][0], bounds[9][1]))
        
        # Chamber geometry
        V_chamber = Lstar * A_throat
        # Convert outer diameter to inner diameter by subtracting wall thickness (0.5 inch total)
        D_chamber_inner = D_chamber_outer - TOTAL_WALL_THICKNESS_M
        if D_chamber_inner <= 0:
            # Fallback: keep at least 30% of outer diameter or 10mm
            D_chamber_inner = max(D_chamber_outer * 0.3, 0.01)
        A_chamber = np.pi * (D_chamber_inner / 2) ** 2
        R_chamber = D_chamber_inner / 2
        R_throat = np.sqrt(max(0, A_throat / np.pi))
        
        if A_throat > 0 and A_chamber > 0:
            contraction_ratio = A_chamber / A_throat
        else:
            contraction_ratio = 10.0
        theta_contraction = np.pi / 4  # 45 degrees
        # NOTE: `contraction_length_horizontal_calc()` expects the nozzle-entrance radius
        # (called `nozzle_y_first` in `engine.core.chamber_geometry.chamber_geometry_calc`).
        # Layer 1 does not generate a full nozzle contour for speed, so we approximate the
        # nozzle-entrance radius as the throat radius (good approximation for the current
        # nozzle generator where the first point is at/near the throat).
        nozzle_entrance_radius_est = R_throat

        L_cylindrical = chamber_length_calc(
            chamber_volume=V_chamber,
            area_throat=A_throat,
            contraction_ratio=contraction_ratio,
            theta=theta_contraction,
        )
        L_contraction = contraction_length_horizontal_calc(
            area_chamber=A_chamber,
            entrance_arc_start_y=nozzle_entrance_radius_est,
            theta=theta_contraction,
        )
        L_chamber = L_cylindrical + L_contraction
        
        if L_chamber <= 0 or L_cylindrical <= 0 or not np.isfinite(L_chamber):
            L_chamber = V_chamber / A_chamber if A_chamber > 0 else 0.2
            L_cylindrical = max(L_chamber * 0.5, 0.05)
        
        L_chamber = np.clip(L_chamber, 0.005, 1.0)
        
        # Ensure chamber_geometry exists
        from engine.pipeline.config_schemas import ensure_chamber_geometry
        if config.chamber_geometry is None:
            cg = ensure_chamber_geometry(config)
        else:
            cg = config.chamber_geometry
        
        # Nozzle calculations
        A_exit = A_throat * expansion_ratio
        if A_exit < 0:
            A_exit = A_throat * 10.0
        D_exit = np.sqrt(max(0, 4 * A_exit / np.pi))
        if D_exit > max_nozzle_exit:
            D_exit = max_nozzle_exit
            A_exit = np.pi * (D_exit / 2) ** 2
            if A_throat > 0:
                expansion_ratio = A_exit / A_throat
            else:
                expansion_ratio = 10.0
        
        # Update chamber_geometry
        cg.A_throat = A_throat
        cg.volume = V_chamber
        cg.Lstar = Lstar
        cg.length = L_chamber
        cg.chamber_diameter = D_chamber_inner
        cg.A_exit = A_exit
        cg.exit_diameter = D_exit
        cg.expansion_ratio = expansion_ratio
        
        # Also update legacy sections if they exist (for backward compatibility)
        if config.chamber is not None:
            config.chamber.A_throat = A_throat
            config.chamber.volume = V_chamber
            config.chamber.Lstar = Lstar
            config.chamber.length = L_chamber
            setattr(config.chamber, 'chamber_inner_diameter', D_chamber_inner)
            if hasattr(config.chamber, 'contraction_ratio'):
                config.chamber.contraction_ratio = contraction_ratio
            if hasattr(config.chamber, 'A_chamber'):
                config.chamber.A_chamber = A_chamber
        if config.nozzle is not None:
            config.nozzle.A_throat = A_throat
            config.nozzle.A_exit = A_exit
            config.nozzle.expansion_ratio = expansion_ratio
            if hasattr(config.nozzle, 'exit_diameter'):
                config.nozzle.exit_diameter = D_exit
        
        if hasattr(config.combustion, 'cea'):
            config.combustion.cea.expansion_ratio = expansion_ratio
        
        # Injector - Primary values
        if hasattr(config.injector, 'geometry'):
            if hasattr(config.injector.geometry, 'fuel'):
                config.injector.geometry.fuel.d_pintle_tip = d_pintle_tip
                config.injector.geometry.fuel.h_gap = h_gap
                # Derived fuel values
                config.injector.geometry.fuel.d_reservoir_inner = d_pintle_tip + 2 * h_gap
                config.injector.geometry.fuel.d_hydraulic = 2 * h_gap  # Annular gap hydraulic diameter
                config.injector.geometry.fuel.A_entry = np.pi * (d_pintle_tip / 2) ** 2  # Placeholder (unused)
            if hasattr(config.injector.geometry, 'lox'):
                config.injector.geometry.lox.n_orifices = n_orifices
                config.injector.geometry.lox.d_orifice = d_orifice
                config.injector.geometry.lox.theta_orifice = 90.0
                # Derived LOX values
                config.injector.geometry.lox.d_hydraulic = d_orifice  # Single orifice diameter
                config.injector.geometry.lox.A_entry = np.pi * (d_orifice / 2) ** 2  # Placeholder (unused)
        
        # Thermal protection
        #
        # IMPORTANT: Layer 1 no longer optimizes or modifies ablative/graphite
        # thickness. Those are handled exclusively in downstream layers
        # (Layer 2/3). We leave any existing values on `base_config` untouched
        # so that YAML export can still reflect sensible defaults, but we do
        # not change them here.
        
        # Layer 1 returns the static initial tank pressures; any time‑varying
        # curves are the responsibility of Layer 2.
        return config, P_O_start_psi, P_F_start_psi
    
    return apply_x_to_config


# ============================================================================
# Helper Functions for Parallel CMA-ES Evaluation
# ============================================================================

def _config_to_dict(config: PintleEngineConfig) -> dict:
    """Convert config to lightweight dict for pickling.
    
    Uses pydantic's dict() method if available, otherwise falls back to __dict__.
    """
    return config.dict() if hasattr(config, 'dict') else config.__dict__


def _dict_to_config(config_dict: dict) -> PintleEngineConfig:
    """Reconstruct config from dict."""
    return PintleEngineConfig(**config_dict)


def _snap_integer_dims(x: np.ndarray, integer_indices: list) -> np.ndarray:
    """Snap integer dimensions to nearest integer.
    
    Ensures cache consistency and physical validity for discrete variables.
    
    Args:
        x: Candidate vector
        integer_indices: List of indices to snap (e.g., [6] for n_orifices)
    
    Returns:
        Snapped vector with integer dimensions rounded
    """
    x_snapped = x.copy()
    for idx in integer_indices:
        x_snapped[idx] = round(x_snapped[idx])
    return x_snapped


def _get_num_workers(config_obj) -> int:
    """Get number of workers from config or default to cpu_count - 1."""
    if hasattr(config_obj, 'optimizer') and hasattr(config_obj.optimizer, 'num_workers'):
        num_workers = config_obj.optimizer.num_workers
    else:
        # Default to cpu_count - 1 (leave one core free)
        num_workers = max(1, os.cpu_count() - 1)
    
    return num_workers


def _init_worker(config_dict: dict, bounds_array: np.ndarray, requirements_dict: dict, 
                 constants_dict: dict, debug_strict: bool = False):
    """Initialize worker process with lightweight data.
    
    Builds PintleEngineRunner ONCE per worker for major speedup.
    Runner is reused by mutating its config in-place (runner.evaluate is stateless).
    
    Args:
        config_dict: Serialized config (primitives only)
        bounds_array: Bounds array [n_dims x 2]
        requirements_dict: Requirements dict
        constants_dict: Constants needed for geometry calculations
        debug_strict: If True, re-raise exceptions; if False, return penalties
    """
    global _worker_runner, _worker_base_config, _worker_bounds, _worker_requirements, _worker_constants, _worker_debug_strict
    
    # Reconstruct config from dict
    _worker_base_config = _dict_to_config(config_dict)
    
    # Build runner ONCE per worker (major speedup)
    # Note: PintleEngineRunner.evaluate() is stateless between calls
    _worker_runner = PintleEngineRunner(_worker_base_config)
    
    # Store bounds and requirements
    _worker_bounds = np.array(bounds_array, dtype=np.float64)
    _worker_requirements = requirements_dict
    _worker_constants = constants_dict
    _worker_debug_strict = debug_strict


def _apply_x_to_worker_config_inplace(x: np.ndarray, config: PintleEngineConfig, constants: dict):
    """Apply x to config IN-PLACE (mutates config, no copy).
    
    Assumes x is already bounded and snapped (CMA-ES + parent handle this).
    This allows runner reuse without rebuilding.
    
    Args:
        x: Candidate vector (already bounded and snapped)
        config: Config to mutate in place
        constants: Constants dict with TOTAL_WALL_THICKNESS_M, etc.
    """
    from engine.pipeline.config_schemas import ensure_chamber_geometry
    
    # Extract values (NO CLIPPING - CMA-ES handles bounds)
    A_throat = float(x[0])
    Lstar = float(x[1])
    expansion_ratio = float(x[2])
    D_chamber_outer = float(x[3])
    d_pintle_tip = float(x[4])
    h_gap = float(x[5])
    n_orifices = int(x[6])  # Already snapped in parent
    d_orifice = float(x[7])
    
    # Compute derived values (same logic as apply_x_to_config)
    V_chamber = Lstar * A_throat
    D_chamber_inner = D_chamber_outer - constants['TOTAL_WALL_THICKNESS_M']
    if D_chamber_inner <= 0:
        D_chamber_inner = max(D_chamber_outer * 0.3, 0.01)
    
    A_chamber = np.pi * (D_chamber_inner / 2) ** 2
    R_chamber = D_chamber_inner / 2
    R_throat = np.sqrt(max(0, A_throat / np.pi))
    
    contraction_ratio = A_chamber / A_throat if (A_throat > 0 and A_chamber > 0) else 10.0
    theta_contraction = np.pi / 4  # 45 degrees
    nozzle_entrance_radius_est = R_throat
    
    L_cylindrical = chamber_length_calc(
        chamber_volume=V_chamber,
        area_throat=A_throat,
        contraction_ratio=contraction_ratio,
        theta=theta_contraction,
    )
    L_contraction = contraction_length_horizontal_calc(
        area_chamber=A_chamber,
        entrance_arc_start_y=nozzle_entrance_radius_est,
        theta=theta_contraction,
    )
    L_chamber = L_cylindrical + L_contraction
    
    if L_chamber <= 0 or L_cylindrical <= 0 or not np.isfinite(L_chamber):
        L_chamber = V_chamber / A_chamber if A_chamber > 0 else 0.2
        L_cylindrical = max(L_chamber * 0.5, 0.05)
    
    L_chamber = np.clip(L_chamber, 0.005, 1.0)
    
    # Nozzle calculations
    A_exit = A_throat * expansion_ratio
    if A_exit < 0:
        A_exit = A_throat * 10.0
    D_exit = np.sqrt(max(0, 4 * A_exit / np.pi))
    
    max_nozzle_exit = constants.get('max_nozzle_exit', 1.0)
    if D_exit > max_nozzle_exit:
        D_exit = max_nozzle_exit
        A_exit = np.pi * (D_exit / 2) ** 2
        expansion_ratio = A_exit / A_throat if A_throat > 0 else 10.0
    
    # Ensure chamber_geometry exists
    if config.chamber_geometry is None:
        cg = ensure_chamber_geometry(config)
    else:
        cg = config.chamber_geometry
    
    # Mutate config.chamber_geometry in place
    cg.A_throat = A_throat
    cg.volume = V_chamber
    cg.Lstar = Lstar
    cg.length = L_chamber
    cg.chamber_diameter = D_chamber_inner
    cg.A_exit = A_exit
    cg.exit_diameter = D_exit
    cg.expansion_ratio = expansion_ratio
    
    # Also update legacy sections if they exist
    if config.chamber is not None:
        config.chamber.A_throat = A_throat
        config.chamber.volume = V_chamber
        config.chamber.Lstar = Lstar
        config.chamber.length = L_chamber
        setattr(config.chamber, 'chamber_inner_diameter', D_chamber_inner)
        if hasattr(config.chamber, 'contraction_ratio'):
            config.chamber.contraction_ratio = contraction_ratio
        if hasattr(config.chamber, 'A_chamber'):
            config.chamber.A_chamber = A_chamber
    
    if config.nozzle is not None:
        config.nozzle.A_exit = A_exit
        config.nozzle.exit_diameter = D_exit
        config.nozzle.expansion_ratio = expansion_ratio
    
    # Update injector geometry
    if hasattr(config, 'injector') and config.injector.type == "pintle":
        if hasattr(config.injector.geometry, 'fuel'):
            config.injector.geometry.fuel.d_pintle_tip = d_pintle_tip
            config.injector.geometry.fuel.h_gap = h_gap
            # Derived fuel values
            config.injector.geometry.fuel.d_reservoir_inner = d_pintle_tip + 2 * h_gap
            config.injector.geometry.fuel.d_hydraulic = 2 * h_gap  # Annular gap hydraulic diameter
            config.injector.geometry.fuel.A_entry = np.pi * (d_pintle_tip / 2) ** 2  # Placeholder (unused)
        if hasattr(config.injector.geometry, 'lox'):
            config.injector.geometry.lox.n_orifices = n_orifices
            config.injector.geometry.lox.d_orifice = d_orifice
            config.injector.geometry.lox.theta_orifice = 90.0
            # Derived LOX values
            config.injector.geometry.lox.d_hydraulic = d_orifice  # Single orifice diameter
            config.injector.geometry.lox.A_entry = np.pi * (d_orifice / 2) ** 2  # Placeholder (unused)


def _compute_objective_value(result: dict, x: np.ndarray, requirements: dict, constants: dict) -> float:
    """Compute objective value from evaluation result.
    
    Pure function: no state mutation.
    Extracted from main objective() to ensure same logic in workers.
    
    This implements the full lexicographic objective with:
    - Geometric validation
    - Injector validation
    - Stability checks
    - Lexicographic scalarization
    
    Args:
        result: Evaluation result dict from runner.evaluate()
        x: Candidate vector (already snapped and bounded)
        requirements: Requirements dict
        constants: Constants dict
    
    Returns:
        Objective value (float)
    """
    from engine.pipeline.config_schemas import ensure_chamber_geometry
    
    # Extract constants
    target_thrust = constants.get('target_thrust', 1000)
    optimal_of = constants.get('optimal_of', 2.5)
    target_P_exit = constants.get('P_ambient', 101325.0)  # Ambient pressure
    max_lox_P_psi = constants.get('max_lox_P_psi', 500)
    max_fuel_P_psi = constants.get('max_fuel_P_psi', 500)
    TOTAL_WALL_THICKNESS_M = constants.get('TOTAL_WALL_THICKNESS_M', 0.0254)
    min_stability = requirements.get('min_stability_margin', 0.15)
    psi_to_Pa = 6894.76
    
    # Reconstruct config from x (we need geometry info)
    # Extract values from x
    A_throat = float(x[0])
    Lstar = float(x[1])
    expansion_ratio = float(x[2])
    D_chamber_outer = float(x[3])
    d_pintle_tip = float(x[4])
    h_gap = float(x[5])
    n_orifices = int(x[6])
    d_orifice = float(x[7])
    
    # Compute derived geometry
    V_chamber = Lstar * A_throat
    D_chamber_inner = D_chamber_outer - TOTAL_WALL_THICKNESS_M
    if D_chamber_inner <= 0:
        D_chamber_inner = max(D_chamber_outer * 0.3, 0.01)
    
    A_chamber_check = np.pi * (D_chamber_inner / 2) ** 2
    A_throat_check = A_throat
    
    # Nozzle
    A_exit = A_throat * expansion_ratio
    D_exit_check = np.sqrt(max(0, 4 * A_exit / np.pi))
    D_throat_check = np.sqrt(4.0 * A_throat_check / np.pi) if A_throat_check > 0 else 0.0
    
    # Injector areas
    A_lox_injector = float(n_orifices * np.pi * (d_orifice / 2) ** 2)
    R_inner = float(d_pintle_tip / 2)
    R_outer = float(R_inner + h_gap)
    A_fuel_injector = float(np.pi * (R_outer ** 2 - R_inner ** 2))
    
    lox_ratio = A_lox_injector / A_throat_check if A_throat_check > 0 else np.nan
    fuel_ratio = A_fuel_injector / A_throat_check if A_throat_check > 0 else np.nan
    
    # Tank pressures
    P_O_psi = float(x[8])
    P_F_psi = float(x[9])
    P_O_ratio = P_O_psi / max_lox_P_psi if max_lox_P_psi > 0 else 0.0
    P_F_ratio = P_F_psi / max_fuel_P_psi if max_fuel_P_psi > 0 else 0.0
    
    # --- Geometric Validation ---
    infeasibility_score = 0.0
    
    # 1. Contraction ratio check
    if A_chamber_check > 0 and A_throat_check > 0:
        contraction_ratio_check = A_chamber_check / A_throat_check
        infeasibility_score += max(0.0, (A_throat_check * 1.1) / A_chamber_check - 1.0) ** 2
        
        if contraction_ratio_check < 1.5:
            infeasibility_score += (1.5 - contraction_ratio_check) ** 2
        elif contraction_ratio_check > 15.0:
            infeasibility_score += (contraction_ratio_check - 15.0) ** 2
    
    # 2. Pintle diameter vs chamber diameter
    if D_chamber_inner > 0:
        infeasibility_score += max(0.0, (d_pintle_tip * 1.1) / D_chamber_inner - 1.0) ** 2
    
    # 2a. Throat diameter vs chamber diameter
    if D_throat_check > 0 and D_chamber_inner > 0:
        infeasibility_score += max(0.0, D_throat_check - D_chamber_inner * 0.95) ** 2 * 10.0
    
    # 3. Nozzle exit vs throat
    if D_exit_check > 0 and D_throat_check > 0:
        infeasibility_score += max(0.0, D_throat_check / D_exit_check - 1.0) ** 2
    
    # 4. Injector area constraints
    if A_throat_check > 0:
        infeasibility_score += max(0.0, lox_ratio - 1.0) ** 2
        infeasibility_score += max(0.0, fuel_ratio - 1.0) ** 2
        
        # O/F area ratio sanity
        if A_fuel_injector > 0:
            area_ratio = A_lox_injector / A_fuel_injector
            Cd_ratio = 0.4 / 0.65
            rho_ratio = np.sqrt(1140.0 / 780.0)
            delta_p_ratio_est = np.sqrt(1.2)
            area_ratio_factor = Cd_ratio * rho_ratio * delta_p_ratio_est
            required_area_ratio = optimal_of / area_ratio_factor if area_ratio_factor > 0 else np.inf
            if required_area_ratio > 0 and np.isfinite(required_area_ratio):
                area_ratio_error = abs(area_ratio - required_area_ratio) / required_area_ratio
                infeasibility_score += max(0.0, area_ratio_error - 0.5) ** 2
    
    # --- Evaluation Results ---
    eval_success = result.get('success', False) if isinstance(result, dict) else False
    
    if not eval_success:
        # Evaluation failed - return high penalty
        infeasibility_score += 1.0
        # Add directional guidance based on pressure ratios
        infeasibility_score += max(0.0, 0.90 - P_O_ratio) ** 2 + max(0.0, 0.90 - P_F_ratio) ** 2
        
        # SCALED DOWN: Max penalty ~1e7
        BASE_INFEAS = 1e6
        W_INFEAS = 1e5
        return BASE_INFEAS + W_INFEAS * float(infeasibility_score)
    
    # Extract performance metrics
    F_actual = float(result.get('F', np.nan))
    MR_actual = float(result.get('MR', np.nan))
    Cf_actual = float(result.get('Cf_actual', result.get('Cf', np.nan)))
    P_exit_actual = float(result.get('P_exit', np.nan))
    stability = result.get('stability_results', {})
    
    # Primary errors
    thrust_error = abs(F_actual - target_thrust) / target_thrust if (target_thrust > 0 and np.isfinite(F_actual)) else 1.0
    of_error = abs(MR_actual - optimal_of) / optimal_of if (optimal_of > 0 and np.isfinite(MR_actual)) else 1.0
    
    # Thrust penalty with 2% deadband (no penalty if within 2% error)
    thrust_penalty_sq_term = 0.0
    if target_thrust > 0 and np.isfinite(F_actual):
        rel_error = abs(F_actual - target_thrust) / target_thrust
        deadband = 0.02  # 2% tolerance
        
        # Soft deadband: Always apply a tiny gradient so the optimizer isn't "blind" 
        # inside the deadband. This encourages exact matching even if < 2% error.
        thrust_penalty_sq_term += (0.1 * rel_error) ** 2

        if rel_error > deadband:
            # Strong penalty for exceeding deadband
            excess = rel_error - deadband
            thrust_penalty_sq_term += excess ** 2
    else:
        # Failed evaluation gets full penalty
        thrust_penalty_sq_term = 1.0
    
    # Exit pressure penalty (asymmetric with deadband)
    exit_pressure_sq_term = 0.0
    if target_P_exit > 0 and np.isfinite(P_exit_actual):
        rel = (P_exit_actual - target_P_exit) / target_P_exit
        deadband = 0.05  # 5%
        if rel < -deadband:
            # Overexpanded beyond deadband (worse)
            excess = rel + deadband
            exit_pressure_sq_term = (5.0 * excess) ** 2
        elif rel > deadband:
            # Underexpanded beyond deadband (less bad)
            excess = rel - deadband
            exit_pressure_sq_term = (1.0 * excess) ** 2
    
    # Stability checks
    stability_state = stability.get('stability_state', 'unstable')
    stability_score = float(stability.get('stability_score', 0.0))
    chugging_margin = max(0.0, float(stability.get('chugging', {}).get('stability_margin', 0.0)))
    acoustic_margin = max(0.0, float(stability.get('acoustic', {}).get('stability_margin', 0.0)))
    feed_margin = max(0.0, float(stability.get('feed_system', {}).get('stability_margin', 0.0)))
    
    min_stability_score_raw = float(requirements.get('min_stability_score', 0.75))
    stability_margin_handicap = float(requirements.get('stability_margin_handicap', 0.0))
    score_factor = max(0.0, 1.0 - stability_margin_handicap)
    margin_factor = max(0.0, 1.0 - stability_margin_handicap)
    effective_min_score = min_stability_score_raw * score_factor
    effective_margin = float(min_stability) * margin_factor
    
    require_stable_state = bool(requirements.get('require_stable_state', True))
    allowed_states = {'stable', 'marginal'}
    state_ok = (stability_state in allowed_states) if require_stable_state else (stability_state != 'unstable')
    
    if not state_ok:
        infeasibility_score += 1.0
    if effective_min_score > 0:
        infeasibility_score += max(0.0, (effective_min_score - stability_score) / effective_min_score) ** 2
    if effective_margin > 0:
        infeasibility_score += max(0.0, (effective_margin - chugging_margin) / effective_margin) ** 2
        infeasibility_score += max(0.0, (effective_margin - acoustic_margin) / effective_margin) ** 2
        infeasibility_score += max(0.0, (effective_margin - feed_margin) / effective_margin) ** 2
    
    # Regularization: Cf band
    def _hinge_band(val, lo, hi, scale=1.0):
        if val < lo:
            return ((lo - val) / scale) ** 2
        elif val > hi:
            return ((val - hi) / scale) ** 2
        return 0.0
    
    Cf_min_acceptable = 1.3
    Cf_max_acceptable = 1.8
    cf_hinge = _hinge_band(float(Cf_actual) if np.isfinite(Cf_actual) else 0.0,
                           Cf_min_acceptable, Cf_max_acceptable,
                           scale=(Cf_max_acceptable - Cf_min_acceptable))
    
    # Chamber length penalty
    # Compute L_chamber from geometry (same as in apply_x_to_config)
    from engine.core.chamber_geometry import chamber_length_calc, contraction_length_horizontal_calc
    R_chamber = D_chamber_inner / 2
    R_throat = np.sqrt(max(0, A_throat / np.pi))
    contraction_ratio = A_chamber_check / A_throat_check if A_throat_check > 0 else 10.0
    theta_contraction = np.pi / 4  # 45 degrees
    L_cylindrical = chamber_length_calc(
        chamber_volume=V_chamber,
        area_throat=A_throat,
        contraction_ratio=contraction_ratio,
        theta=theta_contraction,
    )
    L_contraction = contraction_length_horizontal_calc(
        area_chamber=A_chamber_check,
        entrance_arc_start_y=R_throat,  # nozzle entrance radius estimate
        theta=theta_contraction,
    )
    L_chamber_curr = L_cylindrical + L_contraction
    if L_chamber_curr <= 0 or not np.isfinite(L_chamber_curr):
        L_chamber_curr = V_chamber / A_chamber_check if A_chamber_check > 0 else 0.2
    
    max_chamber_length = float(requirements.get("max_chamber_length_m", 0.50))
    length_term = 0.0
    length_violation = False
    if np.isfinite(L_chamber_curr) and max_chamber_length > 0:
        if L_chamber_curr > max_chamber_length:
            # Hard constraint: treat as infeasibility
            length_violation = True
            length_term = ((L_chamber_curr - max_chamber_length) / max_chamber_length) ** 2
        else:
            # Soft penalty to guide optimizer away from the boundary
            length_term = max(0.0, (L_chamber_curr - max_chamber_length * 0.9) / (max_chamber_length * 0.1)) ** 2
    
    # Lexicographic scalarization
    # Lexicographic scalarization (SCALED DOWN)
    BASE_INFEAS = 1e6
    W_INFEAS = 1e5
    W_THRUST = 1e4
    W_OF = 1e4
    W_CF = 1e2
    W_EXIT = 2.0e2
    W_LEN = 1e4  # Chamber length constraint (same weight as thrust/O/F)
    
    if not np.isfinite(infeasibility_score) or infeasibility_score < 0:
        infeasibility_score = 1.0
    
    # Treat length violation as infeasibility (hard constraint)
    if length_violation:
        obj = BASE_INFEAS + W_INFEAS * length_term
    elif infeasibility_score > 0.0:
        obj = BASE_INFEAS + W_INFEAS * float(infeasibility_score)
    else:
        obj = (
            W_THRUST * thrust_penalty_sq_term +
            W_OF * (of_error ** 2) +
            W_CF * cf_hinge +
            W_EXIT * exit_pressure_sq_term +
            W_LEN * length_term
        )
    
    if not np.isfinite(obj):
        obj = BASE_INFEAS
    
    return float(obj)



def _eval_candidate(x_raw):
    """Pure evaluation function for parallel execution.
    
    Reuses worker's PintleEngineRunner by mutating its config in-place.
    Assumes x_raw is already snapped (integers) and within bounds (CMA-ES handles this).
    Returns lightweight scalar diagnostics only.
    
    Args:
        x_raw: Candidate vector (already snapped and bounded)
    
    Returns:
        dict with 'value', 'success', and optional diagnostics
    """
    try:
        # x_raw is already snapped and bounded - just convert to array
        x = np.asarray(x_raw, dtype=np.float64)
        
        # Apply x to runner's config IN-PLACE (no clipping, CMA-ES handles bounds)
        _apply_x_to_worker_config_inplace(x, _worker_runner.config, _worker_constants)
        
        # Extract pressures from x
        P_O_psi = float(x[8])
        P_F_psi = float(x[9])
        P_O_Pa = P_O_psi * 6894.76
        P_F_Pa = P_F_psi * 6894.76
        
        # Evaluate using worker's runner (reused across calls)
        result = _worker_runner.evaluate(
            P_O_Pa, P_F_Pa,
            P_ambient=_worker_constants['P_ambient'],
            debug=False,
            silent=True
        )
        
        # Compute objective value (pure function)
        obj_value = _compute_objective_value(result, x, _worker_requirements, _worker_constants)
        
        # Return top-level scalars (cheaper than nested dicts)
        return {
            'value': float(obj_value),
            'success': True,
            'F': float(result.get('F', 0)),
            'MR': float(result.get('MR', 0)),
            'Pc': float(result.get('Pc', 0)),
        }
    except Exception as e:
        if _worker_debug_strict:
            # Strict mode: re-raise to crash fast (for debugging)
            raise
        else:
            # Robust mode: return structured penalty
            # Classify error to give more useful feedback to optimizer/logger
            err_type = type(e).__name__
            err_msg = str(e).lower()
            
            # Base penalty for failed evaluation (much lower than 1e10 to avoid destroying covariance)
            # Feasible solutions are ~2e4 - 5e4
            penalty_base = 1.0e7
            
            # Categorize failure
            if "geometry" in err_msg or "bound" in err_msg:
                # Geometry/Bound violation (Critical but maybe structural)
                penalty_val = penalty_base * 1.0
                fail_reason = "GeometryViolation"
            elif "negative" in err_msg or "pressure" in err_msg or "choked" in err_msg:
                # Physics failure (Negative area, pressure, unchoked, etc.)
                penalty_val = penalty_base * 0.5  # Slightly "better" failure than total nonsense
                fail_reason = "PhysicsViolation"
            elif "solver" in err_msg or "convergence" in err_msg:
                # Numerical solver failure
                penalty_val = penalty_base * 0.2  # Least bad failure, might just be stiff region
                fail_reason = "SolverConvergence"
            else:
                # Unknown/Generic
                penalty_val = penalty_base * 0.8
                fail_reason = f"Error_{err_type}"

            return {
                'value': float(penalty_val),
                'success': False,
                'error_type': fail_reason,
                'error_msg': str(e)[:200],
            }



def run_layer1_global_search(
    objective: Callable[[np.ndarray], float],
    bounds: list,
    x0: np.ndarray,
    max_evals: int = 150,
    random_seed: int = 42,
) -> np.ndarray:
    """
    Lightweight global search for Layer 1 using random sampling + short DE.

    This is intended to very quickly improve the starting point before the
    main local optimizer (L-BFGS-B) runs in the orchestrator.

    - Keeps evaluation budget small (max_evals) to avoid long runtimes.
    - Always respects the provided bounds.
    - Falls back gracefully if scipy's differential_evolution is unavailable.
    """
    try:
        from scipy.optimize import differential_evolution
    except Exception:
        differential_evolution = None

    if max_evals <= 0 or objective is None:
        return x0

    rng = np.random.default_rng(random_seed)

    bounds_arr = np.asarray(bounds, dtype=float)
    lower = bounds_arr[:, 0]
    upper = bounds_arr[:, 1]

    # Ensure starting point is within bounds
    best_x = np.clip(np.asarray(x0, dtype=float), lower, upper)
    try:
        best_f = float(objective(best_x))
    except Exception:
        # If evaluation fails, just return the original guess
        return x0

    evals_used = 1
    dim = best_x.size

    # ------------------------------------------------------------------
    # Phase 1: Random sampling within bounds (very small number of points)
    # ------------------------------------------------------------------
    n_random = max(5, min(20, max_evals // 3))
    for _ in range(n_random):
        if evals_used >= max_evals:
            break
        candidate = lower + rng.random(dim) * (upper - lower)
        try:
            f_val = float(objective(candidate))
        except Exception:
            evals_used += 1
            continue
        evals_used += 1
        if np.isfinite(f_val) and f_val < best_f:
            best_f = f_val
            best_x = candidate

    # ------------------------------------------------------------------
    # Phase 2: Very short Differential Evolution (if available)
    # ------------------------------------------------------------------
    if differential_evolution is not None and evals_used < max_evals:
        # Rough heuristic to keep DE cheap; cap iterations and population.
        # For typical Layer 1 dimensionality (~20 vars) this keeps runtime modest.
        remaining_evals = max_evals - evals_used
        popsize = 8
        # Each DE iter uses approximately popsize * dim evaluations
        approx_evals_per_iter = max(1, popsize * dim)
        maxiter = max(1, min(5, remaining_evals // approx_evals_per_iter))

        if maxiter > 0:
            # Wrap objective to track best solution without exceeding budget
            def wrapped_obj(v: np.ndarray) -> float:
                nonlocal best_x, best_f, evals_used
                if evals_used >= max_evals:
                    # Return current best to encourage convergence without new work
                    return best_f
                try:
                    f_val_inner = float(objective(v))
                except Exception:
                    evals_used += 1
                    return 1e7
                evals_used += 1
                if np.isfinite(f_val_inner) and f_val_inner < best_f:
                    best_f = f_val_inner
                    best_x = np.asarray(v, dtype=float)
                return f_val_inner

            try:
                _ = differential_evolution(
                    wrapped_obj,
                    bounds=bounds,
                    maxiter=maxiter,
                    popsize=popsize,
                    tol=0.01,
                    polish=False,
                    updating="deferred",
                    mutation=(0.5, 1.0),
                    recombination=0.7,
                    seed=random_seed,
                )
            except Exception:
                # If DE fails for any reason, just keep the best point found so far.
                pass

    return best_x


def run_layer1_optimization(
    config_obj: PintleEngineConfig,
    runner: PintleEngineRunner,
    requirements: Dict[str, Any],
    target_burn_time: float,
    tolerances: Dict[str, float],
    pressure_config: Dict[str, Any],
    update_progress: Optional[Callable[[str, float, str], None]] = None,
    log_status: Optional[Callable[[str, str], None]] = None,
    objective_callback: Optional[Callable[[int, float, float], None]] = None,
    stop_event: Optional[Any] = None,  # threading.Event for stop signal
) -> Tuple[PintleEngineConfig, Dict[str, Any]]:
    """
    Run complete Layer 1 optimization: geometry + initial tank pressures.
    
    This function contains ALL Layer 1 optimization logic:
    - Setup (bounds, initial guess)
    - Objective function definition
    - Optimization loop (CMA-ES with random restarts + L-BFGS-B)
    - Validation
    - Results packaging
    
    Note:
        max_iterations is HARDCODED to 150 for robust convergence.
        Random restarts (1-2) are used to escape local minima.
    
    Args:
        config_obj: Base engine configuration
        runner: Engine runner (for validation)
        requirements: Design requirements dict
        target_burn_time: Target burn time [s]
        tolerances: Tolerance dict (thrust, apogee)
        pressure_config: Pressure configuration dict
        update_progress: Optional progress callback (stage, progress, message)
        log_status: Optional status logging callback (stage, message)
        objective_callback: Optional callback for objective history (iteration, objective, best_objective)
    
    Returns:
        optimized_config: Optimized engine configuration
        results: Results dict with performance, validation, history, etc.
    """
 
    # Set up Layer 1 logging
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    # Ensure output/logs directory exists
    output_logs_dir = Path(__file__).resolve().parents[3] / "output" / "logs"
    output_logs_dir.mkdir(parents=True, exist_ok=True)
    log_file_path = output_logs_dir / f"layer1_static_{timestamp}.log"
    
    # Create logger for Layer 1
    layer1_logger = logging.getLogger('layer1_static')
    layer1_logger.setLevel(logging.INFO)
    
    # Remove existing handlers to avoid duplicates
    layer1_logger.handlers.clear()
    
    # File handler
    file_handler = logging.FileHandler(log_file_path, mode='w', encoding='utf-8')
    file_handler.setLevel(logging.INFO)
    file_formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
    file_handler.setFormatter(file_formatter)
    layer1_logger.addHandler(file_handler)
    
    # Prevent propagation to root logger
    layer1_logger.propagate = False
    
    layer1_logger.info("="*70)
    layer1_logger.info("Layer 1: Static Optimization")
    layer1_logger.info("="*70)
    layer1_logger.info(f"Log file: {log_file_path}")
    
    # Default callbacks
    if update_progress is None:
        def update_progress(stage: str, progress: float, message: str):
            pass
    if log_status is None:
        def log_status(stage: str, message: str):
            pass
    
    # Helper to check stop event
    class OptimizationStopped(Exception):
        """Exception raised when optimization is stopped by user."""
        pass
    
    def check_stop():
        """Check if optimization should stop and raise exception if so."""
        if stop_event is not None and stop_event.is_set():
            raise OptimizationStopped("Optimization stopped by user")
    
    # Extract requirements
    target_thrust = requirements.get("target_thrust", 7000.0)
    optimal_of = requirements.get("optimal_of_ratio", 2.3)
    min_stability = requirements.get("min_stability_margin", 1.2)
    min_Lstar = requirements.get("min_Lstar", 0.95)
    max_Lstar = requirements.get("max_Lstar", 1.27)
    max_chamber_od = requirements.get("max_chamber_outer_diameter", 0.15)
    max_nozzle_exit = requirements.get("max_nozzle_exit_diameter", 0.101)
    thrust_tol = tolerances.get("thrust", 0.10)
    
    # Calculate target exit pressure from environment config (GPS/GFS-derived atmospheric pressure)
    # Use standard atmosphere model based on elevation if environment config is available
    target_P_exit = 101325.0  # Default: sea level (1 atm)
    if hasattr(config_obj, 'environment') and config_obj.environment is not None:
        elevation = getattr(config_obj.environment, 'elevation', 0.0)
        if elevation is not None and elevation >= 0:
            # Standard atmosphere model: P = P0 * exp(-M*g*h/(R*T0))
            # P0 = 101325 Pa (sea level)
            # M = 0.0289644 kg/mol (molar mass of dry air)
            # g = 9.80665 m/s² (standard gravity)
            # R = 8.31447 J/(mol·K) (universal gas constant)
            # T0 = 288.15 K (sea level temperature)
            P0 = 101325.0  # Pa
            M = 0.0289644  # kg/mol
            g = 9.80665    # m/s²
            R = 8.31447    # J/(mol·K)
            T0 = 288.15    # K
            target_P_exit = P0 * np.exp(-M * g * elevation / (R * T0))
            layer1_logger.info(f"Using atmospheric pressure from elevation: {elevation:.1f} m -> {target_P_exit:.1f} Pa ({target_P_exit/101325.0:.3f} atm)")
    else:
        layer1_logger.info(f"Environment config not available, using default sea level pressure: {target_P_exit:.1f} Pa")
    
    layer1_logger.info(f"Target thrust: {target_thrust:.1f} N")
    layer1_logger.info(f"Target O/F ratio: {optimal_of:.2f}")
    layer1_logger.info(f"Min stability margin: {min_stability:.2f}")
    layer1_logger.info(f"Target burn time: {target_burn_time:.2f} s")
    
    # HARDCODED: max_iterations for robust convergence
    # Tuned for 10D problem with complex constraints
    # With popsize=20-24: ~3000-3600 function evaluations (150 iters * 20-24 pop)
    # With 1-2 restarts: Sufficient for consistent global convergence
    max_iterations = 150
    
    layer1_logger.info(f"Max iterations: {max_iterations}")
    layer1_logger.info("")
    
    # Get max pressures
    max_lox_P_psi = pressure_config.get("max_lox_pressure_psi", 700)
    max_fuel_P_psi = pressure_config.get("max_fuel_pressure_psi", 850)
    psi_to_Pa = 6894.76
    
    # Objective tolerance for early stopping
    obj_tolerance = 2.0  # For good solution: obj ≈ 1.25, so 2.0 is reasonable
    
    update_progress("Layer 1: Setup", 0.01, "Initializing Layer 1 optimization...")
    
    # Prepare base config
    config_base = copy.deepcopy(config_obj)
    if hasattr(config_base, 'injector') and config_base.injector.type == "pintle":
        if hasattr(config_base.injector.geometry, 'lox'):
            config_base.injector.geometry.lox.theta_orifice = 90.0
    
    # Enable turbulence coupling
    if hasattr(config_base, 'combustion') and hasattr(config_base.combustion, 'efficiency'):
        config_base.combustion.efficiency.use_turbulence_coupling = True
    
    # Calculate initial A_throat guess
    Pc_est_psi = 580.0
    Pc_est = Pc_est_psi * psi_to_Pa
    Cf_est = 1.5
    A_throat_init = target_thrust / (Cf_est * Pc_est) if Pc_est > 0 else 0.001
    A_throat_init = np.clip(A_throat_init, 5e-5, 3.0e-3)
    
    # Calculate bounds ensuring injector area < throat area
    # CRITICAL: Injector bounds must be sized for target mass flow!
    # For 7000N thrust at Isp≈280s, O/F=2.3: mdot_O≈1.7 kg/s, mdot_F≈0.74 kg/s
    # Relaxed bounds to allow optimizer to explore wider geometry space
    max_n_orifices = 14  # Restrict to exactly 14 orifices
    max_d_orifice = 0.003  # 1-3mm range for better atomization flexibility
    max_LOX_area = max_n_orifices * np.pi * (max_d_orifice / 2) ** 2
    max_d_pintle = 0.040  # 6-40mm range
    max_h_gap = 0.0015  # 0.3-1.5mm range for stability and manufacturability
    R_inner_max = max_d_pintle / 2
    R_outer_max = R_inner_max + max_h_gap
    max_fuel_area = np.pi * (R_outer_max ** 2 - R_inner_max ** 2)
    max_injector_area = max(max_LOX_area, max_fuel_area)
    # Set minimum throat area to a small physical limit (5e-5 m² ≈ 8mm diameter)
    # Constraint in objective will enforce injector_area < throat_area
    min_A_throat_safe = 5e-5
    
    # Initial pressure bounds (65-98% of max for stable injection with full capability)
    min_P_ratio = 0.65  # Tightened lower bound for stable injection
    max_P_ratio = 0.85  # Limited to 85% of max tank pressure per user request
    min_outer_diameter = max_chamber_od * 0.5
    
    bounds = [
        (min_A_throat_safe, 4.0e-3),  # [0] A_throat
        (min_Lstar, max_Lstar),     # [1] Lstar
        (6.0, 12.0),                # [2] expansion_ratio - good range for sea level Cf≈1.6
        (min_outer_diameter, max_chamber_od),  # [3] outer diameter
        (0.006, 0.040),             # [4] d_pintle_tip - RELAXED: 6-40mm for better exploration
        (0.0003, 0.0015),           # [5] h_gap - RELAXED: 0.3-1.5mm for stability
        (14, 14.1),                 # [6] n_orifices - FIXED: ~14 orifices
        (0.001, 0.004),             # [7] d_orifice - RELAXED: 1-4mm for atomization control
        (max_lox_P_psi * min_P_ratio, max_lox_P_psi * max_P_ratio),    # [8] P_O_start_psi
        (max_fuel_P_psi * min_P_ratio, max_fuel_P_psi * max_P_ratio),  # [9] P_F_start_psi
    ]
    
    # Calculate initial guess
    # Check if we can use the input config as the starting point (x0)
    # This key feature allows the user to providing a "good guess" to speed up optimization
    has_valid_start_geom = False
    
    # Extract candidate values from config
    try:
        # Helper to safely get float > 0
        def _get_val(obj, attr, default=None):
            val = getattr(obj, attr, default)
            return float(val) if val is not None and val > 0 else None

        # Chamber/Nozzle Geometry
        # Try chamber_geometry first, then legacy sections
        cg_in = getattr(config_obj, 'chamber_geometry', None)
        c_in = getattr(config_obj, 'chamber', None)
        n_in = getattr(config_obj, 'nozzle', None)
        
        A_throat_in = _get_val(cg_in, 'A_throat') or _get_val(c_in, 'A_throat') or _get_val(n_in, 'A_throat')
        Lstar_in = _get_val(cg_in, 'Lstar') or _get_val(c_in, 'Lstar')
        eps_in = _get_val(cg_in, 'expansion_ratio') or _get_val(n_in, 'expansion_ratio')
        # Inner diameter -> Outer diameter
        D_inner_in = _get_val(cg_in, 'chamber_diameter') or _get_val(c_in, 'chamber_inner_diameter')
        
        # Injector Geometry
        inj_in = getattr(config_obj, 'injector', None)
        inj_geom = getattr(inj_in, 'geometry', None)
        is_pintle = (getattr(inj_in, 'type', '') == 'pintle')
        
        if is_pintle and inj_geom:
            fuel_in = getattr(inj_geom, 'fuel', None)
            lox_in = getattr(inj_geom, 'lox', None)
            
            d_pintle_in = _get_val(fuel_in, 'd_pintle_tip')
            h_gap_in = _get_val(fuel_in, 'h_gap')
            n_orifices_in = _get_val(lox_in, 'n_orifices')
            d_orifice_in = _get_val(lox_in, 'd_orifice')
        else:
            d_pintle_in = h_gap_in = n_orifices_in = d_orifice_in = None

        # Validate we have a complete set of non-None values to use as a starting point
        if all(v is not None for v in [A_throat_in, Lstar_in, eps_in, D_inner_in, 
                                      d_pintle_in, h_gap_in, n_orifices_in, d_orifice_in]):
            
            # Use input config values
            A_throat_init = A_throat_in
            Lstar_init = Lstar_in
            eps_init = eps_in
            outer_diameter_init = D_inner_in + TOTAL_WALL_THICKNESS_M
            
            # Injector values
            default_d_pintle = d_pintle_in
            default_h_gap = h_gap_in
            default_n_orifices = int(n_orifices_in)
            default_d_orifice = d_orifice_in
            
            # Re-verify derived checks (like throat sizing) just to be safe, but trust user input primarily
            has_valid_start_geom = True
            layer1_logger.info("Using values from input configuration as initial guess (x0).")
            
        else:
            layer1_logger.info("Input configuration incomplete/invalid for x0. Using heuristic defaults.")
            # Fall through to existing heuristics below (re-calculating them if needed)
            pass

    except Exception as e:
        layer1_logger.warning(f"Failed to extract x0 from config: {e}. Using defaults.")
        has_valid_start_geom = False

    if not has_valid_start_geom:
        # === Heuristic Defaults (Original Logic) ===
        # Sized for ~1.7 kg/s LOX flow at ΔP≈1.5 MPa
        default_n_orifices = 14
        default_d_orifice = 0.002  # 2mm orifices - sized for target mass flow
        default_d_pintle = 0.016
        default_h_gap = 0.0006
        
        A_lox_est = default_n_orifices * np.pi * (default_d_orifice / 2) ** 2
        R_inner_est = default_d_pintle / 2
        R_outer_est = R_inner_est + default_h_gap
        A_fuel_est = np.pi * (R_outer_est ** 2 - R_inner_est ** 2)
        max_injector_area_est = max(A_lox_est, A_fuel_est)
        
        # Use simple throat sizing from target thrust
        A_throat_min_safe = max_injector_area_est * 1.1
        A_throat_init = max(A_throat_init, A_throat_min_safe)
        
        Lstar_init = (min_Lstar + max_Lstar) / 2
        eps_init = 8.0 # near optimal for sea level
        outer_diameter_init = np.clip(max_chamber_od * 0.55, min_outer_diameter, max_chamber_od)

    # Clean up variables for array creation
    A_throat_init = np.clip(A_throat_init, 5e-5, 3.0e-3)
    
    # Pressures: Always use heuristic start (80% of max) unless we want to try to infer from somewhere else
    # Ideally should optimize to finding the right pressure regardless of start
    P_O_start_init = max_lox_P_psi * 0.80
    P_F_start_init = max_fuel_P_psi * 0.80
    
    x0 = np.array([
        A_throat_init,
        Lstar_init if 'Lstar_init' in locals() else (min_Lstar + max_Lstar) / 2,
        eps_init if 'eps_init' in locals() else 8.0,
        outer_diameter_init,
        default_d_pintle,
        default_h_gap,
        default_n_orifices,
        default_d_orifice,
        P_O_start_init,
        P_F_start_init,
    ])
    
    # =========================================================================
    # Handle Frozen Parameters from Design Requirements
    # =========================================================================
    # If user has specified frozen_parameters, pin those values by:
    # 1. Setting bounds to [value, value] (prevents CMA-ES from exploring)
    # 2. Setting x0 to the frozen value
    # Frozen parameters use user-friendly units and are converted to SI here.
    frozen = requirements.get("frozen_parameters", {}) or {}
    frozen_param_names = []
    
    # Map frozen parameters to their x-vector indices and unit conversions
    # Index | Parameter name          | Frozen key         | Conversion
    # ------+-------------------------+--------------------+------------
    #  0    | A_throat [m²]           | A_throat_mm2       | mm² -> m² (*1e-6)
    #  1    | Lstar [m]               | Lstar_mm           | mm -> m (*1e-3)
    #  2    | expansion_ratio [-]     | expansion_ratio    | none
    #  3    | D_chamber_outer [m]     | D_chamber_outer_mm | mm -> m (*1e-3)
    #  4    | d_pintle_tip [m]        | d_pintle_tip_mm    | mm -> m (*1e-3)
    #  5    | h_gap [m]               | h_gap_mm           | mm -> m (*1e-3)
    #  6    | n_orifices [-]          | n_orifices         | none (int)
    #  7    | d_orifice [m]           | d_orifice_mm       | mm -> m (*1e-3)
    #  8    | P_O_start [psi]         | P_O_start_psi      | none
    #  9    | P_F_start [psi]         | P_F_start_psi      | none
    
    frozen_mapping = [
        ("A_throat_mm2", 1e-6),      # idx 0
        ("Lstar_mm", 1e-3),          # idx 1
        ("expansion_ratio", 1.0),    # idx 2
        ("D_chamber_outer_mm", 1e-3),# idx 3
        ("d_pintle_tip_mm", 1e-3),   # idx 4
        ("h_gap_mm", 1e-3),          # idx 5
        ("n_orifices", 1.0),         # idx 6 (integer)
        ("d_orifice_mm", 1e-3),      # idx 7
        ("P_O_start_psi", 1.0),      # idx 8
        ("P_F_start_psi", 1.0),      # idx 9
    ]
    
    for idx, (key, conversion) in enumerate(frozen_mapping):
        frozen_val = frozen.get(key)
        if frozen_val is not None:
            # Convert from user-friendly units to SI/optimizer units
            val_si = frozen_val * conversion
            # Special case: n_orifices is integer
            if key == "n_orifices":
                val_si = int(round(frozen_val))
            # Pin bounds to frozen value (CMA-ES will sample this exact value)
            # Use a tiny epsilon for bounds to avoid numerical issues
            eps = 1e-12 if key != "n_orifices" else 0.01
            bounds[idx] = (val_si - eps, val_si + eps)
            # Set x0 to frozen value
            x0[idx] = val_si
            frozen_param_names.append(f"{key}={frozen_val}")
    
    if frozen_param_names:
        layer1_logger.info(f"Frozen parameters: {', '.join(frozen_param_names)}")
        layer1_logger.info("These values will be fixed during optimization.")
    # =========================================================================
    
    # Clip to bounds
    for i, (lo, hi) in enumerate(bounds):
        x0[i] = np.clip(x0[i], lo, hi)
    
    update_progress("Layer 1: Setup", 0.05, "Creating apply_x_to_config function...")
    apply_x_to_config = create_layer1_apply_x_to_config(bounds, max_chamber_od, max_nozzle_exit)
    
    # Precompute bounds arrays for clipping, caching, and CMA-ES scaling
    lower_bounds = np.array([b[0] for b in bounds], dtype=float)
    upper_bounds = np.array([b[1] for b in bounds], dtype=float)
    span = np.maximum(upper_bounds - lower_bounds, 1e-9)
    
    # Get report_every_n from requirements (default: 1 for real-time)
    report_every_n = int(requirements.get("report_every_n", 1))
    report_every_n = max(1, report_every_n)  # At least every iteration
    
    # Initialize optimization state
    opt_state = {
        "iteration": 0,
        "function_evaluations": 0,
        "best_objective": float('inf'),
        "best_x": None,
        "best_config": None,
        "best_lox_end_ratio": None,
        "best_fuel_end_ratio": None,
        "best_pressures": None,
        "best_results_for_validation": None,
        "converged": False,
        "objective_satisfied": False,
        "satisfied_obj": float('inf'),
        "satisfied_eval_count": 0,
        "consecutive_failures": 0,
        "last_valid_obj": float('inf'),
        "history": [],
        "objective_buffer": [],  # Buffer for batch reporting
        "stop_optimization": False,
        "force_maxfun_1": False,
        "last_best_eval": 0,
        "valley_escape_tier": 0, # 0=normal, 1=mild, 2=medium, 3=full
        "cooldown_until": 0,
    }
    
    log_flags = {
        "marginal_candidate_logged": False,
    }
    
    update_progress("Layer 1: Objective", 0.10, "Defining objective function...")
    
    # ------------------------------------------------------------------
    # Objective acceleration: cache expensive evaluate() calls
    # ------------------------------------------------------------------
    # Many optimizers will revisit the same point (especially with discrete
    # variables like n_orifices). Caching is a large speed win because
    # `PintleEngineRunner.evaluate()` is the expensive part.
    #
    # Cache key strategy:
    # - clip to bounds
    # - quantize continuous dims to a fraction of their span
    # - keep discrete dims exact (n_orifices)
    # Finer granularity (1e-5 instead of 1e-4) to preserve gradient information for L-BFGS-B
    cache_rel = float(requirements.get("objective_cache_rel", 1e-5))  # 0.001% of span per bin
    cache_rel = float(np.clip(cache_rel, 1e-6, 1e-3))
    cache_steps = np.maximum(span * cache_rel, 1e-12)
    eval_cache: Dict[Tuple[int, ...], Dict[str, Any]] = {}
    
    def _make_eval_cache_key(x_raw: np.ndarray) -> Tuple[int, ...]:
        """Quantize x to a stable hashable key for caching evaluate() results."""
        x_arr = np.clip(np.asarray(x_raw, dtype=float), lower_bounds, upper_bounds)
        x_arr = x_arr.copy()
        # Discrete variable: n_orifices
        x_arr[6] = int(round(x_arr[6]))
        key_parts = []
        for i, v in enumerate(x_arr):
            if i == 6:
                key_parts.append(int(v))
                continue
            step = float(cache_steps[i])
            # Quantize within bounds so different absolute magnitudes hash consistently
            key_parts.append(int(round((float(v) - float(lower_bounds[i])) / step)))
        return tuple(key_parts)
    
    def _hinge_band(x_val: float, lo: float, hi: float, scale: float = 1.0) -> float:
        """Dimensionless squared hinge penalty outside [lo, hi]."""
        if scale <= 0:
            scale = 1.0
        below = max(0.0, (lo - x_val) / scale)
        above = max(0.0, (x_val - hi) / scale)
        return below * below + above * above
    
    def _check_valley_escape_tier() -> int:
        """Determine if we are in a 'valley' and should boost exploration."""
        evals = opt_state["function_evaluations"]
        best_f = opt_state["best_objective"]
        stagnation = evals - opt_state["last_best_eval"]
        
        # Tier 3: Full (evals > 5000, best > 100, stagnation > 1000)
        if evals > 5000 and best_f > 100.0 and stagnation > 1000:
            return 3
        # Tier 2: Medium (evals > 3000, best > 150, stagnation > 500)
        if evals > 3000 and best_f > 150.0 and stagnation > 500:
            return 2
        # Tier 1: Mild (evals > 1500, best > 300, stagnation > 300)
        if evals > 1500 and best_f > 300.0 and stagnation > 300:
            return 1
        return 0
    
    # Define objective function
    def objective(x: np.ndarray) -> float:
        """Layer 1 objective function: optimize geometry + initial pressures.
        
        Staged/lexicographic structure (approximate but smooth):
        1) Feasibility (hard constraints + stability gates)
        2) Thrust closeness
        3) O/F closeness
        4) Regularization (Cf band, chamber length, exit pressure)
        
        Note: we still return a single scalar for SciPy/CMA-ES, but the scaling
        preserves the priority ordering and reduces "weight fights".
        """
        
        # Initialize opt_state keys
        for key in ["consecutive_failures", "last_valid_obj", "iteration", "function_evaluations", "best_objective", "best_x"]:
            if key not in opt_state:
                opt_state[key] = 0 if key in ["iteration", "function_evaluations", "consecutive_failures"] else (float('inf') if key in ["last_valid_obj", "best_objective"] else None)
        
        opt_state["iteration"] += 1
        iteration = opt_state["iteration"]
        opt_state["function_evaluations"] += 1
        
        # Progress update
        progress = 0.10 + 0.40 * min(iteration / max_iterations, 1.0)
        if iteration <= 3 or iteration % 25 == 0:
            best_obj_str = f"{opt_state['best_objective']:.3e}" if np.isfinite(opt_state['best_objective']) else "inf"
            curr_obj_str = f"{opt_state.get('last_valid_obj', float('inf')):.3e}" if np.isfinite(opt_state.get('last_valid_obj', float('inf'))) else "inf"
            update_progress("Layer 1: Optimization", progress, f"Iter {iteration}/{max_iterations} | Curr: {curr_obj_str} | Best: {best_obj_str}")
            layer1_logger.info(f"[{int(progress*100)}%] Iteration {iteration}/{max_iterations} - "
                            f"Objective: {curr_obj_str} (Best: {best_obj_str})")
            for handler in layer1_logger.handlers:
                handler.flush()
        
        # Always work with a clipped/consistent candidate vector (helps caching and stability)
        x_clipped = np.clip(np.asarray(x, dtype=float), lower_bounds, upper_bounds)
        # Discrete variable
        x_clipped = x_clipped.copy()
        x_clipped[6] = int(round(x_clipped[6]))
        
        # Convert x to config
        config, _, _ = apply_x_to_config(x_clipped, config_base)
        
        # Feasibility pre-checks (cheap): injector sizing, geometry, and O/F area sanity
        from engine.pipeline.config_schemas import ensure_chamber_geometry
        cg = ensure_chamber_geometry(config)
        A_throat_check = float(cg.A_throat or 0.0)
        D_chamber_inner = float(cg.chamber_diameter or 0.0)
        A_chamber_check = np.pi * (D_chamber_inner / 2) ** 2
        
        geom = getattr(getattr(config, "injector", None), "geometry", None)
        has_pintle = bool(getattr(getattr(config, "injector", None), "type", None) == "pintle" and geom is not None)
        
        A_lox_injector = np.nan
        A_fuel_injector = np.nan
        lox_ratio = np.nan
        fuel_ratio = np.nan
        area_ratio_error = np.nan
        
        infeasibility_score = 0.0
        
        # --- Geometric Validation Rules ---
        
        # 1. Throat area must be less than chamber area (with some margin)
        # Typically contraction ratio (A_chamber / A_throat) is between 2 and 10
        if A_chamber_check > 0 and A_throat_check > 0:
            contraction_ratio_check = A_chamber_check / A_throat_check
            # Constraint: A_throat < A_chamber (contraction_ratio > 1.0)
            infeasibility_score += max(0.0, (A_throat_check * 1.1) / A_chamber_check - 1.0) ** 2
            
            # Preferred range for contraction ratio: [1.5, 15.0]
            if contraction_ratio_check < 1.5:
                infeasibility_score += (1.5 - contraction_ratio_check) ** 2
            elif contraction_ratio_check > 15.0:
                infeasibility_score += (contraction_ratio_check - 15.0) ** 2

        # 2. Pintle diameter must be less than chamber diameter
        if has_pintle and D_chamber_inner > 0:
            d_pintle_tip_check = float(geom.fuel.d_pintle_tip)
            # Constraint: d_pintle_tip < D_chamber_inner (with 10% margin)
            infeasibility_score += max(0.0, (d_pintle_tip_check * 1.1) / D_chamber_inner - 1.0) ** 2

        # 2a. Explicit Throat Diameter vs Chamber Diameter check
        # D_throat < D_chamber check
        D_throat_check = np.sqrt(4.0 * A_throat_check / np.pi) if A_throat_check > 0 else 0.0
        if D_throat_check > 0 and D_chamber_inner > 0:
             # Penalize if throat is larger than 95% of chamber
             # This reinforces the contraction ratio check with an explicit diameter-based gradient
             infeasibility_score += max(0.0, D_throat_check - D_chamber_inner * 0.95) ** 2 * 10.0

        # 3. Nozzle exit diameter vs throat diameter
        D_exit_check = float(cg.exit_diameter or 0.0)
        R_throat_check = np.sqrt(max(0, A_throat_check / np.pi))
        D_throat_check = 2 * R_throat_check
        if D_exit_check > 0 and D_throat_check > 0:
            # Expansion ratio should be >= 1.0 (already handled by bounds, but for safety)
            infeasibility_score += max(0.0, D_throat_check / D_exit_check - 1.0) ** 2

        # --- Injector and O/F Validation ---
        
        if has_pintle and A_throat_check > 0:
            A_lox_injector = float(geom.lox.n_orifices * np.pi * (geom.lox.d_orifice / 2) ** 2)
            R_inner = float(geom.fuel.d_pintle_tip / 2)
            R_outer = float(R_inner + geom.fuel.h_gap)
            A_fuel_injector = float(np.pi * (R_outer ** 2 - R_inner ** 2))
            lox_ratio = A_lox_injector / A_throat_check
            fuel_ratio = A_fuel_injector / A_throat_check
            
            # Hard constraint: injector area should not exceed throat area
            infeasibility_score += max(0.0, lox_ratio - 1.0) ** 2
            infeasibility_score += max(0.0, fuel_ratio - 1.0) ** 2
            
            # Sanity constraint: injector O/F area ratio should be in the right ballpark
            if A_fuel_injector > 0:
                area_ratio = A_lox_injector / A_fuel_injector
                Cd_ratio = 0.4 / 0.65
                rho_ratio = np.sqrt(1140.0 / 780.0)
                delta_p_ratio_est = np.sqrt(1.2)
                area_ratio_factor = Cd_ratio * rho_ratio * delta_p_ratio_est
                required_area_ratio = optimal_of / area_ratio_factor if area_ratio_factor > 0 else np.inf
                if required_area_ratio > 0 and np.isfinite(required_area_ratio):
                    area_ratio_error = abs(area_ratio - required_area_ratio) / required_area_ratio
                    # Treat large mismatch as infeasible (provides direction to optimizer)
                    infeasibility_score += max(0.0, area_ratio_error - 0.5) ** 2
        
        # Tank pressures (dimensionless ratios are used for penalties and caching guidance)
        P_O_psi = float(np.clip(x_clipped[8], bounds[8][0], bounds[8][1]))
        P_F_psi = float(np.clip(x_clipped[9], bounds[9][0], bounds[9][1]))
        P_O_test = P_O_psi * psi_to_Pa
        P_F_test = P_F_psi * psi_to_Pa
        P_O_ratio = P_O_psi / max_lox_P_psi if max_lox_P_psi > 0 else 0.0
        P_F_ratio = P_F_psi / max_fuel_P_psi if max_fuel_P_psi > 0 else 0.0
        
        # If already infeasible from cheap checks, skip expensive evaluation.
        # This is both a lexicographic improvement and a speed win.
        eval_success = False
        final_results: Dict[str, Any] = {}
        final_pressures = (P_O_test, P_F_test)
        eval_error_str: Optional[str] = None
        
        cache_key = _make_eval_cache_key(x_clipped)
        if infeasibility_score <= 0.0:
            cached = eval_cache.get(cache_key)
            use_cached = False
            if cached is not None:
                # Handle both dict format (full cache from objective) and float/dict format (from parallel eval)
                if isinstance(cached, dict):
                    # Check if it's the full format with "results" key
                    if "results" in cached:
                        eval_success = bool(cached.get("success", False))
                        final_results = copy.deepcopy(cached.get("results", {})) if eval_success else {}
                        eval_error_str = cached.get("error", None)
                        use_cached = True
                    else:
                        # Partial format from parallel eval (only has 'value', 'success')
                        # Can't use this - we need the full results dict, so treat as cache miss
                        use_cached = False
                else:
                    # Old format: direct float value - can't use, need full results
                    use_cached = False
            
            if not use_cached:
                # Disable thermal protection for evaluation (for speed + avoid unrelated failures)
                config_runner = copy.deepcopy(config)
                if hasattr(config_runner, "ablative_cooling") and config_runner.ablative_cooling:
                    config_runner.ablative_cooling.enabled = False
                if hasattr(config_runner, "graphite_insert") and config_runner.graphite_insert:
                    config_runner.graphite_insert.enabled = False
                
                test_runner = PintleEngineRunner(config_runner)
                try:
                    final_results = test_runner.evaluate(P_O_test, P_F_test, P_ambient=target_P_exit, silent=True)
                    eval_success = True
                except Exception as eval_error:
                    eval_success = False
                    eval_error_str = str(eval_error)
                    final_results = {}
                
                eval_cache[cache_key] = {
                    "success": bool(eval_success),
                    "results": copy.deepcopy(final_results) if eval_success else {},
                    "error": eval_error_str,
                }
        
        # Defaults when evaluation fails / skipped
        F_actual = float(final_results.get("F", np.nan)) if eval_success else np.nan
        Isp_actual = float(final_results.get("Isp", np.nan)) if eval_success else np.nan
        MR_actual = float(final_results.get("MR", np.nan)) if eval_success else np.nan
        Pc_actual = float(final_results.get("Pc", np.nan)) if eval_success else np.nan
        Cf_actual = float(final_results.get("Cf_actual", final_results.get("Cf", np.nan))) if eval_success else np.nan
        stability = final_results.get("stability_results", {}) if eval_success else {}
        
        # Primary errors (dimensionless)
        thrust_error = abs(F_actual - target_thrust) / target_thrust if (eval_success and target_thrust > 0 and np.isfinite(F_actual)) else 1.0
        of_error = abs(MR_actual - optimal_of) / optimal_of if (eval_success and optimal_of > 0 and np.isfinite(MR_actual)) else 1.0
        
        # Thrust penalty with 2% deadband (no penalty if within 2% error)
        thrust_penalty_sq_term = 0.0
        if eval_success and target_thrust > 0 and np.isfinite(F_actual):
            rel_error = abs(F_actual - target_thrust) / target_thrust
            deadband = 0.02  # 2% tolerance
            if rel_error > deadband:
                # Only penalize error beyond the deadband
                excess = rel_error - deadband
                thrust_penalty_sq_term = excess ** 2
        elif not eval_success or not np.isfinite(F_actual):
            # Failed evaluation gets full penalty
            thrust_penalty_sq_term = 1.0
        
        # Exit pressure preference (dimensionless)
        # Asymmetric penalty with deadband: Overexpansion (P < target) is worse than underexpansion
        # Option A: Deadband + asymmetric quadratic
        P_exit_actual = float(final_results.get("P_exit", np.nan)) if eval_success else np.nan
        
        exit_pressure_sq_term = 0.0
        if eval_success and target_P_exit > 0 and np.isfinite(P_exit_actual):
            rel = (P_exit_actual - target_P_exit) / target_P_exit
        
            deadband = 0.05  # 5%
            if rel < -deadband:
                # overexpanded beyond deadband
                excess = rel + deadband
                exit_pressure_sq_term = (5.0 * excess) ** 2
            elif rel > deadband:
                # underexpanded beyond deadband
                excess = rel - deadband
                exit_pressure_sq_term = (1.0 * excess) ** 2
        
        # Injector pressure drop constraint: ΔP should be 0.2-0.5 × Pc
        # This ensures good atomization (ΔP not too low) without excessive pressure waste (ΔP not too high)
        injector_dp_penalty = 0.0
        if eval_success and np.isfinite(Pc_actual) and Pc_actual > 0:
            # Get injector pressures from nested dict (injector_pressure or diagnostics)
            injector_pressure_dict = final_results.get("injector_pressure", {})
            if not injector_pressure_dict:
                injector_pressure_dict = final_results.get("diagnostics", {})
            
            P_injector_O = injector_pressure_dict.get("P_injector_O")
            P_injector_F = injector_pressure_dict.get("P_injector_F")
            
            # Also check diagnostics if not in injector_pressure
            if P_injector_O is None:
                P_injector_O = final_results.get("diagnostics", {}).get("P_injector_O")
            if P_injector_F is None:
                P_injector_F = final_results.get("diagnostics", {}).get("P_injector_F")
            
            # Convert to float and validate
            P_injector_O = float(P_injector_O) if P_injector_O is not None else np.nan
            P_injector_F = float(P_injector_F) if P_injector_F is not None else np.nan
            
            # LOX injector pressure drop
            if np.isfinite(P_injector_O):
                delta_P_O = P_injector_O - Pc_actual
                delta_P_O_norm = delta_P_O / Pc_actual  # Normalized by Pc
                # Quadratic penalty outside [0.2, 0.5] deadband
                if delta_P_O_norm < 0.2:
                    injector_dp_penalty += (0.2 - delta_P_O_norm) ** 2
                elif delta_P_O_norm > 0.5:
                    injector_dp_penalty += (delta_P_O_norm - 0.5) ** 2
            
            # Fuel injector pressure drop
            if np.isfinite(P_injector_F):
                delta_P_F = P_injector_F - Pc_actual
                delta_P_F_norm = delta_P_F / Pc_actual  # Normalized by Pc
                # Quadratic penalty outside [0.2, 0.5] deadband
                if delta_P_F_norm < 0.2:
                    injector_dp_penalty += (0.2 - delta_P_F_norm) ** 2
                elif delta_P_F_norm > 0.5:
                    injector_dp_penalty += (delta_P_F_norm - 0.5) ** 2
        
        # Stability gates contribute to feasibility (lexicographic stage 1)
        stability_state = stability.get("stability_state", "unstable")
        stability_score = float(stability.get("stability_score", 0.0))
        chugging_margin = max(0.0, float(stability.get("chugging", {}).get("stability_margin", 0.0)))
        acoustic_margin = max(0.0, float(stability.get("acoustic", {}).get("stability_margin", 0.0)))
        feed_margin = max(0.0, float(stability.get("feed_system", {}).get("stability_margin", 0.0)))
        
        min_stability_score_raw = float(requirements.get("min_stability_score", 0.75))
        stability_margin_handicap = float(requirements.get("stability_margin_handicap", 0.0))
        score_factor = max(0.0, 1.0 - stability_margin_handicap)
        margin_factor = max(0.0, 1.0 - stability_margin_handicap)
        effective_min_score = min_stability_score_raw * score_factor
        effective_margin = float(min_stability) * margin_factor
        
        require_stable_state = bool(requirements.get("require_stable_state", True))
        allowed_states = {"stable", "marginal"}
        state_ok = (stability_state in allowed_states) if require_stable_state else (stability_state != "unstable")
        if eval_success:
            if not state_ok:
                infeasibility_score += 1.0
            if effective_min_score > 0:
                infeasibility_score += max(0.0, (effective_min_score - stability_score) / effective_min_score) ** 2
            if effective_margin > 0:
                infeasibility_score += max(0.0, (effective_margin - chugging_margin) / effective_margin) ** 2
                infeasibility_score += max(0.0, (effective_margin - acoustic_margin) / effective_margin) ** 2
                infeasibility_score += max(0.0, (effective_margin - feed_margin) / effective_margin) ** 2
        else:
            # If solver fails, treat as infeasible and try to provide directional guidance.
            # This avoids "constant penalty with no gradient" behavior.
            infeasibility_score += 1.0
            if eval_error_str is not None:
                err_lower = eval_error_str.lower()
                # Supply < Demand → encourage higher pressures and/or larger injector area
                if ("supply < demand" in err_lower) or ("insufficient mass flow" in err_lower):
                    infeasibility_score += max(0.0, 0.90 - P_O_ratio) ** 2 + max(0.0, 0.90 - P_F_ratio) ** 2
                # Supply > Demand / bracket issues → encourage reducing injector oversupply or increasing throat
                if ("supply > demand" in err_lower) or ("invalid bracket" in err_lower) or ("no solution" in err_lower):
                    if np.isfinite(lox_ratio):
                        infeasibility_score += max(0.0, lox_ratio - 0.90) ** 2
                    if np.isfinite(fuel_ratio):
                        infeasibility_score += max(0.0, fuel_ratio - 0.90) ** 2
            # Always include area-ratio mismatch as directional signal if available
            if np.isfinite(area_ratio_error):
                infeasibility_score += max(0.0, area_ratio_error - 0.25) ** 2
        
        # Regularization terms (dimensionless squared)
        Cf_min_acceptable = 1.3
        Cf_max_acceptable = 1.8
        cf_hinge = _hinge_band(float(Cf_actual) if np.isfinite(Cf_actual) else 0.0,
                               Cf_min_acceptable, Cf_max_acceptable,
                               scale=(Cf_max_acceptable - Cf_min_acceptable))
        
        # Chamber length penalty: only apply if exceeds maximum (prefer shorter within bounds)
        max_chamber_length = float(requirements.get("max_chamber_length_m", 0.50))  # 50cm max
        L_chamber_curr = getattr(getattr(config, "chamber", None), "length", None)
        L_chamber_curr = float(L_chamber_curr) if (L_chamber_curr is not None and np.isfinite(L_chamber_curr)) else np.nan
        length_term = 0.0
        length_violation = False
        if np.isfinite(L_chamber_curr) and max_chamber_length > 0:
            if L_chamber_curr > max_chamber_length:
                # Hard constraint: treat as infeasibility
                length_violation = True
                length_term = ((L_chamber_curr - max_chamber_length) / max_chamber_length) ** 2
            else:
                # Soft penalty to guide optimizer away from the boundary
                length_term = max(0.0, (L_chamber_curr - max_chamber_length * 0.9) / (max_chamber_length * 0.1)) ** 2
        
        # ------------------------------------------------------------------
        # Lexicographic-ish scalarization with normalized weights
        # Each priority level is 100× the next for clear separation
        # SCALED DOWN: Max penalty ~1e7 instead of 1e10
        # ------------------------------------------------------------------
        BASE_INFEAS = 1e6        # Infeasibility baseline (was 1e10)
        W_INFEAS = 1e5           # Level 0: Hard constraints (was 1e8)
        W_THRUST = 1e4           # Level 1: Primary objectives (was 1e6)
        W_OF = 1e4               # Level 1: Primary objectives (was 1e6)
        W_CF = 1e2               # Level 2: Secondary objectives (was 1e4)
        W_EXIT = 2.0e2           # Level 2: Secondary objectives (was 2e4)
        W_INJECTOR_DP = 1e4      # Level 1.5: Injector pressure drop (critical for proper atomization and efficiency)
        W_LEN = 1e4              # Level 2: Chamber length constraint (increased from 1.0 to enforce max length)
        
        if (not np.isfinite(infeasibility_score)) or infeasibility_score < 0:
            infeasibility_score = 1.0
        
        # Treat length violation as infeasibility (hard constraint)
        if length_violation:
            obj = BASE_INFEAS + W_INFEAS * length_term
        elif infeasibility_score > 0.0:
            obj = BASE_INFEAS + W_INFEAS * float(infeasibility_score)
        else:
            obj = (
                W_THRUST * thrust_penalty_sq_term +
                W_OF * (of_error ** 2) +
                W_CF * cf_hinge +
                W_EXIT * exit_pressure_sq_term +
                W_INJECTOR_DP * injector_dp_penalty +
                W_LEN * length_term
            )
        
        if not np.isfinite(obj):
            obj = BASE_INFEAS
        
        # Check for early stopping (pure feasibility + primary objective satisfaction)
        thrust_tol_validation = thrust_tol * 1.0
        of_tol_validation = 0.15
        errors_acceptable = (
            (infeasibility_score <= 0.0) and
            (thrust_error < thrust_tol_validation) and
            (of_error < of_tol_validation) and
            (stability_score >= effective_min_score * 0.8)
        )
        
        # Track that we found an acceptable solution, but don't force stop
        # (let optimizer continue to find even better solutions)
        if errors_acceptable:
            if eval_success and final_pressures is not None:
                opt_state["best_pressures"] = final_pressures
                opt_state["best_results_for_validation"] = {
                    "F": F_actual,
                    "MR": MR_actual,
                    "thrust_error": thrust_error,
                    "of_error": of_error,
                    "stability_score": stability_score,
                    "stability_state": stability_state,
                    "chugging_margin": chugging_margin,
                    "acoustic_margin": acoustic_margin,
                    "feed_margin": feed_margin,
                    "stability_results": stability,
                }
            if not opt_state.get('acceptable_found_logged', False):
                log_status("Layer 1", f"✓ Acceptable solution found! Obj={obj:.6e}, Thrust err: {thrust_error*100:.2f}%, O/F err: {of_error*100:.2f}% (continuing optimization...)")
                opt_state['acceptable_found_logged'] = True
        
        # Track valid evaluations
        if eval_success and np.isfinite(obj):
            opt_state['consecutive_failures'] = 0
            opt_state['last_valid_obj'] = obj
        else:
            opt_state['consecutive_failures'] += 1
            if opt_state['consecutive_failures'] > 200:
                return 1e5
        
        # Record history with all parameterization variables
        def _finite_or_none(v: Any) -> Optional[float]:
            try:
                vv = float(v)
            except Exception:
                return None
            return vv if np.isfinite(vv) else None

        A_throat_curr = float(np.clip(x_clipped[0], bounds[0][0], bounds[0][1]))
        Lstar_curr = float(np.clip(x_clipped[1], bounds[1][0], bounds[1][1]))
        expansion_ratio_curr = float(np.clip(x_clipped[2], bounds[2][0], bounds[2][1]))
        D_outer_curr = float(np.clip(x_clipped[3], bounds[3][0], bounds[3][1]))
        d_pintle_tip_curr = float(np.clip(x_clipped[4], bounds[4][0], bounds[4][1]))
        h_gap_curr = float(np.clip(x_clipped[5], bounds[5][0], bounds[5][1]))
        n_orifices_curr = int(round(np.clip(x_clipped[6], bounds[6][0], bounds[6][1])))
        d_orifice_curr = float(np.clip(x_clipped[7], bounds[7][0], bounds[7][1]))
        P_O_start_psi_hist = float(np.clip(x_clipped[8], bounds[8][0], bounds[8][1]))
        P_F_start_psi_hist = float(np.clip(x_clipped[9], bounds[9][0], bounds[9][1]))
        
        D_inner_curr = D_outer_curr - TOTAL_WALL_THICKNESS_M
        if D_inner_curr <= 0:
            D_inner_curr = max(D_outer_curr * 0.3, 0.01)
        
        lox_start_ratio_hist = P_O_start_psi_hist / max_lox_P_psi if max_lox_P_psi > 0 else 0.7
        fuel_start_ratio_hist = P_F_start_psi_hist / max_fuel_P_psi if max_fuel_P_psi > 0 else 0.7
        combined_stability_margin = min(chugging_margin, acoustic_margin, feed_margin) if eval_success else 0.0
        L_chamber_hist = L_chamber_curr if (np.isfinite(L_chamber_curr)) else None
        
        opt_state["history"].append({
            "iteration": iteration,
            "x": x_clipped.copy(),
            # Parameterization variables (geometries and pressures)
            "A_throat": A_throat_curr,
            "Lstar": Lstar_curr,
            "expansion_ratio": expansion_ratio_curr,
            "D_chamber_outer": D_outer_curr,
            "D_chamber_inner": D_inner_curr,
            "L_chamber": L_chamber_hist,
            "d_pintle_tip": d_pintle_tip_curr,
            "h_gap": h_gap_curr,
            "n_orifices": n_orifices_curr,
            "d_orifice": d_orifice_curr,
            "P_O_start_psi": P_O_start_psi_hist,
            "P_F_start_psi": P_F_start_psi_hist,
            # Performance metrics
            "thrust": _finite_or_none(F_actual),
            "thrust_error": thrust_error,
            "of_error": of_error,
            "Isp": _finite_or_none(Isp_actual),
            "MR": _finite_or_none(MR_actual),
            "Pc": _finite_or_none(Pc_actual),
            "Cf": _finite_or_none(Cf_actual),
            "Cf_error": float(np.sqrt(cf_hinge)) if np.isfinite(cf_hinge) else 1.0,
            "Cf_penalty": float(W_CF * cf_hinge),
            # Stability metrics
            "stability_margin": combined_stability_margin,
            "stability_state": stability_state,
            "stability_score": stability_score,
            "chugging_margin": chugging_margin,
            "acoustic_margin": acoustic_margin,
            "feed_margin": feed_margin,
            # Pressure ratios
            "lox_end_ratio": lox_start_ratio_hist,
            "fuel_end_ratio": fuel_start_ratio_hist,
            "lox_start_ratio": lox_start_ratio_hist,
            "fuel_start_ratio": fuel_start_ratio_hist,
            # Feasibility diagnostics
            "infeasibility_score": float(infeasibility_score),
            "eval_success": bool(eval_success),
            "eval_error": eval_error_str,
            # Objective
            "objective": obj,
        })
        
        # Track best
        is_new_best = obj < opt_state["best_objective"]
        if is_new_best:
            opt_state["best_objective"] = obj
            opt_state["best_x"] = x_clipped.copy()
            opt_state["last_best_eval"] = opt_state["function_evaluations"]
            
            # Store objective component breakdown for diagnostics
            opt_state["best_objective_breakdown"] = {
                "thrust_penalty": float(W_THRUST * thrust_penalty_sq_term),
                "of_penalty": float(W_OF * (of_error ** 2)),
                "cf_penalty": float(W_CF * cf_hinge),
                "exit_pressure_penalty": float(W_EXIT * exit_pressure_sq_term),
                "injector_dp_penalty": float(W_INJECTOR_DP * injector_dp_penalty),
                "length_penalty": float(W_LEN * length_term),
                "infeasibility_penalty": float(BASE_INFEAS + W_INFEAS * infeasibility_score) if infeasibility_score > 0 or length_violation else 0.0,
                "length_violation": bool(length_violation),
                "is_infeasible": bool(infeasibility_score > 0 or length_violation),
            }
            
            # If we were in a valley escape mode, exit it
            if opt_state.get("valley_escape_tier", 0) > 0:
                layer1_logger.info(f"    *** Improvement found: Exiting Valley Escape Tier {opt_state['valley_escape_tier']} ***")
                opt_state["valley_escape_tier"] = 0
            # Only store a "best config" if we actually evaluated successfully and are feasible.
            if eval_success and infeasibility_score <= 0.0:
                opt_state["best_config"] = copy.deepcopy(config)
                opt_state["best_lox_end_ratio"] = lox_start_ratio_hist
                opt_state["best_fuel_end_ratio"] = fuel_start_ratio_hist
            if eval_success and final_pressures is not None:
                opt_state["best_pressures"] = final_pressures
                opt_state["best_results_for_validation"] = {
                    "F": F_actual,
                    "MR": MR_actual,
                    "thrust_error": thrust_error,
                    "of_error": of_error,
                    "stability_score": stability_score,
                    "stability_state": stability_state,
                    "chugging_margin": chugging_margin,
                    "acoustic_margin": acoustic_margin,
                    "feed_margin": feed_margin,
                    "stability_results": stability,
                }
            layer1_logger.info(
                f"    ✓ New best objective: {obj:.6f} "
                f"(thrust_err: {thrust_error*100:.2f}%, O/F_err: {of_error*100:.2f}%, "
                f"Cf: {Cf_actual:.3f}, stability: {stability_state}, score: {stability_score:.3f})"
            )
            for handler in layer1_logger.handlers:
                handler.flush()
        
        # Buffer objective data every iteration (for batch reporting)
        opt_state["objective_buffer"].append({
            "iteration": int(iteration),
            "objective": float(obj),
            "best_objective": float(opt_state.get("best_objective", obj)),
        })
        
        # Stream objective history to external callback (e.g., UI plot) if provided
        # Only call callback every report_every_n iterations (batch reporting)
        should_report = (iteration % report_every_n == 0) or opt_state.get('objective_satisfied', False)
        if objective_callback is not None and should_report:
            try:
                # Send all buffered entries (batch reporting)
                for buffered_entry in opt_state["objective_buffer"]:
                    objective_callback(
                        buffered_entry["iteration"],
                        buffered_entry["objective"],
                        buffered_entry["best_objective"],
                    )
                # Clear buffer after reporting
                opt_state["objective_buffer"] = []
            except Exception:
                # Never let UI/consumer callback break the optimizer loop
                pass
        
        # Convergence check
        stability_acceptable = (
            state_ok and
            (stability_score >= effective_min_score * 0.6) and
            (chugging_margin >= effective_margin * 0.5) and
            (acoustic_margin >= effective_margin * 0.5) and
            (feed_margin >= effective_margin * 0.5)
        )
        
        convergence_thrust_tol = thrust_tol * 2.0
        convergence_of_tol = 0.30
        # `best_objective` is updated above when `is_new_best` is True, so comparing
        # against it here would always be False for a new best. Re-use the flag.
        obj_improving = is_new_best
        
        if (thrust_error < convergence_thrust_tol and 
            of_error < convergence_of_tol and 
            stability_acceptable and
            obj_improving):
            opt_state["converged"] = True
        else:
            opt_state["converged"] = False
        
        return obj
    
    # Run optimization
    layer1_logger.info("")
    layer1_logger.info("Starting optimization...")
    layer1_logger.info("")
    opt_state["iteration"] = 0
    opt_state["function_evaluations"] = 0
    
    class _ResultWrapper:
        def __init__(self, x, fun, success=True):
            self.x = np.asarray(x, dtype=float)
            self.fun = float(fun)
            self.success = success
    
    result = None
    x0_refined = x0
    # lower_bounds/upper_bounds/span are computed above (used for caching and solvers)
    
    # Check CMA-ES availability (required)
    if cma is None:
        raise ImportError(
            "CMA-ES (cma package) is required for Layer 1 optimization but not installed.\n"
            "Install with: pip install cma"
        )
    
    # Run CMA-ES global optimization with random restarts
    layer1_logger.info("Using CMA-ES with random restart strategy for robust optimization.")
    update_progress("Layer 1: CMA-ES", 0.45, "Running CMA-ES global solver...")
    
    # IMPROVED: Initial step size fraction (reduced to 0.15 for better convergence with wide bounds)
    target_fraction_of_range = 0.15  # 15% of range per sigma for reliable convergence
    
    # Calculate base sigma0 from 25th percentile span (less sensitive to large diameter bounds)
    # Using percentile instead of median prevents large bound changes from dominating step size
    sigma0 = float(np.percentile(span, 25) * target_fraction_of_range)
    if not np.isfinite(sigma0) or sigma0 <= 0:
        sigma0 = 0.05
    
    # Set CMA_stds proportional to each variable's range
    # This ensures variables with larger ranges (like expansion_ratio) get larger step sizes
    cma_stds = np.ones_like(span)
    for i in range(len(span)):
        if span[i] > 0:
            # Desired step size for this dimension: fraction of its range
            desired_step = span[i] * target_fraction_of_range
            # CMA_stds[i] = desired_step / sigma0
            # This makes step size in dimension i proportional to its range
            cma_stds[i] = max(0.1, desired_step / sigma0) if sigma0 > 0 else 1.0
    
    # Special handling for discrete n_orifices (index 6): ensure it can jump between integers
    n_orifices_idx = 6
    target_step_n = 1.0  # ~one orifice per sigma
    if sigma0 > 0:
        cma_stds[n_orifices_idx] = max(cma_stds[n_orifices_idx], target_step_n / sigma0)

    # IMPROVED: Larger population for better exploration (32-80 instead of 16-48)
    # Standardized population for better diversity (increased to 48)
    popsize = 48
    layer1_logger.info(f"Population size: {popsize}")
    
    # Fixed number of restarts (3) to ensure robust convergence across all runs
    num_restarts = 3
    layer1_logger.info(f"Using {num_restarts} fixed restarts to ensure consistent global convergence")
    
    best_x_global = x0_refined
    best_f_global = float('inf')
    
    
    # ============================================================================
    # Setup for Parallel Evaluation (used by both hybrid and default CMA-ES)
    # ============================================================================
    num_workers = _get_num_workers(config_obj)
    debug_strict = getattr(config_obj.optimizer, 'debug_strict', False) if hasattr(config_obj, 'optimizer') else False
    
    layer1_logger.info(f"Using {num_workers} worker processes for parallel evaluation")
    
    # Prepare worker init args
    config_dict = _config_to_dict(config_base)
    bounds_array = np.column_stack([lower_bounds, upper_bounds])
    constants_dict = {
        'target_thrust': target_thrust,
        'optimal_of': optimal_of,
        'P_ambient': target_P_exit,  # Ambient pressure (atmospheric)
        'max_lox_P_psi': max_lox_P_psi,
        'max_fuel_P_psi': max_fuel_P_psi,
        'TOTAL_WALL_THICKNESS_M': TOTAL_WALL_THICKNESS_M,
        'max_nozzle_exit': max_nozzle_exit,
        'max_chamber_od': max_chamber_od,
    }
    
    # Integer dimension indices (for snapping)
    integer_dims = [6]  # n_orifices
    
    # DISPATCH: Check optimizer mode
    optimizer_mode = "cma" # default
    if hasattr(config_obj, "optimizer") and config_obj.optimizer:
        optimizer_mode = config_obj.optimizer.mode
    
    # Create ProcessPoolExecutor for parallel evaluation (used by both modes)
    with ProcessPoolExecutor(
        max_workers=num_workers,
        initializer=_init_worker,
        initargs=(config_dict, bounds_array, requirements, constants_dict, debug_strict)
    ) as executor:
        
        # Optional: Warm-up call per worker (first call can trigger lazy imports)
        if num_workers > 1:
            dummy_candidate = _snap_integer_dims(x0_refined.copy(), integer_dims)
            list(executor.map(_eval_candidate, [dummy_candidate] * num_workers))

        if optimizer_mode == "hybrid_cma_blocks" and hasattr(config_obj.optimizer, "hybrid"):
            layer1_logger.info("Using Hybrid CMA + Block Re-optimization mode.")
            hybrid_config = config_obj.optimizer.hybrid
            
            # Determine total budget available for optimization (excluding L-BFGS-B refinement)
            # We used to have num_restarts * max_iterations per restart
            # Let's say total budget is ~2000-3000 evals
            # Increased budget for hybrid optimization (increased from 150*pop to 200*pop)
            total_eval_budget = 300 
            # Checked existing code: max_iterations is passed as 'maxiter' or 'maxfevals' in different places.
            # In current CMA code above: cma_options['maxiter'] = iter_budget
            # default max_iterations is usually large?
            # Actually in layer1 defaults (not visible here), max_iterations might be small? 
            # Let's assume passed max_iterations is small (e.g. 100 iterations of popsize?)
            # Let's force a reasonable budget for hybrid
            total_budget_evals = max(2000, total_eval_budget * popsize)
            
            # Run Multi-Track Hybrid?
            num_tracks = hybrid_config.num_tracks
            
            best_x_global = x0_refined
            best_f_global = float('inf')
            
            if num_tracks > 1:
                layer1_logger.info(f"Running {num_tracks} independent hybrid tracks...")
                # Track initialization: Top-N restarts?
                # User feedback says: "track i starts from best of restart i"
                # So we first need to run N restarts of global exploration to seed tracks?
                # OR we simply start N tracks from random perturbations of x0.
                # "Multi-track: Initialize tracks from Top-N best results of Stage A restarts."
                # My run_hybrid_optimization includes Stage A internally. 
                # So "Multi-track" essentially means distinct runs of run_hybrid_optimization?
                # OR running Stage A first, then branching?
                # Let's treat "Multi-track" as running the WHOLE hybrid process N times with different seeds.
                 
                for track_i in range(num_tracks):
                    check_stop()  # Check if optimization should stop
                    layer1_logger.info(f"--- Track {track_i+1}/{num_tracks} ---")
                    
                    # Perturb start point for diversity if track > 0
                    if track_i > 0:
                        x0_track = x0_refined + rng.standard_normal(len(x0_refined)) * (0.1 * span)
                        x0_track = np.clip(x0_track, lower_bounds, upper_bounds)
                    else:
                        x0_track = x0_refined
                        
                    t_x, t_f, t_ev = run_hybrid_optimization(
                        objective,
                        list(zip(lower_bounds, upper_bounds)),
                        x0_track,
                        hybrid_config,
                        total_budget=total_budget_evals // num_tracks,
                        logger=layer1_logger,
                        log_status_fn=log_status,
                        update_progress_fn=update_progress,
                        valley_escape_tracker=opt_state,
                        # Parallel evaluation parameters
                        executor=executor,
                        integer_dims=integer_dims,
                        eval_cache=eval_cache,
                        make_cache_key_fn=_make_eval_cache_key,
                        stop_event=stop_event,
                    )
                    
                    if t_f < best_f_global:
                        best_f_global = t_f
                        best_x_global = t_x
                        layer1_logger.info(f"Track {track_i+1} found new global best: {best_f_global:.5f}")
                        
            else:
                # Single track
                best_x_global, best_f_global, evs = run_hybrid_optimization(
                    objective,
                    list(zip(lower_bounds, upper_bounds)),
                    x0_refined,
                    hybrid_config,
                    total_budget=total_budget_evals,
                    logger=layer1_logger,
                    log_status_fn=log_status,
                    update_progress_fn=update_progress,
                    valley_escape_tracker=opt_state,
                    # Parallel evaluation parameters
                    executor=executor,
                    integer_dims=integer_dims,
                    eval_cache=eval_cache,
                    make_cache_key_fn=_make_eval_cache_key,
                    stop_event=stop_event,
                )

        else:
            # Default/Fallback: Legacy CMA-ES Logic with Parallel Evaluation
            # (Executor already created above, wrapping both hybrid and default paths)
            
            best_x_global = x0_refined
            best_f_global = float('inf')
            
            for restart_idx in range(num_restarts):
                restart_name = f"Restart {restart_idx + 1}/{num_restarts}" if num_restarts > 1 else "Main search"
                
                # IMPROVED: Multi-scale restart strategy
                if restart_idx == 0:
                    current_sigma_fraction = target_fraction_of_range # 25% (Global)
                    x_start = x0_refined
                elif restart_idx == 1:
                    current_sigma_fraction = 0.05 # 5% (Refined)
                    perturbation = rng.standard_normal(len(best_x_global)) * (sigma0 * 0.1)
                    x_start = best_x_global + perturbation
                elif restart_idx == 2:
                    current_sigma_fraction = 0.15 # 15% (Medium)
                    perturbation = rng.standard_normal(len(best_x_global)) * (sigma0 * 0.3)
                    x_start = best_x_global + perturbation
                else:
                    current_sigma_fraction = 0.15 if restart_idx % 2 == 0 else 0.25
                    perturbation = rng.standard_normal(len(best_x_global)) * (sigma0 * 0.3)
                    x_start = best_x_global + perturbation
                
                x_start = np.clip(x_start, lower_bounds, upper_bounds)
                    
                current_sigma0 = float(np.percentile(span, 25) * current_sigma_fraction)
                if not np.isfinite(current_sigma0) or current_sigma0 <= 0:
                    current_sigma0 = 0.05
                    
                current_cma_stds = np.ones_like(span)
                for i in range(len(span)):
                    if span[i] > 0:
                        desired_step = span[i] * current_sigma_fraction
                        current_cma_stds[i] = max(0.1, desired_step / current_sigma0) if current_sigma0 > 0 else 1.0
                
                if current_sigma0 > 0:
                    current_cma_stds[n_orifices_idx] = max(current_cma_stds[n_orifices_idx], 1.0 / current_sigma0)
        
                layer1_logger.info(f"")
                layer1_logger.info(f"Starting {restart_name} (sigma: {current_sigma_fraction*100:.0f}% of range)...")
                
                iter_budget = total_eval_budget // num_restarts
                
                cma_options = {
                    "bounds": [lower_bounds.tolist(), upper_bounds.tolist()],
                    "popsize": popsize,
                    "maxiter": iter_budget,
                    "verb_disp": 0,
                    "verb_log": 0,
                    "CMA_stds": current_cma_stds.tolist(),
                    "tolx": 1e-8,
                    "tolfun": 1e-9,
                    "tolstagnation": 50,
                    "ftarget": -np.inf,
                }
                
                try:
                    es = cma.CMAEvolutionStrategy(x_start.tolist(), current_sigma0, cma_options)
                    while not es.stop():
                        # Check if optimization should stop
                        check_stop()
                        
                        # Check for Valley Escape boost
                        target_tier = _check_valley_escape_tier()
                        if target_tier > opt_state["valley_escape_tier"] and opt_state["function_evaluations"] > opt_state["cooldown_until"]:
                            # Tier definitions
                            tier_names = ["None", "Mild", "Medium", "Full"]
                            boost_factors = [1.0, 1.5, 2.0, 3.0]
                            current_factor = boost_factors[opt_state["valley_escape_tier"]]
                            target_factor = boost_factors[target_tier]
                            relative_boost = target_factor / current_factor
                            
                            old_sigma = es.sigma
                            es.sigma *= relative_boost
                            
                            # Clamp sigma to 30% of 25th percentile span to prevent sampling nonsense
                            max_sigma = 0.3 * float(np.percentile(span, 25))
                            if es.sigma > max_sigma:
                                es.sigma = max_sigma
                                
                            # Update state
                            opt_state["valley_escape_tier"] = target_tier
                            opt_state["cooldown_until"] = opt_state["function_evaluations"] + 1000
                            
                            layer1_logger.info("!" * 20)
                            layer1_logger.info(f"VALLEY ESCAPE TRIGGERED (Tier: {tier_names[target_tier]})")
                            layer1_logger.info(f"Evals: {opt_state['function_evaluations']}, Best: {opt_state['best_objective']:.2f}, Stagnation: {opt_state['function_evaluations'] - opt_state['last_best_eval']}")
                            layer1_logger.info(f"Sigma: {old_sigma:.6f} -> {es.sigma:.6f} (Boost: {relative_boost:.2f}x)")
                            layer1_logger.info("!" * 20)
                            for handler in layer1_logger.handlers:
                                handler.flush()


                        # CMA-ES samples within bounds (no manual clipping needed)
                        candidates = es.ask()
                        
                        # Snap integer dimensions for consistency
                        # Convert to numpy arrays (pickle-safe in WSL)
                        candidates_snapped = [
                            _snap_integer_dims(np.asarray(c, dtype=np.float64), integer_dims)
                            for c in candidates
                        ]
                        
                        # Parent-side caching: check cache before submitting work
                        # Cache keys use SNAPPED values for consistency
                        cache_keys = [_make_eval_cache_key(c) for c in candidates_snapped]
                        uncached_indices = []
                        uncached_candidates = []
                        values = [None] * len(candidates)
                        
                        for i, key in enumerate(cache_keys):
                            if key in eval_cache:
                                cached_val = eval_cache[key]
                                # Handle dict format from parallel eval (has 'value' key)
                                # Note: dict format from objective() has 'results' but not 'value', so we can't use it here
                                if isinstance(cached_val, dict) and 'value' in cached_val:
                                    values[i] = float(cached_val['value'])
                                elif isinstance(cached_val, (int, float)):
                                    # Old format: direct float value (backward compatibility)
                                    values[i] = float(cached_val)
                                else:
                                    # Full format from objective() or unknown format - can't extract value, treat as uncached
                                    uncached_indices.append(i)
                                    uncached_candidates.append(candidates_snapped[i])
                            else:
                                uncached_indices.append(i)
                                uncached_candidates.append(candidates_snapped[i])
                        
                        # Parallel evaluation of uncached candidates
                        if uncached_candidates:
                            chunksize = max(1, len(uncached_candidates) // (num_workers * 4))
                            results = list(executor.map(_eval_candidate, uncached_candidates, chunksize=chunksize))
                            
                            # Merge results back and update parent state
                            for idx, res in zip(uncached_indices, results):
                                obj_val = res['value']
                                values[idx] = obj_val
                                
                                # Cache result (using snapped key) - store in dict format for compatibility
                                eval_cache[cache_keys[idx]] = {
                                    'value': obj_val,
                                    'success': res.get('success', True),
                                }
                                
                                # Parent owns: tracking, logging, history
                                # Count ALL evaluations (success + failure) for accurate metrics
                                opt_state['function_evaluations'] += 1
                                
                                if not res['success']:
                                    # Track failures
                                    reason = res.get('error_type', 'Unknown')
                                    opt_state['num_failures'] = opt_state.get('num_failures', 0) + 1
                                    
                                    # Track failure reasons
                                    if 'fail_counts' not in opt_state:
                                        opt_state['fail_counts'] = {}
                                    opt_state['fail_counts'][reason] = opt_state['fail_counts'].get(reason, 0) + 1
                                    
                                    # Periodic failure logging (every 100 evals)
                                    if opt_state['function_evaluations'] % 100 == 0:
                                        # Sort failures by count descending
                                        sorted_fails = sorted(opt_state['fail_counts'].items(), key=lambda item: item[1], reverse=True)
                                        top_fails = sorted_fails[:3]
                                        fail_msg = ", ".join([f"{k}: {v}" for k, v in top_fails])
                                        layer1_logger.warning(f"Recent Failures (Top 3): {fail_msg}")
                                        
                                    layer1_logger.warning(f"Eval failed: {reason}")
                        
                        # Tell CMA-ES using ORIGINAL candidates (not snapped)
                        # This is correct because CMA-ES needs to update its distribution
                        es.tell(candidates, values)
                        
                        iter_idx = max(1, es.countiter)
                        overall_progress = restart_idx / num_restarts
                        restart_progress = iter_idx / iter_budget / num_restarts
                        progress = 0.10 + 0.35 * (overall_progress + restart_progress)
                        update_progress("Layer 1: CMA-ES", progress, 
                                      f"{restart_name} - iteration {iter_idx}/{iter_budget}")
                    
                    cma_result = es.result
                    restart_best_x = np.asarray(cma_result.xbest, dtype=float)
                    restart_best_f = float(cma_result.fbest)
                    
                    layer1_logger.info(f"{restart_name} finished. Final obj: {restart_best_f:.6f}")
                    
                    if restart_best_f < best_f_global:
                        best_f_global = restart_best_f
                        best_x_global = restart_best_x
                        layer1_logger.info(f"  ✓ New global best: {best_f_global:.6f}")
                    
                    if best_f_global < obj_tolerance:
                        layer1_logger.info(f"Found excellent solution, skipping restarts")
                        break
                        
                    for handler in layer1_logger.handlers:
                        handler.flush()
                        
                except Exception as e:
                    layer1_logger.error(f"{restart_name} failed: {e}")
                    if restart_idx == 0:
                        raise
                    continue

    
    # Use best result across all restarts
    x0_refined = best_x_global
    best_fun = best_f_global
    layer1_logger.info(f"")
    layer1_logger.info(f"CMA-ES complete. Global best objective: {best_fun:.6f}")
    layer1_logger.info(f"Total function evaluations: {opt_state['function_evaluations']}")
    log_status("Layer 1", f"CMA-ES complete: {num_restarts} restart(s), obj={best_fun:.3f}, refining with L-BFGS-B...")
    for handler in layer1_logger.handlers:
        handler.flush()
    
    # Reset function evaluation counter for L-BFGS-B refinement
    opt_state["function_evaluations"] = 0

    
    # L-BFGS-B refinement runs after CMA-ES
    # Always run full local optimization regardless of current objective value
    maxfun_capped = min(max_iterations * 3, 500)
    
    update_progress("Layer 1: Local Refinement", 0.47, f"Refining with L-BFGS-B (max {maxfun_capped} func evals)...")
    layer1_logger.info("Phase 2: Local refinement (L-BFGS-B)...")
    
    try:
        lbfgs_result = minimize(
            objective,
            x0_refined,
            method='L-BFGS-B',
            bounds=bounds,
            options={
                'maxiter': max_iterations,
                'maxfun': maxfun_capped,
                'ftol': obj_tolerance * 0.1,
                'gtol': 1e-3,  # Relaxed from 1e-5 to allow larger steps before convergence
                'maxls': 50,    # Increased from 20 to allow more aggressive line searches
                'disp': False,
            }
        )
        layer1_logger.info("")
        layer1_logger.info("Optimization completed")
        layer1_logger.info(f"Success: {lbfgs_result.success}")
        layer1_logger.info(f"Final objective value: {lbfgs_result.fun:.6f}")
        layer1_logger.info(f"Iterations: {lbfgs_result.nit if hasattr(lbfgs_result, 'nit') else 'N/A'}")
        layer1_logger.info(f"Function evaluations: {lbfgs_result.nfev if hasattr(lbfgs_result, 'nfev') else 'N/A'}")
        layer1_logger.info("")
        result = lbfgs_result
    except Exception as e:
        layer1_logger.error(f"L-BFGS-B error: {e}")
        log_status("Layer 1 Warning", f"L-BFGS-B error: {e}, using best result found")
        # Use CMA-ES result or best found during optimization
        if 'best_fun' in locals():
            # CMA-ES succeeded but L-BFGS-B failed
            result = _ResultWrapper(x0_refined, best_fun)
        else:
            # Use best from optimization state
            best_x = opt_state.get('best_x', x0)
            best_obj = opt_state.get('best_objective', float('inf'))
            result = _ResultWrapper(best_x, best_obj)
    
    # Get best config
    if opt_state["best_config"] is not None:
        optimized_config = opt_state["best_config"]
        final_lox_end_ratio = opt_state.get("best_lox_end_ratio", 0.7)
        final_fuel_end_ratio = opt_state.get("best_fuel_end_ratio", 0.7)
    else:
        optimized_config, P_O_final_psi, P_F_final_psi = apply_x_to_config(result.x, config_base)
        final_lox_end_ratio = P_O_final_psi / max_lox_P_psi if max_lox_P_psi > 0 else 0.7
        final_fuel_end_ratio = P_F_final_psi / max_fuel_P_psi if max_fuel_P_psi > 0 else 0.7
    
    # Ensure tank configs exist
    if optimized_config.lox_tank is None:
        from engine.pipeline.config_schemas import LOXTankConfig
        optimized_config.lox_tank = LOXTankConfig(lox_h=0.5, lox_radius=0.1, ox_tank_pos=1.0)
    if optimized_config.fuel_tank is None:
        from engine.pipeline.config_schemas import FuelTankConfig
        optimized_config.fuel_tank = FuelTankConfig(rp1_h=0.5, rp1_radius=0.1, fuel_tank_pos=0.5)
    
    # Extract optimized pressures
    best_x = opt_state.get("best_x", result.x if hasattr(result, 'x') else x0)
    if len(best_x) >= 10:
        P_O_start_optimized_psi = float(np.clip(best_x[8], bounds[8][0], bounds[8][1]))
        P_F_start_optimized_psi = float(np.clip(best_x[9], bounds[9][0], bounds[9][1]))
        optimized_config.lox_tank.initial_pressure_psi = P_O_start_optimized_psi
        optimized_config.fuel_tank.initial_pressure_psi = P_F_start_optimized_psi
    else:
        optimized_config.lox_tank.initial_pressure_psi = max_lox_P_psi * 0.8
        optimized_config.fuel_tank.initial_pressure_psi = max_fuel_P_psi * 0.8

    # Ensure orifice angle is 90°
    if hasattr(optimized_config, 'injector') and optimized_config.injector.type == "pintle":
        if hasattr(optimized_config.injector.geometry, 'lox'):
            optimized_config.injector.geometry.lox.theta_orifice = 90.0
    
    iteration_history = opt_state["history"]
    
    # Validation
    update_progress("Layer 1: Validation", 0.52, "Validating optimized configuration...")
    
    best_x = opt_state.get("best_x", result.x if hasattr(result, 'x') else x0)
    
    if "best_pressures" in opt_state and opt_state["best_pressures"] is not None:
        P_O_initial, P_F_initial = opt_state["best_pressures"]
    else:
        if best_x is not None and len(best_x) > 8:
            P_O_initial = float(np.clip(best_x[8], bounds[8][0], bounds[8][1])) * psi_to_Pa
        else:
            P_O_initial = max_lox_P_psi * psi_to_Pa * 0.95
        if best_x is not None and len(best_x) > 9:
            P_F_initial = float(np.clip(best_x[9], bounds[9][0], bounds[9][1])) * psi_to_Pa
        else:
            P_F_initial = max_fuel_P_psi * psi_to_Pa * 0.95
    
    optimized_config_runner = copy.deepcopy(optimized_config)
    if hasattr(optimized_config_runner, "ablative_cooling") and optimized_config_runner.ablative_cooling:
        optimized_config_runner.ablative_cooling.enabled = False
    if hasattr(optimized_config_runner, "graphite_insert") and optimized_config_runner.graphite_insert:
        optimized_config_runner.graphite_insert.enabled = False
    
    optimized_runner = PintleEngineRunner(optimized_config_runner)
    
    # Use stored validation results if available
    if "best_results_for_validation" in opt_state and opt_state["best_results_for_validation"] is not None:
        stored_results = opt_state["best_results_for_validation"]
        initial_performance = {
            "F": stored_results["F"],
            "MR": stored_results["MR"],
            "Isp": 250.0,
            "Pc": 2e6,
            "stability_results": stored_results.get("stability_results", {}),
        }
        initial_thrust_error = stored_results["thrust_error"]
        initial_MR_error = stored_results["of_error"]
        stored_stability_score = stored_results.get("stability_score", None)
        stored_stability_state = stored_results.get("stability_state", None)
        log_status("Layer 1 Validation", f"Using stored validation results: Thrust err {initial_thrust_error*100:.2f}%, O/F err {initial_MR_error*100:.2f}%")
        
        # For stored results, we need to re-evaluate to get P_exit and Cf
        # (stored_results only contains F, MR, errors, and stability)
        try:
            eval_results = optimized_runner.evaluate(P_O_initial, P_F_initial, P_ambient=target_P_exit)
            # Copy P_exit and Cf from evaluation if available
            if "P_exit" in eval_results:
                initial_performance["P_exit"] = eval_results["P_exit"]
            if "Cf" in eval_results or "Cf_actual" in eval_results:
                initial_performance["Cf"] = eval_results.get("Cf_actual", eval_results.get("Cf"))
                initial_performance["Cf_actual"] = initial_performance["Cf"]
            # Also copy other useful metrics that might be missing
            if "Isp" in eval_results:
                initial_performance["Isp"] = eval_results["Isp"]
            if "Pc" in eval_results:
                initial_performance["Pc"] = eval_results["Pc"]
            # Copy mass flow rates and efficiency metrics
            if "mdot_total" in eval_results:
                initial_performance["mdot_total"] = eval_results["mdot_total"]
            if "mdot_O" in eval_results:
                initial_performance["mdot_O"] = eval_results["mdot_O"]
            if "mdot_F" in eval_results:
                initial_performance["mdot_F"] = eval_results["mdot_F"]
            if "eta_cstar" in eval_results:
                initial_performance["eta_cstar"] = eval_results["eta_cstar"]
            if "cstar_actual" in eval_results:
                initial_performance["cstar_actual"] = eval_results["cstar_actual"]
            if "cstar_ideal" in eval_results:
                initial_performance["cstar_ideal"] = eval_results["cstar_ideal"]
            # Copy chamber_intrinsics (contains is_choked, etc.)
            if "chamber_intrinsics" in eval_results and eval_results["chamber_intrinsics"]:
                initial_performance["chamber_intrinsics"] = eval_results["chamber_intrinsics"]
        except Exception:
            # If re-evaluation fails, calculate Cf from available data
            F_val = initial_performance.get("F", 0)
            Pc_val = initial_performance.get("Pc", 0)
            A_throat_val = getattr(optimized_config.chamber, "A_throat", None)
            if A_throat_val and A_throat_val > 0 and Pc_val > 0:
                Cf_calculated = F_val / (Pc_val * A_throat_val)
                initial_performance["Cf_actual"] = Cf_calculated
                initial_performance["Cf"] = Cf_calculated
    else:
        initial_performance = optimized_runner.evaluate(P_O_initial, P_F_initial, P_ambient=target_P_exit)
        initial_thrust_error = abs(initial_performance.get("F", 0) - target_thrust) / target_thrust if target_thrust > 0 else 1.0
        initial_MR_error = abs(initial_performance.get("MR", 0) - optimal_of) / optimal_of if optimal_of > 0 else 1.0
        
        # Ensure Cf is included (calculate if not provided by runner)
        if "Cf" not in initial_performance and "Cf_actual" not in initial_performance:
            F_val = initial_performance.get("F", 0)
            Pc_val = initial_performance.get("Pc", 0)
            A_throat_val = getattr(optimized_config.chamber, "A_throat", None)
            if A_throat_val and A_throat_val > 0 and Pc_val > 0:
                Cf_calculated = F_val / (Pc_val * A_throat_val)
                initial_performance["Cf_actual"] = Cf_calculated
                initial_performance["Cf"] = Cf_calculated
    
    # Update chamber_geometry.Cf with the calculated thrust coefficient
    Cf_final = initial_performance.get("Cf_actual", initial_performance.get("Cf"))
    if Cf_final is not None and np.isfinite(Cf_final):
        if optimized_config.chamber_geometry is not None:
            optimized_config.chamber_geometry.Cf = float(Cf_final)
    
    # Check stability
    stored_results = opt_state.get("best_results_for_validation", {})
    if stored_results and "stability_results" in stored_results:
        stability_results = stored_results.get("stability_results", {})
        stability_state = stored_results.get("stability_state", "unstable")
        stability_score = stored_results.get("stability_score", 0.0)
        chugging_margin = stored_results.get("chugging_margin", 0)
        acoustic_margin = stored_results.get("acoustic_margin", 0)
        feed_margin = stored_results.get("feed_margin", 0)
    else:
        stability_results = initial_performance.get("stability_results", {})
        stability_state = stability_results.get("stability_state", "unstable")
        stability_score = stability_results.get("stability_score", 0.0)
        chugging_margin = stability_results.get("chugging", {}).get("stability_margin", 0)
        acoustic_margin = stability_results.get("acoustic", {}).get("stability_margin", 0)
        feed_margin = stability_results.get("feed_system", {}).get("stability_margin", 0)
    initial_stability = min(chugging_margin, acoustic_margin, feed_margin)
    
    # Validation checks
    min_stability_score = requirements.get("min_stability_score", 0.75)
    require_stable_state = requirements.get("require_stable_state", True)
    handicap = float(requirements.get("stability_margin_handicap", 0.0))
    score_factor = max(0.0, 1.0 - handicap)
    margin_factor = max(0.0, 1.0 - handicap)
    effective_min_score = min_stability_score * score_factor
    effective_margin = min_stability * margin_factor
    
    state_ok = (stability_state in {"stable", "marginal"}) if require_stable_state else (stability_state != "unstable")
    margin_tolerance = 0.05
    stability_check_passed = (
        state_ok and
        (stability_score >= effective_min_score) and
        (chugging_margin >= effective_margin * (1.0 - margin_tolerance)) and
        (acoustic_margin >= effective_margin * (1.0 - margin_tolerance)) and
        (feed_margin >= effective_margin * (1.0 - margin_tolerance))
    )
    
    thrust_check_passed = initial_thrust_error < thrust_tol * 1.0
    of_check_passed = initial_MR_error < 0.15
    
    # Geometry validation (consistency check for final result)
    A_throat_final = float(getattr(optimized_config.chamber_geometry, 'A_throat', 0.0))
    D_chamber_final = float(getattr(optimized_config.chamber_geometry, 'chamber_diameter', 0.0))
    A_chamber_final = np.pi * (D_chamber_final / 2) ** 2
    
    geometry_check_passed = True
    geometry_failure_reasons = []
    
    if A_chamber_final > 0 and A_throat_final > 0:
        contraction_ratio_final = A_chamber_final / A_throat_final
        if contraction_ratio_final < 1.1:
            geometry_check_passed = False
            geometry_failure_reasons.append(f"Throat area too large for chamber (contraction ratio {contraction_ratio_final:.2f} < 1.1)")
    
    if hasattr(optimized_config.injector, 'geometry') and hasattr(optimized_config.injector.geometry, 'fuel'):
        d_pintle_final = float(optimized_config.injector.geometry.fuel.d_pintle_tip)
        if d_pintle_final >= D_chamber_final:
            geometry_check_passed = False
            geometry_failure_reasons.append(f"Pintle diameter {d_pintle_final*1000:.1f}mm >= chamber diameter {D_chamber_final*1000:.1f}mm")
    
    # Chamber length constraint
    L_chamber_final = getattr(getattr(optimized_config, "chamber", None), "length", None)
    L_chamber_final = float(L_chamber_final) if (L_chamber_final is not None and np.isfinite(L_chamber_final)) else np.nan
    max_chamber_length = float(requirements.get("max_chamber_length_m", 0.50))
    
    if np.isfinite(L_chamber_final) and max_chamber_length > 0:
        if L_chamber_final > max_chamber_length:
            geometry_check_passed = False
            geometry_failure_reasons.append(f"Chamber length {L_chamber_final*1000:.1f}mm > max allowed {max_chamber_length*1000:.1f}mm")

    pressure_candidate_valid = thrust_check_passed and of_check_passed and stability_check_passed and geometry_check_passed
    
    # Build failure reasons
    failure_reasons = []
    if not thrust_check_passed:
        failure_reasons.append(f"Thrust error {initial_thrust_error*100:.1f}% > {thrust_tol*100:.0f}% limit")
    if not of_check_passed:
        failure_reasons.append(f"O/F error {initial_MR_error*100:.1f}% > 15% limit")
    if not geometry_check_passed:
        failure_reasons.extend(geometry_failure_reasons)
    if not stability_check_passed:
        required_parts = []
        if require_stable_state:
            if stability_state not in {"stable", "marginal"}:
                required_parts.append(f"state ∈ {{stable,marginal}} (got '{stability_state}')")
        else:
            if stability_state == "unstable":
                required_parts.append("state!='unstable'")
        if stability_score < effective_min_score:
            required_parts.append(f"score>={effective_min_score:.2f} (got {stability_score:.2f})")
        if chugging_margin < effective_margin:
            required_parts.append(f"chugging_margin>={effective_margin:.2f} (got {chugging_margin:.2f})")
        if acoustic_margin < effective_margin:
            required_parts.append(f"acoustic_margin>={effective_margin:.2f} (got {acoustic_margin:.2f})")
        if feed_margin < effective_margin:
            required_parts.append(f"feed_margin>={effective_margin:.2f} (got {feed_margin:.2f})")
        if not required_parts:
            required_parts.append("stability gate mismatch")
        failure_reasons.append(f"Stability failed: {'; '.join(required_parts)}")
    
    if not pressure_candidate_valid and not failure_reasons:
        failure_reasons.append("Validation failed: no requirements met")
    
    # Log validation
    if pressure_candidate_valid:
        update_progress("Layer 1: Validation", 0.53, f"✓ VALID - Thrust err: {initial_thrust_error*100:.1f}%, O/F err: {initial_MR_error*100:.1f}%, Stability: {stability_state}")
        log_status("Layer 1", f"VALID | Thrust err {initial_thrust_error*100:.1f}%, O/F err {initial_MR_error*100:.1f}%, Stability {stability_state}")
        layer1_logger.info("✓ Validation: VALID")
    else:
        update_progress("Layer 1: Validation", 0.53, f"✗ INVALID - {'; '.join(failure_reasons)}")
        log_status("Layer 1", f"INVALID | Reasons: {', '.join(failure_reasons)}")
        layer1_logger.warning(f"✗ Validation: INVALID - {'; '.join(failure_reasons)}")
    
    # Build final performance dict
    final_performance = initial_performance.copy()
    final_performance["pressure_candidate_valid"] = pressure_candidate_valid
    final_performance["initial_thrust_error"] = initial_thrust_error
    final_performance["initial_MR_error"] = initial_MR_error
    final_performance["initial_stability"] = initial_stability
    final_performance["initial_stability_state"] = stability_state
    final_performance["initial_stability_score"] = stability_score
    final_performance["thrust_check_passed"] = thrust_check_passed
    final_performance["of_check_passed"] = of_check_passed
    final_performance["stability_check_passed"] = stability_check_passed
    final_performance["geometry_check_passed"] = geometry_check_passed
    final_performance["failure_reasons"] = failure_reasons
    # Add individual stability margins at root level for easy access
    final_performance["chugging_margin"] = chugging_margin
    final_performance["acoustic_margin"] = acoustic_margin
    final_performance["feed_margin"] = feed_margin
    
    # Extract optimized pressures
    if len(best_x) >= 10:
        P_O_start_optimized_psi = float(np.clip(best_x[8], bounds[8][0], bounds[8][1]))
        P_F_start_optimized_psi = float(np.clip(best_x[9], bounds[9][0], bounds[9][1]))
        final_performance["P_O_start_psi"] = P_O_start_optimized_psi
        final_performance["P_F_start_psi"] = P_F_start_optimized_psi
        final_performance["P_O_start_ratio"] = P_O_start_optimized_psi / max_lox_P_psi if max_lox_P_psi > 0 else 0.0
        final_performance["P_F_start_ratio"] = P_F_start_optimized_psi / max_fuel_P_psi if max_fuel_P_psi > 0 else 0.0
    else:
        final_performance["P_O_start_psi"] = max_lox_P_psi * 0.8
        final_performance["P_F_start_psi"] = max_fuel_P_psi * 0.8
        final_performance["P_O_start_ratio"] = 0.8
        final_performance["P_F_start_ratio"] = 0.8
    
    # Add chamber_intrinsics from initial_performance (contains is_choked, etc.)
    if "chamber_intrinsics" in initial_performance:
        final_performance["chamber_intrinsics"] = initial_performance["chamber_intrinsics"]
    
    # Calculate and add effective_injector_area_ratio
    # This is the ratio of (effective injector area) / (throat area)
    # Effective injector area = max(A_lox_injector, A_fuel_injector) with Cd weighting
    try:
        from engine.pipeline.config_schemas import ensure_chamber_geometry
        cg = ensure_chamber_geometry(optimized_config)
        A_throat_final = float(cg.A_throat) if cg.A_throat and cg.A_throat > 0 else None
        
        inj = getattr(optimized_config, 'injector', None)
        inj_geom = getattr(inj, 'geometry', None) if inj else None
        is_pintle = getattr(inj, 'type', None) == 'pintle' if inj else False
        
        if is_pintle and inj_geom and A_throat_final:
            # LOX injector area (discrete orifices)
            lox_geom = getattr(inj_geom, 'lox', None)
            fuel_geom = getattr(inj_geom, 'fuel', None)
            
            if lox_geom and fuel_geom:
                n_orifices = float(getattr(lox_geom, 'n_orifices', 0))
                d_orifice = float(getattr(lox_geom, 'd_orifice', 0))
                d_pintle_tip = float(getattr(fuel_geom, 'd_pintle_tip', 0))
                h_gap = float(getattr(fuel_geom, 'h_gap', 0))
                Cd_lox = float(getattr(lox_geom, 'Cd', 0.65))
                Cd_fuel = float(getattr(fuel_geom, 'Cd', 0.4))
                
                A_lox_injector = n_orifices * np.pi * (d_orifice / 2) ** 2 if d_orifice > 0 else 0.0
                R_inner = d_pintle_tip / 2
                R_outer = R_inner + h_gap
                A_fuel_injector = np.pi * (R_outer ** 2 - R_inner ** 2) if h_gap > 0 else 0.0
                
                # Effective areas (Cd-weighted geometric areas)
                A_lox_effective = Cd_lox * A_lox_injector
                A_fuel_effective = Cd_fuel * A_fuel_injector
                
                # Total effective injector area (sum of both propellants)
                A_injector_total_effective = A_lox_effective + A_fuel_effective
                
                # Ratio of total effective injector area to throat area
                effective_injector_area_ratio = A_injector_total_effective / A_throat_final
                final_performance["effective_injector_area_ratio"] = float(effective_injector_area_ratio)
    except Exception as e:
        layer1_logger.debug(f"Could not calculate effective_injector_area_ratio: {e}")
    
    # Build results dict
    results = {
        "performance": final_performance,
        "iteration_history": iteration_history,
        "convergence_info": {
            "converged": opt_state["converged"],
            "iterations": len(iteration_history),
            "final_change": opt_state["best_objective"],
        },
        "exit_pressure_targeting": {
            "target_P_exit": target_P_exit,  # Atmospheric pressure from environment config (GPS/GFS-derived)
        },
        "optimized_pressure_curves": {
            "lox_end_ratio": final_lox_end_ratio,
            "fuel_end_ratio": final_fuel_end_ratio,
            "lox_start_psi": final_performance["P_O_start_psi"],
            "fuel_start_psi": final_performance["P_F_start_psi"],
        },
        "layer_status": {
            "layer_1_pressure_candidate": pressure_candidate_valid,
        },
        "optimized_parameters": extract_all_parameters(optimized_config),
    }
    
    # Final summary logging
    layer1_logger.info("")
    layer1_logger.info("="*70)
    layer1_logger.info("Final Results Summary")
    layer1_logger.info("="*70)
    if "best_results_for_validation" in opt_state and opt_state["best_results_for_validation"] is not None:
        stored = opt_state["best_results_for_validation"]
        layer1_logger.info(f"Thrust: {stored.get('F', 0):.1f} N (target: {target_thrust:.1f} N)")
        layer1_logger.info(f"Thrust error: {stored.get('thrust_error', 0)*100:.2f}%")
        layer1_logger.info(f"O/F ratio: {stored.get('MR', 0):.3f} (target: {optimal_of:.3f})")
        layer1_logger.info(f"O/F error: {stored.get('of_error', 0)*100:.2f}%")
        layer1_logger.info(f"Stability state: {stored.get('stability_state', 'unknown')}")
        layer1_logger.info(f"Stability score: {stored.get('stability_score', 0):.3f}")
        layer1_logger.info(f"Chugging margin: {stored.get('chugging_margin', 0):.3f}")
        layer1_logger.info(f"Acoustic margin: {stored.get('acoustic_margin', 0):.3f}")
        layer1_logger.info(f"Feed margin: {stored.get('feed_margin', 0):.3f}")
    if final_performance.get("P_O_start_psi") is not None:
        layer1_logger.info(f"LOX initial pressure: {final_performance['P_O_start_psi']:.1f} psi")
    if final_performance.get("P_F_start_psi") is not None:
        layer1_logger.info(f"Fuel initial pressure: {final_performance['P_F_start_psi']:.1f} psi")
    layer1_logger.info(f"Validation: {'VALID' if pressure_candidate_valid else 'INVALID'}")
    
    # Log objective function breakdown if objective > 1e0 (indicates non-ideal convergence)
    best_obj_value = opt_state.get("best_objective", float('inf'))
    if best_obj_value > 1.0:
        layer1_logger.info("")
        layer1_logger.info("-"*70)
        layer1_logger.info(f"⚠ Objective Function Breakdown (objective = {best_obj_value:.6f} > 1.0)")
        layer1_logger.info("-"*70)
        breakdown = opt_state.get("best_objective_breakdown", {})
        if breakdown:
            if breakdown.get("is_infeasible", False):
                layer1_logger.info("Solution is INFEASIBLE:")
                if breakdown.get("length_violation", False):
                    layer1_logger.info(f"  • Chamber length violation penalty: {breakdown.get('infeasibility_penalty', 0):.6f}")
                else:
                    layer1_logger.info(f"  • Infeasibility penalty (constraints violated): {breakdown.get('infeasibility_penalty', 0):.6f}")
            else:
                layer1_logger.info("Objective component contributions:")
                # Sort by contribution (largest first)
                components = [
                    ("Thrust penalty", breakdown.get("thrust_penalty", 0)),
                    ("O/F ratio penalty", breakdown.get("of_penalty", 0)),
                    ("Cf band penalty", breakdown.get("cf_penalty", 0)),
                    ("Exit pressure penalty", breakdown.get("exit_pressure_penalty", 0)),
                    ("Injector ΔP penalty", breakdown.get("injector_dp_penalty", 0)),
                    ("Chamber length penalty", breakdown.get("length_penalty", 0)),
                ]
                # Sort by value descending
                components.sort(key=lambda x: x[1], reverse=True)
                total = sum(c[1] for c in components)
                for name, value in components:
                    if value > 0 or total > 0:
                        pct = (value / total * 100) if total > 0 else 0.0
                        layer1_logger.info(f"  • {name}: {value:.6f} ({pct:.1f}%)")
                layer1_logger.info(f"  Total: {total:.6f}")
        else:
            layer1_logger.info("  (component breakdown not available)")
        layer1_logger.info("-"*70)
    
    layer1_logger.info("="*70)
    layer1_logger.info("")
    layer1_logger.info(f"Layer 1 optimization complete. Log saved to: {log_file_path}")
    
    # Clean up handler to prevent file handle issues
    layer1_logger.handlers.clear()
    
    update_progress("Layer 1: Complete", 1.0, "Layer 1 optimization complete!")
    

    return optimized_config, results


class ElitePool:
    """Manages a pool of top-K elite solutions."""
    def __init__(self, k: int = 50):
        self.k = k
        self.points = []  # List of tuples (f_val, x_array)

    def add(self, x: np.ndarray, f: float):
        """Add a candidate to the pool if it's good enough."""
        # Check for duplicates (optional, simple distance check or exact match)
        # For simplicity in this iteration, just naive add & sort
        self.points.append((f, np.asarray(x, dtype=float).copy()))
        # Sort by f (ascending, minimization)
        self.points.sort(key=lambda item: item[0])
        # Keep top k
        if len(self.points) > self.k:
            self.points = self.points[:self.k]

    def get_elites(self) -> Tuple[np.ndarray, np.ndarray]:
        """Return (X, F) arrays of current elites."""
        if not self.points:
            return np.array([]), np.array([])
        f_vals = np.array([p[0] for p in self.points])
        x_vals = np.array([p[1] for p in self.points])
        return x_vals, f_vals

    def get_best(self) -> Tuple[np.ndarray, float]:
        """Return best solution found so far."""
        if not self.points:
            return None, float('inf')
        return self.points[0][1], self.points[0][0]


def run_cma_core(
    objective_fn: Callable[[np.ndarray], float],
    x0: np.ndarray,
    sigma0: float,
    bounds: list,
    budget: int,
    popsize: int,
    cma_stds: np.ndarray = None,
    seed: int = None,
    elite_pool: Optional[ElitePool] = None,
    # Optional logic for penalty/validity
    true_objective_fn: Optional[Callable[[np.ndarray], float]] = None,
    valley_escape_tracker: Optional[Dict[str, Any]] = None,
    logger = None,
    # Parallel evaluation support
    executor: Optional[ProcessPoolExecutor] = None,
    integer_dims: Optional[list] = None,
    eval_cache: Optional[dict] = None,
    make_cache_key_fn: Optional[Callable[[np.ndarray], Tuple[int, ...]]] = None,
    stop_event: Optional[Any] = None,  # threading.Event for stop signal
) -> Tuple[np.ndarray, float, int]:
    """
    Core re-usable CMA-ES wrapper with optional parallel evaluation.
    
    Args:
        objective_fn: The function CMA-ES optimizes (could include penalties).
        x0: Initial mean.
        sigma0: Initial step size.
        bounds: List of (min, max) for EACH dimension.
        budget: Max function evaluations.
        popsize: Population size.
        cma_stds: Coordinate-wise standard deviations (optional scaling).
        seed: Random seed.
        elite_pool: Optional pool to capture all candidates evaluated.
        true_objective_fn: If provided, used to evaluate candidates for ElitePool 
                           and best-so-far tracking (ignoring the penalized objective).
                           If None, objective_fn is used.
        executor: Optional ProcessPoolExecutor for parallel evaluation.
        integer_dims: List of integer dimension indices for snapping.
        eval_cache: Optional evaluation cache dict.
                           
    Returns:
        (best_x, best_f, evals_used)
        Note: best_f returned is the one derived from true_objective_fn if present,
        otherwise objective_fn.
    """
    if cma is None:
        raise ImportError("CMA-ES required")
    
    # Prepare bounds for CMA
    lower_bounds = np.array([b[0] for b in bounds])
    upper_bounds = np.array([b[1] for b in bounds])
    
    # Options
    opts = {
        "bounds": [lower_bounds.tolist(), upper_bounds.tolist()],
        "popsize": popsize,
        "maxiter": budget, # Rough upper bound, we track evals manually better
        "verb_disp": 0,
        "verb_log": 0,
        "tolx": 1e-8,
        "tolfun": 1e-9,
        "tolstagnation": 50,
        "ftarget": -np.inf, 
        "seed": seed,
    }
    if cma_stds is not None:
        opts["CMA_stds"] = cma_stds.tolist()

    # Initialize
    # Ensure x0 is within bounds
    x0_clamped = np.clip(x0, lower_bounds, upper_bounds)
    
    evals = 0
    best_x = x0_clamped.copy()
    
    # Initial eval
    if true_objective_fn:
        best_f = true_objective_fn(best_x)
    else:
        best_f = objective_fn(best_x)

    # CMA object
    # CMA expects list for x0
    es = cma.CMAEvolutionStrategy(x0_clamped.tolist(), sigma0, opts)
    
    stop_loop = False
    
    while not es.stop() and not stop_loop:
        # Check if optimization should stop
        if stop_event is not None and stop_event.is_set():
            raise RuntimeError("Optimization stopped by user")
        
        if evals >= budget:
            break
            
        # Check for Valley Escape boost if tracker provided
        if valley_escape_tracker is not None:
            evals_now = valley_escape_tracker.get("function_evaluations", 0)
            best_f_tracker = valley_escape_tracker.get("best_objective", float('inf'))
            last_best = valley_escape_tracker.get("last_best_eval", 0)
            stagnation = evals_now - last_best
            current_tier = valley_escape_tracker.get("valley_escape_tier", 0)
            cooldown = valley_escape_tracker.get("cooldown_until", 0)
            
            target_tier = 0
            if evals_now > 5000 and best_f_tracker > 100.0 and stagnation > 1000: target_tier = 3
            elif evals_now > 3000 and best_f_tracker > 150.0 and stagnation > 500: target_tier = 2
            elif evals_now > 1500 and best_f_tracker > 300.0 and stagnation > 300: target_tier = 1
            
            if target_tier > current_tier and evals_now > cooldown:
                # Apply boost
                boost_factors = [1.0, 2.0, 4.0, 8.0]
                relative_boost = boost_factors[target_tier] / boost_factors[current_tier]
                
                old_sigma = es.sigma
                es.sigma *= relative_boost
                
                # Clamp sigma to 50% of the entire span (much looser)
                # We want to allow large jumps if needed to escape deep local minima
                span_vals = upper_bounds - lower_bounds
                max_sigma = 0.5 * float(np.max(span_vals))
                if es.sigma > max_sigma:
                    es.sigma = max_sigma
                
                # Update tracker
                valley_escape_tracker["valley_escape_tier"] = target_tier
                valley_escape_tracker["cooldown_until"] = evals_now + 1000
                
                if logger:
                    tier_names = ["None", "Mild", "Medium", "Full"]
                    logger.info("!" * 20)
                    logger.info(f"VALLEY ESCAPE TRIGGERED in run_cma_core (Tier: {tier_names[target_tier]})")
                    logger.info(f"Evals: {evals_now}, Best: {best_f_tracker:.2f}, Stagnation: {stagnation}")
                    logger.info(f"Sigma: {old_sigma:.6f} -> {es.sigma:.6f} (Boost: {relative_boost:.2f}x)")
                    logger.info("!" * 20)

        candidates = es.ask()
        
        # PARALLEL EVALUATION PATH
        if executor is not None and integer_dims is not None:
            # Snap integer dimensions for consistency
            candidates_snapped = [
                _snap_integer_dims(np.asarray(c, dtype=np.float64), integer_dims)
                for c in candidates
            ]
            
            # Parent-side caching if cache provided
            if eval_cache is not None and make_cache_key_fn is not None:
                cache_keys = [make_cache_key_fn(c) for c in candidates_snapped]
                uncached_indices = []
                uncached_candidates = []
                fitness_values = [None] * len(candidates)
                
                for i, key in enumerate(cache_keys):
                    if key in eval_cache:
                        cached_val = eval_cache[key]
                        # Handle dict format from parallel eval (has 'value' key)
                        # Note: dict format from objective() has 'results' but not 'value', so we can't use it here
                        if isinstance(cached_val, dict) and 'value' in cached_val:
                            fitness_values[i] = float(cached_val['value'])
                        elif isinstance(cached_val, (int, float)):
                            # Old format: direct float value (backward compatibility)
                            fitness_values[i] = float(cached_val)
                        else:
                            # Full format from objective() or unknown format - can't extract value, treat as uncached
                            uncached_indices.append(i)
                            uncached_candidates.append(candidates_snapped[i])
                    else:
                        uncached_indices.append(i)
                        uncached_candidates.append(candidates_snapped[i])
                
                # Parallel evaluation of uncached candidates
                if uncached_candidates:
                    num_workers = executor._max_workers
                    chunksize = max(1, len(uncached_candidates) // (num_workers * 4))
                    results = list(executor.map(_eval_candidate, uncached_candidates, chunksize=chunksize))
                    
                    # Merge results back
                    for idx, res in zip(uncached_indices, results):
                        obj_val = res['value']
                        fitness_values[idx] = obj_val
                        # Store in dict format for compatibility with objective() cache format
                        eval_cache[cache_keys[idx]] = {
                            'value': obj_val,
                            'success': res.get('success', True),
                        }
                        evals += 1
                        
                        # Update best and elite pool using true objective
                        if res['success']:
                            # For hybrid mode, we use the same objective for both
                            # (true_objective_fn is typically None in hybrid mode)
                            if obj_val < best_f:
                                best_f = obj_val
                                best_x = candidates_snapped[idx].copy()
                            
                            if elite_pool:
                                elite_pool.add(candidates_snapped[idx], obj_val)
                        
                        if evals >= budget:
                            stop_loop = True
                
                # Count cached evals
                for i, val in enumerate(fitness_values):
                    if val is not None and i not in uncached_indices:
                        evals += 1  # Count cache hits as evals for budget tracking
            else:
                # No caching - evaluate all in parallel
                num_workers = executor._max_workers
                chunksize = max(1, len(candidates_snapped) // (num_workers * 4))
                results = list(executor.map(_eval_candidate, candidates_snapped, chunksize=chunksize))
                
                fitness_values = []
                for i, res in enumerate(results):
                    obj_val = res['value']
                    fitness_values.append(obj_val)
                    evals += 1
                    
                    if res['success']:
                        if obj_val < best_f:
                            best_f = obj_val
                            best_x = candidates_snapped[i].copy()
                        
                        if elite_pool:
                            elite_pool.add(candidates_snapped[i], obj_val)
                    
                    if evals >= budget:
                        stop_loop = True
        else:
            # SEQUENTIAL EVALUATION PATH (original code)
            fitness_values = []
            
            for cand in candidates:
                # Clip candidate for evaluation
                cand_arr = np.clip(np.asarray(cand, dtype=float), lower_bounds, upper_bounds)
                
                # 1. Penalized objective (for CMA ranking)
                val_penalized = objective_fn(cand_arr)
                fitness_values.append(val_penalized)
                evals += 1
                
                # 2. True objective (for elites / best tracking)
                if true_objective_fn:
                    val_true = true_objective_fn(cand_arr)
                else:
                    val_true = val_penalized
                    
                # Update local best using TRUE value
                if val_true < best_f:
                    best_f = val_true
                    best_x = cand_arr.copy()
                    
                # Add to elite pool
                if elite_pool:
                    elite_pool.add(cand_arr, val_true)
                
                if evals >= budget:
                    stop_loop = True
                    
        es.tell(candidates, fitness_values)
        
    return best_x, best_f, evals



def compute_blocks_from_elites(
    elite_pool: ElitePool,
    num_blocks: int,
    dim: int,
    method: str = "random",
    overlap_fraction: float = 0.0,
    rng: np.random.Generator = None,
) -> list[list[int]]:
    """
    Compute variable blocks for re-optimization.
    
    Methods:
    - "random": Randomly partition variables.
    - "corr_greedy": Use correlation matrix of standardized elites. 
      Distance = 1 - abs(Correlation).
    """
    if rng is None:
        rng = np.random.default_rng()
        
    all_indices = np.arange(dim)
    
    if method == "corr_greedy" and len(elite_pool.points) > dim + 2:
        # 1. Get elites X (size K x dim)
        X_raw, _ = elite_pool.get_elites()
        
        # 2. Standardize X (zero mean, unit variance) to avoid scale bias
        # Handle zero variance dimensions safely
        stds = np.std(X_raw, axis=0)
        valid_dims = stds > 1e-12
        X_std = np.zeros_like(X_raw)
        X_std[:, valid_dims] = (X_raw[:, valid_dims] - np.mean(X_raw[:, valid_dims], axis=0)) / stds[valid_dims]
        
        # 3. Compute correlation matrix (not covariance!)
        # Shape (dim, dim)
        if len(X_std) > 1:
            corr_mat = np.corrcoef(X_std, rowvar=False)
            # Handle NaNs if they appear (e.g. constant columns)
            corr_mat = np.nan_to_num(corr_mat, nan=0.0)
        else:
            # Fallback if not enough points
            corr_mat = np.eye(dim)
            
        # 4. Computed distance metric: d_ij = 1 - abs(corr_ij)
        dist_mat = 1.0 - np.abs(corr_mat)
        
        # 5. Greedy clustering
        # Start with unassigned, pick one, add nearest neighbors until block filled
        unassigned = set(all_indices)
        blocks = []
        target_block_size = int(np.ceil(dim / num_blocks))
        
        while unassigned:
            if len(blocks) == num_blocks - 1:
                # Last block takes all remaining
                blocks.append(list(unassigned))
                break
                
            # Pick seed (random or first available)
            seed = list(unassigned)[0]
            current_block = [seed]
            unassigned.remove(seed)
            
            # Add N nearest neighbors
            while len(current_block) < target_block_size and unassigned:
                # Find nearest to *any* in current block? Or centroid?
                # Simple: nearest to seed or mean distance to block
                # Let's do min-average-distance to current block
                candidates = list(unassigned)
                
                # Compute avg dist to current block for each candidate
                # dist_mat[c, current_block]
                avg_dists = [np.mean(dist_mat[c, current_block]) for c in candidates]
                best_cand_idx = np.argmin(avg_dists)
                best_cand = candidates[best_cand_idx]
                
                current_block.append(best_cand)
                unassigned.remove(best_cand)
                
            blocks.append(current_block)
        
        # If we have overlap
        if overlap_fraction > 0:
            # Overlap implementation:
            # Start each block with 'overlap' amount of indices from the previous block
            # This logic modifies the 'blocks' list we just created.
            # However simple partition-based generation above doesn't support overlap naturally.
            # Let's refine: The greedy approach above created partition.
            # To add overlap: Append N items from block[i-1] to block[i]
            # EXCEPT for first block.
            
            # Note: This increases total size, so "target_block_size" in previous step was for partition.
            overlap_count = int(np.ceil(target_block_size * overlap_fraction))
            if overlap_count > 0:
                for i in range(1, len(blocks)):
                    # Get overlap candidates from previous block (random or specific?)
                    # Random is safest to avoid bias
                    prev_block = blocks[i-1]
                    if len(prev_block) > 0:
                        overlap_indices = rng.choice(prev_block, size=min(len(prev_block), overlap_count), replace=False)
                        # Add to current
                        blocks[i].extend(overlap_indices)
                        # Uniquify just in case
                        blocks[i] = list(set(blocks[i]))
            
        return blocks
    else:
        # Fallback to random
        perm = rng.permutation(dim)
        # Split into ~equal chunks
        blocks = [list(a) for a in np.array_split(perm, num_blocks)]
        return blocks


def run_hybrid_optimization(
    objective: Callable[[np.ndarray], float],
    bounds: list,
    x0: np.ndarray,
    hybrid_config: HybridOptimizerConfig,
    total_budget: int = 3000,
    logger = None,
    log_status_fn = None, 
    update_progress_fn = None,
    valley_escape_tracker: Optional[Dict[str, Any]] = None,
    # Parallel evaluation support
    executor: Optional[ProcessPoolExecutor] = None,
    integer_dims: Optional[list] = None,
    eval_cache: Optional[dict] = None,
    make_cache_key_fn: Optional[Callable[[np.ndarray], Tuple[int, ...]]] = None,
    stop_event: Optional[Any] = None,  # threading.Event for stop signal
) -> Tuple[np.ndarray, float, int]:
    """
    Run Hybrid CMA-ES + Block Re-optimization.
    
    Logic:
    1. Stage A: Global Exploration (Standard CMA-ES)
    2. Loop Cycles:
       a. Stage B: Build Blocks (Random or Correlation-based)
       b. Stage C: Block Re-optimization (Soft freezing)
    3. Stage D: Global Refresh (Periodic)
    
    Args:
        objective: Main objective function (returns float).
        bounds: List of (min, max).
        x0: Initial guess.
        hybrid_config: Configuration.
        total_budget: Max evals.
        
    Returns:
        (best_x, best_f, total_evals)
    """
    evals_used = 0
    dim = len(x0)
    
    # Setup constraints/bounds arrays
    lower_bounds = np.array([b[0] for b in bounds])
    upper_bounds = np.array([b[1] for b in bounds])
    span = upper_bounds - lower_bounds
    
    # 1. Initialize Elite Pool
    elite_pool = ElitePool(k=hybrid_config.elite_k)
    
    # 2. Budget allocation
    # Reserve slice for Stage A
    # The rest is split among cycles
    stage_a_budget = int(total_budget * (1.0 - hybrid_config.per_block_budget_fraction))
    block_budget_total = total_budget - stage_a_budget
    
    if hybrid_config.cycles > 0 and hybrid_config.num_blocks > 0:
        per_cycle_budget = block_budget_total // hybrid_config.cycles
        if hybrid_config.refresh_every_pass:
             # Subtract refresh budget from per-cycle
             refresh_cost = int(total_budget * hybrid_config.refresh_budget_fraction)
             per_cycle_budget = max(0, per_cycle_budget - refresh_cost)
    else:
        per_cycle_budget = 0
        
    # --- STAGE A: Global Exploration (CMA-ES) ---
    if update_progress_fn: update_progress_fn("Hybrid: Stage A", 0.1, "Global Exploration")
    if logger: logger.info(f"Stage A: Global Search (Budget: {stage_a_budget})")
    
    # Setup CMA stds
    sigma0 = 0.25 * float(np.percentile(span, 25)) # Heuristic 25% of 25th percentile span
    cma_stds = span / (4.0 * sigma0) # Normalize so sigma*std roughly covers range
    
    # We use a randomized restart wrapper for Stage A to ensure good coverage
    # But for simplicity we call run_cma_core once with restart logic INTERNAL if we wanted,
    # but run_cma_core is single run.
    # Let's do 2 quick restarts in Stage A budget if budget allows
    
    best_x_global = x0.copy()
    valid_f = objective(best_x_global)
    elite_pool.add(best_x_global, valid_f)
    best_f_global = valid_f
    
    # Split Stage A budget into 2 restarts
    budget_a1 = int(stage_a_budget * 0.6)
    budget_a2 = stage_a_budget - budget_a1
    
    # Run 1
    x_res, f_res, evs = run_cma_core(
        objective, x0, sigma0, bounds, budget_a1, 
        popsize=16, cma_stds=cma_stds, elite_pool=elite_pool,
        valley_escape_tracker=valley_escape_tracker, logger=logger,
        # Parallel evaluation
        executor=executor, integer_dims=integer_dims, eval_cache=eval_cache,
        make_cache_key_fn=make_cache_key_fn,
        stop_event=stop_event,
    )
    evals_used += evs
    if f_res < best_f_global:
        best_f_global = f_res
        best_x_global = x_res
        
    # Run 2 (Restart from best or random?)
    # Valid restart: Perturb best logic
    rng = np.random.default_rng()
    x0_2 = best_x_global + rng.standard_normal(dim) * (0.01 * span) # Small perturbation
    
    if budget_a2 > 100:
        x_res, f_res, evs = run_cma_core(
            objective, x0_2, sigma0 * 0.5, bounds, budget_a2, 
            popsize=16, cma_stds=cma_stds, elite_pool=elite_pool,
            valley_escape_tracker=valley_escape_tracker, logger=logger,
            # Parallel evaluation
            executor=executor, integer_dims=integer_dims, eval_cache=eval_cache,
            make_cache_key_fn=make_cache_key_fn,
            stop_event=stop_event,
        )
        evals_used += evs
        if f_res < best_f_global:
            best_f_global = f_res
            best_x_global = x_res
            
    if logger: logger.info(f"Stage A Complete. Best f: {best_f_global:.5f}")
    
    # --- CYCLES ---
    current_x = best_x_global.copy()
    
    for cycle_idx in range(hybrid_config.cycles):
        # Check if optimization should stop
        if stop_event is not None and stop_event.is_set():
            raise RuntimeError("Optimization stopped by user")
        
        if update_progress_fn: 
            update_progress_fn(f"Hybrid: Cycle {cycle_idx+1}", 0.3 + 0.6*(cycle_idx/max(1,hybrid_config.cycles)), f"Block Optimization ({hybrid_config.block_method})")
            
        cycle_budget = per_cycle_budget
        
        # --- STAGE B: Build Blocks ---
        blocks = compute_blocks_from_elites(
            elite_pool, hybrid_config.num_blocks, dim, 
            method=hybrid_config.block_method, 
            overlap_fraction=hybrid_config.overlap_fraction,
            rng=rng
        )
        
        if logger: logger.info(f"Cycle {cycle_idx+1}: Created {len(blocks)} blocks using {hybrid_config.block_method} (Overlap: {hybrid_config.overlap_fraction})")
        
        # Calculate penalty weight
        # λ_eff = λ_schedule * f_scale / ||x||^2
        # Determine f_scale
        _, f_vals_elite = elite_pool.get_elites()
        if len(f_vals_elite) > 0:
            f_scale = np.median(np.abs(f_vals_elite))
        else:
            f_scale = max(1.0, abs(best_f_global))
            
        if not hybrid_config.lambda_normalize:
            f_scale = 1.0 # Use raw user lambda
            
        base_lambda = hybrid_config.lambda0 * (hybrid_config.lambda_mult ** cycle_idx)
        base_lambda = min(base_lambda, hybrid_config.lambda_max)
        
        # --- STAGE C: Block Re-optimization ---
        if len(blocks) > 0:
            budget_per_block = cycle_budget // len(blocks)
        else:
            budget_per_block = 0
        
        for b_i, block_indices in enumerate(blocks):
            if budget_per_block < 20: continue # Skip if too small
            
            non_block_indices = [i for i in range(dim) if i not in block_indices]
            
            # Constants for this block run
            x_fixed_vals = current_x[non_block_indices]
            
            # Define block bounds
            block_lower = lower_bounds[block_indices]
            block_upper = upper_bounds[block_indices]
            block_bounds = list(zip(block_lower, block_upper))
            
            # Initial mean for this block
            z0 = current_x[block_indices]
            
            # Objective wrapper
            def block_obj_fn(z):
                # Stitch
                full_x = current_x.copy() # Start with current baseline
                full_x[block_indices] = z # Overwrite block
                # Clip full x to be safe
                full_x = np.clip(full_x, lower_bounds, upper_bounds)
                return objective(full_x)
                
            # Run CMA on block
            # Scaling: use same heuristic (25% of block range)
            z_span = block_upper - block_lower
            z_sigma = 0.2 * np.median(z_span) # Slightly smaller for local block
            # Apply additional boost to block sigma if valley escape is active
            if valley_escape_tracker is not None:
                tier = valley_escape_tracker.get("valley_escape_tier", 0)
                if tier > 0:
                    # Block reopt: smaller boost (1.2 - 1.8x)
                    block_boost = 1.0 + (tier * 0.2) # Tier 1: 1.2, Tier 2: 1.4, Tier 3: 1.6
                    z_sigma *= block_boost
            
            z_best, z_f, z_evals = run_cma_core(
                block_obj_fn, z0, z_sigma, block_bounds, budget_per_block,
                popsize=max(8, 4 + int(3 * np.log(len(z0)+1))), # Smaller pop for blocks
                elite_pool=None, 
                true_objective_fn=block_obj_fn,
                valley_escape_tracker=valley_escape_tracker, logger=logger,
                make_cache_key_fn=make_cache_key_fn,
                stop_event=stop_event,
            )
            
            evals_used += z_evals
            
            # Update current_x if improved
            if z_f < objective(current_x): # Re-eval current_x or use trusted value?
                 current_x[block_indices] = z_best
                 if z_f < best_f_global:
                     best_f_global = z_f
                     best_x_global = current_x.copy()
                     if logger: logger.info(f"    Block {b_i} improved global best -> {best_f_global:.5f}")
            
            # Also add the new best to elite pool
            elite_pool.add(current_x, z_f)
            
        # --- STAGE D: Global Refresh ---
        if hybrid_config.refresh_every_pass:
            ref_budget = int(total_budget * hybrid_config.refresh_budget_fraction)
            if ref_budget > 50:
                if logger: logger.info(f"Cycle {cycle_idx+1}: Global Refresh (Budget {ref_budget})")
                
                # Start around current best
                x_ref = best_x_global.copy()
                
                # Reduced sigma
                # User req 4: "sigma = refresh_sigma_scale * sigma_initial"
                sigma_ref = sigma0 * hybrid_config.refresh_sigma_scale
                
                # Apply additional boost to refresh sigma if valley escape is active
                if valley_escape_tracker is not None:
                    tier = valley_escape_tracker.get("valley_escape_tier", 0)
                    if tier > 0:
                        # Global refresh: larger boost (1.5 - 2.5x)
                        refresh_boost = 1.0 + (tier * 0.5) # Tier 1: 1.5, Tier 2: 2.0, Tier 3: 2.5
                        sigma_ref *= refresh_boost

                x_ref_res, f_ref_res, evs_ref = run_cma_core(
                    objective, x_ref, sigma_ref, bounds, ref_budget,
                    popsize=16, cma_stds=cma_stds, elite_pool=elite_pool,
                    valley_escape_tracker=valley_escape_tracker, logger=logger,
                    make_cache_key_fn=make_cache_key_fn,
                    stop_event=stop_event,
                )
                evals_used += evs_ref
                
                if f_ref_res < best_f_global:
                    best_f_global = f_ref_res
                    best_x_global = x_ref_res
                    current_x = x_ref_res # Update incumbent for next cycle
                    if logger: logger.info(f"    Refresh improved global best -> {best_f_global:.5f}")
                    
    return best_x_global, best_f_global, evals_used
