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
(mass, energy, liquid); the network is the algebraic constraint, solved to a
tolerance (`Setup.network_tolerance`) at each step rather than carried as extra
unknowns. Unknowns are one pressure per free node and one mass flow per branch;
equations are one mass balance per node and one pressure relation per branch.
Almost all of the Jacobian is the incidence matrix and never changes, so a
Newton step costs one derivative per component and a sparse solve. The ullages
on the press path are the exception: each enters the solve as a storage node,
backward Euler on the vessel inside the one Newton solve.

A solve that fails is held, not integrated: the vessels move on the last
converged flows, and on nothing at all right after the circuit changes (a valve
opens, a tank is isolated dry), when there is no converged answer for the new
circuit yet. The frame shows the last converged pressures and says it did not
converge.

Properties come from CoolProp through a caching layer. Real gas throughout —
at 4500 psi and 293 K nitrogen's compressibility is 1.15, and ideal-gas mass is
15% wrong.

## `Session`: the stand as a thing that exists in time

`Session` (`lib/feedtwin/feedtwin/session/core.py`; `backend/session.py`
re-exports it) is where the stand's physics in time lives. Nothing is
pressurised or loaded until somebody does it; a state commands valves, and the
valves decide what happens next tick.

**Everything is integrated live, Fire included.** A panel tick of `dt` is split
into `LIVE_STEP` (0.02 s) steps -- the Study's grid -- with the Study's Newton
allowance (120 iterations) and no wall-clock budget, so the console and the
Study integrate one scheme. A stand too stiff to keep up runs in slow motion and
the top bar says by how much; nothing is folded to catch up
(docs/PHYSICS-BENCHMARK.md 3.9-3.10b).

The coupling inside each step is sized from the regulator-ullage time constant.
The regulator and the ullage it feeds are an RC pair: capacitance `C = m/p` of
the ullage, resistance `R = flow_droop / rated_flow` of the regulator. Their
product is about **1 ms on helium and 7 ms on GN2**. An explicit scheme that
steps past that overshoots, overcorrects, and fills the trace with tick-rate
noise that reads as physics. `Session._coupling_timescale()` computes it and the
coupling count is sized from it (`COUPLING_SAFETY`, one τ per step — measured,
not assumed: the answer is flat to within run-to-run noise up to 2τ and visibly
rough by 4τ on both gases), and from the ullage's mass and the press path's own
constant on top (see `Session._integrate`).

A command acts on the stand the operator is looking at, at once; an abort is
never refused. (Fire used to be computed ahead and replayed, with commands
during the replay rewinding the stand to the frame on screen. Nothing used it
once Fire ran live, and it went on 2026-10-08.)

## The cockpit and the benchmark are different thermal schemes

The cockpit, Layer X and the Study tab run `Setup`'s thermal defaults: collapse,
vapour, wall chilldown with film and nucleate boiling, a boiling-onset
superheat, a stratified surface layer, line walls, the ullage against its dry
wall only (Layer X and the Study turn off only the automatic vent at burnout,
to read a trace past depletion). The benchmark study (`backend/benchmark_study.py`,
through `feedtwin.session.burn.burn_setup`) turns stratification, boiling
onset, nucleate boiling, line walls, ullage-wall-by-level, the compressible
regulator seat and the automatic vent off, and each case passes collapse, vapour
and chilldown itself, because the
expectations in docs/PHYSICS-BENCHMARK.md 2.x were stated before those closures
existed. **Compare a console trace with a Tier 2 number only after checking
which scheme produced it**: a cockpit run record carries its whole `Setup` in
its inputs.

## The state machine

Read from the DAQ's own CSVs — `state_machine_actuators.csv` (actuator × state)
and `state_transitions.csv` (legality). Not a reimplementation: if the DAQ
table says Fire cannot go to Ox Press, neither can the twin. Nine rows of the
transitions file are one cell short; they are read left-aligned, the way the
DAQ's parser reads them, and every Fire path that alignment opens is warned
(`backend/statemachines/NEEDS-REPAIR.md`). A row that cannot be read at all
fails closed, with the aborts still reachable.

## Testing

- `scripts/check.sh` runs every gate CI runs (`scripts/check.sh full` adds the
  slow tier and the Layer X parity test).
- `lib/feedtwin`: physics against closed form and published values;
  `scripts/physics_benchmark.py` against hand calculation, `fluids` and CoolProp.
- `feed-twin`: the session, the HTTP surface (abuse cases included), operator
  walks; `mypy --strict` on `backend`, `black`, and a frontend `tsc -b && vite
  build`.

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
