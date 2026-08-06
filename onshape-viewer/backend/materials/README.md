# makeitfrom.com material scraper

Scrapes the full material catalog from [makeitfrom.com](https://www.makeitfrom.com)
into a local SQLite database (`../data/materials.db`). The site has no API,
sitemap, or robots.txt, so `scrape.py` crawls the `/material-group/` tree from
the home page and parses every `/material-properties/` leaf page.

As of the last run: **~100 groups, ~2585 materials.**

## Run

Uses only the backend venv (`httpx` + stdlib), no extra deps:

```bash
python backend/materials/scrape.py                # discover + scrape everything
python backend/materials/scrape.py --limit 25     # quick smoke test
python backend/materials/scrape.py --discover-only # just map the group tree
python backend/materials/scrape.py --refresh      # re-scrape stored materials
python backend/materials/scrape.py --db /path.db --workers 8
```

The crawl is **resumable**: a material already stored with HTTP 200 is skipped,
so an interrupted run continues where it left off. Drop `materials.db` to start
clean.

## Schema

Entity-attribute-value, because materials expose heterogeneous property sets
(rubber has no melting point, ceramics no elongation) — a wide table would be
mostly NULL.

| table            | purpose |
|------------------|---------|
| `materials`      | one row per material: `slug`, `name`, `url`, `description`, `http_status`, `scraped_at` |
| `properties`     | one row per property: `material_slug`, `section`, `name`, `value_num`, `value_max`, `unit`, `value_imperial`, `value_text`, `position` |
| `composition`    | alloy composition rows: `material_slug`, `element`, `symbol`, `pct_min`, `pct_max`, `pct_text`, `position` |
| `groups`         | one row per group page: `slug`, `name`, `url`, `description` |
| `group_edges`    | group hierarchy: `parent_slug` → `child_slug` |
| `material_group` | which leaf group(s) list each material: `material_slug`, `group_slug` |

### Property values

- SI figures are parsed into numbers: `value_num` (the value, or the **low** end
  of a range) and `value_max` (the **high** end, when the page shows `"76 to
  140 MPa"`; else NULL). `unit` is the SI unit (`GPa`, `g/cm^3`, `W/m-K`).
- `value_imperial` keeps the imperial figure as a string (`"170 lb/ft^3"`,
  `"10 x 10^6 psi"`) — not normalized, since its units vary.
- `value_text` is the full flattened cell, so nothing is lost if the numeric
  parse ever misses.
- `section` is one of: Mechanical, Thermal, Electrical, Otherwise Unclassified,
  Common Calculations.

Superscripts/subscripts are flattened as `^n` / inline, so units and scientific
notation stay readable (`g/cm^3`, `mm^2/s`, `x 10^6`, `CO2`).

## Example queries

```sql
-- Density of every material (kg/m^3 = value_num * 1000 for g/cm^3)
SELECT m.name, p.value_num, p.unit
FROM properties p JOIN materials m ON m.slug = p.material_slug
WHERE p.name = 'Density' ORDER BY p.value_num;

-- Strongest aluminum alloys by yield strength
SELECT m.name, p.value_num AS yield_min_MPa, p.value_max AS yield_max_MPa
FROM properties p JOIN materials m ON m.slug = p.material_slug
JOIN material_group mg ON mg.material_slug = m.slug
WHERE p.name LIKE 'Tensile Strength: Yield%' AND m.name LIKE '%Aluminum%'
ORDER BY p.value_num DESC LIMIT 20;

-- All distinct property names collected
SELECT DISTINCT section, name FROM properties ORDER BY section, name;
```

## Politeness

Static HTML, 6 concurrent fetchers, exponential backoff on 429/5xx, a descriptive
User-Agent. One full run is a few thousand GETs. Re-run with `--refresh` only
when you actually want fresh numbers.
