#!/usr/bin/env python3
"""Analyze Elodin DB export: load CSV, process, and generate data-analysis plots.

Loads raw + calibrated sensor data, actuator states (0=OFF, 1=ON hardware), and
system state (PSM/engine_state). Saves combined CSV and generates plots.

Usage:
  python scripts/postprocessing/analyze_run.py [EXPORT_DIR] [--output OUT_DIR]

  Export dir defaults to ./export_csv (from FORMAT=csv export_elodin_db.sh).
  Output dir defaults to ./output/postprocessing/latest.
  Use --config PATH.toml if your roles live outside the default config/config.toml.

  By default, if PSM state is available, t=0 is the *first* transition to
  PRESS_STANDBY (state 20). Use --anchor-last-press-standby only if you want the
  last such transition (often near shutdown — can truncate plots). Pass
  --full-run to anchor at the first sensor timestamp (entire capture).
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from matplotlib.gridspec import GridSpec

# PSM SystemState (CONTROLLER.state.to_state) — matches FSW PressureStateMachine
PSM_STATE_NAMES = {
    0: "DEBUG",
    1: "IDLE",
    2: "ARMED",
    3: "FUEL_FILL",
    4: "OX_FILL",
    5: "GN2_LOW_PRESS",
    6: "GN2_VENT",
    7: "FUEL_PRESS",
    8: "FUEL_VENT",
    9: "OX_PRESS",
    10: "OX_VENT",
    11: "GN2_HIGH_PRESS",
    12: "GN2_HIGH_VENT",
    13: "VENT",
    14: "CALIBRATE",
    15: "READY",
    16: "FIRE",
    17: "ENGINE_ABORT",
    18: "GSE_ABORT",
    19: "EMERGENCY_ABORT",
    20: "PRESS_STANDBY",
}

# BOARD heartbeat engine_state (DiabloBoardPacketParser::EngineState) — different enum
BOARD_ENGINE_STATE_NAMES = {
    0: "SAFE",
    1: "PRESSURIZING",
    2: "LOX_FILL",
    3: "FIRING",
    4: "POST_FIRE",
}

# Legacy alias
STATE_NAMES = PSM_STATE_NAMES

# Uppercase PSM name → enum (for string exports / CSV logs)
_PSM_NAME_TO_INT: dict[str, int] = {
    v.upper().replace(" ", "_"): k for k, v in PSM_STATE_NAMES.items()
}

# CONTROLLER.* CSV short_name (from load_csv_series) → plot legend title
CONTROLLER_DISPLAY_LABELS: dict[str, str] = {
    "actuation_duty_F": "Actuation duty (fuel)",
    "actuation_duty_O": "Actuation duty (oxidizer)",
    "actuation_u_F_on": "Actuation valve command fuel",
    "actuation_u_O_on": "Actuation valve command oxidizer",
    "fire_duty_F": "Fire duty (fuel)",
    "fire_duty_O": "Fire duty (oxidizer)",
    "fire_fire_active": "Fire active",
    "diagnostics_F_ref": "Thrust reference (N)",
    "diagnostics_F_estimated": "Thrust estimated (N)",
    "diagnostics_MR_ref": "Mixture ratio reference",
    "diagnostics_MR_estimated": "Mixture ratio estimated",
    "diagnostics_P_ch": "Chamber pressure (diagnostic)",
    "diagnostics_cost": "Controller cost",
    "diagnostics_safety_filtered": "Safety filtered",
    "diagnostics_cutoff_active": "Cutoff active",
    "diagnostics_solver_iters": "Solver iterations",
    "measurement_P_ch_mp1": "Chamber pressure MP1",
    "measurement_P_ch_mp2": "Chamber pressure MP2",
    "measurement_P_copv": "COPV pressure",
    "measurement_P_reg": "Regulated pressure",
    "state_to_state": "PSM state (raw enum)",
}

# Default styling for publication-ready plots
plt.rcParams.update(
    {
        "font.size": 10,
        "axes.titlesize": 11,
        "axes.labelsize": 10,
        "xtick.labelsize": 9,
        "ytick.labelsize": 9,
        "legend.fontsize": 9,
        "figure.dpi": 150,
        "savefig.dpi": 150,
        "savefig.bbox": "tight",
    }
)


PRESS_STANDBY_STATE = 20


def _parse_toml_file(path: Path) -> dict:
    """Load TOML: stdlib tomllib (3.11+) or PyPI tomli on older Python (same package you already have)."""
    if sys.version_info >= (3, 11):
        import tomllib as _toml
    else:
        try:
            import tomli as _toml
        except ModuleNotFoundError as e:
            raise ModuleNotFoundError(
                "Python <3.11 requires the 'tomli' package (pip install tomli). "
                "Note: the stdlib module is named 'tomllib' (with a 'b'); PyPI only has 'tomli'."
            ) from e

    with open(path, "rb") as f:
        return _toml.load(f)


def _read_config_toml(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        return _parse_toml_file(path)
    except ModuleNotFoundError as e:
        print(f"  ⚠️  Could not read config {path}: {e}")
        return None
    except Exception as e:
        print(f"  ⚠️  Could not read config {path}: {e}")
        return None


def _int_sensor_channel(ch) -> int | None:
    if isinstance(ch, bool):
        return None
    if isinstance(ch, (int, float)):
        return int(ch)
    if isinstance(ch, str):
        try:
            return int(float(ch.strip()))
        except ValueError:
            return None
    return None


def _actuator_board_slot(board_id: int) -> int:
    """Elodin ACT_CMD board index: board_id % 10, 0 → 10 (matches FSW / backend)."""
    b = int(board_id)
    if b < 0:
        b = b % (1 << 32)
    s = b % 10
    return 10 if s == 0 else s


def _sensor_names_from_data(data: dict) -> dict[str, str]:
    """PT/TC/RTD column names (e.g. PT1_Cal.CH4) → role labels from config tables."""
    out: dict[str, str] = {}
    if not data:
        return out

    def _add_pt_board(bi: int, roles: dict) -> None:
        for name, ch_raw in roles.items():
            ch = _int_sensor_channel(ch_raw)
            if ch is None:
                continue
            label = str(name).strip().strip('"').strip("'")
            out[f"PT{bi}_Cal.CH{ch}"] = label
            out[f"PT{bi}.CH{ch}"] = f"{label} (raw)"

    pt_board = data.get("sensor_roles_pt_board", {})
    if isinstance(pt_board, dict):
        _add_pt_board(1, pt_board)
    for key, roles in data.items():
        if not isinstance(roles, dict):
            continue
        m = re.match(r"^sensor_roles_pt(\d+)$", key)
        if m:
            _add_pt_board(int(m.group(1)), roles)

    roles_tc = data.get("sensor_roles_tc_board", {})
    if isinstance(roles_tc, dict):
        for name, ch_raw in roles_tc.items():
            ch = _int_sensor_channel(ch_raw)
            if ch is None:
                continue
            label = str(name).strip().strip('"').strip("'")
            out[f"TC1_Cal.CH{ch}"] = label
            out[f"TC1.CH{ch}"] = f"{label} (raw)"

    roles_rtd = data.get("sensor_roles_rtd_board", {})
    if isinstance(roles_rtd, dict):
        for name, ch_raw in roles_rtd.items():
            ch = _int_sensor_channel(ch_raw)
            if ch is None:
                continue
            label = str(name).strip().strip('"').strip("'")
            out[f"RTD1_Cal.CH{ch}"] = label
            out[f"RTD1.CH{ch}"] = label

    return out


def _load_sensor_names(
    project_root: Path | None = None, config_path: Path | None = None
) -> dict[str, str]:
    """Load PT/TC/RTD channel IDs -> human-readable role names from config.toml."""
    root = project_root or Path(__file__).resolve().parent.parent.parent
    path = config_path or (root / "config" / "config.toml")
    data = _read_config_toml(path)
    return _sensor_names_from_data(data or {})


def _actuator_roles_from_data(data: dict) -> dict[str, str]:
    """actuator role name -> NC/NO from actuator_roles table."""
    out: dict[str, str] = {}
    roles = data.get("actuator_roles", {})
    if not isinstance(roles, dict):
        return out
    for name, arr in roles.items():
        label = str(name).strip().strip('"').strip("'")
        if isinstance(arr, (list, tuple)) and len(arr) >= 1:
            out[label] = str(arr[0]).upper()
    return out


def _load_actuator_roles(
    project_root: Path | None = None, config_path: Path | None = None
) -> dict[str, str]:
    root = project_root or Path(__file__).resolve().parent.parent.parent
    path = config_path or (root / "config" / "config.toml")
    data = _read_config_toml(path)
    return _actuator_roles_from_data(data or {})


def _actuator_cmd_labels_from_data(data: dict) -> dict[str, str]:
    """Map ACT_CMD.B<slot>.CH<n> dataframe columns to actuator role names."""
    out: dict[str, str] = {}
    roles = data.get("actuator_roles", {})
    if not isinstance(roles, dict):
        return out
    for name, arr in roles.items():
        if not isinstance(arr, (list, tuple)) or len(arr) < 3:
            continue
        label = str(name).strip().strip('"').strip("'")
        ch = _int_sensor_channel(arr[1])
        bid = _int_sensor_channel(arr[2])
        if ch is None or bid is None:
            continue
        bn = _actuator_board_slot(bid)
        out[f"ACT_CMD.B{bn}.CH{ch}"] = label
    return out


def _find_t_start_from_state(
    state_series: dict[str, pd.DataFrame],
    target_state: int = PRESS_STANDBY_STATE,
    *,
    last: bool = False,
) -> pd.Timestamp | None:
    """Find timestamp of a transition into target_state (e.g. PRESS_STANDBY).

    Default ``last=False``: **first** transition (start of first contiguous block) —
    better for aligning “press sequence” plots. Set ``last=True`` for the last
    transition (e.g. shutdown) — can leave almost no data after t0.
    """
    pick = -1 if last else 0
    for df in state_series.values():
        if "value" not in df.columns or "time" not in df.columns:
            continue
        mask = df["value"] == target_state
        if not mask.any():
            continue
        prev = mask.shift(1, fill_value=False)
        block_starts = mask & ~prev
        if block_starts.any():
            idx = block_starts[block_starts].index[pick]
            return df.loc[idx, "time"]
        return df.loc[mask, "time"].iloc[pick]
    return None


def _find_t0_from_data(*series_dicts: dict[str, pd.DataFrame]) -> pd.Timestamp:
    """Find earliest timestamp across all non-empty series."""
    earliest = []
    for sd in series_dicts:
        if not sd:
            continue
        for df in sd.values():
            if not df.empty and "time" in df.columns:
                earliest.append(df["time"].min())
    if not earliest:
        return pd.Timestamp.now()
    return min(earliest)


def _filter_series_from_t(
    series: dict[str, pd.DataFrame],
    t_start: pd.Timestamp,
) -> dict[str, pd.DataFrame]:
    """Filter each dataframe to rows with time >= t_start."""
    out = {}
    for name, df in series.items():
        if "time" not in df.columns:
            out[name] = df
            continue
        mask = df["time"] >= t_start
        out[name] = df.loc[mask].copy()
    return out


def _coerce_state_values_to_psm_enum(s: pd.Series) -> pd.Series:
    """Map mixed numeric / string PSM state column to float enum values."""
    num = pd.to_numeric(s, errors="coerce")
    out = num.copy()
    need = num.isna() & s.notna()
    if need.any():
        for idx in s.index[need]:
            raw = str(s.loc[idx]).strip()
            up = raw.upper().replace(" ", "_")
            if "." in up:
                up = up.split(".")[-1]
            if up in _PSM_NAME_TO_INT:
                out.loc[idx] = float(_PSM_NAME_TO_INT[up])
    return out


def _prepare_state_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """Ensure time + numeric PSM enum value; drop invalid rows."""
    if df.empty or "value" not in df.columns:
        return df
    out = df.copy()
    out["value"] = _coerce_state_values_to_psm_enum(out["value"])
    return out[["time", "value"]].dropna(subset=["time", "value"])


def _load_state_fallback(export_dir: Path) -> dict[str, pd.DataFrame]:
    """Load state from data/state_transitions.csv (backend writes during run)."""
    candidates = [
        export_dir.parent / "data" / "state_transitions.csv",
        Path("data") / "state_transitions.csv",
        Path.cwd() / "data" / "state_transitions.csv",
        Path(__file__).resolve().parent.parent.parent
        / "data"
        / "state_transitions.csv",
    ]
    for p in candidates:
        if p.exists():
            try:
                df = pd.read_csv(p)
                if "timestamp_ms" in df.columns and "to_state" in df.columns:
                    df["time"] = pd.to_datetime(
                        df["timestamp_ms"], unit="ms", errors="coerce"
                    )
                    df["value"] = df["to_state"]
                    df = _prepare_state_dataframe(df)
                    if len(df) > 0:
                        return {"engine_state": df}
            except Exception as e:
                print(f"  Skip {p.name}: {e}")
    return {}


def _load_controller_state_from_export(export_dir: Path) -> dict[str, pd.DataFrame]:
    """PSM state from Elodin export CONTROLLER.state.to_state (full DB timeline)."""
    ctrl = load_csv_series(export_dir, "CONTROLLER.state.to_state.csv")
    if export_dir.is_dir():
        nested = load_csv_series(export_dir, "**/CONTROLLER.state.to_state.csv")
        for k, v in nested.items():
            ctrl.setdefault(k, v)
    if not ctrl:
        return {}
    df = next(iter(ctrl.values()))
    if df.empty:
        return {}
    df = _prepare_state_dataframe(df)
    if df.empty:
        return {}
    return {"engine_state": df}


def _infer_time_value_cols(df: pd.DataFrame) -> tuple[str, str] | None:
    """Infer time and value column names. Returns (time_col, value_col) or None."""
    time_cands = [
        c for c in df.columns if any(x in c.lower() for x in ("time", "timestamp", "t"))
    ]
    val_cands = [
        c for c in df.columns if any(x in c.lower() for x in ("value", "val", "data"))
    ]
    if time_cands and val_cands:
        return (time_cands[0], val_cands[0])
    if len(df.columns) >= 2:
        return (df.columns[0], df.columns[1])
    return None


def _infer_actuator_export_cols(df: pd.DataFrame) -> tuple[str, str] | None:
    """Elodin flattened exports often name the value column ACT_CMD.*.actuator_state_commanded."""
    time_cands = [
        c for c in df.columns if any(x in c.lower() for x in ("time", "timestamp", "t"))
    ]
    val_cands = [
        c
        for c in df.columns
        if any(
            x in c.lower()
            for x in (
                "actuator_state",
                "commanded",
                "value",
                "val",
                "data",
            )
        )
    ]
    # Prefer the component column, not a stray "value" from another field
    for c in val_cands:
        if "actuator_state" in c.lower():
            if time_cands:
                return (time_cands[0], c)
    if time_cands and val_cands:
        return (time_cands[0], val_cands[0])
    if len(df.columns) >= 2 and time_cands:
        others = [c for c in df.columns if c not in time_cands]
        if others:
            return (time_cands[0], others[0])
    if len(df.columns) >= 2:
        return (df.columns[0], df.columns[1])
    return None


_ACT_SENSE_SERIES_TO_CMD = re.compile(r"^ACT(\d+)\.CH(\d+)$")


def _act_sense_series_key_to_cmd_key(sense_key: str) -> str | None:
    """Map export short name ACT2.CH3 → ACT_CMD.B2.CH3 (same convention as Elodin decode)."""
    m = _ACT_SENSE_SERIES_TO_CMD.match(sense_key)
    if m:
        return f"ACT_CMD.B{m.group(1)}.CH{m.group(2)}"
    return None


def merge_act_sense_fallback_for_act_cmd(
    cmd_series: dict[str, pd.DataFrame],
    sense_series: dict[str, pd.DataFrame],
) -> dict[str, pd.DataFrame]:
    """Fill ACT_CMD.* keys missing from commanded export using ACT*.CH* current-sense (0x31)."""
    out = dict(cmd_series)
    for sk, sdf in sense_series.items():
        ck = _act_sense_series_key_to_cmd_key(sk)
        if ck and ck not in out:
            out[ck] = sdf
    return out


def reorder_actuator_wide_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Sort actuator columns by board then channel for readable multi-panel plots."""
    cols = [c for c in df.columns if c != "t_s"]

    def sort_key(name: str) -> tuple:
        m = re.search(r"ACT_CMD\.B(\d+)\.CH(\d+)", name)
        if m:
            return (0, int(m.group(1)), int(m.group(2)), name)
        return (1, 0, 0, name)

    ordered = sorted(cols, key=sort_key)
    return df[["t_s"] + ordered]


def _normalize_actuator_value(v: float | str) -> float:
    """Map actuator state to 0 (OFF) or 1 (ON). Handles numeric and string values."""
    if pd.isna(v):
        return np.nan
    if isinstance(v, (int, float)):
        return 1.0 if v != 0 else 0.0
    s = str(v).strip().upper()
    if s in ("1", "ON", "OPEN", "TRUE"):
        return 1.0
    if s in ("0", "OFF", "CLOSED", "FALSE"):
        return 0.0
    try:
        return 1.0 if float(v) != 0 else 0.0
    except (ValueError, TypeError):
        return np.nan


def load_csv_series(export_dir: Path, pattern: str) -> dict[str, pd.DataFrame]:
    """Load CSVs matching pattern. Returns {short_name: df with 'time' and 'value' cols}."""
    files = list(export_dir.glob(pattern))
    result = {}
    for f in files:
        stem = f.stem
        parts = stem.split(".")
        if len(parts) >= 3:
            entity = parts[0]
            short = parts[1]
            metric = parts[-1]
            if entity == "CONTROLLER":
                # e.g. CONTROLLER.actuation.duty_F → "actuation_duty_F"
                short_name = f"{short}_{metric}"
            elif len(parts) == 3:
                # e.g. PT1_Cal.CH1.pressure_psi → "PT1_Cal.CH1"
                short_name = f"{entity}.{short}"
            else:
                # e.g. ACT_CMD.B1.CH1.actuator_state_commanded → "ACT_CMD.B1.CH1"
                short_name = f"{entity}.{parts[1]}.{parts[2]}"
        else:
            short_name = stem
        try:
            df = pd.read_csv(f)
            if "ACT_CMD" in stem or "actuator_state" in stem.lower():
                pair = _infer_actuator_export_cols(df)
            else:
                pair = _infer_time_value_cols(df)
            if pair:
                time_col, val_col = pair
                df["time"] = pd.to_datetime(df[time_col], errors="coerce")
                raw_val = df[val_col]
                if "actuator_state" in str(f) or "actuator" in stem.lower():
                    df["value"] = raw_val.apply(_normalize_actuator_value)
                else:
                    df["value"] = pd.to_numeric(raw_val, errors="coerce")
            else:
                df["time"] = pd.to_datetime(df.iloc[:, 0], errors="coerce")
                raw_val = df.iloc[:, 1]
                if "actuator_state" in str(f) or "actuator" in stem.lower():
                    df["value"] = raw_val.apply(_normalize_actuator_value)
                else:
                    df["value"] = pd.to_numeric(raw_val, errors="coerce")
            df = df[["time", "value"]].dropna(subset=["time", "value"])
            if len(df) > 0:
                result[short_name] = df
        except Exception as e:
            print(f"  Skip {f.name}: {e}")
    return result


def to_seconds_from_start(df: pd.DataFrame, t0: pd.Timestamp | None) -> pd.Series:
    """Convert time column to seconds from t0 (or first timestamp)."""
    if t0 is None:
        t0 = df["time"].min()
    return (df["time"] - t0).dt.total_seconds()


def resample_to_grid(
    series: dict[str, pd.DataFrame],
    t0: pd.Timestamp,
    dt: float = 0.1,
    t_min: float = 0.0,
    t_max: float | None = None,
    max_gap_sec: float | None = None,
) -> tuple[pd.DataFrame, np.ndarray]:
    """Resample multiple series to common time grid. Uses linear interpolation.
    If max_gap_sec is provided, gaps in input t_s exceeding this will be NaNs in output.
    """
    if t_max is None:
        all_t = []
        for df in series.values():
            if len(df) == 0:
                continue
            s = (df["time"] - t0).dt.total_seconds()
            all_t.extend(s.dropna().tolist())
        t_max = max(all_t) if all_t else 60.0
    time_grid = np.arange(t_min, t_max + dt * 0.5, dt)
    out = pd.DataFrame({"t_s": time_grid})
    for name, df in series.items():
        if len(df) == 0:
            continue
        t_s = (df["time"] - t0).dt.total_seconds().values
        v = df["value"].values
        # Sort if needed
        idx = np.argsort(t_s)
        t_s = t_s[idx]
        v = v[idx]

        res = np.interp(time_grid, t_s, v)

        # Mask gaps if requested
        if max_gap_sec is not None and len(t_s) > 1:
            gaps = np.diff(t_s)
            large_gap_indices = np.where(gaps > max_gap_sec)[0]
            for idx in large_gap_indices:
                t_gap_start = t_s[idx]
                t_gap_end = t_s[idx + 1]
                # Any grid points falling strictly within this gap (with a small buffer) become NaN
                mask = (time_grid > t_gap_start + dt * 0.1) & (
                    time_grid < t_gap_end - dt * 0.1
                )
                res[mask] = np.nan
        out[name] = res
    return out, time_grid


def debounce_binary(
    df: pd.DataFrame, window_sec: float = 0.5, dt: float = 0.1
) -> pd.DataFrame:
    """Smooth binary (0/1) columns to remove flicker from ADC noise or interleaved sources.
    Uses rolling median (majority vote) with window_sec. Returns rounded 0/1."""
    if df.empty:
        return df
    n = max(1, int(round(window_sec / dt)))
    out = df.copy()
    for c in out.columns:
        if c == "t_s":
            continue
        vals = out[c].values
        if np.all(np.isnan(vals)) or not np.any(np.isfinite(vals)):
            continue
        # Rolling median = majority vote for binary; round to 0 or 1
        rolled = pd.Series(vals).rolling(window=n, min_periods=1, center=True).median()
        out[c] = np.round(rolled.values).astype(float)
    return out


def resample_to_grid_step(
    series: dict[str, pd.DataFrame],
    t0: pd.Timestamp,
    dt: float = 0.1,
    t_min: float = 0.0,
    t_max: float | None = None,
) -> tuple[pd.DataFrame, np.ndarray]:
    """Resample discrete data (states, actuators) using step-hold forward-fill.

    ACT_CMD rows are sparse (Elodin only logs on change). A single sample must
    plot as a flat line for the whole window — use pandas ffill/bfill on a union
    index, not per-point searchsorted (which leaves gaps when samples are sparse).
    """
    if t_max is None:
        all_t = []
        for df in series.values():
            if len(df) == 0:
                continue
            s = (df["time"] - t0).dt.total_seconds()
            all_t.extend(s.dropna().tolist())
        t_max = max(all_t) if all_t else 60.0
    time_grid = np.arange(t_min, t_max + dt * 0.5, dt)
    out = pd.DataFrame({"t_s": time_grid})
    grid_index = pd.Index(time_grid)
    for name, df in series.items():
        if len(df) == 0:
            continue
        t_rel = (df["time"] - t0).dt.total_seconds().astype(float)
        v = pd.to_numeric(df["value"], errors="coerce").astype(float)
        ser = pd.Series(v.values, index=t_rel.values)
        ser = ser[np.isfinite(ser.index)]
        ser = ser[~ser.index.duplicated(keep="last")]
        ser = ser.sort_index()
        ser = ser.dropna()
        if ser.empty:
            out[name] = np.full(len(time_grid), np.nan)
            continue
        u = ser.index.union(grid_index).sort_values()
        filled = ser.reindex(u).ffill().bfill()
        out[name] = filled.reindex(grid_index).values
    return out, time_grid


def plot_pressures_full_run(
    data: pd.DataFrame,
    t_s: np.ndarray,
    out_path: Path,
) -> None:
    """Every calibrated PT channel on its own subplot — full run, no grouping omissions."""
    cols = [c for c in data.columns if c != "t_s"]
    if not cols:
        return
    n = len(cols)
    ncols = min(4, max(1, n))
    nrows = (n + ncols - 1) // ncols
    fig, axes = plt.subplots(
        nrows, ncols, figsize=(3.6 * ncols, 2.3 * nrows), sharex=True, squeeze=False
    )
    for i, c in enumerate(cols):
        r, cc = i // ncols, i % ncols
        ax = axes[r][cc]
        ax.plot(t_s, data[c].values, color="C0", linewidth=0.9, alpha=0.95)
        ax.set_title(str(c).replace("_", " ")[:44], fontsize=8)
        ax.set_ylabel("PSI", fontsize=8)
        ax.grid(True, alpha=0.3)
    for j in range(n, nrows * ncols):
        r, cc = j // ncols, j % ncols
        axes[r][cc].set_visible(False)
    fig.suptitle(
        "All calibrated pressures (full timeline)", fontsize=12, fontweight="bold"
    )
    if len(t_s):
        axes[0][0].set_xlim(float(t_s[0]), float(t_s[-1]))
    axes[-1][0].set_xlabel("Time (s)")
    plt.tight_layout()
    fig.savefig(out_path)
    plt.close(fig)
    print(f"  Saved {out_path}")


def plot_pressures(
    data: pd.DataFrame,
    t_s: np.ndarray,
    out_path: Path,
) -> None:
    """Pressure overview: LOX, Fuel, GN2, GSE, Chamber."""
    fig, axes = plt.subplots(2, 2, figsize=(12, 8), sharex=True)
    fig.suptitle("Pressure Time Series (PSI)", fontsize=12, fontweight="bold")

    # Group by domain from sensor names
    groups = {
        "LOX / Ox": [
            c
            for c in data.columns
            if c not in ("t_s",) and any(x in c for x in ["Ox", "LOX", "Chamber"])
        ],
        "Fuel": [c for c in data.columns if c not in ("t_s",) and "Fuel" in c],
        "GN2 / GSE": [
            c
            for c in data.columns
            if c not in ("t_s",) and any(x in c for x in ["GN2", "GSE"])
        ],
        "Chamber": [c for c in data.columns if c not in ("t_s",) and "Chamber" in c],
    }
    ax_flat = axes.flat
    for idx, (title, cols) in enumerate(groups.items()):
        if idx >= len(ax_flat):
            break
        ax = ax_flat[idx]
        for c in cols:
            if c in data.columns:
                # Use both lines and markers to make drop-outs very apparent
                ax.plot(
                    t_s,
                    data[c],
                    marker=".",
                    markersize=4,
                    linestyle="-",
                    label=c.replace("_", " "),
                    alpha=0.9,
                )
        ax.set_title(title)
        ax.set_ylabel("PSI")
        _handles, leg_labels = ax.get_legend_handles_labels()
        if leg_labels:
            ax.legend(loc="upper right", fontsize=8)
        ax.grid(True, alpha=0.3)
        ax.set_xlim(left=0)

    axes[1, 0].set_xlabel("Time (s)")
    axes[1, 1].set_xlabel("Time (s)")
    plt.tight_layout()
    fig.savefig(out_path)
    plt.close(fig)
    print(f"  Saved {out_path}")


def plot_temperatures(
    data: pd.DataFrame,
    t_s: np.ndarray,
    out_path: Path,
) -> None:
    """Temperature overview: TC and RTD channels."""
    cols = [c for c in data.columns if c != "t_s"]
    if not cols:
        return
    n = len(cols)
    ncols = min(3, n)
    nrows = (n + ncols - 1) // ncols
    fig, axes = plt.subplots(nrows, ncols, figsize=(4 * ncols, 3 * nrows), sharex=True)
    if n == 1:
        axes = np.array([[axes]])
    elif nrows == 1:
        axes = axes.reshape(1, -1)
    fig.suptitle("Temperature Time Series (°C)", fontsize=12, fontweight="bold")
    for idx, c in enumerate(cols):
        r, c_ax = idx // ncols, idx % ncols
        ax = axes[r, c_ax]
        ax.plot(t_s, data[c], label=c, color="C0", alpha=0.9)
        ax.set_title(c.replace("_", " "))
        ax.set_ylabel("°C")
        ax.grid(True, alpha=0.3)
        ax.set_xlim(left=0)
    for idx in range(len(cols), nrows * ncols):
        r, c_ax = idx // ncols, idx % ncols
        axes[r, c_ax].set_visible(False)
    axes[-1, 0].set_xlabel("Time (s)")
    plt.tight_layout()
    fig.savefig(out_path)
    plt.close(fig)
    print(f"  Saved {out_path}")


def plot_load_cells(
    data: pd.DataFrame,
    t_s: np.ndarray,
    out_path: Path,
) -> None:
    """Load cell force time series."""
    cols = [c for c in data.columns if c != "t_s"]
    if not cols:
        return
    fig, ax = plt.subplots(figsize=(12, 4))
    for c in cols:
        ax.plot(t_s, data[c], label=c, alpha=0.9)
    ax.set_title("Load Cell Force (kg)")
    ax.set_ylabel("Force (kg)")
    ax.set_xlabel("Time (s)")
    ax.legend(loc="upper right", fontsize=8)
    ax.grid(True, alpha=0.3)
    ax.set_xlim(left=0)
    plt.tight_layout()
    fig.savefig(out_path)
    plt.close(fig)
    print(f"  Saved {out_path}")


def _apply_actuator_open_closed(
    data: pd.DataFrame,
    actuator_roles: dict[str, str],
) -> pd.DataFrame:
    """Convert hardware 0/1 to OPEN/CLOSED (0/1) per valve type. NC: 0=CLOSED,1=OPEN. NO: invert."""
    out = data.copy()
    for c in out.columns:
        if c == "t_s":
            continue
        role_name = c.replace("_", " ")
        if actuator_roles.get(role_name, "NC").upper() == "NO":
            out[c] = 1.0 - np.clip(out[c].values, 0, 1)
    return out


def _fill_actuator_channel_axis(
    ax,
    t_s: np.ndarray,
    y: np.ndarray,
    label: str,
    *,
    color: str | None = None,
    y_label_fontsize: float = 9,
) -> None:
    """Draw one actuator strip: step-held line at CLOSED (0) or OPEN (1), no area fill."""
    kw: dict = {"where": "post", "linewidth": 1.25}
    if color is not None:
        kw["color"] = color
    ax.step(t_s, y, **kw)
    ax.set_ylabel(label.replace("_", " "), fontsize=y_label_fontsize)
    ax.set_ylim(-0.2, 1.2)
    ax.set_yticks([0, 1])
    ax.set_yticklabels(["CLOSED", "OPEN"])
    ax.grid(True, alpha=0.3, axis="x")


def plot_actuators(
    data: pd.DataFrame,
    t_s: np.ndarray,
    out_path: Path,
    actuator_roles: dict[str, str] | None = None,
) -> None:
    """Actuator state timeline. Converts hardware 0/1 to OPEN/CLOSED per valve type (NC/NO)."""
    cols = [c for c in data.columns if c != "t_s"]
    if not cols:
        return
    roles = actuator_roles or {}
    display = _apply_actuator_open_closed(data, roles)
    n = len(cols)
    fig, axes = plt.subplots(n, 1, figsize=(12, max(4, n * 1.2)), sharex=True)
    if n == 1:
        axes = [axes]
    fig.suptitle("Actuator State (OPEN/CLOSED)", fontsize=12, fontweight="bold")
    for i, (ax, c) in enumerate(zip(axes, cols)):
        _fill_actuator_channel_axis(ax, t_s, display[c].values, c, color=f"C{i % 10}")
        ax.set_xlim(left=0)
    axes[-1].set_xlabel("Time (s)")
    plt.tight_layout()
    fig.savefig(out_path)
    plt.close(fig)
    print(f"  Saved {out_path}")


def _rising_edge_times(
    t_s: np.ndarray, v: np.ndarray, *, t_min: float = 0.0
) -> list[float]:
    """Times where logical actuator goes from CLOSED (0) to OPEN (1), step-hold semantics."""
    y = np.clip(np.asarray(v, dtype=float), 0.0, 1.0)
    hi = y >= 0.5
    # Low before first sample → allow edge at index 0 if hi[0]
    pad = np.concatenate([[False], hi[:-1]])
    rise = hi & ~pad
    out = [float(t_s[i]) for i in np.where(rise)[0] if float(t_s[i]) >= t_min]
    return out


def _resolve_dataframe_column(df: pd.DataFrame, *candidates: str) -> str | None:
    """Pick first column that exists or case-insensitive / substring match to candidates."""
    for want in candidates:
        if want in df.columns:
            return want
        wl = want.lower()
        for c in df.columns:
            if c == "t_s":
                continue
            if c.lower() == wl:
                return c
    for want in candidates:
        parts = want.lower().split()
        for c in df.columns:
            if c == "t_s":
                continue
            cl = c.lower()
            if all(p in cl for p in parts):
                return c
    return None


def plot_gn2_ox_valve_snapshots(
    pt_wide: pd.DataFrame,
    act_display: pd.DataFrame,
    t_s: np.ndarray,
    out_dir: Path,
    *,
    pre_s: float = 3.0,
    post_s: float = 7.0,
) -> None:
    """Two 10 s windows (pre_s before, post_s after opening) for GN2 High + Ox PTs + trigger valve."""
    gn2 = _resolve_dataframe_column(pt_wide, "GN2 High")
    ox_u = _resolve_dataframe_column(pt_wide, "Ox Upstream")
    ox_d = _resolve_dataframe_column(pt_wide, "Ox Downstream")
    fuel = _resolve_dataframe_column(act_display, "Fuel Press")
    loxm = _resolve_dataframe_column(act_display, "LOX Main")

    if not gn2 or not ox_u or not ox_d:
        print(
            "  Skip GN2/Ox snapshots: need GN2 High, Ox Upstream, Ox Downstream in PT data"
        )
        return

    specs: list[tuple[str, str | None, str, float]] = []
    t_fp: float | None = None
    if fuel:
        fp_edges = _rising_edge_times(t_s, act_display[fuel].values, t_min=40.0)
        if fp_edges:
            t_fp = fp_edges[0]
            specs.append(
                (
                    "fuel_press_open",
                    fuel,
                    f"GN2 High + Ox (Fuel Press opens, lab t={t_fp:.2f}s)",
                    t_fp,
                )
            )
    t_lm_min = 120.0
    if t_fp is not None:
        t_lm_min = max(t_lm_min, t_fp + 30.0)
    if loxm:
        lm_edges = _rising_edge_times(t_s, act_display[loxm].values, t_min=t_lm_min)
        if lm_edges:
            t_lm = lm_edges[-1]
            specs.append(
                (
                    "lox_main_open",
                    loxm,
                    f"GN2 High + Ox (LOX Main opens, lab t={t_lm:.2f}s)",
                    t_lm,
                )
            )

    if not specs:
        print(
            "  Skip GN2/Ox snapshots: no Fuel Press / LOX Main opening edges matched filters"
        )
        return

    for key, valve_col, title, t_center in specs:
        t0, t1 = t_center - pre_s, t_center + post_s
        m = (t_s >= t0) & (t_s <= t1)
        if not np.any(m):
            continue
        t_rel = t_s[m] - t_center
        fig, (axp, axa) = plt.subplots(
            2,
            1,
            figsize=(10, 5.5),
            sharex=True,
            gridspec_kw={"height_ratios": [2.2, 1.0]},
        )
        axp.plot(
            t_rel,
            pt_wide[gn2].values[m],
            label="GN2 High",
            color="C0",
            linewidth=1.2,
        )
        axp.plot(
            t_rel,
            pt_wide[ox_u].values[m],
            label="Ox Upstream",
            color="C1",
            linewidth=1.0,
            alpha=0.9,
        )
        axp.plot(
            t_rel,
            pt_wide[ox_d].values[m],
            label="Ox Downstream",
            color="C2",
            linewidth=1.0,
            alpha=0.9,
        )
        axp.axvline(0.0, color="k", linestyle="--", linewidth=0.9, alpha=0.55)
        axp.set_ylabel("Pressure (PSI)")
        axp.set_title(title)
        axp.legend(loc="upper right", fontsize=8)
        axp.grid(True, alpha=0.3)
        axp.set_xlim(-pre_s, post_s)

        if valve_col:
            axa.step(
                t_rel,
                act_display[valve_col].values[m],
                where="post",
                color="C3",
                linewidth=1.25,
            )
            axa.set_ylim(-0.15, 1.15)
            axa.set_yticks([0, 1])
            axa.set_yticklabels(["CLOSED", "OPEN"])
            axa.set_ylabel(valve_col.replace("_", " "), fontsize=9)
            axa.grid(True, alpha=0.3, axis="x")
        axa.set_xlabel("Time relative to valve OPEN (s) — 0 = opening edge")
        plt.tight_layout()
        out_path = out_dir / f"snapshot_{key}_gn2_ox.png"
        fig.savefig(out_path)
        plt.close(fig)
        print(f"  Saved {out_path} (window [{t0:.2f}s, {t1:.2f}s] lab time)")


def plot_states(
    data: pd.DataFrame,
    t_s: np.ndarray,
    out_path: Path,
    state_names: dict[int, str] | None = None,
) -> None:
    """System state timeline (PSM or BOARD engine_state)."""
    state_names = state_names or PSM_STATE_NAMES
    cols = [c for c in data.columns if c != "t_s"]
    if not cols:
        return
    fig, ax = plt.subplots(figsize=(12, 4))
    for c in cols:
        ax.step(t_s, data[c].values, where="post", label=c.replace("_", " "), alpha=0.9)
    ax.set_ylabel("State (enum)")
    ax.set_xlabel("Time (s)")
    ax.set_title("System State")
    ax.legend(loc="upper right", fontsize=8)
    ax.grid(True, alpha=0.3)
    ax.set_xlim(left=0)
    y_vals = sorted(
        {
            int(round(float(v)))
            for c in cols
            for v in np.unique(data[c].dropna().values)
            if np.isfinite(v)
        }
    )
    if y_vals:
        ax.set_yticks(y_vals)
        ax.set_yticklabels([state_names.get(v, str(v)) for v in y_vals], fontsize=8)
    plt.tight_layout()
    fig.savefig(out_path)
    plt.close(fig)
    print(f"  Saved {out_path}")


def plot_summary_stats(
    pt_data: dict[str, pd.DataFrame],
    out_path: Path,
    sensor_names: dict[str, str] | None = None,
) -> None:
    """Summary statistics table for pressures."""
    labels = sensor_names or {}
    rows = []
    for name, df in pt_data.items():
        v = df["value"].dropna()
        if len(v) > 0:
            rows.append(
                {
                    "Sensor": labels.get(name, name),
                    "Mean (PSI)": f"{v.mean():.2f}",
                    "Std (PSI)": f"{v.std():.2f}",
                    "Min (PSI)": f"{v.min():.2f}",
                    "Max (PSI)": f"{v.max():.2f}",
                    "N": len(v),
                }
            )
    if not rows:
        return
    tbl = pd.DataFrame(rows)
    fig, ax = plt.subplots(figsize=(10, max(4, len(rows) * 0.35)))
    ax.axis("off")
    table = ax.table(
        cellText=tbl.values,
        colLabels=tbl.columns,
        loc="center",
        cellLoc="center",
    )
    table.auto_set_font_size(False)
    table.set_fontsize(9)
    table.scale(1.2, 1.8)
    ax.set_title("Pressure Summary Statistics")
    fig.tight_layout(rect=[0, 0, 1, 0.95])
    fig.savefig(out_path)
    plt.close(fig)
    print(f"  Saved {out_path}")


def plot_controller(
    ctrl_wide: pd.DataFrame,
    t_s: np.ndarray,
    out_path: Path,
) -> None:
    """Controller outputs: duty cycles, thrust ref/estimated, P_ch."""
    cols = [c for c in ctrl_wide.columns if c != "t_s"]
    if not cols:
        return
    duty_cols = [c for c in cols if "duty" in c.lower()]
    thrust_cols = [c for c in cols if "F_" in c or "thrust" in c.lower()]
    other_cols = [c for c in cols if c not in duty_cols and c not in thrust_cols]
    n_panels = sum(1 for x in [duty_cols, thrust_cols, other_cols] if x)
    if n_panels == 0:
        return
    fig, axes = plt.subplots(n_panels, 1, figsize=(12, 3 * n_panels), sharex=True)
    if n_panels == 1:
        axes = [axes]
    fig.suptitle("Controller Outputs", fontsize=12, fontweight="bold")
    idx = 0
    if duty_cols:
        ax = axes[idx]
        for c in duty_cols:
            ax.plot(t_s, ctrl_wide[c], label=c.replace("_", " "), alpha=0.9)
        ax.set_ylabel("Duty (0–1)")
        ax.set_title("Duty Cycles")
        ax.legend(loc="upper right", fontsize=8)
        ax.grid(True, alpha=0.3)
        ax.set_ylim(-0.05, 1.05)
        ax.set_xlim(left=0)
        idx += 1
    if thrust_cols:
        ax = axes[idx]
        for c in thrust_cols:
            ax.plot(t_s, ctrl_wide[c], label=c.replace("_", " "), alpha=0.9)
        ax.set_ylabel("Thrust (N)")
        ax.set_title("Thrust Ref / Estimated")
        ax.legend(loc="upper right", fontsize=8)
        ax.grid(True, alpha=0.3)
        ax.set_xlim(left=0)
        idx += 1
    if other_cols:
        ax = axes[idx]
        for c in other_cols[:8]:
            ax.plot(t_s, ctrl_wide[c], label=c.replace("_", " "), alpha=0.9)
        ax.set_ylabel("Value")
        ax.set_xlabel("Time (s)")
        ax.set_title("P_ch, MR, measurement, status")
        ax.legend(loc="upper right", fontsize=8)
        ax.grid(True, alpha=0.3)
        ax.set_xlim(left=0)
    for i in range(idx - 1):
        plt.setp(axes[i].get_xticklabels(), visible=False)
    plt.tight_layout()
    fig.savefig(out_path)
    plt.close(fig)
    print(f"  Saved {out_path}")


def plot_overview_4panel(
    pt_wide: pd.DataFrame,
    tc_wide: pd.DataFrame | None,
    act_wide: pd.DataFrame | None,
    state_wide: pd.DataFrame | None,
    ctrl_wide: pd.DataFrame | None,
    t_s: np.ndarray,
    out_path: Path,
    actuator_roles: dict[str, str] | None = None,
    state_names: dict[int, str] | None = None,
) -> None:
    """Overview: state, pressures, temps, actuators, controller."""
    has_state = state_wide is not None and not state_wide.empty
    has_ctrl = ctrl_wide is not None and not ctrl_wide.empty
    roles_ov = actuator_roles or {}
    act_display_ov = (
        _apply_actuator_open_closed(act_wide, roles_ov)
        if act_wide is not None and not act_wide.empty
        else None
    )
    act_cols_ov = (
        [c for c in act_display_ov.columns if c != "t_s"]
        if act_display_ov is not None
        else []
    )
    n_act_ch = max(1, len(act_cols_ov))
    act_ratio = min(3.0, max(0.95, 0.1 * n_act_ch))
    ratios: list[float] = []
    if has_state:
        ratios.append(0.65)
    ratios.extend([1.2, 1.05, act_ratio])
    if has_ctrl:
        ratios.append(0.55)
    n_panels = len(ratios)
    fig_h = min(22.0, 9.0 + 0.32 * max(0, len(act_cols_ov) - 6))
    fig = plt.figure(figsize=(14, fig_h))
    gs = GridSpec(n_panels, 1, figure=fig, height_ratios=ratios, hspace=0.32)
    idx = 0
    share_ax = None

    if has_state:
        ax0 = fig.add_subplot(gs[idx])
        share_ax = ax0
        for c in state_wide.columns:
            if c != "t_s":
                ax0.step(
                    t_s,
                    state_wide[c],
                    where="post",
                    label=c.replace("_", " "),
                    alpha=0.9,
                )
        ax0.set_ylabel("State")
        ax0.set_title("System State")
        ax0.legend(loc="upper right", fontsize=8)
        ax0.grid(True, alpha=0.3)
        ax0.set_xlim(left=0)
        if state_names:
            st_cols = [c for c in state_wide.columns if c != "t_s"]
            y_vals = sorted(
                {
                    int(round(float(v)))
                    for c in st_cols
                    for v in state_wide[c].dropna().unique()
                    if np.isfinite(v)
                }
            )
            if y_vals:
                ax0.set_yticks(y_vals)
                ax0.set_yticklabels(
                    [state_names.get(v, str(v)) for v in y_vals], fontsize=8
                )
        idx += 1

    ax1 = fig.add_subplot(gs[idx], sharex=share_ax)
    if not pt_wide.empty:
        pt_cols = [c for c in pt_wide.columns if c != "t_s"][:8]
        for c in pt_cols:
            ax1.plot(t_s, pt_wide[c], label=c.replace("_", " "), alpha=0.9)
    ax1.set_ylabel("Pressure (PSI)")
    ax1.set_title("Key Pressures")
    ax1.legend(loc="upper right", ncol=2, fontsize=8)
    ax1.grid(True, alpha=0.3)
    ax1.set_xlim(left=0)
    idx += 1

    ax2 = fig.add_subplot(gs[idx], sharex=ax1)
    if tc_wide is not None and not tc_wide.empty:
        tc_cols = [c for c in tc_wide.columns if c != "t_s"][:6]
        for c in tc_cols:
            ax2.plot(t_s, tc_wide[c], label=c.replace("_", " "), alpha=0.9)
    ax2.set_ylabel("Temperature (°C)")
    ax2.set_title("Temperatures")
    ax2.legend(loc="upper right", ncol=2, fontsize=8)
    ax2.grid(True, alpha=0.3)
    idx += 1

    # Actuators: one row per valve (matches actuators.png). Overlaying steps on one axis
    # collapsed all traces onto y=0/1 and looked like false "flat lines".
    if act_display_ov is not None and act_cols_ov:
        sub = gs[idx].subgridspec(len(act_cols_ov), 1, hspace=0.2)
        act_axes: list = []
        for i, c in enumerate(act_cols_ov):
            axx = fig.add_subplot(
                sub[i, 0],
                sharex=ax1 if i == 0 else act_axes[0],
            )
            act_axes.append(axx)
            _fill_actuator_channel_axis(
                axx,
                t_s,
                act_display_ov[c].values,
                c,
                color=f"C{i % 10}",
                y_label_fontsize=7,
            )
            axx.set_xlim(left=0)
            if i < len(act_cols_ov) - 1:
                plt.setp(axx.get_xticklabels(), visible=False)
        act_axes[0].set_title("Actuators (OPEN/CLOSED)", fontsize=10)
    else:
        ax3 = fig.add_subplot(gs[idx], sharex=ax1)
        ax3.set_title("Actuators (no data)")
        ax3.grid(True, alpha=0.3)
    idx += 1

    if has_ctrl:
        ax4 = fig.add_subplot(gs[idx], sharex=ax1)
        ctrl_cols = [c for c in ctrl_wide.columns if c != "t_s"][:8]
        for c in ctrl_cols:
            ax4.plot(t_s, ctrl_wide[c], label=c.replace("_", " "), alpha=0.9)
        ax4.set_ylabel("Value")
        ax4.set_title("Controller (duty, fire_active, P_ch, etc.)")
        ax4.legend(loc="upper right", ncol=2, fontsize=8)
        ax4.grid(True, alpha=0.3)
        ax4.set_xlim(left=0)
        idx += 1

    _all_ax = fig.get_axes()
    if _all_ax:
        _all_ax[-1].set_xlabel("Time (s)")
        for _a in _all_ax[:-1]:
            plt.setp(_a.get_xticklabels(), visible=False)
    fig.suptitle("Run Overview", fontsize=12, fontweight="bold", y=1.01)
    with np.errstate(all="ignore"):
        fig.tight_layout(rect=[0.02, 0.02, 0.98, 0.97])
    fig.savefig(out_path)
    plt.close(fig)
    print(f"  Saved {out_path}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Analyze Elodin DB export and generate plots"
    )
    parser.add_argument(
        "export_dir", nargs="?", default="./export_csv", help="CSV export directory"
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=None,
        help="config.toml for PT/TC/RTD/actuator display names (default: <repo>/config/config.toml)",
    )
    parser.add_argument(
        "--output", "-o", default=None, help="Output directory for plots"
    )
    parser.add_argument(
        "--max-gap",
        type=float,
        default=0.2,
        help="Max gap in seconds before marking drop-out (default: 0.2)",
    )
    parser.add_argument(
        "--crop-fire",
        action="store_true",
        help="Anchor at FIRE state (or chamber pressure spike) and crop window",
    )
    parser.add_argument(
        "--full-run",
        action="store_true",
        help="Do not anchor at PRESS_STANDBY; use earliest PT/TC time as t=0 (plot full export)",
    )
    parser.add_argument(
        "--anchor-last-press-standby",
        action="store_true",
        help="Anchor t=0 at last PRESS_STANDBY (often near shutdown); default is first PRESS_STANDBY",
    )
    args = parser.parse_args()

    export_dir = Path(args.export_dir)
    if not export_dir.exists():
        print(f"❌ Export dir not found: {export_dir}")
        print(
            "  Run: FORMAT=csv ./scripts/postprocessing/export_elodin_db.sh <DB_PATH> ./export_csv"
        )
        return

    out_dir = (
        Path(args.output) if args.output else Path("./output/postprocessing/latest")
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"📂 Loading from {export_dir}")
    print(f"📁 Output to {out_dir}")

    project_root = Path(__file__).resolve().parent.parent.parent
    config_path = (
        args.config.resolve()
        if args.config
        else project_root / "config" / "config.toml"
    )
    cfg_toml = _read_config_toml(config_path)
    if cfg_toml is None:
        if not config_path.exists():
            print(
                f"  ⚠️  Config not found: {config_path} (using generic channel labels)"
            )
        cfg_data: dict = {}
    else:
        cfg_data = cfg_toml

    sensor_names = _sensor_names_from_data(cfg_data)
    actuator_roles = _actuator_roles_from_data(cfg_data)
    actuator_cmd_labels = _actuator_cmd_labels_from_data(cfg_data)
    if cfg_toml is not None and (sensor_names or actuator_cmd_labels):
        print(
            f"  Display names from {config_path.name}: "
            f"{len(sensor_names)} sensor aliases, {len(actuator_cmd_labels)} actuators"
        )

    # Load PT pressures (board-numbered entities: PT1_Cal.CH*, PT2_Cal.CH*, …)
    pt_series = load_csv_series(export_dir, "PT*_Cal.*.pressure_psi.csv")
    if not pt_series:
        print("  No PT*_Cal pressure_psi data found")
    else:
        print(f"  Loaded {len(pt_series)} PT pressure channels")

    # Load TC/RTD temps
    tc_series = load_csv_series(export_dir, "TC*_Cal.*.temperature_c.csv")
    tc_series.update(load_csv_series(export_dir, "RTD*_Cal.*.temperature_c.csv"))
    if tc_series:
        print(f"  Loaded {len(tc_series)} temperature channels")

    # Load load cells (unit is force_kg from calibration_service)
    lc_series = load_csv_series(export_dir, "LC*_Cal.*.force_kg.csv")
    if lc_series:
        print(f"  Loaded {len(lc_series)} load cell channels")

    # Load actuator states: prefer commanded (0x32, ACT_CMD.*); merge missing channels from sense (0x31).
    act_series = load_csv_series(export_dir, "ACT_CMD.*.actuator_state_commanded.csv")
    if export_dir.is_dir():
        nested = load_csv_series(export_dir, "**/ACT_CMD*.actuator_state_commanded.csv")
        for k, v in nested.items():
            act_series.setdefault(k, v)
    from_commanded = bool(act_series)

    sense_series = load_csv_series(export_dir, "ACT*.CH*.actuator_state.csv")
    if export_dir.is_dir():
        nested_sense = load_csv_series(export_dir, "**/ACT*.CH*.actuator_state.csv")
        for k, v in nested_sense.items():
            sense_series.setdefault(k, v)

    if act_series:
        act_series = merge_act_sense_fallback_for_act_cmd(act_series, sense_series)
    else:
        act_series = sense_series
        if not act_series:
            act_series = load_csv_series(export_dir, "ACT*.CH*.actuator_state*.csv")
    if act_series:
        print(
            f"  Loaded {len(act_series)} actuator channels ({'commanded' if from_commanded else 'current-sense'})"
        )

    # Load system state: prefer Elodin CONTROLLER export (full timeline); else backend CSV; else BOARD.
    state_from_board = False
    state_series = _load_controller_state_from_export(export_dir)
    if state_series:
        print(
            "  Loaded system state from CONTROLLER.state.to_state (Elodin export, PSM)"
        )
    else:
        state_series = _load_state_fallback(export_dir)
        if state_series:
            print("  Loaded system state from data/state_transitions.csv (PSM)")
        else:
            board_state = load_csv_series(export_dir, "BOARD.*.engine_state.csv")
            if board_state:
                state_series = {"engine_state": next(iter(board_state.values()))}
                state_from_board = True
                print(
                    "  Loaded system state from BOARD heartbeat (SAFE/PRESSURIZING/...)"
                )
            else:
                state_series = {}

    # Load controller outputs (actuation, fire, diagnostics, measurement)
    ctrl_series = {}
    ctrl_patterns = [
        "CONTROLLER.actuation.duty_F.csv",
        "CONTROLLER.actuation.duty_O.csv",
        "CONTROLLER.actuation.u_F_on.csv",
        "CONTROLLER.actuation.u_O_on.csv",
        "CONTROLLER.fire.duty_F.csv",
        "CONTROLLER.fire.duty_O.csv",
        "CONTROLLER.fire.fire_active.csv",
        "CONTROLLER.diagnostics.F_ref.csv",
        "CONTROLLER.diagnostics.F_estimated.csv",
        "CONTROLLER.diagnostics.MR_ref.csv",
        "CONTROLLER.diagnostics.MR_estimated.csv",
        "CONTROLLER.diagnostics.P_ch.csv",
        "CONTROLLER.diagnostics.cost.csv",
        "CONTROLLER.diagnostics.safety_filtered.csv",
        "CONTROLLER.diagnostics.cutoff_active.csv",
        "CONTROLLER.measurement.P_ch_mp1.csv",
        "CONTROLLER.measurement.P_ch_mp2.csv",
        "CONTROLLER.measurement.P_copv.csv",
        "CONTROLLER.measurement.P_reg.csv",
    ]
    for pat in ctrl_patterns:
        ctrl_series.update(load_csv_series(export_dir, pat))
    # Fallback: load any CONTROLLER.*.csv (handles export naming variations)
    if not ctrl_series:
        ctrl_series = load_csv_series(export_dir, "CONTROLLER.*.*.csv")
    if ctrl_series:
        print(f"  Loaded {len(ctrl_series)} controller channels")

    # Load raw sensor data (board-numbered: PT1.CH*, PT2.CH*, …)
    pt_raw = load_csv_series(export_dir, "PT*.CH*.raw_adc_counts.csv")
    tc_raw = load_csv_series(export_dir, "TC*.CH*.raw_adc_counts.csv")
    rtd_raw = load_csv_series(export_dir, "RTD*.CH*.raw_resistance_counts.csv")
    lc_raw = load_csv_series(export_dir, "LC*.CH*.raw_adc_counts.csv")
    if pt_raw or tc_raw or rtd_raw or lc_raw:
        print(
            f"  Loaded raw: PT={len(pt_raw)}, TC={len(tc_raw)}, RTD={len(rtd_raw)}, LC={len(lc_raw)}"
        )

    all_series = {
        **pt_series,
        **tc_series,
        **lc_series,
        **act_series,
        **state_series,
        **ctrl_series,
    }
    if not all_series:
        print("❌ No data to plot")
        return

    # Resample all to high-res grid (100Hz) for alignment
    dt = 0.01
    t0: pd.Timestamp
    t_min_crop = 0.0
    t_max_crop = None

    if args.crop_fire:
        FIRE_STATE = 16
        t_data_min = _find_t0_from_data(pt_series, tc_series)
        fire_times = []
        for name, df in state_series.items():
            if "state" in name.lower() and not df.empty:
                # Only look for fire starts after data starts (to avoid stale states)
                t_fire = df[(df["value"] == FIRE_STATE) & (df["time"] >= t_data_min)][
                    "time"
                ]
                if not t_fire.empty:
                    fire_times.append(t_fire.min())

        if fire_times:
            t0 = min(fire_times)
            print(f"🔥 Found relevant FIRE state starts at {t0}")
            t_min_crop = -1.0
            t_max_crop = 7.0
        else:
            # Fallback: search for pressure spike if state missing
            print(
                "⚠️ FIRE state not found in data window, searching for pressure peak..."
            )
            t0 = t_data_min
            for name, df in pt_series.items():
                if "chamber" in name.lower() and not df.empty:
                    peak_time = df.loc[df["value"].idxmax(), "time"]
                    if df["value"].max() > 100:
                        t0 = peak_time - 2.0  # Center on spike
                        print(
                            f"🎯 Found pressure spike at {peak_time}, centering there."
                        )
                        t_min_crop = 0.0
                        t_max_crop = 8.0  # Show 8s around spike
                        break
    else:
        if args.full_run:
            t0 = _find_t0_from_data(pt_series, tc_series)
            print(
                f"  Time axis t=0 at earliest sensor data ({t0}) — full run (--full-run)"
            )
        else:
            t_start = _find_t_start_from_state(
                state_series,
                PRESS_STANDBY_STATE,
                last=args.anchor_last_press_standby,
            )
            if t_start is not None:
                t0 = t_start
                which = "last" if args.anchor_last_press_standby else "first"
                print(
                    f"  Time axis t=0 at {which} PRESS_STANDBY → {t_start} "
                    f"(plots omit earlier time; use --full-run for entire capture)"
                )
            else:
                t0 = _find_t0_from_data(pt_series, tc_series)
                print(
                    f"  No PRESS_STANDBY in state data; t=0 at earliest sensor data ({t0})"
                )

    # Calculate global t_max if not already constrained (exclude state log — it can
    # extend past DAQ or skew bounds; use sensors/actuators/controller only).
    if t_max_crop is None:
        all_t: list[float] = []
        for sd in (pt_series, tc_series, lc_series, act_series, ctrl_series):
            if not sd:
                continue
            for df in sd.values():
                if len(df) > 0:
                    all_t.extend((df["time"] - t0).dt.total_seconds().dropna().tolist())
        t_max_val = max(all_t) if all_t else 60.0
        if t_max_val <= 0:
            print("⚠️  All samples are before t0 — re-anchoring at earliest sensor time")
            t0 = _find_t0_from_data(pt_series, tc_series)
            all_t = []
            for sd in (pt_series, tc_series, lc_series, act_series, ctrl_series):
                if not sd:
                    continue
                for df in sd.values():
                    if len(df) > 0:
                        all_t.extend(
                            (df["time"] - t0).dt.total_seconds().dropna().tolist()
                        )
            t_max_val = max(all_t) if all_t else 60.0
        elif t_max_val < 2.0:
            print(
                f"⚠️  Short timeline after PRESS_STANDBY anchor ({t_max_val:.3f}s). "
                "If this looks wrong, use --full-run or avoid --anchor-last-press-standby."
            )
    else:
        t_max_val = t_max_crop

    # Resample all to high-resolution common grid (100Hz)
    pt_wide, t_s = (
        resample_to_grid(
            pt_series,
            t0,
            dt,
            t_min=t_min_crop,
            t_max=t_max_val,
            max_gap_sec=args.max_gap,
        )
        if pt_series
        else (pd.DataFrame(), np.array([]))
    )
    tc_wide, _ = (
        resample_to_grid(
            tc_series,
            t0,
            dt,
            t_min=t_min_crop,
            t_max=t_max_val,
            max_gap_sec=args.max_gap,
        )
        if tc_series
        else (None, None)
    )
    lc_wide, _ = (
        resample_to_grid(
            lc_series,
            t0,
            dt,
            t_min=t_min_crop,
            t_max=t_max_val,
            max_gap_sec=args.max_gap,
        )
        if lc_series
        else (None, None)
    )
    act_wide, _ = (
        resample_to_grid_step(
            act_series,
            t0,
            dt,
            t_min=t_min_crop,
            t_max=t_max_val,
        )
        if act_series
        else (None, None)
    )
    if act_wide is not None and not act_wide.empty and not from_commanded:
        act_wide = debounce_binary(act_wide, window_sec=0.5, dt=dt)
    if act_wide is not None and not act_wide.empty:
        act_wide = reorder_actuator_wide_columns(act_wide)
    state_wide, _ = (
        resample_to_grid_step(
            state_series,
            t0,
            dt,
            t_min=t_min_crop,
            t_max=t_max_val,
        )
        if state_series
        else (None, None)
    )
    ctrl_wide, _ = (
        resample_to_grid(
            ctrl_series,
            t0,
            dt,
            t_min=t_min_crop,
            t_max=t_max_val,
            max_gap_sec=args.max_gap,
        )
        if ctrl_series
        else (None, None)
    )

    # Map dataframe columns to human-readable names from config
    for df in [pt_wide, tc_wide, lc_wide]:
        if df is not None:
            df.rename(columns=sensor_names, inplace=True)
    if act_wide is not None and actuator_cmd_labels:
        act_wide.rename(columns=actuator_cmd_labels, inplace=True)
    if state_wide is not None and "engine_state" in state_wide.columns:
        state_wide.rename(columns={"engine_state": "System state"}, inplace=True)
    if ctrl_wide is not None and not ctrl_wide.empty:
        ctrl_wide.rename(columns=CONTROLLER_DISPLAY_LABELS, inplace=True)

    # Save combined CSV for downstream analysis
    combined = pd.DataFrame({"t_s": t_s})
    for df in [pt_wide, tc_wide, lc_wide, act_wide, state_wide, ctrl_wide]:
        if df is not None and not df.empty:
            for c in df.columns:
                if c != "t_s":
                    combined[c] = df[c].values
    combined.to_csv(out_dir / "run_data_combined.csv", index=False)

    print("\n📊 Generating plots...")
    plot_pressures(pt_wide, t_s, out_dir / "pressures.png")
    if pt_wide is not None and not pt_wide.empty:
        plot_pressures_full_run(pt_wide, t_s, out_dir / "pressures_full_run.png")
    if pt_series:
        plot_summary_stats(
            pt_series, out_dir / "pressure_summary.png", sensor_names=sensor_names
        )
    if tc_wide is not None:
        plot_temperatures(tc_wide, t_s, out_dir / "temperatures.png")
    if lc_wide is not None:
        plot_load_cells(lc_wide, t_s, out_dir / "load_cells.png")
    if act_wide is not None:
        plot_actuators(act_wide, t_s, out_dir / "actuators.png", actuator_roles)
    if state_wide is not None:
        plot_states(
            state_wide,
            t_s,
            out_dir / "states.png",
            state_names=(
                BOARD_ENGINE_STATE_NAMES if state_from_board else PSM_STATE_NAMES
            ),
        )
    if ctrl_wide is not None and not ctrl_wide.empty:
        plot_controller(ctrl_wide, t_s, out_dir / "controller.png")

    plot_overview_4panel(
        pt_wide,
        tc_wide,
        act_wide,
        state_wide,
        ctrl_wide,
        t_s,
        out_dir / "overview.png",
        actuator_roles,
        state_names=(
            (BOARD_ENGINE_STATE_NAMES if state_from_board else PSM_STATE_NAMES)
            if state_series
            else None
        ),
    )

    if (
        act_wide is not None
        and not act_wide.empty
        and pt_wide is not None
        and not pt_wide.empty
    ):
        act_disp_snap = _apply_actuator_open_closed(act_wide, actuator_roles)
        plot_gn2_ox_valve_snapshots(pt_wide, act_disp_snap, t_s, out_dir)


if __name__ == "__main__":
    main()
