# 0005: Layer X stays where the engine is; the Stand and the Run are what the two share

**Status:** Proposed · 2026-10-06
**Affects:** `EngineDesign` (Layer X), `feed-twin`, `lib/feedtwin`, `lib/stardesign`

## Context

Layer X and the feed-twin cockpit look like they compete for the same job. Both
burn the same drawing on the same physics library and print a thrust curve.
Since 0003 they agree to 0.1 N given the same inputs. To the person using them,
feed-twin reads as "a less informative Layer X that lets me run the stand by
hand". So the obvious question is whether Layer X should move into feed-twin.

What each one actually is:

* **Layer X is forward mode over a burn.** It is EngineDesign's forward
  analysis, made time-dependent and fed by the feed system. It does not stop at
  the feed system. Every burn it runs, it also:
  * builds and grades the engine card;
  * replays erosion and the chamber against the trace;
  * runs stability (chug on the burn's own feed impedance), thermal, and a
    RocketPy flight;
  * keeps lineage-keyed measurements;
  * diffs designs;
  * runs an optimiser whose answer is written back into the engine design
    (`reconcile`, `patch`, `setpoint`).

  That is 23 modules in `engine/layerx` and 27 routes, every one of which
  imports `engine.*` in process.
* **feed-twin is the stand.** It owns the drawing as built, the hookup (which
  actuator opens which valve, which knob loads which regulator), every
  assumption as a Tunable, the state machine, the GSE pages, and a session
  ticked live like the DAQ. Its job is "what will this hardware do when we run
  it", including the parts no burn plan scripts: fills, holds, aborts, a
  regulator turned by hand.

## Decision

1. **Layer X stays in EngineDesign.** Moving it would mean one of two things:
   * importing EngineDesign's engine stack into feed-twin's process: numba, the
     CEA caches, RocketPy, and a second top-level `backend` package that
     collides with feed-twin's own;
   * re-implementing it there.

   The first is the coupling ADR-0001 exists to avoid. The second forks forward
   mode, and the engine analyses are what make Layer X worth having.
2. **The things the two share become shared documents, not shared code:**
   * **the Stand.** The whole configuration as one versioned, shared document
     in `lib/stardesign`, the same store pid-designer keeps drawings in: drawing
     and engine (content hashes), fluid set, state machine, every setting, the
     hookup and the operating point. feed-twin authors it (`/api/twin/stands`).
     Layer X should read it rather than re-derive any of it, which is already
     its rule ("trust the feed twin").
   * **the Run.** Every burn, kept with its inputs, the code that ran it, the
     stand version, the outcome and the solver's own summary
     (`feed-twin/backend/runs.py`). A cockpit burn is recorded at burnout. A
     Layer X burn should write the same record, so the question "how did this
     differ from that" has one answer, whichever tool fired it.
3. **Hand-offs, not merging:**
   * **feed-twin → Layer X:** "Analyse in Layer X" on a run sends the stand
     version and the run's T-0. Layer X then does what feed-twin cannot: the
     card, stability, thermal, flight, and the optimiser.
   * **Layer X → feed-twin:** "Fly it on the stand" opens a cockpit session on
     the stand Layer X ran, primed at the same T-0, for the operations no burn
     plan scripts.
   * The two pages can be embedded in each other later, one iframe or route
     away, without moving code.

## What feed-twin should take from forward mode

The fear behind moving Layer X is losing what forward mode shows. The answer
is to bring the *reading* to the cockpit, not the engine stack. feed-twin
already has:

* the burn totalled the way Layer X totals it (Engine tab);
* the engine card it fired (ADR 0003);
* the solver's residuals and mass balance (Solver tab);
* run records with an attribution ladder (Runs tab).

Next, in the order that pays: a link from each run to the Layer X result of
the same stand and T-0, then a stand-level limits table using Layer X's grader
(`engine/layerx/diag/limits.py`) over HTTP.

## Rejected

* **Move Layer X into feed-twin.** For the reasons in decision 1. It would
  also make feed-twin's CI carry EngineDesign's dependency matrix, which
  `feed-twin-ci.yml`'s compat job exists to keep apart.
* **Retire the cockpit and keep only Layer X.** Layer X burns from a planned
  T-0. Fills, holds, chilldown, the dewar, aborts and a hand on a regulator are
  what the cockpit is for. They are also where the stand's surprises
  (self-pressurisation, a sagging regulator) have come from.
* **A third service both call.** Neither caller would get faster or simpler,
  and the physics is already one library.

## Consequences

* The stand record must stay a superset of what Layer X needs from a stand.
  Today Layer X reads drawings and Setup from feed-twin's library and tunables.
  Making it read a stand version instead is the next Layer X change.
* Runs written by Layer X need its outcome keys mapped onto
  `runs.OUTCOME_KEYS`. Its richer blocks (stability, flight) go beside them
  under their own keys; the cockpit's diff ignores keys it does not know.
* Two UIs remain. That is the cost, and it is paid for by not forking forward
  mode.
