# Elodin Run Viewer

A read-only web viewer for **past** Elodin DB runs. Browse timestamped runs,
pick arbitrary sensors, plot them interactively (zoom/pan), and export CSV or a
plot image — without copying the multi-GB DB off the box or setting up a Python
toolchain per person.

It replaces the old static-PNG `analyze_run.py` pipeline (removed).

## Quick start (local)

```bash
cd daq-server/tools/postprocessing/webviewer
./run.sh                 # backend :8000 (reload) + Vite dev server :5173
# open http://localhost:5173
```

Opening a run is cheap — it shows what the run directory knows (component count, an
approximate duration, size on disk) and nothing more. **Index this run** does the
one-time parquet export into `.cache/` (~20 s per GB); after that the run opens straight
into its plot. The Config tab needs no export.

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
| `WEBVIEWER_VIDEO_DIR` | unset (no video) | the video gateway's recordings folder, read-only; see [Video](#video) |
| `WEBVIEWER_VIDEO_TZ` | `America/Los_Angeles` | the gateway machine's time zone (recording folders are named in local time) |
| `WEBVIEWER_MAX_DOWNLOAD_BPS` | `0` (unlimited); `run.sh --build` sets `10485760` (10 MB/s) | CSV download rate cap in bytes/sec. Dev is unthrottled; the deployment (`--build`) applies the cap |

## What it does

- **Runs** — only timestamped runs (`daq_YYYYMMDD_HHMMSS`) are listed; ad-hoc
  DBs (`daq_live`, calibration, hand-named) are ignored. Past runs are immutable,
  so exporting is safe alongside a live collection writing to a *different* dir.
- **Indexing is explicit** — selecting a run costs a few `stat`s, not an export. See
  [Opening a run](#opening-a-run).
- **Sensors** — grouped by family (PT, PT_Cal, TC, RTD, LC, ACT, CONTROLLER,
  BOARD). Meaningful fields are shown by default; raw/status/plumbing fields are
  behind the "all fields" toggle.
- **Names** — Elodin stores only numeric identities (`PT1.CH5`, `ACT_CMD.B2.CH1`,
  states as a raw `u8`), so the viewer reads the run's own config snapshot and shows
  what each channel actually was: "Ox Upstream", "LOX Main", "Fire". The **names**
  checkbox on the tab strip flips the whole view — picker, chart legend, state axis —
  back to the raw identities; whichever form is hidden is in the tooltip. See
  [Run names](#run-names) below.
- **Config tab** — the config snapshot for the selected run, verbatim, with a line
  filter (matches keep their enclosing `[section]`), copy, and download.
- **Description** — a shared one-liner per run, editable in place under the run title
  and shown in the run list. Anyone can write or rewrite any run's line and everyone
  sees the same text; there is no login here, so there is nobody to attribute it to.
  Stored in `<ELODIN_DB_DIR>/run_descriptions.json` — beside the runs, *not* in the
  parquet cache, which compose calls safe to wipe.
- **Plot** — uPlot; continuous series are min/max-decimated (spikes preserved),
  discrete series are step-drawn.
- **Zoom** — drag a range (the band is highlighted as you drag, labelled with how long
  it is), or scroll the wheel to zoom about the cursor. Either way the new window is
  refetched at higher resolution. **Reset view** — or a double-click on the plot — goes
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
- **Fold the lists** — the ‹ on the run list's header and on the sensor picker folds
  each to a thin rail, giving its width to the plot and video; click the rail to bring
  it back. The rail keeps the count of plotted channels. Remembered per browser.

## Video

The video gateway's **Record** and **Save** clips (`daq-server/video/recordings/`) appear
above the plot, at the time they were taken, for any run they overlap. Outside a clip
there is no video. Click the plot to put the playhead there and the video shows that
moment; a drag still zooms and hovering never seeks. In compose the folder is
`VIDEO_RECORDINGS_HOST_DIR`, mounted read-only; unset, an empty folder (`no-video/`) is
mounted instead and the panel never appears. Desert recordings are copied in afterwards
(`daq-server/video/README.md`).

**Cameras.** The panel lists cameras, not files: a camera's footage in a run is all its
clips together, and where a Save and a Record hold the same moment the Record plays. A run
opens on its first camera; click the others' names to add them. Up to four can be on, in
a grid. A camera that is off has no `<video>` at all, so it costs
nothing.

**Coverage.** A thin band per shown camera runs along the top of the plot, filled where
that camera has footage (Saves and Records merged, outages left empty), so a long run's
few recorded seconds are visible at a glance. Hover a band to see which camera it is, and
click it to put the playhead at the start of that stretch. It is drawn in uPlot's draw
hook: no series, no fetch.

**Playback.** Play/pause (space) runs at 1×, and while it plays one tile leads: the first
camera shown with footage there drives the playhead from the frames it actually shows
(`requestVideoFrameCallback`). On each of its frames, every other playing tile is checked
against that instant. A tile more than a frame out is steered back by its speed (up to
±10 %, not visible) rather than seeked; only one more than a second out is seeked, once,
and then left to settle. Seeking for small drift froze tiles in Safari, which seeks a
playing video slowly. When the leader's footage
ends, the next camera with footage takes over. Where the camera
has no footage, the page clock carries the playhead on at real speed. ← / → (and ◀ ▶) step
one frame, using the clip's own frame period from its mp4 header. Drag the playhead's tab
to scrub. When it runs off the right edge of a zoomed plot, the view pages forward one
window at the same zoom, and play stops at the end of the run.

Matching is by time overlap with the run's extent on either clock (`backend/video.py`), so
a Save made after a run, or a recording copied in later, still finds it. A clip's duration
comes from its mp4 header, read once and cached; a recording still in progress has no
finished mp4 and is not listed. Files are served with HTTP Range, so the browser fetches
only what it shows, and with `Cache-Control: private`, so Cloudflare passes each Range
straight through instead of caching the clip. Cached, a miss made Cloudflare pull the whole
file from byte 0 before answering: a seek to the end of a fresh 190 MB Save waited ~25 s
per camera for its first byte, and the panel looked dead.

**Timing.** The agent writes `<stream>.json` beside each clip it keeps: pieces saying
which second of the file was filmed when, by the gateway's clock. They carry the keyframe
cut (the first frame is up to a keyframe interval before the press) and any outage (the
file plays straight through it; the timeline does not, so the plot shows no video there),
and the gateway's clock offset from the DAQ's. When Record or Save is pressed, the DAQ
backend times three round trips to the agent's clock and keeps the quickest
(`clockOffset`, NTP-style, ±half that round trip). The viewer takes the offset off, so a
clip filmed on the media Mac lands on the sensors' clock, not the Mac's. At the workspace
both are star-rfs and the offset is ~0. The clip's tooltip says what was corrected.
A clip without one (kept before timing files existed) is placed by its folder name: a
Record starts at the name, a Save *ends* at it. That is whole seconds in the gateway's
local time plus the keyframe cut, so such a clip is marked **approx. timing** and sits
within a second or two of the data.

## Which clock the x-axis is

Every row carries two clocks, and the DB indexes on the wrong one.

`elodin-db` stamps each row as the bridge's TCP flush lands. The boards ship several
samples per UDP packet, so a whole packet gets written microseconds apart and then
nothing for ~100 ms: a steady 90 Hz channel draws as bursts separated by gaps. The row's
own `timestamp_ns` field is the real sample time, reconstructed by `BoardClockSync`, and
it is evenly spaced. `elodin-db` never learns this because `DatabaseConfig.cpp` declares
that field as an ordinary data column instead of wrapping it in db.hpp's
`builder::timestamp(...)` op, so the DB falls back to arrival order. (The live GUI is
unaffected — `elodin-protocol.ts` reads field 0 itself.)

So the viewer plots the **sensor clock** by default, taken positionally from the sibling
`<entity>.timestamp_ns` parquet: the flattened export writes one file per field from the
same rows, so row *i* is row *i* in both. On a real run that turns a 65–128 ms jitter on
`PT1_Cal.CH1.pressure_psi` into a clean 101–104 ms.

### Reconciling the two clocks

They are the same wall clock. The sample time is anchored to daq_bridge's `system_clock`
receive; the DB time is elodin-db writing those same rows. The gap between them is write
latency — ~1 ms on raw channels, growing to ~29 ms across a run on calibrated ones, where
the calibration service adds a republish hop. So mixing them on one axis is coherent, and
it is the *DB* clock that drifts, which argues for the sensor clock rather than against
it.

**Not every publisher stamps a wall clock.** daq_bridge and the calibration service use
`system_clock`; the sequencer (`ACT_CMD.*`, `SEQUENCER.state`) and the heartbeat router
(`BOARD.HB_*`) use `steady_clock` — nanoseconds since boot, ~56 years off. But that is
still a good clock, and CLOCK_MONOTONIC is system-wide, so it sits a fixed distance from
CLOCK_REALTIME over a run. Recovering that distance as `median(db_time − stamp)` puts the
channel back on the epoch with its precise relative timing intact. Worth doing rather
than falling back: on `ACT_CMD` the DB write time carries 12 ms of jitter (p99 55 ms),
and "when was the valve commanded, relative to chamber pressure" is exactly the question
these channels exist to answer.

This is not a second scheme bolted on beside the bridge's — it is the *same* one.
`BoardClockSync` takes the board's `millis()` (relative, origin = board boot) and adds an
offset estimated as the sliding-window **minimum** of `arrival − board_time`, because
delay is one-sided: a packet cannot arrive before it was sent. Re-anchoring takes
`steady_clock` (relative, origin = machine boot) and adds the **minimum** of
`db_write − stamp`, for the identical reason: the DB cannot write a row before it was
stamped. Both guarantee the stamp never lands after the event that observed it. (The
bridge needs a *sliding* window because it compares two oscillators — a board crystal
against the server — which drift continuously; MONOTONIC and REALTIME share one
oscillator, so a whole-run floor suffices. Measured drift of that floor: 0.13 ms.)

Every entity is then classified once, on `series.SENSOR_CLOCK_TOLERANCE_S`:

| `time_source` | when | absolute accuracy |
|---|---|---|
| `sensor` | the stamp is already an epoch time | exact |
| `monotonic` | boot-relative, or a board whose clock was never set — shifted by `median(db − stamp)` | a few ms of write-latency bias; **relative timing exact** |
| `db` | no stamp column at all | the write pattern itself |

On a representative run: 650 components `sensor`, 100 `monotonic` (the 25 ACT_CMD /
BOARD.HB / SEQUENCER entities), 0 `db`. The tab strip says how many were re-anchored.

### What each publisher's stamp actually means

Worth knowing before overlaying two families, because "epoch" does not imply "sample
time":

| entity | publisher | stamp is |
|---|---|---|
| `PT*`, `TC*`, `RTD*`, `LC*`, `ACT*`, `ENC*` | daq_bridge | the **sample** time (board crystal + window-min offset) |
| `*_Cal.*` | calibration service | the **same** stamp, carried through from the raw row (`calibration_main.cpp:862`) — identical, not merely close |
| `ACT_CMD.*`, `SEQUENCER.state` | sequencer | when the command/transition **happened** (`steady_clock`, re-anchored) |
| `BOARD.HB_*` | heartbeat router | when the heartbeat was **built** (`steady_clock`, re-anchored) |
| `CONTROLLER.*` | controller service | **when the controller published** — `system_clock::now()` at publish (`ControllerService.cpp:344/397/455`), *not* the sample time of the measurement it acted on |

That last row is the one to be careful with: `CONTROLLER.measurement.p_ch` is stamped when
the control loop emitted the row, so it sits later than the `PT*_Cal` sample it was
computed from by however long the loop took. Comparing the two tells you about controller
latency; it does not tell you the sensor sampled at that moment.

Two further time-like columns ride along as ordinary data and are never used as an axis:
`sample_ts_ms` (the board's raw `millis()`, origin = board boot) and `packet_ts_ms`.

**The run extent is a union across every entity, each on its own clock.** They do not
cover the same interval — heartbeat and command channels start at boot, measured at 3.7 s
before the first sensor packet — so taking only the sensor-clocked entities' extent
clipped the start of every one of those traces off the default window.

The **DB write time** checkbox switches everything back to `elodin-db`'s order — off by
default, kept because it is what every run so far was read on and it is the only way to
see the raw arrival pattern. The run's extent differs between the two clocks, so both are
indexed (`t_min`/`t_max` vs `sensor_t_min`/`sensor_t_max`) and the window follows.

The real fix is upstream — wrap field 0 in `builder::timestamp(...)` in the three
registration paths in `DatabaseConfig.cpp` so the DB indexes on the reconstructed time.
That needs a bench check first (the vendored header does not say whether `OpTimestamp`
wants ns or the µs the index stores) and only helps runs recorded after it lands, which
is why this viewer-side mapping exists: it repairs every run already on disk.

## Opening a run

Plotting needs every component exported to parquet — tens of seconds and a few hundred MB
of cache on a big run. That used to happen on selection, so it was spent on every
mis-click. It is now an explicit **Index this run**, and selecting a run only reads
`backend/summary.py`:

| shown before indexing | where it comes from | exact? |
|---|---|---|
| components in the DB | count of component directories | exact, but *larger* than the indexed count — the export only resolves components it can name, the rest stay bare numeric ids |
| duration | span between the oldest and newest component `data` mtime | **approximate**, shown with a `~`; runs 0.2-0.7 s short on a 20-35 s run because it measures writes, not samples |
| on disk | `du -sk` (the data/index files are sparse 8 GiB each, so apparent size is useless) | exact |

All of it is filesystem metadata, deliberately. elodin-db's on-disk layout is
undocumented and version-specific; an attempt to read component names and row counts out
of it directly produced a plausible-looking row count that was wrong for every component
(2536 where the parquet had 314). Sizes, counts and mtimes cannot fail that way.

`GET /components` therefore refuses an un-indexed run with **409** rather than exporting
behind the caller's back; `POST /index` is the way to build one.

## Run names

`elodin-db` records identities, not meanings: a run DB holds `PT1.CH5`, `ACT2.CH3`,
`ACT_CMD.B2.CH3`, `BOARD.HB_52`, and every state as a bare `u8`. The names live in
`config.toml`, which the DAQ backend copies to `<dbDir>.toml` beside the run dir when a
session starts (`diablo_server/backend/src/service-controller.ts`, `snapshotRunConfig`;
a sim run snapshots `sim_config.toml`). `backend/run_config.py` reads that back:

| Config | Names |
|---|---|
| `[sensor_roles_<board key>]` | `PT1.CH5` and `PT1_Cal.CH5` → "Ox Upstream" |
| `[actuator_roles]` | `ACT2.CH1`, `ACT2_Cal.CH1`, `ACT_CMD.B2.CH1` → "LOX Main" |
| `[boards.*]` | `BOARD.HB_22`, `SELF_TEST.BOARD_22` → "PT Board #2" |
| `[[states]]` | `current_state` / `from_state` / `to_state` `16` → "Fire" |

The Elodin slot in an entity name is `board_id % 10` (0 → 10), matching
`LoadActiveBoards.hpp` and `backend/src/sensor-config.ts`; entity spellings come from
`DatabaseConfig.cpp`; board display names match the config editor's `boardDisplayName`.
`BOARD.HB_*.engine_state` is deliberately *not* named — it carries the coarse
`daq::EngineState`, a different enum.

Runs recorded before the snapshot existed have no `.toml`: their channels keep the raw
identities and the run header says "no config snapshot". State ids are a stable key by
contract, so they are still named, from a built-in table (`run_config.BUILTIN_STATES`)
that `[[states]]` overrides entry by entry — the same override rule the C++ uses.

Names are applied when the index is *served*, not baked into the parquet cache, so a
snapshot copied in later (or corrected) takes effect on the next open without
re-exporting the run.

## Architecture

```
past DB dir ─(lazy, once)─▶ elodin-db export --format parquet --flatten --pattern '*'
                                         │  (named parquet in .cache/<run>/)
browser ──HTTP──▶ FastAPI ──pandas: slice + min/max decimate──▶ JSON / CSV
uPlot canvas ──toBlob()──▶ PNG
```

- `backend/runs.py` — discover timestamped runs (cheap; no per-run `du`).
- `backend/run_config.py` — the run's `<run_id>.toml` snapshot → entity roles + state
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

## Theme

Drawn the way the DAQ console is (`daq-server/diablo_server/frontend/app/globals.css`;
feed-twin's console shares it), so the viewer reads as part of the same stand: true black,
a panel is a region between hairlines rather than a card, nothing is rounded or casts a
shadow, labels and controls are small spaced monospace capitals, related buttons share
one hairline box (the console's segmented control: Play/step, the exports), and colour is
kept for what it means: each channel's trace colour on the plot, amber for "not exact or
not real" (a simulated run, a clip placed approximately). The header is the console's:
"Diablo DAQ" with "a STAR project" under it, a hairline, then this view. Inter is served
from `public/fonts` (the same files the DAQ ships, SIL OFL), so the viewer draws the same
on the stand's offline network.

Controls are a base plus variants: `.btn` a hairline box by default, `.btn.ghost` with no
box until hovered (Clear), `.btn.sm` compact for a row shared with inputs, `.seg` to set
buttons into one box; `.input` for every text field, with the classes beside it setting
only width. Both live in a **Primitives** block at the top of `styles.css`, ahead of every
app section — declared after their consumers, a base rule wins on equal specificity, which
is how the Config filter once rendered full-width and the description box grew a border it
was meant not to have. `.btn` also sets an explicit `line-height`, because a `<button>`
takes the UA's `normal` while an `<a class="btn">` inherits the body's 1.45.

Two guardrails are the viewer's own and win over the console where they differ
(`frontend/theme.check.mjs`, run by `npm test`, after the recovery-calculator's theme
test): every text tier clears WCAG **AAA (7:1)** on every background, so the quietest grey
is `#a3a3a3` where the console uses `#7a7a7a`; and no text is below **13px**, where the
console sets its capitals at 11-12px. The check parses `styles.css` and also holds the
canvas colours in `src/chartTheme.ts` (axis, grid, playhead, coverage band: literal hex,
because a canvas ignores `var()`) to the CSS tokens they mirror.

## Notes

- Parquet `time` is a µs arrow timestamp → normalized to epoch **seconds**
  (uPlot's native x unit).
- The exporter writes hash-named files **without** a pattern and human-named
  files **with** one — hence `--pattern '*'`.
