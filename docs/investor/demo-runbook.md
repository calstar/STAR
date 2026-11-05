# Hotbench demo runbook

Hotbench (a STAR project) is three apps that share one engine and one stand:
**Hotbench P&ID** draws the stand, **Hotbench Engine** designs the engine and burns
it on the drawing (Layer X), and **Hotbench Twin** runs the stand live like the real
console. The demo runs all three on their own ports over a copy of the team's data,
so nothing clicked in a demo reaches the team's real designs or the dev servers on
5173/5174/5177. Every pressure on screen is psia; differences (bias, droop, a drop
across a part) are plain psi.

**The stand is LE4 (3) rocket GN2** (since 2026-11-01): the drawing LE4 (3), rocket
side only (the drawn GSE cut away, its vents kept), nitrogen, the COPV charged to
3,765 psia, and the engine **Ethalox 6800N Doublet (drilled)** with its Hotbench
Engine card. Its own hookup puts every valve and transducer on the DAQ's connectors,
and its own state table adds a **Dome Press** state that loads the dome regulator's
control. It is the team's test stand, and the featured stand: a fresh browser on the
Twin opens on it, and Layer X lists LE4 (3) as the team's stand. LE4 (6), the twin's
bundled sample and the demo's stand until November, is not in the demo data.

## Bring it up

```bash
cd ~/Downloads/STAR_ASF/STAR
scripts/demo.sh             # for the live demo: no auto-reload
```

It waits until all six services answer (about 10 s warm, a minute or two cold),
then prints:

| App | URL |
|---|---|
| Hotbench P&ID | http://localhost:5274 |
| Hotbench Engine | http://localhost:5273 |
| Hotbench Twin | http://localhost:5277 |

`scripts/demo.sh --status` says what is up and whether the apps see each other.
`scripts/demo.sh --stop` stops it.

## Ten minutes before

1. **Clean slate:** `scripts/demo.sh --reset` moves the old demo data aside, copies
   the curated set again and curates it through the apps (about 10 s warm). Rehearsal
   burns, a stray edit on the drawing and anything deleted are all undone by it. The
   last lines it prints should name the featured stand `local/le4-3-rocket-gn2`,
   `pulled le4-3 -> 32fd54aa4fd9`, both aborts closing Fuel Press, Fuel Main, LOX
   Press, LOX Main, and the stand's own table "aborts closed (keeps Dome Press)".
2. Run `scripts/demo.sh --status`. Check for six healthy rows, two "reachable" rows,
   "Layer X feedtwin available" and the "curated" line.
3. Open the three apps in one Chrome window, **one tab each**, and prepare them:
   - **Hotbench Twin:** a fresh browser opens on the stand **LE4 (3) rocket GN2**
     (the button at the right of the top bar). The top bar should read
     `LE4 (3) · Ethalox 6800N Doublet (drilled)` and `ROCKET ONLY`. If it shows
     another stand, click that button and pick **LE4 (3) rocket GN2**, or open
     http://localhost:5277/?stand=le4-3-rocket-gn2.
   - **Hotbench Twin, top bar:** the stand runs on **GN2**. Click **HE** in the
     GN2 · | HE switch to compare; each burn's run record says which gas it ran on.
   - **Hotbench Twin, Console:** set the history window to **10 s**, and scroll so the
     **ENGINE** panel is in view. A 4 s burn is lost in a longer window.
   - **Hotbench Engine, Layer X:** check that **Drawing** says **LE4 (3)** (a fresh
     browser opens on it, as the team's stand) and set **Pressurant** to **GN2**
     (it runs with a "condensation not modelled" caveat; He to compare).
   - The browser remembers these. The first stand build takes about 30 s, so do it
     now rather than in front of anyone.

## Five minutes before

1. **Nobody else opens the demo.** Close every other tab on 5273, 5274 and 5277, on
   this machine and any other, and stop any agent working against them. A second
   viewer of Hotbench Twin can take the live stand from yours.
2. **Last step, always:** `scripts/demo.sh --restart --no-reload`. It turns off
   auto-reload (so a code edit cannot restart an API mid-demo) and gives the stand a
   fresh process. Reload the three tabs after it.

## The five-minute click path

**0:00 Hotbench P&ID (5274).** It opens on **LE4 (3)**, the team's main diagram and the
same drawing the twin and Layer X fire,
read to anyone and held by no one: the bar says **Ready to edit**, and the first
change you make checks it out (**Stop editing** gives it back). The Rocket page opens
at full size on its top, the press section: the COPV, dome regulator and fuel tank, each
pressure printed in psia. Scroll down for the LOX tank and engine (**Fit View** shows the
whole page). Click
**GSE** at the bottom to show the ground cart. Double-click a symbol (the COPV, say):
each number is marked **Estimate** or **Verified**, so you can see where it came from.
Press **Cancel**. The checks button (top right) lists what **the drawing needs** --
sizes, fluids, mates the team has not filled in yet -- apart from anything to fix:
the twin stands a stated default in for each and says so. If a symbol moves by
accident, press Cmd+Z.

**1:00 Hotbench Engine (5273).** The design is **Ethalox 6800N Doublet (drilled)**. On
**Forward Mode**, click **Evaluate** (tanks at 578 psia). In a few seconds it shows
chamber pressure, Isp, chug margin and cooling, plus an independent CEA check.

**2:00 Layer X tab.** Check that **Drawing** says **LE4 (3)**. Set **Pressurant** to **GN2**
or **He**; both run. Click **Run burn**, which takes under a
minute. The overview shows mean thrust, burn time, apogee, a limits table, and what
the design assumed against what the feed delivered.

**3:30 Hotbench Twin (5277), Console.** Press **T-0**: the tanks load to the fire
mass and prime at regulator lockup. Then press **FIRE**. The pressures and thrust move
live through the 4 s burn, and the console goes to Vent at burnout.

With time, run the pad instead of T-0. The guide above the state buttons names
each next state, and the whole route to it (**Armed → Press Standby → GN2 High
Press**): Armed, Ox Fill (set the warp to **×20**; the wall chills, then the LOX
collects), Armed, Fuel Fill, Armed, Press Standby, GN2 High Press, Press Standby,
**Dome Press** (the dome loads; the DR-PT-R gauge, "GN2 Regulated", reads about
550 psia), Press Standby, Fuel Press, the COPV top-up, then set the warp to **×1** and
Press Standby, **Ox Press last**, Ready, FIRE without a pause. On GN2 a pressed LOX tank
collapses as soon as its solenoid shuts: 554 to 340 psia in 35 s of stand time, as the
warm nitrogen cools onto the chilled wall. So the guide presses the LOX last
(walkthrough W9). It takes about eight minutes of wall time, most of it the LOX load;
`video/hotbench-le4-3-demo.mp4` is that run cut to a minute.

If someone asks why the Twin's thrust is not exactly Layer X's: *"Both prime the tanks at
the regulator's lockup off the drawn dome, 541 psia, and land within about 1 %. Layer X
fires the instant it has primed; on the console the stand sits between T-0 and FIRE for
as long as I take. Started from the same T-0 they agree to a hundredth of a percent;
there is a test that holds them to it."*

**4:30 Engine, then Runs.** **Engine** is the burn report. In **Runs**, every burn
is a record, and you can pick two to compare. A `*` after a run's commit means it ran
from a working tree with changes not yet committed, which the demo does; hover it and
it says so.

### Numbers to expect

Measured on the demo stack on 2026-11-01, through the frontends, on **LE4 (3) rocket GN2**
(dome 549.7 psia, COPV 3,764.7 psia, nitrogen, the drilled 6800N doublet's card):

| Where | Result |
|---|---|
| Hotbench Twin, T-0 then FIRE | 6,150 N mean, 3.85 s, 23.70 kN·s, chamber 360 psia, Isp 220 s, O/F 1.51; LOX-Tank ran dry, Vent at burnout |
| Hotbench Twin, the pad sequence then FIRE | 6,196 N mean, 3.75 s, 23.21 kN·s, chamber 362 psia: the bottle sits at 3,219 psia after the presses (supply effect) and the guide moves on at 95 % of the LOX load |
| Layer X, LE4 (3), erosion and flight off | 6,149 N mean, 3.86 s, 23.73 kN·s, LOX ran out: the Twin's T-0 burn to 0.01 % |
| Layer X, LE4 (3), as it opens (erosion and flight on) | 6,214 N mean, 3.83 s, 23.81 kN·s, apogee 3,090 m; **Breaks 1 limit: rail exit speed 21.2 m/s** against the 25.9 m/s FAR-OUT rule; chug margin 1.00 and tank sag 51.6 psi to check |
| Study tab, dome 480–620 psia, both gases | 10 burns in 34 s; helium 10.8 N/psi, 6,800 N at 554.7 psia; nitrogen 9.3 N/psi, about 622 psia |

The full pad sequence at ×20, with the LOX press at ×1, is about three minutes of wall time;
the burn itself runs at real time. On GN2 a pressed LOX tank falls from 552 to 180 psia in
77 s once its solenoid shuts, so Ox Press goes last and FIRE follows Ready without a pause
(`walkthrough-2026-11-01.md`, W9).

The Layer X failure on rail exit is the design's, not the demo's: say so if it is on
screen (`decisions-needed.md`; the airframe in the design is a template).

Do not quote helium against GN2 without saying it rests on an assumed regulator
droop that the September water flows contradict (`decisions-needed.md`, item 2).
Do not quote one thrust as "the engine's": the names and targets disagree
(`decisions-needed.md`, item 1).

### Avoid on stage

- **Auto to Ready.** It works on LE4 (3) rocket GN2 (the stand has a Dome Press
  state), but the LOX load alone is minutes. Use **T-0**, or run the pad by hand.
- **ENG ABORT.** On the demo stand it now shuts the mains and the press valves (see
  "The stand's state table" below), but nothing on stage needs it.
- **A second viewer or tab** on any of the three apps.
- **Hotbench Twin Library ×** removes an artifact, and **Hotbench P&ID Clear page**
  empties a page. Both only touch the demo copy, and `scripts/demo.sh --reset`
  brings it back.

## If something is down

| Symptom | Do this |
|---|---|
| A page is blank or says "not connected" | Reload the browser tab. |
| You can't tell what is wrong | Run `scripts/demo.sh --status`. |
| One service is dead | Run `scripts/demo.sh --restart` (about 10 s; it keeps the reload setting). |
| You need to see why | Run `scripts/demo.sh --logs feedtwin-api`. The other services are `engine-api`, `pid-api`, `engine-ui`, `pid-ui` and `feedtwin-ui`. The log files are in `~/Downloads/STAR_ASF/hotbench-investor/demo-logs/`. |
| "port N is taken by something else" | Something that isn't the demo holds the port. Stop it, or move the demo with `DEMO_FEEDTWIN_UI_PORT=5377 scripts/demo.sh` (any `DEMO_*_PORT`). |
| Data looks wrong, or something was deleted | Run `scripts/demo.sh --reset`. |
| The demo will not come up at all | The dev stack (5173/5174/5177) runs the same code on the team's live data. Show it read-only, and delete nothing there. |
| Hotbench Engine's own debug log | It is in `demo-logs/engine-design/evaluate.log`, not in the repo; the engine-api log keeps warnings only. |

## What is in the demo data

Everything lives in `~/Downloads/STAR_ASF/hotbench-investor/demo-data`. The data was
copied, never moved, from the team's stores. `SEED.json` there lists what was kept
and what was left out.

- **Hotbench Twin library:** the drawings LE4 (3), Ethalox Stand, Copv Study He and
  Copv Study Gn2, plus the engine with its Hotbench Engine card (a byte copy of the
  twin's bundled sample, `feed-twin/backend/sample`). In the demo copy the engine is
  named after its design, **Ethalox 6800N Doublet (drilled)**. One stand document,
  **LE4 (3) rocket GN2**, featured (`.site/stand/featured.json` in the demo's
  userdata; `FEEDTWIN_STANDS` in `scripts/demo.sh`). Runs: the team's two lit T-0
  burns on it; rehearsal runs are cleared by `--reset`.
- **Hotbench P&ID:** **LE4 (3)** (the same drawing, by the same name as in the twin and
  Layer X, set as the main diagram; `PID_STAND_NAME` in `scripts/demo.sh`),
  LE4 (the September draft) and Ethalox Stand 7200N (Helium).
- **Hotbench Engine:** **Ethalox 6800N Doublet (drilled)**, plus Layer X's stand
  measurements and DAQ channel map. Layer X's "team's stand" is LE4 (3): the demo
  gives it a sample set of its own (`demo-data/layerx-sample`, `LAYERX_SAMPLE`).

To change the set, edit the lists at the top of `scripts/demo.sh` and run
`scripts/demo.sh --reset`.

## The stand's state table

The demo stand does not run the DAQ's table as shipped. As the DAQ reads
`feed-twin/backend/statemachines/diablo_actuators.csv`, **Engine Abort** and
**Emergency Abort** command the main valves and the press valves **open**
(`NEEDS-REPAIR.md`, "The actuator table has its own problems"): an abort on a loaded
stand keeps feeding the engine, and the twin shows it doing so. That is the right
thing for a rehearsal of the real stand, and the wrong thing to have one click away
in front of investors.

So the demo stand runs its own table: the stand's (the DAQ's plus the **Dome
Press** state and its **Dome Control** row), with exactly eight more cells changed.

| State | Was OPEN, now CLOSE | Still OPEN (unchanged) |
|---|---|---|
| Engine Abort | Fuel Press, Fuel Main, LOX Press, LOX Main | Fuel Vent, LOX Vent, LOX Dump, GN2 Vent |
| Emergency Abort | Fuel Press, Fuel Main, LOX Press, LOX Main | Fuel Vent, LOX Vent, LOX Dump, GSE High Press Vent, GN2 Vent |

Every other state, every transition, the ragged transition rows and the Idle row are
the DAQ's as the twin reads them (the twin still holds Idle shut, as it does for any
table). The DAQ's CSV files are not touched; the change lives only in the demo data:

- edited in the stand document **LE4 (3) rocket GN2**'s own hookup: its own table,
  Dome Press and all, with the abort rows closed (curation edits a stand's table,
  never replaces it);
- saved as the hookup of LE4 (3)'s lineage (`name:LE4`) in the demo library too (the
  DAQ's table with the abort rows closed), for LE4 (3) opened without the stand. The
  wiring is the twin's suggestion, unchanged: the curation step checks that the saved
  hookup binds every actuator to the same valve as before, and refuses to finish
  otherwise.

`scripts/demo.sh` does this through the twin's API after every fresh seed
(`_curate`; `DEMO_ABORT_STATES` and `DEMO_ABORT_CLOSES` at the top of the script),
starting from the table the twin reads from the DAQ's files at that moment. On the
State machine tab the table shows as edited, and the two "commands Fuel Main, LOX Main
OPEN" table notes are gone; the other eight notes (Idle, the ragged rows, the Fire
bypasses) remain because those rows are the DAQ's. Checked on a live session: in
Engine Abort, Fuel Main, LOX Main, Fuel Press and LOX Press read closed, and Fuel
Vent, LOX Vent and LOX Dump read open.

The real fix is the DAQ's file, with the DAQ team (`decisions-needed.md`). Also the
DAQ's: **Vent** opens Fuel Press and LOX Press with the vents, so after burnout the
COPV keeps emptying through the tank vents (PT-HP-1 read 51 psia two seconds into
Vent in the rehearsal). That row was left as it is.

The stand carries a wired DAQ box: valves on the sol12/sol24 connectors by the DAQ's
names, the low-pressure transducers on PT board 1, the COPV transducer on PT board 2.
