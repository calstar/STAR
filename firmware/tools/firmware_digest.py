#!/usr/bin/env python3
"""The digest a board reports for its own firmware, read out of a built image.

An ESP32 app image built with a hash appended carries its SHA-256 as the last
32 bytes of the image. `esp_partition_get_sha256()` -- what `firmware_hash.h`
calls, and so what every board puts in its BoardHeartbeatPacket -- returns
*those bytes*, after recomputing them once to check they are right. It does not
hash the file. So the value to compare a board against is the appended digest,
NOT `sha256(firmware.bin)`: hashing the whole file folds the digest into its own
input and can never match a board. See FIRMWARE_HASH_VERIFICATION.md.

Usage:
    firmware_digest.py <firmware.bin>
    firmware_digest.py <firmware.bin> --verbose
    firmware_digest.py <firmware.bin> --record --board PT_Hotfire --env <pio env>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import struct
import subprocess
import sys
from pathlib import Path

IMAGE_MAGIC = 0xE9
HEADER_LEN = 24  # esp_image_header_t
SEGMENT_HEADER_LEN = 8  # esp_image_segment_header_t: load_addr + data_len
HASH_LEN = 32


class ImageError(Exception):
    pass


def _parse_image(data: bytes) -> dict:
    """Walk the image the way the ROM loader does, to find where it really ends.

    We do not trust the file's length: a .bin can carry padding past the end of
    the image, and then the appended digest is not the last 32 bytes of the file.
    """
    if len(data) < HEADER_LEN:
        raise ImageError(f"too short to be an image ({len(data)} bytes)")
    if data[0] != IMAGE_MAGIC:
        raise ImageError(f"bad magic {data[0]:#04x}, expected {IMAGE_MAGIC:#04x}")

    segment_count = data[1]
    hash_appended = bool(data[23])

    off = HEADER_LEN
    for i in range(segment_count):
        if off + SEGMENT_HEADER_LEN > len(data):
            raise ImageError(f"segment {i} header runs past end of file")
        _load_addr, data_len = struct.unpack_from("<II", data, off)
        off += SEGMENT_HEADER_LEN + data_len
        if off > len(data):
            raise ImageError(f"segment {i} data runs past end of file")

    # One checksum byte, positioned so the image is a multiple of 16 bytes with
    # the checksum last.
    off += 1
    off += (16 - (off % 16)) % 16
    if hash_appended:
        off += HASH_LEN
    if off > len(data):
        raise ImageError(f"image length {off} exceeds file length {len(data)}")

    return {
        "segment_count": segment_count,
        "hash_appended": hash_appended,
        "image_len": off,
        "trailing_bytes": len(data) - off,
    }


def image_digest(path: str | os.PathLike) -> tuple[bytes, dict]:
    """Return (digest, info) -- the 32 bytes a board running this image reports."""
    data = Path(path).read_bytes()
    info = _parse_image(data)
    end = info["image_len"]

    if info["hash_appended"]:
        digest = data[end - HASH_LEN : end]
        # The same check IDF makes before handing the digest back. If this fails
        # the board would report ESP_ERR_IMAGE_INVALID and never send a digest,
        # so refusing here is the honest answer rather than a plausible hash.
        recomputed = hashlib.sha256(data[: end - HASH_LEN]).digest()
        if digest != recomputed:
            raise ImageError(
                "appended digest does not match the image content it covers "
                f"(appended {digest.hex()}, recomputed {recomputed.hex()}); "
                "the image is corrupt or the format has changed"
            )
    else:
        # No appended hash: IDF hashes the whole image instead.
        digest = hashlib.sha256(data[:end]).digest()

    info["file_len"] = len(data)
    info["file_sha256"] = hashlib.sha256(data).hexdigest()
    return digest, info


def _git(*args: str, cwd: str | None = None) -> str:
    return subprocess.check_output(["git", *args], cwd=cwd, text=True).strip()


def _record(path: str, digest: bytes, info: dict, board: str, pio_env: str) -> dict:
    repo = Path(__file__).resolve().parents[2]
    rec = {
        "image_digest": digest.hex(),
        "file_sha256": info["file_sha256"],
        "board": board,
        "pio_env": pio_env,
        "image_len": info["image_len"],
        "commits": [],
    }
    try:
        rec["commits"] = [_git("rev-parse", "HEAD", cwd=str(repo))]
        rec["first_seen_commit_at"] = _git(
            "log", "-1", "--format=%cI", "HEAD", cwd=str(repo)
        )
        rec["subject"] = _git("log", "-1", "--format=%s", "HEAD", cwd=str(repo))
    except (subprocess.CalledProcessError, OSError) as exc:
        rec["git_error"] = str(exc)
    for key, env in (
        ("run_id", "GITHUB_RUN_ID"),
        ("run_attempt", "GITHUB_RUN_ATTEMPT"),
    ):
        if os.environ.get(env):
            rec[key] = os.environ[env]
    if os.environ.get("GITHUB_REPOSITORY") and os.environ.get("GITHUB_RUN_ID"):
        rec["run_url"] = (
            f"https://github.com/{os.environ['GITHUB_REPOSITORY']}"
            f"/actions/runs/{os.environ['GITHUB_RUN_ID']}"
        )
    rec["built_by"] = "ci" if os.environ.get("GITHUB_ACTIONS") else "local"
    # A toolchain bump changes every digest with no source change. Without these
    # fields the registry just looks corrupt when that happens.
    for key, env in (
        ("platform", "STAR_PIO_PLATFORM"),
        ("framework", "STAR_PIO_FRAMEWORK"),
        ("gcc", "STAR_PIO_GCC"),
    ):
        if os.environ.get(env):
            rec[key] = os.environ[env]
    return rec


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("image", help="path to firmware.bin")
    ap.add_argument("--verbose", "-v", action="store_true")
    ap.add_argument(
        "--record", action="store_true", help="emit a registry record as JSON"
    )
    ap.add_argument("--board", default="", help="board name for --record")
    ap.add_argument(
        "--env", dest="pio_env", default="", help="PlatformIO env for --record"
    )
    args = ap.parse_args()

    try:
        digest, info = image_digest(args.image)
    except (ImageError, OSError) as exc:
        print(f"error: {args.image}: {exc}", file=sys.stderr)
        return 1

    if args.record:
        if not args.board:
            print("error: --record needs --board", file=sys.stderr)
            return 2
        json.dump(
            _record(args.image, digest, info, args.board, args.pio_env),
            sys.stdout,
            indent=2,
            sort_keys=True,
        )
        print()
        return 0

    if args.verbose:
        print(f"image            {args.image}")
        print(f"segments         {info['segment_count']}")
        print(f"hash_appended    {info['hash_appended']}")
        print(f"image_len        {info['image_len']}")
        print(f"file_len         {info['file_len']}")
        print(f"trailing_bytes   {info['trailing_bytes']}")
        print(f"file_sha256      {info['file_sha256']}   <- NOT what a board reports")
        print(f"image_digest     {digest.hex()}   <- what a board reports")
    else:
        print(digest.hex())
    return 0


if __name__ == "__main__":
    sys.exit(main())
