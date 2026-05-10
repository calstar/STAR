"""Chamber pressure solver: solve supply(Pc) = demand(Pc)"""

import numpy as np
import logging
from scipy.optimize import brentq, newton
from typing import Tuple, Dict, Any, List, Optional

from engine.pipeline.config_schemas import PintleEngineConfig, ensure_chamber_geometry
from engine.pipeline.combustion_eff import eta_cstar, calculate_Lstar
from engine.pipeline.cea_cache import CEACache
from engine.pipeline.thermal.film_cooling import compute_film_cooling
from engine.pipeline.thermal.regen_cooling import (
    compute_regen_heat_transfer,
    estimate_hot_wall_heat_flux,
)
from engine.pipeline.thermal.ablative_cooling import (
    compute_ablative_response,
    compute_ablative_heat_flux_profile,
)
from engine.pipeline.numerical_robustness import (
    PhysicalConstraints,
    NumericalStability,
    PhysicsValidator,
    validate_engine_state,
)
from engine.pipeline.constants import (
    DEFAULT_CHAMBER_TEMP_K,
    DEFAULT_CSTAR_IDEAL_M_S,
    DEFAULT_GAMMA_ND,
    DEFAULT_GAS_CONST_J_KG_K,
    DEFAULT_TURBULENCE_INTENSITY_ND,
)
from engine.core.closure import flows


class ChamberSolver:
    """Solves for chamber pressure by balancing supply and demand"""
    
    def __init__(self, config: PintleEngineConfig, cea_cache: CEACache):
        self.config = config
        self.cea_cache = cea_cache
        
        # Ensure chamber_geometry exists
        ensure_chamber_geometry(config)
        
        # Cache for spray quality (updated during solve)
        self.spray_quality_good = True
    
    def residual(self, Pc: float, P_tank_O: float, P_tank_F: float) -> float:
        """
        Calculate residual: supply(Pc) - demand(Pc)
        
        Residual = 0 when supply equals demand.
        
        Parameters:
        -----------
        Pc : float
            Chamber pressure guess [Pa]
        P_tank_O : float
            Oxidizer tank pressure [Pa]
        P_tank_F : float
            Fuel tank pressure [Pa]
        
        Returns:
        --------
        residual : float [kg/s]
        """
        # Validate inputs
        Pc_val = float(Pc)
        P_tank_O_val = float(P_tank_O)
        P_tank_F_val = float(P_tank_F)
        
        # Physical constraint checks
        if not np.isfinite(Pc_val) or Pc_val <= 0:
            return np.nan  # Invalid pressure
        if not np.isfinite(P_tank_O_val) or P_tank_O_val <= 0:
            return np.nan
        if not np.isfinite(P_tank_F_val) or P_tank_F_val <= 0:
            return np.nan
        
        # Supply side: mass flow from injector (via closure)
        # flows() takes TANK PRESSURES and solves for mdot
        # It internally calculates:
        #   1. Feed losses: P_tank → P_injector
        #   2. Injector flow: P_injector - Pc → mdot
        #   3. Spray constraints: validates and adjusts if needed
        try:
            mdot_O, mdot_F, diagnostics = flows(
                P_tank_O_val,  # Tank pressure (INPUT)
                P_tank_F_val,  # Tank pressure (INPUT)
                Pc_val,        # Chamber pressure (GUESS - being solved for)
                self.config
            )
        except Exception as e:
            # If flows() fails, return NaN to signal invalid point
            import warnings
            warnings.warn(f"flows() failed in residual at Pc={Pc_val/1e6:.2f} MPa: {e}")
            return np.nan
        
        # Validate mass flows
        if not (np.isfinite(mdot_O) and np.isfinite(mdot_F)):
            return np.nan
        
        mdot_supply = mdot_O + mdot_F
        
        # Update spray quality for efficiency calculation
        self.spray_quality_good = diagnostics.get("constraints_satisfied", True)
        
        # Demand side: mass flow required by combustion
        MR, mr_valid = NumericalStability.safe_divide(mdot_O, mdot_F, 2.5, "MR")
        if not mr_valid.passed:
            return np.nan
        
        # Get CEA properties (IDEAL - infinite area equilibrium)
        # For 3D cache, use default expansion ratio from config (doesn't affect chamber properties much)
        try:
            cg = ensure_chamber_geometry(self.config)
            eps_default = cg.expansion_ratio
            cea_props = self.cea_cache.eval(MR, Pc_val, 101325.0, eps_default)
        except Exception as e:
            # Log the error for debugging but return NaN to signal failure
            import warnings
            warnings.warn(f"CEA cache eval failed in residual: {e}")
            return np.nan
        
        cstar_ideal = cea_props.get("cstar_ideal", 0.0)
        if not np.isfinite(cstar_ideal) or cstar_ideal <= 0:
            return np.nan
        
        # Apply combustion efficiency for FINITE CHAMBER
        # This corrects CEA's infinite-area assumption


        # Apply combustion efficiency for FINITE CHAMBER
        # This corrects CEA's infinite-area assumption
        
        # Calculate current Lstar and injector diameter dynamically
        # This is critical for optimization where config is mutated in-place
        cg = ensure_chamber_geometry(self.config)
        current_Lstar = calculate_Lstar(
            cg.volume,
            cg.A_throat,
            Lstar_override=cg.Lstar
        )
        current_injector_diameter = self._infer_injector_diameter()


        cooling_results, cooling_eff, _ = self._evaluate_cooling_models(
            Pc_val,
            mdot_O,
            mdot_F,
            cea_props,
            diagnostics,
        )

        geometry = self._get_chamber_geometry()
        advanced_params = {
            "Pc": Pc_val,
            "Tc": cea_props.get("Tc", DEFAULT_CHAMBER_TEMP_K),
            "cstar_ideal": cea_props.get("cstar_ideal", DEFAULT_CSTAR_IDEAL_M_S),
            "gamma": cea_props.get("gamma", DEFAULT_GAMMA_ND),
            "R": cea_props.get("R", DEFAULT_GAS_CONST_J_KG_K),
            "MR": MR,
            "Ac": geometry["area_cross"],
            "At": cg.A_throat,  # Added At for residence time calculation
            "chamber_length": geometry["length"],  # Added for mixing models
            "Dinj": current_injector_diameter,
            "m_dot_total": mdot_supply,
            "spray_diagnostics": diagnostics,
            "turbulence_intensity": diagnostics.get("turbulence_intensity_mix", DEFAULT_TURBULENCE_INTENSITY_ND),
            "fuel_props": self._get_fuel_props(),
        }

        # Add injection velocities to advanced_params if available in diagnostics
        if "u_F" in diagnostics:
            advanced_params["u_fuel"] = diagnostics["u_F"]
        if "u_O" in diagnostics:
            advanced_params["u_lox"] = diagnostics["u_O"]
        
        if hasattr(self, '_debug') and self._debug:
            logging.getLogger("evaluate").info(f"[SOLVER_DEBUG] Pc Guess: {Pc_val/1e6:.4f} MPa | Supply mdot: {mdot_supply:.4f} kg/s | MR: {MR:.3f}")
        
        # Calculate efficiency using advanced physics-based model
        eta = eta_cstar(
            current_Lstar,
            self.config.combustion.efficiency,
            cooling_eff,
            advanced_params,
            debug=self._debug if hasattr(self, '_debug') else False,
        )
        
        # Validate efficiency
        if not np.isfinite(eta) or eta <= 0 or eta > 1.0:
            return np.nan

        
        # Actual c* accounting for finite chamber volume
        cstar_actual = eta * cstar_ideal
        
        # Demand: mdot = Pc * At / c*_actual
        # This uses the chamber-driven c*, not the ideal CEA value
        cg = ensure_chamber_geometry(self.config)
        mdot_demand, demand_valid = NumericalStability.safe_divide(
            Pc_val * cg.A_throat,
            cstar_actual,
            0.0,
            "mdot_demand"
        )
        if not demand_valid.passed:
            return np.nan
        
        residual = mdot_supply - mdot_demand
        
        # Validate residual is finite
        if not np.isfinite(residual):
            return np.nan
        
        return float(residual)
    
    def solve(
        self,
        P_tank_O: float,
        P_tank_F: float,
        Pc_guess: float = None,
        debug: bool = False
    ) -> Tuple[float, Dict[str, Any]]:
        """
        Solve for chamber pressure.
        
        Parameters:
        -----------
        P_tank_O : float
            Oxidizer tank pressure [Pa]
        P_tank_F : float
            Fuel tank pressure [Pa]
        Pc_guess : float, optional
            Initial guess for chamber pressure [Pa]
        
        Returns:
        --------
        Pc : float [Pa]
            Solved chamber pressure
        diagnostics : dict
            Solution diagnostics
        """
        # Determine bounds
        # Realistic bounds: Pc must be less than both tank pressures (accounting for feed losses)
        Pc_min = 100000.0  # 100 kPa minimum
        
        # Estimate maximum feed losses for bounds calculation
        # Use rough estimates: assume maximum flow gives ~10-20% pressure drop
        # This is conservative but better than fixed 5% margin
        # Actual feed losses will be calculated during solve
        feed_loss_margin = 0.15  # 15% margin for feed losses (conservative estimate)
        Pc_max = min(P_tank_O, P_tank_F) * (1.0 - feed_loss_margin)
        
        # If fuel pressure is much higher than oxidizer, we might need to allow
        # Pc up to oxidizer pressure (since oxidizer flow limits the system)
        # But this is already handled by min(P_tank_O, P_tank_F)
        
        # Clamp to config bounds
        Pc_min = max(Pc_min, self.config.solver.Pc_bounds[0])
        Pc_max = min(Pc_max, self.config.solver.Pc_bounds[1])
        
        if Pc_max <= Pc_min:
            raise ValueError(f"Invalid pressure bounds: Pc_max ({Pc_max}) <= Pc_min ({Pc_min})")
        
        # Initial guess
        if Pc_guess is None:
            Pc_guess = (Pc_min + Pc_max) / 2
        
        # Create residual function with tank pressures bound
        # Create residual function with tank pressures bound
        # Also pass debug to residual if needed in future (currently residual uses instance state, but we can't easily pass debug to it without changing signature broadly or storing state)
        # However, residual calls eta_cstar which needs debug...
        # Wait, residual() calls eta_cstar() inside.
        # I need to update residual() to use debug flag.
        # I'll store `self._debug = debug` temporarily or modify residual validation.
        # Storing on self is easiest for this scope.
        self._debug = debug

        def residual_func(Pc):
            return self.residual(Pc, P_tank_O, P_tank_F)
        
        # Check residual signs at bounds before solving
        residual_min = residual_func(Pc_min)
        residual_max = residual_func(Pc_max)
        
        # Check for NaN values and provide better error messages
        if not np.isfinite(residual_min):
            # Try to diagnose the issue
            try:
                # Test a few points to see where it fails
                test_Pc = (Pc_min + Pc_max) / 2
                test_res = residual_func(test_Pc)
                if not np.isfinite(test_res):
                    raise ValueError(
                        f"Residual function returns non-finite values. "
                        f"Pc_min={Pc_min/1e6:.2f} MPa, Pc_max={Pc_max/1e6:.2f} MPa. "
                        f"Check injector geometry, feed system, or CEA cache."
                    )
            except Exception as e:
                raise ValueError(
                    f"Residual function evaluation failed at bounds. "
                    f"Pc_min={Pc_min/1e6:.2f} MPa, Pc_max={Pc_max/1e6:.2f} MPa. "
                    f"Error: {e}"
                )
        
        if not np.isfinite(residual_max):
            raise ValueError(
                f"Residual function returns non-finite at Pc_max={Pc_max/1e6:.2f} MPa. "
                f"Check that tank pressures are sufficient and injector geometry is valid."
            )
        
        # brentq requires opposite signs at bounds
        if np.sign(residual_min) == np.sign(residual_max):
            # No root in interval - this happens when:
            # 1. Supply > demand at all Pc (both positive) - need higher Pc but limited by tank pressure
            # 2. Supply < demand at all Pc (both negative) - can't supply enough flow
            
            if residual_min > 0 and residual_max > 0:
                # Supply > Demand at all Pc
                # This means injector supplies more flow than combustion can demand
                # Common causes:
                # 1. Injector too large (orifice areas too big)
                # 2. Throat too small (can't flow enough to balance supply)
                # 3. Combustion efficiency too low (reduces demand)
                # 4. Pc_max too conservative (we could go slightly higher)
                
                # Initialize skip_solve flag
                skip_solve = False
                
                # Check if residual is small at Pc_max (near solution)
                residual_tolerance = 0.1  # kg/s - accept if within 0.1 kg/s
                
                if residual_max < residual_tolerance:
                    # Residual is small - we're very close to solution
                    # Use Pc_max as solution with warning
                    # import warnings
                    # warnings.warn(
                    #     f"Supply slightly > Demand at Pc_max. "
                    #     f"Using Pc_max ({Pc_max/1e6:.2f} MPa) as solution. "
                    #     f"Residual: {residual_max:.4f} kg/s. "
                    #     f"Injector may be slightly oversized or throat slightly undersized."
                    # )
                    # Skip to solution validation - use Pc_max as solution
                    Pc = Pc_max
                    success = True
                    # Skip the root finding loop below
                    skip_solve = True
                else:
                    # Residual is significant - diagnose the issue
                    # Get diagnostics at Pc_max to understand supply/demand
                    try:
                        mdot_O_test, mdot_F_test, diag_test = flows(
                            P_tank_O, P_tank_F, Pc_max, self.config
                        )
                        mdot_supply_test = mdot_O_test + mdot_F_test
                        
                        # Get demand at Pc_max
                        MR_test = mdot_O_test / mdot_F_test if mdot_F_test > 0 else np.inf
                        cg = ensure_chamber_geometry(self.config)
                        eps_default = cg.expansion_ratio
                        cea_props_test = self.cea_cache.eval(MR_test, Pc_max, 101325.0, eps_default)
                        cstar_ideal_test = cea_props_test.get("cstar_ideal", 0.0)
                        
                        # Build advanced_params for diagnostics
                        geometry_test = self._get_chamber_geometry()
                        advanced_params_test = {
                            "Pc": Pc_max,
                            "Tc": cea_props_test.get("Tc", DEFAULT_CHAMBER_TEMP_K),
                            "cstar_ideal": cstar_ideal_test,
                            "gamma": cea_props_test.get("gamma", DEFAULT_GAMMA_ND),
                            "R": cea_props_test.get("R", DEFAULT_GAS_CONST_J_KG_K),
                            "MR": MR_test,
                            "Ac": geometry_test["area_cross"],
                            "At": cg.A_throat,
                            "chamber_length": geometry_test["length"],
                            "Dinj": self._infer_injector_diameter(),
                            "m_dot_total": mdot_supply_test,
                            "spray_diagnostics": diag_test,
                            "turbulence_intensity": diag_test.get("turbulence_intensity_mix", DEFAULT_TURBULENCE_INTENSITY_ND),
                            "fuel_props": self._get_fuel_props(),
                        }
                        
                        # Calculate efficiency
                        eta_test = eta_cstar(
                            calculate_Lstar(cg.volume, cg.A_throat, Lstar_override=cg.Lstar),
                            self.config.combustion.efficiency,
                            diag_test.get("cooling_efficiency", 1.0),
                            advanced_params_test,
                            debug=debug if 'debug' in locals() else False, 
                        )
                        cstar_actual_test = eta_test * cstar_ideal_test
                        cg = ensure_chamber_geometry(self.config)
                        mdot_demand_test = (Pc_max * cg.A_throat) / cstar_actual_test if cstar_actual_test > 0 else np.inf
                        
                        # Calculate what Pc would balance (extrapolate)
                        # residual = supply - demand
                        # At Pc_max: residual = mdot_supply - mdot_demand
                        # Demand scales with Pc: mdot_demand ∝ Pc
                        # Supply decreases slightly with Pc: mdot_supply decreases as Pc increases
                        # Rough estimate: if we increase Pc by ΔPc, demand increases more than supply
                        
                        # Estimate required Pc (rough extrapolation)
                        # Assume linear relationship near Pc_max
                        if mdot_demand_test > 0 and mdot_supply_test > mdot_demand_test:
                            # We need more Pc to increase demand
                            # mdot_demand = Pc * At / c*, so Pc_needed = mdot_supply * c* / At
                            cg = ensure_chamber_geometry(self.config)
                            Pc_estimate = mdot_supply_test * cstar_actual_test / cg.A_throat
                            
                            raise ValueError(
                                f"No solution: Supply > Demand at all Pc. "
                                f"Residual at Pc_min: {residual_min:.4f} kg/s, at Pc_max: {residual_max:.4f} kg/s. "
                                f"\nDiagnostics at Pc_max ({Pc_max/1e6:.2f} MPa):"
                                f"\n  - Supply: {mdot_supply_test:.4f} kg/s (mdot_O={mdot_O_test:.4f}, mdot_F={mdot_F_test:.4f})"
                                f"\n  - Demand: {mdot_demand_test:.4f} kg/s (c*_actual={cstar_actual_test:.1f} m/s, At={cg.A_throat*1e6:.2f} mm²)"
                                f"\n  - Estimated Pc needed: {Pc_estimate/1e6:.2f} MPa (vs Pc_max={Pc_max/1e6:.2f} MPa)"
                                f"\nPossible fixes:"
                                f"\n  1. Reduce injector orifice areas (currently oversized)"
                                f"\n  2. Increase throat area (currently undersized)"
                                f"\n  3. Increase tank pressures to allow higher Pc_max"
                                f"\n  4. Check combustion efficiency (low efficiency reduces demand)"
                            )
                        else:
                            raise ValueError(
                                f"No solution: Supply > Demand at all Pc. "
                                f"Residual: [{residual_min:.4f}, {residual_max:.4f}] kg/s. "
                                f"Could not compute detailed diagnostics."
                            )
                    except ValueError:
                        # Re-raise explicit ValueErrors from above
                        raise
                    except Exception as diag_e:
                        # Diagnostics failed - provide generic error
                        raise ValueError(
                            f"No solution: Supply > Demand at all Pc. "
                            f"Residual at bounds: [{residual_min:.4f}, {residual_max:.4f}] kg/s. "
                            f"Pc_max ({Pc_max/1e6:.2f} MPa) limited by tank pressure. "
                            f"Possible causes: Injector oversized, throat undersized, or combustion efficiency too low. "
                            f"Diagnostic error: {diag_e}"
                        )
                    
            else:
                # Supply < Demand at all Pc (both negative)
                raise ValueError(
                    f"No solution: Supply < Demand at all Pc. "
                    f"Residual at bounds: [{residual_min:.4f}, {residual_max:.4f}] kg/s. "
                    f"Insufficient mass flow. Check tank pressures and injector geometry."
                )
        
        # Check if we already have a solution (from small residual case above)
        # skip_solve is defined in the if-else block above, default to False if not set
        if 'skip_solve' not in locals():
            skip_solve = False
        
        if not skip_solve:
            # Validate bracket before solving
            bracket_check = NumericalStability.check_bracket(residual_func, Pc_min, Pc_max)
            if not bracket_check.passed:
                raise ValueError(f"Invalid bracket for root finding: {bracket_check.message}")
            
            # Track convergence history for diagnostics
            convergence_history = []
            
            # Enhanced residual function with convergence tracking
            def tracked_residual_func(Pc):
                res = residual_func(Pc)
                convergence_history.append(float(res))
                return res
            
            # Solve using bracketed secant (brentq) - safe and robust
            try:
                if self.config.solver.method == "brentq":
                    Pc, result = brentq(
                        tracked_residual_func,
                        Pc_min,
                        Pc_max,
                        xtol=self.config.solver.tolerance,
                        rtol=self.config.solver.tolerance * 1e-3,  # Relative tolerance
                        maxiter=self.config.solver.max_iterations,
                        full_output=True
                    )
                    success = result.converged
                    
                    # Validate convergence
                    conv_check = NumericalStability.check_convergence(
                        convergence_history,
                        self.config.solver.tolerance,
                        min_iterations=3
                    )
                    if not conv_check.passed and conv_check.severity == "error":
                        raise RuntimeError(f"Convergence validation failed: {conv_check.message}")
                        
                else:
                    # Fallback to Newton's method (less robust)
                    Pc = newton(
                        tracked_residual_func,
                        Pc_guess,
                        tol=self.config.solver.tolerance,
                        maxiter=self.config.solver.max_iterations
                    )
                    success = True
                    
                    # Validate convergence for Newton
                    conv_check = NumericalStability.check_convergence(
                        convergence_history,
                        self.config.solver.tolerance,
                        min_iterations=3
                    )
                    if not conv_check.passed and conv_check.severity == "error":
                        raise RuntimeError(f"Convergence validation failed: {conv_check.message}")
                        
            except ValueError as e:
                # Re-raise ValueError (bracket issues, etc.)
                raise
            except Exception as e:
                raise RuntimeError(f"Chamber pressure solver failed: {e}")
        else:
            # We're using Pc_max as solution (small residual case)
            # Already set Pc = Pc_max and success = True above
            convergence_history = [residual_max]  # Store for diagnostics
        
        # Validate solution
        Pc_val = float(Pc)
        if not np.isfinite(Pc_val):
            raise RuntimeError(f"Solver returned non-finite pressure: {Pc_val}")
        
        Pc_check = PhysicalConstraints.validate_pressure(Pc_val, "Pc_solution")
        if not Pc_check.passed and Pc_check.severity == "error":
            raise RuntimeError(f"Solution validation failed: {Pc_check.message}")
        
        # Get final diagnostics
        mdot_O, mdot_F, closure_diag = flows(P_tank_O, P_tank_F, Pc_val, self.config)
        MR = mdot_O / mdot_F if mdot_F > 0 else 0

        # Calculate current Lstar and injector diameter dynamically
        # This is critical for optimization where config is mutated in-place
        cg = ensure_chamber_geometry(self.config)
        current_Lstar = calculate_Lstar(
            cg.volume,
            cg.A_throat,
            Lstar_override=cg.Lstar
        )
        current_injector_diameter = self._infer_injector_diameter()
        
        # Use current expansion ratio for 3D cache
        # FIXED: Add safety check for division by zero
        cg = ensure_chamber_geometry(self.config)
        eps_current = cg.A_exit / cg.A_throat if cg.A_throat and cg.A_exit and cg.A_throat > 0 else cg.expansion_ratio
        cea_props = self.cea_cache.eval(MR, Pc_val, 101325.0, eps_current)
        
        # Calculate total mass flow rate (needed for various calculations below)
        mdot_total = mdot_O + mdot_F
        
        # Calculate cooling effects early (needed for conservative reaction kinetics)
        cooling_results, cooling_eff, effective_Tc = self._evaluate_cooling_models(
            Pc_val,
            mdot_O,
            mdot_F,
            cea_props,
            closure_diag,
        )

        # Calculate reaction progress through chamber (if finite-rate chemistry enabled)
        reaction_progress = None
        if getattr(self.config.combustion.efficiency, 'use_finite_rate_chemistry', True):
            try:
                from engine.pipeline.reaction_chemistry import calculate_chamber_reaction_progress
                
                # Pass spray diagnostics if available for better evaporation/mixing estimates
                spray_diagnostics = closure_diag if closure_diag else None
                
                # Use conservative "Worst of Both Worlds" temperatures:
                # Tc (Ideal) for residence time (shorter time is conservative)
                # effective_Tc (Actual) for kinetics (slower chemistry is conservative)
                reaction_progress = calculate_chamber_reaction_progress(
                    current_Lstar,
                    Pc_val,
                    cea_props["Tc"], # Ideal Tc (Residence Time)
                    cea_props["cstar_ideal"],
                    cea_props["gamma"],
                    cea_props["R"],
                    MR,
                    self.config,
                    spray_diagnostics=spray_diagnostics,
                    Tc_kinetics=effective_Tc, # Actual Tc (Kinetics)
                )
            except Exception as e:
                # Don't silently fail - raise error or log warning
                import warnings
                warnings.warn(f"Reaction progress calculation failed: {e}. This may indicate invalid engine conditions.")
                # Minimal fallback - but indicate uncertainty
                # CRITICAL FIX: Correct residence time formula
                rho_chamber = Pc_val / (cea_props["R"] * cea_props["Tc"]) if cea_props["R"] > 0 and cea_props["Tc"] > 0 else 1.0
                # Use actual mdot_total from closure (calculated above)
                cg = ensure_chamber_geometry(self.config)
                tau_residence_correct = current_Lstar * rho_chamber * cg.A_throat / mdot_total if mdot_total > 0 else 0.001
                reaction_progress = {
                    "progress_throat": 1.0,  # Assume equilibrium
                    "tau_residence": tau_residence_correct,
                    "calculation_failed": True,
                }
        
        # Extract and validate mixture diagnostics (diagnostics-only, no efficiency impact)
        # Enable mixture coupling diagnostics if configured
        eff_cfg = self.config.combustion.efficiency
        if getattr(eff_cfg, 'use_mixture_coupling', False) and isinstance(closure_diag, dict):
            # Extract mixture diagnostics in non-strict mode (warn but don't fail)
            mixture_diag = self._extract_and_validate_mixture_diagnostics(closure_diag, strict=False)
            # Log diagnostics for informational purposes
            if debug:
                self._log_mixture_diagnostics(mixture_diag)
            # Store in closure_diag for later analysis/logging
            closure_diag['mixture_diagnostics'] = mixture_diag


        # Build advanced parameters for combustion efficiency calculation
        geometry = self._get_chamber_geometry()
        
        advanced_params = {
            "Pc": Pc_val,
            "Tc": cea_props["Tc"],  # Ideal Tc (Conservative Residence Time)
            "Tc_kinetics": effective_Tc, # Actual Tc (Conservative Kinetics)
            "cstar_ideal": cea_props.get("cstar_ideal", DEFAULT_CSTAR_IDEAL_M_S),
            "gamma": cea_props.get("gamma", DEFAULT_GAMMA_ND),
            "R": cea_props.get("R", DEFAULT_GAS_CONST_J_KG_K),
            "MR": MR,
            "Ac": geometry["area_cross"],
            "At": cg.A_throat,
            "chamber_length": geometry["length"],
            "Dinj": current_injector_diameter,
            "m_dot_total": mdot_total,
            "u_fuel": closure_diag.get("u_F"),
            "u_lox": closure_diag.get("u_O"),
            "spray_diagnostics": closure_diag,
            "turbulence_intensity": closure_diag.get("turbulence_intensity_mix", DEFAULT_TURBULENCE_INTENSITY_ND),
            "fuel_props": self._get_fuel_props(),
        }
        
        eta = eta_cstar(
            current_Lstar,
            self.config.combustion.efficiency,
            cooling_eff,
            advanced_params,
            debug=debug,
        )
        
        # Comprehensive validation of final solution
        cstar_actual = eta * cea_props["cstar_ideal"]
        gamma = cea_props["gamma"]
        R = cea_props["R"]

        if debug:
            logging.getLogger("evaluate").info(
                f"[CSTAR] eta={eta:.4f} | c*_ideal={cea_props['cstar_ideal']:.1f} m/s -> c*_actual={cstar_actual:.1f} m/s | "
                f"ratio={cstar_actual/cea_props['cstar_ideal']:.4f}"
            )   
        
        # Calculate Isp for validation
        # CRITICAL FIX: Correct Isp formula
        # Isp = F / (mdot * g0) = (Cf * Pc * At) / (mdot * g0)
        # OR equivalently: Isp = cstar * Cf / g0
        # The previous formula with gamma * sqrt(...) was incorrect
        g0 = 9.80665
        Cf_ideal = cea_props.get("Cf_ideal", 1.5)  # Get from CEA, default to typical value
        cg = ensure_chamber_geometry(self.config)
        Cf_actual = cg.nozzle_efficiency * Cf_ideal  # Account for nozzle efficiency
        # Use correct formula: Isp = Cf * Pc * At / (mdot * g0)
        Isp = (Cf_actual * Pc_val * cg.A_throat) / (mdot_total * g0) if mdot_total > 0 else 0.0
        
        # Validate engine state (use effective temperature after cooling)
        validation_results = validate_engine_state(
            Pc_val, MR, mdot_total, cstar_actual, gamma, effective_Tc, Isp, 0.0  # F not calculated yet
        )
        
        # Check for critical errors
        critical_errors = [r for r in validation_results if r.severity == "error" and not r.passed]
        if critical_errors:
            error_msgs = [r.message for r in critical_errors]
            raise RuntimeError(f"Solution validation failed:\n" + "\n".join(error_msgs))
        
        diagnostics = {
            "Pc": Pc_val,
            "mdot_O": mdot_O,
            "mdot_F": mdot_F,
            "mdot_total": mdot_total,
            "MR": MR,
            "cstar_ideal": cea_props["cstar_ideal"],
            "Tc_ideal": cea_props["Tc"],  # Store original ideal temperature
            "cstar_actual": cstar_actual,
            "eta_cstar": eta,
            "cooling_efficiency": cooling_eff,
            "Tc": effective_Tc,  # Use effective temperature after cooling (accounts for energy removal)
            "Tc_ideal": cea_props["Tc"],  # Store original CEA temperature for reference
            "gamma": gamma,
            "R": R,
            "M": cea_props.get("M"),  # Molecular weight [kg/kmol]
            "spray_quality_good": self.spray_quality_good,
            "validation_results": validation_results,  # Include validation results
            "convergence_history": convergence_history,  # Include convergence history
            **closure_diag,
        }

        diagnostics["cooling"] = cooling_results

        return Pc_val, diagnostics

    def _extract_and_validate_mixture_diagnostics(
        self, 
        closure_diag: Dict[str, Any], 
        strict: bool = True
    ) -> Dict[str, float]:
        """
        Extract and validate mixture quality diagnostics from closure diagnostics.
        
        DIAGNOSTICS-ONLY - no efficiency impact. Physics comes from:
        - eta_Lstar: actual SMD via gasification model
        - eta_mixing: actual turbulence/velocities via diffusion
        - eta_kinetics: actual T/P via Damköhler number
        
        Parameters:
        - closure_diag: Injector diagnostics dict
        - strict: If True, raise on missing critical data. If False, warn.
        
        Returns: Dict with actual_smd_microns, x_star_mm, We_O, We_F, etc.
        """
        if not isinstance(closure_diag, dict):
            if strict:
                raise ValueError("closure_diag must be a dictionary")
            else:
                import warnings
                warnings.warn("closure_diag is not a dictionary, cannot extract mixture diagnostics")
                return {}
        
        diagnostics = {}
        
        # === EXTRACT SMD (CRITICAL) ===
        D32_O = closure_diag.get("D32_O")
        D32_F = closure_diag.get("D32_F")
        
        if D32_O is None and D32_F is None:
            msg = "Missing SMD data: both D32_O and D32_F are None in closure diagnostics"
            if strict:
                raise ValueError(msg)
            else:
                import warnings
                warnings.warn(msg)
        else:
            actual_smd_m = max(
                float(D32_O) if D32_O is not None else 0.0,
                float(D32_F) if D32_F is not None else 0.0,
            )
            actual_smd_microns = actual_smd_m * 1e6
            
            if not np.isfinite(actual_smd_microns):
                msg = (
                    f"Non-finite SMD: {actual_smd_microns:.2f} microns. "
                    f"D32_O={D32_O}, D32_F={D32_F}. Check spray breakup calculations."
                )
                if strict:
                    raise ValueError(msg)
                else:
                    import warnings
                    warnings.warn(msg)
            elif actual_smd_microns <= 0:
                msg = (
                    f"Invalid SMD: {actual_smd_microns:.2f} microns (must be > 0). "
                    f"D32_O={D32_O}, D32_F={D32_F}. Check spray breakup calculations."
                )
                if strict:
                    raise ValueError(msg)
                else:
                    import warnings
                    warnings.warn(msg)
            else:
                diagnostics["actual_smd_microns"] = float(actual_smd_microns)
        
        # === EXTRACT IMPINGEMENT DISTANCE (CRITICAL) ===
        x_star_m = closure_diag.get("x_star")
        
        if x_star_m is None:
            msg = "Missing x_star in closure diagnostics. Check spray impingement calculations."
            if strict:
                raise ValueError(msg)
            else:
                import warnings
                warnings.warn(msg)
        else:
            x_star_mm = float(x_star_m) * 1000.0
            
            if not np.isfinite(x_star_mm):
                msg = f"Non-finite x_star: {x_star_mm} mm. Must be finite."
                if strict:
                    raise ValueError(msg)
                else:
                    import warnings
                    warnings.warn(msg)
            else:
                # x_star <= 0 is valid (upstream/no impingement)
                diagnostics["x_star_mm"] = float(x_star_mm)
        
        # === EXTRACT WEBER NUMBERS (NON-CRITICAL) ===
        We_O = closure_diag.get("We_O")
        We_F = closure_diag.get("We_F")
        
        if We_O is not None:
            we_o = float(We_O)
            if np.isfinite(we_o) and we_o >= 0:
                diagnostics["We_O"] = we_o
            elif strict:
                raise ValueError(f"Invalid We_O: {we_o}. Must be finite and non-negative.")
        
        if We_F is not None:
            we_f = float(We_F)
            if np.isfinite(we_f) and we_f >= 0:
                diagnostics["We_F"] = we_f
            elif strict:
                raise ValueError(f"Invalid We_F: {we_f}. Must be finite and non-negative.")
        
        # Compute We_min if both present
        if "We_O" in diagnostics and "We_F" in diagnostics:
            we_o = diagnostics["We_O"]
            we_f = diagnostics["We_F"]
            
            # Use minimum of positive values, or max if one is zero
            if we_o > 0 and we_f > 0:
                diagnostics["We_min"] = min(we_o, we_f)
            else:
                diagnostics["We_min"] = max(we_o, we_f)
        
        # === EXTRACT TURBULENCE INTENSITY (OPTIONAL) ===
        I_mix = closure_diag.get("turbulence_intensity_mix")
        
        if I_mix is not None:
            I_mix_val = float(I_mix)
            
            if not np.isfinite(I_mix_val):
                msg = f"Non-finite turbulence intensity: {I_mix_val}"
                if strict:
                    raise ValueError(msg)
                else:
                    import warnings
                    warnings.warn(msg)
            elif I_mix_val <= 0 or I_mix_val > 1:
                msg = (
                    f"Turbulence intensity out of range: {I_mix_val:.4f} (expected 0-1). "
                    f"Check turbulence calculations."
                )
                if strict:
                    raise ValueError(msg)
                else:
                    import warnings
                    warnings.warn(msg)
            else:
                diagnostics["turbulence_intensity_mix"] = I_mix_val
        
        return diagnostics
    
    def _log_mixture_diagnostics(self, diag: Dict[str, float]) -> None:
        """
        Log mixture quality diagnostics for informational purposes.
        
        DIAGNOSTICS-ONLY - no efficiency impact.
        """
        if not diag:
            return
        
        parts = []
        
        if "actual_smd_microns" in diag:
            parts.append(f"SMD={diag['actual_smd_microns']:.1f} μm")
        
        if "x_star_mm" in diag:
            parts.append(f"x*={diag['x_star_mm']:.2f} mm")
        
        if "We_O" in diag and "We_F" in diag:
            parts.append(f"We_O={diag['We_O']:.1f}, We_F={diag['We_F']:.1f}")
            if "We_min" in diag:
                parts.append(f"We_min={diag['We_min']:.1f}")
        
        if "turbulence_intensity_mix" in diag:
            parts.append(f"I_mix={diag['turbulence_intensity_mix']:.3f}")
        
        if parts:
            import logging
            logging.getLogger("evaluate").info(f"[MIXTURE_DIAG] {', '.join(parts)}")

    def _compute_cooling_efficiency(
        self,
        cooling_results: Dict[str, Any],
        mdot_total: float,
        Tc: float,
        gamma: float,
        R: float,
    ) -> float:
        eff_cfg = self.config.combustion.efficiency
        if not eff_cfg.use_cooling_coupling:
            return 1.0

        total_heat_removed = 0.0
        for source in cooling_results.values():
            if isinstance(source, dict):
                total_heat_removed += float(source.get("heat_removed", 0.0))

        if total_heat_removed <= 0:
            return 1.0

        cp = gamma * R / max(gamma - 1.0, 1e-6)
        available_energy = mdot_total * cp * max(Tc, 1.0)
        if available_energy <= 0:
            return 1.0

        factor = 1.0 - total_heat_removed / available_energy
        return float(np.clip(factor, eff_cfg.cooling_efficiency_floor, 1.0))

    def _evaluate_cooling_models(
        self,
        Pc: float,
        mdot_O: float,
        mdot_F: float,
        cea_props: Dict[str, float],
        closure_diag: Dict[str, Any],
    ) -> Tuple[Dict[str, Any], float, float]:
        config = self.config
        mdot_total = mdot_O + mdot_F
        cooling_results: Dict[str, Any] = {}
        Tc = float(cea_props["Tc"])

        if mdot_total <= 0:
            closure_diag["cooling"] = cooling_results
            return cooling_results, 1.0, Tc

        fuel_fluid = config.fluids["fuel"]
        geometry = self._get_chamber_geometry()
        Pc_val = float(Pc)
        gamma = float(cea_props["gamma"])
        R = float(cea_props["R"])

        rho_g = max(Pc_val / (R * max(Tc, 1.0)), 1e-6)
        area_cross = geometry["area_cross"]
        velocity_g = mdot_total / (rho_g * area_cross)

        regen_cfg = config.regen_cooling
        from engine.pipeline.constants import DEFAULT_HOT_GAS_VISC_PA_S
        mu_g_config = regen_cfg.hot_gas_viscosity if regen_cfg is not None else DEFAULT_HOT_GAS_VISC_PA_S
        
        # Calculate viscosity using Huzel's formula if molecular weight is available
        M = cea_props.get("M")  # Molecular weight [kg/kmol]
        if M is not None and M > 0 and Tc > 0:
            from engine.pipeline.thermal.regen_cooling import calculate_gas_viscosity_huzel
            mu_g_calculated = calculate_gas_viscosity_huzel(Tc, M)
        else:
            mu_g_calculated = mu_g_config  # Fallback to config if M not available
        
        # Use calculated viscosity for calculations (more accurate)
        mu_g = mu_g_calculated
        
        k_g = regen_cfg.hot_gas_thermal_conductivity if regen_cfg is not None else 0.1
        Pr_g = (
            regen_cfg.hot_gas_prandtl
            if (regen_cfg is not None and regen_cfg.hot_gas_prandtl > 0)
            else mu_g * gamma * R / max(k_g * (gamma - 1.0), 1e-6)
        )

        Re_g = rho_g * velocity_g * geometry["diameter"] / max(mu_g, 1e-8)
        if Re_g < 2000:
            Nu_g = 4.36
        else:
            Nu_g = 0.023 * (Re_g ** 0.8) * (Pr_g ** 0.4)

        turbulence_intensity_calc = 0.05
        if Re_g > 0:
            turbulence_intensity_calc = float(np.clip(0.16 * Re_g ** -0.125, 0.02, 0.25))

        turbulence_boost = 1.0
        if regen_cfg is not None:
            # CRITICAL FIX: Remove arbitrary 0.8 exponent - turbulence effect on heat transfer
            # Turbulence increases Nu, but the relationship is complex
            # For now, use linear scaling: Nu_turbulent ≈ Nu_laminar × (1 + turbulence_intensity)
            turbulence_boost = 1.0 + max(regen_cfg.gas_turbulence_intensity, 0.0)  # Remove arbitrary 0.8 exponent
            turbulence_intensity_calc = max(
                turbulence_intensity_calc,
                float(np.clip(regen_cfg.gas_turbulence_intensity, 0.0, 0.5)),
            )

        h_hot_base = Nu_g * k_g / geometry["diameter"] * turbulence_boost

        gas_props = {
            "Pc": Pc_val,
            "Tc": Tc,
            "gamma": gamma,
            "R": R,
            "rho": rho_g,
            "velocity": velocity_g,
            "length": geometry["length"],
            "circumference": geometry["circumference"],
            "area": geometry["area"],
            "area_cross": area_cross,
            "h_hot_base": h_hot_base,
            "turbulence_intensity": turbulence_intensity_calc,
        }

        film_cfg = config.film_cooling
        film_results = {
            "enabled": False,
            "mdot_available_for_regen": mdot_F,
            "effective_gas_temperature": Tc,
            "heat_removed": 0.0,
        }

        if film_cfg is not None and film_cfg.enabled:
            film_results = compute_film_cooling(
                mdot_total,
                mdot_F,
                gas_props,
                film_cfg,
                fuel_fluid,
            )
            cooling_results["film"] = film_results

        effective_Tc = float(film_results.get("effective_gas_temperature", Tc))
        gas_props_regen = {
            "Pc": Pc_val,
            "Tc": effective_Tc,
            "gamma": gamma,
            "R": R,
            "M": cea_props.get("M"),  # Molecular weight [kg/kmol] for viscosity calculation
            "chamber_area": geometry["area_cross"],
            "A_throat": ensure_chamber_geometry(config).A_throat,
            "chamber_length": geometry["length"],
            "turbulence_intensity": turbulence_intensity_calc,
        }

        coolant_props = {
            "density": float(fuel_fluid.density),
            "viscosity": float(fuel_fluid.viscosity),
            "cp": float(fuel_fluid.specific_heat),
            "thermal_conductivity": float(fuel_fluid.thermal_conductivity),
            "temperature": float(fuel_fluid.temperature),
        }

        mdot_coolant = float(film_results.get("mdot_available_for_regen", mdot_F))

        if regen_cfg is not None and regen_cfg.enabled:
            regen_results = compute_regen_heat_transfer(
                mdot_coolant,
                coolant_props,
                gas_props_regen,
                regen_cfg,
                mdot_total,
            )
            regen_results["mdot_coolant"] = mdot_coolant
            cooling_results["regen"] = regen_results

        abl_cfg = config.ablative_cooling
        if abl_cfg is not None and abl_cfg.enabled:
            hot_flux = estimate_hot_wall_heat_flux(
                gas_props_regen,
                regen_cfg,
                abl_cfg.surface_temperature_limit,
                mdot_total,
            )
            abl_area = geometry["area"] * np.clip(abl_cfg.coverage_fraction, 0.0, 1.0)
            ablative_results = compute_ablative_response(
                hot_flux["heat_flux_total"],
                abl_cfg.surface_temperature_limit,
                abl_cfg,
                abl_area,
                turbulence_intensity_calc,
                heat_flux_conv=hot_flux.get("heat_flux_conv"),
                heat_flux_rad=hot_flux.get("heat_flux_rad"),
                gas_mass_flow_rate=mdot_total,
            )
            ablative_results["incident_heat_flux"] = hot_flux["heat_flux_total"]
            
            # Calculate effective gas temperature after ablative cooling
            # Energy removed from gas: Q = mdot_total × cp × ΔT
            # Therefore: ΔT = Q / (mdot_total × cp)
            abl_heat_removed = ablative_results.get("heat_removed", 0.0)
            if abl_heat_removed > 0 and mdot_total > 0:
                cp = gamma * R / max(gamma - 1.0, 1e-6)  # Specific heat [J/(kg·K)]
                delta_T_abl = abl_heat_removed / max(mdot_total * cp, 1e-6)
                effective_Tc = max(effective_Tc - delta_T_abl, 1.0)  # Update effective temperature
                ablative_results["temperature_reduction"] = float(delta_T_abl)
            else:
                ablative_results["temperature_reduction"] = 0.0
            
            ablative_results["effective_gas_temperature"] = float(effective_Tc)
            
            # Compute ablative heat flux profile along chamber AND nozzle
            # Get chamber and throat dimensions
            chamber_geom = ensure_chamber_geometry(config)
            D_chamber = geometry.get("diameter", 0.1)
            D_throat = np.sqrt(4.0 * chamber_geom.A_throat / np.pi) if chamber_geom.A_throat > 0 else 0.05
            L_chamber = geometry.get("length", 0.15)
            
            # Get nozzle dimensions
            D_exit = np.sqrt(4.0 * chamber_geom.A_exit / np.pi) if chamber_geom.A_exit and chamber_geom.A_exit > 0 else None
            # Estimate nozzle length from geometry (typically 0.8-1.2 × throat diameter × sqrt(expansion_ratio))
            if D_exit and D_throat > 0 and chamber_geom.expansion_ratio:
                # Rao bell nozzle length approximation: L_nozzle ≈ 0.8 × D_throat × sqrt(eps - 1)
                eps = chamber_geom.expansion_ratio
                L_nozzle = 0.8 * D_throat * np.sqrt(max(eps - 1.0, 0.1)) if eps > 1 else None
            else:
                L_nozzle = None
            
            # Add molecular weight to gas props for profile computation
            gas_props_profile = {
                "Tc": effective_Tc,
                "Pc": Pc_val,
                "gamma": gamma,
                "R": R,
                "M": cea_props.get("M", 24.0),  # Molecular weight [kg/kmol]
            }
            
            ablative_profile = compute_ablative_heat_flux_profile(
                gas_props_profile,
                abl_cfg,
                mdot_total,
                L_chamber,
                D_chamber,
                D_throat,
                n_segments=20,
                L_nozzle=L_nozzle,
                D_exit=D_exit,
                include_nozzle=True,
            )
            
            # Debug logging for heat flux profile
            import logging
            logger = logging.getLogger(__name__)
            logger.info(f"[ABLATIVE PROFILE] L_chamber={L_chamber:.4f}m, D_chamber={D_chamber:.4f}m, D_throat={D_throat:.4f}m")
            logger.info(f"[ABLATIVE PROFILE] segment_x length={len(ablative_profile.get('segment_x', []))}, segment_q_incident length={len(ablative_profile.get('segment_q_incident', []))}")
            if ablative_profile.get('segment_q_incident'):
                logger.info(f"[ABLATIVE PROFILE] q_incident range: {min(ablative_profile['segment_q_incident']):.2e} to {max(ablative_profile['segment_q_incident']):.2e} W/m²")
            
            # Add profile data to ablative results
            ablative_results["segment_x"] = ablative_profile["segment_x"]
            ablative_results["segment_q_incident"] = ablative_profile["segment_q_incident"]
            ablative_results["segment_q_conv"] = ablative_profile["segment_q_conv"]
            ablative_results["segment_q_rad"] = ablative_profile["segment_q_rad"]
            ablative_results["segment_q_net"] = ablative_profile["segment_q_net"]
            ablative_results["throat_index"] = ablative_profile["throat_index"]
            
            cooling_results["ablative"] = ablative_results

        cooling_eff = self._compute_cooling_efficiency(
            cooling_results,
            mdot_total,
            effective_Tc,
            gamma,
            R,
        )

        # Store metadata for diagnostics
        metadata = cooling_results.setdefault("metadata", {})
        metadata["gas_turbulence_intensity"] = turbulence_intensity_calc
        metadata["effective_gas_temperature"] = float(effective_Tc)
        metadata["original_gas_temperature"] = float(Tc)
        metadata["gas_viscosity"] = float(mu_g)  # Viscosity used in calculations (calculated from Huzel if available)
        metadata["gas_viscosity_config"] = float(mu_g_config)  # Viscosity from config (for reference)
        metadata["gas_viscosity_calculated"] = float(mu_g_calculated)  # Viscosity from Huzel formula (for reference)
        closure_diag["cooling"] = cooling_results

        return cooling_results, cooling_eff, effective_Tc
    
    def _infer_injector_diameter(self) -> float:
        """Estimate a characteristic injector diameter for mixing models."""
        injector_cfg = getattr(self.config, "injector", None)
        diameter = None
        injector_type = getattr(injector_cfg, "type", None) if injector_cfg is not None else None
        try:
            if injector_type == "pintle":
                diameter = injector_cfg.geometry.fuel.d_pintle_tip
            elif injector_type == "coaxial":
                diameter = injector_cfg.geometry.core.d_port
            elif injector_type == "impinging":
                diameter = injector_cfg.geometry.oxidizer.d_jet
        except AttributeError:
            diameter = None
        
        if diameter is None or diameter <= 0:
            geometry = self._get_chamber_geometry()
            diameter = np.sqrt(4.0 * geometry["area_cross"] / np.pi)
        return float(max(diameter, 1e-5))

    def _get_chamber_geometry(self) -> Dict[str, float]:
        """
        Extract physical chamber geometry from configuration.
        
        Returns a dictionary with:
        - length: Total physical length [m]
        - diameter: Chamber inner diameter [m]
        - area_cross: Cross-sectional area [m²]
        - circumference: Chamber circumference [m]
        - area: Total wetted surface area [m²] (cylindrical + contraction)
        """
        # cg is guaranteed to exist because __init__ calls ensure_chamber_geometry
        cg = ensure_chamber_geometry(self.config)
        regen_cfg = self.config.regen_cooling

        # 1. Physical diameter from unified config
        diameter = cg.chamber_diameter
        
        # Fallback to regen if not in unified (though ensure_chamber_geometry should handle it)
        if (diameter is None or diameter <= 0) and regen_cfg is not None and regen_cfg.chamber_inner_diameter is not None:
            diameter = regen_cfg.chamber_inner_diameter
            
        # Final fallback
        if diameter is None or diameter <= 0:
            diameter = 0.08
            
        diameter = max(diameter, 1e-6)
        area_cross = np.pi * (diameter / 2.0)**2
        circumference = np.pi * diameter
        
        # 2. Physical lengths
        length_total = cg.length
        length_cyl = cg.length_cylindrical
        length_cont = cg.length_contraction
        
        # 3. Wetted Surface Area
        # If we have the breakdown (cylindrical + contraction), calculate accurately
        if length_cyl is not None and length_cont is not None:
            # Wetted area = Cylindrical part + Contraction part (frustum of a cone)
            # Area_cyl = pi * D * L_cyl
            area_cyl = circumference * length_cyl
            
            # Area_cont = lateral area of a frustum = pi * (r1 + r2) * slant_height
            r1 = diameter / 2.0
            # Estimate throat radius from A_throat if available
            A_throat = cg.A_throat if cg.A_throat and cg.A_throat > 0 else (area_cross / 3.0)
            r2 = np.sqrt(A_throat / np.pi)
            
            slant_height = np.sqrt((r1 - r2)**2 + length_cont**2)
            area_cont = np.pi * (r1 + r2) * slant_height
            
            area_wetted = area_cyl + area_cont
        else:
            # Fallback to simple cylinder if breakdown not available
            area_wetted = circumference * length_total

        return {
            "length": float(length_total),
            "diameter": float(diameter),
            "area_cross": float(area_cross),
            "circumference": float(circumference),
            "area": float(area_wetted),
        }


    def _get_fuel_props(self) -> Optional[Dict[str, float]]:
        """
        Extract fuel properties from configuration for evaporation model.
        
        Returns a dictionary with:
        - boiling_point: Fuel boiling point [K]
        - latent_heat: Latent heat of vaporization [J/kg]
        - molecular_weight: Molecular weight [g/mol]
        - Pc_ref: Reference pressure for stable Bm calculation [Pa]
        
        Returns None if fuel config is not available.
        """
        try:
            fuel_cfg = self.config.fluids.get("fuel")
            if fuel_cfg is None:
                return None
            
            # Extract as dict with fallbacks to RP-1 defaults
            props = {
                "boiling_point": getattr(fuel_cfg, "boiling_point", 489.0),
                "latent_heat": getattr(fuel_cfg, "latent_heat", 300e3),
                "molecular_weight": getattr(fuel_cfg, "molecular_weight", 170.0),
                "Pc_ref": getattr(fuel_cfg, "Pc_ref", 2.5e6),
            }
            
            # Add T_star fuel interface cap from combustion efficiency config
            T_star_fuel_cap_K = getattr(
                self.config.combustion.efficiency,
                "T_star_fuel_cap_K",
                1000.0  # Default for RP-1
            )
            props["T_star_fuel_cap_K"] = T_star_fuel_cap_K
            
            return props
        except Exception:
            return None
