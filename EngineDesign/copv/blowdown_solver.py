"""
Pure blowdown pressurization solver.

This module simulates propellant tank pressure decay due to ullage expansion
as propellant is consumed, with no COPV or external pressurant makeup.

Physics model:
- Fixed pressurant gas mass in each tank
- Polytropic temperature relation: T(t) = T0 * (V0/V(t))^(n-1)
- Real gas effects via compressibility factor Z(P,T) in EOS: P = m*Z*R*T/V
- Coupled simulation: Pressure -> mdot -> Mass Depletion -> Volume Expansion -> Pressure
"""

from functools import lru_cache

import numpy as np
import pandas as pd
from typing import Dict, Optional, Tuple, Callable, Any
from scipy.interpolate import RegularGridInterpolator


def split_propellant_by_of(total_kg: float, of_ratio: float) -> Tuple[float, float]:
    """Split total propellant mass into (oxidizer_kg, fuel_kg) for O/F = of_ratio."""
    total_kg = float(total_kg)
    of_ratio = max(float(of_ratio), 1e-9)
    m_fuel = total_kg / (1.0 + of_ratio)
    m_oxidizer = total_kg - m_fuel
    return m_oxidizer, m_fuel


def resolve_tank_volume_m3(
    *,
    tank_volume_m3: Optional[float],
    ullage_volume_m3: Optional[float],
    propellant_mass_kg: float,
    density_kg_m3: float,
    tank_name: str = "tank",
) -> float:
    """Resolve total tank volume from either explicit volume or ullage + liquid fill."""
    if tank_volume_m3 is not None and ullage_volume_m3 is not None:
        liquid_vol = propellant_mass_kg / max(density_kg_m3, 1e-9)
        expected_ullage = float(tank_volume_m3) - liquid_vol
        rel_err = abs(expected_ullage - float(ullage_volume_m3)) / max(abs(float(ullage_volume_m3)), 1e-9)
        if rel_err > 0.05:
            raise ValueError(
                f"{tank_name}: tank volume and ullage volume are inconsistent "
                f"(expected ullage {expected_ullage:.6f} m³, got {float(ullage_volume_m3):.6f} m³)"
            )
        return float(tank_volume_m3)

    if tank_volume_m3 is not None:
        vol = float(tank_volume_m3)
    elif ullage_volume_m3 is not None:
        liquid_vol = propellant_mass_kg / max(density_kg_m3, 1e-9)
        vol = float(ullage_volume_m3) + liquid_vol
    else:
        raise ValueError(f"{tank_name}: provide tank_volume_m3 or ullage_volume_m3")

    liquid_vol = propellant_mass_kg / max(density_kg_m3, 1e-9)
    if vol <= liquid_vol:
        raise ValueError(
            f"{tank_name}: tank volume {vol:.6f} m³ is too small for "
            f"{propellant_mass_kg:.4f} kg propellant (liquid volume {liquid_vol:.6f} m³)"
        )
    return vol


def resolve_blowdown_tank_state(
    config: Any,
    *,
    total_propellant_kg: Optional[float] = None,
    of_ratio: Optional[float] = None,
    lox_tank_volume_m3: Optional[float] = None,
    lox_ullage_volume_m3: Optional[float] = None,
    fuel_tank_volume_m3: Optional[float] = None,
    fuel_ullage_volume_m3: Optional[float] = None,
    lox_propellant_mass_kg: Optional[float] = None,
    fuel_propellant_mass_kg: Optional[float] = None,
) -> Tuple[float, float, float, float, float, float]:
    """Resolve LOX/fuel (volume_m3, mass_kg, density) for blowdown simulation.

    Falls back to config tank fields when overrides are omitted.
    """
    rho_lox = float(config.fluids["oxidizer"].density)
    rho_fuel = float(config.fluids["fuel"].density)

    if lox_propellant_mass_kg is not None and fuel_propellant_mass_kg is not None:
        m_lox = float(lox_propellant_mass_kg)
        m_fuel = float(fuel_propellant_mass_kg)
    elif total_propellant_kg is not None:
        if of_ratio is None:
            dr = getattr(config, "design_requirements", None)
            of_ratio = float(getattr(dr, "optimal_of_ratio", None) or 2.5)
        m_lox, m_fuel = split_propellant_by_of(float(total_propellant_kg), float(of_ratio))
    else:
        lox_tank = getattr(config, "lox_tank", None)
        fuel_tank = getattr(config, "fuel_tank", None)
        m_lox = float(getattr(lox_tank, "mass", None) or 0.0)
        m_fuel = float(getattr(fuel_tank, "mass", None) or 0.0)
        if m_lox <= 0 or m_fuel <= 0:
            raise ValueError(
                "Blowdown requires total_propellant_kg or positive lox_tank.mass and fuel_tank.mass in config"
            )

    if lox_tank_volume_m3 is not None or lox_ullage_volume_m3 is not None:
        V_lox = resolve_tank_volume_m3(
            tank_volume_m3=lox_tank_volume_m3,
            ullage_volume_m3=lox_ullage_volume_m3,
            propellant_mass_kg=m_lox,
            density_kg_m3=rho_lox,
            tank_name="LOX tank",
        )
    else:
        V_lox = config_tank_volume_m3(config, "lox_tank", "lox_h", "lox_radius", "LOX tank")

    if fuel_tank_volume_m3 is not None or fuel_ullage_volume_m3 is not None:
        V_fuel = resolve_tank_volume_m3(
            tank_volume_m3=fuel_tank_volume_m3,
            ullage_volume_m3=fuel_ullage_volume_m3,
            propellant_mass_kg=m_fuel,
            density_kg_m3=rho_fuel,
            tank_name="Fuel tank",
        )
    else:
        V_fuel = config_tank_volume_m3(config, "fuel_tank", "rp1_h", "rp1_radius", "Fuel tank")

    return V_lox, m_lox, rho_lox, V_fuel, m_fuel, rho_fuel


def config_tank_volume_m3(config: Any, tank_attr: str, h_attr: str, r_attr: str,
                          label: Optional[str] = None) -> float:
    """Total tank volume [m^3] from config.

    Prefers the explicit ``tank_volume_m3`` (real hardware), then the cylindrical approximation,
    then the legacy ``config.propellant`` fallback.

    Single source of truth for every blowdown consumer (the Layer-2 branch and the
    ``/timeseries`` blowdown endpoint both need it). Blowdown pressure is driven by ULLAGE
    VOLUME, so a volume is genuinely required — a kg ``*_tank_capacity_kg`` mission requirement
    is density-dependent and cannot substitute for it.
    """
    label = label or tank_attr
    tank = getattr(config, tank_attr, None)
    if tank is not None:
        vol = getattr(tank, "tank_volume_m3", None)
        if vol:
            return float(vol)
        h = getattr(tank, h_attr, None)
        r = getattr(tank, r_attr, None)
        if h and r:
            return float(np.pi * float(r) ** 2 * float(h))
    prop = getattr(config, "propellant", None)
    if prop is not None and getattr(prop, "tank_volume_m3", None):
        return float(prop.tank_volume_m3)
    raise ValueError(
        f"{label}: tank volume not specified. Set config.{tank_attr}.tank_volume_m3 (or "
        f"{h_attr}/{r_attr}). Blowdown pressure is set by ullage expansion, so tank VOLUME is "
        f"required; a kg tank-capacity requirement is density-dependent and cannot substitute."
    )


def make_engine_evaluator(runner: Any) -> Callable[[float, float], Tuple[float, float]]:
    """Build the ``(P_lox_Pa, P_fuel_Pa) -> (mdot_O, mdot_F)`` callback this solver expects.

    Shared by every blowdown consumer so they cannot drift apart.

    Deliberately does NOT swallow exceptions. The chamber solver raises once it can no longer
    close, and :func:`simulate_coupled_blowdown` interprets that as flameout — the physically
    correct end of a blowdown burn. Returning ``(0, 0)`` on *any* exception (as the timeseries
    endpoint used to) also silently reports "engine off" for genuine defects, producing a
    plausible-looking but wrong curve.
    """

    def evaluate(P_lox_Pa: float, P_fuel_Pa: float) -> Tuple[float, float]:
        res = runner.evaluate(P_lox_Pa, P_fuel_Pa, silent=True)
        return float(res["mdot_O"]), float(res["mdot_F"])

    return evaluate


def polytropic_exponents_from_config(config: Any, default_lox: float = 1.40,
                                     default_fuel: float = 1.20) -> Tuple[float, float]:
    """Nominal per-tank polytropic exponents from ``design_requirements``.

    LOX runs higher than fuel by default: the LOX ullage sits on cryogenic liquid — a heat SINK —
    so it cools, and therefore decays, faster than a fuel ullage warmed by near-ambient walls.
    Shared so the Layer-2 branch and the timeseries endpoint cannot model the same tank
    differently.
    """
    dr = getattr(config, "design_requirements", None)
    n_lox = getattr(dr, "blowdown_n_polytropic_lox", None) if dr is not None else None
    n_fuel = getattr(dr, "blowdown_n_polytropic_fuel", None) if dr is not None else None
    return float(n_lox or default_lox), float(n_fuel or default_fuel)


@lru_cache(maxsize=4)
def load_Z_lookup_table_cached(csv_path: str) -> Tuple[RegularGridInterpolator, np.ndarray, np.ndarray]:
    """Cached :func:`load_Z_lookup_table`. The table is static, but a Layer-2 blowdown search calls
    ``simulate_coupled_blowdown`` ~100 times; re-reading the CSV and rebuilding the interpolator
    each time dominated the runtime."""
    return load_Z_lookup_table(csv_path)


def resolve_Z_table_path(csv_path: str) -> str:
    """Resolve the N2 compressibility table path.

    The default is a bare filename, which previously only resolved when the caller's cwd happened
    to be this package — anywhere else every blowdown candidate died with FileNotFoundError. Fall
    back to the copy that ships next to this module.
    """
    import os

    if os.path.isfile(csv_path):
        return csv_path
    local = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.path.basename(csv_path))
    if os.path.isfile(local):
        return local
    raise FileNotFoundError(
        f"N2 compressibility table not found: {csv_path!r} (also tried {local!r}). "
        "Pass n2_Z_csv=<path>, or use_real_gas=False to skip the real-gas correction."
    )


def load_Z_lookup_table(csv_path: str) -> Tuple[RegularGridInterpolator, np.ndarray, np.ndarray]:
    """Load compressibility factor Z(P,T) lookup table from CSV."""
    df_z = pd.read_csv(csv_path)
    T_vals = np.unique(np.sort(df_z["T_K"].values))
    P_vals = np.unique(np.sort(df_z["P_Pa"].values))
    pivot = df_z.pivot(index="T_K", columns="P_Pa", values="Z")
    pivot = pivot.reindex(index=T_vals, columns=P_vals)
    Z_grid = pivot.values
    interp = RegularGridInterpolator(
        (T_vals, P_vals), 
        Z_grid,
        bounds_error=False, 
        fill_value=None
    )
    return interp, T_vals, P_vals


def Z_lookup(
    T_K: float | np.ndarray, 
    P_Pa: float | np.ndarray, 
    interp: RegularGridInterpolator, 
    default_Z: float = 1.0
) -> float | np.ndarray:
    """Lookup compressibility factor Z at given temperature and pressure."""
    T_arr = np.atleast_1d(T_K).astype(float)
    P_arr = np.atleast_1d(P_Pa).astype(float)
    
    if T_arr.size == 1 and P_arr.size > 1:
        T_arr = np.full_like(P_arr, T_arr[0])
    elif P_arr.size == 1 and T_arr.size > 1:
        P_arr = np.full_like(T_arr, P_arr[0])
    elif T_arr.size != P_arr.size:
        raise ValueError("Temperature and pressure arrays must have matching sizes.")
    
    pts = np.column_stack([T_arr, P_arr])
    Z_vals = interp(pts)
    Z_vals = np.where(np.isnan(Z_vals), default_Z, Z_vals)
    
    if np.isscalar(T_K) and np.isscalar(P_Pa):
        return float(Z_vals[0])
    return Z_vals


_NO_SOLUTION_MARKERS = ("no solution", "supply < demand", "insufficient mass flow")


def is_no_solution_error(exc: BaseException) -> bool:
    """True when the chamber solver reported that no steady operating point exists.

    As the tanks decay there comes a point where injector supply is below combustion demand at
    every chamber pressure, so the root-find has no solution and the solver raises. That is a
    physical FLAMEOUT — the normal end of a blowdown burn — not a defect.

    Deliberately narrow: a ``TypeError``/``KeyError``/``AttributeError`` from an actual bug must
    NOT be silently reclassified as end-of-burn. Anything unrecognised propagates.
    """
    if not isinstance(exc, (ValueError, ArithmeticError)):
        return False
    msg = str(exc).lower()
    return any(marker in msg for marker in _NO_SOLUTION_MARKERS)


class TankState:
    """Helper class to track individual tank state during blowdown."""
    def __init__(
        self,
        vol_total: float,
        m_prop_initial: float,
        rho_prop: float,
        P_initial: float,
        T_gas_initial: float,
        R_gas: float,
        Z_interp: Optional[RegularGridInterpolator],
        n_poly: float = 1.2
    ):
        self.V_total = vol_total
        self.m_prop = m_prop_initial
        self.rho = rho_prop
        self.n_poly = n_poly
        self.R = R_gas
        self.Z_interp = Z_interp
        self.T0 = T_gas_initial  # Store T0 for polytropic calc
        
        # Initial geometry
        self.V_ullage_0 = self.V_total - (self.m_prop / self.rho)
        if self.V_ullage_0 <= 0:
            raise ValueError(f"Tank overfilled: V_tank={self.V_total:.4f}, m_prop={self.m_prop:.4f}, rho={self.rho}")
            
        self.V_ullage = self.V_ullage_0
        
        # Initial Gas State
        self.T_gas = T_gas_initial
        self.P_gas = P_initial
        
        # Calculate fixed gas mass
        Z = self.get_Z(self.T_gas, self.P_gas)
        self.m_gas = (self.P_gas * self.V_ullage_0) / (Z * self.R * self.T_gas)
        
    def get_Z(self, T, P):
        if self.Z_interp:
            return Z_lookup(T, P, self.Z_interp)
        return 1.0

    def snapshot(self) -> Tuple[float, float, float, float, float]:
        """Capture the mutable state so a predictor step can be rolled back (Heun corrector)."""
        return (self.m_prop, self.V_ullage, self.m_gas, self.T_gas, self.P_gas)

    def restore(self, snap: Tuple[float, float, float, float, float]) -> None:
        """Restore state captured by :meth:`snapshot`. ``m_gas_0`` is intentionally left intact —
        it is the *initial* gas mass and must survive a rollback."""
        self.m_prop, self.V_ullage, self.m_gas, self.T_gas, self.P_gas = snap

    def step(self, mdot: float, dt: float, mdot_gas: float = 0.0) -> float:
        """Advance tank state by dt. 
        
        Args:
            mdot: Liquid propellant mass flow rate [kg/s] (leaving tank)
            dt: Time step [s]
            mdot_gas: Gas/Pressurant mass flow rate [kg/s] (leaving tank, venting)
            
        Returns:
            New Pressure [Pa]
        """
        if dt <= 0:
            return self.P_gas
            
        # 1. Update Propellant Mass (Depletion check)
        dm = mdot * dt
        self.m_prop = max(0.0, self.m_prop - dm)
        
        # Explicit clamp to 0.0 for very small values to ensure consistent empty state
        if self.m_prop < 1e-9:
             self.m_prop = 0.0
        
        # 2. Update Ullage Volume
        # If prop is depleted, V_ullage assumes full tank volume
        if self.m_prop <= 0.0:
            self.V_ullage = self.V_total
        else:
            self.V_ullage = max(1e-9, self.V_total - (self.m_prop / self.rho))
        
        # 3. Update Gas Mass (Venting)
        if mdot_gas > 0:
            dm_gas = mdot_gas * dt
            self.m_gas = max(1e-9, self.m_gas - dm_gas)
        
        # 4. Polytropic Temperature Update
        # T = T0 * (V0 / V)^(n-1)
        # Note: This simple polytropic relation assumes constant mass expansion.
        # With venting (variable mass), we should ideally use first law:
        # dU = dQ - dW + h_in*dm_in - h_out*dm_out
        #
        # For simple blowdown venting, isentropic expansion of remaining gas is a decent approx
        # T2 = T1 * (P2/P1)^((g-1)/g)
        # But we don't have P2 yet.
        #
        # Let's stick to the polytropic volume expansion for the 'expansion' part,
        # but we also have mass loss.
        # P = m*Z*R*T / V
        # If we vent, m decreases.
        # Simple approach for gas venting phase: 
        # Assume isentropic/polytropic expansion from LOSS of density?
        # rho_gas = m_gas / V_ullage
        # T = T_initial * (rho_gas / rho_gas_initial)^(n-1)
        # 
        # Re-derive T based on current state relative to initial state?
        # self.T_gas = self.T0 * ( (self.m_gas/self.V_ullage) / (self.m_gas_initial/self.V_ullage_0) ) ** (self.n_poly - 1.0)
        # We need to track initial gas mass for this.
        
        # Store initial gas mass if not present
        if not hasattr(self, 'm_gas_0'):
             self.m_gas_0 = self.m_gas
             
        rho_gas_0 = self.m_gas_0 / self.V_ullage_0
        rho_gas_current = self.m_gas / self.V_ullage
        
        self.T_gas = self.T0 * (rho_gas_current / rho_gas_0) ** (self.n_poly - 1.0)
        
        # 5. Solves Pressure Iteratively (since Z depends on P)
        self.P_gas = self.solve_pressure(self.T_gas, self.V_ullage, self.P_gas)
        
        return self.P_gas

    def solve_pressure(self, T, V, P_guess):
        P = P_guess
        # Fixed point iteration with max steps
        for _ in range(10):
            Z = self.get_Z(T, P)
            P_new = (self.m_gas * Z * self.R * T) / V
            
            # Check convergence
            if abs(P_new - P) / max(1.0, P_new) < 1e-6:
                return P_new
                
            P = P_new
        
        return P


def calculate_compressible_gas_flow(
    P_up: float,
    P_down: float,
    T_up: float,
    Area: float,
    gamma: float,
    R: float,
    Cd: float = 0.8
) -> float:
    """Calculate compressible gas mass flow through an orifice (venting)."""
    if P_up <= P_down:
        return 0.0
        
    pr_ratio = P_down / P_up
    
    # Critical pressure ratio for choked flow
    pr_crit = (2 / (gamma + 1)) ** (gamma / (gamma - 1))
    
    if pr_ratio < pr_crit:
        # Choked flow
        # mdot = Cd * A * P_up * sqrt(gamma/(R*T_up)) * (2/(gamma+1))^((gamma+1)/(2(gamma-1)))
        # Simplified choked flow constant
        C_star = np.sqrt(gamma * (2/(gamma+1)) ** ((gamma+1)/(gamma-1)))
        mdot = Cd * Area * P_up / np.sqrt(R * T_up) * C_star
    else:
        # Subsonic flow
        # mdot = Cd * A * P_up * sqrt(2*gamma/((gamma-1)RT)) * sqrt(pr^(2/gamma) - pr^((gamma+1)/gamma))
        term1 = (2 * gamma) / ((gamma - 1) * R * T_up)
        term2 = pr_ratio ** (2 / gamma) - pr_ratio ** ((gamma + 1) / gamma)
        mdot = Cd * Area * P_up * np.sqrt(term1 * term2)
        
    return max(0.0, mdot)


def simulate_coupled_blowdown(
    times: np.ndarray,
    evaluate_engine_fn: Callable[[float, float], Tuple[float, float]],
    P_lox_initial_Pa: float,
    P_fuel_initial_Pa: float,
    config,
    *,
    R_pressurant: float = 296.803,
    T_lox_gas_K: float = 250.0,
    T_fuel_gas_K: float = 293.0,
    n_polytropic: float = 1.2,
    n_polytropic_lox: Optional[float] = None,
    n_polytropic_fuel: Optional[float] = None,
    use_real_gas: bool = True,
    n2_Z_csv: str = "n2_Z_lookup.csv",
    total_propellant_kg: Optional[float] = None,
    of_ratio: Optional[float] = None,
    lox_tank_volume_m3: Optional[float] = None,
    lox_ullage_volume_m3: Optional[float] = None,
    fuel_tank_volume_m3: Optional[float] = None,
    fuel_ullage_volume_m3: Optional[float] = None,
    lox_propellant_mass_kg: Optional[float] = None,
    fuel_propellant_mass_kg: Optional[float] = None,
) -> Dict[str, Dict[str, np.ndarray]]:
    """
    Simulate coupled blowdown for both LOX and fuel tanks.
    
    Parameters
    ----------
    times : np.ndarray
        Time points (s)
    evaluate_engine_fn : function
        Callback (P_lox_Pa, P_fuel_Pa) -> (mdot_lox_kg_s, mdot_fuel_kg_s)
    P_lox_initial_Pa, P_fuel_initial_Pa : float
        Initial tank pressures
    config : EngineConfig
        Configuration object with tank geometry
        
    Returns
    -------
    dict with full time-series traces for both tanks
    """
    # Load Z lookup
    Z_interp = None
    if use_real_gas:
        Z_interp, _, _ = load_Z_lookup_table_cached(resolve_Z_table_path(n2_Z_csv))
        
    # Helpers to extract config (legacy fallback when no overrides supplied)
    def get_tank_params(fluid_key, tank_attr, h_attr, r_attr):
        rho = float(config.fluids[fluid_key].density)

        tank = getattr(config, tank_attr, None)
        if tank and hasattr(tank, 'tank_volume_m3') and tank.tank_volume_m3 is not None:
            V = float(tank.tank_volume_m3)
        elif tank and hasattr(tank, h_attr) and hasattr(tank, r_attr):
            V = float(np.pi * getattr(tank, r_attr)**2 * getattr(tank, h_attr))
        elif hasattr(config, 'propellant') and hasattr(config.propellant, 'tank_volume_m3'):
            V = float(config.propellant.tank_volume_m3)
        else:
            V = 0.01

        if tank and hasattr(tank, 'mass'):
            m = float(tank.mass)
        elif hasattr(config, 'propellant') and hasattr(config.propellant, 'initial_mass_kg'):
            m = float(config.propellant.initial_mass_kg)
        else:
            m = 0.0

        return rho, V, m

    has_tank_overrides = any(
        v is not None
        for v in (
            total_propellant_kg,
            lox_tank_volume_m3,
            lox_ullage_volume_m3,
            fuel_tank_volume_m3,
            fuel_ullage_volume_m3,
            lox_propellant_mass_kg,
            fuel_propellant_mass_kg,
        )
    )
    if has_tank_overrides:
        V_lox, m_lox, rho_lox, V_fuel, m_fuel, rho_fuel = resolve_blowdown_tank_state(
            config,
            total_propellant_kg=total_propellant_kg,
            of_ratio=of_ratio,
            lox_tank_volume_m3=lox_tank_volume_m3,
            lox_ullage_volume_m3=lox_ullage_volume_m3,
            fuel_tank_volume_m3=fuel_tank_volume_m3,
            fuel_ullage_volume_m3=fuel_ullage_volume_m3,
            lox_propellant_mass_kg=lox_propellant_mass_kg,
            fuel_propellant_mass_kg=fuel_propellant_mass_kg,
        )
    else:
        rho_lox, V_lox, m_lox = get_tank_params('oxidizer', 'lox_tank', 'lox_h', 'lox_radius')
        rho_fuel, V_fuel, m_fuel = get_tank_params('fuel', 'fuel_tank', 'rp1_h', 'rp1_radius')

    # Helper to calculate approximate injector discharge area
    # NOTE: For gas venting after propellant depletion, we use a LARGER effective area
    # because: (1) gas flows much faster than liquid, (2) real systems have relief valves
    GAS_VENTING_AREA_MULTIPLIER = 10.0  # Gas venting uses 10x larger effective area
    
    def get_injector_area(fluid_type: str, for_gas_venting: bool = False) -> float:
        try:
            inj = config.injector
            geom = inj.geometry
            if inj.type == 'pintle':
                if fluid_type == 'oxidizer':
                    # LOX flow: n_orifices * A_entry
                    liquid_area = float(geom.lox.n_orifices * geom.lox.A_entry)
                else:
                    # Fuel flow: Gap area is likely the choke point
                    # A_gap = pi * d_tip * h_gap
                    liquid_area = float(np.pi * geom.fuel.d_pintle_tip * geom.fuel.h_gap)
            elif inj.type == 'coaxial':
                 if fluid_type == 'oxidizer':
                     # Core flow: n_elements * A_port
                     liquid_area = float(geom.core.n_ports * np.pi * (geom.core.d_port/2)**2)
                 else:
                     # Annulus flow
                     liquid_area = float(geom.core.n_ports * np.pi * ((geom.annulus.inner_diameter + 2*geom.annulus.gap_thickness)/2)**2 - np.pi*(geom.annulus.inner_diameter/2)**2)
            else:
                # Default fallback
                liquid_area = 1e-4
            
            # For gas venting, use larger effective area for rapid pressure drop
            if for_gas_venting:
                return max(liquid_area * GAS_VENTING_AREA_MULTIPLIER, 1e-3)  # Min 10 cm² for gas venting
            return max(liquid_area, 1e-5)
        except Exception:
            return 1e-3 if for_gas_venting else 1e-4

    A_inj_lox = get_injector_area('oxidizer')
    A_inj_fuel = get_injector_area('fuel')
    
    # Per-tank polytropic exponent. The LOX ullage sits on cryogenic liquid — a heat SINK — so it
    # cools faster than the fuel ullage (whose near-ambient walls act as a heat SOURCE), and its
    # effective n runs higher, potentially >= gamma. Sharing one n under-predicts LOX decay, which
    # over-predicts end-of-burn tank pressure: the dangerous direction for the chug margin.
    # ``n_polytropic`` remains the shared fallback so existing callers are unaffected.
    n_lox = float(n_polytropic if n_polytropic_lox is None else n_polytropic_lox)
    n_fuel = float(n_polytropic if n_polytropic_fuel is None else n_polytropic_fuel)

    # Initialize Tank States
    lox_tank = TankState(V_lox, m_lox, rho_lox, P_lox_initial_Pa, T_lox_gas_K, R_pressurant, Z_interp, n_lox)
    fuel_tank = TankState(V_fuel, m_fuel, rho_fuel, P_fuel_initial_Pa, T_fuel_gas_K, R_pressurant, Z_interp, n_fuel)
    
    # Arrays to store history
    N = len(times)
    history = {
        'lox': {k: np.zeros(N) for k in ['P_Pa', 'T_K', 'V_ullage_m3', 'mdot_kg_s', 'm_prop_kg']},
        'fuel': {k: np.zeros(N) for k in ['P_Pa', 'T_K', 'V_ullage_m3', 'mdot_kg_s', 'm_prop_kg']}
    }
    # Add depletion flags for flameout masking
    history['lox']['is_depleted'] = np.zeros(N, dtype=bool)
    history['fuel']['is_depleted'] = np.zeros(N, dtype=bool)
    # True once the chamber solver can no longer close (it raises "supply < demand at all Pc" as
    # the tanks decay). That is a physical flameout, distinct from propellant depletion.
    history['engine_out'] = np.zeros(N, dtype=bool)

    # Initial Conditions (t=0)
    # We need initial mdot based on initial Pressure
    try:
        mdot_lox_0, mdot_fuel_0 = evaluate_engine_fn(P_lox_initial_Pa, P_fuel_initial_Pa)
        engine_out = False
    except Exception as exc:
        if not is_no_solution_error(exc):
            raise
        # The engine cannot even close at the start pressure — nothing to simulate.
        mdot_lox_0, mdot_fuel_0 = 0.0, 0.0
        engine_out = True
    
    # Store t=0
    history['lox']['P_Pa'][0] = lox_tank.P_gas
    history['lox']['T_K'][0] = lox_tank.T_gas
    history['lox']['V_ullage_m3'][0] = lox_tank.V_ullage
    history['lox']['mdot_kg_s'][0] = mdot_lox_0
    history['lox']['m_prop_kg'][0] = lox_tank.m_prop
    
    history['fuel']['P_Pa'][0] = fuel_tank.P_gas
    history['fuel']['T_K'][0] = fuel_tank.T_gas
    history['fuel']['V_ullage_m3'][0] = fuel_tank.V_ullage
    history['fuel']['mdot_kg_s'][0] = mdot_fuel_0
    history['fuel']['m_prop_kg'][0] = fuel_tank.m_prop
    
    # ambient pressure for venting
    P_amb = 101325.0 
    gamma_gas = 1.4 # Nitrogen
    
    # Time Stepping Loop
    for i in range(1, N):
        dt = times[i] - times[i-1]
        
        # Get flows from PREVIOUS step
        mdot_lox_liquid_prev = history['lox']['mdot_kg_s'][i-1]
        mdot_fuel_liquid_prev = history['fuel']['mdot_kg_s'][i-1]
        
        # Determine if we are in gas venting phase for either tank
        # LOX - track depletion state
        lox_depleted = lox_tank.m_prop <= 1e-4  # effectively empty
        if lox_depleted:
             mdot_lox_liquid = 0.0
             # Use LARGER venting area for rapid pressure drop
             A_vent_lox = get_injector_area('oxidizer', for_gas_venting=True)
             mdot_lox_gas = calculate_compressible_gas_flow(
                 lox_tank.P_gas, P_amb, lox_tank.T_gas, A_vent_lox, gamma_gas, R_pressurant
             )
        else:
             mdot_lox_liquid = mdot_lox_liquid_prev
             mdot_lox_gas = 0.0
             
        # Fuel - track depletion state
        fuel_depleted = fuel_tank.m_prop <= 1e-4
        if fuel_depleted:
             mdot_fuel_liquid = 0.0
             # Use LARGER venting area for rapid pressure drop
             A_vent_fuel = get_injector_area('fuel', for_gas_venting=True)
             mdot_fuel_gas = calculate_compressible_gas_flow(
                 fuel_tank.P_gas, P_amb, fuel_tank.T_gas, A_vent_fuel, gamma_gas, R_pressurant
             )
        else:
             mdot_fuel_liquid = mdot_fuel_liquid_prev
             mdot_fuel_gas = 0.0
        
        # --- Heun (predictor-corrector) on the LIQUID mass update -------------------------
        # Forward Euler drains the whole interval at the start-of-step flow. Blowdown flow
        # decreases monotonically, so that ALWAYS over-drains — a one-signed bias that
        # accumulates and pushes end-of-burn pressure low, the dangerous direction for the chug
        # check. Predict with the start flow, evaluate the engine at the predicted pressure, then
        # redo the step from the original state with the average of the two. O(dt) -> O(dt^2).
        snap_lox = lox_tank.snapshot()
        snap_fuel = fuel_tank.snapshot()

        P_lox_pred = lox_tank.step(mdot_lox_liquid, dt, mdot_lox_gas)
        P_fuel_pred = fuel_tank.step(mdot_fuel_liquid, dt, mdot_fuel_gas)

        if engine_out or lox_depleted or fuel_depleted:
            mdot_lox_pred, mdot_fuel_pred = 0.0, 0.0
        else:
            try:
                mdot_lox_pred, mdot_fuel_pred = evaluate_engine_fn(P_lox_pred, P_fuel_pred)
            except Exception as exc:
                if not is_no_solution_error(exc):
                    raise
                # No chamber solution at the predicted pressure. Degrade to plain Euler for this
                # interval; the corrector evaluation below decides whether we have flamed out.
                mdot_lox_pred, mdot_fuel_pred = mdot_lox_liquid, mdot_fuel_liquid

        lox_tank.restore(snap_lox)
        fuel_tank.restore(snap_fuel)

        P_lox_new = lox_tank.step(0.5 * (mdot_lox_liquid + mdot_lox_pred), dt, mdot_lox_gas)
        P_fuel_new = fuel_tank.step(0.5 * (mdot_fuel_liquid + mdot_fuel_pred), dt, mdot_fuel_gas)
        
        # Evaluate Engine with NEW pressures to get NEW LIQUID mdot.
        # Flameout has two causes: (a) either tank empty, or (b) the chamber solver can no longer
        # close as the tanks decay (it RAISES "No solution: Supply < Demand at all Pc"). Both end
        # the burn. Tank pressure only falls further, so once out we stay out.
        if engine_out or lox_depleted or fuel_depleted:
            mdot_lox_new = 0.0
            mdot_fuel_new = 0.0
        elif lox_tank.m_prop > 0 and fuel_tank.m_prop > 0:
            try:
                mdot_lox_new, mdot_fuel_new = evaluate_engine_fn(P_lox_new, P_fuel_new)
            except Exception as exc:
                if not is_no_solution_error(exc):
                    raise
                engine_out = True
                mdot_lox_new = 0.0
                mdot_fuel_new = 0.0
        else:
            # Safety fallback
            mdot_lox_new = 0.0
            mdot_fuel_new = 0.0
        
        # Store History
        history['lox']['P_Pa'][i] = P_lox_new
        history['lox']['T_K'][i] = lox_tank.T_gas
        history['lox']['V_ullage_m3'][i] = lox_tank.V_ullage
        history['lox']['mdot_kg_s'][i] = mdot_lox_new # This tracks LIQUID flow for engine coupling
        history['lox']['m_prop_kg'][i] = lox_tank.m_prop
        history['lox']['is_depleted'][i] = lox_depleted
        
        history['fuel']['P_Pa'][i] = P_fuel_new
        history['fuel']['T_K'][i] = fuel_tank.T_gas
        history['fuel']['V_ullage_m3'][i] = fuel_tank.V_ullage
        history['fuel']['mdot_kg_s'][i] = mdot_fuel_new
        history['fuel']['m_prop_kg'][i] = fuel_tank.m_prop
        history['fuel']['is_depleted'][i] = fuel_depleted
        history['engine_out'][i] = engine_out
        
    return history
