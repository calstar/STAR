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

# Fallback fluid densities (kg/m³) used ONLY if the loaded config has no fluid density. The real
# densities come from config.fluids so mass-capping follows the selected propellant (LOX/CH4, ethalox,
# kerolox, …) — nothing is hardcoded to a specific fuel. See _propellant_densities().
LOX_DENSITY_FALLBACK = 1141.0  # liquid oxygen at boiling point
FUEL_DENSITY_FALLBACK = 800.0  # generic dense liquid fuel


def _propellant_densities(config) -> tuple:
    """(oxidizer, fuel) liquid densities [kg/m³] from the loaded config's fluids, so propellant
    mass-capping follows the selected propellant rather than a hardcoded fuel. Falls back to generic
    densities only if the config doesn't carry them."""
    ox_rho = fuel_rho = None
    try:
        fluids = getattr(config, "fluids", None) or {}
        ox_rho = getattr(fluids.get("oxidizer"), "density", None)
        fuel_rho = getattr(fluids.get("fuel"), "density", None)
    except Exception:
        pass
    return (float(ox_rho) if ox_rho else LOX_DENSITY_FALLBACK,
            float(fuel_rho) if fuel_rho else FUEL_DENSITY_FALLBACK)


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
    atmosphere_model: Literal["standard_atmosphere", "forecast"] = Field(
        default="standard_atmosphere",
        description="'standard_atmosphere' (ISA, offline, deterministic) or 'forecast' (live GFS weather)")


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
    # Nosecone: von Kármán length derived from fineness ratio (length / diameter); ~4.5:1 is near-optimal.
    nose_kind: str = Field(default="vonKarman", description="Nosecone profile (RocketPy kind)")
    nose_fineness_ratio: float = Field(default=4.5, gt=0, description="Nose length / body diameter (von Kármán ~4.5:1)")
    nose_length: Optional[float] = Field(default=None, gt=0, description="Explicit nose length [m] (overrides fineness ratio)")
    avionics_payload_length_m: float = Field(default=4.0, ge=0, description="Avionics/payload/recovery length above propulsion, before the nose [m]")


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


class MassCapInfo(BaseModel):
    """Propellant mass capped to tank volume."""
    requested_kg: float
    effective_kg: float
    max_fill_kg: float
    fill_factor: float
    tank_volume_m3: float
    was_capped: bool


class PropellantDiagnostics(BaseModel):
    """Propellant vs time-series requirements for flight iteration."""
    regime: str = Field(description="truncated | full_burn | excess_propellant")
    timeseries_burn_time_s: float
    effective_burn_time_s: float
    total_impulse_Ns: float
    lox_required_kg: float
    fuel_required_kg: float
    lox_requested_kg: float
    fuel_requested_kg: float
    lox_effective_kg: float
    fuel_effective_kg: float
    lox_tank_max_kg: Optional[float] = None
    fuel_tank_max_kg: Optional[float] = None
    target_apogee_m: Optional[float] = None
    propellant_tank_fill_factor: Optional[float] = Field(
        default=None, description="Fill fraction used for tank volume mass caps"
    )
    mass_caps: Optional[dict[str, MassCapInfo]] = None
    warnings: List[str] = Field(default_factory=list)


class FlightSimResponse(BaseModel):
    """Response for flight simulation."""
    status: str
    apogee_m: float = Field(description="Apogee AGL [m]")
    apogee_ft: float = Field(description="Apogee AGL [ft]")
    max_velocity_m_s: float = Field(description="Maximum velocity [m/s]")
    flight_time_s: float = Field(description="Total flight time [s]")
    trajectory: Optional[FlightTrajectory] = Field(default=None, description="Flight trajectory data")
    truncation: Optional[TruncationInfo] = Field(default=None, description="Truncation info")
    propellant: Optional[PropellantDiagnostics] = Field(default=None, description="Propellant diagnostics")
    thrust_curve: Optional[dict] = Field(default=None, description="Thrust curve used (time, thrust arrays)")
    rocket_diagram: Optional[str] = Field(default=None, description="Base64-encoded rocket diagram PNG")
    error: Optional[str] = Field(default=None, description="Error message if failed")


class FlightOptimizeRequest(FlightSimRequest):
    """Request for minimum-fuel burn-time optimization to a target apogee."""
    target_apogee_m: float = Field(..., gt=0, description="Target apogee AGL [m]")
    apogee_tolerance_m: float = Field(default=15.0, ge=0, description="Apogee undershoot tolerance [m]")
    min_burn_time_s: Optional[float] = Field(default=None, gt=0, description="Optional lower burn-time bound [s]")
    max_burn_time_s: Optional[float] = Field(default=None, gt=0, description="Optional upper burn-time bound [s]")


class FlightOptimizeResponse(BaseModel):
    """Minimum-fuel burn-time optimization result."""
    status: str
    success: bool
    target_apogee_m: float
    apogee_tolerance_m: float
    optimal_burn_time_s: float
    optimal_lox_kg: float
    optimal_fuel_kg: float
    achieved_apogee_m: float
    apogee_error_m: float
    total_impulse_Ns: float
    simulations_run: int
    infeasible_reason: Optional[str] = None
    flight: Optional[FlightSimResponse] = Field(default=None, description="Full flight result at optimum")


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
        config_dict["environment"]["atmosphere_model"] = request.environment.atmosphere_model
    elif config_dict.get("environment") is None:
        # Set defaults
        config_dict["environment"] = {
            "latitude": 35.0,
            "longitude": -117.0,
            "elevation": 0.0,
            "date": [2025, 1, 1, 12],
            "atmosphere_model": "standard_atmosphere",
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
        config_dict["rocket"]["nose_kind"] = request.rocket.nose_kind
        config_dict["rocket"]["nose_fineness_ratio"] = request.rocket.nose_fineness_ratio
        if request.rocket.nose_length is not None:
            config_dict["rocket"]["nose_length"] = request.rocket.nose_length
        config_dict["rocket"]["avionics_payload_length_m"] = request.rocket.avionics_payload_length_m

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


def _apply_propellant_mass_caps(config_dict: dict, base_config) -> tuple[dict, dict, float | None, float | None, float]:
    """Cap LOX/fuel masses to tank capacity. Returns (mass_adjustments, lox_max, fuel_max, fill_factor)."""
    from engine.pipeline.config_schemas import PintleEngineConfig
    from engine.pipeline.tank_capacity import (
        resolve_fuel_tank_limits,
        resolve_lox_tank_limits,
        resolve_propellant_tank_fill_factor,
    )

    ox_density, fuel_density = _propellant_densities(base_config)
    fill_factor = resolve_propellant_tank_fill_factor(base_config)

    try:
        cap_config = PintleEngineConfig(**config_dict)
    except Exception:
        return {}, None, None, fill_factor

    mass_adjustments: dict = {}
    lox_tank_max = None
    fuel_tank_max = None

    if cap_config.lox_tank is not None:
        lox_max, lox_vol, lox_ff, lox_explicit = resolve_lox_tank_limits(cap_config, ox_density)
        lox_tank_max = lox_max
        fill_factor = lox_ff
        current_lox = float(config_dict.get("lox_tank", {}).get("mass", 0) or 0)
        effective = min(current_lox, lox_max) if current_lox > lox_max else current_lox
        if current_lox > lox_max:
            config_dict["lox_tank"]["mass"] = lox_max
            cap_note = "explicit capacity" if lox_explicit else f"{lox_ff * 100:.0f}% fill"
            print(f"[Flight] Capped LOX mass: {current_lox:.2f} -> {lox_max:.2f} kg ({cap_note}, vol {lox_vol * 1000:.1f}L)")
        mass_adjustments["lox"] = {
            "original": current_lox,
            "capped": effective if current_lox <= lox_max else lox_max,
            "max_fill_kg": lox_max,
            "tank_volume_m3": lox_vol,
            "fill_factor": lox_ff,
            "was_capped": current_lox > lox_max + 1e-6,
            "explicit_capacity_kg": lox_explicit,
        }

    if cap_config.fuel_tank is not None:
        fuel_max, fuel_vol, fuel_ff, fuel_explicit = resolve_fuel_tank_limits(cap_config, fuel_density)
        fuel_tank_max = fuel_max
        fill_factor = fuel_ff
        current_fuel = float(config_dict.get("fuel_tank", {}).get("mass", 0) or 0)
        effective = min(current_fuel, fuel_max) if current_fuel > fuel_max else current_fuel
        if current_fuel > fuel_max:
            config_dict["fuel_tank"]["mass"] = fuel_max
            cap_note = "explicit capacity" if fuel_explicit else f"{fuel_ff * 100:.0f}% fill"
            print(f"[Flight] Capped Fuel mass: {current_fuel:.2f} -> {fuel_max:.2f} kg ({cap_note}, vol {fuel_vol * 1000:.1f}L)")
        mass_adjustments["fuel"] = {
            "original": current_fuel,
            "capped": effective if current_fuel <= fuel_max else fuel_max,
            "max_fill_kg": fuel_max,
            "tank_volume_m3": fuel_vol,
            "fill_factor": fuel_ff,
            "was_capped": current_fuel > fuel_max + 1e-6,
            "explicit_capacity_kg": fuel_explicit,
        }

    return mass_adjustments, lox_tank_max, fuel_tank_max, fill_factor


def _integrate_series(times: np.ndarray, values: np.ndarray) -> float:
    if len(times) < 2:
        return 0.0
    if hasattr(np, "trapezoid"):
        return float(np.trapezoid(values, times))
    return float(np.trapz(values, times))


def _build_mass_cap_info(
    branch: str,
    requested_kg: float,
    effective_kg: float,
    tank_volume_m3: float,
    max_fill_kg: float,
    fill_factor: float,
) -> MassCapInfo:
    return MassCapInfo(
        requested_kg=float(requested_kg),
        effective_kg=float(effective_kg),
        max_fill_kg=float(max_fill_kg),
        fill_factor=fill_factor,
        tank_volume_m3=float(tank_volume_m3),
        was_capped=requested_kg > effective_kg + 1e-6,
    )


def _compute_propellant_diagnostics(
    *,
    times: np.ndarray,
    thrust_array: np.ndarray,
    mdot_O_array: np.ndarray,
    mdot_F_array: np.ndarray,
    lox_requested: float,
    fuel_requested: float,
    lox_effective: float,
    fuel_effective: float,
    lox_tank_max: Optional[float],
    fuel_tank_max: Optional[float],
    truncation: Optional[TruncationInfo],
    mass_caps: dict,
    target_apogee_m: Optional[float],
    propellant_tank_fill_factor: Optional[float] = None,
) -> PropellantDiagnostics:
    burn_time = float(times[-1] - times[0]) if len(times) > 1 else 0.0
    lox_required = _integrate_series(times, mdot_O_array)
    fuel_required = _integrate_series(times, mdot_F_array)
    total_impulse = _integrate_series(times, thrust_array)

    effective_burn = burn_time
    truncated = bool(truncation and truncation.truncated)
    if truncated and truncation.cutoff_time is not None:
        effective_burn = float(truncation.cutoff_time)
        # Required propellant only up to effective burn
        mask = times <= effective_burn + 1e-9
        if np.any(mask):
            t_eff = times[mask]
            lox_required = _integrate_series(t_eff, mdot_O_array[mask])
            fuel_required = _integrate_series(t_eff, mdot_F_array[mask])
            total_impulse = _integrate_series(t_eff, thrust_array[mask])

    warnings: List[str] = []
    for branch, cap in mass_caps.items():
        if cap.get("was_capped") or cap.get("original", cap.get("requested_kg", 0)) > cap.get("capped", cap.get("effective_kg", 0)) + 1e-6:
            req = cap.get("original", cap.get("requested_kg"))
            eff = cap.get("capped", cap.get("effective_kg"))
            mx = cap.get("max_fill_kg", cap.get("capped"))
            ff = cap.get("fill_factor", propellant_tank_fill_factor or 0.90)
            if cap.get("explicit_capacity_kg"):
                warnings.append(
                    f"{branch.upper()} mass capped: requested {req:.2f} kg → using {eff:.2f} kg "
                    f"(design_requirements capacity {mx:.2f} kg)"
                )
            else:
                warnings.append(
                    f"{branch.upper()} mass capped: requested {req:.2f} kg → using {eff:.2f} kg "
                    f"(tank max {mx:.2f} kg at {ff * 100:.0f}% fill)"
                )

    if fuel_tank_max and fuel_required > fuel_tank_max + 1e-6:
        warnings.append(
            f"Fuel tank max fill ({fuel_tank_max:.2f} kg) is below full-burn requirement "
            f"({fuel_required:.2f} kg) — burn will always truncate on fuel unless you shorten the time-series burn or enlarge the tank."
        )
    if lox_tank_max and lox_required > lox_tank_max + 1e-6:
        warnings.append(
            f"LOX tank max fill ({lox_tank_max:.2f} kg) is below full-burn requirement "
            f"({lox_required:.2f} kg) — burn will always truncate on LOX unless you shorten the time-series burn or enlarge the tank."
        )

    if truncated:
        regime = "truncated"
        warnings.append(
            f"Burn truncated at {effective_burn:.2f}s (need LOX {lox_required:.2f} kg, "
            f"fuel {fuel_required:.2f} kg for this burn; loaded {lox_effective:.2f}/{fuel_effective:.2f} kg)"
        )
    elif lox_effective >= lox_required * 0.995 and fuel_effective >= fuel_required * 0.995:
        if lox_effective > lox_required * 1.02 or fuel_effective > fuel_required * 1.02:
            regime = "excess_propellant"
            warnings.append(
                "Excess propellant loaded: burn uses full time-series curve but extra mass lowers apogee. "
                "Trim toward required amounts to optimize altitude."
            )
        else:
            regime = "full_burn"
    else:
        regime = "truncated"

    cap_models = {}
    for branch, raw in mass_caps.items():
        if isinstance(raw, MassCapInfo):
            cap_models[branch] = raw
        else:
            cap_models[branch] = _build_mass_cap_info(
                branch,
                raw.get("original", raw.get("requested_kg", 0)),
                raw.get("capped", raw.get("effective_kg", 0)),
                raw.get("tank_volume_m3", 0),
                raw.get("max_fill_kg", raw.get("capped", 0)),
                raw.get("fill_factor", propellant_tank_fill_factor or 0.90),
            )

    return PropellantDiagnostics(
        regime=regime,
        timeseries_burn_time_s=burn_time,
        effective_burn_time_s=effective_burn,
        total_impulse_Ns=total_impulse,
        lox_required_kg=lox_required,
        fuel_required_kg=fuel_required,
        lox_requested_kg=lox_requested,
        fuel_requested_kg=fuel_requested,
        lox_effective_kg=lox_effective,
        fuel_effective_kg=fuel_effective,
        lox_tank_max_kg=lox_tank_max,
        fuel_tank_max_kg=fuel_tank_max,
        target_apogee_m=target_apogee_m,
        mass_caps=cap_models or None,
        warnings=warnings,
        propellant_tank_fill_factor=propellant_tank_fill_factor,
    )


def _execute_flight_simulation(
    base_config,
    request: FlightSimRequest,
    *,
    time_array: Optional[np.ndarray] = None,
    thrust_array: Optional[np.ndarray] = None,
    mdot_O_array: Optional[np.ndarray] = None,
    mdot_F_array: Optional[np.ndarray] = None,
    lox_mass_kg: Optional[float] = None,
    fuel_mass_kg: Optional[float] = None,
) -> FlightSimResponse:
    """Run one flight simulation (shared by /simulate and /optimize-altitude)."""
    from engine.optimizer.copv_flight_helpers import run_flight_simulation
    from engine.pipeline.config_schemas import PintleEngineConfig

    sim_request = request
    if any(v is not None for v in (time_array, thrust_array, mdot_O_array, mdot_F_array, lox_mass_kg, fuel_mass_kg)):
        overrides = request.model_dump()
        if time_array is not None:
            overrides["time_array"] = time_array.tolist()
        if thrust_array is not None:
            overrides["thrust_array"] = thrust_array.tolist()
        if mdot_O_array is not None:
            overrides["mdot_O_array"] = mdot_O_array.tolist()
        if mdot_F_array is not None:
            overrides["mdot_F_array"] = mdot_F_array.tolist()
        if lox_mass_kg is not None:
            overrides["lox_mass_kg"] = float(lox_mass_kg)
        if fuel_mass_kg is not None:
            overrides["fuel_mass_kg"] = float(fuel_mass_kg)
        sim_request = FlightSimRequest(**overrides)

    config_dict = build_flight_config(base_config, sim_request)
    mass_adjustments, lox_tank_max, fuel_tank_max, fill_factor = _apply_propellant_mass_caps(
        config_dict, base_config
    )

    times = np.array(sim_request.time_array)
    thrust_array = np.array(sim_request.thrust_array)
    mdot_O_array = np.array(sim_request.mdot_O_array)
    mdot_F_array = np.array(sim_request.mdot_F_array)

    times = times - times[0]
    burn_time = float(times[-1])

    if config_dict.get("thrust") is None:
        config_dict["thrust"] = {}
    config_dict["thrust"]["burn_time"] = burn_time

    pressure_curves = {
        "time": times,
        "thrust": thrust_array,
        "mdot_O": mdot_O_array,
        "mdot_F": mdot_F_array,
    }

    try:
        flight_config = PintleEngineConfig(**config_dict)
    except Exception as e:
        return FlightSimResponse(
            status="error",
            apogee_m=0,
            apogee_ft=0,
            max_velocity_m_s=0,
            flight_time_s=0,
            error=f"Invalid flight configuration: {e}",
        )

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
    elevation = config_dict.get("environment", {}).get("elevation", 0.0)

    flight_time_s = 0.0
    if flight_obj is not None and hasattr(flight_obj, "t_final"):
        flight_time_s = float(flight_obj.t_final)

    trajectory = None
    if flight_obj is not None:
        flight_time_arr, flight_z, flight_vz = extract_flight_series(flight_obj, elevation)
        if len(flight_time_arr) > 0:
            trajectory = FlightTrajectory(
                time=flight_time_arr.tolist(),
                altitude=flight_z.tolist(),
                velocity=flight_vz.tolist(),
            )

    trunc_info = result.get("truncation_info", {})
    truncation = None
    if trunc_info:
        truncation = TruncationInfo(
            truncated=trunc_info.get("truncated", False),
            cutoff_time=trunc_info.get("cutoff_time"),
            reason=trunc_info.get("reason"),
        )

    rocket_diagram = generate_rocket_diagram(flight_obj) if flight_obj is not None else None

    lox_requested = float(sim_request.lox_mass_kg)
    fuel_requested = float(sim_request.fuel_mass_kg)
    lox_effective = float(config_dict.get("lox_tank", {}).get("mass", lox_requested))
    fuel_effective = float(config_dict.get("fuel_tank", {}).get("mass", fuel_requested))

    target_apogee_m = None
    dr = config_dict.get("design_requirements") or {}
    if isinstance(dr, dict) and dr.get("target_apogee") is not None:
        target_apogee_m = float(dr["target_apogee"])

    propellant_diag = _compute_propellant_diagnostics(
        times=times,
        thrust_array=thrust_array,
        mdot_O_array=mdot_O_array,
        mdot_F_array=mdot_F_array,
        lox_requested=lox_requested,
        fuel_requested=fuel_requested,
        lox_effective=lox_effective,
        fuel_effective=fuel_effective,
        lox_tank_max=lox_tank_max,
        fuel_tank_max=fuel_tank_max,
        truncation=truncation,
        mass_caps=mass_adjustments,
        target_apogee_m=target_apogee_m,
        propellant_tank_fill_factor=fill_factor,
    )

    return FlightSimResponse(
        status="success",
        apogee_m=apogee,
        apogee_ft=apogee * 3.28084,
        max_velocity_m_s=max_velocity,
        flight_time_s=flight_time_s,
        trajectory=trajectory,
        truncation=truncation,
        propellant=propellant_diag,
        thrust_curve={
            "time": times.tolist(),
            "thrust_N": thrust_array.tolist(),
        },
        rocket_diagram=rocket_diagram,
    )


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
            detail="No config loaded. Upload a config file first.",
        )

    try:
        try:
            from engine.optimizer.copv_flight_helpers import run_flight_simulation  # noqa: F401
        except ImportError as e:
            raise HTTPException(
                status_code=500,
                detail=f"RocketPy or flight simulation module not available: {e}",
            )

        return _execute_flight_simulation(app_state.config, request)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Flight simulation failed: {str(e)}",
        )


@router.post("/optimize-altitude", response_model=FlightOptimizeResponse)
async def optimize_flight_altitude(request: FlightOptimizeRequest):
    """Find minimum-fuel burn time to reach a target apogee for the loaded time-series curve."""
    if not app_state.has_config():
        raise HTTPException(
            status_code=400,
            detail="No config loaded. Upload a config file first.",
        )

    try:
        try:
            from engine.optimizer.copv_flight_helpers import run_flight_simulation  # noqa: F401
        except ImportError as e:
            raise HTTPException(
                status_code=500,
                detail=f"RocketPy or flight simulation module not available: {e}",
            )

        from engine.pipeline.flight_altitude_optimizer import (
            BurnTimeEval,
            optimize_minimum_fuel_burn_time,
            required_propellant_at_burn_time,
            truncate_time_series,
        )

        times = np.array(request.time_array, dtype=float)
        thrust = np.array(request.thrust_array, dtype=float)
        mdot_O = np.array(request.mdot_O_array, dtype=float)
        mdot_F = np.array(request.mdot_F_array, dtype=float)

        def simulate_at_burn_time(burn_time_s: float) -> BurnTimeEval:
            lox_req, fuel_req, _ = required_propellant_at_burn_time(
                times, thrust, mdot_O, mdot_F, burn_time_s
            )
            t_out, thrust_out, mdot_O_out, mdot_F_out = truncate_time_series(
                times, thrust, mdot_O, mdot_F, burn_time_s
            )
            flight_result = _execute_flight_simulation(
                app_state.config,
                request,
                time_array=t_out,
                thrust_array=thrust_out,
                mdot_O_array=mdot_O_out,
                mdot_F_array=mdot_F_out,
                lox_mass_kg=lox_req,
                fuel_mass_kg=fuel_req,
            )
            if flight_result.status != "success":
                return BurnTimeEval(
                    burn_time_s=burn_time_s,
                    lox_required_kg=lox_req,
                    fuel_required_kg=fuel_req,
                    apogee_m=flight_result.apogee_m,
                    success=False,
                    error=flight_result.error,
                )
            return BurnTimeEval(
                burn_time_s=burn_time_s,
                lox_required_kg=lox_req,
                fuel_required_kg=fuel_req,
                apogee_m=flight_result.apogee_m,
                success=True,
            )

        opt = optimize_minimum_fuel_burn_time(
            times=times,
            thrust=thrust,
            mdot_O=mdot_O,
            mdot_F=mdot_F,
            target_apogee_m=float(request.target_apogee_m),
            apogee_tolerance_m=float(request.apogee_tolerance_m),
            simulate_at_burn_time=simulate_at_burn_time,
            min_burn_time_s=request.min_burn_time_s,
            max_burn_time_s=request.max_burn_time_s,
        )

        flight_at_optimum = None
        if opt.success:
            lox_req, fuel_req, _ = required_propellant_at_burn_time(
                times, thrust, mdot_O, mdot_F, opt.optimal_burn_time_s
            )
            t_out, thrust_out, mdot_O_out, mdot_F_out = truncate_time_series(
                times, thrust, mdot_O, mdot_F, opt.optimal_burn_time_s
            )
            flight_at_optimum = _execute_flight_simulation(
                app_state.config,
                request,
                time_array=t_out,
                thrust_array=thrust_out,
                mdot_O_array=mdot_O_out,
                mdot_F_array=mdot_F_out,
                lox_mass_kg=lox_req,
                fuel_mass_kg=fuel_req,
            )

        return FlightOptimizeResponse(
            status="success" if opt.success else "infeasible",
            success=opt.success,
            target_apogee_m=opt.target_apogee_m,
            apogee_tolerance_m=opt.apogee_tolerance_m,
            optimal_burn_time_s=opt.optimal_burn_time_s,
            optimal_lox_kg=opt.optimal_lox_kg,
            optimal_fuel_kg=opt.optimal_fuel_kg,
            achieved_apogee_m=opt.achieved_apogee_m,
            apogee_error_m=opt.apogee_error_m,
            total_impulse_Ns=opt.total_impulse_Ns,
            simulations_run=opt.simulations_run,
            infeasible_reason=opt.infeasible_reason,
            flight=flight_at_optimum,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Altitude optimization failed: {str(e)}",
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

