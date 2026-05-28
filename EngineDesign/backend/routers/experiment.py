"""Experiment router — cold-flow CdA characterization and real-propellant prediction.

Per-row: mdot = weight / dT,  CdA = mdot / sqrt(2 * rho_water * dP)
No orifice diameter required — CdA is measured directly.
Mean CdA then predicts real-propellant mdot at operating conditions.
"""

from __future__ import annotations

import copy
import math
import statistics
from typing import Dict, List, Literal, Optional, Tuple

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field


from backend.state import app_state

router = APIRouter(prefix="/api/experiment", tags=["experiment"])

WATER_VAPOR_PRESSURE_PA = 2337.0   # Pa at 20 °C
WATER_VISCOSITY_PA_S    = 0.001    # Pa·s at 20 °C
PSI_TO_PA               = 6894.757


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class ExperimentRow(BaseModel):
    label: str         = Field(default="Run")
    t0: float          = Field(description="Start time [s]")
    tf: float          = Field(description="End time [s]")
    delta_p_psi: float = Field(gt=0, description="Injector pressure drop during this run [psi]")
    weight: float      = Field(ge=0, description="Tank weight reading at start of this interval [kg]")


class ExperimentRequest(BaseModel):
    propellant: Literal["fuel", "lox"]
    water_density: float         = Field(default=998.2, gt=0, description="Water density [kg/m³]")
    real_pressure_drop_pa: float = Field(gt=0, description="Real-propellant ΔP [Pa]")
    rows: List[ExperimentRow]    = Field(min_length=1)


class RowResult(BaseModel):
    label: str
    dt: float
    weight: float
    delta_p_psi: float
    mdot: float
    cda_m2: float


class ValidationResult(BaseModel):
    cavitation_number: float
    cavitation_warning: bool


class ExperimentResponse(BaseModel):
    rows: List[RowResult]
    mean_cda_m2: float
    std_cda_m2: float
    propellant_name: str
    rho_real: float
    mu_real: float
    mdot_real: float
    validation: ValidationResult


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.post("/calculate", response_model=ExperimentResponse)
async def calculate_experiment(request: ExperimentRequest) -> ExperimentResponse:
    """Process cold-flow water test data and predict real-propellant mass flow rate."""

    # ---- per-row calculations (dW = weight[i] - weight[i-1], weight[-1] = 0) -
    row_results: List[RowResult] = []
    for i, row in enumerate(request.rows):
        dt = row.tf - row.t0
        if dt <= 0:
            raise HTTPException(status_code=400, detail=f"Row '{row.label}': tf must be > t0.")

        prev_weight = request.rows[i - 1].weight if i > 0 else 0.0
        dw          = row.weight - prev_weight
        if dw < 0:
            raise HTTPException(status_code=400, detail=f"Row '{row.label}': weight decreased vs previous row — check row order.")

        mdot       = dw / dt
        delta_p_pa = row.delta_p_psi * PSI_TO_PA
        denominator = math.sqrt(2.0 * request.water_density * delta_p_pa)

        if denominator == 0:
            raise HTTPException(status_code=400, detail=f"Row '{row.label}': zero denominator — check ΔP.")

        cda_m2 = mdot / denominator
        row_results.append(RowResult(
            label=row.label, dt=dt, weight=dw,
            delta_p_psi=row.delta_p_psi, mdot=mdot, cda_m2=cda_m2,
        ))

    # ---------------------------------------------------------- summary stats
    cda_values   = [r.cda_m2 for r in row_results]
    mean_cda_m2  = statistics.mean(cda_values)
    std_cda_m2   = statistics.stdev(cda_values) if len(cda_values) > 1 else 0.0

    # ----------------------------------------- propellant properties from config
    if not app_state.has_config():
        raise HTTPException(status_code=400, detail="No engine config loaded — needed for propellant properties.")

    fluid_key = "fuel" if request.propellant == "fuel" else "oxidizer"
    try:
        fluid = app_state.config.fluids[fluid_key]
    except KeyError:
        raise HTTPException(status_code=400, detail=f"Config has no fluids['{fluid_key}'].")

    rho_real        = fluid.density
    mu_real         = fluid.viscosity
    propellant_name = getattr(fluid, "name", fluid_key.upper())

    # ----------------------------------------- real-propellant prediction
    mdot_real = mean_cda_m2 * math.sqrt(2.0 * rho_real * request.real_pressure_drop_pa)

    # ---------------------------------------------------------- validation (cavitation only)
    mean_dp_pa    = statistics.mean([r.delta_p_psi * PSI_TO_PA for r in row_results])
    cavitation_number = mean_dp_pa / WATER_VAPOR_PRESSURE_PA

    validation = ValidationResult(
        cavitation_number=cavitation_number,
        cavitation_warning=cavitation_number < 2.0,
    )

    return ExperimentResponse(
        rows=row_results, mean_cda_m2=mean_cda_m2, std_cda_m2=std_cda_m2,
        propellant_name=propellant_name, rho_real=rho_real, mu_real=mu_real,
        mdot_real=mdot_real, validation=validation,
    )


# ---------------------------------------------------------------------------
# Run-timeseries models and helpers
# ---------------------------------------------------------------------------

class PropellantTable(BaseModel):
    water_density: float      = Field(default=998.2, gt=0, description="Water density [kg/m³]")
    rows: List[ExperimentRow] = Field(min_length=1)


class FuelTable(PropellantTable):
    pass


class LoxTable(PropellantTable):
    pass


class RunTimeseriesRequest(BaseModel):
    fuel: FuelTable
    lox:  LoxTable


def _extract_cda_pairs(table: PropellantTable) -> List[Tuple[float, float]]:
    """Return list of (delta_p_pa, cda_m2) from per-row water-test data."""
    pairs: List[Tuple[float, float]] = []
    for i, row in enumerate(table.rows):
        dt    = row.tf - row.t0
        if dt <= 0:
            continue
        prev_w = table.rows[i - 1].weight if i > 0 else 0.0
        dw     = row.weight - prev_w
        if dw < 0:
            continue
        dp_pa = row.delta_p_psi * PSI_TO_PA
        denom = math.sqrt(2.0 * table.water_density * dp_pa)
        if denom == 0:
            continue
        pairs.append((dp_pa, (dw / dt) / denom))
    return pairs


def _within_two_orders_of_magnitude(sim: float, ref: float) -> bool:
    """True if sim is within 10⁻² … 10² of ref (two decades)."""
    if ref <= 0.0 or sim <= 0.0:
        return False
    ratio = sim / ref
    return 1e-2 <= ratio <= 1e2


def _fit_cda_sqrt_dp(pairs: List[Tuple[float, float]]) -> Tuple[float, float]:
    """
    Fit CdA as a linear function of sqrt(ΔP):
        CdA = a*sqrt(ΔP_pa) + b  [m²]

    Returns:
        (a, b)
    """
    if not pairs:
        return 0.0, 0.0
    if len(pairs) == 1:
        return 0.0, float(pairs[0][1])

    dp  = np.asarray([p for p, _ in pairs], dtype=float)
    cda = np.asarray([c for _, c in pairs], dtype=float)
    mask = np.isfinite(dp) & np.isfinite(cda) & (dp > 0.0)
    dp  = dp[mask]
    cda = cda[mask]
    if dp.size == 0:
        return 0.0, 0.0
    if dp.size == 1:
        return 0.0, float(cda[0])

    x = np.sqrt(dp)
    y = cda
    a, b = np.polyfit(x, y, 1)
    if not np.isfinite(a) or not np.isfinite(b):
        return 0.0, float(np.nanmean(y)) if y.size else 0.0
    return float(a), float(b)


def _cda_from_fit(dp_pa: float, a: float, b: float) -> float:
    """Evaluate fitted CdA model at ΔP (Pa) with safety clamps."""
    if not np.isfinite(dp_pa) or dp_pa <= 0.0:
        return 0.0
    cda = a * math.sqrt(dp_pa) + b
    if not np.isfinite(cda):
        return 0.0
    return float(max(0.0, cda))


def _segments_to_curve_pa(segments, n_points: int) -> np.ndarray:
    """Build a pressure curve [Pa] using the existing segment generator."""
    from engine.optimizer.layers.layer2_pressure import generate_pressure_curve_from_segments

    if not segments:
        return np.full(n_points, 0.0, dtype=float)

    seg_dicts = []
    prev_end = None
    for i, seg in enumerate(segments):
        # Chain from previous end pressure, mirroring backend/routers/timeseries.py behavior
        start_p = float(seg.start_pressure_pa if i == 0 else (prev_end if prev_end is not None else seg.start_pressure_pa))
        end_p   = float(seg.end_pressure_pa)
        seg_dicts.append({
            "length_ratio": float(seg.length_ratio),
            "type": seg.type,
            "start_pressure": start_p,
            "end_pressure": end_p,
            "k": float(seg.k) if getattr(seg, "k", None) is not None else 0.5,
        })
        prev_end = end_p

    return np.asarray(generate_pressure_curve_from_segments(seg_dicts, n_points=n_points), dtype=float)


# ---------------------------------------------------------------------------
# /run_timeseries endpoint
# ---------------------------------------------------------------------------

@router.post("/run_timeseries")
async def run_timeseries(request: RunTimeseriesRequest):
    """Run time-series engine simulation with per-step Cd from water-test data."""
    if not app_state.has_config():
        raise HTTPException(status_code=400, detail="No engine config loaded.")

    from engine.core.runner import PintleEngineRunner

    # ---- extract (ΔP, CdA) characterisation tables ----
    fuel_pairs = _extract_cda_pairs(request.fuel)
    lox_pairs  = _extract_cda_pairs(request.lox)
    if not fuel_pairs:
        raise HTTPException(status_code=400, detail="Fuel table: not enough valid rows to compute CdA.")
    if not lox_pairs:
        raise HTTPException(status_code=400, detail="LOX table: not enough valid rows to compute CdA.")

    # ---- get pressure curves from config (hotfire-representative) ----
    cfg_active = app_state.config
    pcfg = getattr(cfg_active, "pressure_curves", None)
    if pcfg is None:
        raise HTTPException(
            status_code=400,
            detail="Active config has no 'pressure_curves' section. Upload a config that includes pressure_curves to run experiment-mode time series at operating pressures.",
        )

    n_points = int(pcfg.n_points)
    if n_points <= 1:
        raise HTTPException(status_code=400, detail="pressure_curves.n_points must be > 1.")

    duration_s = float(pcfg.target_burn_time_s)
    if duration_s <= 0:
        raise HTTPException(status_code=400, detail="pressure_curves.target_burn_time_s must be > 0.")

    times = np.linspace(0.0, duration_s, n_points, dtype=float)
    P_lox_curve_pa  = _segments_to_curve_pa(pcfg.lox_segments, n_points=n_points)
    P_fuel_curve_pa = _segments_to_curve_pa(pcfg.fuel_segments, n_points=n_points)

    # ---- deep-copy config; geometry stays as-is (CdA overrides mass flow) ----
    cfg = copy.deepcopy(app_state.config)

    # ---- fit/extrapolate CdA(ΔP) = a*sqrt(ΔP) + b  [m²] ----
    a_fuel, b_fuel = _fit_cda_sqrt_dp(fuel_pairs)
    a_lox,  b_lox  = _fit_cda_sqrt_dp(lox_pairs)

    # ---- install CdA fit coefficients on discharge configs (done once, not per-step) ----
    # The injector solver will re-evaluate CdA = a·√(ΔP_inj) + b at each Pc iteration.
    cfg.discharge["oxidizer"].cda_fit_a = a_lox
    cfg.discharge["oxidizer"].cda_fit_b = b_lox
    cfg.discharge["fuel"].cda_fit_a     = a_fuel
    cfg.discharge["fuel"].cda_fit_b     = b_fuel

    # ---- build runner ----
    runner = PintleEngineRunner(cfg)

    # ---- per-step loop ----
    keys = ["Pc", "mdot_O", "mdot_F", "F", "Isp", "MR", "Cd_O", "Cd_F",
            "delta_p_injector_O", "delta_p_injector_F"]
    out  = {k: np.zeros(len(times)) for k in keys}
    failures: List[str] = []

    for i in range(len(times)):
        P_O = float(P_lox_curve_pa[i])
        P_F = float(P_fuel_curve_pa[i])

        try:
            pt = runner.evaluate(P_O, P_F, debug=False, silent=True)
            for k in ["Pc", "mdot_O", "mdot_F", "F", "Isp", "MR"]:
                out[k][i] = pt.get(k, 0.0)
            out["Cd_O"][i] = pt.get("Cd_O", 0.0)
            out["Cd_F"][i] = pt.get("Cd_F", 0.0)
            inj = pt.get("injector_pressure", {}) or {}
            out["delta_p_injector_O"][i] = inj.get("delta_p_injector_O") or 0.0
            out["delta_p_injector_F"][i] = inj.get("delta_p_injector_F") or 0.0
        except Exception as e:
            msg = f"step {i} failed (P_O={P_O:.0f} Pa, P_F={P_F:.0f} Pa): {e}"
            failures.append(msg)
            print(f"[run_timeseries] {msg}")

    if failures and len(failures) == len(times):
        raise HTTPException(status_code=500, detail=f"Time-series failed for every step. First error: {failures[0]}")

    return {
        "status":  "success",
        "t":       times.tolist(),
        "results": {k: v.tolist() for k, v in out.items()},
        "fuel_cda_pressure_pairs": fuel_pairs,
        "lox_cda_pressure_pairs":  lox_pairs,
        "pressure_curves_used": {
            "P_tank_O_pa": P_lox_curve_pa.tolist(),
            "P_tank_F_pa": P_fuel_curve_pa.tolist(),
        },
        "cda_fit": {
            "fuel": {"model": "CdA = a*sqrt(dP_pa) + b [m²]", "a": a_fuel, "b": b_fuel},
            "lox":  {"model": "CdA = a*sqrt(dP_pa) + b [m²]", "a": a_lox,  "b": b_lox},
        },
    }


# ---------------------------------------------------------------------------
# Pressure Feed Experiment (static press test: fit Cv_line)
# ---------------------------------------------------------------------------

class PressTestRunRow(BaseModel):
    """A single static press test run used to fit Cv_line."""

    label: str = Field(default="Run")
    tank: Literal["lox", "fuel"] = Field(default="lox", description="Which propellant tank this run pressurizes")
    ullage_fraction: float = Field(
        ge=0,
        le=1,
        description="Ullage (gas) fraction 0-1 for the specified tank.",
    )

    # COPV sensor window (start/end of solenoid-open transient, COPV side)
    copv_p_start_psi: float = Field(gt=0, description="COPV pressure at start of open window [psi]")
    copv_p_end_psi: float = Field(gt=0, description="COPV pressure at end of open window [psi]")
    copv_t_start_s: float = Field(ge=0, description="COPV transient start time [s]")
    copv_t_end_s: float = Field(gt=0, description="COPV transient end time [s]")

    # Tank sensor window (may have lag relative to COPV sensor)
    tank_p_start_psi: float = Field(ge=0, description="Tank pressure at start of tank transient [psi]")
    tank_p_end_psi: float = Field(gt=0, description="Tank pressure at end of tank transient [psi]")
    tank_t_start_s: float = Field(ge=0, description="Tank transient start time [s]")
    tank_t_end_s: float = Field(gt=0, description="Tank transient end time [s]")


class PressTestFitRequest(BaseModel):
    rows: List[PressTestRunRow] = Field(min_length=1)
    tank_volume_lox_m3: Optional[float] = Field(default=None, gt=0, description="Total LOX tank volume [m³]")
    tank_volume_fuel_m3: Optional[float] = Field(default=None, gt=0, description="Total fuel tank volume [m³]")

    # Legacy inputs (kept for backward compatibility; prefer the fields above)
    tank_volume_m3: Optional[float] = Field(default=None, gt=0, description="LEGACY: total tank volume [m³] used for both LOX and fuel")
    fill_fraction: Optional[float] = Field(
        default=None,
        ge=0,
        lt=1,
        description="LEGACY: propellant fill fraction 0-1 (ullage_fraction = 1 - fill_fraction)",
    )
    copv_volume_L: float = Field(gt=0, description="COPV free volume [L]")
    T_copv_K: float = Field(default=300.0, gt=0)
    T_ull_K: float = Field(default=293.0, gt=0)
    reg_cv: float = Field(default=0.06, gt=0, description="Regulator Cv (overrides config if provided)")
    reg_droop_coeff: float = Field(default=0.070, ge=0)
    reg_setpoint_psi: float = Field(gt=0)
    reg_initial_copv_psi: float = Field(gt=0)


class PressTestRunResult(BaseModel):
    row_index: int = Field(ge=0, description="0-based index of this run in the submitted rows[]")
    label: str
    tank: Literal["lox", "fuel"]
    cv_line_estimate: float
    mdot_copv_avg: float
    mdot_tank_avg: float
    cross_check_ratio: float
    copv_dp_psi: float
    tank_dp_psi: float


class PressTestRowDiagnostic(BaseModel):
    """Per submitted row: whether it contributed to Cv_line and why not if skipped."""

    row_index: int = Field(ge=0)
    label: str
    tank: Literal["lox", "fuel"]
    status: Literal["ok", "skipped"]
    message: str = Field(default="", description="Empty when ok; human-readable reason when skipped")


class PressTestFitResponse(BaseModel):
    rows: List[PressTestRunResult]
    row_diagnostics: List[PressTestRowDiagnostic] = Field(
        default_factory=list,
        description="One entry per submitted row, same order as request.rows",
    )
    # Per-branch fitted values (None if no runs for that branch)
    cv_line_lox_fitted: Optional[float]
    cv_line_lox_std: Optional[float]
    cv_line_fuel_fitted: Optional[float]
    cv_line_fuel_std: Optional[float]
    cv_reg: float
    cv_eff_lox: Optional[float]
    cv_eff_fuel: Optional[float]
    recommendation: str
    save_available: bool


@router.post("/press_test_fit", response_model=PressTestFitResponse)
async def fit_press_test(request: PressTestFitRequest) -> PressTestFitResponse:
    """Fit Cv_line (separately for LOX and fuel) from one or more static press test runs.

    Each run must specify which tank it pressurizes (lox/fuel). Runs are grouped by tank
    and Cv_line is fitted independently for each branch.

    COPV and tank time windows need not overlap: the fit uses the **union** of both windows
    and holds each pressure trace constant outside its stated interval (so solenoid / line
    delay between COPV and tank transients is allowed).
    """
    from copv.press_resupply_solver import fit_cv_line_from_static_test, series_cv
    from engine.pipeline.config_schemas import PressSystemConfig

    ps = PressSystemConfig(
        reg_cv=request.reg_cv,
        reg_droop_coeff=request.reg_droop_coeff,
        reg_setpoint_psi=request.reg_setpoint_psi,
        reg_initial_copv_psi=request.reg_initial_copv_psi,
    )

    V_copv_m3 = request.copv_volume_L / 1000.0

    # Resolve tank volumes (new per-branch inputs preferred)
    tank_vol_lox_m3 = (
        float(request.tank_volume_lox_m3)
        if request.tank_volume_lox_m3 is not None
        else float(request.tank_volume_m3) if request.tank_volume_m3 is not None else None
    )
    tank_vol_fuel_m3 = (
        float(request.tank_volume_fuel_m3)
        if request.tank_volume_fuel_m3 is not None
        else float(request.tank_volume_m3) if request.tank_volume_m3 is not None else None
    )
    if tank_vol_lox_m3 is None or tank_vol_fuel_m3 is None:
        raise HTTPException(
            status_code=422,
            detail="Provide tank_volume_lox_m3 and tank_volume_fuel_m3 (or legacy tank_volume_m3).",
        )

    def _ullage_volume_m3_for_row(row: PressTestRunRow) -> float:
        tank_vol = tank_vol_lox_m3 if row.tank == "lox" else tank_vol_fuel_m3
        uf = float(np.clip(float(row.ullage_fraction), 0.0, 1.0))
        return float(max(tank_vol * uf, 1e-9))

    def _interp_2pt(t: np.ndarray, t0: float, tf: float, p0: float, pf: float) -> np.ndarray:
        if tf <= t0:
            raise ValueError("Invalid window: tf must be > t0.")
        x = (t - t0) / (tf - t0)
        return p0 + x * (pf - p0)

    def _interp_clamped(t: np.ndarray, t0: float, tf: float, p0: float, pf: float) -> np.ndarray:
        """Linear between [t0, tf]; hold p0 / pf outside (models unknown pre/post window)."""
        if tf <= t0:
            raise ValueError("Invalid window: tf must be > t0.")
        x = np.clip((t - t0) / (tf - t0), 0.0, 1.0)
        return p0 + x * (pf - p0)

    row_results: List[PressTestRunResult] = []
    row_diagnostics: List[PressTestRowDiagnostic] = []
    lox_estimates: List[float] = []
    fuel_estimates: List[float] = []

    for row_index, row in enumerate(request.rows):
        label = (row.label or "").strip() or f"Run {row_index + 1}"

        def _diag_skip(message: str) -> None:
            row_diagnostics.append(
                PressTestRowDiagnostic(
                    row_index=row_index,
                    label=label,
                    tank=row.tank,
                    status="skipped",
                    message=message,
                )
            )

        c0, c1 = float(row.copv_t_start_s), float(row.copv_t_end_s)
        k0, k1 = float(row.tank_t_start_s), float(row.tank_t_end_s)
        if c1 <= c0:
            _diag_skip("COPV time window is invalid: copv_t_end_s must be greater than copv_t_start_s.")
            continue
        if k1 <= k0:
            _diag_skip("Tank time window is invalid: tank_t_end_s must be greater than tank_t_start_s.")
            continue

        # Union of COPV and tank observation windows (allows line/solenoid delay between sides).
        # Each trace is clamped outside its own [start, end] so pre-delay / post-transient plateaus
        # do not extrapolate the linear ramp past measured endpoints.
        t0 = min(c0, k0)
        tf = max(c1, k1)
        if tf <= t0:
            _diag_skip("Combined time span is invalid after merging COPV and tank windows.")
            continue

        if float(row.copv_p_end_psi) >= float(row.copv_p_start_psi):
            _diag_skip(
                "COPV pressure should fall over the window (copv_p_end_psi must be less than copv_p_start_psi)."
            )
            continue
        if float(row.tank_p_end_psi) <= float(row.tank_p_start_psi):
            _diag_skip(
                "Tank pressure should rise over the window (tank_p_end_psi must be greater than tank_p_start_psi)."
            )
            continue

        # Many samples along the hull — sparse (3-point) grids made np.gradient() noisy on
        # short clamped ramps, so physically similar rows alternately inferred Cv_eff >= reg_cv.
        n_samples = 33
        times = np.linspace(t0, tf, n_samples, dtype=float)

        P_copv = _interp_clamped(
            times,
            c0,
            c1,
            float(row.copv_p_start_psi) * PSI_TO_PA,
            float(row.copv_p_end_psi) * PSI_TO_PA,
        )
        P_tank = _interp_clamped(
            times,
            k0,
            k1,
            float(row.tank_p_start_psi) * PSI_TO_PA,
            float(row.tank_p_end_psi) * PSI_TO_PA,
        )

        try:
            V_ull_m3 = _ullage_volume_m3_for_row(row)
            fit = fit_cv_line_from_static_test(
                times=times,
                P_copv_Pa=P_copv,
                P_tank_Pa=P_tank,
                V_copv_m3=float(V_copv_m3),
                V_ull_m3=float(V_ull_m3),
                press_system_config=ps,
                T_copv_K=float(request.T_copv_K),
                T_ull_K=float(request.T_ull_K),
            )
        except ValueError as exc:
            msg = str(exc)
            if "Could not infer any finite Cv_line" in msg:
                msg += (
                    " Typical causes: (1) modeled reg_cv is lower than the hardware path implies—"
                    "try increasing press_system.reg_cv in System Parameters; "
                    "(2) time windows are very short so slopes were noisy (fitter now uses many samples along the hull)."
                )
            _diag_skip(msg)
            continue

        cv_line_est = float(fit["cv_line_median"])
        if not np.isfinite(cv_line_est) or cv_line_est <= 0:
            _diag_skip(
                f"Cv_line estimate was not a positive finite number (got {cv_line_est!r}). "
                "Regulator Cv may be inconsistent with the inferred effective Cv."
            )
            continue

        if row.tank == "lox":
            lox_estimates.append(cv_line_est)
        else:
            fuel_estimates.append(cv_line_est)

        row_diagnostics.append(
            PressTestRowDiagnostic(row_index=row_index, label=label, tank=row.tank, status="ok", message="")
        )
        row_results.append(
            PressTestRunResult(
                row_index=row_index,
                label=label,
                tank=row.tank,
                cv_line_estimate=round(cv_line_est, 6),
                mdot_copv_avg=round(float(np.mean(fit["mdot_copv_side"])), 8),
                mdot_tank_avg=round(float(np.mean(fit["mdot_tank_side"])), 8),
                cross_check_ratio=round(float(fit["cross_check_ratio"]), 3),
                copv_dp_psi=round(float(row.copv_p_start_psi - row.copv_p_end_psi), 2),
                tank_dp_psi=round(float(row.tank_p_end_psi - row.tank_p_start_psi), 2),
            )
        )

    def _summarise(estimates: List[float]) -> tuple:
        if not estimates:
            return None, None
        return float(np.median(estimates)), float(np.std(estimates))

    cv_lox, cv_lox_std = _summarise(lox_estimates)
    cv_fuel, cv_fuel_std = _summarise(fuel_estimates)

    cv_eff_lox = float(series_cv(float(request.reg_cv), cv_lox)) if cv_lox else None
    cv_eff_fuel = float(series_cv(float(request.reg_cv), cv_fuel)) if cv_fuel else None

    save_avail = (
        hasattr(app_state, "config")
        and app_state.config is not None
        and getattr(app_state.config, "press_system", None) is not None
    )

    all_ok = all(abs(r.cross_check_ratio - 1.0) < 0.10 for r in row_results) if row_results else False
    parts: List[str] = []
    if not lox_estimates and not fuel_estimates:
        recommendation = (
            "No row produced a valid Cv_line. See row diagnostics below for each submitted row."
        )
    else:
        if cv_lox is not None:
            parts.append(
                f"LOX Cv_line = {cv_lox:.4f} ± {cv_lox_std:.4f} ({len(lox_estimates)} runs, Cv_eff = {cv_eff_lox:.4f})"
            )
        if cv_fuel is not None:
            parts.append(
                f"Fuel Cv_line = {cv_fuel:.4f} ± {cv_fuel_std:.4f} ({len(fuel_estimates)} runs, Cv_eff = {cv_eff_fuel:.4f})"
            )
        recommendation = "; ".join(parts) + ". " + (
            "Cross-check ratios within ±10% — good." if all_ok
            else "Some cross-check ratios outside ±10% — verify temperature assumptions."
        )

    return PressTestFitResponse(
        rows=row_results,
        row_diagnostics=row_diagnostics,
        cv_line_lox_fitted=round(cv_lox, 6) if cv_lox is not None else None,
        cv_line_lox_std=round(cv_lox_std, 6) if cv_lox_std is not None else None,
        cv_line_fuel_fitted=round(cv_fuel, 6) if cv_fuel is not None else None,
        cv_line_fuel_std=round(cv_fuel_std, 6) if cv_fuel_std is not None else None,
        cv_reg=float(request.reg_cv),
        cv_eff_lox=round(cv_eff_lox, 6) if cv_eff_lox is not None else None,
        cv_eff_fuel=round(cv_eff_fuel, 6) if cv_eff_fuel is not None else None,
        recommendation=recommendation,
        save_available=bool(save_avail),
    )


class SaveCvLineRequest(BaseModel):
    cv_line_lox: Optional[float] = Field(default=None, gt=0)
    cv_line_fuel: Optional[float] = Field(default=None, gt=0)


@router.post("/press_test_save_cv_line")
async def save_cv_line(request: SaveCvLineRequest):
    """Persist fitted Cv_line values (LOX / fuel) to the active config's press_system section.

    Updates both the in-memory config and the backing YAML file on disk so the values
    survive backend restarts and a 'Reload from Config (disk)'.
    """
    import yaml
    from backend.routers.config import config_to_dict

    if not (hasattr(app_state, "config") and app_state.config is not None):
        raise HTTPException(status_code=400, detail="No config loaded.")
    if getattr(app_state.config, "press_system", None) is None:
        raise HTTPException(
            status_code=400,
            detail="Config has no press_system section. Add press_system to your YAML first.",
        )
    if request.cv_line_lox is None and request.cv_line_fuel is None:
        raise HTTPException(status_code=400, detail="Provide at least one of cv_line_lox or cv_line_fuel.")

    saved: Dict[str, float] = {}
    if request.cv_line_lox is not None:
        app_state.config.press_system.line_cv_lox = float(request.cv_line_lox)
        saved["cv_line_lox"] = float(request.cv_line_lox)
    if request.cv_line_fuel is not None:
        app_state.config.press_system.line_cv_fuel = float(request.cv_line_fuel)
        saved["cv_line_fuel"] = float(request.cv_line_fuel)

    # Persist to the backing YAML file if one is known.
    persisted_path: Optional[str] = None
    if app_state.config_path:
        try:
            with open(app_state.config_path, "w", encoding="utf-8") as f:
                yaml.dump(
                    config_to_dict(app_state.config),
                    f,
                    default_flow_style=False,
                    sort_keys=False,
                )
            persisted_path = app_state.config_path
        except OSError as exc:
            raise HTTPException(
                status_code=500,
                detail=f"Updated in-memory config but failed to write YAML to {app_state.config_path}: {exc}",
            )

    return {
        "status": "saved",
        "persisted_to_disk": persisted_path is not None,
        "config_path": persisted_path,
        **saved,
    }
