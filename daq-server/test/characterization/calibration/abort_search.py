#!/usr/bin/env python3
"""Find abort targets that sit on a fused/unfused rounding edge (feeds abort_codes.py BOUNDARY).

    abort_search.py --unfused build/bin/calibration_service --fused <fma build>

Developer tool, not a test. `--fused` is the same source with calibration_main.cpp compiled
`-ffp-contract=fast -mfma` and linked against the same library objects (README.md says how), so
the two binaries differ only in whether the service's own multiply-adds are fused.

For each role: c = the unfused code at a starting target T0; u = the largest double T whose
unfused code is still <= c, found by bisecting the bit patterns of doubles (so u is the unfused
forward value at code c, to the bit). The fused build is then asked at u and at the next double
up; where it answers a different code, that target separates the two and is printed.
"""

from __future__ import annotations

import argparse
import struct
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def probe(cal: str, targets: dict[str, float]) -> dict[str, int]:
    arg = ",".join(f"{r}={t!r}" for r, t in targets.items())
    out = subprocess.run(
        [sys.executable, str(HERE / "abort_codes.py"), "--cal", cal, "--targets", arg],
        check=True, capture_output=True, text=True,
    ).stdout
    return {k: int(v) for k, v in (ln.split("=") for ln in out.split())}


def ordinal(x: float) -> int:
    return struct.unpack("<q", struct.pack("<d", x))[0]  # positive doubles only


def from_ordinal(n: int) -> float:
    return struct.unpack("<d", struct.pack("<q", n))[0]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--unfused", required=True)
    ap.add_argument("--fused", required=True)
    ap.add_argument("--rounds", type=int, default=6)
    a = ap.parse_args()
    roles = [f"R{c}" for c in range(1, 11)]
    found: dict[str, float] = {}
    for rnd in range(a.rounds):
        todo = [r for r in roles if r not in found]
        if not todo:
            break
        t0 = {r: 123.456789 + 87.654321 * i + 3.21 * rnd for i, r in enumerate(todo)}
        c = probe(a.unfused, t0)
        lo = {r: ordinal(t0[r]) for r in todo}  # U(lo) <= c
        hi = {r: ordinal(t0[r] + 0.01) for r in todo}  # U(hi) > c (0.01 psi is ~2e4 codes)
        assert all(v > c[r] for r, v in probe(a.unfused, {r: from_ordinal(hi[r]) for r in todo}).items())
        while any(hi[r] - lo[r] > 1 for r in todo):
            mid = {r: (lo[r] + hi[r]) // 2 for r in todo}
            got = probe(a.unfused, {r: from_ordinal(mid[r]) for r in todo})
            for r in todo:
                if hi[r] - lo[r] <= 1:
                    continue
                if got[r] <= c[r]:
                    lo[r] = mid[r]
                else:
                    hi[r] = mid[r]
        u = {r: from_ordinal(lo[r]) for r in todo}
        nxt = {r: from_ordinal(lo[r] + 1) for r in todo}
        fu, fn = probe(a.fused, u), probe(a.fused, nxt)
        uu, un = probe(a.unfused, u), probe(a.unfused, nxt)
        for r in todo:
            if fu[r] != uu[r]:
                found[r] = u[r]
            elif fn[r] != un[r]:
                found[r] = nxt[r]
            print(f"round {rnd} {r}: c={c[r]} u={u[r]!r} unfused {uu[r]}/{un[r]} fused {fu[r]}/{fn[r]}",
                  file=sys.stderr)
    for r in roles:
        if r in found:
            print(f'    "{r}": {found[r]!r},')
    return 0 if found else 1


if __name__ == "__main__":
    sys.exit(main())
