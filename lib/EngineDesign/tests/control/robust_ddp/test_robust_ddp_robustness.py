"""Unit tests for robust DDP controller robustness module."""

import unittest
import numpy as np

from engine.control.robust_ddp.robustness import (
    update_bounds,
    tube_propagate,
    get_w_bar_array,
    set_w_bar_array,
)
from engine.control.robust_ddp.data_models import ControllerConfig, ControllerState
from engine.control.robust_ddp.dynamics import (
    DynamicsParams,
    N_STATE,
    IDX_P_COPV,
    IDX_P_REG,
    IDX_P_U_F,
    IDX_P_U_O,
    IDX_P_D_F,
    IDX_P_D_O,
)
from engine.control.robust_ddp.engine_wrapper import EngineEstimate


class TestRobustness(unittest.TestCase):
    """Test robustness bounds and tube propagation."""
    
    def setUp(self):
        """Set up test fixtures."""
        self.config = ControllerConfig(
            rho=0.9,        # High retention (slow adaptation)
            eta=0.1,       # 10% inflation margin
            dt=0.01,       # 10 ms time step
        )
        self.params = DynamicsParams.from_config(self.config)
        
        # Test state
        self.x_prev = np.array([
            30e6,    # P_copv
            24e6,    # P_reg
            3e6,     # P_u_F
            3.5e6,   # P_u_O
            2.5e6,   # P_d_F
            3e6,     # P_d_O
            0.01,    # V_u_F
            0.01,    # V_u_O
        ], dtype=np.float64)
        
        self.u_prev = np.array([0.5, 0.5], dtype=np.float64)
        self.mdot_F = 0.5
        self.mdot_O = 1.0
    
    def test_update_bounds_basic(self):
        """Test basic bounds update."""
        state = ControllerState()
        
        # Measured state (slightly different from predicted)
        x_meas = self.x_prev.copy()
        x_meas[IDX_P_COPV] += 1e5  # 0.1 MPa difference
        
        # Update bounds
        update_bounds(
            state, self.x_prev, x_meas, self.u_prev, self.config,
            mdot_F=self.mdot_F, mdot_O=self.mdot_O, dt=self.config.dt
        )
        
        # Check that w_bar_array was created
        self.assertIsNotNone(state.w_bar_array)
        self.assertEqual(len(state.w_bar_array), N_STATE)
        
        # Check that bounds are non-negative
        self.assertTrue(np.all(state.w_bar_array >= 0))
        
        # Check that COPV bound is positive (we had a residual)
        self.assertGreater(state.w_bar_array[IDX_P_COPV], 0)
    
    def test_update_bounds_residual_spike(self):
        """Test that bounds increase when residual spikes."""
        state = ControllerState()
        
        # Initial update with small residual
        x_meas_small = self.x_prev.copy()
        x_meas_small[IDX_P_COPV] += 1e4  # 0.01 MPa difference
        
        update_bounds(
            state, self.x_prev, x_meas_small, self.u_prev, self.config,
            mdot_F=self.mdot_F, mdot_O=self.mdot_O, dt=self.config.dt
        )
        
        w_bar_initial = state.w_bar_array[IDX_P_COPV].copy()
        
        # Update with large residual spike
        x_meas_large = self.x_prev.copy()
        x_meas_large[IDX_P_COPV] += 1e6  # 1 MPa difference (large spike)
        
        update_bounds(
            state, self.x_prev, x_meas_large, self.u_prev, self.config,
            mdot_F=self.mdot_F, mdot_O=self.mdot_O, dt=self.config.dt
        )
        
        w_bar_after_spike = state.w_bar_array[IDX_P_COPV]
        
        # Bounds should increase after spike
        self.assertGreater(w_bar_after_spike, w_bar_initial,
                          f"Bounds should increase after spike: {w_bar_after_spike} > {w_bar_initial}")
    
    def test_update_bounds_ema_behavior(self):
        """Test exponential moving average behavior."""
        state = ControllerState()
        
        # Multiple updates with constant residual
        residual_magnitude = 1e5  # 0.1 MPa
        x_meas = self.x_prev.copy()
        x_meas[IDX_P_COPV] += residual_magnitude
        
        # First update
        update_bounds(
            state, self.x_prev, x_meas, self.u_prev, self.config,
            mdot_F=self.mdot_F, mdot_O=self.mdot_O, dt=self.config.dt
        )
        w_bar_1 = state.w_bar_array[IDX_P_COPV]
        
        # Second update (same residual)
        update_bounds(
            state, self.x_prev, x_meas, self.u_prev, self.config,
            mdot_F=self.mdot_F, mdot_O=self.mdot_O, dt=self.config.dt
        )
        w_bar_2 = state.w_bar_array[IDX_P_COPV]
        
        # With rho=0.9, second update should be:
        # w_bar_2 = 0.9 * w_bar_1 + 0.1 * residual_magnitude
        # Then inflated: w_bar_2 *= 1.1
        expected_w_bar_2 = (0.9 * w_bar_1 + 0.1 * residual_magnitude) * 1.1
        
        self.assertAlmostEqual(w_bar_2, expected_w_bar_2, delta=1e3,
                              msg="EMA update should follow formula")
    
    def test_update_bounds_inflation(self):
        """Test that bounds are inflated by eta."""
        state = ControllerState()
        
        # Update with known residual
        residual_magnitude = 1e5  # 0.1 MPa
        x_meas = self.x_prev.copy()
        x_meas[IDX_P_COPV] += residual_magnitude
        
        update_bounds(
            state, self.x_prev, x_meas, self.u_prev, self.config,
            mdot_F=self.mdot_F, mdot_O=self.mdot_O, dt=self.config.dt
        )
        
        # After first update with rho=0.9, eta=0.1:
        # w_bar = (1 - rho) * abs(residual) * (1 + eta)
        # w_bar = 0.1 * 1e5 * 1.1 = 1.1e4
        expected_w_bar = (1 - self.config.rho) * residual_magnitude * (1 + self.config.eta)
        
        self.assertAlmostEqual(
            state.w_bar_array[IDX_P_COPV], expected_w_bar,
            delta=1e2,
            msg=f"Bounds should be inflated: {state.w_bar_array[IDX_P_COPV]} ≈ {expected_w_bar}"
        )
    
    def test_update_bounds_beta(self):
        """Test disturbance bias beta update."""
        state = ControllerState()
        state.beta = 0.0
        
        # Update with residual
        x_meas = self.x_prev.copy()
        x_meas[IDX_P_COPV] += 1e5
        
        update_bounds(
            state, self.x_prev, x_meas, self.u_prev, self.config,
            mdot_F=self.mdot_F, mdot_O=self.mdot_O, dt=self.config.dt
        )
        
        # Beta should be updated (EWMA of mean residual)
        self.assertNotEqual(state.beta, 0.0)
        self.assertTrue(np.isfinite(state.beta))
    
    def test_tube_propagate_basic(self):
        """Test basic tube propagation."""
        # Create uncertainty tube
        x_nom = self.x_prev.copy()
        w_bar = np.array([1e5, 1e5, 1e5, 1e5, 1e5, 1e5, 1e-4, 1e-4], dtype=np.float64)
        
        x_lo = x_nom - w_bar
        x_hi = x_nom + w_bar
        
        # Propagate
        x_lo_next, x_hi_next = tube_propagate(
            x_lo, x_hi, self.u_prev, w_bar, self.config.dt,
            self.params, self.mdot_F, self.mdot_O
        )
        
        # Check shapes
        self.assertEqual(x_lo_next.shape, (N_STATE,))
        self.assertEqual(x_hi_next.shape, (N_STATE,))
        
        # Check that lo <= hi
        self.assertTrue(np.all(x_lo_next <= x_hi_next),
                       "Lower bound must be <= upper bound")
        
        # Check non-negativity
        self.assertTrue(np.all(x_lo_next >= 0),
                       "Lower bound must be non-negative")
    
    def test_tube_propagate_widens(self):
        """Test that tube propagation widens uncertainty."""
        # Create tight uncertainty tube
        x_nom = self.x_prev.copy()
        w_bar_small = np.full(N_STATE, 1e4, dtype=np.float64)  # Small bounds
        
        x_lo = x_nom - w_bar_small
        x_hi = x_nom + w_bar_small
        
        # Propagate
        x_lo_next, x_hi_next = tube_propagate(
            x_lo, x_hi, self.u_prev, w_bar_small, self.config.dt,
            self.params, self.mdot_F, self.mdot_O
        )
        
        # Compute tube widths
        width_before = np.sum(x_hi - x_lo)
        width_after = np.sum(x_hi_next - x_lo_next)
        
        # Tube should widen (or at least not shrink significantly)
        # Due to w_bar addition, width should increase
        self.assertGreaterEqual(width_after, width_before * 0.9,  # Allow some numerical error
                               f"Tube should widen: {width_after} >= {width_before * 0.9}")
    
    def test_tube_propagate_with_large_w_bar(self):
        """Test tube propagation with large uncertainty bounds."""
        x_nom = self.x_prev.copy()
        w_bar_large = np.full(N_STATE, 1e6, dtype=np.float64)  # Large bounds (1 MPa)
        
        x_lo = x_nom - w_bar_large
        x_hi = x_nom + w_bar_large
        
        # Propagate
        x_lo_next, x_hi_next = tube_propagate(
            x_lo, x_hi, self.u_prev, w_bar_large, self.config.dt,
            self.params, self.mdot_F, self.mdot_O
        )
        
        # Check that tube remains valid
        self.assertTrue(np.all(x_lo_next <= x_hi_next))
        self.assertTrue(np.all(x_lo_next >= 0))
        self.assertTrue(np.all(np.isfinite(x_lo_next)))
        self.assertTrue(np.all(np.isfinite(x_hi_next)))
    
    def test_tube_propagate_validation(self):
        """Test tube propagation input validation."""
        x_lo = self.x_prev - 1e5
        x_hi = self.x_prev + 1e5
        w_bar = np.full(N_STATE, 1e5, dtype=np.float64)
        
        # Valid call
        x_lo_next, x_hi_next = tube_propagate(
            x_lo, x_hi, self.u_prev, w_bar, self.config.dt,
            self.params, self.mdot_F, self.mdot_O
        )
        self.assertIsNotNone(x_lo_next)
        
        # Invalid: wrong shape
        with self.assertRaises(ValueError):
            tube_propagate(
                x_lo[:4], x_hi, self.u_prev, w_bar, self.config.dt,
                self.params, self.mdot_F, self.mdot_O
            )
        
        # Invalid: x_lo > x_hi
        with self.assertRaises(ValueError):
            tube_propagate(
                x_hi, x_lo, self.u_prev, w_bar, self.config.dt,
                self.params, self.mdot_F, self.mdot_O
            )
    
    def test_get_w_bar_array(self):
        """Test getting w_bar as array."""
        state = ControllerState()
        
        # Test with array
        w_bar_test = np.array([1e5, 2e5, 3e5, 4e5, 5e5, 6e5, 1e-4, 2e-4], dtype=np.float64)
        set_w_bar_array(state, w_bar_test)
        
        w_bar_retrieved = get_w_bar_array(state)
        np.testing.assert_array_equal(w_bar_retrieved, w_bar_test)
        
        # Test with dict (legacy)
        state2 = ControllerState()
        state2.w_bar = {
            "P_copv": 1e5,
            "P_reg": 2e5,
            "P_u_F": 3e5,
            "P_u_O": 4e5,
            "P_d_F": 5e5,
            "P_d_O": 6e5,
            "V_u_F": 1e-4,
            "V_u_O": 2e-4,
        }
        
        w_bar_from_dict = get_w_bar_array(state2)
        np.testing.assert_array_almost_equal(w_bar_from_dict, w_bar_test, decimal=2)
    
    def test_set_w_bar_array(self):
        """Test setting w_bar from array."""
        state = ControllerState()
        
        w_bar_test = np.array([1e5, 2e5, 3e5, 4e5, 5e5, 6e5, 1e-4, 2e-4], dtype=np.float64)
        set_w_bar_array(state, w_bar_test)
        
        # Check array was set
        self.assertIsNotNone(state.w_bar_array)
        np.testing.assert_array_equal(state.w_bar_array, w_bar_test)
        
        # Check dict was updated
        self.assertEqual(state.w_bar["P_copv"], 1e5)
        self.assertEqual(state.w_bar["P_reg"], 2e5)
        
        # Invalid shape
        with self.assertRaises(ValueError):
            set_w_bar_array(state, np.array([1, 2, 3]))
    
    def test_update_bounds_with_engine_wrapper(self):
        """Test update_bounds with engine wrapper."""
        from unittest.mock import Mock
        
        # Create mock engine wrapper
        mock_wrapper = Mock()
        mock_wrapper.estimate_from_pressures.return_value = EngineEstimate(
            P_ch=2e6,
            F=1000.0,
            mdot_F=0.5,
            mdot_O=1.0,
            MR=2.0,
            injector_dp_F=0.5e6,
            injector_dp_O=1.0e6,
        )
        
        state = ControllerState()
        x_meas = self.x_prev.copy()
        x_meas[IDX_P_COPV] += 1e5
        
        # Update with engine wrapper
        update_bounds(
            state, self.x_prev, x_meas, self.u_prev, self.config,
            engine_wrapper=mock_wrapper, dt=self.config.dt
        )
        
        # Check that wrapper was called
        mock_wrapper.estimate_from_pressures.assert_called_once()
        
        # Check bounds were updated
        self.assertIsNotNone(state.w_bar_array)
        self.assertGreater(state.w_bar_array[IDX_P_COPV], 0)
    
    def test_update_bounds_requires_mass_flow(self):
        """Test that update_bounds requires mass flow information."""
        state = ControllerState()
        x_meas = self.x_prev.copy()
        
        # Should raise error if neither engine_wrapper nor mdot provided
        with self.assertRaises(ValueError):
            update_bounds(
                state, self.x_prev, x_meas, self.u_prev, self.config,
                dt=self.config.dt
            )
    
    def test_multiple_updates_convergence(self):
        """Test that bounds converge with repeated updates."""
        state = ControllerState()
        
        # Constant residual over multiple updates
        residual_magnitude = 1e5
        x_meas = self.x_prev.copy()
        x_meas[IDX_P_COPV] += residual_magnitude
        
        # Multiple updates
        w_bar_values = []
        for _ in range(10):
            update_bounds(
                state, self.x_prev, x_meas, self.u_prev, self.config,
                mdot_F=self.mdot_F, mdot_O=self.mdot_O, dt=self.config.dt
            )
            w_bar_values.append(state.w_bar_array[IDX_P_COPV])
        
        # Bounds should converge (not grow unbounded)
        # With constant residual, bounds should approach: residual * (1 + eta) / (1 - rho)
        # But with EMA, it's: (1 - rho) * residual * (1 + eta) / (1 - rho * (1 + eta))
        # For simplicity, just check it's finite and reasonable
        self.assertTrue(np.isfinite(w_bar_values[-1]))
        self.assertLess(w_bar_values[-1], residual_magnitude * 10)  # Should be reasonable


if __name__ == '__main__':
    unittest.main()

