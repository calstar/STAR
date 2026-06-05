"""Ethanol/LOX concentric-tank freezing endpoints.

Wraps ``tank_freeze`` (see ``ethanol_lox_heat_flux_guide (1).md``). The
streaming endpoint runs the simulation in a worker thread and forwards
progress events to the client as ``data: {json}\\n\\n`` lines, matching the
pattern the frontend already parses for the Layer-2 controller stream.
"""

import asyncio
import dataclasses
import json
import math
import traceback
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from tank_freeze import TankFreezeInputs, run_tank_freeze_bounds
from tank_freeze.model import H1_HIGH_DEFAULT, H1_LOW_DEFAULT

router = APIRouter(prefix="/api/tank-freeze", tags=["tank_freeze"])


class TankFreezeRequest(BaseModel):
    # Geometry
    r_i: float = Field(..., gt=0, description="Inner section radius [m]")
    wall_thickness_mm: float = Field(..., gt=0, description="Common wall thickness [mm]; r_o = r_i + this")
    H: float = Field(..., gt=0, description="Wetted height [m]")
    r_tank_outer_m: Optional[float] = Field(
        None, gt=0,
        description="Outer tank wall radius [m]; required when the freezable fluid is in the outer section",
    )
    # Fluid selection (the colder-boiling fluid acts as the fixed-T sink)
    fluid_inner: str = Field("ethanol", pattern="^(ethanol|lox|methane)$")
    fluid_outer: str = Field("lox", pattern="^(ethanol|lox|methane)$")
    # Conditions
    P_tank_pa: float = Field(101325.0, gt=0, description="Sink-side tank pressure [Pa] -> T_sink = Tsat(P)")
    P_fuel_pa: Optional[float] = Field(
        None, gt=0,
        description="Fuel(bulk)-side pressure [Pa]; None -> ambient. Shifts T_fr via Clausius-Clapeyron.",
    )
    T_eth0: float = Field(293.0, gt=0, description="Initial bulk liquid temperature [K]")
    m_liq0: float = Field(..., gt=0, description="Initial liquid ethanol mass [kg]")
    # Run controls (mission window is an INPUT, not the guide's hardcoded 20 min)
    t_mission_min: float = Field(20.0, gt=0, description="Mission window [minutes]")
    t_solidify_max_min: float = Field(180.0, gt=0, description="Solidification search horizon [minutes]")
    delta_seed: float = Field(1e-5, gt=0, description="Seeded initial ice thickness [m]")
    r_min: float = Field(1e-4, gt=0, description="Numerical floor on the front radius [m]")
    plot_points: int = Field(400, ge=10, le=5000)
    # Optional readout thresholds
    mu_pump_max: Optional[float] = Field(None, gt=0, description="Max pumpable viscosity [Pa s]")
    delta_ice_max: Optional[float] = Field(None, gt=0, description="Max tolerable ice thickness [m]")
    # Conservatism bounds (guide section 8)
    bound_mode: str = Field("both", pattern="^(both|freeze_time|nominal)$")
    h1_high: float = Field(H1_HIGH_DEFAULT, gt=0)
    h1_low: float = Field(H1_LOW_DEFAULT, gt=0)
    # Material overrides (None -> model defaults)
    k_s: Optional[float] = Field(None, gt=0, description="Solid ethanol conductivity [W/mK]")
    rho_s: Optional[float] = Field(None, gt=0, description="Solid ethanol density [kg/m^3]")
    c_p_s: Optional[float] = Field(None, gt=0, description="Solid ethanol specific heat [J/kgK]")
    L_fus: Optional[float] = Field(None, gt=0, description="Latent heat of fusion [J/kg]")
    T_fr: Optional[float] = Field(None, gt=0, description="Ethanol freezing point [K]")
    k_Al: Optional[float] = Field(None, gt=0, description="Wall (aluminum) conductivity [W/mK]")
    lox_chf: Optional[float] = Field(None, gt=0, description="LOX critical heat flux [W/m^2]; None -> Zuber")

    @property
    def r_o(self) -> float:
        """Outer wall radius derived from the wall thickness."""
        return self.r_i + self.wall_thickness_mm * 1e-3

    def to_inputs(self) -> TankFreezeInputs:
        kwargs = dict(
            r_i=self.r_i,
            r_o=self.r_o,
            fluid_inner=self.fluid_inner,
            fluid_outer=self.fluid_outer,
            r_t=self.r_tank_outer_m,
            H=self.H,
            P_tank_pa=self.P_tank_pa,
            P_fuel_pa=self.P_fuel_pa,
            T_eth0=self.T_eth0,
            m_liq0=self.m_liq0,
            t_mission_s=self.t_mission_min * 60.0,
            t_solidify_max_s=self.t_solidify_max_min * 60.0,
            delta_seed=self.delta_seed,
            r_min=self.r_min,
            plot_points=self.plot_points,
            mu_pump_max=self.mu_pump_max,
            delta_ice_max=self.delta_ice_max,
            lox_chf=self.lox_chf,
        )
        for name in ("k_s", "rho_s", "c_p_s", "L_fus", "T_fr", "k_Al"):
            val = getattr(self, name)
            if val is not None:
                kwargs[name] = val
        return TankFreezeInputs(**kwargs)


def _sanitize(obj):
    """Make a result JSON-safe: non-finite floats -> None (json allow_nan=False)."""
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize(v) for v in obj]
    return obj


def _result_payload(results) -> list:
    return [_sanitize(dataclasses.asdict(r)) for r in results]


def _run_sync(req: TankFreezeRequest, progress_cb=None):
    return run_tank_freeze_bounds(
        req.to_inputs(),
        mode=req.bound_mode,
        h1_high=req.h1_high,
        h1_low=req.h1_low,
        progress_cb=progress_cb,
    )


@router.post("/run")
def run(request: TankFreezeRequest):
    """Blocking run (no progress events); useful from /docs and for tests."""
    try:
        results = _run_sync(request)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")
    return {"results": _result_payload(results)}


@router.post("/run-stream")
async def run_stream(request: TankFreezeRequest):
    """Streaming run: progress events while the sim marches, then results.

    Events: {"type": "status"|"progress"|"complete"|"error", ...}
    """
    from fastapi.responses import StreamingResponse

    async def event_generator():
        def dumps(obj) -> str:
            return json.dumps(_sanitize(obj), allow_nan=False)

        yield f"data: {dumps({'type': 'status', 'progress': 0.0, 'message': 'Building property tables...'})}\n\n"

        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()

        def progress_cb(frac: float, sim_time_s: float, bound: str) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, (frac, sim_time_s, bound))

        sim_task = asyncio.ensure_future(asyncio.to_thread(_run_sync, request, progress_cb))
        last_sent = -1.0
        try:
            while True:
                try:
                    frac, sim_time_s, bound = await asyncio.wait_for(queue.get(), timeout=0.25)
                    # throttle to ~1% steps
                    if frac - last_sent >= 0.01 or frac >= 1.0:
                        last_sent = frac
                        yield (
                            f"data: {dumps({'type': 'progress', 'progress': frac, 'sim_time_s': sim_time_s, 'bound': bound})}\n\n"
                        )
                except asyncio.TimeoutError:
                    pass
                if sim_task.done() and queue.empty():
                    break
            results = sim_task.result()
            yield f"data: {dumps({'type': 'complete', 'progress': 1.0, 'results': _result_payload(results)})}\n\n"
        except Exception as e:
            detail = f"{type(e).__name__}: {e}\n{traceback.format_exc()}"
            yield f"data: {dumps({'type': 'error', 'error': str(e), 'detail': detail})}\n\n"
        finally:
            if not sim_task.done():
                sim_task.cancel()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )
