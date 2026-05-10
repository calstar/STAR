"""Optimizer endpoints for design optimization and Layer 1."""

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from typing import Optional, Dict, Any
import asyncio
import json
import traceback
import numpy as np
import threading
import math
import yaml

from backend.state import app_state
from backend.routers.config import config_to_dict
from engine.pipeline.config_schemas import DesignRequirementsConfig
from engine.optimizer.layers.layer1_static_optimization import run_layer1_optimization
from engine.optimizer.layers.layer2_pressure import run_layer2_pressure
from engine.optimizer.layers.layer3_thermal_protection import run_layer3_thermal_protection


def convert_numpy(obj):
    """Recursively convert numpy types to Python native types for JSON serialization."""
    if isinstance(obj, dict):
        return {k: convert_numpy(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [convert_numpy(item) for item in obj]
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    elif isinstance(obj, (np.integer, np.floating)):
        # Convert numpy scalar to Python scalar, then sanitize non-finite floats
        val = obj.item()
        if isinstance(val, float) and not math.isfinite(val):
            return None
        return val
    elif isinstance(obj, np.bool_):
        return bool(obj)
    elif isinstance(obj, bool):
        return bool(obj)
    elif isinstance(obj, float):
        # JSON forbids NaN/Infinity; scrub them here so JSON.parse never fails
        return obj if math.isfinite(obj) else None
    elif isinstance(obj, (int, str, type(None))):
        return obj
    else:
        # Try to convert to string for unknown types
        try:
            return str(obj)
        except:
            return None


def safe_json_dumps(payload: Any) -> str:
    """Strict JSON serialization for SSE: converts numpy + strips NaN/Inf."""
    sanitized = convert_numpy(payload)
    # allow_nan=False ensures we never emit invalid JSON tokens like NaN
    return json.dumps(sanitized, allow_nan=False)

router = APIRouter(prefix="/api/optimizer", tags=["optimizer"])


# Request/Response models
class DesignRequirementsRequest(BaseModel):
    """Request body for saving design requirements."""
    requirements: Dict[str, Any] = Field(..., description="Design requirements dictionary")


class DesignRequirementsResponse(BaseModel):
    """Response for design requirements."""
    requirements: Optional[Dict[str, Any]] = Field(None, description="Design requirements dictionary")


class Layer1Request(BaseModel):
    """Request body for Layer 1 optimization."""
    thrust_tolerance: float = Field(default=0.1, ge=0.01, le=0.2, description="Thrust tolerance (0.1 = 10%)")
    target_burn_time: Optional[float] = Field(default=None, gt=0, description="Target burn time [s] (from design requirements if None)")


class Layer2Request(BaseModel):
    """Request body for Layer 2 optimization."""
    max_iterations: int = Field(default=20, ge=1, le=100, description="Maximum optimization iterations")
    save_plots: bool = Field(default=False, description="Save evaluation plots")


# Global state for optimization status
_optimization_status = {
    "running": False,
    "progress": 0.0,
    "stage": "",
    "message": "",
    "results": None,
    "error": None,
}

_layer2_status = {
    "running": False,
    "progress": 0.0,
    "stage": "",
    "message": "",
    "results": None,
    "error": None,
}

_layer3_status = {
    "running": False,
    "progress": 0.0,
    "stage": "",
    "message": "",
    "results": None,
    "error": None,
}

# Global stop event for optimization cancellation
_stop_event = None
_stop_event_lock = threading.Lock()


@router.post("/design-requirements")
async def save_design_requirements(request: DesignRequirementsRequest):
    """Save design requirements to config."""
    if not app_state.has_config():
        raise HTTPException(
            status_code=400,
            detail="No config loaded. Upload a config file first."
        )
    
    try:
        # Validate requirements using Pydantic
        requirements = DesignRequirementsConfig(**request.requirements)
        
        # Update config with validated requirements
        app_state.config.design_requirements = requirements
        
        return {
            "status": "success",
            "message": "Design requirements saved successfully",
            "requirements": requirements.model_dump()
        }
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to save design requirements: {str(e)}"
        )


@router.get("/design-requirements", response_model=DesignRequirementsResponse)
async def get_design_requirements():
    """Get current design requirements from config."""
    if not app_state.has_config():
        return DesignRequirementsResponse(requirements=None)
    
    if app_state.config.design_requirements is None:
        return DesignRequirementsResponse(requirements=None)
    
    return DesignRequirementsResponse(
        requirements=app_state.config.design_requirements.model_dump()
    )


@router.get("/layer1/status")
async def get_layer1_status():
    """Get Layer 1 optimization status."""
    return {
        "running": _optimization_status["running"],
        "progress": _optimization_status["progress"],
        "stage": _optimization_status["stage"],
        "message": _optimization_status["message"],
        "has_results": _optimization_status["results"] is not None,
        "error": _optimization_status["error"],
    }


@router.get("/layer1/results")
async def get_layer1_results():
    """Get Layer 1 optimization results."""
    if _optimization_status["results"] is None:
        raise HTTPException(
            status_code=404,
            detail="No optimization results available. Run Layer 1 optimization first."
        )
    
    return {
        "status": "success",
        "results": _optimization_status["results"],
    }


@router.get("/layer2/status")
async def get_layer2_status():
    """Get Layer 2 optimization status."""
    return {
        "running": _layer2_status["running"],
        "progress": _layer2_status["progress"],
        "stage": _layer2_status["stage"],
        "message": _layer2_status["message"],
        "has_results": _layer2_status["results"] is not None,
        "error": _layer2_status["error"],
    }


@router.get("/layer2/results")
async def get_layer2_results():
    """Get Layer 2 optimization results."""
    if _layer2_status["results"] is None:
        raise HTTPException(
            status_code=404,
            detail="No Layer 2 optimization results available. Run Layer 2 optimization first."
        )
    
    return {
        "status": "success",
        "results": _layer2_status["results"],
    }


@router.post("/layer2/stop")
async def stop_layer2():
    """Stop the currently running Layer 2 optimization."""
    global _stop_event
    
    if not _layer2_status["running"]:
        raise HTTPException(
            status_code=400,
            detail="No Layer 2 optimization is currently running."
        )
    
    with _stop_event_lock:
        if _stop_event is not None:
            _stop_event.set()
            _layer2_status["message"] = "Stopping optimization..."
            return {
                "status": "success",
                "message": "Stop signal sent to optimizer."
            }
        else:
            return {
                "status": "error",
                "message": "Stop event not initialized."
            }


@router.post("/layer1/stop")
async def stop_layer1():
    """Stop the currently running Layer 1 optimization."""
    global _stop_event
    
    if not _optimization_status["running"]:
        raise HTTPException(
            status_code=400,
            detail="No optimization is currently running."
        )
    
    with _stop_event_lock:
        if _stop_event is not None:
            _stop_event.set()
            _optimization_status["message"] = "Stopping optimization..."
            return {
                "status": "success",
                "message": "Stop signal sent to optimizer."
            }
        else:
            return {
                "status": "error",
                "message": "Stop event not initialized."
            }


@router.get("/layer1")
async def run_layer1(
    thrust_tolerance: float = 0.1,
    target_burn_time: float | None = None,
    report_every_n: int = 1
):
    """Run Layer 1 optimization with Server-Sent Events for progress updates.
    
    Note: max_iterations is hardcoded in the optimizer for consistent robust convergence.
    
    Returns a stream of progress updates in SSE format.
    """
    if not app_state.has_config():
        raise HTTPException(
            status_code=400,
            detail="No config loaded. Upload a config file first."
        )
    
    if not app_state.runner:
        raise HTTPException(
            status_code=400,
            detail="Runner not initialized. Please check config."
        )
    
    # Check for design requirements
    if app_state.config.design_requirements is None:
        raise HTTPException(
            status_code=400,
            detail="No design requirements set. Save design requirements first."
        )
    
    # Check if already running
    if _optimization_status["running"]:
        raise HTTPException(
            status_code=409,
            detail="Optimization already running. Please wait for it to complete."
        )
    
    async def event_generator():
        """Generate SSE events for optimization progress."""
        global _optimization_status, _stop_event
        
        # Create new stop event for this optimization run
        with _stop_event_lock:
            _stop_event = threading.Event()
        
        _optimization_status["running"] = True
        _optimization_status["progress"] = 0.0
        _optimization_status["stage"] = "Initializing"
        _optimization_status["message"] = "Starting Layer 1 optimization..."
        _optimization_status["results"] = None
        _optimization_status["error"] = None
        
        # Send initial status
        yield f"data: {safe_json_dumps({'type': 'status', 'progress': 0.0, 'stage': 'Initializing', 'message': 'Starting optimization...'})}\n\n"
        
        try:
            # Get design requirements
            requirements = app_state.config.design_requirements.model_dump()
            # Add report_every_n to requirements if not already set
            if "report_every_n" not in requirements:
                requirements["report_every_n"] = report_every_n
            burn_time = target_burn_time or requirements.get("target_burn_time", 10.0)
            
            # Prepare pressure config
            pressure_config = {
                "mode": "optimizer_controlled",
                "max_lox_pressure_psi": requirements.get("max_lox_tank_pressure_psi", 700.0),
                "max_fuel_pressure_psi": requirements.get("max_fuel_tank_pressure_psi", 850.0),
                "target_burn_time": burn_time,
                "n_segments": 3,
            }
            
            # Prepare tolerances
            tolerances = {
                "thrust": thrust_tolerance,
                "apogee": 0.15,
            }
            
            # Objective history - use thread-safe list
            objective_history = []
            objective_history_lock = threading.Lock()
            last_sent_objective_count = 0
            
            # Progress callback
            def update_progress(stage: str, progress: float, message: str):
                _optimization_status["progress"] = progress
                _optimization_status["stage"] = stage
                _optimization_status["message"] = message
            
            # Objective callback - thread-safe
            def objective_callback(iteration: int, objective: float, best_objective: float):
                with objective_history_lock:
                    objective_history.append({
                        "iteration": int(iteration),
                        "objective": float(objective),
                        "best_objective": float(best_objective),
                    })
            
            # Run optimization (blocking)
            # Note: This will block the event loop, but for now we'll keep it simple
            # In production, you'd want to run this in a thread pool
            import concurrent.futures
            
            def run_optimization():
                return run_layer1_optimization(
                    config_obj=app_state.config,
                    runner=app_state.runner,
                    requirements=requirements,
                    target_burn_time=burn_time,
                    tolerances=tolerances,
                    pressure_config=pressure_config,
                    update_progress=update_progress,
                    log_status=lambda stage, msg: None,  # Not used for SSE
                    objective_callback=objective_callback,
                    stop_event=_stop_event,  # Pass stop event to optimizer
                )
            
            # Run in thread pool to avoid blocking
            loop = asyncio.get_event_loop()
            with concurrent.futures.ThreadPoolExecutor() as pool:
                # Send progress updates while optimization runs
                future = loop.run_in_executor(pool, run_optimization)
                
                while not future.done():
                    # Send progress update (convert numpy types)
                    progress_data = convert_numpy({
                        'type': 'progress', 
                        'progress': _optimization_status['progress'], 
                        'stage': _optimization_status['stage'], 
                        'message': _optimization_status['message']
                    })
                    yield f"data: {safe_json_dumps(progress_data)}\n\n"
                    
                    # Check for new objective history updates and send them
                    with objective_history_lock:
                        if len(objective_history) > last_sent_objective_count:
                            # Get new entries
                            new_entries = objective_history[last_sent_objective_count:]
                            last_sent_objective_count = len(objective_history)
                            
                            # Send objective update event
                            objective_data = convert_numpy({
                                'type': 'objective',
                                'objective_history': new_entries,
                                'total_count': last_sent_objective_count,
                            })
                            yield f"data: {safe_json_dumps(objective_data)}\n\n"
                    
                    await asyncio.sleep(0.5)
                
                # Get results - check if stopped
                try:
                    optimized_config, results = future.result()
                    # Check if stop was requested after completion
                    with _stop_event_lock:
                        if _stop_event and _stop_event.is_set():
                            _optimization_status["running"] = False
                            _optimization_status["progress"] = 0.0
                            _optimization_status["stage"] = "Stopped"
                            _optimization_status["message"] = "Optimization stopped by user"
                            yield f"data: {safe_json_dumps({'type': 'error', 'error': 'Optimization stopped by user'})}\n\n"
                            return
                except Exception as e:
                    # Check if error was due to stop request
                    with _stop_event_lock:
                        if _stop_event and _stop_event.is_set():
                            _optimization_status["running"] = False
                            _optimization_status["progress"] = 0.0
                            _optimization_status["stage"] = "Stopped"
                            _optimization_status["message"] = "Optimization stopped by user"
                            yield f"data: {safe_json_dumps({'type': 'error', 'error': 'Optimization stopped by user'})}\n\n"
                            return
                    raise
            
            # Update config and recreate runner with new config
            app_state.set_config(optimized_config)
            
            # Store results (convert numpy types for JSON serialization)
            performance = results.get("performance", {})
            # Add target exit pressure to performance for easy access
            exit_pressure_targeting = results.get("exit_pressure_targeting", {})
            if exit_pressure_targeting.get("target_P_exit") is not None:
                performance["target_P_exit"] = exit_pressure_targeting["target_P_exit"]
            
            results_dict = convert_numpy({
                "performance": performance,
                "validation": results.get("validation", {}),
                "geometry": results.get("optimized_parameters", {}),
                "objective_history": objective_history,
                "iteration_history": results.get("iteration_history", []),
                "config": config_to_dict(optimized_config),
                "config_yaml": yaml.dump(config_to_dict(optimized_config), default_flow_style=False),
            })
            _optimization_status["results"] = results_dict
            _optimization_status["progress"] = 1.0
            _optimization_status["stage"] = "Complete"
            _optimization_status["message"] = "Optimization completed successfully"
            
            # Send completion event
            yield f"data: {safe_json_dumps({'type': 'complete', 'results': results_dict})}\n\n"
            
        except Exception as e:
            # Check if this is a stop request
            error_str = str(e).lower()
            if "stopped by user" in error_str or "optimization stopped" in error_str:
                error_msg = "Optimization stopped by user"
                _optimization_status["error"] = None
                _optimization_status["message"] = error_msg
                _optimization_status["stage"] = "Stopped"
                # Send stop event
                yield f"data: {safe_json_dumps({'type': 'error', 'error': error_msg})}\n\n"
            else:
                error_msg = f"Optimization failed: {str(e)}"
                error_trace = traceback.format_exc()
                _optimization_status["error"] = error_msg
                _optimization_status["message"] = error_msg
                # Send error event
                yield f"data: {safe_json_dumps({'type': 'error', 'error': error_msg, 'traceback': error_trace})}\n\n"
        
        finally:
            _optimization_status["running"] = False
            # Clear stop event
            with _stop_event_lock:
                _stop_event = None
    
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # Disable nginx buffering
        }
    )


@router.get("/layer2")
async def run_layer2(
    max_iterations: int = 20,
    save_plots: bool = False,
    de_maxiter: int = 5,
    de_popsize: int = 2,
    de_n_time_points: int = 25
):
    """Run Layer 2 optimization with Server-Sent Events for progress updates."""
    if not app_state.has_config():
        raise HTTPException(
            status_code=400,
            detail="No config loaded. Run Layer 1 or upload a config first."
        )
    
    if not app_state.runner:
        raise HTTPException(
            status_code=400,
            detail="Runner not initialized."
        )
    
    # Check for design requirements
    if app_state.config.design_requirements is None:
        raise HTTPException(
            status_code=400,
            detail="No design requirements set."
        )
    
    # Check if already running
    if _layer2_status["running"]:
        raise HTTPException(
            status_code=409,
            detail="Layer 2 optimization already running."
        )
    
    async def event_generator():
        global _layer2_status, _stop_event
        
        with _stop_event_lock:
            _stop_event = threading.Event()
        
        _layer2_status.update({
            "running": True,
            "progress": 0.0,
            "stage": "Initializing",
            "message": "Starting Layer 2 optimization...",
            "results": None,
            "error": None,
        })
        
        yield f"data: {safe_json_dumps({'type': 'status', 'progress': 0.0, 'stage': 'Initializing', 'message': 'Starting optimization...'})}\n\n"
        
        try:
            reqs = app_state.config.design_requirements
            burn_time = reqs.target_burn_time
            
            # Extract initial pressures from config if available, otherwise use defaults
            # Layer 1 should have set these in the config
            initial_lox_p = 500.0 * 6894.76
            if app_state.config.lox_tank and app_state.config.lox_tank.initial_pressure_psi:
                initial_lox_p = app_state.config.lox_tank.initial_pressure_psi * 6894.76
                
            initial_fuel_p = 500.0 * 6894.76
            if app_state.config.fuel_tank and app_state.config.fuel_tank.initial_pressure_psi:
                initial_fuel_p = app_state.config.fuel_tank.initial_pressure_psi * 6894.76
            
            # Extract parameters from requirements or config
            target_thrust = reqs.target_thrust
            target_apogee = reqs.target_apogee or 3048.0
            
            # Rocket dry mass calculation
            rocket_dry_mass_kg = 50.0 # Default
            if app_state.config.rocket:
                r = app_state.config.rocket
                if r.airframe_mass is not None and r.engine_mass is not None:
                    # Sum up components if broken down
                    rocket_dry_mass_kg = (
                        (r.airframe_mass or 0) + 
                        (r.engine_mass or 0) + 
                        (r.lox_tank_structure_mass or 0) + 
                        (r.fuel_tank_structure_mass or 0) + 
                        (r.copv_dry_mass or 0)
                    )
                elif r.propulsion_dry_mass is not None:
                    rocket_dry_mass_kg = (r.airframe_mass or 0) + r.propulsion_dry_mass
            
            # Tank capacities
            lox_capacity = reqs.lox_tank_capacity_kg or 25.0
            fuel_capacity = reqs.fuel_tank_capacity_kg or 15.0
            
            objective_history = []
            objective_history_lock = threading.Lock()
            last_sent_count = 0
            
            # Track best pressure curves for streaming to UI
            best_pressure_curves = {"time": None, "lox": None, "fuel": None, "copv_pressure": None, "copv_time": None}
            pressure_curves_lock = threading.Lock()
            pressure_curves_updated = threading.Event()
            
            def update_progress(stage: str, progress: float, message: str):
                _layer2_status.update({"progress": progress, "stage": stage, "message": message})
            
            def objective_callback(iteration: int, objective: float, best_objective: float):
                with objective_history_lock:
                    objective_history.append({
                        "iteration": int(iteration),
                        "objective": float(objective),
                        "best_objective": float(best_objective),
                    })
            
            def pressure_curve_callback(time_arr, P_lox, P_fuel, copv_pressure=None, copv_time=None):
                """Called when a new best solution is found - stream pressure curves to UI."""
                with pressure_curves_lock:
                    best_pressure_curves["time"] = time_arr
                    best_pressure_curves["lox"] = P_lox
                    best_pressure_curves["fuel"] = P_fuel
                    best_pressure_curves["copv_pressure"] = copv_pressure
                    best_pressure_curves["copv_time"] = copv_time
                    pressure_curves_updated.set()  # Signal that new curves are available


            
            import concurrent.futures
            
            # Capture the current stop event explicitly to avoid any global lookup ambiguity
            current_stop_event = _stop_event
            
            def run_opt():
                return run_layer2_pressure(
                    optimized_config=app_state.config,
                    initial_lox_pressure_pa=initial_lox_p,
                    initial_fuel_pressure_pa=initial_fuel_p,
                    peak_thrust=target_thrust,
                    target_apogee_m=target_apogee,
                    rocket_dry_mass_kg=rocket_dry_mass_kg,
                    max_lox_tank_capacity_kg=lox_capacity,
                    max_fuel_tank_capacity_kg=fuel_capacity,
                    target_burn_time=burn_time,
                    n_time_points=200,
                    update_progress=update_progress,
                    objective_callback=objective_callback,
                    pressure_curve_callback=pressure_curve_callback,
                    max_iterations=max_iterations,
                    save_evaluation_plots=save_plots,
                    stop_event=current_stop_event,  # Use captured event
                    de_maxiter=de_maxiter,
                    de_popsize=de_popsize,
                    de_n_time_points=de_n_time_points,
                )
            
            # Wait, I need to check the design requirements for tank capacities
            # It seems DesignRequirementsConfig doesn't have capacity_kg?
            # Let me check engine/pipeline/config_schemas.py
            
            loop = asyncio.get_event_loop()
            with concurrent.futures.ThreadPoolExecutor() as pool:
                future = loop.run_in_executor(pool, run_opt)
                
                while not future.done():
                    yield f"data: {safe_json_dumps({'type': 'progress', 'progress': _layer2_status['progress'], 'stage': _layer2_status['stage'], 'message': _layer2_status['message']})}\n\n"
                    
                    with objective_history_lock:
                        if len(objective_history) > last_sent_count:
                            new_entries = objective_history[last_sent_count:]
                            last_sent_count = len(objective_history)
                            yield f"data: {safe_json_dumps({'type': 'objective', 'objective_history': new_entries, 'total_count': last_sent_count})}\n\n"
                    
                    # Check for new pressure curves and send them
                    if pressure_curves_updated.is_set():
                        with pressure_curves_lock:
                            if best_pressure_curves["time"] is not None:
                                # Send pressure curves to frontend (including COPV data)
                                curves_data = convert_numpy({
                                    'type': 'pressure_curves',
                                    'time_array': best_pressure_curves["time"],
                                    'lox_pressure': best_pressure_curves["lox"],
                                    'fuel_pressure': best_pressure_curves["fuel"],
                                    'copv_pressure': best_pressure_curves["copv_pressure"],
                                    'copv_time': best_pressure_curves["copv_time"],
                                })
                                yield f"data: {safe_json_dumps(curves_data)}\n\n"
                                pressure_curves_updated.clear()  # Reset flag

                    
                    await asyncio.sleep(0.5)
                
                optimized_config, time_array, P_lox, P_fuel, summary, success = future.result()
                
                # Check if stopped - if so, still return results (with best solution found)
                stopped_by_user = False
                with _stop_event_lock:
                    if _stop_event and _stop_event.is_set():
                        stopped_by_user = True
                
                # Update app state (even if stopped - we want to save the best solution)
                app_state.set_config(optimized_config)
                
                results_dict = convert_numpy({
                    "performance": summary, # Layer 2 summary contains performance info
                    "summary": summary,
                    "objective_history": objective_history,
                    "time_array": time_array,
                    "lox_pressure": P_lox,
                    "fuel_pressure": P_fuel,
                    "config": config_to_dict(optimized_config),
                    "config_yaml": yaml.dump(config_to_dict(optimized_config), default_flow_style=False),
                })
                
                _layer2_status.update({
                    "results": results_dict,
                    "progress": 1.0,
                    "stage": "Complete" if not stopped_by_user else "Stopped",
                    "message": "Layer 2 optimization complete" if not stopped_by_user else "Stopped by user - using best solution found",
                })
                
                yield f"data: {safe_json_dumps({'type': 'complete', 'results': results_dict, 'stopped_by_user': stopped_by_user})}\n\n"
                
        except Exception as e:
            _layer2_status["error"] = str(e)
            yield f"data: {safe_json_dumps({'type': 'error', 'error': str(e), 'traceback': traceback.format_exc()})}\n\n"
        finally:
            _layer2_status["running"] = False
            
            # Safety measure: if connection drops or something fails, ensure we signal stop
            # to any running optimizer thread so it doesn't become a zombie.
            with _stop_event_lock:
                if _stop_event is not None:
                    _stop_event.set()
                _stop_event = None

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"}
    )


from fastapi import UploadFile, File as FastAPIFile

@router.post("/layer2/upload-config")
async def upload_layer2_config(file: UploadFile = FastAPIFile(...)):
    """Upload a config to use for Layer 2."""
    try:
        content = await file.read()
        config_dict = yaml.safe_load(content)
        
        # Validate and update app state
        from engine.pipeline.config_schemas import PintleEngineConfig
        config = PintleEngineConfig(**config_dict)
        app_state.config = config
        
        # Re-initialize runner if needed
        from engine.core.runner import PintleEngineRunner
        app_state.runner = PintleEngineRunner(config)
        
        return {
            "status": "success",
            "message": "Config uploaded successfully for Layer 2",
            "config": config_to_dict(config)
        }
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to upload config: {str(e)}"
        )


# ============================================================================
# Layer 3: Thermal Protection Optimization Endpoints
# ============================================================================

@router.get("/layer3/status")
async def get_layer3_status():
    """Get Layer 3 optimization status."""
    return {
        "running": _layer3_status["running"],
        "progress": _layer3_status["progress"],
        "stage": _layer3_status["stage"],
        "message": _layer3_status["message"],
        "has_results": _layer3_status["results"] is not None,
        "error": _layer3_status["error"],
    }


@router.get("/layer3/results")
async def get_layer3_results():
    """Get Layer 3 optimization results."""
    if _layer3_status["results"] is None:
        raise HTTPException(
            status_code=404,
            detail="No Layer 3 optimization results available. Run Layer 3 optimization first."
        )
    
    return {
        "status": "success",
        "results": _layer3_status["results"],
    }


@router.post("/layer3/stop")
async def stop_layer3():
    """Stop the currently running Layer 3 optimization."""
    global _stop_event
    
    if not _layer3_status["running"]:
        raise HTTPException(
            status_code=400,
            detail="No Layer 3 optimization is currently running."
        )
    
    with _stop_event_lock:
        if _stop_event is not None:
            _stop_event.set()
            _layer3_status["message"] = "Stopping optimization..."
            return {
                "status": "success",
                "message": "Stop signal sent to optimizer."
            }
        else:
            return {
                "status": "error",
                "message": "Stop event not initialized."
            }


@router.post("/layer3/upload-config")
async def upload_layer3_config(file: UploadFile = FastAPIFile(...)):
    """Upload a config to use for Layer 3 (should have pressure_curves from Layer 2)."""
    try:
        content = await file.read()
        config_dict = yaml.safe_load(content)
        
        # Validate and update app state
        from engine.pipeline.config_schemas import PintleEngineConfig
        config = PintleEngineConfig(**config_dict)
        
        # Verify config has pressure_curves section (required for Layer 3)
        if not hasattr(config, 'pressure_curves') or config.pressure_curves is None:
            raise HTTPException(
                status_code=400,
                detail="Config must have pressure_curves section from Layer 2 optimization."
            )
        
        app_state.config = config
        
        # Re-initialize runner
        from engine.core.runner import PintleEngineRunner
        app_state.runner = PintleEngineRunner(config)
        
        return {
            "status": "success",
            "message": "Config uploaded successfully for Layer 3",
            "config": config_to_dict(config)
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to upload config: {str(e)}"
        )


@router.get("/layer3")
async def run_layer3(
    max_iterations: int = 20,
    save_plots: bool = False,
    optimization_method: str = "gradient"
):
    """Run Layer 3 thermal protection optimization with Server-Sent Events for progress updates.
    
    Args:
        optimization_method: "gradient" (fast, ~5-15 evals), "cma" (thorough, ~60-80 evals), or "de" (fallback)
    """
    if not app_state.has_config():
        raise HTTPException(
            status_code=400,
            detail="No config loaded. Run Layer 2 or upload a config first."
        )
    
    if not app_state.runner:
        raise HTTPException(
            status_code=400,
            detail="Runner not initialized."
        )
    
    # Verify config has pressure_curves from Layer 2
    if not hasattr(app_state.config, 'pressure_curves') or app_state.config.pressure_curves is None:
        raise HTTPException(
            status_code=400,
            detail="Config must have pressure_curves from Layer 2 optimization."
        )
    
    # Check if already running
    if _layer3_status["running"]:
        raise HTTPException(
            status_code=409,
            detail="Layer 3 optimization already running."
        )
    
    async def event_generator():
        global _layer3_status, _stop_event
        
        with _stop_event_lock:
            _stop_event = threading.Event()
        
        _layer3_status.update({
            "running": True,
            "progress": 0.0,
            "stage": "Initializing",
            "message": "Starting Layer 3 thermal protection optimization...",
            "results": None,
            "error": None,
        })
        
        yield f"data: {safe_json_dumps({'type': 'status', 'progress': 0.0, 'stage': 'Initializing', 'message': 'Starting optimization...'})}\n\n"
        
        try:
            # Extract pressure curves from config
            pressure_curves = app_state.config.pressure_curves
            burn_time = pressure_curves.target_burn_time_s
            n_points = pressure_curves.n_points or 200
            
            # Generate time array and pressure arrays from segments
            from engine.optimizer.layers.layer2_pressure import generate_pressure_curve_from_segments
            
            time_array = np.linspace(0, burn_time, n_points)
            
            # Convert segments to dict format for generate_pressure_curve_from_segments
            lox_segments_dicts = [
                {
                    "length_ratio": seg.length_ratio,
                    "type": seg.type,
                    "start_pressure": seg.start_pressure_pa,
                    "end_pressure": seg.end_pressure_pa,
                    "k": seg.k if seg.k is not None else 0.3,
                }
                for seg in pressure_curves.lox_segments
            ]
            
            fuel_segments_dicts = [
                {
                    "length_ratio": seg.length_ratio,
                    "type": seg.type,
                    "start_pressure": seg.start_pressure_pa,
                    "end_pressure": seg.end_pressure_pa,
                    "k": seg.k if seg.k is not None else 0.3,
                }
                for seg in pressure_curves.fuel_segments
            ]
            
            # Generate LOX pressure curve
            P_tank_O_array = generate_pressure_curve_from_segments(
                lox_segments_dicts,
                n_points
            )
            
            # Generate Fuel pressure curve
            P_tank_F_array = generate_pressure_curve_from_segments(
                fuel_segments_dicts,
                n_points
            )
            
            # Get baseline time series results from Layer 2 (if available)
            # For now, we'll run a quick evaluation to get baseline
            baseline_results = app_state.runner.evaluate_arrays_with_time(
                time_array,
                P_tank_O_array,
                P_tank_F_array,
                track_ablative_geometry=True,
                use_coupled_solver=True,
            )
            
            objective_history = []
            objective_history_lock = threading.Lock()
            last_sent_count = 0
            
            # Track best pressure curves for streaming to UI
            best_pressure_curves = {"time": None, "lox": None, "fuel": None, "copv_pressure": None, "copv_time": None}
            pressure_curves_lock = threading.Lock()
            pressure_curves_updated = threading.Event()
            
            def update_progress(stage: str, progress: float, message: str):
                _layer3_status.update({"progress": progress, "stage": stage, "message": message})
            
            def log_status(stage: str, message: str):
                # Log status messages (not used for SSE, but required by layer3)
                pass
            
            def objective_callback(iteration: int, objective: float, best_objective: float):
                with objective_history_lock:
                    objective_history.append({
                        "iteration": int(iteration),
                        "objective": float(objective),
                        "best_objective": float(best_objective),
                    })
            
            import concurrent.futures
            
            current_stop_event = _stop_event
            
            def run_opt():
                return run_layer3_thermal_protection(
                    optimized_config=app_state.config,
                    time_array=time_array,
                    P_tank_O_array=P_tank_O_array,
                    P_tank_F_array=P_tank_F_array,
                    full_time_results=baseline_results,
                    n_time_points=n_points,
                    update_progress=update_progress,
                    log_status=log_status,
                    objective_callback=objective_callback,
                    optimization_method=optimization_method,
                )
            
            loop = asyncio.get_event_loop()
            with concurrent.futures.ThreadPoolExecutor() as pool:
                future = loop.run_in_executor(pool, run_opt)
                
                while not future.done():
                    yield f"data: {safe_json_dumps({'type': 'progress', 'progress': _layer3_status['progress'], 'stage': _layer3_status['stage'], 'message': _layer3_status['message']})}\n\n"
                    
                    with objective_history_lock:
                        if len(objective_history) > last_sent_count:
                            new_entries = objective_history[last_sent_count:]
                            last_sent_count = len(objective_history)
                            yield f"data: {safe_json_dumps({'type': 'objective', 'objective_history': new_entries, 'total_count': last_sent_count})}\n\n"
                    
                    # Send pressure curves (same as Layer 2 baseline)
                    if not pressure_curves_updated.is_set():
                        with pressure_curves_lock:
                            best_pressure_curves["time"] = time_array
                            best_pressure_curves["lox"] = P_tank_O_array
                            best_pressure_curves["fuel"] = P_tank_F_array
                            pressure_curves_updated.set()
                    
                    if pressure_curves_updated.is_set():
                        with pressure_curves_lock:
                            if best_pressure_curves["time"] is not None:
                                curves_data = convert_numpy({
                                    'type': 'pressure_curves',
                                    'time_array': best_pressure_curves["time"],
                                    'lox_pressure': best_pressure_curves["lox"],
                                    'fuel_pressure': best_pressure_curves["fuel"],
                                    'copv_pressure': best_pressure_curves["copv_pressure"],
                                    'copv_time': best_pressure_curves["copv_time"],
                                })
                                yield f"data: {safe_json_dumps(curves_data)}\n\n"
                                pressure_curves_updated.clear()
                    
                    await asyncio.sleep(0.5)
                
                optimized_config, updated_time_results, thermal_results = future.result()
                
                # Check if stopped
                stopped_by_user = False
                with _stop_event_lock:
                    if _stop_event and _stop_event.is_set():
                        stopped_by_user = True
                
                # Update app state and recreate runner with new config
                app_state.set_config(optimized_config)
                
                # Build comprehensive summary from thermal_results and updated_time_results
                try:
                    # Extract performance arrays
                    thrust_array = np.atleast_1d(updated_time_results.get("F", []))
                    isp_array = np.atleast_1d(updated_time_results.get("Isp", []))
                    mr_array = np.atleast_1d(updated_time_results.get("MR", []))
                    pc_array = np.atleast_1d(updated_time_results.get("Pc", []))
                    
                    # Ensure dimensions match for integration
                    safe_time_array = time_array
                    if len(thrust_array) != len(time_array):
                        if len(thrust_array) > 0:
                            # If sizes mismatch, create a safe time array for integration
                            safe_time_array = np.linspace(0, burn_time, len(thrust_array))
                        else:
                            safe_time_array = np.array([])
                    
                    # Calculate performance metrics (with safe handling of empty arrays)
                    total_impulse = None
                    if len(thrust_array) > 0 and len(safe_time_array) == len(thrust_array):
                        if hasattr(np, 'trapezoid'):
                             total_impulse = float(np.trapezoid(thrust_array, safe_time_array))
                        else:
                             total_impulse = float(np.trapz(thrust_array, safe_time_array))
                    
                    avg_thrust = float(np.mean(thrust_array)) if len(thrust_array) > 0 else None
                    peak_thrust = float(np.max(thrust_array)) if len(thrust_array) > 0 else None
                    avg_isp = float(np.mean(isp_array)) if len(isp_array) > 0 else None
                    avg_of = float(np.mean(mr_array)) if len(mr_array) > 0 else None
                    min_of = float(np.min(mr_array)) if len(mr_array) > 0 else None
                    max_of = float(np.max(mr_array)) if len(mr_array) > 0 else None
                    avg_pc = float(np.mean(pc_array)) if len(pc_array) > 0 else None
                    
                    summary = {
                        # Thermal protection metrics
                        "optimized_ablative_thickness": thermal_results.get("optimized_ablative_thickness"),
                        "optimized_graphite_thickness": thermal_results.get("optimized_graphite_thickness"),
                        "max_recession_chamber": thermal_results.get("max_recession_chamber"),
                        "max_recession_throat": thermal_results.get("max_recession_throat"),
                        "thermal_protection_valid": thermal_results.get("thermal_protection_valid"),
                        "ablative_adequate": thermal_results.get("ablative_adequate"),
                        "graphite_adequate": thermal_results.get("graphite_adequate"),
                        
                        # Performance metrics
                        "total_impulse_Ns": total_impulse,
                        "avg_thrust_N": avg_thrust,
                        "peak_thrust_N": peak_thrust,
                        "avg_isp_s": avg_isp,
                        "avg_chamber_pressure_Pa": avg_pc,
                        "burn_time_s": burn_time,
                        
                        # O/F ratio statistics
                        "avg_of_ratio": avg_of,
                        "min_of_ratio": min_of,
                        "max_of_ratio": max_of,
                        
                        # Stability
                        "min_stability_margin": float(np.min(updated_time_results.get("chugging_stability_margin", [0]))) if "chugging_stability_margin" in updated_time_results else None,
                    }
                except Exception as e:
                    # Fallback summary if calculation fails
                    print(f"Error calculating Layer 3 summary: {e}")
                    traceback.print_exc()
                    
                    summary = {
                        "optimized_ablative_thickness": thermal_results.get("optimized_ablative_thickness"),
                        "optimized_graphite_thickness": thermal_results.get("optimized_graphite_thickness"),
                        "max_recession_chamber": thermal_results.get("max_recession_chamber"),
                        "max_recession_throat": thermal_results.get("max_recession_throat"),
                        "thermal_protection_valid": thermal_results.get("thermal_protection_valid"),
                        "ablative_adequate": thermal_results.get("ablative_adequate"),
                        "graphite_adequate": thermal_results.get("graphite_adequate"),
                        "error": f"Summary calculation failed: {str(e)}"
                    }
                
                results_dict = convert_numpy({
                    "performance": updated_time_results,
                    "summary": summary,
                    "objective_history": objective_history,
                    "time_array": time_array,
                    "lox_pressure": P_tank_O_array,
                    "fuel_pressure": P_tank_F_array,
                    "config": config_to_dict(optimized_config),
                    "config_yaml": yaml.dump(config_to_dict(optimized_config), default_flow_style=False),
                })
                
                _layer3_status.update({
                    "results": results_dict,
                    "progress": 1.0,
                    "stage": "Complete" if not stopped_by_user else "Stopped",
                    "message": "Layer 3 thermal protection optimization complete" if not stopped_by_user else "Stopped by user - using best solution found",
                })
                
                yield f"data: {safe_json_dumps({'type': 'complete', 'results': results_dict, 'stopped_by_user': stopped_by_user})}\n\n"
                
        except Exception as e:
            _layer3_status["error"] = str(e)
            yield f"data: {safe_json_dumps({'type': 'error', 'error': str(e), 'traceback': traceback.format_exc()})}\n\n"
        finally:
            _layer3_status["running"] = False
            with _stop_event_lock:
                if _stop_event is not None:
                    _stop_event.set()
                _stop_event = None

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"}
    )

