#!/usr/bin/env python3
"""calibration_service's abort-threshold ADC codes, at inputs where FMA contraction moves them.

    abort_codes.py --cal build/bin/calibration_service            > golden/abort_codes.txt
    abort_codes.py --cal ... --targets 'R1=401.25,...'            (search.py's probe mode)

The service turns each `[abort_pts]` pressure into the raw ADC code the boards compare against,
by bisecting the same forward conversion it streams (`invert_abort_psi_to_adc`, `select_pt_psi`
in calibration_main.cpp). For a `blend` sensor that conversion is `0.75 * robust + 0.25 * cubic`,
which a compiler is free to fuse into one multiply-add (`-ffp-contract=fast`, gcc's default) or
not, and whether gcc fused it used to depend on how it inlined unrelated code in the file
(D-WP9-FMA). The target is now built with `-ffp-contract=off` (services/CMakeLists.txt).

The targets below are not round numbers on purpose: each sits exactly on the unfused result at
some ADC code, where the fused result lands one ULP to the other side, so a fused build answers
a different code (one count off) for every one of them. They were found by `abort_search.py`
against an unfused and an `-ffp-contract=fast -mfma` build of this same source on x86-64; see
README.md. The ordinary targets (round numbers) are the control: they must not move either way.

Hermetic: the service runs in a private temp directory (all its store paths are relative to its
cwd), with a fixture config whose board IP is 127.0.0.21 and an Elodin port nothing listens on.
It writes abort_thresholds.txt at startup, before it dials Elodin; this reads that file and stops
the service. Binds nothing, so it needs no stack lock.

The library's calibration sources (the cubic and robust evaluation) are built -ffp-contract=off
too (lib/CMakeLists.txt), so nothing on the abort path is fused on any architecture and the
boundary half (--part boundary, golden/abort_codes_boundary.txt) must match on arm64 as on x86-64.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

CAL_DIR = "scripts/calibration/calibrations"

# Ten 0-5 V PTs on one board, all on the 75/25 blend. Each has the same three-point bench cubic,
# stretched a little per connector so the ten curves differ.
POINTS = [(214748365.0, 0.0), (1073741824.0, 500.0), (1932735283.0, 1000.0)]
CONNECTORS = range(1, 11)

# Control targets: round numbers, far from any rounding boundary.
CONTROL = {f"R{c}": 100.0 * c for c in CONNECTORS}

# Boundary targets (abort_search.py): the unfused forward value at some ADC code, where the fused
# one differs in the last bit. Keyed by role; repr() round-trips through TOML exactly.
BOUNDARY: dict[str, float] = {
    "R1": 123.45678904946097,
    "R3": 214.32111048746887,
    "R5": 389.62975228886864,
    "R6": 477.284073064969,
    "R9": 824.6913571612856,
    "R10": 740.2470363336288,
}


def stretch(c: int) -> list[tuple[float, float]]:
    k = 1.0 + 0.0137 * c
    return [(adc, psi * k + 0.75 * c) for adc, psi in POINTS]


def config_text(targets: dict[str, float], elodin_port: int) -> str:
    roles = "\n".join(f'"R{c}" = {c}' for c in CONNECTORS)
    models = "\n".join(f'"R{c}" = "blend"' for c in CONNECTORS)
    aborts = "\n".join(f'"{r}" = {repr(float(t))}' for r, t in targets.items())
    return f"""# abort_codes.py fixture: hermetic, never the stand's.
[database]
host = "127.0.0.1"
port = {elodin_port}

[boards.pt_board]
type = "PT"
pt_type = "0-5V ratiometric"
ip = "127.0.0.21"
send_port = 5005
board_id = 21
enabled = true
voltage_reference = 1
active_connectors = [ {", ".join(str(c) for c in CONNECTORS)} ]

[sensor_roles_pt_board]
{roles}

[calibration_model_pt_board]
{models}

[abort_pts]
{aborts}
"""


def store_text() -> str:
    state = {
        str(2100 + c): {
            "role": f"R{c}",
            "points": [{"adc": a, "psi": p, "t": 1757000000.0} for a, p in stretch(c)],
        }
        for c in CONNECTORS
    }
    return json.dumps({"cubic_state": state}, indent=2)


def dead_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def run_service(cal: str, targets: dict[str, float]) -> dict[str, int]:
    """One service start: role -> code (missing role: no threshold emitted)."""
    work = tempfile.mkdtemp(prefix="char_abort_codes.")
    try:
        os.makedirs(os.path.join(work, CAL_DIR))
        with open(os.path.join(work, CAL_DIR, "cubic_calibration.json"), "w") as f:
            f.write(store_text())
        port = dead_port()
        cfg = os.path.join(work, "config.toml")
        with open(cfg, "w") as f:
            f.write(config_text(targets, port))
        out = os.path.join(work, CAL_DIR, "abort_thresholds.txt")
        env = {k: v for k, v in os.environ.items() if not k.startswith("CAL_")}
        log = open(os.path.join(work, "cal.log"), "wb")
        p = subprocess.Popen(
            [cal, "--config", cfg, "--adjustments", os.path.join(work, "adj.json"),
             "--elodin-host", "127.0.0.1", "--elodin-port", str(port)],
            cwd=work, env=env, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + 30
        while not os.path.exists(out) and p.poll() is None and time.monotonic() < deadline:
            time.sleep(0.02)
        if p.poll() is None:
            p.send_signal(signal.SIGTERM)
        try:
            p.wait(10)
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait()
        log.close()
        if not os.path.exists(out):
            sys.stderr.write(open(os.path.join(work, "cal.log"), errors="replace").read()[-3000:])
            raise SystemExit("abort_codes: the service wrote no abort_thresholds.txt")
        by_uid = {}
        for line in open(out):
            if line.startswith("#") or not line.strip():
                continue
            uid, _psi, code = line.split()
            by_uid[int(uid)] = int(code)
        return {f"R{c}": by_uid[2100 + c] for c in CONNECTORS if 2100 + c in by_uid}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cal", required=True)
    ap.add_argument("--part", choices=("control", "boundary"), default="control")
    ap.add_argument("--targets", help="probe mode: role=psi,... ; prints role=code lines")
    a = ap.parse_args()
    a.cal = os.path.abspath(a.cal)
    if a.targets:
        t = {k: float(v) for k, v in (kv.split("=") for kv in a.targets.split(","))}
        for r, c in sorted(run_service(a.cal, t).items()):
            print(f"{r}={c}")
        return 0
    if a.part == "control":
        print("== control: round-number targets (must not move under any contraction policy)")
        got = run_service(a.cal, CONTROL)
        for r in CONTROL:
            print(f"{r} {CONTROL[r]!r} psi -> {got.get(r, 'none')}")
        return 0
    print("== boundary: targets on a fused/unfused rounding edge (unfused is the contract)")
    got = run_service(a.cal, BOUNDARY)
    for r in BOUNDARY:
        print(f"{r} {BOUNDARY[r]!r} psi -> {got.get(r, 'none')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
