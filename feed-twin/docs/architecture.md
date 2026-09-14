# feed-twin, end to end

A cockpit simulator for the propellant feed system. It looks like the DAQ on
purpose: same layout, same palette, same plot conventions, same state machine
tables. Somebody who has spent a night watching the real stand should not have
to re-learn anything to read a simulated run.

```
 P&ID (pid-designer)  ─┐
                       ├─►  assembly  ─►  Model  ─►  Session  ─►  cockpit
 engine (EngineDesign) ┘                   │                        │
                                           │                        └─ study
                       DAQ state tables ───┘
```

## The layers

**`lib/feedtwin`** — the physics, importable on its own and the thing under
test. Components (valves, orifices, regulators, pipes), vessels (tanks, gas
volumes), a steady network solve, and a transient built on top of it. No web
framework, no app state. Two callers: this app and EngineDesign.

**`feed-twin/backend`** — the app. Assembles a drawing plus an engine into a
`Model`, drives it as a `Session`, and serves it over HTTP.

**`feed-twin/frontend`** — the panel. Routes, not panels-in-a-picker: each view
gets the whole width and its own URL.

## The solve, in one paragraph

The system is a semi-explicit index-1 DAE. Vessels carry the differential state
(mass, energy, liquid); the network is the algebraic constraint, satisfied
exactly at each step rather than carried as extra unknowns. Unknowns are one
pressure per free node and one mass flow per branch; equations are one mass
balance per node and one pressure relation per branch. Almost all of the
Jacobian is the incidence matrix and never changes, so a Newton step costs one
derivative per component and a sparse solve.

Properties come from CoolProp through a caching layer. Real gas throughout —
at 4500 psi and 293 K nitrogen's compressibility is 1.15, and ideal-gas mass is
15% wrong.

## `Session`: the stand as a thing that exists in time

`backend/session.py` is where the app-level physics lives. Nothing is
pressurised or loaded until somebody does it; a state commands valves, and the
valves decide what happens next tick.

Three regimes, and an operator should only notice one:

| Regime | What `step()` does |
|---|---|
| **Live** | Integrates now. The pad, fills, presses, holds. |
| **Computing** | A burn is being integrated ahead on a worker. The display holds its frame and reports progress. |
| **Replaying** | Hands back buffered frames at wall-clock pace. The stand is already at the end of the run; the operator is watching it catch up. |

A command during replay restores the stand to the frame being shown, discards
the future, and continues live — the same thing that would have happened had
the run never been computed ahead. A command *during* compute cancels the run
and does the same. An abort must never be refused and must never act on a
future the operator has not seen.

### Why a burn cannot be integrated live

The regulator and the ullage it feeds are an RC pair: capacitance `C = m/p` of
the ullage, resistance `R = flow_droop / rated_flow` of the regulator. Their
product is about **1 ms on helium and 7 ms on GN2**. An explicit scheme that
steps past that overshoots, overcorrects, and fills the trace with tick-rate
noise that reads as physics. `Session._coupling_timescale()` computes it and the
coupling count is sized from it (`COUPLING_SAFETY`, one τ per step — measured,
not assumed: the answer is flat to within run-to-run noise up to 2τ and visibly
rough by 4τ on both gases).

That costs seconds of wall clock per second of stand — fine for a study,
impossible for a 200 ms panel tick. Hence compute-ahead-and-replay.

## Configuration that changes the trade

`Setup` carries the knobs where a cockpit and a study want opposite answers:

| Field | Cockpit | Study |
|---|---|---|
| `tick_budget` | 0.15 s — panel stays live | `1e9` — never fold a step |
| `max_iterations` | 30 — bounded latency | 120 — converge |
| `ullage_collapse` | on | off, for a clean comparison |

## The state machine

Read from the DAQ's own CSVs — `state_machine_actuators.csv` (actuator × state)
and `state_transitions.csv` (legality). Not a reimplementation: if the DAQ
table says Fire cannot go to Ox Press, neither can the twin. Ten rows of the
transitions file are ragged; they are dropped and reported rather than zipped,
because a shifted column can silently delete an abort path.

## Testing

- `lib/feedtwin`: 508 tests. Physics against closed form and published values.
- `feed-twin`: 101+ tests, including abuse cases against the HTTP surface.
- `mypy --strict` on `backend`, `black`, and a frontend `tsc -b && vite build`.

The rule that matters: **a regression test must be verified to fail when the fix
is reverted.** Two tests in this repo passed with their bug in place before that
check was applied — one compared against the very constant it was guarding, and
one used a fixture whose line losses hid the defect.

## Views

| Route | What it is |
|---|---|
| `/` | Console — valves, state machine, engine |
| `/pid` | The drawing, live, zoomable |
| `/plots` | Channels against time |
| `/mixture` | What sets O/F, and by how much |
| `/study` | COPV sizing — see [copv-study.md](copv-study.md) |
| `/library` | Import drawings and engines |
| `/report` | What was read, what was assumed |
