#!/usr/bin/env python3
"""Offline tests for pad_state. No network. Run: python3 test_pad_state.py"""

import sys

import pad_state as ps

FAILS = []


def check(name, got, want, tol):
    ok = abs(got - want) <= tol
    print("%-52s %s  got %.6g want %.6g" % (name, "ok " if ok else "FAIL", got, want))
    if not ok:
        FAILS.append(name)


def check_eq(name, got, want):
    ok = got == want
    print("%-52s %s  got %r" % (name, "ok " if ok else "FAIL", got))
    if not ok:
        FAILS.append(name)


# --- eq (7a) against the published ISA table -------------------------------
# These are the values in every ISA reference. If (7a) reproduces them the
# exponent, constants and layer-0 form are all right.
for H, want in ((0.0, 101325.0), (1000.0, 89874.6), (1400.0, 85598.9),
                (11000.0, 22632.1)):
    check("eq (7a) ISA pressure at %6.0f m" % H, ps.p_pad_isa(H), want, 0.6)

check("layer-0 exponent -g0/(Rd L0)", ps.EXP, 5.255877, 1e-5)

# --- eq (7b) is an exact inversion, on any day -----------------------------
# The altimeter setting is *manufactured* from station pressure with the
# standard column, so decoding it must round-trip to machine precision
# regardless of what the real weather is doing.
for p_sta in (89874.6, 87000.0, 92500.0, 95123.7):
    A = p_sta / ps.column_ratio(1000.0)          # how the station computes it
    check("eq (7b) round trip from %8.1f Pa" % p_sta,
          ps.p_pad_metar(A, 1000.0), p_sta, 1e-6)

# --- eq (7) self-consistency ----------------------------------------------
# Feeding standard sea-level conditions must return the standard lapse rate.
# This is the free regression test called out in PLAN.md section 5.
check("eq (7) returns ISA L0 for standard pad", ps.refit_lapse(288.15, 0.0),
      -0.0065, 1e-9)

# --- eq (1) ----------------------------------------------------------------
check("eq (1) geopotential at 10 km", ps.geopotential(10000.0), 9984.29, 0.01)
check("eq (1) is identity at sea level", ps.geopotential(0.0), 0.0, 1e-12)

# --- METAR parsing ---------------------------------------------------------
RAW = "METAR KNID 290456Z AUTO 19013KT 10SM CLR 31/M03 A2981 RMK AO2 SLP070 T03061028 $"
ob = ps.parse_metar(RAW)
check_eq("station id", ob.station, "KNID")
check_eq("obs time", ob.time, "290456Z")
# The Txxxxxxxx remark must win over the rounded 31/M03 group.
check("temp from T-remark, not 31/M03", ob.temp_c, 30.6, 1e-9)
check("dewpoint from T-remark, not M03", ob.dewp_c, -2.8, 1e-9)
check("altimeter A2981 -> Pa", ob.altim_pa, 29.81 * ps.INHG, 1e-6)
check_eq("maintenance flag from trailing $", ob.maintenance, True)

# Rounded group only, no remark.
ob2 = ps.parse_metar("KMHV 291553Z 12008KT 10SM CLR 28/M01 A3012")
check("temp falls back to rounded group", ob2.temp_c, 28.0, 1e-9)
check("dewpoint falls back to rounded group", ob2.dewp_c, -1.0, 1e-9)
check_eq("no maintenance flag", ob2.maintenance, False)

# International Q-group is hPa, not inHg -- a factor of 33.86 if confused.
ob3 = ps.parse_metar("EGLL 291550Z 24012KT 9999 FEW035 18/11 Q1013")
check("altimeter Q1013 -> Pa", ob3.altim_pa, 101300.0, 1e-6)

# --- the KNID case end to end ---------------------------------------------
H = ps.geopotential(610.0)
T_pad = (30.6 + 273.15) - ps.L0 * (697.0 - 610.0)
p_pad = ps.p_pad_metar(29.81 * ps.INHG, H)
rho = ps.density(p_pad, T_pad)
check("FAR T_pad, KNID transferred -87 m", T_pad, 304.32, 0.01)
check("FAR p_pad via eq (7b)", p_pad, 93858.8, 0.5)
check("FAR density", rho, 1.07446, 1e-4)

# Temperature must dominate pressure by more than an order of magnitude here.
T_isa = ps.T0 + ps.L0 * H
err_T = ps.density(p_pad, T_isa) / rho - 1.0
err_p = ps.density(ps.p_pad_isa(H), T_pad) / rho - 1.0
check("ISA-temperature error in density", err_T, 0.0708, 5e-4)
check("ISA-pressure error in density", err_p, 0.0037, 5e-4)
check_eq("temperature dominates pressure by >10x", abs(err_T) > 10 * abs(err_p), True)

print()
if FAILS:
    print("%d FAILED: %s" % (len(FAILS), ", ".join(FAILS)))
    sys.exit(1)
print("all passed")
