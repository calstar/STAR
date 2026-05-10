"""Unit tests for reference generation module."""

import unittest
import numpy as np
from unittest.mock import Mock

from engine.control.robust_ddp.reference import (
    build_reference,
    Reference,
    _compute_thrust_command,
    _compute_altitude_command,
    _project_thrust,
    _estimate_thrust_bounds,
)
from engine.control.robust_ddp.data_models import (
    NavState,
    Measurement,
    Command,
    CommandType,
    ControllerConfig,
)
from engine.control.robust_ddp.engine_wrapper import EngineEstimate, EngineWrapper


class TestReferenceGeneration(unittest.TestCase):
    """Test reference generation."""
    
    def setUp(self):
        """Set up test fixtures."""
        self.cfg = ControllerConfig(
            N=10,
            dt=0.01,
            MR_min=1.5,
            MR_max=3.0,
            headroom_dp_min=50000.0,
            P_copv_min=1e6,
        )
        
        self.nav = NavState(
            h=100.0,  # 100 m altitude
            vz=10.0,  # 10 m/s upward
            theta=0.0,  # Vertical
            mass_estimate=100.0,  # 100 kg
        )
        
        self.meas = Measurement(
            P_copv=30e6,  # 30 MPa
            P_reg=24e6,  # 24 MPa
            P_u_fuel=3e6,  # 3 MPa
            P_u_ox=3.5e6,  # 3.5 MPa
            P_d_fuel=2.5e6,  # 2.5 MPa
            P_d_ox=3e6,  # 3 MPa
        )
    
    def test_thrust_command_constant(self):
        """Test constant thrust command."""
        cmd = Command(
            command_type=CommandType.THRUST_DESIRED,
            thrust_desired=5000.0,  # 5 kN constant
        )
        
        F_des = _compute_thrust_command(cmd, horizon_N=10, dt=0.01)
        
        # Should be constant
        self.assertEqual(len(F_des), 10)
        np.testing.assert_array_equal(F_des, 5000.0)
    
    def test_thrust_command_piecewise(self):
        """Test piecewise thrust schedule."""
        cmd = Command(
            command_type=CommandType.THRUST_DESIRED,
            thrust_desired=[
                (0.0, 1000.0),  # 1 kN at t=0
                (0.05, 5000.0),  # 5 kN at t=0.05
                (0.1, 3000.0),  # 3 kN at t=0.1
            ],
        )
        
        F_des = _compute_thrust_command(cmd, horizon_N=10, dt=0.01)
        
        # Should interpolate
        self.assertEqual(len(F_des), 10)
        # First value should be 1000
        self.assertAlmostEqual(F_des[0], 1000.0, places=1)
        # Last value should be 3000 (extrapolated)
        self.assertAlmostEqual(F_des[-1], 3000.0, places=1)
    
    def test_altitude_command(self):
        """Test altitude command produces reasonable thrust."""
        cmd = Command(
            command_type=CommandType.ALTITUDE_GOAL,
            altitude_goal=200.0,  # 200 m goal
        )
        
        # Current at 100 m, goal at 200 m -> should increase thrust
        F_des = _compute_altitude_command(
            self.nav, cmd.altitude_goal, horizon_N=10, dt=0.01, cfg=self.cfg
        )
        
        # Should be positive
        self.assertEqual(len(F_des), 10)
        self.assertTrue(np.all(F_des > 0))
        
        # Should be reasonable (hover ~ m*g = 100*9.81 = 981 N)
        # With altitude error, should be higher
        self.assertTrue(np.all(F_des >= 500.0))  # At least 500 N
        self.assertTrue(np.all(F_des <= 1e5))  # Less than 100 kN
    
    def test_altitude_command_below_goal(self):
        """Test altitude command when below goal increases thrust."""
        # Start below goal
        nav_low = NavState(h=50.0, vz=5.0, theta=0.0, mass_estimate=100.0)
        cmd = Command(
            command_type=CommandType.ALTITUDE_GOAL,
            altitude_goal=200.0,
        )
        
        F_des_low = _compute_altitude_command(
            nav_low, cmd.altitude_goal, horizon_N=10, dt=0.01, cfg=self.cfg
        )
        
        # Compare to case at goal
        nav_at_goal = NavState(h=200.0, vz=0.0, theta=0.0, mass_estimate=100.0)
        F_des_at_goal = _compute_altitude_command(
            nav_at_goal, cmd.altitude_goal, horizon_N=10, dt=0.01, cfg=self.cfg
        )
        
        # Below goal should have higher thrust
        self.assertGreater(np.mean(F_des_low), np.mean(F_des_at_goal))
    
    def test_project_thrust_bounds(self):
        """Test thrust projection respects bounds."""
        F_min = 1000.0
        F_max = 10000.0
        F_prev = 5000.0
        dt = 0.01
        
        # Desired above max -> should clamp to max
        F_ref = _project_thrust(15000.0, F_min, F_max, F_prev, dt, self.cfg)
        self.assertAlmostEqual(F_ref, F_max, places=1)
        
        # Desired below min -> should clamp to min
        F_ref = _project_thrust(500.0, F_min, F_max, F_prev, dt, self.cfg)
        self.assertAlmostEqual(F_ref, F_min, places=1)
        
        # Desired in range -> should pass through (if slew allows)
        F_ref = _project_thrust(6000.0, F_min, F_max, F_prev, dt, self.cfg)
        self.assertGreaterEqual(F_ref, F_min)
        self.assertLessEqual(F_ref, F_max)
    
    def test_project_thrust_slew_rate(self):
        """Test thrust projection respects slew rate limit."""
        F_min = 0.0
        F_max = 20000.0
        F_prev = 5000.0
        dt = 0.01
        
        # Set slew rate limit
        self.cfg.thrust_slew_max = 10000.0  # 10 kN/s
        
        # Large step -> should be limited by slew rate
        F_des = 15000.0  # 10 kN step
        F_ref = _project_thrust(F_des, F_min, F_max, F_prev, dt, self.cfg)
        
        # Should be limited: F_prev + dF_max*dt = 5000 + 10000*0.01 = 6000
        max_allowed = F_prev + self.cfg.thrust_slew_max * dt
        self.assertLessEqual(F_ref, max_allowed + 1.0)  # Allow small numerical error
        
        # Small step -> should pass through
        F_des = 5100.0  # 100 N step
        F_ref = _project_thrust(F_des, F_min, F_max, F_prev, dt, self.cfg)
        self.assertAlmostEqual(F_ref, F_des, places=1)
    
    def test_estimate_thrust_bounds(self):
        """Test thrust bounds estimation."""
        state = np.zeros(8)  # Dummy state
        
        # Mock engine estimate
        eng_est = EngineEstimate(
            P_ch=2.5e6,
            F=5000.0,
            mdot_F=1.0,
            mdot_O=2.0,
            MR=2.0,
            injector_dp_F=0.5e6,
            injector_dp_O=0.5e6,
        )
        
        F_min, F_max = _estimate_thrust_bounds(
            state, self.meas, self.cfg, None, eng_est
        )
        
        # Bounds should be valid
        self.assertGreaterEqual(F_min, 0.0)
        self.assertGreater(F_max, F_min)
        
        # F_max should be related to current thrust
        self.assertGreater(F_max, eng_est.F)
    
    def test_build_reference_thrust_mode(self):
        """Test build_reference with thrust command mode."""
        cmd = Command(
            command_type=CommandType.THRUST_DESIRED,
            thrust_desired=5000.0,
        )
        
        # Mock engine wrapper
        engine_wrapper = Mock(spec=EngineWrapper)
        eng_est = EngineEstimate(
            P_ch=2.5e6,
            F=5000.0,
            mdot_F=1.0,
            mdot_O=2.0,
            MR=2.0,
            injector_dp_F=0.5e6,
            injector_dp_O=0.5e6,
        )
        engine_wrapper.estimate_from_pressures = Mock(return_value=eng_est)
        
        ref = build_reference(
            nav=self.nav,
            meas=self.meas,
            cmd=cmd,
            cfg=self.cfg,
            horizon_N=10,
            engine_wrapper=engine_wrapper,
        )
        
        # Check structure
        self.assertIsInstance(ref, Reference)
        self.assertEqual(len(ref.F_ref), 10)
        self.assertEqual(len(ref.MR_ref), 10)
        self.assertEqual(len(ref.F_min), 10)
        self.assertEqual(len(ref.F_max), 10)
        self.assertEqual(len(ref.feasible), 10)
        
        # Check MR_ref is mid-band
        MR_mid = (self.cfg.MR_min + self.cfg.MR_max) / 2.0
        np.testing.assert_array_almost_equal(ref.MR_ref, MR_mid, decimal=2)
        
        # Check bounds
        self.assertTrue(np.all(ref.F_ref >= ref.F_min))
        self.assertTrue(np.all(ref.F_ref <= ref.F_max))
    
    def test_build_reference_altitude_mode(self):
        """Test build_reference with altitude command mode."""
        cmd = Command(
            command_type=CommandType.ALTITUDE_GOAL,
            altitude_goal=200.0,
        )
        
        # Mock engine wrapper
        engine_wrapper = Mock(spec=EngineWrapper)
        eng_est = EngineEstimate(
            P_ch=2.5e6,
            F=5000.0,
            mdot_F=1.0,
            mdot_O=2.0,
            MR=2.0,
            injector_dp_F=0.5e6,
            injector_dp_O=0.5e6,
        )
        engine_wrapper.estimate_from_pressures = Mock(return_value=eng_est)
        
        ref = build_reference(
            nav=self.nav,
            meas=self.meas,
            cmd=cmd,
            cfg=self.cfg,
            horizon_N=10,
            engine_wrapper=engine_wrapper,
        )
        
        # Check structure
        self.assertIsInstance(ref, Reference)
        self.assertEqual(len(ref.F_ref), 10)
        
        # Should produce positive thrust
        self.assertTrue(np.all(ref.F_ref > 0))
        
        # Should respect bounds
        self.assertTrue(np.all(ref.F_ref >= ref.F_min))
        self.assertTrue(np.all(ref.F_ref <= ref.F_max))
    
    def test_build_reference_slew_rate(self):
        """Test build_reference respects slew rate across horizon."""
        cmd = Command(
            command_type=CommandType.THRUST_DESIRED,
            thrust_desired=20000.0,  # Large step from previous
        )
        
        # Set slew rate limit
        self.cfg.thrust_slew_max = 10000.0  # 10 kN/s
        
        # Mock engine wrapper
        engine_wrapper = Mock(spec=EngineWrapper)
        eng_est = EngineEstimate(
            P_ch=2.5e6,
            F=5000.0,
            mdot_F=1.0,
            mdot_O=2.0,
            MR=2.0,
            injector_dp_F=0.5e6,
            injector_dp_O=0.5e6,
        )
        engine_wrapper.estimate_from_pressures = Mock(return_value=eng_est)
        
        F_ref_prev = 5000.0  # Previous reference
        ref = build_reference(
            nav=self.nav,
            meas=self.meas,
            cmd=cmd,
            cfg=self.cfg,
            horizon_N=10,
            engine_wrapper=engine_wrapper,
            F_ref_prev=F_ref_prev,
        )
        
        # Check slew rate is respected
        for k in range(1, len(ref.F_ref)):
            dF = abs(ref.F_ref[k] - ref.F_ref[k - 1])
            dF_max_allowed = self.cfg.thrust_slew_max * self.cfg.dt
            self.assertLessEqual(dF, dF_max_allowed + 1.0)  # Allow small error


if __name__ == "__main__":
    unittest.main()

