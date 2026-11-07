"""Video recordings from the gateway, placed on a run's timeline.

The video agent (daq-server/video/agent.mjs) keeps each Save and Record as a folder
`<YYYY-MM-DD_HHMMSS>_<label>/` holding one video-only `<stream>.mp4` per stream. That
folder is mounted read-only here (`config.VIDEO_DIR`); this module lists the clips in it,
says which overlap a run, and resolves a clip to its file. It never writes.

Timing. A clip's start is taken from its folder name, which the agent writes in the
gateway machine's local time to the second (`config.VIDEO_TZ`):

- `_record`: the name is when Record was pressed, so that is the clip's start;
- anything else (`_save`): the name is when Save was pressed, and the clip is the buffer
  *before* it, so the clip ends there and starts one duration earlier.

That is only approximate: the second is truncated, and the agent cuts the file at a
keyframe, which can move the first frame by a keyframe interval. Every such clip is
marked `approx`. A clip's duration is read from its own mp4 header (the agent writes
with +faststart, so the header is near the front), never by decoding.

Cost: one directory listing plus a `stat` per clip on each call; the mp4 header is read
once per file and cached on (mtime, size). A folder still being recorded holds no mp4
yet, and a file ffmpeg has not finished has no readable duration, so neither is listed.
"""

from __future__ import annotations

import os
import re
import struct
import threading
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from . import config

# The agent's RECORDING_NAME_RE, verbatim.
RECORDING_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})_([a-z0-9-]{1,32})$", re.IGNORECASE
)
# A stream id as a file name: no dots, no separators, so it can never leave the folder.
STREAM_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


@dataclass(frozen=True)
class Clip:
    recording: str  # folder name
    kind: str  # "record", "save", or another label
    stream: str
    start: float  # epoch seconds, first frame
    duration: float  # seconds
    approx: bool  # timing from the folder name only

    @property
    def end(self) -> float:
        return self.start + self.duration

    def as_json(self) -> dict:
        return {
            "recording": self.recording,
            "kind": self.kind,
            "stream": self.stream,
            "start": self.start,
            "end": self.end,
            "duration": self.duration,
            "approx": self.approx,
        }


# ── mp4 duration ─────────────────────────────────────────────────────────────


def _boxes(f, start: int, end: int):
    """(type, payload offset, payload end) for each box in f[start:end]."""
    pos = start
    while pos + 8 <= end:
        f.seek(pos)
        head = f.read(8)
        if len(head) < 8:
            return
        size, kind = struct.unpack(">I4s", head)
        hdr = 8
        if size == 1:
            ext = f.read(8)
            if len(ext) < 8:
                return
            size = struct.unpack(">Q", ext)[0]
            hdr = 16
        elif size == 0:
            size = end - pos
        if size < hdr:
            return
        yield kind, pos + hdr, min(pos + size, end)
        pos += size


def mp4_duration(path: Path) -> float | None:
    """Duration in seconds from the movie header (moov/mvhd), or None if the file has
    no complete header — not an mp4, or still being written."""
    try:
        with open(path, "rb") as f:
            total = os.fstat(f.fileno()).st_size
            for kind, a, b in _boxes(f, 0, total):
                if kind != b"moov":
                    continue
                for k2, c, _d in _boxes(f, a, b):
                    if k2 != b"mvhd":
                        continue
                    f.seek(c)
                    version = f.read(1)
                    if not version:
                        return None
                    f.read(3)  # flags
                    if version[0] == 1:
                        raw = f.read(28)
                        if len(raw) < 28:
                            return None
                        _ct, _mt, scale, dur = struct.unpack(">QQIQ", raw)
                    else:
                        raw = f.read(16)
                        if len(raw) < 16:
                            return None
                        _ct, _mt, scale, dur = struct.unpack(">IIII", raw)
                    return dur / scale if scale else None
                return None
    except OSError:
        return None
    return None


# ── Listing ──────────────────────────────────────────────────────────────────

_dur_cache: dict[str, tuple[int, int, float]] = {}
_lock = threading.Lock()


def _duration_cached(path: Path, st: os.stat_result) -> float | None:
    key = str(path)
    with _lock:
        hit = _dur_cache.get(key)
    if hit and hit[0] == st.st_mtime_ns and hit[1] == st.st_size:
        return hit[2]
    d = mp4_duration(path)
    if d is not None and d > 0:
        with _lock:
            _dur_cache[key] = (st.st_mtime_ns, st.st_size, d)
    return d


def folder_time(name: str, tz: str) -> float | None:
    """Epoch seconds of a recording folder's name, read in the gateway's time zone."""
    m = RECORDING_RE.match(name)
    if not m:
        return None
    y, mo, d, h, mi, s = (int(x) for x in m.groups()[:6])
    try:
        return datetime(y, mo, d, h, mi, s, tzinfo=ZoneInfo(tz)).timestamp()
    except ValueError:
        return None


def available() -> bool:
    return config.VIDEO_DIR is not None and config.VIDEO_DIR.is_dir()


def list_clips() -> list[Clip]:
    """Every finished clip in the recordings folder."""
    if not available():
        return []
    root = config.VIDEO_DIR
    assert root is not None
    clips: list[Clip] = []
    try:
        folders = list(os.scandir(root))
    except OSError:
        return []
    for folder in folders:
        m = RECORDING_RE.match(folder.name)
        if not m or not folder.is_dir():
            continue
        named = folder_time(folder.name, config.VIDEO_TZ)
        if named is None:
            continue
        kind = m.group(7).lower()
        try:
            entries = list(os.scandir(folder.path))
        except OSError:
            continue
        for e in entries:
            if not e.name.endswith(".mp4"):
                continue
            stream = e.name[:-4]
            if not STREAM_RE.match(stream):
                continue
            try:
                st = e.stat()
            except OSError:
                continue
            dur = _duration_cached(Path(e.path), st)
            if dur is None:
                continue
            start = named if kind == "record" else named - dur
            clips.append(Clip(folder.name, kind, stream, start, dur, approx=True))
    clips.sort(key=lambda c: (c.start, c.stream))
    return clips


def clips_overlapping(t0: float, t1: float) -> list[Clip]:
    """Clips any part of which falls inside [t0, t1]."""
    return [c for c in list_clips() if c.start <= t1 and c.end >= t0]


def clip_file(recording: str, stream: str) -> Path | None:
    """The file for a clip this module would list, else None. Nothing from the request
    reaches the filesystem until both names have passed the listing's own patterns."""
    if not available() or not RECORDING_RE.match(recording) or not STREAM_RE.match(stream):
        return None
    for c in list_clips():
        if c.recording == recording and c.stream == stream:
            assert config.VIDEO_DIR is not None
            return config.VIDEO_DIR / recording / f"{stream}.mp4"
    return None
