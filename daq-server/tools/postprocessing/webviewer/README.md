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
- **Description** — a shared one-liner per run, editable in place under the run title
  and shown in the run list. Anyone can write or rewrite any run's line and everyone
  sees the same text; there is no login here, so there is nobody to attribute it to.
  Stored in `<ELODIN_DB_DIR>/run_descriptions.json`: beside the runs, *not* in the
  parquet cache, which compose explicitly calls safe to wipe.
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

## Which clock the x-axis is

Every row carries two clocks, and the DB indexes on the wrong one.

`elodin-db` stamps each row as the bridge's TCP flush lands. The boards ship several
samples per UDP packet, so a whole packet gets written microseconds apart and then
nothing for ~100 ms: a steady 90 Hz channel draws as bursts separated by gaps. The row's
own `timestamp_ns` field is the real sample time, reconstructed by `BoardClockSync`, and
it is evenly spaced. `elodin-db` never learns this because `DatabaseConfig.cpp` declares
that field as an ordinary data column instead of wrapping it in db.hpp's
`builder::timestamp(...)` op, so the DB falls back to arrival order. (The live GUI is
unaffected: `elodin-protocol.ts` reads field 0 itself.)

So the viewer plots the **sensor clock** by default, taken positionally from the sibling
`<entity>.timestamp_ns` parquet: the flattened export writes one file per field from the
same rows, so row *i* is row *i* in both. On a real run that turns a 65-128 ms jitter on
`PT1_Cal.CH1.pressure_psi` into a clean 101-104 ms.

### Reconciling the two clocks

They are the same wall clock. The sample time is anchored to daq_bridge's `system_clock`
receive; the DB time is elodin-db writing those same rows. The gap between them is write
latency: ~1 ms on raw channels, growing to ~29 ms across a run on calibrated ones, where
the calibration service adds a republish hop. So mixing them on one axis is coherent, and
it is the *DB* clock that drifts, which argues for the sensor clock rather than against
it. Calibrated rows carry the raw sample's stamp verbatim (`calibration_main.cpp:862`
reads it out of the raw payload), so a `_Cal` channel and its raw twin sit at exactly the
same x, where the DB clock separated them by up to 49 ms.

**Not every publisher stamps a wall clock.** daq_bridge and the calibration service use
`system_clock`; the sequencer (`ACT_CMD.*`, `SEQUENCER.state`) and the heartbeat router
(`BOARD.HB_*`) use `steady_clock`: nanoseconds since boot, ~56 years off. But that is
still a good clock, and CLOCK_MONOTONIC is system-wide, so it sits a fixed distance from
CLOCK_REALTIME over a run. Recovering that distance puts the channel back on the epoch
with its precise relative timing intact. Worth doing rather than falling back: on
`ACT_CMD` the DB write time carries 12 ms of jitter (p99 55 ms), and "when was the valve
commanded, relative to chamber pressure" is exactly the question these channels exist to
answer.

This is not a second scheme bolted on beside the bridge's, it is the *same* one.
`BoardClockSync` takes the board's `millis()` (relative, origin = board boot) and adds an
offset estimated as the sliding-window **minimum** of `arrival - board_time`, because
delay is one-sided: a packet cannot arrive before it was sent. Re-anchoring takes
`steady_clock` (relative, origin = machine boot) and adds the **minimum** of
`db_write - stamp`, for the identical reason: the DB cannot write a row before it was
stamped. Both guarantee the stamp never lands after the event that observed it. (The
bridge needs a *sliding* window because it compares two oscillators, a board crystal
against the server, which drift continuously; MONOTONIC and REALTIME share one
oscillator, so a whole-run floor suffices. Measured drift of that floor: 0.13 ms.)

Every entity is then classified once, on `series.SENSOR_CLOCK_TOLERANCE_S`:

| `time_source` | when | absolute accuracy |
|---|---|---|
| `sensor` | the stamp is already an epoch time | exact |
| `monotonic` | boot-relative, or a board whose clock was never set, shifted by `min(db - stamp)` | a few ms of write-latency bias; **relative timing exact** |
| `db` | no stamp column at all | the write pattern itself |

On a representative run: 650 components `sensor`, 100 `monotonic` (the 25 ACT_CMD /
BOARD.HB / SEQUENCER entities), 0 `db`. The tab strip says how many were re-anchored.

**The run extent is a union across every entity, each on its own clock.** They do not
cover the same interval: heartbeat and command channels start at boot, measured 3.7 s
before the first sensor packet, so taking only the sensor-clocked entities' extent
clipped the start of every one of those traces off the default window.

### What each publisher's stamp actually means

Worth knowing before overlaying two families, because "epoch" does not imply "sample
time":

| entity | publisher | stamp is |
|---|---|---|
| `PT*`, `TC*`, `RTD*`, `LC*`, `ACT*`, `ENC*` | daq_bridge | the **sample** time (board crystal + window-min offset) |
| `*_Cal.*` | calibration service | the **same** stamp, carried through from the raw row (`calibration_main.cpp:862`), identical, not merely close |
| `ACT_CMD.*`, `SEQUENCER.state` | sequencer | when the command/transition **happened** (`steady_clock`, re-anchored) |
| `BOARD.HB_*` | heartbeat router | when the heartbeat was **built** (`steady_clock`, re-anchored) |
| `CONTROLLER.*` | controller service | **when the controller published**: `system_clock::now()` at publish (`ControllerService.cpp:344/397/455`), *not* the sample time of the measurement it acted on |

That last row is the one to be careful with: `CONTROLLER.measurement.p_ch` is stamped when
the control loop emitted the row, so it sits later than the `PT*_Cal` sample it was
computed from by however long the loop took. Comparing the two tells you about controller
latency; it does not tell you the sensor sampled at that moment.

Two further time-like columns ride along as ordinary data and are never used as an axis:
`sample_ts_ms` (the board's raw `millis()`, origin = board boot) and `packet_ts_ms`.

The **DB write time** checkbox switches everything back to `elodin-db`'s order: off by
default, kept because it is what every run so far was read on and it is the only way to
see the raw arrival pattern. The run's extent differs between the two clocks, so both are
indexed (`t_min`/`t_max` vs `sensor_t_min`/`sensor_t_max`) and the window follows.

The real fix is upstream: wrap field 0 in `builder::timestamp(...)` in the three
registration paths in `DatabaseConfig.cpp` so the DB indexes on the reconstructed time.
That needs a bench check first (the vendored header does not say whether `OpTimestamp`
wants ns or the µs the index stores) and only helps runs recorded after it lands, which
is why this viewer-side mapping exists: it repairs every run already on disk.

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
