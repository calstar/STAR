#!/usr/bin/env python3
"""Merge freshly built firmware records into the registry tree. Used by CI.

    registry_merge.py --records <dir of *.json> --registry <registry tree>

A record's file name is its digest, so two commits that build byte-identical
firmware land on the same file. That is deliberate: a board running those bytes
genuinely cannot be attributed to one commit rather than the other, so the
record keeps a list of every commit known to produce it instead of pretending
the first one is the answer.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def merge_one(new: dict, existing: dict | None) -> tuple[dict, str]:
    if existing is None:
        rec = dict(new)
        rec["commits"] = sorted(set(new.get("commits") or []))
        return rec, "new"

    rec = dict(existing)
    before = set(rec.get("commits") or [])
    after = before | set(new.get("commits") or [])
    rec["commits"] = sorted(after)

    # Fields that describe the image itself must never drift for a given digest.
    for key in ("image_digest", "file_sha256", "image_len", "board"):
        if key in new and key in rec and new[key] != rec[key]:
            raise SystemExit(
                f"refusing to merge: {key} differs for digest {new.get('image_digest')}\n"
                f"  existing: {rec[key]!r}\n  new:      {new[key]!r}\n"
                "Identical bytes cannot have two different values here; the "
                "registry or the build is wrong."
            )
    # Keep the first sighting's provenance, add the latest.
    for key in ("run_url", "run_id", "subject"):
        if new.get(key):
            rec.setdefault(f"first_{key}", rec.get(key, new[key]))
            rec[key] = new[key]
    return rec, "updated" if after != before else "unchanged"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--records", required=True, help="dir of new record JSON files")
    ap.add_argument("--registry", required=True, help="registry tree to merge into")
    args = ap.parse_args()

    records = sorted(Path(args.records).rglob("*.json"))
    if not records:
        print("no records to merge", file=sys.stderr)
        return 0

    registry = Path(args.registry)
    counts = {"new": 0, "updated": 0, "unchanged": 0}

    for path in records:
        new = json.loads(path.read_text())
        digest = new.get("image_digest")
        board = new.get("board")
        if not digest or not board:
            raise SystemExit(f"{path}: record needs image_digest and board")

        dest = registry / board / f"{digest}.json"
        existing = json.loads(dest.read_text()) if dest.is_file() else None
        merged, what = merge_one(new, existing)
        counts[what] += 1
        if what != "unchanged":
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(json.dumps(merged, indent=2, sort_keys=True) + "\n")
        print(f"{what:9} {board}/{digest[:16]}…")

    print(f"\n{counts['new']} new, {counts['updated']} updated, "
          f"{counts['unchanged']} already current")
    return 0


if __name__ == "__main__":
    sys.exit(main())
