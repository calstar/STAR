# Hotbench demo runbook

Hotbench (a STAR project) is three apps that share one engine and one stand:
**Hotbench P&ID** draws the stand, **Hotbench Engine** designs the engine and burns
it on the drawing (Layer X), and **Hotbench Twin** runs the stand live like the real
console. The demo runs all three on their own ports over a copy of the team's data,
so nothing clicked in a demo reaches the team's real designs or the dev servers on
5173/5174/5177. Every pressure on screen is psia; differences (bias, droop, a drop
across a part) are plain psi.

**The drawing is LE4 (6).** It is the one the demo, the rehearsal and every number
below were run on. The team also has LE4 (1) under the stand "LE4(real)"; which of
the two is the stand is the team's call (`decisions-needed.md`, item 3).

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
   last lines it prints should name the featured stand, `pulled le4-stand ->
   a22f706b60be`, and both aborts closing Fuel Press, Fuel Main, LOX Press, LOX Main.
2. Run `scripts/demo.sh --status`. Check for six healthy rows, two "reachable" rows,
   "Layer X feedtwin available" and the "curated" line.
3. Open the three apps in one Chrome window, **one tab each**, and prepare them:
   - **Hotbench Twin:** a fresh browser opens on **LE4 (6)** (the featured stand).
     The top bar should read `LE4 (6) · Ethalox 7200N Doublet`. If it shows another
     drawing, click **LE4 (6)** in the Library.
   - **Hotbench Twin, top bar:** click **HE** in the GN2 · | HE switch (the dot marks
     the drawing's own gas, GN2). Click **GN2** to compare; each burn's run record
     says which gas it ran on.
   - **Hotbench Twin, Console:** set the history window to **10 s**, and scroll so the
     **ENGINE** panel is in view. A 4 s burn is lost in a longer window.
   - **Hotbench Engine, Layer X:** check that **Drawing** says **LE4 (6)** (a fresh
     browser opens on it) and set **Pressurant** to **He** (or GN2 to compare; GN2
     runs too, with a "condensation not modelled" caveat).
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

**0:00 Hotbench P&ID (5274).** It opens on **LE4 (6)**, the team's main diagram and the
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

**1:00 Hotbench Engine (5273).** The design is **Ethalox 7200N Doublet**. On
**Forward Mode**, click **Evaluate** (tanks at 578 psia). In a few seconds it shows
chamber pressure, Isp, chug margin and cooling, plus an independent CEA check.

**2:00 Layer X tab.** Check that **Drawing** says **LE4 (6)**. Set **Pressurant** to **He**
or **GN2**; both run. Click **Run burn**, which takes under a
minute. The overview shows mean thrust, burn time, apogee, a limits table, and what
the design assumed against what the feed delivered.

**3:30 Hotbench Twin (5277), Console.** Press **T-0**: the tanks load to the fire
mass and prime at regulator lockup. Then press **FIRE**. The pressures and thrust move
live through the 4 s burn, and the console goes to Vent at burnout.

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

Measured on the demo stack after `--reset` on 2026-10-17 (morning, after the night's
fixes), headless at 1920x1080, from a fresh browser: T-0, then FIRE, on helium.

| Where | Result |
|---|---|
| Hotbench Engine, Forward Mode | chamber 397 psia, Isp 224.5 s, O/F 1.51 (not re-read this morning) |
| Layer X, LE4 (6), helium | 6,779 N mean (6,604-6,993), 3.56 s, 24.13 kN·s, chamber 389 psia, Isp 223.7 s, O/F 1.51, apogee 3,228 m; **Breaks 1 limit: rail exit speed 22.1 m/s** against the 25.9 m/s FAR-OUT rule |
| Hotbench Twin, LE4 (6), helium | 6,709 N mean (peak 6,875), 3.58 s, 24.02 kN·s, chamber 388 psia, Isp 224 s, O/F 1.52; LOX-Tank ran dry, Vent at burnout |
| Hotbench Twin, LE4 (6), drawing's GN2 | 5,732 N mean, 4.06-4.08 s (measured before the knob fix, D-20; not re-read) |

The Twin's helium burn ran in about 7 s of wall time. Auto to Ready at x20 does not
reach Ready on LE4 (6): the loads run at about x7 (Ox Fill took 1,060 s of stand time
in 150 s), then the guide stops at "Press LOX: dome not loaded, so the regulator is
shut; open the dome line on the P&ID tab" -- no state in the DAQ's table opens the dome
line (DR-CTRL-R, D-77). With the press valves open the stand ran at x2.7. Use T-0.

The Layer X failure on rail exit is the design's, not the demo's: say so if it is on
screen (`decisions-needed.md`; the airframe in the design is a template).

Do not quote helium against GN2 without saying it rests on an assumed regulator
droop that the September water flows contradict (`decisions-needed.md`, item 2).
Do not quote one thrust as "the engine's": the names and targets disagree
(`decisions-needed.md`, item 1).

### Avoid on stage

- **Auto to Ready.** It is slow (see the table above) and LE4 (6) has no state that
  loads the dome (D-77). Use **T-0**.
- **ENG ABORT.** On the demo stand it now shuts the mains and the press valves (see
  "The stand's state table" below), but nothing on stage needs it.
- **The "LE4" stand document.** Open the drawing **LE4 (6)** from the Library, not
  the older stand document of the same name.
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

- **Hotbench Twin library:** the drawings LE4 (6) (featured), Ethalox Stand, Copv
  Study He and Copv Study Gn2, plus the engine with its Hotbench Engine card. The
  stand drawing and the engine are byte copies of the twin's bundled sample
  (`feed-twin/backend/sample`). In the demo copy only, the engine is named after its
  design, **Ethalox 7200N Doublet**; the team's library still calls it "ethalox 6800N
  doublet 578psia 2026-10-05 drilled" (which name is right is `decisions-needed.md`,
  item 1). LE4 (6) carries a saved hookup: the suggested wiring, unchanged, plus the
  stand's own state table (below). There is one stand document, **LE4**, on that
  drawing and engine; its own hookup carries the same table. Runs: only the team's
  three lit October 7 burns on them; rehearsal runs are cleared by `--reset`.
- **Hotbench P&ID:** **LE4 (6)** (the same drawing, by the same name as in the twin and
  Layer X, set as the main diagram; `PID_STAND_NAME` in `scripts/demo.sh`),
  LE4 (the September draft) and Ethalox Stand 7200N (Helium).
- **Hotbench Engine:** **Ethalox 7200N Doublet**, plus Layer X's stand measurements and
  DAQ channel map.

To change the set, edit the lists at the top of `scripts/demo.sh` and run
`scripts/demo.sh --reset`.

## The stand's state table

The demo's LE4 stand does not run the DAQ's table as shipped. As the DAQ reads
`feed-twin/backend/statemachines/diablo_actuators.csv`, **Engine Abort** and
**Emergency Abort** command the main valves and the press valves **open**
(`NEEDS-REPAIR.md`, "The actuator table has its own problems"): an abort on a loaded
stand keeps feeding the engine, and the twin shows it doing so. That is the right
thing for a rehearsal of the real stand, and the wrong thing to have one click away
in front of investors.

So the demo stand has its own table: the DAQ's, with exactly eight cells changed and
nothing else.

| State | Was OPEN, now CLOSE | Still OPEN (unchanged) |
|---|---|---|
| Engine Abort | Fuel Press, Fuel Main, LOX Press, LOX Main | Fuel Vent, LOX Vent, LOX Dump, GN2 Vent |
| Emergency Abort | Fuel Press, Fuel Main, LOX Press, LOX Main | Fuel Vent, LOX Vent, LOX Dump, GSE High Press Vent, GN2 Vent |

Every other state, every transition, the ragged transition rows and the Idle row are
the DAQ's as the twin reads them (the twin still holds Idle shut, as it does for any
table). The DAQ's CSV files are not touched; the change lives only in the demo data:

- saved as the hookup of LE4 (6)'s lineage (`name:LE4`) in the demo library, so every
  fresh stand on LE4 (6) runs it. The wiring is the twin's suggestion, unchanged: the
  curation step checks that the saved hookup binds every actuator to the same valve
  as before, and refuses to finish otherwise;
- written into the stand document **LE4**'s own hookup too (a stand that carries a
  hookup without a table would run the DAQ's).

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

There is no saved DAQ box (wired hookup) for LE4 (6): the LE4 DAQ wiring is not on
the drawing (D-77), so the stand runs on the suggested name matching.
