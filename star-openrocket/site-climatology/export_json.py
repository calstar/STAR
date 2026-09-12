#!/usr/bin/env python3
"""Pack the committed climatology CSVs into one JSON for the frontend.

The UI's Atmospheric Data tab plots three things -- pad pressure by month,
temperature by month, and T against altitude for a chosen sounding -- and all
three are climatology, not simulation output. They do not change when the user
edits a vehicle, so routing them through `POST /api/atmosphere` would mean the
frontend cannot draw its own charts until the backend exists.

So this writes a static bundle instead. The frontend imports it directly and
the whole tab works with no server at all. When the backend lands it can serve
the identical shape from `GET /api/climatology`; the client already prefers the
endpoint and falls back to this file, so nothing in the components changes.

Aggregates are read back from data/*.csv rather than recomputed, so the JSON
cannot disagree with the CSVs the tests gate. Individual soundings are the one
thing not in any CSV, so those are re-derived from the IGRA cache.

    python3 export_json.py                 # everything, default sample
    python3 export_json.py --no-soundings  # aggregates only, no IGRA parse

Stdlib only, like the rest of this folder.
"""

import argparse
import csv
import datetime as dt
import json
import math
import os
import sys

import igra
import sites
import temp_profile
from _padstate import atmosphere, pad_state

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
DEFAULT_OUT = os.path.join(HERE, os.pardir, "frontend", "src", "fixtures",
                           "climatology.json")

# Sounding datasets to publish. Each is a tag matching data/<tag>-*.csv, so
# adding one here means generating it with temp_profile.py first.
DATASETS = [
    ("edw-nid", "Edwards + China Lake", ["EDW", "NID"], True),
    ("edw", "Edwards AFB", ["EDW"], False),
    ("nid", "China Lake NAF", ["NID"], False),
    ("vef", "Las Vegas", ["VEF"], False),
]

# Individual soundings kept per station, most recent first. 60 is enough to
# scrub through a couple of years without making the bundle bigger than the
# aggregates it ships beside.
SAMPLE = 60


def great_circle_km(lat1, lon1, lat2, lon2):
    """Haversine. Only used for display, so the spherical earth is fine."""
    r1, r2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(r1) * math.cos(r2) * math.sin(dlon / 2) ** 2)
    return 6371.0088 * 2 * math.asin(math.sqrt(a))


def load_csv(name):
    path = os.path.join(DATA, name)
    if not os.path.exists(path):
        return None
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def f(row, key):
    """Float a CSV cell, tolerating the blanks metar_history writes for
    months where a station reported pressure but no temperature."""
    v = row.get(key, "")
    return float(v) if v not in ("", None) else None


def isa_block(grid, pad_H):
    """The ISA standard column, for the "what would ISA have said" overlays.

    Computed here with `physics.atmosphere` rather than reimplemented in
    TypeScript, for the same reason the CSVs are read back instead of
    recomputed: the baseline the charts draw has to be the same standard
    atmosphere the solver integrates, or the comparison is against something
    nothing in the tool actually uses.

    ISA has no seasonality, which is the entire point of plotting it against a
    monthly series -- a flat line next to a curve with a 1.2 kPa annual swing
    says more than any caption.
    """
    T_pad = atmosphere.T_standard(pad_H)
    p_pad = atmosphere.p_standard(pad_H)
    return dict(
        pad=dict(
            H=round(pad_H, 3),
            T=round(T_pad, 4),
            p=round(p_pad, 3),
            rho=round(pad_state.density(p_pad, T_pad), 6),
        ),
        # Down the same grid the sounding profiles use, so a chart can plot
        # them against each other index for index.
        T=[round(atmosphere.T_standard(H), 4) for H in grid],
        p=[round(atmosphere.p_standard(H), 3) for H in grid],
        lapse_k_per_km=pad_state.L0 * 1000,
    )


def surface_block():
    """Pad pressure, temperature and density by month, one entry per station.

    Every station here is answering the same question -- what is the pressure
    at the pad -- from a different vantage point, which is what makes them
    comparable lines on one axis rather than three separate plots.
    """
    stations, monthly = [], {}
    for icao, st in sorted(sites.SURFACE.items()):
        rows = load_csv("%s-monthly.csv" % icao.lower())
        if rows is None:
            print("skip %s: no data/%s-monthly.csv" % (icao, icao.lower()),
                  file=sys.stderr)
            continue
        stations.append(dict(
            id=icao,
            name=st.name,
            elev_m=st.elev_m,
            gap_m=round(st.gap_m, 1),
            distance_km=round(great_circle_km(sites.FAR_LAT, sites.FAR_LON,
                                              st.lat, st.lon), 1),
            primary=(icao == sites.PRIMARY_SURFACE),
            note=st.note,
        ))
        monthly[icao] = [dict(
            month=int(r["month"]),
            n=int(r["n_obs"]),
            p_mean=f(r, "p_pad_mean_pa"),
            p_sd=f(r, "p_pad_sd_pa"),
            p_p05=f(r, "p_pad_p05_pa"),
            p_p95=f(r, "p_pad_p95_pa"),
            p_min=f(r, "p_pad_min_pa"),
            p_max=f(r, "p_pad_max_pa"),
            t_mean=f(r, "T_pad_mean_k"),
            t_p05=f(r, "T_pad_p05_k"),
            t_p95=f(r, "T_pad_p95_k"),
            rho_mean=f(r, "rho_pad_mean"),
            rho_p05=f(r, "rho_pad_p05"),
            rho_p95=f(r, "rho_pad_p95"),
            # Launch window only: 15-23Z, roughly 8am-4pm local.
            lw_n=int(r["lw_T_pad_n"]) if r.get("lw_T_pad_n") else 0,
            lw_t_mean=f(r, "lw_T_pad_mean_k"),
            lw_rho_mean=f(r, "lw_rho_pad_mean"),
        ) for r in rows]
    return dict(stations=stations, monthly=monthly)


def upper_block():
    """Monthly temperature profiles and lapse fits, one entry per dataset.

    The grid is identical across datasets -- all of them come from
    temp_profile.height_grid -- so it is hoisted out and stored once instead
    of repeated 48 times.
    """
    grid = temp_profile.height_grid()
    datasets, profile, lapse, wind = [], {}, {}, {}

    for tag, label, members, pooled in DATASETS:
        prof_rows = load_csv("%s-tprofile-monthly.csv" % tag)
        lapse_rows = load_csv("%s-lapse-monthly.csv" % tag)
        if prof_rows is None or lapse_rows is None:
            print("skip %s: run temp_profile.py --station %s"
                  % (tag, ",".join(members)), file=sys.stderr)
            continue

        # Regroup the flat CSV (one row per month per level) into one record
        # per month with parallel arrays, which is what a chart wants.
        months = {}
        for r in prof_rows:
            m = int(r["month"])
            rec = months.setdefault(m, dict(
                month=m, n=int(r["n_soundings"]), mean=[], sd=[],
                p05=[], p50=[], p95=[], eq7_err=[]))
            rec["mean"].append(f(r, "T_mean_k"))
            rec["sd"].append(f(r, "T_sd_k"))
            rec["p05"].append(f(r, "T_p05_k"))
            rec["p50"].append(f(r, "T_p50_k"))
            rec["p95"].append(f(r, "T_p95_k"))
            rec["eq7_err"].append(f(r, "eq7_minus_measured_k"))

        bad = [m for m, rec in months.items() if len(rec["mean"]) != len(grid)]
        if bad:
            raise SystemExit(
                "%s: months %s do not match the %d-level grid. The CSV was "
                "written with a different --elev or GRID_STEP; regenerate it."
                % (tag, bad, len(grid)))

        datasets.append(dict(id=tag, label=label, stations=members,
                             pooled=pooled,
                             n=sum(rec["n"] for rec in months.values())))
        profile[tag] = [months[m] for m in sorted(months)]
        lapse[tag] = [dict(
            month=int(r["month"]),
            n=int(r["n_soundings"]),
            L_mean=f(r, "L_fit_mean_k_per_km"),
            L_sd=f(r, "L_fit_sd"),
            L_p05=f(r, "L_fit_p05"),
            L_p95=f(r, "L_fit_p95"),
            L_eq7=f(r, "L_eq7_mean_k_per_km"),
            L_isa=f(r, "L_isa_k_per_km"),
        ) for r in lapse_rows]

        # Wind is optional per tag: it is generated by wind_profile.py, which is
        # run separately from temp_profile.py, so a tag can have a temperature
        # profile without a wind one yet. Same regrouping as the T profile --
        # one record per month with parallel arrays down the shared grid.
        wind_rows = load_csv("%s-wprofile-monthly.csv" % tag)
        if wind_rows is not None:
            wmonths = {}
            for r in wind_rows:
                m = int(r["month"])
                rec = wmonths.setdefault(m, dict(
                    month=m, n=int(r["n_soundings"]), u=[], v=[],
                    spd=[], spd_p05=[], spd_p95=[], dir=[]))
                rec["u"].append(f(r, "u_mean_ms"))
                rec["v"].append(f(r, "v_mean_ms"))
                rec["spd"].append(f(r, "spd_mean_ms"))
                rec["spd_p05"].append(f(r, "spd_p05_ms"))
                rec["spd_p95"].append(f(r, "spd_p95_ms"))
                rec["dir"].append(f(r, "dir_mean_deg"))
            bad = [m for m, rec in wmonths.items() if len(rec["u"]) != len(grid)]
            if bad:
                raise SystemExit(
                    "%s: wind months %s do not match the %d-level grid; "
                    "regenerate with wind_profile.py." % (tag, bad, len(grid)))
            wind[tag] = [wmonths[m] for m in sorted(wmonths)]

    return dict(grid_m=grid, datasets=datasets, profile=profile, lapse=lapse,
                wind=wind)


def soundings_block(years, sample):
    """The most recent individual ascents per station, on the same grid.

    Aggregates hide what a single ascent looks like: a January mean profile is
    smooth and nearly linear, while the ascents behind it routinely carry a
    300 m surface inversion. The T-vs-altitude chart exists to show that, so
    it needs real ascents rather than the mean of them.
    """
    today = dt.date.today()
    until = (today.year, today.month)
    since = (today.year - years, today.month)
    grid = temp_profile.height_grid()
    out = {}

    for key in sorted(sites.UPPER):
        st = sites.UPPER[key]
        kept = []
        for s in igra.load(st.igra_id, since, until, p_floor=30000.0):
            ls = igra.build_heights(s, st.elev_m)
            if len(ls) < 5:
                continue
            ts = igra.interp(ls, grid)
            if any(t is None for t in ts):
                continue
            kept.append((s, ts))
        kept.sort(key=lambda p: p[0].key, reverse=True)
        out[key] = [dict(
            id="%s-%04d%02d%02d-%02dZ" % (key, s.year, s.month, s.day, s.hour),
            station=key,
            year=s.year, month=s.month, day=s.day, hour=s.hour,
            label="%04d-%02d-%02d %02dZ" % (s.year, s.month, s.day, s.hour),
            t=[round(v, 2) for v in ts],
            # Fit and eq (7) per ascent, so the chart can draw the straight
            # line each one implies next to the ascent's own kinks.
            L_fit=round(temp_profile.fit_lapse(grid, ts) * 1000, 3),
            L_eq7=round(pad_state.refit_lapse(ts[0], grid[0]) * 1000, 3),
        ) for s, ts in kept[:sample]]
        print("  %-4s %4d soundings usable, keeping %d"
              % (key, len(kept), len(out[key])), file=sys.stderr)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=DEFAULT_OUT,
                    help="output path (default frontend/src/fixtures/)")
    ap.add_argument("--years", type=int, default=10,
                    help="window for the individual soundings (default 10)")
    ap.add_argument("--sample", type=int, default=SAMPLE,
                    help="soundings kept per station (default %d)" % SAMPLE)
    ap.add_argument("--no-soundings", action="store_true",
                    help="aggregates only; skips parsing the IGRA archive")
    ap.add_argument("--indent", type=int, default=None,
                    help="pretty-print with this indent (default compact)")
    args = ap.parse_args()

    bundle = dict(
        meta=dict(
            generated=dt.datetime.now(dt.timezone.utc)
                        .strftime("%Y-%m-%dT%H:%M:%SZ"),
            source="recovery-calculator/site-climatology/export_json.py",
            pad=dict(name="Friends of Amateur Rocketry",
                     lat=round(sites.FAR_LAT, 5), lon=round(sites.FAR_LON, 5),
                     elev_m=sites.FAR_ELEV,
                     # Read from physics/site.py, never restated. This was
                     # hard-coded True and stayed True after the elevation was
                     # confirmed, so the UI kept calling a stated value an
                     # estimate.
                     elev_is_estimate=not sites.FAR_ELEV_CONFIRMED),
            ceiling_agl_ft=round(sites.CEILING_AGL_M / 0.3048),
            ceiling_msl_m=sites.CEILING_MSL_M,
            isa_lapse_k_per_km=pad_state.L0 * 1000,
        ),
        isa=isa_block(temp_profile.height_grid(),
                      atmosphere.geopotential(sites.FAR_ELEV)),
        surface=surface_block(),
        upper=upper_block(),
        soundings={} if args.no_soundings
                  else soundings_block(args.years, args.sample),
    )

    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as fh:
        json.dump(bundle, fh, indent=args.indent, separators=(",", ":")
                  if args.indent is None else None)
        fh.write("\n")

    print("wrote %s (%.0f KB): %d surface stations, %d sounding datasets, "
          "%d individual soundings"
          % (os.path.relpath(out, HERE), os.path.getsize(out) / 1024,
             len(bundle["surface"]["stations"]),
             len(bundle["upper"]["datasets"]),
             sum(len(v) for v in bundle["soundings"].values())),
          file=sys.stderr)


if __name__ == "__main__":
    main()
