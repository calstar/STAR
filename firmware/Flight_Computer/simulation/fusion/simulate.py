"""Generate raw sensor records, run Python, and optionally compare the C replay."""

import argparse
import csv
import json
from pathlib import Path
import struct
import subprocess
import time
import numpy as np
from reference import Filter, G, FORMATS, OUTPUT, IMU, HIGHG, BARO, GNSS, mul

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
TRUTH = ROOT.parents[1] / "EngineDesign/archive/scrap_files/LE3_Flight_Data.csv"


def truth_curve(compressed=False):
    with TRUTH.open() as f:
        rows = np.array(list(csv.reader(f))[1:], dtype=float)
    factor = 0.5 if compressed else 1.0
    t = np.r_[0.0, rows[:, 0] * factor]
    return (
        t,
        np.r_[0.0, rows[:, 1] * 0.3048],
        np.r_[0.0, rows[:, 2] * 0.3048 / factor],
        np.r_[rows[0, 3], rows[:, 3]] * G / factor**2,
    )


def rotation(t):
    # Prescribed, smooth attitude for the vertical truth trajectory. The
    # CSV's Euler rates are not treated as body gyro axes without a mapping.
    angle = np.deg2rad(4) + 0.08 * np.sin(0.12 * max(0.0, t))
    yaw = 0.02 * max(0.0, t)
    return mul(
        [np.cos(yaw / 2), 0, 0, np.sin(yaw / 2)],
        [np.cos(angle / 2), 0, np.sin(angle / 2), 0],
    )


def body_force(q, az):
    w, x, y, z = q
    return np.array(
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]
    ) * (az + G)


def run_case(name, out, c_replay=None, full=False, seed=612):
    bad = name == "combined_faults"
    cold = name == "late_gps"
    pad = 2.0 if cold else 35.0
    tt, hh, vv, aa = truth_curve(bad)
    with TRUTH.open() as f:
        source = np.array(list(csv.reader(f))[1:], dtype=float)
    burnout = float(
        source[np.flatnonzero((source[:, 0] > 1) & (source[:, 28] <= 0.1))[0], 0]
    ) * (0.5 if bad else 1.0)
    end = tt[-1] if full else tt[np.argmax(hh)] + 8.0
    duration = pad + end
    rng = np.random.default_rng(seed)
    imu_t = np.arange(0, int(duration * 1e6), 1200, dtype=np.int64)
    high_t = np.arange(0, int(duration * 1e6), 2500, dtype=np.int64)
    baro_t = np.arange(10000, int(duration * 1e6), 20000, dtype=np.int64)
    gps_t = np.arange(0, int(duration * 1e6), 100000, dtype=np.int64)
    events = sorted(
        [
            (int(t), k)
            for k, ts in [(HIGHG, high_t), (IMU, imu_t), (BARO, baro_t), (GNSS, gps_t)]
            for t in ts
        ]
    )
    model = Filter()
    outputs = []
    truths = []
    previous_q = rotation(0.0)
    fixture = out / (name + ".bin")
    n = 0
    saturation = 0
    jump_count = 0
    gps_drop = 0
    started = time.perf_counter()
    with fixture.open("wb") as f:
        for us, kind in events:
            t = us * 1e-6 - pad
            h = float(np.interp(max(0.0, t), tt, hh))
            v = float(np.interp(max(0.0, t), tt, vv)) if t >= 0 else 0.0
            a = float(np.interp(max(0.0, t), tt, aa)) if t >= 0 else 0.0
            q = rotation(t)
            force = body_force(q, a)
            if kind == IMU:
                inv = previous_q * np.array([1, -1, -1, -1])
                dq = mul(inv, q)
                gyro = 2 * dq[1:] / 0.0012
                previous_q = q
                gyro += np.array([0.002, -0.001, 0.003]) + rng.normal(
                    0, np.deg2rad(0.005) * np.sqrt(833 / 2), 3
                )
                measured = force + np.array([0.0, 0.0, 0.06]) + rng.normal(0, 0.04, 3)
                raw = np.clip(np.rint(measured / (0.000488 * G)), -32768, 32767).astype(
                    int
                )
                saturation += bool(np.any(np.abs(raw) >= 32000))
                gr = np.clip(
                    np.rint(gyro / (0.140 * np.pi / 180)), -32768, 32767
                ).astype(int)
                data = struct.pack(FORMATS[kind], us, 0, *gr, *raw)
            elif kind == HIGHG:
                measured = (
                    force
                    + np.array([0.2, -0.1, 1.5 * G if bad else 0.4])
                    + rng.normal(0, 0.25, 3)
                )
                raw = np.clip(np.rint(measured / (0.780 * G)), -128, 127).astype(int)
                data = struct.pack(FORMATS[kind], us, *raw)
            elif kind == BARO:
                # Synthesized ISA pressure at the recorded geometric height;
                # independent pressure noise in Pa, rounded to the log's Pa.
                jump = 100.0 if bad and 0.85 < abs(v) / 340 < 1.15 else 0.0
                jump_count += bool(jump)
                # D1 is timestamped 10 ms before the driver delivers D2.
                stamp = max(0, us - 10000)
                oldh = float(np.interp(max(0.0, t - 0.01), tt, hh))
                p = (
                    90026.0 * (1 - (oldh + jump) / 44330.0) ** (1 / 0.19029495)
                    + 50.0
                    + rng.normal(0, 1.2)
                )
                data = struct.pack(FORMATS[kind], stamp, 2000, int(round(p)))
            else:
                fix = (
                    us >= 30000000
                    and abs(a) < 4 * G
                    and abs(v) < 500
                    and not (bad and 3.0 < t < 25.0)
                )
                gps_drop += not fix
                height = (
                    1000.0
                    + float(np.interp(max(0.0, t - 0.08), tt, hh))
                    + rng.normal(0, 3.0)
                )
                data = struct.pack(
                    FORMATS[kind],
                    us,
                    us // 1000000 * 1000000,
                    us // 1000,
                    0,
                    0,
                    int(round(height * 1000)),
                    0,
                    0,
                    int(round(-v * 1000)),
                    2000,
                    3000,
                    100,
                    3 if fix else 0,
                    10 if fix else 0,
                    1 if fix else 0,
                )
            f.write(bytes([kind, len(data)]))
            f.write(data)
            n += 1
            result = model.feed(kind, data)
            if result is not None:
                outputs.append(result)
                truths.append((t, h, v, a, *q))
    est = np.array(outputs)
    truth = np.array(truths)
    active = truth[:, 0] >= 0
    herror = est[:, 1] - truth[:, 1]
    verror = est[:, 2] - truth[:, 2]
    qdot = np.abs(np.sum(est[:, 5:9] * truth[:, 4:8], axis=1))
    attitude = 2 * np.arccos(np.clip(qdot, 0, 1)) * 180 / np.pi
    apogee = float(tt[np.argmax(hh)])
    crossings = np.flatnonzero(
        (est[:-1, 2] > 0) & (est[1:, 2] <= 0) & (est[1:, 1] > 100) & (truth[1:, 0] > 0)
    )
    detection = float(truth[crossings[0] + 1, 0]) if len(crossings) else None
    peak = np.argmin(np.abs(truth[:, 0] - apogee))
    metrics = {
        "seed": seed,
        "records": n,
        "output_records": len(est),
        "duration_s": duration,
        "max_altitude_error_m": float(np.max(np.abs(herror[active]))),
        "rms_altitude_error_m": float(np.sqrt(np.mean(herror[active] ** 2))),
        "max_velocity_error_mps": float(np.max(np.abs(verror[active]))),
        "apogee_altitude_error_m": float(herror[peak]),
        "burnout_s": burnout,
        "burnout_altitude_error_m": float(
            herror[np.argmin(np.abs(truth[:, 0] - burnout))]
        ),
        "true_apogee_s": apogee,
        "detected_apogee_s": detection,
        "apogee_time_error_s": None if detection is None else detection - apogee,
        "max_attitude_error_deg": float(np.max(attitude[active])),
        "imu_saturated_samples": saturation,
        "highg_used_samples": model.highg_uses,
        "baro_fault_samples": jump_count,
        "baro_rejections": model.baro_rejections,
        "gps_no_fix_samples": gps_drop,
        "gps_origin_established": model.gnss_origin is not None,
        "python_runtime_s": time.perf_counter() - started,
    }
    metrics["provisional_targets_pass"] = bool(
        metrics["max_altitude_error_m"] < 5
        and detection is not None
        and abs(detection - apogee) < 0.5
    )
    if c_replay:
        result = subprocess.run(
            [
                str(c_replay),
                str(fixture),
                str(out / (name + ".c.bin")),
                "16",
                "4000",
                "1",
                "2",
                "3",
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        blob = (out / (name + ".c.bin")).read_bytes()
        c = np.array(list(struct.iter_unpack(OUTPUT, blob)))
        if c.shape != est.shape:
            raise AssertionError(f"C/Python output shapes {c.shape} != {est.shape}")
        np.testing.assert_array_equal(c[:, [0, 11, 12]], est[:, [0, 11, 12]])
        errors = np.max(np.abs(c[:, 1:11] - est[:, 1:11]), axis=0)
        # Float32 firmware vs independent NumPy float64 reference, same records.
        limits = np.array(
            [0.01, 0.01, 0.01, 0.01, 0.002, 0.002, 0.002, 0.002, 0.002, 0.002]
        )
        if np.any(errors > limits):
            raise AssertionError(f"C/Python mismatch {errors}")
        metrics["c_python_max_abs_errors"] = errors.tolist()
        metrics["c_replay"] = result.stderr.strip()
    np.savez_compressed(out / (name + ".npz"), estimate=est, truth=truth)
    plot(name, out, est, truth, herror, verror, attitude, apogee, burnout)
    return metrics


def plot(name, out, est, truth, he, ve, attitude, apogee, burnout):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(3, 2, figsize=(12, 10), sharex=True)
    t = truth[:, 0]
    for ax, index, title in [
        (axes[0, 0], 1, "Altitude (m)"),
        (axes[1, 0], 2, "Vertical velocity (m/s)"),
        (axes[2, 0], 3, "Vertical acceleration (m/s²)"),
    ]:
        ax.plot(t, truth[:, index], label="Truth", lw=1.4)
        ax.plot(t, est[:, index], label="Estimate", lw=0.8, alpha=0.8)
        ax.set_ylabel(title)
    axes[0, 1].plot(t, he)
    axes[0, 1].set_ylabel("Altitude error (m)")
    axes[0, 1].axhline(5, color="red", ls=":")
    axes[0, 1].axhline(-5, color="red", ls=":")
    axes[1, 1].plot(t, ve)
    axes[1, 1].set_ylabel("Velocity error (m/s)")
    axes[2, 1].plot(t, attitude)
    axes[2, 1].set_ylabel("Attitude error (degrees)")
    for ax in axes.flat:
        ax.axvline(apogee, color="grey", ls="--", lw=0.8)
        ax.axvline(burnout, color="orange", ls=":", lw=0.8)
        ax.grid(alpha=0.2)
        ax.set_xlim(0, max(t))
    axes[0, 0].legend()
    axes[2, 0].set_xlabel("Time from launch (s)")
    axes[2, 1].set_xlabel("Time from launch (s)")
    fig.suptitle(name.replace("_", " ") + " • dashed line: true apogee")
    fig.tight_layout()
    fig.savefig(out / (name + ".png"), dpi=160)
    for ax in axes.flat:
        ax.set_xlim(0, apogee + 3)
    fig.savefig(out / (name + "_ascent.png"), dpi=160)
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=HERE / "output")
    ap.add_argument("--c-replay", type=Path)
    ap.add_argument("--full", action="store_true")
    ap.add_argument("--case", choices=["nominal", "combined_faults", "late_gps"])
    ap.add_argument("--seed", type=int, default=612)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    metrics = {}
    for name in (
        [args.case] if args.case else ["nominal", "combined_faults", "late_gps"]
    ):
        metrics[name] = run_case(name, args.out, args.c_replay, args.full, args.seed)
        print(name, json.dumps(metrics[name]), flush=True)
    (args.out / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")
    if not all(m["provisional_targets_pass"] for m in metrics.values()):
        raise SystemExit("FAIL: provisional altitude/apogee targets")


if __name__ == "__main__":
    main()
