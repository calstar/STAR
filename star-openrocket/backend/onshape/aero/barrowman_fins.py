"""Barrowman normal-force and centre-of-pressure for a fin set.

A faithful port of OpenRocket's ``FinSetCalc`` (release-24.12), at AoA 0 and now
**across Mach** (subsonic → transonic → supersonic). As in OpenRocket, only the fin
*planform* matters -- thickness, cross-section, edge chamfers and root fillets feed
drag and mass, never CP -- so the input is the fin outline sampled into spanwise
strips.

Geometry (``fin_set_properties``) reproduces OpenRocket's 48-strip integration for
the mean aerodynamic chord (MAC length, MAC leading-edge position) and the cosine
of the mid-chord sweep angle. Aerodynamics:

  * single-fin CNa (``single_fin_cna1``), three Mach regimes:
      - subsonic (M ≤ 0.9): cna1 = 2π·s² / (1 + sqrt(1 + (1-M²)·(s²/(A_fin·cosγ))²)) / A_ref
      - supersonic (M ≥ 1.5): cna1 = A_fin·(K1 + K2·α + K3·α²) / A_ref, Busemann K's
      - transonic: PolyInterpolator quartic between the two.
  * the whole set, summed over its fins the way OpenRocket merges fin instances,
    which for N ≥ 3 fins gives Σ sin²(θ-θ_i) = N/2:
        CNa = (N/2)·cna1·(1+τ)·k_interference ,  τ = r/(s+r)
    with the fin-count interference factor k (1 for N≤4, then 0.948, 0.913,
    0.854, 0.81, 0.75 for 5..9+).
  * cp migrates with Mach (``fin_cp_fraction``): quarter-MAC (M ≤ 0.5), a degree-5
    poly transonically, and (ar·β−0.67)/(2·ar·β−1) → mid-MAC (M ≥ 2).
    x_cp = macLead + fin_cp_fraction(ar, M)·macLength.

Validated against OpenRocket's own FinSetCalcTest values (Estes Alpha III:
3 fins CNa 24.146933, 4 fins CNa 32.195911, cp.x 0.0193484) -- these are low-Mach,
so the subsonic branch must reproduce them unchanged.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

#: OpenRocket's spanwise strip count for MAC integration.
DIVISIONS = 48

# -- Mach regime boundaries (OpenRocket 24.12 FinSetCalc) --------------------
# CNa and CP switch regimes at *different* Machs; do not conflate them.
#: Fin CNa: subsonic formula valid up to this Mach.
CNA_SUBSONIC = 0.9
#: Fin CNa: supersonic (Busemann) formula from this Mach; transonic blend between.
CNA_SUPERSONIC = 1.5
#: (CNA_SUPERSONIC² − 1)^1.5, used in the supersonic CNa endpoint derivative.
CNA_SUPERSONIC_B = (CNA_SUPERSONIC**2 - 1) ** 1.5
#: Fin CP: quarter-chord up to this Mach.
CP_SUBSONIC = 0.5
#: Fin CP: supersonic empirical formula from this Mach; transonic poly between.
CP_SUPERSONIC = 2.0
#: Ratio of specific heats for air.
GAMMA = 1.4
#: Fin stall angle (rad); AoA is clamped to this in the supersonic CNa terms.
STALL_ANGLE = 20 * math.pi / 180


@dataclass(frozen=True)
class FinSetProperties:
    mac_length: float  # mean aerodynamic chord length
    mac_lead: float  # MAC leading-edge axial position (same frame as inputs)
    cos_gamma: float  # cosine of the mid-chord sweep angle
    fin_area: float  # single-fin planform area
    span: float
    aspect_ratio: float


@dataclass(frozen=True)
class FinSetAero:
    cna: float
    cp: float  # axial cp position (same frame as the strip x inputs)
    a_ref: float

    @property
    def weight(self) -> float:
        return self.cna


def fin_set_properties(
    chord_lead: np.ndarray, chord_trail: np.ndarray, span: float
) -> FinSetProperties:
    """MAC and mid-chord sweep from spanwise strips, per OpenRocket.

    ``chord_lead[i]`` / ``chord_trail[i]`` are the fin's leading/trailing edge
    axial positions at spanwise station ``y_i = i·span/(DIVISIONS-1)`` (root at
    i=0). They must be length DIVISIONS and in the same axial frame you want the
    cp reported in.
    """
    lead = np.asarray(chord_lead, dtype=np.float64)
    trail = np.asarray(chord_trail, dtype=np.float64)
    n = DIVISIONS
    dy = span / (n - 1)

    mac_length = mac_lead = mac_span = cos_gamma = 0.0
    norm_area = 0.0  # rectangular sum, matches OpenRocket's MAC normalisation
    prev_mid = None
    for i in range(n):
        length = trail[i] - lead[i]
        y = i * dy
        mac_length += length * length
        mac_span += y * length
        mac_lead += lead[i] * length
        norm_area += length
        mid = (trail[i] + lead[i]) / 2
        if prev_mid is not None:
            dx = mid - prev_mid
            hyp = math.hypot(dx, dy)
            if hyp != 0:
                cos_gamma += dy / hyp
        prev_mid = mid

    mac_length *= dy
    mac_lead *= dy
    norm_area *= dy
    if norm_area > 1e-12:
        mac_length /= norm_area
        mac_lead /= norm_area
    else:
        mac_length = mac_lead = 0.0
    cos_gamma /= n - 1

    # True planform area (trapezoidal) for CNa/aspect ratio -- OpenRocket uses the
    # exact getPlanformArea() here, not the rectangular sum, which would be a
    # factor n/(n-1) too large and inflate CNa by ~2%.
    chord = trail - lead
    fin_area = float(np.trapezoid(chord, dx=dy)) if hasattr(np, "trapezoid") else float(np.trapz(chord, dx=dy))
    ar = 2 * span * span / fin_area if fin_area > 1e-12 else 0.0
    return FinSetProperties(
        mac_length=mac_length,
        mac_lead=mac_lead,
        cos_gamma=cos_gamma,
        fin_area=fin_area,
        span=span,
        aspect_ratio=ar,
    )


def _busemann_k(mach: float) -> tuple[float, float, float]:
    """Supersonic Busemann coefficients K1, K2, K3 (OpenRocket FinSetCalc static block).

    ``beta = √(M²−1)``; K1 is the AoA-0 slope, K2/K3 the 2nd/3rd-order AoA terms.
    """
    beta = math.sqrt(max(mach * mach - 1.0, 1e-12))
    k1 = 2.0 / beta
    k2 = ((GAMMA + 1) * mach**4 - 4 * beta**2) / (4 * beta**4)
    k3 = (
        (GAMMA + 1) * mach**8
        + (2 * GAMMA**2 - 7 * GAMMA - 5) * mach**6
        + 10 * (GAMMA + 1) * mach**4
        + 8
    ) / (6 * beta**7)
    return k1, k2, k3


def _supersonic_cna1(fin_area: float, a_ref: float, mach: float, alpha: float) -> float:
    """Supersonic single-fin CNa (OpenRocket calculateFinCNa1, M ≥ CNA_SUPERSONIC)."""
    k1, k2, k3 = _busemann_k(mach)
    return fin_area * (k1 + k2 * alpha + k3 * alpha * alpha) / a_ref


def _subsonic_cna1(fin_area: float, span: float, cos_gamma: float, a_ref: float, mach: float) -> float:
    """Subsonic single-fin CNa (OpenRocket calculateFinCNa1, M ≤ CNA_SUBSONIC)."""
    s2 = span * span
    inner = 1 + (1 - mach * mach) * (s2 / (fin_area * cos_gamma)) ** 2
    return 2 * math.pi * s2 / (1 + math.sqrt(inner)) / a_ref


def _poly_interp(mach: float, x0: float, x1: float, v0: float, v1: float, d0: float, d1: float, dd0: float) -> float:
    """Quartic through 5 constraints, mirroring OpenRocket's PolyInterpolator for the
    transonic CNa blend: value & 1st-deriv at both ends, plus 2nd-deriv at the low end.

    Solves for p(M) = c0 + c1·M + c2·M² + c3·M³ + c4·M⁴ and evaluates at ``mach``.
    """
    a = np.array(
        [
            [1, x0, x0**2, x0**3, x0**4],           # value @ x0
            [1, x1, x1**2, x1**3, x1**4],           # value @ x1
            [0, 1, 2 * x0, 3 * x0**2, 4 * x0**3],   # 1st deriv @ x0
            [0, 1, 2 * x1, 3 * x1**2, 4 * x1**3],   # 1st deriv @ x1
            [0, 0, 2, 6 * x0, 12 * x0**2],          # 2nd deriv @ x0
        ],
        dtype=np.float64,
    )
    b = np.array([v0, v1, d0, d1, dd0], dtype=np.float64)
    c = np.linalg.solve(a, b)
    return float(c[0] + c[1] * mach + c[2] * mach**2 + c[3] * mach**3 + c[4] * mach**4)


def single_fin_cna1(
    fin_area: float,
    span: float,
    cos_gamma: float,
    a_ref: float,
    mach: float,
    alpha: float = 0.0,
) -> float:
    """Single-fin CNa across Mach (OpenRocket calculateFinCNa1).

    Three regimes: subsonic slender-fin (M ≤ 0.9), supersonic Busemann (M ≥ 1.5),
    and a transonic quartic blend between. ``alpha`` (AoA, rad) is clamped to
    STALL_ANGLE and only feeds the supersonic K2/K3 terms; at AoA 0 (the static /
    flight-margin case) supersonic CNa is just ``(fin_area/a_ref)·2/β``.
    """
    if fin_area < 1e-12 or span < 1e-12 or cos_gamma < 1e-12 or a_ref <= 0:
        return 0.0
    alpha = min(abs(alpha), STALL_ANGLE)

    if mach <= CNA_SUBSONIC:
        return _subsonic_cna1(fin_area, span, cos_gamma, a_ref, mach)
    if mach >= CNA_SUPERSONIC:
        return _supersonic_cna1(fin_area, a_ref, mach, alpha)

    # Transonic: PolyInterpolator between the subsonic value/slope at 0.9 and the
    # supersonic value/slope at 1.5, with zero curvature at 0.9.
    k = (span * span) / (fin_area * cos_gamma)
    sq = math.sqrt(1 + (1 - CNA_SUBSONIC**2) * k * k)
    sub_v = 2 * math.pi * span * span / a_ref / (1 + sq)
    # NOTE: OpenRocket evaluates this endpoint derivative with the *running* Mach
    # (not 0.9) — a quirk of FinSetCalc; replicated here for a faithful match.
    sub_d = 2 * mach * math.pi * span**6 / (fin_area**2 * cos_gamma**2 * a_ref * sq * (1 + sq) ** 2)
    super_v = _supersonic_cna1(fin_area, a_ref, CNA_SUPERSONIC, alpha)
    super_d = -fin_area / a_ref * 2 * CNA_SUPERSONIC / CNA_SUPERSONIC_B
    return _poly_interp(mach, CNA_SUBSONIC, CNA_SUPERSONIC, sub_v, super_v, sub_d, super_d, 0.0)


def fin_cp_fraction(aspect_ratio: float, mach: float) -> float:
    """Fin CP as a fraction of MAC, along the chord (OpenRocket calculateCPPos).

    ``x_cp = mac_lead + fin_cp_fraction(ar, M)·mac_length``. Quarter-chord subsonic
    (M ≤ 0.5), migrating aft toward mid-chord supersonically (M ≥ 2), with a
    degree-5 polynomial blend transonically. ``aspect_ratio`` is OpenRocket's
    ``ar = 2·span²/finArea`` (== FinSetProperties.aspect_ratio).
    """
    ar = aspect_ratio
    if mach <= CP_SUBSONIC:
        return 0.25
    if mach >= CP_SUPERSONIC:
        beta = math.sqrt(max(mach * mach - 1.0, 1e-12))
        return (ar * beta - 0.67) / (2 * ar * beta - 1)
    # Transonic: OpenRocket's precomputed degree-5 polynomial in Mach (calculatePoly).
    denom = (1 - 3.4641 * ar) ** 2
    poly = (
        (9.16049 * (-0.588838 + ar) * (-0.20624 + ar)) / denom,
        (-31.6049 * (-0.705375 + ar) * (-0.198476 + ar)) / denom,
        (55.3086 * (-0.711482 + ar) * (-0.196772 + ar)) / denom,
        (-39.5062 * (-0.72074 + ar) * (-0.194245 + ar)) / denom,
        (12.8395 * (-0.725688 + ar) * (-0.19292 + ar)) / denom,
        (-1.58025 * (-0.728769 + ar) * (-0.192105 + ar)) / denom,
    )
    val = 0.0
    x = 1.0
    for coeff in poly:
        val += coeff * x
        x *= mach
    return val


def interference_factor(n_fins: int) -> float:
    """Fin-fin interference reduction by fin count (OpenRocket switch)."""
    return {5: 0.948, 6: 0.913, 7: 0.854, 8: 0.81}.get(n_fins, 1.0 if n_fins <= 4 else 0.75)


def fin_set_aero(
    chord_lead: np.ndarray,
    chord_trail: np.ndarray,
    span: float,
    body_radius: float,
    n_fins: int,
    r_ref: float,
    mach: float = 0.3,
) -> FinSetAero:
    """Whole fin-set CNa and cp, matching OpenRocket at AoA 0.

    ``r_ref`` is the reference radius (max body radius); ``body_radius`` is the
    radius where the fins attach. Strip x's are in the rocket axial frame, so the
    returned cp is too.
    """
    props = fin_set_properties(chord_lead, chord_trail, span)
    a_ref = math.pi * r_ref * r_ref
    cna1 = single_fin_cna1(props.fin_area, props.span, props.cos_gamma, a_ref, mach)

    tau = body_radius / (span + body_radius) if (span + body_radius) > 0 else 0.0
    cna = (n_fins / 2.0) * cna1 * (1 + tau) * interference_factor(n_fins)

    # CP migrates aft with Mach (quarter-MAC subsonic → ~mid-MAC supersonic).
    cp = props.mac_lead + fin_cp_fraction(props.aspect_ratio, mach) * props.mac_length
    return FinSetAero(cna=cna, cp=cp, a_ref=a_ref)
