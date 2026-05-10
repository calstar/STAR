"""Mach number solver for isentropic nozzle flow.

This module provides the area-Mach relation solver used throughout the nozzle
calculations. Consolidates previously duplicated Newton-Raphson implementations.

Physics:
    The area-Mach relation for isentropic flow:
    A/A* = (1/M) × [(2/(γ+1)) × (1 + (γ-1)/2 × M²)]^((γ+1)/(2(γ-1)))
    
    For a given area ratio ε = A/A* > 1, there are two solutions:
    1. Subsonic solution (M < 1)
    2. Supersonic solution (M > 1)
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass
from typing import Optional, Tuple
import numpy as np


@dataclass
class MachSolverResult:
    """Result from Mach number solver."""
    M: float                # Mach number solution
    converged: bool         # Whether solver converged
    iterations: int         # Number of iterations used
    error: float            # Final residual error
    A_Astar_actual: float   # Actual area ratio achieved


def calculate_area_mach_ratio(M: float, gamma: float) -> float:
    """
    Calculate area ratio A/A* for given Mach number and gamma.
    
    A/A* = (1/M) × [(2/(γ+1)) × (1 + (γ-1)/2 × M²)]^((γ+1)/(2(γ-1)))
    
    Parameters
    ----------
    M : float
        Mach number (must be > 0)
    gamma : float
        Specific heat ratio (must be > 1)
        
    Returns
    -------
    A_Astar : float
        Area ratio A/A*
    """
    if M <= 0 or gamma <= 1.0:
        raise ValueError(f"Invalid inputs: M={M}, gamma={gamma}")
    
    term = (2.0 / (gamma + 1.0)) * (1.0 + (gamma - 1.0) / 2.0 * M**2)
    exponent = (gamma + 1.0) / (2.0 * (gamma - 1.0))
    A_Astar = (1.0 / M) * (term ** exponent)
    
    return A_Astar


def calculate_area_mach_derivative(M: float, gamma: float, A_Astar: Optional[float] = None) -> float:
    """
    Calculate derivative d(A/A*)/dM for Newton-Raphson solver.
    
    Parameters
    ----------
    M : float
        Mach number
    gamma : float
        Specific heat ratio
    A_Astar : float, optional
        Pre-calculated A/A* (for efficiency)
        
    Returns
    -------
    dA_dM : float
        Derivative of area ratio with respect to Mach number
    """
    if A_Astar is None:
        A_Astar = calculate_area_mach_ratio(M, gamma)
    
    # Simplified and more stable derivative: 
    # d(A/A*)/dM = (A/A*) * 2 * (M^2 - 1) / (M * (2 + (gamma-1)*M^2))
    numerator = 2.0 * (M**2 - 1.0)
    denominator = M * (2.0 + (gamma - 1.0) * M**2)
    
    return A_Astar * (numerator / denominator)


def estimate_initial_mach(eps: float, gamma: float, supersonic: bool = True) -> float:
    """
    Estimate initial Mach number for given area ratio.
    
    Parameters
    ----------
    eps : float
        Area ratio A/A* (must be >= 1)
    gamma : float
        Specific heat ratio
    supersonic : bool
        Whether to estimate the supersonic solution (M > 1) or subsonic (M < 1)
        
    Returns
    -------
    M_guess : float
        Initial guess for Mach number
    """
    if eps < 1.0:
        if eps > 0.999:  # Handle floating point near 1.0
            return 1.0
        raise ValueError(f"Area ratio must be >= 1: eps={eps}")
    if gamma <= 1.0:
        raise ValueError(f"Gamma must be > 1: gamma={gamma}")
    
    if eps == 1.0:
        return 1.0

    if supersonic:
        if eps > 10.0:
            # Large expansion ratio - supersonic asymptotic formula
            # Derived from M >> 1 limit: M ~ eps^((g-1)/2) * prefactor
            p = (gamma - 1.0) / 2.0
            prefactor = ((gamma + 1.0) / (gamma - 1.0)) ** ((gamma + 1.0) / 4.0)
            M_guess = prefactor * (eps ** p)
        elif eps > 1.5:
            # Moderate expansion ratio - improved approximation
            M_guess = 1.0 + np.sqrt(2.0 * (eps - 1.0) / (gamma + 1.0))
        else:
            # Small expansion ratio (near 1) - linear approximation
            M_guess = 1.0 + 0.5 * (eps - 1.0)
        
        # Ensure supersonic (M > 1)
        return max(M_guess, 1.0 + 1e-6)
    else:
        # Subsonic guess (M < 1)
        # For M << 1, A/A* ~ (prefactor/M)
        # For M near 1, eps ~ 1 + 0.5 * (gamma+1) * (M-1)^2 / 2 ? No.
        # Simple approximation for subsonic:
        if eps > 2.0:
            # Very small M approximation: A/A* ~ 1/M * (2/(g+1))^((g+1)/(2(g-1)))
            prefactor = (2.0 / (gamma + 1.0)) ** ((gamma + 1.0) / (2.0 * (gamma - 1.0)))
            M_guess = prefactor / eps
        else:
            # Near sonic: eps ~ 1 + 0.5 * (1-M)^2 * (gamma+1)/2? No, simpler:
            M_guess = 1.0 - 0.5 * np.sqrt(2.0 * (eps - 1.0) / (gamma + 1.0))
        
        # Ensure subsonic (M < 1)
        return np.clip(M_guess, 1e-6, 1.0 - 1e-6)


def solve_mach_from_area_ratio(
    eps: float,
    gamma: float,
    supersonic: bool = True,
    tolerance: float = 1e-10,
    max_iterations: int = 50,
    initial_guess: Optional[float] = None,
) -> MachSolverResult:
    """
    Solve for Mach number given area ratio using Newton-Raphson.
    
    Finds either the supersonic (M > 1) or subsonic (M < 1) solution.
    
    Parameters
    ----------
    eps : float
        Area ratio A/A* (must be >= 1)
    gamma : float
        Specific heat ratio (must be > 1)
    supersonic : bool
        Whether to find the supersonic or subsonic solution
    tolerance : float
        Convergence tolerance for residual
    max_iterations : int
        Maximum Newton-Raphson iterations
    initial_guess : float, optional
        Initial guess for M (if None, uses estimate_initial_mach)
        
    Returns
    -------
    result : MachSolverResult
        Solver result with M, convergence info, and diagnostics
    """
    # Validate inputs
    if eps < 1.0:
        if eps > 0.999:
            eps = 1.0
        else:
            raise ValueError(f"Area ratio must be >= 1: eps={eps}")
    if gamma <= 1.0:
        raise ValueError(f"Gamma must be > 1: gamma={gamma}")
    
    if eps == 1.0:
        return MachSolverResult(M=1.0, converged=True, iterations=0, error=0.0, A_Astar_actual=1.0)

    # Initial guess
    if initial_guess is not None:
        if supersonic and initial_guess > 1.0:
            M = initial_guess
        elif not supersonic and initial_guess < 1.0:
            M = initial_guess
        else:
            M = estimate_initial_mach(eps, gamma, supersonic)
    else:
        M = estimate_initial_mach(eps, gamma, supersonic)
    
    # Newton-Raphson iteration
    error = float('inf')
    
    for iteration in range(max_iterations):
        # Calculate A/A* and error
        A_Astar = calculate_area_mach_ratio(M, gamma)
        error = A_Astar - eps
        
        # Check convergence
        if abs(error) < tolerance:
            return MachSolverResult(
                M=M,
                converged=True,
                iterations=iteration + 1,
                error=abs(error),
                A_Astar_actual=A_Astar,
            )
        
        # Calculate derivative
        dA_dM = calculate_area_mach_derivative(M, gamma, A_Astar)
        
        # Newton step with safeguards
        if abs(dA_dM) < 1e-12:
            # Derivative too small - use bisection-like fallback
            # Since f(M) has a minimum at M=1:
            # Supersonic: f'(M) > 0, increasing M increases f(M)
            # Subsonic: f'(M) < 0, increasing M decreases f(M)
            if supersonic:
                if error > 0: M *= 0.99
                else: M *= 1.01
            else:
                if error > 0: M *= 1.01
                else: M *= 0.99
        else:
            step = error / dA_dM
            # Limit step size to prevent overshoot
            step = np.clip(step, -0.5 * M, 0.5 * M)
            M = M - step
        
        # Ensure Mach number remains in the correct regime
        if supersonic:
            if M <= 1.0:
                M = 1.0 + 1e-6
        else:
            if M >= 1.0:
                M = 1.0 - 1e-6
            if M <= 0:
                M = 1e-6
    
    # Did not converge within max_iterations
    A_Astar_final = calculate_area_mach_ratio(M, gamma)
    return MachSolverResult(
        M=M,
        converged=abs(error) < tolerance * 10,
        iterations=max_iterations,
        error=abs(A_Astar_final - eps),
        A_Astar_actual=A_Astar_final,
    )


def solve_mach_robust(
    eps: float,
    gamma: float,
    supersonic: bool = True,
) -> Tuple[float, bool]:
    """
    Robust wrapper for Mach solver with automatic fallback.
    
    Parameters
    ----------
    eps : float
        Area ratio A/A*
    gamma : float
        Specific heat ratio
    supersonic : bool
        Whether to find the supersonic or subsonic solution
        
    Returns
    -------
    M : float
        Mach number solution
    success : bool
        Whether solver converged successfully
    """
    # Validate basic physics
    if eps < 1.0:
        if eps > 0.999: eps = 1.0
        else:
            warnings.warn(f"Invalid area ratio: eps={eps}. Using sonic condition.")
            return 1.0, False
            
    if gamma <= 1.0:
        warnings.warn(f"Invalid gamma: gamma={gamma}. Using fallback.")
        return 2.0 if supersonic else 0.1, False
    
    try:
        result = solve_mach_from_area_ratio(eps, gamma, supersonic)
        
        if not result.converged:
            warnings.warn(
                f"Mach solver did not fully converge: |error| = {result.error:.2e} "
                f"after {result.iterations} iterations. M={result.M:.4f}"
            )
        
        # Validate result is in correct regime
        if supersonic and result.M <= 1.0:
            return 1.0 + 1e-6, False
        if not supersonic and result.M >= 1.0:
            return 1.0 - 1e-6, False
        
        return result.M, result.converged
        
    except Exception as e:
        warnings.warn(f"Mach solver failed: {e}. Using fallback.")
        return 2.0 if supersonic else 0.1, False


def solve_exit_mach_robust(
    eps: float,
    gamma: float,
) -> Tuple[float, bool]:
    """
    Backward compatible wrapper for supersonic exit Mach solver.
    """
    return solve_mach_robust(eps, gamma, supersonic=True)


def solve_exit_mach_from_area_ratio(
    eps: float,
    gamma: float,
    **kwargs
) -> MachSolverResult:
    """
    Backward compatible wrapper for supersonic exit Mach solver.
    """
    return solve_mach_from_area_ratio(eps, gamma, supersonic=True, **kwargs)
