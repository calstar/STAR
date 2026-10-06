"""Graphite throat insert: surface chemistry and recession.

The throat oxidisers of a LOX/hydrocarbon engine are H2O, CO2 and OH; their reactions with
carbon are endothermic. See carbon_oxidation.
"""

from __future__ import annotations

from typing import Dict, Optional
import numpy as np
from engine.pipeline.config_schemas import GraphiteInsertConfig

R_GAS = 8.314462618  # J/(mol K)
MW_C = 12.0107       # kg/kmol
ATM = 101325.0

# Carbon consumed per mole of oxidiser (products CO, H2, H) and the reaction enthalpy per kg
# of carbon at 298 K from JANAF heats of formation; positive is absorbed at the surface.
#   C + H2O -> CO + H2   +131.3 kJ/mol     C + CO2 -> 2 CO   +172.5 kJ/mol
#   C + OH  -> CO + H     +68.1 kJ/mol     2C + O2 -> 2 CO   -221.1 kJ/mol
#   C + O   -> CO        -359.7 kJ/mol
CARBON_OXIDISERS = {
    "H2O": (1.0, +10.93e6),
    "CO2": (1.0, +14.36e6),
    "OH": (1.0, +5.67e6),
    "O2": (2.0, -9.20e6),
    "O": (1.0, -29.95e6),
}


def carbon_oxidation(T_s: float, P_static: float, composition: Dict[str, float], MW_mix: float,
                     g0: float, cfg: GraphiteInsertConfig) -> Dict[str, object]:
    """Carbon mass flux [kg/(m^2 s)] off a graphite surface at T_s and the heat it absorbs.

    Each oxidiser attacks at 1/(1/m_kin + 1/m_diff). Diffusion limit (unit Lewis number,
    film theory): m_diff = g * MW_C nu X / MW_mix with g the mass-transfer conductance h/cp,
    reduced by blowing g = g0 ln(1+B)/B, B = m_C/g0. Kinetics (Bradley et al. 1984, via
    Thakre & Yang, J. Propulsion Power 24(4), 2008): A T^b exp(-E/RT) p^n, p in atm;
    O2 and O are diffusion-limited.
    """
    rates = {"H2O": cfg.oxidation_H2O, "CO2": cfg.oxidation_CO2, "OH": cfg.oxidation_OH}
    m_kin = {}
    for sp in CARBON_OXIDISERS:
        x = max(float(composition.get(sp, 0.0)), 0.0)
        if sp in rates and x > 0:
            r = rates[sp]
            p_atm = x * P_static / ATM
            m_kin[sp] = r.A * T_s ** r.T_exponent * np.exp(-r.E / (R_GAS * T_s)) * p_atm ** r.n
        else:
            m_kin[sp] = np.inf
    m_C = 0.0
    species: Dict[str, float] = {}
    for _ in range(100):
        B = m_C / g0 if g0 > 0 else 0.0
        g = g0 * (np.log1p(B) / B if B > 1e-12 else 1.0)
        species = {}
        for sp, (nu, _dH) in CARBON_OXIDISERS.items():
            x = max(float(composition.get(sp, 0.0)), 0.0)
            m_diff = g * MW_C * nu * x / MW_mix
            mk = m_kin[sp]
            species[sp] = 0.0 if m_diff <= 0 or mk <= 0 else 1.0 / (1.0 / mk + 1.0 / m_diff)
        m_new = sum(species.values())
        if abs(m_new - m_C) <= 1e-12 + 1e-10 * m_new:
            m_C = m_new
            break
        m_C = m_new
    B = m_C / g0 if g0 > 0 else 0.0
    q_chem = sum(species[sp] * CARBON_OXIDISERS[sp][1] for sp in species)
    return {"mass_flux": float(m_C), "species": species, "q_chem": float(q_chem), "B": float(B),
            "blowing_factor": float(np.log1p(B) / B) if B > 1e-12 else 1.0}


def graphite_surface_state(T_s: float, gas, contour, composition: Dict[str, float],
                           cfg: GraphiteInsertConfig) -> Dict[str, object]:
    """Gas-side balance at the throat for a graphite surface at T_s: Bartz convection (blown),
    gas radiation, and the heat the surface chemistry absorbs. q_net goes into the insert."""
    from engine.pipeline.thermal.gas_side import station_flux

    eps_w = cfg.emissivity if cfg.emissivity is not None else 0.8
    st = station_flux(gas, contour, 0.0, T_s, eps_w)
    g0 = st["h"] / gas.cp
    ox = carbon_oxidation(T_s, st["P_static"], composition, composition["MW"], g0, cfg)
    q_conv = ox["blowing_factor"] * st["q_conv"]
    q_net = q_conv + st["q_rad"] - ox["q_chem"]
    return {"q_conv": q_conv, "q_conv_unblown": st["q_conv"], "q_rad": st["q_rad"],
            "q_chem": ox["q_chem"], "q_net": q_net, "mass_flux": ox["mass_flux"],
            "species": ox["species"], "B": ox["B"], "h": st["h"], "Taw": st["Taw"],
            "P_static": st["P_static"]}


def calculate_throat_heuristic_multiplier(
    chamber_pressure: float,
    chamber_velocity: float,
    throat_velocity: float,
    chamber_heat_flux: float,
    gamma: float = 1.2,
) -> float:
    """
    Calculate throat recession multiplier based on local flow conditions using a heuristic scaling.
    
    Throat recession is typically 1.2-2.5x higher than chamber due to:
    1. Higher velocity → Higher convective heat transfer
    2. Sonic conditions → Maximum heat flux
    3. Pressure gradient → Enhanced mass transfer
    4. Turbulence amplification near throat
    
    Heuristic scaling for heat flux ratio:
        q_throat / q_chamber ∝ (V_throat / V_chamber)^0.8 × (P_throat / P_chamber)^0.2
    
    WARNING: This is not a formal Bartz correlation. Real throat heat transfer depends on 
    geometry (D_t, curvature), viscosity/Pr, and boundary layer state. If 
    heat_transfer_coefficient at the throat is already available from a CFD or 
    boundary-layer code, this heuristic multiplier should not be used.
    
    Parameters:
    -----------
    chamber_pressure : float
        Chamber pressure [Pa]
    chamber_velocity : float
        Chamber gas velocity [m/s]
    throat_velocity : float
        Throat gas velocity (sonic) [m/s]
    chamber_heat_flux : float
        Chamber wall heat flux [W/m²] (used for validation, not in calculation)
    gamma : float
        Specific heat ratio
    
    Returns:
    --------
    multiplier : float
        Throat recession multiplier (typically 1.2-2.5)
    """
    if chamber_velocity <= 0 or throat_velocity <= 0:
        return 1.3  # Default fallback
    
    # Velocity ratio effect (dominant factor)
    velocity_ratio = throat_velocity / chamber_velocity
    velocity_factor = velocity_ratio ** 0.8
    
    # Pressure ratio effect (throat is at critical pressure)
    # P_throat / P_chamber ≈ (2/(γ+1))^(γ/(γ-1))
    pressure_ratio = (2.0 / (gamma + 1.0)) ** (gamma / (gamma - 1.0))
    pressure_factor = pressure_ratio ** 0.2
    
    # Heuristic heat flux ratio
    heat_flux_ratio = velocity_factor * pressure_factor
    
    # Recession rate is proportional to heat flux
    # Add a base factor for enhanced turbulence at throat
    turbulence_enhancement = 1.1
    
    multiplier = heat_flux_ratio * turbulence_enhancement
    
    # Clamp to reasonable bounds (1.2 to 2.5)
    multiplier = float(np.clip(multiplier, 1.2, 2.5))
    
    return multiplier


def compute_graphite_recession(
    net_heat_flux: float,
    throat_temperature: float,
    gas_temperature: float,
    graphite_config: GraphiteInsertConfig,
    throat_area: float,
    pressure: float,
    gas_density: Optional[float] = None,
    gas_viscosity: Optional[float] = None,
    oxygen_mass_fraction: Optional[float] = None,
    characteristic_length: Optional[float] = None,
    gas_velocity: Optional[float] = None,
    heat_transfer_coefficient: Optional[float] = None,
    backside_temperature: Optional[float] = None,
    effective_thickness: Optional[float] = None,
    gas_state=None,
    contour=None,
    throat_composition: Optional[Dict[str, float]] = None,
) -> Dict[str, float]:
    """Carbon recession of the graphite throat at the surface temperature ``throat_temperature``.

    The surface temperature is an INPUT: it comes from the insert's transient conduction
    (engine.pipeline.thermal.wall_conduction), not from a guess. Chemistry is
    graphite_surface_state: H2O, CO2, OH, O2 and O from the CEA throat composition, each at
    the lesser of its kinetic and diffusion-limited rate. ``gas_state`` is a
    gas_side.HotGasState, ``contour`` a gas_side.WallContour and ``throat_composition`` the
    CEA throat mole fractions with the throat 'MW'. The older arguments (net_heat_flux,
    gas_density, oxygen_mass_fraction, ...) are accepted and unused. With
    ``simplified_graphite_oxidation`` the configured constant rate is returned instead.
    """
    if not graphite_config.enabled or throat_area <= 0:
        return {
            "enabled": False,
            "recession_rate": 0.0,
            "mass_flux": 0.0,
            "surface_temperature": throat_temperature,
            "heat_removed": 0.0,
            "oxidation_rate": 0.0,
            "oxidation_mass_flux": 0.0,
            "thermal_mass_flux": 0.0,
            "feedback_fraction": 0.0,
            "q_feedback": 0.0,
            "q_radiation": 0.0,
            "q_conduction": 0.0,
        }
    
    # Graphite throats absolutely can recede, especially under high heat flux 
    # and oxidizing species. sizing_only_mode allows suppressing this recession 
    # for initial design phases where only thermal soak is being evaluated.
    sizing_only_mode = getattr(graphite_config, "sizing_only_mode", False)
    # If sizing_only_mode is True, we calculate physics but return zero recession_rate.
    # Otherwise (default), we return the physical recession rate.

    # Simplified oxidation mode: constant 0.01 mm/s radial recession
    simplified_mode = getattr(graphite_config, "simplified_graphite_oxidation", False)
    if simplified_mode:
        # Configured constant rate (default 1e-5 m/s = 0.01 mm/s, previously hardcoded here).
        _simp_rate = float(getattr(graphite_config, "simplified_oxidation_rate", 1.0e-5))
        m_dot_ox_simple = _simp_rate * graphite_config.material_density
        
        # Return simplified metrics immediately
        # Still calculate basic thermal metrics if needed, but for simplified mode we skip the complex loop
        recession_rate_report = 0.0 if sizing_only_mode else _simp_rate
        return {
            "enabled": True,
            "recession_rate": float(recession_rate_report),
            "recession_rate_calculated": _simp_rate,
            "mass_flux": float(0.0 if sizing_only_mode else m_dot_ox_simple),
            "mass_flux_calculated": float(m_dot_ox_simple),
            "surface_temperature": float(throat_temperature),
            "effective_heat_flux": float(net_heat_flux),
            "radiative_relief": 0.0,
            "conduction_loss": 0.0,
            "heat_removed": 0.0,
            "oxidation_rate": 1e-5,
            "oxidation_mass_flux": float(m_dot_ox_simple),
            "thermal_mass_flux": 0.0,
            "recession_rate_thermal": 0.0,
            "mass_flux_thermal": 0.0,
            "coverage_area": float(throat_area * graphite_config.coverage_fraction),
            "feedback_fraction": 0.0,
            "q_feedback": 0.0,
            "q_radiation": 0.0,
            "q_conduction": 0.0,
            "q_convective": float(net_heat_flux),
            "damkohler_number": 0.0,
            "blowing_parameter": 0.0,
            "sizing_only_mode": sizing_only_mode,
            "simplified_mode": True,
        }
    
    if gas_state is None or contour is None or throat_composition is None:
        raise ValueError(
            "compute_graphite_recession needs gas_state, contour and throat_composition (the CEA "
            "throat mole fractions); set 'simplified_graphite_oxidation: true' for a constant rate")
    st = graphite_surface_state(float(throat_temperature), gas_state, contour, throat_composition,
                                graphite_config)
    rate = st["mass_flux"] / graphite_config.material_density
    return {
        "enabled": True,
        "recession_rate": 0.0 if sizing_only_mode else float(rate),
        "recession_rate_calculated": float(rate),
        "mass_flux": 0.0 if sizing_only_mode else float(st["mass_flux"]),
        "surface_temperature": float(throat_temperature),
        "oxidation_rate": float(rate),
        "oxidation_mass_flux": float(st["mass_flux"]),
        "recession_rate_thermal": 0.0,
        "thermal_mass_flux": 0.0,
        "q_convective": float(st["q_conv"]),
        "q_radiation": float(st["q_rad"]),
        "q_chemical": float(st["q_chem"]),
        "q_net": float(st["q_net"]),
        "blowing_parameter": float(st["B"]),
        "species_mass_flux": st["species"],
        "heat_transfer_coefficient": float(st["h"]),
        "coverage_area": float(throat_area * graphite_config.coverage_fraction),
        "sizing_only_mode": sizing_only_mode,
        "simplified_mode": False,
    }

