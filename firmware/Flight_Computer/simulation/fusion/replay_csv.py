"""Replay FlightComputer-GUI live CSV exports without inventing lost samples."""

import argparse
import csv
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import numpy as np
from reference import Filter, FORMATS, OUTPUT, IMU, HIGHG, BARO, GNSS, G


def convert(path, accel_fs=16, gyro_fs=4000):
    records = []
    with path.open() as f:
        for row in csv.DictReader(f):
            kind = row["sensor"]
            if kind not in ("imu", "highg", "baro", "gnss"):
                continue

            def value(key, scale=1.0):
                return round(float(row[key]) * scale)

            t = value(kind + "_t_us")
            if kind == "imu":
                r = (
                    t,
                    value("imu_temp_c", 256) - 25 * 256,
                    *(
                        value("imu_g" + axis + "_dps", 1 / (gyro_fs * 0.000035))
                        for axis in "xyz"
                    ),
                    *(
                        value("imu_a" + axis + "_g", 1 / (accel_fs * 0.0000305))
                        for axis in "xyz"
                    ),
                )
                k = IMU
            elif kind == "highg":
                r = (t, *(value("highg_a" + axis + "_g", 1 / 0.780) for axis in "xyz"))
                k = HIGHG
            elif kind == "baro":
                r = (t, value("baro_temp_c", 100), value("baro_pressure_pa"))
                k = BARO
            else:
                r = (
                    t,
                    value("gnss_pps_us"),
                    value("gnss_itow_ms"),
                    value("gnss_lat_deg", 1e7),
                    value("gnss_lon_deg", 1e7),
                    value("gnss_hmsl_m", 1000),
                    *(
                        value("gnss_vel_" + axis + "_ms", 1000)
                        for axis in ["n", "e", "d"]
                    ),
                    value("gnss_hacc_m", 1000),
                    value("gnss_vacc_m", 1000),
                    value("gnss_pdop", 100),
                    value("gnss_fix_type"),
                    value("gnss_num_sv"),
                    value("gnss_flags"),
                )
                k = GNSS
            records.append((k, struct.pack(FORMATS[k], *r)))
    return records


def replay(path, out, c_replay, accel_fs, gyro_fs, highg_axes=None):
    records = convert(path, accel_fs, gyro_fs)
    binary = out / (path.stem + ".records.bin")
    with binary.open("wb") as f:
        for k, data in records:
            f.write(bytes([k, len(data)]) + data)
    model = Filter(
        accel_fs * 0.0000305 * G,
        gyro_fs * 0.000035 * np.pi / 180,
        highg_axes=highg_axes,
    )
    estimates = []
    stamps = []
    pressure = []
    counts = {}
    for k, data in records:
        counts[str(k)] = counts.get(str(k), 0) + 1
        if k == IMU:
            stamps.append(struct.unpack_from("<I", data)[0])
        if k == BARO:
            pressure.append(struct.unpack(FORMATS[k], data))
        r = model.feed(k, data)
        if r is not None:
            estimates.append(r)
    c_out = out / (path.stem + ".c.bin")
    subprocess.run(
        [str(c_replay), str(binary), str(c_out), str(accel_fs), str(gyro_fs)]
        + ([str(a) for a in highg_axes] if highg_axes is not None else []),
        check=True,
    )
    actual = list(struct.iter_unpack(OUTPUT, c_out.read_bytes()))
    if estimates:
        np.testing.assert_allclose(
            np.array(actual)[:, 1:11],
            np.array(estimates)[:, 1:11],
            atol=0.01,
            rtol=0.001,
        )
        np.testing.assert_array_equal(
            np.array(actual)[:, [0, 11, 12]], np.array(estimates)[:, [0, 11, 12]]
        )
    elif actual:
        raise AssertionError("C initialized when Python did not")
    gaps = np.diff(np.array(stamps, dtype=np.int64)) % 2**32 * 1e-6
    metrics = {
        "source": str(path),
        "highg_axes": highg_axes,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "records_by_type": counts,
        "imu_samples": len(stamps),
        "duration_s": float(np.sum(gaps)),
        "median_imu_gap_s": float(np.median(gaps)),
        "max_imu_gap_s": float(np.max(gaps)),
        "gaps_over_50ms": int(np.sum(gaps > 0.05)),
        "python_outputs": len(estimates),
        "c_outputs": len(actual),
        "comparison": "C/Python agree; no resampling or invented measurements",
        "accuracy_verdict": "NOT VALIDATED: no known-height truth or full-rate inertial stream",
    }
    p = np.array(pressure, dtype=float)
    if len(p):
        heights = 44330 * (1 - (p[:, 2] / p[0, 2]) ** 0.19029495)
        metrics["barometric_relative_height_range_m"] = [
            float(min(heights)),
            float(max(heights)),
        ]
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        fig, ax = plt.subplots(figsize=(9, 3))
        ax.plot((p[:, 0] - p[0, 0]) * 1e-6, heights, "o-")
        ax.set(
            xlabel="Elapsed sensor time (s)",
            ylabel="Pressure altitude change (m)",
            title=path.name + " · raw barometer only; no reference height",
        )
        ax.grid(alpha=0.2)
        fig.tight_layout()
        fig.savefig(out / (path.stem + ".png"), dpi=160)
        plt.close(fig)
    return metrics


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--c-replay", type=Path, required=True)
    ap.add_argument("--accel-fs-g", type=int, choices=[2, 4, 8, 16], required=True)
    ap.add_argument(
        "--gyro-fs-dps",
        type=int,
        choices=[125, 250, 500, 1000, 2000, 4000],
        required=True,
    )
    ap.add_argument(
        "--highg-axes",
        nargs=3,
        type=int,
        help="verified signed permutation; omitted disables fallback",
    )
    a = ap.parse_args()
    if a.highg_axes is not None and sorted(abs(v) for v in a.highg_axes) != [1, 2, 3]:
        ap.error("--highg-axes must be a signed permutation of 1, 2, 3")
    a.out.mkdir(parents=True, exist_ok=True)
    results = {
        p.name: replay(p, a.out, a.c_replay, a.accel_fs_g, a.gyro_fs_dps, a.highg_axes)
        for p in a.csv
    }
    (a.out / "real_replay.json").write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
