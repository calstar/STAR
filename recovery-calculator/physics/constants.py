"""Defined constants and unit conversions. One source of truth.

Stdlib only -- no imports at all, in fact. See `physics/__init__.py` for
why that matters.

Every ISA value here is a *defining* constant of the U.S. Standard Atmosphere
1976 / ICAO standard atmosphere, not a measurement, so they are exact by
convention rather than uncertain. Verified against published sources rather
than recalled:

  - p0, T0, rho0, and the layer table: the COESA 1976 definition
  - Rd = 287.053, the value PLAN.md §1.3 specifies. Two derivations of it
    disagree in the seventh digit: R_universal / M_air = 8.31432 / 0.0289644
    gives 287.0531, while the published hydrostatic constant 34.1631947 K/km
    (which is g0/Rd in K/km) gives 287.0528. The spread is 7e-7 relative --
    four orders of magnitude below the humidity term §5 already neglects, and
    it moves the layer-0 exponent only from 5.255877 to 5.255881. PLAN.md's
    value is used so the document stays the source of truth.
  - RE: the COESA effective Earth radius at 45 deg N, used *only* for the
    geometric-to-geopotential conversion in eq (1). It is not the WGS-84
    semi-major axis (6 378 137 m) and substituting that is wrong here.

PLAN.md §5 re-fits the lowest layer through a measured pad temperature, so for
any flight below 11 km geopotential the LAYERS table below is not consulted at
all -- see atmosphere.py. It is retained so the model degrades honestly rather
than extrapolating a re-fit lapse rate into the stratosphere.
"""

# --- ISA defining constants (PLAN.md §5) -----------------------------------

G0 = 9.80665  # m/s^2   standard gravity, exact by definition
RD = 287.053  # J/(kg K)  specific gas constant, dry air
RE = 6356766.0  # m      COESA effective Earth radius, geopotential conversion
T0 = 288.15  # K         sea-level temperature
P0 = 101325.0  # Pa      sea-level pressure
RHO0 = 1.225  # kg/m^3   sea-level density; a *consequence* of the three above,
#                        and asserted as such in tests rather than used.

L0_ISA = -0.0065  # K/m  standard tropospheric lapse rate

T_TROP = 216.65  # K     temperature at the 11 km layer boundary.
H_TROP = 11000.0  # m    geopotential altitude of that boundary.
#
# T_TROP is not an independent constant: 288.15 - 6.5 * 11 = 216.65 exactly.
# PLAN.md §5 uses it as the far anchor of the eq (7) re-fit, and deliberately
# leaves it at the standard value -- perturbing it by 10 K moves density at
# 3 km by 0.8%, and holding it fixed preserves a free regression test, since
# feeding T_pad = 288.15 K must return L0 = -6.5 K/km exactly.

# Layer base geopotential altitude (m), base temperature (K), lapse rate (K/m).
# Base pressures are *not* tabulated: they are integrated from P0 upward at
# import-time-free cost inside Atmosphere, so the table cannot disagree with
# the equations that consume it.
LAYERS = (
    (0.0, 288.15, -0.0065),
    (11000.0, 216.65, 0.0),
    (20000.0, 216.65, 0.001),
    (32000.0, 228.65, 0.0028),
    (47000.0, 270.65, 0.0),
    (51000.0, 270.65, -0.0028),
    (71000.0, 214.65, -0.002),
)
H_TOP = 84852.0  # m geopotential; 86 km geometric, the top of the 1976 model.

# --- unit conversions -------------------------------------------------------
#
# PLAN.md §1.1: SI internally, always. Convert at the I/O boundary only.
# Vendor data arrives in inches, feet, pounds and fps.

IN_TO_M = 0.0254
FT_TO_M = 0.3048
SQFT_TO_SQM = 0.09290304
LBF_TO_N = 4.4482216152605
LB_TO_KG = 0.45359237
G_TO_KG = 1e-3
INHG_TO_PA = 3386.389

M_TO_FT = 1.0 / FT_TO_M
N_TO_LBF = 1.0 / LBF_TO_N
