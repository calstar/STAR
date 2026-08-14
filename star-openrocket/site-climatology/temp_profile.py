#!/usr/bin/env python3
"""Low-altitude temperature climatology, pad to 25,000 ft AGL.

PLAN.md section 5 builds the profile above the pad from eq (7): one lapse rate,
pinned at the measured pad temperature and swung to hit 216.65 K at 11 km. The
plan is explicit that this is "a slope-setting device, not a claim about
conditions at 11 km" and that real profile accuracy needs a sounding. This
module supplies the soundings and answers the question that follows:

    over the band the vehicle actually flies, how far off is that single
    re-fit lapse rate, and does the answer depend on the month?

Output is a monthly T(H) table on a fixed height grid plus, per month, the
lapse rate that best fits the real profile over the flight band -- which is the
number a Phase 2 eq (7) would use in place of the tropopause anchor.

Heights are GEOPOTENTIAL (H) everywhere in this module, never geometric (z).
IGRA reports geopotential, eqs (2)/(3)/(4)/(7) consume geopotential, and the
hypsometric integration in igra.build_heights produces geopotential. Eq (1) is
applied once, at the two ends of the grid, and nowhere else. See README.

Usage:
    python3 temp_profile.py                        # Edwards, last 10 years
    python3 temp_profile.py --station VEF --years 10
    python3 temp_profile.py --years 1              # the last year alone
"""

import argparse
import csv
import datetime as dt
import math
import os
import statistics
import sys

from _padstate import pad_state
import igra
import sites
from metar_history import MONTH, pct

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

GRID_STEP = 250.0   # m. Finer than the sounding's own significant-level spacing
                    # would be interpolation theatre.


def height_grid(pad_elev=sites.FAR_ELEV, ceiling=sites.CEILING_MSL_M):
    """MSL geopotential heights from the pad to the 25 kft AGL ceiling."""
    H_pad = pad_state.geopotential(pad_elev)
    H_top = pad_state.geopotential(ceiling)
    n = int(math.ceil((H_top - H_pad) / GRID_STEP))
    return [H_pad + i * GRID_STEP for i in range(n + 1)]


def profiles(stations, since, until, grid):
    """One temperature vector per sounding, on the shared grid.

    Takes a list of stations and pools them. Edwards and China Lake are 49 km
    and 38 km from the pad and 40 km from each other -- same high desert, same
    elevation band, same terrain -- and each alone is too sparse: Edwards is a
    test-range operation whose rate has fallen from 160/yr to 41/yr, and China
    Lake runs a steady ~50/yr. Together they are 50% more data than Edwards
    alone, with China Lake covering exactly the years Edwards thinned out.

    Pooling stations that are NOT in the same regime would be wrong, which is
    why Las Vegas stays a separate run rather than joining the default.

    Soundings that cannot cover the grid -- balloon burst low, or a run of
    missing temperatures -- are dropped whole rather than left with holes, so
    every grid level in a given month is backed by the same set of ascents and
    the quantiles down the column are internally consistent.
    """
    kept, dropped, resid = [], 0, []
    per_station = {}
    for station in stations:
        st = sites.UPPER[station]
        # 300 hPa is ~9.2 km ISA, comfortably above the 8.23 km ceiling, and
        # keeps one level beyond the top for interpolation to bracket against.
        snds = igra.load(st.igra_id, since, until, p_floor=30000.0)
        n = 0
        for s in snds:
            ls = igra.build_heights(s, st.elev_m)
            if len(ls) < 5:
                dropped += 1
                continue
            ts = igra.interp(ls, grid)
            if any(t is None for t in ts):
                dropped += 1
                continue
            resid.extend(igra.gph_residual(ls))
            kept.append((s, ts))
            n += 1
        per_station[station] = n
    return kept, dropped, resid, per_station


def fit_lapse(grid, ts):
    """Least-squares dT/dH over the whole grid, K/m. Negative = cooling up.

    A least-squares fit rather than the two endpoints, because the endpoints
    are exactly where a surface inversion or the balloon's last good level
    would dominate a number meant to describe the column.
    """
    n = len(grid)
    mh, mt = statistics.fmean(grid), statistics.fmean(ts)
    sxx = sum((h - mh) ** 2 for h in grid)
    sxy = sum((h - mh) * (t - mt) for h, t in zip(grid, ts))
    return sxy / sxx


def eq7_profile(T_pad, grid):
    """What PLAN.md eq (7) predicts for this pad temperature."""
    H_pad = grid[0]
    L = pad_state.refit_lapse(T_pad, H_pad)
    return [T_pad + L * (h - H_pad) for h in grid], L


def monthly(kept, grid):
    """Per calendar month: T quantiles at every grid height, plus lapse fits."""
    out = []
    for m in range(1, 13):
        sel = [ts for s, ts in kept if s.month == m]
        if not sel:
            continue
        rec = dict(month=m, n=len(sel), levels=[])
        for i, h in enumerate(grid):
            col = [ts[i] for ts in sel]
            rec["levels"].append(dict(
                h=h, mean=statistics.fmean(col),
                p05=pct(col, 0.05), p50=pct(col, 0.50), p95=pct(col, 0.95),
                sd=statistics.pstdev(col) if len(col) > 1 else 0.0,
            ))
        # Fit each sounding separately, then take the spread of the fits. The
        # lapse rate of the mean profile is not the mean of the lapse rates
        # once the mean smears inversions that sit at different heights.
        fits = [fit_lapse(grid, ts) for ts in sel]
        rec["L_mean"] = statistics.fmean(fits)
        rec["L_p05"], rec["L_p95"] = pct(fits, 0.05), pct(fits, 0.95)
        rec["L_sd"] = statistics.pstdev(fits) if len(fits) > 1 else 0.0

        # And what eq (7) would have said, driven by the same soundings' own
        # surface temperature. This is the comparison the module exists for.
        e7 = []
        for ts in sel:
            _, L7 = eq7_profile(ts[0], grid)
            e7.append(L7)
        rec["L_eq7_mean"] = statistics.fmean(e7)

        mean_prof = [lv["mean"] for lv in rec["levels"]]
        pred, _ = eq7_profile(mean_prof[0], grid)
        rec["eq7_err"] = [p - t for p, t in zip(pred, mean_prof)]
        out.append(rec)
    return out


# --- output ----------------------------------------------------------------

def write_csv(path, rows, grid, pad_elev):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        # Heights are GEOPOTENTIAL throughout -- H, not z. That is what eqs
        # (2), (3), (4) and (7) consume, so the table is directly usable and
        # the caller applies eq (1) once, at its own boundary. The two differ
        # by 10 m at the top of this grid; enough to matter if you mix them,
        # not enough to notice if you do not.
        w.writerow(["month", "n_soundings", "H_msl_m", "H_agl_ft",
                    "T_mean_k", "T_sd_k", "T_p05_k", "T_p50_k", "T_p95_k",
                    "eq7_minus_measured_k"])
        H_pad = grid[0]
        for r in rows:
            for lv, e in zip(r["levels"], r["eq7_err"]):
                w.writerow([r["month"], r["n"], "%.0f" % lv["h"],
                            "%.0f" % ((lv["h"] - H_pad) / 0.3048),
                            "%.2f" % lv["mean"], "%.2f" % lv["sd"],
                            "%.2f" % lv["p05"], "%.2f" % lv["p50"],
                            "%.2f" % lv["p95"], "%+.2f" % e])


def write_lapse_csv(path, rows):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["month", "n_soundings", "L_fit_mean_k_per_km",
                    "L_fit_sd", "L_fit_p05", "L_fit_p95",
                    "L_eq7_mean_k_per_km", "L_isa_k_per_km"])
        for r in rows:
            w.writerow([r["month"], r["n"],
                        "%.3f" % (r["L_mean"] * 1000),
                        "%.3f" % (r["L_sd"] * 1000),
                        "%.3f" % (r["L_p05"] * 1000),
                        "%.3f" % (r["L_p95"] * 1000),
                        "%.3f" % (r["L_eq7_mean"] * 1000),
                        "%.3f" % (pad_state.L0 * 1000)])


def report(rows, grid, stations, dropped, resid, since, until, per_station):
    H_pad = grid[0]
    print()
    print("TEMPERATURE PROFILE, %04d-%02d to %04d-%02d"
          % (since[0], since[1], until[0], until[1]))
    for s in stations:
        st = sites.UPPER[s]
        print("  %-4s %-16s %s  %4d usable"
              % (s, st.name, st.igra_id, per_station[s]))
    print("grid %.0f-%.0f m MSL (0-%.0f ft AGL over a %.0f m pad), %.0f m steps"
          % (grid[0], grid[-1], (grid[-1] - H_pad) / 0.3048,
             sites.FAR_ELEV, GRID_STEP))
    print("%d soundings usable, %d dropped (burst low or gappy)"
          % (sum(r["n"] for r in rows), dropped))
    if resid:
        print("QC: hydrostatic height minus reported GPH, median %+.0f m, "
              "p95 |%.0f| m over %d mandatory levels"
              % (statistics.median(resid),
                 pct([abs(x) for x in resid], 0.95), len(resid)))

    print()
    print("MEAN T (K) BY MONTH AND ALTITUDE AGL")
    show = [i for i, h in enumerate(grid)
            if round((h - H_pad) / 0.3048) % 5000 < GRID_STEP / 0.3048]
    print("  mon    n  " + "".join("%8.0fft" % ((grid[i] - H_pad) / 0.3048)
                                   for i in show))
    print("  " + "-" * (11 + 10 * len(show)))
    for r in rows:
        print("  %-3s %4d  " % (MONTH[r["month"]], r["n"])
              + "".join("%10.1f" % r["levels"][i]["mean"] for i in show))

    print()
    print("SPREAD (p95-p05, K) -- how much a month varies day to day")
    print("  mon       " + "".join("%8.0fft" % ((grid[i] - H_pad) / 0.3048)
                                   for i in show))
    print("  " + "-" * (11 + 10 * len(show)))
    for r in rows:
        print("  %-3s       " % MONTH[r["month"]]
              + "".join("%10.1f" % (r["levels"][i]["p95"] - r["levels"][i]["p05"])
                        for i in show))

    print()
    print("LAPSE RATE over the flight band, K/km. ISA is %.3f."
          % (pad_state.L0 * 1000))
    print("L_fit is least squares on each sounding; L_eq7 is what PLAN.md")
    print("eq (7) infers from that same sounding's surface temperature.")
    print()
    print("  mon    n   L_fit   sd    p05     p95    L_eq7    eq7 error")
    print("  " + "-" * 58)
    for r in rows:
        print("  %-3s %4d  %6.3f %5.3f %6.3f %7.3f %8.3f %9.3f"
              % (MONTH[r["month"]], r["n"], r["L_mean"] * 1000, r["L_sd"] * 1000,
                 r["L_p05"] * 1000, r["L_p95"] * 1000, r["L_eq7_mean"] * 1000,
                 (r["L_eq7_mean"] - r["L_mean"]) * 1000))

    print()
    print("WHAT eq (7) COSTS: predicted minus measured mean T, K")
    print("and the resulting density error at that height (rho ~ 1/T).")
    print()
    print("  mon   " + "".join("%9.0fft" % ((grid[i] - H_pad) / 0.3048)
                               for i in show[1:]))
    print("  " + "-" * (6 + 11 * (len(show) - 1)))
    for r in rows:
        line = "  %-3s   " % MONTH[r["month"]]
        for i in show[1:]:
            e = r["eq7_err"][i]
            drho = -e / r["levels"][i]["mean"] * 100
            line += "%6.1f/%+.1f%%" % (e, drho)
        print(line)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--station", default=",".join(sites.PRIMARY_UPPER),
                    help="comma-separated IGRA stations to pool: %s "
                         "(default %s)"
                         % ("/".join(sorted(sites.UPPER)),
                            ",".join(sites.PRIMARY_UPPER)))
    ap.add_argument("--years", type=int, default=10,
                    help="years of soundings to pool (default 10). One year is "
                         "not enough at these stations -- see README.")
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
    kept, dropped, resid, per_station = profiles(stations, since, until, grid)
    if not kept:
        raise SystemExit("no usable soundings in that window")

    rows = monthly(kept, grid)
    os.makedirs(DATA, exist_ok=True)
    tag = "-".join(s.lower() for s in stations)
    write_csv(os.path.join(DATA, "%s-tprofile-monthly.csv" % tag),
              rows, grid, args.elev)
    write_lapse_csv(os.path.join(DATA, "%s-lapse-monthly.csv" % tag), rows)
    report(rows, grid, stations, dropped, resid, since, until, per_station)
    print()
    print("wrote data/%s-tprofile-monthly.csv and data/%s-lapse-monthly.csv"
          % (tag, tag))


if __name__ == "__main__":
    sys.exit(main())
