"""Shared physics primitives for the combustion/feed stability model.

Pure functions only — no config coupling, no I/O — so every primitive is unit-testable against a
closed form. Integration (pulling gas properties from CEA, choosing defaults for ``n``/``chi``, etc.)
lives in ``chug.py`` / ``acoustic.py`` / ``analysis.py``, not here.

Equation numbers in the docstrings refer to ``docs/stability/combustion_stability_physics.md`` (v0.2).

Sections
--------
1. Acoustic mode frequencies        — longitudinal half-wave (closed-closed); transverse via J'_m roots
2. Combustion response (n-tau)       — Crocco linearized burning-rate gain                 [Phys §2]
3. Gas dynamics                      — choked-flow function, chamber residence time         [Phys §3.1]
4. Vaporization / time lag           — Spalding B, d^2-law K_v, tau_vap, sensitive lag       [Phys §5]
5. Feed / injector primitives        — injector conductance, feed inertance, chamber gain    [Phys §3.2]
6. Acoustic damping                 — compact choked-nozzle admittance, Kirchhoff wall layer [Phys §4.2]
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
    "chamber_residence_time_from_state",
    "area_ratio_from_mach",
    "mach_from_area_ratio_subsonic",
    "spalding_transfer_number_heat",
    "d2_law_evaporation_constant",
    "vaporization_time",
    "sensitive_time_lag",
    "lags_from_smd",
    "injector_conductance",
    "feed_inertance",
    "chamber_gain",
    "viscous_damping_rate",
    "nozzle_admittance_compact",
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
    """Longitudinal (axial) acoustic mode frequencies [Hz], closed-closed half-wave set.

    ``f_nL = n * a / (2 * L_ch)`` for n = 1..n_modes (1L, 2L, ...).  [Phys §4.1]

    Both ends are acoustically closed. The injector face is a rigid wall. A choked compact nozzle
    has normalised admittance ``(gamma-1)*M_ne/2`` (Crocco; Marble & Candel 1977), ~0.005 at
    M_ne 0.07: a near-rigid end, not a pressure-release one. ``tan(kL) = i*Y`` then gives
    ``Re(kL) = n*pi`` exactly -- the admittance damps the mode (``nozzle_damping_rate``) and
    does not move it. This is the q-branch of Harrje & Reardon SP-194 ch. 1's closed-cylinder
    ``f = (a/2) sqrt((q/L)^2 + (alpha_mn/(pi R))^2)``, and the passive spectrum the hi-fi V3
    case checks (engine/stability_hifi/validation/v3_ntau_duct.py). The old quarter-wave set
    ``(2n-1) a/(4L)`` is the open-end answer and put 1L a factor 2 low.
    """
    if a <= 0 or L_ch <= 0 or n_modes < 1:
        return []
    return [float(n * a / (2.0 * L_ch)) for n in range(1, n_modes + 1)]


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
    REAL part ``n*(1 - cos(omega*tau))`` is the component of q' in phase with p' -- the Rayleigh
    driving (cycle average <p'q'>/<p'^2>); it is >= 0 and peaks at omega*tau = pi (Crocco's
    stability bucket, Harrje & Reardon SP-194 ch. 4). The imaginary part ``n*sin(omega*tau)``
    is in quadrature with p' and shifts the frequency, not the growth rate.

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
    It uses ``R*T = (Gamma*c*)**2``, which holds for the ideal c* only; when the chamber state
    (R, T) is known use ``chamber_residence_time_from_state``.
    """
    G = choked_flow_function(gamma)
    if not np.isfinite(G) or G <= 0 or cstar <= 0 or Lstar <= 0:
        return float("nan")
    return float(Lstar / (G * G * cstar))


def chamber_residence_time_from_state(Lstar: float, cstar: float, R_g: float, T: float) -> float:
    """``theta_c = m_gas / mdot = (Pc V / (R T)) / (Pc A_t / c*) = L* c* / (R T)`` [s].  [Phys §3.1]

    The mass balance itself, with the throat flow set by the c* the engine actually delivers and
    the gas mass by the chamber state the rest of the stability model uses (rho_g = Pc/(R T)).
    Equal to ``chamber_residence_time`` when c* is ideal; with c*_actual it is shorter by
    eta_c*^2 (~9 % on the 6500 N), which the Gamma form hides by assuming RT = (Gamma c*_act)^2.
    """
    if Lstar <= 0 or cstar <= 0 or R_g <= 0 or T <= 0:
        return float("nan")
    return float(Lstar * cstar / (R_g * T))


def area_ratio_from_mach(M: float, gamma: float) -> float:
    """Isentropic area ratio ``A/A* = (1/M) * [(2/(g+1)) * (1 + (g-1)/2 * M^2)]^((g+1)/(2(g-1)))``."""
    g = float(gamma)
    if M <= 0 or g <= 1.0:
        return float("nan")
    return float((1.0 / M) * ((2.0 / (g + 1.0)) * (1.0 + 0.5 * (g - 1.0) * M * M)) ** ((g + 1.0) / (2.0 * (g - 1.0))))


def mach_from_area_ratio_subsonic(area_ratio: float, gamma: float) -> float:
    """Subsonic Mach number at a station with ``A/A* = area_ratio`` (isentropic, one-dimensional).

    This is the mean Mach at the nozzle entrance when ``area_ratio`` is the contraction ratio
    ``A_chamber / A_throat``, which is what sets the convective (nozzle) acoustic damping. Bisection
    on [1e-6, 1]: A/A* is monotone decreasing in M on the subsonic branch. ``area_ratio <= 1`` -> 1.0.
    """
    if not np.isfinite(area_ratio) or gamma <= 1.0:
        return float("nan")
    if area_ratio <= 1.0:
        return 1.0
    lo, hi = 1e-6, 1.0
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        if area_ratio_from_mach(mid, gamma) > area_ratio:
            lo = mid          # too subsonic: area ratio still above target -> raise M
        else:
            hi = mid
    return float(0.5 * (lo + hi))


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
# 6. Acoustic damping
# ---------------------------------------------------------------------------
# Nozzle and wall losses have closed forms and are computed here. The injector-face and two-phase
# terms have none and live in acoustic.DampingCoeffs as stated, uncalibrated fractions; they
# dominate the budget, which is why the acoustic verdict is report-only by default (acoustic.py).

def viscous_damping_rate(freq: float, D_ch: float, nu_g: float,
                         gamma: float | None = None, prandtl: float | None = None) -> float:
    """Kirchhoff acoustic boundary-layer damping on the side wall [1/s].  [Phys §4.2]

    ``alpha = (omega * delta_nu / D) * [1 + (gamma-1)/sqrt(Pr)]`` with the Stokes thickness
    ``delta_nu = sqrt(2 nu / omega)``: ``c`` times Kirchhoff's tube-wall attenuation
    ``beta = sqrt(omega nu / 2) [1 + (gamma-1)/sqrt(Pr)] / (r c)`` (Kinsler & Frey, Fundamentals
    of Acoustics, wall losses in pipes). Without ``gamma`` and ``Pr`` only the viscous half is
    counted -- a lower bound. Exact for a longitudinal wave along the barrel; for transverse modes
    it is an O(1) estimate (their wall velocity is partly normal to the wall). The previous form
    carried an unsourced factor 4 (3.4x this).
    """
    if freq <= 0 or D_ch <= 0 or nu_g <= 0:
        return 0.0
    omega = 2.0 * np.pi * freq
    delta = np.sqrt(2.0 * nu_g / omega)           # Stokes layer thickness [m]
    thermal = 0.0
    if gamma is not None and prandtl is not None and gamma > 1.0 and prandtl > 0.0:
        thermal = (gamma - 1.0) / np.sqrt(prandtl)
    return float(omega * delta / D_ch * (1.0 + thermal))


def nozzle_admittance_compact(mach_nozzle_entrance: float, gamma: float) -> float:
    """Normalised acoustic admittance ``Y = rho a u'/p' = (gamma-1) M_ne / 2`` of a choked compact nozzle.

    From mdot ~ p/sqrt(T) at the throat with isentropic perturbations (Crocco; Marble & Candel,
    J. Sound Vib. 55, 1977). Real and positive: the nozzle absorbs acoustic energy.
    """
    if mach_nozzle_entrance <= 0 or gamma <= 1.0:
        return 0.0
    return float(0.5 * (gamma - 1.0) * mach_nozzle_entrance)


def nozzle_damping_rate(a: float, L_ch: float, mach_nozzle_entrance: float, gamma: float,
                        *, end_weight: float = 1.0) -> float:
    """Nozzle (convective) damping rate [1/s] through a compact choked nozzle.  [Phys §4.2]

    Energy flux out of the nozzle plane over twice the modal energy: ``alpha = end_weight *
    a * Y / L`` with ``Y = nozzle_admittance_compact``. ``end_weight`` is the nozzle-plane share of
    <p'^2> relative to the volume mean: 1 for a longitudinal mode (antinode at the end), 1/2 for a
    transverse mode (uniform in x). The longitudinal case is the passive root of ``tanh(sL) = -Y``
    (hi-fi V3: sigma ~ -Y c / L). For transverse modes the compact admittance is a lower bound
    (Bell & Zinn give larger real parts), so this errs toward less damping.

    The previous form, ``pi f (gamma-1) M``, was pi times this for the half-wave 1L and grew with
    mode number, which the end loss does not.
    """
    if a <= 0 or L_ch <= 0:
        return 0.0
    Y = nozzle_admittance_compact(mach_nozzle_entrance, gamma)
    return float(end_weight * a * Y / L_ch)
