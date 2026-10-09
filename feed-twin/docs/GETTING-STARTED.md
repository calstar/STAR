# Getting started with feed-twin

For an engineer opening the twin for the first time. Thirty minutes, start to
a recorded burn. Words in **bold** are in the [glossary](GLOSSARY.md).

## 0. Run it

```bash
bash feed-twin/setup.sh        # once: venv, the physics library, the design store, npm
cd feed-twin && ./dev.sh       # API on :8003, UI on :5177
```

Open http://localhost:5177. The bar across the top is the DAQ's own layout:
pressures, the state, FIRE. The amber chip on the right of the second bar says
what the model has been checked against. Hover it. Until the stand's own data
has been compared against it, every number here is a prediction.

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

* **Report**: what was read off the drawing and what was assumed. Anything
  amber is a number the twin made up because the drawing left it blank.
  Fix it on the drawing (pid-designer), not here.
* **Hookup**: which actuator opens which valve and which knob loads which
  regulator. Imported drawings are matched by name; check them.
* **Configuration**: every number the twin assumes, with what it stands for.
  Change one here and the next run records it.

Pressures on a drawing are gauge unless they say `psia` (chamber pressure on
the ENGINE symbol is absolute). Differences such as bias, droop and crack take
plain `psi`. See [ADR 0004](../../docs/adr/0004-pressure-references.md).

## 3. Run the stand

Walk the state machine as you would at the pad: fills, press, Ready, Fire.
**GSE Controls** has the knobs. The cockpit runs the same numerics as the
study, so a stiff stand runs in slow motion rather than less accurately. The
top bar says the ratio.

When a burn ends it is **recorded** on its own. Nothing to remember.

## 4. Read the run

* **Engine**: the burn totalled, its traces, and what set O/F.
* **Solver**: did every solve converge, and did the stand keep its mass --
  to rounding, the step a tank runs dry on included. Mass the balance cannot
  explain is a leak in the model; say so.
* **Runs**: every recorded burn. Pick two to see every input that changed and
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
