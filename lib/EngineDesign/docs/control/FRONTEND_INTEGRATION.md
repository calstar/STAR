# Controller Frontend Integration Guide

## Current Status

**The robust DDP controller does NOT currently interface with the frontend.** It's a standalone Python module that needs to be integrated.

## What Exists

### Controller Module (Complete)
- Location: `engine/control/robust_ddp/`
- Status: ✅ Fully implemented and tested
- Components:
  - `controller.py` - Main `RobustDDPController` class
  - `data_models.py` - Measurement, NavState, Command, Config, State
  - All supporting modules (dynamics, solver, actuation, etc.)

### Frontend (No Controller UI)
- Location: `frontend/src/`
- Status: ❌ No controller interface exists
- Current tabs: Forward, TimeSeries, Flight, Geometry, Optimizer, Config

### Backend API (No Controller Endpoints)
- Location: `backend/routers/`
- Status: ❌ No controller router exists
- Current routers: evaluate, timeseries, flight, geometry, optimizer, config

## Integration Plan

### Step 1: Create Backend Controller Router

Create `backend/routers/control.py`:

```python
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
import numpy as np

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
from engine.pipeline.io import load_config
from backend.state import app_state

router = APIRouter(prefix="/control", tags=["control"])

# Global controller instance (or store in app_state)
controller: Optional[RobustDDPController] = None

class ControllerInitRequest(BaseModel):
    config_path: Optional[str] = None  # Path to controller config YAML
    engine_config_loaded: bool = True  # Use loaded engine config

class MeasurementRequest(BaseModel):
    P_copv: float
    P_reg: float
    P_u_fuel: float
    P_u_ox: float
    P_d_fuel: float
    P_d_ox: float
    timestamp: Optional[float] = None

class NavStateRequest(BaseModel):
    h: float  # altitude [m]
    vz: float  # vertical velocity [m/s]
    theta: float  # tilt angle [rad]
    mass_estimate: Optional[float] = None

class CommandRequest(BaseModel):
    command_type: str  # "thrust_desired" or "altitude_goal"
    thrust_desired: Optional[float] = None
    altitude_goal: Optional[float] = None

@router.post("/init")
async def init_controller(request: ControllerInitRequest):
    """Initialize the robust DDP controller."""
    global controller
    
    try:
        # Load controller config
        if request.config_path:
            from engine.control.robust_ddp.config_loader import load_config
            cfg = load_config(request.config_path)
        else:
            from engine.control.robust_ddp.config_loader import get_default_config
            cfg = get_default_config()
        
        # Get engine config
        engine_config = None
        if request.engine_config_loaded:
            engine_config = app_state.get_config()
        
        # Create controller
        controller = RobustDDPController(cfg, engine_config)
        
        return {"status": "initialized", "config": cfg.dict()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/step")
async def controller_step(
    meas: MeasurementRequest,
    nav: NavStateRequest,
    cmd: CommandRequest
):
    """Execute one controller step."""
    global controller
    
    if controller is None:
        raise HTTPException(status_code=400, detail="Controller not initialized")
    
    try:
        # Convert requests to data models
        measurement = Measurement(
            P_copv=meas.P_copv,
            P_reg=meas.P_reg,
            P_u_fuel=meas.P_u_fuel,
            P_u_ox=meas.P_u_ox,
            P_d_fuel=meas.P_d_fuel,
            P_d_ox=meas.P_d_ox,
            timestamp=meas.timestamp,
        )
        
        nav_state = NavState(
            h=nav.h,
            vz=nav.vz,
            theta=nav.theta,
            mass_estimate=nav.mass_estimate,
        )
        
        command = Command(
            command_type=CommandType(cmd.command_type),
            thrust_desired=cmd.thrust_desired,
            altitude_goal=cmd.altitude_goal,
        )
        
        # Run controller step
        actuation_cmd, diagnostics = controller.step(measurement, nav_state, command)
        
        return {
            "actuation": {
                "duty_F": actuation_cmd.duty_F,
                "duty_O": actuation_cmd.duty_O,
                "u_F_onoff": actuation_cmd.u_F_onoff,
                "u_O_onoff": actuation_cmd.u_O_onoff,
            },
            "diagnostics": diagnostics,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/reset")
async def reset_controller():
    """Reset controller state."""
    global controller
    if controller is None:
        raise HTTPException(status_code=400, detail="Controller not initialized")
    controller.reset()
    return {"status": "reset"}

@router.get("/status")
async def get_controller_status():
    """Get current controller status."""
    global controller
    if controller is None:
        return {"initialized": False}
    
    return {
        "initialized": True,
        "state": controller.state.dict(),
        "tick": controller.tick,
    }
```

### Step 2: Register Router in Backend

Add to `backend/main.py`:

```python
from backend.routers import config, evaluate, timeseries, flight, geometry, optimizer, control

# ... existing code ...

app.include_router(control.router)
```

### Step 3: Create Frontend Controller Component

Create `frontend/src/components/ControllerMode.tsx`:

```typescript
import { useState, useCallback } from 'react';
import { initController, controllerStep, resetController, getControllerStatus } from '../api/client';

export function ControllerMode() {
  const [initialized, setInitialized] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [actuation, setActuation] = useState<any>(null);
  const [diagnostics, setDiagnostics] = useState<any>(null);

  const handleInit = useCallback(async () => {
    const response = await initController({});
    if (!response.error) {
      setInitialized(true);
    }
  }, []);

  const handleStep = useCallback(async () => {
    // Get measurements from sensors (or simulate)
    const meas = {
      P_copv: 18.96e6,  // 2750 psi
      P_reg: 6.89e6,    // 1000 psi
      P_u_fuel: 3e6,
      P_u_ox: 3.5e6,
      P_d_fuel: 2.9e6,
      P_d_ox: 3.4e6,
    };

    const nav = {
      h: 0,
      vz: 0,
      theta: 0,
    };

    const cmd = {
      command_type: "thrust_desired",
      thrust_desired: 5000.0,
    };

    const response = await controllerStep(meas, nav, cmd);
    if (!response.error && response.data) {
      setActuation(response.data.actuation);
      setDiagnostics(response.data.diagnostics);
    }
  }, []);

  // ... rest of component
}
```

### Step 4: Add API Client Functions

Add to `frontend/src/api/client.ts`:

```typescript
export async function initController(params: any) {
  return request('/control/init', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function controllerStep(meas: any, nav: any, cmd: any) {
  return request('/control/step', {
    method: 'POST',
    body: JSON.stringify({ meas, nav, cmd }),
  });
}

// ... etc
```

### Step 5: Add Controller Tab to Frontend

Add to `frontend/src/App.tsx`:

```typescript
type Tab = 'forward' | 'timeseries' | 'plotter' | 'flight' | 'geometry' | 'optimizer' | 'config' | 'controller';

// In render:
{activeTab === 'controller' && (
  <ControllerMode />
)}
```

## Summary

**Current State**: Controller is a standalone Python module with no web interface.

**To Integrate**: 
1. Create `backend/routers/control.py` with REST endpoints
2. Create `frontend/src/components/ControllerMode.tsx` UI
3. Add API client functions
4. Register router and add tab

The controller is **ready to use** - it just needs the web interface layer!



