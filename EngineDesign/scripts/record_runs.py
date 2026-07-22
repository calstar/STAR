#!/usr/bin/env python3
"""Emit one JSONL row per config: git provenance + resolved-config hash + evaluated metrics.

Intended primary caller is CI on push to main, appending to the ``metrics/engine-design`` orphan
branch. The name is namespaced because this is a monorepo -- an unscoped ``metrics`` branch would
claim the name for every subproject, and git refs cannot have both a file and a directory at one
path, so a plain ``metrics`` branch would permanently block ``metrics/<anything>``.

Local use is fine for before/after comparisons, but local rows carry ``git_dirty: true`` and are
NOT a baseline -- they cannot be reproduced from a commit alone. See ``engine/pipeline/run_record.py``.

Usage:
    py -3.13 scripts/record_runs.py                     # rows to stdout
    py -3.13 scripts/record_runs.py --out runs.jsonl    # append to a file
    py -3.13 scripts/record_runs.py --config canonical/impinging.yaml
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.pipeline.run_record import build_row  # noqa: E402


def discover_configs() -> list[Path]:
    cfg_root = ROOT / "configs"
    return sorted(cfg_root.glob("*.yaml")) + sorted(cfg_root.glob("canonical/*.yaml"))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=None,
                    help="append JSONL here (default: stdout)")
    ap.add_argument("--config", action="append", default=None,
                    help="config path relative to configs/ (repeatable; default: all)")
    ap.add_argument("--skip-non-engine", action="store_true",
                    help="omit rows for yamls without a thrust target instead of recording them")
    args = ap.parse_args()

    if args.config:
        paths = [ROOT / "configs" / c for c in args.config]
        missing = [p for p in paths if not p.exists()]
        if missing:
            print(f"no such config(s): {[str(p) for p in missing]}", file=sys.stderr)
            return 2
    else:
        paths = discover_configs()

    # One instant for the whole batch so rows from a single invocation group cleanly.
    timestamp = _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")

    cwd = os.getcwd()
    os.chdir(ROOT)   # config loading resolves cache/preset paths relative to the project root
    try:
        rows = [build_row(p, ROOT, timestamp=timestamp) for p in paths]
    finally:
        os.chdir(cwd)

    if args.skip_non_engine:
        rows = [r for r in rows if r["kind"] != "not_engine"]

    lines = "".join(json.dumps(r, sort_keys=True) + "\n" for r in rows)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        with open(args.out, "a", encoding="utf-8") as fh:   # append-only: never rewrite history
            fh.write(lines)
        checked = sum(1 for r in rows if r["kind"] == "checked")
        passed = sum(1 for r in rows if r.get("gates_passed"))
        print(f"appended {len(rows)} row(s) to {args.out} ({checked} evaluated, {passed} passing gates)",
              file=sys.stderr)
    else:
        sys.stdout.write(lines)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
