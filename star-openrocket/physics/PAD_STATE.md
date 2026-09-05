# pad-state

Resolves the pad atmospheric state — $T_{\text{pad}}$, $p_{\text{pad}}$, $\rho$ — for the
recovery model. Implements PLAN.md §5: equations (1), (2), (5), (7), (7a), (7b).

Stdlib only.

## Usage

Three modes, in increasing order of how much you know.

**Nothing but your elevation.** This is the Phase 1 default and it is a
legitimate answer, not a fallback — see "why pressure barely matters" below.

```
python3 pad_state.py --elev 610
```

**A METAR someone read you, or one you pasted.** No network needed.

```
python3 pad_state.py --elev 610 --station-elev 697 \
  --metar "METAR KNID 290456Z AUTO 19013KT 10SM CLR 31/M03 A2981 RMK AO2 SLP070 T03061028 \$"
```

**Live query** against the NWS Aviation Weather Center:

```
python3 pad_state.py --elev 610 --station KNID
```

`--elev` is pad elevation MSL in metres. Get it from GPS or a topo quad — 10 m
of elevation error is 0.12% in pressure, which is comparable to every other
term the model is chasing.

`--station-elev` lets the tool lapse-transfer the reported temperature to your
pad. Without it the station temperature is used unadjusted and the tool says so.

## Tests

```
python3 test_pad_state.py
```

Offline. Checks eq (7a) against the published ISA table at 0/1000/1400/11000 m,
the eq (7b) round trip on four different days, the eq (7) self-consistency
regression (standard pad in → −6.5 K/km out), and METAR parsing including the
`Txxxxxxxx` precision remark, the international `Q` group, and the maintenance
flag.

## Why pressure barely matters and temperature does

Worked at the FAR site (610 m) against a real KNID observation:

| input taken from ISA instead of measured | error in density |
|---|---|
| temperature | **+7.08%** |
| pressure | +0.37% |
| humidity (RH 11%) | −0.20% |

Site elevation alone pins pressure to about 2%, because sea-level pressure only
wanders a few percent with synoptic weather. Nothing pins temperature — it swung
20 K from standard on that observation, and that was at 10 p.m.

**Bring a thermometer. Look up your elevation. Everything else is noise.**

## Traps this tool exists to avoid

- **The altimeter setting is not station pressure.** A METAR reports the
  reference pressure that makes an altimeter at the field read field elevation.
  Using it directly as $p_{\text{pad}}$ is an 11–18% density error at high desert
  sites, and exactly 0% at sea level — so it is invisible in testing and worst
  where these vehicles actually fly. Eq (7b) inverts the definition.
- **`SLPxxx` in the remarks is a third distinct number** — sea-level pressure,
  reduced with the actual station temperature rather than the standard column.
  Not used here.
- **The JSON API reports `altim` in hectopascals**, while the raw METAR uses
  inHg for US stations. A factor of 33.86 if confused. Both paths handled.
- **Aggregator sites substitute the nearest reporting station** when an airport
  has none of its own, so a page existing for an identifier does not mean that
  field reports. The AWC API does not substitute: query it directly and an empty
  result means the station genuinely does not issue METARs.

## Station notes, FAR site (35.34723 N, 117.81006 W)

| station | distance | elevation | gap | reports? |
|---|---|---|---|---|
| KIYK Inyokern | 34.7 km | 749 m | +139 m | no, redirects to KNID |
| **KNID China Lake** | **39.0 km** | **697 m** | **+87 m** | **yes** |
| KMHV Mojave | 44.6 km | 854 m | +244 m | yes |
| KEDW Edwards AFB | 50.2 km | 702 m | +92 m | yes |

KNID's 87 m elevation gap is near best case, which puts eq (7b) at ~0.09% there.
Pad elevation of 610 m is an estimate — confirm it before relying on the gaps.

L71 California City was on this list as "verify — sources conflict". It is
resolved and removed: **L71 does not report.** AWC `stationinfo` returns no
record for it, `metar?ids=L71&hours=48` returns an empty array, and the IEM
archive returns a header with zero rows. It runs an AWOS that feeds aggregator
sites but issues nothing into NWS distribution — the same trap as KIYK, one
paragraph up.

`site-climatology/` measures what the residual after eq (7b) actually is, by
referring KNID, KMHV and KEDW to the same pad and comparing: **±0.1%**, against
the 0.03–0.5% band the literature quotes.
