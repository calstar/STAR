# Fruity Chutes scraper

Pulls the full parachute metrics table for every chute in the Fruity Chutes
descent-rate calculator into `parachutes.json` and `parachutes.csv`.

## Usage

Stdlib only — no `pip install`.

```bash
# Everything (discovers the SKU list itself)
python3 scrape_fruitychutes.py --out-dir out

# Just a few chutes
python3 scrape_fruitychutes.py --skus CFC-96 TARC-16 IFC-48-S --print-table

# Slower / gentler on their server
python3 scrape_fruitychutes.py --out-dir out --delay 1.5
```

`--print-table` renders each record in the same layout the calculator page uses,
which is handy for spot-checking a row against the website.

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
exact-match-only, explicit SKUs, output writers):

```bash
python3 test_mock.py
```

This is a mock, not a live check — it verifies the parsing, discovery fallbacks
and output formatting, not that the real endpoint still behaves as captured.
Run the scraper against the live site to confirm that.
