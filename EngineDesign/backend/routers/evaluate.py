"""Engine evaluation endpoints."""

from fastapi import APIRouter, HTTPException, Depends
from typing import Literal

from pydantic import BaseModel, Field
import math
import numpy as np

from backend.session import UserSession, get_session

router = APIRouter(prefix="/api/evaluate", tags=["evaluate"])


# Constants
PSI_TO_PA = 6894.76
PA_TO_PSI = 1.0 / PSI_TO_PA


class StabilityOverrides(BaseModel):
    """Optional forward-mode knobs for rich stability re-evaluation."""
    eta_inj_O: float | None = Field(default=None, gt=0, le=0.6, description="Oxidizer ΔP_inj/Pc")
    smd_um: float | None = Field(default=None, gt=0, le=200, description="Oxidizer spray SMD [µm]")
    n_interaction: float | None = Field(default=None, gt=0, le=2, description="Combustion interaction index n")
    chi_acoustic: float | None = Field(default=None, gt=0, le=1, description="Acoustic sensitive-fraction χ")
    time_lag_model: Literal["leonardi_dtl", "d2_law"] | None = Field(
        default=None,
        description="Conversion-lag model for the chug loop. Overrides stability.time_lag_model for this run only.",
    )
    convection_model: Literal["none", "leonardi_eq8", "ranz_marshall"] | None = Field(
        default=None, description="Convective speed-up applied to the droplet lifetime.",
    )
    mixing_lag_fraction: float | None = Field(
        default=None, ge=0, le=3,
        description="Mixing lag as a fraction of the rate-limiting vaporization lag.",
    )


class EvaluateRequest(BaseModel):
    """Request body for forward evaluation."""
    lox_pressure_psi: float = Field(..., gt=0, description="LOX tank pressure in psi")
    fuel_pressure_psi: float = Field(..., gt=0, description="Fuel tank pressure in psi")
    stability_overrides: StabilityOverrides | None = Field(
        default=None, description="Optional stability sensitivity overrides (forward mode sliders)",
    )


def convert_numpy(obj):
    """Recursively convert numpy types to Python native types."""
    if isinstance(obj, dict):
        return {k: convert_numpy(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [convert_numpy(item) for item in obj]
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    elif isinstance(obj, np.floating):
        # NaN/Inf are legal model outputs (a lag model that does not define K_v, a margin
        # that could not be evaluated) but json.dumps rejects them outright --
        # "Out of range float values are not JSON compliant" -- which surfaced as a blanket
        # HTTP 500 on forward evaluation. Emit JSON null instead, so a missing number reads
        # as missing rather than taking the whole response down.
        v = obj.item()
        return v if math.isfinite(v) else None
    elif isinstance(obj, np.integer):
        return obj.item()
    elif isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    elif isinstance(obj, np.bool_):
        return bool(obj)
    else:
        return obj


@router.post("")
async def evaluate(request: EvaluateRequest, session: UserSession = Depends(get_session)):
    """Run forward evaluation: tank pressures -> performance.

    Takes LOX and fuel tank pressures in psi, returns the full results from runner.evaluate().
    Ambient pressure is computed automatically by the runner from the config's environment elevation.
    The results dict is passed through directly (with numpy conversion) - same format as Streamlit UI uses.
    """
    if not session.app_state.has_config():
        raise HTTPException(
            status_code=400, 
            detail="No config loaded. Upload a config file first."
        )
    
    # Convert psi to Pa
    P_tank_O = request.lox_pressure_psi * PSI_TO_PA
    P_tank_F = request.fuel_pressure_psi * PSI_TO_PA
    
    try:
        # Get raw results from runner - ambient pressure computed from config elevation
        overrides = None
        if request.stability_overrides is not None:
            overrides = {
                k: v for k, v in request.stability_overrides.model_dump().items() if v is not None
            } or None
        results = session.app_state.runner.evaluate(
            P_tank_O, P_tank_F, debug=True, rich_stability=True, stability_overrides=overrides,
        )

        # "Warn + flag for re-solve": if the chamber was seeded for a different injector/propellant
        # than is now live, surface a non-fatal warning so the forward result is read as a seed, not
        # a validated design.
        from engine.pipeline.config_switch import design_staleness
        design_warning = design_staleness(session.app_state.config)

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
            "design_warning": design_warning,
            "results": convert_numpy(results),
        }
        
    except Exception as e:
        raise HTTPException(
            status_code=500, 
            detail=f"Evaluation failed: {str(e)}"
        )
