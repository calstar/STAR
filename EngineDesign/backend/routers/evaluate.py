"""Engine evaluation endpoints."""

import copy
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
import numpy as np

from backend.state import app_state
from engine.core.runner import PintleEngineRunner

router = APIRouter(prefix="/api/evaluate", tags=["evaluate"])


# Constants
PSI_TO_PA = 6894.76
PA_TO_PSI = 1.0 / PSI_TO_PA


class EvaluateRequest(BaseModel):
    """Request body for forward evaluation."""
    lox_pressure_psi: float = Field(..., gt=0, description="LOX tank pressure in psi")
    fuel_pressure_psi: float = Field(..., gt=0, description="Fuel tank pressure in psi")
    use_cold_flow_cd: bool = Field(default=True, description="Use saved cold-flow Cd fit if present. When False, strips fit and uses Re-based formula.")


def convert_numpy(obj):
    """Recursively convert numpy types to Python native types."""
    if isinstance(obj, dict):
        return {k: convert_numpy(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [convert_numpy(item) for item in obj]
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    elif isinstance(obj, (np.integer, np.floating)):
        return obj.item()
    elif isinstance(obj, np.bool_):
        return bool(obj)
    else:
        return obj


@router.post("")
async def evaluate(request: EvaluateRequest):
    """Run forward evaluation: tank pressures -> performance.
    
    Takes LOX and fuel tank pressures in psi, returns the full results from runner.evaluate().
    Ambient pressure is computed automatically by the runner from the config's environment elevation.
    The results dict is passed through directly (with numpy conversion) - same format as Streamlit UI uses.
    """
    if not app_state.has_config():
        raise HTTPException(
            status_code=400, 
            detail="No config loaded. Upload a config file first."
        )
    
    # Convert psi to Pa
    P_tank_O = request.lox_pressure_psi * PSI_TO_PA
    P_tank_F = request.fuel_pressure_psi * PSI_TO_PA
    
    try:
        app_state.ensure_runner()
        # If cold-flow Cd is disabled, strip fit coefficients from a temp config copy
        if not request.use_cold_flow_cd:
            cfg = copy.deepcopy(app_state.config)
            for fluid in ("oxidizer", "fuel"):
                if fluid in cfg.discharge:
                    cfg.discharge[fluid].cda_fit_a = None
                    cfg.discharge[fluid].cda_fit_b = None
            runner = PintleEngineRunner(cfg)
        else:
            runner = app_state.runner
        # Get raw results from runner - ambient pressure computed from config elevation
        results = runner.evaluate(P_tank_O, P_tank_F, debug=True)
        
        # Convert numpy types to JSON-serializable and return directly
        # Frontend uses the same field names as runner.py outputs
        # P_ambient and elevation are now included in results from runner
        return {
            "status": "success",
            "inputs": {
                "lox_pressure_psi": request.lox_pressure_psi,
                "fuel_pressure_psi": request.fuel_pressure_psi,
                "ambient_pressure_pa": results.get("P_ambient", 101325.0),
                "elevation_m": results.get("elevation", 0.0),
            },
            "results": convert_numpy(results),
        }
        
    except Exception as e:
        raise HTTPException(
            status_code=500, 
            detail=f"Evaluation failed: {str(e)}"
        )
