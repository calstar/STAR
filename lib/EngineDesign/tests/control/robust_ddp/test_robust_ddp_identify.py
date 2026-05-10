"""Unit tests for parameter identification module."""

import unittest
import numpy as np

from engine.control.robust_ddp.identify import ParameterIdentifier, update_params
from engine.control.robust_ddp.data_models import ControllerConfig, ControllerState, Measurement
from engine.control.robust_ddp.dynamics import (
    IDX_P_COPV,
    IDX_P_REG,
    IDX_P_U_F,
    IDX_P_U_O,
    IDX_P_D_F,
    IDX_P_D_O,
    IDX_V_U_F,
    IDX_V_U_O,
    step,
    DynamicsParams,
)


class TestParameterIdentification(unittest.TestCase):
    """Test parameter identification."""
    
    def setUp(self):
        """Set up test fixtures."""
        self.cfg = ControllerConfig(
            N=10,
            dt=0.01,
            alpha_F=10.0,
            alpha_O=10.0,
            tau_line_F=0.01,
            tau_line_O=0.01,
            copv_cF=1e5,
            copv_cO=1e5,
            copv_loss=1e3,
            rho_F=800.0,
            rho_O=1140.0,
        )
    
    def test_identify_alpha_F(self):
        """Test identification of alpha_F from synthetic data."""
        # True parameter
        alpha_F_true = 15.0
        
        # Create identifier with wrong initial value
        identifier = ParameterIdentifier(self.cfg, forgetting_factor=0.95)
        identifier.alpha_F = 5.0  # Wrong initial value
        
        # Generate synthetic data
        x = np.array([30e6, 24e6, 3e6, 3.5e6, 2.5e6, 3e6, 0.01, 0.01])
        u = np.array([0.8, 0.5])  # Fuel valve on
        dt = 0.01
        
        # Create dynamics params with true alpha_F
        params_true = DynamicsParams.from_config(self.cfg)
        params_true.alpha_F = alpha_F_true
        
        # Simulate and identify
        alpha_initial = identifier.alpha_F
        for _ in range(100):
            # Step dynamics with true parameter
            x_next = step(x, u, dt, params_true, 0.5, 1.0)
            
            # Create measurement
            meas = Measurement(
                P_copv=x[IDX_P_COPV],
                P_reg=x[IDX_P_REG],
                P_u_fuel=x[IDX_P_U_F],
                P_u_ox=x[IDX_P_U_O],
                P_d_fuel=x[IDX_P_D_F],
                P_d_ox=x[IDX_P_D_O],
            )
            
            # Update identifier
            identifier.update_params(
                ControllerState(), meas, self.cfg, x, u, dt, mdot_F=0.5, mdot_O=1.0
            )
            
            x = x_next
        
        alpha_final = identifier.alpha_F
        
        # Should move toward true value
        error_initial = abs(alpha_initial - alpha_F_true)
        error_final = abs(alpha_final - alpha_F_true)
        
        self.assertLess(error_final, error_initial, "Parameter should move toward true value")
        self.assertLess(error_final, error_initial * 0.5, "Should converge significantly")
    
    def test_identify_alpha_O(self):
        """Test identification of alpha_O from synthetic data."""
        # True parameter
        alpha_O_true = 20.0
        
        # Create identifier
        identifier = ParameterIdentifier(self.cfg, forgetting_factor=0.95)
        identifier.alpha_O = 5.0  # Wrong initial value
        
        # Generate synthetic data
        x = np.array([30e6, 24e6, 3e6, 3.5e6, 2.5e6, 3e6, 0.01, 0.01])
        u = np.array([0.3, 0.9])  # Oxidizer valve on
        dt = 0.01
        
        # Create dynamics params with true alpha_O
        params_true = DynamicsParams.from_config(self.cfg)
        params_true.alpha_O = alpha_O_true
        
        # Simulate and identify
        alpha_initial = identifier.alpha_O
        for _ in range(100):
            x_next = step(x, u, dt, params_true, 0.5, 1.0)
            
            meas = Measurement(
                P_copv=x[IDX_P_COPV],
                P_reg=x[IDX_P_REG],
                P_u_fuel=x[IDX_P_U_F],
                P_u_ox=x[IDX_P_U_O],
                P_d_fuel=x[IDX_P_D_F],
                P_d_ox=x[IDX_P_D_O],
            )
            
            identifier.update_params(
                ControllerState(), meas, self.cfg, x, u, dt, mdot_F=0.5, mdot_O=1.0
            )
            
            x = x_next
        
        alpha_final = identifier.alpha_O
        
        # Should move toward true value
        error_initial = abs(alpha_initial - alpha_O_true)
        error_final = abs(alpha_final - alpha_O_true)
        
        self.assertLess(error_final, error_initial)
    
    def test_identify_tau_line_F(self):
        """Test identification of tau_line_F from synthetic data."""
        # True parameter
        tau_line_F_true = 0.05
        
        # Create identifier
        identifier = ParameterIdentifier(self.cfg, forgetting_factor=0.95)
        identifier.tau_line_F = 0.01  # Wrong initial value
        
        # Generate synthetic data
        x = np.array([30e6, 24e6, 5e6, 3.5e6, 2.5e6, 3e6, 0.01, 0.01])
        u = np.array([0.5, 0.5])
        dt = 0.01
        
        # Create dynamics params with true tau
        params_true = DynamicsParams.from_config(self.cfg)
        params_true.tau_line_F = tau_line_F_true
        
        # Simulate and identify
        tau_initial = identifier.tau_line_F
        for _ in range(200):  # More steps for tau (slower dynamics)
            x_next = step(x, u, dt, params_true, 0.5, 1.0)
            
            meas = Measurement(
                P_copv=x[IDX_P_COPV],
                P_reg=x[IDX_P_REG],
                P_u_fuel=x[IDX_P_U_F],
                P_u_ox=x[IDX_P_U_O],
                P_d_fuel=x[IDX_P_D_F],
                P_d_ox=x[IDX_P_D_O],
            )
            
            identifier.update_params(
                ControllerState(), meas, self.cfg, x, u, dt, mdot_F=0.5, mdot_O=1.0
            )
            
            x = x_next
        
        tau_final = identifier.tau_line_F
        
        # Should move toward true value
        error_initial = abs(tau_initial - tau_line_F_true)
        error_final = abs(tau_final - tau_line_F_true)
        
        self.assertLess(error_final, error_initial)
    
    def test_identify_tau_line_O(self):
        """Test identification of tau_line_O from synthetic data."""
        # True parameter
        tau_line_O_true = 0.08
        
        # Create identifier
        identifier = ParameterIdentifier(self.cfg, forgetting_factor=0.95)
        identifier.tau_line_O = 0.01  # Wrong initial value
        
        # Generate synthetic data
        x = np.array([30e6, 24e6, 3e6, 5.5e6, 2.5e6, 3e6, 0.01, 0.01])
        u = np.array([0.5, 0.5])
        dt = 0.01
        
        # Create dynamics params with true tau
        params_true = DynamicsParams.from_config(self.cfg)
        params_true.tau_line_O = tau_line_O_true
        
        # Simulate and identify
        tau_initial = identifier.tau_line_O
        for _ in range(200):
            x_next = step(x, u, dt, params_true, 0.5, 1.0)
            
            meas = Measurement(
                P_copv=x[IDX_P_COPV],
                P_reg=x[IDX_P_REG],
                P_u_fuel=x[IDX_P_U_F],
                P_u_ox=x[IDX_P_U_O],
                P_d_fuel=x[IDX_P_D_F],
                P_d_ox=x[IDX_P_D_O],
            )
            
            identifier.update_params(
                ControllerState(), meas, self.cfg, x, u, dt, mdot_F=0.5, mdot_O=1.0
            )
            
            x = x_next
        
        tau_final = identifier.tau_line_O
        
        # Should move toward true value
        error_initial = abs(tau_initial - tau_line_O_true)
        error_final = abs(tau_final - tau_line_O_true)
        
        self.assertLess(error_final, error_initial)
    
    def test_identify_copv_coefficients(self):
        """Test identification of COPV consumption coefficients."""
        # True parameters
        copv_cF_true = 1.5e5
        copv_cO_true = 1.2e5
        
        # Create identifier
        identifier = ParameterIdentifier(self.cfg, forgetting_factor=0.95)
        identifier.copv_cF = 5e4  # Wrong initial value
        identifier.copv_cO = 5e4
        
        # Generate synthetic data
        x = np.array([30e6, 24e6, 3e6, 3.5e6, 2.5e6, 3e6, 0.01, 0.01])
        u = np.array([0.7, 0.6])  # Both valves on
        dt = 0.01
        
        # Create dynamics params with true coefficients
        params_true = DynamicsParams.from_config(self.cfg)
        params_true.copv_cF = copv_cF_true
        params_true.copv_cO = copv_cO_true
        
        # Simulate and identify
        cF_initial = identifier.copv_cF
        cO_initial = identifier.copv_cO
        
        for _ in range(200):
            x_next = step(x, u, dt, params_true, 0.5, 1.0)
            
            meas = Measurement(
                P_copv=x[IDX_P_COPV],
                P_reg=x[IDX_P_REG],
                P_u_fuel=x[IDX_P_U_F],
                P_u_ox=x[IDX_P_U_O],
                P_d_fuel=x[IDX_P_D_F],
                P_d_ox=x[IDX_P_D_O],
            )
            
            identifier.update_params(
                ControllerState(), meas, self.cfg, x, u, dt, mdot_F=0.5, mdot_O=1.0
            )
            
            x = x_next
        
        cF_final = identifier.copv_cF
        cO_final = identifier.copv_cO
        
        # Should move toward true values
        error_F_initial = abs(cF_initial - copv_cF_true)
        error_F_final = abs(cF_final - copv_cF_true)
        error_O_initial = abs(cO_initial - copv_cO_true)
        error_O_final = abs(cO_final - copv_cO_true)
        
        self.assertLess(error_F_final, error_F_initial)
        self.assertLess(error_O_final, error_O_initial)
    
    def test_parameter_bounds(self):
        """Test that parameters stay within bounds."""
        identifier = ParameterIdentifier(self.cfg)
        
        # Try to push parameters out of bounds
        identifier.alpha_F = 200.0  # Above max
        identifier.alpha_O = 0.01  # Below min
        identifier.tau_line_F = 0.0001  # Below min
        identifier.tau_line_O = 2.0  # Above max
        identifier.copv_cF = 1e8  # Above max
        identifier.copv_cO = 1e2  # Below min
        
        # Update should bound them
        x = np.array([30e6, 24e6, 3e6, 3.5e6, 2.5e6, 3e6, 0.01, 0.01])
        u = np.array([0.5, 0.5])
        meas = Measurement(
            P_copv=x[IDX_P_COPV],
            P_reg=x[IDX_P_REG],
            P_u_fuel=x[IDX_P_U_F],
            P_u_ox=x[IDX_P_U_O],
            P_d_fuel=x[IDX_P_D_F],
            P_d_ox=x[IDX_P_D_O],
        )
        
        identifier.update_params(
            ControllerState(), meas, self.cfg, x, u, 0.01, mdot_F=0.5, mdot_O=1.0
        )
        
        # Check bounds
        self.assertGreaterEqual(identifier.alpha_F, identifier.alpha_min)
        self.assertLessEqual(identifier.alpha_F, identifier.alpha_max)
        self.assertGreaterEqual(identifier.alpha_O, identifier.alpha_min)
        self.assertLessEqual(identifier.alpha_O, identifier.alpha_max)
        self.assertGreaterEqual(identifier.tau_line_F, identifier.tau_min)
        self.assertLessEqual(identifier.tau_line_F, identifier.tau_max)
        self.assertGreaterEqual(identifier.tau_line_O, identifier.tau_min)
        self.assertLessEqual(identifier.tau_line_O, identifier.tau_max)
        self.assertGreaterEqual(identifier.copv_cF, identifier.copv_c_min)
        self.assertLessEqual(identifier.copv_cF, identifier.copv_c_max)
        self.assertGreaterEqual(identifier.copv_cO, identifier.copv_c_min)
        self.assertLessEqual(identifier.copv_cO, identifier.copv_c_max)
    
    def test_get_params(self):
        """Test get_params method."""
        identifier = ParameterIdentifier(self.cfg)
        
        params = identifier.get_params()
        
        self.assertIn("alpha_F", params)
        self.assertIn("alpha_O", params)
        self.assertIn("tau_line_F", params)
        self.assertIn("tau_line_O", params)
        self.assertIn("copv_cF", params)
        self.assertIn("copv_cO", params)
        
        self.assertEqual(params["alpha_F"], identifier.alpha_F)
        self.assertEqual(params["alpha_O"], identifier.alpha_O)
    
    def test_update_config(self):
        """Test slow update of config parameters."""
        identifier = ParameterIdentifier(self.cfg)
        
        # Set identifier to different values
        identifier.alpha_F = 20.0
        identifier.alpha_O = 25.0
        
        # Initial config values
        alpha_F_initial = self.cfg.alpha_F
        alpha_O_initial = self.cfg.alpha_O
        
        # Update config (should move slowly)
        identifier.update_config(self.cfg)
        
        # Should move toward identifier values but not all the way
        self.assertGreater(self.cfg.alpha_F, alpha_F_initial)
        self.assertLess(self.cfg.alpha_F, identifier.alpha_F)
        self.assertGreater(self.cfg.alpha_O, alpha_O_initial)
        self.assertLess(self.cfg.alpha_O, identifier.alpha_O)


if __name__ == "__main__":
    unittest.main()

