# Fruity Chutes scraper

Pulls the full parachute metrics table for every chute in the Fruity Chutes
descent-rate calculator into a committed SQLite database (`parachutes.db`), plus
`parachutes.json` / `parachutes.csv` for eyeballing.

## ⚠️ The committed DB is a 3-row seed, not the full catalogue

`parachutes.db` currently holds only the three chutes (`CFC-84`, `CFC-96`,
`TARC-16`) that appear in `capture.har`, because the machine this was written on
had no network route to fruitychutes.com. Every row is marked `source='har'`.

**Run the scraper once on a networked machine to fill it in:**

```bash
python3 scrape_fruitychutes.py --db parachutes.db --out-dir out
```

That upserts the live catalogue in alongside the seed rows (`source='api'`).
Until then, treat the DB as a schema demo — don't size a recovery system off
three rows.

## Usage

Stdlib only — no `pip install`.

```bash
# Everything: discovers the SKU list itself, upserts into out/parachutes.db
python3 scrape_fruitychutes.py --out-dir out

# Update the committed database in place
python3 scrape_fruitychutes.py --db parachutes.db --no-flat-files

# Just a few chutes
python3 scrape_fruitychutes.py --skus CFC-96 TARC-16 --print-table

# Slower / gentler on their server
python3 scrape_fruitychutes.py --out-dir out --delay 1.5

# Rebuild the seed DB from the capture, no network needed
python3 scrape_fruitychutes.py --from-har capture.har --db parachutes.db --no-flat-files
```

`--print-table` renders each record in the same layout the calculator page uses,
which is handy for spot-checking a row against the website.

## Database

Single table, `parachutes`, keyed on `sku`. The API returns every number as a
string (`"96.0000"`), so values are coerced to `REAL` to keep the table directly
queryable; `raw_json` keeps the untouched response in case a field is added
upstream or a coercion ever loses something.

| Column | Type | API field |
| --- | --- | --- |
| `sku` (PK) | TEXT | `SKU` |
| `api_id` | INTEGER | `id` |
| `model`, `trim` | TEXT | `model`, `trim` |
| `style` | TEXT | `style` |
| `canopy_style` | TEXT | `canopy_style` |
| `diameter_in` | REAL | `diameter` |
| `diameter_spill_in` | REAL | `diameter_spill` |
| `gores` | REAL | `gores` |
| `rating_20fps_lb` | REAL | `rate_20` |
| `rating_15fps_lb` | REAL | `rate_15` |
| `weight_oz`, `weight_g` | REAL | `weight_oz`, `weight_grams` |
| `packing_volume_in3` | REAL | `packing_volume` |
| `area_projected_sqft` | REAL | `area_projected` |
| `area_canopy_sqft` | REAL | `area_canopy` |
| `area_spill_sqft` | REAL | `area_spill` |
| `cd_projected` | REAL | `cd_projected` |
| `cd_area_canopy` | REAL | `cd_area_canopy` |
| `equivalent_flat_diameter_in` | REAL | `equivalent_flattend_d` |
| `performance_ratio_20fps` | REAL | `performance_ratio_20` |
| `performance_ratio_15fps` | REAL | `performance_ratio_15` |
| `manufacturer`, `description`, `url` | TEXT | same |
| `source` | TEXT | `'api'` or `'har'` — where the row came from |
| `scraped_at` | TEXT | ISO-8601 UTC |
| `raw_json` | TEXT | verbatim API response object |

Indexed on `model`, `diameter_in`, `rating_20fps_lb`, `rating_15fps_lb` and
`canopy_style` — i.e. the columns a chute-sizing query filters on.

Writes are **upserts on `sku`**, so an interrupted scrape tops the table up
rather than truncating it, and re-running is idempotent.

```sql
-- Lightest chute that lands a 4 lb airframe at 20 fps or slower
SELECT sku, weight_oz, rating_20fps_lb
FROM parachutes WHERE rating_20fps_lb >= 4.0
ORDER BY weight_oz LIMIT 5;

-- Best mass efficiency per product line
SELECT model, MAX(performance_ratio_20fps) FROM parachutes GROUP BY model;
```

## How it works

The calculator's "Parachute Metrics" table is backed by a plain JSON endpoint, so
we never parse rendered HTML for the numbers:

```
GET https://fruitychutes.com/parachuteapi.js?method=get&term=<SKU>
```

```json
[{"id":410,"SKU":"CFC-96","model":"CFC","trim":null,
  "style":"Classic Elliptical with nylon lines","canopy_style":"elliptical",
  "diameter":"96.0000","diameter_spill":"19.2000","gores":"12.0000",
  "rate_20":"34.4539","rate_15":"19.3803","weight_oz":"30.0000", ... }]
```

Response fields map 1:1 onto the on-page table rows:

| Table row | JSON field |
| --- | --- |
| Chute Style | `style` |
| Canopy Shape | `canopy_style` |
| Canopy Diameter (in) | `diameter` |
| Diameter Spill Hole (in) | `diameter_spill` |
| Number Gores | `gores` |
| Rating @ 20fps (lbs) | `rate_20` |
| Rating @ 15fps (lbs) | `rate_15` |
| Weight oz / grams | `weight_oz` / `weight_grams` |
| Packing Volume (in^3) | `packing_volume` |
| Area Projected / Canopy (sq ft) | `area_projected` / `area_canopy` |
| Cd Projected / Cd Area Canopy | `cd_projected` / `cd_area_canopy` |
| Equivalent Flattened D (in) | `equivalent_flattend_d` (the API spells it "flattend") |
| Performance Ratio 20/15fps | `performance_ratio_20` / `performance_ratio_15` |
| Manufacturer | `manufacturer` |

The API also returns `id`, `model`, `trim`, `url`, `description` and `area_spill`,
which the page doesn't display. All of it lands in the CSV.

## Bot protection

There isn't any, as far as the captured traffic shows. The XHRs carry **no
cookies at all**, so nothing is gated behind a session or CSRF token, and the
responses are bare Apache with no challenge/WAF layer. The endpoint is
reachable with plain `curl`:

```bash
curl -s 'https://fruitychutes.com/parachuteapi.js?method=get&term=CFC-96' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36' \
  -H 'X-Requested-With: XMLHttpRequest' \
  -H 'Referer: https://fruitychutes.com/help_for_parachutes/parachute-descent-rate-calculator'
```

The one header that genuinely matters is `User-Agent`: responses come back with
`vary: Accept-Encoding,User-Agent`, so the server may serve different bytes to an
unrecognised agent. The scraper sends a browser UA, `X-Requested-With` and a
`Referer` to match what `descentRate.js` does. It also rate-limits itself
(0.5 s between requests by default) and backs off exponentially on 429/5xx.

## Discovering the model dropdown

This is the only part that couldn't be confirmed against the live site, because
the reference capture only contains three chute selections. The scraper tries
four strategies and unions the results, so it degrades gracefully:

1. **Bulk dump** — tries `method=list`, `method=all`, and empty-term queries. If
   one works the whole catalogue arrives in a single request. Unconfirmed;
   `method=get` is the only method actually observed.
2. **Dropdown parse** — `zelect.js` is a `<select>`-replacement widget, so the
   real `<option>` list ships inside the calculator page's HTML. The control is
   named `term` (the calculator's share links look like `?term=TARC-20&weight=1.5`).
3. **Character sweep** — queries each of `A–Z` and `0–9` as the `term`. If the
   backend matches with a `LIKE`, this enumerates the catalogue in 36 requests,
   since every SKU contains at least one alphanumeric. The scraper probes for
   partial matching first (`term=CFC` should return both CFC-84 and CFC-96) and
   skips the sweep if the endpoint turns out to be exact-match only.
4. **Enumeration** (`--enumerate-max N`, off by default) — crosses every SKU
   prefix already discovered with diameters `1..N`. Prefixes and trim suffixes
   come from real discovered data rather than guessed product names.

By default every SKU is then re-fetched individually with `method=get`, so all
rows come from the same authoritative response shape. `--no-refetch` skips that.

If the numbers look wrong or short, run with `-v` — the sweep logs per-character
hit counts, which makes it obvious whether partial matching is working.

## Tests

`test_mock.py` spins up a local HTTP server that mimics the API shape observed in
the capture and exercises each discovery path (bulk available, partial matching,
exact-match-only, explicit SKUs), the output writers, the SQLite typing and
upsert behaviour, and the HAR loader:

```bash
python3 test_mock.py
```

This is a mock, not a live check — it verifies the parsing, discovery fallbacks,
schema and output formatting, not that the real endpoint still behaves as
captured. Run the scraper against the live site to confirm that.

`capture.har` is the original DevTools capture, committed so `parachutes.db` can
be rebuilt and audited without network access. It contains no cookies or
credentials — the API needs none.
