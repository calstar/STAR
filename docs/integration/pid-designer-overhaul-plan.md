# pid-designer overhaul — plan

September 2026. The dialogs ask for too much, some of it the solver never
reads, some of it the solver reads but a P&ID should only *display*, and the
line/fitting entry is being replaced with a centerline sketch. This is the
plan, in the order it is meant to be built. Each phase is independently
shippable and ends with the gates green.

**One rule under everything:** a field stays in a dialog only if a person on
the stand would know the number. Everything else is derived, looked up, or
left to feed-twin — and a derived number is written with `source: 'default'`
and a reference naming what it was derived from, never typed for the user.

---

## Cross-app contract changes (say these to the feed-twin side first)

These change what the solver reads. pid-designer can land its half alone,
but the behaviour is only right once both halves are in.

| drawing field | today | after |
|---|---|---|
| `TANK.pressure`, `TANK.temperature` | `network.py:445` takes the tank's `pressure` as the solve's initial boundary; `temperature` sets fluid state | **Nominal, not initial.** They are what is drawn on the symbol. The sim's initial state comes from the scenario (vented / primed / held) as it already does for the cockpit. feed-twin keeps reading them only as *nominal* values for limit and sanity checks. |
| `TANK.MAWP` | `session.py:1253` trips the stand above it | Replaced by **`burst_pressure`**. feed-twin trips at `burst_pressure / safety_factor`, with the factor a `Setup` field + `Tunable` (default 2.0, stated). Old drawings carrying `MAWP` are still read as a trip limit until re-saved. |
| `TANK.wall_conductance` (gas-to-wall hA) | Typed by the user or off | **Estimated in feed-twin** from the gas in the ullage, the vessel's size and orientation, and a natural-convection correlation (adapted, not invented — `fluids`), reported as assumed. It is not a material property, so it is not looked up by material: the gas's `k`, `ν`, `Pr` and the wall area decide it. Material enters only through `wall_capacity`. A custom value from the drawing still wins. |
| `TANK.wall_capacity` | Typed | Written by pid-designer from the **material** dropdown, `source: 'default'`, reference naming the material and the property source. Key unchanged. |
| `TANK.wall_mass` | "Wall mass" | Relabelled **Dry mass**; key unchanged. |
| valve / CV / QD / RV `Cd` | feed-twin has `Cd` only for `orifice` / `gas_orifice` | pid-designer writes **`Cd` + `bore`** when the user chose Cd. feed-twin's valve, check-valve and fitting models gain a `cd` model (`ṁ = Cd·A·√(2ρΔp)`, which is the orifice element already in `elements.py:431`). Until that lands, pid-designer also writes an equivalent `Cv` derived from `Cd` and bore, `source: 'default'`, so a drawing solves either way. The conversion lives in one function with a cited derivation and a test against a known orifice. |
| `PR.flow_droop`, `rated_flow`, `lockup_rise`, `min_inlet_differential` | Offered | **Not offered.** feed-twin keeps its catalogue defaults and reports them assumed. Added to the parity test's `NOT_DRAWN` with the reason. (Note: feed-twin's own notes say a regulator with zero droop is transiently indeterminate; its default handles that — the field just is not the user's to type.) |
| `PR.dome_pressure` | Separate field | **Gone from the dialog.** `setpoint` is the one field; when `domeLoaded = yes` it is *labelled* "Dome pressure" and saved as `dome_pressure` (with `setpoint` left unset) so the reader is unchanged. |
| line `lineType` | pipe / flex_hose / bend / fitting | **Gone.** A line is a run; the sketch says what is in it. Old drawings: `flex_hose` keeps its params under an "advanced" disclosure; `bend`/`fitting` lines are read as one-fitting runs. |
| line `elevation_change` | "Rise (outlet − inlet)", signed | Relabelled **Fall (inlet − outlet)** and stored negated into the same key, so the reader is unchanged. Derived from the sketch when there is one. |
| line `roughness` | Typed | Written from the **material** dropdown (6061-T6, 316 SS polished, 316 SS rough), `source: 'default'`, reference to the source. |
| line `K_minor` | Typed | Stays as the no-sketch shortcut. Documented as the fully-turbulent K (`K∞`); feed-twin already treats it as constant. With a sketch, bends are exported as `bend` fittings (`bend_diameters`, `angle`) and priced on feed-twin's Re-dependent ladder — so a sketch gets flow-dependent loss and a lumped K does not. Said in the dialog. |
| `INJECTOR` symbol | Exists | Removed. Existing ones are read as `ENGINE`. |

Nothing above needs a mapping table. Every renamed *label* keeps its key.

---

## Phase 0 — Quick fixes (small, no contract change) — **done, 56f7d870**

1. **Header.** The "P&ID Designer" bar is a title over empty space. The
   title moves into the diagram bar's left end; the bar goes. The canvas
   gains the height.
2. **Regulator text on rotation.** `PR`, `DOME` and the setpoint are
   placed by three different rules and drift apart when turned. All
   lettering moves to the `Frame`'s `extra` (never rotated) and is placed
   off the turned box, like the relief's set pressure. Verified at all
   four rotations.
3. **One-grid-off routing.** A bottom port dropping to something one grid
   step left or right draws a leaning/averaged line that lands on neither
   port. `route.ts` straightens runs within `ALIGNED = 10` by moving *both*
   ends half the error. It now straightens only within 2 px; beyond that
   it draws an honest jog (down, across, down) and the snap-on-drop is what
   lines symbols up.
4. **Remove `INJECTOR`** from the palette and `nodeTypes`; reader alias.

Gates: 282 → same count green; live check of the three visuals.

---

## Phase 1 — Component dialogs slimmed, symbols show their numbers — **done, 8c74212d**

### Tank
- **Fluid** (as now). **Temperature** becomes optional with a dropdown:
  *ambient (293 K)* · *LOX, 90.2 K* · *LN2, 77.4 K* · *LCH4, 111.7 K* ·
  *custom*. Blank is allowed. Values from NIST normal boiling points,
  cited in the reference string.
- **Operating pressure** — nominal; drawn on the symbol.
- **Burst pressure** replaces MAWP. Drawn checks: relief above burst →
  error; operating ≥ burst → error; operating > burst/2 → warning
  ("safety factor below 2"). The old MAWP check is retired.
- **Material** section: dropdown *Aluminium 6061-T6* (default) · *316 SS*
  · *304 SS* · *COPV*. Sets `wall_capacity` automatically. Specific heats
  are entered with a cited source at implementation; the COPV figure is
  the carbon/epoxy overwrap's, is composite-dependent, and will carry
  `verified: false` in its reference until checked against a datasheet —
  the same discipline as the NPT table.
- **Dry mass** (was wall mass). Optional.
- **Insulation**: dropdown *none* (default) · *fiberglass batt (Home
  Depot, ~0.04 W/(m·K))* · *custom*; a thickness field appears only when
  not *none*. Conductivity value cited (manufacturer R-value → k).
- **Gas-to-wall conductance**: removed from the dialog (advanced *custom*
  only). See the contract table for where it comes from.
- Port counts and port names stay.

### Symbols show their numbers
- Tank: pressure and (when set) temperature drawn on the face, under the
  species short name, in the fluid colour, with a layout that measures the
  text and never overlaps the ports or the tag. Same for the engine
  (chamber pressure and temperature) and the bottle (already shows
  pressure). One formatter (`fmt.ts`), one placement rule, checked at all
  rotations.

### K-bottle
- **Supply pressure** and **water volume** only (fluid stays; it is the
  species). Temperature is ambient by default and not shown; count, wall
  fields gone.

### Dewar
- **Fluid** (LN2 / LOX) and **delivery pressure**. **Temperature is
  derived**: saturation temperature at the delivery pressure from a small
  NIST-tabulated `T_sat(p)` for N2 and O2 (interpolated, cited), written
  `source: 'default'`, shown greyed with a *custom* toggle. Everything else
  gone.

### Engine
- **Chamber pressure**, **chamber temperature**, and the Layer-1 config
  reference (`engineConfig`, which is how feed-twin finds the real engine).
  Everything else gone. Both numbers drawn on the symbol.

### Valves (manual, rotary, solenoid)
- **Cd / Cv** toggle, default **Cd**, plus **bore**; `travel_time` for
  actuated valves; fail state. `xT`, `FL`, seat leak gone from the dialog.
  (What they were: `FL` is the liquid pressure-recovery factor — where a
  liquid valve starts to cavitate/choke; `xT` is the gas equivalent. They
  move *where* choking begins, not the choked flow, and for a full-open
  ball valve the IEC defaults feed-twin already uses are within a few
  percent of anything we would type. They stay solver-side, reported as
  assumed.)
- Check valve: **Cd / Cv** (default Cd) + bore. No cracking pressure, no
  reverse leak.
- QD / hydraulic QD: **Cd / Cv** (default Cd) + bore.
- Relief valve: **set pressure**, **reseat**, **Cd / Cv** (default Cd), bore.

### Transducers
- Range only; **PT-LP preset 1000 psi, PT-HP preset 5000 psi** stamped at
  drop with `source: 'default'`. Port bore gone.

### Regulator
- **Setpoint** (labelled *Dome pressure* when dome-loaded), **Cv** (default)
  / Cd, **orifice**, **dome bias** (dome-loaded only), and **supply effect
  as one row**: `[__] psi outlet rise per [__] psi inlet drop`, stored as
  `supply_coefficient` in `psi/psi`-family units feed-twin registers.
  `inlet_reference` asked in the same row ("measured at [__] inlet"),
  because without it the effect has no datum. Droop, rated flow, lockup,
  dropout gone.

### Tests and migration
- `test_spec_parity.py`: `NOT_DRAWN` gains the retired regulator/valve
  fields with reasons; the vessel-walls test becomes "TANK writes
  `wall_capacity` from material"; KBOTTLE/DEWAR walls are dropped from it.
- A one-way migration on load: `MAWP` stays in data (feed-twin reads it
  until Phase 2), `supply_effect_*` already gone, `INJECTOR → ENGINE`.
- Every derived value round-trips through `drafts.ts` with its source and
  reference intact (already guarded).

Gates: vitest, tsc, build, pytest; live check of each dialog and each
symbol readout at 0/90/180/270.

---

## Phase 2 — The feed-twin half — **done** (see the commit; benchmark identical with the film off, +0.03 psi on 2.3 with it on)

1. Tank `pressure`/`temperature` read as nominal; initial state from the
   scenario. Benchmark script run before and after (`scripts/physics_benchmark.py`).
2. `burst_pressure / safety_factor` as the trip limit; `safety_factor` a
   `Setup` field with a `Tunable` row; `MAWP` honoured for old drawings.
3. Gas-to-wall hA estimated from gas properties + vessel geometry when the
   drawing is blank; reported as assumed; drawing value wins.
4. `cd` model for valve / check_valve / fitting, reusing the orifice
   element; pid-designer's derived-Cv fallback then stops being written.

Each is opt-in and defaults to today's behaviour, asserted both ways per
`docs/PHYSICS-BENCHMARK.md` 2.5.

---

## Phase 3 — Line config, simplified (no sketch yet) — **done**

The line dialog becomes three things and a door:

- **Quick path** (always): *length*, *bore* (or size from the chart, Phase
  4e), **material** dropdown (sets roughness), **fall (inlet − outlet)** with
  a one-line note that it is the height difference for hydrostatic head,
  **lumped K** (documented as `K∞`), **lumped line mass** (one number for
  the whole run; feeds the wall model with the line's material's specific
  heat). Nothing else.
- **Advanced** (folded): custom roughness, wall thickness, flex-hose bend
  radii for a hose.
- **The door**: *Sketch the run →* opens Phase 4. When a sketch exists, the
  quick-path length, bore, fall and K are shown greyed as *derived from the
  sketch* and cannot be typed.

Removed: `lineType`, the fitting chips, the per-fitting body/K rows, the
joint/engagement panel, the "tube only / end to end" basis, the loss-method
selector. The `terminations.ts` joint model has no home after this and is
deleted with its tests in Phase 5 (it is in git if it is ever wanted).

Gates as before; the segments reader on the feed-twin side keeps working
because the sketch (Phase 4) still exports the shape it reads.

---

## Phase 4 — The centerline sketch — **done** (`pid-designer/frontend/src/components/pid/sketch/`; bends carry r/D and angle through `feedtwin.pid.segments` to the correlation)

A CAD-like sketch of the run's centerline, the way someone would measure
it on the stand. It lives in the line dialog (full width) and exports to
the `segments` shape feed-twin already reads: straights become segments
(length, bore), bends become `bend` fittings (radius → `bend_diameters`,
`angle`), the vertical extent becomes `elevation_change`, and the first
segment's direction is the run's orientation. No new reader.

**4a — Lines.** *Line* tool: first click sets the **origin** (drawn as a
small anchor mark; the run leaves the upstream port here, so the first
direction *is* the orientation — a horizontal first segment means a side
port). Move: a live length readout in the chosen unit (**in / m** toggle,
remembered). Click to end; the next segment starts there. Segments snap to
horizontal/vertical/45° by default (hold a key to free-draw). Escape ends
the chain. Undo per segment.

**4b — Bends.** Every junction of two non-parallel segments shows a dot.
The *Bend* tool on a dot asks for a **radius** (in the chosen unit, with
the tube's centerline bend radius from the chart as the default when a
size is known) and replaces the sharp corner with an arc; the adjacent
straight lengths are shortened by the tangent length and the readouts say
so. Sharp corners left unbent export as `elbow_90` / `elbow_45` by angle.

**4c — Dimensions.** The *Dimension* tool: click a segment to see and edit
its length (a numeric field on the dimension), click a bend to edit its
radius. Dimensions are drawn like a drawing's — extension lines, arrows,
the number — and can be dragged off the line; they re-anchor as the
geometry changes (Onshape-style). Dimensions are always shown; dragging
only moves where they sit.

**4d — Inner wall.** A **basic inner diameter** field (with units) at the
top of the sketch; every segment is drawn with two thinner lines of a
second colour offset ± bore/2 from the centerline (legend: *centerline* /
*inner wall*). The *Split* tool clicks anywhere on the run (a fat hit
area, not a pixel) and starts a new **section** there; a section carries
its own diameter (or radius — toggle, default diameter). Where two
sections' diameters differ, the walls step with a short connecting
segment so the envelope is closed. Each section exports as its own
`segment`; a step exports as the derived contraction/expansion
transition feed-twin already prices.

**4e — The size chart.** A side panel, always available from the sketch
and from the quick path, that reads at a glance: rows are nominal sizes
1/8 · 1/4 · 3/8 · 1/2; columns are *NPT fitting bore*, *JIC/AN (dash) bore*,
*McMaster 316 SS tube (OD × wall → ID, each wall we stock)*, *McMaster
6061 tube*. One click sets a section's diameter and records the reference.
**Every number in it comes from the catalogue page and is cited in the
row**; nothing is typed from memory, and rows not yet checked are marked
so. Designed like a good reference card: the nominal size is the row
header, the ID is the big number, the source the small one, and what
"matches what" (which tube a JIC -6 mates to) is a bracket, not a sentence.

**4f — Export and the physics note.** The sketch writes `segments` on
save (and the derived quick-path numbers). The dialog says, in one line,
what a sketch buys over a lumped K: bends priced on the flow-dependent
ladder, head from the geometry, orientation known.

Each sub-phase is shippable on its own. 4a+4c already give the length and
fall; 4b adds bends; 4d adds bores; 4e is a reference card useful even
without a sketch.

---

## Phase 5 — Cleanup and handoff

Delete what Phases 3–4 superseded (`terminations.ts`, the fitting chips,
`SegmentPanel`'s old rows, `catalog.ts` entries the chart replaces), update
`docs/integration/pid-to-feedtwin-handoff.md` with the contract table above,
and write the feed-twin note for Phase 2 if it was not done here.

---

## Further UX ideas (not in the phases; say yes to any)

- **Tape-measure mode** in the sketch: type lengths as you go instead of
  dragging — click, type `18`, Enter — which is how a run is actually
  measured on the stand.
- **Paste a McMaster URL** on a part field and have the size, ID and
  material filled from the part number pattern, with the URL as reference.
- **Hover a line** on the P&ID to see its run summary (length, bore,
  bends, K, fall) without opening it.
- **Line size labels** on the sheet (`1/2"` at the run's midpoint), like a
  real P&ID's line numbers — toggleable, so a dense sheet stays clean.
- **Photo per line**: attach a phone photo of the real run to the line so
  the sketch and the hardware can be compared at review.

---

## What I will not do without a source

Specific heats (COPV especially), fiberglass conductivity, NIST saturation
tables, every ID in the size chart, the Cd→Cv derivation. Each lands with
a reference string, and anything seeded before it is checked carries
`verified: false` and shows up in the checks panel, the way the NPT
engagements do today.

## Phase 6 — Connections (experimental, branch `pid/connections`)

The connection tool was the part users called unintuitive. The data model was
right — a graph of symbols and lines, a tee as a node because a tee is a mass
balance — and the interaction layer was wrong. What changed, and why:

**The dot moves; the ring connects.** A tee's four ports covered the whole of
the visible dot, so pressing on it drew a line and moving it meant finding an
invisible halo. The ports still anchor lines but take no pointer; the dot
drags, and a dashed ring on hover pulls a new line out. A tee with one line is
an *open end*, drawn hollow.

**A tee rides its pipe** (`pipes.ts`, `junctions.ts`). A *pipe* is the
longest chain of lines through riding tees (in by one run face, out by the
other) between two ends that are not: a symbol's port, an open end, or a tee
reached on a branch face. It is found from `along.in`/`along.out` every time,
never stored. A pipe is routed once and everything follows from that one path:
every tee on it is put on the path, and each of its lines is handed exactly its
slice of it by distance along the path, so the lines together draw the pipe and
nothing else, and adding a tee never changes the pipe's shape. This replaced
each tee routing its own piece between its two neighbours, which let a new tee
move the bend, let two tees on a Z fight over the line they shared (the reseat
never settled), and made a dragged tee shove the next one.

A tee *keeps its place on the drawing* when its pipe changes: it goes to the
point of the new path nearest where it was (ties toward where it was along the
pipe). It no longer keeps a fraction, which slid tees off their straight drops
whenever an end moved. Where a tee may sit is one rule, `legalSpot`: at least a
tee's reach (14 px of arc) from every bend and from a port or open end at the
pipe's end, 20 px from a tee the pipe ends on, and 20 px from its neighbour
tees, which it cannot pass. A spot inside that is moved to the nearest legal
spot, onto the leg a pull heads for when there is one. There are no elbow tees:
a tee is always straight, and branches take the two faces across the run. The
same rule serves the hover dot (`splitSpot`), every split, a slide and the
reseat, and it is a projection. Told the drawing's ports (`Drawn.endOf`), the
dot and the split place the new tee on its whole pipe exactly as the reseat
will, so on a short bent line with no legal spot of its own the dot shows the
next leg the tee really lands on; a pipe with no legal spot anywhere shows no
dot and takes no tee. A pull whose tee would push a neighbour along is refused
(`roomBeside`); Alt-click and the Junction tool still make the room.

The reseat is idempotent -- it returns the very same arrays when run on its
own output -- because it is one pass that never looks back. Each pipe is
seated after every pipe whose tees it ends on, and just before it is seated
it chooses its faces at the junctions it ends on, priced on ends that are
already where they stay; the lines that are no pipe's choose last, round the
faces the pipes took. A tee that would close a ring of pipes (each ending on a
tee of the next, or a pipe looping back into one of its own tees) does not
ride: there is no first pipe to seat, and seating them in turn moved each
other for ever. Choosing all faces at once used to let two pipes ending on one
junction trade faces on every reseat. `along.t` is the tee's fraction of
the whole pipe, `from`/`to` the pipe's end nodes, and `ends` where they were
when the tee was last put down; a pipe re-routed under a tee that stays put
does not rewrite them, so opening a drawing is not an edit.

A pipe is either the router's or a person's. The router's pipe's lines carry
their slices marked `viaRun`, and it keeps the shape it was drawn with while
that shape still fits its two ends: drawn through exactly, first and last
corner on the ends' axes, nothing crossing itself or a symbol (`keptShape`).
The first time an end moves off it, it is routed afresh. The first hand edit
on any line of a pipe freezes the whole pipe (`freezePipe`, `setHandCorners`):
every line keeps its slice as its own corners, and the pipe is routed through
them wherever the ends go; a tee slid past one of those corners hands it to the
line on the other side. A reset of any line gives the whole pipe back to the
router (`thawPipe`). Corners the router left on a line that belongs to no pipe
(a valve's halves, a tee that stopped riding) survive only while they fit
without doubling back, so a valve dropped on a bent line keeps the bend until
an end moves off it. Ports anchor where React Flow anchors them — the handle's
outer edge, not its centre.

**A line's faces are chosen by the route they make** (`pointLines`). A
branch's face used to be picked by which side of the tee the other end's
centre was on, and for two tees on runs at nearly the same height that put
`t` on one and `b` on the other -- which the router can only join with a
five-segment S over one run and under the other. That was the knot. The
lines on one tee now choose together (the two faces across the run; all four
for an open end; a symbol's port is fixed): at most one line to a face while
there are faces to go round, each priced as length plus 12 a corner, plus
heavily for crossing the tee's own pipe, more for lying on it, a little for
running beside it within a tee's clearance, and heavily for passing through a
symbol, current faces winning an exact tie. Every face is priced by the
route it would draw afresh (the router's route, or through a person's corners),
never by the shape the router last left on the line, which only the face it
already has could have kept. A pipe that ends on a junction chooses its faces
there as one line, in seating order, before the lines on that junction do; a
pipe a person has routed keeps the faces it has, as it keeps its corners.
Routes are priced against only the symbols near them (a spatial index, and
the router's search asked only when the plain route runs into something), so
a reseat grows with the drawing, not with its square: about 4 ms at 300
nodes and 8 ms at 1200, round each page's symbols. A tee end also tells the
router what it is: a six-pixel stub and a fourteen-pixel clearance instead of
a symbol's sixteen and forty-four, so two tees thirty pixels apart get one
crossbar rather than a detour round both. A pull released on a symbol's body
picks the port by the same cost, so a port that faces away is never chosen
just for being nearest.

**Pull a line out of a line** (`BranchDrag.tsx`). Press anywhere on a line and
pull: the dot riding the pointer is where the tee goes -- the spot the split
and the reseat will actually put it (`splitSpot` on its whole pipe, given the
drawing's ports), not the bare point under the pointer. A press that does not
move is a click. Alt-click, or the Junction tool, puts a bare tee in at the
dot; the tool is one-shot. A press within `END_REACH` (10 px) along a line
from its end at a symbol's port is the end's -- exactly as far as React Flow's
anchor there reaches (it carries the end; see below) -- so no branch starts
inside a port's stub.

**Reshaping is done to a picked line.** Segment grips used to show on every
line the pointer crossed, at the middle of every segment -- where people aim
to start a branch -- so the same press-and-pull reshaped a line at its middle
and branched it everywhere else. Grips now show only on a selected line, and a
press anywhere else on a line, selected or not, pulls a branch. Grips no
longer swallow mouse moves (they stopped React Flow's port drag, which listens
on the document, seeing the pointer cross them), and neither grips nor the tee
dot show while a port drag is in progress.

**A press goes to the line nearest the pointer.** Every line is its own
element, stacked in the order lines were made, and React Flow gave each a
20 px hit band over the line's own 12 px one -- wider than the grid -- so
where two lines ran close the newer took presses, hovers and clicks aimed at
the older's own stroke, while a drop at the same spot went to the older. Each
line now has one band (React Flow's, `interactionWidth`), 9 px across on the
screen and never less on the drawing (`hitWidth`), so at full size two lines a
grid step apart never share a pixel of it; and a press, the hover dot, a
click, a double-click or a right-click is given to the drawn line nearest the
pointer by the rule a drop uses (`lineSourceAt`, `lineUnder`), whichever
line's band it landed in -- a click nearer a neighbour is handed to the
neighbour's own element (`handToLine`), so it is the neighbour React Flow
selects and a Delete removes. A click handed on is kept by the line it is sent
to (`handedOn`): it is not judged a second time by a rule that may count lines
the sender left out. The hover dot is one per page, and a line or tee that
leaves the page takes away a dot it drew, put there, or asked for
(`forgetHover`): a removed element gets no mouseleave, so a line deleted from
the keyboard under the pointer used to leave its dot behind, and an undo that
put the line back drew it again where the pointer no longer was.

**Previews are the drop** (`preview.ts`, `ConnectionLine.tsx`). A port drag
showed React Flow's default curve and a pull an L from the press to the
pointer (out of a tee, along the tee's own run), and letting go committed
something else: an orthogonal route with stubs and detours, a hook into a
valve's side port, a tee into a line nobody saw coming, or nothing. Both
previews now resolve the drop as letting go will -- `resolveDrop`, with the
drop handlers' own lookups lent to them (`dropScene`, `underPointer`, and the
line whose end is being carried) -- make it on a copy nobody keeps
(`commitDrop`, minting no ids: `withoutSpendingIds`), let the reseat settle
that copy, and draw the new line as the canvas will draw it, with a dot on each
tee put in, a hollow one on an open end, and a ring on the port or tee it
joins. So the preview is the line as it stands after the release, faces the
reseat re-chooses included: an open end is committed facing back at where the
line came from and then turned to the face that draws best, and a preview of
the commit alone missed that on half of all open-end drops. "As the canvas
will draw it" includes the separation below: the new line's own route is not
where it is drawn when it would lie along a line already there, so the preview
separates the page with the drop made (`tracks.drawnAfter`) -- the lines the
drop did not touch as the page published them (`publishedLines`), the ones it
made or moved an end of routed afresh -- and draws the new line from that.
Drawing its own route alone put the preview a step or three off the committed
line on 31 of 395 drops of a random sweep. What the preview does not show is
a neighbour the new line pushes over a step; the separation works that out
too, so it could be ghosted. A drop that makes nothing -- too short, on its
own pipe, nowhere to go -- is drawn as the bare pull, faded. It is worked out
at most once an animation frame, the drawing is read once per drag, and a
plan the pointer resolved to on the frame before is not made again, so a drag
over empty canvas costs a resolve per frame and a reseat and a separation per
grid step (about 0.5 ms and 4 ms on a 300-node stand, about 1 ms of that the
separation).

**One answer to "what did I let go on"** (`drop.ts`). A port drag, a pull out
of a line, a pull out of a tee's ring and a carried end used to decide what
they had landed on by three sets of rules, none of which asked what the thing
already was. Now `resolveDrop` decides, as a plan, and `commitDrop` makes it;
the handlers only ask the page what is under the pointer. The rules, in order:
(a) a pull let go on its own pipe -- its lines, its tees, the symbols or tees
at its ends -- or on its own symbol, draws nothing; so does one from a symbol
or a tee let go where it would join that symbol or tee to itself through a tee
-- a pipe out of another of the symbol's ports, any pipe through the tee --
and one shorter than 30 screen px (never under 20 on the drawing) unless it is
let go right on a free port, which is aimed at, not missed (a manifold's next
outlet is 26 px on). Nothing that was under the pointer and refused falls
through to an open end; (b) a port right under the pointer is joined as it
is, and a tee's faces are never targets -- they are the tee; (c) otherwise
the nearer of the drawn line (within 14 screen px) and the node under the
pointer wins; (d) a symbol's body means its best *free* port, by the
route a line to it would draw round the symbols, and a riding tee the face
across its run on the side the line comes from -- or, that face taken, a new
tee 20 px along its run toward the other end, so two branches never share a
face; (e) a port that already has a line is teed 30 px out along it (the
port's stub, the tee's anchor and its stub), and a drag out of such a port is
a pull out of that line from the same place, so no port ever carries two
lines; (f) a line is teed where it was hit, or at the foot of the other end
when that is within 20 px on the same straight leg, a tee may sit there, and
the other end can leave straight toward it -- the tee of the line a pull came
out of is put at the foot of where it lands by the same rule, so a pull aimed
straight is straight; (g) empty canvas leaves an open end on the grid, level
with where the line leaves when that is within 20 px, ahead of it, and not on
a line. An open end given a straight continuation rides it (`adoptTee`). A
tee goes into a line only where the line has room for it: between two tees
nearer than twice the 20 px spacing there is none, and `splitSpot` still names
the least bad place, but the reseat would make the room by pushing a
neighbour and its branch along -- so such a drop is refused (`roomBeside`).

**React Flow joins only what is plainly a connection.** `isValidConnection`
lets it join two free ports of two different symbols and nothing else: not a
symbol to itself, not a port that has a line, not a tee's face.
`connectionRadius` is 2, so only a handle actually under the pointer takes a
drop -- the default twenty took the end of the very line being let go on, a
tee's face, or the symbol's own other port -- and click-to-connect is off,
since a stray click armed a connection the next click completed with nothing
on screen to say so. A drop React Flow refuses still reaches `onConnectEnd`,
with `isValid` false and the refused handle in `toHandle`, and goes to the
resolver. A line React Flow does join is named by the designer, `freshEdgeId`'s
way: React Flow's own name is made of the two ports and never checked, and a
carried line keeps its name, so the two ports of a line carried off both of
them could be joined again under the same name.

**Carry a line's end** (`onReconnectStart`, `onReconnect`, `onReconnectEnd`).
A line's end at a symbol's port has React Flow's reconnect anchor; a tee's end
does not (`reconnectableEnds` marks each line in the view, never the drawing:
React Flow hands its own marked objects back to `onDelete` and, for a line
changed through `useReactFlow().setEdges`, to `onEdgesChange`, and both take
them in without the mark; `toStored` drops it too). A viewer gets no anchors
at all -- React Flow draws them for a marked line whatever
`edgesReconnectable` says, so `onReconnect` is withheld. The anchor is the
one press target still given out by stacking rather than by distance -- a
disc centred its radius out along the port's stub, drawn above every older
line -- and React Flow's default radius of 10 reached a whole grid step
across, so off a tank's lid or a manifold, ports a grid step apart, a press or
a click aimed at one line's end carried or picked its neighbour. The canvas
sets `reconnectRadius` to `CARRY_RADIUS` (5), half a grid step, so no anchor
reaches a point nearer another line than its own.
Drag it, and the same line -- its id, params, segments and sketch -- is
re-pointed where it lands, its corners dropped. React Flow runs it as a drag
out of the end that stays, whose port the carried line itself occupies, so the
validator refuses it and the landing is always the resolver's: a free port, a
teed port or line, a body's best free port, a tee's free face. The next port
of the same symbol takes it however near. Let go on nothing, back on its own
port, on its own pipe or where it would join the end that stays to itself,
the line stays as it was. A marker `onReconnectStart` leaves for
`onConnectStart` keeps `onConnectEnd` from teeing, or leaving an open end at,
the end that stays.

**Drop a part into a line** (`insertInline`). Anything in `INLINE` dropped on a
run breaks the run around it, turned to face the way the run goes, upstream
half to `l` and `r` to the downstream half. It goes where it fits: on one
straight leg with a stub of line to spare either side (half its length, the
handle and a 16 px stub), slid along the line from where it was dropped if it
has to be, so its outlet line never doubles back through it to reach a bend.
Each half keeps its slice of the line's corners. Split and insert both mint
line ids no other line has, and re-clip probes on the line to the half they
were on. Deleting it heals the run, exactly as deleting a mid-line tee does.

**Deleting keeps pipes whole** (`rejoinChains`, `dissolveAfterDelete`).
Deleting a riding tee heals its run even when it has branches, which go with
it; a riding tee left with only its two run lines after its branch is deleted
is dissolved and its run healed, unless the two halves disagree about what
kind of pipe it is (a reducer stays); a junction left with no line is removed.
A healed line never takes an id another line has. It keeps every corner its
pieces drew, the router's still the router's, so taking a tee out of a pipe
whose shape is not the router's own gives the pipe back and moves none of its
other tees; probes on the pieces are re-clipped to where they were along it,
the reused id included (`reclipAfterRejoin`, and `dissolveAfterDelete`'s
drawn points).

**Older drawings** (`migrate.ts`). A tee saved by click-to-branch (node type
`JUNCTION`, `data: {}`) is marked a tee again, its lines' missing symbol ports
are filled with the port that reaches it best (placed by each symbol's own
layout: a tank's lid ports, a manifold's outlets), and a tee without `along`
on the one straight run its lines make, within the router's 4 px in-line
tolerance, is given the record a split gives a tee today and put on its pipe.
Tees that recorded their two neighbours, as they did before they rode whole
pipes, have `from`/`to` rewritten to their pipe's ends. All of it runs before
the autosave baseline is taken, so the first reseat after opening has nothing
of it to do; an imported file and a restored version go through it too. The
reseat itself never gives a tee a run: a junction somebody put down off a
line -- an open end carried on to a far port, say -- stays where they put it;
only `migrate` and the gesture that gives an open end its continuation
(`adoptTee`) make a tee ride.

**The ring is a ring.** It was a 24 px square div over the dot, so once
somebody had hovered, pressing the dot itself started a pull. It is an SVG
stroke with `pointer-events: stroke`; the dot underneath still drags. The halo
that makes the dot easier to grab and the ring's pull band both reached past
the next grid line (the halo was also centred two pixels off, placed from the
dot's corner rather than inside its border), and every node is drawn above
every line, so a press on another pipe one grid step away dragged the tee or
pulled a branch out of it across the pipe that was pressed. Both are centred
on the dot, sized in screen pixels with a floor on the drawing and a 14 px cap
(`haloRadius`, `ringBand`: an 8 px halo, a ring from just inside the dot's edge
3 px out), and inside a grid step at full size; and a press on either that is
nearer another line's centreline than the tee's centre goes to that line. The
tee's own lines, which meet at its dot, do not count. So does the rest of
what the pointer does there: the click, double-click or right-click after
such a press is handed to that line, not left to React Flow, which picked the
tee (a Delete then removed it with its branches), painted it, or opened its
colour menu; and the hover dot goes on that line where the press would put a
tee, and nowhere where the press is the tee's.

**When the reseat runs** (`reseat.ts`). After any change to the drawing, and
after any change to the ports as React Flow measured them: a quarter turn of a
square symbol changes its data and not its size, and React Flow re-measures its
handles a frame later without a change to the drawing, so the reseat used to
seat its tees on the ports it had before the turn until some unrelated click.
It is handed a fingerprint of every node's handle bounds (`handleSignature`)
and runs when that changes. Its runaway guard counts only runs on the arrays
the reseat itself last handed back; it used to count every run in a second,
the user's own drag steps included, so an ordinary drag of a run end switched
tee-following off halfway and the tee jumped on the next click. It runs once
more whenever a drag is let go of. What it changes is a correction: undo
amends the entry it corrected, and a correction of the drawing as last saved
moves the autosave's baseline with it (`carryBaseline`), so opening a drawing
-- seated on this screen's ports, routed round this screen's symbols -- never
saves it straight back; the correction goes with the next real edit.

**Lines go round symbols** (`lineRoute.ts`). A line with no corners of its own
that is not a pipe's -- a line between two symbols, a branch off a tee, a line
to an open end -- routes itself round the symbols on its page (`routeAuto`),
which is also how the reseat prices its faces, so a face chosen to go round a
symbol is drawn going round it. A pipe is routed round them once, as a whole,
and its lines draw their slices and nothing of their own. Each page is its own
sheet: the pages share one plane, and a symbol on another page is in nobody's
way. A line asks only which symbols are in the way of its plain route -- none,
nearly always -- so moving a symbol redraws the lines it comes into or goes out
of the way of, not every line on the sheet.

**Lines that would lie on each other are drawn a grid step apart**
(`tracks.ts`). Each line routes itself from its own two ends, so two lines
between the same two columns put their crossbars at the same midpoint, and two
lines out of one side of a tank or a manifold turn at the same stub's length:
drawn on top of each other for 20 px or for 140, with no hop and no dot, they
read as a bus joining all four symbols, or as a plain four-way cross pairing
the wrong two. So once every line on the page has routed itself, one pass
moves the middles of the ones that coincide -- lie along each other within
half a grid step, or turn on each other. Only a line that routes itself moves
(no corners of its own and not a pipe's); a person's corners and a pipe's
slices are drawn where they are, and the lines that can move, move off them.
Only its middle moves: each segment between two others slides across itself by
whole grid steps (up to three), and only while the legs either side keep their
direction and length -- a leg out of a port never shorter than its stub, one
between two corners never shorter than a grid step -- so a moved line still
leaves and arrives the way its ports face. The lines that cannot move are
placed first, with the stubs of all the rest; then the rest by id, each
yielding to the lines placed before it, at the cheapest placement of its middle
(lying on a line or turning on it costs most, a symbol more, a crossing a
little), found segment by segment. A tee's dot, or an open end's, counts as
a joint: a pipe's lines stop at the faces of the tees riding it and a tee is
no obstacle to routing, so a middle moved across a pipe through the gap round
a dot crossed nothing and got no hop -- a line straight through a tee, which
reads as a four-way joint. Passing within 12 px of a dot's centre (the dot as
drawn, and half a grid step: as far as a hop's arc bulges) costs what turning
on a line costs, for every line but the ones that end there, and a line routed
through one is moved off it. On 200 random headers with tees and feeds across
them, moved lines went through a foreign dot 6 times and were moved off one 4
times; now it is none and 9. Parallel feeds stepping down between two
columns come out as a staircase; two lines out of one side of a symbol nest,
whatever their ids, because the one from the port further back passes over the
end of the other's stub, which is turning on it, so it is the one that moves,
and out is the only way its stub lets it go. The pass reads only the routes the
lines published, never what it drew, so a moved line drawn again changes
nothing; it depends on the set of lines alone, so the order they render in
does not matter; and nothing it decides is stored, so neither feed-twin nor a
saved drawing sees it. It remembers each moved line's placement by everything
it depends on, and a whole pass on a 600-line stand costs about a millisecond.
On random bays it takes the length of line lying on line from about 5,500 px to
about 30; what is left is legs out of ports, which never move, crowded
together where no middle within three grid steps clears them.

**Crossings hop** (`hops.ts`, `edgeGeometry.ts`). Every line publishes the
route it routed itself and reads back how it is drawn -- moved or not -- and the
drawn routes of the lines near it; the vertical line at each crossing draws a
semicircle in its own path, so it exports with the line. Nothing infers a join
from an overlap. A line is woken only by what can change its drawing: after a
change, only the lines whose box meets a changed line's box, before or after,
are looked at, and one is told only if what it now has to draw differs from
what it drew -- one that has just drawn its own route beside the same
neighbours is not told to draw it again. Every change used to bump one version
every line subscribed to: dragging a tank on a 147-line stand re-rendered all
147 lines every tick (152 renders), and on a 294-line stand all 294. In the
browser, with the real components, it is now 17 renders a tick over a dozen
lines, whatever the size of the stand, and nothing renders once the drag
stops. Hops, presses and drops (read off the page) and a probe's leader
(`useDrawnRoutes`) all work from the lines as drawn; a leader is redrawn when
its line is moved only because another line moved. A symbol moving is a
change too: a moved segment keeps out of the page's symbols, and an
instrument can be put down on one without any line's own route changing. The
store listens to React Flow's store through the sheet the lines lend it
(`LineInfo.watchSheet`), and runs a pass when the symbols differ from the ones
the last pass kept out of -- by the boxes, since the sheet is filed afresh for
every selection and drag tick. Before, the moved line stayed drawn through the
symbol until some line anywhere on the page happened to publish, and then
jumped.

**Corners go with a group** (`canvasEdits.ts`, `snap.ts`). Hand-placed corners
are absolute; when both ends of a line move together in a box selection, the
corners between them move too, so a routed bay survives being picked up. A tee
picked up with both ends of its pipe moves with them by exactly their delta
rather than sliding, so its lines move as one piece. Letting go lines what was
dragged up with what it is connected to -- the far end of each of its lines, a
tee by its centre rather than a side face, and only two ends facing along the
same axis. A pipe with tees on it is one connection, between its two ends: the
tees ride the pipe wherever it goes, so the tee next to a symbol is a point
that followed the symbol, and lining up with it left a Z in the pipe (or, on a
pipe the router had straightened, moved the symbol halfway). On an axis it has
no connection on, it is lined up with the free ports of the page; never with a
port another line already uses, so a valve in a manifold's fan-out is never
put under the wrong outlet. The shift moves the corners and probes of what
moved with it.

**Any segment moves** (`routeThrough`, `dragSegment`, `jogSegment`). Grips on
every segment of a selected line; a segment touching a port gains a stub and a
corner so the port still leaves the way it faces; Alt-drag puts a detour in;
double-click a grip to route the line automatically again. Corners are stored
on the line as `waypoints`; `offset` is read for old drawings and no longer
written.

What is deliberately not done: a tee still needs a run of exactly two run
lines to ride (a cross with four legs keeps its position); a tee is never an
elbow; the old `SegmentPanel` fittings path is untouched; an open end is a tee
with one line and feed-twin reads it as the dead end it already handled.
