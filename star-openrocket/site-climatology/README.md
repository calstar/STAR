# site-climatology

Historical weather at the FAR launch site, binned by month, for the two
atmospheric inputs PLAN.md §5 actually consumes: pad station pressure
$p_{\text{pad}}$ and the low-altitude temperature profile $T(H)$.

`pad-state/` answers *what is it right now*. This answers *what should I expect
in October*, which is the question you have while designing rather than while
standing at the pad.

Stdlib only, matching `pad-state` and `fruity-chute-scraper`.

## Usage

```
python3 metar_history.py                    # last 12 complete months, KNID
python3 metar_history.py --compare          # + the station-to-station spread
python3 temp_profile.py                     # Edwards + China Lake, 10 years
python3 temp_profile.py --station VEF       # Las Vegas cross-check
python3 test_site_climatology.py            # 105 assertions, offline
```

First run downloads ~64 MB into a gitignored `cache/`; after that everything is
local. `metar_history.py --no-fetch` re-aggregates from cache alone.

Outputs land in `data/`, committed:

| file | what |
|---|---|
| `knid-obs.csv` | 8331 hourly observations, each with $p_{\text{pad}}$, $T_{\text{pad}}$, $\rho$ |
| `knid-monthly.csv` | those binned by calendar month, all-hours and launch-window |
| `edw-nid-tprofile-monthly.csv` | $T(H)$ quantiles, pad to 25 kft, per month |
| `edw-nid-lapse-monthly.csv` | fitted lapse rate per month vs what eq (7) infers |
| `vef-*.csv` | the same two, from Las Vegas, as a cross-check |

## CI

`.github/workflows/recovery-calculator-ci.yml` runs on any push touching
`recovery-calculator/**`. Three jobs: this suite (on Python 3.9 and 3.12,
matching the `target-version` floor in the repo-root `pyproject.toml`),
`pad-state`, and `fruity-chute-scraper`.

Everything in this tree is stdlib-only, so the workflow has no `pip install`
and no dependency cache anywhere in it. If a job ever needs one, something has
drifted.

The two offline jobs run with `http_proxy`/`https_proxy` pointed at a closed
port. **The tests must never touch the network** — regenerating the data needs
`aviationweather.gov`, `mesonet.agron.iastate.edu` and `ncei.noaa.gov`, and a
test that quietly started reaching one of them would be an intermittent failure
tied to somebody else's uptime. The proxy makes that a hard failure instead.
`fruity-chute-scraper` is exempt because its mock stands up a real loopback
HTTP server.

No `black` gate: `format.sh`'s `PY_TARGETS` covers only `firmware/`, and all
nine Python files under `recovery-calculator/` (including the pre-existing
ones) would be reformatted. Adding the gate means reformatting the tree first —
a separate, deliberate change.

### What CI actually catches

The tests can't re-fetch, so they gate the **committed** CSVs instead: column
names, all 12 months present, physical ranges, ordered quantiles, and two
sanity relations that would catch a real inversion of the logic — that the
launch-window mean is warmer than the all-hours mean in every month, and that
eq (7)'s error is identically zero at its own anchor. A regeneration that went
wrong should not be able to land quietly.

## Headline: pressure is not the problem

A full year at KNID, every observation run through eq (7b) to the pad:

| | seasonal swing | worst month vs eq (7a) |
|---|---|---|
| $p_{\text{pad}}$ | 1144 Pa, **1.21%** | +0.92% (January) |
| $T_{\text{pad}}$ | **25 K** | +25.6 K (August, launch window) |

The eq (7a) standard-column default is within +0.92%/−0.29% of *every* month's
mean. It is not a placeholder waiting to be improved — at this site it is
already better than the plan's own ~2% estimate, because 610 m is low enough
that synoptic wander barely shows.

Temperature does all the work. In density:

| month | ISA error, total | from $p$ | from $T$ |
|---|---|---|---|
| January | +1.97% | +0.92% | +0.99% |
| July | **−6.76%** | +0.06% | **−6.86%** |

This is `pad-state`'s "bring a thermometer" conclusion, confirmed against 8331
observations instead of one, and now with the seasonal shape attached: the
temperature term crosses zero in February and again in November, and is worth
−6% to −7% from June through September.

**A summer launch has ~7% less air than the standard column says.** That is
7% in drag force, so ~3.5% in descent rate and ~7% in the opening-load bound —
which lands squarely between "negligible" and the ±20% $C_x$ band, i.e. worth
carrying but not worth agonising over.

## Data sources

| need | source | why |
|---|---|---|
| live surface ob | AWC `aviationweather.gov/api/data/metar` | already in `pad-state`; correct for launch day |
| **surface history** | **IEM ASOS archive** | AWC serves only a short recent window |
| **temperature aloft** | **NOAA NCEI IGRA v2** | authoritative radiosonde archive |

**Iowa State Mesonet** (`mesonet.agron.iastate.edu/cgi-bin/request/asos.py`)
archives the same NWS/FAA observations AWC distributes, and returns the **raw
METAR string** alongside its decoded columns — so every number here is
re-derived by `pad_state.parse_metar` and nothing is taken on trust from the
aggregator. No key. Throttles with 429 rather than failing; `_get` backs off.

The strictly-authoritative alternative is NCEI's Integrated Surface Database
(`Global-Hourly`), which is the same observations in a harder format. That is a
provenance argument, not an accuracy one.

**IGRA v2** (`ncei.noaa.gov/data/integrated-global-radiosonde-archive`) is
NOAA's radiosonde archive, per-station zips of the full period of record.
Rejected alternatives:

- `rucsoundings.noaa.gov/get_soundings.cgi` would have been **strictly better**
  — RAP model soundings interpolated to the pad's own lat/lon, no station
  proxy at all. It returns empty for every query form tried (2026-07). It looks
  retired. Worth re-testing occasionally; if it comes back it supersedes IGRA
  for this purpose.
- `weather.uwyo.edu` serves the same IGRA data as scraped HTML, rate limited.
- ERA5 reanalysis would genuinely beat IGRA for a site-specific profile, but
  needs a Copernicus API key and is a much heavier dependency than a folder of
  stdlib scripts.

## Surface stations

Pad at 35°21′12″N, 117°48′25.80″W, 610 m MSL (**estimate** — `pad-state`'s
README flags this as unconfirmed, and it propagates into every gap below).

| id | name | distance | elev | gap | role |
|---|---|---|---|---|---|
| **KNID** | China Lake NAWS | **38.7 km** | 696 m | **+86 m** | **primary** |
| KMHV | Mojave Air & Space Port | 45.3 km | 849 m | +239 m | cross-check |
| KEDW | Edwards AFB | 50.2 km | 702 m | +92 m | cross-check |

KNID wins on the number that governs: eq (7b)'s residual scales with the
**elevation gap**, not distance. But it **drops temperature from about 06Z to
11Z**, degrading to altimeter-only:

```
KNID 010656Z AUTO A2985 RMK AO2 SLPNO PWINO $
```

8331 obs pulled, 8198 with temperature. `decode` keeps the pressure from those
rows rather than discarding them.

**L71 California City does not report.** `pad-state`'s README listed it as
"verify — sources conflict"; that is now resolved three ways. AWC `stationinfo`
returns no record for it, AWC `metar?hours=48` returns an empty array, and the
IEM archive returns a header with zero rows. It has an AWOS that feeds
aggregator sites but issues no METARs into NWS distribution — the exact
substitution trap `pad-state`'s README warns about. KIYK Inyokern likewise.

Station elevations above are as **IEM** reports them. AWC's `stationinfo`
disagrees by up to 14 m (KNID 682, KEDW 698, KMHV 841). Immaterial: station
elevation enters only the temperature lapse transfer, where 14 m is 0.09 K, and
it does **not** enter eq (7b) at all — an altimeter setting is already referred
to sea level, so the only elevation in that equation is the pad's.

## How $p_{\text{pad}}$ is computed

Per observation:

1. `Axxxx` group out of the raw METAR → altimeter setting, inHg × 3386.389 Pa.
   Falls back to IEM's decoded `alti` column only if the group is absent.
2. Pad 610 m geometric → $H_{\text{pad}}$ = 609.94 m geopotential, eq (1).
3. **Eq (7b)**: $p_{\text{pad}} = A\,(1 - 0.0065 H_{\text{pad}}/288.15)^{5.2559}$.
4. $T$ lapse-transferred station → pad at the standard −6.5 K/km, the same
   convention as `pad_state --station-elev`. For KNID, +0.56 K.

Never the raw setting (11–18% density error here). Never `SLPxxx`.

### The residual, measured rather than assumed

PLAN.md §5 can only put a literature band on the horizontal-gradient term
(0.03–0.5%). `--compare` measures it: all three fields referred to the same pad
by the same equation, matched hour by hour.

```
KEDW vs KNID: -58 Pa mean (-0.062%), sd 122 Pa, n=7640
KMHV vs KNID: +99 Pa mean (+0.105%), sd 120 Pa, n=5819
```

**±0.1%, at the bottom of the quoted band**, with a real seasonal signature —
KEDW runs low in winter, KMHV high in summer. Combined with the 86 m elevation
gap (~0.09%), eq (7b) at this site is good to roughly 0.15%.

> The join is on the **hour**, not the timestamp. These fields do not share a
> reporting minute — KNID files at :56, KEDW and KMHV at :55 — and an
> exact-timestamp join matched 12 observations out of 7640.

**This is a cross-check, not a blend, and the data says why.** KMHV's ASOS was
dead from mid-October through December 2025: October has 142 observations
against a normal ~720, November and December have zero. Averaging stations
would have silently degraded for two and a half months; comparing them makes
the outage obvious.

## Sounding stations

No radiosonde is at the pad. Every IGRA station within 600 km still reporting
in 2024+:

| km | IGRA id | station | elev | |
|---|---|---|---|---|
| **38** | USM00074612 | **China Lake NAF** | 696 m | **pooled** |
| **49** | USM00072381 | **Edwards AFB** | 702 m | **pooled** |
| 249 | USM00072388 | Las Vegas | 697 m | cross-check |
| 260 | USM00072393 | Vandenberg AFB | — | coastal |
| 287 | USM00072293 | San Diego/Miramar | 134 m | coastal |
| 420 | USM00074004 | Yuma Proving Grounds | 231 m | too far |

Vandenberg and Miramar are operational twice-daily and would be tempting on
sample count alone. They are **coastal**: the marine-layer inversion dominates
exactly the low-altitude band this module exists to characterise, so their
$T(H)$ is not the same physical situation as a 610 m inland high-desert pad.
Sample size does not fix being the wrong climate.

### Pool Edwards and China Lake

Neither of the two near stations is enough alone:

| year | 2016 | 2018 | 2020 | 2022 | 2024 | 2025 |
|---|---|---|---|---|---|---|
| Edwards | 117 | 152 | 38 | 67 | 88 | 41 |
| China Lake | 40 | 59 | 52 | 51 | 48 | 53 |

Edwards is a test-range operation and its rate is **falling** — 160/yr in 2017,
41/yr in 2025, with no April or May at all in 2026. China Lake is steady at
~50/yr and holds up in precisely the years Edwards thinned out (2020, 2025).

Pooling them is not averaging two climates. They are 38 km and 49 km from the
pad and **40 km from each other**, both at ~700 m, same high desert, same
terrain — one air mass sampled twice. Over the last decade that is **1331
usable soundings against Edwards' 915**, and every month now has $n \ge 72$
instead of dipping to 48:

| | soundings | min month | max month |
|---|---|---|---|
| Edwards alone | 915 | 48 (Jan) | 135 (Mar) |
| **Edwards + China Lake** | **1331** | **72 (Jan)** | **183 (Mar)** |

The fitted lapse rates move by under 0.1 K/km, which is the reassuring outcome:
China Lake independently agrees with Edwards, so the extra data buys precision
rather than shifting the answer.

`--station` takes any comma-separated subset — `--station EDW` reproduces the
single-station run, `--station VEF` is the cross-check. Las Vegas stays out of
the default pool because 249 km is a different site, not a second look at the
same one.

**One year is not enough** at either station — 41 and 53 soundings across 12
months. Hence `--years 10`: it trades interannual signal for monthly
resolution, which is the right trade when the question is "does it vary by
season." `--years 1` runs, but per-month $n$ falls to single digits.

### What would be better, and why it is unavailable

A **model sounding at the pad's own coordinates** beats any station: RAP 13 km
analysis, hourly, no proxy site at all. Two routes, both closed:

- `rucsoundings.noaa.gov/get_soundings.cgi` returns empty for every query form
  tried. Retired.
- NCEI THREDDS does publish the RAP analysis archive
  (`model-rap130anl`, back to 2005) and advertises a NetCDF Subset Service that
  would return a point profile as plain CSV. **Its NCSS endpoint is broken** —
  HTTP 500 on every date tried, wrapping an S3 403 from the storage backend.
  The raw GRIB2 files *are* downloadable via `fileServer` (HTTP 200), but
  decoding GRIB2 needs `cfgrib`/`eccodes`, which is a much heavier dependency
  than this tree's stdlib-only rule allows.

Worth re-testing occasionally. If either comes back it supersedes IGRA here.

## Heights are geopotential

$H$, never $z$, everywhere in `igra.py` and `temp_profile.py`. IGRA reports
geopotential, the hypsometric integration produces geopotential, and eqs (2),
(3), (4) and (7) consume geopotential. Eq (1) is applied exactly twice — at the
two ends of the grid — and nowhere else. CSV columns are named `H_msl_m` and
`H_agl_ft` so nothing downstream can mistake them.

The two differ by 10 m at the top of a 7620 m grid, 0.13%. Large enough to
matter if you mix them, small enough that it will never announce itself as a
bug. PLAN.md §1.4 already flags `h` vs `H` as a collision risk; this is the same
hazard one level down.

### Reconstructing heights

Reported GPH exists only at mandatory levels (925, 850, 700, 500 hPa …). Every
significant level reports −9999 — and significant levels are where the
inversions and lapse-rate breaks live, which is the entire reason to read a
sounding instead of assuming ISA. So `build_heights` integrates:

$$\Delta H = \frac{R_d \bar{T}}{g_0}\ln\frac{p_1}{p_2}$$

from the surface upward, using dry $\bar T$ (IGRA RH is missing on most of these
records, and §5 already defers the humidity correction).

QC, checked on every run: **integrated height minus reported GPH is −4 m
median, 24 m at p95, over 28,330 mandatory levels.** Tens of metres means the
integration is sound; hundreds would mean the surface anchor is wrong.

## What the profile says

Pooled 2016–2026, Edwards + China Lake, least-squares lapse rate over
pad → 25 kft:

| | $L$, K/km |
|---|---|
| November–January | −5.96 |
| June–August | −6.97 to −7.14 |
| ISA | −6.50 |

**Real seasonality, ±0.6 K/km around ISA, and ISA sits almost exactly in the
middle of it.** Day-to-day scatter within a month (sd 0.61–0.80 K/km) is
comparable to the whole seasonal swing, so a monthly lapse rate is a better
prior than ISA but not by a lot, and neither substitutes for a same-day
sounding.

### Where eq (7) goes wrong

Eq (7) pins the lapse rate to hit 216.65 K at 11 km. PLAN.md is explicit that
this is "a slope-setting device, not a claim about conditions at 11 km." The
data quantifies the cost — `L_eq7` is what eq (7) infers from each sounding's
*own* surface temperature, against `L_fit` measured on the same sounding:

| month | $L$ fitted | $L$ from eq (7) | error |
|---|---|---|---|
| January | −5.96 | −5.90 | +0.06 |
| April | −6.72 | −7.12 | −0.40 |
| **July** | **−7.14** | **−8.58** | **−1.44** |
| September | −6.53 | −7.83 | −1.30 |

**Eq (7) is excellent in winter and bad in summer, and the reason is
structural.** A hot pad forces a steep slope to reach a fixed 216.65 K, but the
real summer atmosphere puts that heat in a shallow surface layer and reverts to
something near ISA above it. The hotter the pad, the worse the over-steepening.

In temperature and the density that follows ($\rho \propto 1/T$):

| month | 5.7 kft | 10.7 kft | 15.6 kft | 20.5 kft | 25.4 kft |
|---|---|---|---|---|---|
| January | −9.2 K / +3.3% | −10.7 / +4.0% | −9.5 / +3.7% | −7.2 / +2.9% | −5.1 / +2.2% |
| July | −2.4 / +0.8% | −3.9 / +1.4% | −6.0 / +2.2% | −8.6 / +3.3% | −10.6 / +4.2% |
| August | −4.9 / +1.7% | −5.6 / +2.0% | −7.4 / +2.7% | −9.8 / +3.8% | −11.5 / **+4.6%** |
| November | −9.9 / +3.5% | −11.9 / **+4.3%** | −11.3 / +4.3% | −10.0 / +4.0% | −7.7 / +3.2% |

Peak error ~12 K, **under 5% in density**, and it always errs cold — so eq (7)
overstates density aloft, which overstates drag, which *understates* descent
time and velocity. Conservative on load, optimistic on drift.

Note winter and summer fail at **opposite ends** of the band: November's error
is worst at 10 kft and shrinks above, while August's grows monotonically all
the way to the ceiling. A single altitude-independent correction will not fix
both.

### Las Vegas agrees on the shape, not the slope

`--station VEF` pools 7263 soundings against the local pair's 1331, so it is
the check on whether 1331 irregular ascents are enough:

| month | local $L$ | Las Vegas $L$ | local eq(7) err | LV eq(7) err |
|---|---|---|---|---|
| January | −5.96 | −6.22 | +0.06 | −0.12 |
| April | −6.72 | −7.23 | −0.40 | −0.26 |
| July | −7.14 | −7.56 | −1.44 | −1.26 |
| October | −6.27 | −6.68 | −0.76 | −0.78 |

**The seasonal pattern replicates:** minimum steepness in November–January,
maximum in June–July, eq (7) accurate in winter and over-steepening in summer,
same sign and comparable magnitude. Two independent records, 5× apart in sample
size, telling the same story — sparse local sampling is not the thing limiting
this result.

**The absolute slope does not:** Las Vegas is consistently 0.3–0.5 K/km steeper
year-round. That is a real site difference across 249 km, and it is the honest
bound on how well *any* station proxies the pad — larger than the difference
pooling China Lake into Edwards made (<0.1 K/km), which is the argument for
pooling the near pair and not the far one. Use the local pair for numbers, Las
Vegas for confidence in the shape.

Las Vegas QC is likewise clean: −5 m median, 18 m p95 over 287,387 mandatory
levels.

### Two things not to do with this table

**Do not use the sounding's surface level as $T_{\text{pad}}$.** January's 0 ft
row has a p95−p05 spread of 41.2 K against 10.9 K just 820 ft higher — that is
the nocturnal surface layer plus irregular release times. The sounding's job is
the *shape* of the profile; the METAR's job is the *anchor*.

**Do not read the monthly mean profile as a flyable day.** Day-to-day spread at
altitude is 5–22 K depending on month (winter 15–22 K, summer 5–10 K — summer
aloft is far more repeatable than winter). The mean is a design prior. Given
that §6.4's airframe drag band spans a factor of 36 and $C_x$ carries ±20%,
a 5% density prior is not the thing limiting this model.

## Where this plugs into PLAN.md

§11.2 item 5 lists NWS integration as v2 work: nearest-station lookup, METAR
fetch, decode, eq (7b), "extends naturally to … radiosonde and model soundings
for a real $T(H)$ profile." This is the offline half of that — the climatology
you design against. The live half is `pad-state`.

Three specific contributions back to §5:

1. The eq (7a) ~2% error estimate is **pessimistic at this site**. Measured
   worst case is +0.92%, and the whole seasonal range is 1.21%.
2. The eq (7b) horizontal-gradient term is **measured**, not assumed: ±0.1%.
3. Eq (7)'s tropopause anchor is **month-dependent**, costing up to 1.44 K/km
   in lapse rate and 4.6% in density aloft, worst in summer. A Phase 2 eq (7)
   could take `edw-nid-lapse-monthly.csv` as the slope directly instead of
   inferring one from a fixed 216.65 K.

## Known limitations

- Pad elevation 610 m is unconfirmed. 10 m is 0.12% in pressure.
- Nearest soundings are 38 km and 49 km away, and the Las Vegas comparison puts
  0.3–0.5 K/km on what that distance costs. A pad-point model sounding would
  fix it; both routes to one are currently broken (see above).
- Monthly bins pool 10 years for the profile and 1 year for the surface. The
  surface year is enough (8331 obs); the profile decade is a compromise, and it
  will smear any real trend into the monthly means.
- Dry air throughout, per §5.
- Nothing here touches winds aloft, which is the other §14 item the same IGRA
  records could serve — `igra.Level` drops WDIR/WSPD on the floor today.
