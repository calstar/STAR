#!/usr/bin/env python3
"""Normalisation rules for stack-level characterization goldens — written once, shared.

Anything that legitimately differs between two runs of the same stack on the same commit is
replaced with a stable placeholder here, and nowhere else. Each rule is documented in README.md
("Normalisation rules", N1..N8); a new rule goes in both places.

Library:

    from normalize import Normalizer
    n = Normalizer(now_ms=..., paths={"/abs/fixture": "<fx>"}, ports={26403: "ws"})
    n.value(obj)      # JSON-shaped value -> normalised copy
    n.text(s)         # one string -> normalised string

CLI (JSON in, JSON out; context from a file written by the harness):

    normalize.py --context ctx.json < raw.json > normalised.json

ctx.json: {"now_ms": <run wall clock>, "paths": {"<abs>": "<placeholder>"}, "ports": {"26403": "ws"}}
"""
import json
import re
import sys

# N1. Wall-clock timestamps. A number under one of these keys, or any number within a day of the
# run's own clock (epoch ms), is a timestamp. Numbers far from "now" (a pinned countdown target in
# 2100, a board's millis) are data and are kept.
TS_KEYS = {
    "timestamp",
    "timestampMs",
    "ts",
    "t",
    "at",
    "atMs",
    "tMs",
    "lastHeartbeatMs",
    "missionStartTime",
    "deadlineMs",
    "startTimeMs",
    "lastInboundAt",
    "lastOutboundAt",
    "lastAckMs",
    "lastDeliveredTsMs",
    "openedAt",
    "mtimeMs",
}
DAY_MS = 86_400_000

# N2. Elapsed times measured on the wall clock.
DURATION_KEYS = {"remainingMs", "uptimeMs", "lifetimeMs", "durationMs_measured"}

# N3. Facts about the machine, not the code.
MACHINE_KEYS = {
    "freeDiskBytes": "<bytes>",
    "heapUsedMb": "<mb>",
    "ingestHost": "<lan-name>",  # video/service.ts lanName(): this machine's mDNS name
}

_ISO = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?"
)
_STAMP = re.compile(r"(daq_(?:sim_)?)\d{8}_\d{6}")
_PID = re.compile(r"\b(pid|PID)([ =:]+)\d+")
_UUID = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b")
_EPOCH_IN_TEXT = re.compile(r"\b1[6-9]\d{11}\b")


class Normalizer:
    def __init__(self, now_ms=None, paths=None, ports=None):
        self.now_ms = now_ms
        # N4. Absolute paths: longest first so a nested path wins over its parent.
        self.paths = sorted((paths or {}).items(), key=lambda kv: -len(kv[0]))
        # N5. Ports the harness chose.
        self.ports = {int(k): v for k, v in (ports or {}).items()}
        if self.ports:
            alt = "|".join(str(p) for p in sorted(self.ports, reverse=True))
            self._port_re = re.compile(r"(?<!\d)(" + alt + r")(?!\d)")
        else:
            self._port_re = None

    def is_now(self, v):
        return (
            self.now_ms is not None
            and isinstance(v, (int, float))
            and not isinstance(v, bool)
            and abs(v - self.now_ms) < DAY_MS
        )

    def text(self, s):
        for path, ph in self.paths:
            s = s.replace(path, ph)
        s = _ISO.sub("<iso>", s)  # N1 (strings)
        s = _STAMP.sub(r"\1<stamp>", s)  # N1 (run dir names)
        s = _PID.sub(r"\1\2<pid>", s)  # N6
        s = _UUID.sub("<uuid>", s)  # N7
        if self.now_ms is not None:
            s = _EPOCH_IN_TEXT.sub(
                lambda m: "<ts>" if self.is_now(int(m.group(0))) else m.group(0), s
            )
        if self._port_re:
            s = self._port_re.sub(lambda m: f"<port:{self.ports[int(m.group(1))]}>", s)
        return s

    def value(self, v, key=None):
        if key in MACHINE_KEYS and v is not None:
            return MACHINE_KEYS[key]
        if isinstance(v, dict):
            return {self.text(k): self.value(x, k) for k, x in v.items()}
        if isinstance(v, list):
            return [self.value(x, key) for x in v]
        if isinstance(v, str):
            return self.text(v)
        if isinstance(v, bool) or v is None:
            return v
        if key in DURATION_KEYS:
            return "<dur>"
        if key in TS_KEYS and isinstance(v, (int, float)) and v > 1e11:
            return "<ts>"
        if self.is_now(v):
            return "<ts>"
        if key is not None and "port" in key.lower() and v in self.ports:
            return f"<port:{self.ports[v]}>"
        return v


def main():
    ctx = {}
    if len(sys.argv) == 3 and sys.argv[1] == "--context":
        ctx = json.load(open(sys.argv[2]))
    elif len(sys.argv) != 1:
        raise SystemExit(__doc__)
    n = Normalizer(ctx.get("now_ms"), ctx.get("paths"), ctx.get("ports"))
    json.dump(n.value(json.load(sys.stdin)), sys.stdout, indent=1, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
