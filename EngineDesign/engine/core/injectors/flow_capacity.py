"""Effective injector flow capacity: A_eff = Cd * A_geom with numeric fallback."""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

import numpy as np


def effective_flow_areas_from_cd(
    diagnostics: Any,
    A_geom_O: float,
    A_geom_F: float,
) -> Tuple[float, float, List[str]]:
    """Compute A_eff_O, A_eff_F from closure diagnostics Cd_O/Cd_F.

    If Cd is missing, non-finite, or <= 0 for a stream, fall back to geometric area
    for that stream and record a warning tag (caller may attach to diagnostics).

    Parameters
    ----------
    diagnostics:
        Injector / closure diagnostics dict containing optional ``Cd_O``, ``Cd_F``.
    A_geom_O, A_geom_F:
        Geometric flow areas [m²] (sum of orifice areas per stream).

    Returns
    -------
    A_eff_O, A_eff_F, warnings
        Effective areas [m²] and a list of warning tokens, e.g.
        ``Cd_O_fallback_geometric``.
    """
    warnings: List[str] = []
    ag_o = float(A_geom_O)
    ag_f = float(A_geom_F)

    if not isinstance(diagnostics, dict):
        warnings.append("no_diagnostics")
        return ag_o, ag_f, warnings

    def _one(cd_key: str, ag: float) -> float:
        cd = diagnostics.get(cd_key)
        if cd is None or not np.isfinite(cd) or float(cd) <= 0.0:
            warnings.append(f"{cd_key}_fallback_geometric")
            return ag
        return float(cd) * ag

    return _one("Cd_O", ag_o), _one("Cd_F", ag_f), warnings


def merge_effective_area_warnings(diagnostics: Dict[str, Any], warnings: List[str]) -> None:
    """Append warnings list onto diagnostics dict in-place (idempotent merge)."""
    if not warnings:
        return
    existing = diagnostics.get("effective_area_fallback_warnings")
    if isinstance(existing, list):
        diagnostics["effective_area_fallback_warnings"] = list(existing) + [
            w for w in warnings if w not in existing
        ]
    else:
        diagnostics["effective_area_fallback_warnings"] = list(warnings)
