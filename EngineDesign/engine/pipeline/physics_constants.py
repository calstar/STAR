"""Centralized physics constants for combustion and nozzle calculations.

This module consolidates scattered hardcoded constants to enable:
1. Easy validation against literature
2. Config-driven parameter sweeps
3. Consistent values across modules

Constants are organized by category and include physical units and sources.
"""

# =============================================================================
# Injection and Propellant Properties
# =============================================================================

# Typical propellant injection temperature [K]
# Used as initial guess for temperature profile calculations
T_INJECTION_GUESS = 400.0  # K, typical propellant temperature at injection

# =============================================================================
# Temperature Profile Parameters
# =============================================================================

# Temperature profile exponent for reaction progress
# alpha < 1 means faster initial heating (empirical)
TEMPERATURE_PROFILE_ALPHA = 0.7  # dimensionless

# =============================================================================
# Evaporation Model Parameters (D²-law)
# =============================================================================

# Default Spalding mass transfer number
# B = cp_gas * (T∞ - T_s) / L_vap for thermodynamic calculation
# This default is conservative for low-temperature conditions
# Typical rocket conditions: B = 2-10
SPALDING_NUMBER_DEFAULT = 0.2  # dimensionless, conservative default

# LOX penalty constant for effective evaporation constant
# K_eff = K / (1 + phi)
LOX_PENALTY_CONSTANT = 3.0  # dimensionless

# Reference diffusivity at 300 K, 1 atm [m²/s]
DIFFUSIVITY_REFERENCE = 2e-5  # m²/s

# Dynamic viscosity for hot gas [Pa·s]
HOT_GAS_VISCOSITY = 7e-5  # Pa·s, representative hot-gas value

# =============================================================================
# Reaction Kinetics Parameters (Arrhenius)
# =============================================================================

# Pre-exponential factor for hydrocarbon combustion [1/s]
# Based on hydrocarbon/LOX global kinetics
# Reference: Westbrook & Dryer, Prog. Energy Combust. Sci., 1984
ARRHENIUS_A0_HYDROCARBON = 1.0e7  # 1/s

# Activation energy for hydrocarbon combustion [J/mol]
# Typical range: 60-100 kJ/mol for hydrocarbon oxidation
ACTIVATION_ENERGY_HYDROCARBON = 80000.0  # J/mol

# Reference reaction time [s]
# τ_ref for pressure/temperature scaling
# 5e-5 s = 50 μs typical for high-pressure rocket conditions
REACTION_TIME_REFERENCE = 5e-5  # s

# Reference conditions for reaction time scaling
REFERENCE_PRESSURE = 4.0e6  # Pa (4 MPa)
REFERENCE_TEMPERATURE = 3500.0  # K

# =============================================================================
# Mixing and Turbulence Parameters
# =============================================================================

# Recirculation/mixing strength factor
# Used in mixing time calculation: τ_mix = L²/(β × D)
MIXING_BETA = 8.0  # dimensionless

# Default turbulence intensity
TURBULENCE_INTENSITY_DEFAULT = 0.08  # 8%

# Target SMD for good atomization [m]
TARGET_SMD_DEFAULT = 50e-6  # 50 microns

# =============================================================================
# Gas Properties
# =============================================================================

# Universal gas constant [J/(mol·K)]
R_UNIVERSAL = 8.314462618  # J/(mol·K)

# Universal gas constant [J/(kmol·K)] for per-kmol calculations
R_UNIVERSAL_KMOL = 8314.462618  # J/(kmol·K)

# Approximate gas specific heat for hot combustion products [J/(kg·K)]
CP_GAS_APPROX = 1200.0  # J/(kg·K)

# =============================================================================
# Nozzle Flow Parameters
# =============================================================================

# Maximum exit Mach number (numerical stability limit, not physics limit)
# Real rocket nozzles typically have M_exit = 2-5
# Very high expansion ratio nozzles can exceed M=5
MACH_EXIT_MAX_NUMERICAL = 20.0  # dimensionless

# Newton-Raphson solver parameters
MACH_SOLVER_TOLERANCE = 1e-10
MACH_SOLVER_MAX_ITERATIONS = 50

# =============================================================================
# Finite-Rate Gasification Model Parameters
# =============================================================================

# Default Prandtl number for hot combustion gas
# Used to compute k_g = μ * cp / Pr
PRANDTL_DEFAULT = 0.8  # dimensionless, typical for hot gas at ~3000K

# Molecular diffusivity reference conditions
# D_m = D_M_REF * (T / D_M_T_REF)^1.75 * (D_M_P_REF / P)
D_M_REF = 5e-5        # m²/s at reference T, P
D_M_T_REF = 1500.0    # K, reference temperature
D_M_P_REF = 2.5e6     # Pa, reference pressure (2.5 MPa)

# Droplet slip velocity cap
# Prevents near-field turbulence from smuggling into evaporation efficiency
U_SLIP_CAP = 50.0  # m/s

# Minimum droplet diameter floor (numerical stability)
D_MIN_GASIFICATION = 1e-6  # m (1 μm)

