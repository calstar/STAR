#!/usr/bin/env python3
"""Offline tests. No network. Run: python3 test_site_climatology.py

The two things most likely to be silently wrong here are the IGRA fixed-width
column offsets and the hydrostatic integration, so both get exact analytic
checks rather than regression values.
"""

import csv
import io
import math
import os
import sys

from _padstate import pad_state as ps
import igra
import metar_history as mh
import sites
import temp_profile as tp

FAILS = []


def check(name, got, want, tol):
    ok = got is not None and abs(got - want) <= tol
    print("%-56s %s  got %.6g want %.6g"
          % (name, "ok " if ok else "FAIL", -999 if got is None else got, want))
    if not ok:
        FAILS.append(name)


def check_eq(name, got, want):
    ok = got == want
    print("%-56s %s  got %r" % (name, "ok " if ok else "FAIL", got))
    if not ok:
        FAILS.append(name)


# --- IGRA fixed-width parsing ----------------------------------------------
# Real records lifted from USM00072381-data.txt. Column positions are the
# whole game: splitting on whitespace parses the first line fine and the
# second one wrong, because -9999 runs into its neighbour.

IGRA_SAMPLE = (
    "#USM00072381 2026 07 22 17 1700   66 ncdc-gts ncdc-gts  349167 -1179000\n"
    "21 -9999  93200B-9999   336B-9999   230   240    46 \n"
    "20 -9999  92700 -9999   314B-9999   210 -9999 -9999 \n"
    "10 -9999  92500   798B  316B-9999   210   275    46 \n"
    "10 -9999  85000  1541B  244B-9999   160   300    26 \n"
    "20 -9999  80300 -9999   206B-9999   130 -9999 -9999 \n"
    "#USM00072381 2020 01 15 12 1200    4 ncdc-gts ncdc-gts  349167 -1179000\n"
    "21 -9999  93500B-9999    50B-9999   100   180    31 \n"
    "10 -9999  85000  1480B-9999B-9999   120   200    26 \n"
)

snds = list(igra.parse(io.StringIO(IGRA_SAMPLE)))
check_eq("two soundings parsed", len(snds), 2)
check_eq("header station id", snds[0].station, "USM00072381")
check_eq("header date/hour", snds[0].key, (2026, 7, 22, 17))
check_eq("levels in first sounding", len(snds[0].levels), 5)

l0 = snds[0].levels[0]
check("surface pressure, Pa", l0.p, 93200.0, 0.0)
check("surface temperature, tenths degC -> K", l0.t, 33.6 + 273.15, 1e-9)
check_eq("surface GPH is missing (-9999 -> None)", l0.gph, None)
check_eq("LVLTYP2=1 flags the surface level", l0.is_surface, True)

l2 = snds[0].levels[2]
check("925 hPa mandatory level GPH", l2.gph, 798.0, 0.0)
check_eq("925 hPa is not flagged surface", l2.is_surface, False)
check_eq("missing temperature -> None", snds[1].levels[1].t, None)

# Date filtering happens on the header, so a filtered-out sounding must not
# leak its levels into the neighbour that survived.
only20 = list(igra.parse(io.StringIO(IGRA_SAMPLE), since=(2020, 1), until=(2020, 12)))
check_eq("since/until keeps one sounding", len(only20), 1)
check_eq("filtered sounding keeps its own levels", len(only20[0].levels), 2)

floored = list(igra.parse(io.StringIO(IGRA_SAMPLE), p_floor=85000.0))
check_eq("p_floor drops levels above the ceiling", len(floored[0].levels), 4)


# --- hydrostatic heights ---------------------------------------------------
# Isothermal column: dZ = (Rd T / g0) ln(p1/p2) is exact, not an approximation,
# so this pins the integration with no tolerance to hide behind.

T_ISO = 280.0
P_SURF = 93000.0


def iso_sounding(ratios):
    s = igra.Sounding("TEST", 2020, 1, 1, 12)
    for i, r in enumerate(ratios):
        s.levels.append(igra.Level(P_SURF * r, T_ISO, None, i == 0))
    return s


ls = igra.build_heights(iso_sounding([1.0, 0.8, 0.6, 0.4]), station_elev=700.0)
check_eq("every level got a height", all(l.z is not None for l in ls), True)
check("isothermal anchor at station elevation", ls[0].z, 700.0, 1e-9)
for i, r in enumerate([0.8, 0.6, 0.4], start=1):
    want = 700.0 + (igra.RD * T_ISO / igra.G0) * math.log(1 / r)
    check("isothermal thickness to p/p0=%.1f" % r, ls[i].z, want, 1e-6)

# A reported surface GPH must win over the station elevation, because the
# balloon knows where it was and the metadata may be stale.
s = iso_sounding([1.0, 0.5])
s.levels[0].gph = 705.0
ls = igra.build_heights(s, station_elev=700.0)
check("reported surface GPH beats station elevation", ls[0].z, 705.0, 1e-9)

# Levels with no temperature cannot be integrated through and must be dropped
# rather than treated as a zero-thickness layer.
s = iso_sounding([1.0, 0.8, 0.6])
s.levels[1].t = None
ls = igra.build_heights(s, station_elev=700.0)
check_eq("temperature-less levels dropped", len(ls), 2)
check("integration skips the gap correctly", ls[1].z,
      700.0 + (igra.RD * T_ISO / igra.G0) * math.log(1 / 0.6), 1e-6)

# An ISA-consistent sounding must reproduce ISA geopotential heights. This
# catches a sign error or a g0/Rd swap that the isothermal case would not.
s = igra.Sounding("TEST", 2020, 1, 1, 12)
for H in (0.0, 1000.0, 2000.0, 5000.0, 8000.0):
    p = ps.p_pad_isa(H)
    s.levels.append(igra.Level(p, ps.T0 + ps.L0 * H, None, H == 0.0))
ls = igra.build_heights(s, station_elev=0.0)
for l, H in zip(ls, (0.0, 1000.0, 2000.0, 5000.0, 8000.0)):
    check("ISA column recovers H = %5.0f m" % H, l.z, H, 4.0)

check_eq("gph_residual ignores levels with no reported GPH",
         igra.gph_residual(ls), [])


# --- interpolation ---------------------------------------------------------

s = iso_sounding([1.0, 0.8, 0.6])
ls = igra.build_heights(s, station_elev=1000.0)
zs = [l.z for l in ls]
got = igra.interp(ls, [zs[0], zs[1], zs[2]])
for i in range(3):
    check("interp is exact at node %d" % i, got[i], T_ISO, 1e-9)

lin = igra.Sounding("TEST", 2020, 1, 1, 12)
lin.levels = [igra.Level(90000.0, 300.0, 1000.0, True),
              igra.Level(70000.0, 280.0, 3000.0, False)]
ls = igra.build_heights(lin, station_elev=1000.0)
mid = 0.5 * (ls[0].z + ls[1].z)
check("interp is linear in height at the midpoint",
      igra.interp(ls, [mid])[0], 290.0, 1e-9)
check_eq("interp refuses above the top level",
         igra.interp(ls, [ls[-1].z + 1.0])[0], None)
check_eq("interp refuses more than 200 m below the base",
         igra.interp(ls, [ls[0].z - 201.0])[0], None)
below = igra.interp(ls, [ls[0].z - 100.0])[0]
lapse = (ls[1].t - ls[0].t) / (ls[1].z - ls[0].z)
check("interp extrapolates 100 m down on the base lapse rate",
      below, 300.0 - lapse * 100.0, 1e-9)


# --- lapse fitting ---------------------------------------------------------

grid = [sites.FAR_ELEV + 250.0 * i for i in range(31)]
exact = [290.0 - 0.0071 * (h - grid[0]) for h in grid]
check("fit_lapse is exact on a linear profile",
      tp.fit_lapse(grid, exact), -0.0071, 1e-12)

# PLAN.md's free regression test, one level up: a standard pad temperature
# must send eq (7) back to the standard lapse rate.
T_std = ps.T0 + ps.L0 * grid[0]
prof, L = tp.eq7_profile(T_std, grid)
check("eq (7) returns ISA L0 for a standard pad", L, ps.L0, 1e-12)
check("eq (7) profile is ISA at the top of the grid",
      prof[-1], ps.T0 + ps.L0 * grid[-1], 1e-9)

g = tp.height_grid(pad_elev=sites.FAR_ELEV)
check("grid starts at the pad geopotential", g[0],
      ps.geopotential(sites.FAR_ELEV), 1e-9)
check_eq("grid clears the 25 kft AGL ceiling",
         g[-1] - g[0] >= sites.CEILING_AGL_M, True)


# --- METAR history decode --------------------------------------------------
# Row 2 is the real overnight KNID form: altimeter present, no temperature
# group at all. pad_state.parse_metar raises on it, and dropping the row would
# throw away the pressure we came for.

IEM_CSV = (
    "station,valid,elevation,metar,alti,tmpf,dwpf\n"
    "NID,2025-07-01 00:56,696.00,"
    "KNID 010056Z 20009G18KT 10SM FEW080 37/04 A2982 RMK AO2 SLP073 T03670039 $,29.82,98.00,39.00\n"
    "NID,2025-07-01 06:56,696.00,"
    "KNID 010656Z AUTO A2985 RMK AO2 SLPNO PWINO $,29.85,M,M\n"
    "NID,2025-07-01 07:56,696.00,,M,M,M\n"
)

obs = mh.decode(IEM_CSV, "KNID", pad_elev=sites.FAR_ELEV)
check_eq("empty metar row dropped, others kept", len(obs), 2)
check_eq("hour parsed from the timestamp", obs[0].hour, 0)
check_eq("month parsed from the timestamp", obs[0].month, 7)

H_pad = ps.geopotential(sites.FAR_ELEV)
want_p = 29.82 * ps.INHG * ps.column_ratio(H_pad)
check("p_pad from the A group via eq (7b)", obs[0].p_pad, want_p, 0.5)
check("temperature comes from the T-remark, not 37/04",
      obs[0].t_station_c, 36.7, 1e-9)
# Pad elevation lives in physics/site.py, so derive the gap rather than
# restating it -- these drifted when 610 m was corrected to 630 m.
check("T_pad lapse-transferred KNID -> pad",
      obs[0].t_pad,
      36.7 + 273.15 + 0.0065 * sites.SURFACE["KNID"].gap_m, 1e-6)
check("rho follows from eq (5)", obs[0].rho_pad,
      ps.density(obs[0].p_pad, obs[0].t_pad), 1e-12)

check("temperature-less ob keeps its pressure", obs[1].p_pad,
      29.85 * ps.INHG * ps.column_ratio(H_pad), 0.5)
check_eq("temperature-less ob has no T_pad", obs[1].t_pad, None)
check_eq("temperature-less ob has no density", obs[1].rho_pad, None)

# The trap the whole module exists to avoid, asserted rather than described.
raw_setting = 29.82 * ps.INHG
check_eq("eq (7b) is not a no-op at this elevation",
         raw_setting / obs[0].p_pad > 1.06, True)


# --- aggregation -----------------------------------------------------------

check("pct interpolates between samples", mh.pct([0.0, 10.0], 0.5), 5.0, 1e-12)
check("pct at q=0 is the minimum", mh.pct([3.0, 1.0, 2.0], 0.0), 1.0, 1e-12)
check("pct at q=1 is the maximum", mh.pct([3.0, 1.0, 2.0], 1.0), 3.0, 1e-12)

s = mh.summarise([1.0, 2.0, 3.0, None])
check_eq("summarise skips None", s["n"], 3)
check("summarise mean", s["mean"], 2.0, 1e-12)
check_eq("summarise of nothing reports n=0", mh.summarise([None])["n"], 0)


class FakeObs:
    def __init__(self, month, hour, p):
        self.month, self.hour = month, hour
        self.p_pad, self.t_pad, self.rho_pad = p, 300.0, 1.0


fake = [FakeObs(3, 6, 90000.0), FakeObs(3, 18, 91000.0), FakeObs(7, 18, 92000.0)]
rows = mh.monthly(fake)
check_eq("monthly bins by calendar month", [r["month"] for r in rows], [3, 7])
check("monthly averages within the bin", rows[0]["p"]["mean"], 90500.0, 1e-9)
lw = mh.monthly(fake, launch_hours_only=True)
check_eq("launch window drops the 06Z ob", lw[0]["p"]["n"], 1)
check("launch window keeps the 18Z ob", lw[0]["p"]["mean"], 91000.0, 1e-9)


# --- site constants --------------------------------------------------------

check("FAR latitude from the DMS coordinate", sites.FAR_LAT, 35.35333, 1e-5)
check("FAR longitude from the DMS coordinate", sites.FAR_LON, -117.80717, 1e-5)
check("KNID elevation gap to the pad", sites.SURFACE["KNID"].gap_m,
      sites.SURFACE["KNID"].elev_m - sites.FAR_ELEV, 1e-9)
check("25 kft ceiling in metres AGL", sites.CEILING_AGL_M, 7620.0, 1e-9)
check_eq("KNID has the smallest gap of the three",
         min(sites.SURFACE, key=lambda k: abs(sites.SURFACE[k].gap_m)), "KNID")


# --- committed data products -----------------------------------------------
# data/*.csv is committed and read by things that will never re-run the
# fetchers, so a regeneration that went wrong must not be able to land quietly.
# Regenerating needs network; checking what was regenerated does not, which is
# what makes this a CI gate rather than a manual step.
#
# Column names are asserted independently of the writers on purpose: if a
# writer renames a column, that is a breaking change for every consumer and
# this should fail.

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")


def load_csv(name):
    with open(os.path.join(DATA, name), newline="") as f:
        return list(csv.DictReader(f))


def check_cols(name, rows, cols):
    missing = [c for c in cols if c not in (rows[0] if rows else {})]
    check_eq("%s has the expected columns" % name, missing, [])


def check_range(name, rows, col, lo, hi):
    vals = [float(r[col]) for r in rows if r[col] != ""]
    bad = [v for v in vals if not lo <= v <= hi]
    check_eq("%s %s within [%g, %g]" % (name, col, lo, hi), bad[:3], [])


PROFILE_TAGS = ("edw-nid", "vef")   # pooled default, and the Las Vegas check

for name in ["knid-monthly.csv"] + [
        "%s-%s-monthly.csv" % (t, k)
        for t in PROFILE_TAGS for k in ("lapse", "tprofile")]:
    rows = load_csv(name)
    check_eq("%s is non-empty" % name, len(rows) > 0, True)
    check_eq("%s covers all 12 months" % name,
             sorted({int(r["month"]) for r in rows}), list(range(1, 13)))

rows = load_csv("knid-monthly.csv")
check_cols("knid-monthly", rows,
           ["month", "n_obs", "p_pad_mean_pa", "p_pad_p05_pa", "p_pad_p95_pa",
            "T_pad_mean_k", "rho_pad_mean", "lw_T_pad_mean_k"])
# A year of hourly obs is ~720/month. Well under that means a station outage
# got baked in -- KMHV lost Oct-Dec 2025 exactly this way.
check_eq("every month has a plausible observation count",
         [r["month"] for r in rows if int(r["n_obs"]) < 400], [])
check_range("knid-monthly", rows, "p_pad_mean_pa", 85000, 100000)
check_range("knid-monthly", rows, "T_pad_mean_k", 250, 330)
check_range("knid-monthly", rows, "rho_pad_mean", 0.90, 1.35)
# The launch window is daytime, so it must be warmer than the all-hours mean
# in every month. Catches an hour-filter inverted or applied to the wrong axis.
check_eq("launch window is warmer than all hours, every month",
         [r["month"] for r in rows
          if float(r["lw_T_pad_mean_k"]) <= float(r["T_pad_mean_k"])], [])
check_eq("p05 <= mean <= p95 in every month",
         [r["month"] for r in rows
          if not (float(r["p_pad_p05_pa"]) <= float(r["p_pad_mean_pa"])
                  <= float(r["p_pad_p95_pa"]))], [])

for tag in PROFILE_TAGS:
    rows = load_csv("%s-lapse-monthly.csv" % tag)
    check_cols("%s-lapse" % tag, rows,
               ["month", "n_soundings", "L_fit_mean_k_per_km",
                "L_eq7_mean_k_per_km", "L_isa_k_per_km"])
    # A troposphere that warms with height, or one steeper than the dry
    # adiabat (-9.8 K/km), means the integration or the fit is broken.
    check_range("%s-lapse" % tag, rows, "L_fit_mean_k_per_km", -9.8, -3.0)
    check_range("%s-lapse" % tag, rows, "L_eq7_mean_k_per_km", -12.0, -3.0)
    check_eq("%s-lapse carries ISA for comparison" % tag,
             {r["L_isa_k_per_km"] for r in rows}, {"-6.500"})
    check_eq("%s-lapse has enough soundings per month" % tag,
             [r["month"] for r in rows if int(r["n_soundings"]) < 20], [])

    rows = load_csv("%s-tprofile-monthly.csv" % tag)
    check_cols("%s-tprofile" % tag, rows,
               ["month", "n_soundings", "H_msl_m", "H_agl_ft", "T_mean_k",
                "T_p05_k", "T_p50_k", "T_p95_k", "eq7_minus_measured_k"])
    check_range("%s-tprofile" % tag, rows, "T_mean_k", 200, 330)
    check_eq("%s-tprofile quantiles are ordered" % tag,
             [r["H_msl_m"] for r in rows
              if not (float(r["T_p05_k"]) <= float(r["T_p50_k"])
                      <= float(r["T_p95_k"]))][:3], [])
    jan = [r for r in rows if r["month"] == "1"]
    hs = [float(r["H_msl_m"]) for r in jan]
    check_eq("%s-tprofile heights ascend within a month" % tag,
             hs == sorted(hs), True)
    check_eq("%s-tprofile reaches the 25 kft AGL ceiling" % tag,
             max(float(r["H_agl_ft"]) for r in jan) >= 25000.0, True)
    # eq (7) is anchored at the pad, so its error there is identically zero.
    # Anything else means the anchor drifted off the bottom of the grid.
    check("%s-tprofile eq (7) error is zero at the anchor" % tag,
          float(jan[0]["eq7_minus_measured_k"]), 0.0, 1e-9)


print()
if FAILS:
    print("%d FAILED: %s" % (len(FAILS), ", ".join(FAILS)))
    sys.exit(1)
print("all passed")
