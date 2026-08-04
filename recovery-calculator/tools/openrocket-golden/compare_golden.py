#!/usr/bin/env python3
"""Diff `physics/openrocket.py` against a run exported from OpenRocket itself.

    python3 tools/openrocket-golden/compare_golden.py CONFIG.json GOLDEN.csv

Every other test of the port compares it against source that was read. This
compares it against the program that was run, which is the only check that can
catch a misreading. See the README next to this file for how to produce the CSV.

Stdlib only, like the rest of `tools/` -- no venv needed to parse a CSV, and
the physics import is the one thing that does need the project on `sys.path`.
"""

import argparse
import csv
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

# OpenRocket's CSV headers, lower-cased, with the unit suffix it appends.
# Matched by prefix so "Altitude (m)" and "Altitude" both land.
COLUMNS = {
    "t": ("time",),
    "z": ("altitude",),
    "v": ("vertical velocity",),
    "a": ("vertical acceleration",),
}

# Past these the port and the program are not describing the same descent.
# Altitude and velocity are the load-bearing channels; acceleration is spiky by
# construction on OpenRocket's side (the canopy opens between two integration
# points) so it gets a looser bound.
TOLERANCE = {"z": 0.01, "v": 0.01, "a": 0.10}


def read_golden(path):
    """Parse an OpenRocket CSV export into {channel: [values]}.

    Handles the two things the export does that a naive reader trips on: the
    leading comment block (lines beginning with `#`, which includes the header
    on some versions) and the unit suffix on every column name.
    """
    with open(path, encoding="utf-8-sig", newline="") as handle:
        raw = [line for line in handle
               if line.strip() and not line.strip().startswith("#")]

    # Some exports put the header inside the comment block. Recover it.
    if raw:
        probe = next(csv.reader([raw[0]]))
        if _looks_numeric(probe):
            with open(path, encoding="utf-8-sig") as handle:
                for line in handle:
                    if line.strip().startswith("#") and "," in line:
                        raw.insert(0, line.strip().lstrip("#").strip())
                        break

    rows = list(csv.reader(raw))
    if len(rows) < 2:
        raise SystemExit("%s has no data rows" % path)

    header = [h.strip().lower() for h in rows[0]]
    index = {}
    for channel, prefixes in COLUMNS.items():
        for i, name in enumerate(header):
            if any(name.startswith(p) for p in prefixes):
                index[channel] = i
                break
    missing = [c for c in COLUMNS if c not in index]
    if missing:
        raise SystemExit(
            "%s is missing column(s) %s. Re-export with Time, Altitude, "
            "Vertical velocity and Vertical acceleration selected.\nSaw: %s"
            % (path, ", ".join(missing), ", ".join(header)))

    out = {c: [] for c in COLUMNS}
    for row in rows[1:]:
        if len(row) <= max(index.values()):
            continue
        try:
            values = {c: float(row[index[c]]) for c in COLUMNS}
        except ValueError:
            continue  # a stray blank row at the end of a run
        # `float("NaN")` parses happily, so a NaN row survives the try/except
        # and then poisons every comparison downstream -- max() over a list
        # containing NaN is NaN, and NaN <= tolerance is False, so the check
        # fails with no indication that the *input* was the problem.
        # OpenRocket writes NaN into the final row of some exports.
        if not all(v == v and abs(v) != float("inf") for v in values.values()):
            continue
        for c, v in values.items():
            out[c].append(v)
    if not out["t"]:
        raise SystemExit("%s parsed to zero usable rows" % path)
    return out


def _looks_numeric(row):
    try:
        float(row[0])
        return True
    except (ValueError, IndexError):
        return False


def interpolate(ts, vs, t):
    """`vs` sampled at `t`. The two runs do not share a time grid."""
    if t <= ts[0]:
        return vs[0]
    if t >= ts[-1]:
        return vs[-1]
    lo, hi = 0, len(ts) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if ts[mid] <= t:
            lo = mid
        else:
            hi = mid
    span = ts[hi] - ts[lo]
    if span <= 0.0:
        return vs[lo]
    f = (t - ts[lo]) / span
    return vs[lo] + (vs[hi] - vs[lo]) * f


def compare(config_path, golden_path, verbose=True):
    """Returns {channel: relative deviation}. Empty means nothing comparable."""
    from physics.openrocket import simulate
    from physics.schema import Config

    with open(config_path, encoding="utf-8") as handle:
        config = Config.model_validate(json.load(handle))

    golden = read_golden(golden_path)
    run = simulate(config)
    ours = {"t": run.traj.t, "z": run.traj.z, "v": run.traj.v, "a": run.traj.a}

    # Compare on the golden run's own grid, over the span both cover.
    t_end = min(golden["t"][-1], ours["t"][-1])
    samples = [t for t in golden["t"] if t <= t_end]

    deviations = {}
    for channel in ("z", "v", "a"):
        scale = max(abs(v) for v in golden[channel]) or 1.0
        worst = 0.0
        for i, t in enumerate(samples):
            mine = interpolate(ours["t"], ours[channel], t)
            worst = max(worst, abs(mine - golden[channel][i]) / scale)
        deviations[channel] = worst

    if verbose:
        print("golden : %s  (%d rows, 0 - %.2f s)"
              % (os.path.basename(golden_path), len(golden["t"]),
                 golden["t"][-1]))
        print("port   : %d steps, 0 - %.2f s" % (len(ours["t"]), ours["t"][-1]))
        print("compared over 0 - %.2f s\n" % t_end)
        print("  %-10s %12s %10s %8s" % ("channel", "worst dev", "tolerance",
                                         ""))
        for channel in ("z", "v", "a"):
            ok = deviations[channel] <= TOLERANCE[channel]
            print("  %-10s %11.3f%% %9.1f%% %8s"
                  % (channel, 100 * deviations[channel],
                     100 * TOLERANCE[channel], "ok" if ok else "FAIL"))
        print()
        print("  descent time  golden %.3f s   port %.3f s   (%+.2f%%)"
              % (golden["t"][-1], run.t_ground,
                 100 * (run.t_ground / golden["t"][-1] - 1.0)))

    return deviations


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Diff physics/openrocket.py against an OpenRocket CSV "
                    "export. See the README beside this script.")
    ap.add_argument("config", help="the JSON config the golden run matches")
    ap.add_argument("golden", help="CSV exported from OpenRocket 24.12")
    args = ap.parse_args(argv)

    deviations = compare(args.config, args.golden)
    bad = [c for c, d in deviations.items() if d > TOLERANCE[c]]
    if bad:
        print("\nFAIL: %s outside tolerance." % ", ".join(sorted(bad)))
        print("Read the README's 'What a disagreement means' before assuming "
              "the port is wrong — the coast phase and a mismatched vehicle "
              "are both likelier.")
        return 1
    print("\nOK: the port reproduces the golden run.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
