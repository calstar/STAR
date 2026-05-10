"""Unit tests for robust DDP controller data models."""

import unittest
import json
import tempfile
from pathlib import Path
import numpy as np
from datetime import datetime

from engine.control.robust_ddp.data_models import (
    Measurement,
    NavState,
    Command,
    CommandType,
    ControllerConfig,
    ControllerState,
)
from engine.control.robust_ddp.config_loader import (
    load_config,
    save_config,
    get_default_config,
)


class TestMeasurement(unittest.TestCase):
    """Test Measurement dataclass."""
    
    def test_measurement_creation(self):
        """Test creating a valid measurement."""
        meas = Measurement(
            P_copv=5e6,
            P_reg=4e6,
            P_u_fuel=3e6,
            P_u_ox=3.5e6,
            P_d_fuel=2e6,
            P_d_ox=2.5e6,
            timestamp=1234567890.0
        )
        self.assertEqual(meas.P_copv, 5e6)
        self.assertEqual(meas.timestamp, 1234567890.0)
    
    def test_measurement_datetime(self):
        """Test measurement with datetime timestamp."""
        dt = datetime.now()
        meas = Measurement(
            P_copv=5e6,
            P_reg=4e6,
            P_u_fuel=3e6,
            P_u_ox=3.5e6,
            P_d_fuel=2e6,
            P_d_ox=2.5e6,
            timestamp=dt
        )
        # Should be converted to float
        self.assertIsInstance(meas.timestamp, float)
    
    def test_measurement_negative_pressure(self):
        """Test that negative pressures raise ValueError."""
        with self.assertRaises(ValueError):
            Measurement(
                P_copv=-1e6,  # Negative!
                P_reg=4e6,
                P_u_fuel=3e6,
                P_u_ox=3.5e6,
                P_d_fuel=2e6,
                P_d_ox=2.5e6
            )
    
    def test_measurement_infinite_pressure(self):
        """Test that infinite pressures raise ValueError."""
        with self.assertRaises(ValueError):
            Measurement(
                P_copv=np.inf,
                P_reg=4e6,
                P_u_fuel=3e6,
                P_u_ox=3.5e6,
                P_d_fuel=2e6,
                P_d_ox=2.5e6
            )
    
    def test_measurement_serialization(self):
        """Test measurement serialization to/from dict."""
        meas = Measurement(
            P_copv=5e6,
            P_reg=4e6,
            P_u_fuel=3e6,
            P_u_ox=3.5e6,
            P_d_fuel=2e6,
            P_d_ox=2.5e6,
            timestamp=1234567890.0
        )
        data = meas.to_dict()
        meas2 = Measurement.from_dict(data)
        self.assertEqual(meas.P_copv, meas2.P_copv)
        self.assertEqual(meas.timestamp, meas2.timestamp)


class TestNavState(unittest.TestCase):
    """Test NavState dataclass."""
    
    def test_navstate_creation(self):
        """Test creating a valid nav state."""
        nav = NavState(h=100.0, vz=10.0, theta=0.1)
        self.assertEqual(nav.h, 100.0)
        self.assertEqual(nav.vz, 10.0)
        self.assertEqual(nav.theta, 0.1)
    
    def test_navstate_with_quaternion(self):
        """Test nav state with quaternion."""
        quat = [1.0, 0.0, 0.0, 0.0]  # Identity quaternion
        nav = NavState(h=100.0, vz=10.0, quaternion=quat)
        self.assertEqual(nav.quaternion, quat)
    
    def test_navstate_with_mass(self):
        """Test nav state with mass estimate."""
        nav = NavState(h=100.0, vz=10.0, mass_estimate=500.0)
        self.assertEqual(nav.mass_estimate, 500.0)
    
    def test_navstate_negative_altitude(self):
        """Test that negative altitude raises ValueError."""
        with self.assertRaises(ValueError):
            NavState(h=-10.0, vz=10.0)
    
    def test_navstate_invalid_quaternion(self):
        """Test that invalid quaternion raises ValueError."""
        with self.assertRaises(ValueError):
            NavState(h=100.0, vz=10.0, quaternion=[1.0, 0.0])  # Wrong length
        
        with self.assertRaises(ValueError):
            NavState(h=100.0, vz=10.0, quaternion=[2.0, 0.0, 0.0, 0.0])  # Not normalized
    
    def test_navstate_serialization(self):
        """Test nav state serialization."""
        nav = NavState(h=100.0, vz=10.0, theta=0.1, mass_estimate=500.0)
        data = nav.to_dict()
        nav2 = NavState.from_dict(data)
        self.assertEqual(nav.h, nav2.h)
        self.assertEqual(nav.mass_estimate, nav2.mass_estimate)


class TestCommand(unittest.TestCase):
    """Test Command dataclass."""
    
    def test_command_thrust_constant(self):
        """Test command with constant thrust."""
        cmd = Command(
            command_type=CommandType.THRUST_DESIRED,
            thrust_desired=1000.0
        )
        self.assertEqual(cmd.command_type, CommandType.THRUST_DESIRED)
        self.assertEqual(cmd.thrust_desired, 1000.0)
    
    def test_command_thrust_profile(self):
        """Test command with time-varying thrust profile."""
        profile = [(0.0, 1000.0), (1.0, 1500.0), (2.0, 2000.0)]
        cmd = Command(
            command_type=CommandType.THRUST_DESIRED,
            thrust_desired=profile
        )
        self.assertEqual(cmd.thrust_desired, profile)
    
    def test_command_altitude_goal(self):
        """Test command with altitude goal."""
        cmd = Command(
            command_type=CommandType.ALTITUDE_GOAL,
            altitude_goal=1000.0
        )
        self.assertEqual(cmd.command_type, CommandType.ALTITUDE_GOAL)
        self.assertEqual(cmd.altitude_goal, 1000.0)
    
    def test_command_missing_thrust(self):
        """Test that missing thrust raises ValueError."""
        with self.assertRaises(ValueError):
            Command(
                command_type=CommandType.THRUST_DESIRED,
                thrust_desired=None
            )
    
    def test_command_missing_altitude(self):
        """Test that missing altitude raises ValueError."""
        with self.assertRaises(ValueError):
            Command(
                command_type=CommandType.ALTITUDE_GOAL,
                altitude_goal=None
            )
    
    def test_command_negative_thrust(self):
        """Test that negative thrust raises ValueError."""
        with self.assertRaises(ValueError):
            Command(
                command_type=CommandType.THRUST_DESIRED,
                thrust_desired=-100.0
            )
    
    def test_command_serialization(self):
        """Test command serialization."""
        cmd = Command(
            command_type=CommandType.THRUST_DESIRED,
            thrust_desired=1000.0
        )
        data = cmd.to_dict()
        cmd2 = Command.from_dict(data)
        self.assertEqual(cmd.command_type, cmd2.command_type)
        self.assertEqual(cmd.thrust_desired, cmd2.thrust_desired)


class TestControllerConfig(unittest.TestCase):
    """Test ControllerConfig dataclass."""
    
    def test_config_creation(self):
        """Test creating a valid config."""
        config = ControllerConfig()
        self.assertEqual(config.N, 50)
        self.assertEqual(config.dt, 0.01)
        self.assertEqual(config.MR_min, 1.5)
        self.assertEqual(config.MR_max, 3.0)
    
    def test_config_validation(self):
        """Test config validation."""
        with self.assertRaises(ValueError):
            ControllerConfig(N=-1)  # Negative N
        
        with self.assertRaises(ValueError):
            ControllerConfig(dt=-0.01)  # Negative dt
        
        with self.assertRaises(ValueError):
            ControllerConfig(MR_min=3.0, MR_max=1.5)  # min >= max
    
    def test_config_serialization(self):
        """Test config serialization."""
        config = ControllerConfig(N=100, dt=0.02)
        data = config.to_dict()
        config2 = ControllerConfig.from_dict(data)
        self.assertEqual(config.N, config2.N)
        self.assertEqual(config.dt, config2.dt)
    
    def test_config_json_io(self):
        """Test config JSON save/load."""
        config = ControllerConfig(N=75, dt=0.015)
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            filepath = f.name
        
        try:
            config.to_json(filepath)
            config2 = ControllerConfig.from_json(filepath)
            self.assertEqual(config.N, config2.N)
            self.assertEqual(config.dt, config2.dt)
        finally:
            Path(filepath).unlink()
    
    def test_config_yaml_io(self):
        """Test config YAML save/load."""
        config = ControllerConfig(N=75, dt=0.015)
        with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', delete=False) as f:
            filepath = f.name
        
        try:
            config.to_yaml(filepath)
            config2 = ControllerConfig.from_yaml(filepath)
            self.assertEqual(config.N, config2.N)
            self.assertEqual(config.dt, config2.dt)
        finally:
            Path(filepath).unlink()


class TestControllerState(unittest.TestCase):
    """Test ControllerState dataclass."""
    
    def test_state_creation(self):
        """Test creating a valid state."""
        state = ControllerState()
        self.assertEqual(state.u_prev["P_u_fuel"], 0.0)
        self.assertEqual(state.beta, 0.0)
        self.assertEqual(state.iteration_count, 0)
    
    def test_state_reset(self):
        """Test state reset behavior."""
        state = ControllerState()
        state.u_prev["P_u_fuel"] = 3e6
        state.beta = 0.5
        state.iteration_count = 5
        state.last_cost = 100.0
        
        state.reset()
        
        self.assertEqual(state.u_prev["P_u_fuel"], 0.0)
        self.assertEqual(state.beta, 0.0)
        self.assertEqual(state.iteration_count, 0)
        self.assertEqual(state.last_cost, float('inf'))
    
    def test_state_serialization(self):
        """Test state serialization."""
        state = ControllerState()
        state.u_prev["P_u_fuel"] = 3e6
        state.beta = 0.5
        
        data = state.to_dict()
        state2 = ControllerState.from_dict(data)
        
        self.assertEqual(state.u_prev["P_u_fuel"], state2.u_prev["P_u_fuel"])
        self.assertEqual(state.beta, state2.beta)


class TestConfigLoader(unittest.TestCase):
    """Test config loader functions."""
    
    def test_get_default_config(self):
        """Test getting default config."""
        config = get_default_config()
        self.assertIsInstance(config, ControllerConfig)
        self.assertEqual(config.N, 50)
    
    def test_load_config_none(self):
        """Test loading None returns default."""
        config = load_config(None)
        self.assertIsInstance(config, ControllerConfig)
    
    def test_load_config_json(self):
        """Test loading config from JSON."""
        config = ControllerConfig(N=100, dt=0.02)
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            filepath = f.name
        
        try:
            save_config(config, filepath)
            config2 = load_config(filepath)
            self.assertEqual(config.N, config2.N)
        finally:
            Path(filepath).unlink()
    
    def test_load_config_yaml(self):
        """Test loading config from YAML."""
        config = ControllerConfig(N=100, dt=0.02)
        with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', delete=False) as f:
            filepath = f.name
        
        try:
            save_config(config, filepath)
            config2 = load_config(filepath)
            self.assertEqual(config.N, config2.N)
        finally:
            Path(filepath).unlink()
    
    def test_load_config_invalid_format(self):
        """Test loading config with invalid format raises error."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
            filepath = f.name
        
        try:
            with self.assertRaises(ValueError):
                load_config(filepath)
        finally:
            Path(filepath).unlink()
    
    def test_load_config_missing_file(self):
        """Test loading missing file raises FileNotFoundError."""
        with self.assertRaises(FileNotFoundError):
            load_config("/nonexistent/path/config.json")


if __name__ == '__main__':
    unittest.main()

