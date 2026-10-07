# feedtwin changelog

The physics library under feed-twin and EngineDesign's Layer X. Versioned in
`feedtwin/__init__.py`; every release here says what moved a number, by how much,
and which test or benchmark holds it. Format: newest first. A change that moves a
result names it under **Changed results**; a reader comparing two runs should
be able to find why they differ.

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

### Removed
- `Setup.regulator_supply_datum`, `Setup.regulator_lockup_supply` and their signals
  (`SUPPLY_DATUM_SIGNAL`, `LOCKUP_SUPPLY_SIGNAL`). `inlet_reference` still loads, is
  ignored, and `Regulator.check` warns.

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
