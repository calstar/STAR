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
- **Names** — Elodin stores only numeric identities (`PT1.CH5`, `ACT_CMD.B2.CH1`,
  states as a raw `u8`), so the viewer reads the run's own config snapshot and shows
  what each channel actually was: "Ox Upstream", "LOX Main", "Fire". The **names**
  checkbox on the tab strip flips the whole view (picker, chart legend, state axis)
  back to the raw identities; whichever form is hidden is in the tooltip. See
  [Run names](#run-names) below.
- **Config tab** — the config snapshot for the selected run, verbatim, with a line
  filter (matches keep their enclosing `[section]`), copy, and download.
- **Plot** — uPlot; continuous series are min/max-decimated (spikes preserved),
  discrete series are step-drawn.
- **Zoom** — drag a range (the band is highlighted as you drag, labelled with how long
  it is), or scroll the wheel to zoom about the cursor. Either way the new window is
  refetched at higher resolution. **Reset view**, or a double-click on the plot, goes
  back to the whole run. Zooming out stops at the run's own bounds.
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
- `backend/run_config.py` — the run's `<run_id>.toml` snapshot into entity roles + state
  names; served through `GET /api/runs/<id>/config` (verbatim) and layered onto the
  component index.
- `backend/export_cache.py` — lazy parquet export (the `--pattern '*'` is
  required for human names) + a component index (families, units, time bounds,
  DB size), cached per run.
- `backend/series.py` — load parquet (time → epoch seconds), time-slice, min/max
  decimate, wide/long CSV.
- `backend/main.py` — FastAPI routes + serves the built frontend.
- `frontend/` — Vite + React + uPlot.

## Tests

```bash
.venv/bin/python -m pytest backend/ -q                 # data logic, run discovery, naming
(cd frontend && npm test)                              # theme guardrails
```

## Run names

`elodin-db` records identities, not meanings: a run DB holds `PT1.CH5`, `ACT2.CH3`,
`ACT_CMD.B2.CH3`, `BOARD.HB_52`, and every state as a bare `u8`. The names live in
`config.toml`, which the DAQ backend copies to `<dbDir>.toml` beside the run dir when a
session starts (`diablo_server/backend/src/service-controller.ts`, `snapshotRunConfig`;
a sim run snapshots `sim_config.toml`). `backend/run_config.py` reads that back:

| Config | Names |
|---|---|
| `[sensor_roles_<board key>]` | `PT1.CH5` and `PT1_Cal.CH5` become "Ox Upstream" |
| `[actuator_roles]` | `ACT2.CH1`, `ACT2_Cal.CH1`, `ACT_CMD.B2.CH1` become "LOX Main" |
| `[boards.*]` | `BOARD.HB_22`, `SELF_TEST.BOARD_22` become "PT Board #2" |
| `[[states]]` | `current_state` / `from_state` / `to_state` `16` becomes "Fire" |

The Elodin slot in an entity name is `board_id % 10` (0 meaning 10), matching
`LoadActiveBoards.hpp` and `backend/src/sensor-config.ts`; entity spellings come from
`DatabaseConfig.cpp`; board display names match the config editor's `boardDisplayName`.
`BOARD.HB_*.engine_state` is deliberately *not* named: it carries the coarse
`daq::EngineState`, a different enum.

Runs recorded before the snapshot existed have no `.toml`: their channels keep the raw
identities and the run header says "no config snapshot". State ids are a stable key by
contract, so they are still named, from a built-in table (`run_config.BUILTIN_STATES`)
that `[[states]]` overrides entry by entry, the same override rule the C++ uses.

Names are applied when the index is *served*, not baked into the parquet cache, so a
snapshot copied in later (or corrected) takes effect on the next open without
re-exporting the run.

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
