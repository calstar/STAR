# Shared layers (charts / ui / units / glossary / time) -- progress

Owner: the shared-layers GUI agent. Files: lx/charts/**, lx/ui/**, lx/time/**, lx/theme.css,
lx/units.ts, lx/glossary.ts. Screenshots: e2e-scratch/shots/shared/{before,after*}/ (script:
e2e-scratch/shared-shots.mjs; env OUT, PAGES, THEMES, SIZES, UNITS).

## 1. Chart axes and labels -- done (2026-10-03)
- y unit no longer overlaps the top tick: it heads the y tick column on the readout row (the
  readout now starts at the plot's left edge); the y axis is widened to fit the unit. One rule for
  every chart. Readout values drop the repeated unit (a hidden "(psia)" keeps it for screen readers).
- x ticks: `charts/axis.ts` timeTicks -- the step comes from the span (1/2/5 x 10^n, at most 7
  ticks), not the width, so every chart over one burn ticks the same seconds with the same decimals.
  The timeline uses the same rule.
- y ticks: at least 28 px apart (small multiples were at 18 px).
- Limit labels moved to the right gutter, placed with the series labels by placeLabels (no
  overlap); gutter labels capped at 28 % of the width with an ellipsis.
- Worst-point note: `placeNote` picks the spot that crosses no limit line / text and the fewest
  data lines, inside the plot.
- New ChartData: `bands[]`, `spans[]` (x shading), `xTime: false` (own cursor, x readout),
  `xLog` (log x, 1-2-5 decade ticks). New Chart prop `quantity` (values in model units; the chart
  converts to the page's unit system -- see `charts/quantity.ts`).
- Fonts: text re-measured when the bundled fonts load (`onFontsChange`, `useTextMeasure`).
- Timeline firing span: opaque `--lx-firing` / `--lx-firing-edge` tokens (light theme had the rail
  showing through a pale pink wash).
- Tests: charts/axis.test.ts, labels.test.ts (placeNote), quantity.test.tsx (bar render).

## 2. x-y charts, log-x, heat layers, Heatmap -- done
- `charts/XYChart.tsx` (+ `xy.ts` engine, `xyScale.ts`, `xyTypes.ts`): Nyquist (equalAspect, marks
  like the -1 point, meta read-out per point), operating map (heat layer + contours with values on
  pills, regions, x/y limit lines, timed path whose dot follows the page cursor; hovering the path
  scrubs the page), same readout/gutter/unit rules as the time charts.
- `charts/Heatmap.tsx`: x-t heatmap (time across, so the page cursor is the same vertical line;
  hover scrubs + reads the cell; at rest the readout is the peak along the cursor's column),
  colourbar with its unit heading it, viridis (17 stops shared with hero/colormap.ts) or magma.
- `charts/colormap.ts`, `charts/contour.ts` (marching squares, saddle by mean).
- Time `Chart` log-x (`xLog`, 1-2-5 per decade ticks, uPlot's own log filter disabled).
- Lab page for visual QA: e2e-scratch/lab/charts-lab.html (script e2e-scratch/shared-lab.mjs).

## 3. MarginBar / MarginList -- done
- `MarginList` (ui): sorts worst first (`sortWorstFirst`, stable), one grid with subgrid rows so the
  value column is as wide as the widest value (never cut, never wrapped) and tracks align.
- Long labels / limit / worst texts truncate with a `title`.
- Two-sided limits (ΔP/Pc 20-40 %): MarginScale.band; the hover/aria says "Safe between 20 and 40"
  instead of "Higher is safer".

## 4. Glossary -- done
- Added: pressureLadder, regulatorCapacity (capacity and use), choked, jouleThomson, hydraulicFlip,
  resultantAngle, nyquist, gainMargin, acousticMode, joukowsky, priming, hardStart, vortex (outlet
  vortex and dip), summerfield, schmucker, soakBack, conservationCheck. Already present and kept:
  saturationMargin, momentumRatio, timeLag (combustion time lag), fuelLead, gasIngestion,
  staticMargin, maxQ, specificForce, lstar, expansionRatio.
- cavitationNumber now defines Nurick's K = (P_in - P_v)/(P_in - P_out), K_crit = (Cd/Cc)^2 -- the K
  and K_incipient the backend reports (DATA-CONTRACT diagnostics.cavitation), not Brennen's sigma.
- Sources are only works I could name with venue and year; priming and soak-back carry none (team
  usage) rather than a guessed citation. New test: every source is dated or a numbered standard.

## 5. Units -- done
- `Chart quantity=` converts series/bands/limits/pins and takes the unit + resolution from the page's
  system (charts/quantity.ts inUnits). Readout decimals are never coarser than the unit's resolution
  (`unitDigits`: bar(a) reads 39.9 on an axis ticked in whole bar).
- Tests: quantity.test.tsx renders a Chart under a bar UnitsProvider (data-y-unit="bar(a)", no psia),
  converts lbf / lb, gauge zero. Real pages checked in bar/lbf/lb (shots/shared/si/).

## 6. Timeline -- done
- Labels thinned by priority (trip > fire > burnout > t0 ...), re-measured when fonts load; a
  400-crowd property test (no touching labels, all inside the track, top priority always shown) --
  mutation-checked. Ticks follow the charts' time rule. Firing span opaque tokens (light readable).

## 7. Worst-note polish
- placeNote sweeps both sides 2 px at a time for a gap between lines after the preferred spots; a
  crossed data line costs 40 (a limit line or text 1000). A hairline leader joins a note set apart
  from its ring (`leaderFor`).

## Remaining / for the pages agent
- pages/Heatmap.tsx and the Engine page's XYPlot duplicate charts/Heatmap + charts/XYChart; switching
  gives the shared look (unit heads, gutters, colourbar head, cursor, readout).
- Overview could use ui/MarginList (subgrid: aligned values that never cut) instead of mapping
  MarginBar; it already sorts worst-first in useRunData.
- Figure subs like "27.0 bar(a) - 27.4 bar(a)" truncate at 8 rem; dropping the first unit fits.
- All three gates pass (tsc, eslint lx, vitest 436 tests).
- xy/contour/colormap tests added (charts/xy.test.ts), mutation-checked. Final gates (01:20): tsc ok, eslint lx ok, vitest: all of mine pass; hero/Hero.test.tsx (another agent, edited at 01:18) has 4 failures in progress.
