# feed-twin: stop redrawing the P&ID, start rendering it

**For:** whoever is working on `feed-twin`
**From:** the `pid-designer` side
**Status:** proposal, with a sequence at the end

---

## The finding, in one paragraph

`feed-twin` does not render the drawing. It renders a **projection** of the
drawing that has been through three lossy layers, and then re-invents the
symbols from scratch in 395 lines of ad-hoc SVG. Everything needed to draw the
real thing — rotation, ports, colour, tag placement, the routing the author
chose, pages, section boxes, the distinction between a manual valve and a
solenoid, the distinction between a valve and a *tee* — is already sitting on
feed-twin's own disk, in the imported artifact, byte for byte. It is discarded
on the way to the screen. The fix is not to add symbols to
`Schematic.tsx`; it is to stop having a second drawing layer at all.

This is not a criticism of the judgement that got you here. The comment at the
top of `Schematic.tsx` makes a real argument:

> Deliberately plain SVG rather than the editor's own canvas: React Flow is
> built for dragging things around, and none of that helps here.

That is true of React Flow's *interaction* layer and false of everything else.
The symbols, the port geometry, the fluid palette, the orthogonal router and
the label placement are not authoring machinery — they are the drawing, and
they are the part a live schematic needs to be exactly right about.

---

## Part 1 — Three layers, each one losing something

### Layer 1: `lib/feedtwin/feedtwin/pid/document.py` — the reader

This layer is the best of the three and still drops presentation.

`PidNode` does not carry `rotation`, `color`, `labelOffset`, `width`/`height`
(a section box's size), or a manifold's port `geometry`.

`PidEdge` does not carry `color`, `data.offset` — and, much more seriously,
**does not carry `segments` at all**. See Part 6; that one is a physics bug,
not a cosmetic one.

### Layer 2: `feed-twin/backend/main.py`, `/api/model` (≈ line 560) — the wire

Every node is projected down to:

```python
Symbol(id=…, tag=…, type=…, x=…, y=…, fluid=…, role=…)
Line(id=…, source=…, target=…, kind=…, fluid=…)
```

Everything the reader did keep — `options`, `ports`, `page`, `source_handle`,
`target_handle` — is dropped here, and `TEXT` and `REGION` are filtered out of
the list entirely:

```python
for n in model.diagram.nodes
if n.type not in {"TEXT", "REGION"}
```

So a drawing whose GSE side is boxed and labelled arrives with no boxes and no
labels, and a two-page diagram arrives as one page with both drawn on top of
each other.

### Layer 3: `feed-twin/frontend/src/components/Schematic.tsx` — the renderer

395 lines, roughly ten per symbol. What it can and cannot draw:

| The drawing says | feed-twin draws |
|---|---|
| `MAN` / `ROT` / `SOL` — three different valves, each with its actuator letter | one bowtie for all three |
| A valve's fail state, `NO` or `NC`, **on the symbol** | nothing |
| `CV` — a check valve, with a direction | the same bowtie |
| `RV` — a relief valve | the same bowtie |
| `QD` / hydraulic QD — dashed circle, `HYD` | the same bowtie |
| **`JUNCTION` — a tee** | **the same bowtie.** A branch point renders as a valve |
| `TANK` — ellipsoidal heads, 1–N top ports, 1–N bottom ports, species inside | a 34 × 44 rounded rect |
| `KBOTTLE` — bottle profile, valve stem, pressure beneath | a 34 × 34 rounded rect |
| `DEWAR` — a vacuum jacket, which is what makes it a dewar | the same rect as a K-bottle |
| `MANIFOLD` — length set by port count, ports placed round the perimeter by hand, port kinds (flow / instrument / plug) | a 44 × 18 rect with no ports |
| `ENGINE` — injector manifold, face, chamber, bell, chamber pressure on it | a six-point polygon |
| `PT` / `PG` — a solid circle with the letters in it, one tapping | a dashed circle, unlabelled |
| `RTD` / `TC` / `LC` — probes clipped to a host, with a dashed leader | the same dashed circle, floating |
| `REGION` — a named section box | dropped at layer 2 |
| `TEXT` | dropped at layer 2 |
| Rotation, any symbol, in 90° steps, lettering staying upright | ignored |
| Paint colour, per symbol and per line | ignored |
| Tag position, dragged by the author, swinging with rotation | fixed `dy` per type |
| **Which port a line attaches to** | lines run centre to centre |
| An orthogonal run whose crossbar the author **dragged**, stored on the edge | recomputed from the midpoint, so every run reroutes |
| Pages | both drawn at once |

The port one and the routing one are worth dwelling on, because they are what
makes the difference between "slightly different" and "a different drawing". A
tank with two bottom ports and a manifold with five outlets are the two symbols
a stand drawing is built around. Rendering their lines to the symbol's centre
turns a legible bay into a starburst — and the author's dragged crossbars,
which exist precisely so eight lines leaving one tank do not stack on top of
each other, are thrown away and recomputed into exactly that stack.

---

## Part 2 — The decision, which is already made

Two documents already say what to do.

**ADR-0002** (`docs/adr/0002-the-drawing-is-a-shared-document.md`) decides that
the drawing is a document three apps share — authoring (`pid-designer`),
solving (`feed-twin`), live data (the DAQ GUI) — and that two things get
extracted: the schema as data, and **the canvas, as `lib/feed-canvas`: the
symbols, the renderer and the layout, with no authoring machinery and no
physics in it.**

**feed-twin's own README** already schedules it, in the dependency table:

> `@xyflow/react`, the canvas · Phase 10 · Comes from `lib/feed-canvas`, so the
> DAQ GUI can import it too.

So this is not a new proposal. It is a request to do the extraction now rather
than continue growing a second drawing layer that will have to be deleted.

**The objection this used to have is gone.** The two apps are on the same
stack, exactly:

| | React | Vite | Tailwind | `@xyflow/react` |
|---|---|---|---|---|
| `pid-designer` | 19.2 | 8.0.8 | 4.1.18 | 12.4.4 |
| `feed-twin` | 19.2 | 8.0.8 | 4.1.18 | — |
| `daq-server` | 18.2 | 7.3.6 | 3.4.1 | — |

Adding `@xyflow/react` to feed-twin is one line. The DAQ GUI is the one that
genuinely differs, and that is the case `lib/stardesign-ui` already solves: it
is a **source-only directory** — no `package.json`, no build step — aliased in
each app's `vite.config.ts` and `tsconfig.app.json`, compiled by that app's own
bundler. Three tools on three different Vite majors already share it. Copy that
pattern exactly.

---

## Part 3 — What goes in `lib/feed-canvas`, and what emphatically does not

The line is **viewer, not editor**, and it is easy to draw because
`pid-designer` has already separated them.

### Extract (this is the drawing)

From `pid-designer/frontend/src/components/pid/`:

- The whole `nodes/` directory, sixteen files: the thirteen symbols
  (`TankNode`, `ValveNode`, `SupplyNode`, `ManifoldNode`, `EngineNode`,
  `PRNode`, `QDNode`, `RVNode`, `CheckValveNode`, `SensorNode`, `JunctionNode`,
  `RegionNode`, `TextNode`) plus `Port`, `Upright` and `DraggableLabel` — see
  the note below about the last one.
- `BranchableEdge.tsx` — the orthogonal router, including the stored crossbar
  offset and `nearestOnPath`.
- `ports.ts` — `portsOf`, `portId`, `portKind`. This is the one that makes a
  line arrive at the right port.
- `fluids.ts` — species, `colorForSpecies`, and `propagateFluids`. feed-twin
  currently has a six-entry copy of the palette in `lib/schematic.ts` with a
  comment saying it matches pid-designer's; that comment is the tell.
- `ManifoldEditor.tsx`'s geometry half — `perimeterPoint`,
  `defaultPositions`, `nearestFraction`. The interactive editor stays behind;
  the pure functions that say where a port *is* come along.
- `types.ts` — `PIDNodeData`, `PIDEdgeData`, `COMPONENT_DEFS`.

That is roughly 2,000 lines, all of it already under test, replacing 395 lines
that are wrong about a dozen things.

### Leave in `pid-designer` (this is authoring)

- Everything from `lib/stardesign`: checkouts, sharing, version history,
  releases.
- `ConfigDialog`, `SegmentPanel`, `ManifoldEditor`'s interactive half,
  `ComponentPalette`, `PaintTool`, `ColorMenu`, `PageBar`, `PIDToolbar`.
- `splitEdge.ts`, `attach.ts`, `lineHit.ts` — branching, tapping, clipping.
- `checks.ts` — the checks panel. (Debatable; see below.)
- Undo/redo, clear, import/export.

**Editing fittings, segments, tube sizes, parameters and geometry stays in
`pid-designer`, permanently.** feed-twin does not get an edit surface for any
of it. If a number is wrong, it is wrong in the drawing, and the drawing is
where it gets fixed. This is not a phase-ordering compromise — it is the
one-owner-per-number rule in ADR-0002, and it is what keeps a run reproducible:
an artifact is addressed by the hash of its own bytes, and a twin that could
edit those bytes would be a twin that could invalidate its own provenance.

**`DraggableLabel` needs splitting.** The label's *placement* — the offset, and
the way the default swings round when a symbol is rotated (`rotatedDefault`) —
is drawing. The dragging and the double-click-to-rename are authoring. Extract
a `<Label>` that takes `offset` and `rotation` and renders; leave the draggable
wrapper in `pid-designer`.

### The read-only switch already exists

Every symbol already renders correctly with no interaction, because
`pid-designer` has a read-only mode that a viewer can hold: `ReadOnlyProvider`
from `@stardesign-ui`, and on the canvas `nodesDraggable`, `nodesConnectable`,
`elementsSelectable`, `edgesReconnectable` and `deleteKeyCode` all derive from
it. A viewer is that mode with the toolbar removed. There is a source audit in
`pid-designer/frontend/src/lib/gating.test.ts` that enforces it, and it is
worth reading before you decide what "read-only" means on your side.

---

## Part 4 — The wire: pass the document, do not project it

Delete `Symbol` and `Line` from `feed-twin/backend/models.py` and stop building
them in `/api/model`.

The artifact you imported is the whole drawing. `backend/library.py` writes the
raw bytes to `blobs/` and addresses them by their sha256; `pid-designer`'s
`toStored` strips exactly three fields on save (`selected`, `dragging`,
`measured` — all view state), so **the file on your disk already contains
everything above**. Serve it:

```
GET /api/diagram?diagram=<artifact id>   ->  { nodes: [...], edges: [...] }
```

verbatim, or as close to verbatim as your caching wants. `lib/feed-canvas`
consumes exactly what `pid-designer` saves, which is what makes "the same
drawing" checkable rather than aspirational.

Keep `/api/model` for what it is genuinely for: the assembly **report** — what
was read, what defaulted, what is unchecked, which symbols became nodes and
which became branches. That is feed-twin's own view of the drawing and it does
not belong in the drawing.

---

## Part 5 — The overlay is the part feed-twin owns

Everything above is about not owning the drawing. This is the part that is
yours, and it is the part worth spending design effort on.

The canvas library should expose a small overlay contract and nothing more:

```ts
interface Overlay {
  /** psi at a node, drawn beside the symbol. */
  nodePressure?: Record<string, number>;
  /** kg/s on a line; sign is direction. Drives the flow dash. */
  lineFlow?: Record<string, number>;
  /** Valve state, so a shut valve looks shut. */
  open?: Record<string, boolean>;
  /** Held by hand — the operator's state, not the sequence's. */
  held?: Record<string, boolean>;
  /** A symbol the report has something to say about. */
  flagged?: Record<string, 'warn' | 'error'>;
  onSymbolClick?: (id: string) => void;
}
```

Three things about it:

**Keep the flow dash.** It is the best thing in the current schematic. The
comment defending it is right — direction of flow is genuinely hard to read
from a number — and `isFlowing` / `dashPeriod` in `lib/schematic.ts` should
move into `lib/feed-canvas` as-is and be used by the DAQ GUI too. It should
draw *along the real routed path*, which is one more thing that gets better for
free once the router is shared.

**A value belongs to a symbol, not to a corner of the screen.** The current
schematic already does this and should keep doing it. What it cannot do today
is put the number where the author put the tag — once `labelOffset` and
`rotation` come across, "beside the symbol" means the place the author chose.

**Fail state and live state are different things and must look different.** A
valve drawn `NO` is a fact about the hardware; a valve currently open is a fact
about right now. Today the bowtie's colour carries live state and the fail
state is not drawn at all, so a normally-open valve that is closed looks
identical to a normally-closed valve that is closed. `ValveNode` already draws
the fail state; the overlay should tint or ring for live state and never
overwrite it.

---

## Part 6 — Separate and more urgent: `segments` is not read at all

This is a physics gap and it does not wait for the canvas work.

`pid-designer` writes a full itemised line-loss model on every edge:

```jsonc
"data": {
  "segments": [{
    "id": "s1",
    "method": "itemised",
    "standard": "tube",
    "tubeSize": "1/2 × 0.049",
    "bore":   { "value": 10.211, "unit": "mm", "source": "default",
                "reference": "1/2 × 0.049 tube, OD − 2 × wall" },
    "length": { "value": 1.2, "unit": "m", "source": "estimated" },
    "lengthBasis": "tube",
    "fittings": [{ "id": "r1", "kind": "elbow_90", "count": 3,
                   "boreMm": 10.211, "lengthMm": 24, "engagementMm": 9 }]
  }]
}
```

`feedtwin.pid.document.read_diagram` reads `data.params` and `data.options` off
an edge and stops. **`segments` is never parsed.** So a line somebody itemised
— tube size, ordered segments, a counted fitting tally, a stated loss method —
arrives at the solver as an unstated line, and gets a default with a shrug.

Two things make this worse than it sounds:

1. The five loss methods are ordered by authority — curve, measured K,
   itemised, lumped K, unstated — and documented in
   `docs/integration/line-loss-plan.md`. Reading only `params.K_minor` means
   feed-twin is always taking the *fourth* one.
2. `pid-designer` now dims the line-level `Length` / `Bore` / `K` fields and
   says "superseded by the segments below" whenever a line has segments,
   because those are the two ways to say the same thing and precedence had to
   stop being a guess. Right now, the field that is marked superseded in the UI
   is the only one the solver reads.

What is needed: `PidEdge.segments`, parsed as `LineSegment` records with the
same field names, and the precedence ladder applied. The shapes are in
`pid-designer/frontend/src/components/pid/segments.ts`, which documents each
field and why it exists; the catalogue arithmetic (dash size → OD, tube bore =
`OD − 2 × wall`) is in `catalog.ts`. Neither needs re-deriving.

While you are in there: `data.offset` on an edge (the dragged crossbar) and
`data.color` are also unread, and both are needed by Part 1.

---

## Part 7 — Order of work

Not all of this is the same size, and the order matters.

**0. `segments`, now.** Independent of everything else, and the only item here
that changes an answer rather than a picture. `feedtwin.pid.document` +
whatever consumes it. (Part 6.)

**1. Extract `lib/feed-canvas`, source-only, aliased.** Move the files in Part
3 out of `pid-designer` and point `pid-designer` at the new location first, so
the extraction is proved by the app that already uses them. `pid-designer`'s
own test suite (148 tests) is the regression gate; if it still passes, the move
was clean. Nothing in feed-twin changes yet.

**2. Serve the document.** `GET /api/diagram` returning the stored bytes.
Delete `Symbol`/`Line` from `models.py`. Keep `/api/model` for the report.
(Part 4.)

**3. Render it.** Replace `Schematic.tsx` with a `<FeedCanvas>` from the
library in read-only mode. Delete `lib/schematic.ts`'s palette copy; keep
`isFlowing` and `dashPeriod` by moving them into the library. At this point
feed-twin should draw a drawing that is pixel-comparable to the editor, with
no live data on it yet.

**4. Put the overlay back.** Pressures, flows, valve state, held ring, flow
dash on the routed path. (Part 5.)

**5. The DAQ GUI.** React 18 / Vite 7 / Tailwind 3 — the case the source-only
pattern exists for. Nothing about steps 1–4 should need changing for it, and
if something does, that is the signal that authoring machinery came along by
mistake.

---

## Part 8 — How to know it is done

One test, and it is not a unit test: **open the same diagram in both apps, side
by side, and they are the same drawing.** Same symbols, same rotations, same
colours, same tag positions, same routing, same page. The only differences
should be the ones feed-twin adds — numbers, dashes, valve state — and the ones
it removes: the palette, the toolbar, and every affordance for changing
anything.

A cheaper proxy while you work: a two-page stand drawing with a tank on two
bottom ports, a five-port manifold with one port marked instrument and one
plugged, a rotated regulator, a junction with a relief valve on it, a painted
line, and a section box round the GSE side. Today feed-twin renders that as
one page of rounded rectangles with a valve where the tee is. When it renders
it correctly, the canvas work is done.

---

## Appendix — Things not to take from `pid-designer`

Said explicitly so they do not get swept up:

- **The checks panel.** feed-twin has its own report and it is better placed to
  judge solvability. The drawing's checks are about whether the *drawing* is
  well-formed; keep them separate and do not merge the two lists.
- **`ids.ts`.** Minting new node ids is authoring.
- **Anything that writes.** `commitGraph`, `splitEdgeAt`, `rejoinAfterDelete`,
  `moveToPage`. `applyPage` and `pageOf` are the other way round — deciding
  what is on the page being viewed is drawing, and should come across.
- **`spec.ts`'s dialog metadata.** Which fields a config dialog shows is
  authoring. The *vocabulary* — what types exist, what ports each has — is
  shared, and ADR-0002 wants it as a data file rather than TypeScript. That is
  a separate piece of work and it should not block the canvas.
