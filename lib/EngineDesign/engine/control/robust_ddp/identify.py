"""Online parameter identification for robust DDP controller.

Uses Recursive Least Squares (RLS) with forgetting factor to identify:
- alpha_F, alpha_O: Pressurization flow coefficients
- tau_line_F, tau_line_O: Feed line time constants
- copv_cF, copv_cO: COPV consumption coefficients
"""

from __future__ import annotations

from typing import Optional
import numpy as np

from .data_models import ControllerConfig, ControllerState, Measurement
from .dynamics import (
    IDX_P_COPV,
    IDX_P_REG,
    IDX_P_U_F,
    IDX_P_U_O,
    IDX_P_D_F,
    IDX_P_D_O,
    IDX_V_U_F,
    IDX_V_U_O,
    IDX_U_F,
    IDX_U_O,
)


class ParameterIdentifier:
    """Online parameter identifier using RLS with forgetting factor."""
    
    def __init__(self, cfg: ControllerConfig, forgetting_factor: float = 0.99):
        """
        Initialize parameter identifier.
        
        Parameters:
        -----------
        cfg : ControllerConfig
            Controller configuration (contains initial parameter values)
        forgetting_factor : float
            RLS forgetting factor (0 < lambda < 1, closer to 1 = slower forgetting)
        """
        self.cfg = cfg
        self.lambda_rls = forgetting_factor
        
        # Initialize parameters (will be updated from cfg)
        self.alpha_F = cfg.alpha_F
        self.alpha_O = cfg.alpha_O
        self.tau_line_F = cfg.tau_line_F
        self.tau_line_O = cfg.tau_line_O
        self.copv_cF = cfg.copv_cF
        self.copv_cO = cfg.copv_cO
        
        # RLS state for alpha_F
        self.P_alpha_F = 1e6  # Covariance matrix (scalar for 1D)
        self.theta_alpha_F = cfg.alpha_F  # Parameter estimate
        
        # RLS state for alpha_O
        self.P_alpha_O = 1e6
        self.theta_alpha_O = cfg.alpha_O
        
        # RLS state for tau_line_F (identify 1/tau)
        self.P_tau_F = 1e6
        self.theta_tau_F = 1.0 / cfg.tau_line_F
        
        # RLS state for tau_line_O (identify 1/tau)
        self.P_tau_O = 1e6
        self.theta_tau_O = 1.0 / cfg.tau_line_O
        
        # RLS state for COPV coefficients (2D: cF, cO)
        self.P_copv = 1e6 * np.eye(2)  # 2x2 covariance matrix
        self.theta_copv = np.array([cfg.copv_cF, cfg.copv_cO])
        
        # Previous state for computing derivatives
        self.x_prev: Optional[np.ndarray] = None
        self.u_prev: Optional[np.ndarray] = None
        self.t_prev: Optional[float] = None
        
        # Parameter bounds
        self.alpha_min, self.alpha_max = 0.1, 100.0  # [1/s]
        self.tau_min, self.tau_max = 0.001, 1.0  # [s]
        self.copv_c_min, self.copv_c_max = 1e3, 1e7  # [Pa/s per unit]
    
    def update_params(
        self,
        state: ControllerState,
        meas: Measurement,
        cfg: ControllerConfig,
        x_current: np.ndarray,
        u_current: np.ndarray,
        dt: float,
        mdot_F: Optional[float] = None,
        mdot_O: Optional[float] = None,
    ) -> None:
        """
        Update identified parameters from measurements.
        
        Parameters:
        -----------
        state : ControllerState
            Controller state (not used, but kept for API consistency)
        meas : Measurement
            Current measurements
        cfg : ControllerConfig
            Controller configuration
        x_current : np.ndarray
            Current state vector
        u_current : np.ndarray
            Current control input
        dt : float
            Time step [s]
        mdot_F : float, optional
            Fuel mass flow [kg/s]
        mdot_O : float, optional
            Oxidizer mass flow [kg/s]
        """
        if self.x_prev is None:
            # First call: store state and return
            self.x_prev = x_current.copy()
            self.u_prev = u_current.copy()
            self.t_prev = meas.timestamp if hasattr(meas, 'timestamp') else 0.0
            return
        
        # Compute derivatives (finite difference)
        dP_copv_dt = (x_current[IDX_P_COPV] - self.x_prev[IDX_P_COPV]) / dt
        dP_u_F_dt = (x_current[IDX_P_U_F] - self.x_prev[IDX_P_U_F]) / dt
        dP_u_O_dt = (x_current[IDX_P_U_O] - self.x_prev[IDX_P_U_O]) / dt
        dP_d_F_dt = (x_current[IDX_P_D_F] - self.x_prev[IDX_P_D_F]) / dt
        dP_d_O_dt = (x_current[IDX_P_D_O] - self.x_prev[IDX_P_D_O]) / dt
        
        # Update alpha_F (pressurization coefficient)
        self._update_alpha_F(
            dP_u_F_dt, x_current, u_current, dt, mdot_F
        )
        
        # Update alpha_O (pressurization coefficient)
        self._update_alpha_O(
            dP_u_O_dt, x_current, u_current, dt, mdot_O
        )
        
        # Update tau_line_F (feed line time constant)
        self._update_tau_line_F(dP_d_F_dt, x_current, dt)
        
        # Update tau_line_O (feed line time constant)
        self._update_tau_line_O(dP_d_O_dt, x_current, dt)
        
        # Update COPV coefficients
        self._update_copv_coefficients(dP_copv_dt, u_current, dt)
        
        # Update previous state
        self.x_prev = x_current.copy()
        self.u_prev = u_current.copy()
        self.t_prev = meas.timestamp if hasattr(meas, 'timestamp') else self.t_prev + dt
    
    def _update_alpha_F(
        self,
        dP_u_dt: float,
        x: np.ndarray,
        u: np.ndarray,
        dt: float,
        mdot_F: Optional[float],
    ) -> None:
        """Update alpha_F using RLS."""
        P_reg = x[IDX_P_REG]
        P_u = x[IDX_P_U_F]
        u_F = u[IDX_U_F]
        V_u = x[IDX_V_U_F]
        
        # Only update when valve is on and there's headroom
        if u_F < 0.1 or P_reg <= P_u:
            return
        
        # Model: dP_u/dt = alpha * u * (P_reg - P_u) - (P_u/V_u) * (mdot/rho)
        # Rearrange: dP_u/dt + (P_u/V_u) * (mdot/rho) = alpha * u * (P_reg - P_u)
        
        # Compute blowdown term
        blowdown_term = 0.0
        if V_u > 1e-10 and mdot_F is not None:
            blowdown_term = (P_u / V_u) * (mdot_F / self.cfg.rho_F)
        
        # Measurement: y = dP_u/dt + blowdown_term
        y = dP_u_dt + blowdown_term
        
        # Regressor: phi = u * (P_reg - P_u)
        phi = u_F * (P_reg - P_u)
        
        if abs(phi) < 1e-6:  # Avoid division by zero
            return
        
        # RLS update
        K = self.P_alpha_F * phi / (self.lambda_rls + self.P_alpha_F * phi ** 2)
        error = y - self.theta_alpha_F * phi
        self.theta_alpha_F += K * error
        self.P_alpha_F = (1.0 / self.lambda_rls) * (self.P_alpha_F - K * phi * self.P_alpha_F)
        
        # Bound and update parameter
        self.theta_alpha_F = np.clip(self.theta_alpha_F, self.alpha_min, self.alpha_max)
        self.alpha_F = self.theta_alpha_F
    
    def _update_alpha_O(
        self,
        dP_u_dt: float,
        x: np.ndarray,
        u: np.ndarray,
        dt: float,
        mdot_O: Optional[float],
    ) -> None:
        """Update alpha_O using RLS."""
        P_reg = x[IDX_P_REG]
        P_u = x[IDX_P_U_O]
        u_O = u[IDX_U_O]
        V_u = x[IDX_V_U_O]
        
        # Only update when valve is on and there's headroom
        if u_O < 0.1 or P_reg <= P_u:
            return
        
        # Compute blowdown term
        blowdown_term = 0.0
        if V_u > 1e-10 and mdot_O is not None:
            blowdown_term = (P_u / V_u) * (mdot_O / self.cfg.rho_O)
        
        # Measurement: y = dP_u/dt + blowdown_term
        y = dP_u_dt + blowdown_term
        
        # Regressor: phi = u * (P_reg - P_u)
        phi = u_O * (P_reg - P_u)
        
        if abs(phi) < 1e-6:
            return
        
        # RLS update
        K = self.P_alpha_O * phi / (self.lambda_rls + self.P_alpha_O * phi ** 2)
        error = y - self.theta_alpha_O * phi
        self.theta_alpha_O += K * error
        self.P_alpha_O = (1.0 / self.lambda_rls) * (self.P_alpha_O - K * phi * self.P_alpha_O)
        
        # Bound and update parameter
        self.theta_alpha_O = np.clip(self.theta_alpha_O, self.alpha_min, self.alpha_max)
        self.alpha_O = self.theta_alpha_O
    
    def _update_tau_line_F(self, dP_d_dt: float, x: np.ndarray, dt: float) -> None:
        """Update tau_line_F using RLS."""
        P_u = x[IDX_P_U_F]
        P_d = x[IDX_P_D_F]
        
        # Model: dP_d/dt = (P_u - P_d) / tau_line
        # Rearrange: dP_d/dt = (1/tau_line) * (P_u - P_d)
        
        # Regressor: phi = P_u - P_d
        phi = P_u - P_d
        
        if abs(phi) < 1e-6:
            return
        
        # Measurement: y = dP_d/dt
        y = dP_d_dt
        
        # RLS update (identify 1/tau)
        K = self.P_tau_F * phi / (self.lambda_rls + self.P_tau_F * phi ** 2)
        error = y - self.theta_tau_F * phi
        self.theta_tau_F += K * error
        self.P_tau_F = (1.0 / self.lambda_rls) * (self.P_tau_F - K * phi * self.P_tau_F)
        
        # Convert to tau and bound
        tau = 1.0 / max(abs(self.theta_tau_F), 1e-6)  # Avoid division by zero
        tau = np.clip(tau, self.tau_min, self.tau_max)
        self.tau_line_F = tau
        self.theta_tau_F = 1.0 / tau  # Update theta to match bounded tau
    
    def _update_tau_line_O(self, dP_d_dt: float, x: np.ndarray, dt: float) -> None:
        """Update tau_line_O using RLS."""
        P_u = x[IDX_P_U_O]
        P_d = x[IDX_P_D_O]
        
        # Regressor: phi = P_u - P_d
        phi = P_u - P_d
        
        if abs(phi) < 1e-6:
            return
        
        # Measurement: y = dP_d/dt
        y = dP_d_dt
        
        # RLS update (identify 1/tau)
        K = self.P_tau_O * phi / (self.lambda_rls + self.P_tau_O * phi ** 2)
        error = y - self.theta_tau_O * phi
        self.theta_tau_O += K * error
        self.P_tau_O = (1.0 / self.lambda_rls) * (self.P_tau_O - K * phi * self.P_tau_O)
        
        # Convert to tau and bound
        tau = 1.0 / max(abs(self.theta_tau_O), 1e-6)
        tau = np.clip(tau, self.tau_min, self.tau_max)
        self.tau_line_O = tau
        self.theta_tau_O = 1.0 / tau
    
    def _update_copv_coefficients(
        self,
        dP_copv_dt: float,
        u: np.ndarray,
        dt: float,
    ) -> None:
        """Update COPV consumption coefficients using RLS."""
        u_F = u[IDX_U_F]
        u_O = u[IDX_U_O]
        
        # Model: dP_copv/dt = -(cF*u_F + cO*u_O + loss)
        # Rearrange: -dP_copv/dt = cF*u_F + cO*u_O + loss
        
        # Measurement: y = -dP_copv/dt (excluding loss)
        y = -dP_copv_dt - self.cfg.copv_loss
        
        # Regressor: phi = [u_F, u_O]
        phi = np.array([u_F, u_O])
        
        if np.linalg.norm(phi) < 1e-6:
            return
        
        # RLS update (2D)
        P_phi = self.P_copv @ phi
        denominator = self.lambda_rls + phi @ P_phi
        if abs(denominator) < 1e-10:
            return
        
        K = P_phi / denominator
        error = y - self.theta_copv @ phi
        self.theta_copv += K * error
        self.P_copv = (1.0 / self.lambda_rls) * (self.P_copv - np.outer(K, P_phi))
        
        # Bound parameters
        self.theta_copv = np.clip(self.theta_copv, self.copv_c_min, self.copv_c_max)
        self.copv_cF = self.theta_copv[0]
        self.copv_cO = self.theta_copv[1]
    
    def get_params(self) -> dict:
        """Get current parameter estimates."""
        return {
            "alpha_F": self.alpha_F,
            "alpha_O": self.alpha_O,
            "tau_line_F": self.tau_line_F,
            "tau_line_O": self.tau_line_O,
            "copv_cF": self.copv_cF,
            "copv_cO": self.copv_cO,
        }
    
    def update_config(self, cfg: ControllerConfig) -> None:
        """Update config with identified parameters (slow update)."""
        # Use exponential moving average to update slowly
        update_rate = 0.01  # 1% per update
        
        cfg.alpha_F = (1 - update_rate) * cfg.alpha_F + update_rate * self.alpha_F
        cfg.alpha_O = (1 - update_rate) * cfg.alpha_O + update_rate * self.alpha_O
        cfg.tau_line_F = (1 - update_rate) * cfg.tau_line_F + update_rate * self.tau_line_F
        cfg.tau_line_O = (1 - update_rate) * cfg.tau_line_O + update_rate * self.tau_line_O
        cfg.copv_cF = (1 - update_rate) * cfg.copv_cF + update_rate * self.copv_cF
        cfg.copv_cO = (1 - update_rate) * cfg.copv_cO + update_rate * self.copv_cO


def update_params(
    identifier: ParameterIdentifier,
    state: ControllerState,
    meas: Measurement,
    cfg: ControllerConfig,
    x_current: np.ndarray,
    u_current: np.ndarray,
    dt: float,
    mdot_F: Optional[float] = None,
    mdot_O: Optional[float] = None,
) -> None:
    """
    Update identified parameters (convenience function).
    
    Parameters:
    -----------
    identifier : ParameterIdentifier
        Parameter identifier instance
    state : ControllerState
        Controller state
    meas : Measurement
        Current measurements
    cfg : ControllerConfig
        Controller configuration
    x_current : np.ndarray
        Current state vector
    u_current : np.ndarray
        Current control input
    dt : float
        Time step [s]
    mdot_F : float, optional
        Fuel mass flow [kg/s]
    mdot_O : float, optional
        Oxidizer mass flow [kg/s]
    """
    identifier.update_params(
        state, meas, cfg, x_current, u_current, dt, mdot_F, mdot_O
    )



