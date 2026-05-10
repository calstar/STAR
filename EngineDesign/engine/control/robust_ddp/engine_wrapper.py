"""Engine physics wrapper for robust DDP controller.

Wraps the existing PintleEngineRunner to provide estimates from feed pressures
with caching for efficient DDP rollouts.
"""

from __future__ import annotations

from typing import Dict, Any, Optional, Tuple
from dataclasses import dataclass
import numpy as np
from functools import lru_cache
import hashlib

from engine.core.runner import PintleEngineRunner
from engine.pipeline.config_schemas import PintleEngineConfig


@dataclass
class EngineEstimate:
    """Engine performance estimate from feed pressures."""
    # Chamber pressure
    P_ch: float  # [Pa]
    
    # Thrust and performance
    F: float  # Thrust [N]
    mdot_F: float  # Fuel mass flow [kg/s]
    mdot_O: float  # Oxidizer mass flow [kg/s]
    MR: float  # Mixture ratio (O/F)
    
    # Injector pressure drops
    injector_dp_F: float  # P_d_F - P_ch [Pa]
    injector_dp_O: float  # P_d_O - P_ch [Pa]
    
    # Stability metrics (if available)
    stability_metrics: Optional[Dict[str, Any]] = None
    
    # Additional diagnostics
    diagnostics: Optional[Dict[str, Any]] = None


class EngineWrapper:
    """Wrapper around PintleEngineRunner with caching for DDP rollouts."""
    
    def __init__(self, config: PintleEngineConfig, cache_size: int = 128):
        """
        Initialize engine wrapper.
        
        Parameters:
        -----------
        config : PintleEngineConfig
            Engine configuration
        cache_size : int
            Maximum number of cached results (LRU cache size)
        """
        self.config = config
        self.runner = PintleEngineRunner(config)
        self.cache_size = cache_size
        
        # Create cached evaluation function
        self._cached_evaluate = self._create_cached_evaluator()
    
    def _create_cached_evaluator(self):
        """Create LRU-cached evaluator function."""
        @lru_cache(maxsize=self.cache_size)
        def cached_evaluate(cache_key: str) -> Dict[str, Any]:
            """Cached evaluation (key is hash of pressures)."""
            # This will be called by estimate_from_pressures after cache key lookup
            # The actual evaluation happens there
            raise RuntimeError("This should not be called directly")
        
        return cached_evaluate
    
    def _make_cache_key(self, P_d_F: float, P_d_O: float, precision: int = 3) -> str:
        """
        Create cache key from feed pressures.
        
        Parameters:
        -----------
        P_d_F : float
            Fuel feed pressure [Pa]
        P_d_O : float
            Oxidizer feed pressure [Pa]
        precision : int
            Decimal places for rounding (reduces cache misses from floating point)
        
        Returns:
        --------
        key : str
            Cache key string
        """
        # Round to reduce cache misses from floating point precision
        P_d_F_rounded = round(P_d_F, precision)
        P_d_O_rounded = round(P_d_O, precision)
        
        # Create hash key
        key_str = f"{P_d_F_rounded:.{precision}f}_{P_d_O_rounded:.{precision}f}"
        return hashlib.md5(key_str.encode()).hexdigest()
    
    def estimate_from_pressures(
        self,
        P_d_F: float,
        P_d_O: float,
        use_cache: bool = True,
    ) -> EngineEstimate:
        """
        Estimate engine performance from tank/ullage pressures.
        
        **IMPORTANT**: Despite the parameter names (P_d_F, P_d_O), these represent
        TANK/ULLAGE PRESSURES (P_u_F, P_u_O), NOT feed/downstream pressures.
        The engine physics pipeline expects tank pressures and internally calculates
        feed line losses.
        
        Parameters:
        -----------
        P_d_F : float
            Fuel tank/ullage pressure [Pa] (P_u_F in state vector)
            NOTE: Parameter name is misleading - this is actually tank pressure, not feed pressure
        P_d_O : float
            Oxidizer tank/ullage pressure [Pa] (P_u_O in state vector)
            NOTE: Parameter name is misleading - this is actually tank pressure, not feed pressure
        use_cache : bool
            Whether to use caching (default: True)
        
        Returns:
        --------
        estimate : EngineEstimate
            Engine performance estimate with validated thrust, MR, and mass flows
        
        Notes:
        ------
        The engine physics pipeline (PintleEngineRunner.evaluate) expects tank pressures
        as input. The controller state uses P_u_F and P_u_O for tank/ullage pressures,
        which are passed directly to this function. Feed pressures (P_d_F, P_d_O) are
        downstream and lag behind tank pressures due to line dynamics.
        
        The estimate is validated to ensure consistency:
        - If mass flows are invalid, MR is set to NaN
        - If MR is invalid, thrust and mass flows are set to NaN
        - If thrust is invalid, MR and mass flows are set to NaN
        This prevents inconsistent estimates like non-zero thrust with zero MR.
        """
        # Check cache first
        cache_key = self._make_cache_key(P_d_F, P_d_O)
        
        if use_cache and hasattr(self, '_result_cache'):
            if cache_key in self._result_cache:
                return self._result_cache[cache_key]
        else:
            # Initialize cache dict if not exists
            if not hasattr(self, '_result_cache'):
                self._result_cache = {}
        
        # Call existing pipeline
        # NOTE: P_d_F and P_d_O parameters represent tank/ullage pressures (P_u_F, P_u_O)
        # The engine physics expects tank pressures and internally calculates feed losses
        try:
            results = self.runner.evaluate(
                P_tank_O=P_d_O,  # Tank/ullage pressure (parameter name is misleading)
                P_tank_F=P_d_F,  # Tank/ullage pressure (parameter name is misleading)
                silent=True,  # Suppress logging for DDP rollouts
            )
        except Exception as e:
            # If evaluation fails, return a minimal estimate with NaN values
            # This allows DDP to handle infeasible pressure combinations
            return EngineEstimate(
                P_ch=np.nan,
                F=np.nan,
                mdot_F=np.nan,
                mdot_O=np.nan,
                MR=np.nan,
                injector_dp_F=np.nan,
                injector_dp_O=np.nan,
                stability_metrics=None,
                diagnostics={"error": str(e)},
            )
        
        # Extract chamber pressure
        P_ch = results.get("Pc", np.nan)
        
        # Extract mass flows
        mdot_F = results.get("mdot_F", np.nan)
        mdot_O = results.get("mdot_O", np.nan)
        
        # Extract mixture ratio
        MR = results.get("MR", np.nan)
        
        # Extract thrust
        F = results.get("F", np.nan)
        
        # Validate engine estimate consistency
        # Rule 1: If either mass flow is zero/NaN, MR should be NaN
        if (not np.isfinite(mdot_F) or mdot_F <= 0) or (not np.isfinite(mdot_O) or mdot_O <= 0):
            if np.isfinite(MR) and MR > 0:
                # Inconsistent: mass flows invalid but MR is valid
                MR = np.nan
        
        # Rule 2: If MR is invalid, thrust should also be invalid (unless engine is off)
        # Actually, allow thrust to be zero when MR is NaN (engine off state)
        # But if thrust is non-zero and MR is NaN, that's inconsistent
        if not np.isfinite(MR) or MR <= 0:
            if np.isfinite(F) and F > 0:
                # Inconsistent: non-zero thrust but invalid MR
                F = np.nan
                # Also invalidate mass flows
                mdot_F = np.nan
                mdot_O = np.nan
        
        # Rule 3: If thrust is invalid, MR and mass flows should also be invalid
        if not np.isfinite(F) or F <= 0:
            if np.isfinite(MR) and MR > 0:
                # Inconsistent: invalid thrust but valid MR
                MR = np.nan
            if np.isfinite(mdot_F) and mdot_F > 0:
                mdot_F = np.nan
            if np.isfinite(mdot_O) and mdot_O > 0:
                mdot_O = np.nan
        
        # Rule 4: If MR is valid, both mass flows should be valid and non-zero
        if np.isfinite(MR) and MR > 0:
            if not np.isfinite(mdot_F) or mdot_F <= 0:
                # Inconsistent: valid MR but invalid fuel flow
                MR = np.nan
                F = np.nan
            if not np.isfinite(mdot_O) or mdot_O <= 0:
                # Inconsistent: valid MR but invalid oxidizer flow
                MR = np.nan
                F = np.nan
        
        # Compute injector pressure drops
        injector_dp_F = P_d_F - P_ch if np.isfinite(P_d_F) and np.isfinite(P_ch) else np.nan
        injector_dp_O = P_d_O - P_ch if np.isfinite(P_d_O) and np.isfinite(P_ch) else np.nan
        
        # Extract stability metrics if available
        stability_metrics = None
        diagnostics = results.get("diagnostics", {})
        stability_results = results.get("stability", None) or results.get("stability_results", None)
        
        if stability_results is not None:
            # Use comprehensive stability results if available
            stability_metrics = {
                "stability_state": stability_results.get("stability_state", "unknown"),
                "stability_score": stability_results.get("stability_score", np.nan),
                "chugging": stability_results.get("chugging", {}),
                "acoustic": stability_results.get("acoustic", {}),
                "feed_system": stability_results.get("feed_system", {}),
            }
        else:
            # Compute minimal injector stiffness constraints
            # These are based on injector pressure drop requirements
            injector_dp_frac_F = injector_dp_F / P_d_F if P_d_F > 0 else np.nan
            injector_dp_frac_O = injector_dp_O / P_d_O if P_d_O > 0 else np.nan
            
            stability_metrics = {
                "stability_state": "unknown",
                "stability_score": np.nan,
                "injector_dp_frac_F": injector_dp_frac_F,
                "injector_dp_frac_O": injector_dp_frac_O,
                "injector_stiffness_ok": (
                    np.isfinite(injector_dp_frac_F) and injector_dp_frac_F > 0.1 and
                    np.isfinite(injector_dp_frac_O) and injector_dp_frac_O > 0.1
                ),
            }
        
        # Create estimate
        estimate = EngineEstimate(
            P_ch=P_ch,
            F=F,
            mdot_F=mdot_F,
            mdot_O=mdot_O,
            MR=MR,
            injector_dp_F=injector_dp_F,
            injector_dp_O=injector_dp_O,
            stability_metrics=stability_metrics,
            diagnostics=diagnostics,
        )
        
        # Cache result
        if use_cache:
            # Limit cache size (simple LRU by keeping only recent N entries)
            if len(self._result_cache) >= self.cache_size:
                # Remove oldest entry (simple FIFO)
                oldest_key = next(iter(self._result_cache))
                del self._result_cache[oldest_key]
            
            self._result_cache[cache_key] = estimate
        
        return estimate
    
    def clear_cache(self) -> None:
        """Clear the evaluation cache."""
        if hasattr(self, '_result_cache'):
            self._result_cache.clear()
    
    def get_cache_stats(self) -> Dict[str, Any]:
        """Get cache statistics."""
        if not hasattr(self, '_result_cache'):
            return {"size": 0, "max_size": self.cache_size}
        
        return {
            "size": len(self._result_cache),
            "max_size": self.cache_size,
            "usage": len(self._result_cache) / self.cache_size if self.cache_size > 0 else 0.0,
        }


# Convenience function for direct use
def estimate_from_pressures(
    P_d_F: float,
    P_d_O: float,
    config: PintleEngineConfig,
    use_cache: bool = True,
) -> EngineEstimate:
    """
    Estimate engine performance from tank/ullage pressures (convenience function).
    
    **IMPORTANT**: Despite parameter names (P_d_F, P_d_O), these represent
    TANK/ULLAGE PRESSURES (P_u_F, P_u_O), NOT feed/downstream pressures.
    
    Parameters:
    -----------
    P_d_F : float
        Fuel tank/ullage pressure [Pa] (P_u_F - parameter name is misleading)
    P_d_O : float
        Oxidizer tank/ullage pressure [Pa] (P_u_O - parameter name is misleading)
    config : PintleEngineConfig
        Engine configuration
    use_cache : bool
        Whether to use caching (default: True)
    
    Returns:
    --------
    estimate : EngineEstimate
        Engine performance estimate with validated thrust, MR, and mass flows
    
    Note:
    -----
    This function creates a temporary EngineWrapper. For repeated calls,
    create an EngineWrapper instance and reuse it.
    """
    wrapper = EngineWrapper(config, cache_size=128)
    return wrapper.estimate_from_pressures(P_d_F, P_d_O, use_cache=use_cache)

