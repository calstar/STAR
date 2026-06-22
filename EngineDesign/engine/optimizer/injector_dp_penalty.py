"""Layer-1 injector pressure-drop ratio penalty: per-stream quadratic hinge on ΔP_inj / Pc."""

from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

import numpy as np


# Layer‑1 injector-face ΔP/Pc gates: tiny edge tolerance so CFD-style float noise /
# iterative closure residuals do not falsely fail when hinge penalty is (~) zero at the boundary.
_DEFAULT_INJECTOR_DP_GATE_RTOL = 2.0e-4

# Preferred ΔP_inj/Pc band (design default; was [0.15, 0.35] before M6 recalibration).
_DEFAULT_DP_O_BAND = (0.20, 0.40)
_DEFAULT_DP_F_BAND = (0.20, 0.40)
_LEGACY_DP_BAND = (0.15, 0.35)


def injector_dp_bands_from_requirements(
    requirements: Dict[str, Any],
    *,
    default_o: Tuple[float, float] = _DEFAULT_DP_O_BAND,
    default_f: Tuple[float, float] = _DEFAULT_DP_F_BAND,
) -> Tuple[Tuple[float, float], Tuple[float, float]]:
    """Read oxidizer/fuel ΔP_inj/Pc bands; migrate legacy [0.15, 0.35] yaml to [0.20, 0.40]."""

    def _one(min_key: str, max_key: str, default: Tuple[float, float]) -> Tuple[float, float]:
        lo = float(requirements.get(min_key, default[0]))
        hi = float(requirements.get(max_key, default[1]))
        if abs(lo - _LEGACY_DP_BAND[0]) < 1e-9 and abs(hi - _LEGACY_DP_BAND[1]) < 1e-9:
            return _DEFAULT_DP_O_BAND
        return (lo, hi)

    return (
        _one("injector_dp_ratio_O_min", "injector_dp_ratio_O_max", default_o),
        _one("injector_dp_ratio_F_min", "injector_dp_ratio_F_max", default_f),
    )


def injector_dp_ratio_within_gate(
    r: Optional[float],
    lo: float,
    hi: float,
    *,
    rtol: float = _DEFAULT_INJECTOR_DP_GATE_RTOL,
    atol_floor: float = 5.0e-7,
) -> Optional[bool]:
    """True if finite ``r`` lies in ``[lo, hi]`` with a small symmetric margin at the edges."""
    if r is None:
        return None
    try:
        rr = float(r)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(rr):
        return None
    lo_f, hi_f = float(lo), float(hi)
    if hi_f <= lo_f:
        return False
    scale_ref = max(abs(lo_f), abs(hi_f), abs(rr), 0.05)
    margin = max(float(rtol) * scale_ref, float(atol_floor))
    return (lo_f - margin) <= rr <= (hi_f + margin)


def stream_injector_dp_soft_floor_squared(r: Optional[float], floor: Optional[float]) -> float:
    """Squared shortfall when ratio < floor (extra cost for LOX ΔP_inj/Pc too low).

    Returns 0 when ``floor`` is None or ``r`` is missing/non-finite.
    """
    if floor is None:
        return 0.0
    if r is None or not np.isfinite(r):
        return 0.0
    rr = float(r)
    fl = float(floor)
    short = max(0.0, fl - rr)
    return float(short * short)


def stream_injector_dp_band_hinge_squared(r: Optional[float], lo: float, hi: float) -> float:
    """Normalized squared hinge penalty outside [lo, hi]. Zero when lo <= r <= hi.

    Normalization by band width keeps penalty strength consistent across different
    configured bands and avoids under-penalizing small absolute misses.
    """
    if r is None:
        return 0.0
    try:
        rr = float(r)
    except (TypeError, ValueError):
        return 0.0
    if not np.isfinite(rr):
        return 0.0
    lo_f, hi_f = float(lo), float(hi)
    if hi_f <= lo_f:
        return 0.0
    span = max(hi_f - lo_f, 1e-9)
    below = max(0.0, lo_f - rr)
    above = max(0.0, rr - hi_f)
    return float((below / span) ** 2 + (above / span) ** 2)


def stream_injector_dp_center_squared(r: Optional[float], lo: float, hi: float) -> float:
    """Normalized squared deviation from the band CENTRE: ``((r - mid)/span)**2``.

    Unlike the hinge (which is zero everywhere inside the band), this is nonzero inside the
    band too, so a small weight on it gives the optimizer a gentle preference for the middle
    of the pass band instead of parking on an edge (e.g. 0.40). Zero for missing/non-finite
    ``r`` or an invalid band.
    """
    if r is None:
        return 0.0
    try:
        rr = float(r)
    except (TypeError, ValueError):
        return 0.0
    if not np.isfinite(rr):
        return 0.0
    lo_f, hi_f = float(lo), float(hi)
    if hi_f <= lo_f:
        return 0.0
    span = max(hi_f - lo_f, 1e-9)
    mid = 0.5 * (lo_f + hi_f)
    return float(((rr - mid) / span) ** 2)


def injector_dp_ratio_penalty_weighted(
    ratio_o: Optional[float],
    ratio_f: Optional[float],
    w_dp: float,
    w_dp_high: float = 0.0,
    *,
    o_band: Tuple[float, float] = (0.20, 0.40),
    f_band: Tuple[float, float] = (0.50, 1.20),
    w_dp_o: Optional[float] = None,
    w_dp_f: Optional[float] = None,
    o_soft_floor: Optional[float] = None,
    w_dp_o_floor: float = 0.0,
    w_dp_center: float = 0.0,
) -> float:
    """Soft weighted penalty for oxidizer and fuel ΔP_inj/Pc ratios (independent bands).

    Per-stream weights: if ``w_dp_o`` / ``w_dp_f`` are None, both streams use ``w_dp``.
    Otherwise ``injector_penalty = w_dp_o * hinge_O + w_dp_f * hinge_F``.

    Optionally adds ``w_dp_o_floor * (max(0, o_soft_floor - ratio_o))**2`` when
    ``o_soft_floor`` is set (stronger discourage very low oxidizer ΔP/Pc).

    ``w_dp_center`` (>0) adds a gentle ``w_dp_center * ((r - mid)/span)**2`` per stream that
    pulls each ratio toward the CENTRE of its pass band — the "soft target" so the optimizer
    settles near the middle (~0.30 for a [0.20,0.40] band) rather than the 0.40 edge. It is
    deliberately small relative to the band hinge so it only breaks ties inside the band and
    never overrides feasibility/thrust/O-F.

    ``w_dp_high`` is retained for call-site compatibility but does not contribute (legacy tier removed).
    """
    lo_o, hi_o = float(o_band[0]), float(o_band[1])
    lo_f, hi_f = float(f_band[0]), float(f_band[1])
    s_o = stream_injector_dp_band_hinge_squared(ratio_o, lo_o, hi_o)
    s_f = stream_injector_dp_band_hinge_squared(ratio_f, lo_f, hi_f)
    wo = float(w_dp_o) if w_dp_o is not None else float(w_dp)
    wf = float(w_dp_f) if w_dp_f is not None else float(w_dp)
    _ = w_dp_high  # unused; kept so older signatures remain valid
    floor_pen = stream_injector_dp_soft_floor_squared(ratio_o, o_soft_floor)
    wflo = float(w_dp_o_floor) if np.isfinite(w_dp_o_floor) else 0.0
    wc = float(w_dp_center) if np.isfinite(w_dp_center) else 0.0
    center_pen = 0.0
    if wc > 0.0:
        center_pen = (stream_injector_dp_center_squared(ratio_o, lo_o, hi_o)
                      + stream_injector_dp_center_squared(ratio_f, lo_f, hi_f))
    return wo * float(s_o) + wf * float(s_f) + wflo * float(floor_pen) + wc * float(center_pen)


def stream_injector_dp_raw_terms(r: float) -> Tuple[float, float]:
    """Deprecated: symmetric LOX-style band (0.20, 0.35). Returns (hinge, 0)."""
    h = stream_injector_dp_band_hinge_squared(r, 0.20, 0.35)
    return float(h), 0.0


def injector_dp_ratios_from_eval_result(pc: float, result: Dict[str, Any]) -> Tuple[Optional[float], Optional[float]]:
    """ΔP_inj / Pc using **injector-face** ΔP only (not tank−Pc).

    Impinging feed coupling produces ``diagnostics['delta_p_injector_{O,F}']`` =
    ``P_inj − Pc``, where ``P_inj`` is stagnation **after** ``delta_p_feed`` from the tank.
    Ratios used for Layer‑1 gates and penalties are ``delta_p_injector_* / Pc``.
    """
    if not np.isfinite(pc) or pc <= 0:
        return None, None
    diag = result.get("diagnostics") if isinstance(result.get("diagnostics"), dict) else {}
    ip = result.get("injector_pressure") if isinstance(result.get("injector_pressure"), dict) else {}

    def ratio_one(side: str) -> Optional[float]:
        dp = diag.get(f"delta_p_injector_{side}")
        if dp is None or not np.isfinite(dp):
            p_inj = diag.get(f"P_injector_{side}")
            if p_inj is None:
                p_inj = ip.get(f"P_injector_{side}")
            if p_inj is not None and np.isfinite(p_inj):
                dp = float(p_inj) - float(pc)
        if dp is None or not np.isfinite(dp):
            return None
        return float(dp) / float(pc)

    return ratio_one("O"), ratio_one("F")
