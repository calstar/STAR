# Getting started with feed-twin

For an engineer opening the twin for the first time. Thirty minutes, start to
a recorded burn. Words in **bold** are in the [glossary](GLOSSARY.md).

## 0. Run it

```bash
bash feed-twin/setup.sh        # once: venv, the physics library, the design store, npm
cd feed-twin && ./dev.sh       # API on :8003, UI on :5177
```

Open http://localhost:5177. The tabs are in three groups: **Operate** (Console,
P&ID, GSE Controls, Plots), **Results** (Engine, Runs, Study, Solver) and **Set
up** (Library, Hookup, Configuration, Checks). The line under them is the
stand's health, the time warp (×1 / ×5 / ×20 to wait out a load; Fire always
runs at ×1), the stand clock, the drawing and engine, and "not validated":
hover it for what the model has been checked against. Until the stand's own
data has been compared against it, every number here is a prediction.

## 1. Pick or make a stand

A **stand** is the whole set-up as one shared document: the drawing, the
engine, every setting, the hookup and where the regulator knobs sit.

* **Stand → + New stand** saves what the cockpit has now under a name.
* **Share** it from the same dialog. The people you share it with can edit it
  (one at a time: whoever holds the **checkout**) and see its runs.
* **Save as release…** freezes a named version ("TRR rev B") that nothing can
  change afterwards.

Without a stand the cockpit still works. Its runs then go in your own list.

## 2. Check the drawing was read the way you meant

* **Checks**: what is worth fixing on the drawing, what the twin had to fill
  in because the drawing left it blank, and (folded) how it read the drawing.
  The tab's number counts only the first. Fix it on the drawing
  (pid-designer), not here.
* **P&ID → Symbols**: every symbol on the drawing. Tick **console** to show it
  on the console, give it a **console name**, and for a valve pick the
  state-machine actuator that **drives** it; Save at the top (wiring restarts
  the stand). Its numbers are here too: **edit** one to override it, with a
  source and a reference. Imported drawings are matched by name; check them.
* **Hookup**: which knob on GSE Controls sets which regulator.
* **GSE Controls → Ignore the drawn GSE**: run the rocket alone, filled by the
  built-in charge and loads at the settings on that page, when the cart on the
  drawing is more than you need.
* **Configuration**: every number the twin assumes, with what it stands for.
  Change one here and the next run records it.

Pressures on a drawing are gauge unless they say `psia` (chamber pressure on
the ENGINE symbol is absolute). Differences such as bias, droop and crack take
plain `psi`. See [ADR 0004](../../docs/adr/0004-pressure-references.md).

## 3. Run the stand

Walk the state machine as you would at the pad: fills, press, Ready, Fire.
The state to press next is ringed on the grid, and the line over it says
what the stand is doing; **Auto to Ready** walks it for you and stops short of
Fire (and never leads out of an abort). While it burns, and in the Vent it ends
in, that line is the burn: time, mean thrust, Isp, and which tank ran dry.
**GSE Controls** has the knobs, and shows the lockup range a burn sweeps:
the tanks at T-0 with the COPV charged, climbing as it blows down. Its red arcs
are the drawing's MAWPs. The stand's **Notes** (below the fold) say when a
drawn tank cannot hold the engine's fire load.
The cockpit runs the same numerics as the study, so a stiff stand runs in slow
motion rather than less accurately. The top bar says the ratio. **T-0** skips
the pad: loaded with the engine's fire load, charged, at lockup, in Ready.

When a burn ends it is **recorded** on its own. Nothing to remember.

## 4. Read the run

* **Engine**: the burn totalled, its traces, and what set O/F.
* **Solver**: a verdict in words, then one residual monitor -- every residual
  divided by its criterion, so under the dashed line is converged -- and the
  iteration log beside it. Mass the balance cannot explain is a leak in the
  model; say so.
* **Plots**: every channel against time, with each state change marked;
  **Download CSV** for the whole trace at full rate.
* **Runs**: every recorded burn, with the drawing and engine it ran on (and
  *rocket only* / *simplified* where they apply). Pick two to see every input that changed and
  the outcome deltas. **Explain** replays both from their **T-0** and swaps one
  input group at a time, showing how much of the change each group accounts
  for and how much is **interaction**. *Replay vs recorded* under it says
  whether the replay is a faithful stand-in for the burn.
* **Download** a run's record to attach it to a review: inputs, code version,
  stand version, outcome, solver summary, traces.

## 5. Going further

* **Study**: your stand, burned from T-0 once per case. Every case starts as
  the cockpit is set (COPV target, knobs, Configuration) and changes only the
  cells you fill in; **Sweep…** writes one case per value. Results compare
  tank, COPV, thrust and chamber traces and the burn totals side by side.
* **Layer X** (EngineDesign): the same burn with the engine analyses
  (stability, thermal, flight, the optimiser). See
  [ADR 0005](../../docs/adr/0005-layer-x-stays-where-the-engine-is.md) for how
  the two divide the work.

## Before changing the physics

Read [`docs/PHYSICS-BENCHMARK.md`](../../docs/PHYSICS-BENCHMARK.md) and run
`scripts/check.sh` (fast) or `scripts/check.sh full`. You cannot verify the
sim with the sim.
