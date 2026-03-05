#!/usr/bin/env python3
"""
Post-process a single Elodin DB run.

Responsibilities:
- Resolve DB path from a DB name (under ~/.local/share/elodin) or explicit path.
- Create a per-run output folder under scripts/postprocessing/output/<DB_NAME>/.
- Export key tables from Elodin DB to CSV using `elodin-db export`.
- Emit a minimal run summary (timestamps, row counts per table) as JSON.

Usage:
  ./postprocess_run.py --db-name daq_20260304_123456
  ./postprocess_run.py --db-path ~/.local/share/elodin/daq_20260304_123456

You can extend this script with more domain-specific analysis/plots as needed.
"""

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parents[2]
POSTPROC_ROOT = ROOT / "scripts" / "postprocessing"
DEFAULT_DB_ROOT = Path(
    os.environ.get("ELODIN_DB_ROOT", Path.home() / ".local" / "share" / "elodin")
)

try:
    import matplotlib.pyplot as plt  # type: ignore[import-not-found]
except Exception:  # pragma: no cover - optional dependency
    plt = None  # type: ignore[assignment]


def run_cmd(
    cmd: List[str], capture: bool = False, check: bool = True
) -> subprocess.CompletedProcess:
    if capture:
        return subprocess.run(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=check
        )
    return subprocess.run(cmd, check=check)


def resolve_db_path(db_name: Optional[str], db_path: Optional[str]) -> Path:
    if db_path:
        p = Path(os.path.expanduser(db_path)).resolve()
        if not p.exists():
            raise SystemExit(f"DB path does not exist: {p}")
        return p
    if not db_name:
        raise SystemExit("Either --db-name or --db-path is required.")
    p = (DEFAULT_DB_ROOT / db_name).expanduser()
    if not p.exists():
        raise SystemExit(f"Resolved DB path does not exist: {p}")
    return p


def get_db_name_from_path(db_path: Path) -> str:
    return db_path.name


def ensure_output_dir(db_name: str) -> Path:
    out_dir = POSTPROC_ROOT / "output" / db_name
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


def list_tables(db_path: Path) -> List[str]:
    try:
        proc = run_cmd(["elodin-db", "list", str(db_path)], capture=True)
    except subprocess.CalledProcessError as e:
        sys.stderr.write(
            f"[postprocess] Failed to list tables for {db_path}: {e.stderr}\n"
        )
        raise

    tables: List[str] = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # Simple heuristic: treat each non-empty line as a table name
        tables.append(line.split()[0])
    return tables


def export_table(db_path: Path, table: str, out_csv: Path) -> int:
    try:
        proc = run_cmd(["elodin-db", "export", str(db_path), table], capture=True)
    except subprocess.CalledProcessError as e:
        sys.stderr.write(f"[postprocess] Failed to export table {table}: {e.stderr}\n")
        return 0

    text = proc.stdout
    if not text:
        return 0

    out_csv.parent.mkdir(parents=True, exist_ok=True)
    out_csv.write_text(text)

    # Cheap row count (minus header)
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        return 0
    return max(len(lines) - 1, 0)


def copy_metadata(db_path: Path, out_dir: Path) -> None:
    meta_src = Path(str(db_path) + "_metadata")
    if not meta_src.exists():
        return
    meta_dst = out_dir / "_metadata"
    if meta_dst.exists():
        shutil.rmtree(meta_dst)
    shutil.copytree(meta_src, meta_dst)


def _detect_time_and_numeric_columns(
    headers: List[str], rows: List[dict]
) -> Tuple[Optional[str], List[str]]:
    """Return (time_column, numeric_columns) based on simple heuristics."""
    lowered = [h.lower() for h in headers]
    time_candidates = [
        h
        for h, low in zip(headers, lowered)
        if "time" in low or "timestamp" in low or low.endswith("_ns")
    ]
    time_col: Optional[str] = time_candidates[0] if time_candidates else None

    numeric_cols: List[str] = []
    for h in headers:
        if h == time_col:
            continue
        ok = 0
        total = 0
        for r in rows:
            val = r.get(h, "")
            if val == "" or val is None:
                continue
            total += 1
            try:
                float(val)
                ok += 1
            except Exception:
                pass
            if total >= 50:
                break
        if total > 0 and ok / total >= 0.8:
            numeric_cols.append(h)
    return time_col, numeric_cols


def generate_basic_plots(
    out_dir: Path, table_rows: Dict[str, int]
) -> Dict[str, Dict[str, str]]:
    """
    For each CSV in out_dir, generate simple time-series plots:
    - X axis: detected time/timestamp column (if any)
    - Y axis: each numeric column

    Returns a mapping: {table: {column: relative_plot_path}}
    """
    if plt is None:
        sys.stderr.write(
            "[postprocess] matplotlib not available; skipping plot generation.\n"
        )
        return {}

    plots_root = out_dir / "plots"
    plots_root.mkdir(parents=True, exist_ok=True)

    plots_index: Dict[str, Dict[str, str]] = {}

    for csv_path in sorted(out_dir.glob("*.csv")):
        table = csv_path.stem
        if table_rows.get(table, 0) <= 0:
            continue

        with csv_path.open("r", encoding="utf-8") as f:
            import csv as _csv

            reader = _csv.DictReader(f)
            rows = []
            for i, row in enumerate(reader):
                rows.append(row)
                if i >= 5000:  # avoid huge memory usage
                    break

        if not rows:
            continue

        headers = list(rows[0].keys())
        time_col, numeric_cols = _detect_time_and_numeric_columns(headers, rows)
        if not time_col or not numeric_cols:
            continue

        # Convert time column; if it's in ns, turn into seconds relative to first sample.
        xs_raw: List[float] = []
        for r in rows:
            val = r.get(time_col, "")
            if val == "" or val is None:
                continue
            try:
                xs_raw.append(float(val))
            except Exception:
                xs_raw.append(math.nan)

        if not xs_raw:
            continue

        # Normalize time to seconds from start to keep axes readable.
        base = xs_raw[0]
        scale = 1.0
        if any(str(time_col).lower().endswith(suffix) for suffix in ("_ns", "ns")):
            scale = 1e-9

        xs = [(x - base) * scale for x in xs_raw]

        # Downsample to at most ~2000 points to keep plots light.
        step = max(1, len(xs) // 2000)

        for col in numeric_cols:
            ys: List[float] = []
            for r in rows:
                val = r.get(col, "")
                if val == "" or val is None:
                    ys.append(math.nan)
                    continue
                try:
                    ys.append(float(val))
                except Exception:
                    ys.append(math.nan)

            if not any(not math.isnan(v) for v in ys):
                continue

            xs_ds = xs[::step]
            ys_ds = ys[::step]

            plt.figure(figsize=(10, 4))
            plt.plot(xs_ds, ys_ds, linewidth=0.8)
            plt.xlabel(f"{time_col} (relative)")
            plt.ylabel(col)
            plt.title(f"{table} — {col}")
            plt.grid(True, alpha=0.3)

            safe_col = "".join(c if c.isalnum() or c in "_-" else "_" for c in col)
            plot_path = plots_root / f"{table}__{safe_col}.png"
            plt.tight_layout()
            plt.savefig(plot_path)
            plt.close()

            plots_index.setdefault(table, {})[col] = str(plot_path.relative_to(out_dir))

    return plots_index


def summarize_run(db_path: Path, table_rows: Dict[str, int]) -> Dict:
    now = datetime.utcnow().isoformat() + "Z"
    return {
        "db_path": str(db_path),
        "db_name": get_db_name_from_path(db_path),
        "generated_at_utc": now,
        "tables": table_rows,
    }


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Post-process a single Elodin DB run.")
    parser.add_argument(
        "--db-name", help="Logical DB name under ~/.local/share/elodin/<DB_NAME>"
    )
    parser.add_argument("--db-path", help="Explicit DB path (overrides --db-name)")
    parser.add_argument(
        "--tables",
        nargs="*",
        help="Subset of tables to export (default: export all tables returned by `elodin-db list`).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing output for this DB run if present.",
    )
    return parser.parse_args(argv)


def main(argv: List[str]) -> int:
    args = parse_args(argv)

    try:
        db_path = resolve_db_path(args.db_name, args.db_path)
    except SystemExit as e:
        sys.stderr.write(str(e) + "\n")
        return 1

    db_name = get_db_name_from_path(db_path)
    out_dir = ensure_output_dir(db_name)

    if out_dir.exists() and any(out_dir.iterdir()) and not args.force:
        sys.stderr.write(
            f"[postprocess] Output directory already populated for DB '{db_name}': {out_dir}\n"
            "  Re-run with --force to overwrite.\n"
        )
        return 1

    # If force, clear existing contents but keep the directory
    if args.force:
        for child in out_dir.iterdir():
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()

    try:
        available_tables = list_tables(db_path)
    except Exception:
        return 1

    if args.tables:
        tables = [t for t in args.tables if t in available_tables]
        missing = set(args.tables) - set(tables)
        if missing:
            sys.stderr.write(
                f"[postprocess] Requested tables not found and will be skipped: {', '.join(sorted(missing))}\n"
            )
    else:
        tables = available_tables

    table_rows: Dict[str, int] = {}
    for table in tables:
        csv_path = out_dir / f"{table}.csv"
        rows = export_table(db_path, table, csv_path)
        table_rows[table] = rows

    copy_metadata(db_path, out_dir)

    plots_index = generate_basic_plots(out_dir, table_rows)

    summary = summarize_run(db_path, table_rows)
    if plots_index:
        summary["plots"] = plots_index
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2))

    print(f"[postprocess] Completed for DB '{db_name}'")
    print(f"[postprocess] Output directory: {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
