#!/usr/bin/env python3
"""
Fail if any config TOML uses `_` digit-separators in numbers (e.g. `port = 5_006`).

Those are valid TOML, but the minimal C++ config parsers in the DAQ services use
std::stoul/stoi/stod, which stop at the underscore — so `5_006` parses as `5`, a
privileged port, and daq_bridge crash-loops on bind (EACCES). @iarna/toml's
stringify emits these separators for every integer >= 1000, so a GUI "Save Config"
would reintroduce them; the writer now strips them (routes/config.ts), and this
check guards the committed files against any other source (hand edits, other tools).

Scans daq-server/config/*.toml. Quote- and comment-aware so a string value like
"weird_1_2_name" is not flagged. Exit 1 (with file:line) on any violation.

Run:  python3 test/check_toml_no_underscore_ints.py   (from daq-server/ or repo root)
"""

from __future__ import annotations

import glob
import os
import re
import sys

UNDERSCORE_BETWEEN_DIGITS = re.compile(r"[0-9]_[0-9]")


def strip_strings_and_comment(line: str) -> str:
    """Blank out quoted spans (basic \" and literal ') and any trailing comment,
    so only the structural/numeric part of the line remains for scanning."""
    out = []
    quote = None  # '"' or "'"
    for ch in line:
        if quote:
            out.append(" ")  # keep column alignment, hide string content
            if ch == quote:
                quote = None
            continue
        if ch in ('"', "'"):
            quote = ch
            out.append(" ")
            continue
        if ch == "#":  # start of an unquoted comment — ignore the rest
            break
        out.append(ch)
    return "".join(out)


def scan_file(path: str) -> list[tuple[int, str]]:
    violations: list[tuple[int, str]] = []
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for i, raw in enumerate(f, start=1):
            scannable = strip_strings_and_comment(raw)
            if UNDERSCORE_BETWEEN_DIGITS.search(scannable):
                violations.append((i, raw.rstrip("\n")))
    return violations


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    daq_root = os.path.dirname(here)  # daq-server/
    config_dir = os.path.join(daq_root, "config")
    # config/*.toml plus the committed config profiles (config/profiles/*.toml — the source of truth;
    # config.toml itself is a git-ignored generated artifact).
    files = sorted(
        glob.glob(os.path.join(config_dir, "*.toml"))
        + glob.glob(os.path.join(config_dir, "profiles", "*.toml"))
    )
    if not files:
        print(f"[check_toml] no TOML files found in {config_dir}", flush=True)
        return 0

    total = 0
    for path in files:
        for line_no, text in scan_file(path):
            rel = os.path.relpath(path, daq_root)
            print(f"{rel}:{line_no}: underscore digit-separator in number → {text.strip()}",
                  flush=True)
            total += 1

    if total:
        print(
            f"\n[check_toml] {total} underscore-separated number(s) found. The C++ config "
            "parsers (std::stoul) truncate these — write plain integers (5006, not 5_006).",
            flush=True,
        )
        return 1
    print(f"[check_toml] OK — {len(files)} config TOML file(s) have no underscore-separated numbers.",
          flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
