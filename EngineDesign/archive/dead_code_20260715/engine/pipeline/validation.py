"""Centralized validation functions for physics quantities.

This module provides explicit validation functions that raise clear errors
instead of hiding problems with clipping, clamping, or default fallbacks.

Design principles:
1. NEVER hide errors with defaults or clipping
2. Raise ValueError with descriptive messages
3. Include relevant context in error messages
4. Validate physical constraints explicitly
"""

import numpy as np
from typing import Any, Optional, Tuple


def validate_positive(
    value: float,
    name: str,
    context: Optional[str] = None
) -> None:
    """Validate that a value is positive and finite.
    
    Parameters
    ----------
    value : float
        Value to validate
    name : str
        Name of the variable for error message
    context : str, optional
        Additional context for error message
    
    Raises
    ------
    ValueError
        If value is not positive and finite
    """
    if not np.isfinite(value):
        msg = f"Non-finite {name}: {value}"
        if context:
            msg += f". Context: {context}"
        raise ValueError(msg)
    
    if value <= 0:
        msg = f"Non-positive {name}: {value}. Must be > 0"
        if context:
            msg += f". Context: {context}"
        raise ValueError(msg)


def validate_range(
    value: float,
    name: str,
    min_val: float,
    max_val: float,
    context: Optional[str] = None
) -> None:
    """Validate that a value is in a specified range.
    
    Parameters
    ----------
    value : float
        Value to validate
    name : str
        Name of the variable for error message
    min_val : float
        Minimum allowed value (inclusive)
    max_val : float
        Maximum allowed value (inclusive)
    context : str, optional
        Additional context for error message
    
    Raises
    ------
    ValueError
        If value is outside the specified range
    """
    if not np.isfinite(value):
        msg = f"Non-finite {name}: {value}"
        if context:
            msg += f". Context: {context}"
        raise ValueError(msg)
    
    if not (min_val <= value <= max_val):
        msg = f"{name} out of range: {value}. Must be in [{min_val}, {max_val}]"
        if context:
            msg += f". Context: {context}"
        raise ValueError(msg)


def validate_efficiency(
    efficiency: float,
    name: str,
    context: Optional[str] = None
) -> None:
    """Validate that an efficiency is in [0, 1].
    
    Parameters
    ----------
    efficiency : float
        Efficiency value to validate
    name : str
        Name of the efficiency for error message
    context : str, optional
        Additional context (e.g., "L*=0.15 m, mixing=0.8")
    
    Raises
    ------
    ValueError
        If efficiency is not in [0, 1]
    """
    validate_range(efficiency, name, 0.0, 1.0, context)


def validate_temperature(
    temperature: float,
    name: str,
    min_temp: float = 200.0,
    max_temp: float = 5000.0,
    context: Optional[str] = None
) -> None:
    """Validate that a temperature is physically reasonable.
    
    Parameters
    ----------
    temperature : float
        Temperature in Kelvin
    name : str
        Name of the temperature for error message
    min_temp : float, optional
        Minimum reasonable temperature (default: 200 K)
    max_temp : float, optional
        Maximum reasonable temperature (default: 5000 K)
    context : str, optional
        Additional context for error message
    
    Raises
    ------
    ValueError
        If temperature is outside reasonable range
    """
    if not np.isfinite(temperature):
        msg = f"Non-finite {name}: {temperature} K"
        if context:
            msg += f". Context: {context}"
        raise ValueError(msg)
    
    if temperature < min_temp or temperature > max_temp:
        msg = (
            f"{name} outside reasonable range: {temperature:.1f} K. "
            f"Expected [{min_temp:.1f}, {max_temp:.1f}] K for rocket engines"
        )
        if context:
            msg += f". Context: {context}"
        raise ValueError(msg)


def validate_pressure(
    pressure: float,
    name: str,
    min_pressure: float = 1e4,  # 0.1 bar
    max_pressure: float = 50e6,  # 50 MPa
    context: Optional[str] = None
) -> None:
    """Validate that a pressure is physically reasonable.
    
    Parameters
    ----------
    pressure : float
        Pressure in Pascal
    name : str
        Name of the pressure for error message
    min_pressure : float, optional
        Minimum reasonable pressure (default: 10 kPa)
    max_pressure : float, optional
        Maximum reasonable pressure (default: 50 MPa)
    context : str, optional
        Additional context for error message
    
    Raises
    ------
    ValueError
        If pressure is outside reasonable range
    """
    if not np.isfinite(pressure):
        msg = f"Non-finite {name}: {pressure} Pa"
        if context:
            msg += f". Context: {context}"
        raise ValueError(msg)
    
    if pressure < 0:
        msg = f"Negative {name}: {pressure:.3e} Pa. Pressure cannot be negative"
        if context:
            msg += f". Context: {context}"
        raise ValueError(msg)
    
    if pressure < min_pressure or pressure > max_pressure:
        msg = (
            f"{name} outside reasonable range: {pressure/1e6:.4f} MPa. "
            f"Expected [{min_pressure/1e6:.4f}, {max_pressure/1e6:.4f}] MPa for rocket engines"
        )
        if context:
            msg += f". Context: {context}"
        raise ValueError(msg)


def validate_mach_number(
    mach: float,
    name: str,
    supersonic: bool = False,
    context: Optional[str] = None
) -> None:
    """Validate that a Mach number is physically reasonable.
    
    Parameters
    ----------
    mach : float
        Mach number
    name : str
        Name of the Mach number for error message
    supersonic : bool, optional
        If True, require M > 1 (default: False)
    context : str, optional
        Additional context for error message
    
    Raises
    ------
    ValueError
        If Mach number is invalid
    """
    if not np.isfinite(mach):
        msg = f"Non-finite {name}: {mach}"
        if context:
            msg += f". Context: {context}"
        raise ValueError(msg)
    
    if mach < 0:
        msg = f"Negative {name}: {mach}. Mach number cannot be negative"
        if context:
            msg += f". Context: {context}"
        raise ValueError(msg)
    
    if supersonic and mach <= 1.0:
        msg = f"Subsonic {name}: {mach:.4f}. Expected supersonic (M > 1)"
        if context:
            msg += f". Context: {context}"
        raise ValueError(msg)
    
    if mach > 10.0:
        msg = f"Unreasonably high {name}: {mach:.4f}. Expected < 10 for rocket nozzles"
        if context:
            msg += f". Context: {context}"
        raise ValueError(msg)


def validate_gamma(
    gamma: float,
    name: str = "gamma",
    context: Optional[str] = None
) -> None:
    """Validate that specific heat ratio is physically reasonable.
    
    Parameters
    ----------
    gamma : float
        Specific heat ratio
    name : str, optional
        Name for error message (default: "gamma")
    context : str, optional
        Additional context for error message
    
    Raises
    ------
    ValueError
        If gamma is not in reasonable range
    """
    if not np.isfinite(gamma):
        msg = f"Non-finite {name}: {gamma}"
        if context:
            msg += f". Context: {context}"
        raise ValueError(msg)
    
    if gamma <= 1.0:
        msg = f"Invalid {name}: {gamma:.4f}. Must be > 1.0 for physical gas"
        if context:
            msg += f". Context: {context}"
        raise ValueError(msg)
    
    if gamma < 1.05 or gamma > 1.67:
        msg = (
            f"{name} outside typical range: {gamma:.4f}. "
            f"Expected [1.05, 1.67] for rocket combustion products"
        )
        if context:
            msg += f". Context: {context}"
        raise ValueError(msg)


def validate_required_keys(
    data_dict: dict,
    required_keys: list,
    dict_name: str = "dictionary"
) -> None:
    """Validate that all required keys are present in a dictionary.
    
    Parameters
    ----------
    data_dict : dict
        Dictionary to validate
    required_keys : list
        List of required key names
    dict_name : str, optional
        Name of the dictionary for error message
    
    Raises
    ------
    KeyError
        If any required keys are missing
    """
    missing_keys = [key for key in required_keys if key not in data_dict]
    
    if missing_keys:
        raise KeyError(
            f"Missing required keys in {dict_name}: {missing_keys}. "
            f"Available keys: {list(data_dict.keys())}"
        )


def validate_monotonic_decreasing(
    array: np.ndarray,
    name: str,
    context: Optional[str] = None
) -> None:
    """Validate that an array is monotonically decreasing.
    
    Parameters
    ----------
    array : np.ndarray
        Array to validate
    name : str
        Name of the array for error message
    context : str, optional
        Additional context for error message
    
    Raises
    ------
    ValueError
        If array is not monotonically decreasing
    """
    if not np.all(np.isfinite(array)):
        msg = f"Non-finite values in {name}"
        if context:
            msg += f". Context: {context}"
        raise ValueError(msg)
    
    # Check monotonicity
    diff = np.diff(array)
    if not np.all(diff <= 0):
        # Find first violation
        violation_idx = np.where(diff > 0)[0][0]
        msg = (
            f"{name} is not monotonically decreasing. "
            f"Violation at index {violation_idx}: "
            f"value[{violation_idx}]={array[violation_idx]:.3e}, "
            f"value[{violation_idx+1}]={array[violation_idx+1]:.3e}"
        )
        if context:
            msg += f". Context: {context}"
        raise ValueError(msg)


def validate_mass_flow_rate(
    mdot: float,
    name: str,
    min_mdot: float = 0.001,  # 1 g/s
    max_mdot: float = 100.0,  # 100 kg/s
    context: Optional[str] = None
) -> None:
    """Validate that a mass flow rate is physically reasonable.
    
    Parameters
    ----------
    mdot : float
        Mass flow rate in kg/s
    name : str
        Name of the mass flow for error message
    min_mdot : float, optional
        Minimum reasonable mass flow (default: 1 g/s)
    max_mdot : float, optional
        Maximum reasonable mass flow (default: 100 kg/s)
    context : str, optional
        Additional context for error message
    
    Raises
    ------
    ValueError
        If mass flow rate is invalid
    """
    if not np.isfinite(mdot):
        msg = f"Non-finite {name}: {mdot} kg/s"
        if context:
            msg += f". Context: {context}"
        raise ValueError(msg)
    
    if mdot <= 0:
        msg = f"Non-positive {name}: {mdot:.6f} kg/s. Must be > 0"
        if context:
            msg += f". Context: {context}"
        raise ValueError(msg)
    
    if mdot < min_mdot or mdot > max_mdot:
        msg = (
            f"{name} outside reasonable range: {mdot:.4f} kg/s. "
            f"Expected [{min_mdot:.4f}, {max_mdot:.4f}] kg/s"
        )
        if context:
            msg += f". Context: {context}"
        raise ValueError(msg)

