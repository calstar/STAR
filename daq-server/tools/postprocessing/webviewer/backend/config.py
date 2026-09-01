"""Paths, binary discovery, and run-name conventions for the webviewer backend."""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

# Directory holding the Elodin DB run directories.
ELODIN_DIR = Path(
    os.environ.get("ELODIN_DB_DIR", str(Path.home() / ".local/share/elodin"))
).expanduser()

# Where we cache the exported parquet for each run. Immutable past runs → cache
# never needs invalidation. Lives next to this file, gitignored.
CACHE_DIR = Path(
    os.environ.get(
        "WEBVIEWER_CACHE_DIR", str(Path(__file__).resolve().parent.parent / ".cache")
    )
).expanduser()

# Only timestamped runs are considered: daq_YYYYMMDD_HHMMSS, and the simulated
# variant daq_sim_YYYYMMDD_HHMMSS that session-manager writes for a sim session.
# Older ad-hoc DBs (daq_live, calibration, hand-named dirs) stay ignored — the
# `sim_` group is what tells the UI to label a run as synthetic, so widening the
# pattern does not blur the real/simulated distinction the prefix exists for.
RUN_RE = re.compile(r"^daq_(?P<sim>sim_)?(?P<date>\d{8})_(?P<time>\d{6})$")

# Cap the throughput of CSV downloads (bytes/sec) so a big whole-run export can't
# saturate the host's uplink and starve other services on the box. A long run's
# tidy CSV can be hundreds of MB; this paces it instead of forbidding it.
# Default unlimited (0) — local dev is unthrottled; the deployment sets a cap via
# WEBVIEWER_MAX_DOWNLOAD_BPS (see run.sh --build).
MAX_DOWNLOAD_BYTES_PER_SEC = int(os.environ.get("WEBVIEWER_MAX_DOWNLOAD_BPS", "0"))


def find_elodin_db() -> str:
    """Locate the elodin-db binary the same way export_elodin_db.sh does."""
    cargo = Path.home() / ".cargo/bin/elodin-db"
    if cargo.is_file():
        return str(cargo)
    found = shutil.which("elodin-db")
    if found:
        return found
    raise RuntimeError(
        "elodin-db not found. Install with `cargo install elodin-db` or put it on PATH."
    )
