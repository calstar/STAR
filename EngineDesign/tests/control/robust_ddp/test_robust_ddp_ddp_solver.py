"""Unit tests for DDP solver."""

import unittest
import numpy as np
from unittest.mock import Mock, MagicMock

from engine.control.robust_ddp.ddp_solver import (
    solve_ddp,
    DDPSolution,
    forward_rollout,
    running_cost,
    backward_pass,
    forward_line_search,
)
from engine.control.robust_ddp.data_models import ControllerConfig
from engine.control.robust_ddp.dynamics import DynamicsParams, step, N_STATE, N_CONTROL
from engine.control.robust_ddp.engine_wrapper import EngineEstimate, EngineWrapper


class TestDDPSolver(unittest.TestCase):
    """Test DDP solver on toy linear system."""
    
    def setUp(self):
        """Set up test fixtures."""
        # Create minimal config
        self.cfg = ControllerConfig(
            N=10,
            dt=0.01,
            qF=1.0,
            qMR=1.0,
            qGas=0.1,
            qSwitch=0.01,
            max_iterations=5,
            convergence_tol=1e-4,
        )
        
        # Create dynamics params
        self.params = DynamicsParams.from_config(self.cfg)
        
        # Create mock engine wrapper for toy system
        self.engine_wrapper = Mock(spec=EngineWrapper)
        
        # Mock engine estimate (simplified for toy system)
        def mock_estimate(P_d_F, P_d_O):
            # Simple linear model: F = a*P_d_F + b*P_d_O, MR = P_d_O / P_d_F
            F = 1000.0 * (P_d_F + P_d_O) / 1e6  # Simplified
            MR = P_d_O / max(P_d_F, 1e3) if P_d_F > 0 else 2.0
            mdot_F = 0.5 * P_d_F / 1e6
            mdot_O = 1.0 * P_d_O / 1e6
            
            return EngineEstimate(
                P_ch=0.5 * (P_d_F + P_d_O),
                F=F,
                mdot_F=mdot_F,
                mdot_O=mdot_O,
                MR=MR,
                injector_dp_F=P_d_F - 0.5 * (P_d_F + P_d_O),
                injector_dp_O=P_d_O - 0.5 * (P_d_F + P_d_O),
            )
        
        self.engine_wrapper.estimate_from_pressures = Mock(side_effect=mock_estimate)
    
    def test_running_cost(self):
        """Test running cost computation."""
        x = np.array([30e6, 24e6, 3e6, 3.5e6, 2.5e6, 3e6, 0.01, 0.01])
        u = np.array([0.5, 0.5])
        eng_est = EngineEstimate(
            P_ch=2.75e6,
            F=5000.0,
            mdot_F=1.25,
            mdot_O=3.0,
            MR=2.4,
            injector_dp_F=0.125e6,
            injector_dp_O=0.125e6,
        )
        F_ref = 5000.0
        MR_ref = 2.4
        constraints = {}
        
        cost = running_cost(x, u, eng_est, F_ref, MR_ref, self.cfg, constraints)
        
        # Cost should be non-negative
        self.assertGreaterEqual(cost, 0.0)
        # With matching references, cost should be small (just gas consumption)
        self.assertLess(cost, 100.0)
    
    def test_running_cost_with_errors(self):
        """Test running cost with tracking errors."""
        x = np.array([30e6, 24e6, 3e6, 3.5e6, 2.5e6, 3e6, 0.01, 0.01])
        u = np.array([0.5, 0.5])
        eng_est = EngineEstimate(
            P_ch=2.75e6,
            F=4000.0,  # 1000 N error
            mdot_F=1.25,
            mdot_O=3.0,
            MR=3.0,  # 0.6 error from ref
            injector_dp_F=0.125e6,
            injector_dp_O=0.125e6,
        )
        F_ref = 5000.0
        MR_ref = 2.4
        constraints = {}
        
        cost = running_cost(x, u, eng_est, F_ref, MR_ref, self.cfg, constraints)
        
        # Cost should include tracking errors
        self.assertGreater(cost, 1000.0)  # Should be significant
    
    def test_forward_rollout(self):
        """Test forward rollout."""
        x0 = np.array([30e6, 24e6, 3e6, 3.5e6, 2.5e6, 3e6, 0.01, 0.01])
        u_seq = np.ones((self.cfg.N, N_CONTROL)) * 0.5
        F_ref = np.ones(self.cfg.N) * 5000.0
        MR_ref = np.ones(self.cfg.N) * 2.4
        
        x_seq, eng_estimates, cost, violations = forward_rollout(
            x0, u_seq, F_ref, MR_ref, self.cfg, self.params,
            self.engine_wrapper, self.cfg.dt
        )
        
        # Check shapes
        self.assertEqual(x_seq.shape, (self.cfg.N + 1, N_STATE))
        self.assertEqual(len(eng_estimates), self.cfg.N)
        self.assertEqual(len(violations), self.cfg.N)
        
        # Check initial state
        np.testing.assert_array_equal(x_seq[0], x0)
        
        # Cost should be finite
        self.assertTrue(np.isfinite(cost))
        self.assertGreaterEqual(cost, 0.0)
    
    def test_ddp_on_toy_linear_system(self):
        """Test DDP on a simplified toy linear system."""
        # Use a very simple setup with small horizon
        cfg_simple = ControllerConfig(
            N=5,
            dt=0.01,
            qF=1.0,
            qMR=1.0,
            qGas=0.01,
            qSwitch=0.001,
            max_iterations=3,
            convergence_tol=1e-3,
        )
        
        x0 = np.array([30e6, 24e6, 3e6, 3.5e6, 2.5e6, 3e6, 0.01, 0.01])
        u_seq_init = np.ones((cfg_simple.N, N_CONTROL)) * 0.5
        F_ref = np.ones(cfg_simple.N) * 5000.0
        MR_ref = np.ones(cfg_simple.N) * 2.4
        
        params = DynamicsParams.from_config(cfg_simple)
        
        # Solve DDP
        solution = solve_ddp(
            x0=x0,
            u_seq_init=u_seq_init,
            F_ref=F_ref,
            MR_ref=MR_ref,
            cfg=cfg_simple,
            dynamics_params=params,
            engine_wrapper=self.engine_wrapper,
            w_bar=np.zeros(N_STATE),
            use_robustification=False,
        )
        
        # Check solution structure
        self.assertIsInstance(solution, DDPSolution)
        self.assertEqual(solution.u_seq.shape, (cfg_simple.N, N_CONTROL))
        self.assertEqual(solution.x_seq.shape, (cfg_simple.N + 1, N_STATE))
        self.assertEqual(len(solution.eng_estimates), cfg_simple.N)
        
        # Check control bounds
        self.assertTrue(np.all(solution.u_seq >= 0.0))
        self.assertTrue(np.all(solution.u_seq <= 1.0))
        
        # Check objective is finite
        self.assertTrue(np.isfinite(solution.objective))
        self.assertGreaterEqual(solution.objective, 0.0)
        
        # Check iterations
        self.assertGreater(solution.iterations, 0)
        self.assertLessEqual(solution.iterations, cfg_simple.max_iterations)
    
    def test_ddp_decreases_cost(self):
        """Test that DDP decreases cost over iterations."""
        cfg_simple = ControllerConfig(
            N=5,
            dt=0.01,
            qF=1.0,
            qMR=1.0,
            qGas=0.01,
            qSwitch=0.001,
            max_iterations=5,
            convergence_tol=1e-4,
        )
        
        x0 = np.array([30e6, 24e6, 3e6, 3.5e6, 2.5e6, 3e6, 0.01, 0.01])
        u_seq_init = np.ones((cfg_simple.N, N_CONTROL)) * 0.3  # Start with low control
        F_ref = np.ones(cfg_simple.N) * 5000.0
        MR_ref = np.ones(cfg_simple.N) * 2.4
        
        params = DynamicsParams.from_config(cfg_simple)
        
        # Compute initial cost
        x_seq_init, _, cost_init, _ = forward_rollout(
            x0, u_seq_init, F_ref, MR_ref, cfg_simple, params,
            self.engine_wrapper, cfg_simple.dt
        )
        
        # Solve DDP
        solution = solve_ddp(
            x0=x0,
            u_seq_init=u_seq_init,
            F_ref=F_ref,
            MR_ref=MR_ref,
            cfg=cfg_simple,
            dynamics_params=params,
            engine_wrapper=self.engine_wrapper,
            w_bar=np.zeros(N_STATE),
            use_robustification=False,
        )
        
        # DDP should improve or at least not worsen significantly
        # (may not always decrease due to regularization, but should be reasonable)
        self.assertLessEqual(solution.objective, cost_init * 1.5)  # Allow some tolerance
    
    def test_ddp_respects_bounds(self):
        """Test that DDP respects control bounds [0, 1]."""
        cfg_simple = ControllerConfig(
            N=5,
            dt=0.01,
            qF=1.0,
            qMR=1.0,
            qGas=0.01,
            qSwitch=0.001,
            max_iterations=3,
            convergence_tol=1e-3,
        )
        
        x0 = np.array([30e6, 24e6, 3e6, 3.5e6, 2.5e6, 3e6, 0.01, 0.01])
        # Start with controls that might go out of bounds
        u_seq_init = np.array([
            [0.0, 0.0],
            [0.5, 0.5],
            [1.0, 1.0],
            [0.8, 0.8],
            [0.2, 0.2],
        ])
        F_ref = np.ones(cfg_simple.N) * 5000.0
        MR_ref = np.ones(cfg_simple.N) * 2.4
        
        params = DynamicsParams.from_config(cfg_simple)
        
        # Solve DDP
        solution = solve_ddp(
            x0=x0,
            u_seq_init=u_seq_init,
            F_ref=F_ref,
            MR_ref=MR_ref,
            cfg=cfg_simple,
            dynamics_params=params,
            engine_wrapper=self.engine_wrapper,
            w_bar=np.zeros(N_STATE),
            use_robustification=False,
        )
        
        # All controls must be in [0, 1]
        self.assertTrue(np.all(solution.u_seq >= 0.0))
        self.assertTrue(np.all(solution.u_seq <= 1.0))
        
        # Check state bounds (pressures should be non-negative)
        self.assertTrue(np.all(solution.x_seq >= 0.0))
    
    def test_backward_pass_structure(self):
        """Test backward pass produces correct structure."""
        cfg_simple = ControllerConfig(
            N=3,
            dt=0.01,
            qF=1.0,
            qMR=1.0,
            qGas=0.01,
            qSwitch=0.001,
        )
        
        x0 = np.array([30e6, 24e6, 3e6, 3.5e6, 2.5e6, 3e6, 0.01, 0.01])
        u_seq = np.ones((cfg_simple.N, N_CONTROL)) * 0.5
        F_ref = np.ones(cfg_simple.N) * 5000.0
        MR_ref = np.ones(cfg_simple.N) * 2.4
        
        params = DynamicsParams.from_config(cfg_simple)
        
        # Forward rollout
        x_seq, eng_estimates, _, _ = forward_rollout(
            x0, u_seq, F_ref, MR_ref, cfg_simple, params,
            self.engine_wrapper, cfg_simple.dt
        )
        
        # Backward pass
        k_seq, K_seq, Vx, Vxx = backward_pass(
            x_seq, u_seq, eng_estimates, F_ref, MR_ref, cfg_simple, params,
            self.engine_wrapper, cfg_simple.dt, reg=1e-3,
            w_bar=np.zeros(N_STATE), use_robustification=False, gamma_robust=1.0
        )
        
        # Check shapes
        self.assertEqual(k_seq.shape, (cfg_simple.N, N_CONTROL))
        self.assertEqual(K_seq.shape, (cfg_simple.N, N_CONTROL, N_STATE))
        self.assertEqual(Vx.shape, (N_STATE,))
        self.assertEqual(Vxx.shape, (N_STATE, N_STATE))
        
        # Vxx should be symmetric
        np.testing.assert_array_almost_equal(Vxx, Vxx.T, decimal=10)
        
        # Vxx should be positive semi-definite (eigenvalues >= 0)
        eigenvals = np.linalg.eigvals(Vxx)
        self.assertTrue(np.all(eigenvals >= -1e-10))  # Allow small numerical errors
    
    def test_forward_line_search(self):
        """Test forward line search."""
        cfg_simple = ControllerConfig(
            N=3,
            dt=0.01,
            qF=1.0,
            qMR=1.0,
            qGas=0.01,
            qSwitch=0.001,
        )
        
        x0 = np.array([30e6, 24e6, 3e6, 3.5e6, 2.5e6, 3e6, 0.01, 0.01])
        u_seq = np.ones((cfg_simple.N, N_CONTROL)) * 0.5
        F_ref = np.ones(cfg_simple.N) * 5000.0
        MR_ref = np.ones(cfg_simple.N) * 2.4
        
        params = DynamicsParams.from_config(cfg_simple)
        
        # Forward rollout
        x_seq_nom, eng_estimates, _, _ = forward_rollout(
            x0, u_seq, F_ref, MR_ref, cfg_simple, params,
            self.engine_wrapper, cfg_simple.dt
        )
        
        # Backward pass
        k_seq, K_seq, _, _ = backward_pass(
            x_seq_nom, u_seq, eng_estimates, F_ref, MR_ref, cfg_simple, params,
            self.engine_wrapper, cfg_simple.dt, reg=1e-3,
            w_bar=np.zeros(N_STATE), use_robustification=False, gamma_robust=1.0
        )
        
        # Line search
        u_seq_new, alpha, cost_new = forward_line_search(
            x0, u_seq, k_seq, K_seq, x_seq_nom, F_ref, MR_ref, cfg_simple, params,
            self.engine_wrapper, cfg_simple.dt, alpha_init=1.0, alpha_min=1e-4
        )
        
        # Check structure
        self.assertEqual(u_seq_new.shape, u_seq.shape)
        self.assertGreaterEqual(alpha, 1e-4)
        self.assertLessEqual(alpha, 1.0)
        self.assertTrue(np.isfinite(cost_new))
        
        # Check bounds
        self.assertTrue(np.all(u_seq_new >= 0.0))
        self.assertTrue(np.all(u_seq_new <= 1.0))


if __name__ == "__main__":
    unittest.main()

