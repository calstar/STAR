# Elodin Run Viewer

A read-only web viewer for **past** Elodin DB runs. Browse timestamped runs,
pick arbitrary sensors, plot them interactively (zoom/pan), and export CSV or a
plot image — without copying the multi-GB DB off the box or setting up a Python
toolchain per person.

This complements the static-PNG `analyze_run.py` pipeline: same data, but
interactive and self-serve.

## Quick start (local)

```bash
cd daq-server/tools/postprocessing/webviewer
./run.sh                 # backend :8000 (reload) + Vite dev server :5173
# open http://localhost:5173
```

First open of a run triggers a one-time parquet export into `.cache/` (~20 s for
a ~1.3 GB run); subsequent opens are instant.

Single-process (build the frontend, serve everything from uvicorn):

```bash
./run.sh --build         # http://localhost:8000
```

### Env

| Var | Default | Meaning |
|-----|---------|---------|
| `ELODIN_DB_DIR` | `~/.local/share/elodin` | where run dirs live |
| `WEBVIEWER_CACHE_DIR` | `./.cache` | exported parquet cache |
| `PORT` | `8000` | backend port |
| `WEBVIEWER_MAX_DOWNLOAD_BPS` | `0` (unlimited); `run.sh --build` sets `10485760` (10 MB/s) | CSV download rate cap in bytes/sec. Dev is unthrottled; the deployment (`--build`) applies the cap |

## What it does

- **Runs** — only timestamped runs (`daq_YYYYMMDD_HHMMSS`) are listed; ad-hoc
  DBs (`daq_live`, calibration, hand-named) are ignored. Past runs are immutable,
  so exporting is safe alongside a live collection writing to a *different* dir.
- **Sensors** — grouped by family (PT, PT_Cal, TC, RTD, LC, ACT, CONTROLLER,
  BOARD). Meaningful fields are shown by default; raw/status/plumbing fields are
  behind the "all fields" toggle.
- **Plot** — uPlot; drag to zoom (which refetches that window at higher
  resolution), continuous series are min/max-decimated (spikes preserved),
  discrete series are step-drawn.
- **Export plot CSV** — selected channels over the current window, **wide**
  (aligned) format.
- **Download run CSV** — every primary channel, **long/tidy** (`time,component,
  value`) streamed. Long-format because a whole-run wide frame would be millions
  of rows × hundreds of mostly-NaN columns; a long run is still large (tens of
  millions of rows) and downloads over a few minutes. Downloads are **bandwidth-
  capped** (`WEBVIEWER_MAX_DOWNLOAD_BPS`, default 10 MB/s) so a big export can't
  saturate the host uplink and starve co-located services — it paces, not caps
  size.
- **Save image** — PNG of the current chart (uPlot canvas).

## Architecture

```
past DB dir ─(lazy, once)─▶ elodin-db export --format parquet --flatten --pattern '*'
                                         │  (named parquet in .cache/<run>/)
browser ──HTTP──▶ FastAPI ──pandas: slice + min/max decimate──▶ JSON / CSV
uPlot canvas ──toBlob()──▶ PNG
```

- `backend/runs.py` — discover timestamped runs (cheap; no per-run `du`).
- `backend/export_cache.py` — lazy parquet export (the `--pattern '*'` is
  required for human names) + a component index (families, units, time bounds,
  DB size), cached per run.
- `backend/series.py` — load parquet (time → epoch seconds), time-slice, min/max
  decimate, wide/long CSV.
- `backend/main.py` — FastAPI routes + serves the built frontend.
- `frontend/` — Vite + React + uPlot.

## Tests

```bash
.venv/bin/python -m pytest backend/test_series.py -q   # backend data logic
(cd frontend && npm test)                              # theme guardrails
```

## Theme

The header is the one the other STAR apps use: wordmark, rule, title (see
`star-openrocket/frontend/src/App.tsx`). `star-wordmark.png` is synced from
`assets/brand` by `scripts/sync-brand.sh`; the copy under `src/assets/` is generated, so
edit the master and re-run the script.

Dark-only otherwise, adopting the conventions the recovery-calculator enforces
(`recovery-calculator/frontend/src/lib/theme.test.ts`): a `--color-*` token
namespace where every text tier clears WCAG **AAA (7:1)** on every background, a
`--text-*` scale that never drops below **13px**, and a chart palette kept as
literal hex in `src/chartTheme.ts` (canvas ignores `var()`, which is why axis
text must not be left to default to black). `frontend/theme.check.mjs` (run via
`npm test`) parses `styles.css` directly and fails on any contrast, type-scale,
palette-mirror, or undeclared-var violation.

## Notes

- Parquet `time` is a µs arrow timestamp → normalized to epoch **seconds**
  (uPlot's native x unit).
- The exporter writes hash-named files **without** a pattern and human-named
  files **with** one — hence `--pattern '*'`.
