#!/usr/bin/env python3
"""Pad pressure climatology from a year of archived METARs.

PLAN.md section 5 offers three sources for p_pad and ranks them by error, but
the ranking is stated as a single number per source. It cannot say whether the
~2% attributed to eq (7a) is a January number or a July number, and that is the
question this module answers: pull every hourly observation from the nearest
reporting field for a year, run each one through eq (7b), and bin by month.

Source is the Iowa State Mesonet ASOS archive rather than the Aviation Weather
Center. AWC's /api/data/metar serves the current observation and a short recent
window -- it is what pad-state uses and the right thing for launch day -- but it
does not serve a year of history. IEM archives the same NWS/FAA observations and
returns the raw METAR string alongside its decoded fields, so nothing is taken
on trust that pad_state.parse_metar cannot re-derive.

Stdlib only, matching pad-state and fruity-chute-scraper.

Usage:
    python3 metar_history.py                       # last 12 months, KNID
    python3 metar_history.py --station KMHV --months 24
    python3 metar_history.py --no-fetch            # re-aggregate from cache
"""

import argparse
import csv
import datetime as dt
import io
import math
import os
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from _padstate import pad_state
import sites

IEM = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py"

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache", "asos")
DATA = os.path.join(HERE, "data")

# Daylight launch window in UTC. FAR runs UTC-7 (PDT) most of the year, so
# 15-23Z is roughly 08:00-16:00 local. Reported alongside the all-hours figure
# because the diurnal swing in temperature is larger than the entire seasonal
# swing in pressure, and nobody flies at 3 a.m.
LAUNCH_HOURS_UTC = range(15, 24)


# --- fetch -----------------------------------------------------------------

def month_range(months_back, end=None):
    """The last `months_back` complete calendar months, oldest first."""
    end = end or dt.date.today()
    y, m = end.year, end.month
    out = []
    for _ in range(months_back):
        m -= 1
        if m == 0:
            y, m = y - 1, 12
        out.append((y, m))
    return list(reversed(out))


def fetch_month(station, year, month, refetch=False):
    """One calendar month of routine observations. Cached on disk.

    Chunked by month so a re-run costs one request per new month rather than a
    full year, and so a partial failure loses one month instead of everything.
    """
    st = sites.SURFACE[station]
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, "%s-%04d-%02d.csv" % (st.iem_id, year, month))
    if os.path.exists(path) and not refetch:
        with open(path) as f:
            return f.read()

    first = dt.date(year, month, 1)
    last = dt.date(year + (month == 12), month % 12 + 1, 1)
    params = {
        "station": st.icao,
        "data": ["metar", "alti", "tmpf", "dwpf"],
        "year1": first.year, "month1": first.month, "day1": first.day,
        "year2": last.year, "month2": last.month, "day2": last.day,
        "tz": "UTC",
        "format": "onlycomma",
        "latlon": "no",
        "elev": "yes",
        "missing": "M",
        "trace": "T",
        "direct": "no",
        "report_type": 3,   # routine hourly only; 4 would add SPECIs
    }
    url = IEM + "?" + urllib.parse.urlencode(params, doseq=True)
    text = _get(url)

    # A month with a header and nothing else means the station did not report,
    # which is a real finding -- cache it so we do not re-ask every run.
    with open(path, "w") as f:
        f.write(text)
    return text


def _get(url, tries=4):
    """GET with backoff. IEM throttles rather than failing outright."""
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return r.read().decode("utf-8", "replace")
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == tries - 1:
                raise
            wait = 2 ** attempt
            print("  retry in %ds (%s)" % (wait, e), file=sys.stderr)
            time.sleep(wait)


# --- decode ----------------------------------------------------------------

class Obs:
    __slots__ = ("time", "hour", "month", "altim_pa", "t_station_c",
                 "dewp_c", "p_pad", "t_pad", "rho_pad")


def decode(text, station, pad_elev=sites.FAR_ELEV):
    """Rows of IEM CSV -> pad state per observation.

    Two conversions, and they are the whole point of the module:

      p_pad  eq (7b), the altimeter setting run down the standard column to pad
             elevation. Never the reported setting itself -- that is an 11-18%
             density error at these elevations (PLAN.md section 5).
      T_pad  the station temperature lapse-transferred across the elevation gap
             at the standard -6.5 K/km, the same convention pad_state --station-elev
             uses.
    """
    st = sites.SURFACE[station]
    H_pad = pad_state.geopotential(pad_elev)
    out = []
    for row in csv.DictReader(io.StringIO(text)):
        raw = (row.get("metar") or "").strip()
        if not raw:
            continue
        try:
            ob = pad_state.parse_metar(raw)
        except ValueError:
            # No temperature group. Overnight KNID observations are like this:
            # 'KNID 010656Z AUTO A2985 RMK AO2 SLPNO PWINO $'. The altimeter is
            # still there and pressure is what we came for, so keep the row.
            ob = None

        altim_pa = ob.altim_pa if ob and ob.altim_pa is not None else None
        if altim_pa is None:
            alti = row.get("alti", "M")
            if alti not in ("M", "", None):
                altim_pa = float(alti) * pad_state.INHG
        if altim_pa is None:
            continue

        o = Obs()
        o.time = row["valid"]
        o.hour = int(row["valid"][11:13])
        o.month = int(row["valid"][5:7])
        o.altim_pa = altim_pa
        o.t_station_c = ob.temp_c if ob else None
        o.dewp_c = ob.dewp_c if ob else None
        o.p_pad = pad_state.p_pad_metar(altim_pa, H_pad)

        if o.t_station_c is None:
            o.t_pad = o.rho_pad = None
        else:
            T_st = o.t_station_c + 273.15
            o.t_pad = T_st - pad_state.L0 * (st.elev_m - pad_elev)
            o.rho_pad = pad_state.density(o.p_pad, o.t_pad)
        out.append(o)
    return out


# --- aggregate -------------------------------------------------------------

def pct(xs, q):
    """Linear-interpolated percentile of a sorted-able sequence, q in [0,1]."""
    s = sorted(xs)
    if not s:
        return float("nan")
    i = q * (len(s) - 1)
    lo = int(math.floor(i))
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (i - lo)


def summarise(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return dict(n=0)
    return dict(
        n=len(xs),
        mean=statistics.fmean(xs),
        sd=statistics.pstdev(xs) if len(xs) > 1 else 0.0,
        min=min(xs), p05=pct(xs, 0.05), p50=pct(xs, 0.50),
        p95=pct(xs, 0.95), max=max(xs),
    )


def monthly(obs, launch_hours_only=False):
    """Per calendar month, the three numbers section 5 consumes."""
    rows = []
    for m in range(1, 13):
        sel = [o for o in obs if o.month == m]
        if launch_hours_only:
            sel = [o for o in sel if o.hour in LAUNCH_HOURS_UTC]
        if not sel:
            continue
        rows.append(dict(
            month=m,
            p=summarise([o.p_pad for o in sel]),
            T=summarise([o.t_pad for o in sel]),
            rho=summarise([o.rho_pad for o in sel]),
        ))
    return rows


# --- output ----------------------------------------------------------------

MONTH = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
         "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def write_obs_csv(path, obs, station):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time_utc", "station", "altim_pa", "t_station_c",
                    "dewp_c", "p_pad_pa", "t_pad_k", "rho_pad"])
        for o in obs:
            w.writerow([
                o.time, station, "%.1f" % o.altim_pa,
                "" if o.t_station_c is None else "%.1f" % o.t_station_c,
                "" if o.dewp_c is None else "%.1f" % o.dewp_c,
                "%.1f" % o.p_pad,
                "" if o.t_pad is None else "%.2f" % o.t_pad,
                "" if o.rho_pad is None else "%.5f" % o.rho_pad,
            ])


def write_monthly_csv(path, rows, rows_lw):
    lw = {r["month"]: r for r in rows_lw}
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            "month", "n_obs",
            "p_pad_mean_pa", "p_pad_sd_pa", "p_pad_p05_pa", "p_pad_p95_pa",
            "p_pad_min_pa", "p_pad_max_pa",
            "T_pad_n", "T_pad_mean_k", "T_pad_sd_k", "T_pad_p05_k", "T_pad_p95_k",
            "rho_pad_mean", "rho_pad_p05", "rho_pad_p95",
            "lw_T_pad_n", "lw_T_pad_mean_k", "lw_T_pad_p05_k", "lw_T_pad_p95_k",
            "lw_rho_pad_mean",
        ])
        for r in rows:
            p, T, rho = r["p"], r["T"], r["rho"]
            q = lw.get(r["month"], {})
            qT = q.get("T", dict(n=0))
            qr = q.get("rho", dict(n=0))
            w.writerow([
                r["month"], p["n"],
                "%.1f" % p["mean"], "%.1f" % p["sd"], "%.1f" % p["p05"],
                "%.1f" % p["p95"], "%.1f" % p["min"], "%.1f" % p["max"],
                T["n"],
                *(["", "", "", ""] if not T["n"] else
                  ["%.2f" % T["mean"], "%.2f" % T["sd"],
                   "%.2f" % T["p05"], "%.2f" % T["p95"]]),
                *(["", "", ""] if not rho["n"] else
                  ["%.5f" % rho["mean"], "%.5f" % rho["p05"], "%.5f" % rho["p95"]]),
                qT.get("n", 0),
                *(["", "", ""] if not qT.get("n") else
                  ["%.2f" % qT["mean"], "%.2f" % qT["p05"], "%.2f" % qT["p95"]]),
                "" if not qr.get("n") else "%.5f" % qr["mean"],
            ])


def report(rows, rows_lw, station, pad_elev):
    H_pad = pad_state.geopotential(pad_elev)
    p_isa = pad_state.p_pad_isa(H_pad)
    T_isa = pad_state.T0 + pad_state.L0 * H_pad
    rho_isa = pad_state.density(p_isa, T_isa)
    lw = {r["month"]: r for r in rows_lw}

    print()
    print("PAD PRESSURE, from %s, referred to %.0f m MSL by eq (7b)"
          % (station, pad_elev))
    print("eq (7a) standard-column default at this elevation: %.0f Pa" % p_isa)
    print()
    print("  mon     n    mean Pa   sd     p05      p95    vs eq(7a)   spread")
    print("  " + "-" * 66)
    for r in rows:
        p = r["p"]
        print("  %-3s %5d  %9.0f %5.0f %8.0f %8.0f   %+6.2f%%   %+.2f/%+.2f%%"
              % (MONTH[r["month"]], p["n"], p["mean"], p["sd"], p["p05"], p["p95"],
                 (p["mean"] / p_isa - 1) * 100,
                 (p["p05"] / p["mean"] - 1) * 100,
                 (p["p95"] / p["mean"] - 1) * 100))
    allp = [r["p"]["mean"] for r in rows]
    print("  " + "-" * 66)
    print("  seasonal swing in the monthly mean: %.0f Pa, %.2f%% of the mean"
          % (max(allp) - min(allp), (max(allp) - min(allp)) / statistics.fmean(allp) * 100))

    print()
    print("PAD TEMPERATURE, lapse-transferred from %s. ISA here is %.2f K."
          % (station, T_isa))
    print("Launch-window columns are %02d-%02dZ only (~08-16 local)."
          % (LAUNCH_HOURS_UTC[0], LAUNCH_HOURS_UTC[-1]))
    print()
    print("  mon        all hours              launch window        dT vs ISA")
    print("        mean K   p05    p95      mean K   p05    p95     (window)")
    print("  " + "-" * 66)
    for r in rows:
        T = r["T"]
        if not T["n"]:
            continue
        q = lw.get(r["month"], {}).get("T", dict(n=0))
        if q["n"]:
            print("  %-3s %8.1f %6.1f %6.1f   %8.1f %6.1f %6.1f   %+8.1f"
                  % (MONTH[r["month"]], T["mean"], T["p05"], T["p95"],
                     q["mean"], q["p05"], q["p95"], q["mean"] - T_isa))
        else:
            print("  %-3s %8.1f %6.1f %6.1f          -      -      -          -"
                  % (MONTH[r["month"]], T["mean"], T["p05"], T["p95"]))

    print()
    print("DENSITY at the pad. ISA here is %.5f kg/m3." % rho_isa)
    print()
    print("  mon      mean      p05      p95    vs ISA    p-only    T-only")
    print("  " + "-" * 62)
    for r in rows:
        rho, p, T = r["rho"], r["p"], r["T"]
        if not rho["n"]:
            continue
        # Split the ISA error into its two causes by freezing one at a time.
        d_p = pad_state.density(p["mean"], T_isa) / pad_state.density(p_isa, T_isa) - 1
        d_T = pad_state.density(p_isa, T["mean"]) / pad_state.density(p_isa, T_isa) - 1
        print("  %-3s %9.5f %8.5f %8.5f  %+7.2f%% %+8.2f%% %+8.2f%%"
              % (MONTH[r["month"]], rho["mean"], rho["p05"], rho["p95"],
                 (rho["mean"] / rho_isa - 1) * 100, d_p * 100, d_T * 100))


def compare(stations, months, pad_elev, no_fetch=False):
    """Run every station to the same pad and report where they disagree.

    Eq (7b)'s residual after the elevation transfer is the horizontal pressure
    gradient between the reporting field and the pad, and PLAN.md can only put
    a literature band on that (0.03-0.5%). Three fields at 39, 45 and 50 km on
    different bearings measure it instead: referred to the same pad by the same
    equation, they should agree, and whatever is left is the gradient plus
    0.01 inHg of quantisation.

    This is a validation mode, not a blend. Averaging them would hide a station
    drifting out of calibration, which is exactly what the spread detects.
    """
    per = {}
    for st in stations:
        obs = []
        for y, m in months:
            path = os.path.join(CACHE, "%s-%04d-%02d.csv"
                                % (sites.SURFACE[st].iem_id, y, m))
            if no_fetch and not os.path.exists(path):
                continue
            obs.extend(decode(fetch_month(st, y, m), st, pad_elev))
        if obs:
            # Key on the hour, not the timestamp. These fields do not share a
            # reporting minute -- KNID files at :56, KEDW and KMHV at :55 --
            # so an exact-timestamp join matches almost nothing.
            per[st] = {o.time[:13]: o for o in obs}

    base = stations[0]
    print()
    print("STATION CROSS-CHECK: p_pad from each field, same pad, eq (7b).")
    print("Matched to the hour; only concurrent observations are compared.")
    print()
    hdr = "  mon  " + "".join("%22s" % ("%s-%s" % (s, base))
                              for s in stations[1:])
    print(hdr)
    print("       " + "".join("%22s" % "mean Pa   p05/p95  " for _ in stations[1:]))
    print("  " + "-" * (len(hdr) - 2))
    for m in range(1, 13):
        line = "  %-3s  " % MONTH[m]
        for s in stations[1:]:
            d = [per[s][t].p_pad - per[base][t].p_pad
                 for t in per.get(s, {})
                 if t in per[base] and per[base][t].month == m]
            if not d:
                line += "%22s" % "-"
                continue
            line += "%10.0f %5.0f/%-5.0f" % (statistics.fmean(d),
                                             pct(d, 0.05), pct(d, 0.95))
        print(line)
    print()
    for s in stations[1:]:
        d = [per[s][t].p_pad - per[base][t].p_pad
             for t in per.get(s, {}) if t in per[base]]
        if not d:
            continue
        mean = statistics.fmean(d)
        print("  %s vs %s: %+.0f Pa mean (%+.3f%%), sd %.0f Pa, n=%d"
              % (s, base, mean, mean / 94000 * 100, statistics.pstdev(d), len(d)))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--station", default=sites.PRIMARY_SURFACE,
                    choices=sorted(sites.SURFACE))
    ap.add_argument("--compare", action="store_true",
                    help="also fetch the cross-check fields and report the "
                         "station-to-station spread in p_pad")
    ap.add_argument("--months", type=int, default=12,
                    help="complete calendar months back from today (default 12)")
    ap.add_argument("--elev", type=float, default=sites.FAR_ELEV,
                    help="pad elevation MSL, m (default %g)" % sites.FAR_ELEV)
    ap.add_argument("--no-fetch", action="store_true",
                    help="use only what is already cached")
    ap.add_argument("--refetch", action="store_true",
                    help="ignore the cache and re-download every month")
    args = ap.parse_args()

    months = month_range(args.months)
    print("%s, %04d-%02d through %04d-%02d"
          % (args.station, months[0][0], months[0][1], months[-1][0], months[-1][1]),
          file=sys.stderr)

    text = []
    for y, m in months:
        path = os.path.join(CACHE, "%s-%04d-%02d.csv"
                            % (sites.SURFACE[args.station].iem_id, y, m))
        if args.no_fetch and not os.path.exists(path):
            print("  skip %04d-%02d (not cached)" % (y, m), file=sys.stderr)
            continue
        cached = os.path.exists(path) and not args.refetch
        print("  %04d-%02d %s" % (y, m, "cached" if cached else "fetching"),
              file=sys.stderr)
        text.append(fetch_month(args.station, y, m, refetch=args.refetch))

    obs = []
    for t in text:
        obs.extend(decode(t, args.station, args.elev))
    if not obs:
        raise SystemExit("no usable observations")
    print("  %d observations, %d with temperature"
          % (len(obs), sum(o.t_pad is not None for o in obs)), file=sys.stderr)

    rows = monthly(obs)
    rows_lw = monthly(obs, launch_hours_only=True)

    os.makedirs(DATA, exist_ok=True)
    tag = args.station.lower()
    write_obs_csv(os.path.join(DATA, "%s-obs.csv" % tag), obs, args.station)
    write_monthly_csv(os.path.join(DATA, "%s-monthly.csv" % tag), rows, rows_lw)
    report(rows, rows_lw, args.station, args.elev)

    if args.compare:
        others = [s for s in sorted(sites.SURFACE) if s != args.station]
        compare([args.station] + others, months, args.elev, args.no_fetch)

    print()
    print("wrote data/%s-obs.csv and data/%s-monthly.csv" % (tag, tag))


if __name__ == "__main__":
    sys.exit(main())
