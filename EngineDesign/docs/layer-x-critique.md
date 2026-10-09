# Layer X: the hostile review, 2026-10-02

Four reviewers were asked to find everything wrong, each from one side: a propulsion engineer who
will be blamed if the stand disagrees (**Ph**), a principal software engineer (**C**), a data-viz
and interaction critic (**V**), and a product analyst who has watched teams waste weeks (**P**).
Every finding is here with what was done about it. Status: **fixed**, **partly** (what is left is
said), **open** (needs data or a decision from the team, or is a larger build, and says which).

The one-line verdict, from the product review: *a very accurate simulator whose answers stay in one
engineer's browser and never meet a real firing.* The physics checks against outside references;
the product around it did not.

## Physics and credibility (Ph)

| # | Finding | Status |
|---|---|---|
| Ph1 | The doc's optimiser winner (600 psia / 3150 psig) leaves the bottle 97.6 psi above lockup under today's code: it fails its own 100 psi margin. Doc tables carried numbers from older code. | **fixed (doc)**: the phase sections are marked as dated; today's numbers come from a run. The 600 / 3150 winner is flagged in Phase 4 as failing the margin by 2.4 psi under today's code. |
| Ph2 | The binding limit (bottle spare) moves +189 psi with line walls and vapour on, −18 psi with the bottle wall conductance; none is swept, and the tornado ranks by impulse so the switches look like nothing. | **fixed**: line walls, vapour and the bottle wall's heat transfer are sweep factors; the bottle's spare has its own ranking; each case is graded against the 100 psi margin. |
| Ph3 | Impulse cannot see feed errors (a fixed load burns dry whatever the flow): valve Cv 26→8 moves thrust −1.3 %, O/F −1 %, flips depletion, impulse +0.16 %. "The top bar is the next measurement" was unfounded. | **fixed**: every estimated valve Cv, line K and line length on the drawing is swept (as one factor per kind); the tornado ranks by thrust by default, with O/F, bottle and ΔP/Pc a click away. Test: half the valve Cv moves thrust and not impulse. |
| Ph4 | The band is symmetric and RSS of the larger swing: E_m is −1820 / +754 N·s, so the upside is overstated ~2×. Sigma and bounds are mixed with no label. | **fixed**: the band is told below and above separately; the basis says ranges are bounds unless a measurement states a sigma. Test: E_m's two sides differ. |
| Ph5 | Nozzle efficiency swept 0.93–0.97 excludes the 0.975–0.985 the review called typical (+3.5 % impulse). | **fixed**: unmeasured nozzle efficiency swept 0.93–0.99. |
| Ph6 | The reconciler asks for a re-drill (+5–6 % area) the size of the uncalibrated Cd scatter and of drill oversize; "converged" means the holes stopped moving, not that the target was met; diameters quoted to 0.1 µm. | **partly**: "converged" now reads "holes settled"; diameters to 3 decimals; the drill map draws the uncalibrated-Cd box (±4.2 % O/F, ±2.1 % thrust) around the pick and the check is graded against the band. Open: blocking a machining order until a cold-flow Cd exists is the team's call. |
| Ph7 | The feed fit writes the regulator's supply deficit into K0, which the chug model reads as resistance: GM 1.509 → 1.570, in the unsafe direction. | **fixed**: `feed_system.<side>.supply_K` holds the regulator's share of K0; the chug loop leaves it out (the regulator model carries it); the feed fit writes it. Default 0 is the old model exactly. Test: same operating point, lower margin. |
| Ph8 | EngineDesign's chug margin is computed every replay step and shown nowhere; the verdict is a ΔP/Pc rule of thumb taken after 0.2 s, so ignition is never graded. | **fixed**: EngineDesign's chug margin is carried through the replay, graded as a verdict (lowest over the whole burn, ignition included), in the CSV and on the test card; ΔP/Pc through ignition is in the summary. |
| Ph9 | A failed erosion replay reported the run converged, and the headline fell back to the as-built throat silently. | **fixed**: a failed replay leaves the run unconverged with the reason; a "Model" verdict says when the coupling did not settle and an "Engine table" one when steps were extrapolated. |
| Ph10 | "Left over 0.04 kg, LOX ran dry first" is graded green at 0.4 % of the load, when ±3 % Cd alone flips which tank runs dry. | **fixed**: "Left over" under 3 % of the load is amber with the reason (the tank that runs dry first is inside the Cd scatter); the sweep reports which inputs flip it. |
| Ph11 | Throat erosion (0.32–0.99 mm/burn, unmeasured) is outside the uncertainty band: the sweep runs without the replay. Doc erosion and Phase 3 numbers are stale. | **open**: an erosion factor needs the replay inside the sweep (each case a full replay). The sweep basis says erosion is outside it. |
| Ph12 | The injector-face dump is priced from the config's passage area with an unsourced K_exit = 1; nothing compares it with the drawing's last line bore (3/8 in tube would make it ~4× larger, silently). | **fixed**: preflight compares the drawing's last line bore with the design's exit bore and warns with the dump's factor. Verified both ways. |
| Ph13 | SMD, wall heat loss, finite-rate constants, propellant temperature, load tolerance are not swept. | **open**: SMD, wall heat loss, finite-rate constants, propellant temperature need EngineDesign measurement fields first. |
| Ph14 | Apogee is vertical, windless, standard atmosphere, quoted to the metre, when the open items are each ±100–150 m. | **open**: a dispersion case (rail angle, wind) is a flight-model build; the headline says vertical and windless in its hover. |
| Ph15 | Preflight passes against MAWPs that are themselves "estimated" on the drawing, and the optimiser's lockup ceiling comes from them. | **fixed**: preflight warns when a vessel has no MAWP or an estimated one, naming them; each tank's peak over hold and burn is graded against its MAWP. |
| Ph16 | A measured Cd switches the Reynolds/inlet model off, so the Cd cases also change model structure. | **open (documented)**: the sweep's Cd cases change model structure; said here. |
| Ph17 | Engine-card agreement is printed to 0.001 % next to an unflagged 4–8 % band: agreement read as accuracy. | **fixed**: preflight says the table reproduces EngineDesign's model, and that this is agreement, not accuracy. |

## Code (C)

| # | Finding | Status |
|---|---|---|
| C1 | `flight.fly` swapped `sys.stdout` for the whole API process: two overlapping flights left the server printing into a StringIO for ever; other requests' prints landed in a run's notes. | **fixed**: `engine/layerx/capture.py` captures per thread. Test: two concurrent captures, and the redirect_stdout version fails it. |
| C2 | The "write into the design" guards compared against a preflight that is stale for seconds after a design load, and read *fresh* when preflight errored: a K0 or hole set fitted to design A could be written into design B. The server took any PUT. | **fixed**: `PUT /api/config?expect_sha256=` refuses a write for another design (409); both Layer X writers send it; the UI treats an unsettled preflight as unknown, not fresh. Test. |
| C3 | Cancelling a trade or sweep waited for an in-flight point (1–2 min flown) while holding the user's slot. | **fixed**: one pool (`engine/layerx/pool.py`) wakes every 0.5 s for a cancel and terminates its workers. |
| C4 | The worker-pool lifecycle was copy-pasted in optimise, trade and sweep, each reaching into private attributes. | **fixed**: optimiser, trade study and sweep share `WorkerPool`. |
| C5 | The router (940 lines) had one happy-path test, which leaked a temp dir per run. | **fixed**: `tests/test_layerx_router.py` (one-job 409, index, names, pins, pruning, delete, trade refusals, measurement bounds); the old test no longer leaks a temp dir. |
| C6 | `GET /runs` parsed every saved run's full JSON on every 2 s poll. | **fixed**: runs carry an index entry; the listing never parses a burn. Old runs are indexed on first listing. |
| C7 | Every cursor move re-rendered every chart; the compare reference was a new object each render. | **partly**: the compare reference is memoised. Open: drawing the cursor as an overlay so the charts are not re-rendered on every move. |
| C8 | `useReducedMotion` re-subscribed every frame. | **fixed**: `useSyncExternalStore`. |
| C9 | Trade limits were written three times (router, engine, UI) and had drifted; every job ran preflight twice. | **fixed** (limits in one place, served to the UI); **open**: preflight still runs twice per job. |
| C10 | Four copies of the job-panel lifecycle in the UI. | **open**: one `useLayerXJob` hook for the four panels. |
| C11 | `DraftNumber` and `finite` defined twice, a third variant elsewhere. | **fixed**: `fields.tsx` / `format.finite`. |
| C12 | Unit constants redefined in a dozen places, one truncated. | **fixed** in the UI (`format.ts`: FT, G0, PSI, LB); backend constants left. |
| C13 | Cancellation signalled by exception strings; any error after a cancel was labelled "cancelled". | **fixed**: `pool.Cancelled`; the router files any other exception as a failure. |
| C14 | `DrawingStore.get` read and hashed every drawing on every lookup. | **fixed**: uploads open by id; shipped drawings are cached by mtime. |
| C15 | A job whose save failed stayed in memory for ever, result included. | **fixed**: the newest five unsaved jobs are kept in memory, older ones dropped. |
| C16 | Double-clicking Run burn left a 409 error beside the run that started. | **fixed**: one click is one run. |
| C17 | oxidiser / oxidizer / ox across the API. | **open**: oxidiser/oxidizer is a wire contract across apps; a rename is its own change. |
| C18 | `RunView.result` an undiscriminated union, so casts everywhere. | **open**. |
| C19–20 | Two near-copy "write into the design" components; two near-copy download helpers; the .eng dimension overrides unreachable from the UI. | **open**: the .eng overrides are still not in the UI. |
| C21 | `export-config` 500 on a config without a feed side. | **fixed**: 422. |
| C22 | Restated measurements accepted any value and unbounded strings. | **fixed**: negative values refused (heights excepted), strings capped, 500 restatements at most. Test. |
| C23 | The trade study built hole patches without the router's bounds. | **fixed**: per-axis windows and the hole's L/d bound, checked before a slot is taken. Test. |
| C24 | `trade._trade_point` raised on a burn with no tank minimum, turning a good burn into "failed". | **fixed**. |
| C25 | The optimiser graded a 0 psia bottle as "not computed" (truthiness). | **fixed**. |
| C26 | Opening a run fetched it twice, neither checking it was still the one wanted. | **fixed**: one fetch, and a late answer for a run no longer wanted is dropped. |
| C27 | `sweepByRun` grew in localStorage for ever. | **fixed**: pruned to runs that exist. |
| C28 | csv.ts: O(N²) acceleration lookup, unquoted headers, happy-path tests only. | **fixed**: one pass, safe headers, chug margin column, edge-case tests. |
| C29 | No tests for Trade.tsx, the compare merge, `settingsDiff`, `pollJob`; slow tests unmarked. | **partly**: new tests for the CSV, DAQ import, test card and error text. Open: Trade.tsx and settingsDiff component tests; slow tests unmarked. |
| C30 | Burns run in the API process; components too big; magic values; tab strip without ARIA. | **open**: architecture. |

## Visual and interaction (V)

| # | Finding | Status |
|---|---|---|
| V1 | The Trade ramp meant the second setting on the curves and the first setting on the histories, and ran from the LOX blue to the fuel orange. | **fixed**: one accent-lightness ramp for the second setting on the curves, a grey ramp for the swept setting through the burn, each with its own legend; never the propellant hues. |
| V2 | Every Trade chart flagged an infeasible point red whatever limit it missed. | **fixed**: ringed red only on the chart of the limit missed; hollow grey elsewhere. |
| V3 | Optimise showed an infeasible winner as the answer, with the primary button. | **fixed**: red line above, "Use anyway" as a quiet button. |
| V4 | Axis ticks rounded into duplicates ("232 / 233 / 233"). | **fixed**: `tickDigits` on every result and trade axis. |
| V5 | `auto` axes drew a 1 % thrust ripple as tall as a 30 % sag. | **fixed**: each mini-chart has a least span. |
| V6 | Nine tooltips popped at once; values at the cursor were hover-only. | **fixed**: no chart tooltips; each line's value at the cursor is printed beside its legend. |
| V7 | A failing verdict was an 8 px dot under six 2 rem numbers; colour-only. | **fixed**: a red "Fails:" line above the headline; ✓ ! ✗ shapes. |
| V8 | The schematic is unreadable below ~1100 px (fixed 1180-wide viewBox). | **open**: the schematic's fixed viewBox below ~1000 px. |
| V9 | The flow dashes animated for ever on a still result, and the gas lines' speed was hard-coded. | **fixed**: dashes move only while playing; gas lines run at the bottle's own outflow. |
| V10 | The stale-settings banner spoke model words, had no units, said "from the design" for the drawing's bottle, and had two ambiguous buttons. | **fixed**: rail words and units, "drawing"/"design" for unset, two lines, "Restore this burn's settings" / "Re-run with the rail". |
| V11 | The tornado: LOX-blue for low and alarm-red for high, values hover-only, "±" printed for same-sign swings. | **fixed**: neutral filled/outlined bars, signed values printed, accessible label. |
| V12 | The sweep's big nominal numbers sat under a burn whose headline differs. | **fixed**: the band shown below/above with the sweep's nominal in a hover; the paragraph is a hover. |
| V13 | The thrust envelope was twenty translucent lines and a tooltip listing all of them. | **fixed**: a shaded band with the nominal. |
| V14 | The compare ghost was the same colour at 28 % under the live line: invisible when runs are close. | **fixed**: one thin grey for the other run on every chart, legend to match. |
| V15 | Trade and Optimise failed silently when their setup request failed. | **fixed**. |
| V16 | Impulse in four formats. | **fixed**: kN·s to two decimals everywhere. |
| V17 | The bottle in psig on the rail and psia everywhere else. | **fixed**: the bottle in psig on the schematic, its chart and the test card. |
| V18 | Flight mixed ft, m and m/s, kg and lb. | **fixed**: ft, ft/s (m/s beneath), lb (kg beneath). |
| V19 | The Trade "now" line was the value at run time and vanished outside the swept range. | **fixed**: "at run", never dropped. |
| V20 | Trade x axes without units; an unlabelled sag line; the stiffness floor missing when the config has no band. | **fixed**. |
| V21 | Events: the fuel minimum drawn LOX-blue; same-instant events stacked into one hover. | **fixed**. |
| V22 | Recent and Compare runs told apart only by time and impulse; six rows. | **fixed**: names, pins, drawing · psia · gas · flown in every row, all runs in a scroll list. |
| V23 | One quantity, three names ("Engine model", "engine table error", "Engine table accuracy"); "EngineDesign" / "uneroded" as legend words. | **fixed**: "Engine fit"; "Thrust" / "as built". |
| V24 | Muted text brighter than secondary text; propellant colours hard-coded hex outside the theme. | **fixed**: muted below secondary (#7d8ba0, AA); `--color-lox` / `--color-fuel` tokens. |
| V25 | Plume regime colours reused the propellant hues. | **fixed**: regime as text; colour only for separation. |
| V26 | Tooltips widened the page past narrow screens and were not linked for screen readers. | **fixed**: hidden tooltips take no space, flip to stay on screen, are linked by aria-describedby. |
| V27 | Drill sizes to 0.1 µm; the drill map without axis titles; check errors not graded. | **fixed**. |
| V28 | Locale formatting: "6.804 N" in a de-DE browser reads as six newtons. | **fixed**: en-US; and "-0" no longer printed for a value that rounds to zero. |
| V29 | "T-12.00" before Fire and "3.20 s" after; playback speed cycled ½→1→¼; provenance printed as 0.020000. | **fixed**: T−/T+, speed 1 → ½ → ¼, provenance at four significant figures. |
| V30 | Colour-only encodings in the parameters panel and the feed fit. | **fixed**: ◆ for a default; "!" beside the feed fit's large differences and the check's off-band errors. |
| V31 | (Own walk-through) the app shell scrolled sideways below 1060 px; on narrow screens the whole rail stands between the engineer and the result. | **partly**: the shell no longer scrolls sideways at 820 or 390 px. Open: putting the result above the rail on a phone. |

## Product (P)

| # | Finding | Status |
|---|---|---|
| P1 | The prediction cannot be compared with the stand's channels: the drawing's instruments are not output, and their tags (PT_OXU…) are not the DAQ's (PT_OUP…). | **fixed**: every instrument on the drawing is read on every burn (feedtwin `Probes.instruments`, opt-in, default empty); each pairs with a channel from the DAQ's own config, saved with the drawing. |
| P2 | No post-test loop: no way to bring a DAQ CSV back and see it against the prediction. | **partly**: load a DAQ export (wide or long), Fire found from the transducer that jumps at Fire, measured against predicted per channel with bias and scatter. Open: fitting Cd, K and droop from it. |
| P3 | No test card; the dome setting, the one number someone dials, lives in a tooltip. | **fixed**: Test card: dome, lockup and fill as the gauges read, loads, expected per channel at T−0/0.5/1/2 s/burnout, the lines not to cross, what is not modelled; print or PDF. |
| P4 | Layer X's thermal defaults are off; the cockpit's are on; the same drawing answers differently in each. | **partly**: the headline says which thermal models the burn ran without, and the sweep includes them. Open: whether Layer X's defaults should be the cockpit's is the team's decision (it moves the bottle ~190 psi). |
| P5 | Safety checks fail open: MAWP checked against lockup at rest only, skipped when a drawing has none; no peak vessel pressure over hold and burn. | **fixed**: peak tank pressure over hold and burn against MAWP; missing or estimated ratings named in preflight. |
| P6 | The chug margin is thrown away (with Ph8). | **fixed** (with Ph8). |
| P7 | The chosen operating point lives in one browser. | **open**: an operating-point block in the design document. |
| P8 | Runs cannot be reproduced: the config is hashed, not kept; no code version. | **fixed**: every burn keeps the design as YAML and `git describe` of the code. |
| P9 | Six-line run list, silent pruning at 25, no names, notes or pins. | **fixed**: name, note, pin (never pruned), delete. |
| P10 | Results cannot be shared: no report, no link. | **partly**: the test card prints to PDF. Open: links. |
| P11 | The Forward/Flight hand-off does not say which run it came from. | **open**. |
| P12 | Imports take the pid-designer working copy, never a release. | **open**: the release picker. |
| P13 | The sweep omits the operational uncertainties (dome set, fill, propellant temperature, load). | **fixed**: dome set ±5 psi and a short fill are sweep factors. |
| P14 | Known optimistic biases hidden behind a clean headline. | **fixed**: "Not in these numbers" under the headline. |
| P15 | Ignition (lead/lag, hard start) not assessed. | **open**: ignition lead/lag needs the valve timing and fill volumes. |
| P16 | Stand and vehicle drawings are not linked; a part measured on one does not carry to the other. | **open**. |
| P17 | Nothing seeds a cockpit rehearsal with the predicted settings. | **open**. |
| P18 | Waiting is dead time: one job per user, no title progress, no notification, no partial results. | **partly**: progress in the tab title. Open: a queue and streamed partial results. |
| P19 | Comparison stops at two runs. | **open**: comparison is pairwise. |
| P20 | Onboarding needs the author. | **open**. |
| P21 | Decisions are not recorded. | **partly**: a run's note holds what was decided. |
| P22 | Competition rules are not checked. | **open**. |
