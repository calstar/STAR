#!/usr/bin/env python3
"""
characterize_cd.py

Script to characterize the engine (or injector/valve) discharge coefficient (CdA)
using Elodin DB exported run data.

It finds the global t=0 of the run (matching analyze_run.py), lists available
pressure sensors, and asks the user for:
  - The upstream pressure sensor
  - The total mass of fluid flowed (in lbs)
  - The start time of steady flow (in seconds from t=0)
  - The end time of steady flow (in seconds from t=0)

Then it calculates the average upstream pressure in that window, subtracts
atmospheric pressure (14.7 psi), calculates the mass flow rate, and calculates CdA.
"""

import argparse
import sys
from pathlib import Path

import pandas as pd
import numpy as np


def get_global_t0(export_dir: Path) -> pd.Timestamp:
    """Find the earliest timestamp across all CSVs to use as t=0."""
    t0_list = []
    # Only sample up to 50 files to find t=0 to be fast, or all if small
    for f in export_dir.glob("*.csv"):
        try:
            df = pd.read_csv(f, nrows=1)
            if "time" in df.columns and not df.empty:
                t0_list.append(pd.to_datetime(df["time"].iloc[0]))
        except Exception:
            pass
    return min(t0_list) if t0_list else pd.Timestamp("2000-01-01T00:00:00Z")


def get_flow_window(export_dir: Path, t0: pd.Timestamp):
    """Attempt to find [t_start, t_end] from controller state or actuators."""
    # 1. Try CONTROLLER.state.to_state.csv (FIRE state is 5)
    state_file = export_dir / "CONTROLLER.state.to_state.csv"
    if state_file.exists():
        df = pd.read_csv(state_file)
        if not df.empty:
            val_cols = [c for c in df.columns if c != "time"]
            if val_cols:
                df = df.rename(columns={val_cols[0]: "value"})
            df["t_sec"] = (
                pd.to_datetime(df["time"], utc=True, format="ISO8601") - t0
            ).dt.total_seconds()
            fire_starts = df[df["value"] == 5]["t_sec"].values
            if len(fire_starts) > 0:
                t_start = fire_starts[0]
                post_fire = df[(df["t_sec"] > t_start) & (df["value"] != 5)][
                    "t_sec"
                ].values
                t_end = post_fire[0] if len(post_fire) > 0 else df["t_sec"].max()
                return t_start, t_end, "CONTROLLER (FIRE State)"

    # 2. Try Main Valves opening
    for act_name in ["Fuel_Main", "LOX_Main", "Main_Valve"]:
        for suffix in ["actuator_state_commanded.csv", "actuator_state.csv"]:
            act_file = export_dir / f"ACT.{act_name}.{suffix}"
            if act_file.exists():
                df = pd.read_csv(act_file)
                if not df.empty:
                    val_cols = [c for c in df.columns if c != "time"]
                    if val_cols:
                        df = df.rename(columns={val_cols[0]: "value"})
                    df["t_sec"] = (
                        pd.to_datetime(df["time"], utc=True, format="ISO8601") - t0
                    ).dt.total_seconds()
                    opens = df[df["value"] == 1]["t_sec"].values  # 1 is open
                    if len(opens) > 0:
                        t_start = opens[0]
                        closes = df[(df["t_sec"] > t_start) & (df["value"] == 0)][
                            "t_sec"
                        ].values
                        t_end = closes[0] if len(closes) > 0 else df["t_sec"].max()
                        return t_start, t_end, f"Actuator {act_name}"

    return None, None, None


def main():
    parser = argparse.ArgumentParser(
        description="Calculate engine/injector Cd from run data"
    )
    parser.add_argument(
        "export_dir",
        type=str,
        help="Path to the directory containing Elodin CSV exports",
    )
    args = parser.parse_args()

    export_dir = Path(args.export_dir)
    if not export_dir.exists() or not export_dir.is_dir():
        print(f"Error: {export_dir} is not a valid directory.")
        sys.exit(1)

    print("Analyzing run to find global t=0...")
    t0 = get_global_t0(export_dir)
    print(f"Global t=0 found: {t0}")

    # Find all pressure sensor CSVs
    pt_files = list(export_dir.glob("PT_Cal.*.pressure_psi.csv")) + list(
        export_dir.glob("PT.*.pressure_psi.csv")
    )

    if not pt_files:
        print(
            "Error: No pressure sensor files (*.pressure_psi.csv) found in the export directory."
        )
        print(
            "Are you sure this is a valid export directory or that the run had pressure data?"
        )
        sys.exit(1)

    print("\nAvailable Pressure Sensors:")
    for i, file in enumerate(pt_files):
        # file.name looks like PT_Cal.Fuel_Upstream.pressure_psi.csv
        sensor_name = file.name.split(".pressure_psi")[0]
        print(f"  [{i}]: {sensor_name}")

    print("")
    sensor_idx = -1
    while True:
        try:
            choice = input(
                f"Select the upstream pressure sensor (0-{len(pt_files)-1}): "
            )
            sensor_idx = int(choice)
            if 0 <= sensor_idx < len(pt_files):
                break
            print("Invalid selection.")
        except ValueError:
            print("Please enter a valid number.")

    selected_file = pt_files[sensor_idx]
    sensor_name = selected_file.name.split(".pressure_psi")[0]
    print(f"\nLoading data for {sensor_name}...")

    df = pd.read_csv(selected_file)
    val_cols = [c for c in df.columns if c != "time"]
    if val_cols:
        df = df.rename(columns={val_cols[0]: "value"})

    df["time"] = pd.to_datetime(df["time"])
    # Convert time to seconds from t0
    df["t_sec"] = (df["time"] - t0).dt.total_seconds()

    print(
        f"Data loaded. Time range: {df['t_sec'].min():.2f}s to {df['t_sec'].max():.2f}s"
    )

    t_start, t_end = None, None
    auto_start, auto_end, source = get_flow_window(export_dir, t0)

    if auto_start is not None and auto_end is not None:
        print(f"\nAuto-detected flow window from {source}:")
        print(f"  Start: {auto_start:.3f} s")
        print(f"  End:   {auto_end:.3f} s")
        print(f"  Duration: {(auto_end - auto_start):.3f} s")
        ans = input("Use this steady flow window? [Y/n]: ").strip().lower()
        if ans == "" or ans == "y":
            t_start, t_end = auto_start, auto_end

    def get_float_input(prompt):
        while True:
            val = input(prompt).strip()
            if not val:
                continue
            try:
                return float(val)
            except ValueError:
                print("Invalid numerical input. Please try again.")

    mass_lbs = get_float_input("\nEnter total mass of fluid flowed (lbs): ")
    if t_start is None or t_end is None:
        t_start = get_float_input(
            "Enter start time of steady flow (in seconds, as seen on plot): "
        )
        t_end = get_float_input(
            "Enter end time of steady flow (in seconds, as seen on plot): "
        )

    if t_start >= t_end:
        print("Error: start time must be less than end time.")
        sys.exit(1)

    # Filter data within the time window
    window_df = df[(df["t_sec"] >= t_start) & (df["t_sec"] <= t_end)]
    if window_df.empty:
        print(
            f"Error: No data found for {sensor_name} between {t_start}s and {t_end}s."
        )
        sys.exit(1)

    avg_pressure_absolute = window_df["value"].mean()
    dp_psi = avg_pressure_absolute - 14.7

    print("\n" + "=" * 50)
    print(" RESULTS")
    print("=" * 50)
    print(f"Sensor used:               {sensor_name}")
    print(f"Average upstream pressure: {avg_pressure_absolute:.2f} psia")
    print(f"Pressure differential (ΔP): {dp_psi:.2f} psi (assuming 14.7 psi atm)")

    if dp_psi <= 0:
        print("\nError: Delta P is <= 0. Cannot compute Cd.")
        sys.exit(1)

    delta_t = t_end - t_start
    mass_flow_rate = mass_lbs / delta_t
    print(f"Flow duration (Δt):        {delta_t:.2f} s")
    print(f"Mass flow rate (ṁ):        {mass_flow_rate:.4f} lbm/s")

    # Calculate CdA
    # Equation: m_dot (lbm/s) = CdA (in^2) * sqrt(2 * g_c * rho * dP)
    # g_c = 386.4 lbm*in/(lbf*s^2)
    # rho_water = 0.03613 lbm/in^3
    rho_water_lb_in3 = 0.03613
    g_c = 386.4

    # Let user confirm or change fluid density
    print("\nAssuming test fluid is Water.")
    print(f"Default density: {rho_water_lb_in3:.5f} lbm/in^3  (62.43 lbm/ft^3)")
    change_rho = (
        input("Do you want to specify a different fluid density? (y/N): ")
        .strip()
        .lower()
    )

    rho = rho_water_lb_in3
    if change_rho == "y":
        try:
            val = float(input("Enter fluid density in lbm/in^3: "))
            rho = val
        except ValueError:
            print(f"Invalid input, using default {rho_water_lb_in3} lbm/in^3")

    # Compute Cd*A
    # sqrt(2 * 386.4 * rho * dP)
    denominator = np.sqrt(2 * g_c * rho * dp_psi)
    cda_in2 = mass_flow_rate / denominator

    print("\n" + "-" * 50)
    print(f"Fluid Density (ρ):         {rho:.5f} lbm/in^3")
    print(f"Cd*A:                      {cda_in2:.5f} in²")
    print("-" * 50)


if __name__ == "__main__":
    main()
