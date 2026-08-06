# Recovery Calculator — frontend

React 19 + TypeScript + Vite + Recharts + Tailwind, per PLAN.md §11.1.

```bash
npm install
npm run dev        # http://localhost:5273
```

Ports are load-bearing, not cosmetic (§11.1): this app owns **5273** (frontend)
and **8100** (backend). `EngineDesign/dev.sh` force-kills whatever holds 8000,
so sharing a port would let one app silently kill the other. `strictPort` is on
so a clash fails loudly instead of drifting onto 5274.

| script | what it does |
|---|---|
| `npm run dev` | dev server, proxies `/api` → `localhost:8100` |
| `npm run build` | `tsc -b` then `vite build` — the typecheck is the point |
| `npm run lint` | eslint |

## It runs without a backend

Every endpoint falls back to a local fixture, and **says so on screen**. That
is the expected state while the physics is written in parallel, not an error
state — but it must never be silent.

| endpoint | fallback | how you can tell |
|---|---|---|
| `POST /api/simulate` | §11.11 canned `Result` | amber **"These numbers are not computed"** banner |
| `GET /api/devices` | 4-row placeholder list | `placeholder list` badge in the picker |
| `GET /api/climatology` | compiled-in bundle | `bundled data` badge, vs `live from backend` |
| `GET /api/health` | — | header reads `No backend — fixture mode` |

Two details worth knowing before you change `api/client.ts`:

**Vite's dev proxy does not fail fast.** With nothing on :8100 it accepts the
connection and hangs forever rather than returning a 502, so `fetch` never
rejects. Every request therefore carries an explicit deadline, and the client
caches "backend is down" so live-editing doesn't wait out that deadline on
every keystroke. It re-probes every 10 s, so starting the backend mid-session
picks up on its own.

**A 4xx is not a reason to fall back.** `schema.py` sets `extra="forbid"` and
validates triggers against the start altitude, so a 422 is the backend telling
you something true about your config. Showing fake output instead would hide
the one thing worth seeing. Only *unreachable* (timeout, network error, 404)
falls back. A 5xx is ambiguous — Vite's proxy also returns 500 for a dead
upstream — so that one re-probes `/health` before deciding.

**A 422 `detail` is an ARRAY, not a string.** FastAPI returns
`[{type, loc, msg, input}, …]`. Handing that to React as a child throws
"Objects are not valid as a React child" and blanks the entire page, so
`describeDetail` flattens it to `vehicle.m: greater than 0`. This actually
happened: the backend made pad elevation a site constant, the frontend kept
posting `z_site`, `extra="forbid"` returned a 422, and the app went white.

## Layout

```
src/
  types/schema.ts        mirror of physics/schema.py — see below
  types/climatology.ts   shape of the climatology bundle
  api/client.ts          endpoints + fallbacks
  api/fixture.ts         the canned Result. NOT PHYSICS — read its header
  fixtures/climatology.json   generated; do not hand-edit
  lib/serialise.ts       the ONLY UiConfig → Config conversion
  lib/units.ts           display helpers, SI stays on the wire
  components/
    ui.tsx               shared primitives
    recovery/            the Recovery tab
    atmosphere/          the Atmospheric Data tab
```

### `Ui*` types vs wire types

Every Pydantic model sets `extra="forbid"`, so posting a UI bookkeeping field
is a 422 rather than a silently ignored key. The editor needs state the physics
must never see — a stable React key, which fields came from the catalog — so
those live on `UiDevice`/`UiSite`/`UiHardware`, and `toWireConfig` in
`lib/serialise.ts` is the only place allowed to cross the line. It names every
field explicitly instead of spreading, so a new UI field stays UI-side by
default. That is the safe direction to fail.

The `Config` half of `types/schema.ts` is settled against `physics/schema.py`.
**The `Result` half is the frontend's proposal** and is marked as such in the
file — reconcile it when the backend's response models are final.

### The climatology bundle is typechecked

`api/client.ts` assigns `climatology.json` to the `Climatology` interface with
a plain annotation, deliberately **not** an `as` cast. With `resolveJsonModule`
on, that makes `npm run build` validate the actual committed data file against
the declared types. Rename a column in `export_json.py` and CI fails, instead
of a chart silently going blank in someone's browser. Keep it an annotation.

Regenerate the bundle with:

```bash
cd ../site-climatology && python3 export_json.py
```

## Atmospheric Data tab

Read-only reference climatology — it is not an input form. The pad state on the
Recovery tab is a separate per-run decision (§5); this is the measured record
you sanity-check that decision against.

- **Pad pressure by month**, one line per METAR station. Every line is the same
  quantity — station pressure at the pad — reached from a different vantage
  point via eq (7b). The spread between them is the method's error bar,
  measured rather than assumed.
- **Troposphere temperature by month**, one line per sounding dataset, either
  at a chosen height or as the lapse rate over the whole band. The lapse view
  overlays what eq (7) would have inferred from the same ascents' surface
  temperature; that gap is the modelling error the dataset exists to quantify.
- **T against altitude** for a chosen station and either a monthly climatology
  or an individual dated ascent. The individual ascents are the point: a
  January mean profile is smooth, while the ascents behind it routinely carry a
  surface inversion that the mean erases.

Every chart has an **ISA baseline** toggle. ISA has no seasonality, so it draws
flat against a real annual swing — which is the comparison. The ISA values come
from `physics.atmosphere` via the export, not from a TypeScript
reimplementation, so the baseline is the same standard atmosphere the solver
integrates.

Heights are **geopotential (H)** throughout, matching the recovery model.

## Recharts traps found the hard way

Both of these fail *silently* — no warning, no error, just a missing element:

1. **Never wrap chart children in a fragment.** Recharts scans its own
   `children` for known component types and does not flatten fragments, so
   `<>{<Area/>}<{/Area}></>` renders nothing at all. Use sibling expressions.
2. **Never build a range band from two stacked `<Area>`s.** Stacking baselines
   the domain at zero, which flattens a 1 kPa annual swing into a flat line on
   a 0–100 kPa axis. Use one Area whose dataKey holds a `[lo, hi]` tuple.
3. **In `layout="vertical"`, do not put a `dataKey` on the `XAxis`.** It is the
   value axis, and pinning it to one series sizes the domain from that series
   alone and clips everything else off the plot.
4. **A bottom `<Legend>` overprints an x-axis `label`.** Charts with both put
   the legend on top.

## Figures

Recharts is for interaction only. Export artifacts are rendered server-side
with matplotlib (§11.4) — the CLI needs headless figures regardless, so that
code is written once and both paths use it. There is no matplotlib, and no
image export, in this tree.
