"""Integration test for robust DDP controller.

Runs controller for 200 steps with simulated dynamics and verifies:
- Constraints never violated
- COPV pressure decreases but stays above minimum
- Thrust tracks reference within tolerance
"""

import unittest
import numpy as np
from unittest.mock import Mock

from engine.control.robust_ddp.controller import RobustDDPController
from engine.control.robust_ddp.data_models import (
    ControllerConfig,
    Measurement,
    NavState,
    Command,
    CommandType,
)
from engine.control.robust_ddp.dynamics import (
    step,
    DynamicsParams,
    IDX_P_COPV,
    IDX_P_REG,
    IDX_P_U_F,
    IDX_P_U_O,
    IDX_P_D_F,
    IDX_P_D_O,
    IDX_V_U_F,
    IDX_V_U_O,
)
from engine.control.robust_ddp.engine_wrapper import EngineEstimate, EngineWrapper
from engine.control.robust_ddp.constraints import is_safe
from engine.pipeline.config_schemas import PintleEngineConfig


class TestControllerIntegration(unittest.TestCase):
    """Integration test for robust DDP controller."""
    
    def setUp(self):
        """Set up test fixtures."""
        # Create controller config
        self.cfg = ControllerConfig(
            N=10,  # Short horizon for faster test
            dt=0.01,  # 10 ms
            dwell_time=0.05,
            duty_quantization=0.1,  # 10% steps
            qF=1.0,
            qMR=10.0,
            qGas=0.1,
            qSwitch=0.01,
            MR_min=1.5,
            MR_max=3.0,
            P_u_max=10e6,
            P_copv_min=1e6,
            max_iterations=3,  # Few iterations for speed
            convergence_tol=1e-3,
        )
        
        # Create minimal engine config
        self.engine_config = self._create_minimal_engine_config()
        
        # Create controller
        self.controller = RobustDDPController(self.cfg, self.engine_config)
        
        # Initial state
        self.x0 = np.array([
            30e6,   # P_copv
            24e6,   # P_reg
            3e6,    # P_u_F
            3.5e6,  # P_u_O
            2.5e6,  # P_d_F
            3e6,    # P_d_O
            0.01,   # V_u_F
            0.01,   # V_u_O
        ])
        
        # Reference thrust
        self.F_ref = 5000.0  # 5 kN
        
        # Dynamics params
        self.dynamics_params = DynamicsParams.from_config(self.cfg)
    
    def _create_minimal_engine_config(self) -> PintleEngineConfig:
        """Create minimal engine config for testing."""
        from engine.pipeline.config_schemas import (
            PintleEngineConfig,
            PintleInjectorConfig,
            PintleInjectorGeometry,
            FuelGeometry,
            OxidizerGeometry,
            FluidConfig,
            FeedSystemConfig,
            DischargeConfig,
            CombustionConfig,
            CEAConfig,
            ChamberGeometryConfig,
        )
        
        return PintleEngineConfig(
            injector=PintleInjectorConfig(
                type="pintle",
                geometry=PintleInjectorGeometry(
                    fuel=FuelGeometry(
                        d_pintle_tip=0.01,
                        n_holes=8,
                        d_hole=0.001,
                    ),
                    oxidizer=OxidizerGeometry(
                        d_annulus_inner=0.008,
                        d_annulus_outer=0.012,
                    ),
                ),
            ),
            fluids={
                "fuel": FluidConfig(
                    name="RP-1",
                    density=800.0,
                    viscosity=2e-3,
                    surface_tension=0.025,
                ),
                "oxidizer": FluidConfig(
                    name="LOX",
                    density=1140.0,
                    viscosity=0.2e-3,
                    surface_tension=0.013,
                ),
            },
            feed_system={
                "fuel": FeedSystemConfig(
                    line_length=1.0,
                    line_diameter=0.02,
                    roughness=1e-6,
                ),
                "oxidizer": FeedSystemConfig(
                    line_length=1.0,
                    line_diameter=0.02,
                    roughness=1e-6,
                ),
            },
            discharge={
                "fuel": DischargeConfig(
                    Cd=0.6,
                    A=1e-4,
                ),
                "oxidizer": DischargeConfig(
                    Cd=0.6,
                    A=1e-4,
                ),
            },
            combustion=CombustionConfig(
                cea=CEAConfig(),
            ),
            chamber_geometry=ChamberGeometryConfig(
                A_throat=1e-4,
                A_exit=5e-4,
                L_star=1.0,
            ),
        )
    
    def _simulate_dynamics(
        self,
        x: np.ndarray,
        u: np.ndarray,
        engine_wrapper: EngineWrapper,
    ) -> np.ndarray:
        """
        Simulate one step of dynamics.
        
        Parameters:
        -----------
        x : np.ndarray
            Current state
        u : np.ndarray
            Control action
        engine_wrapper : EngineWrapper
            Engine wrapper for mass flow estimation
        
        Returns:
        --------
        x_next : np.ndarray
            Next state
        """
        # Estimate mass flows
        try:
            eng_est = engine_wrapper.estimate_from_pressures(x[IDX_P_D_F], x[IDX_P_D_O])
            mdot_F = eng_est.mdot_F if np.isfinite(eng_est.mdot_F) else 0.0
            mdot_O = eng_est.mdot_O if np.isfinite(eng_est.mdot_O) else 0.0
        except Exception:
            mdot_F = 0.0
            mdot_O = 0.0
        
        # Step dynamics
        x_next = step(x, u, self.cfg.dt, self.dynamics_params, mdot_F, mdot_O)
        
        return x_next
    
    def _measurement_from_state(self, x: np.ndarray) -> Measurement:
        """Create measurement from state."""
        return Measurement(
            P_copv=x[IDX_P_COPV],
            P_reg=x[IDX_P_REG],
            P_u_fuel=x[IDX_P_U_F],
            P_u_ox=x[IDX_P_U_O],
            P_d_fuel=x[IDX_P_D_F],
            P_d_ox=x[IDX_P_D_O],
        )
    
    def test_controller_integration(self):
        """Test controller integration over 200 steps."""
        # Reset controller
        self.controller.reset()
        
        # Initial state
        x = self.x0.copy()
        
        # Track history
        history = {
            "x": [],
            "u": [],
            "F": [],
            "P_copv": [],
            "constraint_violations": [],
        }
        
        # Create command
        cmd = Command(
            command_type=CommandType.THRUST_DESIRED,
            thrust_desired=self.F_ref,
        )
        
        # Navigation state (constant for this test)
        nav = NavState(h=0.0, vz=0.0, theta=0.0, mass_estimate=100.0)
        
        # Run for 200 steps
        num_steps = 200
        for k in range(num_steps):
            # Create measurement from current state
            meas = self._measurement_from_state(x)
            
            # Controller step
            actuation_cmd, diagnostics = self.controller.step(meas, nav, cmd)
            
            # Extract control
            u = np.array([actuation_cmd.duty_F, actuation_cmd.duty_O])
            
            # Simulate dynamics
            x_next = self._simulate_dynamics(x, u, self.controller.engine_wrapper)
            
            # Check constraints
            eng_est = self.controller.engine_wrapper.estimate_from_pressures(
                x[IDX_P_D_F], x[IDX_P_D_O]
            )
            safe = is_safe(x, eng_est, self.cfg)
            
            # Store history
            history["x"].append(x.copy())
            history["u"].append(u.copy())
            history["F"].append(eng_est.F)
            history["P_copv"].append(x[IDX_P_COPV])
            history["constraint_violations"].append(not safe)
            
            # Update state
            x = x_next
        
        # Convert to arrays
        P_copv_history = np.array(history["P_copv"])
        F_history = np.array(history["F"])
        constraint_violations = np.array(history["constraint_violations"])
        
        # Check 1: Constraints never violated
        self.assertFalse(
            np.any(constraint_violations),
            f"Constraints violated at steps: {np.where(constraint_violations)[0]}"
        )
        
        # Check 2: COPV pressure decreases but stays above minimum
        P_copv_final = P_copv_history[-1]
        P_copv_initial = P_copv_history[0]
        
        self.assertLess(
            P_copv_final, P_copv_initial,
            "COPV pressure should decrease over time"
        )
        
        self.assertGreaterEqual(
            P_copv_final, self.cfg.P_copv_min,
            f"COPV pressure ({P_copv_final/1e6:.2f} MPa) should stay above minimum ({self.cfg.P_copv_min/1e6:.2f} MPa)"
        )
        
        # Check 3: Thrust tracks reference within reasonable tolerance
        # Allow 20% tolerance for model uncertainty
        F_tolerance = 0.2 * self.F_ref
        F_mean = np.mean(F_history[50:])  # Skip initial transient
        
        self.assertLess(
            abs(F_mean - self.F_ref), F_tolerance,
            f"Thrust ({F_mean:.1f} N) should track reference ({self.F_ref:.1f} N) within {F_tolerance:.1f} N"
        )
        
        # Additional checks
        # Check that control is reasonable (not all zeros or all ones)
        u_history = np.array(history["u"])
        u_mean = np.mean(u_history, axis=0)
        
        self.assertTrue(
            np.any(u_mean > 0.1) and np.any(u_mean < 0.9),
            "Control should vary (not stuck at boundaries)"
        )
        
        # Check that state stays bounded
        x_history = np.array(history["x"])
        self.assertTrue(
            np.all(np.isfinite(x_history)),
            "State should remain finite"
        )
        
        # Check ullage pressures stay below maximum
        P_u_F_history = x_history[:, IDX_P_U_F]
        P_u_O_history = x_history[:, IDX_P_U_O]
        
        self.assertLessEqual(
            np.max(P_u_F_history), self.cfg.P_u_max * 1.1,  # 10% margin for numerical errors
            f"Fuel ullage pressure should stay below maximum"
        )
        self.assertLessEqual(
            np.max(P_u_O_history), self.cfg.P_u_max * 1.1,
            f"Oxidizer ullage pressure should stay below maximum"
        )


if __name__ == "__main__":
    unittest.main()

