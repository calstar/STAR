#!/usr/bin/env python3
import argparse
import sys
from pathlib import Path
import pandas as pd
import numpy as np


def main():
    parser = argparse.ArgumentParser(
        description="Robustly calculate CdA from a combined run CSV."
    )
    parser.add_argument(
        "combined_csv",
        type=str,
        nargs="?",
        default="output/postprocessing/latest/run_data_combined.csv",
        help="Path to run_data_combined.csv",
    )
    args = parser.parse_args()

    csv_path = Path(args.combined_csv)
    if not csv_path.exists():
        print(
            f"Error: {csv_path} not found. Please run analyze_run.py on your data first to generate it."
        )
        sys.exit(1)

    print(f"Loading {csv_path} ...")
    df = pd.read_csv(csv_path)

    side = input("Which side are you characterizing? (Fuel/LOX): ").strip().lower()
    side_prefix = "Ox" if side in ["lox", "ox"] else "Fuel"

    up_col = f"PT_Cal.{side_prefix}_Upstream"
    down_col = f"PT_Cal.{side_prefix}_Downstream"
    act_col = f"ACT.{side_prefix}_Main"

    if up_col not in df.columns:
        print(f"Error: Column {up_col} not found in the combined CSV.")
        sys.exit(1)

    print(f"\nLooking for flow window using reliable markers for {side_prefix}...")

    t_start, t_end = None, None
    source = "Unknown"

    # Attempt 1: engine_state == 5
    if "engine_state" in df.columns and 5 in df["engine_state"].values:
        fire_df = df[df["engine_state"] == 5]
        t_start = fire_df["t_s"].min()
        t_end = fire_df["t_s"].max()
        source = "CONTROLLER (FIRE State)"

    # Attempt 2: Main Valve Actuator == 1
    elif act_col in df.columns and 1.0 in df[act_col].values:
        act_df = df[df[act_col] == 1.0]
        t_start = act_df["t_s"].min()
        t_end = act_df["t_s"].max()
        source = f"Actuator ({act_col})"

    # Attempt 3: Downstream pressure spike > 10 PSI (only if it starts near 0)
    elif (
        down_col in df.columns and df[down_col].max() > 10 and df[down_col].iloc[0] < 10
    ):
        flow_df = df[df[down_col] > 10]
        t_start = flow_df["t_s"].min()
        t_end = flow_df["t_s"].max()
        source = f"Downstream Pressure Spike ({down_col} > 10 PSI)"

    # Attempt 4: Upstream sudden drop (gradient)
    else:
        grad = np.gradient(
            df[up_col].rolling(10, min_periods=1).mean().fillna(method="bfill")
        )
        drop_idx = np.argmin(grad)
        spike_idx = np.argmax(grad)

        if df[up_col].max() > 50 and grad[drop_idx] < -1:  # significant drop
            t_start = df.iloc[drop_idx]["t_s"]
            if spike_idx > drop_idx:
                t_end = df.iloc[spike_idx]["t_s"]
            else:
                t_end = t_start + 5.0  # fallback duration
            source = f"Upstream Pressure Sudden Drop ({up_col})"

    steady_start, steady_end = None, None

    if t_start is not None and t_end is not None and t_end > t_start:
        duration = t_end - t_start
        # Buffer slightly to ensure steady state (remove first 15% and last 15% of the window)
        steady_start = t_start + duration * 0.15
        steady_end = t_end - duration * 0.15

        print(f"\n✅ Auto-detected theoretical flow window from {source}:")
        print(f"  Event Start: {t_start:.3f} s")
        print(f"  Event End:   {t_end:.3f} s")
        print(
            f"\nRecommended Steady Flow Window (15% padded to ignore transient spikes):"
        )
        print(f"  Start: {steady_start:.3f} s")
        print(f"  End:   {steady_end:.3f} s")

        ans = input("Use this steady flow window? [Y/n]: ").strip().lower()
        if ans == "" or ans == "y":
            pass
        else:
            steady_start, steady_end = None, None

    def get_float(prompt):
        while True:
            val = input(prompt).strip()
            if not val:
                continue
            try:
                return float(val)
            except ValueError:
                print("Invalid number. Please try again.")

    mass_lbs = get_float("\nEnter total mass of fluid flowed (lbs): ")
    if steady_start is None or steady_end is None:
        steady_start = get_float(f"Enter start time of steady flow (in seconds): ")
        steady_end = get_float(f"Enter end time of steady flow (in seconds): ")

    steady_df = df[(df["t_s"] >= steady_start) & (df["t_s"] <= steady_end)]
    if steady_df.empty:
        print("Error: No data in that steady window.")
        sys.exit(1)

    avg_up = steady_df[up_col].mean()
    avg_down = steady_df[down_col].mean() if down_col in steady_df.columns else 0.0

    # Calculate dP for every row across the steady window
    # If the user is venting to atmosphere, gauge pressure is the Delta P
    # (Assuming the sensor zeros to atmosphere).
    # If downstream is available and realistically lower, use Up - Down.
    # Otherwise, default to gauge upstream pressure.
    if (
        down_col in steady_df.columns
        and (steady_df[up_col] > steady_df[down_col]).all()
    ):
        print(f"\nUsing (Upstream - Downstream) for instantaneous ΔP.")
        dp_series = steady_df[up_col] - steady_df[down_col]
    else:
        print(
            f"\nUsing gauge Upstream pressure as ΔP (assuming venting to atmosphere or downstream is equivalent to 0)."
        )
        dp_series = steady_df[up_col]

    dp_series = dp_series.clip(lower=0)  # prevent negative sqrt
    avg_dp = dp_series.mean()

    print("\n" + "=" * 50)
    print(" RESULTS")
    print("=" * 50)
    print(f"Average upstream pressure ({up_col}):   {avg_up:.2f} psia")
    if down_col in steady_df.columns:
        print(f"Average downstream pressure ({down_col}): {avg_down:.2f} psia")
    print(f"Average pressure differential (ΔP): {avg_dp:.2f} psi")

    if avg_dp <= 0:
        print("\nError: Delta P is <= 0. Cannot compute Cd.")
        sys.exit(1)

    delta_t = steady_end - steady_start
    mdot = mass_lbs / delta_t
    print(f"Flow duration (Δt):        {delta_t:.2f} s")
    print(f"Mass flow rate (ṁ):        {mdot:.4f} lbm/s")

    rho_water = 0.03613
    g_c = 386.4

    print("\nAssuming test fluid is Water.")
    print(f"Default density: {rho_water:.5f} lbm/in^3  (62.43 lbm/ft^3)")
    ans = (
        input("Do you want to specify a different fluid density? (y/N): ")
        .strip()
        .lower()
    )
    rho = rho_water
    if ans == "y":
        rho = get_float("Enter fluid density in lbm/in^3: ")

    # 1. Steady State CdA
    cda_steady = mdot / np.sqrt(2 * g_c * rho * avg_dp)

    # 2. Integral Blowdown CdA
    # m = Cd A \sqrt{2 \rho} \int \sqrt{ P(t) } dt
    dt_arr = np.diff(steady_df["t_s"].values, prepend=steady_df["t_s"].values[0])
    # The first dt is 0, so we can just use the mean dt for integration if we want, or exact diffs
    integral_sqrt_dp = np.sum(np.sqrt(dp_series.values) * dt_arr)
    cda_blowdown = (
        mass_lbs / (np.sqrt(2 * g_c * rho) * integral_sqrt_dp)
        if integral_sqrt_dp > 0
        else 0
    )

    print("\n" + "-" * 50)
    print(f"Fluid Density (ρ):         {rho:.5f} lbm/in^3")
    print(f"Steady State Cd*A:         {cda_steady:.5f} in² (using average ΔP)")
    print(f"Blowdown Integral Cd*A:    {cda_blowdown:.5f} in² (using ∫√ΔP dt)")
    print("-" * 50)
    print("Use the 'Steady State Cd*A' if pressure was held relatively constant.")
    print(
        "Use the 'Blowdown Integral Cd*A' if pressure dropped rapidly as the tank emptied."
    )
    print("Done!")


if __name__ == "__main__":
    main()
