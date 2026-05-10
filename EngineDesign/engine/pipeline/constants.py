"""
Physical and engineering constants used throughout the pintle engine pipeline.

This module centralizes all magic numbers and default values to improve maintainability
and make the physical meaning of constants explicit.

⚠️ IMPORTANT: DEPRECATED DEFAULT/FALLBACK CONSTANTS ⚠️
===========================================================
Many constants in this file with names starting with DEFAULT_* or FALLBACK_*
are DEPRECATED and should NOT be used to hide missing values or failed calculations.

WRONG usage (DO NOT DO THIS):
    gamma = cea_props.get("gamma", DEFAULT_GAMMA_ND)  # WRONG!
    density = max(calculated_density, MIN_DENS_KG_M3)  # WRONG!

CORRECT usage:
    if "gamma" not in cea_props:
        raise KeyError("Missing gamma in CEA properties")
    gamma = cea_props["gamma"]
    if not (1.0 < gamma < 2.0):
        raise ValueError(f"Invalid gamma: {gamma}")

These constants should only be used for:
1. Physical limits (e.g., GRAVITATIONAL_ACCEL_M_S2)
2. Model parameters explicitly chosen by design (not fallbacks)
3. Testing with explicit test data
===========================================================

Naming Convention:
- All constants include units in their names (e.g., _K, _PA, _M, _M_S)
- Dimensionless constants use _ND suffix (non-dimensional)
- This prevents unit confusion and makes conversions explicit
"""

# ============================================================================
# FUNDAMENTAL PHYSICAL CONSTANTS
# ============================================================================

# Stefan-Boltzmann constant for blackbody radiation
# Units: W/(m²·K⁴)
STEFAN_BOLTZMANN_W_M2_K4 = 5.670374419e-8

# Universal gas constant
# Units: J/(kmol·K)
UNIVERSAL_GAS_CONST_J_KMOL_K = 8314.462618

# Standard gravitational acceleration
# Units: m/s²
GRAVITATIONAL_ACCEL_M_S2 = 9.80665

# ============================================================================
# DEFAULT GAS PROPERTIES (Combustion Products)
# ============================================================================
# These are fallback values used when gas properties are not available from CEA
# or other sources. Values are typical for hydrocarbon/LOX rocket combustion.

# Default specific heat ratio (gamma) for combustion products
# Typical range: 1.20-1.25 for hydrocarbon/LOX
# Used when gas_props dict doesn't contain "gamma"
DEFAULT_GAMMA_ND = 1.2

# Default gas constant for combustion products
# Units: J/(kg·K)
# For molecular weight M ~ 24 kg/kmol: R = R_universal / M ≈ 346 J/(kg·K)
# Typical range: 350-400 J/(kg·K) depending on mixture ratio
# Used when gas_props dict doesn't contain "R"
DEFAULT_GAS_CONST_J_KG_K = 350.0

# Default chamber temperature
# Units: K
# Typical range: 3200-3600 K for hydrocarbon/LOX
# Used when gas_props dict doesn't contain "Tc"
DEFAULT_CHAMBER_TEMP_K = 3500.0

# Default ideal characteristic velocity
# Units: m/s
# Typical range: 1700-1900 m/s for hydrocarbon/LOX
# Used when cstar_ideal is not available
DEFAULT_CSTAR_IDEAL_M_S = 1800.0

# Default mixture ratio
# Typical range: 2.0-3.0 for hydrocarbon/LOX
DEFAULT_MIXTURE_RATIO_ND = 2.5

# Default chamber pressure
# Units: Pa
DEFAULT_CHAMBER_PRESS_PA = 4.0e6  # 4 MPa

# ============================================================================
# DEFAULT FLUID PROPERTIES
# ============================================================================

# Default coolant properties (typical for RP-1 fuel)
DEFAULT_COOLANT_SPEC_HEAT_J_KG_K = 2000.0  # J/(kg·K)
DEFAULT_COOLANT_THERMAL_COND_W_M_K = 0.1  # W/(m·K)
DEFAULT_COOLANT_DENS_KG_M3 = 700.0  # kg/m³
DEFAULT_COOLANT_TEMP_K = 300.0  # K (ambient)

# Default fuel properties (RP-1)
DEFAULT_FUEL_DENS_KG_M3 = 810.0  # kg/m³
DEFAULT_FUEL_BOILING_POINT_K = 489.0  # K

# Default oxidizer properties (LOX)
DEFAULT_LOX_DENS_KG_M3 = 1140.0  # kg/m³

# Default hot gas properties
DEFAULT_HOT_GAS_VISC_PA_S = 4.0e-5  # Pa·s
DEFAULT_HOT_GAS_THERMAL_COND_W_M_K = 0.1  # W/(m·K)
DEFAULT_HOT_GAS_PRANDTL_ND = 0.7  # Dimensionless

# ============================================================================
# HEAT TRANSFER CONSTANTS
# ============================================================================

# Default radiation properties
DEFAULT_EMISSIVITY_ND = 0.8  # Typical for hot gas/combustion products
DEFAULT_VIEW_FACTOR_ND = 1.0  # Full view (no obstruction)

# Default turbulence intensity
# Typical range: 0.05-0.15 for rocket chambers
DEFAULT_TURBULENCE_INTENSITY_ND = 0.08  # 8% turbulence
DEFAULT_TURBULENCE_INTENSITY_COOLANT_ND = 0.05  # 5% for coolant flow

# Nusselt number constants for heat transfer correlations
# Laminar flow (Re < 2000): Nu = 4.36 for constant wall temperature
NU_LAMINAR_ND = 4.36

# Turbulent flow Dittus-Boelter correlation constants
# Nu = C × Re^0.8 × Pr^0.4
NU_TURBULENT_COEFFICIENT_ND = 0.023
NU_TURBULENT_RE_EXPONENT_ND = 0.8
NU_TURBULENT_PR_EXPONENT_ND = 0.4

# Turbulent boundary layer recovery factor
# Used to calculate adiabatic wall temperature: Taw = Tc × recovery_factor
# Typical range: 0.90-0.98 for turbulent boundary layers in rocket chambers
# Accounts for kinetic energy recovery in the boundary layer
# Higher values (closer to 1.0) indicate more efficient recovery
DEFAULT_RECOVERY_FACTOR_ND = 0.94  # Typical value for turbulent flow in rocket chambers

# ============================================================================
# GEOMETRIC DEFAULTS
# ============================================================================

# Default chamber length
# Units: m
# Used when chamber length is not specified
DEFAULT_CHAMBER_LEN_M = 0.1  # 10 cm

# Default chamber diameter (fallback)
# Units: m
DEFAULT_CHAMBER_DIAM_M = 0.08  # 8 cm

# Default throat area (fallback)
# Units: m²
DEFAULT_THROAT_AREA_M2 = 1e-3  # 1 cm²

# Default throat diameter
# Units: m
DEFAULT_THROAT_DIAM_M = 0.033  # 3.3 cm

# ============================================================================
# COMBUSTION CHEMISTRY CONSTANTS
# ============================================================================

# Reference conditions for reaction rate calculations
REF_PRESS_PA = 1.0e6  # 1 MPa [Pa]
REF_TEMP_K = 3500.0  # K

# Activation energies for different fuel types
# Units: J/mol
ACTIVATION_ENERGY_HC_J_MOL = 80000.0  # RP-1, kerosene
ACTIVATION_ENERGY_H2_J_MOL = 40000.0  # H2

# Pre-exponential factors for reaction rates
# Units: 1/s
PRE_EXPONENTIAL_HC_1_S = 1e7
PRE_EXPONENTIAL_H2_1_S = 1e9

# Pressure exponents for reaction rates
PRESSURE_EXPONENT_HC_ND = 0.8
PRESSURE_EXPONENT_H2_ND = 0.5
PRESSURE_EXPONENT_PRE_FACTOR_ND = 0.3  # Pre-exponential pressure dependence

# Reaction time scale reference
# Units: s
DEFAULT_REACTION_TIME_REF_S = 0.005  # 5 ms

# Normalized activation energy for reaction time calculations
# Dimensionless
EA_NORM_FUEL_RICH_ND = 12.0
EA_NORM_STOICHIOMETRIC_ND = 10.0
EA_NORM_OXIDIZER_RICH_ND = 8.0

# ============================================================================
# ABLATIVE MATERIAL CONSTANTS
# ============================================================================

# Default ablative material properties
DEFAULT_ABLATOR_DENS_KG_M3 = 1600.0  # kg/m³ (phenolic ablator typical)
DEFAULT_ABLATOR_THERMAL_COND_W_M_K = 0.35  # W/(m·K)
DEFAULT_ABLATOR_SPEC_HEAT_J_KG_K = 1500.0  # J/(kg·K)
DEFAULT_ABLATOR_INIT_THICK_M = 0.01  # m (10 mm)
DEFAULT_ABLATOR_SURF_TEMP_LIMIT_K = 1200.0  # K
DEFAULT_ABLATOR_PYROLYSIS_TEMP_K = 900.0  # K
DEFAULT_ABLATOR_BLOWING_EFF_ND = 0.8  # Dimensionless (0-1)
DEFAULT_ABLATOR_CHAR_LAYER_COND_W_M_K = 0.2  # W/(m·K)
DEFAULT_ABLATOR_CHAR_LAYER_THICK_M = 0.001  # m (1 mm)

# Default heat of ablation
# Units: J/kg
DEFAULT_HEAT_ABLATION_J_KG = 2.5e6

# Default throat recession multiplier (conservative)
DEFAULT_THROAT_RECESSION_MULT_ND = 1.3

# ============================================================================
# GRAPHITE INSERT CONSTANTS
# ============================================================================

DEFAULT_GRAPHITE_DENS_KG_M3 = 1800.0  # kg/m³
DEFAULT_GRAPHITE_THERMAL_COND_W_M_K = 100.0  # W/(m·K)
DEFAULT_GRAPHITE_SURF_TEMP_LIMIT_K = 2500.0  # K
DEFAULT_GRAPHITE_OXIDATION_TEMP_K = 800.0  # K
DEFAULT_GRAPHITE_OXIDATION_RATE_M_S = 1e-6  # m/s
DEFAULT_GRAPHITE_CHAR_LAYER_COND_W_M_K = 5.0  # W/(m·K)
DEFAULT_GRAPHITE_CHAR_LAYER_THICK_M = 0.0005  # m (0.5 mm)

# ============================================================================
# FILM COOLING CONSTANTS
# ============================================================================

DEFAULT_FILM_MASS_FRAC_ND = 0.05  # 5% of total flow
DEFAULT_FILM_EFF_REF_ND = 0.4  # 40% effectiveness
DEFAULT_FILM_DECAY_LEN_M = 0.1  # m
DEFAULT_FILM_REF_BLOWING_RATIO_ND = 0.5
DEFAULT_FILM_BLOWING_EXP_ND = 0.6
DEFAULT_FILM_REF_WALL_TEMP_K = 1100.0  # K

# ============================================================================
# SPRAY AND EVAPORATION CONSTANTS
# ============================================================================

# Default Sauter Mean Diameter (SMD)
# Units: m
DEFAULT_SMD_M = 100e-6  # 100 microns

# Default evaporation length
# Units: m
DEFAULT_EVAPORATION_LEN_M = 0.1  # 10 cm

# Default Weber number minimum for breakup
DEFAULT_WEBER_MIN_ND = 15.0

# ============================================================================
# NUMERICAL AND COMPUTATIONAL CONSTANTS
# ============================================================================

# Small epsilon values for numerical stability
EPSILON_SMALL = 1e-6
EPSILON_TINY = 1e-8

# ============================================================================
# DEPRECATED: DO NOT USE THESE DEFAULT/FALLBACK CONSTANTS
# ============================================================================
# 
# These constants were previously used to hide missing values or failed
# calculations. This practice is now FORBIDDEN in the codebase.
# 
# **DO NOT USE THESE** - They are kept only for reference and to prevent
# breaking old code during transition. Any new code using these will be rejected.
# 
# Instead of using defaults/fallbacks:
# 1. Explicitly validate that required values are present
# 2. Raise clear ValueError/KeyError if values are missing
# 3. Fix the root cause (missing config, failed calculation, etc.)
# 
# Examples of INCORRECT usage (DO NOT DO THIS):
#   density = some_dict.get("density", FALLBACK_DENS_KG_M3)  # WRONG!
#   velocity = max(calculated_velocity, MIN_VELOCITY_M_S)  # WRONG!
# 
# Examples of CORRECT usage:
#   if "density" not in some_dict:
#       raise KeyError("Missing 'density' in results")
#   density = some_dict["density"]
#   if density <= 0:
#       raise ValueError(f"Invalid density: {density}")
# ============================================================================

# DEPRECATED - DO NOT USE
MIN_DENS_KG_M3 = 0.01  # kg/m³
MIN_TEMP_K = 1.0  # K
MIN_PRESS_PA = 1e5  # Pa (1 bar)
MIN_VELOCITY_M_S = 0.0  # m/s
MIN_AREA_M2 = 1e-6  # m²

# DEPRECATED - DO NOT USE  
FALLBACK_DENS_KG_M3 = 1.0  # kg/m³
FALLBACK_SOUND_SPEED_M_S = 1000.0  # m/s
FALLBACK_VELOCITY_M_S = 50.0  # m/s
FALLBACK_MACH_NUMBER_ND = 0.01
FALLBACK_RESIDENCE_TIME_S = 0.001  # s (1 ms)
FALLBACK_REYNOLDS_NUMBER_ND = 10000.0

# ============================================================================
# STABILITY AND FEED SYSTEM CONSTANTS
# ============================================================================

# Critical damping ratio for feed system stability
CRITICAL_DAMPING_RATIO_ND = 0.05

# Default feed system dimensions
DEFAULT_FEED_LENGTH_M = 1.0  # m
DEFAULT_FEED_DIAMETER_M = 0.01  # m (1 cm)

# Default chamber time constant (fallback)
# Units: s
DEFAULT_CHAMBER_TIME_CONST_S = 0.01  # 10 ms

# ============================================================================
# COMBUSTION EFFICIENCY CONSTANTS
# ============================================================================

# Default combustion efficiency parameters
# η_c* = 1 - C × exp(-K × L*)
DEFAULT_EFFICIENCY_C_ND = 0.3
DEFAULT_EFFICIENCY_K_ND = 0.15

# Default frozen flow parameter
DEFAULT_FROZEN_FLOW_PARAM_ND = 0.1

# ============================================================================
# TIME SERIES CONSTANTS
# ============================================================================

# Default decay constant for exponential time series
DEFAULT_DECAY_CONST_ND = 3.0

# Default power exponent for power-law time series
DEFAULT_POWER_EXP_ND = 2.0

# ============================================================================
# PRESSURE DROP CONSTANTS
# ============================================================================

# Entrance loss coefficient (sharp entrance)
K_ENTRANCE_SHARP_ND = 0.5

# ============================================================================
# UNIT CONVERSION CONSTANTS
# ============================================================================

# Feet to meters
FEET_TO_METERS = 0.3048

# Rankine to Kelvin conversion
# T_Rankine = T_Kelvin × RANKINE_PER_KELVIN
RANKINE_PER_KELVIN = 1.8

# Viscosity unit conversion: lb·s/in² to Pa·s
# Formula from Huzel uses lb·s/in², need to convert to Pa·s
# 1 lb·s/in² = 6894.76 Pa·s
LB_S_PER_IN2_TO_PA_S = 6894.76

# ============================================================================
# MIXING AND TURBULENCE CONSTANTS
# ============================================================================

# Default mixing efficiency factors
DEFAULT_MIXING_EFFICIENCY_ND = 1.0  # Perfect mixing
DEFAULT_TURBULENCE_EFFICIENCY_ND = 0.9  # 90% efficiency

# Default spray quality factors (when unknown)
DEFAULT_SMD_FACTOR_ND = 0.5  # Assume poor spray quality
DEFAULT_EVAP_FACTOR_ND = 0.5  # Assume moderate evaporation

# ============================================================================
# REACTION PROGRESS CONSTANTS
# ============================================================================

# Default reaction progress values
DEFAULT_PROGRESS_INJECTION_ND = 0.0  # No reaction at injection
DEFAULT_PROGRESS_MID_ND = 0.5  # 50% at mid-chamber
DEFAULT_PROGRESS_THROAT_ND = 1.0  # Complete at throat

# ============================================================================
# AMBIENT CONDITIONS
# ============================================================================

# Standard atmospheric conditions
STANDARD_ATMOSPHERE_PRESS_PA = 101325.0  # Pa (sea level)
STANDARD_AMBIENT_TEMP_K = 300.0  # K (27°C)

