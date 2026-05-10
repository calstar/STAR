"""Unit tests for safety filter module."""

import unittest
import numpy as np
from unittest.mock import Mock

from engine.control.robust_ddp.safety_filter import (
    filter_action,
    _is_action_safe,
    _tube_violates_constraints,
    _find_best_safe_action,
    _generate_action_candidates,
    _compute_action_cost,
)
from engine.control.robust_ddp.data_models import ControllerConfig, ControllerState
from engine.control.robust_ddp.engine_wrapper import EngineEstimate, EngineWrapper
from engine.control.robust_ddp.dynamics import IDX_P_U_F, IDX_P_U_O, IDX_P_COPV


class TestSafetyFilter(unittest.TestCase):
    """Test safety filter."""
    
    def setUp(self):
        """Set up test fixtures."""
        self.cfg = ControllerConfig(
            N=10,
            dt=0.01,
            P_u_max=10e6,  # 10 MPa max ullage pressure
            P_copv_min=1e6,  # 1 MPa min COPV pressure
            MR_min=1.5,
            MR_max=3.0,
            injector_dp_frac=0.1,
            qF=1.0,
            qMR=10.0,
            qGas=0.1,
        )
        
        # Normal state
        self.x_normal = np.array([
            30e6,  # P_copv
            24e6,  # P_reg
            3e6,   # P_u_F
            3.5e6, # P_u_O
            2.5e6, # P_d_F
            3e6,   # P_d_O
            0.01,  # V_u_F
            0.01,  # V_u_O
        ])
        
        # State with high ullage pressure (near limit)
        self.x_high_ullage = self.x_normal.copy()
        self.x_high_ullage[IDX_P_U_F] = 9.5e6  # Near P_u_max
        
        # State with low COPV pressure
        self.x_low_copv = self.x_normal.copy()
        self.x_low_copv[IDX_P_COPV] = 1.5e6  # Near P_copv_min
        
        self.state = ControllerState(
            w_bar_array=np.ones(8) * 0.1e6,  # 0.1 MPa uncertainty per component
        )
        
        # Mock engine wrapper
        self.engine_wrapper = Mock(spec=EngineWrapper)
    
    def test_tube_violates_constraints_ullage_max(self):
        """Test tube constraint violation for ullage max."""
        # Create tube that violates ullage max
        x_lo = self.x_normal.copy()
        x_hi = self.x_normal.copy()
        x_hi[IDX_P_U_F] = 11e6  # Exceeds P_u_max (10e6)
        
        violates = _tube_violates_constraints(x_lo, x_hi, self.cfg, None)
        self.assertTrue(violates)
    
    def test_tube_violates_constraints_copv_min(self):
        """Test tube constraint violation for COPV min."""
        # Create tube that violates COPV min
        x_lo = self.x_normal.copy()
        x_hi = self.x_normal.copy()
        x_hi[IDX_P_COPV] = 0.5e6  # Below P_copv_min (1e6)
        
        violates = _tube_violates_constraints(x_lo, x_hi, self.cfg, None)
        self.assertTrue(violates)
    
    def test_tube_violates_constraints_mr(self):
        """Test tube constraint violation for MR bounds."""
        # Create engine estimate with MR violation
        eng_est = EngineEstimate(
            P_ch=2.5e6,
            F=5000.0,
            mdot_F=1.0,
            mdot_O=5.0,  # MR = 5.0 > MR_max (3.0)
            MR=5.0,
            injector_dp_F=0.5e6,
            injector_dp_O=0.5e6,
        )
        self.engine_wrapper.estimate_from_pressures = Mock(return_value=eng_est)
        
        x_lo = self.x_normal.copy()
        x_hi = self.x_normal.copy()
        
        violates = _tube_violates_constraints(x_lo, x_hi, self.cfg, self.engine_wrapper)
        self.assertTrue(violates)
    
    def test_tube_violates_constraints_safe(self):
        """Test tube that satisfies all constraints."""
        x_lo = self.x_normal.copy()
        x_hi = self.x_normal.copy()
        
        # Normal engine estimate
        eng_est = EngineEstimate(
            P_ch=2.5e6,
            F=5000.0,
            mdot_F=1.0,
            mdot_O=2.0,  # MR = 2.0 (within bounds)
            MR=2.0,
            injector_dp_F=0.5e6,
            injector_dp_O=0.5e6,
        )
        self.engine_wrapper.estimate_from_pressures = Mock(return_value=eng_est)
        
        violates = _tube_violates_constraints(x_lo, x_hi, self.cfg, self.engine_wrapper)
        self.assertFalse(violates)
    
    def test_generate_action_candidates(self):
        """Test action candidate generation."""
        candidates = _generate_action_candidates(self.cfg)
        
        # Should have at least binary candidates
        self.assertGreaterEqual(len(candidates), 4)
        
        # Check binary candidates are present
        binary_set = {
            (0.0, 0.0),
            (0.0, 1.0),
            (1.0, 0.0),
            (1.0, 1.0),
        }
        candidate_set = {tuple(c) for c in candidates}
        self.assertTrue(binary_set.issubset(candidate_set))
    
    def test_compute_action_cost(self):
        """Test action cost computation."""
        u = np.array([0.5, 0.5])
        
        # Cost without references
        cost = _compute_action_cost(
            self.x_normal, u, self.cfg, None, None, None
        )
        self.assertGreater(cost, 0.0)
        
        # Cost with references
        eng_est = EngineEstimate(
            P_ch=2.5e6,
            F=5000.0,
            mdot_F=1.0,
            mdot_O=2.0,
            MR=2.0,
            injector_dp_F=0.5e6,
            injector_dp_O=0.5e6,
        )
        self.engine_wrapper.estimate_from_pressures = Mock(return_value=eng_est)
        
        cost_with_ref = _compute_action_cost(
            self.x_normal, u, self.cfg, self.engine_wrapper, 5000.0, 2.0
        )
        self.assertGreater(cost_with_ref, cost)  # Should be higher with tracking error
    
    def test_filter_action_safe(self):
        """Test filter_action with safe proposed action."""
        # Proposed action that should be safe
        proposed = np.array([0.5, 0.5])
        
        # Mock engine wrapper for safe tube propagation
        eng_est = EngineEstimate(
            P_ch=2.5e6,
            F=5000.0,
            mdot_F=1.0,
            mdot_O=2.0,
            MR=2.0,
            injector_dp_F=0.5e6,
            injector_dp_O=0.5e6,
        )
        self.engine_wrapper.estimate_from_pressures = Mock(return_value=eng_est)
        
        safe_action = filter_action(
            x=self.x_normal,
            proposed=proposed,
            state=self.state,
            cfg=self.cfg,
            engine_wrapper=self.engine_wrapper,
        )
        
        # Should return same action if safe
        np.testing.assert_array_almost_equal(safe_action, proposed, decimal=3)
    
    def test_filter_action_unsafe_ullage(self):
        """Test filter_action with unsafe action that violates ullage max."""
        # Proposed action that would increase ullage pressure too much
        # Use high control to pressurize (unsafe when already near limit)
        proposed = np.array([1.0, 1.0])  # Full open
        
        # Mock engine wrapper
        eng_est = EngineEstimate(
            P_ch=2.5e6,
            F=5000.0,
            mdot_F=1.0,
            mdot_O=2.0,
            MR=2.0,
            injector_dp_F=0.5e6,
            injector_dp_O=0.5e6,
        )
        self.engine_wrapper.estimate_from_pressures = Mock(return_value=eng_est)
        
        # Use state with high ullage pressure
        safe_action = filter_action(
            x=self.x_high_ullage,
            proposed=proposed,
            state=self.state,
            cfg=self.cfg,
            engine_wrapper=self.engine_wrapper,
            num_steps=1,  # Single step for faster test
        )
        
        # Should return different (safer) action
        # May be zeros or lower control
        self.assertIsNotNone(safe_action)
        self.assertTrue(np.all(safe_action >= 0.0))
        self.assertTrue(np.all(safe_action <= 1.0))
    
    def test_filter_action_unsafe_mr(self):
        """Test filter_action with unsafe action that violates MR bounds."""
        # Proposed action that would cause MR violation
        proposed = np.array([0.1, 1.0])  # Low fuel, high oxidizer -> high MR
        
        # Mock engine wrapper with MR violation
        eng_est_high_mr = EngineEstimate(
            P_ch=2.5e6,
            F=5000.0,
            mdot_F=0.5,
            mdot_O=3.0,  # MR = 6.0 > MR_max (3.0)
            MR=6.0,
            injector_dp_F=0.5e6,
            injector_dp_O=0.5e6,
        )
        
        # For tube propagation, use normal MR
        eng_est_normal = EngineEstimate(
            P_ch=2.5e6,
            F=5000.0,
            mdot_F=1.0,
            mdot_O=2.0,
            MR=2.0,
            injector_dp_F=0.5e6,
            injector_dp_O=0.5e6,
        )
        
        # Return high MR for worst-case check
        def mock_estimate(P_d_F, P_d_O):
            # Use high MR for upper bound check
            if P_d_O > 2.5e6:  # High oxidizer pressure
                return eng_est_high_mr
            return eng_est_normal
        
        self.engine_wrapper.estimate_from_pressures = Mock(side_effect=mock_estimate)
        
        safe_action = filter_action(
            x=self.x_normal,
            proposed=proposed,
            state=self.state,
            cfg=self.cfg,
            engine_wrapper=self.engine_wrapper,
            num_steps=1,
        )
        
        # Should return different (safer) action
        self.assertIsNotNone(safe_action)
        # Should have higher fuel or lower oxidizer to fix MR
        self.assertTrue(safe_action[0] > proposed[0] or safe_action[1] < proposed[1])
    
    def test_filter_action_clamping(self):
        """Test filter_action clamps inputs."""
        # Proposed action outside [0, 1]
        proposed = np.array([-0.1, 1.5])
        
        eng_est = EngineEstimate(
            P_ch=2.5e6,
            F=5000.0,
            mdot_F=1.0,
            mdot_O=2.0,
            MR=2.0,
            injector_dp_F=0.5e6,
            injector_dp_O=0.5e6,
        )
        self.engine_wrapper.estimate_from_pressures = Mock(return_value=eng_est)
        
        safe_action = filter_action(
            x=self.x_normal,
            proposed=proposed,
            state=self.state,
            cfg=self.cfg,
            engine_wrapper=self.engine_wrapper,
        )
        
        # Should be clamped to [0, 1]
        self.assertTrue(np.all(safe_action >= 0.0))
        self.assertTrue(np.all(safe_action <= 1.0))
    
    def test_find_best_safe_action(self):
        """Test finding best safe action from candidates."""
        # Proposed unsafe action
        proposed = np.array([1.0, 1.0])
        
        eng_est = EngineEstimate(
            P_ch=2.5e6,
            F=5000.0,
            mdot_F=1.0,
            mdot_O=2.0,
            MR=2.0,
            injector_dp_F=0.5e6,
            injector_dp_O=0.5e6,
        )
        self.engine_wrapper.estimate_from_pressures = Mock(return_value=eng_est)
        
        w_bar = get_w_bar_array(self.state)
        
        best_action = _find_best_safe_action(
            x=self.x_normal,
            proposed=proposed,
            w_bar=w_bar,
            cfg=self.cfg,
            engine_wrapper=self.engine_wrapper,
            F_ref=5000.0,
            MR_ref=2.0,
            num_steps=1,
            dt=self.cfg.dt,
        )
        
        # Should return a valid action
        self.assertIsNotNone(best_action)
        self.assertEqual(best_action.shape, (2,))
        self.assertTrue(np.all(best_action >= 0.0))
        self.assertTrue(np.all(best_action <= 1.0))


if __name__ == "__main__":
    unittest.main()

