#!/usr/bin/env python3
"""Resolve pad atmospheric state (T_pad, p_pad, rho) for the recovery model.

Implements PLAN.md section 5: equations (1), (2), (5), (7), (7a) and (7b).

Two modes, because the thing you need on launch day and the thing you need at a
desk are different:

  --metar "<raw string>"   parse a pasted observation. No network. Use this when
                           someone reads you a METAR over the radio, or when
                           your environment blocks aviationweather.gov.

  --station KNID           pull the latest observation from the NWS Aviation
                           Weather Center API.

  (neither)                eq (7a) only -- the standard column at your site
                           elevation. This is the PLAN.md Phase 1 default and
                           needs nothing but --elev.

Station pressure is never taken from the reported altimeter setting directly;
see PLAN.md section 5 for why that is an 11-18% error at high desert sites.

Stdlib only, matching fruity-chute-scraper.
"""

import argparse
import json
import math
import re
import sys
import urllib.parse
import urllib.request

# --- ISA defined constants (PLAN.md section 5) -----------------------------
G0 = 9.80665          # m/s^2, standard gravity
RD = 287.053          # J/(kg K), specific gas constant, dry air
T0 = 288.15           # K, ISA sea level temperature
P0 = 101325.0         # Pa, ISA sea level pressure
L0 = -0.0065          # K/m, ISA tropospheric lapse rate
RE = 6356766.0        # m, ISA effective earth radius
EXP = -G0 / (RD * L0)  # 5.255877, the layer-0 pressure exponent
INHG = 3386.389       # Pa per inch of mercury
T_TROP = 216.65       # K, standard tropopause temperature
H_TROP = 11000.0      # m, standard tropopause geopotential altitude

API = "https://aviationweather.gov/api/data/metar"


# --- atmosphere ------------------------------------------------------------

def geopotential(z):
    """Eq (1). Geometric altitude MSL -> geopotential altitude."""
    return RE * z / (RE + z)


def column_ratio(H):
    """Layer-0 pressure ratio p(H)/p(0) for the *standard* column.

    Eq (3) with the ISA constants. Both (7a) and (7b) use the standard L0 and
    T0 here even when eq (7) has re-fit the lapse rate: the altimeter setting
    is defined against the standard column, so decoding it with anything else
    introduces an error rather than removing one.
    """
    return (1.0 + L0 * H / T0) ** EXP


def p_pad_isa(H_pad):
    """Eq (7a). Phase 1 default: standard column at site elevation. ~2%."""
    return P0 * column_ratio(H_pad)


def p_pad_metar(altimeter_pa, H_pad):
    """Eq (7b). Invert the altimeter-setting definition. 0.3-0.6%."""
    return altimeter_pa * column_ratio(H_pad)


def refit_lapse(T_pad, H_pad):
    """Eq (7). Lapse rate through the measurement to the standard tropopause."""
    return (T_TROP - T_pad) / (H_TROP - H_pad)


def density(p, T):
    """Eq (5), dry air."""
    return p / (RD * T)


def sat_vapour_pressure(T_c):
    """Magnus formula, Pa. Only used to report the humidity correction size."""
    return 611.2 * math.exp(17.67 * T_c / (T_c + 243.5))


def virtual_factor(T_c, Td_c, p):
    """rho_moist / rho_dry = 1 - 0.378 e/p. Returns the multiplier."""
    if Td_c is None:
        return 1.0
    e = sat_vapour_pressure(Td_c)
    return 1.0 - 0.378 * e / p


# --- METAR parsing ---------------------------------------------------------

class Metar:
    def __init__(self, station, time, temp_c, dewp_c, altim_pa, raw,
                 elev_m=None, maintenance=False):
        self.station = station
        self.time = time
        self.temp_c = temp_c
        self.dewp_c = dewp_c
        self.altim_pa = altim_pa
        self.raw = raw
        self.elev_m = elev_m
        self.maintenance = maintenance


def parse_metar(raw):
    """Parse the fields section 5 needs out of a raw METAR string.

    Prefers the Txxxxxxxx remark over the rounded temp/dewpoint group, since a
    0.5 K rounding is 0.17% in density -- comparable to everything else the
    model is chasing.
    """
    s = raw.strip().rstrip("=")
    toks = s.split()
    if not toks:
        raise ValueError("empty METAR")

    # Station: first 4-character alphanumeric token, skipping the type word.
    station = None
    for t in toks:
        if t in ("METAR", "SPECI"):
            continue
        if re.fullmatch(r"[A-Z0-9]{4}", t):
            station = t
            break
    if station is None:
        raise ValueError("no station identifier found in: %s" % raw)

    m = re.search(r"\b(\d{6}Z)\b", s)
    time = m.group(1) if m else None

    # Altimeter: Axxxx is inHg*100 (US), Qxxxx is hPa (most everywhere else).
    altim_pa = None
    m = re.search(r"\bA(\d{4})\b", s)
    if m:
        altim_pa = int(m.group(1)) / 100.0 * INHG
    else:
        m = re.search(r"\bQ(\d{4})\b", s)
        if m:
            altim_pa = int(m.group(1)) * 100.0

    # Rounded temp/dewpoint group, e.g. 31/M03.
    temp_c = dewp_c = None
    m = re.search(r"\b(M?\d{2})/(M?\d{2})\b", s)
    if m:
        temp_c = _signed(m.group(1))
        dewp_c = _signed(m.group(2))

    # Precise remark, e.g. T03061028 -> +30.6 / -2.8. Overrides the above.
    m = re.search(r"\bT(\d)(\d{3})(\d)(\d{3})\b", s)
    if m:
        temp_c = (-1 if m.group(1) == "1" else 1) * int(m.group(2)) / 10.0
        dewp_c = (-1 if m.group(3) == "1" else 1) * int(m.group(4)) / 10.0

    if temp_c is None:
        raise ValueError("no temperature group found in: %s" % raw)

    return Metar(station, time, temp_c, dewp_c, altim_pa, s,
                 maintenance=s.endswith("$"))


def _signed(g):
    return -int(g[1:]) if g.startswith("M") else int(g)


def fetch_metar(station, hours=3.0):
    """Pull the most recent observation from the AWC API.

    Querying this API is also the definitive test of whether a field actually
    reports. Aggregator websites substitute the nearest reporting station when
    an airport has none; this API does not. An empty result means the station
    does not issue METARs, whatever a third-party page displays for it.
    """
    url = API + "?" + urllib.parse.urlencode(
        {"ids": station, "format": "json", "hours": hours})
    with urllib.request.urlopen(url, timeout=30) as r:
        rows = json.load(r)
    if not rows:
        raise SystemExit(
            "%s returned no observations in the last %g h.\n"
            "That station does not issue METARs (or is currently down)."
            % (station, hours))
    row = sorted(rows, key=lambda d: d.get("obsTime", 0))[-1]

    ob = parse_metar(row["rawOb"])
    # Trust the decoded fields over our regexes where the API provides them.
    if row.get("temp") is not None:
        ob.temp_c = row["temp"]
    if row.get("dewp") is not None:
        ob.dewp_c = row["dewp"]
    # NOTE: the JSON API reports altim in HECTOPASCALS, not inHg as the raw
    # string does for US stations. Easy to get wrong by a factor of 33.86.
    if row.get("altim") is not None:
        ob.altim_pa = row["altim"] * 100.0
    if row.get("elev") is not None:
        ob.elev_m = float(row["elev"])
    return ob


# --- report ----------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(
        description="Resolve pad T, p and rho for the recovery model (PLAN.md section 5).")
    ap.add_argument("--elev", type=float, required=True,
                    help="pad elevation MSL in metres (GPS or topo, not memory: "
                         "10 m of error is 0.12%% in pressure)")
    ap.add_argument("--station", help="ICAO id to query, e.g. KNID")
    ap.add_argument("--metar", help="raw METAR string to parse instead of querying")
    ap.add_argument("--station-elev", type=float,
                    help="reporting station elevation MSL in metres "
                         "(required with --metar if you want its temperature used)")
    ap.add_argument("--hours", type=float, default=3.0,
                    help="hours back to search when querying (default 3)")
    args = ap.parse_args()

    H_pad = geopotential(args.elev)

    ob = None
    if args.metar:
        ob = parse_metar(args.metar)
        ob.elev_m = args.station_elev
    elif args.station:
        ob = fetch_metar(args.station, args.hours)

    print("pad elevation      %.1f m MSL  (geopotential %.1f m)" % (args.elev, H_pad))
    print()

    # --- pressure ---
    p_a = p_pad_isa(H_pad)
    print("PRESSURE")
    print("  eq (7a) ISA default        %9.1f Pa   (Phase 1 default, ~2%%)" % p_a)

    p_pad, p_src = p_a, "eq (7a)"
    if ob is not None and ob.altim_pa is not None:
        p_b = p_pad_metar(ob.altim_pa, H_pad)
        print("  eq (7b) from %-4s A=%.2f\"  %9.1f Pa   (%+.2f%% vs default)"
              % (ob.station, ob.altim_pa / INHG, p_b, (p_b / p_a - 1) * 100))
        p_pad, p_src = p_b, "eq (7b)"
    print()

    # --- temperature ---
    print("TEMPERATURE")
    T_isa = T0 + L0 * H_pad
    print("  ISA at site elevation      %8.2f K  (%.1f C)" % (T_isa, T_isa - 273.15))

    T_pad, T_src = T_isa, "ISA"
    if ob is not None:
        T_st = ob.temp_c + 273.15
        if ob.elev_m is None:
            print("  %s reported             %8.2f K  (%.1f C)"
                  % (ob.station, T_st, ob.temp_c))
            print("  !! no station elevation given; pass --station-elev to")
            print("     lapse-transfer it to the pad. Using it unadjusted.")
            T_pad, T_src = T_st, "%s (untransferred)" % ob.station
        else:
            T_pad = T_st - L0 * (ob.elev_m - args.elev)
            print("  %s reported             %8.2f K  (%.1f C) at %.0f m"
                  % (ob.station, T_st, ob.temp_c, ob.elev_m))
            print("  lapse-transferred to pad   %8.2f K  (%.1f C)"
                  % (T_pad, T_pad - 273.15))
            T_src = "%s, transferred %+.0f m" % (ob.station, args.elev - ob.elev_m)
        print("  departure from ISA         %+8.2f K" % (T_pad - T_isa))
    print()

    # --- derived ---
    L_refit = refit_lapse(T_pad, H_pad)
    rho = density(p_pad, T_pad)
    rho_isa = density(p_a, T_isa)

    print("RESULT")
    print("  T_pad     %8.2f K      (%s)" % (T_pad, T_src))
    print("  p_pad     %8.1f Pa     (%s)" % (p_pad, p_src))
    print("  L_0       %8.5f K/m   (eq (7) re-fit; ISA is %.5f)" % (L_refit, L0))
    print("  rho_pad   %8.5f kg/m3" % rho)
    print()

    if ob is not None:
        d_T = density(p_pad, T_isa) / rho - 1.0
        d_p = density(p_a, T_pad) / rho - 1.0
        print("  error you would have made using ISA instead of the observation:")
        print("    temperature   %+6.2f%% in density" % (d_T * 100))
        print("    pressure      %+6.2f%% in density" % (d_p * 100))
        print("    both          %+6.2f%% in density" % ((rho_isa / rho - 1) * 100))
        if ob.dewp_c is not None:
            f = virtual_factor(ob.temp_c, ob.dewp_c, p_pad)
            rh = sat_vapour_pressure(ob.dewp_c) / sat_vapour_pressure(ob.temp_c)
            print("    humidity      %+6.2f%% in density  (RH %.0f%%, deferred in Phase 1)"
                  % ((f - 1) * 100, rh * 100))
        if ob.maintenance:
            print()
            print("  !! observation ends in '$': the station is flagging that it")
            print("     needs maintenance. Data is usable but treat it with caution.")


if __name__ == "__main__":
    sys.exit(main())
