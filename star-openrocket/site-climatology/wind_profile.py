#!/usr/bin/env python3
"""Low-altitude wind climatology, pad to 25,000 ft AGL. PLAN.md §21.

The sibling of `temp_profile.py`, on the same soundings and the same height
grid, answering the drift question instead of the density one:

    over the band the vehicle descends through, which way and how hard does the
    wind blow each month, and how much does it vary day to day?

Wind is stored as **u (east) / v (north) components** rather than speed and
direction, because that is what the drift model and RocketPy both consume, and
because components interpolate correctly where speed/direction would swing the
vector the long way round a backing wind. Per grid level and month we publish
the mean vector, the day-to-day speed quantiles (the p95 is the deterministic
"worst-case wind" the Drift tab offers), and the mean bearing the wind blows
from.

IGRA reports wind direction (degrees the wind blows *from*) and speed; the
component conversion and the meteorological convention live in
`igra.Level`/`igra.interp_wind`, kept in step with `physics/wind.py`.

Usage:
    python3 wind_profile.py                        # Edwards+China Lake, 10 yr
    python3 wind_profile.py --station VEF --years 10
"""

import argparse
import csv
import datetime as dt
import math
import os
import statistics
import sys

import igra
import sites
from metar_history import MONTH, pct
from temp_profile import GRID_STEP, height_grid

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")


def profiles(stations, since, until, grid):
    """One (u, v) vector pair per sounding, on the shared grid.

    Pools stations exactly as `temp_profile.profiles` does, and drops whole any
    sounding that cannot supply wind at every grid level -- so each month's
    quantiles down a column rest on the same set of ascents. A sounding may
    cover the temperature grid yet miss wind (older or automated releases),
    which is why this is filtered independently of the temperature pass.
    """
    kept, dropped = [], 0
    per_station = {}
    for station in stations:
        st = sites.UPPER[station]
        snds = igra.load(st.igra_id, since, until, p_floor=30000.0)
        n = 0
        for s in snds:
            ls = igra.build_heights(s, st.elev_m)
            if len(ls) < 5:
                dropped += 1
                continue
            uv = igra.interp_wind(ls, grid)
            if any(u is None or v is None for u, v in uv):
                dropped += 1
                continue
            us = [u for u, v in uv]
            vs = [v for u, v in uv]
            kept.append((s, us, vs))
            n += 1
        per_station[station] = n
    return kept, dropped, per_station


def _dir_from(u_mean, v_mean):
    """Bearing the mean wind blows *from*, degrees clockwise from north.

    The inverse of the component convention: the wind vector (u, v) points where
    the air travels, so the direction it came from is that reversed.
    """
    if u_mean == 0.0 and v_mean == 0.0:
        return 0.0
    return math.degrees(math.atan2(-u_mean, -v_mean)) % 360.0


def monthly(kept, grid):
    """Per calendar month: u/v mean and speed quantiles at every grid height."""
    out = []
    for m in range(1, 13):
        sel = [(us, vs) for s, us, vs in kept if s.month == m]
        if not sel:
            continue
        rec = dict(month=m, n=len(sel), levels=[])
        for i, h in enumerate(grid):
            us_col = [us[i] for us, vs in sel]
            vs_col = [vs[i] for us, vs in sel]
            spd_col = [math.hypot(u, v) for u, v in zip(us_col, vs_col)]
            u_mean = statistics.fmean(us_col)
            v_mean = statistics.fmean(vs_col)
            rec["levels"].append(dict(
                h=h,
                u_mean=u_mean, v_mean=v_mean,
                spd_mean=statistics.fmean(spd_col),
                spd_sd=statistics.pstdev(spd_col) if len(spd_col) > 1 else 0.0,
                spd_p05=pct(spd_col, 0.05),
                spd_p50=pct(spd_col, 0.50),
                spd_p95=pct(spd_col, 0.95),
                dir_mean=_dir_from(u_mean, v_mean),
            ))
        out.append(rec)
    return out


# --- output ----------------------------------------------------------------

COLUMNS = ["month", "n_soundings", "H_msl_m", "H_agl_ft",
           "u_mean_ms", "v_mean_ms", "spd_mean_ms", "spd_sd_ms",
           "spd_p05_ms", "spd_p50_ms", "spd_p95_ms", "dir_mean_deg"]


def write_csv(path, rows, grid):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(COLUMNS)
        H_pad = grid[0]
        for r in rows:
            for lv in r["levels"]:
                w.writerow([r["month"], r["n"], "%.0f" % lv["h"],
                            "%.0f" % ((lv["h"] - H_pad) / 0.3048),
                            "%.2f" % lv["u_mean"], "%.2f" % lv["v_mean"],
                            "%.2f" % lv["spd_mean"], "%.2f" % lv["spd_sd"],
                            "%.2f" % lv["spd_p05"], "%.2f" % lv["spd_p50"],
                            "%.2f" % lv["spd_p95"], "%.1f" % lv["dir_mean"]])


def report(rows, grid, stations, dropped, since, until, per_station):
    H_pad = grid[0]
    print()
    print("WIND PROFILE, %04d-%02d to %04d-%02d"
          % (since[0], since[1], until[0], until[1]))
    for s in stations:
        st = sites.UPPER[s]
        print("  %-4s %-16s %s  %4d usable"
              % (s, st.name, st.igra_id, per_station[s]))
    print("grid %.0f-%.0f m MSL (0-%.0f ft AGL over a %.0f m pad), %.0f m steps"
          % (grid[0], grid[-1], (grid[-1] - H_pad) / 0.3048,
             sites.FAR_ELEV, GRID_STEP))
    print("%d soundings usable, %d dropped (burst low, gappy, or no wind)"
          % (sum(r["n"] for r in rows), dropped))

    show = [i for i, h in enumerate(grid)
            if round((h - H_pad) / 0.3048) % 5000 < GRID_STEP / 0.3048]

    print()
    print("MEAN WIND SPEED (m/s) BY MONTH AND ALTITUDE AGL")
    print("  mon    n  " + "".join("%8.0fft" % ((grid[i] - H_pad) / 0.3048)
                                   for i in show))
    print("  " + "-" * (11 + 10 * len(show)))
    for r in rows:
        print("  %-3s %4d  " % (MONTH[r["month"]], r["n"])
              + "".join("%10.1f" % r["levels"][i]["spd_mean"] for i in show))

    print()
    print("WORST-CASE SPEED (p95, m/s) -- the Drift tab's strong-wind profile")
    print("  mon       " + "".join("%8.0fft" % ((grid[i] - H_pad) / 0.3048)
                                   for i in show))
    print("  " + "-" * (11 + 10 * len(show)))
    for r in rows:
        print("  %-3s       " % MONTH[r["month"]]
              + "".join("%10.1f" % r["levels"][i]["spd_p95"] for i in show))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--station", default=",".join(sites.PRIMARY_UPPER),
                    help="comma-separated IGRA stations to pool: %s (default %s)"
                         % ("/".join(sorted(sites.UPPER)),
                            ",".join(sites.PRIMARY_UPPER)))
    ap.add_argument("--years", type=int, default=10,
                    help="years of soundings to pool (default 10)")
    ap.add_argument("--elev", type=float, default=sites.FAR_ELEV)
    args = ap.parse_args()

    stations = [s.strip().upper() for s in args.station.split(",") if s.strip()]
    unknown = [s for s in stations if s not in sites.UPPER]
    if unknown:
        raise SystemExit("unknown station(s): %s. Known: %s"
                         % (", ".join(unknown), ", ".join(sorted(sites.UPPER))))

    today = dt.date.today()
    until = (today.year, today.month)
    since = (today.year - args.years, today.month)

    grid = height_grid(args.elev)
    print("%s, pooling %d years" % ("+".join(stations), args.years),
          file=sys.stderr)
    kept, dropped, per_station = profiles(stations, since, until, grid)
    if not kept:
        raise SystemExit("no usable soundings in that window")

    rows = monthly(kept, grid)
    os.makedirs(DATA, exist_ok=True)
    tag = "-".join(s.lower() for s in stations)
    write_csv(os.path.join(DATA, "%s-wprofile-monthly.csv" % tag), rows, grid)
    report(rows, grid, stations, dropped, since, until, per_station)
    print()
    print("wrote data/%s-wprofile-monthly.csv" % tag)


if __name__ == "__main__":
    sys.exit(main())
