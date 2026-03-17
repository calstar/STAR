#!/usr/bin/env python3
"""
Plot controller LUT as heatmaps and slices.
Produces a multi-panel figure showing F, duty_F, duty_O over the pressure/thrust grid.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np


def load_lut(npz_path: Path) -> dict:
    """Load LUT from .npz, return dict with axes and data arrays."""
    data = np.load(npz_path, allow_pickle=True)
    meta_raw = data["meta"].tolist()
    meta = json.loads(meta_raw)
    axes_meta = meta.get("axes", [])

    axes = {}
    for ax in axes_meta:
        name = ax["name"]
        key = f"axes/{name}"
        axes[name] = np.asarray(data[key], dtype=np.float64)

    outputs = {}
    for out_name in meta.get("outputs", []):
        key = f"data/{out_name}"
        if key in data:
            outputs[out_name] = np.asarray(data[key], dtype=np.float64)

    return {"axes": axes, "outputs": outputs, "meta": meta}


def plot_policy_lut(lut: dict, out_path: Path) -> None:
    """Create multi-panel plot for 4D policy LUT (P_u_fuel, P_u_ox, thrust_desired, MR_ref)."""
    axes = lut["axes"]
    outputs = lut["outputs"]

    P_fuel = axes["P_u_fuel"] / 1e6  # MPa
    P_ox = axes["P_u_ox"] / 1e6
    thrust = axes["thrust_desired"]
    MR_ref = axes["MR_ref"]

    # Use MR_ref index 1 (middle, ~2.2)
    mr_idx = len(MR_ref) // 2

    n_thrust = len(thrust)
    n_cols = 3
    n_rows = (n_thrust + n_cols - 1) // n_cols
    fig, axes_plt = plt.subplots(
        n_rows, n_cols, figsize=(5 * n_cols, 4 * n_rows), sharex=True, sharey=True
    )
    axes_plt = np.atleast_2d(axes_plt).flatten()

    # F (thrust) heatmaps for each thrust_desired
    for i, t_val in enumerate(thrust):
        ax = axes_plt[i]
        F_slice = outputs["F"][:, :, i, mr_idx]
        im = ax.pcolormesh(
            P_fuel,
            P_ox,
            F_slice.T,
            cmap="viridis",
            shading="auto",
            vmin=0,
            vmax=np.nanmax(outputs["F"]) if np.any(np.isfinite(outputs["F"])) else 7000,
        )
        ax.set_title(f"F @ thrust_des={t_val:.0f} N, MR_ref={MR_ref[mr_idx]:.1f}")
        ax.set_xlabel("P_u_fuel (MPa)")
        ax.set_ylabel("P_u_ox (MPa)")
        ax.set_aspect("equal")
        plt.colorbar(im, ax=ax, label="F (N)")

    for j in range(n_thrust, len(axes_plt)):
        axes_plt[j].set_visible(False)
    plt.suptitle("Controller LUT: Thrust (F) vs tank pressures", fontsize=12, y=1.02)
    plt.tight_layout()
    fig.savefig(out_path.with_suffix(".thrust.png"), dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"Saved {out_path.with_suffix('.thrust.png')}")

    # Duty cycle heatmaps
    fig2, axes2 = plt.subplots(
        n_rows, n_cols, figsize=(5 * n_cols, 4 * n_rows), sharex=True, sharey=True
    )
    axes2 = np.atleast_2d(axes2).flatten()

    for i, t_val in enumerate(thrust):
        ax = axes2[i]
        duty_F = outputs["duty_F"][:, :, i, mr_idx]
        duty_O = outputs["duty_O"][:, :, i, mr_idx]
        # Combined or show duty_F
        im = ax.pcolormesh(
            P_fuel,
            P_ox,
            duty_F.T,
            cmap="plasma",
            shading="auto",
            vmin=0,
            vmax=1,
        )
        ax.set_title(f"duty_F @ thrust_des={t_val:.0f} N")
        ax.set_xlabel("P_u_fuel (MPa)")
        ax.set_ylabel("P_u_ox (MPa)")
        ax.set_aspect("equal")
        plt.colorbar(im, ax=ax, label="duty_F")

    for j in range(n_thrust, len(axes2)):
        axes2[j].set_visible(False)
    plt.suptitle(
        "Controller LUT: Fuel duty cycle vs tank pressures", fontsize=12, y=1.02
    )
    plt.tight_layout()
    fig2.savefig(out_path.with_suffix(".duty_fuel.png"), dpi=150, bbox_inches="tight")
    plt.close(fig2)
    print(f"Saved {out_path.with_suffix('.duty_fuel.png')}")

    # MR_ref sweep: one thrust level, all MR_ref
    n_mr = len(MR_ref)
    t_idx = min(5, n_thrust - 1)  # 6000 N or last if fewer
    fig3, axes3 = plt.subplots(1, n_mr, figsize=(4 * n_mr, 4), sharex=True, sharey=True)
    axes3 = np.atleast_1d(axes3)
    for j, mr_val in enumerate(MR_ref):
        ax = axes3[j]
        F_slice = outputs["F"][:, :, t_idx, j]
        im = ax.pcolormesh(
            P_fuel,
            P_ox,
            F_slice.T,
            cmap="viridis",
            shading="auto",
            vmin=0,
            vmax=np.nanmax(outputs["F"]),
        )
        ax.set_title(f"F @ thrust_des={thrust[t_idx]:.0f} N, MR_ref={mr_val:.1f}")
        ax.set_xlabel("P_u_fuel (MPa)")
        ax.set_ylabel("P_u_ox (MPa)")
        ax.set_aspect("equal")
        plt.colorbar(im, ax=ax, label="F (N)")

    plt.suptitle(
        f"Controller LUT: Thrust vs MR_ref (thrust_desired={thrust[t_idx]:.0f} N)",
        fontsize=12,
        y=1.02,
    )
    plt.tight_layout()
    fig3.savefig(out_path.with_suffix(".mr_sweep.png"), dpi=150, bbox_inches="tight")
    plt.close(fig3)
    print(f"Saved {out_path.with_suffix('.mr_sweep.png')}")


def plot_engine_lut(lut: dict, out_path: Path) -> None:
    """Plot 2D engine LUT (P_u_fuel, P_u_ox)."""
    axes = lut["axes"]
    outputs = lut["outputs"]

    P_fuel = axes["P_u_fuel"] / 1e6
    P_ox = axes["P_u_ox"] / 1e6

    fig, axes_plt = plt.subplots(2, 2, figsize=(10, 9), sharex=True, sharey=True)

    # F
    ax = axes_plt[0, 0]
    F = outputs["F"]
    im = ax.pcolormesh(P_fuel, P_ox, F.T, cmap="viridis", shading="auto")
    ax.set_title("Thrust F (N)")
    ax.set_xlabel("P_u_fuel (MPa)")
    ax.set_ylabel("P_u_ox (MPa)")
    plt.colorbar(im, ax=ax)

    # MR
    ax = axes_plt[0, 1]
    MR = outputs["MR"]
    im = ax.pcolormesh(P_fuel, P_ox, MR.T, cmap="coolwarm", shading="auto")
    ax.set_title("Mixture ratio MR")
    ax.set_xlabel("P_u_fuel (MPa)")
    ax.set_ylabel("P_u_ox (MPa)")
    plt.colorbar(im, ax=ax)

    # P_ch if present
    if "P_ch" in outputs:
        ax = axes_plt[1, 0]
        Pc = outputs["P_ch"] / 1e6
        im = ax.pcolormesh(P_fuel, P_ox, Pc.T, cmap="magma", shading="auto")
        ax.set_title("Chamber pressure (MPa)")
        ax.set_xlabel("P_u_fuel (MPa)")
        ax.set_ylabel("P_u_ox (MPa)")
        plt.colorbar(im, ax=ax)

    # stability_score if present
    if "stability_score" in outputs:
        ax = axes_plt[1, 1]
        stab = outputs["stability_score"]
        im = ax.pcolormesh(
            P_fuel, P_ox, stab.T, cmap="RdYlGn", shading="auto", vmin=0, vmax=1
        )
        ax.set_title("Stability score")
        ax.set_xlabel("P_u_fuel (MPa)")
        ax.set_ylabel("P_u_ox (MPa)")
        plt.colorbar(im, ax=ax)

    plt.suptitle("Engine LUT: Performance vs tank pressures", fontsize=12, y=1.02)
    plt.tight_layout()
    png_path = out_path.with_suffix(".png") if out_path.suffix != ".png" else out_path
    fig.savefig(png_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"Saved {png_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Plot controller/engine LUT")
    parser.add_argument(
        "--input",
        "-i",
        type=Path,
        default=Path("output/lut/controller_policy_fsw.npz"),
        help="Input .npz LUT path",
    )
    parser.add_argument(
        "--output",
        "-o",
        type=Path,
        default=None,
        help="Output plot path (default: same as input with .png)",
    )
    parser.add_argument(
        "--engine",
        action="store_true",
        help="Plot engine LUT (2D) instead of policy LUT (4D)",
    )
    args = parser.parse_args()

    in_path = args.input.resolve()
    if not in_path.exists():
        raise FileNotFoundError(f"LUT not found: {in_path}")

    out_path = args.output or in_path.with_suffix(".plots")
    out_path = out_path.resolve()

    lut = load_lut(in_path)

    if args.engine or "thrust_desired" not in lut["axes"]:
        plot_engine_lut(lut, out_path)
    else:
        plot_policy_lut(lut, out_path)


if __name__ == "__main__":
    main()
