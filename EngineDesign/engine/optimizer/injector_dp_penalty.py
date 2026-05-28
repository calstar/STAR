"""Layer-1 injector pressure-drop ratio penalty: per-stream quadratic hinge on ΔP_inj / Pc."""

from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

import numpy as np


# Layer‑1 injector-face ΔP/Pc gates: tiny edge tolerance so CFD-style float noise /
# iterative closure residuals do not falsely fail when hinge penalty is (~) zero at the boundary.
_DEFAULT_INJECTOR_DP_GATE_RTOL = 2.0e-4


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


def injector_dp_ratio_penalty_weighted(
    ratio_o: Optional[float],
    ratio_f: Optional[float],
    w_dp: float,
    w_dp_high: float = 0.0,
    *,
    o_band: Tuple[float, float] = (0.20, 0.35),
    f_band: Tuple[float, float] = (0.50, 1.20),
    w_dp_o: Optional[float] = None,
    w_dp_f: Optional[float] = None,
    o_soft_floor: Optional[float] = None,
    w_dp_o_floor: float = 0.0,
) -> float:
    """Soft weighted penalty for oxidizer and fuel ΔP_inj/Pc ratios (independent bands).

    Per-stream weights: if ``w_dp_o`` / ``w_dp_f`` are None, both streams use ``w_dp``.
    Otherwise ``injector_penalty = w_dp_o * hinge_O + w_dp_f * hinge_F``.

    Optionally adds ``w_dp_o_floor * (max(0, o_soft_floor - ratio_o))**2`` when
    ``o_soft_floor`` is set (stronger discourage very low oxidizer ΔP/Pc).

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
    return wo * float(s_o) + wf * float(s_f) + wflo * float(floor_pen)


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
