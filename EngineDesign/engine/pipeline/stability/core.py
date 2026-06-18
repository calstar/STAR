"""Shared physics primitives for the combustion/feed stability model.

Pure functions only — no config coupling, no I/O — so every primitive is unit-testable against a
closed form. Integration (pulling gas properties from CEA, choosing defaults for ``n``/``chi``, etc.)
lives in ``chug.py`` / ``acoustic.py`` / ``analysis.py``, not here.

Equation numbers in the docstrings refer to ``docs/stability/combustion_stability_physics.md`` (v0.2).

Sections
--------
1. Acoustic mode frequencies        — longitudinal quarter-wave; transverse via J'_m (hard-wall) roots
2. Combustion response (n-tau)       — Crocco linearized burning-rate gain                 [Phys §2]
3. Gas dynamics                      — choked-flow function, chamber residence time         [Phys §3.1]
4. Vaporization / time lag           — Spalding B, d^2-law K_v, tau_vap, sensitive lag       [Phys §5]
5. Feed / injector primitives        — injector conductance, feed inertance, chamber gain    [Phys §3.2]
6. Acoustic damping (first-cut)      — nozzle / viscous / radiation damping rates            [Phys §4.2]
"""

from __future__ import annotations

from typing import Dict, List, Tuple
import numpy as np

__all__ = [
    "sound_speed",
    "longitudinal_mode_frequencies",
    "TRANSVERSE_EIGENVALUES",
    "transverse_mode_frequencies",
    "n_tau_gain",
    "choked_flow_function",
    "chamber_residence_time",
    "spalding_transfer_number_heat",
    "d2_law_evaporation_constant",
    "vaporization_time",
    "sensitive_time_lag",
    "lags_from_smd",
    "injector_conductance",
    "feed_inertance",
    "chamber_gain",
    "viscous_damping_rate",
    "nozzle_damping_rate",
]


# ---------------------------------------------------------------------------
# 1. Acoustic mode frequencies
# ---------------------------------------------------------------------------

def sound_speed(gamma: float, R_g: float, T: float) -> float:
    """Chamber sound speed ``a = sqrt(gamma * R_g * T)`` [m/s]. Returns 0 for non-physical inputs."""
    val = gamma * R_g * T
    return float(np.sqrt(val)) if val > 0 else 0.0


def longitudinal_mode_frequencies(a: float, L_ch: float, n_modes: int = 5) -> List[float]:
    """Longitudinal (axial) acoustic mode frequencies [Hz], open-closed quarter-wave set.

    ``f_nL = (2n - 1) * a / (4 * L_ch)`` for n = 1..n_modes (1L, 2L, ...).  [Phys §4.1]

    The injector face is ~closed and a choked throat is ~closed (finite admittance); the quarter-wave
    set is the standard first estimate. The true eigenvalue lies between this and the half-wave set and
    depends on nozzle admittance — handled (later) in the rich acoustic model, not here.
    """
    if a <= 0 or L_ch <= 0 or n_modes < 1:
        return []
    return [float((2 * n - 1) * a / (4.0 * L_ch)) for n in range(1, n_modes + 1)]


# Transverse acoustic eigenvalues for a hard-wall cylinder: roots of J'_m (dp/dr = 0 at the wall).
# f_mode = alpha * a / (pi * D_ch).   [Phys §4.1 — the fix vs the current code, which wrongly used the
# pressure-Bessel roots of J_m (2.405, ...) instead of the velocity roots of J'_m.]
# Labels: T = tangential (m>=1), R = radial (m=0). Values are standard zeros of J'_m.
TRANSVERSE_EIGENVALUES: Dict[str, float] = {
    "1T": 1.84118,   # J'_1 first zero  — first tangential (most destructive in liquid engines)
    "2T": 3.05424,   # J'_2 first zero  — second tangential
    "1R": 3.83171,   # J'_0 first nonzero zero — first radial
    "3T": 4.20119,   # J'_3 first zero
    "1T1R": 5.33144,  # J'_1 second zero — combined tangential/radial
}


def transverse_mode_frequencies(a: float, D_ch: float) -> Dict[str, float]:
    """Transverse acoustic mode frequencies [Hz] for a hard-wall cylinder.

    ``f = alpha_mn * a / (pi * D_ch)`` with ``alpha_mn`` the zeros of ``J'_m`` (TRANSVERSE_EIGENVALUES).
    Returns a dict keyed by mode name (``1T``, ``2T``, ``1R``, ...).  [Phys §4.1]
    """
    if a <= 0 or D_ch <= 0:
        return {k: 0.0 for k in TRANSVERSE_EIGENVALUES}
    return {name: float(alpha * a / (np.pi * D_ch)) for name, alpha in TRANSVERSE_EIGENVALUES.items()}


# ---------------------------------------------------------------------------
# 2. Combustion response (Crocco n-tau)
# ---------------------------------------------------------------------------

def n_tau_gain(omega: float, n: float, tau: float) -> complex:
    """Linearized burning-rate response gain ``n * (1 - exp(-i*omega*tau))``.  [Phys §2, eq 2.1]

    This is ``(dm_b'/m_b) / (p'/Pc)`` for a single sinusoid at angular frequency ``omega``. The
    ``sin(omega*tau)`` (imaginary) part is the Rayleigh-driving phase that feeds the acoustic growth
    rate (§4); the magnitude scales with the interaction index ``n``.

    Note: ``tau`` here is the **sensitive** lag tau_sens (= chi * tau_vap) for acoustic driving — NOT
    the chug transport lag tau_conv. See the two-lags box in [Phys §5].
    """
    return complex(n) * (1.0 - np.exp(-1j * float(omega) * float(tau)))


# ---------------------------------------------------------------------------
# 3. Gas dynamics
# ---------------------------------------------------------------------------

def choked_flow_function(gamma: float) -> float:
    """Vandenkerckhove choked-flow function ``Gamma = sqrt(gamma) * (2/(gamma+1))**((gamma+1)/(2(gamma-1)))``.

    Relates throat mass flow and c*: ``mdot = Pc * A_t * Gamma / sqrt(R_g*T_c) = Pc*A_t/c*`` so that
    ``R_g*T_c = (Gamma*c*)**2``. ``Gamma**2 ~ 0.4`` for ``gamma ~ 1.2``.  [Phys §3.1]
    """
    g = float(gamma)
    if g <= 1.0:
        return float("nan")
    return float(np.sqrt(g) * (2.0 / (g + 1.0)) ** ((g + 1.0) / (2.0 * (g - 1.0))))


def chamber_residence_time(Lstar: float, cstar: float, gamma: float) -> float:
    """Chamber gas-dynamic time constant ``theta_c = L* / (Gamma**2 * c*)`` [s].  [Phys §3.1, eq 3.1]

    This is the gas residence (stay) time m_gas/mdot_out, the first-order chamber relaxation constant
    used in the chug loop. NOTE the prefactor is ``1/Gamma**2`` (~2.4 at gamma~1.2), *not* ``1/gamma``.
    """
    G = choked_flow_function(gamma)
    if not np.isfinite(G) or G <= 0 or cstar <= 0 or Lstar <= 0:
        return float("nan")
    return float(Lstar / (G * G * cstar))


# ---------------------------------------------------------------------------
# 4. Vaporization / time lag
# ---------------------------------------------------------------------------

def spalding_transfer_number_heat(cp_g: float, T_inf: float, T_boil: float, h_fg: float) -> float:
    """Spalding heat-transfer number ``B_T = cp_g * (T_inf - T_boil) / h_fg`` (evaporating droplet).

    ``cp_g`` gas-phase specific heat in the film [J/(kg·K)], ``T_inf`` ambient gas temp [K], ``T_boil``
    droplet surface (boiling) temp [K], ``h_fg`` latent heat [J/kg].  [Phys §5.1]
    """
    if h_fg <= 0:
        return float("nan")
    return float(cp_g * (T_inf - T_boil) / h_fg)


def d2_law_evaporation_constant(k_g: float, rho_l: float, cp_g: float, B: float) -> float:
    """d^2-law evaporation constant ``K_v = 8*k_g/(rho_l*cp_g) * ln(1+B)`` [m^2/s].  [Phys §5.1, eq 5.1]

    ``k_g`` gas-phase thermal conductivity in the film [W/(m·K)], ``rho_l`` liquid density [kg/m^3],
    ``cp_g`` gas-phase specific heat [J/(kg·K)], ``B`` Spalding transfer number. Godsave/Spalding.
    """
    if rho_l <= 0 or cp_g <= 0 or B <= -1.0:
        return float("nan")
    return float(8.0 * k_g / (rho_l * cp_g) * np.log(1.0 + B))


def vaporization_time(D32: float, K_v: float) -> float:
    """Droplet vaporization lifetime ``tau_vap = D32**2 / K_v`` [s].  [Phys §5.1, eq 5.2/5.3]

    ``D32`` is the spray Sauter mean diameter [m] (the code's Ingebo SMD). This equals the chug
    transport lag ``tau_conv`` to leading order. **tau_vap ∝ SMD^2** — atomization is a quadratic lever.
    """
    if D32 <= 0 or not np.isfinite(K_v) or K_v <= 0:
        return float("nan")
    return float(D32 * D32 / K_v)


def sensitive_time_lag(tau_vap: float, chi: float = 0.5) -> float:
    """Sensitive (pressure-responsive) lag ``tau_sens = chi * tau_vap`` [s].  [Phys §5, eq 5.4]

    ``chi in (0, 1]`` is the sensitive fraction (default 0.5; the single largest modeling uncertainty,
    swept in the rich tier). Used for the acoustic n-tau driving — NOT the chug transport lag.
    """
    if not np.isfinite(tau_vap) or tau_vap < 0:
        return float("nan")
    chi = float(np.clip(chi, 1e-6, 1.0))
    return float(chi * tau_vap)


def lags_from_smd(
    D32: float,
    *,
    k_g: float,
    rho_l: float,
    cp_g: float,
    T_inf: float,
    T_boil: float,
    h_fg: float,
    chi: float = 0.5,
) -> Tuple[float, float, float]:
    """Convenience: SMD -> (tau_conv, tau_sens, K_v). Composes B_T, K_v, tau_vap, tau_sens.  [Phys §5]

    Returns
    -------
    (tau_conv, tau_sens, K_v) where tau_conv = tau_vap (chug transport lag) and tau_sens = chi*tau_vap
    (acoustic sensitive lag). All NaN-safe.
    """
    B = spalding_transfer_number_heat(cp_g, T_inf, T_boil, h_fg)
    K_v = d2_law_evaporation_constant(k_g, rho_l, cp_g, B)
    tau_vap = vaporization_time(D32, K_v)
    tau_sens = sensitive_time_lag(tau_vap, chi)
    return tau_vap, tau_sens, K_v


# ---------------------------------------------------------------------------
# 5. Feed / injector primitives (support chug.py)
# ---------------------------------------------------------------------------

def injector_conductance(mdot: float, eta_inj: float, Pc: float) -> float:
    """Injector flow conductance ``G_inj = mdot / (2 * eta_inj * Pc)`` [kg/(s·Pa)].  [Phys §3.2, eq 3.2]

    ``eta_inj = dP_inj/Pc`` is the injector stiffness ratio. ``G_inj = |dm/dP_c|`` from Bernoulli; a
    stiffer injector (larger eta_inj) gives smaller G_inj => weaker chug coupling.
    """
    if eta_inj <= 0 or Pc <= 0:
        return float("nan")
    return float(mdot / (2.0 * eta_inj * Pc))


def feed_inertance(length: float, area: float) -> float:
    """Feed-line inertance ``I = length / area`` [1/m] (mass-flow convention).  [Phys §3.2]

    Impedance contribution is ``Z_I = I * s`` [Pa·s/kg]. Note: ``length/area``, NOT ``rho*length/area``
    — the density cancels under the mass-flow through-variable convention (see nomenclature note).
    """
    if area <= 0 or length < 0:
        return float("nan")
    return float(length / area)


def chamber_gain(cstar: float, A_t: float) -> float:
    """Chamber gain ``K_c = c* / A_t`` [Pa·s/kg] (burned-flow -> chamber pressure).  [Phys §3.2]

    Steady-state sensitivity dp_c/dmdot_in; the dynamic chamber transfer function is
    ``Y_ch(s) = K_c / (theta_c * s + 1)``.
    """
    if A_t <= 0:
        return float("nan")
    return float(cstar / A_t)


# ---------------------------------------------------------------------------
# 6. Acoustic damping (first-cut; flagged uncertain — see [Phys §4.2])
# ---------------------------------------------------------------------------
# These are documented first-cut approximations. The quantitative coefficients (especially two-phase
# and injector-face admittance) are the weakest part of a-priori acoustic prediction; the rich acoustic
# model (A3) reports them as an explicit budget with sensitivity bands, not false precision.

def viscous_damping_rate(freq: float, D_ch: float, nu_g: float) -> float:
    """First-cut acoustic boundary-layer (viscous/thermal) damping rate [1/s].  [Phys §4.2 — APPROX]

    Uses the Stokes acoustic boundary-layer thickness ``delta = sqrt(nu_g / (pi*f))`` and a
    surface/volume scaling ``alpha ~ (a_BL) * (4/D) * sqrt(...)``. Returns a *positive* damping rate
    (subtracted from the driving term). This is order-of-magnitude only; calibrate against the cold
    ring-down test (T7) before trusting magnitudes.
    """
    if freq <= 0 or D_ch <= 0 or nu_g <= 0:
        return 0.0
    delta = np.sqrt(nu_g / (np.pi * freq))   # Stokes layer thickness [m]
    # surface-to-volume ~ 4/D for a cylinder; damping ~ (omega) * (delta/D) is a standard scaling
    return float(2.0 * np.pi * freq * (delta / D_ch) * (4.0))


def nozzle_damping_rate(freq: float, L_ch: float, mach_nozzle_entrance: float, gamma: float) -> float:
    """First-cut nozzle (convective) damping rate for a longitudinal mode [1/s].  [Phys §4.2 — APPROX]

    Short-nozzle quasi-steady estimate: acoustic energy convected/radiated through the throat scales
    with the mean Mach number at the nozzle entrance. ``alpha_noz ~ (a/2L) * (gamma-1) * M_ne`` form,
    rendered here via the modal frequency. Positive (damping). Placeholder for the Bell–Zinn nozzle
    admittance used in the rich model.
    """
    if freq <= 0 or L_ch <= 0 or mach_nozzle_entrance <= 0:
        return 0.0
    return float(np.pi * freq * (gamma - 1.0) * mach_nozzle_entrance)
