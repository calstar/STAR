"""Helper functions for optimization layers.

Contains:
- Pressure curve generation and manipulation
- Optimization variable conversion
- Utility functions shared across layers
"""

from __future__ import annotations

from typing import Dict, Any, List, Tuple
import numpy as np


def generate_segmented_pressure_curve(
    segments: List[Dict[str, Any]],
    n_points: int = 200,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Generate a pressure curve from a list of segments.
    
    Each segment can be 'linear' or 'blowdown' with its own duration and pressures.
    
    Args:
        segments: List of segment dicts with keys:
            - type: 'linear' or 'blowdown'
            - duration: segment duration in seconds
            - start_pressure_psi: pressure at start of segment
            - end_pressure_psi: pressure at end of segment
            - decay_tau: time constant for blowdown (only for blowdown type)
        n_points: Total number of points in output array
    
    Returns:
        time_array: Array of time points [s]
        pressure_array: Array of pressures [psi]
    """
    if not segments:
        return np.array([0.0]), np.array([500.0])
    
    # Calculate total duration
    total_duration = sum(seg["duration"] for seg in segments)
    
    # Create time array
    time_array = np.linspace(0, total_duration, n_points)
    pressure_array = np.zeros(n_points)
    
    # Build pressure curve segment by segment
    t_start = 0.0
    for seg in segments:
        seg_type = seg["type"]
        seg_duration = seg["duration"]
        P_start = seg["start_pressure_psi"]
        P_end = seg["end_pressure_psi"]
        t_end = t_start + seg_duration
        
        # Find indices for this segment
        mask = (time_array >= t_start) & (time_array <= t_end)
        t_local = time_array[mask] - t_start
        
        if seg_type == "linear":
            # Linear interpolation
            if seg_duration > 0:
                pressure_array[mask] = P_start + (P_end - P_start) * t_local / seg_duration
            else:
                pressure_array[mask] = P_start
        elif seg_type == "blowdown":
            # Exponential decay: P(t) = P_end + (P_start - P_end) * exp(-t/tau)
            tau = seg.get("decay_tau", seg_duration * 0.3)
            if tau <= 0:
                tau = seg_duration * 0.3  # Use 30% as default
            pressure_array[mask] = P_end + (P_start - P_end) * np.exp(-t_local / tau)
        else:
            # Default to linear
            if seg_duration > 0:
                pressure_array[mask] = P_start + (P_end - P_start) * t_local / seg_duration
            else:
                pressure_array[mask] = P_start
        
        t_start = t_end
    
    return time_array, pressure_array


def segments_from_optimizer_vars(
    x_segments: np.ndarray,
    n_segments: int,
    base_pressure_psi: float,
    target_burn_time: float,
    use_initial_as_base: bool = False,
) -> List[Dict[str, Any]]:
    """
    Convert optimizer variables to segment list.
    
    For each segment, optimizer provides:
    - type (0=linear, 1=blowdown) - rounded to int
    - duration_ratio (0-1, fraction of total burn time)
    - start_pressure_ratio (0.7-1.0 for regulation, 0.3-1.0 for blowdown, ratio of base pressure)
    - end_pressure_ratio (0.7-1.0 for regulation, 0.3-1.0 for blowdown, ratio of base pressure)
    - decay_tau_ratio (0-1, fraction of segment duration, only for blowdown)
    
    Args:
        x_segments: Array of optimizer variables for segments
        n_segments: Number of segments (1-20)
        base_pressure_psi: Base pressure [psi] - either max (blowdown) or initial (regulation)
        target_burn_time: Total burn time [s]
        use_initial_as_base: If True, base_pressure_psi is initial pressure (for regulation)
                           If False, base_pressure_psi is max pressure (for blowdown)
    
    Returns:
        List of segment dicts
    """
    segments = []
    vars_per_segment = 5  # type, duration_ratio, start_ratio, end_ratio, tau_ratio
    
    # Ensure n_segments doesn't exceed available array size
    max_available_segments = len(x_segments) // vars_per_segment
    n_segments = min(n_segments, max_available_segments)
    if n_segments < 1:
        n_segments = 1  # At least one segment
    
    # Normalize durations so they sum to 1.0
    duration_ratios = []
    
    for i in range(n_segments):
        idx_base = i * vars_per_segment
        if idx_base + 4 >= len(x_segments):
            break  # Not enough variables for this segment
        duration_ratio = float(np.clip(x_segments[idx_base + 1], 0.01, 1.0))
        duration_ratios.append(duration_ratio)
    
    # Normalize so sum = 1.0
    total_ratio = sum(duration_ratios)
    if total_ratio > 0:
        duration_ratios = [dr / total_ratio for dr in duration_ratios]
    
    # Build segments
    for i in range(n_segments):
        idx_base = i * vars_per_segment
        if idx_base + 4 >= len(x_segments):
            break  # Not enough variables for this segment
        seg_type_val = float(np.clip(x_segments[idx_base], 0.0, 1.0))
        seg_type = "blowdown" if seg_type_val >= 0.5 else "linear"
        duration = duration_ratios[i] * target_burn_time if i < len(duration_ratios) else target_burn_time / n_segments
        
        # CRITICAL: For regulation, pressure ratios are relative to INITIAL pressure
        # For regulation, we want start_ratio ≈ end_ratio ≈ 1.0 (flat profile)
        # For blowdown, we allow end_ratio < start_ratio
        if use_initial_as_base:
            # Regulation mode: ratios relative to initial pressure (0.7-1.0)
            start_ratio = float(np.clip(x_segments[idx_base + 2], 0.7, 1.0))
            end_ratio_raw = float(np.clip(x_segments[idx_base + 3], 0.7, 1.0))
            # For regulation, allow slight drop but prefer flat (end ≈ start)
            # Don't enforce end <= start strictly - optimizer can explore
            end_ratio = end_ratio_raw  # Allow end to be slightly higher for flexibility
        else:
            # Blowdown mode: ratios relative to max pressure (0.1-1.0)
            start_ratio = float(np.clip(x_segments[idx_base + 2], 0.1, 1.0))
            end_ratio_raw = float(np.clip(x_segments[idx_base + 3], 0.1, 1.0))
            # Ensure end <= start for blowdown (physically valid)
            end_ratio = min(end_ratio_raw, start_ratio)
        
        tau_ratio = float(np.clip(x_segments[idx_base + 4], 0.1, 1.0))
        
        # Convert ratios to absolute pressures using base pressure
        start_pressure_psi = start_ratio * base_pressure_psi
        end_pressure_psi = end_ratio * base_pressure_psi
        
        seg = {
            "type": seg_type,
            "duration": duration,
            "start_pressure_psi": start_pressure_psi,
            "end_pressure_psi": end_pressure_psi,
        }
        
        if seg_type == "blowdown":
            seg["decay_tau"] = duration * tau_ratio
        
        segments.append(seg)
    
    return segments


def optimizer_vars_from_segments(
    segments: List[Dict[str, Any]],
    max_pressure_psi: float,
    target_burn_time: float,
) -> np.ndarray:
    """
    Convert segment list to optimizer variables.
    
    Inverse of segments_from_optimizer_vars.
    """
    vars_per_segment = 5
    n_segments = len(segments)
    x = np.zeros(n_segments * vars_per_segment)
    
    total_duration = sum(seg["duration"] for seg in segments)
    
    for i, seg in enumerate(segments):
        idx_base = i * vars_per_segment
        x[idx_base] = 1.0 if seg["type"] == "blowdown" else 0.0
        x[idx_base + 1] = seg["duration"] / total_duration if total_duration > 0 else 1.0 / n_segments
        x[idx_base + 2] = seg["start_pressure_psi"] / max_pressure_psi
        x[idx_base + 3] = seg["end_pressure_psi"] / max_pressure_psi
        x[idx_base + 4] = seg.get("decay_tau", seg["duration"] * 0.3) / seg["duration"] if seg["duration"] > 0 else 0.3
    
    return x

