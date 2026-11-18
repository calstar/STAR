#!/usr/bin/env python3
"""
STAR imu_mlc — pad/idle ISM330DHCX MLC pipeline (v1 retarget).

Default: generate pad/idle synthetic data → train ONE tree
(still / handled / vibration) → export review rules + fixture .ucf / C header.

Silicon MLC program: author in MEMS Studio / Unico MLC tool, export .ucf,
then replay with firmware ism330_mlc_load (see docs/firmware-mlc-loader-sketch.md).
AN5392 Rev 5: .ucf → .h via Unico "C code generation"; MLC ODR 12.5/26/52/104.
"""

from __future__ import annotations

import argparse
import os
import sys

if sys.prefix == getattr(sys, "base_prefix", sys.prefix):
    venv_py = os.path.abspath(
        os.path.join(os.path.dirname(__file__), ".venv", "bin", "python")
    )
    if os.path.exists(venv_py) and os.path.realpath(sys.executable) != os.path.realpath(
        venv_py
    ):
        os.execv(venv_py, [venv_py] + sys.argv)

from scripts.generate_pad_idle_data import generate_pad_idle_dataset
from src.features import DEFAULT_MLC_ODR_HZ, MLC_ODR_HZ_CHOICES
from src.train_pad_mlc import format_summary, train_and_evaluate_pad_mlc

DATA_PATH = "data/pad_idle_bench.csv"
EXPORTS_DIR = "exports"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Pad/idle ISM330DHCX MLC trainer (1 tree: still/handled/vibration)."
    )
    parser.add_argument("--generate-data", action="store_true")
    parser.add_argument("--train", action="store_true")
    parser.add_argument("--evaluate", action="store_true")
    parser.add_argument("--data-file", default=DATA_PATH)
    parser.add_argument("--export-dir", default=EXPORTS_DIR)
    parser.add_argument(
        "--odr",
        type=float,
        default=DEFAULT_MLC_ODR_HZ,
        choices=list(MLC_ODR_HZ_CHOICES),
        help="MLC ODR Hz (AN5392 Table 1). Default 26.",
    )
    args = parser.parse_args()
    run_all = not (args.generate_data or args.train or args.evaluate)

    print("STAR imu_mlc — pad/idle MLC (hint only; no pyro/launch authority)")
    print(f"MLC ODR = {args.odr} Hz | target classes = still / handled / vibration")

    if args.generate_data or run_all or not os.path.exists(args.data_file):
        print(f"[*] Generating pad/idle dataset -> {args.data_file}")
        generate_pad_idle_dataset(output_path=args.data_file, odr_hz=args.odr)

    if args.train or args.evaluate or run_all:
        print("[*] Training single pad/idle tree + exporting .ucf-oriented artifacts")
        summary = train_and_evaluate_pad_mlc(
            csv_path=args.data_file,
            export_dir=args.export_dir,
            odr_hz=args.odr,
        )
        print(format_summary(summary))


if __name__ == "__main__":
    main()
