# What feed-twin still needs from pid-designer

Second handoff, September 2026. The first one (`pid-designer-to-feed-twin.md`)
was written before the `pid/twin-integration` work landed; most of what it asked
for is now done. This one is narrower and more specific, and it ends with an
ordered list.

---

## The vision, in one line

**Design it in pid-designer. Bring it to life in feed-twin.**

You draw the system once — symbols, lines, hardware numbers, fittings. feed-twin
opens that same document, builds a solvable network from it, and renders *the
drawing you drew* with live values on it: pressures at every station, flow
animating along the lines in the direction it is actually going, valves you can
click to open and shut, tanks whose level falls as they empty.

Nobody re-types anything. There is no import mapping, no "feed-twin config"
separate from the drawing. The P&ID **is** the model.

That is already true for topology and for component parameters — a drawing
imports today and solves. What is missing is the part that decides half the
answer: **the fittings**.

---

## What already lines up (so you don't undo it)

This took no coordination and it is exactly right:

- `ParamValue` mirrors `feedtwin.model.Param`: value, unit, source, reference.
- Unit spellings match `feedtwin.model.units` — `psi`, `mm`, `in`, `Cv`, `K`, `L`,
  `deg`, `-`, `kg/s`, `s`, `ms`.
- **No `psig`.** Keep defending that.
- Species ids match `feedtwin/props/species.toml`.
- `source` has no default, so nothing arrives pretending to be checked.
- `LINE_SPECS` already declares `pipe` / `flex_hose` / `bend` / `fitting` with
  the *exact* param names feed-twin's `components.toml` uses.
- Fluid propagates from sources, with conflicts reported rather than blended.
- Ports have identity; instruments clip to what they measure.

feed-twin reads all of this with **no translation table**. Please keep it that
way — a mapping layer is a third place for a name to be wrong.

**One thing to add on the physics side:** a dome-loaded regulator needs
`dome_bias` (pressure) and `dome_pressure` (pressure) in the `PR` spec. Our
Aqua Environment 1092-50 delivers **50 psi above whatever its dome is loaded
to**, and feed-twin models that as its own parameter. Without it a dome reg is
wrong by exactly 50 psi, everywhere, silently.

---

## The big one: fittings

### Why it matters

We measured this rather than assumed it:

| Question | Answer |
|---|---|
| Do fittings matter? | **~50% of a line's resistance.** Ignoring them halves the answer. |
| Does the order of same-bore fittings matter? | **No — 0.003%.** Never make anyone place them. |
| Does the order of *bore changes* matter? | **Yes — up to 2.1×.** 1/4→3/8→1/2 is 4.56 bar; 1/2→1/4→3/8 is 9.72 bar. |
| Does miscounting one elbow matter? | ~3% on Δp. |

So the shape that is both correct and not tedious is:

> **Ordered segments. Unordered tally inside each.**

Segments are ordered because their *bores* are — that is the 2.1× effect.
Fittings inside one segment are a bag with counts, because at a single bore their
arrangement carries no information.

Right now a line carries `K_minor`, one lumped number somebody guesses. That is
the single biggest source of error in an imported system.

### The data shape

On an edge, alongside the existing params:

```ts
interface LineSegment {
  id: string;
  /** Ordered upstream → downstream. Index is the order. */
  bore: ParamValue;            // length — the FLOW diameter, not the thread size
  length: ParamValue;          // length — developed, along the centreline
  roughness?: ParamValue;      // length — defaults to drawn stainless, 0.0015 mm
  elevation_change?: ParamValue; // length, signed — up is positive
  /** Unordered. Key is a feed-twin fitting kind; value is how many. */
  fittings: Record<FittingKind, number>;
  /** Fittings whose loss needs more than a count — a reducer, a custom part. */
  detailed?: FittingInstance[];
}

interface FittingInstance {
  kind: FittingKind;
  /** Overrides the segment bore for this fitting only. */
  bore?: ParamValue;
  /** For contraction / expansion: the other side. */
  bore2?: ParamValue;
  /** For a bend fitting: r/D. */
  bend_diameters?: ParamValue;
  angle?: ParamValue;
  /** Catalogue reference, when it came from the parts library. */
  partNumber?: string;
  /** A measured or published K, which beats every correlation. */
  K?: ParamValue;
}
```

`PIDEdgeData.segments?: LineSegment[]`. **Optional.** A line with no segments
behaves exactly as it does today — bore, length, `K_minor`, done.

### The fitting kinds feed-twin already prices

These are registered in `feedtwin/comps/correlations.py` right now. Use these
exact strings:

```
elbow_90   elbow_45   bend   tee_run   tee_branch
contraction   expansion   entrance_sharp   exit
ball_valve_full   gate_valve_full   globe_valve   swing_check
elbow_90_crane   elbow_45_crane
```

If you need one that isn't there — a union, a cross, a bulkhead — tell me the
name you want and I'll register it rather than you inventing a mapping.

### Where the K comes from when nobody published one

Worth knowing while designing the dialog, because it decides what to *ask* for:

| Rung | Needs | Example: 90° elbow, 3/8″, Re 3e5 |
|---|---|---|
| 1 · Fitted from our own flow test | a DAQ run | the real number |
| 2 · Published | a datasheet | as printed |
| 3 · Hooper 2K / Darby 3K | class, bore, Re | 1.71 · 0.83 |
| 4 · Crane `K = n·f_T` | class, bore | 0.94 |
| 5 · Equivalent length `K = f·(L/D)` | L/D, roughness, Re | 0.49 |
| 6 · Geometric (Rennels) | r/D, β, angle | 0.29 |

The spread is **8.9×**, which is far larger than the 3% a miscounted elbow costs.
*Which correlation you pick matters more than how carefully you count.* So the
dialog should ask for **kind + bore** and let feed-twin walk the ladder — do not
ask a user to pick a correlation. If they have a measured K, that's the `K` field
and it wins.

Area changes are the exception: they're genuinely derived. A sudden expansion is
Borda–Carnot, `K = (1 − β²)²`, from momentum conservation alone. That's why the
bore-change ordering is load-bearing and the same-bore ordering isn't.

### Bends are fittings, not a shape

A bend on a real stand is a *bend fitting* with a specific through-bore, and that
bore follows from what kind of fitting it is. So:

1. User picks the fitting standard and size: `JIC 37° · 1/2"`, `NPT · 3/8"`,
   `Swagelok tube · 1/2 × 0.035`, `ORB · #8`.
2. The bore is **derived** from a lookup and pre-filled.
3. The field stays editable, because the real part is always a little different.

The derived value should be stored with `source: 'default'` and a reference
naming where it came from, so it shows up in feed-twin's run report as
"unchecked" until somebody measures the part. If the user overrides it, they pick
the source — `measured` or `manufacturer`.

**This lookup table needs to be built from catalogues, not from memory.** I am
not going to hand you numbers I can't cite. The mechanism is what matters:

```ts
/** standard → size → nominal through-bore. VERIFY EVERY ROW against a
 *  catalogue before shipping; cite the source in the reference string. */
const THROUGH_BORE: Record<Standard, Record<string, { mm: number; source: string }>>;
```

The trap worth writing into the description text: **a 3/8″ NPT fitting does not
have a 3/8″ bore.** Thread size is not flow diameter, and using the thread size
under-predicts loss by several times. That one sentence next to the field will
save somebody a day.

### What it should look like

Double-click a line → a panel, not a modal that covers the drawing.

```
┌ FL-OX  ·  ox tank → main valve ───────────────────── ΣK 11.4 ─┐
│                                                                │
│  ① 1/2 × 0.035 tube          0.40 m          bore 10.9 mm  ⋮   │
│     ┌──────────────────────────────────────────────────────┐   │
│     │ elbow 90°      ×2       union         ×1              │   │
│     │ tee (run)      ×1       + add fitting                 │   │
│     └──────────────────────────────────────────────────────┘   │
│                                                                │
│     ↓  reducer 1/2 → 3/8            derived, K 0.31            │
│                                                                │
│  ② 3/8 × 0.035 tube          1.60 m          bore  7.75 mm ⋮   │
│     ┌──────────────────────────────────────────────────────┐   │
│     │ elbow 90°      ×3       + add fitting                 │   │
│     └──────────────────────────────────────────────────────┘   │
│                                                                │
│  + add segment                                                 │
└────────────────────────────────────────────────────────────────┘
```

Notes on that:

- **Transitions between segments are derived, never typed.** Two adjacent
  segments with different bores *are* a reducer; draw it as a consequence with
  its K shown, not as a row somebody has to remember to add.
- **ΣK in the header**, live. It's the number the user is actually building, and
  seeing it move as they add fittings is the whole feedback loop.
- Adding a fitting is a count, not a placement. `+ add fitting` → a searchable
  list → it lands in the bag with `×1`. Clicking `×2` increments.
- Keep it flat. No accordions, no wizard, no tabs. A segment is a row with a bag
  under it.
- One segment is the default and the common case. The `+ add segment` affordance
  should be quiet — most lines are one bore.

### Everything here is optional

This is the part I most want to be sure of. A drawing must stay useful when none
of it is filled in:

- No segments → the line uses `bore` / `length` / `K_minor` exactly as now.
- Segments but no fittings → just the friction term.
- A fitting with only a kind → feed-twin uses the segment bore and walks the
  K ladder.
- Nothing at all → feed-twin fills in a default, marks it `source: 'default'`,
  and the run report counts it as unchecked.

Somebody sketching a system on a Tuesday should never be blocked by a dialog
asking for a roughness. The rule is: **absent means "not stated", never "zero"**,
and feed-twin says so in its own report.

---

## Smaller things, still needed

**1. A line's config has to be reachable.** `LINE_SPECS` exists; confirm that
double-clicking an edge opens it. If it doesn't yet, that's step one — the
segments UI hangs off the same panel.

**2. The engine symbol should carry a reference to a Layer-1 config.**
One string field on `ENGINE`: `engineConfig`, the path or id of an EngineDesign
YAML. feed-twin already imports those (injector areas per type, discharge model,
throat area, CEA table) — it just has nowhere to be told *which one*. Without it
the engine is a fixed pressure boundary and the whole chamber-pressure coupling
is unreachable from a drawing.

**3. Actuator metadata, so feed-twin can drive it.** For `ROT` / `SOL`:
`travel_time` (time) and `failState` — you have `failState` already. feed-twin
builds a command signal named `<label>.command` from the label, which is why tags
must be unique; your tag-uniqueness check already covers that.

**4. A fetch endpoint feed-twin can call.** Today a stand is a JSON file copied
by hand into `feed-twin/backend/diagrams/` and registered in a dict. Anything
that lets feed-twin list and pull released diagrams — it already goes through
`lib/stardesign`, so a released version is the natural unit — turns that into a
picker.

**5. Don't reuse the fluid role colours for plots.** Fuel `#f97316` against
pressurant `#ef4444` is ΔE 10.4 in *normal* vision, below the 15 threshold at
which people reliably tell two lines apart. Fine on a schematic where position
and labels separate them; not fine on a chart. If pid-designer grows plots, use
a separate validated set.

---

## What stays feed-twin's job

So the boundary is clear, and so you don't build things twice:

- Solving. Pressures, flows, transients.
- The **dome control regulator** as a live control — feed-twin reads
  `domeLoaded: yes`, finds the regulator feeding it, lifts that one *out* of the
  flow path, and turns its setpoint into a knob on the dashboard.
- Clicking valves on the schematic to open and shut them during a run.
- Fluid substitution for cold flows — same drawing, LN2 where the LOX goes and
  water where the ethanol goes. That's a run-time choice, not a redraw.
- Fitting a K from DAQ data and writing it back as `source: 'measured'`.

You own the drawing. We own what it does.

---

## Steps, in order

1. **Confirm a line's config panel opens on double-click.** Everything else
   hangs off it.
2. **Add `dome_bias` and `dome_pressure` to the `PR` spec.** Two fields, and it
   removes a silent 50 psi error today.
3. **Add `engineConfig` to `ENGINE`.** One string. Unblocks the entire engine
   coupling on our side.
4. **Build the through-bore lookup**, from catalogues, with a cited source per
   row. NPT / JIC / ORB / Swagelok tube, in the sizes we actually run.
5. **Segments**: the data shape, then the panel — ordered rows, derived
   transitions, live ΣK.
6. **The fitting bag**: search, add, count. Kinds exactly as listed above.
7. **A fetch endpoint** so feed-twin can list and pull released diagrams.

1–3 are small and unblock work on our side immediately. 4–6 are the real feature.
7 turns a file copy into a workflow.

---

## Where the contract lives

- `lib/feedtwin/feedtwin/model/components.toml` — param names, dimensions,
  options, per fidelity model. The names to match are here.
- `lib/feedtwin/feedtwin/model/units.py` — registered unit spellings.
- `lib/feedtwin/feedtwin/props/species.toml` — species ids.
- `lib/feedtwin/feedtwin/comps/correlations.py` — the registered fitting kinds.
- `lib/feedtwin/feedtwin/pid/` — the reader, and the tests that pin its
  behaviour. If you want to know exactly what we do with a field, read
  `network.py`; it is commented for this purpose.

If a name has to differ, say so in a comment on both sides rather than adding a
mapping table. A mapping table is where these drift.
