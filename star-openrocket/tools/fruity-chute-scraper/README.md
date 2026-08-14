# Fruity Chutes scraper

Pulls the full parachute metrics table behind the Fruity Chutes descent-rate
calculator into a committed CSV (`parachutes.csv`), plus one raw JSON payload
per device under `raw/`.

Stdlib only — no `pip install`.

## The catalogue is multi-vendor

The calculator is not Fruity Chutes' own product list. It carries six
manufacturers, and only 68 of the 121 rows are Fruity Chutes:

| manufacturer | SKUs | prefixes |
|---|---|---|
| **Fruity Chutes** | **68** | `IFC-`, `CFC-`, `TARC-` |
| Sky Angle | 16 | `SKY-` |
| Spherachute | 13 | `SP-` |
| The Rocket Man | 11 | `R…C` |
| Top Flight Recovery | 7 | `PAR-` |
| Giant Leap | 6 | `TAC-1-` |

Every row carries a `manufacturer` column, so filtering is a one-liner.

> **The spill-hole convention is uniform across all six manufacturers.**
> PLAN.md §4.1 establishes that `area_projected` *excludes the spill hole* —
> for the IFC-48, π*d*²/4 = 12.5664 ft² against an `area_projected` of
> 12.1771 ft², the difference being exactly the 8.448 in vent (+3.20%). That
> convention could have been Fruity-Chutes-only, since they transcribe
> competitors' canopies into their own calculator. It is not:
> `area_projected + area_spill == πd²/4` holds for **120 of 121 rows**, every
> manufacturer included. So `cd_projected × area_projected` is safe to use
> catalogue-wide via eq (A1).
>
> The single exception is not a convention break. `R18C-P` is a **cupped
> cruciform** with no vent at all (`diameter_spill = 0`), whose projected area
> is 90% of πd²/4 because an X-shaped canopy never inflates to a full circle.
> Different geometry, and one more reason never to recompute `S_p` from a
> quoted diameter.

## Usage

The committed table lives in `physics/data/`, which is where
`physics.devices.load_catalogue()` reads it from — so a re-scrape writes
there, not next to this script.

```bash
DATA=../../physics/data

# Everything: discovers the catalogue itself, writes parachutes.csv and raw/
python3 scrape_fruitychutes.py --out-dir "$DATA"

# Fail the run if any row fails an eq (A4)-(A6) consistency check
python3 scrape_fruitychutes.py --out-dir "$DATA" --strict

# Slower / gentler on their server
python3 scrape_fruitychutes.py --out-dir "$DATA" --delay 1.5

# Just a few chutes, printed rather than written
python3 scrape_fruitychutes.py --skus CFC-96 TARC-16 --print-table

# Rebuild from the committed capture, no network needed
python3 scrape_fruitychutes.py --from-har capture.har --out-dir "$DATA"
```

After a re-scrape, run the library's data-layer test — it pins the row count,
the eq (A1)-(A3) conversions for the IFC-48 used in PLAN.md §13, and the two
known vendor errors:

```bash
cd ../.. && .venv/bin/python -m pytest tests/test_devices.py -q
```

`--print-table` renders each record in the same layout the calculator page uses,
which is handy for spot-checking a row against the website.

## Output

**`parachutes.csv`** — one row per SKU, keyed on `sku`, sorted by `sku`. Column
names are **machine names, not the display labels** on the calculator page, so
renaming a table heading upstream cannot break `physics/devices.py`.
Values stay in vendor units; PLAN.md eqs (A1)–(A3) do the SI conversion at load
time, so exactly one place converts.

| column | API field | | column | API field |
|---|---|---|---|---|
| `sku` (key) | `SKU` | | `area_projected_sqft` | `area_projected` |
| `api_id` | `id` | | `area_canopy_sqft` | `area_canopy` |
| `model`, `trim` | same | | `area_spill_sqft` | `area_spill` |
| `style` | `style` | | `cd_projected` | `cd_projected` |
| `canopy_style` | `canopy_style` | | `cd_area_canopy` | `cd_area_canopy` |
| `diameter_in` | `diameter` | | `equivalent_flat_diameter_in` | `equivalent_flattend_d` |
| `diameter_spill_in` | `diameter_spill` | | `performance_ratio_20fps` | `performance_ratio_20` |
| `gores` | `gores` | | `performance_ratio_15fps` | `performance_ratio_15` |
| `rating_20fps_lb` | `rate_20` | | `manufacturer`, `description`, `url` | same |
| `rating_15fps_lb` | `rate_15` | | `source` | `'api'` or `'har'` |
| `weight_oz`, `weight_g` | `weight_oz`, `weight_grams` | | `scraped_at` | ISO-8601 UTC |
| `packing_volume_in3` | `packing_volume` | | | |

**`raw/<sku>.json`** — the untouched API response for that device, one file
each, so vendor payloads stay diffable and CSV quoting stays sane.

**Why CSV and not SQLite.** This is committed reference data feeding structural
load calculations. A vendor revising `Cd` from 2.2 to 1.9 — a 14% shift in
`CdS`, straight into eq (23) — has to be visible as a readable line in a pull
request. A binary database makes every re-scrape an unreviewable blob delta.
Writes **merge on `sku`**, so an interrupted scrape tops the table up rather
than truncating it, and re-running with no vendor change is byte-identical.

## Consistency checks

Every run asserts PLAN.md eqs (A4)–(A6) and warns per row. These validate that
a record *parsed* correctly, which matters because a silently mis-parsed `Cd`
or area becomes a wrong opening load with nothing to flag it:

- **(A4)** `cd_projected × area_projected == cd_area_canopy × area_canopy`
- **(A5)** `equivalent_flattend_d == sqrt(4·area_canopy/π)`
- **(A6)** `rate_15 / rate_20 == (15/20)² = 0.5625`

119 of 121 rows pass. The two that do not are a real vendor data-entry error:

```
CFC-30-S  A4: cd_projected*area_projected=7.0686 != cd_area_canopy*area_canopy=6.7104
CFC-36-S  A4: ...=10.1787 != ...=9.6630
```

Both `-S` variants have geometry identical to their base models but carry
`cd_area_canopy = 0.8000` where consistency requires `0.8427` (the value the
non-`-S` rows use). **This does not affect any drag area we compute**, because
eq (A1) reads `cd_projected × area_projected`, not the canopy pair — but it is
exactly the class of error these assertions exist to surface.

## How it works

The metrics table is backed by a plain JSON endpoint, so no rendered HTML is
parsed for numbers:

```
GET /parachuteapi.js?method=get&term=<SKU>
```

Discovery uses two further methods, `list` and `manufacturer`, which populate
the calculator's dropdowns:

```
GET /parachuteapi.js?method=manufacturer&term=&page=0
GET /parachuteapi.js?method=list&term=&page=0&mfgr=<key>
```

### ⚠️ Three traps, all of which return `[]` with HTTP 200

None of these produce an error. A scrape that hits any of them reports an empty
catalogue and looks like the endpoint no longer exists — which is exactly what
happened once already. All three are pinned in `test_mock.py`.

1. **`list` and `manufacturer` require a `PHPSESSID`.** Load the calculator page
   first; the scraper does this in `warm_session()`. `method=get` needs no
   session, so a HAR capturing only `get` calls will never reveal this.
2. **`page` is 0-indexed.** `page=1` on the 121-row catalogue — which fits
   entirely on page 0 — returns `[]`.
3. **`list` returns lowercase `sku`**, not the `SKU` of `method=get`, and
   `manufacturer` returns `key`. A parser filtering on `"SKU"` silently drops
   the entire catalogue.

`method=get` is also **exact-match only**. It no longer does partial matching,
so the older character-sweep and prefix-enumeration strategies find nothing on
their own; they survive as fallbacks for when catalogue discovery fails.

Per-manufacturer counts are pulled separately and summed against the unfiltered
list — the only available cross-check that the `** all **` list is not itself
truncated. They agree at 121.

## Bot protection

There isn't any, as far as the captured traffic shows, beyond the session
requirement above. The XHRs carry no auth, nothing is gated behind CSRF, and the
responses are bare Apache with no challenge layer. The endpoint is reachable
with plain `curl`:

```bash
curl -s 'https://fruitychutes.com/parachuteapi.js?method=get&term=CFC-96' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36' \
  -H 'X-Requested-With: XMLHttpRequest' \
  -H 'Referer: https://fruitychutes.com/help_for_parachutes/parachute-descent-rate-calculator'
```

The one header that genuinely matters is `User-Agent`: responses come back with
`vary: Accept-Encoding,User-Agent`, so the server may serve different bytes to
an unrecognised agent. The scraper sends a browser UA, `X-Requested-With` and a
`Referer` to match what `descentRate.js` does. It rate-limits itself (0.5 s
between requests by default) and backs off exponentially on 429/5xx.

## Tests

```bash
python3 test_mock.py
```

Spins up a local server mimicking the live API — including all three traps
above — and exercises the discovery paths, the CSV writer (headers, numeric
formatting, null handling, byte-identical re-writes, non-destructive merge,
sort order), the raw-payload writer, the (A4)–(A6) checks, and the HAR loader.

This is a mock, not a live check: it verifies parsing, discovery, schema and
output formatting, not that the real endpoint still behaves as captured. Run
the scraper against the live site to confirm that.

`capture.har` is the original DevTools capture, committed so the seed rows can
be rebuilt and audited without network access. It contains no cookies or
credentials. Note it captures only three `method=get` calls, so it does **not**
document the discovery path — that was reverse-engineered from
`assets/fc/js/descentRate.js`.
