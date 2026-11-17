#!/usr/bin/env python3
"""
Synthetic pad/idle IMU logs for STAR ISM330DHCX MLC v1.

Classes (AN5392 supervised-learning style — one log family per class):
  still      — near-static 1 g, low noise
  handled    — slow carry / orientation drift, moderate low-freq motion
  vibration  — higher-frequency shaking (bench / transport vibe)

Sampled at MLC ODR (default 26 Hz), accel in g at firmware ±16 g scale.
No magnetometer (ISM330DHCX is 6-DOF; external mag hub is out of scope for v1).
No flight phases / chute / abort labels.

Prefer replacing this with labelled bench logs from the flight computer before silicon tune.
See AN5392 Rev 5 §2: log at the chosen MLC ODR when known.
"""

from __future__ import annotations

import argparse
import os
import sys

import numpy as np
import pandas as pd

# Allow `python scripts/...` from package root.
_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from src.features import DEFAULT_MLC_ODR_HZ, MLC_ODR_HZ_CHOICES  # noqa: E402


def _segment(
    rng: np.random.Generator,
    label: str,
    duration_s: float,
    odr_hz: float,
) -> pd.DataFrame:
    n = int(round(duration_s * odr_hz))
    t = np.arange(n, dtype=float) / odr_hz
    accel_x = np.zeros(n)
    accel_y = np.zeros(n)
    accel_z = np.zeros(n)
    gyro_x = np.zeros(n)
    gyro_y = np.zeros(n)
    gyro_z = np.zeros(n)

    if label == "still":
        accel_x[:] = rng.normal(0.0, 0.004, n)
        accel_y[:] = rng.normal(0.0, 0.004, n)
        accel_z[:] = 1.0 + rng.normal(0.0, 0.006, n)
        gyro_x[:] = rng.normal(0.0, 0.15, n)
        gyro_y[:] = rng.normal(0.0, 0.15, n)
        gyro_z[:] = rng.normal(0.0, 0.15, n)
    elif label == "handled":
        # Slow pendulum-like carry (~0.4–0.8 Hz) + mild tilt wander.
        w = 2.0 * np.pi * 0.55
        accel_x[:] = 0.12 * np.sin(w * t) + rng.normal(0.0, 0.02, n)
        accel_y[:] = 0.09 * np.cos(0.7 * w * t) + rng.normal(0.0, 0.02, n)
        accel_z[:] = 0.98 + 0.08 * np.sin(0.5 * w * t) + rng.normal(0.0, 0.025, n)
        gyro_x[:] = 18.0 * np.cos(w * t) + rng.normal(0.0, 2.0, n)
        gyro_y[:] = 14.0 * np.sin(w * t) + rng.normal(0.0, 2.0, n)
        gyro_z[:] = 6.0 * np.sin(0.3 * w * t) + rng.normal(0.0, 1.5, n)
    elif label == "vibration":
        # Broadband-ish shake around a few Hz (well below 833 Hz sensor ODR).
        w1 = 2.0 * np.pi * 8.0
        w2 = 2.0 * np.pi * 13.0
        accel_x[:] = (
            0.35 * np.sin(w1 * t) + 0.2 * np.sin(w2 * t) + rng.normal(0.0, 0.08, n)
        )
        accel_y[:] = (
            0.30 * np.cos(w1 * t)
            + 0.15 * np.sin(1.3 * w2 * t)
            + rng.normal(0.0, 0.08, n)
        )
        accel_z[:] = 1.0 + 0.45 * np.sin(w2 * t) + rng.normal(0.0, 0.10, n)
        gyro_x[:] = 60.0 * np.sin(w1 * t) + rng.normal(0.0, 8.0, n)
        gyro_y[:] = 55.0 * np.cos(w2 * t) + rng.normal(0.0, 8.0, n)
        gyro_z[:] = 25.0 * np.sin(0.5 * w1 * t) + rng.normal(0.0, 5.0, n)
    else:
        raise ValueError(label)

    return pd.DataFrame(
        {
            "timestamp": np.round(t, 6),
            "accel_x": np.round(accel_x, 5),
            "accel_y": np.round(accel_y, 5),
            "accel_z": np.round(accel_z, 5),
            "gyro_x": np.round(gyro_x, 4),
            "gyro_y": np.round(gyro_y, 4),
            "gyro_z": np.round(gyro_z, 4),
            "pad_class": label,
        }
    )


def generate_pad_idle_dataset(
    output_path: str = "data/pad_idle_bench.csv",
    odr_hz: float = DEFAULT_MLC_ODR_HZ,
    seconds_per_class: float = 120.0,
    seed: int = 7,
) -> pd.DataFrame:
    if odr_hz not in MLC_ODR_HZ_CHOICES:
        raise ValueError(f"odr_hz must be one of {MLC_ODR_HZ_CHOICES}")
    rng = np.random.default_rng(seed)
    parts = []
    t0 = 0.0
    for label in ("still", "handled", "vibration"):
        # Three takes per class (AN5392: multiple logs per class).
        for take in range(3):
            df = _segment(rng, label, seconds_per_class / 3.0, odr_hz)
            df["timestamp"] = np.round(df["timestamp"] + t0, 6)
            df["take_id"] = take + 1
            t0 = float(df["timestamp"].iloc[-1]) + (1.0 / odr_hz)
            parts.append(df)
    out = pd.concat(parts, ignore_index=True)
    os.makedirs(os.path.dirname(os.path.abspath(output_path)) or ".", exist_ok=True)
    out.to_csv(output_path, index=False)
    print(f"Wrote {len(out)} samples @ {odr_hz} Hz -> {output_path}")
    print(out["pad_class"].value_counts().to_string())
    return out


def main() -> None:
    p = argparse.ArgumentParser(
        description="Generate synthetic pad/idle IMU CSV for MLC training."
    )
    p.add_argument("--output", default="data/pad_idle_bench.csv")
    p.add_argument(
        "--odr",
        type=float,
        default=DEFAULT_MLC_ODR_HZ,
        choices=list(MLC_ODR_HZ_CHOICES),
    )
    p.add_argument("--seconds-per-class", type=float, default=120.0)
    p.add_argument("--seed", type=int, default=7)
    args = p.parse_args()
    generate_pad_idle_dataset(args.output, args.odr, args.seconds_per_class, args.seed)


if __name__ == "__main__":
    main()
