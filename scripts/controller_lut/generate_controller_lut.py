from __future__ import annotations

import argparse
import json
import os
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List, Tuple

import numpy as np

from .config import ControllerLUTConfig

# Worker globals (set by initializer, used by _compute_*_point)
_worker_controller = None
_worker_engine_wrapper = None
_worker_axis_names = None
_worker_grids = None
_worker_axis_sizes = None
_worker_output_names = None
_worker_Measurement = None
_worker_NavState = None
_worker_Command = None
_worker_CommandType = None


def _add_engine_sim_to_path(project_root: Path) -> None:
    """
    Ensure the engine_sim submodule is importable as a Python package.

    We do not modify any files inside engine_sim; we only import and use its
    public APIs.
    """
    engine_sim_root = project_root / "engine_sim"
    if str(engine_sim_root) not in sys.path:
        sys.path.insert(0, str(engine_sim_root))


def _load_engine_only(engine_config_path: Path):
    """
    Import engine_sim components and load the engine configuration
    for pure engine-performance LUTs (no DDP).

    Returns
    -------
    (engine_config, EngineWrapper)
    """
    from engine.pipeline.io import load_config as load_engine_config
    from engine.control.robust_ddp.engine_wrapper import EngineWrapper

    engine_cfg = load_engine_config(str(engine_config_path))
    wrapper = EngineWrapper(engine_cfg)
    return engine_cfg, wrapper


def _load_engine_and_controller(
    engine_config_path: Path,
    controller_config_path: Path | None,
    engine_lut_path: Path | None = None,
    project_root: Path | None = None,
):
    """
    Load engine + controller configs and construct a RobustDDPController.
    When engine_lut_path is set, controller uses EngineLUTWrapper for fast lookups.
    """
    from engine.pipeline.io import load_config as load_engine_config
    from engine.control.robust_ddp import (
        RobustDDPController,
        Measurement,
        NavState,
        Command,
        CommandType,
    )
    from engine.control.robust_ddp.config_loader import (
        load_config as load_controller_config,
        get_default_config,
    )

    engine_cfg = load_engine_config(str(engine_config_path))
    if controller_config_path is not None:
        controller_cfg = load_controller_config(str(controller_config_path))
    else:
        controller_cfg = get_default_config()

    if engine_lut_path is not None:
        resolved = (
            engine_lut_path
            if engine_lut_path.is_absolute()
            else (project_root or Path.cwd()) / engine_lut_path
        )
        if resolved.exists():
            controller_cfg.engine_lut_path = str(resolved)
        else:
            import warnings

            warnings.warn(f"Engine LUT not found: {resolved} — using physics")

    controller = RobustDDPController(controller_cfg, engine_cfg, logger=None)
    return engine_cfg, controller, Measurement, NavState, Command, CommandType


def _build_axes(config: ControllerLUTConfig) -> Tuple[List[str], List[np.ndarray]]:
    axis_names: List[str] = []
    grids: List[np.ndarray] = []
    for axis in config.axes:
        values = np.asarray(axis.values, dtype=float)
        if values.ndim != 1:
            raise ValueError(f"Axis '{axis.name}' values must be 1D")
        if values.size < 2:
            raise ValueError(
                f"Axis '{axis.name}' must have at least 2 points for interpolation"
            )
        axis_names.append(axis.name)
        grids.append(values)
    return axis_names, grids


def _find_required_pressure_axes(axis_names: List[str]) -> Tuple[int, int]:
    """
    Locate indices of P_u_fuel and P_u_ox axes.

    These are required because EngineWrapper.estimate_from_pressures expects
    tank/ullage pressures for fuel and oxidizer.
    """
    try:
        idx_fuel = axis_names.index("P_u_fuel")
        idx_ox = axis_names.index("P_u_ox")
    except ValueError as exc:
        raise ValueError(
            "LUT config must define axes named 'P_u_fuel' and 'P_u_ox' "
            "to drive EngineWrapper.estimate_from_pressures."
        ) from exc
    return idx_fuel, idx_ox


def _get_axis_value(
    axis_names: List[str], coords: List[float], name: str, default: float
) -> float:
    """Helper to read a coordinate for a named axis with a default."""
    if name in axis_names:
        idx = axis_names.index(name)
        return float(coords[idx])
    return float(default)


def _map_engine_output(est: Any, out_name: str) -> float:
    """Map EngineEstimate to a single output value."""
    value: float = np.nan
    if out_name == "F":
        value = float(est.F)
    elif out_name == "MR":
        value = float(est.MR)
    elif out_name == "P_ch":
        value = float(est.P_ch)
    elif out_name == "mdot_F":
        value = float(est.mdot_F)
    elif out_name == "mdot_O":
        value = float(est.mdot_O)
    elif out_name == "injector_dp_F":
        value = float(est.injector_dp_F)
    elif out_name == "injector_dp_O":
        value = float(est.injector_dp_O)
    elif out_name == "stability_score":
        if est.stability_metrics is not None:
            value = float(est.stability_metrics.get("stability_score", np.nan))
    elif out_name == "injector_stiffness_ok":
        if est.stability_metrics is not None:
            ok = est.stability_metrics.get("injector_stiffness_ok")
            value = 1.0 if ok is True else (0.0 if ok is False else np.nan)
    elif est.diagnostics is not None and out_name in est.diagnostics:
        try:
            value = float(est.diagnostics[out_name])
        except Exception:
            value = np.nan
    return value


G0 = 9.80665  # m/s^2


def _duty_from_thrust_and_mr(
    u_safe: np.ndarray,
    axis_names: List[str],
    coords: List[float],
    eng_est: Any,
    get_axis: Any,
) -> Tuple[float, float]:
    """
    Compute duty_F and duty_O from (F_ref, MR_ref, F_engine) for MR-aware control.
    Uses mass-flow scaling: duty_i = throttle * min(1, mdot_i_des / mdot_i_engine).
    - F_ref=0: duty_F=duty_O=0
    - F_ref < F_engine*0.80: throttle=0 (or 0.06 baseline if F_ref>500)
    - F_ref in [F_engine*0.80, F_engine]: throttle 0.10..0.30 (maintenance)
    - F_ref > F_engine: throttle 0.30 + 0.65*(deficit/7000), cap 0.95
    """
    u_F = float(u_safe[0]) if len(u_safe) > 0 else 0.0
    u_O = float(u_safe[1]) if len(u_safe) > 1 else 0.0
    F_ref = get_axis(axis_names, coords, "thrust_desired", 0.0)
    MR_ref = get_axis(axis_names, coords, "MR_ref", 2.2)
    if F_ref <= 0:
        return 0.0, 0.0
    if eng_est is None or not np.isfinite(eng_est.F) or eng_est.F <= 0:
        return u_F, u_O
    F_eng = float(eng_est.F)
    mdot_F = float(eng_est.mdot_F) if np.isfinite(eng_est.mdot_F) and eng_est.mdot_F > 0 else 1e-9
    mdot_O = float(eng_est.mdot_O) if np.isfinite(eng_est.mdot_O) and eng_est.mdot_O > 0 else 1e-9
    mdot_total = mdot_F + mdot_O
    Isp = F_eng / (mdot_total * G0) if mdot_total > 0 else 280.0

    # Throttle level from thrust demand
    if F_ref < F_eng * 0.80:
        throttle = 0.06 if F_ref > 500 else 0.0
    elif F_ref <= F_eng:
        t = (F_ref - F_eng * 0.80) / (F_eng * 0.20)
        throttle = max(0.10, min(0.30, 0.10 + 0.20 * t))
    else:
        deficit = F_ref - F_eng
        throttle = 0.30 + 0.65 * (deficit / 7000.0)
        throttle = max(0.30, min(0.95, throttle))

    # Desired mass flows for (F_ref, MR_ref)
    mdot_total_des = F_ref / (Isp * G0)
    mdot_F_des = mdot_total_des / (1.0 + MR_ref)
    mdot_O_des = MR_ref * mdot_F_des

    duty_F_raw = mdot_F_des / mdot_F
    duty_O_raw = mdot_O_des / mdot_O
    duty_F = throttle * min(1.0, duty_F_raw)
    duty_O = throttle * min(1.0, duty_O_raw)
    duty_F = max(0.0, min(0.95, duty_F))
    duty_O = max(0.0, min(0.95, duty_O))

    return max(u_F, duty_F), max(u_O, duty_O)


def _duty_from_thrust(
    u_safe: np.ndarray,
    axis_names: List[str],
    coords: List[float],
    eng_est: Any,
    idx: int,
    get_axis: Any,
) -> float:
    """Legacy: return duty_F or duty_O from MR-aware computation."""
    duty_F, duty_O = _duty_from_thrust_and_mr(u_safe, axis_names, coords, eng_est, get_axis)
    return duty_F if idx == 0 else duty_O


def _init_engine_worker(
    engine_config_path: str,
    project_root: str,
    axis_names: List[str],
    grids: List[np.ndarray],
    axis_sizes: Tuple[int, ...],
    output_names: List[str],
) -> None:
    """Initialize worker for engine-only LUT generation."""
    global _worker_engine_wrapper, _worker_axis_names, _worker_grids
    global _worker_axis_sizes, _worker_output_names
    os.chdir(project_root)
    _add_engine_sim_to_path(Path(project_root))
    _, _worker_engine_wrapper = _load_engine_only(Path(engine_config_path))
    _worker_axis_names = axis_names
    _worker_grids = grids
    _worker_axis_sizes = axis_sizes
    _worker_output_names = output_names


def _compute_engine_point_sequential(
    flat_idx: int,
    axis_names: List[str],
    grids: List[np.ndarray],
    axis_sizes: Tuple[int, ...],
    output_names: List[str],
    engine_wrapper: Any,
) -> Tuple[Tuple[int, ...], Dict[str, float]]:
    """Compute a single engine-only grid point (main process, no worker)."""
    multi_idx = np.unravel_index(flat_idx, axis_sizes)
    coords = [grids[i][multi_idx[i]] for i in range(len(axis_names))]
    idx_fuel = axis_names.index("P_u_fuel")
    idx_ox = axis_names.index("P_u_ox")
    P_u_fuel = float(coords[idx_fuel])
    P_u_ox = float(coords[idx_ox])
    est = engine_wrapper.estimate_from_pressures(P_u_fuel, P_u_ox)
    result = {out_name: _map_engine_output(est, out_name) for out_name in output_names}
    return (multi_idx, result)


def _compute_engine_point(flat_idx: int) -> Tuple[Tuple[int, ...], Dict[str, float]]:
    """Compute a single engine-only grid point. Uses worker globals."""
    multi_idx = np.unravel_index(flat_idx, _worker_axis_sizes)
    coords = [_worker_grids[i][multi_idx[i]] for i in range(len(_worker_axis_names))]
    idx_fuel = _worker_axis_names.index("P_u_fuel")
    idx_ox = _worker_axis_names.index("P_u_ox")
    P_u_fuel = float(coords[idx_fuel])
    P_u_ox = float(coords[idx_ox])
    est = _worker_engine_wrapper.estimate_from_pressures(P_u_fuel, P_u_ox)
    result = {
        out_name: _map_engine_output(est, out_name)
        for out_name in _worker_output_names
    }
    return (multi_idx, result)


def _init_ddp_worker(
    engine_config_path: str,
    controller_config_path: str,
    engine_lut_path: str,
    project_root: str,
    axis_names: List[str],
    grids: List[np.ndarray],
    axis_sizes: Tuple[int, ...],
    output_names: List[str],
) -> None:
    """Initialize worker for DDP LUT generation."""
    global _worker_controller, _worker_engine_wrapper, _worker_axis_names
    global _worker_grids, _worker_axis_sizes, _worker_output_names
    global _worker_Measurement, _worker_NavState, _worker_Command, _worker_CommandType
    os.chdir(project_root)
    _add_engine_sim_to_path(Path(project_root))
    engine_lut = Path(engine_lut_path) if engine_lut_path else None
    _, _worker_controller, _worker_Measurement, _worker_NavState, _worker_Command, _worker_CommandType = _load_engine_and_controller(
        Path(engine_config_path),
        Path(controller_config_path),
        engine_lut_path=engine_lut,
        project_root=Path(project_root),
    )
    _worker_engine_wrapper = _worker_controller.engine_wrapper
    _worker_axis_names = axis_names
    _worker_grids = grids
    _worker_axis_sizes = axis_sizes
    _worker_output_names = output_names


def _compute_ddp_point_sequential(
    flat_idx: int,
    axis_names: List[str],
    grids: List[np.ndarray],
    axis_sizes: Tuple[int, ...],
    output_names: List[str],
    controller: Any,
    engine_wrapper: Any,
    Measurement: Any,
    NavState: Any,
    Command: Any,
    CommandType: Any,
) -> Tuple[Tuple[int, ...], Dict[str, float]]:
    """Compute a single DDP grid point (main process, no worker)."""
    multi_idx = np.unravel_index(flat_idx, axis_sizes)
    coords = [grids[i][multi_idx[i]] for i in range(len(axis_names))]

    P_copv = _get_axis_value(axis_names, coords, "P_copv", 18.96e6)
    P_reg = _get_axis_value(axis_names, coords, "P_reg", 6.89e6)
    P_u_fuel = _get_axis_value(axis_names, coords, "P_u_fuel", 6.89e6)
    P_u_ox = _get_axis_value(axis_names, coords, "P_u_ox", 6.89e6)
    P_d_fuel = _get_axis_value(axis_names, coords, "P_d_fuel", P_u_fuel)
    P_d_ox = _get_axis_value(axis_names, coords, "P_d_ox", P_u_ox)
    meas = Measurement(
        P_copv=P_copv, P_reg=P_reg, P_u_fuel=P_u_fuel, P_u_ox=P_u_ox,
        P_d_fuel=P_d_fuel, P_d_ox=P_d_ox, timestamp=0.0,
    )
    h = _get_axis_value(axis_names, coords, "h", 0.0)
    vz = _get_axis_value(axis_names, coords, "vz", 0.0)
    theta = _get_axis_value(axis_names, coords, "theta", 0.0)
    mass_estimate = _get_axis_value(axis_names, coords, "mass_estimate", 100.0)
    nav = NavState(h=h, vz=vz, theta=theta, mass_estimate=mass_estimate)
    if "thrust_desired" in axis_names:
        thrust_val = _get_axis_value(axis_names, coords, "thrust_desired", 0.0)
        cmd = Command(command_type=CommandType.THRUST_DESIRED, thrust_desired=float(thrust_val))
    elif "altitude_goal" in axis_names:
        alt_goal = _get_axis_value(axis_names, coords, "altitude_goal", 0.0)
        cmd = Command(command_type=CommandType.ALTITUDE_GOAL, altitude_goal=float(alt_goal))
    else:
        cmd = Command(command_type=CommandType.THRUST_DESIRED, thrust_desired=0.0)

    controller.reset()
    actuation_cmd, diagnostics = controller.step(meas, nav, cmd)
    eng_est = diagnostics.get("eng_est")
    if eng_est is None and engine_wrapper is not None:
        try:
            eng_est = engine_wrapper.estimate_from_pressures(P_u_fuel, P_u_ox)
        except Exception:
            eng_est = None
    u_relaxed = diagnostics.get("u_relaxed", np.array([0.0, 0.0]))
    u_safe = diagnostics.get("u_safe", np.array([0.0, 0.0]))
    solution = diagnostics.get("solution", None)

    result = {}
    for out_name in output_names:
        value: float = np.nan
        if out_name in ("F", "F_hat"):
            if diagnostics.get("F_hat") is not None:
                value = float(diagnostics["F_hat"])
            elif eng_est is not None:
                value = float(eng_est.F)
        elif out_name in ("MR", "MR_hat"):
            if diagnostics.get("MR_hat") is not None:
                value = float(diagnostics["MR_hat"])
            elif eng_est is not None:
                value = float(eng_est.MR)
        elif out_name in ("P_ch", "Pc"):
            if diagnostics.get("P_ch") is not None:
                value = float(diagnostics["P_ch"])
            elif eng_est is not None:
                value = float(eng_est.P_ch)
        elif out_name == "mdot_F":
            value = float(eng_est.mdot_F) if eng_est is not None else np.nan
        elif out_name == "mdot_O":
            value = float(eng_est.mdot_O) if eng_est is not None else np.nan
        elif out_name == "stability_score":
            if eng_est is not None and eng_est.stability_metrics is not None:
                value = float(eng_est.stability_metrics.get("stability_score", np.nan))
        elif out_name == "injector_stiffness_ok":
            if eng_est is not None and eng_est.stability_metrics is not None:
                ok = eng_est.stability_metrics.get("injector_stiffness_ok")
                value = 1.0 if ok is True else (0.0 if ok is False else np.nan)
        elif out_name == "duty_F":
            value = _duty_from_thrust(u_safe, axis_names, coords, eng_est, 0, _get_axis_value)
        elif out_name == "duty_O":
            value = _duty_from_thrust(u_safe, axis_names, coords, eng_est, 1, _get_axis_value)
        elif out_name == "u_F_onoff":
            value = 1.0 if bool(getattr(actuation_cmd, "u_F_onoff", False)) else 0.0
        elif out_name == "u_O_onoff":
            value = 1.0 if bool(getattr(actuation_cmd, "u_O_onoff", False)) else 0.0
        elif out_name == "u_relaxed_F":
            value = float(u_relaxed[0]) if len(u_relaxed) > 0 else 0.0
        elif out_name == "u_relaxed_O":
            value = float(u_relaxed[1]) if len(u_relaxed) > 1 else 0.0
        elif out_name == "u_safe_F":
            value = _duty_from_thrust(u_safe, axis_names, coords, eng_est, 0, _get_axis_value)
        elif out_name == "u_safe_O":
            value = _duty_from_thrust(u_safe, axis_names, coords, eng_est, 1, _get_axis_value)
        elif out_name in ("value_function", "cost"):
            if solution is not None and hasattr(solution, "objective"):
                try:
                    value = float(solution.objective)
                except Exception:
                    value = np.nan
            else:
                value = float(diagnostics.get("last_cost", 0.0)) if "last_cost" in diagnostics else np.nan
        else:
            if out_name in diagnostics:
                try:
                    val = diagnostics[out_name]
                    if isinstance(val, (int, float, np.floating)):
                        value = float(val)
                except Exception:
                    value = np.nan
            elif eng_est is not None and eng_est.diagnostics is not None and out_name in eng_est.diagnostics:
                try:
                    value = float(eng_est.diagnostics[out_name])
                except Exception:
                    value = np.nan
        result[out_name] = value
    return (multi_idx, result)


def _compute_ddp_point(flat_idx: int) -> Tuple[Tuple[int, ...], Dict[str, float]]:
    """Compute a single DDP grid point. Uses worker globals."""
    multi_idx = np.unravel_index(flat_idx, _worker_axis_sizes)
    coords = [_worker_grids[i][multi_idx[i]] for i in range(len(_worker_axis_names))]
    axis_names = _worker_axis_names

    P_copv = _get_axis_value(axis_names, coords, "P_copv", 18.96e6)
    P_reg = _get_axis_value(axis_names, coords, "P_reg", 6.89e6)
    P_u_fuel = _get_axis_value(axis_names, coords, "P_u_fuel", 6.89e6)
    P_u_ox = _get_axis_value(axis_names, coords, "P_u_ox", 6.89e6)
    P_d_fuel = _get_axis_value(axis_names, coords, "P_d_fuel", P_u_fuel)
    P_d_ox = _get_axis_value(axis_names, coords, "P_d_ox", P_u_ox)

    meas = _worker_Measurement(
        P_copv=P_copv,
        P_reg=P_reg,
        P_u_fuel=P_u_fuel,
        P_u_ox=P_u_ox,
        P_d_fuel=P_d_fuel,
        P_d_ox=P_d_ox,
        timestamp=0.0,
    )

    h = _get_axis_value(axis_names, coords, "h", 0.0)
    vz = _get_axis_value(axis_names, coords, "vz", 0.0)
    theta = _get_axis_value(axis_names, coords, "theta", 0.0)
    mass_estimate = _get_axis_value(axis_names, coords, "mass_estimate", 100.0)
    nav = _worker_NavState(
        h=h, vz=vz, theta=theta, mass_estimate=mass_estimate
    )

    if "thrust_desired" in axis_names:
        thrust_val = _get_axis_value(axis_names, coords, "thrust_desired", 0.0)
        cmd = _worker_Command(
            command_type=_worker_CommandType.THRUST_DESIRED,
            thrust_desired=float(thrust_val),
        )
    elif "altitude_goal" in axis_names:
        alt_goal = _get_axis_value(axis_names, coords, "altitude_goal", 0.0)
        cmd = _worker_Command(
            command_type=_worker_CommandType.ALTITUDE_GOAL,
            altitude_goal=float(alt_goal),
        )
    else:
        cmd = _worker_Command(
            command_type=_worker_CommandType.THRUST_DESIRED,
            thrust_desired=0.0,
        )

    _worker_controller.reset()
    actuation_cmd, diagnostics = _worker_controller.step(meas, nav, cmd)

    eng_est = diagnostics.get("eng_est")
    if eng_est is None and _worker_engine_wrapper is not None:
        try:
            eng_est = _worker_engine_wrapper.estimate_from_pressures(P_u_fuel, P_u_ox)
        except Exception:
            eng_est = None

    u_relaxed = diagnostics.get("u_relaxed", np.array([0.0, 0.0]))
    u_safe = diagnostics.get("u_safe", np.array([0.0, 0.0]))
    solution = diagnostics.get("solution", None)

    result = {}
    for out_name in _worker_output_names:
        value: float = np.nan
        if out_name in ("F", "F_hat"):
            if diagnostics.get("F_hat") is not None:
                value = float(diagnostics["F_hat"])
            elif eng_est is not None:
                value = float(eng_est.F)
        elif out_name in ("MR", "MR_hat"):
            if diagnostics.get("MR_hat") is not None:
                value = float(diagnostics["MR_hat"])
            elif eng_est is not None:
                value = float(eng_est.MR)
        elif out_name in ("P_ch", "Pc"):
            if diagnostics.get("P_ch") is not None:
                value = float(diagnostics["P_ch"])
            elif eng_est is not None:
                value = float(eng_est.P_ch)
        elif out_name == "mdot_F":
            value = float(eng_est.mdot_F) if eng_est is not None else np.nan
        elif out_name == "mdot_O":
            value = float(eng_est.mdot_O) if eng_est is not None else np.nan
        elif out_name == "stability_score":
            if eng_est is not None and eng_est.stability_metrics is not None:
                value = float(eng_est.stability_metrics.get("stability_score", np.nan))
        elif out_name == "injector_stiffness_ok":
            if eng_est is not None and eng_est.stability_metrics is not None:
                ok = eng_est.stability_metrics.get("injector_stiffness_ok")
                value = 1.0 if ok is True else (0.0 if ok is False else np.nan)
        elif out_name == "duty_F":
            value = _duty_from_thrust(u_safe, axis_names, coords, eng_est, 0, _get_axis_value)
        elif out_name == "duty_O":
            value = _duty_from_thrust(u_safe, axis_names, coords, eng_est, 1, _get_axis_value)
        elif out_name == "u_F_onoff":
            value = 1.0 if bool(getattr(actuation_cmd, "u_F_onoff", False)) else 0.0
        elif out_name == "u_O_onoff":
            value = 1.0 if bool(getattr(actuation_cmd, "u_O_onoff", False)) else 0.0
        elif out_name == "u_relaxed_F":
            value = float(u_relaxed[0]) if len(u_relaxed) > 0 else 0.0
        elif out_name == "u_relaxed_O":
            value = float(u_relaxed[1]) if len(u_relaxed) > 1 else 0.0
        elif out_name == "u_safe_F":
            value = _duty_from_thrust(u_safe, axis_names, coords, eng_est, 0, _get_axis_value)
        elif out_name == "u_safe_O":
            value = _duty_from_thrust(u_safe, axis_names, coords, eng_est, 1, _get_axis_value)
        elif out_name in ("value_function", "cost"):
            if solution is not None and hasattr(solution, "objective"):
                try:
                    value = float(solution.objective)
                except Exception:
                    value = np.nan
            else:
                value = float(diagnostics.get("last_cost", 0.0)) if "last_cost" in diagnostics else np.nan
        else:
            if out_name in diagnostics:
                try:
                    val = diagnostics[out_name]
                    if isinstance(val, (int, float, np.floating)):
                        value = float(val)
                except Exception:
                    value = np.nan
            elif eng_est is not None and eng_est.diagnostics is not None and out_name in eng_est.diagnostics:
                try:
                    value = float(eng_est.diagnostics[out_name])
                except Exception:
                    value = np.nan
        result[out_name] = value
    return (multi_idx, result)


def generate_lut(
    lut_config_path: Path,
    output_path: Path,
    project_root: Path,
    jobs: int = 1,
) -> None:
    """
    Generate a high-dimensional LUT.

    Modes:
    - Engine-only mode (no controller_config_path): map tank pressures to
      engine performance (F, MR, Pc, mdots, stability, etc.) using EngineWrapper.
    - DDP mode (controller_config_path set): run RobustDDPController for each
      grid point and record both engine predictions and optimal control
      quantities (duty cycles, relaxed controls, etc.).
    """
    lut_cfg = ControllerLUTConfig.from_yaml(lut_config_path)

    _add_engine_sim_to_path(project_root)

    use_ddp = lut_cfg.controller_config_path is not None
    engine_config_path = project_root / lut_cfg.engine_config_path
    controller_config_path = (
        project_root / lut_cfg.controller_config_path
        if lut_cfg.controller_config_path is not None
        else None
    )

    axis_names, grids = _build_axes(lut_cfg)
    axis_sizes = [len(g) for g in grids]
    total_points = int(np.prod(axis_sizes))

    print(f"[LUT] Axes: {axis_names}")
    print(f"[LUT] Axis sizes: {axis_sizes} (total points = {total_points:,})")
    print(f"[LUT] Engine config: {lut_cfg.engine_config_path}")
    print(f"[LUT] Controller config: {lut_cfg.controller_config_path or '<default>'}")
    print(f"[LUT] Outputs: {lut_cfg.outputs}")
    if jobs > 1:
        print(f"[LUT] Parallel: {jobs} workers")

    # Allocate arrays for each requested output
    data_arrays: Dict[str, np.ndarray] = {}
    for out_name in lut_cfg.outputs:
        data_arrays[out_name] = np.full(axis_sizes, np.nan, dtype=float)

    if not use_ddp:
        # ------------------------------------------------------------------
        # Engine-only LUT: map tank pressures -> engine performance
        # ------------------------------------------------------------------
        _find_required_pressure_axes(axis_names)  # validate axes
        if jobs <= 1:
            engine_cfg, engine_wrapper = _load_engine_only(engine_config_path)
            for flat_idx in range(total_points):
                multi_idx, result = _compute_engine_point_sequential(
                    flat_idx, axis_names, grids, axis_sizes, lut_cfg.outputs, engine_wrapper
                )
                for out_name, val in result.items():
                    data_arrays[out_name][multi_idx] = val
                if (flat_idx + 1) % max(1, total_points // 50) == 0 or flat_idx == total_points - 1:
                    pct = 100.0 * (flat_idx + 1) / total_points
                    print(f"[LUT] {flat_idx+1:,}/{total_points:,} points ({pct:5.1f}%)")
        else:
            init_args = (
                str(engine_config_path),
                str(project_root),
                axis_names,
                grids,
                tuple(axis_sizes),
                list(lut_cfg.outputs),
            )
            done = 0
            with ProcessPoolExecutor(max_workers=jobs, initializer=_init_engine_worker, initargs=init_args) as ex:
                futures = {ex.submit(_compute_engine_point, i): i for i in range(total_points)}
                for fut in as_completed(futures):
                    multi_idx, result = fut.result()
                    for out_name, val in result.items():
                        data_arrays[out_name][multi_idx] = val
                    done += 1
                    if done % max(1, total_points // 50) == 0 or done == total_points:
                        print(f"[LUT] {done:,}/{total_points:,} points ({100.0*done/total_points:5.1f}%)")
    else:
        # ------------------------------------------------------------------
        # DDP-based LUT: map full state/command -> optimal control + engine
        # ------------------------------------------------------------------
        engine_lut_path = Path(lut_cfg.engine_lut_path) if lut_cfg.engine_lut_path else None
        if jobs <= 1:
            (
                engine_cfg,
                controller,
                Measurement,
                NavState,
                Command,
                CommandType,
            ) = _load_engine_and_controller(
                engine_config_path,
                controller_config_path,
                engine_lut_path=engine_lut_path,
                project_root=project_root,
            )
            engine_wrapper = controller.engine_wrapper
            for flat_idx in range(total_points):
                multi_idx, result = _compute_ddp_point_sequential(
                    flat_idx, axis_names, grids, axis_sizes, lut_cfg.outputs,
                    controller, engine_wrapper, Measurement, NavState, Command, CommandType,
                )
                for out_name, val in result.items():
                    data_arrays[out_name][multi_idx] = val
                if (flat_idx + 1) % max(1, total_points // 50) == 0 or flat_idx == total_points - 1:
                    pct = 100.0 * (flat_idx + 1) / total_points
                    print(f"[LUT/DDP] {flat_idx+1:,}/{total_points:,} points ({pct:5.1f}%)")
        else:
            init_args = (
                str(engine_config_path),
                str(controller_config_path),
                str(engine_lut_path) if engine_lut_path else "",
                str(project_root),
                axis_names,
                grids,
                tuple(axis_sizes),
                list(lut_cfg.outputs),
            )
            done = 0
            with ProcessPoolExecutor(max_workers=jobs, initializer=_init_ddp_worker, initargs=init_args) as ex:
                futures = {ex.submit(_compute_ddp_point, i): i for i in range(total_points)}
                for fut in as_completed(futures):
                    multi_idx, result = fut.result()
                    for out_name, val in result.items():
                        data_arrays[out_name][multi_idx] = val
                    done += 1
                    if done % max(1, total_points // 50) == 0 or done == total_points:
                        print(f"[LUT/DDP] {done:,}/{total_points:,} points ({100.0*done/total_points:5.1f}%)")

    # Prepare metadata for saving
    axes_meta: List[Dict[str, Any]] = [
        {
            "name": axis.name,
            "units": axis.units,
            "description": axis.description,
        }
        for axis in lut_cfg.axes
    ]

    meta: Dict[str, Any] = {
        "axes": axes_meta,
        "outputs": list(lut_cfg.outputs),
        "engine_config_path": lut_cfg.engine_config_path,
        "controller_config_path": lut_cfg.controller_config_path,
        "metadata": lut_cfg.metadata,
    }

    npz_kwargs: Dict[str, Any] = {}
    # Axes
    for axis, grid in zip(lut_cfg.axes, grids):
        npz_kwargs[f"axes/{axis.name}"] = grid
    # Data
    for out_name, arr in data_arrays.items():
        npz_kwargs[f"data/{out_name}"] = arr
    # Meta
    npz_kwargs["meta"] = np.array(json.dumps(meta))

    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = output_path.parent / (output_path.stem + ".tmp.npz")
    np.savez_compressed(str(tmp_path), **npz_kwargs)
    tmp_path.replace(output_path)  # atomic on same filesystem
    print(f"[LUT] Saved LUT to {output_path}")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Generate high-dimensional controller LUT using engine_sim."
    )
    parser.add_argument(
        "--lut-config",
        type=Path,
        required=True,
        help="Path to LUT configuration YAML file.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Path to output .npz file for the LUT.",
    )
    parser.add_argument(
        "--project-root",
        type=Path,
        default=Path(__file__).resolve().parents[2],
        help="Path to sensor_system project root (used to locate engine_sim).",
    )
    parser.add_argument(
        "--jobs",
        type=int,
        default=os.cpu_count() or 1,
        help="Number of parallel workers (default: CPU count). Use 1 for sequential.",
    )

    args = parser.parse_args(argv)
    generate_lut(args.lut_config, args.output, args.project_root, jobs=args.jobs)


if __name__ == "__main__":
    main()
