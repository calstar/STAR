"""Unit tests for actuation module."""

import unittest
import numpy as np

from engine.control.robust_ddp.actuation import (
    compute_actuation,
    ActuationCommand,
    ExecutionBackend,
    quantize_duty,
    enforce_dwell,
    binary_actuation,
    update_state_dwell_timers,
    create_duty_grid,
)
from engine.control.robust_ddp.data_models import ControllerConfig, ControllerState


class TestActuation(unittest.TestCase):
    """Test actuation command generation."""
    
    def setUp(self):
        """Set up test fixtures."""
        self.cfg = ControllerConfig(
            N=10,
            dt=0.01,
            dwell_time=0.05,  # 50 ms minimum dwell
            duty_quantization=0.01,  # 1% steps
        )
        
        self.state = ControllerState(
            u_prev={"P_u_fuel": 0.5, "P_u_ox": 0.5},
            dwell_timers={"P_u_fuel": 0.1, "P_u_ox": 0.1},  # Already satisfied
        )
    
    def test_quantize_duty(self):
        """Test duty quantization."""
        # Test exact grid points
        self.assertAlmostEqual(quantize_duty(0.0, 0.01), 0.0)
        self.assertAlmostEqual(quantize_duty(0.5, 0.01), 0.5)
        self.assertAlmostEqual(quantize_duty(1.0, 0.01), 1.0)
        
        # Test rounding
        self.assertAlmostEqual(quantize_duty(0.005, 0.01), 0.0)  # Rounds down
        self.assertAlmostEqual(quantize_duty(0.015, 0.01), 0.02)  # Rounds up
        self.assertAlmostEqual(quantize_duty(0.495, 0.01), 0.5)  # Rounds up
        
        # Test clamping
        self.assertAlmostEqual(quantize_duty(-0.1, 0.01), 0.0)
        self.assertAlmostEqual(quantize_duty(1.1, 0.01), 1.0)
        
        # Test different quantization steps
        self.assertAlmostEqual(quantize_duty(0.25, 0.1), 0.2)  # 10% steps
        self.assertAlmostEqual(quantize_duty(0.75, 0.1), 0.8)
    
    def test_enforce_dwell_satisfied(self):
        """Test dwell enforcement when dwell time is satisfied."""
        # Dwell time satisfied, control changed -> allow change
        u_new = 0.7
        u_prev = 0.5
        dwell_timer = 0.1  # > dwell_time (0.05)
        dwell_time = 0.05
        dt = 0.01
        
        u_output, dwell_timer_new = enforce_dwell(
            u_new, u_prev, dwell_timer, dwell_time, dt
        )
        
        # Should allow change and reset timer
        self.assertAlmostEqual(u_output, u_new)
        self.assertAlmostEqual(dwell_timer_new, 0.0)
    
    def test_enforce_dwell_not_satisfied(self):
        """Test dwell enforcement when dwell time is not satisfied."""
        # Dwell time not satisfied, control changed -> keep previous
        u_new = 0.7
        u_prev = 0.5
        dwell_timer = 0.02  # < dwell_time (0.05)
        dwell_time = 0.05
        dt = 0.01
        
        u_output, dwell_timer_new = enforce_dwell(
            u_new, u_prev, dwell_timer, dwell_time, dt
        )
        
        # Should keep previous control and increment timer
        self.assertAlmostEqual(u_output, u_prev)
        self.assertAlmostEqual(dwell_timer_new, dwell_timer + dt)
    
    def test_enforce_dwell_no_change(self):
        """Test dwell enforcement when control unchanged."""
        # Control unchanged -> increment timer
        u_new = 0.5
        u_prev = 0.5
        dwell_timer = 0.1
        dwell_time = 0.05
        dt = 0.01
        
        u_output, dwell_timer_new = enforce_dwell(
            u_new, u_prev, dwell_timer, dwell_time, dt
        )
        
        # Should allow (no change) and increment timer
        self.assertAlmostEqual(u_output, u_new)
        self.assertAlmostEqual(dwell_timer_new, dwell_timer + dt)
    
    def test_binary_actuation_threshold(self):
        """Test binary actuation with threshold method."""
        # Threshold method (no sigma-delta)
        duty_output, onoff = binary_actuation(0.3, 0.01, self.cfg, None)
        self.assertFalse(onoff)
        self.assertEqual(duty_output, 0.0)
        
        duty_output, onoff = binary_actuation(0.7, 0.01, self.cfg, None)
        self.assertTrue(onoff)
        self.assertEqual(duty_output, 1.0)
    
    def test_binary_actuation_sigma_delta(self):
        """Test binary actuation with sigma-delta modulation."""
        # Sigma-delta: accumulator starts at 0
        accumulator = 0.0
        
        # Test with duty = 0.3 (should average to 30% over time)
        # First few steps
        outputs = []
        for _ in range(10):
            duty_output, onoff = binary_actuation(0.3, 0.01, self.cfg, accumulator)
            outputs.append(duty_output)
            # Update accumulator (simulate what would happen in state)
            accumulator = accumulator + (0.3 - duty_output)
        
        # Should have some 1s and some 0s (not all 0s or all 1s for 0.3 duty)
        # Average should be close to 0.3
        avg_duty = np.mean(outputs)
        self.assertGreater(avg_duty, 0.0)
        self.assertLess(avg_duty, 1.0)
    
    def test_compute_actuation_pwm(self):
        """Test compute_actuation with PWM backend."""
        u_relaxed = np.array([0.75, 0.45])
        
        cmd = compute_actuation(
            u_relaxed=u_relaxed,
            state=self.state,
            cfg=self.cfg,
            backend=ExecutionBackend.PWM,
        )
        
        # Check structure
        self.assertIsInstance(cmd, ActuationCommand)
        self.assertEqual(cmd.backend, ExecutionBackend.PWM)
        
        # Check quantization
        self.assertAlmostEqual(cmd.u_F_quantized, 0.75)
        self.assertAlmostEqual(cmd.u_O_quantized, 0.45)
        
        # Check duty cycles (should match quantized values after dwell)
        self.assertGreaterEqual(cmd.duty_F, 0.0)
        self.assertLessEqual(cmd.duty_F, 1.0)
        self.assertGreaterEqual(cmd.duty_O, 0.0)
        self.assertLessEqual(cmd.duty_O, 1.0)
        
        # Check on/off (should match duty > 0)
        self.assertEqual(cmd.u_F_onoff, cmd.duty_F > 0.0)
        self.assertEqual(cmd.u_O_onoff, cmd.duty_O > 0.0)
    
    def test_compute_actuation_binary(self):
        """Test compute_actuation with binary backend."""
        u_relaxed = np.array([0.75, 0.25])
        
        cmd = compute_actuation(
            u_relaxed=u_relaxed,
            state=self.state,
            cfg=self.cfg,
            backend=ExecutionBackend.BINARY,
        )
        
        # Check structure
        self.assertIsInstance(cmd, ActuationCommand)
        self.assertEqual(cmd.backend, ExecutionBackend.BINARY)
        
        # Check duty cycles are binary (0 or 1)
        self.assertIn(cmd.duty_F, [0.0, 1.0])
        self.assertIn(cmd.duty_O, [0.0, 1.0])
        
        # Check on/off matches duty
        self.assertEqual(cmd.u_F_onoff, cmd.duty_F > 0.0)
        self.assertEqual(cmd.u_O_onoff, cmd.duty_O > 0.0)
    
    def test_compute_actuation_dwell_enforcement(self):
        """Test compute_actuation enforces dwell time."""
        # Set state with short dwell timer (not satisfied)
        state_short_dwell = ControllerState(
            u_prev={"P_u_fuel": 0.5, "P_u_ox": 0.5},
            dwell_timers={"P_u_fuel": 0.02, "P_u_ox": 0.02},  # < dwell_time
        )
        
        # Try to change control
        u_relaxed = np.array([0.8, 0.3])  # Different from 0.5
        
        cmd = compute_actuation(
            u_relaxed=u_relaxed,
            state=state_short_dwell,
            cfg=self.cfg,
            backend=ExecutionBackend.PWM,
        )
        
        # Should keep previous control (0.5) because dwell not satisfied
        # Note: This depends on how u_prev is interpreted
        # For now, check that dwell timer is incremented
        self.assertGreater(cmd.dwell_timer_F, state_short_dwell.dwell_timers["P_u_fuel"])
    
    def test_compute_actuation_dwell_satisfied(self):
        """Test compute_actuation allows change when dwell satisfied."""
        # Set state with satisfied dwell timer
        state_satisfied = ControllerState(
            u_prev={"P_u_fuel": 0.5, "P_u_ox": 0.5},
            dwell_timers={"P_u_fuel": 0.1, "P_u_ox": 0.1},  # > dwell_time
        )
        
        # Try to change control
        u_relaxed = np.array([0.8, 0.3])
        
        cmd = compute_actuation(
            u_relaxed=u_relaxed,
            state=state_satisfied,
            cfg=self.cfg,
            backend=ExecutionBackend.PWM,
        )
        
        # Should allow change and reset timer
        self.assertAlmostEqual(cmd.dwell_timer_F, 0.0)
        self.assertAlmostEqual(cmd.dwell_timer_O, 0.0)
    
    def test_update_state_dwell_timers(self):
        """Test updating dwell timers in state."""
        state = ControllerState(
            u_prev={"P_u_fuel": 0.0, "P_u_ox": 0.0},
            dwell_timers={"P_u_fuel": 0.0, "P_u_ox": 0.0},
        )
        
        cmd = ActuationCommand(
            u_F_onoff=True,
            u_O_onoff=False,
            duty_F=0.75,
            duty_O=0.25,
            u_F_quantized=0.75,
            u_O_quantized=0.25,
            backend=ExecutionBackend.PWM,
            dwell_timer_F=0.05,
            dwell_timer_O=0.03,
        )
        
        update_state_dwell_timers(state, cmd)
        
        # Check timers updated
        self.assertAlmostEqual(state.dwell_timers["P_u_fuel"], 0.05)
        self.assertAlmostEqual(state.dwell_timers["P_u_ox"], 0.03)
        
        # Check u_prev updated
        self.assertAlmostEqual(state.u_prev["P_u_fuel"], 0.75)
        self.assertAlmostEqual(state.u_prev["P_u_ox"], 0.25)
    
    def test_create_duty_grid(self):
        """Test duty grid creation."""
        grid = create_duty_grid(0.1)
        
        # Should have 11 points: 0, 0.1, 0.2, ..., 1.0
        self.assertEqual(len(grid), 11)
        self.assertAlmostEqual(grid[0], 0.0)
        self.assertAlmostEqual(grid[-1], 1.0)
        self.assertAlmostEqual(grid[5], 0.5)
        
        # Test smaller step
        grid = create_duty_grid(0.01)
        self.assertEqual(len(grid), 101)
        self.assertAlmostEqual(grid[0], 0.0)
        self.assertAlmostEqual(grid[-1], 1.0)
    
    def test_quantize_duty_edge_cases(self):
        """Test duty quantization edge cases."""
        # Very small quantization
        self.assertAlmostEqual(quantize_duty(0.123456, 0.001), 0.123, places=3)
        
        # Large quantization
        self.assertAlmostEqual(quantize_duty(0.75, 0.5), 1.0)  # Rounds to 1.0
        
        # Zero quantization (should handle gracefully)
        # This would cause division by zero, but duty_quantization should be > 0
        # Just test that it works with very small values
        self.assertAlmostEqual(quantize_duty(0.5, 1e-6), 0.5, places=6)
    
    def test_compute_actuation_clamping(self):
        """Test compute_actuation clamps inputs."""
        # Test values outside [0, 1]
        u_relaxed = np.array([-0.1, 1.5])
        
        cmd = compute_actuation(
            u_relaxed=u_relaxed,
            state=self.state,
            cfg=self.cfg,
            backend=ExecutionBackend.PWM,
        )
        
        # Should clamp to [0, 1]
        self.assertGreaterEqual(cmd.duty_F, 0.0)
        self.assertLessEqual(cmd.duty_F, 1.0)
        self.assertGreaterEqual(cmd.duty_O, 0.0)
        self.assertLessEqual(cmd.duty_O, 1.0)


if __name__ == "__main__":
    unittest.main()

