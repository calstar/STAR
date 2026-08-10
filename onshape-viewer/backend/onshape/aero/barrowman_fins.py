"""Barrowman normal-force and centre-of-pressure for a fin set.

A faithful port of OpenRocket's ``FinSetCalc`` (release-24.12) for the static case
its design view shows: Mach 0.3, AoA 0. As in OpenRocket, only the fin *planform*
matters -- thickness, cross-section, edge chamfers and root fillets feed drag and
mass, never CP -- so the input is the fin outline sampled into spanwise strips.

Geometry (``fin_set_properties``) reproduces OpenRocket's 48-strip integration for
the mean aerodynamic chord (MAC length, MAC leading-edge position) and the cosine
of the mid-chord sweep angle. Aerodynamics:

  * single-fin subsonic CNa (``single_fin_cna1``):
        cna1 = 2π·s² / (1 + sqrt(1 + (1-M²)·(s²/(A_fin·cosγ))²)) / A_ref
  * the whole set, summed over its fins the way OpenRocket merges fin instances,
    which for N ≥ 3 fins gives Σ sin²(θ-θ_i) = N/2:
        CNa = (N/2)·cna1·(1+τ)·k_interference ,  τ = r/(s+r)
    with the fin-count interference factor k (1 for N≤4, then 0.948, 0.913,
    0.854, 0.81, 0.75 for 5..9+).
  * cp at the quarter-MAC (subsonic): x_cp = macLead + 0.25·macLength.

Validated against OpenRocket's own FinSetCalcTest values (Estes Alpha III:
3 fins CNa 24.146933, 4 fins CNa 32.195911, cp.x 0.0193484).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

#: OpenRocket's spanwise strip count for MAC integration.
DIVISIONS = 48

#: Subsonic CP is the quarter-chord up to this Mach.
CNA_SUBSONIC = 0.5


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


def single_fin_cna1(fin_area: float, span: float, cos_gamma: float, a_ref: float, mach: float) -> float:
    """Subsonic single-fin CNa (OpenRocket calculateFinCNa1)."""
    if fin_area < 1e-12 or span < 1e-12 or cos_gamma < 1e-12 or a_ref <= 0:
        return 0.0
    if mach > CNA_SUBSONIC:
        # Static design-view CP is evaluated at Mach 0.3; supersonic not ported.
        raise NotImplementedError("only the subsonic (Mach <= 0.5) fin CNa is ported")
    s2 = span * span
    inner = 1 + (1 - mach * mach) * (s2 / (fin_area * cos_gamma)) ** 2
    return 2 * math.pi * s2 / (1 + math.sqrt(inner)) / a_ref


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

    # Subsonic: quarter-MAC.
    cp = props.mac_lead + 0.25 * props.mac_length
    return FinSetAero(cna=cna, cp=cp, a_ref=a_ref)
