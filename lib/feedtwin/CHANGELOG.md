# feedtwin changelog

The physics library under feed-twin and EngineDesign's Layer X. Versioned in
`feedtwin/__init__.py`; every release here says what moved a number, by how much,
and which test or benchmark holds it. Format: newest first. A change that moves a
result names it under **Changed results**; a reader comparing two runs should
be able to find why they differ.

## Unreleased — 2026-10-11/12: a sealed tank holds its liquid; the watcher; properties near saturation

### Fixed
- **A sealed tank no longer refills itself with air as it drains.** The ullage floor
  (`TankSim._settled`) kept the pressurant at atmosphere's worth in the ullage's
  *present* volume, so liquid leaving a tank with its vent shut was replaced by air
  from nowhere. The operator's case: a full fuel tank, the fill stopped (Armed shuts
  the vent), a line open below the liquid -- the tank emptied at 129 g/s, held at
  0 psig, and the solver tab's clamp energy climbed ~57 J/s. A tank whose ullage has
  no open gas path to the air (`Session._sealed`, walked through the branches the
  solve has not shut; `TankSim.sealed`) now never has gas added by the floor: it pulls
  a vacuum and stops (14.25 psia against the column on LE4 (6), a few grams then
  nothing). A vented tank keeps the floor, which stands in for the air the vent lets
  back in and, on a built-in LOX load, for the boil-off the chill vents off the books.
- **Every branch closes against its own pressure** (`solve.steady._local_scales`,
  `LOCAL_TOLERANCE` 1 %). The convergence test scaled every branch's pressure
  residual by the highest fixed pressure on the stand; with a 6,000 psi K-bottle
  drawn, a branch could sit 0.5 psi off its relation and be called converged, and a
  drain driven by 0.45 psi of head never left the solve's 1 g/s starting guess. Each
  branch must now also close to 1 % of the larger of its end pressures (at least a
  bar). It only tightens, and not on choked rows; 1 % because a choked charge into
  an empty COPV closes to ~0.1 % and stalls there.
- **A dead engine no longer pushes back up the mains.** With no engine model the
  chamber counted any flow touching it as "lit" -- including flow out of it -- so
  after a burn it stayed at its drawn 385 psia and an Engine Abort's open mains drove
  3 kg/s from the dead engine into the tanks: 16 kg the mass balance could not
  account for on LE4 (6). Lit now means propellant arriving, and only while every
  tank still holding liquid is above the drawn chamber pressure; below it the
  chamber is the air (`Session._chamber`). A burn on tanks above it is unchanged.
- **A tank only takes in the liquid a tank sends it.** A tank the cart loads through
  the drawing credited any arrival at its outlet; at Fire on unpressed tanks the
  chamber's push-back filled a full LE4 fuel tank 46 g a second and, on a longer pad,
  overfilled it ("tank is overfull") and stopped the stand. Its intake is now capped
  at what its supply's outlet sends (and a supply's at what its fed tanks send back).
  What any tank refuses at its outlet is booked as a clamp (`TankSim.refused_kg`,
  in `fixed_kg`): unbooked, it read as mass lost.
- **A shut-in tank's outlet is closed implicitly** (`Session._close_outlet`, inside
  `_ullage_storage`). With the vent and press line shut, every gram that leaves
  expands a fixed mass of ullage, so the outlet is as stiff as that ullage; held at
  its start-of-step pressure, a sealed LE4 fuel tank on an open drain swung it
  ~30 g/s each way at rest and leaked 2 g/s. Now it settles at 14.20 psia in two
  Newton iterations, residual ~1e-13. Only for a tank with no live gas branch, so a
  pressed tank in a burn is untouched.
- **A dry tank whose outlet is a tee is a junction, not a cut** (`Session.
  _through_outlets`). LE4 (6)'s unsized tee joins the fill line and the dump into the
  cart transfer tank's outlet node; once that tank ran dry `_dry_branches` cut every
  branch on it, the fuel tank's way out through the tee with them, and the stand
  froze with Eth-Tank at 45 psig and the dump open (no solve at all). A dry tank's
  outlet with two or more lines on it, not being loaded through them, now has no
  pressure of its own and takes nothing from or gives nothing to the tank
  (`_outlet_split`); the fuel tank vents out through the dump to its head's vacuum.
  The dry tank's own ullage gas still cannot leave by its liquid port.

- **Properties near the saturation line come from the equation of state.**
  CoolProp's bicubic tables (first in every chain) interpolate across the saturation
  line wherever a table cell straddles it: nitrogen 10 K above its boiling point at
  1.07 bar read 83 kg/m³ for 4.3, saturated oxygen vapour at 90 K read 0.47 bar for
  0.99. `backends.coolprop._Dome` has the tables decline (p, T), (p, h) and vapour
  (rho, T) within 16 K of the line and near the critical point; HEOS answers. Away
  from it nothing changes (warm pressurant, LOX subcooled at tank pressure), so no
  calibrated result or benchmark moved; LE4 (6)'s cart pad runs ~9 % slower.
  `docs/PHYSICS-BENCHMARK.md` 4.12.
- **Vent gas that expands to its dew point is held as vapour** (`Session.
  _off_the_dew_line`, `_DEW_MARGIN_K` 0.5 K). GN2 vented off a chilled LOX tank landed
  on nitrogen's boiling point (77.87 K at 107.6 kPa); the next solve's (p, T) was on
  the saturation line, where no backend will say liquid or vapour, and every solve
  failed for 7 s of Vent on LE4 (6) with the cart -- the tanks stopped moving. A
  mostly-vapour landing in the two-phase dome is now taken as the vapour it nearly is,
  and the notes say so once; a flashing liquid is left alone.

- **A gas line on its own dew point is priced as vapour** (`comps.elements.
  conditions_from_fluid`, `DEW_POINT_MARGIN_K` 0.05 K). The same refusal reached
  another way: a chilled LOX tank's nitrogen ullage at 2.72 bar and 86.83 K seeded its
  press line exactly on the saturation curve, and every solve of the Ethalox Stand's
  Vent failed for 13 s. When (p, T) is refused at or below the dew point, the line is
  priced just above it.
- **Beyond the c* table's O/F range, only what can burn makes chamber pressure**
  (`engine.chamber.burning`, both `Chamber` and `CardChamber`). Clamped, an Engine Abort
  that vented the fuel tank ran LOX-rich at O/F 20-70 on the c* of O/F ~4, held the
  chamber at the fuel tank's own pressure and pushed the fuel line backwards on every
  other step (Ethalox Stand, COPV studies). Now the scarce propellant burns with as
  much of the other as the table's edge allows and the rest passes through unburned,
  as `unlit` already says a lone propellant does: continuous at the edge, unlit as one
  side goes to zero. Nominal burns are inside the table: benchmark and Layer X parity
  unchanged.

- **A venting tank that dips under the air no longer makes an atmosphere of gas.** A
  LOX tank filling after a skipped chill dipped 0.02 psi below atmosphere for one
  step; the floor switched on and asked for a whole atmosphere of nitrogen at the
  92 K wall, ignoring the 7.9 g of oxygen vapour holding a third of the pressure --
  57 g where the ullage held 17.6, 39.6 g from nowhere in one step, booked as a clamp
  (Ethalox Stand). Three parts:
  - Out of a built-in chill the floor grows the ullage only below atmosphere, and only
    to what puts the tank back at it (`TankSim._atmosphere_floor`: the pressurant's
    share of an atmosphere beside the vapour, at the gas's own temperature); with no
    vapour it also holds the pressurant there. Retention with vapour, the vent split,
    and the whole of a built-in chill (where the old floor stands in for the boil-off
    the chill vents off the books) are as before -- every calibrated chill test holds.
  - What the floor adds out of a chill is air an open vent let in: booked as inflow
    (`TankSim.vent_drawn_kg`, in `added_kg`), not as a clamp.
  - `skip_chill` leaves the ullage where a chill does -- at the chilled wall's
    temperature, at its pressure (`TankSim._chilled_ullage`), the gas that takes booked
    as the load's boil-off -- instead of warm gas over a cold wall.
- **An undrawn tanker hose passes nothing** (`Session._fill_hoses`, isolated from the
  solve). The hose stub is pinned at the tank's pressure, but a fill line with height
  trickled ~0.7 g/s through it into the outlet, a second copy of the commanded load the
  tank refused -- the Ethalox Stand's 1.7 g "mass not accounted for".

### Added
- **The watcher** (`feedtwin.session.watch`, `Session.watcher`): laws a correct
  stand cannot break, checked every tick, one flag per episode -- gas made in a
  sealed tank (`TankSim.floored_kg`), a branch left at the solve's starting flow
  (`solve.steady.INITIAL_FLOW`), pressure held against an open path for 2 s, liquid
  from nowhere, three unconverged ticks, five seconds above half the tolerance, and
  mass not accounted for. Read-only; a check that raises is a flag, never a stopped
  stand. Its first runs found the two faults above.

### Tests
- `tests/test_sealed_tank_drain.py`: a sealed tank draining gains no air and goes
  below atmosphere; a vent still stops at the floor; a 0.45 psi drain beside a
  6,000 psi bottle is solved; LE4 (6) with a drain teed into the fuel tank holds its
  fuel after the fill, and holds it still (no slosh, no flags); a dry transfer tank's
  tee lets the fuel tank vent through the dump (stuck at 34 psia before). Each fails
  on the code before its fix.
- `tests/test_props_near_dome.py` (against CoolProp's HEOS, not feedtwin; 9 of 12 fail
  with the guard off), `tests/test_dew_line.py`, `tests/test_chamber_out_of_table.py`.
- EngineDesign `tests/test_layerx_wire.py::test_a_trip_ends_the_burn_where_it_happened`
  asserted the tripped step was *short*, true only while the crossing fell in its first
  half; correct oxygen-vapour properties moved it 0.3 psi and 25 ms onto the step's end.
  It now asserts the trip is within one step of the last sample.

### Known
- The COPV study drawings run Vent after burnout 10-25x slower than real time: the
  wide-open dome regulator sits just short of choke (146 -> 49.5 psia), where the seat's
  drop is nearly vertical in flow, and Newton creeps (60-120 iterations a solve). Wants
  the near-choked seat solved in its inverse form.

- `tests/test_watch.py`: an LE4 (6) burn and abort raise no flag and keep their mass
  (16 kg lost before); the dead engine sits at atmosphere; a full fuel tank takes
  nothing from the chamber at Fire (46 g/s before); each check fires on its
  condition in a real stand; a flag is an episode.


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

### Fixed
- `builtin_rows(machine, model, drawn=None)` follows the drawing: the COPV charge and
  dump only while a vehicle bottle's fill is not drawn (not on LE4 (6), whose cart
  charges it; again rocket only), the fill-press row only for a cart transfer tank of
  its side with a drawn pressure (not on the shipped stand). The drawn-fill walk is
  `core.drawn_fills(model)`, which `Session._drawn_fill` now calls; `Session.builtin`
  lists the rows on a stand's own fills.
- An edited table missing a state the twin keys on is warned with that state's reason
  alone (`KEYED_STATES` is name -> reason), and one in which no state loads a side's
  tank is warned for that side (`statemachine.fills`, the rule `Session._fills` now
  calls).
- `lost_connectors`: only a connector named for a table row is matched by name again;
  a transducer's names nothing until it is rewired (docstring).

### Added
- `assemble_model(gas_swap=...)` / `swap_gases`: the pressurant replaced wherever a
  symbol declares it (bottles, press and dome lines; the network spreads it to the
  ullages); tanks and dewars keep their contents. `Setup.pressurant` (`""`, `"nitrogen"`,
  `"helium"`) names it for the caller that assembles, as `ignore_gse` does. Empty, the
  default, is the drawing's gas -- nothing changes.

### Changed results
- `roles.vehicle_only` (`Setup.ignore_gse`, rocket only) keeps the cart's vent lines
  (`roles.vent_branches`: behind a vehicle disconnect, no vessel, regulator or
  further coupling, and a valve the table opens, a relief or an outlet). They are
  plugged into the rocket until launch (the team, 2026-10-10), so rocket only a
  tank vents through the cart's vent valve, not a stand-in on its capped top
  disconnect. A LE4 (6) rocket-only burn is unchanged (thrust within 4e-5 N of
  6,916 N); its fuel tank vents from 519.9 psia to 14.7 psia in 10 s through
  FV-SOL. `roles.unpaired_vents` reports a vent whose halves are drawn unpaired.
- Otherwise none. A hookup without channels and a table without flags bind and run as before
  (`tests/test_daq_hookup.py`, `test_hookup.py`); the shipped table's aborts from its
  new `_states.csv` are the three the name rule found. The fixes above are reporting
  only: an LE4 (6) whole and rocket-only, and shipped-stand, pad walk is bit-identical
  to before (history, notes, drawn fills).

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
