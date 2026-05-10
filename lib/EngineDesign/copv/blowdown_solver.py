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

import numpy as np
import pandas as pd
from typing import Dict, Optional, Tuple, Callable
from scipy.interpolate import RegularGridInterpolator


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
    use_real_gas: bool = True,
    n2_Z_csv: str = "n2_Z_lookup.csv",
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
        Z_interp, _, _ = load_Z_lookup_table(n2_Z_csv)
        
    # Helpers to extract config
    def get_tank_params(fluid_key, tank_attr, h_attr, r_attr):
        rho = float(config.fluids[fluid_key].density)
        
        # Volume - prioritize tank_volume_m3 from config, fallback to geometry calculation
        tank = getattr(config, tank_attr, None)
        if tank and hasattr(tank, 'tank_volume_m3') and tank.tank_volume_m3 is not None:
            V = float(tank.tank_volume_m3)
        elif tank and hasattr(tank, h_attr) and hasattr(tank, r_attr):
            V = float(np.pi * getattr(tank, r_attr)**2 * getattr(tank, h_attr))
        elif hasattr(config, 'propellant') and hasattr(config.propellant, 'tank_volume_m3'):
            V = float(config.propellant.tank_volume_m3)
        else:
            V = 0.01 # Fallback, should likely raise
             
        # Mass
        if tank and hasattr(tank, 'mass'):
            m = float(tank.mass)
        elif hasattr(config, 'propellant') and hasattr(config.propellant, 'initial_mass_kg'):
            m = float(config.propellant.initial_mass_kg)
        else:
            m = 0.0
            
        return rho, V, m
    
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

    rho_lox, V_lox, m_lox = get_tank_params('oxidizer', 'lox_tank', 'lox_h', 'lox_radius')
    rho_fuel, V_fuel, m_fuel = get_tank_params('fuel', 'fuel_tank', 'rp1_h', 'rp1_radius')
    
    A_inj_lox = get_injector_area('oxidizer')
    A_inj_fuel = get_injector_area('fuel')
    
    # Initialize Tank States
    lox_tank = TankState(V_lox, m_lox, rho_lox, P_lox_initial_Pa, T_lox_gas_K, R_pressurant, Z_interp, n_polytropic)
    fuel_tank = TankState(V_fuel, m_fuel, rho_fuel, P_fuel_initial_Pa, T_fuel_gas_K, R_pressurant, Z_interp, n_polytropic)
    
    # Arrays to store history
    N = len(times)
    history = {
        'lox': {k: np.zeros(N) for k in ['P_Pa', 'T_K', 'V_ullage_m3', 'mdot_kg_s', 'm_prop_kg']},
        'fuel': {k: np.zeros(N) for k in ['P_Pa', 'T_K', 'V_ullage_m3', 'mdot_kg_s', 'm_prop_kg']}
    }
    # Add depletion flags for flameout masking
    history['lox']['is_depleted'] = np.zeros(N, dtype=bool)
    history['fuel']['is_depleted'] = np.zeros(N, dtype=bool)
    
    # Initial Conditions (t=0)
    # We need initial mdot based on initial Pressure
    mdot_lox_0, mdot_fuel_0 = evaluate_engine_fn(P_lox_initial_Pa, P_fuel_initial_Pa)
    
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
        
        # Step Tanks with appropriate flows
        P_lox_new = lox_tank.step(mdot_lox_liquid, dt, mdot_lox_gas)
        P_fuel_new = fuel_tank.step(mdot_fuel_liquid, dt, mdot_fuel_gas)
        
        # Evaluate Engine with NEW pressures to get NEW LIQUID mdot
        # CRITICAL: If EITHER tank is depleted, engine flame-out occurs -> zero flow
        if lox_depleted or fuel_depleted:
            # Flameout condition: no combustion without both propellants
            mdot_lox_new = 0.0
            mdot_fuel_new = 0.0
        elif lox_tank.m_prop > 0 and fuel_tank.m_prop > 0:
            mdot_lox_new, mdot_fuel_new = evaluate_engine_fn(P_lox_new, P_fuel_new)
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
        
    return history
