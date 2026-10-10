# feedtwin changelog

The physics library under feed-twin and EngineDesign's Layer X. Versioned in
`feedtwin/__init__.py`; every release here says what moved a number, by how much,
and which test or benchmark holds it. Format: newest first. A change that moves a
result names it under **Changed results**; a reader comparing two runs should
be able to find why they differ.

## Unreleased — 2026-10-10: the DAQ box and the stand's own state table

### Added
- **A hookup can be wired** (`Hookup.channels`, `Channel(board, slot, name, symbol)`,
  hookup schema 2; schema 1 still reads and a hookup without channels is still written
  as schema 1). It is how the real DAQ declares a stand: each valve and transducer on a
  named connector, and the state table opening names. On a wired hookup `binding()`
  binds a row to the valve on the connector of its name (ignoring case) and nothing
  else: a row with no connector, or one on a symbol that is not a valve, drives
  nothing and is listed in `unmatched`. `channels=()` is a box with nothing plugged
  in. Without channels nothing changes: pins, then names and roles, bit for bit.
  `Hookup.names()` is the console's names (a connector's name over an alias).
  `on_vehicle` keeps the rocket's connectors and matches the rows whose cable went to
  the cart as before (`Hookup.auto`, compared ignoring case), and now rebuilds with
  `replace`. Rocket only, a row with no connector still drives the stand-in the cut
  drawing makes of a disconnect whose mate went with the cart (the tank-top GSE
  vent; `Model.meta["capped"]`), which the box cannot take. A connector whose
  symbol the drawing lost is matched by name again, as a pin to a lost valve always
  was (`lost_connectors` lists them for the stand's notes).
- **An edited state table** (`StateMachine.to_dict`, `machine_from_dict`,
  `Hookup.machine`). Read exactly as the CSVs are: Idle held shut, mains outside Fire
  and ignition paths around Ready warned (`_hold_idle`, `_fire_bypasses`, shared with
  `load_machine`). Refused when it contradicts itself (a state or row named twice --
  rows ignoring case --, a cell naming what the table lacks). `StateMachine.table`
  keeps what the table wrote before the Idle hold; `layout` is the DAQ's panel
  row/col; `aborts` the states flagged abort (`None`: by name, as before; a flag is
  read strictly -- "0" is no). `load_machine` reads an optional
  `<name>_states.csv` beside the tables for both. An edited table without a state
  the twin keys on by name (`KEYED_STATES`: Idle, Ready, Fire, Vent, Engine Abort)
  is warned.
- `core.builtin_rows(machine)`: the rows the session reads by name (the built-in
  COPV charge and dump, the transfer tank's press), with what each does.

### Changed results
- None. A hookup without channels and a table without flags bind and run as before
  (`tests/test_daq_hookup.py`, `test_hookup.py`); the shipped table's aborts from its
  new `_states.csv` are the three the name rule found.

## Unreleased — 2026-10-09

### Changed results
- **Reading a regulator's lockup moves nothing** (`Session.peek_signals`,
  `regulator_lockup(place=)`). It went through the step's `signals()`, which at a zero
  dt snaps every valve to its command; the cockpit read each tank's lockup on every
  tick, so a main valve mid-travel was fully open after the readout. Cockpit burns now
  honour the valves' travel time. T-0 (`jump_to_t0`, `prime_at_t0`) keeps the old
  evaluation (`place=True`): the Study, Layer X and the benchmark are unchanged, and
  the Layer X <-> cockpit parity test holds.
- **A dry tank no longer drains back through its fill line** (`Session._dry_branches`).
  The line a drawn cart loads through was exempt from the dry-tank isolation, and an
  open branch flows both ways: with LE4's FD-ROT-G (uncommanded, rests open) beyond
  it, the dry tank kept "draining" and the vessel floor re-made the mass, ~0.46 kg/s
  booked as guard. It now stays open to a dry tank only in that tank's fill state
  (`Session._loading`): not on the last solve's pressures, which sit within a hair of
  each other across an idle line and flipped it every step -- a circuit that changes
  every step drops its flows, and a topped LOX tank's vent went with them
  (`test_a_topped_lox_tank_on_its_vent_lands_where_the_solve_put_it`). Drawings with
  no cart are untouched; the benchmark is unchanged.
- **A venting ullage is closed on its gas-out slope** (`Session._ullage_storage`,
  `Session._venting`). It was closed on the stiffer of gas in and gas out, and over
  boiling LOX gas in is ~8x stiffer, so a steady vent left the tank above the node its
  vent flowed from by a gap that grew with the coupling step. LE4 (6), LOX tank topped
  in Ox Fill: 7.2 -> 3.1 psig (the node was 3.1 both times; finer coupling on the old
  code tended to 3.4). Tier 2.1 bit-identical; LE4 (6) burn impulse bit-identical
  (docs/PHYSICS-BENCHMARK.md 3.10c).

### Added
- `Session.short_loads()`: each vehicle tank that cannot hold the engine's fire load at
  its full fraction, said. LE4's Eth-Tank holds 6.14 kg against a 7.00 kg fuel fire
  load; a load stops at the full fraction, so the stand has been loaded short.
- `regulator_lockup(inlet=, loaded_dome=)`: the lockup with the bottle at a given
  pressure, and with the dome its knob sets though the dome line is shut.
- `Session.operator_held` (the operator's hands, not the crew's fill valve),
  `TankSim.load_target_kg`, `T0.loads`, and a note naming where a cold vehicle tank's
  propellant goes when it is not the engine.

### Fixed
- Fills ran at a third of real time on a drawn cart. The 10 % mass rule counted gas a
  tank vents to atmosphere, and the regulator-ullage time constant paired every
  regulator with every ullage, joined or not (`Session._regulator_slopes`). LE4 (6) Ox
  Fill holding its load: 9-10 solves per 20 ms step -> 1, 0.34x -> 1.89x in-process;
  Fuel Fill 1.42x -> 3.01x.
- A failed network solve could freeze the stand for good: it holds the vessels, so
  the next step asks the same question and fails the same way. A Fire from unpressed
  tanks sat at 0 psig chamber from ignition (`test_fire_with_unpressed_tanks_is_a_weak_start`,
  tipped into it by the changes above; the same solve converged in 384 iterations).
  A solve that fails with the ullages closed is retried once from the solution with
  them held (`Session._solve`): 9 + 4 iterations there. Steps that converge are
  untouched.
- The burnout note said `T+` on the stand clock ("T+302.7 s" after a 3.5 s burn); it
  times from Fire.

## Unreleased — 2026-10-07

### Changed results
- **The supply-pressure effect is measured from zero inlet**: outlet = dome + bias
  - S x inlet (gauge) (`Regulator.supply_effect`). It was ``S (p_ref - p_in)`` with
  ``p_ref`` a drawn `inlet_reference` or the COPV charge, which zeroed it at a full
  bottle. A full 4,500 psig bottle now holds a 1092-50 at dome 500 to 473.5 psig, not
  550. Benchmark tiers 2.1-2.4 re-baselined (docs/PHYSICS-BENCHMARK.md 4.11); LE4 (6)
  at dome 500 primes at 483.7 psig (was 549.8) and makes 5,677 N at 1 s (was 6,305).
- Lockup always carries the supply effect; `prime_at_t0` primes and settles at the
  regulators' lockup off the vehicle's bottle (`tank_psi` is the fallback with no
  regulator); `regulator_lockup` reads the vehicle's bottle, not a cart bank.

- **T-0 and pad fills load the fire load**: `EngineDesign.fire_load` (the config's
  `lox_tank.mass` / `fuel_tank.mass`), placed on the vehicle tank of that side
  (`Session.fire_loads`). `jump_to_t0` loads it by default and a pad load stops at it
  (`TankSim.load_kg`); a fraction of the drawn tank is only the fallback with no
  engine. LE4 (6) with the 6800N: 6.611 / 4.404 kg, not 8.88 / 6.14 (95 % of 8.19 L),
  a 3.9 s burn at dome 500 instead of 5.3.

### Removed
- `Setup.regulator_supply_datum`, `Setup.regulator_lockup_supply` and their signals
  (`SUPPLY_DATUM_SIGNAL`, `LOCKUP_SUPPLY_SIGNAL`). `inlet_reference` still loads, is
  ignored, and `Regulator.check` warns.

### Changed results (2026-10-08, the team)
- **The regulator seat is compressible by default** (`Setup.regulator_compressible_seat`,
  IEC 60534-2-1's expansion factor and choke) in the cockpit, Layer X and the Study tab;
  `burn_setup` pins it off, so the benchmark Study is unchanged. Only a wide-open
  regulator is affected: the LE4 (6) helium burn and a press from 50 psig to lockup are
  bit-identical, and the COPV study's GN2 drawing burned off a 1,200 psig bottle loses
  0.04 % thrust.
- **`dewar_fill_cv` 0.013 -> 0.019**. On the LE4-like test stand the chill reads the
  stand's ~30 psig again at 30 s (it read ~21 since the 2026-10-06 vent fix), and
  `test_the_fill_cv_is_calibrated_to_the_stands_30_psig_chill` is no longer an xfail.
  LE4 (6) as drawn vents differently: its chill now peaks at 57 psig and takes 5.3 min
  (was 38.5 psig and 6.9 min); the stand shows ~30 psig and ~10 min.

### Added (2026-10-08)
- `Session.skip_chilldown(tank_id="")` / `TankSim.skip_chill()`: a vehicle cryogen
  tank's wall goes where a load's chill leaves it -- saturation at atmosphere plus the
  boiling onset, so the boil-off venting afterwards does not set it chilling again --
  and the load collects from the next step. The propellant the chill would have
  flashed is booked in `chill_boiled`, and the assumptions say the pad was cut short.

### Removed (2026-10-08: nothing called them)
- `Session.precompute` and the replay it served: `computing`, `progress`,
  `replaying`, `Snapshot`, `_snapshot` / `_restore` / `_leave_replay` and the
  session's lock, which existed for the precompute thread. A session is stepped
  from one thread; `step()` integrates live or holds a tripped frame.
- `feedtwin.transient` (`TransientSystem`, `simulate`, `Scenario`, ...) and
  `feedtwin.engine.EngineCoupling`, the Phase 07 integrator and its relaxed
  chamber loop: the session replaced them, and nothing imported them but their
  own tests. The two of those tests that checked components rather than the
  integrator -- a regulator with no droop is flagged, a valve reads its own
  command -- moved to `test_regulator.py` and `test_comps_validation.py`.

### Fixed (2026-10-08, from an outside review of feed-twin)
- **A failed network solve no longer moves the stand.** `Session._advance_once`
  integrated the vessels on `self._last_flows or dict(result.flows)`, and the last
  flows are emptied whenever the circuit changes, so a solve that failed on the step
  a main opened (or a tank was isolated dry) moved propellant on the failed iterate:
  forced at the mains opening, one 20 ms tick took 3 kg out of a 6 kg fuel tank. Its
  pressures also fed the tank's supply clip, the frame and the trapped-leg values. A
  failed solve now holds the last converged flows and pressures (`Session._held`),
  and moves nothing when the circuit has none yet. No change where every solve
  converges: the LE4 (6) burn fails none, and the benchmark asserts none fail.
  `tests/test_failed_solve_holds.py`.
- **A leg behind a shut valve holds what was trapped in it** (docs/PHYSICS-BENCHMARK.md
  3.2, listed there as open). A stub reached across a shut or isolated branch is now
  flagged undefined, so the session shows its last value rather than the live side's
  pressure across the seat; only a check valve behind its crack used to be. Solved
  pressures and flows unchanged; on LE4 (6) no transducer reading changes (its two
  such PTs read the dome line).
- `Tank.step` rebuilds its state with `replace`, so a field `TankState` grows later is
  carried through a step rather than reset (benchmark trap 4.3). Same numbers.
- The session names the GSE actuators it drives an undrawn bottle with
  (`GSE_CHARGE`, `GSE_DUMP`) and its notes say when the state table has neither
  row, instead of the charge and dump silently never happening.

## 0.2.0 — 2026-10-06

### Added
- `session.burn.regulator_lockup` (the lockup of the regulator that presses a
  tank, at the session's knobs and the bottle as it is) and `jump_to_t0` (the
  study's prime, at those lockups, in Ready).
- `session.report`: one way to total a burn. Right-endpoint impulse, O/F as the
  mass ratio burned, delivered Isp, minima at full flow, and a step burns only
  when both propellants flow. Layer X's own summary agrees on impulse, thrust,
  O/F and Isp (EngineDesign `tests/test_layerx_cockpit_parity.py`).
- `EngineCard.install`: the one way an engine card goes onto an engine (cockpit
  and Layer X).
- `session.hookup`: knobs (regulators each GSE dial sets) and valve pins per
  drawing; `bind(..., overrides=)`. With no hookup, or the suggested one, the
  session behaves exactly as before.
- Paired quick-disconnects are mated across pid-designer pages
  (`BuiltNetwork.mated`); a cart drawn on another page fills the vehicle through
  the network, and the built-in fills stand aside for it.
- `session.diagnostics`: the solver tab's per-tick record (Newton residuals,
  continuity, chamber closure, global mass balance, integrator guards).
- `Setup.ullage_wall_by_level` (on; `burn_setup` pins it off).
- A `slow` pytest marker; `scripts/check.sh` runs the fast tier.

### Fixed
- A tank venting its own boil-off vented air the floor put back. The vent split
  its gas by mass share, so a LOX tank chilling down at ~25 psig sent its air
  to the pressurant floor (an atmosphere's worth, kept because the pressurant
  carries the ullage's heat capacity) and the floor re-created it: ~3 g/s of
  air and ~800 W through a whole chilldown on LE4, 0.2 kg booked as a guard
  per load. At the floor the vent now takes vapour (`TankSim.advance`); the
  guard falls ~150x. **Changed result:** the cockpit's chill peak on LE4 drops
  from ~29 to ~21 psig at the calibrated `dewar_fill_cv` 0.013 -- that
  calibration was made against the phantom air; ~0.019 reproduces the
  operator's ~30 psig (chill ~4.8 min). Not re-tuned; the team's call. Study and
  benchmark unaffected (vapour off there).
- One propellant alone no longer burns. A one-sided flow was evaluated at O/F
  zero, which the c* table clamps to its leanest point: the step after the LOX
  tank ran dry read 3,480 N from fuel alone. Both engine models now return the
  unlit chamber (ambient, no thrust) unless both sides deliver more than
  `MIN_CHAMBER_FLOW` (now defined in `feedtwin.engine.chamber`, shared with the
  burn report). Benchmark and Layer X parity unchanged.
- Gas pushed back through a locked-up regulator into a bottle vanished. It now
  returns to the tanks that sent it (pressurant conserved to 1e-9 again).
- `TankSim._one_step` dropped the rest of a step after a halving retry.
- The coupling guard did not see the press path between two ullages on one
  manifold (helium sawtooth); `Session._press_path_timescale`.
- The step a tank ran dry on delivered the whole step's flow to the engine
  while the tank gave only what it held: 17-25 g of propellant no vessel gave
  on the ethalox stand. The coupling step now ends where the tank does
  (`Session._dry_cut`) and the rest is solved with its outlet isolated; under
  that, `TankSim.advance` caps the outflow at what the tank holds and books any
  excess in `fixed_kg` (it used to zero the outflow below a gram, unbooked).
  `test_runs.py::test_a_tank_running_dry_burns_no_phantom_propellant` and
  `tests/test_tank_runs_dry.py`.

### Changed results
- **Drawings read gauge** (`feedtwin.model.pressure`, ADR 0004). A drawing's
  bare `psi` on an absolute pressure (tank, bottle, setpoint, dome,
  inlet_reference, MAWP, burst) is psig; `psia`/`bara` say absolute; a chamber
  pressure on ENGINE/INJECTOR stays absolute; differences (bias, droop, crack,
  relief set) refuse a reference. Units `psig/barg/kPag/MPag/Pag` and
  `psia/bara/kPaa/MPaa` added. The drawn dome loader now agrees with the dome
  knob (was 14.7 psi apart); a delivered bottle starts at its own fill target;
  the trip limit divides the pressure across the wall by the safety factor.
  Tier 2.1: GN2 T-0 550.0 to 550.7, dip -34.9 to -35.4, recovery 3.67 to
  3.79 s; helium dip -12.9 to -12.7, recovery 0.38 to 0.36 s (all inside
  tolerance; PHYSICS-BENCHMARK.md 2.1). LE4 burns unchanged.
- Cockpit (`Setup()` defaults) only: a freshly pressed LOX ullage in Ready falls
  548 to 260 psig in ~15 s at 95 % full (was ~6 s); ~25 s at a 6.6 kg load.
  Burns: LE4 GN2 -2 N, helium 0 N. Study and benchmark unchanged
  (`burn_setup`). See docs/PHYSICS-BENCHMARK.md 3.11.
- LE4 helium as drawn 6,579 to 6,726 N (sawtooth fix).
- Burns that run to depletion (cockpit; the Study and Layer X stop at
  `dry_kg` first and are unchanged). LE4 stand, ethalox_doublet_7000N, 95 %
  fill: 36,182.1 to 36,037.6 N.s, 6.225 to 6.200 s, 18.381 to 18.307 kg in the
  report. The fuel tank ran dry 20.0 ms into a 25 ms tick: ~29 N.s of that is
  the phantom propellant gone; the rest is the report's right endpoint, since
  the dry tick's frame now shows the stand after burnout. LOX residual
  4.378 to 4.438 kg. Mass balance at depletion 5.2 g booked as a guard (14 g
  unbooked at 4 % fill) to 1e-11 g.

### Performance
- Helium Fire 6.85 to 0.61 s per simulated second; GN2 0.23; holds 0.09.

## 0.1.0

The library as lifted out of the feed-twin app (ADR-0001).
