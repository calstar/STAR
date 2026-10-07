# Layer X changelog

Changes to Layer X physics, defaults and results, newest first. Each entry gives the baseline it was measured against. Any figure that moves more than 1 % gets reported here with its before and after values. That rule applies to the full figure list in `AUDIT.md` section 8, not to impulse alone.

## 2026-10-07 Two-page drawings, the dome as an input, every pressure in psia

New reference: `baseline-2026-10-07.json` (golden, integration, stability and LE4 integration tests
point at it). It differs from `baseline-2026-10-03d.json` in two inputs, both deliberate: the LE4
config's 1.65 / 1.50 mm drilled holes (2026-10-05) and the drawn-dome default below. The feed twin's
own changes since 03d (regulator supply datum and the rest) left 03d's golden green.

| change | why | effect |
|---|---|---|
| **Layer X burns the vehicle only** (`engine/layerx/vehicle.py`): the symbols joined to the ENGINE by drawn lines. A GSE page joined only by paired quick-disconnects is cut before assembly and the vehicle's disconnect halves capped; tank roles, the bottle, the helium swap and the drawing summary come from the vehicle | LE4 (6) drew the GSE on a second page: two ethanol tanks blocked the run, the 49 L K-bottles were listed and swapped as pressurant, and the mated GSE dome regulator tripped the LOX tank at 802 psig before T-0 | none on one-piece drawings (returned unchanged); LE4 (6) now runs |
| **The dome dial is an input**, `dome_psia`; default the dial the drawing states on the regulator it sets (`feedtwin.session.hookup`: a loader's setpoint, else a dome-loaded regulator's `dome_pressure`). A rail tank pressure still solves the dial; the last one typed wins. `dome_regulator` names another regulator (list or click on the drawing) | "why is the dome pressure hardcoded, that should be a variable … autopulled from the dome reg in the drawing" | default lockup on the study drawings 578.0 → **564.7 psia (−2.3 %)**, PR-CTRL's 500 psig. Isolated on he_pad (old holes): mean thrust **−1.96 %**, Pc −1.78 %, burn time +1.68 %, bottle at burnout +2.96 %, pressurant used −2.61 %. LE4 (6): DPR_HP's 535 psig dome, **599.7 psia** lockup |
| Every pressure on the rail and the pages is **absolute** (`units.ts` `ABSOLUTE_ONLY`; `copv_pressure_psia` on the rail, `copv_pressure_psig` still read from older settings and written by the optimiser) | "everything should be psia" | display only |

he_pad, 03d → 07 (holes and dome together): impulse +0.03 %, mean thrust −1.01 %, O/F 1.521 → 1.505,
burn time +1.06 %, chug margin min 1.398 → **1.337 (−4.4 %)**, throat growth 3.44 → 3.30 %.

Server: `engine-design-api` had no `PID_DESIGNER_URL`, so "From pid-designer" asked 127.0.0.1:8001
inside its own container. `docker-compose.yml` now points it at `http://pid-designer-api:8001`.

## 2026-10-03 (night) Fitting heat and the supply effect on, in the feed twin

Measured against `baseline-2026-10-03c.json`; the new reference is `baseline-2026-10-03d.json`
(golden, integration and stability tests point at it).

The change is made in the feed twin, not in Layer X: `lib/feedtwin` `Setup.line_walls` and
`Setup.regulator_lockup_supply` default on, the cockpit's line-walls toggle starts on, and Layer X
sets neither (it used to force the supply effect itself). The Line and fitting heat toggle stays in
the rail and starts at the twin's value; the supply effect has no toggle. `burn_setup` pins both off,
so the Study and `scripts/physics_benchmark.py` are unchanged (benchmark: all checks pass).

| figure | he_pad 03c → 03d | gn2_pad 03c → 03d |
|---|---|---|
| bottle at burnout | 1,637.1 → **1,859.3 psia (+13.6 %)** | 1,194.7 → **1,387.0 psia (+16.1 %)** |
| over lockup at burnout | 1,059.0 → **1,281.2 psi (+21.0 %)** | 616.7 → **809.0 psi (+31.2 %)** |
| pressurant used | 0.0909 → **0.0820 kg (−9.8 %)** | 0.7141 → **0.6467 kg (−9.4 %)** |
| tanks at end (LOX / fuel) | 618.5 / 619.1 → 616.5 / 617.0 psia (−0.3 %) | 577.6 / 580.7 → 582.9 / 585.9 psia (+0.9 %) |
| impulse | 24,241 → 24,236 N·s (−0.02 %) | 24,096 → 24,109 N·s (+0.05 %) |
| Pc mean, O/F, ΔP/Pc, chug, throat | < 0.4 % | < 0.4 % |

Why: the press path's tubes and fittings (1/2 in 316, 0.035 in wall; fitting masses on the drawing,
"estimated", ~1.4 kg on the pressurant path) warm gas the bottle's expansion has cooled, so each
ullage litre takes less of it. Energy check by hand: ~10 % less N2 at ~1040 J/(kg·K) is ~12 kJ, about
17 K out of ~1.4 kg of steel at 500 J/(kg·K), the right order for a 3.6 s burn. The fitting masses
are the inputs this rides on (the drawing says to measure the stand).

feed-twin: `tests/test_operator_walks.py::...round_trips_do_not_leak_anything` started its leak check
the moment the press valve shut, so it counted the gas already past the valve finishing into the tank
(26 mg, then flat to the microgram; 37 mg with line walls) as a leak. It now starts after 0.5 s.

## 2026-10-03 (evening) Physics is not a setting; one flight coupling

Measured against `baseline-2026-10-03b.json`; the re-run is `baseline-2026-10-03c.json`. **Nothing moved
more than 1 %**: every pad case is identical to the last digit, the flown cases within 0.01 %. 03b stays
the golden reference; `LAYERX_GOLDEN=1` golden and LE4 integration are 37/37.

| change | why | effect on LE4 |
|---|---|---|
| The eroded nozzle's thrust (`card_eroded_nozzle`), the chug on the eroded engine and the drawing's lines (`chug_eroded`, `chug_basis`) are always on; no longer settings | "there should never be options for wrong physics, just physics" | none on the delivered figures (pad cases bit-identical) |
| Main-valve opening time and tank outlet bore are the drawing's only; the overrides are gone | "they are in the drawing" | none (both were unset by default) |
| Thermal toggles (ullage collapse, propellant vapour, line and fitting heat, tank wall heat) default to the feed twin's own values and show them | keep the toggle, take the number from the twin | none |
| **Flight: the inline 1-DOF ascent is the only coupling.** A flown run settles on the pad first (the stand's burn, for the pad-against-flight panel) and then flies inline from the pad's throat history; RocketPy flies the settled burn once | measured: the RocketPy outer loop gave the same burn as inline (impulse 0.006 %, apogee 0.01 m) in 5 passes and 247 s | he_flight 243 s / 5 passes → **191 s / 4 passes** (2 pad + 2 flight), impulse 24,236 → 24,235 N·s, apogee 3,250 m both; gn2_flight 49.7 → 46.9 s. Inline without the pad comparison is 2 passes / 100 s |

Saved settings that still carry the removed keys are accepted and ignored (`prepare.options`).

## 2026-10-03 (afternoon) The team's answers: trust the feed twin, D7, materials

Measured against `baseline-2026-10-03.json`; the new reference is `baseline-2026-10-03b.json` (same
config fingerprint for the engine except the two material blocks below; same drawings, CEA and DAQ
tables). `LAYERX_GOLDEN=1 tests/test_layerx_golden.py` is green against it.

| change | why | effect on LE4 (he_pad unless said) |
|---|---|---|
| Layer X burns on the **feed twin's own Setup** (`prepare.feed_twin_setup`): ullage collapse, propellant vapour, chilldown 100, stratification, boiling onset, nucleate and wall boiling as the cockpit runs them; line walls off as there. Layer X's four thermal switches became "unset = the twin's"; the rail shows them read-only. | "it's called feed twin cause it's supposed to be an exact twin of the feed system ... pull from it and trust it" (AUDIT D1) | bottle at burnout −9.2 psi (1,068 → 1,059 psi over lockup, −0.86 %); GN2 −9.3 psi (−1.49 %, **> 1 %**); every burn figure < 0.3 % |
| Drawings come from the **feed twin's library** too (`sources.py`: `feed-twin/backend/library`), so what its cockpit pulled from pid-designer is runnable; byte-identical copies are one drawing, repeated names get their import date | the same | none (the burns use the same drawing bytes) |
| **D7 decided**: the graded chug margin is on the drawing's own lines, on the eroded engine, from the first full-flow step | "if it removes a time step artifact then yes do it" | graded chug margin 1.398 (t = 0.05 s, start included) → **1.469 (+5.1 %, > 1 %)** at t = 0.10 s; the old figure is listed beside it as `chug_margin_other_basis` |
| LE4 config (`configs/ethalox_6800N.yaml`): the team's **phenolic** liner (density 1.37 g/cm³, k 0.293 W/m·K from its datasheet) and the **304 stainless case**, 0.25 in (Incropera Table A.1 properties) | the team's datasheet and hardware | with the next row |
| The graphite insert is **backed by the phenolic out to the case** (`time_varying_solver._insert_backing`), not set directly on the steel. The backing is *assumed* (the config does not say what fills the gap between the insert and the case; the liner's material is the only other one it declares). | declaring the case otherwise put steel against the graphite | **throat growth 4.00 % → 3.44 % (−14 %, > 1 %)**, recession 0.474 → 0.407 mm: the phenolic draws ~0.4 MW/m² from the ~2000 K insert, which a 6 mm slab feels as ~100–200 K. The case stays at ambient through the burn. Max thrust −0.21 %, Pc max +0.29 %. The insert's back face is now its graphite/phenolic interface (was an adiabatic upper bound). |
| Tank limits (MAWP, MEOP, design cap) are **information** | "don't worry about tank limits for now" | verdict only; the twin's MAWP trip still stops a burn |
| Water hammer: only the **opening surge** at Fire, as information; the closing case is gone | "the valves NEVER close, they open for fire and stay open" | verdict only |
| "Runs dry first" is **information**; left-over propellant flags above **0.2 kg** (was 0.25) | "if it's within 0.2 kg it's fine" | verdict only: LE4 he now grades with no warnings |

Not changed, reported to the team: the regulator's supply-pressure effect is 17 psi/1000 psi in every
feed-twin drawing (TB 1031) and in the regulator's own default; the team quoted 14.7. Layer X uses the
twin's 17.

## 2026-10-03 Verification: every change tonight, measured on LE4

Measured against `baseline-2026-10-02.json` on the same machine (Python 3.11.7, numpy 2.4.2, CoolProp
7.2.0). The re-run of the whole baseline is `baseline-2026-10-03.json`; its diff is at the end of this
entry. **No default burn of the baseline moved, except he_flight, by the intended helium-flight fix.**
`LAYERX_GOLDEN=1 tests/test_layerx_golden.py` is 29/29. An he_pad burn with every diagnostic on
(`diagnostics=True`, as the router runs it) reproduces every he_pad baseline metric bit for bit.

### Each change and its effect on the LE4 baseline

"None" means measured, not assumed: the he_pad golden burn, the he_pad diagnostics-on burn and the
re-run baseline all reproduce the 2026-10-02 figures to the last digit.

| change (where) | kind | default | effect on the LE4 baseline |
|---|---|---|---|
| **lib/feedtwin** | | | |
| Network recorder: every node and branch, every step (`session/network_trace.py`, `Probes(network=True)`) | recording | on in Layer X since the wiring | none; checked exact with and without it on a GN2 burn |
| Vessel trip ends `burn()` (`session/burn.py`, `BurnEnd.tripped`, `trip_record`) | **bug fix** (AUDIT 5.2, #1) | always | none on an untripped burn. AUDIT's case (TK-FUEL MAWP 600 psi, he_pad): 99,478 N·s over 14.000 s → 21,717 N·s twin / 21,834 N·s delivered, ending at 3.125 s with a `trip` event |
| Pressure-actuated relief valve (`comps/relief.py`, `comps/iec_gas.py`): an RV that declares `set_pressure` | new component | only when a drawing declares one | none: no shipped drawing has an RV. An RV without a set pressure is still the old always-open Cv valve, now with a build warning |
| Regulator seat with the IEC 60534 expansion factor and choke (`Setup.regulator_compressible_seat`, `regulator_xT` 0.70 assumed) | physics, opt-in | off; not reachable from Layer X | none. Measured when on: LE4 He unchanged through burnout; the 7000N config burned to depletion on GN2, impulse −46.8 N·s (−0.11 %) |
| `surface_temperature_K` recorded; ullage-wall T-0 per tank (`Setup.ullage_wall_T0_K`, `cryogen_ullage_wall_T0_K`) | recording / opt-in | 0 = today's | none |
| **EngineDesign, wave 1 (diagnostics and fixes)** | | | |
| Chug block on both feed bases, start window, gate frequency, Nyquist, lag sweep, acoustics (`diag/stability.py`; `build_stability_inputs(feed=None)`) | diagnostic | computed on every run | none; the config basis equals the replay's own margin to 0.0 at all 28 points |
| Replay keeps its per-point arrays, writes the axial sidecar, soak-back after the final replay (`replay.py`, `time_varying_solver.py`) | recording | on | none |
| Eroding engines always erode in the replay; the legacy loop raises instead of falling back (`replay.py`, `runner.py` `strict_erosion`) | **bug fix** (AUDIT 5.3) | always | none on LE4 (already tracked). A graphite-only engine grows its throat 3.09 %, where it reported 0.000 % |
| `supply_K` zeroed in `line_exit_config` (`card.py`) | **bug fix** (AUDIT D7) | always | none: LE4 carries 0. After a feed-fit write the chug gate no longer drops 1.330 → 1.248 [doc] with no physical cause |
| Hardware block: throat, contour, separation (Summerfield, Schmucker), Isp breakdown, insert back face, soak-back (`diag/hardware.py`) | diagnostic | on | none |
| Feed blocks: ladder, regulator, solenoids, pressurant floor, saturation, cavitation, injector, thrust shape, ledger (`diag/*.py`) | diagnostic | on | none. The checker's fix to the pressurant floor (bottle on its isentrope) moved that diagnostic only: unusable He 0.0520 → 0.0723 kg, spare 0.0664 → 0.0461 kg |
| Start, shutdown, water hammer, gas ingestion (`diag/start.py`, `shutdown.py`, `waterhammer.py`, `outflow.py`) | diagnostic | on; the burn still opens both mains at Fire | none. They report: start loss 101 N·s (0.42 %); fuel water hammer at the drawn 0.05 s closure 1,384 psi rise with column separation, graded on Joukowsky 2,906 psia against an estimated 1,015 psia rating |
| Limits graded once, on the server (`diag/limits.py`), V&V (`diag/vv.py`), exports (`export.py`) | grading | on | none on the burn. LE4 he_pad grades: tank caps 618.4 / 619.0 psia against 600 (warn, D11), depletion tie 0.058 kg (warn), water hammer l_fu1 2,906 psia (amber, capped from red pending review) and l_ox1 911 psia (warn). The settled and drawing-basis chug rows carry the frequency at their gate (21.8 / 23.3 Hz), not the nominal-lag 31.7 Hz the old report gave; today's graded row carries none |
| Flight: the drawing's pressurant prices the ullage refill (`flight.py`, `ui/flight_sim.py`) | **bug fix** (AUDIT D2-C) | always | he_flight moves; table in the 2026-10-03 Integration entry below. GN2 unchanged (nitrogen is the config's gas) |
| Flight: pressure thrust only while firing; the vehicle held on the rail reads exactly 1 g (`flight.axial_acceleration`) | **bug fix** (AUDIT 5.1) | always | none on any burn: every firing sample is bit-identical, so he_flight and gn2_flight do not move. The coast reads 0 at apogee (was +0.40 g) |
| Flight: static margin, CG, CP, max-Q, rail exit (`vehicle_stability`); inline 1-DOF ascent (`InlineAscent`) | diagnostic / opt-in | stability on; inline off | none (inline measured below) |
| Set point, Hardware mode, catalogue, change list; Trade study removed (`setpoint.py`, `optimize.py`, `catalog.py`, `diff.py`) | tools | — | none: no burn path touched |
| **EngineDesign, integration and wiring** | | | |
| Diagnostics on every run a person starts (`analysis.run_prepared(diagnostics=True)`) | wiring | on (router); off for the tools' candidate burns | none; 3.0–4.6 % of the run's wall time |
| Nitrogen over LOX refused for a hot fire (`prepare.gn2_on_lox`: p_N2 > Psat,N2(T_LOX), 52.3 psia at 90 K; `ack_gn2_condensation`) | preflight | refuse | gn2_pad and gn2_flight need the acknowledgement; their figures do not move. The 492.5 psia constant is gone |
| Tank-rise estimate before the burn (`prepare`, `tank_rise`) | preflight | on | a new `warn` on the helium cases (≈625 psia estimated, 618/619 burned, over the 600 cap); no figure moves |
| Network on every burn; a trip read by Layer X (`analysis._burn_once`, `reduce_trace`) | wiring / **bug fix** | on | none on untripped burns; `cavitation_fuel` moves 2.28535 → 2.28533 (it reads the line-exit temperature from the network) |
| New GUI, default from 2026-10-03 (`frontend/src/components/lx/`) | display | on (`?lx=1` the old one) | none |

### The opt-in settings, measured on LE4

Each burned once with diagnostics on, on the baseline's embedded config, against the same burn at
defaults. Delivered figures are EngineDesign's eroding replay; "twin" figures are the engine card's.

| setting | burn | default → on | what else moved |
|---|---|---|---|
| `chug_basis: drawing` | he_pad | graded chug margin 1.3981 (0.05 s, config basis, start included) → **1.4683** (0.10 s, drawing basis, settled), +5.0 %; burnout margin 1.5117 → 1.5852; gate frequency 21.8 → 23.3 Hz | nothing in the burn; the config basis is shown beside it |
| `chug_eroded: true` | he_pad | graded chug margin 1.39810 → 1.39846 (+0.03 %); settled 1.39767 → 1.39838; **burnout margin 1.5117 → 1.5724** (+4.0 %); drawing basis 1.4683 → 1.4691 | nothing else |
| `card_eroded_nozzle: true` | he_pad | delivered figures unchanged (impulse, thrust, Pc, Isp, burn time to the last digit); twin impulse 24,273.7 → 24,236.9 N·s (−0.15 %), twin peak thrust 7,351.9 → 7,318.5 N (−0.45 %), twin mean −0.15 %; engine check against the replay, worst thrust 0.50 % → 0.047 % | delivered `impulse_to_depletion` +0.0006 % |
| `flight_coupling: inline` | he_flight | passes 4 → 2; wall 190 → 115 s (both under load); delivered impulse −0.0056 %, mean thrust −0.015 %, max thrust −0.001 %, apogee 3,249.08 → 3,249.05 m; liftoff acceleration 8.578 → 8.535 g (−0.50 %) | **graded chug margin 1.4066 → 1.3981 (−0.60 %)**, ignition dips −0.5 / −0.7 %, ignition stiffness LOX −0.61 %: the inline ascent's first firing step burns at 1 g, because the vehicle is still held at Fire, where the outer loop applies RocketPy's 8.5 g. The inline run carries no `flight.pad` / `flight.in_flight` comparison |

The start and gas-ingestion settings (`fuel_lead_s`, `valve_travel_s`, `outlet_d_mm`) change those two
diagnostics only; with all the opt-ins on at once the delivered figures do not move and the graded chug
margin is 1.469 (drawing basis, settled; Integration entry).

### Re-baseline: `baseline-2026-10-03.json`

`scripts/layerx_baseline.py --all` on the same design (config fingerprint `7782d2fd…`; the embedded
config is identical to the 2026-10-02 file's), the same drawing, CEA table and DAQ tables (hashes
equal), code `08b47c05-dirty` (tonight's work is uncommitted), same environment. Every metric of every
case was compared; wall-clock entries aside, these are all the moves.

| case | figures moved | why |
|---|---|---|
| he_pad | **none** | — |
| gn2_pad | **none** | its settings now carry `ack_gn2_condensation: true` |
| gn2_flight | **none** (one key added: `flight.mass_budget.pressurant_gas` = Nitrogen) | new record key |
| he_flight_he_ullage | **none** (the same key added, Helium) | — |
| he_flight | 112 of 131 | **the helium-flight fix**: it now flies, and equals `he_flight_he_ullage` in every figure |

Every case gains the `tank_rise` preflight warning (He: ~625 psia estimated; GN2: ~630 psia), and the
GN2 cases' condensation note now states the physical criterion. The settings defaults gain the nine
opt-in keys, all `None`.

**he_flight, figures over 1 %** (each is the flight's own effect: 8.6–9.8 g on the liquid columns
raises the injector inlets and shifts O/F, which changes which tank is left with what):

| figure | 2026-10-02 (pad burn; flight refused) | 2026-10-03 | move |
|---|---|---|---|
| fuel left when the LOX runs dry | 0.0579 kg | 0.0641 kg | +10.6 % |
| LOX left (the depleted side) | 0.99 g | 0.90 g | −9.0 % |
| min LOX injector ΔP | 142.15 psi | 143.62 psi | +1.03 % |
| passes | 2 | 4 | the flight loop |
| twin steps | 80 | 79 | the burn ends 10 ms earlier |
| engine check / replay agreement, worst | thrust 0.504 %, Pc 0.112 %, flows 0.119-0.131 % | 0.453 %, 0.111 %, 0.116-0.128 % | relative errors of 0.1-0.5 %, which move by more than 1 % of their own size |
| Forward cross-check (8 rows) | −0.29 to +0.04 % | +0.04 to +0.38 % | the same: small relative errors, now taken on the flown burn |

Below 1 %: impulse −0.019 %, burn time −0.29 %, mean thrust +0.27 %, min +0.49 %, max +0.016 %, Pc
mean +0.20 %, O/F +0.14 %, Isp +0.04 %, bottle at burnout +0.12 %, tank peaks −0.03 psi, ΔP/Pc LOX
+0.62 % and fuel +0.09 %, chug minimum 1.398 → 1.407 (+0.61 %), throat growth +0.39 %. Apogee 3,249 m
AGL (was "flight failed"). Wall time 78 → 192 s, the two flown passes.

`tests/test_layerx_golden.py` keeps `baseline-2026-10-02.json` as its reference: its case, he_pad, is
identical in both files, and the test passes 29/29 against either (`LAYERX_GOLDEN_BASELINE`).

## 2026-10-03 Wiring: the feed network on every burn; a vessel trip ends the burn

Measured against `baseline-2026-10-02.json` (same platform). **No untripped burn moves**: he_pad with every
diagnostic on reproduces all 91 physics metrics bit for bit (impulse 24,239.795689323 N·s; only the three
wall-clock entries differ), he_flight equals the `he_flight_he_ullage` row bit for bit (24,235.2 N·s,
apogee 3,249.08 m), and `LAYERX_GOLDEN=1 tests/test_layerx_golden.py` is 29/29.

**The whole feed network is recorded on every burn** (`result.network`, DATA-CONTRACT 2): lib/feedtwin's
recorder, switched on in `analysis._burn_once`. Recording only, checked exact on a GN2 burn with and without
it (`tests/test_layerx_wire.py`). On LE4 he_pad: 31 nodes, 31 branches, 80 steps; the run record is 0.97 MB
(0.15 MB of it the network); the burn took 72.1 s and the diagnostics 3.3 s (4.6 %); on the flown burn
143.1 s and 4.25 s (3.0 %). Every diagnostics block is now built (16/16 on he_pad and he_flight): the
pressure ladder (closes to 1e-12 psi), the regulator (18.7 % of its IEC capacity at most, never wide open),
the press solenoids (3.06 / 2.56 psi at most), saturation (lowest static margin 517.8 psi, LOX injector
inlet), the pressurant floor (0.163 kg needed, 0.046 kg spare). New limit rows appear with it, none of them
amber or red on LE4: `regulator_wide_open` and one `saturation_<node>` per liquid node; `cavitation_fuel`
moves 2.28535 -> 2.28533 (it now reads the line-exit temperature from the network). The stability block's
start window opens on the mains' recorded state rather than the travel-time rule: the same 0.05 s on LE4,
so no chug figure moves.

**Bug fix: a vessel trip ends the burn and the run says so (AUDIT section 5 #1, catalogue #38).** lib/feedtwin's
`burn()` now stops on the tripping step; Layer X now reads it: `result.tripped`, a `fail` event keyed `trip`
(no "Horizon reached"), `converged: false`, `vessel_trip` graded bad, a tripped pass replayed once for its
delivered figures and never iterated or flown, the shutdown diagnostic a cutoff at the trip. The tripping
step's sample is stamped at the trip (lib/feedtwin's `burn()` stamps it at the end of the 50 ms step, though
the session stopped at its 25 ms live step). Every tool counts a tripped burn as failing (set point, hardware,
uncertainty sweep, legacy optimiser, reconcile). The AUDIT's case, TK-FUEL's MAWP restated to 600 psi on the
LE4 helium pad burn (trips at 614.70 psia):

| AUDIT case | AUDIT (Layer X then) | lib/feedtwin stopping, Layer X not reading it | now |
|---|---|---|---|
| total impulse (twin) | 99,478 N·s | 21,896 N·s | 21,717 N·s |
| delivered impulse (replay) | — | — | 21,834 N·s |
| burn time | 14.000 s | 3.150 s | 3.125 s (the trip) |
| events | "Horizon reached", no trip | "Horizon reached", no trip | `trip` (fail) at 3.125 s |
| converged | — | true with the replay off | false |

Only burns that trip move. A trip in the settle, before the burn records a step, raises
`analysis.StandTripped` (the run fails with the trip's message).

## 2026-10-03 Integration: diagnostics wired in; helium flight fixed; GN2-on-LOX refused

Measured against `baseline-2026-10-02.json` (code `08b47c05-dirty`, same platform). **he_pad does not
move**: with every diagnostic on, all 94 baseline metrics are bit-identical (impulse 24,239.795689323 N·s);
`LAYERX_GOLDEN=1 tests/test_layerx_golden.py` stays green. The diagnostics read the burn and cost
3.0-3.5 s against a 77 s burn (4-4.5 %).

**Bug fix: the helium drawing flies (AUDIT D2-C, 5.2).** `analysis.run_prepared` now passes the drawing's
pressurant to `flight.fly`, which prices the T-0 ullage and the COPV refill as that gas. Before, the flight
priced them as the config's nitrogen and refused the 0.209 kg helium bottle ("needs 0.521 kg"), so
**he_flight** reported the pad burn. Its figures now equal the baseline's `he_flight_he_ullage` what-if
(which patched the config's `ullage_gas` instead) to the last digit:

| he_flight | before (baseline) | now | move |
|---|---|---|---|
| total impulse | 24,239.8 N·s (pad; flight refused) | 24,235.2 N·s | -0.02 % |
| burn time | 3.4562 s | 3.4461 s | -0.29 % |
| mean / max thrust | 7,013 / 7,315 N | 7,033 / 7,316 N | +0.27 % / +0.02 % |
| Pc mean | 399.69 psia | 400.49 psia | +0.20 % |
| bottle at burnout | 1,646.3 psia | 1,648.2 psia | +0.11 % |
| tank peaks LOX / fuel | 618.4 / 619.0 psia | 618.3 / 619.0 psia | -0.1 / 0.0 psi |
| min ΔP/Pc LOX / fuel | 0.3634 / 0.3487 | 0.3657 / 0.3490 | +0.62 % / +0.09 % |
| chug margin min | 1.398 (0.05 s) | 1.407 (0.05 s) | +0.61 % |
| throat growth | 4.005 % | 4.020 % | +0.39 % |
| apogee AGL | flight failed | 3,249 m | — |

No figure moves more than 1 %. The GN2 drawing's flight is unchanged (nitrogen is the config's gas
already: same config bit for bit). The `he_flight` row of `baseline-2026-10-02.json` is superseded by the
`he_flight_he_ullage` row; the file is not regenerated (the golden test burns he_pad only).

**Preflight: nitrogen over LOX is refused for a hot fire** (coordinator decision on AUDIT D3-C). A `fail`
when the ullage's nitrogen (lockup less LOX's vapour pressure) is above nitrogen's saturation pressure at
the LOX temperature (CoolProp: 52.3 psia at 90 K); `ack_gn2_condensation` runs it anyway as a `warn`. The
492.5 psia warning (nitrogen's critical pressure) is gone. **gn2_pad and gn2_flight now need the
acknowledgement**: `scripts/layerx_baseline.py` passes it for those cases, and the tests that burn the
GN2 drawing pass it too. Their figures do not move.

**Opt-in, off by default, not measured into any baseline:** `chug_basis: drawing`, `chug_eroded`,
`card_eroded_nozzle`, `flight_coupling: inline` (LE4 He flown: 2 passes and 78 s against 4 passes and
160 s; impulse -0.006 %, mean thrust -0.015 %, apogee -0.03 m against the outer loop), and the start /
gas-ingestion diagnostic settings `fuel_lead_s`, `valve_travel_s`, `outlet_d_mm`.

## 2026-10-02 Phase 0 audit: no physics changed; baseline recorded

This was a read-only audit. No existing source file, config or drawing was edited. The findings and the decisions now waiting on the user are in [`AUDIT.md`](AUDIT.md).

**Files added:**
- `docs/layerx/AUDIT.md`
- `docs/layerx/CHANGELOG.md`
- `docs/layerx/baseline-2026-10-02.json`, which holds the recorded figures, the embedded config and the input hashes
- `scripts/layerx_baseline.py`, which regenerates the baseline
- `tests/test_layerx_golden.py`, 29 tests, run with `LAYERX_GOLDEN=1`

**Basis of the baseline:**
- Config: `configs/ethalox_6800N.yaml`, sha256 `7782d2fdd7f9f4dd…`. This is not the app document "Ethalox 7200N Doublet" (`ae3edfd7…`); see AUDIT D8.
- Code: `08b47c05-dirty`.
- Environment: Python 3.11.7, numpy 2.4.2, CoolProp 7.2.0, macOS arm64.
- Settings: default `LayerXSettings`. That means card engine, erosion replay on, dt 0.05 s, 300 s hold, thermal closures off, lockup 578 psia (dome 513.55 psig), and bottle 4500 psig as drawn.
- Reproducibility: results are bitwise identical across processes.

| metric | he_pad (`copv_study_he`) | gn2_pad (`copv_study_gn2`) |
|---|---|---|
| delivered total impulse | 24,239.8 N·s | 24,092.2 N·s |
| burn time | 3.4562 s | 3.5983 s |
| thrust mean / min / max | 7,013 / 6,769 / 7,315 N | 6,696 / 6,540 / 6,910 N |
| Pc mean (min-max) | 399.69 (391.1-405.2) psia | 382.89 (378.6-385.6) psia |
| O/F mean | 1.5211 | 1.5157 |
| Isp delivered | 225.39 s | 223.76 s |
| bottle at burnout (over lockup) | 1,646.3 psia (1,068.2 psi) | 1,204.3 psia (626.1 psi) |
| pressurant used | 0.0906 kg He | 0.7111 kg N2 |
| tank peak LOX / fuel | 618.4 / 619.0 psia | 578.1 / 580.6 psia |
| tank min while firing (ignition dip) | 574.4 / 574.4 psia (3.6 / 3.7 psi) | 552.9 / 553.0 psia (25.0 / 25.3 psi) |
| min ΔP/Pc LOX / fuel (t ≥ 0.2 s) | 0.3634 / 0.3487 | 0.3542 / 0.3365 |
| chug margin min (time) | 1.398 (0.05 s) | 1.355 (0.70 s) |
| depleted side; residual of the other | LOX; 0.0579 kg fuel | LOX; 0.0423 kg fuel |
| throat area growth (recession) | 4.005 % (0.474 mm) | 4.046 % (0.479 mm) |
| passes; converged; failed steps | 2; yes; 0 | 2; yes; 0 |

**Other baseline cases:**
- **he_flight.** The flight was refused with "COPV holds 0.208 kg; … needs 0.521 kg", because the refill is sized for nitrogen (AUDIT D2). The run reports the pad burn as converged.
- **gn2_flight**, the run the UI produces by default: 24,088.1 N·s, 3.5885 s, mean thrust 6,713 N, apogee 3,125 m AGL.
- **What-if, He ullage gas:** 24,235.2 N·s, 3.4461 s, apogee 3,249 m AGL.

**Known sensitivities of the baseline:**
- **Time step (he_pad).** dt 0.1 s moves impulse +0.078 %. dt 0.02 s moves it −0.056 % and the chug minimum −0.58 %.
- **App document instead of the YAML (he_pad).** Throat growth 5.69 % (+42 % relative), chug minimum 1.367, mean thrust +0.31 %, Pc −0.41 %, impulse −0.03 %.
