#!/usr/bin/env python3
"""Summarize an Elodin `elodin-db export --format csv` directory for DB validation.

Checks that expected entity families exist (PT/TC/LC calibrated, actuators, controller, board HB).
Use after: FORMAT=csv ./scripts/postprocessing/export_elodin_db.sh <DB_PATH> ./export_csv

Exit codes:
  0 — export looks usable (and passes --strict checks if set)
  1 — missing export dir, no CSVs, or --strict failure
"""

from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from pathlib import Path


def _count_lines(p: Path) -> int:
    try:
        with open(p, "rb") as f:
            return sum(1 for _ in f)
    except OSError:
        return -1


def main() -> int:
    ap = argparse.ArgumentParser(description="Validate Elodin CSV export directory")
    ap.add_argument(
        "export_dir",
        type=Path,
        nargs="?",
        default=Path("./export_csv"),
        help="Directory containing flattened CSVs from elodin-db export",
    )
    ap.add_argument(
        "--strict",
        action="store_true",
        help="Fail if no calibrated PT pressure series found (typical hotfire/GSE run)",
    )
    args = ap.parse_args()
    d: Path = args.export_dir
    if not d.is_dir():
        print(f"❌ Not a directory: {d}", file=sys.stderr)
        return 1
    csvs = sorted(d.glob("*.csv"))
    if not csvs:
        print(f"❌ No *.csv in {d.resolve()}", file=sys.stderr)
        return 1

    by_prefix: dict[str, list[Path]] = defaultdict(list)
    for f in csvs:
        stem = f.stem
        prefix = stem.split(".", 1)[0] if "." in stem else stem
        by_prefix[prefix].append(f)

    print(f"📂 Export: {d.resolve()}")
    print(f"   Total CSV files: {len(csvs)}")
    print("   By entity prefix:")
    for pref in sorted(by_prefix.keys()):
        print(f"      {pref}: {len(by_prefix[pref])} file(s)")

    # Heuristic buckets (names match elodin-db flattened stems)
    pt_cal = [
        f
        for f in csvs
        if "PT" in f.name and "Cal" in f.name and "pressure_psi" in f.name
    ]
    pt_raw = [
        f
        for f in csvs
        if f.name.startswith("PT") and "Cal" not in f.name and "pressure" in f.name
    ]
    tc_cal = [f for f in csvs if "TC" in f.name and "Cal" in f.name]
    rtd_cal = [f for f in csvs if "RTD" in f.name and "Cal" in f.name]
    lc_cal = [f for f in csvs if "LC" in f.name and "Cal" in f.name]
    act_cmd = [
        f for f in csvs if "ACT_CMD" in f.name or "actuator_state_commanded" in f.name
    ]
    act_hw = [
        f
        for f in csvs
        if f.name.startswith("ACT") and "CH" in f.name and "actuator_state" in f.name
    ]
    ctrl = [f for f in csvs if f.name.startswith("CONTROLLER")]
    brd = [f for f in csvs if f.name.startswith("BOARD")]

    def rows_sample(paths: list[Path]) -> int:
        n = 0
        for p in paths[:20]:
            c = _count_lines(p)
            if c > 0:
                n += max(0, c - 1)
        return n

    print("\n   Content hints (file counts / ~data rows in first 20 files each):")
    print(
        f"      PT calibrated (PSI):  {len(pt_cal)} files, ~{rows_sample(pt_cal)} rows"
    )
    print(
        f"      PT raw:               {len(pt_raw)} files, ~{rows_sample(pt_raw)} rows"
    )
    print(f"      TC/RTD cal:           {len(tc_cal) + len(rtd_cal)} files")
    print(f"      LC cal:               {len(lc_cal)} files")
    print(f"      Actuators (CMD):      {len(act_cmd)} files")
    print(f"      Actuators (HW sense): {len(act_hw)} files")
    print(f"      CONTROLLER:           {len(ctrl)} files")
    print(f"      BOARD (HB etc.):      {len(brd)} files")

    warnings: list[str] = []
    if not pt_cal:
        warnings.append(
            "No PT*_Cal.*pressure_psi.csv — calibrated PT may be missing or export pattern changed."
        )
    if not pt_raw and not pt_cal:
        warnings.append(
            "No PT raw/cal files — check daq_bridge publish + calibration_service."
        )
    if not ctrl:
        warnings.append(
            "No CONTROLLER*.csv — controller may be off or not writing to DB."
        )
    if not act_cmd and not act_hw:
        warnings.append("No ACT* actuator_state*.csv — actuator tables may be missing.")

    if warnings:
        print("\n   ⚠️  Warnings:")
        for w in warnings:
            print(f"      - {w}")
    else:
        print("\n   ✅ Core sensor/actuator/controller families present.")

    def total_data_rows(paths: list[Path]) -> int:
        n = 0
        for p in paths:
            c = _count_lines(p)
            if c > 1:
                n += c - 1
        return n

    if args.strict:
        if not pt_cal:
            print(
                "\n❌ --strict: require at least one PT calibrated pressure CSV.",
                file=sys.stderr,
            )
            return 1
        total_pt_rows = total_data_rows(pt_cal)
        if total_pt_rows < 2:
            print(
                "\n❌ --strict: PT cal series have insufficient rows.",
                file=sys.stderr,
            )
            return 1

    print(
        "\n   Next: python scripts/postprocessing/analyze_run.py",
        d,
        "-o ./output/postprocessing/latest",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
