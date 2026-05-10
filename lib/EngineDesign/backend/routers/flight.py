"""Flight simulation endpoints."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import List, Optional, Literal
import numpy as np
import copy

from backend.state import app_state

router = APIRouter(prefix="/api/flight", tags=["flight"])


# Constants
PSI_TO_PA = 6894.76
PA_TO_PSI = 1.0 / PSI_TO_PA

# Fluid densities for propellant mass capping (kg/m³)
LOX_DENSITY = 1141.0  # Liquid oxygen at boiling point
RP1_DENSITY = 820.0   # RP-1 kerosene


def calculate_tank_capacity(height: float, radius: float, density: float, fill_factor: float = 0.95) -> float:
    """Calculate max propellant mass for a cylindrical tank.
    
    Args:
        height: Tank height in meters
        radius: Tank radius in meters
        density: Fluid density in kg/m³
        fill_factor: Fill factor (default 95% to avoid overfill)
    
    Returns:
        Maximum propellant mass in kg
    """
    import math
    volume = math.pi * radius ** 2 * height
    return volume * density * fill_factor


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


# ============================================================================
# Request/Response Models
# ============================================================================

class EnvironmentConfig(BaseModel):
    """Environment configuration for flight simulation."""
    latitude: float = Field(default=35.0, ge=-90, le=90, description="Launch site latitude [deg]")
    longitude: float = Field(default=-117.0, ge=-180, le=180, description="Launch site longitude [deg]")
    elevation: float = Field(default=0.0, ge=-500, le=10000, description="Ground elevation [m]")
    date: List[int] = Field(default=[2025, 1, 1, 12], min_length=4, max_length=4, description="Launch date [year, month, day, hour]")


class FinsConfig(BaseModel):
    """Fins configuration for flight simulation."""
    no_fins: int = Field(default=3, ge=1, le=8, description="Number of fins")
    root_chord: float = Field(default=0.2, gt=0, description="Root chord [m]")
    tip_chord: float = Field(default=0.1, gt=0, description="Tip chord [m]")
    fin_span: float = Field(default=0.3, gt=0, description="Fin span [m]")
    fin_position: float = Field(default=0.1, ge=0, description="Fin position from tail [m]")


class RocketConfig(BaseModel):
    """Rocket configuration for flight simulation."""
    airframe_mass: float = Field(default=78.72, gt=0, description="Airframe mass (no propulsion) [kg]")
    engine_mass: float = Field(default=8.0, gt=0, description="Engine + plumbing mass [kg]")
    lox_tank_structure_mass: float = Field(default=5.0, gt=0, description="Empty LOX tank mass [kg]")
    fuel_tank_structure_mass: float = Field(default=3.0, gt=0, description="Empty fuel tank mass [kg]")
    radius: float = Field(default=0.1015, gt=0, description="Rocket radius [m]")
    rocket_length: float = Field(default=3.5, gt=0, description="Rocket total length [m]")
    motor_position: float = Field(default=0.0, ge=0, description="Motor position from tail [m]")
    inertia: List[float] = Field(default=[8.0, 8.0, 0.5], min_length=3, max_length=3, description="Inertia [Ixx, Iyy, Izz] [kg·m²]")
    fins: Optional[FinsConfig] = Field(default=None, description="Fins configuration")


class TankConfig(BaseModel):
    """Tank configuration for flight simulation."""
    mass: float = Field(..., gt=0, description="Initial propellant mass [kg]")
    height: float = Field(default=1.0, gt=0, description="Tank height [m]")
    radius: float = Field(default=0.0762, gt=0, description="Tank radius [m]")
    position: float = Field(default=0.6, description="Tank position relative to motor [m]")
    volume_m3: Optional[float] = Field(default=None, gt=0, description="Tank volume [m³]. If not provided, will be calculated from height and radius using π×r²×h")


class FlightSimRequest(BaseModel):
    """Request body for flight simulation (time-series mode only)."""
    # Time-series data - arrays from time-series analysis
    time_array: List[float] = Field(..., min_length=2, description="Time array [s]")
    thrust_array: List[float] = Field(..., min_length=2, description="Thrust array [N]")
    mdot_O_array: List[float] = Field(..., min_length=2, description="LOX mass flow array [kg/s]")
    mdot_F_array: List[float] = Field(..., min_length=2, description="Fuel mass flow array [kg/s]")
    
    # Propellant configuration
    lox_mass_kg: float = Field(default=18.0, gt=0, description="Initial LOX mass [kg]")
    fuel_mass_kg: float = Field(default=4.0, gt=0, description="Initial fuel mass [kg]")
    
    # Tank geometry (optional)
    lox_tank: Optional[TankConfig] = Field(default=None, description="LOX tank configuration")
    fuel_tank: Optional[TankConfig] = Field(default=None, description="Fuel tank configuration")
    
    # Environment configuration
    environment: Optional[EnvironmentConfig] = Field(default=None, description="Environment configuration")
    
    # Rocket configuration
    rocket: Optional[RocketConfig] = Field(default=None, description="Rocket configuration")


class FlightTrajectory(BaseModel):
    """Flight trajectory data."""
    time: List[float] = Field(description="Time array [s]")
    altitude: List[float] = Field(description="Altitude AGL array [m]")
    velocity: List[float] = Field(description="Vertical velocity array [m/s]")


class TruncationInfo(BaseModel):
    """Information about burn truncation."""
    truncated: bool = Field(default=False, description="Whether burn was truncated")
    cutoff_time: Optional[float] = Field(default=None, description="Cutoff time [s]")
    reason: Optional[str] = Field(default=None, description="Reason for truncation")


class FlightSimResponse(BaseModel):
    """Response for flight simulation."""
    status: str
    apogee_m: float = Field(description="Apogee AGL [m]")
    apogee_ft: float = Field(description="Apogee AGL [ft]")
    max_velocity_m_s: float = Field(description="Maximum velocity [m/s]")
    flight_time_s: float = Field(description="Total flight time [s]")
    trajectory: Optional[FlightTrajectory] = Field(default=None, description="Flight trajectory data")
    truncation: Optional[TruncationInfo] = Field(default=None, description="Truncation info")
    thrust_curve: Optional[dict] = Field(default=None, description="Thrust curve used (time, thrust arrays)")
    rocket_diagram: Optional[str] = Field(default=None, description="Base64-encoded rocket diagram PNG")
    error: Optional[str] = Field(default=None, description="Error message if failed")


# ============================================================================
# Helper Functions
# ============================================================================

def generate_rocket_diagram(flight_obj) -> Optional[str]:
    """Generate rocket diagram as base64-encoded PNG.
    
    Returns:
        Base64-encoded PNG string, or None if generation fails.
    """
    try:
        import matplotlib
        matplotlib.use('Agg')  # Non-interactive backend
        import matplotlib.pyplot as plt
        import io
        import base64
        
        plt.close('all')
        
        rocket = getattr(flight_obj, 'rocket', None)
        if rocket is None:
            return None
        
        # Call RocketPy's draw method
        maybe_fig = rocket.draw()
        fig = maybe_fig if hasattr(maybe_fig, 'savefig') else plt.gcf()
        
        # Save to bytes buffer
        buf = io.BytesIO()
        fig.savefig(buf, format='png', dpi=150, bbox_inches='tight', 
                    facecolor='white', edgecolor='none')
        buf.seek(0)
        
        # Encode as base64
        img_base64 = base64.b64encode(buf.read()).decode('utf-8')
        
        plt.close(fig)
        buf.close()
        
        return img_base64
    except Exception as e:
        print(f"Failed to generate rocket diagram: {e}")
        return None


def extract_flight_series(flight_obj, elevation: float = 0.0):
    """Extract flight time series from RocketPy flight object.
    
    Returns:
        Tuple of (time_array, altitude_agl_array, velocity_array)
    """
    try:
        # Get time array
        t_final = flight_obj.t_final if hasattr(flight_obj, 't_final') else 100.0
        time_array = np.linspace(0, t_final, 500)
        
        # Get altitude (z coordinate) - subtract elevation for AGL
        if hasattr(flight_obj, 'z'):
            altitude_array = np.array([float(flight_obj.z(t)) - elevation for t in time_array])
        else:
            altitude_array = np.zeros_like(time_array)
        
        # Get vertical velocity (vz)
        if hasattr(flight_obj, 'vz'):
            velocity_array = np.array([float(flight_obj.vz(t)) for t in time_array])
        else:
            velocity_array = np.zeros_like(time_array)
        
        return time_array, altitude_array, velocity_array
    except Exception:
        return np.array([]), np.array([]), np.array([])


def build_flight_config(base_config, request: FlightSimRequest):
    """Build a flight-ready config by merging base config with request overrides."""
    # Deep copy the base config
    config_dict = copy.deepcopy(base_config.model_dump())
    
    # Update LOX tank
    if config_dict.get("lox_tank") is None:
        config_dict["lox_tank"] = {}
    config_dict["lox_tank"]["mass"] = request.lox_mass_kg
    
    if request.lox_tank:
        config_dict["lox_tank"]["lox_h"] = request.lox_tank.height
        config_dict["lox_tank"]["lox_radius"] = request.lox_tank.radius
        config_dict["lox_tank"]["ox_tank_pos"] = request.lox_tank.position
        if request.lox_tank.volume_m3 is not None:
            config_dict["lox_tank"]["tank_volume_m3"] = request.lox_tank.volume_m3
    
    # Update fuel tank
    if config_dict.get("fuel_tank") is None:
        config_dict["fuel_tank"] = {}
    config_dict["fuel_tank"]["mass"] = request.fuel_mass_kg
    
    if request.fuel_tank:
        config_dict["fuel_tank"]["rp1_h"] = request.fuel_tank.height
        config_dict["fuel_tank"]["rp1_radius"] = request.fuel_tank.radius
        config_dict["fuel_tank"]["fuel_tank_pos"] = request.fuel_tank.position
        if request.fuel_tank.volume_m3 is not None:
            config_dict["fuel_tank"]["tank_volume_m3"] = request.fuel_tank.volume_m3
    
    # Update environment
    if request.environment:
        if config_dict.get("environment") is None:
            config_dict["environment"] = {}
        config_dict["environment"]["latitude"] = request.environment.latitude
        config_dict["environment"]["longitude"] = request.environment.longitude
        config_dict["environment"]["elevation"] = request.environment.elevation
        config_dict["environment"]["date"] = request.environment.date
    elif config_dict.get("environment") is None:
        # Set defaults
        config_dict["environment"] = {
            "latitude": 35.0,
            "longitude": -117.0,
            "elevation": 0.0,
            "date": [2025, 1, 1, 12],
        }
    
    # Update rocket
    if request.rocket:
        if config_dict.get("rocket") is None:
            config_dict["rocket"] = {}
        config_dict["rocket"]["airframe_mass"] = request.rocket.airframe_mass
        config_dict["rocket"]["propulsion_dry_mass"] = (
            request.rocket.engine_mass + 
            request.rocket.lox_tank_structure_mass + 
            request.rocket.fuel_tank_structure_mass
        )
        config_dict["rocket"]["radius"] = request.rocket.radius
        config_dict["rocket"]["motor_position"] = request.rocket.motor_position
        config_dict["rocket"]["inertia"] = request.rocket.inertia
        
        if request.rocket.fins:
            config_dict["rocket"]["fins"] = {
                "no_fins": request.rocket.fins.no_fins,
                "root_chord": request.rocket.fins.root_chord,
                "tip_chord": request.rocket.fins.tip_chord,
                "fin_span": request.rocket.fins.fin_span,
                "fin_position": request.rocket.fins.fin_position,
            }
    elif config_dict.get("rocket") is None:
        # Set defaults
        config_dict["rocket"] = {
            "airframe_mass": 78.72,
            "propulsion_dry_mass": 24.0,
            "radius": 0.1015,
            "motor_position": 0.0,
            "inertia": [8.0, 8.0, 0.5],
            "fins": {
                "no_fins": 3,
                "root_chord": 0.2,
                "tip_chord": 0.1,
                "fin_span": 0.3,
                "fin_position": 0.1,
            },
        }
    
    return config_dict


# ============================================================================
# Endpoints
# ============================================================================

@router.post("/simulate", response_model=FlightSimResponse)
async def simulate_flight(request: FlightSimRequest):
    """Run flight simulation using time-series data.
    
    Uses provided thrust/mdot arrays from time-series analysis.
    Returns apogee, max velocity, and flight trajectory.
    """
    if not app_state.has_config():
        raise HTTPException(
            status_code=400,
            detail="No config loaded. Upload a config file first."
        )
    
    try:
        # Check if RocketPy is available
        try:
            from engine.optimizer.copv_flight_helpers import run_flight_simulation
            from engine.pipeline.config_schemas import PintleEngineConfig
        except ImportError as e:
            raise HTTPException(
                status_code=500,
                detail=f"RocketPy or flight simulation module not available: {e}"
            )
        
        # Build flight config from base config + request overrides
        config_dict = build_flight_config(app_state.config, request)
        
        # Validate and cap propellant masses to prevent tank overfill errors
        # This ensures the propellant mass doesn't exceed tank volume capacity
        # Use conservative 75% fill factor to avoid RocketPy's internal numerical precision issues
        # (RocketPy's tank calculations can fail when liquid level approaches geometry bounds)
        FILL_FACTOR = 0.75
        mass_adjustments = {}
        import math
        
        # Get tank dimensions - check both request and config_dict
        lox_height = None
        lox_radius = None
        if request.lox_tank:
            lox_height = request.lox_tank.height
            lox_radius = request.lox_tank.radius
        elif config_dict.get("lox_tank"):
            lox_height = config_dict["lox_tank"].get("lox_h")
            lox_radius = config_dict["lox_tank"].get("lox_radius")
        
        if lox_height and lox_radius and config_dict.get("lox_tank"):
            # Calculate tank volume and max mass with conservative margin
            lox_tank_volume = math.pi * lox_radius ** 2 * lox_height
            lox_max = lox_tank_volume * LOX_DENSITY * FILL_FACTOR
            current_lox = config_dict["lox_tank"].get("mass", 0)
            if current_lox > lox_max:
                mass_adjustments["lox"] = {
                    "original": current_lox,
                    "capped": lox_max,
                    "tank_volume_m3": lox_tank_volume
                }
                config_dict["lox_tank"]["mass"] = lox_max
                print(f"[Flight] Capped LOX mass: {current_lox:.2f} -> {lox_max:.2f} kg (tank vol: {lox_tank_volume*1000:.1f}L, 75% fill)")
        
        fuel_height = None
        fuel_radius = None
        if request.fuel_tank:
            fuel_height = request.fuel_tank.height
            fuel_radius = request.fuel_tank.radius
        elif config_dict.get("fuel_tank"):
            fuel_height = config_dict["fuel_tank"].get("rp1_h")
            fuel_radius = config_dict["fuel_tank"].get("rp1_radius")
        
        if fuel_height and fuel_radius and config_dict.get("fuel_tank"):
            fuel_tank_volume = math.pi * fuel_radius ** 2 * fuel_height
            fuel_max = fuel_tank_volume * RP1_DENSITY * FILL_FACTOR
            current_fuel = config_dict["fuel_tank"].get("mass", 0)
            if current_fuel > fuel_max:
                mass_adjustments["fuel"] = {
                    "original": current_fuel,
                    "capped": fuel_max,
                    "tank_volume_m3": fuel_tank_volume
                }
                config_dict["fuel_tank"]["mass"] = fuel_max
                print(f"[Flight] Capped Fuel mass: {current_fuel:.2f} -> {fuel_max:.2f} kg (tank vol: {fuel_tank_volume*1000:.1f}L, 75% fill)")
        
        # Use provided time-series arrays
        times = np.array(request.time_array)
        thrust_array = np.array(request.thrust_array)
        mdot_O_array = np.array(request.mdot_O_array)
        mdot_F_array = np.array(request.mdot_F_array)
        
        # Normalize time to start at 0
        times = times - times[0]
        burn_time = float(times[-1])
        
        # Update burn time in config
        if config_dict.get("thrust") is None:
            config_dict["thrust"] = {}
        config_dict["thrust"]["burn_time"] = burn_time
        
        # Build pressure curves dict
        pressure_curves = {
            "time": times,
            "thrust": thrust_array,
            "mdot_O": mdot_O_array,
            "mdot_F": mdot_F_array,
        }
        
        # Create config object
        try:
            flight_config = PintleEngineConfig(**config_dict)
        except Exception as e:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid flight configuration: {e}"
            )
        
        # Run flight simulation
        result = run_flight_simulation(flight_config, pressure_curves, burn_time)
        
        if not result.get("success", False):
            return FlightSimResponse(
                status="error",
                apogee_m=result.get("apogee", 0),
                apogee_ft=result.get("apogee", 0) * 3.28084,
                max_velocity_m_s=result.get("max_velocity", 0),
                flight_time_s=result.get("flight_time", 0),
                error=result.get("error", "Flight simulation failed"),
            )
        
        apogee = result["apogee"]
        max_velocity = result["max_velocity"]
        flight_obj = result.get("flight_obj")
        
        # Get elevation for AGL calculation
        elevation = config_dict.get("environment", {}).get("elevation", 0.0)
        
        # Extract flight time from flight object (t_final is total flight time)
        flight_time_s = 0.0
        if flight_obj is not None and hasattr(flight_obj, 't_final'):
            flight_time_s = float(flight_obj.t_final)
        
        # Extract trajectory if flight object available
        trajectory = None
        if flight_obj is not None:
            flight_time_arr, flight_z, flight_vz = extract_flight_series(flight_obj, elevation)
            if len(flight_time_arr) > 0:
                trajectory = FlightTrajectory(
                    time=flight_time_arr.tolist(),
                    altitude=flight_z.tolist(),
                    velocity=flight_vz.tolist(),
                )
        
        # Build truncation info
        trunc_info = result.get("truncation_info", {})
        truncation = None
        if trunc_info:
            truncation = TruncationInfo(
                truncated=trunc_info.get("truncated", False),
                cutoff_time=trunc_info.get("cutoff_time"),
                reason=trunc_info.get("reason"),
            )
        
        # Generate rocket diagram
        rocket_diagram = None
        if flight_obj is not None:
            rocket_diagram = generate_rocket_diagram(flight_obj)
        
        return FlightSimResponse(
            status="success",
            apogee_m=apogee,
            apogee_ft=apogee * 3.28084,
            max_velocity_m_s=max_velocity,
            flight_time_s=flight_time_s,
            trajectory=trajectory,
            truncation=truncation,
            thrust_curve={
                "time": times.tolist(),
                "thrust_N": thrust_array.tolist(),
            },
            rocket_diagram=rocket_diagram,
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Flight simulation failed: {str(e)}"
        )


@router.get("/check")
async def check_rocketpy():
    """Check if RocketPy is available for flight simulation."""
    try:
        from rocketpy import Environment, Rocket, Flight
        return {
            "available": True,
            "message": "RocketPy is installed and available",
        }
    except ImportError as e:
        return {
            "available": False,
            "message": f"RocketPy not installed: {e}",
            "install_hint": "pip install rocketpy",
        }

