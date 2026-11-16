"""Normalisation rules for the lifecycle goldens.

The suite README names pipeline/normalize as the shared home for these rules; it did not exist on
backend-remastered when this area was written, so the same rules live here. Each rule replaces one
kind of run-to-run noise with a stable placeholder and nothing else:

  timestamps   header u32 timestamps are classified, not printed (classify_ts); every epoch-ms JSON
               field (EPOCH_KEYS) becomes "<ms>"; durations become "<dur>"; heartbeatTimes keeps
               only its length.
  PIDs         "pid 12345" / "(PID 12345)" -> "<pid>".
  ports        every port this harness allocated maps to its name (Ports.names), e.g. "<P_ELODIN>".
  temp paths   the per-run work dir -> "<WORK>", the daq-server root -> "<ROOT>".
  IDs          WS connIds ("c17") -> "c<N>"; sim log sequence numbers ("#12") -> "#<n>".
  timings      wall-clock gaps are reported as named buckets (bucket()) whose edges are justified
               where each is used; a gap outside every bucket prints as such, and goes red.

Anything else that varies between runs is a flake to fix, not to mask here.
"""

from __future__ import annotations

import json
import re
import time

EPOCH_KEYS = {
    "timestamp",
    "timestampMs",
    "lastHeartbeatMs",
    "missionStartTime",
    "startTimeMs",
    "openedAt",
    "ts",
    "at",
    "lastDeliveredTsMs",
}
DURATION_KEYS = {"durationMs", "uptimeMs", "lagMs", "lifetimeMs"}
# Derived from arrival jitter or from the host's DHCP lease table, never from the stack's logic.
DROP_KEYS = {"frequencyHz", "dhcp"}


def classify_ts(ts: int, recv_epoch_ms: int | None = None) -> str:
    if ts == 0:
        return "0"
    now = recv_epoch_ms if recv_epoch_ms is not None else int(time.time() * 1000)
    diff = (ts - (now & 0xFFFFFFFF)) & 0xFFFFFFFF
    diff = min(diff, 0x100000000 - diff)
    return "<epoch-ms-u32>" if diff < 10_000 else "<non-epoch-ms>"


def log_text(text: str) -> str:
    return re.sub(r"#\d+", "#<n>", text)


def json_value(obj, key: str | None = None):
    """Recursively normalise a decoded WS/HTTP JSON value."""
    if isinstance(obj, dict):
        out = {}
        for k in sorted(obj):
            if k in DROP_KEYS:
                continue
            out[k] = json_value(obj[k], k)
        return out
    if isinstance(obj, list):
        if key == "heartbeatTimes":
            # how many it holds is how long the board has been up (capped at 20)
            return "<times>" if obj else []
        return [json_value(v) for v in obj]
    if key in EPOCH_KEYS and isinstance(obj, (int, float)) and obj > 1_000_000_000:
        return "<ms>"
    if key in DURATION_KEYS and isinstance(obj, (int, float)):
        return "<dur>"
    if key == "connId" and isinstance(obj, str):
        return re.sub(r"^c\d+$", "c<N>", obj)
    return obj


def dumps(obj) -> str:
    return json.dumps(json_value(obj), sort_keys=True, separators=(",", ":"))


def bucket(seconds: float, edges: list[tuple[float, float, str]]) -> str:
    """Name the [lo, hi) range holding `seconds`. Outside all of them is a real change."""
    for lo, hi, name in edges:
        if lo <= seconds < hi:
            return name
    return f"OUTSIDE-ALL-BUCKETS({seconds:.2f}s)"


class Ports:
    """Every port the harness hands out, so text can be rewritten to the port's name."""

    def __init__(self, base: int):
        self.base = base
        self.names: dict[int, str] = {}

    def take(self, offset: int, name: str) -> int:
        port = self.base + offset
        self.names[port] = name
        return port


def text(
    s: str, ports: Ports | None = None, work: str | None = None, root: str | None = None
) -> str:
    if work:
        s = s.replace(work, "<WORK>")
    if root:
        s = s.replace(root, "<ROOT>")
    s = re.sub(r"\b(pid|PID)[ =:]*\d+", "<pid>", s)
    if ports:
        for port in sorted(ports.names, reverse=True):
            s = re.sub(rf"(?<!\d){port}(?!\d)", f"<{ports.names[port]}>", s)
    s = re.sub(r"\bc\d+\b", "c<N>", s)
    return s
