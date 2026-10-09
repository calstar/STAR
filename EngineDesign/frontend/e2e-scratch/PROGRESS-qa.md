# Wave-2 visual QA + fix (agent key: qa)

Owner: everything under src/components/lx/ for fixes (builders finished). Final screens go to
docs/layerx/screens/wave2/. Script: e2e-scratch/qa-wave2.mjs.

## 01:40 start
- Gates at start: tsc OK, eslint lx OK, vitest 480/480.
- Plan: 1) full sweep script (burn pages, injector, optimize, empty, running, failed, compare, imperial;
  1440/1920 x dark/light; geometry + axe + console) 2) look at every page, fix 3) scrub perf on Overview
  4) final screens to docs/layerx/screens/wave2/.

## 01:40-02:05 piece 1: sweep script + first fixes (1440 dark)
- e2e-scratch/qa-wave2.mjs: SETS burn,compare,imperial,tools,empty,running,failed; full-height shots into
  shots/wave2/; geometry + console + optional axe. Tools are reached by clicking the tool switch (a `run=`
  URL forces Burn).
- Fixed: charts on a page now share the page's span (charts/engine.ts sharedRange/xRange: a time chart that
  follows the page cursor fits its x axis to T-0..burnout unioned with its data; the cursor line still stands
  where a chart has no sample) -> every chart's 0 tick and cursor line up; Hardware/Engine charts no longer
  lose their 0 tick.
- Fixed: Flight climb charts read "Altitude 0" at rest (own store never moved): the climb cursor follows the
  page cursor (same Fire=0 clock), still scrubbable past burnout by hand.
- Fixed: initial cursor snapped to a sample (ladder said T+1.75 s while the timeline said T+1.73 s).
- Fixed: FigureRow auto-fill -> auto-fit (Hardware's 4 figures sat in the left 40 %).
- Fixed: Hardware section drawn at up to 320 px tall when the wall frames are absent (was 220 px in a
  1100 px panel, half empty); EngineSection maxHeight prop, figures auto-fit, centreline only as long as the drawing.
- Fixed: Record grid (5+6 / lone 6 left ragged right edges): rows of 7+5, LeftOut+CrossCheck stacked beside
  EngineFit when no V&V block; Solver/Burn settings scroll at 300 px with a count.
- Fixed: Stand DAQ channel pickers two different widths (legacy Measured): one width via `.lx-measured`.
