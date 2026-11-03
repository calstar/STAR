# Walkthrough on LE4 (3) rocket GN2, 2026-11-01

The investor demo moved to the team's test stand, **LE4 (3) rocket GN2**: drawing LE4 (3),
rocket only, nitrogen, COPV charged to 3,765 psia, and the drilled 6800N doublet with its
Hotbench Engine card. The stand was then run the way an operator would run it, from a fresh
browser on the demo Twin (5277). Every step was a click on the console: Armed, Ox Fill
(at ×20), Fuel Fill, the COPV charge, **Dome Press**, Fuel Press, the COPV top-up, Ox Press
(at ×1, last; W9), Ready, FIRE, and the vent at burnout. Engine, Plots and Runs came after.
The video `hotbench-investor/video/hotbench-le4-3-demo.mp4` is that same run, recorded in
headless Chromium by `video/record.mjs`. Every wait in it is read off the console's own pad
guide.

## Fixed

| # | Where | What an operator saw | Fix |
|---|---|---|---|
| W1 | Fresh browser on the demo Twin | It opened on LE4 (6) with an engine labelled "Ethalox 7200N Doublet": the bundled sample, not the team's stand. | Twin stands can be featured (`backend/routers/stands.py`, `featured=True`). A browser that remembers no stand and no drawing opens the featured one (`stand.tsx`, `landOnStand`), and so does `/?stand=<id>`. Both are opened before a drawing is picked, so the sample never flashes up first. `scripts/demo.sh` seeds LE4 (3) and the stand, features it, gives Layer X a sample set of its own (`LAYERX_SAMPLE`), and edits the stand's own table instead of replacing it, so the abort rows close the valves and Dome Press survives. |
| W2 | Pad guide, Ox Fill | With the wall cold and LOX collecting, it still read "LOX loading; the wall chills first, so keep venting". | The line shows only after the chill, which has its own line. It now reads "LOX collecting; the vent stays open for the boil-off". |
| W3 | Pad guide, after Fuel Fill | "Next, charge copv: press **Armed** → GN2 High Press". GN2 High Press is not reachable from Armed, so pressing it did nothing. | The hint names the whole route: **Armed** → Press Standby → GN2 High Press. |
| W4 | Pad guide, after Ox Press | The LOX press drew the rocket-only COPV down from 3,767 to 3,168 psia. The guide went from 4/9 back to 2/9, "charge copv". | A charge already spent on a press stays done (`chargeDone`); topping it up is the later phase's job. |
| W5 | Pad guide, Ox Press ↔ Fuel Press | A pressed tank's ullage cools after its solenoid shuts: the fuel tank fell from 565.7 to 559.7 psia while the LOX tank was pressed, and the LOX tank fell from 553 to 500 psia while the fuel was pressed. Against the 3 psi band, the guide sent the operator back and forth while the COPV ran down. | A phase that has been reached stays done until it slips past 15 %, the same margin the guide already uses after Ready (`phaseDone`). Fire opens both press valves and takes the sag back. Tests in `src/lib/padGuide.test.ts`, each checked failing against the old rule. |
| W9 | Pad guide, press order on GN2 | The guide pressed the LOX first. The recording's second take followed it at ×20. Ox Press took the LOX tank to 554 psia and drew the COPV from 3,744 to 3,066 psia. Once the solenoid shut and Fuel Press began, the LOX tank fell to 340 psia in 35 s of stand time, to 245 in 70 s, and settled near 170 psia at 96 K. The warm GN2 had cooled onto the freshly chilled wall and the LOX. Past the 15 % slip, the guide sent the operator back to "press LOX", and every later step would have waited on it. A burn fired from there lights on a collapsed LOX ullage that the regulator must refill. | The guide now presses the fuel, tops up the COPV, then presses the LOX **last**, straight before Ready (`PAD_ORDER`). It also no longer walks back past a phase once a later one has been reached: the LOX press leaves a rocket-only COPV at 81 % of its charge, and topping it up again let the LOX collapse while the bottle filled. Whatever has sagged by Ready is reported there, as before. A T-0 rehearsal never shows this: T-0 primes the tanks with the gas already settled, and held at Ready on GN2 the LOX tank only drifts from 544.6 to 516.8 psia. Through the pad sequence at ×1 it falls from 552.0 to 179.9 psia in 77 s (`hotbench-investor/data/le4-3_lox_hold.json`, from the console's own Download CSV). The end point checks by hand: nitrogen at 552 psia and 302 K, cooled at constant density to the 110.9 K the twin reaches, is 164.2 psia (CoolProp), plus 15.2 psia of oxygen vapour over 90.5 K LOX, 179.4 psia. The rate rides on the assumed wall and surface heat transfer and on both tank diameters, which the drawing leaves out (152 mm assumed). Nitrogen's condensation on LOX is not modelled and would only deepen the fall. The recording drops the warp to ×1 for the LOX press, as an operator would. Tests in `src/lib/padGuide.test.ts`, checked failing without the rule. |
| W11 | Top bar, Pressurant switch | A fresh browser opens the featured stand read only, and the GN2 · HE switch sat greyed out with no word why. Recording the helium hold, the click simply never landed. | The disabled button says "Take the stand (Edit, top bar) to change its gas", and so does the switch's own hover, since some browsers show no title on a disabled button (`TopBar.tsx`). |
| W15 | Pad guide, load order | The guide loaded the LOX first, then the fuel, so the loaded LOX sat boiling off and building pressure through the whole fuel load. The team loads fuel first. | The guide's first phase is now Load fuel, then Load LOX, then the COPV charge (`PAD_ORDER`, `PadSequence.tsx`). Test in `src/lib/padGuide.test.ts`, red against the old order. The demo video follows it. |

## Open

| # | Where | What | Why it is not fixed here |
|---|---|---|---|
| W6 | Console, PC gauge at rest | An unlit chamber reads 13.6 psia; every other gauge reads 14.7. The engine card was sampled at its design site's ambient, 94.07 kPa (`ambient_pa_sampled`), and the cockpit installs the card there (`assembly.py`, `card.install(engine)`). The tanks and vents sit at 101.325 kPa. | Which site the stand is at is a physics choice, and it moves thrust by about (101.3 − 94.1) kPa × A_exit. One ambient for the whole stand is the team's call. |
| W7 | Runs, Explain | The pad burn replays at 6,152 N against the 6,136 N it recorded; the T-0 burn replays at 6,152 against 6,149. The replay (`main.py _replay`) primes both tanks at their *mean* T-0 pressure with fresh LOX. It drops the pad run's split pressures (569 / 532 psia) and its warmed LOX (114 K against 90 K after an hour at pressure), so the ladder cannot see what the pad hold cost. | Applying per-tank pressure and liquid temperature means extending `BurnPlan` in the library: a physics change, with the benchmark to run. |
| W8 | Console, time warp | ×20 asked, ×6 to ×11 delivered during the loads. The top bar says so. | The solver is the limit, as `docs/PHYSICS-BENCHMARK.md` 3.10 describes. |
| W10 | Plots, Download CSV; console, Pressure history 5 min | A session keeps its last 4,000 samples (`HISTORY`, `lib/feedtwin/feedtwin/session/core.py`), which is 80 s of stand time on the 0.02 s grid. The CSV asks for an hour and the console offers a five-minute window, but after a pad run both hold only the burn and the last minute before it. The fill, the chill and the presses are gone. | Keeping a whole pad run means thinning older samples or storing them elsewhere: a library change to every session's memory, with the console's plots reading it. |
| W12 | Pad guide, Ox Fill | The guide moves on once the LOX reaches 95 % of the fire load (`LOADED_OF_TARGET`). A pad burn carries 6.48 kg of LOX against T-0's 6.61, so it burns 0.11 s shorter and about 2 % less impulse than a T-0 burn of the same stand. | Whether the crew tops the LOX to 100 % before pressing, or the guide should wait for it, is a procedure call for the team. |
| W13 | Runs, What changed | Compared across a stand edit (the ox vent MOV and Dome Press), the diff lists 17 rows of `machine table · allowed · <state>` before anything physical. | Correct, but noisy. Grouping a changed table into one row is a Runs change; the recording now picks the newest T-0 burn, and stops if there is none. |
| W14 | Checks tab, LE4 (3) | Two fixes on the drawing: the COPV is drawn as a TANK (read as a bottle; draw it as a KBOTTLE), and segment `node_15-node_38 seg_1` has no bore, so it adds no loss. 120 numbers run on defaults; both tank diameters are 152 mm by assumption. | The drawing is the team's: the twin never infers what it leaves out. |

## Numbers

From the final recorded take (fresh browser on the demo Twin, the full pad sequence, then FIRE, on GN2),
against a T-0 burn of the same stand version, as the Runs tab compares them:

| | Pad burn (22:54) | T-0 burn (22:37) |
|---|---|---|
| Bottle at Fire | 3,219.2 psia | 3,764.7 psia |
| Tanks at Fire, fuel / LOX | 495.9 / 487.5 psia | 544.6 / 542.1 psia |
| LOX aboard | 6.480 kg | 6.611 kg |
| Mean thrust | 6,196.2 N | 6,149.9 N |
| Impulse | 23,214.7 N·s | 23,697.2 N·s |
| Burn time | 3.747 s | 3.853 s |
| Mean Pc | 362.1 psia | 359.6 psia |
| O/F, Isp | 1.509, 220.6 s | 1.510, 220.3 s |

The pad burn starts lower in the tanks yet runs 46 N harder: its bottle, drawn down by the presses,
sits lower, and by the regulator's supply effect (outlet = dome + bias − S × inlet) a lower inlet raises
the outlet. The Study tab says the same from the other side: at dome 549.7 psia, COPV charges of 2,500
to 4,515 psia give 6,280 to 6,068 N (`hotbench-investor/data/le4-3_copv_sweep.json`).

Layer X on the same stand, with nozzle erosion and flight switched off to match, fires 6,149 N
over 3.86 s (23.73 kN·s): the T-0 burn to 0.01 %.

Dome sweep (Study tab, 10 burns in 34 s, COPV 3,764.7 psia, `data/le4-3_dome_sweep.json`): helium
5,974 to 7,485 N from 480 to 620 psia, about 10.8 N per psi, 6,800 N at 554.7 psia; nitrogen 5,483 to
6,782 N, about 9.3 N per psi, 6,800 N at about 622 psia (just past the sweep). At 550 psia nitrogen
gives up 595 N: its tanks sag to about 492 psia through the burn where helium holds about 540.

None of this is validated against the stand. Droop and the supply effect are assumed; nitrogen's
condensation on LOX is not modelled.
