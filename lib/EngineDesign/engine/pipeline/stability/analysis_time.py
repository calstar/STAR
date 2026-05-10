"""Time-varying stability analysis for complete engine system.

This module provides rigorous stability analysis that accounts for:
1. Time-varying geometry (L*, throat area, chamber volume)
2. Time-varying reaction chemistry (affects shifting equilibrium)
3. Time-varying chamber dynamics (pressure, temperature, efficiency)
4. Ablative/graphite recession effects
5. Coupling between all systems

Stability metrics are calculated at each time step and tracked over the burn.
"""

from __future__ import annotations

from typing import Dict, List, Tuple, Optional
import numpy as np
from engine.pipeline.stability.analysis import (
    calculate_chugging_frequency,
    calculate_acoustic_modes,
    analyze_feed_system_stability,
)


def analyze_stability_over_time(
    time_history: np.ndarray,
    state_history: List[Any],  # List of TimeVaryingState
) -> Dict[str, np.ndarray]:
    """
    Analyze stability metrics over time with full coupling.
    
    Parameters:
    -----------
    time_history : np.ndarray
        Time points [s]
    state_history : List[TimeVaryingState]
        Complete state history from coupled solver
    
    Returns:
    --------
    stability_results : dict
        Time-varying stability metrics:
        - chugging_frequency: [Hz]
        - chugging_stability_margin: (positive = stable)
        - acoustic_frequencies: Dict of mode frequencies [Hz]
        - feed_stability_margins: Dict of feed system margins
        - overall_stability: Combined stability metric
        - stability_degradation: Change in stability over time
    """
    n = len(time_history)
    
    # Extract stability metrics from state history
    chugging_freq = np.array([s.chugging_frequency for s in state_history])
    chugging_margin = np.array([s.chugging_stability_margin for s in state_history])
    
    # Extract acoustic modes (first longitudinal mode)
    acoustic_freq_1L = np.array([s.acoustic_modes.get("1L", np.nan) for s in state_history])
    
    # Extract feed stability
    feed_margins = {}
    if state_history and state_history[0].feed_stability:
        for key in state_history[0].feed_stability.keys():
            feed_margins[key] = np.array([s.feed_stability.get(key, np.nan) for s in state_history])
    
    # Calculate overall stability metric
    # Combine all stability margins (weighted average)
    # Positive = stable, negative = unstable
    overall_stability = np.zeros(n)
    
    # Chugging stability (weight: 0.4)
    overall_stability += 0.4 * chugging_margin
    
    # Feed system stability (weight: 0.3)
    if feed_margins:
        feed_combined = np.mean([m for m in feed_margins.values()], axis=0)
        overall_stability += 0.3 * feed_combined
    
    # Acoustic stability (weight: 0.3)
    # Higher frequency = more stable (further from chugging)
    if np.any(np.isfinite(acoustic_freq_1L)):
        # Normalize: higher frequency = better
        acoustic_normalized = (acoustic_freq_1L - np.nanmin(acoustic_freq_1L)) / (
            np.nanmax(acoustic_freq_1L) - np.nanmin(acoustic_freq_1L) + 1e-9
        )
        overall_stability += 0.3 * acoustic_normalized
    
    # Calculate stability degradation
    if n > 1:
        stability_degradation = overall_stability[-1] - overall_stability[0]
    else:
        stability_degradation = 0.0
    
    # Identify stability issues
    stability_issues = []
    if np.any(chugging_margin < 0):
        stability_issues.append("Chugging instability detected")
    if feed_margins and np.any([np.any(m < 0) for m in feed_margins.values()]):
        stability_issues.append("Feed system instability detected")
    if np.any(overall_stability < 0):
        stability_issues.append("Overall system instability detected")
    
    results = {
        "time": time_history,
        "chugging_frequency": chugging_freq,
        "chugging_stability_margin": chugging_margin,
        "acoustic_frequency_1L": acoustic_freq_1L,
        "overall_stability": overall_stability,
        "stability_degradation": stability_degradation,
        "stability_issues": stability_issues,
    }
    
    # Add feed stability margins
    for key, values in feed_margins.items():
        results[f"feed_stability_{key}"] = values
    
    return results


def predict_stability_failure(
    time_history: np.ndarray,
    stability_history: Dict[str, np.ndarray],
    threshold_margin: float = 0.1,
) -> Optional[float]:
    """
    Predict time of stability failure based on degradation trend.
    
    Parameters:
    -----------
    time_history : np.ndarray
        Time points [s]
    stability_history : dict
        Stability metrics over time
    threshold_margin : float
        Stability margin threshold (below this = failure)
    
    Returns:
    --------
    failure_time : float or None
        Predicted failure time [s], or None if stable
    """
    overall_stability = stability_history["overall_stability"]
    
    # Find where stability crosses threshold
    below_threshold = overall_stability < threshold_margin
    
    if np.any(below_threshold):
        # Find first crossing
        first_crossing_idx = np.where(below_threshold)[0]
        if len(first_crossing_idx) > 0:
            return float(time_history[first_crossing_idx[0]])
    
    # Extrapolate if degrading
    if len(overall_stability) >= 2:
        degradation_rate = (overall_stability[-1] - overall_stability[0]) / (time_history[-1] - time_history[0])
        
        if degradation_rate < 0:  # Degrading
            # Linear extrapolation
            time_to_failure = (threshold_margin - overall_stability[-1]) / degradation_rate
            predicted_failure_time = time_history[-1] + time_to_failure
            
            if predicted_failure_time > time_history[-1]:
                return float(predicted_failure_time)
    
    return None  # Stable

