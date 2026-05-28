"""Layer 1: Static Optimization

This layer implements the main optimization loop that optimizes ONLY
static (time‑independent) quantities:

- Engine geometry (throat, L*, expansion ratio, pintle or impinging jet geometry)
- Initial tank pressures for LOX and fuel (single value per tank)

All **time‑varying** pressure behavior (segments/curves over the burn)
is handled **exclusively** in Layer 2 (`layer2_pressure.py`). Layer 1
must NOT create or manipulate pressure segments or time arrays.
"""

from __future__ import annotations

from typing import Tuple, Callable, Dict, Any, Optional, List
import numpy as np
import copy
import logging
import time
import os
from datetime import datetime
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor

from engine.pipeline.config_schemas import PintleEngineConfig, HybridOptimizerConfig
from engine.core.runner import PintleEngineRunner
from engine.core.injectors.flow_capacity import (
    effective_flow_areas_from_cd,
    merge_effective_area_warnings,
)
from engine.optimizer.injector_dp_penalty import (
    injector_dp_ratio_penalty_weighted,
    injector_dp_ratios_from_eval_result,
    injector_dp_ratio_within_gate,
)

from scipy.optimize import minimize, differential_evolution

try:
    import cma
except ImportError:  # pragma: no cover - optional dependency
    cma = None
   

from engine.optimizer.utils import (
    extract_all_parameters,
    impinging_chamber_inner_diameter_for_bounds,
    impinging_d_jet_upper_bound_m,
    impinging_n_elements_hi_int,
    impinging_spacing_upper_bound_m,
)

from engine.core.chamber_geometry import (
    chamber_length_calc,
    contraction_length_horizontal_calc,
)


TOTAL_WALL_THICKNESS_M = 0.0254  # 1.0 inch total wall (0.5 inch per side: outer - inner diameter)

# Default for ``requirements["min_stability_margin"]`` when unset. MUST stay identical in
# ``run_layer1_optimization`` and ``_compute_objective_value`` — parallel CMA ranks candidates via
# workers using the latter; L-BFGS-B uses ``objective()`` on the parent process.
_LAYER1_DEFAULT_MIN_STABILITY_MARGIN = 1.2

# Fallback injector ΔP/Pc bands when ``constants_dict`` omits keys (must match
# ``requirements.get("injector_dp_ratio_*")`` defaults in ``run_layer1_optimization``).
_LAYER1_DEFAULT_DP_O_BAND = (0.15, 0.40)
_LAYER1_DEFAULT_DP_F_BAND = (0.15, 0.40)

# Fallback when ``layer1_exit_pressure_inside_quad_scale`` is absent from constants (matches
# ``_requirement_float(..., "layer1_exit_pressure_inside_quad_scale", 0.35)``).
_LAYER1_DEFAULT_EXIT_PRESSURE_INSIDE_QUAD = 0.35


class _LocalSerialExecutor:
    """Drop-in minimal executor used when process pools are unavailable."""

    def __init__(self):
        self._max_workers = 1

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def map(self, fn, iterable, chunksize=None):
        del chunksize  # Serial executor ignores chunk hints.
        return map(fn, iterable)


def _throat_area_m2_from_config(config: PintleEngineConfig) -> Optional[float]:
    """Prefer unified ``chamber_geometry``; many YAMLs leave legacy ``chamber`` null."""
    cg = getattr(config, "chamber_geometry", None)
    if cg is not None:
        at = getattr(cg, "A_throat", None)
        if at is not None and np.isfinite(float(at)) and float(at) > 0:
            return float(at)
    ch = getattr(config, "chamber", None)
    if ch is not None:
        at = getattr(ch, "A_throat", None)
        if at is not None and np.isfinite(float(at)) and float(at) > 0:
            return float(at)
    return None


def _requirement_float(requirements: Dict[str, Any], key: str, default: float) -> float:
    """Parse float from Layer-1 ``requirements``; treat explicit ``None`` as *unset*."""
    v = requirements.get(key)
    return float(default if v is None else v)


def _store_last_good_eval_bundle_from_worker_res(
    res: Dict[str, Any], state: Optional[Dict[str, Any]]
) -> None:
    """Keep a parent-side copy of the last successful worker ``evaluate()`` for validation replay."""
    if state is None:
        return
    if not res.get("success") or not isinstance(res.get("full_results"), dict):
        return
    fr = res["full_results"]
    try:
        rf = float(fr.get("F", float("nan")))
    except (TypeError, ValueError):
        rf = float("nan")
    if not np.isfinite(rf):
        return
    state["last_good_eval_bundle"] = {
        "results": copy.deepcopy(fr),
        "P_O_Pa": float(res.get("P_O_Pa", 0.0)),
        "P_F_Pa": float(res.get("P_F_Pa", 0.0)),
        "thrust_error": float(res.get("thrust_error", 1.0)),
        "of_error": float(res.get("of_error", 1.0)),
    }


def _impinging_momentum_hinge_squared(
    R: Any,
    *,
    r_band_lo: Optional[float] = None,
    r_band_hi: Optional[float] = None,
) -> float:
    """Penalty for momentum_ratio_R outside a preferred band.

    If both ``r_band_lo`` and ``r_band_hi`` are finite and ``r_band_hi > r_band_lo``,
    uses a **ratio-space** deadband: zero when ``r_band_lo <= R <= r_band_hi``,
    else squared distance to the nearest band edge.

    Otherwise (defaults / legacy): **log-space** deadband zero for R in [1/1.1, 1.1],
    ``max(0, |log R| - log(1.1))**2`` outside.

    Returns 0.0 if R is missing, non-finite, or <= 0.
    """
    if R is None:
        return 0.0
    try:
        r = float(R)
    except (TypeError, ValueError):
        return 0.0
    if not np.isfinite(r) or r <= 0.0:
        return 0.0

    if (
        r_band_lo is not None
        and r_band_hi is not None
        and np.isfinite(r_band_lo)
        and np.isfinite(r_band_hi)
        and float(r_band_hi) > float(r_band_lo)
    ):
        lo, hi = float(r_band_lo), float(r_band_hi)
        if lo <= r <= hi:
            return 0.0
        excess = float(lo - r) if r < lo else float(r - hi)
        return float(excess * excess)

    log_R = float(np.log(r))
    tol = float(np.log(1.1))
    excess = max(0.0, abs(log_R) - tol)
    return float(excess * excess)


def _impinging_momentum_band_violation_squared(
    R: Any,
    *,
    r_band_lo: Optional[float] = None,
    r_band_hi: Optional[float] = None,
) -> float:
    """Normalized squared violation outside a configured momentum band.

    Returns 0.0 when no valid band is configured or R is missing/non-finite.
    """
    if (
        r_band_lo is None
        or r_band_hi is None
        or not np.isfinite(float(r_band_lo))
        or not np.isfinite(float(r_band_hi))
        or float(r_band_hi) <= float(r_band_lo)
    ):
        return 0.0
    try:
        r = float(R)
    except (TypeError, ValueError):
        return 0.0
    if not np.isfinite(r) or r <= 0.0:
        return 0.0
    lo = float(r_band_lo)
    hi = float(r_band_hi)
    if lo <= r <= hi:
        return 0.0
    excess = (lo - r) if r < lo else (r - hi)
    band_span = max(hi - lo, 1e-9)
    norm = excess / band_span
    return float(norm * norm)


def _impinging_angle_hinge_squared(
    impingement_angle_deg: Any,
    *,
    angle_band_lo_deg: Optional[float] = None,
    angle_band_hi_deg: Optional[float] = None,
) -> float:
    """Penalty for effective impingement angle outside a preferred degree band.

    Returns 0.0 when bounds are unset/invalid, or when angle is missing/non-finite.
    """
    if impingement_angle_deg is None:
        return 0.0
    try:
        phi = float(impingement_angle_deg)
    except (TypeError, ValueError):
        return 0.0
    if not np.isfinite(phi):
        return 0.0
    if (
        angle_band_lo_deg is None
        or angle_band_hi_deg is None
        or not np.isfinite(float(angle_band_lo_deg))
        or not np.isfinite(float(angle_band_hi_deg))
        or float(angle_band_hi_deg) <= float(angle_band_lo_deg)
    ):
        return 0.0
    lo = float(angle_band_lo_deg)
    hi = float(angle_band_hi_deg)
    if lo <= phi <= hi:
        return 0.0
    excess = float(lo - phi) if phi < lo else float(phi - hi)
    return float(excess * excess)


def _layer1_exit_pressure_sq_term(
    P_exit_actual: float,
    target_P_exit: float,
    *,
    deadband_rel: float = 0.05,
    inside_rel_quad_scale: float = 0.0,
) -> float:
    """Exit nozzle vs ambient-equivalent ``target``: asymmetric hinge beyond deadband, optional quad inside.

    Outside ``deadband_rel`` uses the asymmetric hinge used elsewhere; inside the deadband optionally
    adds ``inside_rel_quad_scale * rel**2`` to gently center on target (preference, not a hard gate).
    """
    if target_P_exit <= 0.0 or not np.isfinite(P_exit_actual):
        return 0.0
    rel = (float(P_exit_actual) - float(target_P_exit)) / float(target_P_exit)
    if not np.isfinite(rel):
        return 0.0
    deadband_rel = float(max(deadband_rel, 1e-9))
    if rel < -deadband_rel:
        excess = rel + deadband_rel
        return float((5.0 * excess) ** 2)
    if rel > deadband_rel:
        excess = rel - deadband_rel
        return float((1.0 * excess) ** 2)
    return float(max(0.0, inside_rel_quad_scale)) * float(rel ** 2)


def _layer1_primary_relative_metrics(
    final_performance: Dict[str, Any],
    *,
    target_thrust: float,
    optimal_of: float,
    target_P_exit: float,
) -> Dict[str, float]:
    """Dimensionless thrust / O-F / exit-pressure mismatches (not weighted optimizer penalties).

    The Layer 1 scalar objective multiplies these kinds of errors by ``W_THRUST``, ``W_OF``, ``W_EXIT``
    (order 1e2–1e4); the weighted sum will never approach machine epsilon. Use these metrics (especially
    ``rms_primary``) to judge whether the **physics** matches are tight.
    """
    try:
        F = float(final_performance.get("F", float("nan")))
    except (TypeError, ValueError):
        F = float("nan")
    try:
        MR = float(final_performance.get("MR", float("nan")))
    except (TypeError, ValueError):
        MR = float("nan")
    try:
        p_ex = float(final_performance.get("P_exit", float("nan")))
    except (TypeError, ValueError):
        p_ex = float("nan")
    rel_thrust = (
        abs(F - float(target_thrust)) / float(target_thrust)
        if float(target_thrust) > 0 and np.isfinite(F)
        else float("nan")
    )
    rel_of = (
        abs(MR - float(optimal_of)) / float(optimal_of)
        if float(optimal_of) > 0 and np.isfinite(MR)
        else float("nan")
    )
    rel_p_exit = (
        abs(p_ex - float(target_P_exit)) / float(target_P_exit)
        if float(target_P_exit) > 0 and np.isfinite(p_ex)
        else float("nan")
    )
    parts = [x for x in (rel_thrust, rel_of, rel_p_exit) if np.isfinite(x)]
    rms_primary = float(np.sqrt(np.mean(np.square(parts)))) if parts else float("nan")
    return {
        "rel_thrust": float(rel_thrust),
        "rel_of": float(rel_of),
        "rel_P_exit": float(rel_p_exit),
        "rms_primary": float(rms_primary),
    }


def _impinging_jet_pair_asymmetry_squared(
    theta_o_deg: Any,
    theta_f_deg: Any,
    *,
    max_delta_deg: float,
) -> float:
    """Soft penalty when paired oxidizer/fuel jet inclinations diverge excessively.

    ``max_delta_deg`` is an allowable |Δθ| band for nominally coherent doublet impingement; excess
    is normalized by ``max(max_delta_deg, 5 degrees)`` so the term is order one before weights.
    """
    if max_delta_deg <= 0.0 or not np.isfinite(max_delta_deg):
        return 0.0
    try:
        t_o = float(theta_o_deg)
        t_f = float(theta_f_deg)
    except (TypeError, ValueError):
        return 0.0
    if not np.isfinite(t_o) or not np.isfinite(t_f):
        return 0.0
    dd = abs(t_o - t_f)
    cap = float(max_delta_deg)
    if dd <= cap:
        return 0.0
    excess = dd - cap
    span = float(max(cap, 5.0))
    return float((excess / span) ** 2)


def _relative_hinge_band_squared(v: Any, lo: Optional[float], hi: Optional[float]) -> float:
    """Normalized hinge² outside [lo, hi]."""
    try:
        vv = float(v)
    except (TypeError, ValueError):
        return 0.0
    if not np.isfinite(vv):
        return 0.0
    if (
        lo is None
        or hi is None
        or not np.isfinite(float(lo))
        or not np.isfinite(float(hi))
        or float(hi) <= float(lo)
    ):
        return 0.0
    lo_f = float(lo)
    hi_f = float(hi)
    if lo_f <= vv <= hi_f:
        return 0.0
    if vv < lo_f:
        s = max(1e-12, abs(lo_f))
        return float(((lo_f - vv) / s) ** 2)
    s = max(1e-12, abs(hi_f))
    return float(((vv - hi_f) / s) ** 2)


def _expected_geom_ao_af_for_unit_momentum_ratio(optimal_of: float, rho_o: float, rho_f: float) -> float:
    """Geometric A_O/A_F consistent with MR ≈ optimal_of when R ≈ 1 (bulk u, fixed ρ)."""
    if optimal_of <= 0 or rho_f <= 0 or rho_o <= 0:
        return float("nan")
    return float(optimal_of) / float(np.sqrt(float(rho_o) / float(rho_f)))


def _geom_ao_af_momentum_hint_squared(
    A_geom_o: float,
    A_geom_f: float,
    optimal_of: float,
    rho_o: float,
    rho_f: float,
) -> Tuple[float, float, float]:
    """Returns (relative_error_squared, A_O/A_F, expected_A_O/A_F for R≈1)."""
    exp_af = _expected_geom_ao_af_for_unit_momentum_ratio(optimal_of, rho_o, rho_f)
    if not (np.isfinite(exp_af) and exp_af > 0 and A_geom_f > 0):
        return 0.0, float("nan"), exp_af
    ao_af = float(A_geom_o) / float(A_geom_f)
    rel = (ao_af - exp_af) / exp_af
    return float(rel * rel), ao_af, exp_af


def _impinging_smd_penalty_with_angle(
    diagnostics: Dict[str, Any],
    *,
    target_smd_microns: float,
    smd_rel_tol: float = 0.20,
    smd_corr_c: float = 0.9,
    smd_corr_a: float = 0.45,
    smd_corr_b: float = 0.10,
    smd_phi_floor_deg: float = 10.0,
    rho_l: float = 1000.0,
    mr_mass: Optional[float] = None,
) -> Tuple[float, float, float]:
    """Return (combined_penalty, effective_smd_um, impingement_angle_deg).

    Correlation form (user-requested):
      D32/d_j = C * We^(-a) * (rho_l/rho_g)^b * f(phi)
    where f(phi)=1/max(sin(phi), sin(phi_floor)).

    ``effective_smd_um`` uses a mass-flux–weighted blend of the two stream Sauter means when both
    are available (MR = mdot_O/mdot_F), consistent with common "effective spray SMD" reporting practice.
    """
    def _local_hinge_band(v: float, lo: float, hi: float, scale: float) -> float:
        """Local hinge squared penalty; avoids dependency on declaration order."""
        if not np.isfinite(v):
            return 0.0
        s = scale if (np.isfinite(scale) and scale > 1e-12) else 1.0
        if v < lo:
            return float(((lo - v) / s) ** 2)
        if v > hi:
            return float(((v - hi) / s) ** 2)
        return 0.0

    try:
        d32_o = float(diagnostics.get("D32_O", np.nan))
    except (TypeError, ValueError):
        d32_o = float("nan")
    try:
        d32_f = float(diagnostics.get("D32_F", np.nan))
    except (TypeError, ValueError):
        d32_f = float("nan")
    try:
        imp_deg = float(diagnostics.get("impingement_angle_deg", np.nan))
    except (TypeError, ValueError):
        imp_deg = float("nan")

    def _mr_eff() -> float:
        if mr_mass is not None and np.isfinite(float(mr_mass)) and float(mr_mass) > 0:
            return float(mr_mass)
        try:
            mr_diag = float(diagnostics.get("MR", np.nan))
        except (TypeError, ValueError):
            mr_diag = float("nan")
        if np.isfinite(mr_diag) and mr_diag > 0:
            return float(mr_diag)
        return 3.0

    def _mass_weighted_d32_m(do: float, df: float) -> float:
        if np.isfinite(do) and do > 0 and np.isfinite(df) and df > 0:
            mr = _mr_eff()
            w_o = float(mr / (1.0 + mr))
            w_f = float(1.0 / (1.0 + mr))
            return float(w_o * do + w_f * df)
        if np.isfinite(do) and do > 0:
            return float(do)
        if np.isfinite(df) and df > 0:
            return float(df)
        return float("nan")

    # Pull required terms for the correlation.
    try:
        djet_o = float(diagnostics.get("d_jet_O", np.nan))
    except (TypeError, ValueError):
        djet_o = float("nan")
    try:
        djet_f = float(diagnostics.get("d_jet_F", np.nan))
    except (TypeError, ValueError):
        djet_f = float("nan")
    try:
        we_o = float(diagnostics.get("We_O", np.nan))
    except (TypeError, ValueError):
        we_o = float("nan")
    try:
        we_f = float(diagnostics.get("We_F", np.nan))
    except (TypeError, ValueError):
        we_f = float("nan")
    try:
        pc = float(diagnostics.get("Pc", np.nan))
    except (TypeError, ValueError):
        pc = float("nan")
    try:
        tc = float(diagnostics.get("Tc", np.nan))
    except (TypeError, ValueError):
        tc = float("nan")
    try:
        r_g = float(diagnostics.get("R", np.nan))
    except (TypeError, ValueError):
        r_g = float("nan")

    rho_g = float("nan")
    if np.isfinite(pc) and np.isfinite(tc) and np.isfinite(r_g) and tc > 0 and r_g > 0:
        rho_g = pc / (r_g * tc)
    if not np.isfinite(rho_g) or rho_g <= 0:
        rho_g = 1.0

    phi_rad = np.deg2rad(imp_deg) if np.isfinite(imp_deg) else np.nan
    phi_floor_rad = np.deg2rad(max(1.0, smd_phi_floor_deg))
    if np.isfinite(phi_rad):
        f_phi = 1.0 / max(np.sin(phi_rad), np.sin(phi_floor_rad))
    else:
        f_phi = 1.0 / np.sin(phi_floor_rad)

    def _predict_d32_m(dj: float, we: float) -> float:
        if not (np.isfinite(dj) and dj > 0 and np.isfinite(we) and we > 0):
            return float("nan")
        return float(
            dj
            * smd_corr_c
            * (we ** (-smd_corr_a))
            * ((max(rho_l, 1e-9) / max(rho_g, 1e-9)) ** smd_corr_b)
            * f_phi
        )

    d32_pred_o = _predict_d32_m(djet_o, we_o)
    d32_pred_f = _predict_d32_m(djet_f, we_f)
    finite_pred = [v for v in (d32_pred_o, d32_pred_f) if np.isfinite(v) and v > 0.0]
    if finite_pred:
        d32_eff_m = _mass_weighted_d32_m(d32_pred_o, d32_pred_f)
        d32_eff_um = float(d32_eff_m * 1e6) if np.isfinite(d32_eff_m) and d32_eff_m > 0 else float("nan")
    else:
        # Fallback to injector diagnostics if correlation inputs are missing.
        finite_d = [v for v in (d32_o, d32_f) if np.isfinite(v) and v > 0.0]
        if not finite_d:
            return 0.0, float("nan"), imp_deg
        d32_eff_m = _mass_weighted_d32_m(d32_o, d32_f)
        d32_eff_um = float(d32_eff_m * 1e6) if np.isfinite(d32_eff_m) and d32_eff_m > 0 else float("nan")
    if not np.isfinite(d32_eff_um) or d32_eff_um <= 0.0 or target_smd_microns <= 0.0:
        return 0.0, d32_eff_um, imp_deg

    # Penalize if effective SMD exceeds target + tolerance.
    hi = float(target_smd_microns * (1.0 + max(0.0, smd_rel_tol)))
    smd_term = _local_hinge_band(d32_eff_um, lo=0.0, hi=hi, scale=max(hi, 1e-9))
    return float(smd_term), d32_eff_um, imp_deg


def _merge_runner_eval_into_performance(
    initial_performance: Dict[str, Any],
    eval_results: Dict[str, Any],
) -> None:
    """Copy diagnostics and injector_pressure from runner.evaluate for Layer 1 summaries.

    Stored-validation path builds a partial ``initial_performance`` dict; without these,
    momentum_ratio_R / injector ΔP metrics do not propagate to ``final_performance``.
    """
    di = eval_results.get("diagnostics")
    if isinstance(di, dict):
        initial_performance["diagnostics"] = di
    ip = eval_results.get("injector_pressure")
    if isinstance(ip, dict):
        initial_performance["injector_pressure"] = ip


def _layer1_final_primary_objective_terms(
    final_performance: Dict[str, Any],
    *,
    target_thrust: float,
    optimal_of: float,
    target_P_exit: float,
    layer1_exit_pressure_inside_quad_scale: float = 0.0,
    layer1_w_dp: float,
    layer1_w_dp_o: float,
    layer1_w_dp_f: float,
    injector_dp_o_band: Tuple[float, float],
    injector_dp_f_band: Tuple[float, float],
    injector_dp_o_soft_floor: Optional[float] = None,
    layer1_w_dp_o_floor: float = 0.0,
    layer1_w_thrust: float = 1.0e4,
    layer1_w_of: float = 1.0e4,
    layer1_w_of_low_mr_scale: float = 1.0,
    layer1_w_of_high_mr_scale: float = 1.0,
) -> Dict[str, float]:
    """Recompute primary scalar penalty contributions (matches inner objective, excluding Cf/length/momentum)."""
    w_thrust = float(layer1_w_thrust)
    w_of = float(layer1_w_of)
    w_of_low = max(1.0, float(layer1_w_of_low_mr_scale))
    w_of_high = max(1.0, float(layer1_w_of_high_mr_scale))
    w_exit = 2.0e2

    f_act = float(final_performance.get("F", np.nan))
    thrust_penalty_sq_term = 0.0
    if target_thrust > 0 and np.isfinite(f_act):
        rel_error = abs(f_act - target_thrust) / target_thrust
        deadband = 0.02
        if rel_error > deadband:
            thrust_penalty_sq_term = float((rel_error - deadband) ** 2)
    thrust_contrib = w_thrust * thrust_penalty_sq_term

    mr_act = float(final_performance.get("MR", np.nan))
    if optimal_of > 0 and np.isfinite(mr_act):
        of_error = abs(mr_act - optimal_of) / optimal_of
    else:
        of_error = 1.0
    of_sq = float(of_error) ** 2
    if optimal_of > 0 and np.isfinite(mr_act):
        if mr_act < optimal_of:
            of_sq *= w_of_low
        elif mr_act > optimal_of:
            of_sq *= w_of_high
    of_contrib = w_of * of_sq

    p_exit_actual = float(final_performance.get("P_exit", np.nan))
    exit_pressure_sq_term = float(
        _layer1_exit_pressure_sq_term(
            p_exit_actual,
            float(target_P_exit),
            deadband_rel=0.05,
            inside_rel_quad_scale=float(layer1_exit_pressure_inside_quad_scale),
        )
    )
    exit_contrib = w_exit * exit_pressure_sq_term

    pc = final_performance.get("Pc")
    inj_contrib = 0.0
    if pc is not None and np.isfinite(float(pc)) and float(pc) > 0:
        ro, rf = injector_dp_ratios_from_eval_result(float(pc), final_performance)
        inj_contrib = float(
            injector_dp_ratio_penalty_weighted(
                ro,
                rf,
                layer1_w_dp,
                0.0,
                o_band=injector_dp_o_band,
                f_band=injector_dp_f_band,
                w_dp_o=layer1_w_dp_o,
                w_dp_f=layer1_w_dp_f,
                o_soft_floor=injector_dp_o_soft_floor,
                w_dp_o_floor=layer1_w_dp_o_floor,
            )
        )

    return {
        "thrust_penalty_contribution": float(thrust_contrib),
        "of_penalty_contribution": float(of_contrib),
        "exit_pressure_penalty_contribution": float(exit_contrib),
        "injector_dp_penalty_contribution": float(inj_contrib),
    }


def _layer1_apply_chamber_geometry_to_config(
    config: PintleEngineConfig,
    *,
    A_throat: float,
    Lstar: float,
    expansion_ratio: float,
    D_chamber_outer: float,
    max_nozzle_exit: float,
    wall_thickness_m: float,
) -> float:
    """Update chamber / nozzle fields from the first four Layer-1 DOFs.

    Returns:
        Final expansion ratio after optional exit clipping [–]
    """
    from engine.pipeline.config_schemas import ensure_chamber_geometry

    V_chamber = Lstar * A_throat
    D_chamber_inner = D_chamber_outer - wall_thickness_m
    if D_chamber_inner <= 0:
        D_chamber_inner = max(D_chamber_outer * 0.3, 0.01)
    A_chamber = np.pi * (D_chamber_inner / 2) ** 2
    R_throat = np.sqrt(max(0, A_throat / np.pi))

    if A_throat > 0 and A_chamber > 0:
        contraction_ratio = A_chamber / A_throat
    else:
        contraction_ratio = 10.0
    theta_contraction = np.pi / 4
    nozzle_entrance_radius_est = R_throat

    L_cylindrical = chamber_length_calc(
        chamber_volume=V_chamber,
        area_throat=A_throat,
        contraction_ratio=contraction_ratio,
        theta=theta_contraction,
    )
    L_contraction = contraction_length_horizontal_calc(
        area_chamber=A_chamber,
        entrance_arc_start_y=nozzle_entrance_radius_est,
        theta=theta_contraction,
    )
    L_chamber = L_cylindrical + L_contraction

    if L_chamber <= 0 or L_cylindrical <= 0 or not np.isfinite(L_chamber):
        L_chamber = V_chamber / A_chamber if A_chamber > 0 else 0.2
        L_cylindrical = max(L_chamber * 0.5, 0.05)

    L_chamber = np.clip(L_chamber, 0.005, 1.0)

    if config.chamber_geometry is None:
        cg = ensure_chamber_geometry(config)
    else:
        cg = config.chamber_geometry

    A_exit = A_throat * expansion_ratio
    if A_exit < 0:
        A_exit = A_throat * 10.0
    D_exit = np.sqrt(max(0, 4 * A_exit / np.pi))
    exp_ratio_out = expansion_ratio
    if D_exit > max_nozzle_exit:
        D_exit = max_nozzle_exit
        A_exit = np.pi * (D_exit / 2) ** 2
        exp_ratio_out = A_exit / A_throat if A_throat > 0 else 10.0

    cg.A_throat = A_throat
    cg.volume = V_chamber
    cg.Lstar = Lstar
    cg.length = L_chamber
    cg.chamber_diameter = D_chamber_inner
    cg.A_exit = A_exit
    cg.exit_diameter = D_exit
    cg.expansion_ratio = exp_ratio_out

    if config.chamber is not None:
        config.chamber.A_throat = A_throat
        config.chamber.volume = V_chamber
        config.chamber.Lstar = Lstar
        config.chamber.length = L_chamber
        setattr(config.chamber, 'chamber_inner_diameter', D_chamber_inner)
        if hasattr(config.chamber, 'contraction_ratio'):
            config.chamber.contraction_ratio = contraction_ratio
        if hasattr(config.chamber, 'A_chamber'):
            config.chamber.A_chamber = A_chamber
    if config.nozzle is not None:
        config.nozzle.A_throat = A_throat
        config.nozzle.A_exit = A_exit
        config.nozzle.expansion_ratio = exp_ratio_out
        if hasattr(config.nozzle, 'exit_diameter'):
            config.nozzle.exit_diameter = D_exit

    if hasattr(config.combustion, 'cea'):
        config.combustion.cea.expansion_ratio = exp_ratio_out

    return float(exp_ratio_out)

# ============================================================================
# Worker Process Globals (for parallel CMA-ES evaluation)
# ============================================================================
# These are set by _init_worker() in each worker process and reused across evaluations
_worker_runner = None
_worker_base_config = None
_worker_bounds = None
_worker_requirements = None
_worker_constants = None
_worker_debug_strict = False



def create_layer1_apply_x_to_config(
    bounds: list,
    max_chamber_od: float,
    max_nozzle_exit: float,
    injector_type: str = "pintle",
) -> Callable:
    """Create the apply_x_to_config function with dependencies.

    Returns a function that converts optimizer variables to engine config.
    """

    def apply_x_to_config(
        x: np.ndarray,
        base_config: PintleEngineConfig,
    ) -> Tuple[PintleEngineConfig, float, float]:
        """Apply optimization variables to config."""
        config = copy.deepcopy(base_config)
        inj_type = injector_type
        if inj_type not in ("pintle", "impinging"):
            inj_type = getattr(getattr(base_config, "injector", None), "type", "pintle")

        A_throat = float(np.clip(x[0], bounds[0][0], bounds[0][1]))
        Lstar = float(np.clip(x[1], bounds[1][0], bounds[1][1]))
        expansion_ratio = float(np.clip(x[2], bounds[2][0], bounds[2][1]))
        D_chamber_outer = float(np.clip(x[3], bounds[3][0], bounds[3][1]))

        _layer1_apply_chamber_geometry_to_config(
            config,
            A_throat=A_throat,
            Lstar=Lstar,
            expansion_ratio=expansion_ratio,
            D_chamber_outer=D_chamber_outer,
            max_nozzle_exit=max_nozzle_exit,
            wall_thickness_m=TOTAL_WALL_THICKNESS_M,
        )

        if inj_type == "impinging":
            n_doublets = int(round(np.clip(x[4], bounds[4][0], bounds[4][1])))
            n_el_O = n_doublets
            d_jet_O = float(np.clip(x[5], bounds[5][0], bounds[5][1]))
            ang_O = float(np.clip(x[6], bounds[6][0], bounds[6][1]))
            sp_O = float(np.clip(x[7], bounds[7][0], bounds[7][1]))
            n_el_F = n_doublets
            d_jet_F = float(np.clip(x[8], bounds[8][0], bounds[8][1]))
            ang_F = float(np.clip(x[9], bounds[9][0], bounds[9][1]))
            sp_F = float(np.clip(x[10], bounds[10][0], bounds[10][1]))
            P_O_start_psi = float(np.clip(x[11], bounds[11][0], bounds[11][1]))
            P_F_start_psi = float(np.clip(x[12], bounds[12][0], bounds[12][1]))
            if hasattr(config.injector, "geometry"):
                config.injector.geometry.oxidizer.n_elements = max(1, n_el_O)
                config.injector.geometry.oxidizer.d_jet = d_jet_O
                config.injector.geometry.oxidizer.impingement_angle = ang_O
                config.injector.geometry.oxidizer.spacing = sp_O
                config.injector.geometry.fuel.n_elements = max(1, n_el_F)
                config.injector.geometry.fuel.d_jet = d_jet_F
                config.injector.geometry.fuel.impingement_angle = ang_F
                config.injector.geometry.fuel.spacing = sp_F
            # Keep tank stagnation pressures on ``config`` in sync with ``x`` (runner.evaluate uses x-derived Pa).
            if getattr(config, "lox_tank", None) is not None:
                config.lox_tank.initial_pressure_psi = float(P_O_start_psi)
            if getattr(config, "fuel_tank", None) is not None:
                config.fuel_tank.initial_pressure_psi = float(P_F_start_psi)
            return config, P_O_start_psi, P_F_start_psi

        d_pintle_tip = float(np.clip(x[4], bounds[4][0], bounds[4][1]))
        h_gap = float(np.clip(x[5], bounds[5][0], bounds[5][1]))
        n_orifices = int(round(np.clip(x[6], bounds[6][0], bounds[6][1])))
        d_orifice = float(np.clip(x[7], bounds[7][0], bounds[7][1]))
        P_O_start_psi = float(np.clip(x[8], bounds[8][0], bounds[8][1]))
        P_F_start_psi = float(np.clip(x[9], bounds[9][0], bounds[9][1]))

        if hasattr(config.injector, 'geometry'):
            if hasattr(config.injector.geometry, 'fuel'):
                config.injector.geometry.fuel.d_pintle_tip = d_pintle_tip
                config.injector.geometry.fuel.h_gap = h_gap
                config.injector.geometry.fuel.d_reservoir_inner = d_pintle_tip + 2 * h_gap
                config.injector.geometry.fuel.d_hydraulic = 2 * h_gap
                config.injector.geometry.fuel.A_entry = np.pi * (d_pintle_tip / 2) ** 2
            if hasattr(config.injector.geometry, 'lox'):
                config.injector.geometry.lox.n_orifices = n_orifices
                config.injector.geometry.lox.d_orifice = d_orifice
                config.injector.geometry.lox.theta_orifice = 90.0
                config.injector.geometry.lox.d_hydraulic = d_orifice
                config.injector.geometry.lox.A_entry = np.pi * (d_orifice / 2) ** 2

        if getattr(config, "lox_tank", None) is not None:
            config.lox_tank.initial_pressure_psi = float(P_O_start_psi)
        if getattr(config, "fuel_tank", None) is not None:
            config.fuel_tank.initial_pressure_psi = float(P_F_start_psi)

        return config, P_O_start_psi, P_F_start_psi

    return apply_x_to_config





# ============================================================================
# Helper Functions for Parallel CMA-ES Evaluation
# ============================================================================

def _config_to_dict(config: PintleEngineConfig) -> dict:
    """Convert config to lightweight dict for pickling.
    
    Uses pydantic's dict() method if available, otherwise falls back to __dict__.
    """
    return config.dict() if hasattr(config, 'dict') else config.__dict__


def _dict_to_config(config_dict: dict) -> PintleEngineConfig:
    """Reconstruct config from dict."""
    return PintleEngineConfig(**config_dict)


def _snap_integer_dims(x: np.ndarray, integer_indices: list) -> np.ndarray:
    """Snap integer dimensions to nearest integer.
    
    Ensures cache consistency and physical validity for discrete variables.
    
    Args:
        x: Candidate vector
        integer_indices: List of indices to snap (e.g., [6] for n_orifices)
    
    Returns:
        Snapped vector with integer dimensions rounded
    """
    x_snapped = x.copy()
    for idx in integer_indices:
        x_snapped[idx] = round(x_snapped[idx])
    return x_snapped


def _get_num_workers(config_obj) -> int:
    """Get number of workers from config or default to cpu_count - 1."""
    if hasattr(config_obj, 'optimizer') and hasattr(config_obj.optimizer, 'num_workers'):
        num_workers = config_obj.optimizer.num_workers
    else:
        # Default to cpu_count - 1 (leave one core free)
        num_workers = max(1, os.cpu_count() - 1)
    
    return num_workers


def _init_worker(config_dict: dict, bounds_array: np.ndarray, requirements_dict: dict, 
                 constants_dict: dict, debug_strict: bool = False):
    """Initialize worker process with lightweight data.
    
    Builds PintleEngineRunner ONCE per worker for major speedup.
    Runner is reused by mutating its config in-place (runner.evaluate is stateless).
    
    Args:
        config_dict: Serialized config (primitives only)
        bounds_array: Bounds array [n_dims x 2]
        requirements_dict: Requirements dict
        constants_dict: Constants needed for geometry calculations
        debug_strict: If True, re-raise exceptions; if False, return penalties
    """
    global _worker_runner, _worker_base_config, _worker_bounds, _worker_requirements, _worker_constants, _worker_debug_strict
    
    # Reconstruct config from dict
    _worker_base_config = _dict_to_config(config_dict)
    
    # Build runner ONCE per worker (major speedup)
    # Note: PintleEngineRunner.evaluate() is stateless between calls
    _worker_runner = PintleEngineRunner(_worker_base_config)
    
    # Store bounds and requirements
    _worker_bounds = np.array(bounds_array, dtype=np.float64)
    _worker_requirements = requirements_dict
    _worker_constants = constants_dict
    _worker_debug_strict = debug_strict


def _apply_x_to_worker_config_inplace(x: np.ndarray, config: PintleEngineConfig, constants: dict):
    """Apply x to config IN-PLACE (mutates config, no copy).

    Assumes x is already bounded and snapped (CMA-ES + parent handle this).
    """
    inj_type = constants.get("injector_type", "pintle")

    A_throat = float(x[0])
    Lstar = float(x[1])
    expansion_ratio = float(x[2])
    D_chamber_outer = float(x[3])
    max_nozzle_exit = constants.get('max_nozzle_exit', 1.0)
    wall = float(constants.get('TOTAL_WALL_THICKNESS_M', TOTAL_WALL_THICKNESS_M))

    _layer1_apply_chamber_geometry_to_config(
        config,
        A_throat=A_throat,
        Lstar=Lstar,
        expansion_ratio=expansion_ratio,
        D_chamber_outer=D_chamber_outer,
        max_nozzle_exit=max_nozzle_exit,
        wall_thickness_m=wall,
    )

    if inj_type == "impinging":
        n_doublets = int(x[4])
        n_el_O = n_doublets
        d_jet_O = float(x[5])
        ang_O = float(x[6])
        sp_O = float(x[7])
        n_el_F = n_doublets
        d_jet_F = float(x[8])
        ang_F = float(x[9])
        sp_F = float(x[10])
        if hasattr(config, 'injector') and hasattr(config.injector, 'geometry'):
            config.injector.geometry.oxidizer.n_elements = max(1, n_el_O)
            config.injector.geometry.oxidizer.d_jet = d_jet_O
            config.injector.geometry.oxidizer.impingement_angle = ang_O
            config.injector.geometry.oxidizer.spacing = sp_O
            config.injector.geometry.fuel.n_elements = max(1, n_el_F)
            config.injector.geometry.fuel.d_jet = d_jet_F
            config.injector.geometry.fuel.impingement_angle = ang_F
            config.injector.geometry.fuel.spacing = sp_F
        _io = int(constants.get("idx_P_O", 11))
        _if = int(constants.get("idx_P_F", 12))
        if len(x) > _if:
            _po = float(x[_io])
            _pf = float(x[_if])
            if getattr(config, "lox_tank", None) is not None:
                config.lox_tank.initial_pressure_psi = _po
            if getattr(config, "fuel_tank", None) is not None:
                config.fuel_tank.initial_pressure_psi = _pf
        return

    d_pintle_tip = float(x[4])
    h_gap = float(x[5])
    n_orifices = int(x[6])
    d_orifice = float(x[7])

    if hasattr(config, 'injector') and getattr(config.injector, 'type', '') == "pintle":
        if hasattr(config.injector.geometry, 'fuel'):
            config.injector.geometry.fuel.d_pintle_tip = d_pintle_tip
            config.injector.geometry.fuel.h_gap = h_gap
            config.injector.geometry.fuel.d_reservoir_inner = d_pintle_tip + 2 * h_gap
            config.injector.geometry.fuel.d_hydraulic = 2 * h_gap
            config.injector.geometry.fuel.A_entry = np.pi * (d_pintle_tip / 2) ** 2
        if hasattr(config.injector.geometry, 'lox'):
            config.injector.geometry.lox.n_orifices = n_orifices
            config.injector.geometry.lox.d_orifice = d_orifice
            config.injector.geometry.lox.theta_orifice = 90.0
            config.injector.geometry.lox.d_hydraulic = d_orifice
            config.injector.geometry.lox.A_entry = np.pi * (d_orifice / 2) ** 2

    _io = int(constants.get("idx_P_O", 8))
    _if = int(constants.get("idx_P_F", 9))
    if len(x) > _if:
        _po = float(x[_io])
        _pf = float(x[_if])
        if getattr(config, "lox_tank", None) is not None:
            config.lox_tank.initial_pressure_psi = _po
        if getattr(config, "fuel_tank", None) is not None:
            config.fuel_tank.initial_pressure_psi = _pf


def _compute_objective_value(result: dict, x: np.ndarray, requirements: dict, constants: dict) -> float:
    """Compute objective value from evaluation result.
    
    Pure function: no state mutation.
    Extracted from main objective() to ensure same logic in workers.
    
    This implements the full lexicographic objective with:
    - Geometric validation
    - Injector validation
    - Stability checks
    - Lexicographic scalarization
    
    Args:
        result: Evaluation result dict from runner.evaluate()
        x: Candidate vector (already snapped and bounded)
        requirements: Requirements dict
        constants: Constants dict
    
    Returns:
        Objective value (float)
    """
    inj_type = constants.get("injector_type", "pintle")
    idx_P_O = int(constants.get("idx_P_O", 8))
    idx_P_F = int(constants.get("idx_P_F", 9))

    target_thrust = constants.get('target_thrust', 1000)
    optimal_of = constants.get('optimal_of', 2.5)
    target_P_exit = constants.get('P_ambient', 101325.0)
    max_lox_P_psi = constants.get('max_lox_P_psi', 500)
    max_fuel_P_psi = constants.get('max_fuel_P_psi', 500)
    TOTAL_WALL_THICKNESS_M = constants.get('TOTAL_WALL_THICKNESS_M', 0.0254)
    max_nozzle_exit = constants.get('max_nozzle_exit', 1.0)
    min_stability = float(requirements.get("min_stability_margin", _LAYER1_DEFAULT_MIN_STABILITY_MARGIN))

    A_throat = float(x[0])
    Lstar = float(x[1])
    expansion_ratio = float(x[2])
    D_chamber_outer = float(x[3])

    d_pintle_tip = 0.0
    h_gap = 0.0
    n_orifices = 0
    d_orifice = 0.0

    if inj_type == "impinging":
        # Impinging Layer-1 vector uses shared paired-doublet count:
        # [4]=n_doublets, [5:8]=LOX jet vars, [8:11]=fuel jet vars, [11:13]=tank pressures.
        n_el_O = int(x[4])
        d_jet_O = float(x[5])
        ang_O = float(x[6])
        sp_O = float(x[7])
        n_el_F = n_el_O
        d_jet_F = float(x[8])
        ang_F = float(x[9])
        sp_F = float(x[10])
        A_lox_injector = float(n_el_O * np.pi * (d_jet_O / 2.0) ** 2)
        A_fuel_injector = float(n_el_F * np.pi * (d_jet_F / 2.0) ** 2)
    else:
        d_pintle_tip = float(x[4])
        h_gap = float(x[5])
        n_orifices = int(x[6])
        d_orifice = float(x[7])
        A_lox_injector = float(n_orifices * np.pi * (d_orifice / 2.0) ** 2)
        R_inner = float(d_pintle_tip / 2.0)
        R_outer = float(R_inner + h_gap)
        A_fuel_injector = float(np.pi * (R_outer ** 2 - R_inner ** 2))

    V_chamber = Lstar * A_throat
    D_chamber_inner = D_chamber_outer - TOTAL_WALL_THICKNESS_M
    if D_chamber_inner <= 0:
        D_chamber_inner = max(D_chamber_outer * 0.3, 0.01)

    A_chamber_check = np.pi * (D_chamber_inner / 2.0) ** 2
    A_throat_check = A_throat

    A_exit = A_throat * expansion_ratio
    if A_exit < 0:
        A_exit = A_throat * 10.0
    D_exit_check = np.sqrt(max(0.0, 4.0 * A_exit / np.pi))
    if D_exit_check > max_nozzle_exit:
        D_exit_check = max_nozzle_exit

    D_throat_check = np.sqrt(4.0 * A_throat_check / np.pi) if A_throat_check > 0 else 0.0

    # Flow-capacity ratios use A_eff = Cd × A_geom when diagnostics supply Cd (post-evaluate)
    A_lox_flow = A_lox_injector
    A_fuel_flow = A_fuel_injector
    if inj_type in ("impinging", "pintle"):
        diag_r = result.get("diagnostics") if isinstance(result, dict) else {}
        A_lox_flow, A_fuel_flow, eff_w = effective_flow_areas_from_cd(
            diag_r, A_lox_injector, A_fuel_injector
        )
        if eff_w and isinstance(result.get("diagnostics"), dict):
            merge_effective_area_warnings(result["diagnostics"], eff_w)

    lox_ratio = A_lox_flow / A_throat_check if A_throat_check > 0 else np.nan
    fuel_ratio = A_fuel_flow / A_throat_check if A_throat_check > 0 else np.nan

    P_O_psi = float(x[idx_P_O])
    P_F_psi = float(x[idx_P_F])
    P_O_ratio = P_O_psi / max_lox_P_psi if max_lox_P_psi > 0 else 0.0
    P_F_ratio = P_F_psi / max_fuel_P_psi if max_fuel_P_psi > 0 else 0.0

    infeasibility_score = 0.0

    if A_chamber_check > 0 and A_throat_check > 0:
        contraction_ratio_check = A_chamber_check / A_throat_check
        infeasibility_score += max(0.0, (A_throat_check * 1.1) / A_chamber_check - 1.0) ** 2

        if contraction_ratio_check < 1.5:
            infeasibility_score += (1.5 - contraction_ratio_check) ** 2
        elif contraction_ratio_check > 15.0:
            infeasibility_score += (contraction_ratio_check - 15.0) ** 2

    if inj_type == "pintle" and D_chamber_inner > 0:
        infeasibility_score += max(0.0, (d_pintle_tip * 1.1) / D_chamber_inner - 1.0) ** 2

    if D_throat_check > 0 and D_chamber_inner > 0:
        infeasibility_score += max(0.0, D_throat_check - D_chamber_inner * 0.95) ** 2 * 10.0

    if D_exit_check > 0 and D_throat_check > 0:
        infeasibility_score += max(0.0, D_throat_check / D_exit_check - 1.0) ** 2

    if inj_type == "pintle" and A_throat_check > 0:
        infeasibility_score += max(0.0, lox_ratio - 1.0) ** 2
        infeasibility_score += max(0.0, fuel_ratio - 1.0) ** 2
        if A_fuel_flow > 0:
            area_ratio = A_lox_flow / A_fuel_flow
            Cd_ratio = 0.4 / 0.65
            rho_ratio = np.sqrt(
                max(float(constants.get("rho_oxidizer", 1140.0)), 1e-9)
                / max(float(constants.get("rho_fuel", 780.0)), 1e-9)
            )
            delta_p_ratio_est = np.sqrt(1.2)
            area_ratio_factor = Cd_ratio * rho_ratio * delta_p_ratio_est
            required_area_ratio = optimal_of / area_ratio_factor if area_ratio_factor > 0 else np.inf
            if required_area_ratio > 0 and np.isfinite(required_area_ratio):
                area_ratio_error = abs(area_ratio - required_area_ratio) / required_area_ratio
                infeasibility_score += max(0.0, area_ratio_error - 0.5) ** 2

    elif inj_type == "impinging" and A_throat_check > 0:
        infeasibility_score += max(0.0, lox_ratio - 0.95) ** 2
        infeasibility_score += max(0.0, fuel_ratio - 0.95) ** 2
        infeasibility_score += (max(0.0, d_jet_O - sp_O) / (sp_O + 1e-9)) ** 2
        infeasibility_score += (max(0.0, d_jet_F - sp_F) / (sp_F + 1e-9)) ** 2
        infeasibility_score += (max(0.0, 2.5 * d_jet_O - sp_O) * 0.4) ** 2
        infeasibility_score += (max(0.0, 2.5 * d_jet_F - sp_F) * 0.4) ** 2
        face_a = np.pi * (D_chamber_inner / 2.0) ** 2
        pack = float(n_el_O + n_el_F) * max(sp_O, sp_F) ** 2
        if face_a > 0:
            infeasibility_score += max(0.0, pack / face_a - 0.55) ** 2
        if A_fuel_flow > 0:
            area_ratio = A_lox_flow / A_fuel_flow
            Cd_ratio = 0.4 / 0.65
            rho_ratio = np.sqrt(
                max(float(constants.get("rho_oxidizer", 1140.0)), 1e-9)
                / max(float(constants.get("rho_fuel", 780.0)), 1e-9)
            )
            delta_p_ratio_est = np.sqrt(1.2)
            area_ratio_factor = Cd_ratio * rho_ratio * delta_p_ratio_est
            required_area_ratio = optimal_of / area_ratio_factor if area_ratio_factor > 0 else np.inf
            if required_area_ratio > 0 and np.isfinite(required_area_ratio):
                area_ratio_err = abs(area_ratio - required_area_ratio) / required_area_ratio
                infeasibility_score += max(0.0, area_ratio_err - 0.5) ** 2

    # --- Evaluation Results ---
    eval_success = result.get('success', False) if isinstance(result, dict) else False
    # Runner.evaluate typically omits success; infer from finite thrust/Pc when absent
    if isinstance(result, dict) and not eval_success:
        F_guess = result.get("F", np.nan)
        Pc_guess = result.get("Pc", np.nan)
        eval_success = bool(np.isfinite(F_guess) and np.isfinite(Pc_guess))

    if not eval_success:
        # Evaluation failed - return high penalty
        infeasibility_score += 1.0
        # Add directional guidance based on pressure ratios
        infeasibility_score += max(0.0, 0.90 - P_O_ratio) ** 2 + max(0.0, 0.90 - P_F_ratio) ** 2
        
        # SCALED DOWN: Max penalty ~1e7
        BASE_INFEAS = 1e6
        W_INFEAS = 1e5
        return BASE_INFEAS + W_INFEAS * float(infeasibility_score)
    
    # Extract performance metrics
    F_actual = float(result.get('F', np.nan))
    MR_actual = float(result.get('MR', np.nan))
    Cf_actual = float(result.get('Cf_actual', result.get('Cf', np.nan)))
    P_exit_actual = float(result.get('P_exit', np.nan))
    stability = result.get('stability_results', {})
    
    # Primary errors
    thrust_error = abs(F_actual - target_thrust) / target_thrust if (target_thrust > 0 and np.isfinite(F_actual)) else 1.0
    of_error = abs(MR_actual - optimal_of) / optimal_of if (optimal_of > 0 and np.isfinite(MR_actual)) else 1.0
    
    # Thrust penalty with 2% deadband (no penalty if within 2% error)
    thrust_penalty_sq_term = 0.0
    if target_thrust > 0 and np.isfinite(F_actual):
        rel_error = abs(F_actual - target_thrust) / target_thrust
        deadband = 0.02  # 2% tolerance

        if rel_error > deadband:
            # Strong penalty for exceeding deadband
            excess = rel_error - deadband
            thrust_penalty_sq_term += excess ** 2
    else:
        # Failed evaluation gets full penalty
        thrust_penalty_sq_term = 1.0
    
    _ins_q_raw = constants.get("layer1_exit_pressure_inside_quad_scale")
    exit_pressure_inside_quad_worker = (
        float(_ins_q_raw)
        if _ins_q_raw is not None and np.isfinite(float(_ins_q_raw))
        else _LAYER1_DEFAULT_EXIT_PRESSURE_INSIDE_QUAD
    )
    exit_pressure_sq_term = float(
        _layer1_exit_pressure_sq_term(
            float(P_exit_actual),
            float(target_P_exit),
            deadband_rel=0.05,
            inside_rel_quad_scale=exit_pressure_inside_quad_worker,
        )
    )
    
    # Stability checks
    stability_state = stability.get('stability_state', 'unstable')
    stability_score = float(stability.get('stability_score', 0.0))
    chugging_margin = max(0.0, float(stability.get('chugging', {}).get('stability_margin', 0.0)))
    acoustic_margin = max(0.0, float(stability.get('acoustic', {}).get('stability_margin', 0.0)))
    feed_margin = max(0.0, float(stability.get('feed_system', {}).get('stability_margin', 0.0)))
    
    min_stability_score_raw = float(requirements.get('min_stability_score', 0.75))
    stability_margin_handicap = float(requirements.get('stability_margin_handicap', 0.0))
    score_factor = max(0.0, 1.0 - stability_margin_handicap)
    margin_factor = max(0.0, 1.0 - stability_margin_handicap)
    effective_min_score = min_stability_score_raw * score_factor
    effective_margin = float(min_stability) * margin_factor
    
    require_stable_state = bool(requirements.get('require_stable_state', True))
    allowed_states = {'stable', 'marginal'}
    state_ok = (stability_state in allowed_states) if require_stable_state else (stability_state != 'unstable')
    
    if not state_ok:
        infeasibility_score += 1.0
    if effective_min_score > 0:
        infeasibility_score += max(0.0, (effective_min_score - stability_score) / effective_min_score) ** 2
    if effective_margin > 0:
        infeasibility_score += max(0.0, (effective_margin - chugging_margin) / effective_margin) ** 2
        infeasibility_score += max(0.0, (effective_margin - acoustic_margin) / effective_margin) ** 2
        infeasibility_score += max(0.0, (effective_margin - feed_margin) / effective_margin) ** 2
    
    # Regularization: Cf band
    def _hinge_band(val, lo, hi, scale=1.0):
        if val < lo:
            return ((lo - val) / scale) ** 2
        elif val > hi:
            return ((val - hi) / scale) ** 2
        return 0.0
    
    Cf_min_acceptable = 1.3
    Cf_max_acceptable = 1.8
    cf_hinge = _hinge_band(float(Cf_actual) if np.isfinite(Cf_actual) else 0.0,
                           Cf_min_acceptable, Cf_max_acceptable,
                           scale=(Cf_max_acceptable - Cf_min_acceptable))
    
    # Chamber length penalty
    # Compute L_chamber from geometry (same as in apply_x_to_config)
    from engine.core.chamber_geometry import chamber_length_calc, contraction_length_horizontal_calc
    R_chamber = D_chamber_inner / 2
    R_throat = np.sqrt(max(0, A_throat / np.pi))
    contraction_ratio = A_chamber_check / A_throat_check if A_throat_check > 0 else 10.0
    theta_contraction = np.pi / 4  # 45 degrees
    L_cylindrical = chamber_length_calc(
        chamber_volume=V_chamber,
        area_throat=A_throat,
        contraction_ratio=contraction_ratio,
        theta=theta_contraction,
    )
    L_contraction = contraction_length_horizontal_calc(
        area_chamber=A_chamber_check,
        entrance_arc_start_y=R_throat,  # nozzle entrance radius estimate
        theta=theta_contraction,
    )
    L_chamber_curr = L_cylindrical + L_contraction
    if L_chamber_curr <= 0 or not np.isfinite(L_chamber_curr):
        L_chamber_curr = V_chamber / A_chamber_check if A_chamber_check > 0 else 0.2
    # Keep identical to ``_layer1_apply_chamber_geometry_to_config`` (evaluate/config path).
    L_chamber_curr = float(np.clip(L_chamber_curr, 0.005, 1.0))
    
    max_chamber_length = float(requirements.get("max_chamber_length_m", 0.50))
    length_term = 0.0
    length_violation = False
    if np.isfinite(L_chamber_curr) and max_chamber_length > 0:
        if L_chamber_curr > max_chamber_length:
            # Hard constraint: treat as infeasibility
            length_violation = True
            length_term = ((L_chamber_curr - max_chamber_length) / max_chamber_length) ** 2
        else:
            # Soft penalty to guide optimizer away from the boundary
            length_term = max(0.0, (L_chamber_curr - max_chamber_length * 0.9) / (max_chamber_length * 0.1)) ** 2
    chamber_shape_term = 0.0
    
    # Lexicographic scalarization
    # Lexicographic scalarization (SCALED DOWN)
    BASE_INFEAS = 1e6
    W_INFEAS = 1e5
    W_THRUST = float(constants.get("layer1_W_THRUST", 1e4))
    W_OF = float(constants.get("layer1_W_OF", 1e4))
    w_of_low_mr = max(1.0, float(constants.get("layer1_W_OF_low_MR_scale", 1.0)))
    w_of_high_mr = max(1.0, float(constants.get("layer1_W_OF_high_MR_scale", 1.0)))
    W_CF = 1e2
    W_EXIT = 2.0e2
    W_LEN = 1e4  # Chamber length constraint (same weight as thrust/O/F)
    W_MOM = float(constants.get("W_MOM", 75.0))
    _mom_lo_c = constants.get("impinging_momentum_R_min")
    _mom_hi_c = constants.get("impinging_momentum_R_max")
    _ang_lo_c = constants.get("layer1_impinging_angle_deg_min")
    _ang_hi_c = constants.get("layer1_impinging_angle_deg_max")
    W_DP = float(constants.get("W_DP", 160.0))
    W_DP_O = float(constants.get("W_DP_O", W_DP))
    W_DP_F = float(constants.get("W_DP_F", W_DP))
    W_DP_HIGH = float(constants.get("W_DP_HIGH", 480.0))
    W_geom_ao_af = float(constants.get("W_geom_ao_af_momentum", 0.0))
    rho_ox_c = float(constants.get("rho_oxidizer", 1140.0))
    rho_fu_c = float(constants.get("rho_fuel", 422.6))
    dp_o_band = (
        float(constants.get("injector_dp_ratio_O_min", _LAYER1_DEFAULT_DP_O_BAND[0])),
        float(constants.get("injector_dp_ratio_O_max", _LAYER1_DEFAULT_DP_O_BAND[1])),
    )
    dp_f_band = (
        float(constants.get("injector_dp_ratio_F_min", _LAYER1_DEFAULT_DP_F_BAND[0])),
        float(constants.get("injector_dp_ratio_F_max", _LAYER1_DEFAULT_DP_F_BAND[1])),
    )
    _c_sf_raw = constants.get("injector_dp_ratio_O_soft_floor")
    dp_o_soft_floor_worker: Optional[float] = (
        float(_c_sf_raw)
        if _c_sf_raw is not None and np.isfinite(float(_c_sf_raw))
        else None
    )
    W_DP_O_FLOOR_worker = float(constants.get("W_DP_O_FLOOR", 0.0))
    W_SMD = float(constants.get("W_SMD", 0.0))
    W_ANGLE = float(constants.get("W_IMPINGING_ANGLE", 0.0))
    W_JET_ASYM = float(constants.get("W_IMPINGING_JET_ASYM", 0.0))
    _jet_asym_mx = constants.get("layer1_impinging_jet_angle_max_asym_deg")
    jet_asym_max = float(_jet_asym_mx) if _jet_asym_mx is not None else 28.0
    W_CHAMBER_SHAPE = float(constants.get("W_CHAMBER_SHAPE", 2500.0))
    CH_DT_MIN = float(constants.get("layer1_chamber_dt_ratio_min", 2.2))
    CH_DT_MAX = float(constants.get("layer1_chamber_dt_ratio_max", 3.2))
    CH_LD_MIN = float(constants.get("layer1_chamber_ld_ratio_min", 1.6))
    CH_LD_MAX = float(constants.get("layer1_chamber_ld_ratio_max", 3.2))
    target_smd_um = float(constants.get("target_smd_microns", 50.0))
    smd_rel_tol = float(constants.get("layer1_smd_rel_tol", 0.20))
    smd_corr_c = float(constants.get("layer1_impinging_smd_corr_C", 0.9))
    smd_corr_a = float(constants.get("layer1_impinging_smd_corr_a", 0.45))
    smd_corr_b = float(constants.get("layer1_impinging_smd_corr_b", 0.10))
    smd_phi_floor_deg = float(constants.get("layer1_impinging_smd_phi_floor_deg", 10.0))
    rho_liq = float(constants.get("rho_oxidizer", 1000.0))

    momentum_term = 0.0
    angle_term = 0.0
    jet_asym_term = 0.0
    if inj_type == "impinging" and isinstance(result, dict):
        diagnostics = result.get("diagnostics", {}) if isinstance(result.get("diagnostics"), dict) else {}
        R_val = diagnostics.get("momentum_ratio_R")
        if R_val is not None and np.isfinite(R_val) and float(R_val) > 0:
            _mlo = float(_mom_lo_c) if _mom_lo_c is not None else None
            _mhi = float(_mom_hi_c) if _mom_hi_c is not None else None
            momentum_term = _impinging_momentum_hinge_squared(
                R_val, r_band_lo=_mlo, r_band_hi=_mhi
            )
            # Momentum band is part of final validation; mirror that in feasibility search so
            # the optimizer cannot settle on a momentum-failing "best objective" point.
            infeasibility_score += _impinging_momentum_band_violation_squared(
                R_val, r_band_lo=_mlo, r_band_hi=_mhi
            )
        if W_ANGLE > 0.0:
            _alo = float(_ang_lo_c) if _ang_lo_c is not None else None
            _ahi = float(_ang_hi_c) if _ang_hi_c is not None else None
            angle_term = _impinging_angle_hinge_squared(
                diagnostics.get("impingement_angle_deg"),
                angle_band_lo_deg=_alo,
                angle_band_hi_deg=_ahi,
            )
        if W_JET_ASYM > 0.0:
            jet_asym_term = _impinging_jet_pair_asymmetry_squared(
                ang_O,
                ang_F,
                max_delta_deg=jet_asym_max,
            )
    if D_chamber_inner > 0 and D_throat_check > 0:
        chamber_shape_term += _relative_hinge_band_squared(
            D_chamber_inner / D_throat_check,
            CH_DT_MIN,
            CH_DT_MAX,
        )
    if D_chamber_inner > 0 and np.isfinite(L_chamber_curr) and L_chamber_curr > 0:
        chamber_shape_term += _relative_hinge_band_squared(
            L_chamber_curr / D_chamber_inner,
            CH_LD_MIN,
            CH_LD_MAX,
        )

    geom_ao_af_term = 0.0
    if inj_type == "impinging" and eval_success and W_geom_ao_af > 0.0 and A_fuel_injector > 0:
        geom_ao_af_term, _, _ = _geom_ao_af_momentum_hint_squared(
            float(A_lox_injector),
            float(A_fuel_injector),
            float(optimal_of),
            rho_ox_c,
            rho_fu_c,
        )
    # AO/AF geometry term is a guidance aid; taper it as O/F approaches target so it doesn't
    # dominate residual after core requirements are already satisfied.
    _of_tol_for_geom = float(constants.get("layer1_of_validation_tol", 0.15))
    _of_tol_for_geom = max(0.05, _of_tol_for_geom)
    _of_err_for_geom = of_error if np.isfinite(of_error) else 1.0
    geom_ao_af_scale = min(1.0, float(_of_err_for_geom / _of_tol_for_geom) ** 2)
    geom_ao_af_weighted = W_geom_ao_af * geom_ao_af_term * geom_ao_af_scale

    injector_dp_weighted = 0.0
    if isinstance(result, dict):
        _pc_obj = float(result.get("Pc", np.nan))
        if np.isfinite(_pc_obj) and _pc_obj > 0:
            _ro, _rf = injector_dp_ratios_from_eval_result(_pc_obj, result)
            injector_dp_weighted = injector_dp_ratio_penalty_weighted(
                _ro,
                _rf,
                W_DP,
                W_DP_HIGH,
                o_band=dp_o_band,
                f_band=dp_f_band,
                w_dp_o=W_DP_O,
                w_dp_f=W_DP_F,
                o_soft_floor=dp_o_soft_floor_worker,
                w_dp_o_floor=W_DP_O_FLOOR_worker,
            )

    smd_term = 0.0
    if inj_type == "impinging" and eval_success and W_SMD > 0.0 and isinstance(result, dict):
        _mr_smd = float(MR_actual) if np.isfinite(MR_actual) and MR_actual > 0 else None
        smd_term, _, _ = _impinging_smd_penalty_with_angle(
            result.get("diagnostics", {}) or {},
            target_smd_microns=target_smd_um,
            smd_rel_tol=smd_rel_tol,
            smd_corr_c=smd_corr_c,
            smd_corr_a=smd_corr_a,
            smd_corr_b=smd_corr_b,
            smd_phi_floor_deg=smd_phi_floor_deg,
            rho_l=rho_liq,
            mr_mass=_mr_smd,
        )

    if not np.isfinite(infeasibility_score) or infeasibility_score < 0:
        infeasibility_score = 1.0

    # Tiny squared stability/packing residuals can leave infeasibility_score > 0 while still being
    # practically feasible; that lexicographically masks thrust/O‑F/ΔP shaping (BASE_INFEAS plateaus).
    gate_eps = _requirement_float(requirements, "layer1_infeasibility_gate_eps", 0.0)
    inf_residual = max(0.0, float(infeasibility_score) - max(0.0, gate_eps))
    
    # Treat length violation as infeasibility (hard constraint)
    if length_violation:
        obj = BASE_INFEAS + W_INFEAS * length_term
    elif inf_residual > 0.0:
        obj = BASE_INFEAS + W_INFEAS * float(inf_residual)
    else:
        of_sq = float(of_error) ** 2
        if eval_success and np.isfinite(MR_actual) and optimal_of > 0:
            if MR_actual < optimal_of:
                of_sq *= w_of_low_mr
            elif MR_actual > optimal_of:
                of_sq *= w_of_high_mr
        obj = (
            W_THRUST * thrust_penalty_sq_term +
            W_OF * of_sq +
            W_CF * cf_hinge +
            W_EXIT * exit_pressure_sq_term +
            W_LEN * length_term +
            W_CHAMBER_SHAPE * chamber_shape_term +
            W_MOM * momentum_term +
            W_ANGLE * angle_term +
            W_JET_ASYM * jet_asym_term +
            geom_ao_af_weighted +
            W_SMD * smd_term +
            injector_dp_weighted
        )
    
    if not np.isfinite(obj):
        obj = BASE_INFEAS
    
    return float(obj)



def _eval_candidate(x_raw):
    """Pure evaluation function for parallel execution.
    
    Reuses worker's PintleEngineRunner by mutating its config in-place.
    Assumes x_raw is already snapped (integers) and within bounds (CMA-ES handles this).
    Returns lightweight scalar diagnostics only.
    
    Args:
        x_raw: Candidate vector (already snapped and bounded)
    
    Returns:
        dict with 'value', 'success', and optional diagnostics
    """
    try:
        # x_raw is already snapped and bounded - just convert to array
        x = np.asarray(x_raw, dtype=np.float64)
        
        # Apply x to runner's config IN-PLACE (no clipping, CMA-ES handles bounds)
        _apply_x_to_worker_config_inplace(x, _worker_runner.config, _worker_constants)
        
        # Extract pressures from x (indices depend on injector type)
        io = int(_worker_constants.get("idx_P_O", 8))
        iof = int(_worker_constants.get("idx_P_F", 9))
        P_O_psi = float(x[io])
        P_F_psi = float(x[iof])
        P_O_Pa = P_O_psi * 6894.76
        P_F_Pa = P_F_psi * 6894.76
        
        # Evaluate using worker's runner (reused across calls)
        result = _worker_runner.evaluate(
            P_O_Pa, P_F_Pa,
            P_ambient=_worker_constants['P_ambient'],
            debug=False,
            silent=True
        )
        
        # Compute objective value (pure function)
        obj_value = _compute_objective_value(result, x, _worker_requirements, _worker_constants)
        
        _f = float(result.get("F", 0))
        _mr = float(result.get("MR", 0))
        _tgt = float(_worker_constants.get("target_thrust", 7000.0))
        _oof = float(_worker_constants.get("optimal_of", 2.3))
        thr_e = abs(_f - _tgt) / _tgt if _tgt > 0 and np.isfinite(_f) else 1.0
        of_e = abs(_mr - _oof) / _oof if _oof > 0 and np.isfinite(_mr) else 1.0
        return {
            'value': float(obj_value),
            'success': True,
            'F': _f,
            'MR': _mr,
            'Pc': float(result.get('Pc', 0)),
            'full_results': copy.deepcopy(result),
            'P_O_Pa': float(P_O_Pa),
            'P_F_Pa': float(P_F_Pa),
            'thrust_error': float(thr_e),
            'of_error': float(of_e),
        }
    except Exception as e:
        if _worker_debug_strict:
            # Strict mode: re-raise to crash fast (for debugging)
            raise
        else:
            # Robust mode: return structured penalty
            # Classify error to give more useful feedback to optimizer/logger
            err_type = type(e).__name__
            err_msg = str(e).lower()
            
            # Base penalty for failed evaluation (much lower than 1e10 to avoid destroying covariance)
            # Feasible solutions are ~2e4 - 5e4
            penalty_base = 1.0e7
            
            # Categorize failure
            if "geometry" in err_msg or "bound" in err_msg:
                # Geometry/Bound violation (Critical but maybe structural)
                penalty_val = penalty_base * 1.0
                fail_reason = "GeometryViolation"
            elif "negative" in err_msg or "pressure" in err_msg or "choked" in err_msg:
                # Physics failure (Negative area, pressure, unchoked, etc.)
                penalty_val = penalty_base * 0.5  # Slightly "better" failure than total nonsense
                fail_reason = "PhysicsViolation"
            elif "solver" in err_msg or "convergence" in err_msg:
                # Numerical solver failure
                penalty_val = penalty_base * 0.2  # Least bad failure, might just be stiff region
                fail_reason = "SolverConvergence"
            else:
                # Unknown/Generic
                penalty_val = penalty_base * 0.8
                fail_reason = f"Error_{err_type}"

            return {
                'value': float(penalty_val),
                'success': False,
                'error_type': fail_reason,
                'error_msg': str(e)[:200],
            }


def _layer1_cma_warmstart_candidates(
    x0: np.ndarray,
    *,
    lower_bounds: np.ndarray,
    upper_bounds: np.ndarray,
    span: np.ndarray,
    integer_dims: List[int],
    rng: np.random.Generator,
    executor: Any,
    n_trials: int,
    sigma_frac: float,
    eval_cache: Dict[Any, Any],
    make_cache_key_fn: Callable[[np.ndarray], Any],
    opt_state: Dict[str, Any],
    logger: logging.Logger,
) -> Tuple[np.ndarray, float]:
    """Local cloud around ``x0`` using the **same** ``_eval_candidate`` path as CMA-ES.

    Picks the clipped/snapped vector with lowest scalar objective. This only replaces the
    CMA initial mean when ``n_trials > 0``; it does not alter ``_compute_objective_value``,
    validation gates, or final ``evaluate()`` physics.
    """
    x0_snap = _snap_integer_dims(
        np.clip(np.asarray(x0, dtype=float), lower_bounds, upper_bounds),
        integer_dims,
    )
    if n_trials <= 0:
        return x0_snap.copy(), float("inf")

    n_t = int(max(1, n_trials))
    candidates: List[np.ndarray] = [x0_snap.copy()]
    sig = float(max(sigma_frac, 0.0))
    scale = np.asarray(span, dtype=float)
    # Multi-ring perturbations (tighter + moderate + wider) to escape ``BASE_INFEAS`` plateau.
    fracs = (
        float(max(0.008, 0.45 * sig)),
        float(sig),
        float(min(0.22, max(sig * 1.65, sig + 0.02))),
    )
    for k in range(n_t - 1):
        f_k = fracs[k % len(fracs)]
        noise = rng.standard_normal(len(x0_snap)) * f_k * scale
        xq = np.clip(x0_snap + noise, lower_bounds, upper_bounds)
        candidates.append(_snap_integer_dims(xq, integer_dims))

    nw = int(getattr(executor, "_max_workers", 1) or 1)
    chunksize = max(1, len(candidates) // (nw * 4))
    results = list(executor.map(_eval_candidate, candidates, chunksize=chunksize))

    best_f = float("inf")
    best_x = x0_snap.copy()
    for cand, res in zip(candidates, results):
        obj_val = float(res["value"])
        cache_key = make_cache_key_fn(cand)
        eval_cache[cache_key] = {
            "value": obj_val,
            "success": bool(res.get("success", False)),
        }
        opt_state["function_evaluations"] = int(opt_state.get("function_evaluations", 0)) + 1
        _store_last_good_eval_bundle_from_worker_res(res, opt_state)
        if not res.get("success", True):
            reason = res.get("error_type", "Unknown")
            opt_state["num_failures"] = opt_state.get("num_failures", 0) + 1
            if "fail_counts" not in opt_state:
                opt_state["fail_counts"] = {}
            opt_state["fail_counts"][reason] = opt_state["fail_counts"].get(reason, 0) + 1
        if obj_val < best_f:
            best_f = obj_val
            best_x = cand.copy()

    logger.info(
        "Layer 1 CMA warm-start: %d candidates (sigma_frac=%.4g × span), best objective=%.6g",
        len(candidates),
        sigma_frac,
        best_f,
    )
    return best_x, best_f


def _layer1_sync_best_from_worker_eval(
    opt_state: Dict[str, Any],
    x_vec: np.ndarray,
    obj_val: float,
) -> None:
    """Keep ``best_objective`` / ``best_x`` aligned with parallel ``_eval_candidate`` results."""
    if not np.isfinite(obj_val):
        return
    cur = float(opt_state.get("best_objective", float("inf")))
    if obj_val < cur:
        opt_state["best_objective"] = float(obj_val)
        opt_state["best_x"] = np.asarray(x_vec, dtype=float).copy()
        opt_state["last_best_eval"] = int(opt_state.get("function_evaluations", 0))


def _layer1_emit_objective_plot_point(
    objective_callback: Optional[Callable[[int, float, float], None]],
    opt_state: Dict[str, Any],
    iteration: int,
    current_obj: float,
    best_obj: float,
) -> None:
    """SSE / UI objective curve (parallel CMA does not call ``objective()``)."""
    if objective_callback is None:
        return
    try:
        objective_callback(int(iteration), float(current_obj), float(best_obj))
    except Exception:
        pass


def run_layer1_global_search(
    objective: Callable[[np.ndarray], float],
    bounds: list,
    x0: np.ndarray,
    max_evals: int = 150,
    random_seed: int = 42,
) -> np.ndarray:
    """
    Lightweight global search for Layer 1 using random sampling + short DE.

    This is intended to very quickly improve the starting point before the
    main local optimizer (L-BFGS-B) runs in the orchestrator.

    - Keeps evaluation budget small (max_evals) to avoid long runtimes.
    - Always respects the provided bounds.
    - Falls back gracefully if scipy's differential_evolution is unavailable.
    """
    try:
        from scipy.optimize import differential_evolution
    except Exception:
        differential_evolution = None

    if max_evals <= 0 or objective is None:
        return x0

    rng = np.random.default_rng(random_seed)

    bounds_arr = np.asarray(bounds, dtype=float)
    lower = bounds_arr[:, 0]
    upper = bounds_arr[:, 1]

    # Ensure starting point is within bounds
    best_x = np.clip(np.asarray(x0, dtype=float), lower, upper)
    try:
        best_f = float(objective(best_x))
    except Exception:
        # If evaluation fails, just return the original guess
        return x0

    evals_used = 1
    dim = best_x.size

    # ------------------------------------------------------------------
    # Phase 1: Random sampling within bounds (very small number of points)
    # ------------------------------------------------------------------
    n_random = max(5, min(20, max_evals // 3))
    for _ in range(n_random):
        if evals_used >= max_evals:
            break
        candidate = lower + rng.random(dim) * (upper - lower)
        try:
            f_val = float(objective(candidate))
        except Exception:
            evals_used += 1
            continue
        evals_used += 1
        if np.isfinite(f_val) and f_val < best_f:
            best_f = f_val
            best_x = candidate

    # ------------------------------------------------------------------
    # Phase 2: Very short Differential Evolution (if available)
    # ------------------------------------------------------------------
    if differential_evolution is not None and evals_used < max_evals:
        # Rough heuristic to keep DE cheap; cap iterations and population.
        # For typical Layer 1 dimensionality (~20 vars) this keeps runtime modest.
        remaining_evals = max_evals - evals_used
        popsize = 8
        # Each DE iter uses approximately popsize * dim evaluations
        approx_evals_per_iter = max(1, popsize * dim)
        maxiter = max(1, min(5, remaining_evals // approx_evals_per_iter))

        if maxiter > 0:
            # Wrap objective to track best solution without exceeding budget
            def wrapped_obj(v: np.ndarray) -> float:
                nonlocal best_x, best_f, evals_used
                if evals_used >= max_evals:
                    # Return current best to encourage convergence without new work
                    return best_f
                try:
                    f_val_inner = float(objective(v))
                except Exception:
                    evals_used += 1
                    return 1e7
                evals_used += 1
                if np.isfinite(f_val_inner) and f_val_inner < best_f:
                    best_f = f_val_inner
                    best_x = np.asarray(v, dtype=float)
                return f_val_inner

            try:
                _ = differential_evolution(
                    wrapped_obj,
                    bounds=bounds,
                    maxiter=maxiter,
                    popsize=popsize,
                    tol=0.01,
                    polish=False,
                    updating="deferred",
                    mutation=(0.5, 1.0),
                    recombination=0.7,
                    seed=random_seed,
                )
            except Exception:
                # If DE fails for any reason, just keep the best point found so far.
                pass

    return best_x


def run_layer1_optimization(
    config_obj: PintleEngineConfig,
    runner: PintleEngineRunner,
    requirements: Dict[str, Any],
    target_burn_time: float,
    tolerances: Dict[str, float],
    pressure_config: Dict[str, Any],
    update_progress: Optional[Callable[[str, float, str], None]] = None,
    log_status: Optional[Callable[[str, str], None]] = None,
    objective_callback: Optional[Callable[[int, float, float], None]] = None,
    stop_event: Optional[Any] = None,  # threading.Event for stop signal
    layer1_max_iterations: Optional[int] = None,
    layer1_cma_restarts: Optional[int] = None,
    layer1_smoke: bool = False,
) -> Tuple[PintleEngineConfig, Dict[str, Any]]:
    """
    Run complete Layer 1 optimization: geometry + initial tank pressures.
    
    This function contains ALL Layer 1 optimization logic:
    - Setup (bounds, initial guess)
    - Objective function definition
    - Optimization loop (CMA-ES with random restarts + L-BFGS-B)
    - Validation
    - Results packaging
    
    Note:
        Default ``max_iterations`` is 150 for robust convergence (override via ``layer1_max_iterations``
        for smoke tests). Design vector is **10** DOFs for pintle and **13** for impinging injectors
        (paired unlike doublets: shared ``n_doublets`` for LOX/fuel counts, independent jets per side).
        Random CMA restarts default to 3 (override via ``layer1_cma_restarts``).
        Set ``layer1_smoke=True`` to force pure CMA-ES (ignore ``hybrid_cma_blocks``) and,
        unless ``layer1_cma_restarts`` is set explicitly, use a single CMA restart for short runs.

    Args:
        config_obj: Base engine configuration
        runner: Engine runner (for validation)
        requirements: Design requirements dict
        target_burn_time: Target burn time [s]
        tolerances: Tolerance dict (thrust, apogee)
        pressure_config: Pressure configuration dict
        update_progress: Optional progress callback (stage, progress, message)
        log_status: Optional status logging callback (stage, message)
        objective_callback: Optional callback for objective history (iteration, objective, best_objective)
        layer1_smoke: When True, force pure CMA-ES and (if ``layer1_cma_restarts`` is unset) a single restart.

    Returns:
        optimized_config: Optimized engine configuration
        results: Results dict with performance, validation, history, etc.
    """
 
    # Set up Layer 1 logging
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    # Ensure output/logs directory exists
    output_logs_dir = Path(__file__).resolve().parents[3] / "output" / "logs"
    output_logs_dir.mkdir(parents=True, exist_ok=True)
    log_file_path = output_logs_dir / f"layer1_static_{timestamp}.log"
    
    # Create logger for Layer 1
    layer1_logger = logging.getLogger('layer1_static')
    layer1_logger.setLevel(logging.INFO)
    
    # Remove existing handlers to avoid duplicates
    layer1_logger.handlers.clear()
    
    # File handler
    file_handler = logging.FileHandler(log_file_path, mode='w', encoding='utf-8')
    file_handler.setLevel(logging.INFO)
    file_formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
    file_handler.setFormatter(file_formatter)
    layer1_logger.addHandler(file_handler)
    
    # Prevent propagation to root logger
    layer1_logger.propagate = False
    
    layer1_logger.info("="*70)
    layer1_logger.info("Layer 1: Static Optimization")
    layer1_logger.info("="*70)
    layer1_logger.info(f"Log file: {log_file_path}")
    
    # Default callbacks
    if update_progress is None:
        def update_progress(stage: str, progress: float, message: str):
            pass
    if log_status is None:
        def log_status(stage: str, message: str):
            pass
    
    # Helper to check stop event
    class OptimizationStopped(Exception):
        """Exception raised when optimization is stopped by user."""
        pass
    
    def check_stop():
        """Check if optimization should stop and raise exception if so."""
        if stop_event is not None and stop_event.is_set():
            raise OptimizationStopped("Optimization stopped by user")
    
    # Extract requirements
    target_thrust = requirements.get("target_thrust", 7000.0)
    optimal_of = requirements.get("optimal_of_ratio", 2.3)
    min_stability = float(requirements.get("min_stability_margin", _LAYER1_DEFAULT_MIN_STABILITY_MARGIN))

    def _resolve_Lstar_bounds_from_req_and_config() -> Tuple[float, float]:
        """Layer‑1 DOF ``x[1]`` is L* [m]. Prefer ``requirements``; fill missing keys from ``config_obj.design_requirements``."""
        mn_raw = requirements.get("min_Lstar", None)
        mx_raw = requirements.get("max_Lstar", None)
        try:
            dr = getattr(config_obj, "design_requirements", None)
            if mn_raw is None and dr is not None:
                mn_raw = getattr(dr, "min_Lstar", None)
            if mx_raw is None and dr is not None:
                mx_raw = getattr(dr, "max_Lstar", None)
        except (TypeError, ValueError, AttributeError):
            pass
        try:
            mn = float(mn_raw) if mn_raw is not None else 0.95
        except (TypeError, ValueError):
            mn = 0.95
        try:
            mx = float(mx_raw) if mx_raw is not None else 1.27
        except (TypeError, ValueError):
            mx = 1.27
        if not np.isfinite(mn) or mn <= 0:
            mn = 0.95
        if not np.isfinite(mx) or mx <= 0:
            mx = 1.27
        if mx <= mn:
            mx = mn + 1e-6
        return mn, mx

    min_Lstar, max_Lstar = _resolve_Lstar_bounds_from_req_and_config()
    layer1_logger.info(
        "Layer 1 optimizing L* [m] within [%.5f, %.5f] (x[1]); freeze ``design_requirements.frozen_parameters.Lstar_mm`` for a single target.",
        min_Lstar,
        max_Lstar,
    )

    max_chamber_od = requirements.get("max_chamber_outer_diameter", 0.15)
    max_nozzle_exit = requirements.get("max_nozzle_exit_diameter", 0.101)
    thrust_tol = tolerances.get("thrust", 0.10)
    
    # Calculate target exit pressure from environment config (GPS/GFS-derived atmospheric pressure)
    # Use standard atmosphere model based on elevation if environment config is available
    target_P_exit = 101325.0  # Default: sea level (1 atm)
    if hasattr(config_obj, 'environment') and config_obj.environment is not None:
        elevation = getattr(config_obj.environment, 'elevation', 0.0)
        if elevation is not None and elevation >= 0:
            # Standard atmosphere model: P = P0 * exp(-M*g*h/(R*T0))
            # P0 = 101325 Pa (sea level)
            # M = 0.0289644 kg/mol (molar mass of dry air)
            # g = 9.80665 m/s² (standard gravity)
            # R = 8.31447 J/(mol·K) (universal gas constant)
            # T0 = 288.15 K (sea level temperature)
            P0 = 101325.0  # Pa
            M = 0.0289644  # kg/mol
            g = 9.80665    # m/s²
            R = 8.31447    # J/(mol·K)
            T0 = 288.15    # K
            target_P_exit = P0 * np.exp(-M * g * elevation / (R * T0))
            layer1_logger.info(f"Using atmospheric pressure from elevation: {elevation:.1f} m -> {target_P_exit:.1f} Pa ({target_P_exit/101325.0:.3f} atm)")
    else:
        layer1_logger.info(f"Environment config not available, using default sea level pressure: {target_P_exit:.1f} Pa")
    
    layer1_logger.info(f"Target thrust: {target_thrust:.1f} N")
    layer1_logger.info(f"Target O/F ratio: {optimal_of:.2f}")
    layer1_logger.info(f"Min stability margin: {min_stability:.2f}")
    layer1_logger.info(f"Target burn time: {target_burn_time:.2f} s")
    
    # Default max_iterations for robust convergence (10-DOF pintle / 13-DOF impinging geometry + pressures)
    # With popsize ~48: many evaluations per CMA iteration unless clamped for smoke tests.
    max_iterations = 150
    if layer1_max_iterations is not None:
        max_iterations = max(1, int(layer1_max_iterations))

    layer1_logger.info(f"Max iterations: {max_iterations}")
    layer1_logger.info("")
    
    # Get max pressures (stagnation search must never exceed these [psi]).
    max_lox_P_psi = float(pressure_config.get("max_lox_pressure_psi", 700))
    max_fuel_P_psi = float(pressure_config.get("max_fuel_pressure_psi", 850))
    # Defensive: if anything passed a looser pressure_config than ``config_obj.design_requirements``,
    # use the stricter of the two (common when requirements are edited in the UI but a stale field lingers).
    try:
        _dr_cap = getattr(config_obj, "design_requirements", None)
        if _dr_cap is not None:
            _lox_cap = getattr(_dr_cap, "max_lox_tank_pressure_psi", None)
            if _lox_cap is not None and float(_lox_cap) > 0.0:
                max_lox_P_psi = min(max_lox_P_psi, float(_lox_cap))
            _f_cap = getattr(_dr_cap, "max_fuel_tank_pressure_psi", None)
            if _f_cap is not None and float(_f_cap) > 0.0:
                max_fuel_P_psi = min(max_fuel_P_psi, float(_f_cap))
    except (TypeError, ValueError, AttributeError):
        pass
    layer1_logger.info(
        "Layer 1 tank stagnation caps (psi): max LOX=%.1f, max fuel=%.1f",
        max_lox_P_psi,
        max_fuel_P_psi,
    )
    psi_to_Pa = 6894.76
    
    # Objective tolerance for early stopping (weighted scalar; see ``primary_relative_residual`` for physics scale)
    obj_tolerance = 2.0  # For good solution: obj ≈ 1.25, so 2.0 is reasonable
    layer1_lbfgs_gtol = float(max(1e-15, _requirement_float(requirements, "layer1_lbfgs_gtol", 1e-9)))
    _lbfgs_2 = requirements.get("layer1_lbfgs_second_pass")
    layer1_lbfgs_second_pass = True if _lbfgs_2 is None else bool(_lbfgs_2)
    
    update_progress("Layer 1: Setup", 0.01, "Initializing Layer 1 optimization...")
    
    # Prepare base config
    config_base = copy.deepcopy(config_obj)
    if hasattr(config_base, 'injector') and config_base.injector.type == "pintle":
        if hasattr(config_base.injector.geometry, 'lox'):
            config_base.injector.geometry.lox.theta_orifice = 90.0

    l1_injector_type = getattr(getattr(config_base, "injector", None), "type", "pintle")
    if l1_injector_type not in ("pintle", "impinging"):
        raise ValueError(
            "Layer 1 static optimization supports injector types 'pintle' and 'impinging' only; "
            f"got {l1_injector_type!r}."
        )
    idx_P_O = 11 if l1_injector_type == "impinging" else 8
    idx_P_F = 12 if l1_injector_type == "impinging" else 9
    layer1_integer_dims = [4] if l1_injector_type == "impinging" else [6]
    
    # Enable turbulence coupling
    if hasattr(config_base, 'combustion') and hasattr(config_base.combustion, 'efficiency'):
        config_base.combustion.efficiency.use_turbulence_coupling = True
    
    # Calculate initial A_throat guess
    Pc_est_psi = 580.0
    Pc_est = Pc_est_psi * psi_to_Pa
    Cf_est = 1.5
    A_throat_init = target_thrust / (Cf_est * Pc_est) if Pc_est > 0 else 0.001
    A_throat_init = np.clip(A_throat_init, 5e-5, 3.0e-3)
    
    # Calculate bounds ensuring injector area < throat area (pintle) or manufacturable jets (impinging)
    min_A_throat_safe = 5e-5

    # Stagnation-pressure search box: fractions of respective tank caps (independent LOX vs fuel).
    # Equal optimizer values (e.g. 720/720 psi) can occur when caps and fractions match and the objective is symmetric —
    # there is **no** equality constraint forcing P_O == P_F.
    min_P_ratio = float(requirements.get("layer1_stagnation_pressure_frac_min") or 0.65)
    max_P_ratio = float(requirements.get("layer1_stagnation_pressure_frac_max") or 0.85)
    if max_P_ratio <= min_P_ratio:
        max_P_ratio = min_P_ratio + 1e-3
    exp_ratio_lo = _requirement_float(requirements, "layer1_expansion_ratio_min", 4.0)
    exp_ratio_hi = _requirement_float(requirements, "layer1_expansion_ratio_max", 12.0)
    if exp_ratio_hi <= exp_ratio_lo:
        exp_ratio_hi = exp_ratio_lo + 1e-3

    # Throat floor from target thrust and available pressure envelope.
    # Prevents optimizer spending budget in clearly unreachable tiny-throat basins.
    _cf_hi_for_floor = _requirement_float(requirements, "layer1_cf_upper_bound_for_throat_floor", 1.8)
    _pc_floor_factor = _requirement_float(requirements, "layer1_pc_fraction_for_throat_floor", 0.75)
    _pc_cap_psi = min(max_lox_P_psi * max_P_ratio, max_fuel_P_psi * max_P_ratio)
    _pc_cap_pa = _pc_cap_psi * psi_to_Pa * max(0.1, _pc_floor_factor)
    if target_thrust > 0 and _pc_cap_pa > 0 and _cf_hi_for_floor > 0:
        _a_req = target_thrust / (_cf_hi_for_floor * _pc_cap_pa)
        if np.isfinite(_a_req) and _a_req > 0:
            # Keep some slack below the rough feasibility line.
            min_A_throat_safe = max(min_A_throat_safe, 0.7 * float(_a_req))
            layer1_logger.info(
                "A_throat lower bound raised by thrust-feasibility floor: %.2f mm^2 "
                "(target %.0f N, Pc_cap≈%.1f psi, Cf_hi=%.2f)",
                min_A_throat_safe * 1e6,
                target_thrust,
                _pc_cap_psi,
                _cf_hi_for_floor,
            )
    min_outer_diameter = max_chamber_od * 0.5

    if l1_injector_type == "impinging":
        D_inner_bounds = impinging_chamber_inner_diameter_for_bounds(
            config_base,
            max_chamber_outer_diameter_m=max_chamber_od,
            wall_thickness_m=TOTAL_WALL_THICKNESS_M,
        )
        n_hi_int = impinging_n_elements_hi_int(D_inner_bounds)
        _nd_cap = requirements.get("layer1_impinging_n_doublets_max")
        if _nd_cap is not None:
            try:
                _c = int(_nd_cap)
                if _c >= 5:
                    n_hi_int = min(n_hi_int, _c)
            except (TypeError, ValueError):
                pass
        # Upper continuous edge so clip→round cannot exceed n_hi_int (avoid legacy +3.99 overrun).
        n_hi_upper = float(n_hi_int) + 0.499
        d_jet_hi = impinging_d_jet_upper_bound_m(D_inner_bounds)
        spacing_hi = impinging_spacing_upper_bound_m(D_inner_bounds)
        layer1_logger.info(
            f"Impinging injector bounds from chamber bore D_inner≈{D_inner_bounds*1000:.2f} mm: "
            f"n_doublets ≤ {n_hi_int} (hard int cap via search box), "
            f"d_jet ≤ {d_jet_hi*1000:.2f} mm, spacing ≤ {spacing_hi*1000:.2f} mm"
        )
        bounds = [
            (min_A_throat_safe, 4.0e-3),
            (min_Lstar, max_Lstar),
            (exp_ratio_lo, exp_ratio_hi),
            (min_outer_diameter, max_chamber_od),
            (5.0, n_hi_upper),
            (0.0005, d_jet_hi),
            (15.0, 85.0),
            (0.003, spacing_hi),
            (0.0005, d_jet_hi),
            (15.0, 85.0),
            (0.003, spacing_hi),
            (max_lox_P_psi * min_P_ratio, max_lox_P_psi * max_P_ratio),
            (max_fuel_P_psi * min_P_ratio, max_fuel_P_psi * max_P_ratio),
        ]
    else:
        max_n_orifices = 14
        max_d_orifice = 0.003
        max_LOX_area = max_n_orifices * np.pi * (max_d_orifice / 2) ** 2
        max_d_pintle = 0.040
        max_h_gap = 0.0015
        R_inner_max = max_d_pintle / 2
        R_outer_max = R_inner_max + max_h_gap
        max_fuel_area = np.pi * (R_outer_max ** 2 - R_inner_max ** 2)
        max_injector_area = max(max_LOX_area, max_fuel_area)

        bounds = [
            (min_A_throat_safe, 4.0e-3),
            (min_Lstar, max_Lstar),
            (exp_ratio_lo, exp_ratio_hi),
            (min_outer_diameter, max_chamber_od),
            (0.006, 0.040),
            (0.0003, 0.0015),
            (14, 14.1),
            (0.001, 0.004),
            (max_lox_P_psi * min_P_ratio, max_lox_P_psi * max_P_ratio),
            (max_fuel_P_psi * min_P_ratio, max_fuel_P_psi * max_P_ratio),
        ]

    # Optional explicit stagnation-pressure ranges [psi] for x[idx_P_O], x[idx_P_F]
    # (overrides default 65–85% of max_lox_pressure_psi / max_fuel_pressure_psi bands).
    _p_o_min = requirements.get("layer1_P_O_start_psi_min")
    _p_o_max = requirements.get("layer1_P_O_start_psi_max")
    if _p_o_min is not None and _p_o_max is not None:
        lo_p, hi_p = float(_p_o_min), min(float(_p_o_max), max_lox_P_psi)
        lo_p = min(lo_p, hi_p)
        if hi_p > lo_p:
            bounds[idx_P_O] = (lo_p, hi_p)
    _p_f_min = requirements.get("layer1_P_F_start_psi_min")
    _p_f_max = requirements.get("layer1_P_F_start_psi_max")
    if _p_f_min is not None and _p_f_max is not None:
        lo_pf, hi_pf = float(_p_f_min), min(float(_p_f_max), max_fuel_P_psi)
        lo_pf = min(lo_pf, hi_pf)
        if hi_pf > lo_pf:
            bounds[idx_P_F] = (lo_pf, hi_pf)

    # Hard ceiling: optimized stagnation cannot exceed allowable tank pressures [psi].
    _o_lo, _o_hi = bounds[idx_P_O]
    bounds[idx_P_O] = (float(min(_o_lo, max_lox_P_psi)), float(min(_o_hi, max_lox_P_psi)))
    if bounds[idx_P_O][0] > bounds[idx_P_O][1]:
        bounds[idx_P_O] = (bounds[idx_P_O][1], bounds[idx_P_O][0])
    _f_lo, _f_hi = bounds[idx_P_F]
    bounds[idx_P_F] = (float(min(_f_lo, max_fuel_P_psi)), float(min(_f_hi, max_fuel_P_psi)))
    if bounds[idx_P_F][0] > bounds[idx_P_F][1]:
        bounds[idx_P_F] = (bounds[idx_P_F][1], bounds[idx_P_F][0])

    # Calculate initial guess
    # Check if we can use the input config as the starting point (x0)
    # This key feature allows the user to providing a "good guess" to speed up optimization
    has_valid_start_geom = False
    
    # Extract candidate values from config
    try:
        # Helper to safely get float > 0
        def _get_val(obj, attr, default=None):
            val = getattr(obj, attr, default)
            return float(val) if val is not None and val > 0 else None

        # Chamber/Nozzle Geometry
        # Try chamber_geometry first, then legacy sections
        cg_in = getattr(config_obj, 'chamber_geometry', None)
        c_in = getattr(config_obj, 'chamber', None)
        n_in = getattr(config_obj, 'nozzle', None)
        
        A_throat_in = _get_val(cg_in, 'A_throat') or _get_val(c_in, 'A_throat') or _get_val(n_in, 'A_throat')
        Lstar_in = _get_val(cg_in, 'Lstar') or _get_val(c_in, 'Lstar')
        eps_in = _get_val(cg_in, 'expansion_ratio') or _get_val(n_in, 'expansion_ratio')
        # Inner diameter -> Outer diameter
        D_inner_in = _get_val(cg_in, 'chamber_diameter') or _get_val(c_in, 'chamber_inner_diameter')
        
        # Injector Geometry
        inj_in = getattr(config_obj, 'injector', None)
        inj_geom = getattr(inj_in, 'geometry', None)
        is_pintle = (getattr(inj_in, 'type', '') == 'pintle')
        is_impinging = (getattr(inj_in, 'type', '') == 'impinging')

        d_pintle_in = h_gap_in = n_orifices_in = d_orifice_in = None
        n_O_in = d_jet_O_in = ang_O_in = sp_O_in = None
        n_F_in = d_jet_F_in = ang_F_in = sp_F_in = None

        if is_pintle and inj_geom:
            fuel_in = getattr(inj_geom, 'fuel', None)
            lox_in = getattr(inj_geom, 'lox', None)

            d_pintle_in = _get_val(fuel_in, 'd_pintle_tip')
            h_gap_in = _get_val(fuel_in, 'h_gap')
            n_orifices_in = _get_val(lox_in, 'n_orifices')
            d_orifice_in = _get_val(lox_in, 'd_orifice')
        elif is_impinging and inj_geom:
            ox_in = getattr(inj_geom, 'oxidizer', None)
            fu_in = getattr(inj_geom, 'fuel', None)
            if ox_in and fu_in:
                n_O_in = getattr(ox_in, 'n_elements', None)
                n_F_in = getattr(fu_in, 'n_elements', None)
                n_doublets_in = None
                if n_O_in is not None and float(n_O_in) > 0:
                    no_i = int(n_O_in)
                    if n_F_in is not None and float(n_F_in) > 0:
                        nf_i = int(n_F_in)
                        if nf_i != no_i:
                            layer1_logger.warning(
                                "Impinging YAML n_elements_O (%s) != n_elements_F (%s); paired doublets "
                                "use one n_doublets — Layer-1 x0 uses min(O,F)=%s.",
                                no_i,
                                nf_i,
                                min(no_i, nf_i),
                            )
                        n_doublets_in = min(no_i, nf_i)
                    else:
                        n_doublets_in = no_i
                elif n_F_in is not None and float(n_F_in) > 0:
                    n_doublets_in = int(n_F_in)
                d_jet_O_in = _get_val(ox_in, 'd_jet')
                ang_O_in = _get_val(ox_in, 'impingement_angle')
                sp_O_in = _get_val(ox_in, 'spacing')
                d_jet_F_in = _get_val(fu_in, 'd_jet')
                ang_F_in = _get_val(fu_in, 'impingement_angle')
                sp_F_in = _get_val(fu_in, 'spacing')

        pintle_complete = (
            is_pintle
            and all(
                v is not None
                for v in [
                    A_throat_in,
                    Lstar_in,
                    eps_in,
                    D_inner_in,
                    d_pintle_in,
                    h_gap_in,
                    n_orifices_in,
                    d_orifice_in,
                ]
            )
        )
        imp_complete = (
            is_impinging
            and all(
                v is not None
                for v in [
                    A_throat_in,
                    Lstar_in,
                    eps_in,
                    D_inner_in,
                    n_doublets_in,
                    d_jet_O_in,
                    ang_O_in,
                    sp_O_in,
                    d_jet_F_in,
                    ang_F_in,
                    sp_F_in,
                ]
            )
        )

        if pintle_complete:
            A_throat_init = A_throat_in
            Lstar_init = Lstar_in
            eps_init = eps_in
            outer_diameter_init = D_inner_in + TOTAL_WALL_THICKNESS_M

            default_d_pintle = d_pintle_in
            default_h_gap = h_gap_in
            default_n_orifices = int(n_orifices_in)
            default_d_orifice = d_orifice_in

            has_valid_start_geom = True
            layer1_logger.info("Using values from input configuration as initial guess (x0).")

        elif imp_complete:
            A_throat_init = A_throat_in
            Lstar_init = Lstar_in
            eps_init = eps_in
            outer_diameter_init = D_inner_in + TOTAL_WALL_THICKNESS_M

            default_n_doublets = int(n_doublets_in)
            default_d_jet_O = float(d_jet_O_in)
            default_d_jet_F = float(d_jet_F_in)
            default_ang_O = float(ang_O_in)
            default_ang_F = float(ang_F_in)
            default_sp_O = float(sp_O_in)
            default_sp_F = float(sp_F_in)

            has_valid_start_geom = True
            layer1_logger.info("Using impinging injector geometry from input configuration as initial guess (x0).")

        else:
            layer1_logger.info("Input configuration incomplete/invalid for x0. Using heuristic defaults.")

    except Exception as e:
        layer1_logger.warning(f"Failed to extract x0 from config: {e}. Using defaults.")
        has_valid_start_geom = False

    if not has_valid_start_geom:
        if l1_injector_type == "impinging":
            default_n_doublets = 12
            default_d_jet_O = 0.002
            default_d_jet_F = 0.002
            default_ang_O = 45.0
            default_ang_F = 45.0
            default_sp_O = 0.012
            default_sp_F = 0.012
            A_lox_est = default_n_doublets * np.pi * (default_d_jet_O / 2.0) ** 2
            A_fuel_est = default_n_doublets * np.pi * (default_d_jet_F / 2.0) ** 2
            max_injector_area_est = max(A_lox_est, A_fuel_est)
            A_throat_min_safe = max_injector_area_est * 1.15
            A_throat_init = max(A_throat_init, A_throat_min_safe)
            Lstar_init = (min_Lstar + max_Lstar) / 2
            eps_init = 8.0
            outer_diameter_init = np.clip(max_chamber_od * 0.55, min_outer_diameter, max_chamber_od)
        else:
            default_n_orifices = 14
            default_d_orifice = 0.002
            default_d_pintle = 0.016
            default_h_gap = 0.0006

            A_lox_est = default_n_orifices * np.pi * (default_d_orifice / 2) ** 2
            R_inner_est = default_d_pintle / 2
            R_outer_est = R_inner_est + default_h_gap
            A_fuel_est = np.pi * (R_outer_est ** 2 - R_inner_est ** 2)
            max_injector_area_est = max(A_lox_est, A_fuel_est)

            A_throat_min_safe = max_injector_area_est * 1.1
            A_throat_init = max(A_throat_init, A_throat_min_safe)

            Lstar_init = (min_Lstar + max_Lstar) / 2
            eps_init = 8.0
            outer_diameter_init = np.clip(max_chamber_od * 0.55, min_outer_diameter, max_chamber_od)

    # Clean up variables for array creation
    A_throat_init = np.clip(A_throat_init, 5e-5, 3.0e-3)

    P_O_start_init = max_lox_P_psi * 0.80
    P_F_start_init = max_fuel_P_psi * 0.80
    P_O_start_init = float(np.clip(P_O_start_init, bounds[idx_P_O][0], bounds[idx_P_O][1]))
    P_F_start_init = float(np.clip(P_F_start_init, bounds[idx_P_F][0], bounds[idx_P_F][1]))

    if l1_injector_type == "impinging":
        x0 = np.array([
            A_throat_init,
            Lstar_init if 'Lstar_init' in locals() else (min_Lstar + max_Lstar) / 2,
            eps_init if 'eps_init' in locals() else 8.0,
            outer_diameter_init,
            float(default_n_doublets),
            default_d_jet_O,
            default_ang_O,
            default_sp_O,
            default_d_jet_F,
            default_ang_F,
            default_sp_F,
            P_O_start_init,
            P_F_start_init,
        ])
    else:
        x0 = np.array([
            A_throat_init,
            Lstar_init if 'Lstar_init' in locals() else (min_Lstar + max_Lstar) / 2,
            eps_init if 'eps_init' in locals() else 8.0,
            outer_diameter_init,
            default_d_pintle,
            default_h_gap,
            default_n_orifices,
            default_d_orifice,
            P_O_start_init,
            P_F_start_init,
        ])
    
    # =========================================================================
    # Handle Frozen Parameters from Design Requirements
    # =========================================================================
    # If user has specified frozen_parameters, pin those values by:
    # 1. Setting bounds to [value, value] (prevents CMA-ES from exploring)
    # 2. Setting x0 to the frozen value
    # Frozen parameters use user-friendly units and are converted to SI here.
    #
    # ``requirements`` often comes from ``design_requirements.model_dump()`` via the API. If the UI
    # saved a document without nested ``frozen_parameters`` (or with an empty dict), we must not
    # drop pins that still exist on ``config_base.design_requirements`` from the loaded YAML.
    def _frozen_param_nonempty(fp: Any) -> bool:
        return isinstance(fp, dict) and any(v is not None for v in fp.values())

    _fp_req = requirements.get("frozen_parameters")
    _fp_cfg: Dict[str, Any] = {}
    dr0 = getattr(config_base, "design_requirements", None)
    if dr0 is not None and dr0.frozen_parameters is not None:
        _fp_cfg = dr0.frozen_parameters.model_dump(exclude_none=True)
    if _fp_cfg:
        if not _frozen_param_nonempty(_fp_req):
            requirements = dict(requirements)
            requirements["frozen_parameters"] = dict(_fp_cfg)
        elif isinstance(_fp_req, dict):
            merged_fp = dict(_fp_cfg)
            for _k, _v in _fp_req.items():
                if _v is not None:
                    merged_fp[_k] = _v
            requirements = dict(requirements)
            requirements["frozen_parameters"] = merged_fp

    frozen = requirements.get("frozen_parameters", {}) or {}
    frozen_param_names = []
    
    # Map frozen parameters to their x-vector indices and unit conversions
    # Index | Parameter name          | Frozen key         | Conversion
    # ------+-------------------------+--------------------+------------
    #  0    | A_throat [m²]           | A_throat_mm2       | mm² -> m² (*1e-6)
    #  1    | Lstar [m]               | Lstar_mm           | mm -> m (*1e-3)
    #  2    | expansion_ratio [-]     | expansion_ratio    | none
    #  3    | D_chamber_outer [m]     | D_chamber_outer_mm | mm -> m (*1e-3)
    #
    # Pintle continues: 4=d_pintle_tip, 5=h_gap, 6=n_orifices, 7=d_orifice, 8-9 pressures.
    #
    # Impinging (paired unlike doublets — see frozen_mapping below): 4=n_doublets (int),
    # 5–7 LOX jet, 8–10 fuel jet, 11–12 pressures.
    #
    #  4    | d_pintle_tip [m]        | d_pintle_tip_mm    | mm -> m (*1e-3)  # pintle only
    #  5    | h_gap [m]               | h_gap_mm           | mm -> m (*1e-3)
    #  6    | n_orifices [-]          | n_orifices         | none (int)
    #  7    | d_orifice [m]           | d_orifice_mm       | mm -> m (*1e-3)
    #  8    | P_O_start [psi]         | P_O_start_psi      | none
    #  9    | P_F_start [psi]         | P_F_start_psi      | none
    
    if l1_injector_type == "impinging":
        frozen_mapping = [
            ("A_throat_mm2", 1e-6),
            ("Lstar_mm", 1e-3),
            ("expansion_ratio", 1.0),
            ("D_chamber_outer_mm", 1e-3),
            ("n_doublets", 1.0),
            ("d_jet_O_mm", 1e-3),
            ("impingement_angle_O_deg", 1.0),
            ("spacing_O_mm", 1e-3),
            ("d_jet_F_mm", 1e-3),
            ("impingement_angle_F_deg", 1.0),
            ("spacing_F_mm", 1e-3),
            ("P_O_start_psi", 1.0),
            ("P_F_start_psi", 1.0),
        ]
    else:
        frozen_mapping = [
            ("A_throat_mm2", 1e-6),
            ("Lstar_mm", 1e-3),
            ("expansion_ratio", 1.0),
            ("D_chamber_outer_mm", 1e-3),
            ("d_pintle_tip_mm", 1e-3),
            ("h_gap_mm", 1e-3),
            ("n_orifices", 1.0),
            ("d_orifice_mm", 1e-3),
            ("P_O_start_psi", 1.0),
            ("P_F_start_psi", 1.0),
        ]

    int_keys = {"n_orifices", "n_doublets"}

    for idx, (key, conversion) in enumerate(frozen_mapping):
        frozen_val = frozen.get(key)
        if frozen_val is not None:
            val_si = frozen_val * conversion
            if key in int_keys:
                val_si = int(round(frozen_val))
            eps = 1e-12 if key not in int_keys else 0.01
            bounds[idx] = (val_si - eps, val_si + eps)
            x0[idx] = val_si
            frozen_param_names.append(f"{key}={frozen_val}")
    
    if frozen_param_names:
        layer1_logger.info(f"Frozen parameters: {', '.join(frozen_param_names)}")
        layer1_logger.info("These values will be fixed during optimization.")

    # Optional exploration band for throat area [mm²] → bounds index 0 [m²].
    # Applied after frozen pinning so unfrozen A_throat can still be narrowed.
    _atm_lo = requirements.get("layer1_A_throat_mm2_min")
    _atm_hi = requirements.get("layer1_A_throat_mm2_max")
    if _atm_lo is not None and _atm_hi is not None:
        lo_m2 = float(_atm_lo) * 1e-6
        hi_m2 = float(_atm_hi) * 1e-6
        if hi_m2 <= lo_m2:
            raise ValueError(
                "layer1_A_throat_mm2_max must exceed layer1_A_throat_mm2_min "
                f"(got min={_atm_lo}, max={_atm_hi})."
            )
        b0_lo = max(float(bounds[0][0]), lo_m2)
        b0_hi = min(float(bounds[0][1]), hi_m2)
        if b0_lo >= b0_hi:
            raise ValueError(
                "layer1 A_throat band does not intersect default bounds "
                f"(band mm² [{_atm_lo}, {_atm_hi}], intersect [{b0_lo}, {b0_hi}] m²)."
            )
        bounds[0] = (b0_lo, b0_hi)
        layer1_logger.info(
            "Layer 1 A_throat interval from requirements "
            "layer1_A_throat_mm2_min/max: [%.6f, %.6f] mm²",
            bounds[0][0] * 1e6,
            bounds[0][1] * 1e6,
        )
    # =========================================================================
    
    # Clip to bounds
    for i, (lo, hi) in enumerate(bounds):
        x0[i] = np.clip(x0[i], lo, hi)
    
    update_progress("Layer 1: Setup", 0.05, "Creating apply_x_to_config function...")
    apply_x_to_config = create_layer1_apply_x_to_config(bounds, max_chamber_od, max_nozzle_exit, l1_injector_type)
    
    # Precompute bounds arrays for clipping, caching, and CMA-ES scaling
    lower_bounds = np.array([b[0] for b in bounds], dtype=float)
    upper_bounds = np.array([b[1] for b in bounds], dtype=float)
    span = np.maximum(upper_bounds - lower_bounds, 1e-9)
    _rs = requirements.get("layer1_random_seed")
    layer1_seed_base = int(_rs) if _rs is not None else 42
    rng = np.random.default_rng(layer1_seed_base)
    layer1_logger.info(
        "Layer 1 RNG/CMA reproducibility: layer1_random_seed base=%s "
        "(CMA seed per restart = base + restart_idx × 1_000_003)",
        layer1_seed_base,
    )
    
    # Get report_every_n from requirements (default: 1 for real-time)
    report_every_n = int(requirements.get("report_every_n", 1))
    report_every_n = max(1, report_every_n)  # At least every iteration
    
    # Initialize optimization state
    opt_state = {
        "iteration": 0,
        "function_evaluations": 0,
        "best_objective": float('inf'),
        "best_x": None,
        "best_config": None,
        "best_config_x": None,
        "best_lox_end_ratio": None,
        "best_fuel_end_ratio": None,
        "best_pressures": None,
        "last_eval_config": None,
        "last_eval_config_x": None,
        "best_validation_tank_pa": None,
        "last_eval_validation_tank_pa": None,
        "last_good_eval_bundle": None,
        "best_results_for_validation": None,
        "converged": False,
        "objective_satisfied": False,
        "satisfied_obj": float('inf'),
        "satisfied_eval_count": 0,
        "consecutive_failures": 0,
        "last_valid_obj": float('inf'),
        "history": [],
        "objective_buffer": [],  # Buffer for batch reporting
        "stop_optimization": False,
        "force_maxfun_1": False,
        "last_best_eval": 0,
        "valley_escape_tier": 0, # 0=normal, 1=mild, 2=medium, 3=full
        "cooldown_until": 0,
    }

    layer1_W_MOM = _requirement_float(requirements, "W_MOM", 75.0)
    _irm_lo = requirements.get("impinging_momentum_R_min")
    _irm_hi = requirements.get("impinging_momentum_R_max")
    layer1_impinging_R_mom_lo = float(_irm_lo) if _irm_lo is not None else None
    layer1_impinging_R_mom_hi = float(_irm_hi) if _irm_hi is not None else None
    layer1_W_chamber_shape = _requirement_float(requirements, "W_CHAMBER_SHAPE", 2500.0)
    layer1_chamber_dt_ratio_min = _requirement_float(requirements, "layer1_chamber_dt_ratio_min", 2.2)
    layer1_chamber_dt_ratio_max = _requirement_float(requirements, "layer1_chamber_dt_ratio_max", 3.2)
    layer1_chamber_ld_ratio_min = _requirement_float(requirements, "layer1_chamber_ld_ratio_min", 1.6)
    layer1_chamber_ld_ratio_max = _requirement_float(requirements, "layer1_chamber_ld_ratio_max", 3.2)
    _iang_lo = requirements.get("layer1_impinging_angle_deg_min")
    _iang_hi = requirements.get("layer1_impinging_angle_deg_max")
    layer1_impinging_angle_deg_lo = float(_iang_lo) if _iang_lo is not None else None
    layer1_impinging_angle_deg_hi = float(_iang_hi) if _iang_hi is not None else None
    layer1_W_impinging_angle = _requirement_float(requirements, "W_IMPINGING_ANGLE", 0.0)
    layer1_W_impinging_jet_asym = _requirement_float(requirements, "W_IMPINGING_JET_ASYM", 160.0)
    layer1_impinging_jet_max_asym_deg = _requirement_float(
        requirements, "layer1_impinging_jet_angle_max_asym_deg", 28.0
    )
    layer1_exit_pressure_inside_quad = _requirement_float(
        requirements, "layer1_exit_pressure_inside_quad_scale", 0.35
    )
    layer1_W_DP = _requirement_float(requirements, "W_DP", 160.0)
    layer1_W_DP_O = (
        float(requirements["W_DP_O"])
        if requirements.get("W_DP_O") is not None
        else layer1_W_DP
    )
    layer1_W_DP_F = (
        float(requirements["W_DP_F"])
        if requirements.get("W_DP_F") is not None
        else layer1_W_DP
    )
    layer1_W_DP_HIGH = _requirement_float(requirements, "W_DP_HIGH", 480.0)
    layer1_dp_o_band: Tuple[float, float] = (
        float(requirements.get("injector_dp_ratio_O_min", 0.15)),
        float(requirements.get("injector_dp_ratio_O_max", 0.40)),
    )
    layer1_dp_f_band: Tuple[float, float] = (
        float(requirements.get("injector_dp_ratio_F_min", 0.15)),
        float(requirements.get("injector_dp_ratio_F_max", 0.40)),
    )
    _lio_sf_raw = requirements.get("injector_dp_ratio_O_soft_floor")
    layer1_dp_o_soft_floor: Optional[float] = (
        float(_lio_sf_raw)
        if _lio_sf_raw is not None and np.isfinite(float(_lio_sf_raw))
        else None
    )
    layer1_W_DP_O_FLOOR = _requirement_float(requirements, "W_DP_O_FLOOR", 0.0)
    layer1_W_SMD = _requirement_float(requirements, "W_SMD", 0.0)
    layer1_target_smd_microns = _requirement_float(requirements, "target_smd_microns", 50.0)
    layer1_smd_rel_tol = _requirement_float(requirements, "layer1_smd_rel_tol", 0.20)
    layer1_impinging_smd_corr_C = _requirement_float(requirements, "layer1_impinging_smd_corr_C", 0.9)
    layer1_impinging_smd_corr_a = _requirement_float(requirements, "layer1_impinging_smd_corr_a", 0.45)
    layer1_impinging_smd_corr_b = _requirement_float(requirements, "layer1_impinging_smd_corr_b", 0.10)
    layer1_impinging_smd_phi_floor_deg = _requirement_float(requirements, "layer1_impinging_smd_phi_floor_deg", 10.0)
    layer1_W_geom_ao_af = float(requirements.get("W_geom_ao_af_momentum", 0.0))
    layer1_W_THRUST_obj = _requirement_float(requirements, "layer1_W_THRUST", 1e4)
    layer1_W_OF_obj = _requirement_float(requirements, "layer1_W_OF", 1e4)
    _w_ol = requirements.get("layer1_W_OF_low_MR_scale")
    layer1_W_OF_low_MR_scale = max(1.0, float(_w_ol)) if _w_ol is not None else 1.0
    _w_oh = requirements.get("layer1_W_OF_high_MR_scale")
    layer1_W_OF_high_MR_scale = max(1.0, float(_w_oh)) if _w_oh is not None else 1.0
    # Impinging methane runs can stall at high O/F while still satisfying momentum/ΔP if
    # AO/AF geometry guidance is disabled. Apply a conservative adaptive fallback when unset.
    if l1_injector_type == "impinging" and layer1_W_geom_ao_af <= 0.0:
        layer1_W_geom_ao_af = max(400.0, 0.05 * layer1_W_OF_obj)
    layer1_of_validation_tol = _requirement_float(requirements, "layer1_of_validation_tol", 0.15)
    # Final validation uses ``layer1_thrust_validation_rel_tol`` when set; errors_acceptable must match.
    _thr_gate_yaml = requirements.get("layer1_thrust_validation_rel_tol")
    layer1_gate_thrust_tol = (
        float(_thr_gate_yaml)
        if _thr_gate_yaml is not None and np.isfinite(float(_thr_gate_yaml)) and float(_thr_gate_yaml) > 0
        else float(thrust_tol)
    )
    layer1_logger.info(
        "Injector ΔP_inj/Pc preferred bands (soft hinge): "
        f"oxidizer [{layer1_dp_o_band[0]:.3f}, {layer1_dp_o_band[1]:.3f}], "
        f"fuel [{layer1_dp_f_band[0]:.3f}, {layer1_dp_f_band[1]:.3f}]"
    )
    layer1_logger.info(
        "Injector ΔP weights: W_DP=%g (fallback); W_DP_O=%g; W_DP_F=%g",
        layer1_W_DP,
        layer1_W_DP_O,
        layer1_W_DP_F,
    )
    if layer1_dp_o_soft_floor is not None and layer1_dp_o_soft_floor > 0 and layer1_W_DP_O_FLOOR > 0:
        layer1_logger.info(
            "LOX dP_inj/Pc soft floor: penalize ratios below %.4f using W_DP_O_FLOOR=%.4g*(floor-r_O)^2",
            layer1_dp_o_soft_floor,
            layer1_W_DP_O_FLOOR,
        )
    if layer1_W_geom_ao_af > 0.0:
        layer1_logger.info(
            f"Geometry AO/AF momentum hint weight W_geom_ao_af_momentum={layer1_W_geom_ao_af:g} "
            f"(targets A_O/A_F ≈ MR/√(ρ_O/ρ_F) for R≈1)"
        )
    if layer1_impinging_R_mom_lo is not None and layer1_impinging_R_mom_hi is not None:
        layer1_logger.info(
            "Impinging momentum_ratio_R preferred band (ratio-space hinge): "
            f"[{layer1_impinging_R_mom_lo:g}, {layer1_impinging_R_mom_hi:g}]"
        )
    if layer1_W_impinging_angle > 0.0 and layer1_impinging_angle_deg_lo is not None and layer1_impinging_angle_deg_hi is not None:
        layer1_logger.info(
            "Impinging effective-angle preferred band (deg): "
            f"[{layer1_impinging_angle_deg_lo:g}, {layer1_impinging_angle_deg_hi:g}] "
            f"with W_IMPINGING_ANGLE={layer1_W_impinging_angle:g}"
        )
    if l1_injector_type == "impinging" and layer1_W_impinging_jet_asym > 0.0:
        layer1_logger.info(
            "Impinging paired jet |Δθ_O/F| soft cap: max Δ=%.2f° with W_IMPINGING_JET_ASYM=%g",
            float(layer1_impinging_jet_max_asym_deg),
            float(layer1_W_impinging_jet_asym),
        )
    layer1_logger.info(
        "Ambient-matched exit pressure: inside-deadband quadratic scale "
        "layer1_exit_pressure_inside_quad_scale=%g (W_EXIT×scale×rel²; 0=flat inside band)",
        float(layer1_exit_pressure_inside_quad),
    )
    layer1_logger.info(
        "Layer 1 primary weights: layer1_W_THRUST=%g layer1_W_OF=%g low_MR_scale=%g high_MR_scale=%g; "
        "of_validation_tol=%.4f",
        layer1_W_THRUST_obj,
        layer1_W_OF_obj,
        layer1_W_OF_low_MR_scale,
        layer1_W_OF_high_MR_scale,
        layer1_of_validation_tol,
    )

    log_flags = {
        "marginal_candidate_logged": False,
    }
    
    update_progress("Layer 1: Objective", 0.10, "Defining objective function...")
    
    # ------------------------------------------------------------------
    # Objective acceleration: cache expensive evaluate() calls
    # ------------------------------------------------------------------
    # Many optimizers will revisit the same point (especially with discrete
    # variables like n_orifices). Caching is a large speed win because
    # `PintleEngineRunner.evaluate()` is the expensive part.
    #
    # Cache key strategy:
    # - clip to bounds
    # - quantize continuous dims to a fraction of their span
    # - keep discrete dims exact (n_orifices)
    # Finer granularity (1e-5 instead of 1e-4) to preserve gradient information for L-BFGS-B
    cache_rel = float(requirements.get("objective_cache_rel", 1e-5))  # 0.001% of span per bin
    cache_rel = float(np.clip(cache_rel, 1e-6, 1e-3))
    cache_steps = np.maximum(span * cache_rel, 1e-12)
    eval_cache: Dict[Tuple[int, ...], Dict[str, Any]] = {}
    
    def _make_eval_cache_key(x_raw: np.ndarray) -> Tuple[int, ...]:
        """Quantize x to a stable hashable key for caching evaluate() results."""
        x_arr = np.clip(np.asarray(x_raw, dtype=float), lower_bounds, upper_bounds)
        x_arr = x_arr.copy()
        for di in layer1_integer_dims:
            if 0 <= di < len(x_arr):
                x_arr[di] = int(round(x_arr[di]))
        key_parts = []
        for i, v in enumerate(x_arr):
            if i in layer1_integer_dims:
                key_parts.append(int(v))
                continue
            step = float(cache_steps[i])
            # Quantize within bounds so different absolute magnitudes hash consistently
            key_parts.append(int(round((float(v) - float(lower_bounds[i])) / step)))
        return tuple(key_parts)
    
    def _hinge_band(x_val: float, lo: float, hi: float, scale: float = 1.0) -> float:
        """Dimensionless squared hinge penalty outside [lo, hi]."""
        if scale <= 0:
            scale = 1.0
        below = max(0.0, (lo - x_val) / scale)
        above = max(0.0, (x_val - hi) / scale)
        return below * below + above * above
    
    def _check_valley_escape_tier() -> int:
        """Determine if we are in a 'valley' and should boost exploration."""
        evals = opt_state["function_evaluations"]
        best_f = opt_state["best_objective"]
        stagnation = evals - opt_state["last_best_eval"]
        
        # Tier 3: Full (evals > 5000, best > 100, stagnation > 1000)
        if evals > 5000 and best_f > 100.0 and stagnation > 1000:
            return 3
        # Tier 2: Medium (evals > 3000, best > 150, stagnation > 500)
        if evals > 3000 and best_f > 150.0 and stagnation > 500:
            return 2
        # Tier 1: Mild (evals > 1500, best > 300, stagnation > 300)
        if evals > 1500 and best_f > 300.0 and stagnation > 300:
            return 1
        return 0
    
    # Define objective function
    def objective(x: np.ndarray) -> float:
        """Layer 1 objective function: optimize geometry + initial pressures.
        
        Staged/lexicographic structure (approximate but smooth):
        1) Feasibility (hard constraints + stability gates)
        2) Thrust closeness
        3) O/F closeness
        4) Regularization (Cf band, chamber length, exit pressure)
        
        Note: we still return a single scalar for SciPy/CMA-ES, but the scaling
        preserves the priority ordering and reduces "weight fights".
        """
        
        # Initialize opt_state keys
        for key in ["consecutive_failures", "last_valid_obj", "iteration", "function_evaluations", "best_objective", "best_x"]:
            if key not in opt_state:
                opt_state[key] = 0 if key in ["iteration", "function_evaluations", "consecutive_failures"] else (float('inf') if key in ["last_valid_obj", "best_objective"] else None)
        
        opt_state["iteration"] += 1
        iteration = opt_state["iteration"]
        opt_state["function_evaluations"] += 1
        
        # Progress update
        progress = 0.10 + 0.40 * min(iteration / max_iterations, 1.0)
        if iteration <= 3 or iteration % 25 == 0:
            try:
                _bo = float(opt_state["best_objective"])
            except (TypeError, ValueError):
                _bo = float("inf")
            _lv_raw = opt_state.get("last_valid_obj", float("inf"))
            try:
                _lv = float(_lv_raw) if _lv_raw is not None else float("inf")
            except (TypeError, ValueError):
                _lv = float("inf")
            best_obj_str = f"{_bo:.3e}" if np.isfinite(_bo) else "inf"
            curr_obj_str = f"{_lv:.3e}" if np.isfinite(_lv) else "inf"
            update_progress("Layer 1: Optimization", progress, f"Iter {iteration}/{max_iterations} | Curr: {curr_obj_str} | Best: {best_obj_str}")
            layer1_logger.info(f"[{int(progress*100)}%] Iteration {iteration}/{max_iterations} - "
                            f"Objective: {curr_obj_str} (Best: {best_obj_str})")
            for handler in layer1_logger.handlers:
                handler.flush()
        
        # Always work with a clipped/consistent candidate vector (helps caching and stability)
        x_clipped = np.clip(np.asarray(x, dtype=float), lower_bounds, upper_bounds)
        # Discrete variable
        x_clipped = x_clipped.copy()
        for di in layer1_integer_dims:
            if 0 <= di < len(x_clipped):
                x_clipped[di] = int(round(x_clipped[di]))

        # Convert x to config
        config, _, _ = apply_x_to_config(x_clipped, config_base)
        
        # Feasibility pre-checks (cheap): injector sizing, geometry, and O/F area sanity
        from engine.pipeline.config_schemas import ensure_chamber_geometry
        cg = ensure_chamber_geometry(config)
        A_throat_check = float(cg.A_throat or 0.0)
        D_chamber_inner = float(cg.chamber_diameter or 0.0)
        A_chamber_check = np.pi * (D_chamber_inner / 2) ** 2
        
        geom = getattr(getattr(config, "injector", None), "geometry", None)
        has_pintle = bool(getattr(getattr(config, "injector", None), "type", None) == "pintle" and geom is not None)
        has_impinging = bool(getattr(getattr(config, "injector", None), "type", None) == "impinging" and geom is not None)

        A_lox_injector = np.nan
        A_fuel_injector = np.nan
        lox_ratio = np.nan
        fuel_ratio = np.nan
        area_ratio_error = np.nan
        
        infeasibility_score = 0.0
        
        # --- Geometric Validation Rules ---
        
        # 1. Throat area must be less than chamber area (with some margin)
        # Typically contraction ratio (A_chamber / A_throat) is between 2 and 10
        if A_chamber_check > 0 and A_throat_check > 0:
            contraction_ratio_check = A_chamber_check / A_throat_check
            # Constraint: A_throat < A_chamber (contraction_ratio > 1.0)
            infeasibility_score += max(0.0, (A_throat_check * 1.1) / A_chamber_check - 1.0) ** 2
            
            # Preferred range for contraction ratio: [1.5, 15.0]
            if contraction_ratio_check < 1.5:
                infeasibility_score += (1.5 - contraction_ratio_check) ** 2
            elif contraction_ratio_check > 15.0:
                infeasibility_score += (contraction_ratio_check - 15.0) ** 2

        # 2. Pintle diameter must be less than chamber diameter
        if has_pintle and D_chamber_inner > 0:
            d_pintle_tip_check = float(geom.fuel.d_pintle_tip)
            # Constraint: d_pintle_tip < D_chamber_inner (with 10% margin)
            infeasibility_score += max(0.0, (d_pintle_tip_check * 1.1) / D_chamber_inner - 1.0) ** 2

        # 2a. Explicit Throat Diameter vs Chamber Diameter check
        # D_throat < D_chamber check
        D_throat_check = np.sqrt(4.0 * A_throat_check / np.pi) if A_throat_check > 0 else 0.0
        if D_throat_check > 0 and D_chamber_inner > 0:
             # Penalize if throat is larger than 95% of chamber
             # This reinforces the contraction ratio check with an explicit diameter-based gradient
             infeasibility_score += max(0.0, D_throat_check - D_chamber_inner * 0.95) ** 2 * 10.0

        # 3. Nozzle exit diameter vs throat diameter
        D_exit_check = float(cg.exit_diameter or 0.0)
        R_throat_check = np.sqrt(max(0, A_throat_check / np.pi))
        D_throat_check = 2 * R_throat_check
        if D_exit_check > 0 and D_throat_check > 0:
            # Expansion ratio should be >= 1.0 (already handled by bounds, but for safety)
            infeasibility_score += max(0.0, D_throat_check / D_exit_check - 1.0) ** 2

        # --- Injector and O/F Validation ---
        
        if has_pintle and A_throat_check > 0:
            A_lox_injector = float(geom.lox.n_orifices * np.pi * (geom.lox.d_orifice / 2) ** 2)
            R_inner = float(geom.fuel.d_pintle_tip / 2)
            R_outer = float(R_inner + geom.fuel.h_gap)
            A_fuel_injector = float(np.pi * (R_outer ** 2 - R_inner ** 2))
            # Flow-capacity vs throat and O/F area sanity use Cd-weighted A_eff (post-evaluate below)

        if has_impinging and A_throat_check > 0:
            oxg = geom.oxidizer
            fug = geom.fuel
            A_lox_injector = float(oxg.n_elements * np.pi * (oxg.d_jet / 2.0) ** 2)
            A_fuel_injector = float(fug.n_elements * np.pi * (fug.d_jet / 2.0) ** 2)
            # Flow-capacity penalties use A_eff = Cd × A_geom from evaluate() diagnostics (post-evaluate below)
            sp_O = float(oxg.spacing)
            sp_F = float(fug.spacing)
            djo = float(oxg.d_jet)
            djf = float(fug.d_jet)
            infeasibility_score += (max(0.0, djo - sp_O) / (sp_O + 1e-9)) ** 2
            infeasibility_score += (max(0.0, djf - sp_F) / (sp_F + 1e-9)) ** 2
            infeasibility_score += (max(0.0, 2.5 * djo - sp_O) * 0.4) ** 2
            infeasibility_score += (max(0.0, 2.5 * djf - sp_F) * 0.4) ** 2
            face_a = np.pi * (D_chamber_inner / 2.0) ** 2
            pack = float(oxg.n_elements + fug.n_elements) * max(sp_O, sp_F) ** 2
            if face_a > 0:
                infeasibility_score += max(0.0, pack / face_a - 0.55) ** 2

        # Tank pressures (dimensionless ratios are used for penalties and caching guidance)
        P_O_psi = float(np.clip(x_clipped[idx_P_O], bounds[idx_P_O][0], bounds[idx_P_O][1]))
        P_F_psi = float(np.clip(x_clipped[idx_P_F], bounds[idx_P_F][0], bounds[idx_P_F][1]))
        P_O_test = P_O_psi * psi_to_Pa
        P_F_test = P_F_psi * psi_to_Pa
        P_O_ratio = P_O_psi / max_lox_P_psi if max_lox_P_psi > 0 else 0.0
        P_F_ratio = P_F_psi / max_fuel_P_psi if max_fuel_P_psi > 0 else 0.0
        
        # If already infeasible from cheap checks, skip expensive evaluation.
        # This is both a lexicographic improvement and a speed win.
        eval_success = False
        final_results: Dict[str, Any] = {}
        final_pressures = (P_O_test, P_F_test)
        eval_error_str: Optional[str] = None
        
        # During L-BFGS-B refinement, ``objective()`` is called sequentially and needs
        # exact ``evaluate()`` values for finite-diff gradients — cache quantization can
        # flatten curvature and inflate residuals. Parallel CMA paths use workers, not this
        # cache toggle.
        cache_enabled = not bool(opt_state.get("layer1_lbfgs_phase", False))
        cache_key = _make_eval_cache_key(x_clipped) if cache_enabled else None
        if infeasibility_score <= 0.0:
            cached = eval_cache.get(cache_key) if cache_enabled and cache_key is not None else None
            use_cached = False
            if cached is not None:
                # Handle both dict format (full cache from objective) and float/dict format (from parallel eval)
                if isinstance(cached, dict):
                    # Check if it's the full format with "results" key
                    if "results" in cached:
                        eval_success = bool(cached.get("success", False))
                        final_results = copy.deepcopy(cached.get("results", {})) if eval_success else {}
                        eval_error_str = cached.get("error", None)
                        use_cached = True
                    else:
                        # Partial format from parallel eval (only has 'value', 'success')
                        # Can't use this - we need the full results dict, so treat as cache miss
                        use_cached = False
                else:
                    # Old format: direct float value - can't use, need full results
                    use_cached = False
            
            if not use_cached:
                # Disable thermal protection for evaluation (for speed + avoid unrelated failures)
                config_runner = copy.deepcopy(config)
                if hasattr(config_runner, "ablative_cooling") and config_runner.ablative_cooling:
                    config_runner.ablative_cooling.enabled = False
                if hasattr(config_runner, "graphite_insert") and config_runner.graphite_insert:
                    config_runner.graphite_insert.enabled = False
                
                test_runner = PintleEngineRunner(config_runner)
                try:
                    final_results = test_runner.evaluate(P_O_test, P_F_test, P_ambient=target_P_exit, silent=True)
                    eval_success = True
                except Exception as eval_error:
                    eval_success = False
                    eval_error_str = str(eval_error)
                    final_results = {}
                
                if cache_enabled and cache_key is not None:
                    eval_cache[cache_key] = {
                        "success": bool(eval_success),
                        "results": copy.deepcopy(final_results) if eval_success else {},
                        "error": eval_error_str,
                    }
        
        # Defaults when evaluation fails / skipped
        F_actual = float(final_results.get("F", np.nan)) if eval_success else np.nan
        Isp_actual = float(final_results.get("Isp", np.nan)) if eval_success else np.nan
        MR_actual = float(final_results.get("MR", np.nan)) if eval_success else np.nan
        Pc_actual = float(final_results.get("Pc", np.nan)) if eval_success else np.nan
        Cf_actual = float(final_results.get("Cf_actual", final_results.get("Cf", np.nan))) if eval_success else np.nan
        stability = final_results.get("stability_results", {}) if eval_success else {}
        
        # Primary errors (dimensionless)
        thrust_error = abs(F_actual - target_thrust) / target_thrust if (eval_success and target_thrust > 0 and np.isfinite(F_actual)) else 1.0
        of_error = abs(MR_actual - optimal_of) / optimal_of if (eval_success and optimal_of > 0 and np.isfinite(MR_actual)) else 1.0
        if eval_success and isinstance(final_results, dict) and np.isfinite(F_actual):
            opt_state["last_good_eval_bundle"] = {
                "results": copy.deepcopy(final_results),
                "P_O_Pa": float(P_O_test),
                "P_F_Pa": float(P_F_test),
                "thrust_error": float(thrust_error),
                "of_error": float(of_error),
            }
        of_sq = float(of_error) ** 2
        if eval_success and np.isfinite(MR_actual) and optimal_of > 0:
            if MR_actual < optimal_of:
                of_sq *= layer1_W_OF_low_MR_scale
            elif MR_actual > optimal_of:
                of_sq *= layer1_W_OF_high_MR_scale

        # Thrust penalty with 2% deadband (no penalty if within 2% error)
        thrust_penalty_sq_term = 0.0
        if eval_success and target_thrust > 0 and np.isfinite(F_actual):
            rel_error = abs(F_actual - target_thrust) / target_thrust
            deadband = 0.02  # 2% tolerance
            if rel_error > deadband:
                # Only penalize error beyond the deadband
                excess = rel_error - deadband
                thrust_penalty_sq_term = excess ** 2
        elif not eval_success or not np.isfinite(F_actual):
            # Failed evaluation gets full penalty
            thrust_penalty_sq_term = 1.0
        
        # Exit pressure preference (dimensionless)
        # Asymmetric penalty with deadband: Overexpansion (P < target) is worse than underexpansion
        # Option A: Deadband + asymmetric quadratic
        P_exit_actual = float(final_results.get("P_exit", np.nan)) if eval_success else np.nan
        
        exit_pressure_sq_term = float(
            _layer1_exit_pressure_sq_term(
                float(P_exit_actual) if eval_success else float("nan"),
                float(target_P_exit),
                deadband_rel=0.05,
                inside_rel_quad_scale=float(layer1_exit_pressure_inside_quad),
            )
        )

        # Injector pressure-drop ratio penalty (ΔP_inj / Pc): piecewise hinge; matches worker _compute_objective_value
        injector_dp_weighted = 0.0
        ratio_o_obj: Optional[float] = None
        ratio_f_obj: Optional[float] = None
        if eval_success and np.isfinite(Pc_actual) and Pc_actual > 0:
            ratio_o_obj, ratio_f_obj = injector_dp_ratios_from_eval_result(float(Pc_actual), final_results)
            injector_dp_weighted = injector_dp_ratio_penalty_weighted(
                ratio_o_obj,
                ratio_f_obj,
                layer1_W_DP,
                layer1_W_DP_HIGH,
                o_band=layer1_dp_o_band,
                f_band=layer1_dp_f_band,
                w_dp_o=layer1_W_DP_O,
                w_dp_f=layer1_W_DP_F,
                o_soft_floor=layer1_dp_o_soft_floor,
                w_dp_o_floor=layer1_W_DP_O_FLOOR,
            )
        
        # Injector flow capacity vs throat: use A_eff = Cd × A_geom from evaluated diagnostics
        if has_pintle and A_throat_check > 0 and geom is not None:
            lox_geom = geom.lox
            fuel_geom = geom.fuel
            A_lox_g = float(lox_geom.n_orifices * np.pi * (lox_geom.d_orifice / 2) ** 2)
            R_inner_g = float(fuel_geom.d_pintle_tip / 2)
            R_outer_g = float(R_inner_g + fuel_geom.h_gap)
            A_fuel_g = float(np.pi * (R_outer_g ** 2 - R_inner_g ** 2))
            if eval_success:
                diag_ev = final_results.get("diagnostics") or {}
                A_eff_O, A_eff_F, eff_warns = effective_flow_areas_from_cd(diag_ev, A_lox_g, A_fuel_g)
                if eff_warns:
                    fd = final_results.setdefault("diagnostics", {})
                    if isinstance(fd, dict):
                        merge_effective_area_warnings(fd, eff_warns)
                lox_ratio = A_eff_O / A_throat_check
                fuel_ratio = A_eff_F / A_throat_check
                infeasibility_score += max(0.0, lox_ratio - 1.0) ** 2
                infeasibility_score += max(0.0, fuel_ratio - 1.0) ** 2
                if A_eff_F > 0:
                    area_ratio = A_eff_O / A_eff_F
                    Cd_ratio = 0.4 / 0.65
                    rho_ratio = np.sqrt(
                        max(float(config.fluids["oxidizer"].density), 1e-9)
                        / max(float(config.fluids["fuel"].density), 1e-9)
                    )
                    delta_p_ratio_est = np.sqrt(1.2)
                    area_ratio_factor = Cd_ratio * rho_ratio * delta_p_ratio_est
                    required_area_ratio = optimal_of / area_ratio_factor if area_ratio_factor > 0 else np.inf
                    if required_area_ratio > 0 and np.isfinite(required_area_ratio):
                        area_ratio_error = abs(area_ratio - required_area_ratio) / required_area_ratio
                        infeasibility_score += max(0.0, area_ratio_error - 0.5) ** 2
            else:
                lox_ratio = A_lox_g / A_throat_check
                fuel_ratio = A_fuel_g / A_throat_check
                if A_fuel_g > 0:
                    area_ratio = A_lox_g / A_fuel_g
                    Cd_ratio = 0.4 / 0.65
                    rho_ratio = np.sqrt(
                        max(float(config.fluids["oxidizer"].density), 1e-9)
                        / max(float(config.fluids["fuel"].density), 1e-9)
                    )
                    delta_p_ratio_est = np.sqrt(1.2)
                    area_ratio_factor = Cd_ratio * rho_ratio * delta_p_ratio_est
                    required_area_ratio = optimal_of / area_ratio_factor if area_ratio_factor > 0 else np.inf
                    if required_area_ratio > 0 and np.isfinite(required_area_ratio):
                        area_ratio_error = abs(area_ratio - required_area_ratio) / required_area_ratio

        elif has_impinging and A_throat_check > 0 and geom is not None:
            oxg = geom.oxidizer
            fug = geom.fuel
            A_lox_g = float(oxg.n_elements * np.pi * (oxg.d_jet / 2.0) ** 2)
            A_fuel_g = float(fug.n_elements * np.pi * (fug.d_jet / 2.0) ** 2)
            if eval_success:
                diag_ev = final_results.get("diagnostics") or {}
                A_eff_O, A_eff_F, eff_warns = effective_flow_areas_from_cd(diag_ev, A_lox_g, A_fuel_g)
                if eff_warns:
                    fd = final_results.setdefault("diagnostics", {})
                    if isinstance(fd, dict):
                        merge_effective_area_warnings(fd, eff_warns)
                lox_ratio = A_eff_O / A_throat_check
                fuel_ratio = A_eff_F / A_throat_check
                infeasibility_score += max(0.0, lox_ratio - 0.95) ** 2
                infeasibility_score += max(0.0, fuel_ratio - 0.95) ** 2
                if A_eff_F > 0:
                    area_ratio = A_eff_O / A_eff_F
                    Cd_ratio = 0.4 / 0.65
                    rho_ratio = np.sqrt(
                        max(float(config.fluids["oxidizer"].density), 1e-9)
                        / max(float(config.fluids["fuel"].density), 1e-9)
                    )
                    delta_p_ratio_est = np.sqrt(1.2)
                    area_ratio_factor = Cd_ratio * rho_ratio * delta_p_ratio_est
                    required_area_ratio = optimal_of / area_ratio_factor if area_ratio_factor > 0 else np.inf
                    if required_area_ratio > 0 and np.isfinite(required_area_ratio):
                        area_ratio_error = abs(area_ratio - required_area_ratio) / required_area_ratio
                        infeasibility_score += max(0.0, area_ratio_error - 0.5) ** 2
            else:
                lox_ratio = A_lox_g / A_throat_check
                fuel_ratio = A_fuel_g / A_throat_check
                if A_fuel_g > 0:
                    area_ratio = A_lox_g / A_fuel_g
                    Cd_ratio = 0.4 / 0.65
                    rho_ratio = np.sqrt(
                        max(float(config.fluids["oxidizer"].density), 1e-9)
                        / max(float(config.fluids["fuel"].density), 1e-9)
                    )
                    delta_p_ratio_est = np.sqrt(1.2)
                    area_ratio_factor = Cd_ratio * rho_ratio * delta_p_ratio_est
                    required_area_ratio = optimal_of / area_ratio_factor if area_ratio_factor > 0 else np.inf
                    if required_area_ratio > 0 and np.isfinite(required_area_ratio):
                        area_ratio_error = abs(area_ratio - required_area_ratio) / required_area_ratio
        
        # Stability gates contribute to feasibility (lexicographic stage 1)
        stability_state = stability.get("stability_state", "unstable")
        stability_score = float(stability.get("stability_score", 0.0))
        chugging_margin = max(0.0, float(stability.get("chugging", {}).get("stability_margin", 0.0)))
        acoustic_margin = max(0.0, float(stability.get("acoustic", {}).get("stability_margin", 0.0)))
        feed_margin = max(0.0, float(stability.get("feed_system", {}).get("stability_margin", 0.0)))
        
        min_stability_score_raw = float(requirements.get("min_stability_score", 0.75))
        stability_margin_handicap = float(requirements.get("stability_margin_handicap", 0.0))
        score_factor = max(0.0, 1.0 - stability_margin_handicap)
        margin_factor = max(0.0, 1.0 - stability_margin_handicap)
        effective_min_score = min_stability_score_raw * score_factor
        effective_margin = float(min_stability) * margin_factor
        
        require_stable_state = bool(requirements.get("require_stable_state", True))
        allowed_states = {"stable", "marginal"}
        state_ok = (stability_state in allowed_states) if require_stable_state else (stability_state != "unstable")
        if eval_success:
            if not state_ok:
                infeasibility_score += 1.0
            if effective_min_score > 0:
                infeasibility_score += max(0.0, (effective_min_score - stability_score) / effective_min_score) ** 2
            if effective_margin > 0:
                infeasibility_score += max(0.0, (effective_margin - chugging_margin) / effective_margin) ** 2
                infeasibility_score += max(0.0, (effective_margin - acoustic_margin) / effective_margin) ** 2
                infeasibility_score += max(0.0, (effective_margin - feed_margin) / effective_margin) ** 2
        else:
            # If solver fails, treat as infeasible and try to provide directional guidance.
            # This avoids "constant penalty with no gradient" behavior.
            infeasibility_score += 1.0
            if eval_error_str is not None:
                err_lower = eval_error_str.lower()
                # Supply < Demand → encourage higher pressures and/or larger injector area
                if ("supply < demand" in err_lower) or ("insufficient mass flow" in err_lower):
                    infeasibility_score += max(0.0, 0.90 - P_O_ratio) ** 2 + max(0.0, 0.90 - P_F_ratio) ** 2
                # Supply > Demand / bracket issues → encourage reducing injector oversupply or increasing throat
                if ("supply > demand" in err_lower) or ("invalid bracket" in err_lower) or ("no solution" in err_lower):
                    if np.isfinite(lox_ratio):
                        infeasibility_score += max(0.0, lox_ratio - 0.90) ** 2
                    if np.isfinite(fuel_ratio):
                        infeasibility_score += max(0.0, fuel_ratio - 0.90) ** 2
            # Always include area-ratio mismatch as directional signal if available
            if np.isfinite(area_ratio_error):
                infeasibility_score += max(0.0, area_ratio_error - 0.25) ** 2
        
        # Regularization terms (dimensionless squared)
        Cf_min_acceptable = 1.3
        Cf_max_acceptable = 1.8
        cf_hinge = _hinge_band(float(Cf_actual) if np.isfinite(Cf_actual) else 0.0,
                               Cf_min_acceptable, Cf_max_acceptable,
                               scale=(Cf_max_acceptable - Cf_min_acceptable))
        
        # Chamber length penalty: only apply if exceeds maximum (prefer shorter within bounds)
        max_chamber_length = float(requirements.get("max_chamber_length_m", 0.50))  # 50cm max
        L_chamber_curr = getattr(getattr(config, "chamber", None), "length", None)
        L_chamber_curr = float(L_chamber_curr) if (L_chamber_curr is not None and np.isfinite(L_chamber_curr)) else np.nan
        length_term = 0.0
        length_violation = False
        if np.isfinite(L_chamber_curr) and max_chamber_length > 0:
            if L_chamber_curr > max_chamber_length:
                # Hard constraint: treat as infeasibility
                length_violation = True
                length_term = ((L_chamber_curr - max_chamber_length) / max_chamber_length) ** 2
            else:
                # Soft penalty to guide optimizer away from the boundary
                length_term = max(0.0, (L_chamber_curr - max_chamber_length * 0.9) / (max_chamber_length * 0.1)) ** 2
        chamber_shape_term = 0.0
        chamber_dt_ratio_curr = float("nan")
        chamber_ld_ratio_curr = float("nan")
        if D_chamber_inner > 0 and D_throat_check > 0:
            chamber_dt_ratio_curr = D_chamber_inner / D_throat_check
            chamber_shape_term += _relative_hinge_band_squared(
                chamber_dt_ratio_curr,
                layer1_chamber_dt_ratio_min,
                layer1_chamber_dt_ratio_max,
            )
        if D_chamber_inner > 0 and np.isfinite(L_chamber_curr) and L_chamber_curr > 0:
            chamber_ld_ratio_curr = L_chamber_curr / D_chamber_inner
            chamber_shape_term += _relative_hinge_band_squared(
                chamber_ld_ratio_curr,
                layer1_chamber_ld_ratio_min,
                layer1_chamber_ld_ratio_max,
            )
        
        # Impinging jet momentum balance (hinge; matches worker _compute_objective_value)
        momentum_term = 0.0
        smd_term = 0.0
        angle_term = 0.0
        jet_asym_term = 0.0
        smd_eff_um = float("nan")
        imp_angle_deg = float("nan")
        if has_impinging and eval_success:
            R_m = final_results.get("diagnostics", {}).get("momentum_ratio_R")
            if R_m is not None and np.isfinite(R_m) and float(R_m) > 0:
                momentum_term = _impinging_momentum_hinge_squared(
                    R_m,
                    r_band_lo=layer1_impinging_R_mom_lo,
                    r_band_hi=layer1_impinging_R_mom_hi,
                )
                infeasibility_score += _impinging_momentum_band_violation_squared(
                    R_m,
                    r_band_lo=layer1_impinging_R_mom_lo,
                    r_band_hi=layer1_impinging_R_mom_hi,
                )
            if layer1_W_SMD > 0.0:
                _mr_smd_main = float(MR_actual) if np.isfinite(MR_actual) and MR_actual > 0 else None
                smd_term, smd_eff_um, imp_angle_deg = _impinging_smd_penalty_with_angle(
                    final_results.get("diagnostics", {}) or {},
                    target_smd_microns=layer1_target_smd_microns,
                    smd_rel_tol=layer1_smd_rel_tol,
                    smd_corr_c=layer1_impinging_smd_corr_C,
                    smd_corr_a=layer1_impinging_smd_corr_a,
                    smd_corr_b=layer1_impinging_smd_corr_b,
                    smd_phi_floor_deg=layer1_impinging_smd_phi_floor_deg,
                    rho_l=float(config.fluids["oxidizer"].density),
                    mr_mass=_mr_smd_main,
                )
            else:
                try:
                    imp_angle_deg = float(final_results.get("diagnostics", {}).get("impingement_angle_deg", np.nan))
                except (TypeError, ValueError):
                    imp_angle_deg = float("nan")
            if layer1_W_impinging_angle > 0.0:
                angle_term = _impinging_angle_hinge_squared(
                    imp_angle_deg,
                    angle_band_lo_deg=layer1_impinging_angle_deg_lo,
                    angle_band_hi_deg=layer1_impinging_angle_deg_hi,
                )
            if layer1_W_impinging_jet_asym > 0.0 and geom is not None:
                jet_asym_term = _impinging_jet_pair_asymmetry_squared(
                    getattr(getattr(geom, "oxidizer", None), "impingement_angle", np.nan),
                    getattr(getattr(geom, "fuel", None), "impingement_angle", np.nan),
                    max_delta_deg=float(layer1_impinging_jet_max_asym_deg),
                )

        # Geometry hint: A_O/A_F vs MR/√(ρ_O/ρ_F) for R≈1 (soft, optimizer-only)
        geom_ao_af_term = 0.0
        geom_ao_af_ratio_curr = float("nan")
        expected_ao_af_for_R1_curr = float("nan")
        if has_impinging and eval_success and geom is not None and layer1_W_geom_ao_af > 0.0:
            oxgg = geom.oxidizer
            fugg = geom.fuel
            Aog_h = float(oxgg.n_elements * np.pi * (oxgg.d_jet / 2.0) ** 2)
            Afg_h = float(fugg.n_elements * np.pi * (fugg.d_jet / 2.0) ** 2)
            rho_o_v = float(config.fluids["oxidizer"].density)
            rho_f_v = float(config.fluids["fuel"].density)
            if Afg_h > 0:
                geom_ao_af_term, geom_ao_af_ratio_curr, expected_ao_af_for_R1_curr = (
                    _geom_ao_af_momentum_hint_squared(Aog_h, Afg_h, optimal_of, rho_o_v, rho_f_v)
                )
        _of_tol_for_geom = max(0.05, float(layer1_of_validation_tol))
        _of_err_for_geom = of_error if np.isfinite(of_error) else 1.0
        geom_ao_af_scale = min(1.0, float(_of_err_for_geom / _of_tol_for_geom) ** 2)
        geom_ao_af_weighted = layer1_W_geom_ao_af * geom_ao_af_term * geom_ao_af_scale
        
        # ------------------------------------------------------------------
        # Lexicographic-ish scalarization with normalized weights
        # Each priority level is 100× the next for clear separation
        # SCALED DOWN: Max penalty ~1e7 instead of 1e10
        # ------------------------------------------------------------------
        BASE_INFEAS = 1e6        # Infeasibility baseline (was 1e10)
        W_INFEAS = 1e5           # Level 0: Hard constraints (was 1e8)
        W_THRUST = layer1_W_THRUST_obj
        W_OF = layer1_W_OF_obj
        W_CF = 1e2               # Level 2: Secondary objectives (was 1e4)
        W_EXIT = 2.0e2           # Level 2: Secondary objectives (was 2e4)
        W_LEN = 1e4              # Level 2: Chamber length constraint (increased from 1.0 to enforce max length)
        W_MOM = layer1_W_MOM     # Impinging momentum-balance hinge (same default as constants_dict W_MOM)
        W_GEOM_AO_AF = layer1_W_geom_ao_af
        
        if (not np.isfinite(infeasibility_score)) or infeasibility_score < 0:
            infeasibility_score = 1.0

        gate_eps = _requirement_float(requirements, "layer1_infeasibility_gate_eps", 0.0)
        inf_residual = max(0.0, float(infeasibility_score) - max(0.0, gate_eps))
        
        # Treat length violation as infeasibility (hard constraint)
        if length_violation:
            obj = BASE_INFEAS + W_INFEAS * length_term
        elif inf_residual > 0.0:
            obj = BASE_INFEAS + W_INFEAS * float(inf_residual)
        else:
            obj = (
                W_THRUST * thrust_penalty_sq_term +
                W_OF * of_sq +
                W_CF * cf_hinge +
                W_EXIT * exit_pressure_sq_term +
                injector_dp_weighted +
                W_LEN * length_term +
                layer1_W_chamber_shape * chamber_shape_term +
                W_MOM * momentum_term +
                layer1_W_impinging_angle * angle_term +
                layer1_W_impinging_jet_asym * jet_asym_term +
                geom_ao_af_weighted
                + layer1_W_SMD * smd_term
            )
        
        if not np.isfinite(obj):
            obj = BASE_INFEAS
        
        # Check for early stopping (pure feasibility + primary objective satisfaction)
        thrust_tol_validation = float(layer1_gate_thrust_tol)
        of_tol_validation = float(layer1_of_validation_tol)
        # Keep "acceptable" criteria aligned with final validation gates.
        dp_gate_obj = True
        _ok_o_dp = injector_dp_ratio_within_gate(ratio_o_obj, layer1_dp_o_band[0], layer1_dp_o_band[1])
        if _ok_o_dp is not None:
            dp_gate_obj &= bool(_ok_o_dp)
        _ok_f_dp = injector_dp_ratio_within_gate(ratio_f_obj, layer1_dp_f_band[0], layer1_dp_f_band[1])
        if _ok_f_dp is not None:
            dp_gate_obj &= bool(_ok_f_dp)
        momentum_gate_obj = True
        _R_m_gate = np.nan
        if "R_m" in locals() and R_m is not None:
            try:
                _R_m_gate = float(R_m)
            except (TypeError, ValueError):
                _R_m_gate = np.nan
        if (
            has_impinging
            and np.isfinite(_R_m_gate)
            and layer1_impinging_R_mom_lo is not None
            and layer1_impinging_R_mom_hi is not None
        ):
            momentum_gate_obj = (
                float(layer1_impinging_R_mom_lo) <= _R_m_gate <= float(layer1_impinging_R_mom_hi)
            )
        errors_acceptable = (
            (infeasibility_score <= 0.0) and
            (thrust_error <= thrust_tol_validation + 1e-12) and
            (of_error <= of_tol_validation + 1e-12) and
            (stability_score >= effective_min_score * 0.8) and
            dp_gate_obj and
            momentum_gate_obj
        )
        
        # Track that we found an acceptable solution, but don't force stop
        # (let optimizer continue to find even better solutions)
        if errors_acceptable:
            if eval_success and final_pressures is not None:
                opt_state["best_pressures"] = final_pressures
                opt_state["best_results_for_validation"] = {
                    "F": F_actual,
                    "MR": MR_actual,
                    "thrust_error": thrust_error,
                    "of_error": of_error,
                    "stability_score": stability_score,
                    "stability_state": stability_state,
                    "chugging_margin": chugging_margin,
                    "acoustic_margin": acoustic_margin,
                    "feed_margin": feed_margin,
                    "stability_results": stability,
                }
            if not opt_state.get('acceptable_found_logged', False):
                log_status("Layer 1", f"✓ Acceptable solution found! Obj={obj:.6e}, Thrust err: {thrust_error*100:.2f}%, O/F err: {of_error*100:.2f}% (continuing optimization...)")
                opt_state['acceptable_found_logged'] = True
            if np.isfinite(obj) and obj <= obj_tolerance:
                opt_state["objective_satisfied"] = True
                if obj < float(opt_state.get("satisfied_obj", float("inf"))):
                    opt_state["satisfied_obj"] = float(obj)
                opt_state["satisfied_eval_count"] = int(opt_state.get("satisfied_eval_count", 0)) + 1
        
        # Track valid evaluations
        if eval_success and np.isfinite(obj):
            opt_state['consecutive_failures'] = 0
            opt_state['last_valid_obj'] = obj
        else:
            opt_state['consecutive_failures'] += 1
            if opt_state['consecutive_failures'] > 200:
                return 1e5
        
        # Record history with all parameterization variables
        def _finite_or_none(v: Any) -> Optional[float]:
            try:
                vv = float(v)
            except Exception:
                return None
            return vv if np.isfinite(vv) else None

        A_throat_curr = float(np.clip(x_clipped[0], bounds[0][0], bounds[0][1]))
        Lstar_curr = float(np.clip(x_clipped[1], bounds[1][0], bounds[1][1]))
        expansion_ratio_curr = float(np.clip(x_clipped[2], bounds[2][0], bounds[2][1]))
        D_outer_curr = float(np.clip(x_clipped[3], bounds[3][0], bounds[3][1]))
        if l1_injector_type == "impinging":
            n_doublets_curr = int(round(np.clip(x_clipped[4], bounds[4][0], bounds[4][1])))
            n_elements_O_curr = n_doublets_curr
            d_jet_O_curr = float(np.clip(x_clipped[5], bounds[5][0], bounds[5][1]))
            imp_ang_O_curr = float(np.clip(x_clipped[6], bounds[6][0], bounds[6][1]))
            spacing_O_curr = float(np.clip(x_clipped[7], bounds[7][0], bounds[7][1]))
            n_elements_F_curr = n_doublets_curr
            d_jet_F_curr = float(np.clip(x_clipped[8], bounds[8][0], bounds[8][1]))
            imp_ang_F_curr = float(np.clip(x_clipped[9], bounds[9][0], bounds[9][1]))
            spacing_F_curr = float(np.clip(x_clipped[10], bounds[10][0], bounds[10][1]))
            d_pintle_tip_curr = float("nan")
            h_gap_curr = float("nan")
            n_orifices_curr = -1
            d_orifice_curr = float("nan")
        else:
            d_pintle_tip_curr = float(np.clip(x_clipped[4], bounds[4][0], bounds[4][1]))
            h_gap_curr = float(np.clip(x_clipped[5], bounds[5][0], bounds[5][1]))
            n_orifices_curr = int(round(np.clip(x_clipped[6], bounds[6][0], bounds[6][1])))
            d_orifice_curr = float(np.clip(x_clipped[7], bounds[7][0], bounds[7][1]))
            n_elements_O_curr = -1
            n_elements_F_curr = -1
            d_jet_O_curr = float("nan")
            d_jet_F_curr = float("nan")
            imp_ang_O_curr = float("nan")
            imp_ang_F_curr = float("nan")
            spacing_O_curr = float("nan")
            spacing_F_curr = float("nan")
        P_O_start_psi_hist = float(np.clip(x_clipped[idx_P_O], bounds[idx_P_O][0], bounds[idx_P_O][1]))
        P_F_start_psi_hist = float(np.clip(x_clipped[idx_P_F], bounds[idx_P_F][0], bounds[idx_P_F][1]))
        
        D_inner_curr = D_outer_curr - TOTAL_WALL_THICKNESS_M
        if D_inner_curr <= 0:
            D_inner_curr = max(D_outer_curr * 0.3, 0.01)
        
        lox_start_ratio_hist = P_O_start_psi_hist / max_lox_P_psi if max_lox_P_psi > 0 else 0.7
        fuel_start_ratio_hist = P_F_start_psi_hist / max_fuel_P_psi if max_fuel_P_psi > 0 else 0.7
        combined_stability_margin = min(chugging_margin, acoustic_margin, feed_margin) if eval_success else 0.0
        L_chamber_hist = L_chamber_curr if (np.isfinite(L_chamber_curr)) else None
        
        opt_state["history"].append({
            "iteration": iteration,
            "x": x_clipped.copy(),
            # Parameterization variables (geometries and pressures)
            "A_throat": A_throat_curr,
            "Lstar": Lstar_curr,
            "expansion_ratio": expansion_ratio_curr,
            "D_chamber_outer": D_outer_curr,
            "D_chamber_inner": D_inner_curr,
            "L_chamber": L_chamber_hist,
            "d_pintle_tip": d_pintle_tip_curr,
            "h_gap": h_gap_curr,
            "n_orifices": n_orifices_curr,
            "d_orifice": d_orifice_curr,
            "n_elements_O": n_elements_O_curr,
            "n_elements_F": n_elements_F_curr,
            "n_doublets": float(n_elements_O_curr) if l1_injector_type == "impinging" else float("nan"),
            "d_jet_O": d_jet_O_curr,
            "impingement_angle_O": imp_ang_O_curr,
            "spacing_O": spacing_O_curr,
            "d_jet_F": d_jet_F_curr,
            "impingement_angle_F": imp_ang_F_curr,
            "spacing_F": spacing_F_curr,
            "effective_smd_microns": _finite_or_none(smd_eff_um),
            "impingement_angle_deg_effective": _finite_or_none(imp_angle_deg),
            "P_O_start_psi": P_O_start_psi_hist,
            "P_F_start_psi": P_F_start_psi_hist,
            # Performance metrics
            "thrust": _finite_or_none(F_actual),
            "thrust_error": thrust_error,
            "of_error": of_error,
            "Isp": _finite_or_none(Isp_actual),
            "MR": _finite_or_none(MR_actual),
            "Pc": _finite_or_none(Pc_actual),
            "Cf": _finite_or_none(Cf_actual),
            "Cf_error": float(np.sqrt(cf_hinge)) if np.isfinite(cf_hinge) else 1.0,
            "Cf_penalty": float(W_CF * cf_hinge),
            # Stability metrics
            "stability_margin": combined_stability_margin,
            "stability_state": stability_state,
            "stability_score": stability_score,
            "chugging_margin": chugging_margin,
            "acoustic_margin": acoustic_margin,
            "feed_margin": feed_margin,
            # Pressure ratios
            "lox_end_ratio": lox_start_ratio_hist,
            "fuel_end_ratio": fuel_start_ratio_hist,
            "lox_start_ratio": lox_start_ratio_hist,
            "fuel_start_ratio": fuel_start_ratio_hist,
            # Feasibility diagnostics
            "infeasibility_score": float(infeasibility_score),
            "eval_success": bool(eval_success),
            "eval_error": eval_error_str,
            # Objective
            "objective": obj,
        })
        
        # Track best
        is_new_best = obj < opt_state["best_objective"]
        if is_new_best:
            opt_state["best_objective"] = obj
            opt_state["best_x"] = x_clipped.copy()
            opt_state["last_best_eval"] = opt_state["function_evaluations"]
            if eval_success:
                opt_state["last_eval_config"] = copy.deepcopy(config)
                opt_state["last_eval_config_x"] = x_clipped.copy()
                opt_state["last_eval_validation_tank_pa"] = (float(P_O_test), float(P_F_test))
            
            # Store objective component breakdown for diagnostics
            opt_state["best_objective_breakdown"] = {
                "thrust_penalty": float(W_THRUST * thrust_penalty_sq_term),
                "of_penalty": float(W_OF * of_sq),
                "cf_penalty": float(W_CF * cf_hinge),
                "exit_pressure_penalty": float(W_EXIT * exit_pressure_sq_term),
                "injector_dp_penalty": float(injector_dp_weighted),
                "injector_dp_ratio_O": ratio_o_obj,
                "injector_dp_ratio_F": ratio_f_obj,
                "length_penalty": float(W_LEN * length_term),
                "chamber_shape_penalty": float(layer1_W_chamber_shape * chamber_shape_term),
                "chamber_D_over_Dt": chamber_dt_ratio_curr,
                "chamber_L_over_D": chamber_ld_ratio_curr,
                "momentum_balance_penalty": float(W_MOM * momentum_term),
                "impingement_angle_penalty": float(layer1_W_impinging_angle * angle_term),
                "jet_angle_asymmetry_penalty": float(layer1_W_impinging_jet_asym * jet_asym_term),
                "smd_penalty": float(layer1_W_SMD * smd_term),
                "effective_smd_microns": _finite_or_none(smd_eff_um),
                "impingement_angle_deg": _finite_or_none(imp_angle_deg),
                "geom_ao_af_momentum_penalty": float(geom_ao_af_weighted),
                "geom_ao_af_momentum_scale": float(geom_ao_af_scale),
                "geom_ao_af": geom_ao_af_ratio_curr,
                "expected_ao_af_for_R1": expected_ao_af_for_R1_curr,
                "infeasibility_penalty": float(BASE_INFEAS + W_INFEAS * infeasibility_score) if infeasibility_score > 0 or length_violation else 0.0,
                "length_violation": bool(length_violation),
                "is_infeasible": bool(infeasibility_score > 0 or length_violation),
            }
            
            # If we were in a valley escape mode, exit it
            if opt_state.get("valley_escape_tier", 0) > 0:
                layer1_logger.info(f"    *** Improvement found: Exiting Valley Escape Tier {opt_state['valley_escape_tier']} ***")
                opt_state["valley_escape_tier"] = 0
            # Only store a "best config" if we actually evaluated successfully and are feasible.
            if eval_success and infeasibility_score <= 0.0:
                opt_state["best_config"] = copy.deepcopy(config)
                opt_state["best_config_x"] = x_clipped.copy()
                opt_state["best_validation_tank_pa"] = (float(P_O_test), float(P_F_test))
                opt_state["best_lox_end_ratio"] = lox_start_ratio_hist
                opt_state["best_fuel_end_ratio"] = fuel_start_ratio_hist
            if (
                eval_success
                and infeasibility_score <= 0.0
                and not length_violation
                and final_pressures is not None
            ):
                opt_state["best_pressures"] = final_pressures
                opt_state["best_results_for_validation"] = {
                    "F": F_actual,
                    "MR": MR_actual,
                    "thrust_error": thrust_error,
                    "of_error": of_error,
                    "stability_score": stability_score,
                    "stability_state": stability_state,
                    "chugging_margin": chugging_margin,
                    "acoustic_margin": acoustic_margin,
                    "feed_margin": feed_margin,
                    "stability_results": stability,
                }
            layer1_logger.info(
                f"    ✓ New best objective: {obj:.6f} "
                f"(thrust_err: {thrust_error*100:.2f}%, O/F_err: {of_error*100:.2f}%, "
                f"Cf: {Cf_actual:.3f}, stability: {stability_state}, score: {stability_score:.3f})"
            )
            for handler in layer1_logger.handlers:
                handler.flush()
        
        # Buffer objective data every iteration (for batch reporting)
        opt_state["objective_buffer"].append({
            "iteration": int(iteration),
            "objective": float(obj),
            "best_objective": float(opt_state.get("best_objective", obj)),
        })
        
        # Stream objective history to external callback (e.g., UI plot) if provided
        # Only call callback every report_every_n iterations (batch reporting)
        should_report = (iteration % report_every_n == 0) or opt_state.get('objective_satisfied', False)
        if objective_callback is not None and should_report:
            try:
                # Send all buffered entries (batch reporting)
                for buffered_entry in opt_state["objective_buffer"]:
                    objective_callback(
                        buffered_entry["iteration"],
                        buffered_entry["objective"],
                        buffered_entry["best_objective"],
                    )
                # Clear buffer after reporting
                opt_state["objective_buffer"] = []
            except Exception:
                # Never let UI/consumer callback break the optimizer loop
                pass
        
        # Convergence check
        stability_acceptable = (
            state_ok and
            (stability_score >= effective_min_score * 0.6) and
            (chugging_margin >= effective_margin * 0.5) and
            (acoustic_margin >= effective_margin * 0.5) and
            (feed_margin >= effective_margin * 0.5)
        )
        
        convergence_thrust_tol = thrust_tol * 2.0
        convergence_of_tol = 0.30
        # `best_objective` is updated above when `is_new_best` is True, so comparing
        # against it here would always be False for a new best. Re-use the flag.
        converged_now = (
            thrust_error < convergence_thrust_tol
            and of_error < convergence_of_tol
            and stability_acceptable
            and np.isfinite(float(opt_state.get("best_objective", float("inf"))))
            and float(opt_state.get("best_objective", float("inf"))) <= obj_tolerance
        )
        # Sticky convergence: once reached with a qualified best solution, keep it true.
        opt_state["converged"] = bool(opt_state.get("converged", False) or converged_now)
        
        return obj
    
    # Run optimization
    layer1_logger.info("")
    layer1_logger.info("Starting optimization...")
    layer1_logger.info("")
    opt_state["iteration"] = 0
    opt_state["function_evaluations"] = 0
    
    class _ResultWrapper:
        def __init__(self, x, fun, success=True):
            self.x = np.asarray(x, dtype=float)
            self.fun = float(fun)
            self.success = success
    
    result = None
    x0_refined = x0
    # lower_bounds/upper_bounds/span are computed above (used for caching and solvers)
    
    # Check CMA-ES availability (required)
    if cma is None:
        raise ImportError(
            "CMA-ES (cma package) is required for Layer 1 optimization but not installed.\n"
            "Install with: pip install cma"
        )
    
    # Run CMA-ES global optimization with random restarts
    layer1_logger.info("Using CMA-ES with random restart strategy for robust optimization.")
    update_progress("Layer 1: CMA-ES", 0.45, "Running CMA-ES global solver...")
    
    # IMPROVED: Initial step size fraction (reduced to 0.15 for better convergence with wide bounds)
    target_fraction_of_range = 0.15  # 15% of range per sigma for reliable convergence
    
    # Calculate base sigma0 from 25th percentile span (less sensitive to large diameter bounds)
    # Using percentile instead of median prevents large bound changes from dominating step size
    sigma0 = float(np.percentile(span, 25) * target_fraction_of_range)
    if not np.isfinite(sigma0) or sigma0 <= 0:
        sigma0 = 0.05
    
    # Set CMA_stds proportional to each variable's range
    # This ensures variables with larger ranges (like expansion_ratio) get larger step sizes
    cma_stds = np.ones_like(span)
    for i in range(len(span)):
        if span[i] > 0:
            # Desired step size for this dimension: fraction of its range
            desired_step = span[i] * target_fraction_of_range
            # CMA_stds[i] = desired_step / sigma0
            # This makes step size in dimension i proportional to its range
            cma_stds[i] = max(0.1, desired_step / sigma0) if sigma0 > 0 else 1.0
    
    # Discrete integer dimensions (n_orifices or impinging element counts)
    target_step_n = 1.0
    if sigma0 > 0:
        for idx_disc in layer1_integer_dims:
            if 0 <= idx_disc < len(cma_stds):
                cma_stds[idx_disc] = max(cma_stds[idx_disc], target_step_n / sigma0)

    # IMPROVED: Larger population for better exploration (32-80 instead of 16-48)
    # Standardized population for better diversity (increased to 48)
    popsize = 48
    layer1_logger.info(f"Population size: {popsize}")
    
    num_restarts = 3 if layer1_cma_restarts is None else max(1, int(layer1_cma_restarts))
    if layer1_smoke and layer1_cma_restarts is None:
        num_restarts = 1
    layer1_logger.info(f"Using {num_restarts} CMA restart(s)")

    # Legacy CMA uses this for ``maxiter`` per restart (hybrid path sets its own budget).
    total_eval_budget = max_iterations
    
    best_x_global = x0_refined
    best_f_global = float('inf')
    
    
    # ============================================================================
    # Setup for Parallel Evaluation (used by both hybrid and default CMA-ES)
    # ============================================================================
    num_workers = _get_num_workers(config_obj)
    debug_strict = getattr(config_obj.optimizer, 'debug_strict', False) if hasattr(config_obj, 'optimizer') else False
    
    layer1_logger.info(f"Using {num_workers} worker processes for parallel evaluation")
    
    # Prepare worker init args
    config_dict = _config_to_dict(config_base)
    bounds_array = np.column_stack([lower_bounds, upper_bounds])
    constants_dict = {
        'target_thrust': target_thrust,
        'optimal_of': optimal_of,
        'P_ambient': target_P_exit,  # Ambient pressure (atmospheric)
        'max_lox_P_psi': max_lox_P_psi,
        'max_fuel_P_psi': max_fuel_P_psi,
        'TOTAL_WALL_THICKNESS_M': TOTAL_WALL_THICKNESS_M,
        'max_nozzle_exit': max_nozzle_exit,
        'max_chamber_od': max_chamber_od,
        'injector_type': l1_injector_type,
        'idx_P_O': idx_P_O,
        'idx_P_F': idx_P_F,
        'W_MOM': layer1_W_MOM,
        'W_DP': layer1_W_DP,
        'W_DP_O': layer1_W_DP_O,
        'W_DP_F': layer1_W_DP_F,
        'W_DP_HIGH': layer1_W_DP_HIGH,
        'injector_dp_ratio_O_min': layer1_dp_o_band[0],
        'injector_dp_ratio_O_max': layer1_dp_o_band[1],
        'injector_dp_ratio_F_min': layer1_dp_f_band[0],
        'injector_dp_ratio_F_max': layer1_dp_f_band[1],
        'W_geom_ao_af_momentum': layer1_W_geom_ao_af,
        'rho_oxidizer': float(config_base.fluids["oxidizer"].density),
        'rho_fuel': float(config_base.fluids["fuel"].density),
        'impinging_momentum_R_min': layer1_impinging_R_mom_lo,
        'impinging_momentum_R_max': layer1_impinging_R_mom_hi,
        'W_IMPINGING_ANGLE': layer1_W_impinging_angle,
        'W_IMPINGING_JET_ASYM': layer1_W_impinging_jet_asym,
        'layer1_impinging_jet_angle_max_asym_deg': layer1_impinging_jet_max_asym_deg,
        'layer1_exit_pressure_inside_quad_scale': layer1_exit_pressure_inside_quad,
        'layer1_impinging_angle_deg_min': layer1_impinging_angle_deg_lo,
        'layer1_impinging_angle_deg_max': layer1_impinging_angle_deg_hi,
        'W_CHAMBER_SHAPE': layer1_W_chamber_shape,
        'layer1_chamber_dt_ratio_min': layer1_chamber_dt_ratio_min,
        'layer1_chamber_dt_ratio_max': layer1_chamber_dt_ratio_max,
        'layer1_chamber_ld_ratio_min': layer1_chamber_ld_ratio_min,
        'layer1_chamber_ld_ratio_max': layer1_chamber_ld_ratio_max,
        'injector_dp_ratio_O_soft_floor': layer1_dp_o_soft_floor,
        'W_DP_O_FLOOR': layer1_W_DP_O_FLOOR,
        'W_SMD': layer1_W_SMD,
        'target_smd_microns': layer1_target_smd_microns,
        'layer1_smd_rel_tol': layer1_smd_rel_tol,
        'layer1_impinging_smd_corr_C': layer1_impinging_smd_corr_C,
        'layer1_impinging_smd_corr_a': layer1_impinging_smd_corr_a,
        'layer1_impinging_smd_corr_b': layer1_impinging_smd_corr_b,
        'layer1_impinging_smd_phi_floor_deg': layer1_impinging_smd_phi_floor_deg,
        'layer1_W_THRUST': layer1_W_THRUST_obj,
        'layer1_W_OF': layer1_W_OF_obj,
        'layer1_W_OF_low_MR_scale': layer1_W_OF_low_MR_scale,
        'layer1_W_OF_high_MR_scale': layer1_W_OF_high_MR_scale,
        'layer1_of_validation_tol': layer1_of_validation_tol,
    }

    integer_dims = list(layer1_integer_dims)
    
    # DISPATCH: Check optimizer mode (smoke runs force pure CMA so max_iterations stays meaningful)
    optimizer_mode = "cma"  # default
    if hasattr(config_obj, "optimizer") and config_obj.optimizer:
        optimizer_mode = config_obj.optimizer.mode
    effective_mode = optimizer_mode
    if layer1_smoke:
        effective_mode = "cma"
        layer1_logger.info(
            "Layer 1 smoke: forcing pure CMA-ES (config optimizer.mode=%r ignored for hybrid).",
            optimizer_mode,
        )

    # Create evaluator executor for candidate scoring.
    # On some macOS/sandboxed environments, ProcessPool creation can fail with
    # PermissionError/OSError (e.g., semaphore sysconf restrictions). Fall back
    # to serial evaluation in-process so optimization can still run.
    executor_context = None
    if num_workers > 1:
        try:
            executor_context = ProcessPoolExecutor(
                max_workers=num_workers,
                initializer=_init_worker,
                initargs=(config_dict, bounds_array, requirements, constants_dict, debug_strict),
            )
        except (PermissionError, OSError) as e:
            layer1_logger.warning(
                "ProcessPool unavailable (%s). Falling back to serial Layer-1 evaluation.",
                e,
            )
            num_workers = 1

    if executor_context is None:
        _init_worker(config_dict, bounds_array, requirements, constants_dict, debug_strict)
        executor_context = _LocalSerialExecutor()

    with executor_context as executor:
        
        # Optional: Warm-up call per worker (first call can trigger lazy imports)
        if num_workers > 1:
            dummy_candidate = _snap_integer_dims(x0_refined.copy(), integer_dims)
            list(executor.map(_eval_candidate, [dummy_candidate] * num_workers))

        # ------------------------------------------------------------------
        # CMA warm-start (hybrid + legacy): same ``_eval_candidate`` / objective as CMA
        # workers. Improves ``x0``; syncs ``opt_state`` + SSE plot (parallel CMA never
        # calls ``objective()``, so the UI curve used to miss this entirely).
        # ------------------------------------------------------------------
        best_x_global = np.asarray(x0_refined, dtype=float).copy()
        best_f_global = float("inf")
        layer1_warmstart_applied = False
        _ws_n_raw = requirements.get("layer1_cma_warmstart_trials")
        _ws_n = 16 if _ws_n_raw is None else int(_ws_n_raw)
        if layer1_smoke:
            _ws_n = min(_ws_n, 4)
        _ws_sig = _requirement_float(requirements, "layer1_cma_warmstart_sigma_frac", 0.04)
        if _ws_n > 0:
            x0_refined, _ws_best_f = _layer1_cma_warmstart_candidates(
                x0_refined,
                lower_bounds=lower_bounds,
                upper_bounds=upper_bounds,
                span=span,
                integer_dims=integer_dims,
                rng=rng,
                executor=executor,
                n_trials=_ws_n,
                sigma_frac=_ws_sig,
                eval_cache=eval_cache,
                make_cache_key_fn=_make_eval_cache_key,
                opt_state=opt_state,
                logger=layer1_logger,
            )
            layer1_warmstart_applied = True
            best_x_global = np.asarray(x0_refined, dtype=float).copy()
            if np.isfinite(_ws_best_f):
                best_f_global = float(_ws_best_f)
                _layer1_sync_best_from_worker_eval(opt_state, best_x_global, float(_ws_best_f))
                _layer1_emit_objective_plot_point(
                    objective_callback,
                    opt_state,
                    int(opt_state.get("function_evaluations", 0)),
                    float(_ws_best_f),
                    float(opt_state.get("best_objective", _ws_best_f)),
                )

        if effective_mode == "hybrid_cma_blocks" and hasattr(config_obj.optimizer, "hybrid"):
            layer1_logger.info("Using Hybrid CMA + Block Re-optimization mode.")
            hybrid_config = config_obj.optimizer.hybrid
            
            # Tie hybrid budget to Layer 1 max_iterations (population-sized generations).
            total_budget_evals = max(int(popsize), int(max_iterations) * int(popsize))
            layer1_logger.info(
                "Hybrid evaluation budget: %s (max(%s, max_iterations=%s × popsize=%s))",
                total_budget_evals,
                popsize,
                max_iterations,
                popsize,
            )
            
            # Run Multi-Track Hybrid?
            num_tracks = hybrid_config.num_tracks
            
            best_x_global = x0_refined
            best_f_global = float('inf')
            
            if num_tracks > 1:
                layer1_logger.info(f"Running {num_tracks} independent hybrid tracks...")
                # Track initialization: Top-N restarts?
                # User feedback says: "track i starts from best of restart i"
                # So we first need to run N restarts of global exploration to seed tracks?
                # OR we simply start N tracks from random perturbations of x0.
                # "Multi-track: Initialize tracks from Top-N best results of Stage A restarts."
                # My run_hybrid_optimization includes Stage A internally. 
                # So "Multi-track" essentially means distinct runs of run_hybrid_optimization?
                # OR running Stage A first, then branching?
                # Let's treat "Multi-track" as running the WHOLE hybrid process N times with different seeds.
                 
                for track_i in range(num_tracks):
                    check_stop()  # Check if optimization should stop
                    layer1_logger.info(f"--- Track {track_i+1}/{num_tracks} ---")
                    
                    # Perturb start point for diversity if track > 0
                    if track_i > 0:
                        x0_track = x0_refined + rng.standard_normal(len(x0_refined)) * (0.1 * span)
                        x0_track = np.clip(x0_track, lower_bounds, upper_bounds)
                    else:
                        x0_track = x0_refined
                        
                    t_x, t_f, t_ev = run_hybrid_optimization(
                        objective,
                        list(zip(lower_bounds, upper_bounds)),
                        x0_track,
                        hybrid_config,
                        total_budget=total_budget_evals // num_tracks,
                        logger=layer1_logger,
                        log_status_fn=log_status,
                        update_progress_fn=update_progress,
                        valley_escape_tracker=opt_state,
                        # Parallel evaluation parameters
                        executor=executor,
                        integer_dims=integer_dims,
                        eval_cache=eval_cache,
                        make_cache_key_fn=_make_eval_cache_key,
                        stop_event=stop_event,
                    )
                    
                    if t_f < best_f_global:
                        best_f_global = t_f
                        best_x_global = t_x
                        layer1_logger.info(f"Track {track_i+1} found new global best: {best_f_global:.5f}")
                        
            else:
                # Single track
                best_x_global, best_f_global, evs = run_hybrid_optimization(
                    objective,
                    list(zip(lower_bounds, upper_bounds)),
                    x0_refined,
                    hybrid_config,
                    total_budget=total_budget_evals,
                    logger=layer1_logger,
                    log_status_fn=log_status,
                    update_progress_fn=update_progress,
                    valley_escape_tracker=opt_state,
                    # Parallel evaluation parameters
                    executor=executor,
                    integer_dims=integer_dims,
                    eval_cache=eval_cache,
                    make_cache_key_fn=_make_eval_cache_key,
                    stop_event=stop_event,
                )

        else:
            # Default/Fallback: Legacy CMA-ES Logic with Parallel Evaluation
            best_x_global = np.asarray(x0_refined, dtype=float).copy()
            if not layer1_warmstart_applied:
                best_f_global = float("inf")

            for restart_idx in range(num_restarts):
                restart_name = f"Restart {restart_idx + 1}/{num_restarts}" if num_restarts > 1 else "Main search"
                
                # IMPROVED: Multi-scale restart strategy
                if restart_idx == 0:
                    current_sigma_fraction = target_fraction_of_range # 25% (Global)
                    x_start = x0_refined
                elif restart_idx == 1:
                    current_sigma_fraction = 0.05 # 5% (Refined)
                    perturbation = rng.standard_normal(len(best_x_global)) * (sigma0 * 0.1)
                    x_start = best_x_global + perturbation
                elif restart_idx == 2:
                    current_sigma_fraction = 0.15 # 15% (Medium)
                    perturbation = rng.standard_normal(len(best_x_global)) * (sigma0 * 0.3)
                    x_start = best_x_global + perturbation
                else:
                    current_sigma_fraction = 0.15 if restart_idx % 2 == 0 else 0.25
                    perturbation = rng.standard_normal(len(best_x_global)) * (sigma0 * 0.3)
                    x_start = best_x_global + perturbation
                
                x_start = np.clip(x_start, lower_bounds, upper_bounds)
                    
                current_sigma0 = float(np.percentile(span, 25) * current_sigma_fraction)
                if not np.isfinite(current_sigma0) or current_sigma0 <= 0:
                    current_sigma0 = 0.05
                # First restart only: tighter initial cloud around warm-started ``x0`` so generation-1
                # samples do not all land in ``BASE_INFEAS`` (~1e6) when global sigma is huge.
                if restart_idx == 0 and layer1_warmstart_applied:
                    _s0_scale = _requirement_float(requirements, "layer1_cma_restart0_sigma_scale", 0.48)
                    current_sigma0 *= float(np.clip(_s0_scale, 0.12, 1.0))
                    
                current_cma_stds = np.ones_like(span)
                for i in range(len(span)):
                    if span[i] > 0:
                        desired_step = span[i] * current_sigma_fraction
                        current_cma_stds[i] = max(0.1, desired_step / current_sigma0) if current_sigma0 > 0 else 1.0
                
                if current_sigma0 > 0:
                    for idx_disc in layer1_integer_dims:
                        if 0 <= idx_disc < len(current_cma_stds):
                            current_cma_stds[idx_disc] = max(
                                current_cma_stds[idx_disc], 1.0 / current_sigma0
                            )
        
                layer1_logger.info(f"")
                layer1_logger.info(f"Starting {restart_name} (sigma: {current_sigma_fraction*100:.0f}% of range)...")
                
                iter_budget = total_eval_budget // num_restarts
                
                # Without an explicit ``seed``, cma uses non-deterministic defaults → different optima each run.
                _cma_restart_seed = layer1_seed_base + int(restart_idx) * 1_000_003
                cma_options = {
                    "bounds": [lower_bounds.tolist(), upper_bounds.tolist()],
                    "popsize": popsize,
                    "maxiter": iter_budget,
                    "verb_disp": 0,
                    "verb_log": 0,
                    "CMA_stds": current_cma_stds.tolist(),
                    "tolx": 1e-8,
                    "tolfun": 1e-9,
                    "tolstagnation": 50,
                    "ftarget": -np.inf,
                    "seed": _cma_restart_seed,
                }
                
                try:
                    es = cma.CMAEvolutionStrategy(x_start.tolist(), current_sigma0, cma_options)
                    while not es.stop():
                        # Check if optimization should stop
                        check_stop()
                        
                        # Check for Valley Escape boost
                        target_tier = _check_valley_escape_tier()
                        if target_tier > opt_state["valley_escape_tier"] and opt_state["function_evaluations"] > opt_state["cooldown_until"]:
                            # Tier definitions
                            tier_names = ["None", "Mild", "Medium", "Full"]
                            boost_factors = [1.0, 1.5, 2.0, 3.0]
                            current_factor = boost_factors[opt_state["valley_escape_tier"]]
                            target_factor = boost_factors[target_tier]
                            relative_boost = target_factor / current_factor
                            
                            old_sigma = es.sigma
                            es.sigma *= relative_boost
                            
                            # Clamp sigma to 30% of 25th percentile span to prevent sampling nonsense
                            max_sigma = 0.3 * float(np.percentile(span, 25))
                            if es.sigma > max_sigma:
                                es.sigma = max_sigma
                                
                            # Update state
                            opt_state["valley_escape_tier"] = target_tier
                            opt_state["cooldown_until"] = opt_state["function_evaluations"] + 1000
                            
                            layer1_logger.info("!" * 20)
                            layer1_logger.info(f"VALLEY ESCAPE TRIGGERED (Tier: {tier_names[target_tier]})")
                            layer1_logger.info(f"Evals: {opt_state['function_evaluations']}, Best: {opt_state['best_objective']:.2f}, Stagnation: {opt_state['function_evaluations'] - opt_state['last_best_eval']}")
                            layer1_logger.info(f"Sigma: {old_sigma:.6f} -> {es.sigma:.6f} (Boost: {relative_boost:.2f}x)")
                            layer1_logger.info("!" * 20)
                            for handler in layer1_logger.handlers:
                                handler.flush()


                        # CMA-ES samples within bounds (no manual clipping needed)
                        candidates = es.ask()
                        
                        # Snap integer dimensions for consistency
                        # Convert to numpy arrays (pickle-safe in WSL)
                        candidates_snapped = [
                            _snap_integer_dims(np.asarray(c, dtype=np.float64), integer_dims)
                            for c in candidates
                        ]
                        
                        # Parent-side caching: check cache before submitting work
                        # Cache keys use SNAPPED values for consistency
                        cache_keys = [_make_eval_cache_key(c) for c in candidates_snapped]
                        uncached_indices = []
                        uncached_candidates = []
                        values = [None] * len(candidates)
                        
                        for i, key in enumerate(cache_keys):
                            if key in eval_cache:
                                cached_val = eval_cache[key]
                                # Handle dict format from parallel eval (has 'value' key)
                                # Note: dict format from objective() has 'results' but not 'value', so we can't use it here
                                if isinstance(cached_val, dict) and 'value' in cached_val:
                                    values[i] = float(cached_val['value'])
                                elif isinstance(cached_val, (int, float)):
                                    # Old format: direct float value (backward compatibility)
                                    values[i] = float(cached_val)
                                else:
                                    # Full format from objective() or unknown format - can't extract value, treat as uncached
                                    uncached_indices.append(i)
                                    uncached_candidates.append(candidates_snapped[i])
                            else:
                                uncached_indices.append(i)
                                uncached_candidates.append(candidates_snapped[i])
                        
                        # Parallel evaluation of uncached candidates
                        if uncached_candidates:
                            chunksize = max(1, len(uncached_candidates) // (num_workers * 4))
                            results = list(executor.map(_eval_candidate, uncached_candidates, chunksize=chunksize))
                            
                            # Merge results back and update parent state
                            for idx, res in zip(uncached_indices, results):
                                obj_val = res['value']
                                values[idx] = obj_val
                                
                                # Cache result (using snapped key) - store in dict format for compatibility
                                eval_cache[cache_keys[idx]] = {
                                    'value': obj_val,
                                    'success': res.get('success', True),
                                }
                                
                                # Parent owns: tracking, logging, history
                                # Count ALL evaluations (success + failure) for accurate metrics
                                opt_state['function_evaluations'] += 1
                                _store_last_good_eval_bundle_from_worker_res(res, opt_state)

                                if not res['success']:
                                    # Track failures
                                    reason = res.get('error_type', 'Unknown')
                                    opt_state['num_failures'] = opt_state.get('num_failures', 0) + 1
                                    
                                    # Track failure reasons
                                    if 'fail_counts' not in opt_state:
                                        opt_state['fail_counts'] = {}
                                    opt_state['fail_counts'][reason] = opt_state['fail_counts'].get(reason, 0) + 1
                                    
                                    # Periodic failure logging (every 100 evals)
                                    if opt_state['function_evaluations'] % 100 == 0:
                                        # Sort failures by count descending
                                        sorted_fails = sorted(opt_state['fail_counts'].items(), key=lambda item: item[1], reverse=True)
                                        top_fails = sorted_fails[:3]
                                        fail_msg = ", ".join([f"{k}: {v}" for k, v in top_fails])
                                        layer1_logger.warning(f"Recent Failures (Top 3): {fail_msg}")
                                        
                                    layer1_logger.warning(f"Eval failed: {reason}")
                        
                        # Tell CMA-ES using ORIGINAL candidates (not snapped)
                        # This is correct because CMA-ES needs to update its distribution
                        es.tell(candidates, values)
                        
                        _fv = [
                            float(v) if v is not None and np.isfinite(float(v)) else float("inf")
                            for v in values
                        ]
                        if _fv and min(_fv) < float("inf"):
                            _gen_best = float(min(_fv))
                            _gi = int(np.argmin(np.asarray(_fv, dtype=float)))
                            _layer1_sync_best_from_worker_eval(
                                opt_state, candidates_snapped[_gi], _gen_best
                            )
                            _layer1_emit_objective_plot_point(
                                objective_callback,
                                opt_state,
                                int(opt_state.get("function_evaluations", 0)),
                                _gen_best,
                                float(opt_state.get("best_objective", _gen_best)),
                            )
                        
                        iter_idx = max(1, es.countiter)
                        overall_progress = restart_idx / num_restarts
                        restart_progress = iter_idx / iter_budget / num_restarts
                        progress = 0.10 + 0.35 * (overall_progress + restart_progress)
                        update_progress("Layer 1: CMA-ES", progress, 
                                      f"{restart_name} - iteration {iter_idx}/{iter_budget}")
                    
                    cma_result = es.result
                    restart_best_x = np.asarray(cma_result.xbest, dtype=float)
                    restart_best_f = float(cma_result.fbest)
                    
                    layer1_logger.info(f"{restart_name} finished. Final obj: {restart_best_f:.6f}")
                    
                    if restart_best_f < best_f_global:
                        best_f_global = restart_best_f
                        best_x_global = restart_best_x
                        layer1_logger.info(f"  ✓ New global best: {best_f_global:.6f}")
                    
                    if best_f_global < obj_tolerance:
                        layer1_logger.info(f"Found excellent solution, skipping restarts")
                        break
                        
                    for handler in layer1_logger.handlers:
                        handler.flush()
                        
                except Exception as e:
                    layer1_logger.error(f"{restart_name} failed: {e}")
                    if restart_idx == 0:
                        raise
                    continue

    
    # Use best result across all restarts
    x0_refined = best_x_global
    best_fun = best_f_global
    layer1_logger.info(f"")
    layer1_logger.info(f"CMA-ES complete. Global best objective: {best_fun:.6f}")
    layer1_logger.info(f"Total function evaluations: {opt_state['function_evaluations']}")
    log_status("Layer 1", f"CMA-ES complete: {num_restarts} restart(s), obj={best_fun:.3f}, refining with L-BFGS-B...")
    for handler in layer1_logger.handlers:
        handler.flush()
    
    # Reset function evaluation counter for L-BFGS-B refinement
    opt_state["function_evaluations"] = 0

    
    # L-BFGS-B refinement runs after CMA-ES
    # Always run full local optimization regardless of current objective value
    # ``minimize(..., ftol=...)`` for L-BFGS-B is **not** a tolerance on Layer 1's
    # composite objective magnitude. SciPy divides by ``mach_eps`` internally to form
    # Fortran ``factr`` (see ``scipy.optimize._lbfgsb_py``). Passing ``obj_tolerance*0.1``
    # (~0.2) made ``factr`` ~ 1e15 → effectively immediate "convergence" with ~1e-4 residuals.
    maxfun_capped = min(max_iterations * 5, 2500)

    opt_state["layer1_lbfgs_phase"] = True
    update_progress("Layer 1: Local Refinement", 0.47, f"Refining with L-BFGS-B (max {maxfun_capped} func evals)...")
    layer1_logger.info("Phase 2: Local refinement (L-BFGS-B)...")

    try:
        lbfgs_result = minimize(
            objective,
            x0_refined,
            method='L-BFGS-B',
            bounds=bounds,
            options={
                'maxiter': max_iterations,
                'maxfun': maxfun_capped,
                # Omitted ftol uses SciPy's default (~``mach_eps`` × 1e7 / ``factr`` workflow).
                'gtol': layer1_lbfgs_gtol,
                'maxls': 50,
                'disp': False,
            }
        )
        if layer1_lbfgs_second_pass and getattr(lbfgs_result, "success", True):
            _gt2 = float(max(1e-15, min(1e-12, layer1_lbfgs_gtol * 0.05)))
            try:
                lbfgs_result2 = minimize(
                    objective,
                    np.asarray(lbfgs_result.x, dtype=float),
                    method="L-BFGS-B",
                    bounds=bounds,
                    options={
                        "maxiter": max_iterations,
                        "maxfun": min(800, maxfun_capped),
                        "gtol": _gt2,
                        "maxls": 60,
                        "disp": False,
                    },
                )
                if np.isfinite(getattr(lbfgs_result2, "fun", float("nan"))) and float(lbfgs_result2.fun) <= float(
                    lbfgs_result.fun
                ):
                    lbfgs_result = lbfgs_result2
                    layer1_logger.info(
                        "L-BFGS-B second pass improved objective to %.6g (gtol=%.1e)",
                        float(lbfgs_result.fun),
                        _gt2,
                    )
            except Exception as _e2:
                layer1_logger.debug("L-BFGS-B second pass skipped: %s", _e2)
        layer1_logger.info("")
        layer1_logger.info("Optimization completed")
        layer1_logger.info(f"Success: {lbfgs_result.success}")
        layer1_logger.info(f"Final objective value: {lbfgs_result.fun:.6f}")
        layer1_logger.info(f"Iterations: {lbfgs_result.nit if hasattr(lbfgs_result, 'nit') else 'N/A'}")
        layer1_logger.info(f"Function evaluations: {lbfgs_result.nfev if hasattr(lbfgs_result, 'nfev') else 'N/A'}")
        layer1_logger.info("")
        result = lbfgs_result
    except Exception as e:
        layer1_logger.error(f"L-BFGS-B error: {e}")
        log_status("Layer 1 Warning", f"L-BFGS-B error: {e}, using best result found")
        # Use CMA-ES result or best found during optimization
        if 'best_fun' in locals():
            # CMA-ES succeeded but L-BFGS-B failed
            result = _ResultWrapper(x0_refined, best_fun)
        else:
            # Use best from optimization state
            best_x = opt_state.get('best_x', x0)
            best_obj = opt_state.get('best_objective', float('inf'))
            result = _ResultWrapper(best_x, best_obj)
    finally:
        opt_state.pop("layer1_lbfgs_phase", None)
    
    validation_tank_pa: Optional[Tuple[float, float]] = None
    if opt_state["best_config"] is not None:
        optimized_config = copy.deepcopy(opt_state["best_config"])
        final_lox_end_ratio = opt_state.get("best_lox_end_ratio", 0.7)
        final_fuel_end_ratio = opt_state.get("best_fuel_end_ratio", 0.7)
        validation_tank_pa = opt_state.get("best_validation_tank_pa")
    elif opt_state.get("last_eval_config") is not None:
        optimized_config = copy.deepcopy(opt_state["last_eval_config"])
        final_lox_end_ratio = opt_state.get("best_lox_end_ratio", 0.7)
        final_fuel_end_ratio = opt_state.get("best_fuel_end_ratio", 0.7)
        validation_tank_pa = opt_state.get("last_eval_validation_tank_pa")
    else:
        _rx = getattr(result, "x", None)
        _rx = np.asarray(_rx if _rx is not None else x0, dtype=float).copy()
        optimized_config, P_O_final_psi, P_F_final_psi = apply_x_to_config(_rx, config_base)
        final_lox_end_ratio = P_O_final_psi / max_lox_P_psi if max_lox_P_psi > 0 else 0.7
        final_fuel_end_ratio = P_F_final_psi / max_fuel_P_psi if max_fuel_P_psi > 0 else 0.7
    
    # Ensure tank configs exist
    if optimized_config.lox_tank is None:
        from engine.pipeline.config_schemas import LOXTankConfig
        optimized_config.lox_tank = LOXTankConfig(lox_h=0.5, lox_radius=0.1, ox_tank_pos=1.0)
    if optimized_config.fuel_tank is None:
        from engine.pipeline.config_schemas import FuelTankConfig
        optimized_config.fuel_tank = FuelTankConfig(rp1_h=0.5, rp1_radius=0.1, fuel_tank_pos=0.5)
    
    # Extract optimized pressures
    best_x = opt_state.get("best_x", result.x if hasattr(result, 'x') else x0)
    # Pressures must match the geometry snapshot in ``best_config`` when present (``best_x`` alone can
    # refer to an infeasible iterate while ``best_config`` still holds the last feasible design).
    x_for_tank_psi = opt_state.get("best_config_x")
    if x_for_tank_psi is None or len(x_for_tank_psi) <= idx_P_F:
        x_for_tank_psi = opt_state.get("last_eval_config_x")
    if x_for_tank_psi is None or len(x_for_tank_psi) <= idx_P_F:
        x_for_tank_psi = best_x
    if x_for_tank_psi is not None and len(x_for_tank_psi) > idx_P_F:
        P_O_start_optimized_psi = float(
            np.clip(x_for_tank_psi[idx_P_O], bounds[idx_P_O][0], bounds[idx_P_O][1])
        )
        P_F_start_optimized_psi = float(
            np.clip(x_for_tank_psi[idx_P_F], bounds[idx_P_F][0], bounds[idx_P_F][1])
        )
        optimized_config.lox_tank.initial_pressure_psi = P_O_start_optimized_psi
        optimized_config.fuel_tank.initial_pressure_psi = P_F_start_optimized_psi
    else:
        optimized_config.lox_tank.initial_pressure_psi = max_lox_P_psi * 0.8
        optimized_config.fuel_tank.initial_pressure_psi = max_fuel_P_psi * 0.8

    # Ensure orifice angle is 90°
    if hasattr(optimized_config, 'injector') and optimized_config.injector.type == "pintle":
        if hasattr(optimized_config.injector.geometry, 'lox'):
            optimized_config.injector.geometry.lox.theta_orifice = 90.0
    
    iteration_history = opt_state["history"]
    
    def _validation_evaluate_boost(
        runner: PintleEngineRunner,
        po: float,
        pf: float,
    ) -> Tuple[Dict[str, Any], float]:
        """Run final ``evaluate``; if marginally supply-starved, retry with mild tank-pressure boost."""
        po0, pf0 = float(po), float(pf)
        last_exc: Optional[Exception] = None
        for scale in (1.0, 1.03, 1.06, 1.09, 1.14, 1.20, 1.28, 1.40, 1.55, 1.72):
            try:
                return (
                    runner.evaluate(
                        po0 * scale,
                        pf0 * scale,
                        P_ambient=target_P_exit,
                        silent=True,
                    ),
                    scale,
                )
            except ValueError as exc:
                last_exc = exc
                if "Supply < Demand" not in str(exc) and "Insufficient mass flow" not in str(exc):
                    raise
            except Exception as exc:
                last_exc = exc
                raise
        assert last_exc is not None
        raise last_exc

    def _validation_evaluate_or_bundle(
        runner: PintleEngineRunner,
        po: float,
        pf: float,
    ) -> Tuple[Dict[str, Any], float]:
        """Replay validation evaluate; fall back to the last optimizer ``evaluate`` payload if the solver diverges."""
        try:
            return _validation_evaluate_boost(runner, po, pf)
        except ValueError as exc:
            b = opt_state.get("last_good_eval_bundle")
            if not isinstance(b, dict) or not isinstance(b.get("results"), dict):
                raise
            layer1_logger.warning(
                "Layer 1 validation replay failed (%s); using last-good in-loop evaluate payload.", exc
            )
            perf = copy.deepcopy(b["results"])
            perf["layer1_validation_used_last_good_bundle"] = True
            return perf, 1.0
    
    # Validation
    update_progress("Layer 1: Validation", 0.52, "Validating optimized configuration...")
    
    best_x = opt_state.get("best_x", result.x if hasattr(result, 'x') else x0)
    validation_pressure_scale = 1.0
    
    # Prefer exact LOX/fuel tank pressures (Pa) used in the iterate that produced this geometry snapshot;
    # avoids psi↔Pa rounding drift vs ``initial_pressure_psi`` clipping.
    if validation_tank_pa is not None and len(validation_tank_pa) == 2:
        P_O_initial = float(validation_tank_pa[0])
        P_F_initial = float(validation_tank_pa[1])
    else:
        try:
            P_O_initial = float(optimized_config.lox_tank.initial_pressure_psi) * psi_to_Pa
            P_F_initial = float(optimized_config.fuel_tank.initial_pressure_psi) * psi_to_Pa
        except Exception:
            if best_x is not None and len(best_x) > idx_P_O:
                P_O_initial = float(np.clip(best_x[idx_P_O], bounds[idx_P_O][0], bounds[idx_P_O][1])) * psi_to_Pa
            else:
                P_O_initial = max_lox_P_psi * psi_to_Pa * 0.95
            if best_x is not None and len(best_x) > idx_P_F:
                P_F_initial = float(np.clip(best_x[idx_P_F], bounds[idx_P_F][0], bounds[idx_P_F][1])) * psi_to_Pa
            else:
                P_F_initial = max_fuel_P_psi * psi_to_Pa * 0.95

    optimized_config_runner = copy.deepcopy(optimized_config)
    if hasattr(optimized_config_runner, "ablative_cooling") and optimized_config_runner.ablative_cooling:
        optimized_config_runner.ablative_cooling.enabled = False
    if hasattr(optimized_config_runner, "graphite_insert") and optimized_config_runner.graphite_insert:
        optimized_config_runner.graphite_insert.enabled = False
    
    optimized_runner = PintleEngineRunner(optimized_config_runner)
    
    # Use stored validation results if available
    if "best_results_for_validation" in opt_state and opt_state["best_results_for_validation"] is not None:
        stored_results = opt_state["best_results_for_validation"]
        initial_performance = {
            "F": stored_results["F"],
            "MR": stored_results["MR"],
            "Isp": 250.0,
            "Pc": 2e6,
            "stability_results": stored_results.get("stability_results", {}),
        }
        initial_thrust_error = stored_results["thrust_error"]
        initial_MR_error = stored_results["of_error"]
        stored_stability_score = stored_results.get("stability_score", None)
        stored_stability_state = stored_results.get("stability_state", None)
        log_status("Layer 1 Validation", f"Using stored validation results: Thrust err {initial_thrust_error*100:.2f}%, O/F err {initial_MR_error*100:.2f}%")
        
        # For stored results, we need to re-evaluate to get P_exit and Cf
        # (stored_results only contains F, MR, errors, and stability)
        try:
            eval_results, validation_pressure_scale = _validation_evaluate_or_bundle(
                optimized_runner, P_O_initial, P_F_initial
            )
            # Copy P_exit and Cf from evaluation if available
            if "P_exit" in eval_results:
                initial_performance["P_exit"] = eval_results["P_exit"]
            if "Cf" in eval_results or "Cf_actual" in eval_results:
                initial_performance["Cf"] = eval_results.get("Cf_actual", eval_results.get("Cf"))
                initial_performance["Cf_actual"] = initial_performance["Cf"]
            # Also copy other useful metrics that might be missing
            if "Isp" in eval_results:
                initial_performance["Isp"] = eval_results["Isp"]
            if "Pc" in eval_results:
                initial_performance["Pc"] = eval_results["Pc"]
            # Copy mass flow rates and efficiency metrics
            if "mdot_total" in eval_results:
                initial_performance["mdot_total"] = eval_results["mdot_total"]
            if "mdot_O" in eval_results:
                initial_performance["mdot_O"] = eval_results["mdot_O"]
            if "mdot_F" in eval_results:
                initial_performance["mdot_F"] = eval_results["mdot_F"]
            if "eta_cstar" in eval_results:
                initial_performance["eta_cstar"] = eval_results["eta_cstar"]
            if "cstar_actual" in eval_results:
                initial_performance["cstar_actual"] = eval_results["cstar_actual"]
            if "cstar_ideal" in eval_results:
                initial_performance["cstar_ideal"] = eval_results["cstar_ideal"]
            # Replay thrust/MR/stability must match diagnostics used for ΔP and momentum gates.
            if "F" in eval_results:
                initial_performance["F"] = eval_results["F"]
            if "MR" in eval_results:
                initial_performance["MR"] = eval_results["MR"]
            if eval_results.get("stability_results"):
                initial_performance["stability_results"] = eval_results["stability_results"]
            # Copy chamber_intrinsics (contains is_choked, etc.)
            if "chamber_intrinsics" in eval_results and eval_results["chamber_intrinsics"]:
                initial_performance["chamber_intrinsics"] = eval_results["chamber_intrinsics"]
            _merge_runner_eval_into_performance(initial_performance, eval_results)
        except Exception:
            # If re-evaluation fails, calculate Cf from available data
            F_val = initial_performance.get("F", 0)
            Pc_val = initial_performance.get("Pc", 0)
            A_throat_val = _throat_area_m2_from_config(optimized_config)
            if A_throat_val and A_throat_val > 0 and Pc_val > 0:
                Cf_calculated = F_val / (Pc_val * A_throat_val)
                initial_performance["Cf_actual"] = Cf_calculated
                initial_performance["Cf"] = Cf_calculated
    else:
        initial_performance, validation_pressure_scale = _validation_evaluate_or_bundle(
            optimized_runner, P_O_initial, P_F_initial
        )
        initial_thrust_error = (
            abs(initial_performance.get("F", 0) - target_thrust) / target_thrust if target_thrust > 0 else 1.0
        )
        initial_MR_error = (
            abs(initial_performance.get("MR", 0) - optimal_of) / optimal_of if optimal_of > 0 else 1.0
        )
        
        # Ensure Cf is included (calculate if not provided by runner)
        if "Cf" not in initial_performance and "Cf_actual" not in initial_performance:
            F_val = initial_performance.get("F", 0)
            Pc_val = initial_performance.get("Pc", 0)
            A_throat_val = _throat_area_m2_from_config(optimized_config)
            if A_throat_val and A_throat_val > 0 and Pc_val > 0:
                Cf_calculated = F_val / (Pc_val * A_throat_val)
                initial_performance["Cf_actual"] = Cf_calculated
                initial_performance["Cf"] = Cf_calculated
    
    if validation_pressure_scale is not None and np.isfinite(float(validation_pressure_scale)):
        sc = float(validation_pressure_scale)
        initial_performance["layer1_validation_tank_pressure_scale"] = sc
        # Nominal stagnation pressures from the optimizer iterate (``P_O_initial`` / ``P_F_initial`` in Pa).
        _po_nom_psi = min(float(P_O_initial) / float(psi_to_Pa), max_lox_P_psi)
        _pf_nom_psi = min(float(P_F_initial) / float(psi_to_Pa), max_fuel_P_psi)
        # Saved YAML + "Optimized Tank Pressures" must stay at **nominal** caps: replay may multiply tanks
        # by ``sc>1`` only to get a convergent ``evaluate()`` after marginal supply starvation (common when
        # spray / η models tighten injector-side closure). Persisting ``*_nom*sc`` made UI/YAML look like
        # the design exceeded the Layer‑1 stagnation band (~65–85% of tank max).
        optimized_config.lox_tank.initial_pressure_psi = _po_nom_psi
        optimized_config.fuel_tank.initial_pressure_psi = _pf_nom_psi
        if abs(sc - 1.0) > 1e-6:
            initial_performance["layer1_validation_replay_boosted_tanks"] = True
            initial_performance["P_O_start_psi_validation_replay"] = float(_po_nom_psi * sc)
            initial_performance["P_F_start_psi_validation_replay"] = float(_pf_nom_psi * sc)

    # Impinging: expose jet momentum-balance ratio and hinge penalty at top level for UI / summaries
    if getattr(getattr(optimized_config, "injector", None), "type", None) == "impinging":
        _diag_vals = initial_performance.get("diagnostics")
        initial_performance["momentum_balance_penalty"] = 0.0
        if isinstance(_diag_vals, dict):
            _mr_promote = _diag_vals.get("momentum_ratio_R")
            if _mr_promote is not None and np.isfinite(_mr_promote) and float(_mr_promote) > 0:
                initial_performance["momentum_ratio_R"] = float(_mr_promote)
                initial_performance["momentum_balance_penalty"] = float(
                    layer1_W_MOM
                    * _impinging_momentum_hinge_squared(
                        _mr_promote,
                        r_band_lo=layer1_impinging_R_mom_lo,
                        r_band_hi=layer1_impinging_R_mom_hi,
                    )
                )
            # Audit fields for UI (same definitions as impinging.flows momentum_ratio_R)
            for _rk, _cast in (
                ("v_O_bulk", float),
                ("v_F_bulk", float),
                ("A_jet_O", float),
                ("A_jet_F", float),
                ("rho_O_momentum", float),
                ("rho_F_momentum", float),
                ("d_jet_O", float),
                ("d_jet_F", float),
            ):
                _rv = _diag_vals.get(_rk)
                if _rv is not None:
                    try:
                        _rf = _cast(_rv)
                        if np.isfinite(_rf):
                            initial_performance[_rk] = _rf
                    except (TypeError, ValueError):
                        pass
            for _ik in ("momentum_ratio_n_elements_O", "momentum_ratio_n_elements_F"):
                _iv = _diag_vals.get(_ik)
                if _iv is not None:
                    try:
                        initial_performance[_ik] = int(_iv)
                    except (TypeError, ValueError):
                        pass
        try:
            ig = optimized_config.injector.geometry
            rho_o_p = float(optimized_config.fluids["oxidizer"].density)
            rho_f_p = float(optimized_config.fluids["fuel"].density)
            Aog_p = float(ig.oxidizer.n_elements * np.pi * (ig.oxidizer.d_jet / 2.0) ** 2)
            Afg_p = float(ig.fuel.n_elements * np.pi * (ig.fuel.d_jet / 2.0) ** 2)
            if Afg_p > 0:
                _sq_g, ao_r, exp_r = _geom_ao_af_momentum_hint_squared(
                    Aog_p, Afg_p, optimal_of, rho_o_p, rho_f_p
                )
                initial_performance["geom_ao_af"] = float(ao_r)
                initial_performance["expected_ao_af_for_R1"] = float(exp_r)
                if np.isfinite(exp_r) and float(exp_r) != 0.0:
                    initial_performance["geom_ao_af_rel_error"] = float((float(ao_r) - float(exp_r)) / float(exp_r))
                initial_performance["geom_ao_af_momentum_hint_sq"] = float(_sq_g)
        except Exception:
            pass

    # Injector ΔP/Pc ratios and weighted penalty (all injector types when Pc and diagnostics allow)
    initial_performance["injector_dp_out_of_range"] = False
    _pc_prom = initial_performance.get("Pc")
    if _pc_prom is not None and np.isfinite(float(_pc_prom)) and float(_pc_prom) > 0:
        _ro_p, _rf_p = injector_dp_ratios_from_eval_result(float(_pc_prom), initial_performance)
        if _ro_p is not None:
            initial_performance["injector_dp_ratio_O"] = float(_ro_p)
        if _rf_p is not None:
            initial_performance["injector_dp_ratio_F"] = float(_rf_p)
        initial_performance["injector_dp_penalty"] = float(
            injector_dp_ratio_penalty_weighted(
                _ro_p,
                _rf_p,
                layer1_W_DP,
                layer1_W_DP_HIGH,
                o_band=layer1_dp_o_band,
                f_band=layer1_dp_f_band,
                w_dp_o=layer1_W_DP_O,
                w_dp_f=layer1_W_DP_F,
                o_soft_floor=layer1_dp_o_soft_floor,
                w_dp_o_floor=layer1_W_DP_O_FLOOR,
            )
        )
        lo_o, hi_o = layer1_dp_o_band
        lo_f, hi_f = layer1_dp_f_band
        _oor = False
        if injector_dp_ratio_within_gate(_ro_p, float(lo_o), float(hi_o)) is False:
            _oor = True
        if injector_dp_ratio_within_gate(_rf_p, float(lo_f), float(hi_f)) is False:
            _oor = True
        initial_performance["injector_dp_out_of_range"] = bool(_oor)

    # Thrust/MR gate fractions must match final replay payload (ΔP/R gates already use same evaluate).
    _Fv_gate = initial_performance.get("F")
    _MRv_gate = initial_performance.get("MR")
    if target_thrust > 0 and _Fv_gate is not None and np.isfinite(float(_Fv_gate)):
        initial_thrust_error = abs(float(_Fv_gate) - float(target_thrust)) / float(target_thrust)
    else:
        initial_thrust_error = 1.0
    if optimal_of > 0 and _MRv_gate is not None and np.isfinite(float(_MRv_gate)):
        initial_MR_error = abs(float(_MRv_gate) - float(optimal_of)) / float(optimal_of)
    else:
        initial_MR_error = 1.0
    
    # Update chamber_geometry.Cf with the calculated thrust coefficient
    Cf_final = initial_performance.get("Cf_actual", initial_performance.get("Cf"))
    if Cf_final is not None and np.isfinite(Cf_final):
        if optimized_config.chamber_geometry is not None:
            optimized_config.chamber_geometry.Cf = float(Cf_final)
    
    # Check stability (replay evaluate provides nested stability_results; snapshot uses flat margins).
    sr_live = initial_performance.get("stability_results")
    snap = opt_state.get("best_results_for_validation") or {}
    if isinstance(sr_live, dict) and sr_live:
        stability_results = sr_live
        stability_state = stability_results.get("stability_state", "unstable")
        stability_score = float(stability_results.get("stability_score", 0.0))
        chugging_margin = float(stability_results.get("chugging", {}).get("stability_margin", 0))
        acoustic_margin = float(stability_results.get("acoustic", {}).get("stability_margin", 0))
        feed_margin = float(stability_results.get("feed_system", {}).get("stability_margin", 0))
    elif snap:
        stability_results = snap.get("stability_results", {})
        stability_state = snap.get("stability_state", "unstable")
        stability_score = float(snap.get("stability_score", 0.0))
        chugging_margin = float(snap.get("chugging_margin", 0))
        acoustic_margin = float(snap.get("acoustic_margin", 0))
        feed_margin = float(snap.get("feed_margin", 0))
    else:
        stability_results = {}
        stability_state = "unstable"
        stability_score = 0.0
        chugging_margin = acoustic_margin = feed_margin = 0.0
    initial_stability = min(chugging_margin, acoustic_margin, feed_margin)
    
    # Validation checks
    min_stability_score = requirements.get("min_stability_score", 0.75)
    require_stable_state = requirements.get("require_stable_state", True)
    handicap = float(requirements.get("stability_margin_handicap", 0.0))
    score_factor = max(0.0, 1.0 - handicap)
    margin_factor = max(0.0, 1.0 - handicap)
    effective_min_score = min_stability_score * score_factor
    effective_margin = min_stability * margin_factor
    
    state_ok = (stability_state in {"stable", "marginal"}) if require_stable_state else (stability_state != "unstable")
    margin_tolerance = 0.05
    stability_check_passed = (
        state_ok and
        (stability_score >= effective_min_score) and
        (chugging_margin >= effective_margin * (1.0 - margin_tolerance)) and
        (acoustic_margin >= effective_margin * (1.0 - margin_tolerance)) and
        (feed_margin >= effective_margin * (1.0 - margin_tolerance))
    )
    
    _thr_v = requirements.get("layer1_thrust_validation_rel_tol")
    thrust_tol_valid = float(_thr_v) if _thr_v is not None else float(thrust_tol)
    _of_v = requirements.get("layer1_of_validation_tol")
    of_tol_valid = float(_of_v if _of_v is not None else 0.15)
    if not np.isfinite(of_tol_valid) or of_tol_valid <= 0.0:
        of_tol_valid = 0.15
    _gate_tol_eps = 1e-12
    thrust_check_passed = initial_thrust_error <= thrust_tol_valid + _gate_tol_eps
    of_check_passed = initial_MR_error <= of_tol_valid + _gate_tol_eps
    
    # Geometry validation (consistency check for final result)
    A_throat_final = float(getattr(optimized_config.chamber_geometry, 'A_throat', 0.0))
    D_chamber_final = float(getattr(optimized_config.chamber_geometry, 'chamber_diameter', 0.0))
    A_chamber_final = np.pi * (D_chamber_final / 2) ** 2
    
    geometry_check_passed = True
    geometry_failure_reasons = []
    
    if A_chamber_final > 0 and A_throat_final > 0:
        contraction_ratio_final = A_chamber_final / A_throat_final
        if contraction_ratio_final < 1.1:
            geometry_check_passed = False
            geometry_failure_reasons.append(f"Throat area too large for chamber (contraction ratio {contraction_ratio_final:.2f} < 1.1)")
    
    if (
        getattr(optimized_config.injector, "type", None) == "pintle"
        and hasattr(optimized_config.injector, 'geometry')
        and hasattr(optimized_config.injector.geometry, 'fuel')
    ):
        d_pintle_final = float(optimized_config.injector.geometry.fuel.d_pintle_tip)
        if d_pintle_final >= D_chamber_final:
            geometry_check_passed = False
            geometry_failure_reasons.append(f"Pintle diameter {d_pintle_final*1000:.1f}mm >= chamber diameter {D_chamber_final*1000:.1f}mm")
    
    if (
        getattr(optimized_config.injector, "type", None) == "impinging"
        and hasattr(optimized_config.injector, "geometry")
    ):
        ig = optimized_config.injector.geometry
        d_max = max(float(ig.oxidizer.d_jet), float(ig.fuel.d_jet))
        if D_chamber_final > 0 and d_max * 1.15 >= D_chamber_final:
            geometry_check_passed = False
            geometry_failure_reasons.append(
                f"Impinging jet diameter (max {d_max*1000:.2f} mm) too large vs chamber inner Ø {D_chamber_final*1000:.1f} mm"
            )
    
    # Chamber length constraint (use unified chamber_geometry when legacy chamber is null).
    from engine.pipeline.config_schemas import ensure_chamber_geometry as _ensure_cg_len

    _cg_len = _ensure_cg_len(optimized_config)
    _len_raw = getattr(_cg_len, "length", None)
    L_chamber_final = (
        float(_len_raw)
        if (_len_raw is not None and np.isfinite(float(_len_raw)))
        else np.nan
    )
    max_chamber_length = float(requirements.get("max_chamber_length_m", 0.50))
    
    if np.isfinite(L_chamber_final) and max_chamber_length > 0:
        if L_chamber_final > max_chamber_length:
            geometry_check_passed = False
            geometry_failure_reasons.append(f"Chamber length {L_chamber_final*1000:.1f}mm > max allowed {max_chamber_length*1000:.1f}mm")

    # Injector ΔP ratio gate (optional; enforced when Pc and ratios are available).
    def _as_finite_float_or_nan(v: Any) -> float:
        try:
            f = float(v)
        except (TypeError, ValueError):
            return float("nan")
        return f if np.isfinite(f) else float("nan")

    ratio_o_val = ratio_f_val = float("nan")
    dp_gate_passed = True
    pc_val = float(initial_performance.get("Pc", np.nan))
    if np.isfinite(pc_val) and pc_val > 0:
        _ro, _rf = injector_dp_ratios_from_eval_result(pc_val, initial_performance)
        ratio_o_val = _as_finite_float_or_nan(_ro)
        ratio_f_val = _as_finite_float_or_nan(_rf)
        _chk_o_final = injector_dp_ratio_within_gate(
            ratio_o_val, layer1_dp_o_band[0], layer1_dp_o_band[1]
        )
        if _chk_o_final is not None:
            dp_gate_passed &= bool(_chk_o_final)
        _chk_f_final = injector_dp_ratio_within_gate(
            ratio_f_val, layer1_dp_f_band[0], layer1_dp_f_band[1]
        )
        if _chk_f_final is not None:
            dp_gate_passed &= bool(_chk_f_final)

    # Impinging momentum-ratio gate (optional).
    momentum_gate_passed = True
    momentum_r_val = float(initial_performance.get("momentum_ratio_R", np.nan))
    if (
        getattr(optimized_config.injector, "type", None) == "impinging"
        and layer1_impinging_R_mom_lo is not None
        and layer1_impinging_R_mom_hi is not None
        and np.isfinite(momentum_r_val)
        and momentum_r_val > 0
    ):
        momentum_gate_passed = (
            float(layer1_impinging_R_mom_lo) <= momentum_r_val <= float(layer1_impinging_R_mom_hi)
        )

    pressure_candidate_valid = (
        thrust_check_passed
        and of_check_passed
        and stability_check_passed
        and geometry_check_passed
        and dp_gate_passed
        and momentum_gate_passed
    )
    # Surface truth to API/UI: mid-optimization ``converged`` can latch True from soft thresholds;
    # overrides only when final hard gates settle.
    opt_state["converged"] = bool(pressure_candidate_valid)
    
    # Build failure reasons
    failure_reasons = []
    if not thrust_check_passed:
        failure_reasons.append(f"Thrust error {initial_thrust_error*100:.1f}% > {thrust_tol_valid*100:.1f}% limit")
    if not of_check_passed:
        failure_reasons.append(f"O/F error {initial_MR_error*100:.1f}% > {of_tol_valid*100:.1f}% limit")
    if not geometry_check_passed:
        failure_reasons.extend(geometry_failure_reasons)
    if not stability_check_passed:
        required_parts = []
        if require_stable_state:
            if stability_state not in {"stable", "marginal"}:
                required_parts.append(f"state ∈ {{stable,marginal}} (got '{stability_state}')")
        else:
            if stability_state == "unstable":
                required_parts.append("state!='unstable'")
        _sfloor = effective_margin * (1.0 - margin_tolerance)
        if stability_score < effective_min_score:
            required_parts.append(f"score>={effective_min_score:.2f} (got {stability_score:.2f})")
        if chugging_margin < _sfloor:
            required_parts.append(f"chugging_margin>={_sfloor:.2f} (got {chugging_margin:.2f})")
        if acoustic_margin < _sfloor:
            required_parts.append(f"acoustic_margin>={_sfloor:.2f} (got {acoustic_margin:.2f})")
        if feed_margin < _sfloor:
            required_parts.append(f"feed_margin>={_sfloor:.2f} (got {feed_margin:.2f})")
        if not required_parts:
            required_parts.append("stability gate mismatch")
        failure_reasons.append(f"Stability failed: {'; '.join(required_parts)}")
    if not dp_gate_passed:
        dp_parts = []
        if np.isfinite(ratio_o_val):
            dp_parts.append(
                f"ΔP_O/Pc in [{layer1_dp_o_band[0]:.3f},{layer1_dp_o_band[1]:.3f}] (got {ratio_o_val:.3f})"
            )
        if np.isfinite(ratio_f_val):
            dp_parts.append(
                f"ΔP_F/Pc in [{layer1_dp_f_band[0]:.3f},{layer1_dp_f_band[1]:.3f}] (got {ratio_f_val:.3f})"
            )
        failure_reasons.append("Injector ΔP ratio failed: " + "; ".join(dp_parts))
    if not momentum_gate_passed:
        failure_reasons.append(
            f"Momentum ratio R not in [{float(layer1_impinging_R_mom_lo):.3f},"
            f"{float(layer1_impinging_R_mom_hi):.3f}] (got {momentum_r_val:.3f})"
        )
    
    if not pressure_candidate_valid and not failure_reasons:
        failure_reasons.append("Validation failed: no requirements met")
    
    # Log validation
    if pressure_candidate_valid:
        update_progress("Layer 1: Validation", 0.53, f"✓ VALID - Thrust err: {initial_thrust_error*100:.1f}%, O/F err: {initial_MR_error*100:.1f}%, Stability: {stability_state}")
        log_status("Layer 1", f"VALID | Thrust err {initial_thrust_error*100:.1f}%, O/F err {initial_MR_error*100:.1f}%, Stability {stability_state}")
        layer1_logger.info("✓ Validation: VALID")
    else:
        update_progress("Layer 1: Validation", 0.53, f"✗ INVALID - {'; '.join(failure_reasons)}")
        log_status("Layer 1", f"INVALID | Reasons: {', '.join(failure_reasons)}")
        layer1_logger.warning(f"✗ Validation: INVALID - {'; '.join(failure_reasons)}")
    
    # Build final performance dict
    final_performance = initial_performance.copy()
    final_performance["pressure_candidate_valid"] = pressure_candidate_valid
    final_performance["initial_thrust_error"] = initial_thrust_error
    final_performance["initial_MR_error"] = initial_MR_error
    final_performance["initial_stability"] = initial_stability
    final_performance["initial_stability_state"] = stability_state
    final_performance["initial_stability_score"] = stability_score
    final_performance["thrust_check_passed"] = thrust_check_passed
    final_performance["of_check_passed"] = of_check_passed
    final_performance["stability_check_passed"] = stability_check_passed
    final_performance["geometry_check_passed"] = geometry_check_passed
    final_performance["dp_gate_passed"] = dp_gate_passed
    final_performance["momentum_gate_passed"] = momentum_gate_passed
    final_performance["injector_dp_ratio_O"] = ratio_o_val if np.isfinite(ratio_o_val) else None
    final_performance["injector_dp_ratio_F"] = ratio_f_val if np.isfinite(ratio_f_val) else None
    final_performance["layer1_Lstar_search_min_m"] = float(min_Lstar)
    final_performance["layer1_Lstar_search_max_m"] = float(max_Lstar)
    final_performance["layer1_W_geom_ao_af_momentum_effective"] = float(layer1_W_geom_ao_af)
    try:
        if isinstance(requirements, dict):
            req_used = {
                str(k): requirements.get(k) for k in sorted(requirements.keys(), key=str)
            }
            req_used["W_geom_ao_af_momentum"] = float(layer1_W_geom_ao_af)
            final_performance["layer1_requirements_used"] = req_used
        else:
            final_performance["layer1_requirements_used"] = {}
    except Exception:
        final_performance["layer1_requirements_used"] = {}
    try:
        from engine.pipeline.config_schemas import ensure_chamber_geometry as _eg_lstar_diag
        _cgd = _eg_lstar_diag(optimized_config)
        _atd = float(_cgd.A_throat) if _cgd.A_throat else float("nan")
        _vold = float(_cgd.volume) if _cgd.volume is not None else float("nan")
        _lscd = float(_cgd.Lstar) if _cgd.Lstar is not None else float("nan")
        _dind = float(_cgd.chamber_diameter) if _cgd.chamber_diameter else float("nan")
        _acd = float(np.pi * (_dind / 2.0) ** 2) if np.isfinite(_dind) and _dind > 0 else float("nan")
        final_performance["layer1_geometry_Lstar_config_m"] = _lscd if np.isfinite(_lscd) else None
        final_performance["layer1_geometry_volume_over_At_m"] = (
            float(_vold / _atd) if np.isfinite(_vold) and np.isfinite(_atd) and _atd > 0 else None
        )
        final_performance["layer1_geometry_Ac_over_At"] = (
            float(_acd / _atd) if np.isfinite(_acd) and np.isfinite(_atd) and _atd > 0 else None
        )
        if np.isfinite(_vold) and np.isfinite(_atd) and _atd > 0 and np.isfinite(_lscd):
            final_performance["layer1_geometry_V_equals_Lstar_At"] = bool(
                np.isclose(_vold, _lscd * _atd, rtol=1e-4, atol=1e-8)
            )
    except Exception:
        pass
    if getattr(optimized_config.injector, "type", None) == "impinging":
        _diag_fp = final_performance.get("diagnostics", {}) if isinstance(final_performance, dict) else {}
        _diag_map = _diag_fp if isinstance(_diag_fp, dict) else {}
        try:
            _mr_fp_raw = float(final_performance.get("MR", np.nan))
        except (TypeError, ValueError):
            _mr_fp_raw = float("nan")
        _mr_fp = _mr_fp_raw if np.isfinite(_mr_fp_raw) and _mr_fp_raw > 0 else None
        _smd_term_fp, _smd_eff_um_fp, _imp_deg_fp = _impinging_smd_penalty_with_angle(
            _diag_map,
            target_smd_microns=layer1_target_smd_microns,
            smd_rel_tol=layer1_smd_rel_tol,
            smd_corr_c=layer1_impinging_smd_corr_C,
            smd_corr_a=layer1_impinging_smd_corr_a,
            smd_corr_b=layer1_impinging_smd_corr_b,
            smd_phi_floor_deg=layer1_impinging_smd_phi_floor_deg,
            rho_l=float(config_base.fluids["oxidizer"].density),
            mr_mass=_mr_fp,
        )
        # When SMD objective is disabled, report physical diagnostic SMD directly.
        if layer1_W_SMD <= 0.0:
            _do = float("nan")
            _df = float("nan")
            _v_o = _diag_map.get("D32_O")
            if _v_o is not None:
                try:
                    _fv_o = float(_v_o)
                except (TypeError, ValueError):
                    _fv_o = float("nan")
                if np.isfinite(_fv_o) and _fv_o > 0:
                    _do = _fv_o
            _v_f = _diag_map.get("D32_F")
            if _v_f is not None:
                try:
                    _fv_f = float(_v_f)
                except (TypeError, ValueError):
                    _fv_f = float("nan")
                if np.isfinite(_fv_f) and _fv_f > 0:
                    _df = _fv_f
            if np.isfinite(_do) and _do > 0 and np.isfinite(_df) and _df > 0:
                _mr_b = _mr_fp if _mr_fp is not None else 3.0
                _w_o = float(_mr_b / (1.0 + _mr_b))
                _w_f = float(1.0 / (1.0 + _mr_b))
                _smd_eff_um_fp = float((_w_o * _do + _w_f * _df) * 1e6)
            elif np.isfinite(_do) and _do > 0:
                _smd_eff_um_fp = float(_do * 1e6)
            elif np.isfinite(_df) and _df > 0:
                _smd_eff_um_fp = float(_df * 1e6)
        final_performance["effective_smd_microns"] = _smd_eff_um_fp if np.isfinite(_smd_eff_um_fp) else None
        final_performance["impingement_angle_deg_effective"] = _imp_deg_fp if np.isfinite(_imp_deg_fp) else None
        final_performance["smd_penalty"] = float(layer1_W_SMD * _smd_term_fp)
    final_performance["failure_reasons"] = failure_reasons
    # Add individual stability margins at root level for easy access
    final_performance["chugging_margin"] = chugging_margin
    final_performance["acoustic_margin"] = acoustic_margin
    final_performance["feed_margin"] = feed_margin
    
    # Tank pressures consistent with validated runner config (avoid ``best_x`` / snapshot mismatch).
    try:
        P_O_start_optimized_psi = float(optimized_config.lox_tank.initial_pressure_psi)
        P_F_start_optimized_psi = float(optimized_config.fuel_tank.initial_pressure_psi)
        final_performance["P_O_start_psi"] = P_O_start_optimized_psi
        final_performance["P_F_start_psi"] = P_F_start_optimized_psi
        final_performance["P_O_start_ratio"] = P_O_start_optimized_psi / max_lox_P_psi if max_lox_P_psi > 0 else 0.0
        final_performance["P_F_start_ratio"] = P_F_start_optimized_psi / max_fuel_P_psi if max_fuel_P_psi > 0 else 0.0
    except Exception:
        if best_x is not None and len(best_x) > idx_P_F:
            P_O_start_optimized_psi = float(np.clip(best_x[idx_P_O], bounds[idx_P_O][0], bounds[idx_P_O][1]))
            P_F_start_optimized_psi = float(np.clip(best_x[idx_P_F], bounds[idx_P_F][0], bounds[idx_P_F][1]))
            final_performance["P_O_start_psi"] = P_O_start_optimized_psi
            final_performance["P_F_start_psi"] = P_F_start_optimized_psi
            final_performance["P_O_start_ratio"] = P_O_start_optimized_psi / max_lox_P_psi if max_lox_P_psi > 0 else 0.0
            final_performance["P_F_start_ratio"] = P_F_start_optimized_psi / max_fuel_P_psi if max_fuel_P_psi > 0 else 0.0
        else:
            final_performance["P_O_start_psi"] = max_lox_P_psi * 0.8
            final_performance["P_F_start_psi"] = max_fuel_P_psi * 0.8
            final_performance["P_O_start_ratio"] = 0.8
            final_performance["P_F_start_ratio"] = 0.8
    
    # Add chamber_intrinsics from initial_performance (contains is_choked, etc.)
    if "chamber_intrinsics" in initial_performance:
        final_performance["chamber_intrinsics"] = initial_performance["chamber_intrinsics"]
    
    # Calculate and add effective_injector_area_ratio
    # This is the ratio of (effective injector area) / (throat area)
    # Effective injector area = max(A_lox_injector, A_fuel_injector) with Cd weighting
    try:
        from engine.pipeline.config_schemas import ensure_chamber_geometry
        cg = ensure_chamber_geometry(optimized_config)
        A_throat_final = float(cg.A_throat) if cg.A_throat and cg.A_throat > 0 else None
        
        inj = getattr(optimized_config, 'injector', None)
        inj_geom = getattr(inj, 'geometry', None) if inj else None
        is_pintle = getattr(inj, 'type', None) == 'pintle' if inj else False
        is_impinging = getattr(inj, 'type', None) == 'impinging' if inj else False

        if is_impinging and inj_geom and A_throat_final:
            ox = getattr(inj_geom, 'oxidizer', None)
            fu = getattr(inj_geom, 'fuel', None)
            if ox and fu:
                n_o = float(getattr(ox, 'n_elements', 0))
                d_o = float(getattr(ox, 'd_jet', 0))
                n_f = float(getattr(fu, 'n_elements', 0))
                d_f = float(getattr(fu, 'd_jet', 0))
                A_lox_g = n_o * np.pi * (d_o / 2.0) ** 2 if d_o > 0 else 0.0
                A_fuel_g = n_f * np.pi * (d_f / 2.0) ** 2 if d_f > 0 else 0.0
                diag_ev = initial_performance.get("diagnostics") or {}
                cd_o = diag_ev.get("Cd_O")
                cd_f = diag_ev.get("Cd_F")
                if (
                    cd_o is not None and np.isfinite(cd_o) and float(cd_o) > 0
                    and cd_f is not None and np.isfinite(cd_f) and float(cd_f) > 0
                ):
                    A_eff = float(cd_o) * A_lox_g + float(cd_f) * A_fuel_g
                else:
                    try:
                        Cd_lox = float(optimized_config.discharge["oxidizer"].Cd_inf)
                        Cd_fu = float(optimized_config.discharge["fuel"].Cd_inf)
                    except Exception:
                        Cd_lox, Cd_fu = 0.4, 0.65
                    A_eff = Cd_lox * A_lox_g + Cd_fu * A_fuel_g
                final_performance["effective_injector_area_ratio"] = float(A_eff / A_throat_final)

        if is_pintle and inj_geom and A_throat_final:
            # LOX injector area (discrete orifices)
            lox_geom = getattr(inj_geom, 'lox', None)
            fuel_geom = getattr(inj_geom, 'fuel', None)
            
            if lox_geom and fuel_geom:
                n_orifices = float(getattr(lox_geom, 'n_orifices', 0))
                d_orifice = float(getattr(lox_geom, 'd_orifice', 0))
                d_pintle_tip = float(getattr(fuel_geom, 'd_pintle_tip', 0))
                h_gap = float(getattr(fuel_geom, 'h_gap', 0))
                Cd_lox = float(getattr(lox_geom, 'Cd', 0.65))
                Cd_fuel = float(getattr(fuel_geom, 'Cd', 0.4))
                
                A_lox_injector = n_orifices * np.pi * (d_orifice / 2) ** 2 if d_orifice > 0 else 0.0
                R_inner = d_pintle_tip / 2
                R_outer = R_inner + h_gap
                A_fuel_injector = np.pi * (R_outer ** 2 - R_inner ** 2) if h_gap > 0 else 0.0
                
                # Effective areas (Cd-weighted geometric areas)
                A_lox_effective = Cd_lox * A_lox_injector
                A_fuel_effective = Cd_fuel * A_fuel_injector
                
                # Total effective injector area (sum of both propellants)
                A_injector_total_effective = A_lox_effective + A_fuel_effective
                
                # Ratio of total effective injector area to throat area
                effective_injector_area_ratio = A_injector_total_effective / A_throat_final
                final_performance["effective_injector_area_ratio"] = float(effective_injector_area_ratio)
    except Exception as e:
        layer1_logger.debug(f"Could not calculate effective_injector_area_ratio: {e}")
    
    _prim_rel = _layer1_primary_relative_metrics(
        final_performance,
        target_thrust=target_thrust,
        optimal_of=optimal_of,
        target_P_exit=target_P_exit,
    )
    # Build results dict
    results = {
        "performance": final_performance,
        "iteration_history": iteration_history,
        "convergence_info": {
            "converged": opt_state["converged"],
            "iterations": len(iteration_history),
            "final_change": opt_state["best_objective"],
            "best_objective": float(opt_state.get("best_objective", float("inf"))),
            "best_objective_breakdown": (
                dict(opt_state.get("best_objective_breakdown", {}))
                if isinstance(opt_state.get("best_objective_breakdown", {}), dict)
                else {}
            ),
            "primary_relative_residual": _prim_rel,
        },
        "exit_pressure_targeting": {
            "target_P_exit": target_P_exit,  # Atmospheric pressure from environment config (GPS/GFS-derived)
        },
        "optimized_pressure_curves": {
            "lox_end_ratio": final_lox_end_ratio,
            "fuel_end_ratio": final_fuel_end_ratio,
            "lox_start_psi": final_performance["P_O_start_psi"],
            "fuel_start_psi": final_performance["P_F_start_psi"],
        },
        "layer_status": {
            "layer_1_pressure_candidate": pressure_candidate_valid,
        },
        "optimized_parameters": extract_all_parameters(optimized_config),
    }
    
    # Final summary logging
    layer1_logger.info("")
    layer1_logger.info("="*70)
    layer1_logger.info("Final Results Summary")
    layer1_logger.info("="*70)
    if "best_results_for_validation" in opt_state and opt_state["best_results_for_validation"] is not None:
        stored = opt_state["best_results_for_validation"]
        layer1_logger.info(f"Thrust: {stored.get('F', 0):.1f} N (target: {target_thrust:.1f} N)")
        layer1_logger.info(f"Thrust error: {stored.get('thrust_error', 0)*100:.2f}%")
        layer1_logger.info(f"O/F ratio: {stored.get('MR', 0):.3f} (target: {optimal_of:.3f})")
        layer1_logger.info(f"O/F error: {stored.get('of_error', 0)*100:.2f}%")
        layer1_logger.info(f"Stability state: {stored.get('stability_state', 'unknown')}")
        layer1_logger.info(f"Stability score: {stored.get('stability_score', 0):.3f}")
        layer1_logger.info(f"Chugging margin: {stored.get('chugging_margin', 0):.3f}")
        layer1_logger.info(f"Acoustic margin: {stored.get('acoustic_margin', 0):.3f}")
        layer1_logger.info(f"Feed margin: {stored.get('feed_margin', 0):.3f}")
    if final_performance.get("P_O_start_psi") is not None:
        layer1_logger.info(f"LOX initial pressure: {final_performance['P_O_start_psi']:.1f} psi")
    if final_performance.get("P_F_start_psi") is not None:
        layer1_logger.info(f"Fuel initial pressure: {final_performance['P_F_start_psi']:.1f} psi")
    _idr_o = final_performance.get("injector_dp_ratio_O")
    _idr_f = final_performance.get("injector_dp_ratio_F")
    _idp = final_performance.get("injector_dp_penalty")
    if _idr_o is not None and np.isfinite(_idr_o):
        layer1_logger.info(f"Injector ΔP/Pc (LOX): {_idr_o:.4f}")
    if _idr_f is not None and np.isfinite(_idr_f):
        layer1_logger.info(f"Injector ΔP/Pc (fuel): {_idr_f:.4f}")
    if _idp is not None and np.isfinite(_idp):
        layer1_logger.info(f"Injector ΔP ratio penalty (weighted): {float(_idp):.6g}")
    if (
        getattr(getattr(optimized_config, "injector", None), "type", None) == "impinging"
        and final_performance.get("momentum_ratio_R") is not None
    ):
        layer1_logger.info(
            f"Impinging jet momentum ratio R: {final_performance['momentum_ratio_R']:.3f} "
            f"(sqrt momentum-flux ratio; target ~1.0)"
        )
        mbp = final_performance.get("momentum_balance_penalty")
        if mbp is not None and np.isfinite(mbp):
            layer1_logger.info(
                f"Impinging momentum-balance penalty (W_MOM × hinge): {float(mbp):.6g}"
            )
    layer1_logger.info(f"Validation: {'VALID' if pressure_candidate_valid else 'INVALID'}")

    _primary_terms = _layer1_final_primary_objective_terms(
        final_performance,
        target_thrust=target_thrust,
        optimal_of=optimal_of,
        target_P_exit=target_P_exit,
        layer1_exit_pressure_inside_quad_scale=layer1_exit_pressure_inside_quad,
        layer1_w_dp=layer1_W_DP,
        layer1_w_dp_o=layer1_W_DP_O,
        layer1_w_dp_f=layer1_W_DP_F,
        injector_dp_o_band=layer1_dp_o_band,
        injector_dp_f_band=layer1_dp_f_band,
        injector_dp_o_soft_floor=layer1_dp_o_soft_floor,
        layer1_w_dp_o_floor=layer1_W_DP_O_FLOOR,
        layer1_w_thrust=layer1_W_THRUST_obj,
        layer1_w_of=layer1_W_OF_obj,
        layer1_w_of_low_mr_scale=layer1_W_OF_low_MR_scale,
        layer1_w_of_high_mr_scale=layer1_W_OF_high_MR_scale,
    )
    layer1_logger.info("")
    layer1_logger.info(
        "Final evaluate — primary objective penalty contributions "
        "(W_THRUST/W_OF/W_EXIT × terms + injector_dp weighted; same structure as scalar objective)"
    )
    layer1_logger.info(
        f"  • Thrust penalty contribution: {_primary_terms['thrust_penalty_contribution']:.6f}"
    )
    layer1_logger.info(
        f"  • O/F penalty contribution: {_primary_terms['of_penalty_contribution']:.6f}"
    )
    layer1_logger.info(
        f"  • Exit pressure penalty contribution: {_primary_terms['exit_pressure_penalty_contribution']:.6f}"
    )
    layer1_logger.info(
        f"  • Injector ΔP penalty contribution: {_primary_terms['injector_dp_penalty_contribution']:.6f}"
    )
    layer1_logger.info(
        "  • Primary relative |ΔF|/F, |ΔMR|/MR, |ΔP_exit|/P_tgt: "
        f"{_prim_rel['rel_thrust']:.4g}, {_prim_rel['rel_of']:.4g}, {_prim_rel['rel_P_exit']:.4g} "
        f"(RMS={_prim_rel['rms_primary']:.4g}, dimensionless; not the weighted scalar)"
    )
    if final_performance.get("injector_dp_out_of_range"):
        layer1_logger.warning(
            "  injector_dp_out_of_range: True (one or both ΔP_inj/Pc streams exceed 0.50)"
        )

    # Log objective function breakdown if objective > 1e0 (indicates non-ideal convergence)
    best_obj_value = opt_state.get("best_objective", float('inf'))
    if best_obj_value > 1.0:
        layer1_logger.info("")
        layer1_logger.info("-"*70)
        layer1_logger.info(f"⚠ Objective Function Breakdown (objective = {best_obj_value:.6f} > 1.0)")
        layer1_logger.info("-"*70)
        breakdown = opt_state.get("best_objective_breakdown", {})
        if breakdown:
            if breakdown.get("is_infeasible", False):
                layer1_logger.info("Solution is INFEASIBLE:")
                if breakdown.get("length_violation", False):
                    layer1_logger.info(f"  • Chamber length violation penalty: {breakdown.get('infeasibility_penalty', 0):.6f}")
                else:
                    layer1_logger.info(f"  • Infeasibility penalty (constraints violated): {breakdown.get('infeasibility_penalty', 0):.6f}")
            else:
                layer1_logger.info("Objective component contributions:")
                # Sort by contribution (largest first)
                components = [
                    ("Thrust penalty", breakdown.get("thrust_penalty", 0)),
                    ("O/F ratio penalty", breakdown.get("of_penalty", 0)),
                    ("Cf band penalty", breakdown.get("cf_penalty", 0)),
                    ("Exit pressure penalty", breakdown.get("exit_pressure_penalty", 0)),
                    ("Injector ΔP penalty", breakdown.get("injector_dp_penalty", 0)),
                    ("Chamber length penalty", breakdown.get("length_penalty", 0)),
                    ("Momentum balance penalty", breakdown.get("momentum_balance_penalty", 0)),
                ]
                # Sort by value descending
                components.sort(key=lambda x: x[1], reverse=True)
                total = sum(c[1] for c in components)
                for name, value in components:
                    if value > 0 or total > 0:
                        pct = (value / total * 100) if total > 0 else 0.0
                        layer1_logger.info(f"  • {name}: {value:.6f} ({pct:.1f}%)")
                layer1_logger.info(f"  Total: {total:.6f}")
        else:
            layer1_logger.info("  (component breakdown not available)")
        layer1_logger.info("-"*70)
    
    layer1_logger.info("="*70)
    layer1_logger.info("")
    layer1_logger.info(f"Layer 1 optimization complete. Log saved to: {log_file_path}")
    
    # Clean up handler to prevent file handle issues
    layer1_logger.handlers.clear()
    
    update_progress("Layer 1: Complete", 1.0, "Layer 1 optimization complete!")
    

    return optimized_config, results


class ElitePool:
    """Manages a pool of top-K elite solutions."""
    def __init__(self, k: int = 50):
        self.k = k
        self.points = []  # List of tuples (f_val, x_array)

    def add(self, x: np.ndarray, f: float):
        """Add a candidate to the pool if it's good enough."""
        # Check for duplicates (optional, simple distance check or exact match)
        # For simplicity in this iteration, just naive add & sort
        self.points.append((f, np.asarray(x, dtype=float).copy()))
        # Sort by f (ascending, minimization)
        self.points.sort(key=lambda item: item[0])
        # Keep top k
        if len(self.points) > self.k:
            self.points = self.points[:self.k]

    def get_elites(self) -> Tuple[np.ndarray, np.ndarray]:
        """Return (X, F) arrays of current elites."""
        if not self.points:
            return np.array([]), np.array([])
        f_vals = np.array([p[0] for p in self.points])
        x_vals = np.array([p[1] for p in self.points])
        return x_vals, f_vals

    def get_best(self) -> Tuple[np.ndarray, float]:
        """Return best solution found so far."""
        if not self.points:
            return None, float('inf')
        return self.points[0][1], self.points[0][0]


def run_cma_core(
    objective_fn: Callable[[np.ndarray], float],
    x0: np.ndarray,
    sigma0: float,
    bounds: list,
    budget: int,
    popsize: int,
    cma_stds: np.ndarray = None,
    seed: int = None,
    elite_pool: Optional[ElitePool] = None,
    # Optional logic for penalty/validity
    true_objective_fn: Optional[Callable[[np.ndarray], float]] = None,
    valley_escape_tracker: Optional[Dict[str, Any]] = None,
    logger = None,
    # Parallel evaluation support
    executor: Optional[ProcessPoolExecutor] = None,
    integer_dims: Optional[list] = None,
    eval_cache: Optional[dict] = None,
    make_cache_key_fn: Optional[Callable[[np.ndarray], Tuple[int, ...]]] = None,
    stop_event: Optional[Any] = None,  # threading.Event for stop signal
) -> Tuple[np.ndarray, float, int]:
    """
    Core re-usable CMA-ES wrapper with optional parallel evaluation.
    
    Args:
        objective_fn: The function CMA-ES optimizes (could include penalties).
        x0: Initial mean.
        sigma0: Initial step size.
        bounds: List of (min, max) for EACH dimension.
        budget: Max function evaluations.
        popsize: Population size.
        cma_stds: Coordinate-wise standard deviations (optional scaling).
        seed: Random seed.
        elite_pool: Optional pool to capture all candidates evaluated.
        true_objective_fn: If provided, used to evaluate candidates for ElitePool 
                           and best-so-far tracking (ignoring the penalized objective).
                           If None, objective_fn is used.
        executor: Optional ProcessPoolExecutor for parallel evaluation.
        integer_dims: List of integer dimension indices for snapping.
        eval_cache: Optional evaluation cache dict.
                           
    Returns:
        (best_x, best_f, evals_used)
        Note: best_f returned is the one derived from true_objective_fn if present,
        otherwise objective_fn.
    """
    if cma is None:
        raise ImportError("CMA-ES required")
    
    # Prepare bounds for CMA
    lower_bounds = np.array([b[0] for b in bounds])
    upper_bounds = np.array([b[1] for b in bounds])
    
    # Options
    opts = {
        "bounds": [lower_bounds.tolist(), upper_bounds.tolist()],
        "popsize": popsize,
        "maxiter": budget, # Rough upper bound, we track evals manually better
        "verb_disp": 0,
        "verb_log": 0,
        "tolx": 1e-8,
        "tolfun": 1e-9,
        "tolstagnation": 50,
        "ftarget": -np.inf, 
        "seed": seed,
    }
    if cma_stds is not None:
        opts["CMA_stds"] = cma_stds.tolist()

    # Initialize
    # Ensure x0 is within bounds
    x0_clamped = np.clip(x0, lower_bounds, upper_bounds)
    
    evals = 0
    best_x = x0_clamped.copy()
    
    # Initial eval
    if true_objective_fn:
        best_f = true_objective_fn(best_x)
    else:
        best_f = objective_fn(best_x)

    # CMA object
    # CMA expects list for x0
    es = cma.CMAEvolutionStrategy(x0_clamped.tolist(), sigma0, opts)
    
    stop_loop = False
    
    while not es.stop() and not stop_loop:
        # Check if optimization should stop
        if stop_event is not None and stop_event.is_set():
            raise RuntimeError("Optimization stopped by user")
        
        if evals >= budget:
            break
            
        # Check for Valley Escape boost if tracker provided
        if valley_escape_tracker is not None:
            evals_now = valley_escape_tracker.get("function_evaluations", 0)
            best_f_tracker = valley_escape_tracker.get("best_objective", float('inf'))
            last_best = valley_escape_tracker.get("last_best_eval", 0)
            stagnation = evals_now - last_best
            current_tier = valley_escape_tracker.get("valley_escape_tier", 0)
            cooldown = valley_escape_tracker.get("cooldown_until", 0)
            
            target_tier = 0
            if evals_now > 5000 and best_f_tracker > 100.0 and stagnation > 1000: target_tier = 3
            elif evals_now > 3000 and best_f_tracker > 150.0 and stagnation > 500: target_tier = 2
            elif evals_now > 1500 and best_f_tracker > 300.0 and stagnation > 300: target_tier = 1
            
            if target_tier > current_tier and evals_now > cooldown:
                # Apply boost
                boost_factors = [1.0, 2.0, 4.0, 8.0]
                relative_boost = boost_factors[target_tier] / boost_factors[current_tier]
                
                old_sigma = es.sigma
                es.sigma *= relative_boost
                
                # Clamp sigma to 50% of the entire span (much looser)
                # We want to allow large jumps if needed to escape deep local minima
                span_vals = upper_bounds - lower_bounds
                max_sigma = 0.5 * float(np.max(span_vals))
                if es.sigma > max_sigma:
                    es.sigma = max_sigma
                
                # Update tracker
                valley_escape_tracker["valley_escape_tier"] = target_tier
                valley_escape_tracker["cooldown_until"] = evals_now + 1000
                
                if logger:
                    tier_names = ["None", "Mild", "Medium", "Full"]
                    logger.info("!" * 20)
                    logger.info(f"VALLEY ESCAPE TRIGGERED in run_cma_core (Tier: {tier_names[target_tier]})")
                    logger.info(f"Evals: {evals_now}, Best: {best_f_tracker:.2f}, Stagnation: {stagnation}")
                    logger.info(f"Sigma: {old_sigma:.6f} -> {es.sigma:.6f} (Boost: {relative_boost:.2f}x)")
                    logger.info("!" * 20)

        candidates = es.ask()
        
        # PARALLEL EVALUATION PATH
        if executor is not None and integer_dims is not None:
            # Snap integer dimensions for consistency
            candidates_snapped = [
                _snap_integer_dims(np.asarray(c, dtype=np.float64), integer_dims)
                for c in candidates
            ]
            
            # Parent-side caching if cache provided
            if eval_cache is not None and make_cache_key_fn is not None:
                cache_keys = [make_cache_key_fn(c) for c in candidates_snapped]
                uncached_indices = []
                uncached_candidates = []
                fitness_values = [None] * len(candidates)
                
                for i, key in enumerate(cache_keys):
                    if key in eval_cache:
                        cached_val = eval_cache[key]
                        # Handle dict format from parallel eval (has 'value' key)
                        # Note: dict format from objective() has 'results' but not 'value', so we can't use it here
                        if isinstance(cached_val, dict) and 'value' in cached_val:
                            fitness_values[i] = float(cached_val['value'])
                        elif isinstance(cached_val, (int, float)):
                            # Old format: direct float value (backward compatibility)
                            fitness_values[i] = float(cached_val)
                        else:
                            # Full format from objective() or unknown format - can't extract value, treat as uncached
                            uncached_indices.append(i)
                            uncached_candidates.append(candidates_snapped[i])
                    else:
                        uncached_indices.append(i)
                        uncached_candidates.append(candidates_snapped[i])
                
                # Parallel evaluation of uncached candidates
                if uncached_candidates:
                    num_workers = executor._max_workers
                    chunksize = max(1, len(uncached_candidates) // (num_workers * 4))
                    results = list(executor.map(_eval_candidate, uncached_candidates, chunksize=chunksize))
                    
                    # Merge results back
                    for idx, res in zip(uncached_indices, results):
                        obj_val = res['value']
                        fitness_values[idx] = obj_val
                        # Store in dict format for compatibility with objective() cache format
                        eval_cache[cache_keys[idx]] = {
                            'value': obj_val,
                            'success': res.get('success', True),
                        }
                        evals += 1
                        _store_last_good_eval_bundle_from_worker_res(res, valley_escape_tracker)
                        
                        # Update best and elite pool using true objective
                        if res['success']:
                            # For hybrid mode, we use the same objective for both
                            # (true_objective_fn is typically None in hybrid mode)
                            if obj_val < best_f:
                                best_f = obj_val
                                best_x = candidates_snapped[idx].copy()
                            
                            if elite_pool:
                                elite_pool.add(candidates_snapped[idx], obj_val)
                        
                        if evals >= budget:
                            stop_loop = True
                
                # Count cached evals
                for i, val in enumerate(fitness_values):
                    if val is not None and i not in uncached_indices:
                        evals += 1  # Count cache hits as evals for budget tracking
            else:
                # No caching - evaluate all in parallel
                num_workers = executor._max_workers
                chunksize = max(1, len(candidates_snapped) // (num_workers * 4))
                results = list(executor.map(_eval_candidate, candidates_snapped, chunksize=chunksize))
                
                fitness_values = []
                for i, res in enumerate(results):
                    obj_val = res['value']
                    fitness_values.append(obj_val)
                    evals += 1
                    _store_last_good_eval_bundle_from_worker_res(res, valley_escape_tracker)
                    
                    if res['success']:
                        if obj_val < best_f:
                            best_f = obj_val
                            best_x = candidates_snapped[i].copy()
                        
                        if elite_pool:
                            elite_pool.add(candidates_snapped[i], obj_val)
                    
                    if evals >= budget:
                        stop_loop = True
        else:
            # SEQUENTIAL EVALUATION PATH (original code)
            fitness_values = []
            
            for cand in candidates:
                # Clip candidate for evaluation
                cand_arr = np.clip(np.asarray(cand, dtype=float), lower_bounds, upper_bounds)
                
                # 1. Penalized objective (for CMA ranking)
                val_penalized = objective_fn(cand_arr)
                fitness_values.append(val_penalized)
                evals += 1
                
                # 2. True objective (for elites / best tracking)
                if true_objective_fn:
                    val_true = true_objective_fn(cand_arr)
                else:
                    val_true = val_penalized
                    
                # Update local best using TRUE value
                if val_true < best_f:
                    best_f = val_true
                    best_x = cand_arr.copy()
                    
                # Add to elite pool
                if elite_pool:
                    elite_pool.add(cand_arr, val_true)
                
                if evals >= budget:
                    stop_loop = True
                    
        es.tell(candidates, fitness_values)
        
    return best_x, best_f, evals



def compute_blocks_from_elites(
    elite_pool: ElitePool,
    num_blocks: int,
    dim: int,
    method: str = "random",
    overlap_fraction: float = 0.0,
    rng: np.random.Generator = None,
) -> list[list[int]]:
    """
    Compute variable blocks for re-optimization.
    
    Methods:
    - "random": Randomly partition variables.
    - "corr_greedy": Use correlation matrix of standardized elites. 
      Distance = 1 - abs(Correlation).
    """
    if rng is None:
        rng = np.random.default_rng()
        
    all_indices = np.arange(dim)
    
    if method == "corr_greedy" and len(elite_pool.points) > dim + 2:
        # 1. Get elites X (size K x dim)
        X_raw, _ = elite_pool.get_elites()
        
        # 2. Standardize X (zero mean, unit variance) to avoid scale bias
        # Handle zero variance dimensions safely
        stds = np.std(X_raw, axis=0)
        valid_dims = stds > 1e-12
        X_std = np.zeros_like(X_raw)
        X_std[:, valid_dims] = (X_raw[:, valid_dims] - np.mean(X_raw[:, valid_dims], axis=0)) / stds[valid_dims]
        
        # 3. Compute correlation matrix (not covariance!)
        # Shape (dim, dim)
        if len(X_std) > 1:
            corr_mat = np.corrcoef(X_std, rowvar=False)
            # Handle NaNs if they appear (e.g. constant columns)
            corr_mat = np.nan_to_num(corr_mat, nan=0.0)
        else:
            # Fallback if not enough points
            corr_mat = np.eye(dim)
            
        # 4. Computed distance metric: d_ij = 1 - abs(corr_ij)
        dist_mat = 1.0 - np.abs(corr_mat)
        
        # 5. Greedy clustering
        # Start with unassigned, pick one, add nearest neighbors until block filled
        unassigned = set(all_indices)
        blocks = []
        target_block_size = int(np.ceil(dim / num_blocks))
        
        while unassigned:
            if len(blocks) == num_blocks - 1:
                # Last block takes all remaining
                blocks.append(list(unassigned))
                break
                
            # Pick seed (random or first available)
            seed = list(unassigned)[0]
            current_block = [seed]
            unassigned.remove(seed)
            
            # Add N nearest neighbors
            while len(current_block) < target_block_size and unassigned:
                # Find nearest to *any* in current block? Or centroid?
                # Simple: nearest to seed or mean distance to block
                # Let's do min-average-distance to current block
                candidates = list(unassigned)
                
                # Compute avg dist to current block for each candidate
                # dist_mat[c, current_block]
                avg_dists = [np.mean(dist_mat[c, current_block]) for c in candidates]
                best_cand_idx = np.argmin(avg_dists)
                best_cand = candidates[best_cand_idx]
                
                current_block.append(best_cand)
                unassigned.remove(best_cand)
                
            blocks.append(current_block)
        
        # If we have overlap
        if overlap_fraction > 0:
            # Overlap implementation:
            # Start each block with 'overlap' amount of indices from the previous block
            # This logic modifies the 'blocks' list we just created.
            # However simple partition-based generation above doesn't support overlap naturally.
            # Let's refine: The greedy approach above created partition.
            # To add overlap: Append N items from block[i-1] to block[i]
            # EXCEPT for first block.
            
            # Note: This increases total size, so "target_block_size" in previous step was for partition.
            overlap_count = int(np.ceil(target_block_size * overlap_fraction))
            if overlap_count > 0:
                for i in range(1, len(blocks)):
                    # Get overlap candidates from previous block (random or specific?)
                    # Random is safest to avoid bias
                    prev_block = blocks[i-1]
                    if len(prev_block) > 0:
                        overlap_indices = rng.choice(prev_block, size=min(len(prev_block), overlap_count), replace=False)
                        # Add to current
                        blocks[i].extend(overlap_indices)
                        # Uniquify just in case
                        blocks[i] = list(set(blocks[i]))
            
        return blocks
    else:
        # Fallback to random
        perm = rng.permutation(dim)
        # Split into ~equal chunks
        blocks = [list(a) for a in np.array_split(perm, num_blocks)]
        return blocks


def run_hybrid_optimization(
    objective: Callable[[np.ndarray], float],
    bounds: list,
    x0: np.ndarray,
    hybrid_config: HybridOptimizerConfig,
    total_budget: int = 3000,
    logger = None,
    log_status_fn = None, 
    update_progress_fn = None,
    valley_escape_tracker: Optional[Dict[str, Any]] = None,
    # Parallel evaluation support
    executor: Optional[ProcessPoolExecutor] = None,
    integer_dims: Optional[list] = None,
    eval_cache: Optional[dict] = None,
    make_cache_key_fn: Optional[Callable[[np.ndarray], Tuple[int, ...]]] = None,
    stop_event: Optional[Any] = None,  # threading.Event for stop signal
) -> Tuple[np.ndarray, float, int]:
    """
    Run Hybrid CMA-ES + Block Re-optimization.
    
    Logic:
    1. Stage A: Global Exploration (Standard CMA-ES)
    2. Loop Cycles:
       a. Stage B: Build Blocks (Random or Correlation-based)
       b. Stage C: Block Re-optimization (Soft freezing)
    3. Stage D: Global Refresh (Periodic)
    
    Args:
        objective: Main objective function (returns float).
        bounds: List of (min, max).
        x0: Initial guess.
        hybrid_config: Configuration.
        total_budget: Max evals.
        
    Returns:
        (best_x, best_f, total_evals)
    """
    evals_used = 0
    dim = len(x0)
    
    # Setup constraints/bounds arrays
    lower_bounds = np.array([b[0] for b in bounds])
    upper_bounds = np.array([b[1] for b in bounds])
    span = upper_bounds - lower_bounds
    
    # 1. Initialize Elite Pool
    elite_pool = ElitePool(k=hybrid_config.elite_k)
    
    # 2. Budget allocation
    # Reserve slice for Stage A
    # The rest is split among cycles
    stage_a_budget = int(total_budget * (1.0 - hybrid_config.per_block_budget_fraction))
    block_budget_total = total_budget - stage_a_budget
    
    if hybrid_config.cycles > 0 and hybrid_config.num_blocks > 0:
        per_cycle_budget = block_budget_total // hybrid_config.cycles
        if hybrid_config.refresh_every_pass:
             # Subtract refresh budget from per-cycle
             refresh_cost = int(total_budget * hybrid_config.refresh_budget_fraction)
             per_cycle_budget = max(0, per_cycle_budget - refresh_cost)
    else:
        per_cycle_budget = 0
        
    # --- STAGE A: Global Exploration (CMA-ES) ---
    if update_progress_fn: update_progress_fn("Hybrid: Stage A", 0.1, "Global Exploration")
    if logger: logger.info(f"Stage A: Global Search (Budget: {stage_a_budget})")
    
    # Setup CMA stds
    sigma0 = 0.25 * float(np.percentile(span, 25)) # Heuristic 25% of 25th percentile span
    cma_stds = span / (4.0 * sigma0) # Normalize so sigma*std roughly covers range
    
    # We use a randomized restart wrapper for Stage A to ensure good coverage
    # But for simplicity we call run_cma_core once with restart logic INTERNAL if we wanted,
    # but run_cma_core is single run.
    # Let's do 2 quick restarts in Stage A budget if budget allows
    
    best_x_global = x0.copy()
    valid_f = objective(best_x_global)
    elite_pool.add(best_x_global, valid_f)
    best_f_global = valid_f
    
    # Split Stage A budget into 2 restarts
    budget_a1 = int(stage_a_budget * 0.6)
    budget_a2 = stage_a_budget - budget_a1
    
    # Run 1
    x_res, f_res, evs = run_cma_core(
        objective, x0, sigma0, bounds, budget_a1, 
        popsize=16, cma_stds=cma_stds, elite_pool=elite_pool,
        valley_escape_tracker=valley_escape_tracker, logger=logger,
        # Parallel evaluation
        executor=executor, integer_dims=integer_dims, eval_cache=eval_cache,
        make_cache_key_fn=make_cache_key_fn,
        stop_event=stop_event,
    )
    evals_used += evs
    if f_res < best_f_global:
        best_f_global = f_res
        best_x_global = x_res
        
    # Run 2 (Restart from best or random?)
    # Valid restart: Perturb best logic
    rng = np.random.default_rng()
    x0_2 = best_x_global + rng.standard_normal(dim) * (0.01 * span) # Small perturbation
    
    if budget_a2 > 100:
        x_res, f_res, evs = run_cma_core(
            objective, x0_2, sigma0 * 0.5, bounds, budget_a2, 
            popsize=16, cma_stds=cma_stds, elite_pool=elite_pool,
            valley_escape_tracker=valley_escape_tracker, logger=logger,
            # Parallel evaluation
            executor=executor, integer_dims=integer_dims, eval_cache=eval_cache,
            make_cache_key_fn=make_cache_key_fn,
            stop_event=stop_event,
        )
        evals_used += evs
        if f_res < best_f_global:
            best_f_global = f_res
            best_x_global = x_res
            
    if logger: logger.info(f"Stage A Complete. Best f: {best_f_global:.5f}")
    
    # --- CYCLES ---
    current_x = best_x_global.copy()
    
    for cycle_idx in range(hybrid_config.cycles):
        # Check if optimization should stop
        if stop_event is not None and stop_event.is_set():
            raise RuntimeError("Optimization stopped by user")
        
        if update_progress_fn: 
            update_progress_fn(f"Hybrid: Cycle {cycle_idx+1}", 0.3 + 0.6*(cycle_idx/max(1,hybrid_config.cycles)), f"Block Optimization ({hybrid_config.block_method})")
            
        cycle_budget = per_cycle_budget
        
        # --- STAGE B: Build Blocks ---
        blocks = compute_blocks_from_elites(
            elite_pool, hybrid_config.num_blocks, dim, 
            method=hybrid_config.block_method, 
            overlap_fraction=hybrid_config.overlap_fraction,
            rng=rng
        )
        
        if logger: logger.info(f"Cycle {cycle_idx+1}: Created {len(blocks)} blocks using {hybrid_config.block_method} (Overlap: {hybrid_config.overlap_fraction})")
        
        # Calculate penalty weight
        # λ_eff = λ_schedule * f_scale / ||x||^2
        # Determine f_scale
        _, f_vals_elite = elite_pool.get_elites()
        if len(f_vals_elite) > 0:
            f_scale = np.median(np.abs(f_vals_elite))
        else:
            f_scale = max(1.0, abs(best_f_global))
            
        if not hybrid_config.lambda_normalize:
            f_scale = 1.0 # Use raw user lambda
            
        base_lambda = hybrid_config.lambda0 * (hybrid_config.lambda_mult ** cycle_idx)
        base_lambda = min(base_lambda, hybrid_config.lambda_max)
        
        # --- STAGE C: Block Re-optimization ---
        if len(blocks) > 0:
            budget_per_block = cycle_budget // len(blocks)
        else:
            budget_per_block = 0
        
        for b_i, block_indices in enumerate(blocks):
            if budget_per_block < 20: continue # Skip if too small
            
            non_block_indices = [i for i in range(dim) if i not in block_indices]
            
            # Constants for this block run
            x_fixed_vals = current_x[non_block_indices]
            
            # Define block bounds
            block_lower = lower_bounds[block_indices]
            block_upper = upper_bounds[block_indices]
            block_bounds = list(zip(block_lower, block_upper))
            
            # Initial mean for this block
            z0 = current_x[block_indices]
            
            # Objective wrapper
            def block_obj_fn(z):
                # Stitch
                full_x = current_x.copy() # Start with current baseline
                full_x[block_indices] = z # Overwrite block
                # Clip full x to be safe
                full_x = np.clip(full_x, lower_bounds, upper_bounds)
                return objective(full_x)
                
            # Run CMA on block
            # Scaling: use same heuristic (25% of block range)
            z_span = block_upper - block_lower
            z_sigma = 0.2 * np.median(z_span) # Slightly smaller for local block
            # Apply additional boost to block sigma if valley escape is active
            if valley_escape_tracker is not None:
                tier = valley_escape_tracker.get("valley_escape_tier", 0)
                if tier > 0:
                    # Block reopt: smaller boost (1.2 - 1.8x)
                    block_boost = 1.0 + (tier * 0.2) # Tier 1: 1.2, Tier 2: 1.4, Tier 3: 1.6
                    z_sigma *= block_boost
            
            z_best, z_f, z_evals = run_cma_core(
                block_obj_fn, z0, z_sigma, block_bounds, budget_per_block,
                popsize=max(8, 4 + int(3 * np.log(len(z0)+1))), # Smaller pop for blocks
                elite_pool=None, 
                true_objective_fn=block_obj_fn,
                valley_escape_tracker=valley_escape_tracker, logger=logger,
                make_cache_key_fn=make_cache_key_fn,
                stop_event=stop_event,
            )
            
            evals_used += z_evals
            
            # Update current_x if improved
            if z_f < objective(current_x): # Re-eval current_x or use trusted value?
                 current_x[block_indices] = z_best
                 if z_f < best_f_global:
                     best_f_global = z_f
                     best_x_global = current_x.copy()
                     if logger: logger.info(f"    Block {b_i} improved global best -> {best_f_global:.5f}")
            
            # Also add the new best to elite pool
            elite_pool.add(current_x, z_f)
            
        # --- STAGE D: Global Refresh ---
        if hybrid_config.refresh_every_pass:
            ref_budget = int(total_budget * hybrid_config.refresh_budget_fraction)
            if ref_budget > 50:
                if logger: logger.info(f"Cycle {cycle_idx+1}: Global Refresh (Budget {ref_budget})")
                
                # Start around current best
                x_ref = best_x_global.copy()
                
                # Reduced sigma
                # User req 4: "sigma = refresh_sigma_scale * sigma_initial"
                sigma_ref = sigma0 * hybrid_config.refresh_sigma_scale
                
                # Apply additional boost to refresh sigma if valley escape is active
                if valley_escape_tracker is not None:
                    tier = valley_escape_tracker.get("valley_escape_tier", 0)
                    if tier > 0:
                        # Global refresh: larger boost (1.5 - 2.5x)
                        refresh_boost = 1.0 + (tier * 0.5) # Tier 1: 1.5, Tier 2: 2.0, Tier 3: 2.5
                        sigma_ref *= refresh_boost

                x_ref_res, f_ref_res, evs_ref = run_cma_core(
                    objective, x_ref, sigma_ref, bounds, ref_budget,
                    popsize=16, cma_stds=cma_stds, elite_pool=elite_pool,
                    valley_escape_tracker=valley_escape_tracker, logger=logger,
                    make_cache_key_fn=make_cache_key_fn,
                    stop_event=stop_event,
                )
                evals_used += evs_ref
                
                if f_ref_res < best_f_global:
                    best_f_global = f_ref_res
                    best_x_global = x_ref_res
                    current_x = x_ref_res # Update incumbent for next cycle
                    if logger: logger.info(f"    Refresh improved global best -> {best_f_global:.5f}")
                    
    return best_x_global, best_f_global, evals_used
