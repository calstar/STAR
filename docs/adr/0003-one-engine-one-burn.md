# 0003 — One engine, one burn: feed-twin fires EngineDesign's engine

**Status:** Proposed, decision 1–4 built · 2026-10-06
**Affects:** `lib/feedtwin`, `feed-twin`, `EngineDesign` (Layer X)

## What feed-twin is for

Feed-system analysis that also tells you what the engine did. The stand as drawn
(pid-designer) and the engine as designed (EngineDesign) run together through one
physics library (ADR 0001), whether the run is the cockpit flown in real time, a
headless study, or Layer X sweeping a design. Whichever way a burn is asked for,
the same stand at the same T-0 gives the same thrust curve.

## Context: two tools, "entirely different thrust curves"

On 2026-10-06 the cockpit and Layer X were run on the same LE4 (3) drawing. Each
row below changes one thing, going from Layer X to the cockpit. GN2, 20 ms vs 50 ms
steps, mean over the burn:

| | thrust | O/F | Isp | burn |
|---|---|---|---|---|
| 1. Layer X (engine card, its T-0: 578 psia, 4000 psig bottle, the config's loads) | 6,205 N | 1.593 | 220.7 s | 3.75 s |
| 2. engine → feedtwin's simplified model | 5,883 N | 1.600 | 242.6 s | 4.34 s |
| 3. engine → the copy in feed-twin's library | 7,489 N | 1.928 | 248.4 s | 3.26 s |
| 4. + the cockpit's numerics (`Setup()`) | 7,490 N | 1.928 | 248.4 s | 3.26 s |
| 5. + the cockpit's dome 500 psig, bottle 4500 psig | 7,333 N | 1.929 | 247.8 s | 3.33 s |
| 6. + a 95 % fill = what the cockpit fired | 7,193 N | 1.917 | 247.3 s | 4.55 s |

The solver is not the problem: row 3 to row 4 moves 1 N. Three inputs had drifted:

* **A copy, not the design.** feed-twin imported "Ethalox 7200N Doublet" on Sep 12 and
  kept the bytes. EngineDesign has moved on twice since then: the plate (26 fuel holes of
  1.93 mm, now 24 of 1.50 mm), the throat (1,727 mm², now 1,795 mm²) and the design point.
  That one stale copy was +1,606 N, and nothing on screen said the design had changed.
* **Two engine models.** The cockpit fired feedtwin's simplified engine: one orifice per
  side, c* off the CEA table, no manifold, mixing or nozzle losses. Layer X fires
  EngineDesign's engine as a card. On the same design the simplified one is −5 % thrust,
  +10 % Isp and +11 % impulse.
* **Two T-0s.** Layer X starts at the engine's design point; the cockpit starts wherever
  the operator's knobs put it. Both are legitimate. They are different questions, and the
  numbers should only be compared at the same T-0.

The cockpit also told you nothing about the engine. A full pad sequence and burn left a
pressure plot, four numbers that flashed while the chamber was lit, and no total.

## Decision

1. **One engine model, EngineDesign's.** An engine pulled into feed-twin brings its
   **engine card**: EngineDesign's injector, chamber and nozzle, sampled once over 40–130 %
   of the design tank pressure and tabulated (`feedtwin.engine.card`). The worst error is
   0.07 % against held-out EngineDesign solves. EngineDesign builds it on request
   (`POST /api/layerx/engine-card`, any config as YAML), and feed-twin stores it beside the
   engine. A card goes on an engine one way only, `EngineCard.install`, which the cockpit
   and Layer X both call.
   The simplified engine stays as a fallback for an engine with no card. It is labelled
   everywhere: the report warning, the Engine page and the Library tag.
2. **Reference, don't copy.** An artifact pulled from a design tool remembers where it came
   from. feed-twin asks that tool whether it has changed (`/api/library/{id}/freshness`),
   and pulls it again with its card in one click (`/refresh`, a new artifact; the old one
   stays for the runs made on it).
3. **One way to total a burn.** `feedtwin.session.report` totals a burn from its steps:
   * right-endpoint sums, the way `burn()` steps;
   * O/F as the mass ratio burned;
   * delivered Isp;
   * minima at full flow;
   * a step counts only when both propellants flow.

   The cockpit finds its burns in the session history (`/api/session/{id}/burns`). Layer X
   keeps its own summary, but its impulse, mean thrust, O/F and Isp are the same arithmetic,
   and a test holds them equal on the same burn. Its chamber-pressure statistics are read
   after 0.2 s, the report's at full flow; moving Layer X onto the shared function would
   re-baseline its golden figures, so that is left for a deliberate change.
4. **The engine is on the page.** Engine channels go into the history: chamber pressure
   plots with the stand pressures; thrust, O/F and flows plot on the Engine page. The
   Engine page shows:
   * the last burn, totalled;
   * which engine fired, and whether EngineDesign has moved on;
   * the O/F split.

   The Console carries a last-burn strip, and says when a stand has no engine at all
   (LE4's drawings link none, so the chamber was a fixed pressure).

## Rejected

* **Make feedtwin's own engine better until it agrees.** That is a second implementation
  of the spray, mixing, manifold and nozzle physics. It would drift from EngineDesign the
  moment either changed, which is how this started.
* **Call EngineDesign from inside the chamber closure.** That costs seconds per step on a
  50 Hz console, and two `backend` packages would have to share one interpreter.
  The card is the same physics sampled once.
* **Calibrate the simplified engine at T-0** (Layer X's `calibrated` mode). It is exact at
  one point and wrong elsewhere in the burn, and a cockpit visits every point.

## Consequences

* **Parity is a test, not a hope.** `EngineDesign/tests/test_layerx_cockpit_parity.py`
  runs the cockpit's path against Layer X's burn at Layer X's T-0. That means the engine
  from YAML, the card as JSON off the wire, the cockpit's `Setup`, Fire commanded, 20 ms
  ticks and the burn totalled from the samples. Measured gap: thrust −0.02 %, O/F −0.002 %,
  Isp −0.004 %. The same test fails on the simplified engine (−5.7 % thrust, +9 % Isp).
  On LE4 (3) by hand the gap is +0.02 % thrust and +0.04 % O/F.
* Importing an engine now takes 5–15 s while EngineDesign builds the card. Without
  EngineDesign the import still succeeds and says why it has no card.
* A cold flow never fires a card. It burns nothing, and a card is the engine burning.
* The feed-twin test suite points `ENGINE_DESIGN_URL` at a closed port, so it never builds
  cards against a developer's running EngineDesign. Tests that need a card stub the transport.

## Next, in order of what they buy

1. **A shared operating point.** Store T-0 (dome, bottle fill, loads, hold time) as a
   library artifact the cockpit and Layer X both read. Then "fire Layer X's T-0 in the
   cockpit" and "run my stand's T-0 in Layer X" are one click each, and a disagreement can
   only be physics. With it, add a cockpit **Fire from T-0** (prime and settle, as Layer X
   does) so a what-if does not need the 25-minute pad.
2. **Burn records that persist**, next to Layer X's run store. Then the cockpit, Layer X
   and a DAQ test file can be laid over each other, and the twin can be calibrated against
   measured burns. That comparison is what makes this an engineering tool and not a
   simulator.
3. **No combustion on one propellant.** The chamber still reports thrust from fuel alone
   once the LOX is gone (~2 kN for a step or two on LE4, clamped at its table's edge). The
   report no longer counts it, but the live readout shows it. This is a physics change: make
   it opt-in, and benchmark it.
4. **Ullage collapse in Ready.** In the cockpit a freshly pressed LOX ullage falls ~50 psi/s
   with the press valve shut (548 → 260 psig in ~6 s). The burn then starts fuel-rich
   (O/F ~0.9) for ~0.2 s while the press valve refills it. Check this against a DAQ trace
   before trusting either the model or the procedure.
5. Uncertainty bands in the cockpit (Layer X has the sweep), and implicit press-path
   coupling for helium real-time speed.
