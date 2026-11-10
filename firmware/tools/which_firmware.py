#!/usr/bin/env python3
"""Answer "which firmware is this board running?" from a digest it reported.

    which_firmware.py 5f2885e2                 # a prefix is enough
    which_firmware.py 5f2885e2 --registry DIR  # a registry tree other than the default

The digest is what a board puts in its heartbeat and what the DAQ shows in the
config panel. CI records one file per distinct image on the `firmware-registry`
branch, so get that branch first:

    git fetch origin firmware-registry:firmware-registry
    git worktree add /tmp/fwreg firmware-registry

and point --registry at it, or set STAR_FIRMWARE_REGISTRY.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def find(registry: Path, prefix: str) -> list[dict]:
    prefix = prefix.lower().strip()
    hits = []
    for path in sorted(registry.rglob("*.json")):
        try:
            rec = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        if str(rec.get("image_digest", "")).lower().startswith(prefix):
            rec["_path"] = str(path)
            hits.append(rec)
    return hits


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("digest", help="full digest or a unique prefix (case-insensitive)")
    ap.add_argument(
        "--registry",
        default=os.environ.get("STAR_FIRMWARE_REGISTRY", ""),
        help="registry tree (default: $STAR_FIRMWARE_REGISTRY)",
    )
    args = ap.parse_args()

    if len(args.digest.strip()) < 4:
        print("error: give at least 4 hex characters", file=sys.stderr)
        return 2
    if not args.registry:
        print(
            "error: no registry tree given. Pass --registry or set "
            "STAR_FIRMWARE_REGISTRY; see this file's docstring for how to get "
            "the firmware-registry branch.",
            file=sys.stderr,
        )
        return 2

    registry = Path(args.registry)
    if not registry.is_dir():
        print(f"error: {registry} is not a directory", file=sys.stderr)
        return 2

    hits = find(registry, args.digest)
    if not hits:
        if args.digest.strip("0") == "":
            print(
                "All-zero digest: the board did not report one. Either it has "
                "not computed it yet, or esp_partition_get_sha256() failed, "
                "which means the image on it does not verify."
            )
            return 1
        print(
            f"No image in the registry starts with {args.digest!r}.\n"
            "That means this firmware was never built by CI on main -- a local "
            "build, a branch, or an image from before the registry existed."
        )
        return 1
    if len(hits) > 1:
        print(f"{args.digest!r} matches {len(hits)} images; give more characters:")
        for rec in hits:
            print(f"  {rec['image_digest']}  {rec.get('board')}")
        return 1

    rec = hits[0]
    commits = rec.get("commits") or []
    print(f"board          {rec.get('board')}")
    print(f"digest         {rec['image_digest']}")
    print(f"image_len      {rec.get('image_len')}")
    if len(commits) == 1:
        print(f"commit         {commits[0]}")
    else:
        print(f"commits        {len(commits)} commits build these exact bytes:")
        for c in commits:
            print(f"               {c}")
    for key in (
        "subject",
        "first_seen_commit_at",
        "platform",
        "framework",
        "gcc",
        "built_by",
        "run_url",
    ):
        if rec.get(key):
            print(f"{key:14} {rec[key]}")
    print(f"record         {rec['_path']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
