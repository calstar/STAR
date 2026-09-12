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

## Phase 0 — Quick fixes (small, no contract change)

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

## Phase 1 — Component dialogs slimmed, symbols show their numbers

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

## Phase 2 — The feed-twin half (in this monorepo; can be done by either agent)

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

## Phase 3 — Line config, simplified (no sketch yet)

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

## Phase 4 — The centerline sketch

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
