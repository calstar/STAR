#!/usr/bin/env python3
"""Plot thrust curve from CSV (time_s, thrust_N)."""
import argparse
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np


def main() -> None:
    parser = argparse.ArgumentParser(description="Plot thrust curve CSV")
    parser.add_argument(
        "input",
        type=Path,
        nargs="?",
        default=Path("output/lut/thrust_curve.csv"),
        help="Thrust curve CSV path",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=None,
        help="Save figure path (default: input with .png)",
    )
    args = parser.parse_args()

    data = np.loadtxt(args.input, delimiter=",", skiprows=1)
    time_s = data[:, 0]
    thrust_N = data[:, 1]

    fig, ax = plt.subplots(figsize=(8, 4))
    ax.plot(time_s, thrust_N, "b-", linewidth=1.5)
    ax.set_xlabel("Time [s]")
    ax.set_ylabel("Thrust [N]")
    ax.set_title("Thrust Curve (Layer 2 pressure curves)")
    ax.grid(True, alpha=0.3)
    ax.set_xlim(0, time_s[-1])
    fig.tight_layout()

    out = args.output or args.input.with_suffix(".png")
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=150)
    plt.close(fig)
    print(f"Saved {out}")


if __name__ == "__main__":
    main()
