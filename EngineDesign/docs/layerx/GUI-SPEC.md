# Layer X GUI: design spec (2026-10-02)

This is the single design source for the Layer X rebuild. It is written before the pages so that every
piece, built by whoever, reads as one instrument. Code lives in `frontend/src/components/lx/`. The old
`components/layerx/` stays only until the cut-over; its non-UI modules (`format.ts`, `csv.ts`,
`daqcsv.ts`, `testcard.ts`, `plume.ts`, `jobs.ts`, `runs.ts`) are imported, not copied.

## What the user said, which this answers

- "I literally don't even know where to find what I'm looking for… overlapping text, so much text
  everywhere." A first-time user gets a verdict in 5 seconds. An engineer reaches any number in 3 clicks.
- GUI plain, not verbose. Numbers on the page; the explanations go in hover cards and a glossary. Use stand
  words, not model jargon.
- References to learn from, not copy: Linear (calm density, keyboard), Geist (type, spacing, neutrals),
  Stripe (number hierarchy), Rerun/Foxglove (one time cursor driving synced views), Open MCT (limit
  displays), W&B (run comparison), Flighty (status at a glance, event timeline), OWID/Tufte (direct
  labels, no chartjunk), Bret Victor (scrub and see the system respond).

## The idea in one line

**A telemetry console for a burn that has not happened yet.** One time cursor runs the whole page:
scrub the timeline and every number, chart, the schematic and the engine section move together. That
is the memorable thing. Everything else stays quiet.

## Tokens (`lx/theme.css`, scoped under `.lx` with `data-theme="dark" | "light"`)

Dark is the default. It follows the app's theme, and a toggle is kept in localStorage.

| token | dark | light | use |
|---|---|---|---|
| `--lx-bg` | `#0c0e11` | `#f6f7f9` | page |
| `--lx-surface` | `#13161a` | `#ffffff` | panels |
| `--lx-surface-2` | `#1a1e24` | `#f0f2f5` | inset, hover, selected |
| `--lx-line` | `#262b33` | `#e2e5ea` | hairlines, grid |
| `--lx-line-strong` | `#353c47` | `#cdd2da` | inputs, focus-less borders |
| `--lx-text` | `#e7eaee` | `#13161a` | values, titles |
| `--lx-text-2` | `#a7afba` | `#4a5260` | labels |
| `--lx-text-3` | `#808a98` | `#646d7a` | units, captions (AA on bg and surface) |
| `--lx-accent` | `#8f9cff` | `#4452d9` | interactive: focus ring, selected tab, primary button |
| `--lx-cursor` | `#e7eaee` | `#13161a` | the time cursor (drawn at 55 % opacity) |
| `--lx-lox` | `#5fb0f5` | `#1d6fc9` | LOX everywhere |
| `--lx-fuel` | `#e9a55a` | `#a8621a` | ethanol everywhere |
| `--lx-gas` | `#4cc3b5` | `#0d8478` | pressurant (bottle, regulator, press lines) |
| `--lx-hot` | `#ff7b54` | `#cf4a1c` | chamber, thrust, plume, heat |
| `--lx-ok` | `#3fb950` | `#1a7f37` | status only |
| `--lx-warn` | `#e3b341` | `#9a6700` | status only |
| `--lx-bad` | `#f85149` | `#cf222e` | status only |

Rules:
- **Status colours are only for status**: margin bars, verdict badges and limit lines. They are always
  paired with a shape (✓ ! ✗) so colour is never the only signal.
- **Data colours are fixed by meaning**: LOX blue, fuel amber-tan, gas teal, chamber and heat
  red-orange. A chart with one neutral series uses `--lx-text`.
- **Fuel is `--lx-fuel`, never `--lx-warn`.** They differ in hue (tan vs yellow) and in use (a line vs a
  badge).
- The compared ("ghost") run is always drawn in `--lx-text-3` at 1 px with 70 % opacity, on every chart.
  Grey means "the other run".
- Every pair (LOX/fuel blue/orange, status) is checked against deuteranopia and protanopia.
- Contrast is WCAG AA: 4.5:1 for text, 3:1 for chart lines against the surface.

Type, from `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono`, bundled, never fetched:
- UI is Inter 13 px, line 1.45. Labels 12 px `--lx-text-2`, captions 11 px `--lx-text-3`.
- **Every number is JetBrains Mono with tabular figures**, at 12/13 px in tables, 22 px in figures and
  28 px for the verdict figures. A unit sits next to its number, 11 px, `--lx-text-3`, joined by a
  no-break space so it never orphans.
- Sentence case everywhere. No all-caps labels and no eyebrows.

Spacing is a 4 px base. Panels are padded 16 px; gaps between sections are 24 px. Panel and input
radius is 6 px, buttons 6 px and chips 4 px. Hairlines are 1 px, with no shadows except on popovers.

## Units (`lx/units.ts`, React context with a persisted toggle)

There is one global system: `{ pressure: 'psi' | 'bar', force: 'N' | 'lbf', mass: 'kg' | 'lb', length: 'mm' | 'in', temp: 'K' }`.
- A pressure is psia or psig as today; in bar it is bar(a) or bar(g).
- Every displayed quantity goes through `u.p(psia, 'gauge'|'abs')`, `u.f(N)`, `u.m(kg)` and so on. These
  return `{ value, unit, digits }`.
- Digits come from the quantity's resolution, never from the raw float. The model's resolution is
  stated in the glossary entry (pressure 1 psi or 0.1 bar, thrust 1 N, O/F 0.01, Isp 0.1 s).

## Layout

```
┌ Layer X ─────────────────────────────────────────────────────────────────────────────────────────┐
│ [Burn | Injector | Optimize]     run ▾  ☆  vs ▾   ·   units ▾  ◐  ?        Export ▾   [Run ▶] │  top bar, 48 px
├──────┬───────────────────────────────────────────────────────────────────────────────────────────┤
│ rail │ Overview  Feed  Engine  Hardware  Flight  Stand  Uncertainty  Record                      │  page tabs
│ 288  │ "Will it work?"                                                     (page question, 12 px)│
│ px,  │                                                                                           │
│ coll-│   page content: a 12-col grid, panels with 16 px padding                                   │
│ apses│                                                                                           │
│ to   │                                                                                           │
│ 48px ├───────────────────────────────────────────────────────────────────────────────────────────┤
│ icons│ ▶ ½× │T−0  fuel lead  Fire   ign      min chug          LOX dry  burnout│  T+1.85 s        │  timeline, 64 px, sticky
└──────┴───────────────────────────────────────────────────────────────────────────────────────────┘
```

- Layer X is full width (the app's `max-w-7xl` is lifted for this tab only). The content grid caps at
  1600 px. At 1920 the extra width goes to charts.
- **Left rail = setup only**: drawing, before firing, simulate, advanced. It collapses to a 48 px icon
  rail (shortcut `\`); collapsed, its icons show a dot when a value differs from the design.
- **Timeline** is docked at the bottom of every Burn page (B4). Injector and Optimize have none.
- **Compare** works on every page: ghost lines in grey and delta chips (`+0.11 s` / `−2.9 %`) next to
  figures.

## Components (`lx/ui/`)

| component | spec |
|---|---|
| `Figure` | label (12 px text-2), value (mono 22 px) + unit, optional delta chip and sub-line. Never wraps the value; truncates the sub with a title. |
| `MarginBar` | One limit as a horizontal bar (see below). |
| `Panel` | surface, 1 px line, 6 px radius, title (13 px, 500) + optional right slot; no nested panels. |
| `Field` | label left, unit inline in the input's right edge, value in mono. A dot (accent) when it differs from the design default, with ↺ reset on hover. Inline validation message under the field in `--lx-bad`. A `measured ±x` badge when the value is a measured one. |
| `Segmented`, `Toggle`, `Menu`, `Button` | 28 px controls; primary button filled accent, others ghost with line border. |
| `Term` | A glossary term: dotted underline; its hover card gives one-sentence intuition, the equation (mono), the source and the model's resolution. The glossary lives in `lx/glossary.ts`; no explanatory paragraph sits on a page. |
| `DeltaChip` | `+1.2 %` mono 11 px on surface-2. The colour is neutral; it never encodes good or bad because direction is ambiguous. |
| `Badge` | status glyph + word, status colour. |

### MarginBar

```
 ✓ Chug margin            1.33                ├────────────────█────────┼──────┤
                          worst at T+0.04 s   0            1.0 red   1.2 amber      → better
```

- Each limit has its own scale that maps the value onto a 0..1 track. The red line marks the limit,
  the amber zone the warning band, and the marker the value. The direction is stated ("higher is
  safer").
- Clicking sets the global cursor to the limit's worst-case time and flashes a marker at that point on
  every chart and the schematic (`time.focus(t, key)`).
- Keyboard: Tab focuses the bar, Enter jumps.
- The hover card gives the reasoning behind the threshold (today's `verdictItems` hints).

## Time (`lx/time/`)

- `TimeStore` is a tiny external store read with `useSyncExternalStore`. It holds `{ t, playing, speed,
  focus: { t, key } | null }`, the series' `t[]` (to find nearest indices) and the event list.
- Scrubbing calls `set(t)` throttled to rAF. **Only cursor-dependent leaves subscribe**: the charts
  redraw just their cursor layer, and figures read values at `t`. Scrubbing must hold 60 fps on 10 ms data
  (around 400–2000 steps, 30+ series).
- Keyboard:
  - Space plays or pauses.
  - ←/→ step one sample, Shift moves 10.
  - `[` and `]` step to the previous or next event.
  - Home is T−0, End is burnout.
  - `C` toggles compare.
  - `1`–`8` pick a page.
  - `R` runs the burn.
  - `?` shows the shortcut sheet.
- Shortcuts are ignored while typing in an input.

## Charts (`lx/charts/Chart.tsx`, on uPlot)

uPlot, because 10 ms data across many series must scrub at 60 fps; recharts redraws the SVG on every
cursor move.
- **Direct labels**: each series is named at its right end in its own colour. There is no legend box.
  Labels that collide are nudged apart vertically.
- Units sit in the axis title ("psia", "kN"). Ticks fall on round values only (`niceTicks`).
- Limit bands are shaded faintly in status colour (ok band green at 6 %), and the limit line is dashed.
- **The worst point** of a graded quantity is marked with a ring and a 1-line annotation ("min 35.6 %
  at 3.52 s").
- The cursor is a vertical line in `--lx-cursor`, and each series' value at the cursor is a dot. The
  values themselves show in a compact readout row above the plot, not in a floating tooltip.
- The ghost run is drawn in grey and aligned on Fire = 0.
- Event ticks run along the x axis, faint.
- Charts are responsive to their container (ResizeObserver) and theme-aware: colours are read from
  CSS vars at draw time and redrawn on a theme change.
- Height is given by the layout: 220 px standard, 300 px hero, 140 px small multiples.

## Hero (B4): schematic + engine section, on Overview

- **Schematic generated from the drawing's topology**, faithful to the P&ID: technical line art, flat,
  1.5 px strokes, no glows and no gradients.
  - Line stroke colour maps local pressure onto one shared sequential colormap (viridis-like, CVD-safe),
    with a small colourbar.
  - Stroke width maps mass flow (1–5 px).
  - Tank fill shows liquid level; the ullage is tinted by gas temperature.
  - The regulator, valves and solenoids show their state (open/shut, % of capacity).
  - Hovering any node gives P, T, ṁ and its saturation margin.
- **Engine section**: to scale from the real contour (chamber, convergent, throat, divergent, liner
  thickness). The as-built outline is drawn faint; the current wall comes from the recession at the
  cursor. The throat diameter is annotated.
- **Plume**, understated, from Pe/Pa and exit Mach: an expansion fan for under-expanded, a compressed
  boundary for over-expanded, a diamond spacing estimate, and a separation marker when relevant. The
  logic is reused from `layerx/plume.ts`.
- SVG; everything is driven by the TimeStore.

## Pages: each answers one question, shown as its subtitle

Three levels: verdict → story → evidence. Level-3 content never appears on Overview.

1. **Overview** asks "Will it work?"
   - A verdict strip: one status line plus the 4–5 figures that matter (thrust, burn time, impulse,
     apogee or O/F, bottle at burnout).
   - Margin bars for every graded limit, sorted worst-first by normalised margin.
   - The hero (schematic + engine section).
   - Assumption ledger summary: "Design assumed → feed delivers" (tank pressure, feed loss, O/F,
     ΔP/Pc, At, ηc*): design value, then the delivered range over the burn, with a mini sparkline.
2. **Feed** asks "Where does the pressure go?"
   - The pressure ladder at the cursor: a waterfall from bottle to chamber, one bar per element, with
     each element's drop and its % of the total, LOX and fuel side by side.
   - The regulator operating point on its flow curve.
   - Bottle P/T, ullage temperatures, pressurant budget.
   - Saturation and cavitation margin per node.
3. **Engine** asks "What does the chamber see?"
   - Pc, thrust, O/F, Isp breakdown, ΔP/Pc with its band, momentum ratio, ηc*.
   - Chug margin vs t and the chug frequency, with a Nyquist plot at the worst time and the τ
     sensitivity.
   - The operating-trajectory map: the burn as a path over (O/F, Pc) with Isp contours, the design
     point, the ΔP/Pc limit boundaries and the chug-unstable region.
4. **Hardware** asks "What does the burn do to the engine?"
   - The contour overlay (t=0 vs cursor vs burnout).
   - Throat diameter, liner thickness, L* and ε over t.
   - Heat flux and temperature as x–t heatmaps.
   - Separation check, soak-back.
5. **Flight** asks "How does it fly?" (when flown)
   - Trajectory, specific force on the liquids, static margin over t, max-Q, pad vs flight deltas.
6. **Stand** asks "What should the stand read, and did it?"
   - Test mode selector (hot fire / LOX-LN2 cold flow / water + N2), with the test card per mode.
   - Measured vs predicted, Calibrate.
7. **Uncertainty** asks "What don't we know, and does it matter?"
   - Tornado per figure.
   - Limit-breaking cases.
   - "Measure this next".
   - Off-nominal scenario presets, each with its own graded result.
8. **Record** asks "Can I trust this run?"
   - Run record and assumptions, conservation and convergence checks, engine fit, events log, the
     run's name and note, exports.

Data that does not exist yet (the physics workstream adds it) shows a quiet "not computed for this run"
placeholder in its panel, never an error. Every new field is optional in the TypeScript types.

## States

- **Empty / first run**: a 3-step guided start in the main area (① pick the drawing → ② set tank
  pressure and bottle fill → ③ Run). Each step highlights its rail control. The last burn is offered as
  a link.
- **Running**: the stage tracker (Settle → Pass n: Burn / Erosion / Flight → Checks). As each pass
  finishes, its headline figures stream in (partial results). Cancel.
- **Stale**: a banner when the rail differs from the run, with the exact diff listed ("Tank pressure 578 →
  600 psia"), plus "Use this run's settings" / "Run again".
- **Failed**: the error in one line, with details on expand.

## URL state

`?lx=2&run=<id>&page=feed&t=1.85&vs=<id>` is kept in sync with `history.replaceState`. Opening such a URL
restores the run, page, cursor and comparison. The app has no router; only Layer X's own params are read
and written, and other params are left alone.

Since the cut-over (2026-10-03) this GUI is Layer X with or without `lx`: `lx=2` (the old opt-in) still
opens it, and `lx=1` opens the old GUI (`components/layerx/`) for one more release (`url.ts`, marked
`TODO(next release)`).

## Acceptance (B5)

- Playwright screenshots at 1440 and 1920, dark and light, for every page with a real run. Iterate until
  there is no overlapping text, no orphaned units, and no table that should be a chart.
- `docs/layerx/WALKTHROUGH.md`: a first-time user goes load → run → "which limit is closest, and when?"
  without reading docs. It is scripted as a Playwright test that clicks only visible, labelled controls.
- An axe-core (or manual token) check for AA contrast.
