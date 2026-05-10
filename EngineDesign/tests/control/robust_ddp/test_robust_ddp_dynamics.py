"""Unit tests for robust DDP controller dynamics."""

import unittest
import numpy as np

from engine.control.robust_ddp.dynamics import (
    step,
    linearize,
    DynamicsParams,
    N_STATE,
    N_CONTROL,
    IDX_P_COPV,
    IDX_P_REG,
    IDX_P_U_F,
    IDX_P_U_O,
    IDX_P_D_F,
    IDX_P_D_O,
    IDX_V_U_F,
    IDX_V_U_O,
)
from engine.control.robust_ddp.data_models import ControllerConfig


class TestDynamics(unittest.TestCase):
    """Test dynamics model."""
    
    def setUp(self):
        """Set up test fixtures."""
        self.config = ControllerConfig()
        self.params = DynamicsParams.from_config(self.config)
        self.dt = 0.01  # 10 ms
        
        # Initial state: [P_copv, P_reg, P_u_F, P_u_O, P_d_F, P_d_O, V_u_F, V_u_O]
        self.x0 = np.array([
            30e6,    # P_copv: 30 MPa (~4350 psi)
            24e6,    # P_reg: 24 MPa (~3480 psi)
            3e6,     # P_u_F: 3 MPa (~435 psi)
            3.5e6,   # P_u_O: 3.5 MPa (~508 psi)
            2.5e6,   # P_d_F: 2.5 MPa (~363 psi)
            3e6,     # P_d_O: 3 MPa (~435 psi)
            0.01,    # V_u_F: 0.01 m³ (10 L)
            0.01,    # V_u_O: 0.01 m³ (10 L)
        ], dtype=np.float64)
        
        # Control: [u_F, u_O] in [0, 1]
        self.u0 = np.array([0.5, 0.5], dtype=np.float64)
        
        # Mass flow rates [kg/s]
        self.mdot_F = 0.5
        self.mdot_O = 1.0
    
    def test_step_basic(self):
        """Test basic step function."""
        x_next = step(self.x0, self.u0, self.dt, self.params, self.mdot_F, self.mdot_O)
        
        self.assertEqual(len(x_next), N_STATE)
        self.assertTrue(np.all(np.isfinite(x_next)))
        self.assertTrue(np.all(x_next >= 0))  # All pressures/volumes non-negative
    
    def test_blowdown_decreases_pressure(self):
        """Test that blowdown decreases P_u when u=0 and mdot>0."""
        # Set control to zero (no pressurization)
        u = np.array([0.0, 0.0], dtype=np.float64)
        
        # Initial ullage pressures
        P_u_F_initial = self.x0[IDX_P_U_F]
        P_u_O_initial = self.x0[IDX_P_U_O]
        
        # Step forward
        x_next = step(self.x0, u, self.dt, self.params, self.mdot_F, self.mdot_O)
        
        # Ullage pressures should decrease due to blowdown
        P_u_F_next = x_next[IDX_P_U_F]
        P_u_O_next = x_next[IDX_P_U_O]
        
        self.assertLess(P_u_F_next, P_u_F_initial, 
                       f"P_u_F should decrease: {P_u_F_next} < {P_u_F_initial}")
        self.assertLess(P_u_O_next, P_u_O_initial,
                       f"P_u_O should decrease: {P_u_O_next} < {P_u_O_initial}")
    
    def test_pressurization_increases_pressure(self):
        """Test that pressurization increases P_u when u>0 and headroom positive."""
        # Set high control (full pressurization)
        u = np.array([1.0, 1.0], dtype=np.float64)
        
        # Set regulator pressure higher than ullage (positive headroom)
        x = self.x0.copy()
        x[IDX_P_REG] = 5e6  # 5 MPa regulator
        x[IDX_P_U_F] = 3e6  # 3 MPa fuel ullage (2 MPa headroom)
        x[IDX_P_U_O] = 3e6  # 3 MPa oxidizer ullage (2 MPa headroom)
        
        # Set low mass flow to minimize blowdown effect
        mdot_F_low = 0.01
        mdot_O_low = 0.01
        
        # Initial ullage pressures
        P_u_F_initial = x[IDX_P_U_F]
        P_u_O_initial = x[IDX_P_U_O]
        
        # Step forward
        x_next = step(x, u, self.dt, self.params, mdot_F_low, mdot_O_low)
        
        # Ullage pressures should increase due to pressurization
        P_u_F_next = x_next[IDX_P_U_F]
        P_u_O_next = x_next[IDX_P_U_O]
        
        self.assertGreater(P_u_F_next, P_u_F_initial,
                          f"P_u_F should increase: {P_u_F_next} > {P_u_F_initial}")
        self.assertGreater(P_u_O_next, P_u_O_initial,
                          f"P_u_O should increase: {P_u_O_next} > {P_u_O_initial}")
    
    def test_ullage_volume_increases(self):
        """Test that ullage volume increases with propellant consumption."""
        V_u_F_initial = self.x0[IDX_V_U_F]
        V_u_O_initial = self.x0[IDX_V_U_O]
        
        x_next = step(self.x0, self.u0, self.dt, self.params, self.mdot_F, self.mdot_O)
        
        V_u_F_next = x_next[IDX_V_U_F]
        V_u_O_next = x_next[IDX_V_U_O]
        
        # Volumes should increase as propellant is consumed
        self.assertGreater(V_u_F_next, V_u_F_initial,
                          f"V_u_F should increase: {V_u_F_next} > {V_u_F_initial}")
        self.assertGreater(V_u_O_next, V_u_O_initial,
                          f"V_u_O should increase: {V_u_O_next} > {V_u_O_initial}")
    
    def test_copv_blowdown(self):
        """Test COPV pressure decreases with control usage."""
        P_copv_initial = self.x0[IDX_P_COPV]
        
        # With control active
        x_next = step(self.x0, self.u0, self.dt, self.params, self.mdot_F, self.mdot_O)
        P_copv_next = x_next[IDX_P_COPV]
        
        # COPV should decrease
        self.assertLess(P_copv_next, P_copv_initial,
                       f"P_copv should decrease: {P_copv_next} < {P_copv_initial}")
        
        # With zero control, should still decrease due to loss
        u_zero = np.array([0.0, 0.0], dtype=np.float64)
        x_next_zero = step(self.x0, u_zero, self.dt, self.params, 0.0, 0.0)
        P_copv_next_zero = x_next_zero[IDX_P_COPV]
        
        self.assertLess(P_copv_next_zero, P_copv_initial,
                       f"P_copv should decrease even with u=0 due to loss: "
                       f"{P_copv_next_zero} < {P_copv_initial}")
    
    def test_regulator_behavior(self):
        """Test regulator pressure behavior."""
        # Test with setpoint
        params_setpoint = DynamicsParams.from_config(self.config)
        params_setpoint.reg_setpoint = 25e6  # 25 MPa setpoint
        
        x_next = step(self.x0, self.u0, self.dt, params_setpoint, self.mdot_F, self.mdot_O)
        P_reg_next = x_next[IDX_P_REG]
        
        # Should be at setpoint
        self.assertAlmostEqual(P_reg_next, 25e6, delta=1e3,
                              msg=f"P_reg should be at setpoint: {P_reg_next} ≈ 25e6")
        
        # Test with ratio (no setpoint)
        params_ratio = DynamicsParams.from_config(self.config)
        params_ratio.reg_setpoint = None
        params_ratio.reg_ratio = 0.8
        
        x_next_ratio = step(self.x0, self.u0, self.dt, params_ratio, self.mdot_F, self.mdot_O)
        P_reg_next_ratio = x_next_ratio[IDX_P_REG]
        P_copv_next_ratio = x_next_ratio[IDX_P_COPV]
        
        # Should be approximately reg_ratio * P_copv
        expected_P_reg = params_ratio.reg_ratio * P_copv_next_ratio
        self.assertAlmostEqual(P_reg_next_ratio, expected_P_reg, delta=1e3,
                              msg=f"P_reg should be {params_ratio.reg_ratio} * P_copv: "
                              f"{P_reg_next_ratio} ≈ {expected_P_reg}")
    
    def test_feed_pressure_lag(self):
        """Test feed pressure follows ullage pressure with lag."""
        # Set feed pressures different from ullage
        x = self.x0.copy()
        x[IDX_P_D_F] = 1e6  # Low feed pressure
        x[IDX_P_D_O] = 1e6  # Low feed pressure
        
        x_next = step(x, self.u0, self.dt, self.params, self.mdot_F, self.mdot_O)
        
        # Feed pressures should move toward ullage pressures
        P_d_F_next = x_next[IDX_P_D_F]
        P_d_O_next = x_next[IDX_P_D_O]
        
        # Should be higher than initial (moving toward ullage)
        self.assertGreater(P_d_F_next, x[IDX_P_D_F],
                           f"P_d_F should increase toward P_u_F: {P_d_F_next} > {x[IDX_P_D_F]}")
        self.assertGreater(P_d_O_next, x[IDX_P_D_O],
                           f"P_d_O should increase toward P_u_O: {P_d_O_next} > {x[IDX_P_D_O]}")
    
    def test_linearize_shape(self):
        """Test linearization returns correct matrix shapes."""
        A, B = linearize(self.x0, self.u0, self.dt, self.params, self.mdot_F, self.mdot_O)
        
        self.assertEqual(A.shape, (N_STATE, N_STATE))
        self.assertEqual(B.shape, (N_STATE, N_CONTROL))
        self.assertTrue(np.all(np.isfinite(A)))
        self.assertTrue(np.all(np.isfinite(B)))
    
    def test_linearize_accuracy(self):
        """Test linearization accuracy."""
        # Compute linearization
        A, B = linearize(self.x0, self.u0, self.dt, self.params, self.mdot_F, self.mdot_O)
        
        # Nominal next state
        x_nom = step(self.x0, self.u0, self.dt, self.params, self.mdot_F, self.mdot_O)
        
        # Linearized prediction
        x_lin = A @ self.x0 + B @ self.u0
        
        # For small perturbations, linearization should be close
        # Note: dynamics are nonlinear, so we don't expect exact match
        # But should be within reasonable tolerance
        error = np.linalg.norm(x_lin - x_nom)
        self.assertLess(error, 1e6,  # Allow 1 MPa error
                       f"Linearization error too large: {error}")
    
    def test_zero_mass_flow(self):
        """Test dynamics with zero mass flow."""
        x_next = step(self.x0, self.u0, self.dt, self.params, 0.0, 0.0)
        
        # Ullage volumes should not change
        self.assertEqual(x_next[IDX_V_U_F], self.x0[IDX_V_U_F])
        self.assertEqual(x_next[IDX_V_U_O], self.x0[IDX_V_U_O])
        
        # Pressures should still evolve (pressurization, COPV blowdown, etc.)
        self.assertTrue(np.all(np.isfinite(x_next)))
    
    def test_control_clamping(self):
        """Test that control is clamped to [0, 1]."""
        # Try control outside [0, 1]
        u_high = np.array([2.0, -1.0], dtype=np.float64)
        
        x_next = step(self.x0, u_high, self.dt, self.params, self.mdot_F, self.mdot_O)
        
        # Should not crash and should produce valid state
        self.assertTrue(np.all(np.isfinite(x_next)))
        self.assertTrue(np.all(x_next >= 0))
    
    def test_state_non_negative(self):
        """Test that all states remain non-negative."""
        # Try various initial conditions
        x_test = self.x0.copy()
        x_test[IDX_P_COPV] = 1e6  # Low COPV
        x_test[IDX_P_U_F] = 0.1e6  # Very low ullage
        
        x_next = step(x_test, self.u0, self.dt, self.params, self.mdot_F, self.mdot_O)
        
        # All states should be non-negative
        self.assertTrue(np.all(x_next >= 0), 
                       f"All states should be non-negative, got: {x_next}")


if __name__ == '__main__':
    unittest.main()

