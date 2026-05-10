"""Controller endpoints for robust DDP thrust control."""

from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any, Literal
import numpy as np
import json
import asyncio
import yaml

from backend.state import app_state
from engine.control.robust_ddp import (
    RobustDDPController,
    ControllerConfig,
    ControllerLogger,
    Measurement,
    NavState,
    Command,
    CommandType,
    ActuationCommand,
)
from engine.control.robust_ddp.config_loader import load_config as load_controller_config, get_default_config
from engine.pipeline.io import load_config as load_engine_config

router = APIRouter(prefix="/api/control", tags=["control"])

# Global controller instance (stored in app_state would be better, but this works)
_controller: Optional[RobustDDPController] = None
_controller_logger: Optional[ControllerLogger] = None


def safe_float(val):
    """Convert value to float, replacing NaN/Inf with None."""
    if val is None:
        return None
    try:
        fval = float(val)
        if np.isnan(fval) or np.isinf(fval):
            return None
        return fval
    except (ValueError, TypeError):
        return None


def convert_numpy(obj):
    """Recursively convert numpy types to Python native types, handling NaN and Inf."""
    # Handle dataclasses and objects with __dict__
    if hasattr(obj, '__dict__') and not isinstance(obj, (dict, list, tuple, str, bytes)):
        try:
            # Try to convert to dict first
            if hasattr(obj, '__dataclass_fields__'):
                # It's a dataclass
                return {k: convert_numpy(getattr(obj, k, None)) for k in obj.__dataclass_fields__.keys()}
            else:
                # Regular object with __dict__
                return {k: convert_numpy(v) for k, v in obj.__dict__.items()}
        except Exception:
            # If conversion fails, return string representation
            return str(obj)
    
    if isinstance(obj, dict):
        return {k: convert_numpy(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [convert_numpy(item) for item in obj]
    elif isinstance(obj, np.ndarray):
        # Convert array, replacing NaN/Inf with None
        try:
            arr_list = obj.tolist()
            return convert_numpy(arr_list)  # Recursively handle NaN in list
        except Exception:
            return str(obj)
    elif isinstance(obj, (np.integer, np.floating)):
        val = obj.item()
        # Replace NaN and Inf with None (JSON-safe)
        if isinstance(val, float) and (np.isnan(val) or np.isinf(val)):
            return None
        return val
    elif isinstance(obj, np.bool_):
        return bool(obj)
    elif isinstance(obj, float):
        # Handle Python float NaN/Inf
        if np.isnan(obj) or np.isinf(obj):
            return None
        return obj
    elif isinstance(obj, (int, str, bool, type(None))):
        return obj
    else:
        # For any other type, try to convert to string
        try:
            return str(obj)
        except Exception:
            return None


# ============================================================================
# Request/Response Models
# ============================================================================

class ControllerInitRequest(BaseModel):
    """Request to initialize controller."""
    controller_config_path: Optional[str] = Field(
        default=None,
        description="Path to controller config YAML (relative to configs/). If None, uses default."
    )
    use_engine_config: bool = Field(
        default=True,
        description="Use currently loaded engine config from app_state"
    )


class MeasurementRequest(BaseModel):
    """Sensor measurement data."""
    P_copv: float = Field(..., description="COPV pressure [Pa]")
    P_reg: float = Field(..., description="Regulator pressure [Pa]")
    P_u_fuel: float = Field(..., description="Fuel ullage/tank pressure [Pa]")
    P_u_ox: float = Field(..., description="Oxidizer ullage/tank pressure [Pa]")
    P_d_fuel: float = Field(..., description="Fuel feed pressure [Pa]")
    P_d_ox: float = Field(..., description="Oxidizer feed pressure [Pa]")
    timestamp: Optional[float] = Field(default=None, description="Timestamp [s]")


class NavStateRequest(BaseModel):
    """Navigation state data."""
    h: float = Field(..., description="Altitude [m]")
    vz: float = Field(..., description="Vertical velocity [m/s]")
    theta: float = Field(default=0.0, description="Tilt angle [rad]")
    mass_estimate: Optional[float] = Field(default=None, description="Vehicle mass estimate [kg]")


class CommandRequest(BaseModel):
    """Control command."""
    command_type: Literal["thrust_desired", "altitude_goal"] = Field(
        ...,
        description="Command type: 'thrust_desired' or 'altitude_goal'"
    )
    thrust_desired: Optional[float] = Field(
        default=None,
        description="Desired thrust [N] (for thrust_desired mode) or piecewise schedule"
    )
    altitude_goal: Optional[float] = Field(
        default=None,
        description="Target altitude [m] (for altitude_goal mode)"
    )


class ControllerStepRequest(BaseModel):
    """Request for one controller step."""
    meas: MeasurementRequest
    nav: NavStateRequest
    cmd: CommandRequest


class ControllerSimulateRequest(BaseModel):
    """Request to simulate controller over time series."""
    # Initial conditions
    initial_meas: MeasurementRequest
    initial_nav: NavStateRequest
    
    # Command
    cmd: CommandRequest
    
    # Simulation parameters
    duration: float = Field(..., gt=0, description="Simulation duration [s]")
    dt: float = Field(default=0.01, gt=0, description="Time step [s]")
    
    # Optional: provide thrust curve for tracking
    thrust_curve: Optional[List[float]] = Field(
        default=None,
        description="Target thrust curve [N] (if provided, used for thrust_desired mode)"
    )
    time_array: Optional[List[float]] = Field(
        default=None,
        description="Time array for thrust curve [s]"
    )
    
    # Controller config
    controller_config_path: Optional[str] = None


class Layer2ControllerSimulateRequest(BaseModel):
    """Request to run controller on Layer 2 optimized thrust curve."""
    thrust_curve_time: List[float] = Field(..., description="Time array from Layer 2 [s]")
    thrust_curve_values: List[float] = Field(..., description="Thrust values from Layer 2 [N]")
    initial_meas: Optional[MeasurementRequest] = Field(
        default=None,
        description="Initial measurements. If None, uses defaults from Layer 2 results."
    )
    initial_nav: Optional[NavStateRequest] = Field(
        default=None,
        description="Initial navigation state. If None, uses defaults."
    )
    dt: float = Field(default=0.01, description="Controller time step [s]")


class Layer2ConfigSimulateRequest(BaseModel):
    """Request to run controller from Layer 2 config file."""
    config_path: Optional[str] = Field(
        default=None,
        description="Path to Layer 2 config YAML file (relative to project root). If None, uses currently loaded config."
    )
    initial_meas: Optional[MeasurementRequest] = Field(
        default=None,
        description="Initial measurements. If None, uses defaults from config."
    )
    initial_nav: Optional[NavStateRequest] = Field(
        default=None,
        description="Initial navigation state. If None, uses defaults."
    )
    dt: float = Field(default=0.01, description="Controller time step [s]")


# ============================================================================
# Endpoints
# ============================================================================

@router.post("/init")
async def init_controller(request: ControllerInitRequest):
    """Initialize the robust DDP controller."""
    global _controller, _controller_logger
    
    try:
        # Load controller config
        if request.controller_config_path:
            config_path = f"configs/{request.controller_config_path}"
            cfg = load_controller_config(config_path)
        else:
            cfg = get_default_config()
        
        # Get engine config (REQUIRED for controller - needed for chamber design, injector geometry, etc.)
        if not app_state.has_config():
            raise HTTPException(
                status_code=400,
                detail="No engine config loaded. The controller requires an engine config to formulate the control pipeline (chamber design, injector geometry, etc.). Please load a config first."
            )
        engine_config = app_state.config
        
        # Create logger (optional, for now just in-memory)
        # _controller_logger = ControllerLogger("controller_run.json", format="json")
        
        # Create controller (engine_config is required)
        _controller = RobustDDPController(cfg, engine_config, logger=None)
        
        return {
            "status": "initialized",
            "config": convert_numpy(cfg.to_dict()),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/step")
async def controller_step(request: ControllerStepRequest):
    """Execute one controller step."""
    global _controller
    
    if _controller is None:
        raise HTTPException(status_code=400, detail="Controller not initialized. Call /init first.")
    
    try:
        # Convert requests to data models
        measurement = Measurement(
            P_copv=request.meas.P_copv,
            P_reg=request.meas.P_reg,
            P_u_fuel=request.meas.P_u_fuel,
            P_u_ox=request.meas.P_u_ox,
            P_d_fuel=request.meas.P_d_fuel,
            P_d_ox=request.meas.P_d_ox,
            timestamp=request.meas.timestamp,
        )
        
        nav_state = NavState(
            h=request.nav.h,
            vz=request.nav.vz,
            theta=request.nav.theta,
            mass_estimate=request.nav.mass_estimate,
        )
        
        command = Command(
            command_type=CommandType(request.cmd.command_type),
            thrust_desired=request.cmd.thrust_desired,
            altitude_goal=request.cmd.altitude_goal,
        )
        
        # Run controller step
        actuation_cmd, diagnostics = _controller.step(measurement, nav_state, command)
        
        # Extract only primitive values - avoid any numpy arrays or complex objects
        def safe_float_val(val, default=0.0):
            try:
                if isinstance(val, (int, float)):
                    fval = float(val)
                    return fval if not (np.isnan(fval) or np.isinf(fval)) else default
                elif isinstance(val, np.number):
                    fval = float(val)
                    return fval if not (np.isnan(fval) or np.isinf(fval)) else default
                elif isinstance(val, np.ndarray):
                    # Skip arrays entirely
                    return default
                return default
            except Exception:
                return default
        
        # Build diagnostics dict with ONLY primitive types
        diagnostics_dict = {}
        try:
            diagnostics_dict["F_ref"] = safe_float_val(diagnostics.get("F_ref", 0.0))
            diagnostics_dict["MR_ref"] = safe_float_val(diagnostics.get("MR_ref", 0.0))
            diagnostics_dict["F_estimated"] = safe_float_val(diagnostics.get("F_hat", 0.0))
            diagnostics_dict["MR_estimated"] = safe_float_val(diagnostics.get("MR_hat", 0.0))
            diagnostics_dict["P_ch"] = safe_float_val(diagnostics.get("P_ch", 0.0))
            diagnostics_dict["cost"] = 0.0
            diagnostics_dict["solver_iters"] = 0
            diagnostics_dict["safety_filtered"] = False
            diagnostics_dict["cutoff_active"] = False
            
            # Try to add solution info if available (safely)
            solution = diagnostics.get("solution")
            if solution:
                if hasattr(solution, 'objective'):
                    try:
                        obj_val = solution.objective
                        if isinstance(obj_val, (int, float)) and not isinstance(obj_val, np.ndarray):
                            diagnostics_dict["cost"] = safe_float_val(obj_val)
                    except Exception:
                        pass
                if hasattr(solution, 'iterations'):
                    try:
                        iter_val = solution.iterations
                        if isinstance(iter_val, (int, np.integer)):
                            diagnostics_dict["solver_iters"] = int(iter_val)
                    except Exception:
                        pass
        except Exception as e:
            # If diagnostics extraction fails, use defaults
            diagnostics_dict = {
                "F_ref": 0.0, "MR_ref": 0.0, "F_estimated": 0.0, "MR_estimated": 0.0,
                "P_ch": 0.0, "cost": 0.0, "solver_iters": 0, "safety_filtered": False, "cutoff_active": False
            }
        
        # Extract primitive values from actuation_cmd
        actuation_dict = {
            "duty_F": float(getattr(actuation_cmd, 'duty_F', 0.0)),
            "duty_O": float(getattr(actuation_cmd, 'duty_O', 0.0)),
            "u_F_onoff": bool(getattr(actuation_cmd, 'u_F_onoff', False)),
            "u_O_onoff": bool(getattr(actuation_cmd, 'u_O_onoff', False)),
        }
        
        # Return plain dict - FastAPI will serialize it
        return {
            "actuation": actuation_dict,
            "diagnostics": diagnostics_dict,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/simulate")
async def simulate_controller(request: ControllerSimulateRequest):
    """Simulate controller over a time series."""
    global _controller
    
    # Initialize controller if needed
    if _controller is None:
        try:
            cfg = get_default_config()
            if not app_state.has_config():
                raise HTTPException(
                    status_code=400,
                    detail="No engine config loaded. Load a config first."
                )
            engine_config = app_state.config
            _controller = RobustDDPController(cfg, engine_config, logger=None)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to initialize controller: {e}")
    
    try:
        # Build time array
        n_steps = int(request.duration / request.dt)
        time_array = np.linspace(0, request.duration, n_steps + 1)
        
        # Initialize state
        meas = Measurement(
            P_copv=request.initial_meas.P_copv,
            P_reg=request.initial_meas.P_reg,
            P_u_fuel=request.initial_meas.P_u_fuel,
            P_u_ox=request.initial_meas.P_u_ox,
            P_d_fuel=request.initial_meas.P_d_fuel,
            P_d_ox=request.initial_meas.P_d_ox,
        )
        
        nav = NavState(
            h=request.initial_nav.h,
            vz=request.initial_nav.vz,
            theta=request.initial_nav.theta,
            mass_estimate=request.initial_nav.mass_estimate,
        )
        
        # Build command (handle thrust curve if provided)
        if request.cmd.command_type == "thrust_desired" and request.thrust_curve:
            # Piecewise thrust schedule
            if request.time_array:
                thrust_schedule = list(zip(request.time_array, request.thrust_curve))
            else:
                # Use simulation time array
                thrust_schedule = list(zip(time_array.tolist(), request.thrust_curve))
            cmd = Command(
                command_type=CommandType.THRUST_DESIRED,
                thrust_desired=thrust_schedule,
            )
        else:
            cmd = Command(
                command_type=CommandType(request.cmd.command_type),
                thrust_desired=request.cmd.thrust_desired,
                altitude_goal=request.cmd.altitude_goal,
            )
        
        # Import dynamics for state propagation
        from engine.control.robust_ddp.dynamics import step as dynamics_step, DynamicsParams, N_STATE
        from engine.control.robust_ddp.dynamics import IDX_P_COPV, IDX_P_REG, IDX_P_U_F, IDX_P_U_O, IDX_P_D_F, IDX_P_D_O, IDX_V_U_F, IDX_V_U_O
        
        # Get dynamics params
        dynamics_params = DynamicsParams.from_config(_controller.cfg)
        
        # Build initial state vector
        x = _controller._build_state(meas)
        
        # Validate initial state size
        if len(x) != N_STATE:
            raise ValueError(f"Initial state vector has wrong size: expected {N_STATE}, got {len(x)}. "
                           f"State: {x}")
        
        # NOTE: Controller is already integrated with engine physics pipeline:
        # - Controller calls engine_wrapper.estimate_from_pressures(P_u_F, P_u_O)
        # - Engine wrapper calls PintleEngineRunner.evaluate(P_tank_F, P_tank_O)
        # - PintleEngineRunner uses full physics: chamber solver, nozzle, stability, etc.
        # - This gives actual thrust, mdot, MR from tank pressures
        # - Flight dynamics are integrated below using actual thrust from engine
        
        # Simulate
        results = {
            "time": [],
            "thrust_ref": [],
            "thrust_actual": [],
            "MR": [],
            "P_copv": [],
            "P_reg": [],
            "P_u_fuel": [],
            "P_u_ox": [],
            "P_d_fuel": [],
            "P_d_ox": [],
            "P_ch": [],
            "duty_F": [],
            "duty_O": [],
            "altitude": [],
            "velocity": [],
            "value_function": [],  # DDP objective/cost
            "control_effort": [],  # ||u|| or ||u - u_prev||
            "V_u_fuel": [],  # Fuel ullage volume
            "V_u_ox": [],  # Oxidizer ullage volume
            "mdot_F": [],
            "mdot_O": [],
        }
        
        u_prev = None
        
        for i, t in enumerate(time_array):
            # Update command if using thrust curve
            if request.cmd.command_type == "thrust_desired" and request.thrust_curve:
                # Interpolate thrust from curve
                if request.time_array and len(request.time_array) == len(request.thrust_curve):
                    # Interpolate
                    thrust_val = np.interp(t, request.time_array, request.thrust_curve)
                    cmd = Command(
                        command_type=CommandType.THRUST_DESIRED,
                        thrust_desired=float(thrust_val),
                    )
            
            # Controller step
            actuation, diagnostics = _controller.step(meas, nav, cmd)
            
            # Get DDP solution for value function
            solution = diagnostics.get("solution")
            value_func = solution.objective if solution and hasattr(solution, 'objective') else 0.0
            
            # Get control effort
            u_relaxed = diagnostics.get("u_relaxed", np.array([0.0, 0.0]))
            if u_prev is not None:
                control_effort = float(np.linalg.norm(u_relaxed - u_prev))
            else:
                control_effort = float(np.linalg.norm(u_relaxed))
            u_prev = u_relaxed.copy()
            
            # Get engine estimate from diagnostics (computed once in controller)
            eng_est = diagnostics.get("eng_est")
            
            # Get state from diagnostics if available, otherwise use current x
            x_current = diagnostics.get("x", x)
            
            # Store results
            results["time"].append(float(t))
            results["thrust_ref"].append(diagnostics.get("F_ref", 0.0) if isinstance(diagnostics.get("F_ref"), (int, float)) else 0.0)
            results["thrust_actual"].append(diagnostics.get("F_hat", 0.0) if isinstance(diagnostics.get("F_hat"), (int, float)) else 0.0)
            results["MR"].append(diagnostics.get("MR_hat", 0.0) if isinstance(diagnostics.get("MR_hat"), (int, float)) else 0.0)
            results["P_copv"].append(float(meas.P_copv))
            results["P_reg"].append(float(meas.P_reg))
            results["P_u_fuel"].append(float(meas.P_u_fuel))
            results["P_u_ox"].append(float(meas.P_u_ox))
            results["P_d_fuel"].append(float(meas.P_d_fuel))
            results["P_d_ox"].append(float(meas.P_d_ox))
            results["P_ch"].append(diagnostics.get("P_ch", 0.0) if isinstance(diagnostics.get("P_ch"), (int, float)) else 0.0)
            results["duty_F"].append(float(actuation.duty_F))
            results["duty_O"].append(float(actuation.duty_O))
            results["altitude"].append(float(nav.h))
            results["velocity"].append(float(nav.vz))
            results["value_function"].append(value_func)
            results["control_effort"].append(control_effort)
            results["V_u_fuel"].append(float(x_current[IDX_V_U_F]))
            results["V_u_ox"].append(float(x_current[IDX_V_U_O]))
            results["mdot_F"].append(float(eng_est.mdot_F) if eng_est and hasattr(eng_est, 'mdot_F') and np.isfinite(eng_est.mdot_F) else 0.0)
            results["mdot_O"].append(float(eng_est.mdot_O) if eng_est and hasattr(eng_est, 'mdot_O') and np.isfinite(eng_est.mdot_O) else 0.0)
            
            # Update state using actual dynamics
            # Get mass flows from engine (pressure-dependent, NOT gated by control)
            # CRITICAL: Mass flow to chamber is ALWAYS happening (pressure-dependent)
            # Control input (u) only affects gas flow INTO tanks, not propellant flow OUT
            # Propellant flows out based on feed pressure and injector characteristics
            mdot_F = float(eng_est.mdot_F) if eng_est and hasattr(eng_est, 'mdot_F') and np.isfinite(eng_est.mdot_F) else 0.0
            mdot_O = float(eng_est.mdot_O) if eng_est and hasattr(eng_est, 'mdot_O') and np.isfinite(eng_est.mdot_O) else 0.0
            
            # CRITICAL: Use ACTUAL actuation state (duty cycle or on/off), not relaxed control
            # PWM duty cycle means valve is either fully open or fully closed, switching at high frequency
            # For dynamics, we need to model the discrete on/off behavior, not continuous flow
            # Use duty cycle as the "fraction of time valve is open" for the time step
            # This creates the spikes/ripple when valves open and close
            
            # Get actuation command (has duty cycles and on/off states)
            duty_F = float(actuation.duty_F)  # Duty cycle [0, 1] - fraction of time valve is open
            duty_O = float(actuation.duty_O)  # Duty cycle [0, 1]
            
            # For discrete modeling: duty cycle represents fraction of dt that valve is open
            # During that time, valve is fully open (u=1), otherwise closed (u=0)
            # Average effect over dt: u_effective = duty_cycle
            # But for realistic spikes, we should model the on/off switching
            # For now, use duty cycle as effective control (will create pressure changes)
            u_effective = np.array([duty_F, duty_O], dtype=np.float64)
            
            # Step dynamics (ensure dt is always defined)
            # Dynamics model handles:
            # - Gas flow from COPV->regulator->tanks when valves open (duty > 0)
            # - Blowdown when valves closed (pressure decreases as propellant consumed)
            # - Mass flow to chamber is always happening (pressure-dependent)
            dt_step = float(request.dt) if request.dt is not None else 0.01
            
            # Validate state before stepping
            if len(x) != N_STATE:
                raise ValueError(f"State vector has wrong size before step: expected {N_STATE}, got {len(x)}")
            
            # Use effective control (duty cycle) for dynamics
            x_next = dynamics_step(x, u_effective, dt_step, dynamics_params, mdot_F, mdot_O)
            
            # Validate state after stepping
            if len(x_next) != N_STATE:
                raise ValueError(f"State vector has wrong size after step: expected {N_STATE}, got {len(x_next)}")
            
            # Update measurements from state
            meas.P_copv = x_next[IDX_P_COPV]
            meas.P_reg = x_next[IDX_P_REG]
            meas.P_u_fuel = x_next[IDX_P_U_F]
            meas.P_u_ox = x_next[IDX_P_U_O]
            meas.P_d_fuel = x_next[IDX_P_D_F]
            meas.P_d_ox = x_next[IDX_P_D_O]
            
            # Update internal ullage volumes
            _controller.V_u_F = x_next[IDX_V_U_F]
            _controller.V_u_O = x_next[IDX_V_U_O]
            
            # Update nav using flight dynamics integrated with engine physics
            # Use actual thrust from engine to compute acceleration
            F_actual = diagnostics.get("F_hat", 0.0)
            if isinstance(F_actual, (int, float)) and F_actual > 0:
                # Flight dynamics: a = F/m - g
                # Account for propellant consumption
                mass = nav.mass_estimate or 100.0
                if eng_est:
                    mdot_total = (eng_est.mdot_F or 0.0) + (eng_est.mdot_O or 0.0)
                    mass -= mdot_total * dt_step
                    nav.mass_estimate = max(mass, 50.0)  # Minimum mass
                
                # Compute acceleration (accounting for gravity and drag if needed)
                # For now, simple vertical flight: a = F/m - g
                # In full implementation, would integrate with RocketPy for drag, etc.
                acceleration = (F_actual / nav.mass_estimate) - 9.81
                nav.vz += acceleration * dt_step
                nav.h += nav.vz * dt_step
            else:
                # No thrust - ballistic (gravity only)
                nav.vz -= 9.81 * dt_step
                nav.h += nav.vz * dt_step
            
            # Update state for next iteration
            # CRITICAL: Use x_next directly - it contains all updated values including gas masses
            # Don't rebuild from measurements, as gas masses aren't in measurements
            x = x_next.copy()  # Make a copy to avoid reference issues
        
        return convert_numpy(results)
        
    except Exception as e:
        import traceback
        error_detail = f"{str(e)}\n\nTraceback:\n{traceback.format_exc()}"
        raise HTTPException(status_code=500, detail=error_detail)


@router.post("/reset")
async def reset_controller():
    """Reset controller state."""
    global _controller
    if _controller is None:
        raise HTTPException(status_code=400, detail="Controller not initialized")
    _controller.reset()
    return {"status": "reset"}


@router.post("/simulate-layer2")
async def simulate_layer2_controller(request: Layer2ControllerSimulateRequest):
    """Run controller simulation using Layer 2 optimized thrust curve as reference."""
    global _controller
    
    # Initialize dt as function-level variable (always defined)
    dt = float(request.dt) if request.dt is not None else 0.01
    
    # Initialize controller if needed
    if _controller is None:
        try:
            cfg = get_default_config()
            if not app_state.has_config():
                raise HTTPException(
                    status_code=400,
                    detail="No engine config loaded. Load a config first."
                )
            engine_config = app_state.config
            _controller = RobustDDPController(cfg, engine_config, logger=None)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to initialize controller: {e}")
    
    try:
        # Use Layer 2 thrust curve as reference
        time_array = np.array(request.thrust_curve_time)
        thrust_curve = np.array(request.thrust_curve_values)
        
        # Validate inputs
        if len(time_array) == 0:
            raise HTTPException(status_code=400, detail="Time array is empty")
        if len(thrust_curve) == 0:
            raise HTTPException(status_code=400, detail="Thrust curve is empty")
        if len(time_array) != len(thrust_curve):
            raise HTTPException(status_code=400, detail=f"Time array length ({len(time_array)}) doesn't match thrust curve length ({len(thrust_curve)})")
        
        duration = float(time_array[-1])
        
        # Compute dt from time array (use differences, fallback to function-level dt)
        # Override default if we have multiple time points
        if len(time_array) > 1:
            try:
                dt = float(np.mean(np.diff(time_array)))
            except (ValueError, TypeError):
                # Fallback to default if computation fails
                dt = float(request.dt) if request.dt is not None else 0.01
        
        # Default initial conditions if not provided
        if request.initial_meas is None:
            # Use reasonable defaults based on typical Layer 2 results
            meas = Measurement(
                P_copv=18.96e6,  # ~2750 psi
                P_reg=6.89e6,    # ~1000 psi
                P_u_fuel=6.89e6,  # ~1000 psi (regulated)
                P_u_ox=6.89e6,    # ~1000 psi (regulated)
                P_d_fuel=6.89e6,  # Start at ullage pressure
                P_d_ox=6.89e6,    # Start at ullage pressure
            )
        else:
            meas = Measurement(
                P_copv=request.initial_meas.P_copv,
                P_reg=request.initial_meas.P_reg,
                P_u_fuel=request.initial_meas.P_u_fuel,
                P_u_ox=request.initial_meas.P_u_ox,
                P_d_fuel=request.initial_meas.P_d_fuel,
                P_d_ox=request.initial_meas.P_d_ox,
            )
        
        if request.initial_nav is None:
            nav = NavState(h=0.0, vz=0.0, theta=0.0, mass_estimate=100.0)
        else:
            nav = NavState(
                h=request.initial_nav.h,
                vz=request.initial_nav.vz,
                theta=request.initial_nav.theta,
                mass_estimate=request.initial_nav.mass_estimate,
            )
        
        # Build piecewise thrust command from Layer 2 curve
        thrust_schedule = list(zip(time_array.tolist(), thrust_curve.tolist()))
        cmd = Command(
            command_type=CommandType.THRUST_DESIRED,
            thrust_desired=thrust_schedule,
        )
        
        # Import dynamics for state propagation
        from engine.control.robust_ddp.dynamics import step as dynamics_step, DynamicsParams
        from engine.control.robust_ddp.dynamics import IDX_P_COPV, IDX_P_REG, IDX_P_U_F, IDX_P_U_O, IDX_P_D_F, IDX_P_D_O, IDX_V_U_F, IDX_V_U_O
        
        # Get dynamics params
        dynamics_params = DynamicsParams.from_config(_controller.cfg)
        
        # Build initial state vector
        x = _controller._build_state(meas)
        
        # Simulate over Layer 2 time array
        n_steps = len(time_array)
        results = {
            "time": [],
            "thrust_ref": [],
            "thrust_actual": [],
            "MR": [],
            "P_copv": [],
            "P_reg": [],
            "P_u_fuel": [],
            "P_u_ox": [],
            "P_d_fuel": [],
            "P_d_ox": [],
            "P_ch": [],
            "duty_F": [],
            "duty_O": [],
            "altitude": [],
            "velocity": [],
            "value_function": [],
            "control_effort": [],
            "V_u_fuel": [],
            "V_u_ox": [],
            "mdot_F": [],
            "mdot_O": [],
            "w_bar": [],  # Robustness bounds
            "constraint_margins": [],  # Constraint safety margins
        }
        
        u_prev = None
        
        for i, t in enumerate(time_array):
            # Interpolate thrust reference from Layer 2 curve
            if i < len(thrust_curve):
                thrust_ref = float(thrust_curve[i])
            else:
                thrust_ref = float(thrust_curve[-1]) if len(thrust_curve) > 0 else 0.0
            
            # Update command with current reference
            cmd = Command(
                command_type=CommandType.THRUST_DESIRED,
                thrust_desired=thrust_ref,
            )
            
            # Controller step
            actuation, diagnostics = _controller.step(meas, nav, cmd)
            
            # Get diagnostics
            eng_est = diagnostics.get("eng_est")
            solution = diagnostics.get("solution")
            value_func = solution.objective if solution and hasattr(solution, 'objective') else 0.0
            
            # Get control effort
            u_relaxed = diagnostics.get("u_relaxed", np.array([0.0, 0.0]))
            if u_prev is not None:
                control_effort = float(np.linalg.norm(u_relaxed - u_prev))
            else:
                control_effort = float(np.linalg.norm(u_relaxed))
            u_prev = u_relaxed.copy()
            
            # Get robustness bounds
            from engine.control.robust_ddp.robustness import get_w_bar_array
            w_bar = get_w_bar_array(_controller.state).tolist()
            
            # Get constraint margins
            constraint_margins = diagnostics.get("constraint_margins", {})
            
            # Store results
            results["time"].append(float(t))
            results["thrust_ref"].append(thrust_ref)
            results["thrust_actual"].append(float(diagnostics.get("F_hat", 0.0)))
            results["MR"].append(float(eng_est.MR) if eng_est and eng_est.MR else 0.0)
            results["P_copv"].append(float(meas.P_copv))
            results["P_reg"].append(float(meas.P_reg))
            results["P_u_fuel"].append(float(meas.P_u_fuel))
            results["P_u_ox"].append(float(meas.P_u_ox))
            results["P_d_fuel"].append(float(meas.P_d_fuel))
            results["P_d_ox"].append(float(meas.P_d_ox))
            results["P_ch"].append(float(eng_est.P_ch) if eng_est and eng_est.P_ch else 0.0)
            results["duty_F"].append(float(actuation.duty_F))
            results["duty_O"].append(float(actuation.duty_O))
            results["altitude"].append(float(nav.h))
            results["velocity"].append(float(nav.vz))
            results["value_function"].append(value_func)
            results["control_effort"].append(control_effort)
            results["V_u_fuel"].append(float(_controller.V_u_F))
            results["V_u_ox"].append(float(_controller.V_u_O))
            results["mdot_F"].append(float(eng_est.mdot_F) if eng_est and eng_est.mdot_F else 0.0)
            results["mdot_O"].append(float(eng_est.mdot_O) if eng_est and eng_est.mdot_O else 0.0)
            results["w_bar"].append(w_bar)
            results["constraint_margins"].append(constraint_margins)
            
            # Propagate state using dynamics
            # Use actual time step from array (may vary)
            if i < len(time_array) - 1:
                dt_step = float(time_array[i+1] - time_array[i])
            else:
                # Last iteration - use average dt (always defined at start of try block)
                dt_step = dt
            
            u_relaxed_array = np.array([actuation.duty_F, actuation.duty_O])
            
            # Get mass flows from engine estimate
            mdot_F = float(eng_est.mdot_F) if eng_est and hasattr(eng_est, 'mdot_F') and eng_est.mdot_F is not None else 0.0
            mdot_O = float(eng_est.mdot_O) if eng_est and hasattr(eng_est, 'mdot_O') and eng_est.mdot_O is not None else 0.0
            
            x_next = dynamics_step(x, u_relaxed_array, dt_step, dynamics_params, mdot_F, mdot_O)
            
            # Update measurements from state
            meas.P_copv = x_next[IDX_P_COPV]
            meas.P_reg = x_next[IDX_P_REG]
            meas.P_u_fuel = x_next[IDX_P_U_F]
            meas.P_u_ox = x_next[IDX_P_U_O]
            meas.P_d_fuel = x_next[IDX_P_D_F]
            meas.P_d_ox = x_next[IDX_P_D_O]
            
            # Update internal ullage volumes
            _controller.V_u_F = x_next[IDX_V_U_F]
            _controller.V_u_O = x_next[IDX_V_U_O]
            
            # Update nav using flight dynamics
            F_actual = diagnostics.get("F_hat", 0.0)
            if isinstance(F_actual, (int, float)) and F_actual > 0:
                mass = nav.mass_estimate or 100.0
                if eng_est:
                    mdot_total = (eng_est.mdot_F or 0.0) + (eng_est.mdot_O or 0.0)
                    mass -= mdot_total * dt_step
                    nav.mass_estimate = max(mass, 50.0)
                
                acceleration = (F_actual / nav.mass_estimate) - 9.81
                nav.vz += acceleration * dt_step
                nav.h += nav.vz * dt_step
            else:
                nav.vz -= 9.81 * dt_step
                nav.h += nav.vz * dt_step
            
            # Update state for next iteration
            # CRITICAL: Use x_next directly - it contains all updated values including gas masses
            # Don't rebuild from measurements, as gas masses aren't in measurements
            x = x_next.copy()  # Make a copy to avoid reference issues
        
        return convert_numpy(results)
        
    except Exception as e:
        import traceback
        error_detail = f"Controller simulation failed: {str(e)}\n\nTraceback:\n{traceback.format_exc()}"
        raise HTTPException(status_code=500, detail=error_detail)


@router.post("/simulate-layer2-stream")
async def simulate_layer2_controller_stream(request: Layer2ControllerSimulateRequest):
    """Stream controller simulation in real-time using Layer 2 optimized thrust curve."""
    global _controller
    
    def safe_json_dumps(obj):
        """Safely serialize to JSON, handling non-serializable types."""
        return json.dumps(convert_numpy(obj), allow_nan=False)
    
    async def event_generator():
        global _controller
        
        # Initialize dt as function-level variable (always defined)
        dt = float(request.dt) if request.dt is not None else 0.01
        
        # Always reinitialize controller with fresh config to ensure latest settings
        try:
            cfg = get_default_config()
            if not app_state.has_config():
                yield f"data: {safe_json_dumps({'type': 'error', 'error': 'No engine config loaded. Load a config first.'})}\n\n"
                return
            engine_config = app_state.config
            _controller = RobustDDPController(cfg, engine_config, logger=None)
            _controller.reset()  # Reset to ensure fresh state
        except Exception as e:
            yield f"data: {safe_json_dumps({'type': 'error', 'error': f'Failed to initialize controller: {e}'})}\n\n"
            return
        
        try:
            # Use Layer 2 thrust curve as reference
            time_array = np.array(request.thrust_curve_time)
            thrust_curve = np.array(request.thrust_curve_values)
            
            # Validate inputs
            if len(time_array) == 0:
                yield f"data: {safe_json_dumps({'type': 'error', 'error': 'Time array is empty'})}\n\n"
                return
            if len(thrust_curve) == 0:
                yield f"data: {safe_json_dumps({'type': 'error', 'error': 'Thrust curve is empty'})}\n\n"
                return
            if len(time_array) != len(thrust_curve):
                error_msg = f"Time array length ({len(time_array)}) doesn't match thrust curve length ({len(thrust_curve)})"
                yield f"data: {safe_json_dumps({'type': 'error', 'error': error_msg})}\n\n"
                return
            
            duration = float(time_array[-1])
            n_steps = len(time_array)
            
            # Compute dt from time array
            if len(time_array) > 1:
                try:
                    dt = float(np.mean(np.diff(time_array)))
                except (ValueError, TypeError):
                    dt = float(request.dt) if request.dt is not None else 0.01
            
            # Send initial status
            yield f"data: {safe_json_dumps({'type': 'status', 'progress': 0.0, 'stage': 'Initializing', 'message': f'Starting simulation for {n_steps} steps...'})}\n\n"
            
            # Default initial conditions
            if request.initial_meas is None:
                meas = Measurement(
                    P_copv=18.96e6, P_reg=6.89e6,
                    P_u_fuel=6.89e6, P_u_ox=6.89e6,
                    P_d_fuel=6.89e6, P_d_ox=6.89e6,
                )
            else:
                meas = Measurement(
                    P_copv=request.initial_meas.P_copv,
                    P_reg=request.initial_meas.P_reg,
                    P_u_fuel=request.initial_meas.P_u_fuel,
                    P_u_ox=request.initial_meas.P_u_ox,
                    P_d_fuel=request.initial_meas.P_d_fuel,
                    P_d_ox=request.initial_meas.P_d_ox,
                )
            
            if request.initial_nav is None:
                nav = NavState(h=0.0, vz=0.0, theta=0.0, mass_estimate=100.0)
            else:
                nav = NavState(
                    h=request.initial_nav.h,
                    vz=request.initial_nav.vz,
                    theta=request.initial_nav.theta,
                    mass_estimate=request.initial_nav.mass_estimate,
                )
            
            # Import dynamics
            from engine.control.robust_ddp.dynamics import step as dynamics_step, DynamicsParams
            from engine.control.robust_ddp.dynamics import IDX_P_COPV, IDX_P_REG, IDX_P_U_F, IDX_P_U_O, IDX_P_D_F, IDX_P_D_O, IDX_V_U_F, IDX_V_U_O
            
            dynamics_params = DynamicsParams.from_config(_controller.cfg)
            x = _controller._build_state(meas)
            u_prev = None
            
            # Simulate and stream results
            for i, t in enumerate(time_array):
                progress = (i + 1) / n_steps
                
                # Interpolate thrust reference
                if i < len(thrust_curve):
                    thrust_ref = float(thrust_curve[i])
                else:
                    thrust_ref = float(thrust_curve[-1]) if len(thrust_curve) > 0 else 0.0
                
                cmd = Command(
                    command_type=CommandType.THRUST_DESIRED,
                    thrust_desired=thrust_ref,
                )
                
                # Controller step
                actuation, diagnostics = _controller.step(meas, nav, cmd)
                
                # Get diagnostics
                eng_est = diagnostics.get("eng_est")
                solution = diagnostics.get("solution")
                value_func = solution.objective if solution and hasattr(solution, 'objective') else 0.0
                
                u_relaxed = diagnostics.get("u_relaxed", np.array([0.0, 0.0]))
                if u_prev is not None:
                    control_effort = float(np.linalg.norm(u_relaxed - u_prev))
                else:
                    control_effort = float(np.linalg.norm(u_relaxed))
                u_prev = u_relaxed.copy()
                
                # Get robustness bounds
                from engine.control.robust_ddp.robustness import get_w_bar_array
                w_bar = get_w_bar_array(_controller.state).tolist()
                constraint_margins = diagnostics.get("constraint_margins", {})
                
                # Stream data point (sanitize all float values to handle NaN/Inf)
                data_point = {
                    "type": "data",
                    "time": safe_float(t),
                    "thrust_ref": safe_float(thrust_ref),
                    "thrust_actual": safe_float(diagnostics.get("F_hat", 0.0)),
                    "MR": safe_float(eng_est.MR if eng_est and eng_est.MR else 0.0),
                    "P_copv": safe_float(meas.P_copv),
                    "P_reg": safe_float(meas.P_reg),
                    "P_u_fuel": safe_float(meas.P_u_fuel),
                    "P_u_ox": safe_float(meas.P_u_ox),
                    "P_d_fuel": safe_float(meas.P_d_fuel),
                    "P_d_ox": safe_float(meas.P_d_ox),
                    "P_ch": safe_float(eng_est.P_ch if eng_est and eng_est.P_ch else 0.0),
                    "duty_F": safe_float(actuation.duty_F),
                    "duty_O": safe_float(actuation.duty_O),
                    "altitude": safe_float(nav.h),
                    "velocity": safe_float(nav.vz),
                    "value_function": safe_float(value_func),
                    "control_effort": safe_float(control_effort),
                    "V_u_fuel": safe_float(_controller.V_u_F),
                    "V_u_ox": safe_float(_controller.V_u_O),
                    "mdot_F": safe_float(eng_est.mdot_F if eng_est and eng_est.mdot_F else 0.0),
                    "mdot_O": safe_float(eng_est.mdot_O if eng_est and eng_est.mdot_O else 0.0),
                    "w_bar": convert_numpy(w_bar),  # Already handles NaN recursively
                    "constraint_margins": convert_numpy(constraint_margins),  # Already handles NaN recursively
                }
                yield f"data: {safe_json_dumps(data_point)}\n\n"
                
                # Update progress every 10 steps or at end
                if (i + 1) % 10 == 0 or i == n_steps - 1:
                    yield f"data: {safe_json_dumps({'type': 'progress', 'progress': progress, 'stage': 'Simulating', 'message': f'Step {i+1}/{n_steps}'})}\n\n"
                
                # Propagate state
                if i < len(time_array) - 1:
                    dt_step = float(time_array[i+1] - time_array[i])
                else:
                    dt_step = dt
                
                u_relaxed_array = np.array([actuation.duty_F, actuation.duty_O])
                mdot_F = float(eng_est.mdot_F) if eng_est and hasattr(eng_est, 'mdot_F') and eng_est.mdot_F is not None else 0.0
                mdot_O = float(eng_est.mdot_O) if eng_est and hasattr(eng_est, 'mdot_O') and eng_est.mdot_O is not None else 0.0
                
                x_next = dynamics_step(x, u_relaxed_array, dt_step, dynamics_params, mdot_F, mdot_O)
                
                # Update measurements
                meas.P_copv = x_next[IDX_P_COPV]
                meas.P_reg = x_next[IDX_P_REG]
                meas.P_u_fuel = x_next[IDX_P_U_F]
                meas.P_u_ox = x_next[IDX_P_U_O]
                meas.P_d_fuel = x_next[IDX_P_D_F]
                meas.P_d_ox = x_next[IDX_P_D_O]
                
                _controller.V_u_F = x_next[IDX_V_U_F]
                _controller.V_u_O = x_next[IDX_V_U_O]
                
                # Update nav
                F_actual = diagnostics.get("F_hat", 0.0)
                if isinstance(F_actual, (int, float)) and F_actual > 0:
                    mass = nav.mass_estimate or 100.0
                    if eng_est:
                        mdot_total = (eng_est.mdot_F or 0.0) + (eng_est.mdot_O or 0.0)
                        mass -= mdot_total * dt_step
                        nav.mass_estimate = max(mass, 50.0)
                    
                    acceleration = (F_actual / nav.mass_estimate) - 9.81
                    nav.vz += acceleration * dt_step
                    nav.h += nav.vz * dt_step
                else:
                    nav.vz -= 9.81 * dt_step
                    nav.h += nav.vz * dt_step
                
                x = x_next
                
                # Small delay to allow UI to update (optional, can be removed for faster simulation)
                await asyncio.sleep(0.01)
            
            # Send completion
            yield f"data: {safe_json_dumps({'type': 'complete', 'progress': 1.0, 'stage': 'Complete', 'message': 'Simulation complete'})}\n\n"
            
        except Exception as e:
            import traceback
            error_detail = f"Controller simulation failed: {str(e)}\n\nTraceback:\n{traceback.format_exc()}"
            yield f"data: {safe_json_dumps({'type': 'error', 'error': error_detail})}\n\n"
    
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"}
    )


@router.post("/simulate-from-config")
async def simulate_from_layer2_config(request: Layer2ConfigSimulateRequest):
    """Run controller simulation from a Layer 2 config file by extracting thrust curve."""
    global _controller
    
    try:
        # Load config
        if request.config_path:
            config = load_engine_config(request.config_path)
        else:
            # Use currently loaded config
            if not app_state.has_config():
                raise HTTPException(
                    status_code=400,
                    detail="No config loaded. Provide config_path or load a config first."
                )
            config = app_state.config
        
        # Check if config has pressure curves
        if not config.pressure_curves:
            raise HTTPException(
                status_code=400,
                detail="Config does not have pressure_curves. This must be a Layer 2 optimized config."
            )
        
        # Import functions to generate pressure curves and evaluate engine
        from engine.optimizer.layers.layer2_pressure import generate_pressure_curve_from_segments
        from engine.core.runner import PintleEngineRunner
        
        # Generate pressure curves from segments
        pc = config.pressure_curves
        n_points = pc.n_points
        burn_time = pc.target_burn_time_s
        
        # Convert segments to dict format
        lox_segments = [
            {
                "length_ratio": seg.length_ratio,
                "type": seg.type,
                "start_pressure": seg.start_pressure_pa,
                "end_pressure": seg.end_pressure_pa,
                "k": seg.k,
            }
            for seg in pc.lox_segments
        ]
        fuel_segments = [
            {
                "length_ratio": seg.length_ratio,
                "type": seg.type,
                "start_pressure": seg.start_pressure_pa,
                "end_pressure": seg.end_pressure_pa,
                "k": seg.k,
            }
            for seg in pc.fuel_segments
        ]
        
        # Generate pressure arrays
        P_lox = generate_pressure_curve_from_segments(lox_segments, n_points)
        P_fuel = generate_pressure_curve_from_segments(fuel_segments, n_points)
        
        # Generate time array
        time_array = np.linspace(0, burn_time, n_points)
        
        # Evaluate engine at each time point to get thrust
        runner = PintleEngineRunner(config)
        thrust_curve = []
        
        for i in range(n_points):
            try:
                results = runner.evaluate(
                    P_tank_O=P_lox[i],
                    P_tank_F=P_fuel[i],
                    silent=True,
                )
                thrust_curve.append(float(results.get("F", 0.0)))
            except Exception as e:
                # If evaluation fails, use previous value or 0
                thrust_curve.append(thrust_curve[-1] if thrust_curve else 0.0)
        
        # Now run controller simulation with extracted thrust curve
        # Convert to Layer2ControllerSimulateRequest format
        layer2_request = Layer2ControllerSimulateRequest(
            thrust_curve_time=time_array.tolist(),
            thrust_curve_values=thrust_curve,
            initial_meas=request.initial_meas,
            initial_nav=request.initial_nav,
            dt=request.dt,
        )
        
        # Call the existing simulate endpoint
        return await simulate_layer2_controller(layer2_request)
        
    except Exception as e:
        import traceback
        error_detail = f"Failed to simulate from config: {str(e)}\n\nTraceback:\n{traceback.format_exc()}"
        raise HTTPException(status_code=500, detail=error_detail)


@router.post("/simulate-from-config-stream")
async def simulate_from_layer2_config_stream(request: Layer2ConfigSimulateRequest):
    """Stream controller simulation from a Layer 2 config file in real-time."""
    global _controller
    
    def safe_json_dumps(obj):
        """Safely serialize to JSON, handling non-serializable types."""
        return json.dumps(convert_numpy(obj), allow_nan=False)
    
    async def event_generator():
        global _controller
        
        try:
            # Load config
            if request.config_path:
                config = load_engine_config(request.config_path)
            else:
                # Use currently loaded config
                if not app_state.has_config():
                    yield f"data: {safe_json_dumps({'type': 'error', 'error': 'No config loaded. Provide config_path or load a config first.'})}\n\n"
                    return
                config = app_state.config
            
            # Check if config has pressure curves
            if not config.pressure_curves:
                yield f"data: {safe_json_dumps({'type': 'error', 'error': 'Config does not have pressure_curves. This must be a Layer 2 optimized config.'})}\n\n"
                return
            
            yield f"data: {safe_json_dumps({'type': 'status', 'progress': 0.0, 'stage': 'Extracting Thrust Curve', 'message': 'Generating pressure curves from config...'})}\n\n"
            
            # Import functions
            from engine.optimizer.layers.layer2_pressure import generate_pressure_curve_from_segments
            from engine.core.runner import PintleEngineRunner
            
            # Generate pressure curves
            pc = config.pressure_curves
            n_points = pc.n_points
            burn_time = pc.target_burn_time_s
            
            lox_segments = [
                {
                    "length_ratio": seg.length_ratio,
                    "type": seg.type,
                    "start_pressure": seg.start_pressure_pa,
                    "end_pressure": seg.end_pressure_pa,
                    "k": seg.k,
                }
                for seg in pc.lox_segments
            ]
            fuel_segments = [
                {
                    "length_ratio": seg.length_ratio,
                    "type": seg.type,
                    "start_pressure": seg.start_pressure_pa,
                    "end_pressure": seg.end_pressure_pa,
                    "k": seg.k,
                }
                for seg in pc.fuel_segments
            ]
            
            P_lox = generate_pressure_curve_from_segments(lox_segments, n_points)
            P_fuel = generate_pressure_curve_from_segments(fuel_segments, n_points)
            time_array = np.linspace(0, burn_time, n_points)
            
            yield f"data: {safe_json_dumps({'type': 'status', 'progress': 0.2, 'stage': 'Evaluating Engine', 'message': 'Computing thrust curve from pressure curves...'})}\n\n"
            
            # Evaluate engine to get thrust
            runner = PintleEngineRunner(config)
            thrust_curve = []
            
            for i in range(n_points):
                try:
                    results = runner.evaluate(
                        P_tank_O=P_lox[i],
                        P_tank_F=P_fuel[i],
                        silent=True,
                    )
                    thrust_curve.append(float(results.get("F", 0.0)))
                except Exception:
                    thrust_curve.append(thrust_curve[-1] if thrust_curve else 0.0)
                
                # Progress update every 20 points
                if (i + 1) % 20 == 0:
                    progress = 0.2 + 0.3 * ((i + 1) / n_points)
                    yield f"data: {safe_json_dumps({'type': 'progress', 'progress': progress, 'stage': 'Evaluating Engine', 'message': f'Evaluated {i+1}/{n_points} points'})}\n\n"
            
            yield f"data: {safe_json_dumps({'type': 'status', 'progress': 0.5, 'stage': 'Starting Controller', 'message': 'Thrust curve extracted. Starting controller simulation...'})}\n\n"
            
            # Now run controller simulation
            layer2_request = Layer2ControllerSimulateRequest(
                thrust_curve_time=time_array.tolist(),
                thrust_curve_values=thrust_curve,
                initial_meas=request.initial_meas,
                initial_nav=request.initial_nav,
                dt=request.dt,
            )
            
            # Reuse the streaming logic from simulate_layer2_controller_stream
            # Initialize controller
            dt = float(request.dt) if request.dt is not None else 0.01
            
            # Always reinitialize controller with fresh config to ensure latest settings
            # This ensures controller uses the most aggressive settings for responsiveness
            cfg = get_default_config()
            if not app_state.has_config():
                yield f"data: {safe_json_dumps({'type': 'error', 'error': 'No engine config loaded. Load a config first.'})}\n\n"
                return
            engine_config = app_state.config
            _controller = RobustDDPController(cfg, engine_config, logger=None)
            _controller.reset()  # Reset to ensure fresh state
            
            # Continue with simulation (reuse code from simulate_layer2_controller_stream)
            # ... (rest of the simulation code)
            # For now, just call the existing stream endpoint logic
            # Actually, let me just forward to the existing endpoint
            # But we can't easily do that with streaming, so let me inline it
            
            # Use the extracted data
            time_array_np = np.array(layer2_request.thrust_curve_time)
            thrust_curve_np = np.array(layer2_request.thrust_curve_values)
            n_steps = len(time_array_np)
            
            # Default initial conditions
            if request.initial_meas is None:
                meas = Measurement(
                    P_copv=18.96e6, P_reg=6.89e6,
                    P_u_fuel=pc.initial_fuel_pressure_pa,
                    P_u_ox=pc.initial_lox_pressure_pa,
                    P_d_fuel=pc.initial_fuel_pressure_pa,
                    P_d_ox=pc.initial_lox_pressure_pa,
                )
            else:
                meas = Measurement(
                    P_copv=request.initial_meas.P_copv,
                    P_reg=request.initial_meas.P_reg,
                    P_u_fuel=request.initial_meas.P_u_fuel,
                    P_u_ox=request.initial_meas.P_u_ox,
                    P_d_fuel=request.initial_meas.P_d_fuel,
                    P_d_ox=request.initial_meas.P_d_ox,
                )
            
            if request.initial_nav is None:
                nav = NavState(h=0.0, vz=0.0, theta=0.0, mass_estimate=100.0)
            else:
                nav = NavState(
                    h=request.initial_nav.h,
                    vz=request.initial_nav.vz,
                    theta=request.initial_nav.theta,
                    mass_estimate=request.initial_nav.mass_estimate,
                )
            
            from engine.control.robust_ddp.dynamics import step as dynamics_step, DynamicsParams
            from engine.control.robust_ddp.dynamics import IDX_P_COPV, IDX_P_REG, IDX_P_U_F, IDX_P_U_O, IDX_P_D_F, IDX_P_D_O, IDX_V_U_F, IDX_V_U_O
            
            dynamics_params = DynamicsParams.from_config(_controller.cfg)
            x = _controller._build_state(meas)
            u_prev = None
            
            # Simulate and stream
            for i, t in enumerate(time_array_np):
                progress = 0.5 + 0.5 * ((i + 1) / n_steps)
                
                if i < len(thrust_curve_np):
                    thrust_ref = float(thrust_curve_np[i])
                else:
                    thrust_ref = float(thrust_curve_np[-1]) if len(thrust_curve_np) > 0 else 0.0
                
                cmd = Command(
                    command_type=CommandType.THRUST_DESIRED,
                    thrust_desired=thrust_ref,
                )
                
                actuation, diagnostics = _controller.step(meas, nav, cmd)
                
                eng_est = diagnostics.get("eng_est")
                solution = diagnostics.get("solution")
                value_func = solution.objective if solution and hasattr(solution, 'objective') else 0.0
                
                u_relaxed = diagnostics.get("u_relaxed", np.array([0.0, 0.0]))
                if u_prev is not None:
                    control_effort = float(np.linalg.norm(u_relaxed - u_prev))
                else:
                    control_effort = float(np.linalg.norm(u_relaxed))
                u_prev = u_relaxed.copy()
                
                # Get robustness bounds
                from engine.control.robust_ddp.robustness import get_w_bar_array
                w_bar = get_w_bar_array(_controller.state).tolist()
                constraint_margins = diagnostics.get("constraint_margins", {})
                
                # Stream data point
                # Stream data point (sanitize all float values to handle NaN/Inf)
                data_point = {
                    "type": "data",
                    "time": safe_float(t),
                    "thrust_ref": safe_float(thrust_ref),
                    "thrust_actual": safe_float(diagnostics.get("F_hat", 0.0)),
                    "MR": safe_float(eng_est.MR if eng_est and eng_est.MR else 0.0),
                    "P_copv": safe_float(meas.P_copv),
                    "P_reg": safe_float(meas.P_reg),
                    "P_u_fuel": safe_float(meas.P_u_fuel),
                    "P_u_ox": safe_float(meas.P_u_ox),
                    "P_d_fuel": safe_float(meas.P_d_fuel),
                    "P_d_ox": safe_float(meas.P_d_ox),
                    "P_ch": safe_float(eng_est.P_ch if eng_est and eng_est.P_ch else 0.0),
                    "duty_F": safe_float(actuation.duty_F),
                    "duty_O": safe_float(actuation.duty_O),
                    "altitude": safe_float(nav.h),
                    "velocity": safe_float(nav.vz),
                    "value_function": safe_float(value_func),
                    "control_effort": safe_float(control_effort),
                    "V_u_fuel": safe_float(_controller.V_u_F),
                    "V_u_ox": safe_float(_controller.V_u_O),
                    "mdot_F": safe_float(eng_est.mdot_F if eng_est and eng_est.mdot_F else 0.0),
                    "mdot_O": safe_float(eng_est.mdot_O if eng_est and eng_est.mdot_O else 0.0),
                    "w_bar": convert_numpy(w_bar),  # Already handles NaN recursively
                    "constraint_margins": convert_numpy(constraint_margins),  # Already handles NaN recursively
                }
                yield f"data: {safe_json_dumps(data_point)}\n\n"
                
                if (i + 1) % 10 == 0 or i == n_steps - 1:
                    yield f"data: {safe_json_dumps({'type': 'progress', 'progress': progress, 'stage': 'Simulating', 'message': f'Step {i+1}/{n_steps}'})}\n\n"
                
                # Propagate state
                if i < len(time_array_np) - 1:
                    dt_step = float(time_array_np[i+1] - time_array_np[i])
                else:
                    dt_step = dt
                
                u_relaxed_array = np.array([actuation.duty_F, actuation.duty_O])
                mdot_F = float(eng_est.mdot_F) if eng_est and hasattr(eng_est, 'mdot_F') and eng_est.mdot_F is not None else 0.0
                mdot_O = float(eng_est.mdot_O) if eng_est and hasattr(eng_est, 'mdot_O') and eng_est.mdot_O is not None else 0.0
                
                x_next = dynamics_step(x, u_relaxed_array, dt_step, dynamics_params, mdot_F, mdot_O)
                
                meas.P_copv = x_next[IDX_P_COPV]
                meas.P_reg = x_next[IDX_P_REG]
                meas.P_u_fuel = x_next[IDX_P_U_F]
                meas.P_u_ox = x_next[IDX_P_U_O]
                meas.P_d_fuel = x_next[IDX_P_D_F]
                meas.P_d_ox = x_next[IDX_P_D_O]
                
                _controller.V_u_F = x_next[IDX_V_U_F]
                _controller.V_u_O = x_next[IDX_V_U_O]
                
                F_actual = diagnostics.get("F_hat", 0.0)
                if isinstance(F_actual, (int, float)) and F_actual > 0:
                    mass = nav.mass_estimate or 100.0
                    if eng_est:
                        mdot_total = (eng_est.mdot_F or 0.0) + (eng_est.mdot_O or 0.0)
                        mass -= mdot_total * dt_step
                        nav.mass_estimate = max(mass, 50.0)
                    
                    acceleration = (F_actual / nav.mass_estimate) - 9.81
                    nav.vz += acceleration * dt_step
                    nav.h += nav.vz * dt_step
                else:
                    nav.vz -= 9.81 * dt_step
                    nav.h += nav.vz * dt_step
                
                x = x_next
                await asyncio.sleep(0.01)
            
            yield f"data: {safe_json_dumps({'type': 'complete', 'progress': 1.0, 'stage': 'Complete', 'message': 'Simulation complete'})}\n\n"
            
        except Exception as e:
            import traceback
            error_detail = f"Failed to simulate from config: {str(e)}\n\nTraceback:\n{traceback.format_exc()}"
            yield f"data: {safe_json_dumps({'type': 'error', 'error': error_detail})}\n\n"
    
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"}
    )


@router.post("/upload-config-and-simulate")
async def upload_config_and_simulate(
    file: UploadFile = File(...),
    dt: float = 0.01,
):
    """Upload a Layer 2 config file and immediately run controller simulation."""
    def safe_json_dumps(obj):
        """Safely serialize to JSON, handling non-serializable types."""
        return json.dumps(convert_numpy(obj), allow_nan=False)
    
    async def event_generator():
        global _controller
        
        try:
            # Read uploaded file
            contents = await file.read()
            config_dict = yaml.safe_load(contents.decode("utf-8"))
            
            # Load config
            from engine.pipeline.config_schemas import PintleEngineConfig
            config = PintleEngineConfig(**config_dict)
            
            # Check if config has pressure curves
            if not config.pressure_curves:
                yield f"data: {safe_json_dumps({'type': 'error', 'error': 'Config does not have pressure_curves. This must be a Layer 2 optimized config.'})}\n\n"
                return
            
            yield f"data: {safe_json_dumps({'type': 'status', 'progress': 0.0, 'stage': 'Extracting Thrust Curve', 'message': 'Generating pressure curves from config...'})}\n\n"
            
            # Import functions
            from engine.optimizer.layers.layer2_pressure import generate_pressure_curve_from_segments
            from engine.core.runner import PintleEngineRunner
            
            # Generate pressure curves
            pc = config.pressure_curves
            n_points = pc.n_points
            burn_time = pc.target_burn_time_s
            
            lox_segments = [
                {
                    "length_ratio": seg.length_ratio,
                    "type": seg.type,
                    "start_pressure": seg.start_pressure_pa,
                    "end_pressure": seg.end_pressure_pa,
                    "k": seg.k,
                }
                for seg in pc.lox_segments
            ]
            fuel_segments = [
                {
                    "length_ratio": seg.length_ratio,
                    "type": seg.type,
                    "start_pressure": seg.start_pressure_pa,
                    "end_pressure": seg.end_pressure_pa,
                    "k": seg.k,
                }
                for seg in pc.fuel_segments
            ]
            
            P_lox = generate_pressure_curve_from_segments(lox_segments, n_points)
            P_fuel = generate_pressure_curve_from_segments(fuel_segments, n_points)
            time_array = np.linspace(0, burn_time, n_points)
            
            yield f"data: {safe_json_dumps({'type': 'status', 'progress': 0.2, 'stage': 'Evaluating Engine', 'message': 'Computing thrust curve from pressure curves...'})}\n\n"
            
            # Temporarily set app_state config for engine evaluation
            original_config = app_state.config if app_state.has_config() else None
            app_state.set_config(config)
            
            try:
                # Evaluate engine to get thrust
                runner = PintleEngineRunner(config)
                thrust_curve = []
                
                for i in range(n_points):
                    try:
                        results = runner.evaluate(
                            P_tank_O=P_lox[i],
                            P_tank_F=P_fuel[i],
                            silent=True,
                        )
                        thrust_curve.append(float(results.get("F", 0.0)))
                    except Exception:
                        thrust_curve.append(thrust_curve[-1] if thrust_curve else 0.0)
                    
                    # Progress update every 20 points
                    if (i + 1) % 20 == 0:
                        progress = 0.2 + 0.3 * ((i + 1) / n_points)
                        yield f"data: {safe_json_dumps({'type': 'progress', 'progress': progress, 'stage': 'Evaluating Engine', 'message': f'Evaluated {i+1}/{n_points} points'})}\n\n"
                
                yield f"data: {safe_json_dumps({'type': 'status', 'progress': 0.5, 'stage': 'Starting Controller', 'message': 'Thrust curve extracted. Starting controller simulation...'})}\n\n"
                
                # Initialize controller
                dt_val = float(dt)
                
                if _controller is None:
                    cfg = get_default_config()
                    engine_config = config  # Use the uploaded config
                    _controller = RobustDDPController(cfg, engine_config, logger=None)
                
                # Default initial conditions from config
                meas = Measurement(
                    P_copv=18.96e6, P_reg=6.89e6,
                    P_u_fuel=pc.initial_fuel_pressure_pa,
                    P_u_ox=pc.initial_lox_pressure_pa,
                    P_d_fuel=pc.initial_fuel_pressure_pa,
                    P_d_ox=pc.initial_lox_pressure_pa,
                )
                
                nav = NavState(h=0.0, vz=0.0, theta=0.0, mass_estimate=100.0)
                
                from engine.control.robust_ddp.dynamics import step as dynamics_step, DynamicsParams
                from engine.control.robust_ddp.dynamics import IDX_P_COPV, IDX_P_REG, IDX_P_U_F, IDX_P_U_O, IDX_P_D_F, IDX_P_D_O, IDX_V_U_F, IDX_V_U_O
                
                dynamics_params = DynamicsParams.from_config(_controller.cfg)
                x = _controller._build_state(meas)
                u_prev = None
                
                # Simulate and stream
                for i, t in enumerate(time_array):
                    progress = 0.5 + 0.5 * ((i + 1) / n_points)
                    
                    if i < len(thrust_curve):
                        thrust_ref = float(thrust_curve[i])
                    else:
                        thrust_ref = float(thrust_curve[-1]) if len(thrust_curve) > 0 else 0.0
                    
                    cmd = Command(
                        command_type=CommandType.THRUST_DESIRED,
                        thrust_desired=thrust_ref,
                    )
                    
                    actuation, diagnostics = _controller.step(meas, nav, cmd)
                    
                    eng_est = diagnostics.get("eng_est")
                    solution = diagnostics.get("solution")
                    value_func = solution.objective if solution and hasattr(solution, 'objective') else 0.0
                    
                    u_relaxed = diagnostics.get("u_relaxed", np.array([0.0, 0.0]))
                    if u_prev is not None:
                        control_effort = float(np.linalg.norm(u_relaxed - u_prev))
                    else:
                        control_effort = float(np.linalg.norm(u_relaxed))
                    u_prev = u_relaxed.copy()
                    
                    # Get robustness bounds
                    from engine.control.robust_ddp.robustness import get_w_bar_array
                    w_bar = get_w_bar_array(_controller.state).tolist()
                    constraint_margins = diagnostics.get("constraint_margins", {})
                    
                    # Stream data point (sanitize all float values to handle NaN/Inf)
                    data_point = {
                        "type": "data",
                        "time": safe_float(t),
                        "thrust_ref": safe_float(thrust_ref),
                        "thrust_actual": safe_float(diagnostics.get("F_hat", 0.0)),
                        "MR": safe_float(eng_est.MR if eng_est and eng_est.MR else 0.0),
                        "P_copv": safe_float(meas.P_copv),
                        "P_reg": safe_float(meas.P_reg),
                        "P_u_fuel": safe_float(meas.P_u_fuel),
                        "P_u_ox": safe_float(meas.P_u_ox),
                        "P_d_fuel": safe_float(meas.P_d_fuel),
                        "P_d_ox": safe_float(meas.P_d_ox),
                        "P_ch": safe_float(eng_est.P_ch if eng_est and eng_est.P_ch else 0.0),
                        "duty_F": safe_float(actuation.duty_F),
                        "duty_O": safe_float(actuation.duty_O),
                        "altitude": safe_float(nav.h),
                        "velocity": safe_float(nav.vz),
                        "value_function": safe_float(value_func),
                        "control_effort": safe_float(control_effort),
                        "V_u_fuel": safe_float(_controller.V_u_F),
                        "V_u_ox": safe_float(_controller.V_u_O),
                        "mdot_F": safe_float(eng_est.mdot_F if eng_est and eng_est.mdot_F else 0.0),
                        "mdot_O": safe_float(eng_est.mdot_O if eng_est and eng_est.mdot_O else 0.0),
                        "w_bar": convert_numpy(w_bar),  # Already handles NaN recursively
                        "constraint_margins": convert_numpy(constraint_margins),  # Already handles NaN recursively
                    }
                    yield f"data: {safe_json_dumps(data_point)}\n\n"
                    
                    if (i + 1) % 10 == 0 or i == n_points - 1:
                        yield f"data: {safe_json_dumps({'type': 'progress', 'progress': progress, 'stage': 'Simulating', 'message': f'Step {i+1}/{n_points}'})}\n\n"
                    
                    # Propagate state
                    if i < len(time_array) - 1:
                        dt_step = float(time_array[i+1] - time_array[i])
                    else:
                        dt_step = dt_val
                    
                    u_relaxed_array = np.array([actuation.duty_F, actuation.duty_O])
                    mdot_F = float(eng_est.mdot_F) if eng_est and hasattr(eng_est, 'mdot_F') and eng_est.mdot_F is not None else 0.0
                    mdot_O = float(eng_est.mdot_O) if eng_est and hasattr(eng_est, 'mdot_O') and eng_est.mdot_O is not None else 0.0
                    
                    x_next = dynamics_step(x, u_relaxed_array, dt_step, dynamics_params, mdot_F, mdot_O)
                    
                    meas.P_copv = x_next[IDX_P_COPV]
                    meas.P_reg = x_next[IDX_P_REG]
                    meas.P_u_fuel = x_next[IDX_P_U_F]
                    meas.P_u_ox = x_next[IDX_P_U_O]
                    meas.P_d_fuel = x_next[IDX_P_D_F]
                    meas.P_d_ox = x_next[IDX_P_D_O]
                    
                    _controller.V_u_F = x_next[IDX_V_U_F]
                    _controller.V_u_O = x_next[IDX_V_U_O]
                    
                    F_actual = diagnostics.get("F_hat", 0.0)
                    if isinstance(F_actual, (int, float)) and F_actual > 0:
                        mass = nav.mass_estimate or 100.0
                        if eng_est:
                            mdot_total = (eng_est.mdot_F or 0.0) + (eng_est.mdot_O or 0.0)
                            mass -= mdot_total * dt_step
                            nav.mass_estimate = max(mass, 50.0)
                        
                        acceleration = (F_actual / nav.mass_estimate) - 9.81
                        nav.vz += acceleration * dt_step
                        nav.h += nav.vz * dt_step
                    else:
                        nav.vz -= 9.81 * dt_step
                        nav.h += nav.vz * dt_step
                    
                    x = x_next
                    await asyncio.sleep(0.01)
                
                yield f"data: {safe_json_dumps({'type': 'complete', 'progress': 1.0, 'stage': 'Complete', 'message': 'Simulation complete'})}\n\n"
                
            finally:
                # Restore original config
                if original_config:
                    app_state.set_config(original_config)
            
        except Exception as e:
            import traceback
            error_detail = f"Failed to upload and simulate: {str(e)}\n\nTraceback:\n{traceback.format_exc()}"
            yield f"data: {safe_json_dumps({'type': 'error', 'error': error_detail})}\n\n"
    
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"}
    )


@router.get("/status")
async def get_controller_status():
    """Get current controller status."""
    global _controller
    if _controller is None:
        return {"initialized": False}
    
    return {
        "initialized": True,
        "tick": _controller.tick,
        "state": convert_numpy(_controller.state.to_dict()),
    }

