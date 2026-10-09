# PROGRESS: Burn pages against DATA-CONTRACT (agent key: pages)

Owner: pages/**, contract.ts, useRunData.ts (+test), LayerX.tsx, TopBar.tsx, Rail.tsx, dev/**

## 2026-10-03 00:30 start
- Previous session left no progress file and no edits; pages are at the pre-task state.
- Baseline gates pass (tsc, eslint lx, vitest 307 tests).
- Latest run 20261002-231658-7e47d1 carries none of limits/network/diagnostics/tripped/test_mode yet;
  flight.stability exists but as scalars (static_margin_liftoff_cal ...), not the contract's series.
- lx/hero does not exist yet.

Plan: contract.ts (+test) -> fixture (dev/) -> Overview -> Feed -> Engine -> Hardware -> Flight -> Stand
-> Uncertainty -> Record. Each step: gates + Playwright screenshots, then a line here.

## 00:40-01:10 contract, Overview, Feed, Engine, Hardware
- contract.ts: types for every DATA-CONTRACT key (all optional) + accessors: diag()/diagFailed()/diagMissing(),
  limitsOf()/serverLimits()/fromServerLimit()/limitKindOf(), networkOf, ledgerOf, trippedOf, testModeOf,
  flightStabilityOf (both shapes), eventKeyOf, resolveRef ("diagnostics.stability.margin" -> column + clock),
  fetchAxial/sidecarUrl/exportUrl. Proposed `diagnostics.opmap` shape (not in the contract yet) is typed there.
- useRunData: data.limits = server limits when result.limits exists (else the ported ones); 'info' limits never
  count in the verdict; timeline keeps backend event keys and does not double burnout / min chug.
- dev/contractFixture.ts: `&lxfixture=contract` (DEV only) dresses a run in made-up blocks; badge "Fixture data".
- Overview: Hero via import.meta.glob('../hero/Hero.tsx') -> picks it up when the hero agent lands it, old
  schematic until then; limits show the closest 8 + "Show all"; ledger from diagnostics.ledger when present.
- Feed: waterfall ladder (pages/ladder.ts, tested), regulator op point, pressurant budget, solenoids, boiling
  & cavitation, water hammer, outflow; absent blocks named in one NotYet strip instead of empty panels.
- Engine: operating map (pages/XYPlot.tsx, TODO(charts) XY), Isp breakdown, momentum ratio, spray lean,
  chug + summary + frequency + Nyquist + tau sweep, acoustics, start & shutdown.
- Hardware: section at cursor/burnout + recession along the wall, small multiples, x-t heatmaps
  (pages/Heatmap.tsx, TODO(charts) heatmap; only fetched when hardware.heatmap names the sidecar), separation, soak.
- Tests: useRunData.test.ts (+contract cases, mutation-checked), pages/ladder.test.ts.
- Shots: e2e-scratch/shots/pages/<page>-1440-dark-{fx,real}.png; script e2e-scratch/lx-pages.mjs.

## 01:10-01:25 Flight, Stand, Uncertainty, Record, exports
- Flight: Max-Q figure (flight.stability.max_q_pa), static margin: chart over flight time when the series lands
  (limit lines from the server's static-margin limit), figures from today's scalars until then.
- Stand: test mode segmented (hot fire / LOX-LN2 / water+N2), other modes disabled "backend pending" until
  result.test_mode exists; Calibrate button disabled (backend pending); MeasuredView kept.
- Uncertainty: "Measure this next" (pages/measure.ts, tested: closest limit the sweep moves, inputs ranked by
  swing), "Cases that break a limit" (sweep.crossings), tornado kept (legacy), scenario presets in NotYet.
- Record: conservation and convergence (diagnostics.vv), exports panel (server csv/parquet/fea via
  pages/exports.ts + .eng + test card; also in the TopBar Export menu, 404 -> notice), models behind each
  diagnostic (every block's `model`), events sorted by time.
- pages/pages.render.test.tsx: every page server-rendered for an old run and a full fixture run, plus
  placeholders / failed-block reasons / trip verdict / test mode / measure-next (mutation-checked).
- dev/testRun.ts: the hand-built run, shared by the tests.

## 01:25-01:45 hero landed; polish
- lx/hero landed (another agent): Overview now imports Hero directly (the glob guard and the old
  FeedSchematic slot are gone); Hardware's section is hero/EngineSection, with "wall moved along the engine"
  (cursor vs burnout, from diagnostics.hardware.contour.frames) beside it.
- Feed ladder has a middle tier: result.network paths when diagnostics.ladder is absent (rungsFromNetwork, tested).
- A trip fails data.verdict (tab glyph) as well as the Overview line (tested).
- Ranges print the unit once (side.ts spanText): "27.0 – 27.4 bar(a)" overflowed a figure in bar units.
- Checked: bar/lbf/lb/in units, compare (vs) mode, 1440/1920 dark/light, fixture and real run:
  geometry checks (overlap/clipped/orphan) 0; console errors only from other services (geometry/preflight 5xx
  while the backend restarts, vite websocket on sleep).

## 01:37 done for this pass
- Gates: tsc (app) OK, eslint src/components/lx OK, vitest 480/480.
- Remaining: see the report (XY chart and heatmap capabilities belong in lx/charts; opmap shape to agree with
  the backend; scenario presets endpoint; test_mode in the rail settings; Isp contours).
