"""Graphite throat insert geometry sizing based on physics-based wall model with oxidation heat feedback.

This module implements the sizing methodology from graphite_geometry.tex to determine:
- Radial thickness (recession allowance + conduction + mechanical + safety factor)
- Axial length (based on heat flux profile)
- Transient verification through burn time

The algorithm follows the method described in the LaTeX document for sizing graphite inserts
that keep the back surface within safe temperature limits while providing recession allowance
and mechanical support.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Tuple, Optional, Callable, Union
import numpy as np


@dataclass
class GraphiteInsertSizing:
    """Structured results from graphite insert sizing calculation."""
    # Inputs (echoed for logging)
    peak_heat_flux: float
    surface_temperature: float
    recession_rate: float
    burn_time: float
    thermal_conductivity: float
    backface_temperature_max: float
    throat_diameter: float
    mechanical_thickness: float
    safety_factor: float
    
    # Thickness components
    recession_allowance: float
    conduction_thickness: float
    conduction_model: str  # "steady_state" or "transient" or "max"
    safety_margin: float
    initial_thickness: float
    
    # Axial lengths
    axial_half_length_upstream: float
    axial_half_length_downstream: float
    total_axial_length: float
    sizing_method: str  # "heat_flux_profile" or "simple_rule"
    
    # Throat growth
    throat_diameter_initial: float
    throat_diameter_end: float
    throat_area_change: float
    throat_area_change_pct: float
    
    # Integrity flags and notes
    throat_area_change_excessive: bool  # True if area_change_pct > 3%
    conduction_thickness_zero: bool  # True if t_cond == 0 (T_s <= T_b,max)
    transient_backface_warning: bool  # True if transient backface check fails
    integrity_note: str  # Human-readable note about any issues
    
    def to_dict(self) -> Dict[str, Union[float, str]]:
        """Convert to dictionary for backward compatibility."""
        return {
            "peak_heat_flux": self.peak_heat_flux,
            "surface_temperature": self.surface_temperature,
            "recession_rate": self.recession_rate,
            "burn_time": self.burn_time,
            "thermal_conductivity": self.thermal_conductivity,
            "backface_temperature_max": self.backface_temperature_max,
            "throat_diameter": self.throat_diameter,
            "mechanical_thickness": self.mechanical_thickness,
            "safety_factor": self.safety_factor,
            "recession_allowance": self.recession_allowance,
            "conduction_thickness": self.conduction_thickness,
            "conduction_model": self.conduction_model,
            "safety_margin": self.safety_margin,
            "initial_thickness": self.initial_thickness,
            "axial_half_length_upstream": self.axial_half_length_upstream,
            "axial_half_length_downstream": self.axial_half_length_downstream,
            "total_axial_length": self.total_axial_length,
            "sizing_method": self.sizing_method,
            "throat_diameter_initial": self.throat_diameter_initial,
            "throat_diameter_end": self.throat_diameter_end,
            "throat_area_change": self.throat_area_change,
            "throat_area_change_pct": self.throat_area_change_pct,
            "throat_area_change_excessive": self.throat_area_change_excessive,
            "conduction_thickness_zero": self.conduction_thickness_zero,
            "transient_backface_warning": self.transient_backface_warning,
            "integrity_note": self.integrity_note,
        }


def _validate_inputs(
    peak_heat_flux: float,
    burn_time: float,
    throat_diameter: float,
    thermal_conductivity: float,
    density: Optional[float] = None,
    specific_heat: Optional[float] = None,
    heat_flux_profile: Optional[Callable] = None,
    allowable_heat_flux_adjacent: Optional[float] = None,
) -> None:
    """Validate inputs and raise ValueError if invalid."""
    if peak_heat_flux <= 0:
        raise ValueError(f"peak_heat_flux must be > 0, got {peak_heat_flux}")
    if burn_time <= 0:
        raise ValueError(f"burn_time must be > 0, got {burn_time}")
    if throat_diameter <= 0:
        raise ValueError(f"throat_diameter must be > 0, got {throat_diameter}")
    if thermal_conductivity <= 0:
        raise ValueError(f"thermal_conductivity must be > 0, got {thermal_conductivity}")
    if density is not None and density <= 0:
        raise ValueError(f"density must be > 0, got {density}")
    if specific_heat is not None and specific_heat <= 0:
        raise ValueError(f"specific_heat must be > 0, got {specific_heat}")
    if heat_flux_profile is not None and allowable_heat_flux_adjacent is None:
        raise ValueError(
            "allowable_heat_flux_adjacent must be provided when heat_flux_profile is provided"
        )
    if allowable_heat_flux_adjacent is not None and allowable_heat_flux_adjacent <= 0:
        raise ValueError(
            f"allowable_heat_flux_adjacent must be > 0, got {allowable_heat_flux_adjacent}"
        )


def _check_finite(
    peak_heat_flux: float,
    surface_temperature: float,
    recession_rate: float,
    burn_time: float,
    thermal_conductivity: float,
    backface_temperature_max: float,
    throat_diameter: float,
    density: Optional[float] = None,
    specific_heat: Optional[float] = None,
) -> None:
    """Check that all inputs are finite (not NaN or Inf)."""
    inputs = {
        "peak_heat_flux": peak_heat_flux,
        "surface_temperature": surface_temperature,
        "recession_rate": recession_rate,
        "burn_time": burn_time,
        "thermal_conductivity": thermal_conductivity,
        "backface_temperature_max": backface_temperature_max,
        "throat_diameter": throat_diameter,
    }
    if density is not None:
        inputs["density"] = density
    if specific_heat is not None:
        inputs["specific_heat"] = specific_heat
    
    for name, value in inputs.items():
        if not np.isfinite(value):
            raise ValueError(f"{name} must be finite, got {value}")


def _vectorized_heat_flux_profile(
    heat_flux_profile: Callable[[np.ndarray], np.ndarray],
    x: Union[float, np.ndarray],
) -> Union[float, np.ndarray]:
    """
    Ensure heat_flux_profile is called with vectorized input.
    
    Parameters:
    -----------
    heat_flux_profile : callable
        Function that accepts np.ndarray and returns np.ndarray
    x : float or np.ndarray
        Axial position(s) [m]
    
    Returns:
    --------
    q : float or np.ndarray
        Heat flux [W/m²]
    """
    x_array = np.atleast_1d(x)
    q_array = heat_flux_profile(x_array)
    if np.isscalar(x):
        return q_array[0]  # Explicit indexing for numerical safety
    return q_array


def calculate_recession_allowance(
    recession_rate: float,
    burn_time: float,
) -> float:
    """
    Calculate recession allowance from recession rate and burn time.
    
    From equation (eq:q_to_rdot) in graphite_geometry.tex:
        Δ_ablate = ṙ × t_b
    
    This is the total material that will be removed during the burn.
    
    Parameters:
    -----------
    recession_rate : float
        Net recession rate [m/s] from wall model output
    burn_time : float
        Total burn time [s]
    
    Returns:
    --------
    delta_ablate : float
        Recession allowance [m]
    """
    return recession_rate * burn_time


def calculate_conduction_thickness(
    thermal_conductivity: float,
    surface_temperature: float,
    backface_temperature_max: float,
    peak_heat_flux: float,
) -> float:
    """
    Calculate minimum conduction thickness to keep back face below temperature limit (steady-state).
    
    From equation (eq:tcond) in graphite_geometry.tex:
        t_cond ≥ k × (T_s - T_b,max) / q''_peak
    
    This is a conservative estimate assuming steady-state conduction through
    the remaining thickness under peak heat flux.
    
    Parameters:
    -----------
    thermal_conductivity : float
        Graphite thermal conductivity [W/(m·K)]
    surface_temperature : float
        Surface temperature T_s [K] from wall model at design point
    backface_temperature_max : float
        Maximum allowable back-face temperature T_b,max [K] for metal substrate or adhesive
    peak_heat_flux : float
        Peak convective heat flux at throat q''_peak [W/m²]
    
    Returns:
    --------
    t_cond : float
        Minimum conduction thickness [m]
    """
    if peak_heat_flux <= 0:
        return 0.0
    
    t_cond = thermal_conductivity * (surface_temperature - backface_temperature_max) / peak_heat_flux
    return max(t_cond, 0.0)


def calculate_conduction_thickness_transient(
    thermal_conductivity: float,
    density: float,
    specific_heat: float,
    surface_heat_flux: float,
    burn_time: float,
    delta_T_backface_max: float,
    eta: float = 2.5,
) -> Tuple[float, bool]:
    """
    Calculate minimum conduction thickness using transient semi-infinite solid bound.
    
    For short burns, the back face heats by diffusion. This provides a conservative
    transient option that often reduces over-thick designs or catches under-thick ones
    when q'' spikes.
    
    Diffusion scale:
        t_cond ≥ η * sqrt(α t_b)
    
    Temperature rise check (independent):
        ΔT_back(t) ≈ (2 q'' / k) * sqrt(α t / π)
    
    where η ≈ 2–3 is a safety factor capturing that finite slabs heat faster near backface.
    
    Parameters:
    -----------
    thermal_conductivity : float
        Thermal conductivity k [W/(m·K)]
    density : float
        Material density ρ_s [kg/m³]
    specific_heat : float
        Specific heat c_p [J/(kg·K)]
    surface_heat_flux : float
        Surface heat flux q'' [W/m²]
    burn_time : float
        Burn time t_b [s]
    delta_T_backface_max : float
        Maximum allowable back-face temperature rise T_b,max - T_init [K]
    eta : float
        Safety factor (default 2.5, range 2-3) for conservatism
    
    Returns:
    --------
    t_cond : float
        Minimum conduction thickness [m] (diffusion scale)
    meets_backface : bool
        True if backface temperature rise is within limit with this thickness
    """
    alpha = thermal_conductivity / (density * specific_heat)
    
    # Diffusion scale: minimum penetration depth
    t_cond = eta * np.sqrt(alpha * burn_time)
    
    # Independently check temperature rise constraint
    meets_backface = True
    if delta_T_backface_max > 0 and surface_heat_flux > 0:
        # From semi-infinite solution: ΔT = (2 q'' / k) * sqrt(α t / π)
        delta_T_estimate = (2.0 * surface_heat_flux / thermal_conductivity) * np.sqrt(alpha * burn_time / np.pi)
        meets_backface = delta_T_estimate <= delta_T_backface_max
    
    return max(t_cond, 0.0), meets_backface


def calculate_initial_thickness(
    recession_allowance: float,
    conduction_thickness: float,
    mechanical_thickness: float = 0.001,
    safety_factor: float = 0.3,
) -> float:
    """
    Calculate initial radial thickness at throat.
    
    From equation (eq:thickness) in graphite_geometry.tex:
        t_insert,0 = Δ_ablate + t_cond + t_mech + φ_sf
    
    where:
    - Δ_ablate: recession allowance from wall model
    - t_cond: conduction thickness for back-face temperature control
    - t_mech: mechanical lip, fit, and strength requirements
    - φ_sf: safety factor (typically 30-50% of (Δ_ablate + t_cond))
    
    Parameters:
    -----------
    recession_allowance : float
        Recession allowance Δ_ablate [m]
    conduction_thickness : float
        Conduction thickness t_cond [m]
    mechanical_thickness : float
        Mechanical thickness t_mech [m] for groove, seating, strength
        Typical: 0.5-1.5 mm for small throats, thicker for large bores
    safety_factor : float
        Safety factor as fraction (0.3 = 30%, 0.5 = 50%)
        Applied to (Δ_ablate + t_cond) to cover property scatter and profile uncertainty
    
    Returns:
    --------
    t_insert_0 : float
        Initial radial thickness at throat [m]
    """
    base_thickness = recession_allowance + conduction_thickness
    safety_margin = safety_factor * base_thickness
    t_insert_0 = base_thickness + mechanical_thickness + safety_margin
    return max(t_insert_0, 0.0)


def calculate_axial_lengths_from_profile(
    heat_flux_profile: Callable[[np.ndarray], np.ndarray],
    allowable_heat_flux_adjacent: float,
    throat_diameter: float,
) -> Tuple[float, float]:
    """
    Calculate axial half-lengths upstream and downstream separately.
    
    The upstream shoulder sees a different q''(x) than downstream. This function
    solves for both half-lengths independently.
    
    From section "Axial length" in graphite_geometry.tex:
        q''(|x| = L_±) ≤ q''_allow,adjacent
    
    where x < 0 is upstream and x > 0 is downstream.
    
    Parameters:
    -----------
    heat_flux_profile : callable
        Function q''(x) that returns heat flux [W/m²] at axial position x [m]
        Must accept np.ndarray and return np.ndarray (vectorized).
        x=0 is at throat, x < 0 is upstream, x > 0 is downstream
    allowable_heat_flux_adjacent : float
        Maximum heat flux q''_allow,adjacent [W/m²] that adjacent material can handle
    throat_diameter : float
        Throat diameter D_t [m]
    
    Returns:
    --------
    L_upstream : float
        Axial half-length upstream [m] (negative x direction)
    L_downstream : float
        Axial half-length downstream [m] (positive x direction)
    """
    def find_L(sign: float) -> float:
        """Find half-length in direction given by sign (-1 for upstream, +1 for downstream)."""
        L_min = 0.1 * throat_diameter
        L_max = 2.5 * throat_diameter
        
        # Binary search: find smallest |L| where q''(±L) ≤ q_allow
        # When q <= q_allow, move upper bound down (to find smaller L)
        # When q > q_allow, move lower bound up (need larger L)
        for _ in range(24):
            L_mid = 0.5 * (L_min + L_max)
            x_test = np.array([sign * L_mid])
            q_array = _vectorized_heat_flux_profile(heat_flux_profile, x_test)
            q = q_array[0] if isinstance(q_array, np.ndarray) else q_array  # Explicit indexing
            
            if q <= allowable_heat_flux_adjacent:
                L_max = L_mid  # Move upper bound down to find smaller L
            else:
                L_min = L_mid  # Move lower bound up, need larger L
            
            if abs(L_max - L_min) < 1e-6:
                break
        
        return L_max  # Return the smallest L that satisfies q <= q_allow
    
    L_upstream = find_L(-1.0)
    L_downstream = find_L(+1.0)
    
    return L_upstream, L_downstream


def calculate_axial_length_simple(
    throat_diameter: float,
    length_factor: float = 0.75,
) -> Tuple[float, float]:
    """
    Simple rule-of-thumb for axial half-lengths when heat flux profile is not available.
    
    From graphite_geometry.tex:
        L_± = (0.5 to 1.0) × D_t on each side of throat
    
    Many teams converge to a total graphite length of 1.5 to 2.5 × D_t.
    
    Parameters:
    -----------
    throat_diameter : float
        Throat diameter D_t [m]
    length_factor : float
        Factor to multiply D_t (default 0.75, range 0.5-1.0)
    
    Returns:
    --------
    L_upstream : float
        Axial half-length upstream [m]
    L_downstream : float
        Axial half-length downstream [m]
    """
    L = length_factor * throat_diameter
    return L, L


def calculate_thermal_penetration_depth(
    thermal_conductivity: float,
    density: float,
    specific_heat: float,
    time: float,
) -> float:
    """
    Calculate thermal penetration depth for 1D semi-infinite solid.
    
    From section "Transient conduction and penetration depth" in graphite_geometry.tex:
        δ(t) = √(α × t)
        α = k / (ρ_s × c_p)
    
    This is a conservative bound for thickness estimation. The heat footprint is narrow
    and flux decays strongly away from throat, so this over-predicts for real nozzles.
    Use it to bound the thickness, not to set it directly.
    
    Parameters:
    -----------
    thermal_conductivity : float
        Thermal conductivity k [W/(m·K)]
    density : float
        Material density ρ_s [kg/m³]
    specific_heat : float
        Specific heat c_p [J/(kg·K)]
    time : float
        Time t [s]
    
    Returns:
    --------
    penetration_depth : float
        Thermal penetration depth δ [m]
    """
    alpha = thermal_conductivity / (density * specific_heat)
    penetration_depth = np.sqrt(alpha * time)
    return penetration_depth


def throat_growth_check(
    throat_diameter_initial: float,
    recession_allowance: float,
) -> Dict[str, float]:
    """
    Check throat growth due to recession and calculate area change.
    
    Recession at the throat increases A_t → lowers q''_peak but also changes performance.
    This provides a simple post-check to warn if ΔA_t/A_t > 2-3%.
    
    Parameters:
    -----------
    throat_diameter_initial : float
        Initial throat diameter D_t,0 [m]
    recession_allowance : float
        Recession allowance Δ_ablate [m] (radial loss on each side)
    
    Returns:
    --------
    results : dict
        Dictionary containing:
        - throat_diameter_end: D_t,end [m]
        - throat_area_initial: A_t,0 [m²]
        - throat_area_end: A_t,end [m²]
        - throat_area_change: ΔA_t [m²]
        - throat_area_change_pct: ΔA_t/A_t,0 [%]
    """
    # Radial loss on each side of bore
    # Note: recession reduces the inner diameter, so D_t increases
    Dt_end = max(throat_diameter_initial + 2.0 * recession_allowance, 1e-6)
    
    At_initial = (np.pi / 4.0) * throat_diameter_initial ** 2
    At_end = (np.pi / 4.0) * Dt_end ** 2
    area_change = At_end - At_initial
    area_change_pct = (area_change / At_initial) * 100.0 if At_initial > 0 else 0.0
    
    return {
        "throat_diameter_end": float(Dt_end),
        "throat_area_initial": float(At_initial),
        "throat_area_end": float(At_end),
        "throat_area_change": float(area_change),
        "throat_area_change_pct": float(area_change_pct),
    }


def verify_transient_thickness(
    time: np.ndarray,
    recession_rate: np.ndarray,
    initial_thickness: float,
    mechanical_thickness: float = 0.001,
) -> Dict[str, float]:
    """
    Verify thickness throughout burn by integrating recession rate over time.
    
    Most of the error comes from assuming constant q'' and ṙ. This function allows
    you to feed per-time-step wall-model results (q''(t), T_s(t), ṙ(t)) and integrate
    consumed thickness.
    
    Parameters:
    -----------
    time : np.ndarray
        Time array [s]
    recession_rate : np.ndarray
        Recession rate ṙ(t) [m/s] from wall model per step
    initial_thickness : float
        Initial thickness t_insert,0 [m]
    mechanical_thickness : float
        Minimum mechanical thickness [m] to check against
    
    Returns:
    --------
    results : dict
        Dictionary containing:
        - consumed: Total consumed thickness [m]
        - remaining: Remaining thickness at end [m]
        - min_remaining: Minimum remaining thickness during burn [m]
        - meets_mechanical: bool, whether min_remaining >= mechanical_thickness
    """
    if len(time) != len(recession_rate):
        raise ValueError(f"time and recession_rate must have same length, got {len(time)} and {len(recession_rate)}")
    
    if len(time) < 2:
        raise ValueError("time array must have at least 2 elements")
    
    # Calculate time steps
    dt = np.diff(time, prepend=time[0])
    
    # Integrate recession
    consumed = np.sum(recession_rate * dt)
    remaining = initial_thickness - consumed
    
    # Track minimum remaining (accounting for cumulative consumption)
    cumulative_consumed = np.cumsum(recession_rate * dt)
    remaining_history = initial_thickness - cumulative_consumed
    min_remaining = float(np.min(remaining_history))
    
    meets_mechanical = min_remaining >= mechanical_thickness
    
    return {
        "consumed": float(consumed),
        "remaining": float(remaining),
        "min_remaining": float(min_remaining),
        "meets_mechanical": bool(meets_mechanical),
    }


def size_graphite_insert(
    peak_heat_flux: float,
    surface_temperature: float,
    recession_rate: float,
    burn_time: float,
    thermal_conductivity: float,
    backface_temperature_max: float,
    throat_diameter: float,
    density: Optional[float] = None,
    specific_heat: Optional[float] = None,
    backface_temperature_initial: Optional[float] = None,
    mechanical_thickness: float = 0.001,
    safety_factor: float = 0.3,
    transient: bool = False,
    transient_eta: float = 2.5,
    heat_flux_profile: Optional[Callable[[np.ndarray], np.ndarray]] = None,
    allowable_heat_flux_adjacent: Optional[float] = None,
    axial_length_factor: float = 0.75,
) -> GraphiteInsertSizing:
    """
    Size graphite throat insert following the algorithm from graphite_geometry.tex.
    
    This implements the full sizing algorithm (section "Algorithm you can implement"):
    1. Compute q''_peak at throat (input)
    2. Get T_s, ṙ from wall model (inputs)
    3. Set Δ_ablate = ṙ × t_b
    4. Compute t_cond from equation (eq:tcond) or transient bound
    5. Choose t_insert,0 from equation (eq:thickness)
    6. Select L_± based on heat flux profile or simple rule
    7. Check throat growth
    
    Parameters:
    -----------
    peak_heat_flux : float
        Peak convective heat flux at throat q''_peak [W/m²]
    surface_temperature : float
        Surface temperature T_s [K] from wall model at design point
    recession_rate : float
        Net recession rate ṙ [m/s] from wall model output
    burn_time : float
        Total burn time t_b [s]
    thermal_conductivity : float
        Graphite thermal conductivity k [W/(m·K)]
    backface_temperature_max : float
        Maximum allowable back-face temperature T_b,max [K]
    throat_diameter : float
        Throat diameter D_t [m]
    density : float, optional
        Material density ρ_s [kg/m³]. Required if transient=True
    specific_heat : float, optional
        Specific heat c_p [J/(kg·K)]. Required if transient=True
    backface_temperature_initial : float, optional
        Initial back-face temperature T_b,init [K]. If None, assumed 300 K.
        Used for transient calculation: delta_T = T_b,max - T_b,init
    mechanical_thickness : float
        Mechanical thickness t_mech [m] (default 1 mm)
    safety_factor : float
        Safety factor as fraction (default 0.3 = 30%)
    transient : bool
        If True, use transient conduction model (or max of steady and transient)
        If False, use only steady-state model
    transient_eta : float
        Safety factor for transient model (default 2.5, range 2-3)
    heat_flux_profile : callable, optional
        Function q''(x) for axial heat flux profile. Must accept np.ndarray and return np.ndarray.
        If provided, used to calculate L_± separately for upstream and downstream.
        x=0 is at throat, x < 0 is upstream, x > 0 is downstream
    allowable_heat_flux_adjacent : float, optional
        Maximum heat flux for adjacent material [W/m²]. Required if heat_flux_profile provided
    axial_length_factor : float
        Factor for simple L_± calculation if profile not available (default 0.75)
    
    Returns:
    --------
    sizing : GraphiteInsertSizing
        Structured sizing results
    """
    # Validate inputs
    _validate_inputs(
        peak_heat_flux,
        burn_time,
        throat_diameter,
        thermal_conductivity,
        density,
        specific_heat,
        heat_flux_profile,
        allowable_heat_flux_adjacent,
    )
    
    # Check for finite values (NaN/Inf)
    _check_finite(
        peak_heat_flux,
        surface_temperature,
        recession_rate,
        burn_time,
        thermal_conductivity,
        backface_temperature_max,
        throat_diameter,
        density,
        specific_heat,
    )
    
    if transient and (density is None or specific_heat is None):
        raise ValueError("density and specific_heat must be provided when transient=True")
    
    # Step 3: Calculate recession allowance
    delta_ablate = calculate_recession_allowance(recession_rate, burn_time)
    
    # Step 4: Calculate conduction thickness
    t_cond_steady = calculate_conduction_thickness(
        thermal_conductivity,
        surface_temperature,
        backface_temperature_max,
        peak_heat_flux,
    )
    
    transient_backface_warning = False
    if transient:
        if backface_temperature_initial is None:
            backface_temperature_initial = 300.0
        delta_T_backface_max = backface_temperature_max - backface_temperature_initial
        
        t_cond_transient, meets_backface = calculate_conduction_thickness_transient(
            thermal_conductivity,
            density,
            specific_heat,
            peak_heat_flux,
            burn_time,
            delta_T_backface_max,
            transient_eta,
        )
        
        if not meets_backface:
            transient_backface_warning = True
            # Take max of steady and transient, but flag the warning
            t_cond = max(t_cond_steady, t_cond_transient)
            conduction_model = "max"
        else:
            # Take maximum of steady and transient
            t_cond = max(t_cond_steady, t_cond_transient)
            conduction_model = "max"
    else:
        t_cond = t_cond_steady
        conduction_model = "steady_state"
    
    # Step 5: Calculate initial thickness
    base_thickness = delta_ablate + t_cond
    safety_margin = safety_factor * base_thickness
    t_insert_0 = calculate_initial_thickness(
        delta_ablate,
        t_cond,
        mechanical_thickness,
        safety_factor,
    )
    
    # Step 6: Calculate axial lengths
    if heat_flux_profile is not None and allowable_heat_flux_adjacent is not None:
        L_upstream, L_downstream = calculate_axial_lengths_from_profile(
            heat_flux_profile,
            allowable_heat_flux_adjacent,
            throat_diameter,
        )
        sizing_method = "heat_flux_profile"
    else:
        L_upstream, L_downstream = calculate_axial_length_simple(throat_diameter, axial_length_factor)
        sizing_method = "simple_rule"
    
    # Step 7: Check throat growth
    growth_check = throat_growth_check(throat_diameter, delta_ablate)
    
    # Calculate integrity flags
    throat_area_change_excessive = growth_check["throat_area_change_pct"] > 3.0
    conduction_thickness_zero = t_cond == 0.0
    
    # Build integrity note
    notes = []
    if throat_area_change_excessive:
        notes.append(f"Throat area change {growth_check['throat_area_change_pct']:.2f}% exceeds 3% threshold")
    if conduction_thickness_zero:
        notes.append("Conduction thickness is zero (T_s <= T_b,max) - verify inputs")
    if transient_backface_warning:
        notes.append("Transient backface temperature rise would exceed limit with current eta; consider thicker insert or lower q''_peak")
    
    integrity_note = "; ".join(notes) if notes else "All checks passed"
    
    return GraphiteInsertSizing(
        # Inputs
        peak_heat_flux=peak_heat_flux,
        surface_temperature=surface_temperature,
        recession_rate=recession_rate,
        burn_time=burn_time,
        thermal_conductivity=thermal_conductivity,
        backface_temperature_max=backface_temperature_max,
        throat_diameter=throat_diameter,
        mechanical_thickness=mechanical_thickness,
        safety_factor=safety_factor,
        # Thickness components
        recession_allowance=delta_ablate,
        conduction_thickness=t_cond,
        conduction_model=conduction_model,
        safety_margin=safety_margin,
        initial_thickness=t_insert_0,
        # Axial lengths
        axial_half_length_upstream=L_upstream,
        axial_half_length_downstream=L_downstream,
        total_axial_length=L_upstream + L_downstream,
        sizing_method=sizing_method,
        # Throat growth
        throat_diameter_initial=throat_diameter,
        throat_diameter_end=growth_check["throat_diameter_end"],
        throat_area_change=growth_check["throat_area_change"],
        throat_area_change_pct=growth_check["throat_area_change_pct"],
        # Integrity flags
        throat_area_change_excessive=throat_area_change_excessive,
        conduction_thickness_zero=conduction_thickness_zero,
        transient_backface_warning=transient_backface_warning,
        integrity_note=integrity_note,
    )


def quick_back_of_envelope_sizing(
    peak_heat_flux: float,
    surface_temperature: float,
    burn_time: float,
    backface_temperature_max: float,
    thermal_conductivity: float = 1500.0,
    recession_rate: float = 6e-5,
    mechanical_thickness: float = 0.001,
    safety_factor: float = 0.3,
) -> Dict[str, float]:
    """
    Quick back-of-envelope sizing using shop-note numbers.
    
    From section "Quick numeric back-of-envelope" in graphite_geometry.tex:
        Δ_ablate ≈ 0.6 mm (for t_b = 10 s, ṙ = 6e-5 m/s)
        t_cond ≈ k × (T_s - T_b,max) / q''_peak
        t_insert,0 ≈ Δ_ablate + t_cond + t_mech + 0.3 × (Δ_ablate + t_cond)
    
    Uses conservative material bounds: k = 1500 W/(m·K)
    
    Parameters:
    -----------
    peak_heat_flux : float
        Peak heat flux at throat [W/m²]
    surface_temperature : float
        Surface temperature [K] (from model or estimate)
    burn_time : float
        Burn time [s]
    backface_temperature_max : float
        Maximum back-face temperature [K]
    thermal_conductivity : float
        Thermal conductivity [W/(m·K)] (default 1500, conservative lower bound)
    recession_rate : float
        Recession rate [m/s] (default 6e-5 for LOX/RP-1)
    mechanical_thickness : float
        Mechanical thickness [m] (default 1 mm)
    safety_factor : float
        Safety factor (default 0.3 = 30%)
    
    Returns:
    --------
    results : dict
        Dictionary with sizing results
    """
    delta_ablate = recession_rate * burn_time
    t_cond = thermal_conductivity * (surface_temperature - backface_temperature_max) / peak_heat_flux
    t_cond = max(t_cond, 0.0)
    
    base_thickness = delta_ablate + t_cond
    safety_margin = safety_factor * base_thickness
    t_insert_0 = base_thickness + mechanical_thickness + safety_margin
    
    return {
        "recession_allowance": float(delta_ablate),
        "conduction_thickness": float(t_cond),
        "mechanical_thickness": float(mechanical_thickness),
        "safety_margin": float(safety_margin),
        "initial_thickness": float(t_insert_0),
        "method": "back_of_envelope",
    }
