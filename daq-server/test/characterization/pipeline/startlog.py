#!/usr/bin/env python3
"""The backend's startup log, from its first line to the end of its synchronous start (G12).

    startlog.py <backend.log> <context.json> <out.txt>

run.sh startlog starts src/server.ts alone -- the pt fixture's environment, nothing listening on
any of its ports -- and stops it once it has logged the last line of its listen callback's
synchronous part (`[ThinServer] Actuator service: localhost:<port>`, server.ts). Everything the
process wrote up to and including that line is one deterministic sequence: ESM import evaluation
(the state-CSV loaders' import-time reads and warnings, the session manager's construction), then
server.ts's top level statement by statement (GUI downsampling, the PT calibration search, the
sensor-role map, `Loaded N boards`, the state-actuator CSV search with its `Trying:` lines, the
GUI static server), then `listen`. What follows is I/O-ordered -- the Elodin connect refusals,
the video gateway's, the board-log receiver's bind -- and is cut, not frozen (DESIGN-WP6 §6.3,
startup-log diff; LEDGER D96).

Normalisation is normalize.py's (paths, ports, timestamps, pids) plus ANSI colour codes
stripped (console.log colours an object dump when the environment says the terminal can show it;
FORCE_COLOR / TERM differ between a developer shell, the gate and the Linux container). Nothing
else: a moved, added or dropped line, or a line in another position, is a difference. The file is read as
written (stdout and stderr interleaved by the process itself; both are synchronous file writes
in Node, so their order is the program's).
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from normalize import Normalizer  # noqa: E402

END_MARK = "[ThinServer] Actuator service: localhost:"
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def main():
    log_path, ctx_path, out_path = sys.argv[1:4]
    ctx = json.load(open(ctx_path))
    n = Normalizer(ctx.get("now_ms"), ctx.get("paths"), ctx.get("ports"))
    lines = open(log_path, errors="replace").read().split("\n")
    out = [
        "## backend startup log, first line to the end of the synchronous start (G12)"
    ]
    ended = False
    for ln in lines:
        out.append(n.text(ANSI.sub("", ln.rstrip("\r"))))
        if ln.startswith(END_MARK):
            ended = True
            break
    if not ended:
        out.append(
            "<< the end mark never appeared: the backend did not reach its listen callback >>"
        )
    out.append("")
    with open(out_path, "w") as f:
        f.write("\n".join(out))
    return 0 if ended else 1


if __name__ == "__main__":
    sys.exit(main())
