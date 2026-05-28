"""Pydantic schemas for YAML/JSON configuration validation"""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator, model_validator, ConfigDict
from typing import Literal, Optional, Union, List, Dict, Tuple, Set
import numpy as np


class FluidConfig(BaseModel):
    """Fluid property configuration"""
    name: str
    density: float = Field(gt=0, description="Density [kg/m³]")
    viscosity: float = Field(gt=0, description="Dynamic viscosity [Pa·s]")
    surface_tension: float = Field(gt=0, description="Surface tension [N/m]")
    vapor_pressure: float = Field(ge=0, description="Vapor pressure [Pa]")
    specific_heat: float = Field(default=2200.0, gt=0, description="Specific heat at constant pressure [J/(kg·K)]")
    thermal_conductivity: float = Field(default=0.15, gt=0, description="Thermal conductivity [W/(m·K)]")
    temperature: float = Field(default=293.15, gt=0, description="Bulk fluid temperature [K]")
    # Fuel-specific properties for combustion physics
    latent_heat: Optional[float] = Field(default=None, gt=0, description="Latent heat of vaporization [J/kg] (fuel only)")
    boiling_point: Optional[float] = Field(default=None, gt=0, description="Boiling point at 1 atm [K] (fuel only)")
    molecular_weight: Optional[float] = Field(default=None, gt=0, description="Molecular weight [g/mol] (fuel only)")


class PintleLOXConfig(BaseModel):
    """LOX (oxidizer) pintle geometry - Axial flow through orifices"""
    n_orifices: int = Field(gt=0, description="Number of orifices on pintle tip")
    d_orifice: float = Field(gt=0, description="Diameter of each orifice [m]")
    theta_orifice: float = Field(ge=0, le=90, description="Angle of orifices from axis [deg]")
    A_entry: float = Field(gt=0, description="Single entry hole area [m²]")
    d_hydraulic: float = Field(gt=0, description="Hydraulic diameter for Re calculation [m]")


class PintleFuelConfig(BaseModel):
    """Fuel (RP-1) pintle geometry - Reservoir with gap spillage"""
    d_pintle_tip: float = Field(gt=0, description="Outer diameter of pintle tip [m]")
    d_reservoir_inner: float = Field(gt=0, description="Inner diameter of fuel reservoir [m]")
    h_gap: float = Field(gt=0, description="Gap height between pintle tip and reservoir [m]")
    A_entry: float = Field(gt=0, description="Single entry port area into reservoir [m²]")
    d_hydraulic: float = Field(gt=0, description="Hydraulic diameter for Re calculation [m] (gap hydraulic diameter)")


class PintleGeometryConfig(BaseModel):
    """Pintle injector geometry configuration"""
    lox: PintleLOXConfig
    fuel: PintleFuelConfig


class InjectorBaseConfig(BaseModel):
    """Base injector configuration with type identifier"""
    type: Literal["pintle", "coaxial", "impinging"]


class PintleInjectorConfig(InjectorBaseConfig):
    """Complete pintle injector configuration"""
    type: Literal["pintle"] = "pintle"
    geometry: PintleGeometryConfig


class CoaxialCoreConfig(BaseModel):
    """Core (inner) element geometry for coaxial injector"""
    n_ports: int = Field(gt=0, description="Number of core ports/nozzles")
    d_port: float = Field(gt=0, description="Diameter of each core port [m]")
    length: Optional[float] = Field(default=None, gt=0, description="Port length for loss modeling [m]")


class CoaxialAnnulusConfig(BaseModel):
    """Annular (outer) element geometry for coaxial injector"""
    inner_diameter: float = Field(gt=0, description="Inner diameter of annulus (matches core OD) [m]")
    gap_thickness: float = Field(gt=0, description="Annulus gap thickness [m]")
    swirl_angle: float = Field(default=0.0, ge=0, le=90, description="Swirl angle for outer flow [deg]")


class CoaxialInjectorGeometry(BaseModel):
    """Complete geometry description for a shear coaxial injector"""
    core: CoaxialCoreConfig
    annulus: CoaxialAnnulusConfig


class CoaxialInjectorConfig(InjectorBaseConfig):
    """Coaxial injector configuration"""
    type: Literal["coaxial"] = "coaxial"
    geometry: CoaxialInjectorGeometry


class ImpingingElementConfig(BaseModel):
    """Geometry parameters for a single impinging jet element"""
    n_elements: int = Field(gt=0, description="Number of elements (pairs or triplets)")
    d_jet: float = Field(gt=0, description="Jet diameter [m]")
    impingement_angle: float = Field(gt=0, le=180, description="Included impingement angle [deg]")
    spacing: float = Field(gt=0, description="Center-to-center spacing between jets [m]")


class ImpingingInjectorGeometry(BaseModel):
    """Complete geometry for an impinging injector"""
    oxidizer: ImpingingElementConfig
    fuel: ImpingingElementConfig


class ImpingingInjectorConfig(InjectorBaseConfig):
    """Impinging-element injector configuration"""
    type: Literal["impinging"] = "impinging"
    geometry: ImpingingInjectorGeometry


class FeedSystemConfig(BaseModel):
    """Feed system configuration for one branch (O or F)"""
    d_inlet: float = Field(gt=0, description="Inlet pipe diameter [m] (e.g., 3/8\" = 0.009525 m)")
    A_hydraulic: float = Field(gt=0, description="Hydraulic area of feed line [m²] (calculated from d_inlet if not specified)")
    K0: float = Field(ge=0, description="Base loss coefficient")
    K1: float = Field(ge=0, description="Pressure dependence coefficient")
    phi_type: Literal["none", "sqrtP", "logP"] = Field(
        default="none",
        description="Pressure function type"
    )


class RegenCoolingConfig(BaseModel):
    """Regenerative cooling channel configuration"""
    enabled: bool = Field(default=False, description="Enable regen cooling model")
    d_inlet: float = Field(gt=0, description="Inlet pipe diameter [m] (e.g., 3/8\" = 0.009525 m)")
    L_inlet: float = Field(gt=0, description="Inlet pipe length [m]")
    n_channels: int = Field(gt=0, description="Number of parallel cooling channels")
    channel_width: float = Field(gt=0, description="Channel width [m]")
    channel_height: float = Field(gt=0, description="Channel height [m]")
    channel_length: float = Field(gt=0, description="Channel length [m] (typically chamber length)")
    d_outlet: Optional[float] = Field(default=None, description="Outlet pipe diameter [m] (default: same as inlet)")
    L_outlet: float = Field(gt=0, description="Outlet pipe length [m] (from merge to injector)")
    roughness: float = Field(default=0.0, ge=0, description="Surface roughness [m] (0 = smooth)")
    K_manifold_split: float = Field(default=0.5, ge=0, description="Manifold split loss coefficient")
    K_manifold_merge: float = Field(default=0.3, ge=0, description="Manifold merge loss coefficient")
    # Dynamic discharge coefficient configuration (similar to injector Cd)
    Cd_entrance_inf: float = Field(default=0.8, gt=0, le=1, description="Asymptotic Cd at high Re for channel entrance")
    a_Re_entrance: float = Field(default=0.1, ge=0, description="Reynolds correction parameter for entrance")
    Cd_entrance_min: float = Field(default=0.6, ge=0, le=1, description="Minimum Cd for entrance")
    Cd_exit_inf: float = Field(default=0.9, gt=0, le=1, description="Asymptotic Cd at high Re for channel exit")
    a_Re_exit: float = Field(default=0.1, ge=0, description="Reynolds correction parameter for exit")
    Cd_exit_min: float = Field(default=0.7, ge=0, le=1, description="Minimum Cd for exit")
    # Heat-transfer coupling (Phase 2)
    use_heat_transfer: bool = Field(default=False, description="Enable coupled heat-transfer calculations for regen cooling")
    wall_thickness: float = Field(default=0.002, gt=0, description="Hot-wall thickness between gas and coolant [m]")
    wall_thermal_conductivity: float = Field(default=300.0, gt=0, description="Wall material thermal conductivity [W/(m·K)]")
    chamber_inner_diameter: Optional[float] = Field(default=None, gt=0, description="Chamber inner diameter for hot-side area [m]")
    hot_gas_prandtl: float = Field(default=0.7, gt=0, description="Assumed hot-gas Prandtl number")
    hot_gas_viscosity: float = Field(default=4.0e-5, gt=0, description="Effective hot-gas viscosity [Pa·s]")
    hot_gas_thermal_conductivity: float = Field(default=0.1, gt=0, description="Effective hot-gas thermal conductivity [W/(m·K)]")
    radiation_emissivity_hot: float = Field(default=0.8, ge=0, le=1, description="Effective hot-side emissivity for radiation")
    radiation_view_factor: float = Field(default=1.0, ge=0, le=1, description="Radiation view factor to coolant surface")
    n_segments: int = Field(default=20, gt=0, description="Number of axial segments for heat-transfer integration")
    gas_turbulence_intensity: float = Field(default=0.1, ge=0, description="Estimated turbulence intensity of hot gas (0-1)")
    coolant_turbulence_intensity: float = Field(default=0.05, ge=0, description="Estimated turbulence intensity of coolant (0-1)")
    hot_gas_cp: float = Field(default=2200.0, gt=0, description="Hot-gas specific heat [J/(kg·K)]")
    recovery_factor: Optional[float] = Field(default=None, gt=0, le=1, description="Turbulent boundary layer recovery factor for adiabatic wall temperature (Taw = Tc × recovery_factor). Typical range: 0.90-0.98. If None, uses default from constants.")


class FilmCoolingConfig(BaseModel):
    """Film cooling configuration"""
    enabled: bool = Field(default=False, description="Enable film cooling model")
    mass_fraction: float = Field(default=0.05, ge=0, le=0.5, description="Fraction of total mass flow used for film injection")
    injection_temperature: Optional[float] = Field(default=None, gt=0, description="Film injection temperature [K] (defaults to fuel temperature)")
    effectiveness_ref: float = Field(default=0.4, ge=0, le=1, description="Reference film effectiveness at injection location")
    decay_length: float = Field(default=0.1, gt=0, description="Characteristic decay length for film effectiveness [m]")
    apply_to_fraction_of_length: float = Field(default=1.0, gt=0, description="Portion of chamber length covered by film cooling")
    slot_height: float = Field(default=3.0e-4, gt=0, description="Annular slot height for film injection [m]")
    reference_blowing_ratio: float = Field(default=0.5, gt=0, description="Reference blowing ratio for effectiveness correlation")
    blowing_exponent: float = Field(default=0.6, gt=0, description="Exponent on blowing ratio for effectiveness correlation")
    turbulence_reference_intensity: float = Field(default=0.08, gt=0, description="Reference turbulence intensity for film erosion")
    turbulence_sensitivity: float = Field(default=1.0, ge=0, description="Sensitivity of film effectiveness to turbulence intensity")
    turbulence_exponent: float = Field(default=1.0, gt=0, description="Exponent governing turbulence erosion scaling")
    turbulence_min_multiplier: float = Field(default=0.4, ge=0, le=1, description="Minimum multiplier applied to effectiveness due to turbulence erosion")
    reference_wall_temperature: float = Field(default=1100.0, gt=0, description="Reference hot wall temperature used for heat-flux estimation [K]")
    density_override: Optional[float] = Field(default=None, gt=0, description="Override density for film coolant if different from bulk fuel [kg/m³]")
    cp_override: Optional[float] = Field(default=None, gt=0, description="Override specific heat for film coolant if different from bulk fuel [J/(kg·K)]")


class GraphiteInsertConfig(BaseModel):
    """Graphite throat insert configuration (separate from chamber ablator)"""
    enabled: bool = Field(default=False, description="Enable graphite throat insert")
    material_density: float = Field(default=1800.0, gt=0, description="Graphite density [kg/m³] (typical: 1800-2200)")
    heat_of_ablation: float = Field(default=8.0e6, gt=0, description="Effective heat of ablation [J/kg] (graphite: ~8-12 MJ/kg)")
    thermal_conductivity: float = Field(default=100.0, gt=0, description="Graphite thermal conductivity [W/(m·K)] (typical: 50-150)")
    specific_heat: float = Field(default=710.0, gt=0, description="Graphite specific heat [J/(kg·K)]")
    initial_thickness: float = Field(default=0.005, gt=0, description="Initial graphite insert thickness [m]")
    surface_temperature_limit: float = Field(default=2500.0, gt=0, description="Maximum surface temperature before failure [K]")
    oxidation_temperature: float = Field(default=800.0, gt=0, description="Onset temperature for oxidation [K]")
    oxidation_rate: float = Field(default=1e-6, ge=0, description="Oxidation recession rate [m/s] at reference conditions")
    activation_energy: Optional[float] = Field(default=180e3, gt=0, description="Activation energy for Arrhenius oxidation rate [J/mol]. Typical: 150-200 kJ/mol")
    oxidation_reference_temperature: float = Field(default=1500.0, gt=0, description="Reference temperature where oxidation_rate is defined [K]. Typical: 1500-1800 K")
    oxidation_reference_pressure: float = Field(default=1.0e6, gt=0, description="Reference pressure where oxidation_rate is defined [Pa]. Typical: 1 MPa")
    recession_multiplier: Optional[float] = Field(default=None, gt=0, description="Recession multiplier vs chamber (if None, calculated from flow conditions). Typically 1.3-2.5")
    sizing_only_mode: bool = Field(default=False, description="If True, suppress recession for sizing iterations. Graphite does recede in reality; use only for design phase.")
    simplified_graphite_oxidation: bool = Field(default=False, description="If True, use a constant 0.01 mm/s radial oxidation recession rate instead of the physics-based model.")
    char_layer_conductivity: float = Field(default=5.0, gt=0, description="Thermal conductivity of protective layer [W/(m·K)]")
    char_layer_thickness: float = Field(default=0.0005, gt=0, description="Thickness of protective layer [m]")
    coverage_fraction: float = Field(default=1.0, gt=0, le=1.0, description="Fraction of throat/nozzle with graphite insert")
    emissivity: Optional[float] = Field(default=None, ge=0, le=1, description="Surface emissivity for radiation (default: 0.8)")
    ambient_temperature: Optional[float] = Field(default=None, gt=0, description="Ambient temperature for radiation [K] (default: 300 K)")
    feedback_fraction_min: Optional[float] = Field(default=None, ge=0, le=1, description="Minimum oxidation heat feedback fraction (default: 0.0)")
    feedback_fraction_max: Optional[float] = Field(default=None, ge=0, le=1, description="Maximum oxidation heat feedback fraction (default: 0.2)")
    oxidation_enthalpy: Optional[float] = Field(default=None, gt=0, description="Oxidation reaction enthalpy [J/kg C]. If None, auto-selected: 32.8e6 for CO2 (ratio=1.0), 10.1e6 for CO (ratio=2.0)")
    ablation_surface_temperature: Optional[float] = Field(default=None, gt=0, description="Surface temperature at which thermal ablation pins T_s [K] (default: 3000 K). Above this, T_s is fixed and m_dot_th balances energy.")
    ablation_transition_width: float = Field(default=200.0, gt=0, description="Temperature width [K] for smooth transition to thermal ablation regime.")
    oxidation_pressure_exponent: Optional[float] = Field(default=None, ge=0, description="Pressure exponent for oxidation kinetics (default: 0.5)")
    oxidation_pre_exponential: Optional[float] = Field(default=None, gt=0, description="Pre-exponential factor for Arrhenius oxidation (default: calculated from oxidation_rate)")
    mixture_mw: Optional[float] = Field(default=None, gt=0, description="Average molecular weight of combustion products [kg/mol] (default: 0.024)")
    oxidation_stoichiometry_ratio: Optional[float] = Field(default=None, gt=0, description="Moles of C per mole of O2 (1.0 for CO2, 2.0 for CO) (default: 1.0)")
    oxygen_mass_fraction: Optional[float] = Field(
        default=None,
        ge=0,
        le=1,
        description="Free-stream oxygen mass fraction at throat for oxidation model [-].",
    )
    oxygen_mole_fraction: Optional[float] = Field(
        default=None,
        ge=0,
        le=1,
        description="Free-stream oxygen mole fraction at throat. If provided, overrides oxygen_mass_fraction conversion.",
    )
    friction_coefficient_override: Optional[float] = Field(default=None, gt=0, description="Override skin friction coefficient Cf for blowing parameter calculation.")
    reference_diffusivity: Optional[float] = Field(default=None, gt=0, description="Reference O2 diffusivity [m²/s] at reference temperature and pressure.")
    reference_diffusivity_temperature: float = Field(default=1500.0, gt=0, description="Reference temperature [K] for oxygen diffusivity scaling.")
    reference_diffusivity_pressure: float = Field(default=1.0e6, gt=0, description="Reference pressure [Pa] for oxygen diffusivity scaling.")


class StainlessSteelCaseConfig(BaseModel):
    """Stainless steel case configuration (structural wall behind ablative/graphite)"""
    enabled: bool = Field(default=True, description="Enable stainless steel case")
    thickness: float = Field(default=0.003, gt=0, description="Stainless steel wall thickness [m]")
    thermal_conductivity: float = Field(default=15.0, gt=0, description="Thermal conductivity [W/(m·K)]")
    density: float = Field(default=8000.0, gt=0, description="Material density [kg/m³]")
    specific_heat: float = Field(default=500.0, gt=0, description="Specific heat [J/(kg·K)]")
    max_temperature: float = Field(default=1000.0, gt=0, description="Maximum allowable temperature [K] (melting point ~1700K, but limit lower for structural integrity)")
    emissivity: float = Field(default=0.3, ge=0, le=1, description="Surface emissivity")
    yield_strength: float = Field(default=200e6, gt=0, description="Yield strength at max temp [Pa]")
    youngs_modulus: float = Field(default=200e9, gt=0, description="Young's modulus [Pa]")


class AblativeCoolingConfig(BaseModel):
    """Ablative cooling configuration for chamber liner (phenolic)"""
    enabled: bool = Field(default=False, description="Enable ablative cooling model")
    material_density: float = Field(default=1600.0, gt=0, description="Ablator (phenolic) density [kg/m³]")
    heat_of_ablation: float = Field(default=2.5e6, gt=0, description="Effective heat of ablation [J/kg]")
    thermal_conductivity: float = Field(default=0.35, gt=0, description="Ablator (phenolic) thermal conductivity [W/(m·K)]")
    specific_heat: float = Field(default=1500.0, gt=0, description="Ablator (phenolic) specific heat [J/(kg·K)]")
    initial_thickness: float = Field(default=0.01, gt=0, description="Initial ablative (phenolic) thickness [m]")
    surface_temperature_limit: float = Field(default=1200.0, gt=0, description="Allowable surface temperature [K]")
    coverage_fraction: float = Field(default=1.0, gt=0, le=1.0, description="Fraction of chamber surface protected by ablative liner")
    pyrolysis_temperature: float = Field(default=900.0, gt=0, description="Characteristic pyrolysis temperature of ablator [K]")
    blowing_efficiency: float = Field(default=0.8, ge=0, le=1, description="Effectiveness of ablative gases in blocking convective heat flux (legacy constant factor, used if use_physics_based_blowing=False)")
    use_physics_based_blowing: bool = Field(default=True, description="If True, use physics-based blowing parameter B = m_dot_pyrolysis/m_dot_external. If False, use constant blowing_efficiency factor.")
    blowing_coefficient: float = Field(default=0.5, gt=0, description="Blowing coefficient c in empirical function f(B) = 1/(1 + c*B). Typical range: 0.3-0.8. Higher values = stronger blowing effect.")
    blowing_min_reduction_factor: float = Field(default=0.1, ge=0, le=1, description="Minimum convective reduction factor (maximum blowing effectiveness). Prevents blowing from reducing convective heat transfer below this fraction. Default 0.1 means maximum 90% reduction. Lower values allow stronger blowing effect.")
    turbulence_reference_intensity: float = Field(default=0.08, gt=0, description="Reference turbulence intensity for ablative augmentation")
    turbulence_sensitivity: float = Field(default=1.5, ge=0, description="Sensitivity of ablative heat flux to turbulence")
    turbulence_exponent: float = Field(default=1.0, gt=0, description="Exponent on turbulence intensity for ablative response")
    turbulence_max_multiplier: float = Field(default=3.0, gt=0, description="Maximum multiplier applied to convective heat flux due to turbulence")
    throat_recession_multiplier: Optional[float] = Field(default=None, gt=0, description="Throat recession multiplier vs chamber (if None, calculated from flow conditions). Typically 1.2-2.0")
    char_layer_conductivity: float = Field(default=0.2, gt=0, description="Thermal conductivity of char layer [W/(m·K)]")
    char_layer_thickness: float = Field(default=0.001, gt=0, description="Thickness of protective char layer [m]")
    surface_emissivity: float = Field(default=0.85, ge=0, le=1, description="Surface emissivity for radiative heat transfer (0-1, typical 0.8-0.9 for charred ablators)")
    ambient_temperature: float = Field(default=300.0, gt=0, description="Ambient/surrounding temperature for radiative heat transfer [K]. For radiation to space, use ~300K. For radiation exchange with gas, use gas temperature.")
    radiative_sink_minimum_threshold: float = Field(default=400.0, gt=0, description="Minimum ambient temperature threshold [K]. If ambient_temperature is below this, radiative_sink_fallback_temperature is used instead.")
    radiative_sink_fallback_temperature: float = Field(default=600.0, gt=0, description="Fallback radiative sink temperature [K] used when ambient_temperature is too low. Represents approximate heated steel layer temperature behind ablator.")
    track_geometry_evolution: bool = Field(default=True, description="Enable time-varying geometry tracking (L* evolution)")
    nozzle_ablative: bool = Field(default=False, description="If True, nozzle exit also recedes (A_exit grows). If False, only throat recedes (expansion ratio decreases)")


class DischargeConfig(BaseModel):
    """Discharge coefficient configuration"""
    Cd_inf: float = Field(gt=0, le=1, description="Cd at infinite Re")
    a_Re: float = Field(ge=0, description="Reynolds number correction parameter")
    Cd_min: float = Field(default=0.2, ge=0, le=1, description="Minimum Cd")
    # Pressure and temperature dependence (optional)
    use_pressure_correction: bool = Field(default=False, description="Enable pressure-dependent Cd (compressibility effects)")
    P_ref: float = Field(default=5.0e6, gt=0, description="Reference pressure for pressure correction [Pa]")
    a_P: float = Field(default=0.0, description="Pressure correction coefficient")
    use_temperature_correction: bool = Field(default=False, description="Enable temperature-dependent Cd (viscosity effects)")
    T_ref: float = Field(default=300.0, gt=0, description="Reference temperature for temperature correction [K]")
    a_T: float = Field(default=0.0, description="Temperature correction coefficient")


class SprayAngleConfig(BaseModel):
    """Spray angle model configuration"""
    model: Literal["J", "TMR"] = Field(default="TMR", description="Model type")
    k: float = Field(default=0.5, gt=0, description="J model coefficient")
    n: float = Field(default=0.5, gt=0, description="J model exponent")


class SMDConfig(BaseModel):
    """Sauter Mean Diameter configuration"""
    model: Literal["lefebvre", "nukiyama_tanasawa"] = Field(
        default="lefebvre",
        description="SMD model type"
    )
    C: float = Field(default=0.5, gt=0, description="Lefebvre constant C")
    m: float = Field(default=0.6, gt=0, description="Lefebvre exponent m")
    p: float = Field(default=0.0, description="Lefebvre exponent p")
    we_corr_max: Optional[float] = Field(
        default=None,
        gt=0.0,
        description=(
            "Optional cap applied to the liquid Weber number **only** when evaluating the "
            "Lefebvre-style ``smd_lefebvre`` correlation (D32). Full We is still used for "
            "``check_spray_constraints``. Jet-like impingement can produce enormous We with "
            "liquid ρ and mm jets, which drives D32 to sub-micron values outside the correlation's "
            "useful regime; capping We_corr is a pragmatic surrogate for secondary breakup / "
            "turbulence limits. Default None = no cap."
        ),
    )


class EvaporationConfig(BaseModel):
    """Evaporation model configuration"""
    K: float = Field(default=3e5, gt=0, description="Evaporation constant [s/m²]")
    x_star_limit: float = Field(default=0.05, gt=0, description="Max evaporation length [m]")
    use_constraint: bool = Field(default=True, description="Enable x* constraint")



class PintleSprayConfig(BaseModel):
    """Pintle-specific spray correlation parameters"""
    C: float = Field(default=15.0, gt=0, description="Correlation coefficient C")
    B: float = Field(default=2.0, ge=0, description="Ohnesorge multiplier B")
    n: float = Field(default=0.5, gt=0, description="Weber exponent n")
    p: float = Field(default=0.2, ge=0, description="Ohnesorge exponent p")


class SprayConfig(BaseModel):
    """Spray/mixing model configuration"""
    momentum_flux_ratio: bool = Field(default=True, description="Enable J calculation")
    spray_angle: SprayAngleConfig = Field(default_factory=SprayAngleConfig)
    weber: dict = Field(default_factory=lambda: {"We_min": 15.0})
    smd: SMDConfig = Field(default_factory=SMDConfig)
    pintle: PintleSprayConfig = Field(default_factory=PintleSprayConfig)
    evaporation: EvaporationConfig = Field(default_factory=EvaporationConfig)
    use_turbulence_corrections: bool = Field(default=False, description="Enable turbulence-dependent spray corrections")
    turbulence_breakup_gain: float = Field(default=1.0, ge=0, description="Gain applied to droplet breakup due to turbulence")
    turbulence_penetration_gain: float = Field(default=0.5, ge=0, description="Gain applied to evaporation length reduction due to turbulence")


class CEAConfig(BaseModel):
    use_parallel_cea_build: bool = Field(default=True, description="Use parallel processing for CEA cache building")
    cea_parallel_workers: Optional[int] = Field(default=None, description="Number of parallel workers (None = auto-detect, limited to 8)")
    """CEA (Chemical Equilibrium Analysis) configuration"""
    ox_name: str = Field(default="LOX", description="Oxidizer name")
    fuel_name: str = Field(default="RP-1", description="Fuel name")
    expansion_ratio: float = Field(gt=1, description="Nozzle expansion ratio (initial/default value)")
    cache_file: str = Field(default="cea_cache_LOX_RP1.npz", description="Cache filename")
    Pc_range: List[float] = Field(
        default=[2.0e6, 9.0e6],
        description="Chamber pressure range [Pa]"
    )
    MR_range: List[float] = Field(
        default=[2.0, 2.8],
        description="Mixture ratio range"
    )
    eps_range: Optional[List[float]] = Field(
        default=None,
        description="Expansion ratio range for 3D cache [min, max]. If None, uses 2D cache with fixed expansion_ratio"
    )
    n_points: int = Field(default=34, gt=0, description="Number of grid points per dimension (34³ ≈ 39,300 points for 3D cache, similar to old 2D cache with ~40k points)")


class CombustionEfficiencyConfig(BaseModel):
    """Combustion efficiency (L* correction) configuration
    
    NOTE: CEA uses EQUILIBRIUM flow (not frozen). The efficiency correction
    accounts for finite chamber effects that prevent perfect equilibrium.
    
    Two models available:
    1. Simple model: Exponential L* correction (backward compatible)
    2. Advanced model: Physics-based with kinetics, mixing, turbulence
    """
    model: Literal["constant", "linear", "exponential"] = Field(
        default="exponential",
        description="Efficiency model type"
    )
    C: float = Field(default=0.3, ge=0, le=1, description="Efficiency loss parameter (for exponential/linear models)")
    K: float = Field(default=0.15, ge=0, description="Recovery rate parameter (for exponential model)")
    use_spray_correction: bool = Field(default=False, description="Apply spray quality penalty")
    spray_penalty_factor: float = Field(default=0.8, ge=0, le=1, description="Efficiency penalty if spray constraints violated")
    use_mixture_coupling: bool = Field(
        default=False,
        description="[DIAGNOSTICS ONLY] Enable mixture diagnostics logging (does NOT affect efficiency calculation)"
    )
    use_cooling_coupling: bool = Field(default=True, description="Apply cooling efficiency corrections")
    use_turbulence_coupling: bool = Field(
        default=False,
        description="[DEPRECATED] Turbulence is always included in eta_mixing physics, not as separate penalty"
    )
    mixture_efficiency_floor: float = Field(default=0.25, ge=0, le=1, description="[DEPRECATED] No longer used")
    cooling_efficiency_floor: float = Field(default=0.25, ge=0, le=1, description="Minimum cooling efficiency")
    turbulence_efficiency_floor: float = Field(default=0.3, ge=0, le=1, description="[DEPRECATED] No longer used")
    target_turbulence_intensity: Optional[float] = Field(
        default=None,
        description="[DEPRECATED] Design target only, not used in efficiency calculation"
    )
    turbulence_penalty_exponent: Optional[float] = Field(
        default=None,
        description="[DEPRECATED] No longer used"
    )
    target_smd_microns: Optional[float] = Field(
        default=None,
        description="[DEPRECATED] Design target only, not used in efficiency calculation"
    )
    xstar_limit_mm: Optional[float] = Field(
        default=None,
        description="[DEPRECATED] No longer used"
    )
    xstar_penalty_exponent: Optional[float] = Field(
        default=None,
        description="[DEPRECATED] No longer used"
    )
    we_reference: Optional[float] = Field(
        default=None,
        description="[DEPRECATED] Design target only, not used in efficiency calculation"
    )
    we_penalty_exponent: Optional[float] = Field(
        default=None,
        description="[DEPRECATED] No longer used"
    )
    smd_penalty_exponent: Optional[float] = Field(
        default=None,
        description="[DEPRECATED] No longer used"
    )
    use_advanced_model: bool = Field(
        default=False,
        description="Use advanced physics-based efficiency model (kinetics, mixing, turbulence)"
    )
    Pc_gate: float = Field(
        default=1000000.0,
        ge=0,
        description="Chamber pressure gate for advanced model [Pa]. Below this pressure, simple model is used for stability."
    )
    # Finite-rate chemistry and reaction modeling
    use_finite_rate_chemistry: bool = Field(
        default=True,
        description="Model finite-rate chemistry in chamber (reaction progress tracking)"
    )
    use_shifting_equilibrium: bool = Field(
        default=True,
        description="Use shifting equilibrium in nozzle (composition changes with expansion)"
    )
    # Kinetics timescale calibration (for calculate_reaction_time_scale)
    tau_ref: float = Field(
        default=1e-5,
        gt=0,
        description="Reference chemical reaction time [s] at tau_ref_P and tau_ref_T. Default 10 μs for LOX/RP-1."
    )
    tau_ref_P: float = Field(
        default=4.0e6,
        gt=0,
        description="Reference pressure for tau_ref [Pa]. Default 4 MPa."
    )
    tau_ref_T: float = Field(
        default=3500.0,
        gt=0,
        description="Reference temperature for tau_ref [K]. Default 3500 K."
    )
    n_pressure: float = Field(
        default=0.8,
        ge=0,
        description="Pressure exponent for kinetics scaling: tau_chem ~ (P_ref/Pc)^n. Default 0.8."
    )
    tau_Tc_floor_K: Optional[float] = Field(
        default=None,
        description=(
            "Optional floor applied to CEA chamber temperature when evaluating the global τ_chem scaling "
            "in ``calculate_reaction_time_scale`` (finite-rate η_kinetics path). "
            "CEA equilibrium Tc can be artificially low for some propellant/MR/Pc combinations, which "
            "blows up the Arrhenius-like temperature factor and makes η_kinetics unrealistically small. "
            "When set, uses Tc_eff = max(Tc, tau_Tc_floor_K) only for τ_chem (not for equilibrium properties)."
        ),
    )
    # Gasification model transition temperature
    T_star_fuel_cap_K: float = Field(
        default=1000.0,
        gt=0,
        description="Effective fuel interface temperature cap for gasification model [K]. Represents wet-bulb/pyrolysis onset scale, NOT gas temperature tracking. Default 1000K for RP-1."
    )
    # Arrhenius kinetics parameters (fuel-specific, can be overridden per fuel type)
    A0_hydrocarbon: float = Field(
        default=1e7,
        gt=0,
        description="Pre-exponential factor for hydrocarbon fuels (RP-1, Kerosene) [1/s]. Default 1e7."
    )
    Ea_hydrocarbon: float = Field(
        default=80000.0,
        gt=0,
        description="Activation energy for hydrocarbon fuels (RP-1, Kerosene) [J/mol]. Default 80 kJ/mol."
    )
    n_pre_hydrocarbon: float = Field(
        default=0.3,
        ge=0,
        description="Pre-exponential pressure exponent for hydrocarbons. Default 0.3."
    )
    A0_ethanol: float = Field(
        default=5e7,
        gt=0,
        description="Pre-exponential factor for ethanol [1/s]. Default 5e7 (faster than RP-1)."
    )
    Ea_ethanol: float = Field(
        default=140000.0,
        gt=0,
        description="Activation energy for ethanol [J/mol]. Default 140 kJ/mol (higher than RP-1)."
    )
    n_pre_ethanol: float = Field(
        default=0.25,
        ge=0,
        description="Pre-exponential pressure exponent for ethanol. Default 0.25."
    )
    A0_hydrogen: float = Field(
        default=1e9,
        gt=0,
        description="Pre-exponential factor for hydrogen [1/s]. Default 1e9 (much faster than hydrocarbons)."
    )
    Ea_hydrogen: float = Field(
        default=40000.0,
        gt=0,
        description="Activation energy for hydrogen [J/mol]. Default 40 kJ/mol (lower than hydrocarbons)."
    )
    n_pre_hydrogen: float = Field(
        default=0.2,
        ge=0,
        description="Pre-exponential pressure exponent for hydrogen. Default 0.2."
    )


class CombustionConfig(BaseModel):
    """Combustion configuration"""
    cea: CEAConfig = Field(default_factory=CEAConfig)
    efficiency: CombustionEfficiencyConfig = Field(default_factory=CombustionEfficiencyConfig)


class ChamberGeometryConfig(BaseModel):
    """
    Unified chamber geometry configuration for solve_chamber_geometry_with_cea.
    Groups all design inputs (chamber + nozzle) in one place.
    """
    # Design requirements
    design_pressure: float = Field(gt=0, description="Target chamber pressure Pc [Pa]")
    design_thrust: float = Field(gt=0, description="Target thrust F [N]")
    design_MR: float = Field(gt=0, description="Design mixture ratio O/F")
    
    # Chamber dimensions
    chamber_diameter: float = Field(gt=0, description="Inner chamber diameter [m]")
    Lstar: float = Field(gt=0, description="Characteristic length [m] (0.95-1.27 for LOX/RP-1)")
    
    # Nozzle dimensions
    exit_diameter: float = Field(gt=0, description="Nozzle exit diameter [m]")
    expansion_ratio: float = Field(gt=1, description="Area ratio A_exit/A_throat")
    nozzle_efficiency: float = Field(default=0.95, ge=0, le=1, description="Nozzle efficiency (0.94-0.98)")
    
    # Solver outputs (populated after running solver)
    A_throat: Optional[float] = Field(default=None, gt=0, description="Throat area [m²] - SOLVED")
    A_exit: Optional[float] = Field(default=None, gt=0, description="Exit area [m²] - SOLVED")
    volume: Optional[float] = Field(default=None, gt=0, description="Chamber volume [m³] - SOLVED")
    length: Optional[float] = Field(default=None, gt=0, description="Total chamber length [m] - SOLVED")
    length_cylindrical: Optional[float] = Field(default=None, gt=0, description="Cylindrical section length [m] - SOLVED")
    length_contraction: Optional[float] = Field(default=None, gt=0, description="Contraction section length [m] - SOLVED")
    Cf: Optional[float] = Field(default=None, gt=0, description="Thrust coefficient - SOLVED")


class ChamberConfig(BaseModel):
    """Chamber geometry configuration"""
    volume: float = Field(gt=0, description="Chamber volume [m³]")
    A_throat: float = Field(gt=0, description="Throat area [m²]")
    length: Optional[float] = Field(default=None, gt=0, description="Total chamber length [m]")
    length_cylindrical: Optional[float] = Field(default=None, gt=0, description="Cylindrical section length [m]")
    length_contraction: Optional[float] = Field(default=None, gt=0, description="Contraction section length [m]")
    Lstar: Optional[float] = Field(
        default=None,
        gt=0,
        description="Characteristic length [m] = V_chamber / A_throat. If not specified, calculated from volume and A_throat."
    )
    chamber_inner_diameter: Optional[float] = Field(default=None, gt=0, description="Chamber inner diameter [m]")
    exit_diameter: Optional[float] = Field(default=None, gt=0, description="Nozzle exit diameter [m] for geometry solver")
    
    # Design parameters for solve_chamber_geometry_with_cea
    design_pressure: Optional[float] = Field(default=None, gt=0, description="Design chamber pressure [Pa] (Pc_design)")
    design_thrust: Optional[float] = Field(default=None, gt=0, description="Design thrust [N] (F_design)")
    design_MR: Optional[float] = Field(default=None, gt=0, description="Design mixture ratio O/F for CEA solver")
    design_force_coefficient: Optional[float] = Field(default=None, gt=0, description="Solved thrust coefficient Cf (output from solver)")


class NozzleConfig(BaseModel):
    """Nozzle configuration"""
    A_throat: float = Field(gt=0, description="Throat area [m²]")
    A_exit: float = Field(gt=0, description="Exit area [m²]")
    expansion_ratio: float = Field(gt=1, description="Expansion ratio (A_exit/A_throat)")
    exit_diameter: Optional[float] = Field(default=None, gt=0, description="Nozzle exit diameter [m]")
    efficiency: float = Field(default=0.98, ge=0, le=1, description="Nozzle efficiency")


class ClosureConfig(BaseModel):
    """Closure iteration configuration"""
    max_iterations: int = Field(default=6, gt=0, description="Max closure iterations")
    Cd_reduction_factor: float = Field(
        default=0.95,
        ge=0,
        le=1,
        description="Cd reduction factor if constraints violated"
    )
    tolerance: float = Field(default=1e-4, gt=0, description="Convergence tolerance")


class SolverConfig(BaseModel):
    """Solver configuration"""
    method: Literal["brentq", "secant", "newton"] = Field(
        default="brentq",
        description="Root finding method"
    )
    Pc_bounds: List[float] = Field(
        default=[100000.0, 8000000.0],
        description="Chamber pressure bounds [Pa]"
    )
    tolerance: float = Field(default=1e-6, gt=0, description="Root finding tolerance")
    max_iterations: int = Field(default=100, gt=0, description="Max iterations")
    closure: ClosureConfig = Field(default_factory=ClosureConfig)


InjectorConfig = Union[PintleInjectorConfig, CoaxialInjectorConfig, ImpingingInjectorConfig]


# Flight simulation configuration classes
class LOXTankConfig(BaseModel):
    """LOX tank geometry configuration for flight simulation"""
    lox_h: float = Field(gt=0, description="LOX tank height (internal cylindrical length, not including end caps) [m]")
    lox_radius: float = Field(gt=0, description="LOX tank internal radius [m]")
    ox_tank_pos: float = Field(description="LOX tank center position relative to nozzle exit (positive = above nozzle) [m]")
    mass: Optional[float] = Field(default=None, gt=0, description="Initial LOX PROPELLANT mass [kg] (liquid only, not tank structure). Depletes during burn.")
    initial_pressure_psi: Optional[float] = Field(default=None, gt=0, description="Initial LOX tank pressure [psi]")
    tank_volume_m3: Optional[float] = Field(default=None, gt=0, description="LOX tank volume [m³]. If not provided, will be calculated from lox_h and lox_radius using π×r²×h")


class FuelTankConfig(BaseModel):
    """Fuel tank geometry configuration for flight simulation"""
    rp1_h: float = Field(gt=0, description="RP-1 tank height (internal cylindrical length, not including end caps) [m]")
    rp1_radius: float = Field(gt=0, description="RP-1 tank internal radius [m]")
    fuel_tank_pos: float = Field(description="Fuel tank center position relative to nozzle exit (positive = above, negative = below nozzle) [m]")
    mass: Optional[float] = Field(default=None, gt=0, description="Initial RP-1 PROPELLANT mass [kg] (liquid only, not tank structure). Depletes during burn.")
    initial_pressure_psi: Optional[float] = Field(default=None, gt=0, description="Initial fuel tank pressure [psi]")
    tank_volume_m3: Optional[float] = Field(default=None, gt=0, description="RP-1 tank volume [m³]. If not provided, will be calculated from rp1_h and rp1_radius using π×r²×h")


class PressTankConfig(BaseModel):
    """Pressurant (COPV) tank configuration for flight simulation.
    
    For gaseous nitrogen (GN2) pressurization system.
    - dry_mass: COPV tank structure mass (walls, fittings)
    - initial_gas_mass: Initial N2 gas mass from COPV sizing
    - free_volume_L: COPV free internal volume in liters
    """
    press_h: float = Field(gt=0, description="Pressurant tank height (internal cylindrical length) [m]")
    press_radius: float = Field(gt=0, description="Pressurant tank internal radius [m]")
    pres_tank_pos: float = Field(description="Pressurant tank center position relative to nozzle exit (positive = above nozzle) [m]")
    dry_mass: Optional[float] = Field(default=None, gt=0, description="COPV tank structure mass (tank walls only, no gas) [kg]")
    initial_gas_mass: Optional[float] = Field(default=None, gt=0, description="Initial N2 pressurant gas mass [kg] (from COPV sizing)")
    mass: Optional[float] = Field(default=None, gt=0, description="LEGACY: Use initial_gas_mass instead")
    free_volume_L: Optional[float] = Field(default=4.5, gt=0, description="COPV free internal volume [L]")


class FinsConfig(BaseModel):
    """Fins configuration for flight simulation"""
    no_fins: int = Field(gt=0, description="Number of fins (typically 3 or 4)")
    root_chord: float = Field(gt=0, description="Root chord length (fin edge attached to body) [m]")
    tip_chord: float = Field(gt=0, description="Tip chord length (outer fin edge) [m]")
    fin_span: float = Field(gt=0, description="Fin span (height from body to fin tip) [m]")
    fin_position: float = Field(description="Fin leading edge position from rocket tail (z=0) [m]")


class MotorConfig(BaseModel):
    """Motor configuration for flight simulation (LEGACY - use propulsion_dry_mass instead)"""
    dry_mass: float = Field(gt=0, description="Motor dry mass [kg]")
    inertia: List[float] = Field(description="Motor inertia [kg·m²]")


class RocketConfig(BaseModel):
    """Rocket configuration for flight simulation.
    
    NEW Mass Model (recommended):
    - airframe_mass: Rocket body without propulsion (fuselage, fins, nosecone, avionics, payload)
    - engine_mass: Engine + ALL plumbing (chamber, nozzle, injector, valves, fittings, lines)
    - lox_tank_structure_mass: Empty LOX tank only (walls, no fittings)
    - fuel_tank_structure_mass: Empty fuel tank only (walls, no fittings)
    - copv_dry_mass: Empty COPV tank only (walls, no pressurant gas)
    - engine_cm_offset: Height of engine CM above nozzle exit
    - rocket_length: Total rocket length (tail to nose tip) for MoI estimation
    
    propulsion_dry_mass and propulsion_cm_offset are COMPUTED from the above.
    
    Total dry mass = airframe_mass + engine_mass + lox_tank_structure_mass + fuel_tank_structure_mass + copv_dry_mass
    Total wet mass = dry mass + lox_tank.mass + fuel_tank.mass (propellants) + press_tank.initial_gas_mass
    
    LEGACY fields (mass, motor.dry_mass) still supported for backward compatibility.
    """
    # NEW detailed mass model
    airframe_mass: Optional[float] = Field(default=None, gt=0, description="Airframe mass (fuselage, fins, nosecone, avionics, payload) - NO propulsion [kg]")
    engine_mass: Optional[float] = Field(default=None, gt=0, description="Engine + plumbing mass (chamber, nozzle, injector, valves, ALL fittings & lines) [kg]")
    lox_tank_structure_mass: Optional[float] = Field(default=None, gt=0, description="Empty LOX tank only (walls, no fittings) [kg]")
    fuel_tank_structure_mass: Optional[float] = Field(default=None, gt=0, description="Empty fuel tank only (walls, no fittings) [kg]")
    engine_cm_offset: float = Field(default=0.15, ge=0, description="Height of engine+plumbing CM above nozzle exit [m]. Typical: 0.1-0.3m.")
    
    # COMPUTED fields (calculated from detailed breakdown)
    propulsion_dry_mass: Optional[float] = Field(default=None, gt=0, description="COMPUTED: Total propulsion dry mass (engine + tanks) [kg]")
    propulsion_cm_offset: float = Field(default=0.3, description="COMPUTED: Propulsion system CM above nozzle exit [m]")
    
    # COPV tank structure mass (for blowdown systems)
    copv_dry_mass: Optional[float] = Field(default=None, gt=0, description="COPV tank structure mass (tank walls only, no pressurant gas) [kg]")
    
    # Common parameters
    inertia: List[float] = Field(description="AIRFRAME inertia only (without motor/propulsion), relative to airframe CM [Ixx, Iyy, Izz] [kg·m²]. Motor inertia is added separately by RocketPy from propulsion_dry_mass.")
    radius: float = Field(gt=0, description="Rocket body radius (outer diameter / 2) [m]")
    rocket_length: Optional[float] = Field(default=None, gt=0, description="Total rocket length from tail to nose tip [m]. Used for MoI estimation.")
    motor_position: float = Field(default=0.0, description="Nozzle exit position from rocket tail (z=0 at tail, positive toward nose) [m]")
    fins: Optional[FinsConfig] = Field(default=None, description="Fins configuration")
    
    # LEGACY fields - kept for backward compatibility
    mass: Optional[float] = Field(default=None, gt=0, description="LEGACY: Airframe mass. Use airframe_mass instead.")
    cm_wo_motor: Optional[float] = Field(default=None, description="LEGACY: CM without motor. Now auto-calculated from airframe_mass and propulsion positions.")
    dry_mass: Optional[float] = Field(default=None, gt=0, description="LEGACY: Unused field.")
    motor_inertia: Optional[List[float]] = Field(default=None, description="LEGACY: Motor inertia. Now estimated from propulsion_dry_mass.")
    motor: Optional[MotorConfig] = Field(default=None, description="LEGACY: Motor config. Use propulsion_dry_mass instead.")


class EnvironmentConfig(BaseModel):
    """Environment configuration for flight simulation"""
    date: List[int] = Field(description="Launch date and time [year, month, day, hour (0-23 UTC)]")
    latitude: float = Field(ge=-90, le=90, description="Launch site latitude (positive = North, negative = South) [deg]")
    longitude: float = Field(ge=-180, le=180, description="Launch site longitude (positive = East, negative = West) [deg]")
    elevation: float = Field(description="Launch site elevation above sea level (ground level) [m]")
    # NOTE: p_amb removed - RocketPy fetches atmospheric pressure from GFS forecast based on date/location


class ThrustConfig(BaseModel):
    """Thrust configuration for flight simulation"""
    burn_time: float = Field(gt=0, description="Burn time [s]")


class FrozenParametersConfig(BaseModel):
    """Frozen parameter values for Layer 1 optimization.
    
    When a parameter is set (not None), the optimizer will use that exact
    value instead of optimizing it. Values use user-friendly units.
    """
    # Chamber geometry
    A_throat_mm2: Optional[float] = Field(default=None, gt=0, description="Frozen throat area [mm²]")
    Lstar_mm: Optional[float] = Field(default=None, gt=0, description="Frozen characteristic length L* [mm]")
    expansion_ratio: Optional[float] = Field(default=None, gt=1, description="Frozen expansion ratio (A_exit/A_throat)")
    D_chamber_outer_mm: Optional[float] = Field(default=None, gt=0, description="Frozen chamber outer diameter [mm]")
    
    # Injector geometry
    d_pintle_tip_mm: Optional[float] = Field(default=None, gt=0, description="Frozen pintle tip diameter [mm]")
    h_gap_mm: Optional[float] = Field(default=None, gt=0, description="Frozen annular gap height [mm]")
    n_orifices: Optional[int] = Field(default=None, gt=0, description="Frozen number of LOX orifices")
    d_orifice_mm: Optional[float] = Field(default=None, gt=0, description="Frozen LOX orifice diameter [mm]")
    
    # Initial tank pressures
    P_O_start_psi: Optional[float] = Field(default=None, gt=0, description="Frozen initial LOX tank pressure [psi]")
    P_F_start_psi: Optional[float] = Field(default=None, gt=0, description="Frozen initial fuel tank pressure [psi]")


class DesignRequirementsConfig(BaseModel):
    """Design requirements for optimizer"""
    # Performance targets
    target_thrust: float = Field(default=7000.0, gt=0, description="Target peak thrust [N]")
    target_apogee: Optional[float] = Field(default=3048.0, gt=0, description="Target apogee above ground level [m]")
    optimal_of_ratio: float = Field(default=2.3, gt=0, description="Target oxidizer-to-fuel mixture ratio")
    target_burn_time: float = Field(default=10.0, gt=0, description="Target burn time [s]")
    
    # Tank pressures
    max_lox_tank_pressure_psi: float = Field(default=700.0, gt=0, description="Maximum LOX tank pressure [psi]")
    max_fuel_tank_pressure_psi: float = Field(default=850.0, gt=0, description="Maximum fuel tank pressure [psi]")
    max_P_tank_O: Optional[float] = Field(default=None, gt=0, description="Maximum LOX tank pressure [Pa] (auto-converted from psi if None)")
    max_P_tank_F: Optional[float] = Field(default=None, gt=0, description="Maximum fuel tank pressure [Pa] (auto-converted from psi if None)")
    
    # Geometry constraints
    max_engine_length: float = Field(default=0.5, gt=0, description="Maximum total engine length (chamber + nozzle) [m]")
    max_chamber_outer_diameter: float = Field(default=0.15, gt=0, description="Maximum chamber outer diameter [m]")
    max_nozzle_exit_diameter: float = Field(default=0.101, gt=0, description="Maximum nozzle exit diameter [m]")
    
    # L* constraints
    min_Lstar: float = Field(default=0.95, gt=0, description="Minimum characteristic length [m]")
    max_Lstar: float = Field(default=1.27, gt=0, description="Maximum characteristic length [m]")
    
    # Stability requirements (new comprehensive analysis)
    min_stability_score: float = Field(default=0.75, ge=0, le=1, description="Minimum stability score (0-1)")
    require_stable_state: bool = Field(default=True, description="Require 'stable' state (not just 'marginal')")
    stability_margin_handicap: float = Field(default=0.0, ge=0, le=1, description="Stability requirement relaxation factor (0=strict, 1=any)")
    
    # Stability requirements (legacy margins)
    min_stability_margin: float = Field(default=1.2, gt=0, description="Legacy minimum overall stability margin")
    chugging_margin_min: float = Field(default=0.2, ge=0, description="Minimum chugging stability margin")
    acoustic_margin_min: float = Field(default=0.1, ge=0, description="Minimum acoustic stability margin")
    feed_stability_min: float = Field(default=0.15, ge=0, description="Minimum feed system stability margin")
    
    # Tank capacities (for optimizer bounds)
    lox_tank_capacity_kg: Optional[float] = Field(default=None, gt=0, description="LOX tank capacity [kg]")
    fuel_tank_capacity_kg: Optional[float] = Field(default=None, gt=0, description="Fuel tank capacity [kg]")
    
    # COPV
    copv_free_volume_L: Optional[float] = Field(default=4.5, gt=0, description="COPV free internal volume [L]")
    copv_free_volume_m3: Optional[float] = Field(default=None, gt=0, description="COPV free volume [m³] (auto-converted from L if None)")
    
    # Injector ΔP_inj / Pc soft penalty bands (Layer 1); quadratic hinge outside each interval
    injector_dp_ratio_O_min: float = Field(
        default=0.15,
        ge=0.0,
        description="Preferred lower edge for oxidizer ΔP_inj/Pc (soft hinge)",
    )
    injector_dp_ratio_O_max: float = Field(
        default=0.40,
        gt=0.0,
        description="Preferred upper edge for oxidizer ΔP_inj/Pc (soft hinge)",
    )
    injector_dp_ratio_F_min: float = Field(
        default=0.15,
        ge=0.0,
        description="Preferred lower edge for fuel ΔP_inj/Pc (soft hinge)",
    )
    injector_dp_ratio_F_max: float = Field(
        default=0.40,
        gt=0.0,
        description="Preferred upper edge for fuel ΔP_inj/Pc (soft hinge)",
    )
    W_geom_ao_af_momentum: float = Field(
        default=0.0,
        ge=0.0,
        description=(
            "Layer 1 impinging-only: weight × (relative error)² steering A_geom_O/A_geom_F toward "
            "MR/√(ρ_O/ρ_F) (consistent with R≈1 for bulk velocities). 0 disables."
        ),
    )
    # Layer 1 impinging-only (optional overrides; omit or null to use optimizer code defaults).
    W_MOM: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "Weight on momentum_ratio_R quadratic hinge relative to bands below "
            "(default in layer1_static_optimization.py is 75 when unset)."
        ),
    )
    impinging_momentum_R_min: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Preferred lower edge for momentum_ratio_R hinge R (impinging-only). None disables.",
    )
    impinging_momentum_R_max: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Preferred upper edge for momentum_ratio_R hinge.",
    )
    layer1_impinging_angle_deg_min: Optional[float] = Field(
        default=None,
        gt=0.0,
        lt=180.0,
        description="Preferred lower edge for effective impingement angle hinge [deg] (impinging-only).",
    )
    layer1_impinging_angle_deg_max: Optional[float] = Field(
        default=None,
        gt=0.0,
        lt=180.0,
        description="Preferred upper edge for effective impingement angle hinge [deg] (impinging-only).",
    )
    W_IMPINGING_ANGLE: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "Layer 1 impinging-only weight on effective impingement angle hinge term "
            "(uses layer1_impinging_angle_deg_min/max when both are set)."
        ),
    )
    # Paired-doublet realism: constrain how far oxidizer vs fuel jet inclinations may diverge.
    W_IMPINGING_JET_ASYM: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "Impinging paired jets only: weight on normalized excess [|θ_O−θ_F| − "
            "`layer1_impinging_jet_angle_max_asym_deg`]₊ squared (paired-doublet coherence preference)."
        ),
    )
    layer1_impinging_jet_angle_max_asym_deg: Optional[float] = Field(
        default=None,
        gt=0.0,
        lt=180.0,
        description=(
            "Impinging paired jets only: allowable |θ_O−θ_F| before asymmetry hinge activates [deg]. "
            "Unset ⇒ optimizer defaults (see layer1_static_optimization)."
        ),
    )
    layer1_exit_pressure_inside_quad_scale: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "Inside the nominal plus-or-minus 5 percent exit-pressure deadband, multiply W_EXIT by this "
            "coefficient times (ΔP_exit/P_tgt) squared to steer toward atmospheric-matched nozzle exit pressure."
        ),
    )
    layer1_impinging_n_doublets_max: Optional[int] = Field(
        default=None,
        ge=5,
        description=(
            "Layer 1 impinging: max paired LOX/fuel element count (n_doublets). "
            "The bore-derived ceiling from ``impinging_n_elements_hi_int`` is clipped to this value when set."
        ),
    )
    layer1_random_seed: Optional[int] = Field(
        default=None,
        description=(
            "Layer 1 integer seed for NumPy restart perturbations and CMA-ES ``seed`` "
            "(each restart uses seed + restart_index × 1_000_003). Omit or null → base 42."
        ),
    )
    layer1_cma_warmstart_trials: Optional[int] = Field(
        default=None,
        ge=0,
        description=(
            "Before legacy CMA-ES, evaluate this many clipped/snapped candidates around ``x0`` "
            "(same worker objective as CMA). 0 disables. Default 16 in optimizer when unset."
        ),
    )
    layer1_cma_warmstart_sigma_frac: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=0.5,
        description=(
            "Per-dimension Gaussian scale for warm-start perturbations: ``sigma_frac × (upper−lower)``. "
            "Default 0.04 when unset."
        ),
    )
    layer1_cma_restart0_sigma_scale: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description=(
            "After warm-start, multiply legacy CMA-ES initial step size (restart 0 only) by this factor "
            "so the first population stays near the feasible mean (default 0.48 in code when unset)."
        ),
    )
    layer1_lbfgs_gtol: Optional[float] = Field(
        default=None,
        gt=0.0,
        description=(
            "Gradient norm tolerance for the L-BFGS-B local refinement after CMA-ES (default 1e-9 in code). "
            "Tighter values can reduce the weighted objective; they do not target a specific absolute objective magnitude."
        ),
    )
    layer1_lbfgs_second_pass: Optional[bool] = Field(
        default=None,
        description=(
            "If true, run a second L-BFGS-B from the first local optimum with a tighter ``gtol`` (default true in code)."
        ),
    )
    W_DP: Optional[float] = Field(default=None, ge=0.0, description="Layer 1 fallback injector ΔP weight.")
    W_DP_O: Optional[float] = Field(default=None, ge=0.0, description="Layer 1 oxidizer stream ΔP hinge weight.")
    W_DP_F: Optional[float] = Field(default=None, ge=0.0, description="Layer 1 fuel stream ΔP hinge weight.")
    W_DP_HIGH: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "Layer 1 weight on injector ΔP hinge term when both ΔP/Pc streams exceed their bands "
            "(used together with W_DP_O/W_DP_F in weighted injector ΔP penalty)."
        ),
    )
    layer1_infeasibility_gate_eps: Optional[float] = Field(
        default=None,
        ge=0.0,
        description="Treat infeasibility_score ≤ eps as feasible for thrust/MR/ΔP objective blending.",
    )
    layer1_W_THRUST: Optional[float] = Field(
        default=None,
        ge=0.0,
        description="Layer 1 weight on thrust penalty term (code default 1e4 when unset).",
    )
    layer1_W_OF: Optional[float] = Field(
        default=None,
        ge=0.0,
        description="Layer 1 weight on relative MR error squared (code default 1e4 when unset).",
    )
    layer1_W_OF_low_MR_scale: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "When MR is below optimal_of_ratio, multiply the O/F penalty by max(1, this scale) "
            "(default 1: no extra weight on fuel-rich side)."
        ),
    )
    layer1_W_OF_high_MR_scale: Optional[float] = Field(
        default=None,
        ge=0.0,
        description=(
            "When MR exceeds optimal_of_ratio, multiply the O/F penalty by max(1, this scale) "
            "(default 1: symmetric with low‑MR tuning optional)."
        ),
    )
    layer1_of_validation_tol: Optional[float] = Field(
        default=None,
        gt=0.0,
        description=(
            "Relative MR error cap used for Layer‑1 bookkeeping and for ``pressure_candidate_valid`` "
            "O/F gate (default 0.15)."
        ),
    )
    layer1_thrust_validation_rel_tol: Optional[float] = Field(
        default=None,
        gt=0.0,
        description=(
            "Relative thrust error gate for ``pressure_candidate_valid``. "
            "If unset, uses ``tolerances['thrust']`` passed into ``run_layer1_optimization`` (default 10%)."
        ),
    )
    W_CHAMBER_SHAPE: Optional[float] = Field(
        default=None,
        ge=0.0,
        description="Layer 1 weight on chamber-shape regularization (D_chamber/D_throat and L_chamber/D_chamber).",
    )
    layer1_chamber_dt_ratio_min: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Preferred lower bound for chamber-to-throat diameter ratio D_chamber_inner/D_throat.",
    )
    layer1_chamber_dt_ratio_max: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Preferred upper bound for chamber-to-throat diameter ratio D_chamber_inner/D_throat.",
    )
    layer1_chamber_ld_ratio_min: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Preferred lower bound for chamber length ratio L_chamber/D_chamber_inner.",
    )
    layer1_chamber_ld_ratio_max: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Preferred upper bound for chamber length ratio L_chamber/D_chamber_inner.",
    )

    layer1_stagnation_pressure_frac_min: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description=(
            "Layer 1 search-box lower edge as a fraction of each tank cap: "
            "P_O ∈ [max_lox×f_min, max_lox×f_max], P_F similarly (unless overridden below). "
            "Default when unset: 0.65."
        ),
    )
    layer1_stagnation_pressure_frac_max: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="Companion upper fraction for stagnation-pressure box (default when unset: 0.85).",
    )
    layer1_expansion_ratio_min: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Optional lower bound for Layer 1 expansion-ratio search box (default when unset: 4.0).",
    )
    layer1_expansion_ratio_max: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Optional upper bound for Layer 1 expansion-ratio search box (default when unset: 12.0).",
    )
    layer1_P_O_start_psi_min: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Optional absolute LOX stagnation pressure lower bound [psi] for Layer 1 (overrides frac box).",
    )
    layer1_P_O_start_psi_max: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Optional absolute LOX stagnation upper bound [psi].",
    )
    layer1_P_F_start_psi_min: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Optional fuel stagnation lower bound [psi].",
    )
    layer1_P_F_start_psi_max: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Optional fuel stagnation upper bound [psi].",
    )

    # Frozen parameters (optional - for locking specific values during optimization)
    frozen_parameters: Optional[FrozenParametersConfig] = Field(
        default=None,
        description="Optional frozen parameter values for Layer 1 optimization. When set, these values are used instead of being optimized."
    )

    @model_validator(mode="after")
    def _injector_dp_bands_ordered(self):
        if self.injector_dp_ratio_O_max <= self.injector_dp_ratio_O_min:
            raise ValueError("injector_dp_ratio_O_max must exceed injector_dp_ratio_O_min")
        if self.injector_dp_ratio_F_max <= self.injector_dp_ratio_F_min:
            raise ValueError("injector_dp_ratio_F_max must exceed injector_dp_ratio_F_min")
        rlo, rhi = self.impinging_momentum_R_min, self.impinging_momentum_R_max
        if (rlo is not None) ^ (rhi is not None):
            raise ValueError("Set both impinging_momentum_R_min and impinging_momentum_R_max or neither.")
        if rlo is not None and rhi is not None and float(rhi) <= float(rlo):
            raise ValueError("impinging_momentum_R_max must exceed impinging_momentum_R_min.")
        alo, ahi = self.layer1_impinging_angle_deg_min, self.layer1_impinging_angle_deg_max
        if (alo is not None) ^ (ahi is not None):
            raise ValueError("Set both layer1_impinging_angle_deg_min and layer1_impinging_angle_deg_max or neither.")
        if alo is not None and ahi is not None and float(ahi) <= float(alo):
            raise ValueError("layer1_impinging_angle_deg_max must exceed layer1_impinging_angle_deg_min.")
        fmn, fmx = self.layer1_stagnation_pressure_frac_min, self.layer1_stagnation_pressure_frac_max
        if fmn is not None and fmx is not None and float(fmx) <= float(fmn):
            raise ValueError("layer1_stagnation_pressure_frac_max must exceed layer1_stagnation_pressure_frac_min.")
        ermn, ermx = self.layer1_expansion_ratio_min, self.layer1_expansion_ratio_max
        if ermn is not None and ermx is not None and float(ermx) <= float(ermn):
            raise ValueError("layer1_expansion_ratio_max must exceed layer1_expansion_ratio_min.")
        dtr_lo, dtr_hi = self.layer1_chamber_dt_ratio_min, self.layer1_chamber_dt_ratio_max
        if (dtr_lo is not None) ^ (dtr_hi is not None):
            raise ValueError("Set both layer1_chamber_dt_ratio_min and layer1_chamber_dt_ratio_max or neither.")
        if dtr_lo is not None and dtr_hi is not None and float(dtr_hi) <= float(dtr_lo):
            raise ValueError("layer1_chamber_dt_ratio_max must exceed layer1_chamber_dt_ratio_min.")
        ldr_lo, ldr_hi = self.layer1_chamber_ld_ratio_min, self.layer1_chamber_ld_ratio_max
        if (ldr_lo is not None) ^ (ldr_hi is not None):
            raise ValueError("Set both layer1_chamber_ld_ratio_min and layer1_chamber_ld_ratio_max or neither.")
        if ldr_lo is not None and ldr_hi is not None and float(ldr_hi) <= float(ldr_lo):
            raise ValueError("layer1_chamber_ld_ratio_max must exceed layer1_chamber_ld_ratio_min.")
        return self


class HybridOptimizerConfig(BaseModel):
    """Configuration for Hybrid CMA + Block Re-optimization"""
    elite_k: int = Field(default=50, gt=0, description="Size of elite pool for block building")
    
    block_method: Literal["random", "corr_greedy"] = Field(
        default="random",
        description="Method to build variable blocks: 'random' or 'corr_greedy' (correlation-based)"
    )
    num_blocks: int = Field(default=3, gt=0, description="Number of blocks")
    overlap_fraction: float = Field(default=0.0, ge=0.0, le=0.5, description="Fraction of block indices that overlap with the previous block")
    
    cycles: int = Field(default=3, gt=0, description="Number of re-optimization cycles")
    
    # Soft freezing / Penalty parameters
    lambda0: float = Field(default=1e-3, gt=0, description="Initial penalty weight base")
    lambda_mult: float = Field(default=10.0, gt=1.0, description="Multiplier for lambda per cycle")
    lambda_max: float = Field(default=1.0, gt=0, description="Maximum lambda (relative to f-scale)")
    lambda_normalize: bool = Field(default=True, description="Normalize lambda using objective function scale magnitude")
    
    # Budgeting
    per_block_budget_fraction: float = Field(default=0.5, gt=0.0, le=0.9, description="Fraction of TOTAL budget allocated to block optimization cycles")
    
    # Global Refresh
    refresh_every_pass: bool = Field(default=True, description="Run a global refresh after every full pass of blocks")
    refresh_budget_fraction: float = Field(default=0.1, gt=0.0, le=1.0, description="Fraction of initial global budget for each refresh")
    refresh_sigma_scale: float = Field(default=0.2, gt=0.0, le=1.0, description="Scale of sigma for refresh relative to initial sigma")
    
    # Multi-track
    num_tracks: int = Field(default=1, gt=0, description="Number of independent optimization tracks")


class OptimizerConfig(BaseModel):
    """Main Optimizer Configuration"""
    mode: Literal["cma", "hybrid_cma_blocks"] = Field(
        default="cma",
        description="Optimization mode: 'cma' (baseline) or 'hybrid_cma_blocks'"
    )
    hybrid: Optional[HybridOptimizerConfig] = Field(default=None, description="Configuration for hybrid mode")


class PressureSegmentConfig(BaseModel):
    """Single segment of a pressure curve"""
    length_ratio: float = Field(gt=0, le=1, description="Fraction of total burn time for this segment (0-1)")
    type: Literal["linear", "blowdown"] = Field(description="Segment type: 'linear' or 'blowdown'")
    start_pressure_pa: float = Field(gt=0, description="Pressure at segment start [Pa]")
    end_pressure_pa: float = Field(gt=0, description="Pressure at segment end [Pa]")
    k: Optional[float] = Field(default=None, gt=0, description="Blowdown parameter k (only used for blowdown type, typically 0.1-2.0)")


class PressureCurvesConfig(BaseModel):
    """Optimized pressure curves from Layer 2 optimization"""
    n_points: int = Field(default=200, gt=0, description="Number of points in the generated pressure curve arrays")
    target_burn_time_s: float = Field(gt=0, description="Target burn time [s] used for optimization")
    initial_lox_pressure_pa: float = Field(gt=0, description="Initial LOX tank pressure [Pa]")
    initial_fuel_pressure_pa: float = Field(gt=0, description="Initial fuel tank pressure [Pa]")
    lox_segments: List[PressureSegmentConfig] = Field(description="LOX tank pressure curve segments")
    fuel_segments: List[PressureSegmentConfig] = Field(description="Fuel tank pressure curve segments")


class PintleEngineConfig(BaseModel):
    """Complete pintle engine configuration"""
    fluids: Dict[str, FluidConfig]
    injector: InjectorConfig
    feed_system: Dict[str, FeedSystemConfig]  # "oxidizer" and "fuel"
    regen_cooling: Optional[RegenCoolingConfig] = Field(default=None, description="Regenerative cooling configuration (fuel only)")
    film_cooling: Optional[FilmCoolingConfig] = Field(default=None, description="Film cooling configuration")
    ablative_cooling: Optional[AblativeCoolingConfig] = Field(default=None, description="Ablative cooling configuration for chamber liner")
    graphite_insert: Optional[GraphiteInsertConfig] = Field(default=None, description="Graphite throat insert configuration (separate from chamber ablator)")
    stainless_steel_case: Optional[StainlessSteelCaseConfig] = Field(default=None, description="Stainless steel case configuration (structural wall behind ablative/graphite)")
    discharge: Dict[str, DischargeConfig]  # "oxidizer" and "fuel"
    spray: SprayConfig = Field(default_factory=SprayConfig)
    combustion: CombustionConfig = Field(default_factory=CombustionConfig)
    # Chamber geometry - unified section for solve_chamber_geometry_with_cea
    chamber_geometry: Optional[ChamberGeometryConfig] = Field(default=None, description="Unified chamber geometry config (design inputs + solver outputs)")
    # Legacy chamber/nozzle sections (for backward compatibility - optional if chamber_geometry is provided)
    chamber: Optional[ChamberConfig] = Field(default=None, description="Legacy chamber config (use chamber_geometry instead)")
    nozzle: Optional[NozzleConfig] = Field(default=None, description="Legacy nozzle config (use chamber_geometry instead)")
    solver: SolverConfig = Field(default_factory=SolverConfig)
    optimizer: Optional[OptimizerConfig] = Field(default=None, description="Optimizer configuration")
    # Flight simulation fields (optional)
    lox_tank: Optional[LOXTankConfig] = Field(default=None, description="LOX tank configuration for flight simulation")
    fuel_tank: Optional[FuelTankConfig] = Field(default=None, description="Fuel tank configuration for flight simulation")
    press_tank: Optional[PressTankConfig] = Field(default=None, description="Pressurant tank configuration for flight simulation")
    rocket: Optional[RocketConfig] = Field(default=None, description="Rocket configuration for flight simulation")
    environment: Optional[EnvironmentConfig] = Field(default=None, description="Environment configuration for flight simulation")
    thrust: Optional[ThrustConfig] = Field(default=None, description="Thrust configuration for flight simulation")
    design_requirements: Optional[DesignRequirementsConfig] = Field(default=None, description="Design requirements for optimizer")
    pressure_curves: Optional[PressureCurvesConfig] = Field(default=None, description="Optimized pressure curves from Layer 2 optimization")

    @field_validator("feed_system", "discharge")
    @classmethod
    def validate_branches(cls, v):
        """Ensure both oxidizer and fuel branches are present"""
        if "oxidizer" not in v or "fuel" not in v:
            raise ValueError("Must specify both 'oxidizer' and 'fuel' branches")
        return v

    @model_validator(mode="after")
    def align_expansion_ratio_with_exit_throat_areas(self):
        """Nozzle thrust uses eps == A_exit/A_throat (strict); YAML often labels eps rounded."""
        cg = self.chamber_geometry
        if cg is None:
            return self
        at = cg.A_throat
        ae = cg.A_exit
        if at is None or ae is None:
            return self
        try:
            at_f = float(at)
            ae_f = float(ae)
        except (TypeError, ValueError):
            return self
        if not np.isfinite(at_f) or not np.isfinite(ae_f) or at_f <= 0 or ae_f <= 0:
            return self
        eps_geo = ae_f / at_f
        if eps_geo <= 1.0:
            return self
        cg.expansion_ratio = float(eps_geo)
        try:
            self.combustion.cea.expansion_ratio = float(eps_geo)
        except Exception:
            pass
        nz = self.nozzle
        if nz is not None:
            try:
                nz.expansion_ratio = float(eps_geo)
            except Exception:
                pass
        return self

    class Config:
        extra = "allow"  # Reject unknown fields


def ensure_chamber_geometry(config: PintleEngineConfig) -> ChamberGeometryConfig:
    """
    Ensure chamber_geometry exists, creating from legacy sections if needed.
    
    This helper function provides backward compatibility by creating chamber_geometry
    from legacy chamber/nozzle sections if chamber_geometry doesn't exist.
    
    Parameters:
    -----------
    config : PintleEngineConfig
        Configuration object
        
    Returns:
    --------
    ChamberGeometryConfig
        The chamber_geometry config (created if needed)
        
    Raises:
    -------
    ValueError
        If neither chamber_geometry nor legacy sections exist
    """
    if config.chamber_geometry is not None:
        return config.chamber_geometry
    
    # Create from legacy sections if they exist
    if config.chamber is None or config.nozzle is None:
        raise ValueError(
            "Must provide either 'chamber_geometry' section or both 'chamber' and 'nozzle' sections"
        )
    
    # Create chamber_geometry from legacy sections
    chamber = config.chamber
    nozzle = config.nozzle
    
    # Get design parameters (use defaults if not in legacy sections)
    design_pressure = getattr(chamber, 'design_pressure', 2.0e6)
    design_thrust = getattr(chamber, 'design_thrust', 5000.0)
    design_MR = getattr(chamber, 'design_MR', 2.55)
    
    # Get dimensions
    chamber_diameter = getattr(chamber, 'chamber_inner_diameter', 0.08)
    Lstar = getattr(chamber, 'Lstar', 1.0)
    exit_diameter = getattr(chamber, 'exit_diameter', None) or getattr(nozzle, 'exit_diameter', 0.1)
    expansion_ratio = getattr(nozzle, 'expansion_ratio', 8.0)
    nozzle_efficiency = getattr(nozzle, 'efficiency', 0.95)
    
    # Get solved outputs (if available)
    A_throat = getattr(chamber, 'A_throat', None) or getattr(nozzle, 'A_throat', None)
    A_exit = getattr(nozzle, 'A_exit', None)
    volume = getattr(chamber, 'volume', None)
    length = getattr(chamber, 'length', None)
    length_cylindrical = getattr(chamber, 'length_cylindrical', None)
    length_contraction = getattr(chamber, 'length_contraction', None)
    Cf = getattr(chamber, 'design_force_coefficient', None)
    
    # Create and assign chamber_geometry
    config.chamber_geometry = ChamberGeometryConfig(
        design_pressure=design_pressure,
        design_thrust=design_thrust,
        design_MR=design_MR,
        chamber_diameter=chamber_diameter,
        Lstar=Lstar,
        exit_diameter=exit_diameter,
        expansion_ratio=expansion_ratio,
        nozzle_efficiency=nozzle_efficiency,
        A_throat=A_throat,
        A_exit=A_exit,
        volume=volume,
        length=length,
        length_cylindrical=length_cylindrical,
        length_contraction=length_contraction,
        Cf=Cf,
    )
    
    return config.chamber_geometry
