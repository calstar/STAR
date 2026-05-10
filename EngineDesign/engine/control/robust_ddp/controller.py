"""Main robust DDP controller class.

Integrates all components: reference generation, DDP solver, actuation, and safety filter.
"""

from __future__ import annotations

from typing import Optional
import numpy as np

from .data_models import (
    ControllerConfig,
    ControllerState,
    Measurement,
    NavState,
    Command,
)
from .dynamics import (
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
from .reference import build_reference
from .robustness import update_bounds, get_w_bar_array
from .ddp_solver import solve_ddp
from .actuation import compute_actuation, update_state_dwell_timers, ExecutionBackend
from .safety_filter import filter_action
from .engine_wrapper import EngineWrapper
from .logging import ControllerLogger
from .constraints import constraint_values
from .policy_lut import PolicyLUT
from .engine_lut_wrapper import EngineLUTWrapper
from engine.pipeline.config_schemas import PintleEngineConfig


class RobustDDPController:
    """Robust DDP controller for thrust regulation."""
    
    def __init__(
        self,
        cfg: ControllerConfig,
        engine_config: Optional[PintleEngineConfig] = None,
        logger: Optional[ControllerLogger] = None,
    ):
        """
        Initialize robust DDP controller.
        
        Parameters:
        -----------
        cfg : ControllerConfig
            Controller configuration
        engine_config : PintleEngineConfig, optional
            Engine configuration (required for engine wrapper)
        logger : ControllerLogger, optional
            Logger instance. If None, no logging.
        """
        self.cfg = cfg
        self.state = ControllerState()
        self.logger = logger
        
        # Initialize engine wrapper: prefer EngineLUT (fast) when path provided
        self.engine_wrapper = None
        if cfg.engine_lut_path:
            try:
                self.engine_wrapper = EngineLUTWrapper(cfg.engine_lut_path)
            except Exception as e:
                import warnings
                warnings.warn(f"Failed to load engine LUT from {cfg.engine_lut_path}: {e}")
        if self.engine_wrapper is None and engine_config is not None:
            self.engine_wrapper = EngineWrapper(engine_config)
        
        # Dynamics parameters
        self.dynamics_params = DynamicsParams.from_config(cfg)
        
        # Previous state and control (for robustness update)
        self.x_prev: Optional[np.ndarray] = None
        self.u_prev_applied: Optional[np.ndarray] = None
        
        # Previous DDP solution (for warm start)
        self.u_seq_prev: Optional[np.ndarray] = None
        
        # Initialize ullage volumes (if not in config, will be estimated)
        self.V_u_F = cfg.V_u_F_init if cfg.V_u_F_init is not None else 0.01
        self.V_u_O = cfg.V_u_O_init if cfg.V_u_O_init is not None else 0.01
        
        # Tick counter for logging
        self.tick = 0

        # Policy LUT (lazy load when use_policy_lut is True)
        self._policy_lut: Optional[PolicyLUT] = None
        if cfg.use_policy_lut and cfg.policy_lut_path:
            try:
                self._policy_lut = PolicyLUT.load(cfg.policy_lut_path)
            except Exception as e:
                import warnings
                warnings.warn(f"Failed to load policy LUT from {cfg.policy_lut_path}: {e}")

    def reset(self) -> None:
        """Reset controller state to initial values."""
        self.state.reset()
        self.x_prev = None
        self.u_prev_applied = None
        self.u_seq_prev = None
        self.V_u_F = self.cfg.V_u_F_init if self.cfg.V_u_F_init is not None else 0.01
        self.V_u_O = self.cfg.V_u_O_init if self.cfg.V_u_O_init is not None else 0.01
        self.tick = 0
    
    def step(
        self,
        meas: Measurement,
        nav: NavState,
        cmd: Command,
        backend: ExecutionBackend = ExecutionBackend.PWM,
    ) -> tuple:
        """
        Execute one control step.
        
        Parameters:
        -----------
        meas : Measurement
            Current sensor measurements
        nav : NavState
            Current navigation state
        cmd : Command
            Control command (thrust desired or altitude goal)
        backend : ExecutionBackend
            Actuation backend (PWM or BINARY)
        
        Returns:
        --------
        actuation_cmd : ActuationCommand
            Actuation command for solenoids
        diagnostics : dict
            Additional diagnostics (DDP solution, reference, etc.)
        """
        # Step 1: Build full state x from measurements + internal ullage volumes
        x = self._build_state(meas)
        
        # Step 2: Build reference (F_ref, MR_ref) for horizon
        ref = build_reference(
            nav=nav,
            meas=meas,
            cmd=cmd,
            cfg=self.cfg,
            horizon_N=self.cfg.N,
            engine_wrapper=self.engine_wrapper,
            F_ref_prev=self._get_previous_f_ref(),
            dt=self.cfg.dt,
        )
        
        # Step 3: Update robustness bounds using previous x and applied u
        if self.x_prev is not None and self.u_prev_applied is not None:
            update_bounds(
                state=self.state,
                x_prev=self.x_prev,
                x_meas=x,
                u_prev=self.u_prev_applied,
                cfg=self.cfg,
                engine_wrapper=self.engine_wrapper,
                dt=self.cfg.dt,
            )
        
        # Step 4: Check engine estimate validity before DDP
        # Get a preliminary engine estimate to check if we can compute valid thrust/MR
        eng_est_prelim = None
        engine_valid = False
        if self.engine_wrapper is not None:
            try:
                eng_est_prelim = self.engine_wrapper.estimate_from_pressures(
                    meas.P_u_fuel, meas.P_u_ox
                )
                # Check if estimate is valid (both F and MR are finite and positive)
                engine_valid = (
                    np.isfinite(eng_est_prelim.F) and eng_est_prelim.F >= 0 and
                    np.isfinite(eng_est_prelim.MR) and eng_est_prelim.MR > 0
                )
            except Exception:
                engine_valid = False
        
        # Check if we have a non-zero reference but invalid engine estimate
        F_ref_current = ref.F_ref[0] if len(ref.F_ref) > 0 else 0.0
        MR_ref_current = ref.MR_ref[0] if len(ref.MR_ref) > 0 else 0.0
        has_nonzero_ref = (np.isfinite(F_ref_current) and F_ref_current > 0) or \
                         (np.isfinite(MR_ref_current) and MR_ref_current > 0)
        
        if has_nonzero_ref and not engine_valid:
            # Log warning: we want output but engine estimate is invalid
            # This could happen if pressures are too low, engine can't operate, etc.
            # DDP will still run but will use large penalties for invalid estimates
            import warnings
            warnings.warn(
                f"Controller step {self.tick}: Non-zero reference (F_ref={F_ref_current:.1f} N, "
                f"MR_ref={MR_ref_current:.3f}) but engine estimate is invalid. "
                f"Pressures: P_u_F={meas.P_u_fuel/1e6:.2f} MPa, P_u_O={meas.P_u_ox/1e6:.2f} MPa. "
                f"DDP will use penalty-based optimization.",
                RuntimeWarning
            )
        
        w_bar = get_w_bar_array(self.state)

        # Step 5 & 6: Get u_relaxed from LUT or DDP
        if self._policy_lut is not None:
            u_relaxed = self._policy_lut.lookup(
                x[IDX_P_U_F], x[IDX_P_U_O], F_ref_current, MR_ref_current
            )
            u_seq = np.tile(u_relaxed, (self.cfg.N, 1))
            from .ddp_solver import DDPSolution
            solution = DDPSolution(
                u_seq=u_seq,
                x_seq=np.tile(x, (self.cfg.N + 1, 1)),
                eng_estimates=[],
                objective=0.0,
                iterations=0,
                converged=True,
                constraint_violations=[{}] * self.cfg.N,
                diagnostics={"source": "policy_lut"},
            )
        else:
            u_seq_init = self._get_warm_start_control_sequence()
            solution = solve_ddp(
                x0=x,
                u_seq_init=u_seq_init,
                F_ref=ref.F_ref,
                MR_ref=ref.MR_ref,
                cfg=self.cfg,
                dynamics_params=self.dynamics_params,
                engine_wrapper=self.engine_wrapper,
                w_bar=w_bar,
                use_robustification=True,
            )
            u_relaxed = solution.u_seq[0].copy()
        
        # CRITICAL: If controller isn't making changes, force it to respond to thrust errors
        # Check if we have a thrust deficit and controller isn't responding
        eng_est_current = None
        if self.engine_wrapper is not None:
            try:
                eng_est_current = self.engine_wrapper.estimate_from_pressures(
                    meas.P_u_fuel, meas.P_u_ox
                )
            except Exception:
                pass
        
        F_ref_current = ref.F_ref[0] if len(ref.F_ref) > 0 else 0.0
        if eng_est_current is not None and np.isfinite(eng_est_current.F) and F_ref_current > 0:
            F_error = eng_est_current.F - F_ref_current
            # If thrust is too low and control is low, force increase
            if F_error < -500.0 and np.max(u_relaxed) < 0.3:  # Thrust deficit > 500N and control < 30%
                # Force controller to increase control to raise pressure
                u_relaxed = np.clip(u_relaxed + 0.2, 0.0, 1.0)  # Increase by 20%
        
        # Step 7: Convert to actuation via actuation.py
        actuation_cmd = compute_actuation(
            u_relaxed=u_relaxed,
            state=self.state,
            cfg=self.cfg,
            backend=backend,
            dt=self.cfg.dt,
        )
        
        # Step 8: Apply safety filter
        u_safe = filter_action(
            x=x,
            proposed=u_relaxed,
            state=self.state,
            cfg=self.cfg,
            engine_wrapper=self.engine_wrapper,
            F_ref=ref.F_ref[0] if len(ref.F_ref) > 0 else None,
            MR_ref=ref.MR_ref[0] if len(ref.MR_ref) > 0 else None,
            num_steps=2,
            dt=self.cfg.dt,
        )
        
        # If safety filter changed action, recompute actuation
        if not np.allclose(u_safe, u_relaxed):
            actuation_cmd = compute_actuation(
                u_relaxed=u_safe,
                state=self.state,
                cfg=self.cfg,
                backend=backend,
                dt=self.cfg.dt,
            )
        
        # Update dwell timers in state
        update_state_dwell_timers(self.state, actuation_cmd)
        
        # Step 9: Store state for next tick
        self._update_state(x, u_safe, solution, ref)
        
        # Get engine estimate once for both logging and diagnostics
        eng_est = None
        if self.engine_wrapper is not None:
            try:
                # Use tank/ullage pressures (P_u) to get engine performance
                # Engine expects tank pressures, not feed pressures
                eng_est = self.engine_wrapper.estimate_from_pressures(
                    meas.P_u_fuel, meas.P_u_ox
                )
            except Exception:
                pass
        
        # Get constraint margins
        constraints = {}
        if eng_est is not None:
            constraints = constraint_values(x, eng_est, self.cfg)
        
        # Log tick data
        if self.logger is not None:
            # Log
            self.logger.log_tick(
                tick=self.tick,
                timestamp=meas.timestamp if hasattr(meas, 'timestamp') else self.tick * self.cfg.dt,
                meas=meas,
                eng_est=eng_est,
                constraints=constraints,
                u_proposed=u_relaxed,
                u_filtered=u_safe,
                actuation_cmd=actuation_cmd,
                w_bar=w_bar,
                F_ref=ref.F_ref[0] if len(ref.F_ref) > 0 else None,
                MR_ref=ref.MR_ref[0] if len(ref.MR_ref) > 0 else None,
            )
        
        # Increment tick counter
        self.tick += 1
        
        # Build diagnostics
        diagnostics = {
            "x": x.copy(),
            "u_relaxed": u_relaxed.copy(),
            "u_safe": u_safe.copy(),
            "solution": solution,
            "ref": ref,
            "w_bar": w_bar.copy(),
            "constraint_violations": solution.constraint_violations[0] if solution.constraint_violations else {},
            "eng_est": eng_est,
            "F_hat": float(eng_est.F) if eng_est is not None and np.isfinite(eng_est.F) else 0.0,
            "MR_hat": float(eng_est.MR) if eng_est is not None and np.isfinite(eng_est.MR) else 0.0,
            "P_ch": float(eng_est.P_ch) if eng_est is not None and np.isfinite(eng_est.P_ch) else 0.0,
            "F_ref": float(ref.F_ref[0]) if len(ref.F_ref) > 0 else 0.0,
            "MR_ref": float(ref.MR_ref[0]) if len(ref.MR_ref) > 0 else 0.0,
        }
        
        return actuation_cmd, diagnostics
    
    def _build_state(self, meas: Measurement) -> np.ndarray:
        """
        Build full state vector from measurements and internal ullage volumes.
        
        Parameters:
        -----------
        meas : Measurement
            Sensor measurements
        
        Returns:
        --------
        x : np.ndarray, shape (N_STATE,)
            Full state vector including gas masses
        """
        from .dynamics import IDX_M_GAS_COPV, IDX_M_GAS_F, IDX_M_GAS_O
        
        x = np.zeros(N_STATE, dtype=np.float64)
        
        x[IDX_P_COPV] = meas.P_copv
        x[IDX_P_REG] = meas.P_reg
        x[IDX_P_U_F] = meas.P_u_fuel
        x[IDX_P_U_O] = meas.P_u_ox
        x[IDX_P_D_F] = meas.P_d_fuel
        x[IDX_P_D_O] = meas.P_d_ox
        x[IDX_V_U_F] = self.V_u_F
        x[IDX_V_U_O] = self.V_u_O
        
        # Initialize gas masses from pressures using ideal gas law
        # P = (m * R * T) / (V * Z), so m = (P * V * Z) / (R * T)
        R_gas = 296.8  # N2 gas constant [J/(kg·K)]
        T_gas = 293.0  # Gas temperature [K]
        Z_gas = 1.0    # Compressibility factor
        V_copv = getattr(self.dynamics_params, 'V_copv', 0.006)  # Default 6L
        
        x[IDX_M_GAS_COPV] = (meas.P_copv * V_copv * Z_gas) / (R_gas * T_gas)
        x[IDX_M_GAS_F] = (meas.P_u_fuel * self.V_u_F * Z_gas) / (R_gas * T_gas) if self.V_u_F > 1e-10 else 0.0
        x[IDX_M_GAS_O] = (meas.P_u_ox * self.V_u_O * Z_gas) / (R_gas * T_gas) if self.V_u_O > 1e-10 else 0.0
        
        return x
    
    def _get_warm_start_control_sequence(self) -> np.ndarray:
        """
        Get warm start control sequence from previous solution.
        
        Returns:
        --------
        u_seq_init : np.ndarray, shape (N, N_CONTROL)
            Initial control sequence (shifted previous or small non-zero values)
        """
        if self.u_seq_prev is not None:
            # Shift previous solution: u[k] = u_prev[k+1], last = last
            u_seq_init = np.zeros((self.cfg.N, N_CONTROL), dtype=np.float64)
            u_seq_init[:-1] = self.u_seq_prev[1:]
            u_seq_init[-1] = self.u_seq_prev[-1]
            return u_seq_init
        else:
            # No previous solution: use small non-zero initial values
            # This helps when engine estimates are initially invalid by providing
            # a starting point that allows the solver to explore the control space
            # Small value (0.1) is better than zero when gradients are undefined
            return np.full((self.cfg.N, N_CONTROL), 0.1, dtype=np.float64)
    
    def _get_previous_f_ref(self) -> Optional[float]:
        """Get previous reference thrust for slew rate limiting."""
        # Could store previous reference, for now return None
        return None
    
    def _update_state(
        self,
        x: np.ndarray,
        u_applied: np.ndarray,
        solution,
        ref,
    ) -> None:
        """
        Update controller state for next tick.
        
        Parameters:
        -----------
        x : np.ndarray
            Current state
        u_applied : np.ndarray
            Applied control (after safety filter)
        solution : DDPSolution
            DDP solution
        ref : Reference
            Reference trajectory
        """
        # Store previous state and control
        self.x_prev = x.copy()
        self.u_prev_applied = u_applied.copy()
        
        # Store previous DDP solution for warm start
        self.u_seq_prev = solution.u_seq.copy()
        
        # Update ullage volumes (from state)
        self.V_u_F = x[IDX_V_U_F]
        self.V_u_O = x[IDX_V_U_O]

