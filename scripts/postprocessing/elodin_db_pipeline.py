#!/usr/bin/env python3
"""
FSW-style Elodin DB postprocessing pipeline.

Mimics ~/fsw/postprocessing/scripts/elodin_postprocessing.sh:
  1. elodin-db lua save_archive → parquet
  2. parquet → CSV (duckdb)
  3. merge CSVs by prefix (FULL OUTER JOIN on row index)

Uses elodin-db's native export instead of custom socket protocol.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parents[2]
POSTPROC_ROOT = ROOT / "scripts" / "postprocessing"
DEFAULT_DB_ROOT = Path(
    os.environ.get("ELODIN_DB_ROOT", Path.home() / ".local" / "share" / "elodin")
)

# elodin-db binary (not elodin_db_compat)
ELODIN_DB_BIN = os.environ.get("ELODIN_DB_BIN", "elodin-db")
if (
    ELODIN_DB_BIN == "elodin-db"
    and (Path.home() / ".cargo" / "bin" / "elodin-db").exists()
):
    ELODIN_DB_BIN = str(Path.home() / ".cargo" / "bin" / "elodin-db")


def _run(
    cmd: List[str],
    capture: bool = False,
    check: bool = True,
    input: Optional[str] = None,
) -> subprocess.CompletedProcess:
    kw: Dict = {"check": check, "text": True}
    if capture:
        kw["stdout"] = subprocess.PIPE
        kw["stderr"] = subprocess.PIPE
    if input is not None:
        kw["input"] = input
    return subprocess.run(cmd, **kw)


def _find_elodin_port(db_path: Path) -> Optional[int]:
    """Return port if elodin-db is already running for this DB path."""
    resolved = str(db_path.resolve())
    try:
        proc = _run(
            ["pgrep", "-a", "-f", "elodin-db run"],
            capture=True,
            check=False,
        )
    except Exception:
        return None
    if proc.returncode != 0 or not proc.stdout.strip():
        return None
    for line in proc.stdout.splitlines():
        if resolved in line:
            m = re.search(r"\[::\]:(\d+)", line)
            if m:
                return int(m.group(1))
    return None


def _find_free_port(start: int = 2240) -> Optional[int]:
    """Find a port not in use by elodin-db or other services."""
    import socket

    for port in range(start, min(start + 100, 65535)):
        if (
            _run(
                ["pgrep", "-f", r"elodin-db run \[::\]:" + str(port)],
                capture=True,
                check=False,
            ).returncode
            == 0
        ):
            continue
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(("127.0.0.1", port))
                return port
        except OSError:
            continue
    return None


def _save_archive(db_path: Path, parquet_dir: Path, port: int) -> None:
    """Run elodin-db lua save_archive to export DB to parquet."""
    parquet_dir.mkdir(parents=True, exist_ok=True)
    lua = f'client = connect("0.0.0.0:{port}")\nclient:save_archive("{parquet_dir}", "parquet")'
    _run([ELODIN_DB_BIN, "lua"], input=lua)


def _parquet_to_csv(parquet_dir: Path, csv_dir: Path) -> List[Path]:
    """Convert each parquet file to CSV using duckdb. Returns list of CSV paths."""
    try:
        import duckdb
    except ImportError:
        sys.stderr.write(
            "[pipeline] duckdb required for parquet→csv. pip install duckdb\n"
        )
        raise

    csv_dir.mkdir(parents=True, exist_ok=True)
    out: List[Path] = []
    for pf in sorted(parquet_dir.glob("*.parquet")):
        stem = pf.stem.replace(" ", "")
        cf = csv_dir / f"{stem}.csv"
        try:
            duckdb.sql(
                f"""
                COPY (SELECT * FROM '{pf}')
                TO '{cf}' (FORMAT CSV, HEADER);
            """
            )
            out.append(cf)
        except Exception as e:
            sys.stderr.write(f"[pipeline] Failed {pf.name}: {e}\n")
    return out


def _merge_csvs(csv_dir: Path, out_dir: Path) -> Dict[str, int]:
    """
    Merge CSVs by prefix (e.g. BARMESSAGE.TIME_BAR + BARMESSAGE.PRESSURE → BARMESSAGE).
    Uses duckdb FULL OUTER JOIN on row_idx. Returns {merged_stem: row_count}.
    """
    try:
        import duckdb
    except ImportError:
        out_dir.mkdir(parents=True, exist_ok=True)
        table_rows = {}
        for cf in csv_dir.glob("*.csv"):
            dst = out_dir / cf.name
            shutil.copy2(cf, dst)
            try:
                table_rows[cf.stem] = max(0, sum(1 for _ in open(dst)) - 1)
            except Exception:
                table_rows[cf.stem] = 0
        return table_rows

    out_dir.mkdir(parents=True, exist_ok=True)

    # Group by prefix (before first dot)
    groups: Dict[str, List[Path]] = {}
    for cf in csv_dir.glob("*.csv"):
        if "consolidated" in cf.stem:
            continue
        prefix = cf.stem.split(".")[0] if "." in cf.stem else cf.stem
        if prefix not in groups:
            groups[prefix] = []
        groups[prefix].append(cf)

    table_rows: Dict[str, int] = {}
    for prefix, files in groups.items():
        if len(files) < 2:
            for f in files:
                dst = out_dir / f.name
                shutil.copy2(f, dst)
                try:
                    table_rows[f.stem] = max(0, sum(1 for _ in open(dst)) - 1)
                except Exception:
                    table_rows[f.stem] = 0
            continue

        time_file = None
        data_files = []
        for f in files:
            if "time_monotonic" in f.stem.lower() or "TIME_MONOTONIC" in f.stem:
                time_file = f
            else:
                data_files.append(f)

        if not time_file or not data_files:
            for f in files:
                dst = out_dir / f.name
                shutil.copy2(f, dst)
                try:
                    table_rows[f.stem] = max(0, sum(1 for _ in open(dst)) - 1)
                except Exception:
                    table_rows[f.stem] = 0
            continue

        try:
            t0_cols = (
                duckdb.sql(f"DESCRIBE SELECT * FROM '{time_file}'")
                .df()["column_name"]
                .tolist()
            )
            cols = ["t0.row_idx"] + [f't0."{c}"' for c in t0_cols if c != "row_idx"]
            subqueries = [
                f"(SELECT row_number() OVER () as row_idx, * FROM '{time_file}') as t0"
            ]

            for i, df in enumerate(data_files, 1):
                df_cols = (
                    duckdb.sql(f"DESCRIBE SELECT * FROM '{df}'")
                    .df()["column_name"]
                    .tolist()
                )
                cols += [f't{i}."{c}"' for c in df_cols if c != "row_idx"]
                subqueries.append(
                    f"(SELECT row_number() OVER () as row_idx, * FROM '{df}') as t{i}"
                )

            from_clause = subqueries[0]
            for i in range(1, len(subqueries)):
                from_clause += (
                    f" FULL OUTER JOIN {subqueries[i]} ON t0.row_idx = t{i}.row_idx"
                )

            dst = out_dir / f"{prefix}_consolidated.csv"
            duckdb.sql(
                f"""
                COPY (
                    SELECT {", ".join(cols)}
                    FROM {from_clause}
                    ORDER BY t0.row_idx
                )
                TO '{dst}' (FORMAT CSV, HEADER);
            """
            )
            table_rows[f"{prefix}_consolidated"] = max(0, sum(1 for _ in open(dst)) - 1)
        except Exception as e:
            sys.stderr.write(f"[pipeline] Merge failed for {prefix}: {e}\n")
            for f in files:
                dst = out_dir / f.name
                shutil.copy2(f, dst)
                try:
                    table_rows[f.stem] = max(0, sum(1 for _ in open(dst)) - 1)
                except Exception:
                    table_rows[f.stem] = 0

    for cf in csv_dir.glob("*.csv"):
        if "consolidated" in cf.stem:
            continue
        dst = out_dir / cf.name
        if not dst.exists():
            shutil.copy2(cf, dst)
            try:
                table_rows[cf.stem] = max(0, sum(1 for _ in open(dst)) - 1)
            except Exception:
                table_rows[cf.stem] = 0

    return table_rows


def run_pipeline(
    db_path: Path,
    db_name: str,
    out_dir: Path,
    *,
    copy_db_if_canonical: bool = True,
) -> Tuple[Dict[str, int], Path]:
    """
    Run FSW-style pipeline: DB → parquet → CSV → merge.
    Returns (table_rows, csv_dir).
    """
    db_path = db_path.resolve()
    effective_db = db_path
    started_server = False
    server_proc = None
    port: Optional[int] = None

    # If elodin-db is already running for this path, use it (no copy)
    port = _find_elodin_port(db_path)
    if port is not None:
        effective_db = db_path
        sys.stderr.write(f"[pipeline] Using existing elodin-db on port {port}\n")
    elif copy_db_if_canonical:
        try:
            default_resolved = DEFAULT_DB_ROOT.expanduser().resolve()
        except Exception:
            default_resolved = Path(str(DEFAULT_DB_ROOT.expanduser()))
        if default_resolved in db_path.parents or db_path == default_resolved:
            work_root = POSTPROC_ROOT / "work_dbs"
            work_root.mkdir(parents=True, exist_ok=True)
            effective_db = work_root / db_name
            if not effective_db.exists():
                sys.stderr.write(f"[pipeline] Copying DB to {effective_db}...\n")
                shutil.copytree(db_path, effective_db)
            else:
                sys.stderr.write(f"[pipeline] Using work copy at {effective_db}\n")

    if not (effective_db / "db_state").exists():
        raise FileNotFoundError(f"Not a valid Elodin DB (no db_state): {effective_db}")

    meta_dir = Path(str(effective_db) + "_metadata")
    parquet_dir = meta_dir / "elodin_db_parquet"
    csv_unaligned = meta_dir / "elodin_db_csv"

    meta_dir.mkdir(parents=True, exist_ok=True)

    # Find or start elodin-db (port already set if we found existing server)
    if port is None:
        port = _find_elodin_port(effective_db)
    if port is None:
        port = _find_free_port()
        if port is None:
            raise RuntimeError("No free port for elodin-db")
        sys.stderr.write(f"[pipeline] Starting elodin-db on port {port}...\n")
        server_proc = subprocess.Popen(
            [ELODIN_DB_BIN, "run", f"[::]:{port}", str(effective_db)],
            stdout=sys.stderr,
            stderr=sys.stderr,
        )
        started_server = True
        import time

        time.sleep(2)

    try:
        sys.stderr.write("[pipeline] Running elodin-db save_archive → parquet...\n")
        _save_archive(effective_db, parquet_dir, port)

        sys.stderr.write("[pipeline] Converting parquet → CSV...\n")
        _parquet_to_csv(parquet_dir, csv_unaligned)

        sys.stderr.write("[pipeline] Merging CSVs...\n")
        table_rows = _merge_csvs(csv_unaligned, out_dir)

        if not table_rows:
            for cf in out_dir.glob("*.csv"):
                try:
                    table_rows[cf.stem] = max(0, sum(1 for _ in open(cf)) - 1)
                except Exception:
                    table_rows[cf.stem] = 0

        return table_rows, out_dir
    finally:
        if started_server and server_proc:
            server_proc.terminate()
            server_proc.wait(timeout=5)


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser()
    p.add_argument("--db-name", required=True)
    p.add_argument(
        "--db-path", help="Override; default ~/.local/share/elodin/<db-name>"
    )
    p.add_argument("--output-dir", type=Path, default=None)
    args = p.parse_args()

    db_root = Path(
        os.environ.get("ELODIN_DB_ROOT", Path.home() / ".local" / "share" / "elodin")
    )
    db_path = Path(args.db_path) if args.db_path else (db_root / args.db_name)
    if not db_path.exists():
        sys.stderr.write(f"DB not found: {db_path}\n")
        sys.exit(1)

    out = args.output_dir or (POSTPROC_ROOT / "output" / args.db_name)
    table_rows, csv_dir = run_pipeline(db_path, args.db_name, out)
    print(f"Exported {len(table_rows)} tables to {out}")
    for name, n in sorted(table_rows.items()):
        print(f"  {name}: {n} rows")
