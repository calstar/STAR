"""Numerical robustness and validation framework for physics calculations.

This module provides:
1. Dimensional consistency checking
2. Numerical stability validation
3. Physical constraint validation
4. Convergence diagnostics
5. Error propagation analysis
"""

from __future__ import annotations

from typing import Dict, List, Tuple, Optional, Any
import numpy as np
from dataclasses import dataclass


@dataclass
class ValidationResult:
    """Result of a validation check"""
    passed: bool
    message: str
    value: Optional[float] = None
    expected_range: Optional[Tuple[float, float]] = None
    severity: str = "warning"  # "error", "warning", "info"


class DimensionalValidator:
    """Validates dimensional consistency of physical quantities"""
    
    # Base SI units: [m, kg, s, K, A, mol, cd]
    DIMENSIONS = {
        "length": [1, 0, 0, 0, 0, 0, 0],
        "mass": [0, 1, 0, 0, 0, 0, 0],
        "time": [0, 0, 1, 0, 0, 0, 0],
        "temperature": [0, 0, 0, 1, 0, 0, 0],
        "pressure": [-1, 1, -2, 0, 0, 0, 0],  # Pa = kg/(m·s²)
        "density": [-3, 1, 0, 0, 0, 0, 0],  # kg/m³
        "velocity": [1, 0, -1, 0, 0, 0, 0],  # m/s
        "force": [1, 1, -2, 0, 0, 0, 0],  # N = kg·m/s²
        "energy": [2, 1, -2, 0, 0, 0, 0],  # J = kg·m²/s²
        "power": [2, 1, -3, 0, 0, 0, 0],  # W = kg·m²/s³
        "mass_flow": [0, 1, -1, 0, 0, 0, 0],  # kg/s
        "heat_flux": [0, 1, -3, 0, 0, 0, 0],  # W/m² = kg/s³
        "viscosity": [-1, 1, -1, 0, 0, 0, 0],  # Pa·s = kg/(m·s)
        "thermal_conductivity": [1, 1, -3, -1, 0, 0, 0],  # W/(m·K)
        "specific_heat": [2, 0, -2, -1, 0, 0, 0],  # J/(kg·K)
    }
    
    @classmethod
    def validate_equation(cls, left_side: Dict[str, float], right_side: Dict[str, float]) -> bool:
        """
        Validate that left_side and right_side have same dimensions.
        
        Parameters:
        -----------
        left_side : dict
            {quantity_name: value} where quantity_name is a key in DIMENSIONS
        right_side : dict
            Same format as left_side
            
        Returns:
        --------
        is_valid : bool
        """
        left_dims = np.zeros(7)
        right_dims = np.zeros(7)
        
        for name, value in left_side.items():
            if name in cls.DIMENSIONS:
                left_dims += np.array(cls.DIMENSIONS[name]) * value
        
        for name, value in right_side.items():
            if name in cls.DIMENSIONS:
                right_dims += np.array(cls.DIMENSIONS[name]) * value
        
        return np.allclose(left_dims, right_dims, atol=1e-10)


class PhysicalConstraints:
    """Validates physical constraints and bounds"""
    
    @staticmethod
    def validate_pressure(P: float, name: str = "pressure") -> ValidationResult:
        """Validate pressure is physically reasonable"""
        if not np.isfinite(P):
            return ValidationResult(False, f"{name} is not finite", P, severity="error")
        if P < 0:
            return ValidationResult(False, f"{name} is negative: {P:.2e} Pa", P, (0, np.inf), "error")
        if P > 1e9:  # 1 GPa
            return ValidationResult(False, f"{name} is extremely high: {P/1e6:.2f} MPa", P, (0, 1e9), "warning")
        return ValidationResult(True, f"{name} is valid: {P/1e6:.2f} MPa", P)
    
    @staticmethod
    def validate_temperature(T: float, name: str = "temperature") -> ValidationResult:
        """Validate temperature is physically reasonable"""
        if not np.isfinite(T):
            return ValidationResult(False, f"{name} is not finite", T, severity="error")
        if T < 0:
            return ValidationResult(False, f"{name} is negative: {T:.2f} K", T, (0, np.inf), "error")
        if T > 5000:  # Very high for rocket engines
            return ValidationResult(False, f"{name} is extremely high: {T:.2f} K", T, (0, 5000), "warning")
        return ValidationResult(True, f"{name} is valid: {T:.2f} K", T)
    
    @staticmethod
    def validate_mass_flow(mdot: float, name: str = "mass_flow") -> ValidationResult:
        """Validate mass flow is physically reasonable"""
        if not np.isfinite(mdot):
            return ValidationResult(False, f"{name} is not finite", mdot, severity="error")
        if mdot < 0:
            return ValidationResult(False, f"{name} is negative: {mdot:.4f} kg/s", mdot, (0, np.inf), "error")
        if mdot > 1000:  # Very high for typical engines
            return ValidationResult(False, f"{name} is extremely high: {mdot:.2f} kg/s", mdot, (0, 1000), "warning")
        return ValidationResult(True, f"{name} is valid: {mdot:.4f} kg/s", mdot)
    
    @staticmethod
    def validate_mixture_ratio(MR: float) -> ValidationResult:
        """Validate mixture ratio is physically reasonable"""
        if not np.isfinite(MR):
            return ValidationResult(False, "MR is not finite", MR, severity="error")
        if MR <= 0:
            return ValidationResult(False, f"MR is non-positive: {MR:.4f}", MR, (0.1, 20), "error")
        if MR > 20:
            return ValidationResult(False, f"MR is extremely high: {MR:.2f}", MR, (0.1, 20), "warning")
        return ValidationResult(True, f"MR is valid: {MR:.4f}", MR)
    
    @staticmethod
    def validate_area(A: float, name: str = "area") -> ValidationResult:
        """Validate area is physically reasonable"""
        if not np.isfinite(A):
            return ValidationResult(False, f"{name} is not finite", A, severity="error")
        if A <= 0:
            return ValidationResult(False, f"{name} is non-positive: {A:.2e} m²", A, (1e-6, 1.0), "error")
        if A > 1.0:  # 1 m² is very large
            return ValidationResult(False, f"{name} is extremely large: {A:.4f} m²", A, (1e-6, 1.0), "warning")
        return ValidationResult(True, f"{name} is valid: {A:.2e} m²", A)
    
    @staticmethod
    def validate_velocity(v: float, name: str = "velocity") -> ValidationResult:
        """Validate velocity is physically reasonable"""
        if not np.isfinite(v):
            return ValidationResult(False, f"{name} is not finite", v, severity="error")
        if v < 0:
            return ValidationResult(False, f"{name} is negative: {v:.2f} m/s", v, (0, 5000), "error")
        if v > 5000:  # Very high for rocket exhaust
            return ValidationResult(False, f"{name} is extremely high: {v:.2f} m/s", v, (0, 5000), "warning")
        return ValidationResult(True, f"{name} is valid: {v:.2f} m/s", v)
    
    @staticmethod
    def validate_gamma(gamma: float) -> ValidationResult:
        """Validate specific heat ratio"""
        if not np.isfinite(gamma):
            return ValidationResult(False, "gamma is not finite", gamma, severity="error")
        if gamma <= 1.0:
            return ValidationResult(False, f"gamma <= 1.0: {gamma:.4f}", gamma, (1.0, 2.0), "error")
        if gamma > 2.0:
            return ValidationResult(False, f"gamma > 2.0: {gamma:.4f}", gamma, (1.0, 2.0), "warning")
        return ValidationResult(True, f"gamma is valid: {gamma:.4f}", gamma)
    
    @staticmethod
    def validate_cstar(cstar: float) -> ValidationResult:
        """Validate characteristic velocity"""
        if not np.isfinite(cstar):
            return ValidationResult(False, "c* is not finite", cstar, severity="error")
        if cstar <= 0:
            return ValidationResult(False, f"c* is non-positive: {cstar:.2f} m/s", cstar, (500, 3000), "error")
        if cstar < 500 or cstar > 3000:
            return ValidationResult(False, f"c* is outside typical range: {cstar:.2f} m/s", cstar, (500, 3000), "warning")
        return ValidationResult(True, f"c* is valid: {cstar:.2f} m/s", cstar)
    
    @staticmethod
    def validate_isp(Isp: float) -> ValidationResult:
        """Validate specific impulse"""
        if not np.isfinite(Isp):
            return ValidationResult(False, "Isp is not finite", Isp, severity="error")
        if Isp <= 0:
            return ValidationResult(False, f"Isp is non-positive: {Isp:.2f} s", Isp, (100, 500), "error")
        if Isp < 100 or Isp > 500:
            return ValidationResult(False, f"Isp is outside typical range: {Isp:.2f} s", Isp, (100, 500), "warning")
        return ValidationResult(True, f"Isp is valid: {Isp:.2f} s", Isp)


class NumericalStability:
    """Numerical stability checks and improvements"""
    
    @staticmethod
    def check_condition_number(A: np.ndarray, name: str = "matrix") -> ValidationResult:
        """Check condition number of a matrix"""
        if A.size == 0:
            return ValidationResult(False, f"{name} is empty", severity="error")
        
        try:
            cond = np.linalg.cond(A)
            if cond > 1e12:
                return ValidationResult(False, f"{name} is ill-conditioned: κ = {cond:.2e}", cond, severity="error")
            elif cond > 1e8:
                return ValidationResult(False, f"{name} is poorly conditioned: κ = {cond:.2e}", cond, severity="warning")
            return ValidationResult(True, f"{name} condition number: {cond:.2e}", cond)
        except np.linalg.LinAlgError:
            return ValidationResult(False, f"{name} is singular", severity="error")
    
    @staticmethod
    def safe_divide(numerator: float, denominator: float, default: float = 0.0, name: str = "ratio") -> Tuple[float, ValidationResult]:
        """Safely divide with validation"""
        if not np.isfinite(numerator) or not np.isfinite(denominator):
            return default, ValidationResult(False, f"{name}: non-finite inputs", severity="error")
        
        if abs(denominator) < 1e-12:
            return default, ValidationResult(False, f"{name}: division by near-zero ({denominator:.2e})", severity="error")
        
        result = numerator / denominator
        if not np.isfinite(result):
            return default, ValidationResult(False, f"{name}: result is not finite", result, severity="error")
        
        return result, ValidationResult(True, f"{name} = {result:.6e}", result)
    
    @staticmethod
    def safe_sqrt(value: float, name: str = "sqrt") -> Tuple[float, ValidationResult]:
        """Safely compute square root with validation"""
        if not np.isfinite(value):
            return 0.0, ValidationResult(False, f"{name}: input is not finite", value, severity="error")
        
        if value < 0:
            return 0.0, ValidationResult(False, f"{name}: negative input ({value:.2e})", value, severity="error")
        
        result = np.sqrt(value)
        return result, ValidationResult(True, f"{name} = {result:.6e}", result)
    
    @staticmethod
    def safe_log(value: float, name: str = "log") -> Tuple[float, ValidationResult]:
        """Safely compute logarithm with validation"""
        if not np.isfinite(value):
            return 0.0, ValidationResult(False, f"{name}: input is not finite", value, severity="error")
        
        if value <= 0:
            return 0.0, ValidationResult(False, f"{name}: non-positive input ({value:.2e})", value, severity="error")
        
        result = np.log(value)
        if not np.isfinite(result):
            return 0.0, ValidationResult(False, f"{name}: result is not finite", result, severity="error")
        
        return result, ValidationResult(True, f"{name} = {result:.6e}", result)
    
    @staticmethod
    def check_convergence(
        residuals: List[float],
        tolerance: float,
        min_iterations: int = 3,
    ) -> ValidationResult:
        """Check convergence of iterative method"""
        if len(residuals) < min_iterations:
            return ValidationResult(False, f"Too few iterations: {len(residuals)}", severity="warning")
        
        if not all(np.isfinite(r) for r in residuals):
            return ValidationResult(False, "Non-finite residuals", severity="error")
        
        final_residual = abs(residuals[-1])
        if final_residual > tolerance:
            return ValidationResult(False, f"Not converged: |residual| = {final_residual:.2e} > {tolerance:.2e}", 
                                   final_residual, severity="error")
        
        # Check for monotonic decrease (good convergence behavior)
        if len(residuals) >= 3:
            recent = residuals[-3:]
            if not all(abs(recent[i]) <= abs(recent[i-1]) * 1.1 for i in range(1, len(recent))):
                return ValidationResult(False, "Non-monotonic convergence", severity="warning")
        
        return ValidationResult(True, f"Converged in {len(residuals)} iterations", final_residual)
    
    @staticmethod
    def check_bracket(f: callable, a: float, b: float) -> ValidationResult:
        """Check that bracket [a, b] contains a root"""
        if a >= b:
            return ValidationResult(False, f"Invalid bracket: a ({a:.2e}) >= b ({b:.2e})", severity="error")
        
        try:
            f_a = f(a)
            f_b = f(b)
        except Exception as e:
            return ValidationResult(False, f"Error evaluating bracket: {e}", severity="error")
        
        if not (np.isfinite(f_a) and np.isfinite(f_b)):
            return ValidationResult(False, "Non-finite function values at bracket", severity="error")
        
        if np.sign(f_a) == np.sign(f_b):
            return ValidationResult(False, 
                                   f"Bracket does not contain root: f(a)={f_a:.2e}, f(b)={f_b:.2e}",
                                   severity="error")
        
        return ValidationResult(True, f"Valid bracket: f(a)={f_a:.2e}, f(b)={f_b:.2e}")


class PhysicsValidator:
    """Validates physical relationships and conservation laws"""
    
    @staticmethod
    def validate_mass_conservation(
        mdot_in: float,
        mdot_out: float,
        tolerance: float = 1e-6,
    ) -> ValidationResult:
        """Validate mass conservation"""
        if not (np.isfinite(mdot_in) and np.isfinite(mdot_out)):
            return ValidationResult(False, "Non-finite mass flows", severity="error")
        
        error = abs(mdot_in - mdot_out)
        relative_error = error / max(abs(mdot_in), abs(mdot_out), 1e-12)
        
        if relative_error > tolerance:
            return ValidationResult(False,
                                   f"Mass not conserved: error = {error:.2e} kg/s ({relative_error*100:.2f}%)",
                                   error, severity="error")
        
        return ValidationResult(True, f"Mass conserved: error = {error:.2e} kg/s", error)
    
    @staticmethod
    def validate_energy_balance(
        energy_in: float,
        energy_out: float,
        tolerance: float = 1e-3,  # 0.1% for energy (less strict)
    ) -> ValidationResult:
        """Validate energy balance"""
        if not (np.isfinite(energy_in) and np.isfinite(energy_out)):
            return ValidationResult(False, "Non-finite energies", severity="error")
        
        error = abs(energy_in - energy_out)
        relative_error = error / max(abs(energy_in), abs(energy_out), 1e-12)
        
        if relative_error > tolerance:
            return ValidationResult(False,
                                   f"Energy not balanced: error = {error:.2e} J ({relative_error*100:.2f}%)",
                                   error, severity="warning")  # Warning, not error, as some loss is expected
        
        return ValidationResult(True, f"Energy balanced: error = {error:.2e} J ({relative_error*100:.4f}%)", error)
    
    @staticmethod
    def validate_choked_flow(
        Pc: float,
        P_exit: float,
        gamma: float,
    ) -> ValidationResult:
        """Validate that flow is choked at throat"""
        # For choked flow: P_exit / Pc <= (2/(gamma+1))^(gamma/(gamma-1))
        critical_ratio = (2.0 / (gamma + 1.0)) ** (gamma / (gamma - 1.0))
        actual_ratio = P_exit / Pc if Pc > 0 else 0.0
        
        if actual_ratio > critical_ratio * 1.01:  # 1% tolerance
            return ValidationResult(False,
                                   f"Flow may not be choked: P_exit/Pc = {actual_ratio:.4f} > {critical_ratio:.4f}",
                                   actual_ratio, severity="warning")
        
        return ValidationResult(True, f"Flow is choked: P_exit/Pc = {actual_ratio:.4f}", actual_ratio)
    
    @staticmethod
    def validate_thrust_equation(
        F_momentum: float,
        F_pressure: float,
        F_total: float,
        tolerance: float = 1e-3,
    ) -> ValidationResult:
        """Validate thrust equation: F = F_momentum + F_pressure"""
        if not all(np.isfinite([F_momentum, F_pressure, F_total])):
            return ValidationResult(False, "Non-finite thrust components", severity="error")
        
        F_calculated = F_momentum + F_pressure
        error = abs(F_total - F_calculated)
        relative_error = error / max(abs(F_total), abs(F_calculated), 1e-12)
        
        if relative_error > tolerance:
            return ValidationResult(False,
                                   f"Thrust equation error: {error:.2e} N ({relative_error*100:.2f}%)",
                                   error, severity="error")
        
        return ValidationResult(True, f"Thrust equation valid: error = {error:.2e} N", error)


def validate_engine_state(
    Pc: float,
    MR: float,
    mdot_total: float,
    cstar: float,
    gamma: float,
    Tc: float,
    Isp: float,
    F: float,
) -> List[ValidationResult]:
    """
    Comprehensive validation of engine state.
    
    Returns list of validation results (errors first, then warnings, then info).
    """
    results = []
    
    # Physical constraints
    results.append(PhysicalConstraints.validate_pressure(Pc, "Pc"))
    results.append(PhysicalConstraints.validate_temperature(Tc, "Tc"))
    results.append(PhysicalConstraints.validate_mass_flow(mdot_total, "mdot_total"))
    results.append(PhysicalConstraints.validate_mixture_ratio(MR))
    results.append(PhysicalConstraints.validate_gamma(gamma))
    results.append(PhysicalConstraints.validate_cstar(cstar))
    results.append(PhysicalConstraints.validate_isp(Isp))
    
    # Physics relationships
    # Check: mdot = Pc * At / cstar (approximately, for choked flow)
    # This would require At, so we skip it here
    
    # Sort by severity: error > warning > info
    severity_order = {"error": 0, "warning": 1, "info": 2}
    results.sort(key=lambda r: severity_order.get(r.severity, 3))
    
    return results

