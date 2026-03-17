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

# SystemState enum (matches web-gui/shared/types.ts) for state timeline
STATE_NAMES = {
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


def load_csv_series(export_dir: Path, pattern: str) -> dict[str, pd.DataFrame]:
    """Load CSVs matching pattern. Returns {short_name: df with 'time' and 'value' cols}."""
    files = list(export_dir.glob(pattern))
    result = {}
    for f in files:
        # e.g. PT_Cal.GN2_High.pressure_psi.csv -> short_name = GN2_High (pressure_psi)
        stem = f.stem  # PT_Cal.GN2_High.pressure_psi
        parts = stem.split(".")
        if len(parts) >= 3:
            short = parts[1]  # GN2_High or actuation
            metric = parts[-1]  # pressure_psi or duty_F
            # CONTROLLER has multiple metrics per entity (duty_F, duty_O, F_ref, etc.)
            short_name = (
                f"{short}_{metric}"
                if parts[0] == "CONTROLLER"
                else (f"{short}" if len(parts) == 3 else f"{short}.{metric}")
            )
        else:
            short_name = stem
        try:
            df = pd.read_csv(f)
            df["time"] = pd.to_datetime(df.iloc[:, 0])
            df["value"] = pd.to_numeric(df.iloc[:, 1], errors="coerce")
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
    t_max: float | None = None,
) -> tuple[pd.DataFrame, np.ndarray]:
    """Resample multiple series to common time grid. Uses linear interpolation."""
    t_min = 0.0
    if t_max is None:
        all_t = []
        for df in series.values():
            s = (df["time"] - t0).dt.total_seconds()
            all_t.extend(s.dropna().tolist())
        t_max = max(all_t) if all_t else 60.0
    time_grid = np.arange(t_min, t_max + dt * 0.5, dt)
    out = pd.DataFrame({"t_s": time_grid})
    for name, df in series.items():
        t_s = (df["time"] - t0).dt.total_seconds().values
        v = df["value"].values
        out[name] = np.interp(time_grid, t_s, v)
    return out, time_grid


def resample_to_grid_step(
    series: dict[str, pd.DataFrame],
    t0: pd.Timestamp,
    dt: float = 0.1,
    t_max: float | None = None,
) -> tuple[pd.DataFrame, np.ndarray]:
    """Resample discrete data (states, actuators) using forward-fill. No interpolation."""
    t_min = 0.0
    if t_max is None:
        all_t = []
        for df in series.values():
            s = (df["time"] - t0).dt.total_seconds()
            all_t.extend(s.dropna().tolist())
        t_max = max(all_t) if all_t else 60.0
    time_grid = np.arange(t_min, t_max + dt * 0.5, dt)
    out = pd.DataFrame({"t_s": time_grid})
    for name, df in series.items():
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
                ax.plot(t_s, data[c], label=c.replace("_", " "), alpha=0.9)
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
    ax.set_title("Load Cell Force (N)")
    ax.set_ylabel("Force (N)")
    ax.set_xlabel("Time (s)")
    ax.legend(loc="upper right", fontsize=8)
    ax.grid(True, alpha=0.3)
    ax.set_xlim(left=0)
    plt.tight_layout()
    fig.savefig(out_path)
    plt.close(fig)
    print(f"  Saved {out_path}")


def plot_actuators(
    data: pd.DataFrame,
    t_s: np.ndarray,
    out_path: Path,
) -> None:
    """Actuator state timeline. Hardware: 0=OFF, 1=ON (OPEN/CLOSE depends on valve NO/NC)."""
    cols = [c for c in data.columns if c != "t_s"]
    if not cols:
        return
    n = len(cols)
    fig, axes = plt.subplots(n, 1, figsize=(12, max(4, n * 1.2)), sharex=True)
    if n == 1:
        axes = [axes]
    fig.suptitle(
        "Actuator State (0=OFF, 1=ON — OPEN/CLOSE depends on valve type)",
        fontsize=12,
        fontweight="bold",
    )
    for ax, c in zip(axes, cols):
        vals = data[c].values
        ax.fill_between(t_s, 0, vals, step="post", alpha=0.7)
        ax.set_ylabel(c.replace("_", " "), fontsize=9)
        v_min, v_max = np.nanmin(vals), np.nanmax(vals)
        ax.set_ylim(v_min - 0.2, max(v_max + 0.2, 1.2))
        uniq = sorted(set(np.unique(vals.astype(int))))
        ax.set_yticks(uniq if uniq else [0, 1])
        ax.set_yticklabels([str(int(u)) for u in uniq])
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
) -> None:
    """System state timeline (PSM/engine_state)."""
    cols = [c for c in data.columns if c != "t_s"]
    if not cols:
        return
    fig, ax = plt.subplots(figsize=(12, 4))
    for c in cols:
        ax.step(t_s, data[c].values, where="post", label=c.replace("_", " "), alpha=0.9)
    ax.set_ylabel("State (enum)")
    ax.set_xlabel("Time (s)")
    ax.set_title("System State (PSM / engine_state)")
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
        ax.set_yticklabels([STATE_NAMES.get(v, str(v)) for v in y_vals], fontsize=8)
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
        for c in other_cols[:4]:
            ax.plot(t_s, ctrl_wide[c], label=c.replace("_", " "), alpha=0.9)
        ax.set_ylabel("Value")
        ax.set_xlabel("Time (s)")
        ax.set_title("P_ch, MR, etc.")
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
    t_s: np.ndarray,
    out_path: Path,
) -> None:
    """5-panel overview: state, pressures, temps, actuators."""
    has_state = state_wide is not None and not state_wide.empty
    n_panels = 4 + (1 if has_state else 0)
    ratios = [0.6, 1.2, 1.0, 0.8, 0.5][:n_panels]
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
        act_cols = [c for c in act_wide.columns if c != "t_s"][:6]
        for c in act_cols:
            ax3.step(
                t_s, act_wide[c], where="post", label=c.replace("_", " "), alpha=0.8
            )
    ax3.set_ylabel("Actuator (0=OFF, 1=ON)")
    ax3.set_xlabel("Time (s)")
    ax3.set_title("Actuators")
    ax3.set_ylim(-0.1, 1.3)
    ax3.set_yticks([0, 1])
    ax3.set_yticklabels(["OFF", "ON"])
    ax3.legend(loc="upper right", ncol=2, fontsize=8)
    ax3.grid(True, alpha=0.3)

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

    # Load PT pressures
    pt_series = load_csv_series(export_dir, "PT_Cal.*.pressure_psi.csv")
    if not pt_series:
        print("  No PT_Cal pressure_psi data found")
    else:
        print(f"  Loaded {len(pt_series)} PT pressure channels")

    # Load TC temps
    tc_series = load_csv_series(export_dir, "TC_Cal.*.temperature_c.csv")
    tc_series.update(load_csv_series(export_dir, "RTD_Cal.*.temperature_c.csv"))
    if tc_series:
        print(f"  Loaded {len(tc_series)} temperature channels")

    # Load load cells
    lc_series = load_csv_series(export_dir, "LC_Cal.*.force_n.csv")
    if lc_series:
        print(f"  Loaded {len(lc_series)} load cell channels")

    # Load actuator states (0=OFF, 1=ON hardware; OPEN/CLOSE depends on valve NO/NC)
    act_series = load_csv_series(export_dir, "ACT.*.actuator_state.csv")
    if act_series:
        print(f"  Loaded {len(act_series)} actuator channels")

    # Load system state (PSM / engine_state). Prefer CONTROLLER.state.to_state (authoritative).
    ctrl_state = load_csv_series(export_dir, "CONTROLLER.state.to_state.csv")
    board_state = load_csv_series(export_dir, "BOARD.*.engine_state.csv")
    if ctrl_state:
        state_series = {"engine_state": next(iter(ctrl_state.values()))}
        print(f"  Loaded system state from CONTROLLER.state.to_state")
    elif board_state:
        state_series = {"engine_state": next(iter(board_state.values()))}
        print(f"  Loaded system state from BOARD heartbeat")
    else:
        state_series = {}

    # Load controller outputs (duty, thrust, diagnostics)
    ctrl_act = load_csv_series(export_dir, "CONTROLLER.actuation.duty_F.csv")
    ctrl_act.update(load_csv_series(export_dir, "CONTROLLER.actuation.duty_O.csv"))
    ctrl_act.update(load_csv_series(export_dir, "CONTROLLER.fire.duty_F.csv"))
    ctrl_act.update(load_csv_series(export_dir, "CONTROLLER.fire.duty_O.csv"))
    ctrl_diag = load_csv_series(export_dir, "CONTROLLER.diagnostics.F_ref.csv")
    ctrl_diag.update(load_csv_series(export_dir, "CONTROLLER.diagnostics.F_estimated.csv"))
    ctrl_diag.update(load_csv_series(export_dir, "CONTROLLER.diagnostics.MR_estimated.csv"))
    ctrl_diag.update(load_csv_series(export_dir, "CONTROLLER.diagnostics.P_ch.csv"))
    ctrl_series = {**ctrl_act, **ctrl_diag}
    if ctrl_series:
        print(f"  Loaded {len(ctrl_series)} controller channels")

    # Load raw sensor data (for combined export)
    pt_raw = load_csv_series(export_dir, "PT.*.raw_adc_counts.csv")
    tc_raw = load_csv_series(export_dir, "TC.*.raw_adc_counts.csv")
    rtd_raw = load_csv_series(export_dir, "RTD.*.raw_resistance_counts.csv")
    lc_raw = load_csv_series(export_dir, "LC.*.raw_adc_counts.csv")
    if pt_raw or tc_raw or rtd_raw or lc_raw:
        print(
            f"  Loaded raw: PT={len(pt_raw)}, TC={len(tc_raw)}, RTD={len(rtd_raw)}, LC={len(lc_raw)}"
        )

    # Common t0 and t_max from all data
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

    t0 = min(df["time"].min() for df in all_series.values())
    all_t = []
    for df in all_series.values():
        s = (df["time"] - t0).dt.total_seconds()
        all_t.extend(s.dropna().tolist())
    t_max = max(all_t) if all_t else 60.0
    dt = 0.1

    # Resample to common grid (same t_max for all)
    pt_wide, t_s = (
        resample_to_grid(pt_series, t0, dt, t_max)
        if pt_series
        else (pd.DataFrame(), np.array([]))
    )
    tc_wide, _ = (
        resample_to_grid(tc_series, t0, dt, t_max) if tc_series else (None, None)
    )
    lc_wide, _ = (
        resample_to_grid(lc_series, t0, dt, t_max) if lc_series else (None, None)
    )
    act_wide, _ = (
        resample_to_grid_step(act_series, t0, dt, t_max) if act_series else (None, None)
    )
    state_wide, _ = (
        resample_to_grid_step(state_series, t0, dt, t_max)
        if state_series
        else (None, None)
    )
    ctrl_wide, _ = (
        resample_to_grid(ctrl_series, t0, dt, t_max) if ctrl_series else (None, None)
    )

    if len(t_s) == 0:
        t_s = np.arange(0, t_max + dt * 0.5, dt)

    # Save combined CSV (raw + calibrated) for downstream analysis
    combined = pd.DataFrame({"t_s": t_s})

    def add_to_combined(series: dict, prefix: str, step_mode: bool = False) -> None:
        for name, df in series.items():
            t_sec = (df["time"] - t0).dt.total_seconds().values
            v = df["value"].values
            idx = np.argsort(t_sec)
            t_sec = t_sec[idx]
            v = v[idx]
            col = f"{prefix}{name}" if prefix else name
            if step_mode:
                res = np.full(len(t_s), np.nan)
                for i, g in enumerate(t_s):
                    j = np.searchsorted(t_sec, g, side="right") - 1
                    if j >= 0:
                        res[i] = v[j]
                if len(res) > 0 and np.isnan(res[0]):
                    fv = np.nonzero(~np.isnan(res))[0]
                    if len(fv) > 0:
                        res[: fv[0]] = res[fv[0]]
                combined[col] = res
            else:
                combined[col] = np.interp(t_s, t_sec, v)

    add_to_combined(pt_series, "PT_Cal.")
    add_to_combined(pt_raw, "PT_raw.")
    add_to_combined(tc_series, "TC_Cal.")
    add_to_combined(tc_raw, "TC_raw.")
    add_to_combined(rtd_raw, "RTD_raw.")
    add_to_combined(lc_series, "LC_Cal.")
    add_to_combined(lc_raw, "LC_raw.")
    add_to_combined(act_series, "ACT.", step_mode=True)
    add_to_combined(state_series, "", step_mode=True)
    add_to_combined(ctrl_series, "CTRL.")
    combined_path = out_dir / "run_data_combined.csv"
    combined.to_csv(combined_path, index=False)
    print(f"  Saved {combined_path} ({len(combined.columns)-1} channels)")

    # Generate plots
    print("\n📊 Generating plots...")
    if not pt_wide.empty:
        plot_pressures(pt_wide, t_s, out_dir / "pressures.png")
        plot_summary_stats(pt_series, out_dir / "pressure_summary.png")
    if tc_wide is not None and not tc_wide.empty:
        plot_temperatures(tc_wide, t_s, out_dir / "temperatures.png")
    if lc_wide is not None and not lc_wide.empty:
        plot_load_cells(lc_wide, t_s, out_dir / "load_cells.png")
    if act_wide is not None and not act_wide.empty:
        plot_actuators(act_wide, t_s, out_dir / "actuators.png")
    if state_wide is not None and not state_wide.empty:
        plot_states(state_wide, t_s, out_dir / "states.png")
    if ctrl_wide is not None and not ctrl_wide.empty:
        plot_controller(ctrl_wide, t_s, out_dir / "controller.png")

    plot_overview_4panel(
        pt_wide if not pt_wide.empty else pd.DataFrame(),
        tc_wide,
        act_wide,
        state_wide,
        t_s,
        out_dir / "overview.png",
    )

    print("\n✅ Done.")


if __name__ == "__main__":
    main()
