# Hero (B4) progress -- owner: hero agent

Owns `src/components/lx/hero/**`. Harness: `e2e-scratch/hero.html` + `hero-harness.tsx`, screenshots by
`e2e-scratch/hero-shots.mjs` into `e2e-scratch/shots/hero-*.png`.

## Plan
1. Pure logic + tests: colormap (viridis window per theme, log pressure scale, flow width), drawing
   parse + layout + orthogonal routing, network view (result.network or series fallback by role),
   contour (diagnostics.hardware.contour or /api/geometry, recession at t), plume geometry.
2. Schematic.tsx (SVG, TimeStore-driven).
3. EngineSection.tsx (to-scale section + plume).
4. Hero.tsx + render test; harness screenshots 1440/1920 dark/light.

## Log
- (start) read GUI-SPEC, DATA-CONTRACT, api/layerx.ts, time store, units, Overview's old hero slot.
  Findings: latest runs carry no `network`/`diagnostics` yet (backend in progress); drawing ids map
  1:1 to feedtwin branch ids (lines = edge id, inline symbols = symbol id, nodes `<id>.in/.out`,
  engine faces `ENG.oxidiser`). /api/geometry is the *session's* design: on this machine it is
  methalox (Dt 34.7 mm, eps 6.1) while the runs' engine has Dt 47.8 mm, eps 4.8, so the fallback contour is used only
  when its throat matches the run's (replay A_throat) -- otherwise "not computed for this run".
- (piece 1, done) pure logic + tests: colormap.ts (viridis window per theme, log pressure scale,
  colourbar ticks by label width, sqrt flow width), drawing.ts (parse, kinds, liquid side, axis,
  dome loaders), layout.ts (fit, ports: tank gas upper half / liquid lower half, level with the far
  end; orthogonal router with overlap/box/axis costs; labels by kind with halo; instrument tags),
  network.ts (result.network by id, else series by role: bottle, regulator, tank sides, dome),
  readout.ts (hover rows). 60 tests, key ones mutation-checked (viridis window, flood flow, tank
  ports, U-turn simplify, parallel-line tolerance).
- (piece 2, done) Schematic.tsx: static symbols (symbols.tsx/shapes.ts) + live layers keyed on the
  cursor index (lines, tank level/ullage tint, bottle fill, valve state, lit chamber, vessel
  figures), hover card (Card.tsx), focus ring for margin-bar jumps, legend (colourbar + flow wedge).
- (piece 3, done) EngineSection.tsx + contour.ts + plumeGeom.ts: own contour frames when the run has
  them, else /api/geometry only when its throat matches the run's; wall from sqrt(At ratio) +
  chamber recession; plume edges/diamonds/fan or lip shocks; plume length fixed per run.
- (piece 4, in progress) Hero.tsx done; harness e2e-scratch/hero.html + hero-shots.mjs; shots
  hero-1440/1920-dark/light*.png, hero-net-* (network fixture + hover). Remaining: unit tests for
  contour/plume/readout, Hero render test, final gate run.
- (piece 4, done) contour/plume/readout tests + Hero story render test (90 hero tests; mutation-
  checked: sqrt growth, throat-match tolerance, bottle gauge). Line hit paths aria-hidden (axe was
  flagging aria-label on role-less paths); focused symbol aria-describedby its card. axe: none.
  Scrub perf (harness, dev build, 80-sample run, index change every frame): mean 8.3 ms, p95 12.4 ms.
  Overview already mounts lx/hero/Hero via glob (pages agent) -> shots hero-overview-{1440,1920}-
  {dark,light}.png in the real ?lx=2 page; no console errors.
- Gates: hero tsc/eslint/vitest clean. Full `tsc`/`eslint src/components/lx` currently fail only in
  pages/Hardware.tsx (unused imports, the other GUI agent's in-progress file).
- Remaining: check the network mapping against the backend's real node ids once runs carry
  `result.network` (tank gas node picked by phase, chamber node by kind 'chamber'); the contour frames
  path is verified on synthetic frames only.
