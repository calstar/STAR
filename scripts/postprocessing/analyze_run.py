#!/usr/bin/env python3
"""Analyze Elodin DB export: load CSV, process, and generate data-analysis plots.

Loads raw + calibrated sensor data, actuator states (0=OFF, 1=ON hardware), and
system state (PSM/engine_state). Saves combined CSV and generates plots.

Usage:
  python scripts/postprocessing/analyze_run.py [EXPORT_DIR] [--output OUT_DIR]

  Export dir defaults to ./export_csv (from FORMAT=csv export_elodin_db.sh).
  Output dir defaults to ./output/postprocessing/latest.
"""

from __future__ import annotations

import argparse
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


def _load_sensor_names(project_root: Path | None = None) -> dict[str, str]:
    """Load PT/TC/RTD/LC channel IDs -> role names from config.toml."""
    root = project_root or Path(__file__).resolve().parent.parent.parent
    cfg = root / "config" / "config.toml"
    if not cfg.exists():
        return {}
    out: dict[str, str] = {}
    try:
        import tomllib

        with open(cfg, "rb") as f:
            data = tomllib.load(f)

        # PT Board 1 (board slot 1 → entity prefix PT1 / PT1_Cal)
        roles1 = data.get("sensor_roles_pt_board", {})
        for name, ch in roles1.items():
            out[f"PT1_Cal.CH{ch}"] = name
            out[f"PT1.CH{ch}"] = f"{name} (raw)"

        # PT Board 2 (board slot 2 → entity prefix PT2 / PT2_Cal, local channels 1-10)
        roles2 = data.get("sensor_roles_pt2", {})
        for name, ch in roles2.items():
            out[f"PT2_Cal.CH{ch}"] = name
            out[f"PT2.CH{ch}"] = f"{name} (raw)"

        # TC Board 1
        roles_tc = data.get("sensor_roles_tc_board", {})
        for name, ch in roles_tc.items():
            out[f"TC1_Cal.CH{ch}"] = name
            out[f"TC1.CH{ch}"] = f"{name} (raw)"

        # RTD Board 1
        roles_rtd = data.get("sensor_roles_rtd_board", {})
        for name, ch in roles_rtd.items():
            out[f"RTD1_Cal.CH{ch}"] = name
            out[f"RTD1.CH{ch}"] = name

    except Exception:
        pass
    return out


def _load_actuator_roles(project_root: Path | None = None) -> dict[str, str]:
    """Load actuator name -> type (NC/NO) from config. Returns {name: 'NC'|'NO'}."""
    root = project_root or Path(__file__).resolve().parent.parent.parent
    cfg = root / "config" / "config.toml"
    if not cfg.exists():
        return {}
    out: dict[str, str] = {}
    try:
        import tomllib

        with open(cfg, "rb") as f:
            data = tomllib.load(f)
        roles = data.get("actuator_roles", {})
        for name, arr in roles.items():
            if isinstance(arr, (list, tuple)) and len(arr) >= 1:
                out[name] = str(arr[0]).upper()
    except Exception:
        pass
    return out


def _find_t_start_from_state(
    state_series: dict[str, pd.DataFrame],
    target_state: int = PRESS_STANDBY_STATE,
) -> pd.Timestamp | None:
    """Find timestamp of last transition to target_state (e.g. PRESS_STANDBY)."""
    for df in state_series.values():
        if "value" not in df.columns or "time" not in df.columns:
            continue
        mask = df["value"] == target_state
        if not mask.any():
            continue
        # Transition-based (state_transitions): each row = one transition; last row with value==target is correct.
        # Time-series: find start of last contiguous block of target_state.
        prev = mask.shift(1, fill_value=False)
        block_starts = mask & ~prev
        if block_starts.any():
            last_start_idx = block_starts[block_starts].index[-1]
            return df.loc[last_start_idx, "time"]
        return df.loc[mask, "time"].iloc[-1]
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
                    df["value"] = pd.to_numeric(df["to_state"], errors="coerce")
                    df = df[["time", "value"]].dropna(subset=["value"])
                    if len(df) > 0:
                        return {"engine_state": df}
            except Exception as e:
                print(f"  Skip {p.name}: {e}")
    return {}


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
            df = df[["time", "value"]].dropna(subset=["value"])
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
    max_gap_sec: float | None = None,
) -> tuple[pd.DataFrame, np.ndarray]:
    """Resample discrete data (states, actuators) using forward-fill. No interpolation.
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
        # Sort by time
        idx = np.argsort(t_s)
        t_s = t_s[idx]
        v = v[idx]
        # Forward-fill: at each grid point, use value at last sample before t
        res = np.full(len(time_grid), np.nan)
        for i, g in enumerate(time_grid):
            j = np.searchsorted(t_s, g, side="right") - 1
            if j >= 0:
                # Also check gap to previous sample
                if max_gap_sec is not None and (g - t_s[j]) > max_gap_sec:
                    res[i] = np.nan
                else:
                    res[i] = v[j]
        # Fill leading nans with first valid
        if len(res) > 0 and np.isnan(res[0]):
            first_valid = np.nonzero(~np.isnan(res))[0]
            if len(first_valid) > 0:
                res[: first_valid[0]] = res[first_valid[0]]
        out[name] = res
    return out, time_grid


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
    for ax, c in zip(axes, cols):
        vals = display[c].values
        ax.fill_between(t_s, 0, vals, step="post", alpha=0.7)
        ax.set_ylabel(c.replace("_", " "), fontsize=9)
        ax.set_ylim(-0.2, 1.2)
        ax.set_yticks([0, 1])
        ax.set_yticklabels(["CLOSED", "OPEN"])
        ax.grid(True, alpha=0.3, axis="x")
        ax.set_xlim(left=0)
    axes[-1].set_xlabel("Time (s)")
    plt.tight_layout()
    fig.savefig(out_path)
    plt.close(fig)
    print(f"  Saved {out_path}")


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
        set(
            int(round(v))
            for v in np.unique(data[cols[0]].dropna().values)
            if not np.isnan(v)
        )
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
) -> None:
    """Summary statistics table for pressures."""
    rows = []
    for name, df in pt_data.items():
        v = df["value"].dropna()
        if len(v) > 0:
            rows.append(
                {
                    "Sensor": name,
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
) -> None:
    """Overview: state, pressures, temps, actuators, controller."""
    has_state = state_wide is not None and not state_wide.empty
    has_ctrl = ctrl_wide is not None and not ctrl_wide.empty
    n_panels = 4 + (1 if has_state else 0) + (1 if has_ctrl else 0)
    ratios = [0.6, 1.2, 1.0, 0.8, 0.5, 0.6][:n_panels]
    fig = plt.figure(figsize=(14, 10))
    gs = GridSpec(n_panels, 1, figure=fig, height_ratios=ratios, hspace=0.35)
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

    ax3 = fig.add_subplot(gs[idx], sharex=ax1)
    if act_wide is not None and not act_wide.empty:
        roles = actuator_roles or {}
        act_display = _apply_actuator_open_closed(act_wide, roles)
        act_cols = [c for c in act_display.columns if c != "t_s"][:6]
        for c in act_cols:
            ax3.step(
                t_s, act_display[c], where="post", label=c.replace("_", " "), alpha=0.8
            )
    ax3.set_ylabel("Actuator")
    ax3.set_title("Actuators (OPEN/CLOSED)")
    ax3.set_ylim(-0.1, 1.3)
    ax3.set_yticks([0, 1])
    ax3.set_yticklabels(["CLOSED", "OPEN"])
    ax3.legend(loc="upper right", ncol=2, fontsize=8)
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

    fig.get_axes()[-1].set_xlabel("Time (s)")
    for i in range(idx - 1):
        plt.setp(fig.get_axes()[i].get_xticklabels(), visible=False)
    fig.suptitle("Run Overview", fontsize=12, fontweight="bold", y=1.02)
    plt.tight_layout()
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
        "--output", "-o", default=None, help="Output directory for plots"
    )
    parser.add_argument(
        "--max-gap",
        type=float,
        default=0.2,
        help="Max gap in seconds before marking drop-out (default: 0.2)",
    )
    parser.add_argument(
        "--crop-fire", action="store_true", help="Crop to 6-second FIRE window"
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
    actuator_roles = _load_actuator_roles(project_root)

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

    # Load actuator states: prefer commanded (0x32, ACT_CMD.*) over current-sense (0x31, ACT*.CH*)
    act_series = load_csv_series(export_dir, "ACT_CMD.*.actuator_state_commanded.csv")
    from_commanded = bool(act_series)
    if not act_series:
        act_series = load_csv_series(export_dir, "ACT*.CH*.actuator_state.csv")
    if not act_series:
        # Fallback: any actuator_state* from non-CMD tables
        act_series = load_csv_series(export_dir, "ACT*.CH*.actuator_state*.csv")
    if act_series:
        print(
            f"  Loaded {len(act_series)} actuator channels ({'commanded' if from_commanded else 'current-sense'})"
        )

    # Load system state (PSM). Order: state_transitions (backend during run) > CONTROLLER > BOARD.
    state_series = _load_state_fallback(export_dir)
    state_from_board = False
    if state_series:
        print(f"  Loaded system state from data/state_transitions.csv (PSM)")
    else:
        ctrl_state = load_csv_series(export_dir, "CONTROLLER.state.to_state.csv")
        board_state = load_csv_series(export_dir, "BOARD.*.engine_state.csv")
        if ctrl_state:
            state_series = {"engine_state": next(iter(ctrl_state.values()))}
            print(f"  Loaded system state from CONTROLLER.state.to_state (PSM)")
        elif board_state:
            state_series = {"engine_state": next(iter(board_state.values()))}
            state_from_board = True
            print(f"  Loaded system state from BOARD heartbeat (SAFE/PRESSURIZING/...)")
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
        t_start = _find_t_start_from_state(state_series, PRESS_STANDBY_STATE)
        if t_start is not None:
            print(f"  Filtering from PRESS_STANDBY at {t_start}")
            t0 = t_start
        else:
            t0 = _find_t0_from_data(pt_series, tc_series)

    # Calculate global t_max if not already constrained
    if t_max_crop is None:
        all_t = []
        for df in all_series.values():
            if len(df) > 0:
                all_t.extend((df["time"] - t0).dt.total_seconds().dropna().tolist())
        t_max_val = max(all_t) if all_t else 60.0
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
            max_gap_sec=args.max_gap,
        )
        if act_series
        else (None, None)
    )
    if act_wide is not None and not act_wide.empty and not from_commanded:
        act_wide = debounce_binary(act_wide, window_sec=0.5, dt=dt)
    state_wide, _ = (
        resample_to_grid_step(
            state_series,
            t0,
            dt,
            t_min=t_min_crop,
            t_max=t_max_val,
            max_gap_sec=args.max_gap,
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

    # Map columns to sensor names from config
    sensor_names = _load_sensor_names(project_root)
    for df in [pt_wide, tc_wide, lc_wide]:
        if df is not None:
            df.rename(columns=sensor_names, inplace=True)

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
    if pt_series:
        plot_summary_stats(pt_series, out_dir / "pressure_summary.png")
    if tc_wide is not None:
        plot_temperatures(tc_wide, t_s, out_dir / "temperatures.png")
    if lc_wide is not None:
        plot_load_cells(lc_wide, t_s, out_dir / "load_cells.png")
    if act_wide is not None:
        plot_actuators(act_wide, t_s, out_dir / "actuators.png", actuator_roles)
    if state_wide is not None:
        plot_states(state_wide, t_s, out_dir / "states.png")

    plot_overview_4panel(
        pt_wide,
        tc_wide,
        act_wide,
        state_wide,
        ctrl_wide,
        t_s,
        out_dir / "overview.png",
        actuator_roles,
    )


if __name__ == "__main__":
    main()
