"""A stand that exists in time.

Everything before this was a calculator with a state label on it: each request
re-solved from scratch with the tanks *pinned* at the regulator's setpoint. So
the tanks were always pressurised, "Fuel Press" changed nothing you could see,
and transducers read pressures that had no business existing. Nothing
accumulated, so nothing behaved.

A session fixes that by holding the thing a stand actually has -- **inventory**.
Each tank is a real vessel with a gas mass, a gas energy, a liquid mass and a
wall temperature, and those integrate forward. That single change is what makes
the sequence mean something:

* A tank starts **empty and at atmosphere**. Its transducer reads 14.7 psi,
  because that is what a vented tank reads.
* ``Ox Fill`` puts propellant in it. The level rises; the ullage shrinks.
* ``Ox Press`` opens the path from the regulator, gas flows into the ullage, and
  the pressure *climbs over several seconds* the way a real tank does -- fast at
  first into a small ullage, slower as it fills.
* ``Ox Vent`` opens it to atmosphere and it blows down.
* ``Fire`` opens the mains, propellant leaves, and the ullage cools and droops
  because the gas behind it is doing expansion work.

None of that is scripted. It falls out of integrating the vessels against a
network solved at each instant.

How a tick works
----------------
The system is a semi-explicit index-1 DAE: the vessels are differential, the
network is algebraic. Rather than hand the whole thing to a stiff integrator --
which is what Phase 07 did, and what would not converge on an imported
network -- this marches it at a fixed small step, which is what a flight
simulator does and is stable for the same reason:

1. Write each vessel's current pressure into its network boundary node.
2. Solve the network for flows. Pure algebra at frozen vessel state.
3. Hand those flows back to the vessels as inflow and outflow.
4. Advance the vessels by ``dt``.

A tick that fails to converge does not abort the session -- it holds the last
good flows and keeps going, because a stand does not stop existing because one
solve was hard, and the alternative is a simulator that dies mid-sequence.
"""

from __future__ import annotations

import copy
import math
import time
import uuid
from collections import deque
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Deque, Mapping

from feedtwin.comps.correlations import (
    DEFAULT_FRICTION_METHOD,
    darcy_friction_factor,
    reynolds,
)
from feedtwin.comps.iec_gas import XT_TYPICAL
from feedtwin.comps.regulator import (
    SEAT_XT_SIGNAL,
    Regulator,
)
from feedtwin.engine.balance import MixtureBalance
from feedtwin.engine.chamber import MIN_CHAMBER_FLOW as ENGINE_MIN_CHAMBER_FLOW
from feedtwin.engine.chamber import ChamberResult
from feedtwin.comps.wall import STAINLESS_DENSITY, LineWall, fitting_metal
from feedtwin.props import Fluid, PropertyError
from fluids.fittings import Cv_to_K
from feedtwin.vessels.convection import GasFilm, still_gas_conductance
from feedtwin.solve.network import Network
from feedtwin.solve.steady import SteadyResult, solve_steady
from feedtwin.vessels.geometry import CylindricalTank, cylindrical_from_volume
from feedtwin.vessels.collapse import ConductionCollapse, NoCollapse
from feedtwin.vessels.vapour import NoVapour, SaturatedVapour, latent_heat
from feedtwin.vessels.tank import Tank, TankRates, TankState
from feedtwin.vessels.volume import GRAVITY, GasVolume, VesselState

from feedtwin.pid.document import BOUNDARY_TYPES, INLINE_TYPES, SOURCE_TYPES
from feedtwin.pid.network import DOME_HANDLE, DomeLine, DomeLoader, propellant_side
from feedtwin.session.gauge import ATMOSPHERE, PSI, from_psig, psig
from feedtwin.session.diagnostics import SolverRecord, boundary_nodes, crossing
from feedtwin.session.hookup import CHARGE, DOME, Hookup
from feedtwin.session.model import AssemblyError, Model
from feedtwin.session.statemachine import Binding, StateMachine, _words

#: Standard atmosphere [Pa]. What a vented vessel sits at, and the zero of every
#: gauge on the stand -- see `feedtwin.session.gauge.psig`.
AMBIENT = ATMOSPHERE

#: Largest step a single tick may take [s]. A browser tab that was in the
#: background for a minute must not be allowed to integrate a minute of stand
#: in one Euler step; it catches up over several ticks or it does not catch up
#: at all, and either is better than a step that goes unstable.
MAX_STEP = 0.25

#: Largest fractional pressure change a vessel may make while the network flows
#: are held fixed.
#:
#: Sub-stepping the vessel alone is not enough. The flows come from one network
#: solve at the state the tick started in, so a tank filling fast integrates a
#: *stale* inflow: it sails past the pressure at which the regulator would have
#: closed and overshoots by a hundred psi before the next solve notices. Above
#: this the tick re-solves partway through, which is the only thing that stops
#: it -- the vessel cannot know the flow should have stopped.
MAX_COUPLED_CHANGE = 0.04

#: Liquid below which a tank is called dry [kg]. A tank does not deliver a
#: smooth trickle down to the last gram -- the outlet unports and the engine
#: gets gas -- so a small floor is closer to the truth than zero as well as
#: being better conditioned.
#: Sweeps of the enthalpy walk in `Session._propagate_temperatures`. The longest
#: path from a bottle to the injector face on a stand is under a dozen branches;
#: bounding it stops a recirculating drawing spinning.
_TEMPERATURE_SWEEPS = 12
#: Flow below which a branch carries no temperature information [kg/s].
_TEMPERATURE_MIN_FLOW = 1.0e-6
#: Temperature change worth another sweep [K].
_TEMPERATURE_TOL = 0.05

ROOM = 293.15
"""Room temperature [K]. Where a wall starts when its line has no upstream node
to take a temperature from -- which on a drawn stand is nothing."""

#: Propellant per side that counts as "lit" [kg/s]; the chamber's own rule.
MIN_CHAMBER_FLOW = ENGINE_MIN_CHAMBER_FLOW

DRY_MASS = 1.0e-3


#: Cap on those re-solves. One step is allowed to cost this many network solves
#: and no more; past it the step is simply taken, and the next one corrects.
#:
#: Raised from 12 once the coupling was sized from the ullage time constant
#: (see COUPLING_SAFETY): a helium ullage of half a litre behind a regulator has
#: a time constant of two or three milliseconds, and a 20 ms step needs far more
#: than twelve solves to resolve it. Nothing else bounds a slow tick any more
#: (TICK_BUDGET is effectively off): a stand that cannot keep up runs in slow
#: motion.
MAX_COUPLING_STEPS = 400

#: Fraction of the regulator-ullage time constant one coupling step may span.
#:
#: The regulator and the ullage it feeds are an RC pair: the ullage stores gas
#: (capacitance ``C = V rho / p``, kg/Pa) and the regulator meters it in
#: (resistance ``R = droop / rated_flow``, Pa per kg/s). Their product is a
#: time constant, and an explicit scheme that steps further than that in one
#: go does what explicit schemes always do past their stability limit: it
#: overshoots, the next solve overcorrects, and the trace fills with tick-rate
#: noise that looks like physics and is not. The lighter the gas, the smaller
#: ``C`` and the shorter the constant -- which is why helium, at the same dt,
#: was forty times noisier than nitrogen, and why the noise vanished as dt
#: fell. Sizing the step from the constant, rather than from how much the
#: vessels happened to move last tick, is the actual stability condition.
#:
#: **One tau, measured rather than assumed.** This was 0.25, on the reasoning
#: that a quarter of a time constant must be safe. It is -- and so is a whole
#: one. Sweeping it over a two-second burn against a tau/4 reference moves the
#: answer by less than the run-to-run noise until well past 1.0, and this step
#: is what a study spends all of its wall clock on:
#:
#: ==========  ==========  ==========  =============  =============
#: safety      GN2 speed   GN2 rough   helium speed   helium rough
#: ==========  ==========  ==========  =============  =============
#: 0.25 (was)  1.0x        0.53 psi    1.0x           0.54 psi
#: 1.00 (now)  3.2x        0.64 psi    3.4x           0.56 psi
#: 2.00        5.2x        1.21 psi    5.9x           0.55 psi
#: 4.00        7.3x        4.01 psi    10.5x          1.70 psi
#: 8.00        12.7x       11.98 psi   --             --
#: ==========  ==========  ==========  =============  =============
#:
#: "rough" is the worst tick-to-tick jump in tank pressure, which is what this
#: instability actually looks like on a plot. It is flat to 2.0 and broken by
#: 4.0, so one tau keeps a factor of four in hand -- and the RC estimate is
#: itself conservative, because it ignores line resistance, which only
#: lengthens tau. Raise it further only with a fresh sweep in hand.
COUPLING_SAFETY = 1.0

#: How long a primed stand has been sitting loaded before T-0 [s].
#:
#: Five minutes: long enough that the interface's ``1/sqrt(t)`` collapse flux
#: has fallen to a few percent of its first-second value and the wetted wall
#: has chilled to the liquid, short enough to be a pad hold rather than a
#: soak. A repressurisation just before ignition would reset the interface
#: clock to seconds and is the pessimistic case for pressurant consumption;
#: `Session.prime` takes ``hold_s`` so a study can ask for it.
PAD_HOLD_S = 300.0

#: Fill fraction below which a tank is worth mentioning.
LOW_TANK = 0.10

#: Fraction of its fill target below which a bottle is worth mentioning.
LOW_BOTTLE = 0.25

#: Propellant leaving a vehicle tank with the engine cold faster than this
#: [kg/s] gets a note naming where it goes: five grams a second, well over
#: anything a closed stand weeps and well under a dump.
LEAK_NOTE_KG_S = 0.005

#: Chamber closure tolerance [Pa] and iteration cap. The chamber node is a
#: boundary whose value depends on the flows it receives; each cockpit step
#: finds the pressure at which the network's delivery and the chamber's
#: c*-limited throughput agree, by regula falsi on a bracket that always
#: exists (ambient below, the feed pressure above). A relaxed step per tick
#: -- what this used to be -- is a fixed-point iteration on a map whose
#: slope is -p_c / (2 dp_injector): stable for a stiff injector, and for a
#: soft one (the 7200 N doublet at 40 psi of injector drop) it diverged
#: into a flip-flop between 718 psia and nothing, frame by frame.
CHAMBER_TOL = 0.5 * PSI
CHAMBER_ITERATIONS = 12

#: Width of the band over which a tank stops accepting gas, as a fraction of
#: the pressure supplying it [-].
#:
#: Matches the regulator's own `is_choked` band, deliberately: the two are
#: deciding the same question from opposite ends, and a vessel that closes at a
#: point while the component closes over a band will chatter between them.
SUPPLY_BAND = 0.005

#: Shut-to-open time for an actuator with none declared [s].
#:
#: Only reached when a drawing leaves `travel_time` off a valve. Fast for a
#: solenoid and slow for a big ball valve, so it is worth declaring; what it
#: must not be is zero, which is what this code did before and which makes the
#: ignition dip a property of the time step.
DEFAULT_TRAVEL = 0.05

#: Wall-clock budget for one tick [s].
#:
#: It was 0.15 s: past that the tick folded the coupling steps it had no
#: time for into one and let the next tick correct, so the panel never hung.
#: It also meant the cockpit's answer depended on what else the machine was
#: doing, and that the console and the Study tab -- the same physics, the
#: same code -- gave different traces. The console now runs the study's
#: numerics and never folds; when it cannot keep up with the wall clock it
#: runs in slow motion and the top bar says so. Effectively unbounded.
TICK_BUDGET = 1.0e9

#: The cockpit's outer integration step [s] -- the study's ``dt``. A panel
#: tick of up to 0.25 s is integrated as a run of these, so the vessel
#: integration, the temperature walk and the chamber closure happen on the
#: same grid whichever tab is asking.
LIVE_STEP = 0.02

#: An implicit coupling step was built and measured here, and removed. The
#: scheme -- move the vessels, re-solve the network where they landed, redo the
#: move on the average of the flows at both ends, iterate -- is trapezoidal, and
#: trapezoidal *is* A-stable. Picard iteration on it is not: the fixed point
#: only contracts while the step stays near the time constant, so past 4 tau it
#: diverged exactly like the explicit scheme, at twice the cost per step. On
#: GN2 it matched explicit at 3.0x against 2.8x; on helium it was worse, 2.4x
#: against 3.1x. Real implicit stability needs a Newton solve over the vessel
#: states and the network together, not a fixed point over them in turn -- and
#: that is a coupled Jacobian of perhaps fifty unknowns, which is the one place
#: in this model where the CFD toolbox would genuinely apply. See
#: docs/solver-notes.md.
#:
#: What does work is the linear half of that: each ullage enters the solve as
#: a storage node, its pressure an unknown tied to the gas it receives by the
#: vessel's own response over the step (``Session._ullage_storage``,
#: ``solve_steady(storage=...)``). Backward Euler on the press path, inside the
#: one Newton solve, at the cost of three trial vessel steps per tank.
#:
#: Vessel sub-steps inside one coupling step. The vessels are stiffer than the
#: network is expensive, so they take several short steps per solve.
SUBSTEPS = 4

#: How close to its chilled temperature a tank's wall must be for a load to
#: stop chilling it and start collecting [K].
CHILLED_BAND = 0.5

#: Temperature of the gas a GSE fill delivers [K]: a bank at ambient.
FILL_SUPPLY_T = 293.15
#: The state table's actuators for the GSE side of a bottle whose fill is not
#: drawn: its charge and its dump, the Diablo table's rows read as the DAQ reads
#: them. The one place the session names actuators itself, because that side
#: has no valve on the drawing for the hookup to bind. A table without them
#: cannot charge or dump such a bottle, and the notes say so (`Session._notes`).
GSE_CHARGE = "GSE High Press Control"
GSE_DUMP = "GSE High Press Vent"
#: The room [K], for the heat that leaks through a tank skin.
AMBIENT_T = 293.15
#: Fiberglass batt, for a drawing that gives a thickness and no conductivity.
FIBERGLASS_K = 0.04
#: A liquid colder than this is a cryogen for the purposes of the notes.
CRYOGENIC_K = 150.0
#: Relative step for the press-path slope in ``Session._press_path_timescale``.
#: Coarser than the solver's 1e-6: this sizes a step count, not a Newton step.
PRESS_PATH_FD = 1.0e-3
#: Probe for an ullage's storage slope in ``Session._ullage_storage``: the
#: share of its gas a trial step adds or takes. A finite difference, not a
#: physical number: small enough to stay linear, big enough to read through
#: the property layer's rounding.
STORAGE_PROBE = 1.0e-3
#: Share of the supply band a tick's drain must cover before the press-path
#: constant is applied (``Session._press_path_timescale``). A tenth: ~0.3 psi
#: a tick at a 550 psig lockup, against 2-6 psi on a burning LE4 helium tank.
PRESS_PATH_DRAIN_FRACTION = 0.1
#: Fixed-point passes on the fill line's friction factor, which depends on the
#: flow it sets. Clamond moves by under 0.1 % after the third.
FILL_LINE_ITERATIONS = 4
#: Wall roughness of the dewar's fill line [m]: drawn tube, the same number the
#: drawing reader falls back to for a pipe (``pid.network.FALLBACKS``).
FILL_LINE_ROUGHNESS = 1.5e-6
#: A wetted wall this far above its liquid is still chilling down, and will
#: boil the liquid hard if the tank is shut. Said in the notes.
WARM_WALL_K = 30.0
#: A bottle this much warmer than its own wall is still settling from its
#: fill, and its pressure will follow the gas down. Said in the notes.
HOT_BOTTLE_K = 15.0
#: Most of an ullage's mass one coupling step may move. Coarser than the 4 %
#: pressure-change rule because the vessel clips the lockup crossing exactly
#: (CHARGE_GAMMA below); this only sets how finely a fast press is resolved.
#: A wide-open regulator into a 3 g ullage still asks for ~300 steps a tick.
MAX_MASS_STEP = 0.10
#: Pressure rise per unit of mass charged into an ullage runs up to gamma
#: times the isothermal figure (an adiabatic charge lands at gamma T_in).
#: Helium's 1.67 bounds nitrogen's 1.40, so the clip errs toward refusing a
#: little that the next step then accepts, never toward overshooting.
CHARGE_GAMMA = 1.67
#: A tank is "being pressed" -- its charge jet stirring the ullage -- while it
#: sits more than this fraction of the supply pressure below the supply.
#: Inside the band it is at lockup, and what arrives is slosh, not a jet.
STIR_BAND = 0.02

#: Largest fraction of a vessel's gas mass one integration step may move. Above
#: this an explicit step overshoots -- a vent is the case that bites, because it
#: can empty an ullage in well under a second.
MAX_MASS_FRACTION = 0.02

#: Largest fraction of a vessel's gas *temperature* one step may change.
#:
#: Bounding mass alone is not enough. Gas leaving a tank carries its enthalpy,
#: which exceeds its internal energy by the flow work, so a vent removes energy
#: faster than mass and an ullage stepped for mass alone lands far colder than
#: it should. Temperature rather than energy because internal energy has an
#: arbitrary reference -- nitrogen's crosses zero in the range a blowdown visits,
#: and a fractional bound on a quantity that passes through zero means nothing.
MAX_TEMPERATURE_FRACTION = 0.03

#: How many times a sub-step may halve itself when the state it lands on is one
#: the equation of state will not price. Belt to the sub-stepping's braces: the
#: bound above is an estimate made before the step, and a vent onto a small
#: ullage is violent enough to beat an estimate.
STEP_RETRIES = 6

#: Cap on the adaptive sub-steps, so one violent instant cannot stall the tick.
MAX_VESSEL_STEPS = 200

#: Newton budget for one live solve. The study's figure; it was 30 on the
#: cockpit, which held the last good flows through the regulator's crossover
#: rather than resolving it. Same physics, same numbers, both tabs.
LIVE_ITERATIONS = 120

#: Convergence tolerance for a live tick. Looser than a reported steady solve
#: because this drives a display reading three significant figures at 5 Hz, and
#: the extra digit costs iterations that show up as stutter.
LIVE_TOL = 1.0e-4

#: History kept for the plots [samples]. At 10 Hz this is about seven minutes,
#: which covers a fill and a press and a burn.
HISTORY = 4000

#: A tank is called full here: a 5 % ullage, which is how the stand is loaded
#: (6.5 kg of ethanol plus 5 %, operator). Leaving real ullage is the point: a
#: tank filled to the brim has nowhere to put pressurant and would spike to the
#: relief on the first press. It was 0.85, a guess.
FULL_FRACTION = 0.95


@dataclass
class Setup:
    """What the operator can dial before and during a run.

    Fill rates are times-to-full rather than mass flows because that is what
    somebody setting up a rehearsal actually knows -- "the ox fill takes about
    two minutes" -- and because the supply doing the filling is a road tanker or
    a GSE cart that is deliberately not on the drawing yet. Everything else here
    is solved.
    """

    dome_psi: float = 500.0
    """Dome control regulator setting [psig] -- what the dial reads. The
    1092-50 delivers dome + its 50 psi bias less its supply effect, S x inlet
    gauge, so lockup is *not* dome + bias: on LE4 (6) off a full 4,500 psig
    bottle, 500 here locks the tanks up at 483.7 psig
    (docs/PHYSICS-BENCHMARK.md 4.11)."""

    copv_target_psi: float = 4500.0
    """Bottle fill target [psig], as its gauge would read it: what GN2 High
    Press fills the bottle to."""

    supply_press_s: float = 3.0
    """Seconds the cart's press line takes to bring a ground supply tank (a fuel
    transfer tank) to its drawn pressure, when that line is not on the drawing
    and its actuator ("Fuel Fill Press") is open. **Assumed**: a first-order
    rate standing in for a regulator and a line nobody has drawn. Draw the
    press line and this is not used."""
    copv_fill_s: float = 9.7
    """Seconds to take the bottle from empty to target while the fill valve is
    open. Fitted 2026-10-05 to the 12 Sep pulse fill (DAQ run
    daq_20260912_204917: six High Press CTRL pulses, 233 to 3,515 psig): with
    the stand's own valve commands, 9.7 s puts the twin's bottle within 183 psi
    RMS of the DAQ over the fill. The operator's 25 s was 1,489 psi RMS -- it
    reached 1,430 psig where the stand reached 3,515. The cart is not on the
    drawing, so this is a rate rather than a solved flow, and it only holds with
    the GSE bank well above the bottle: the rate is set by the bank side, not
    the solenoid. How hot the bottle ends up is ``fill_stirring``'s business,
    not this number's."""

    fuel_fill_s: float = 15.0
    """Seconds to take the fuel tank from empty to :data:`FULL_FRACTION`:
    about what pouring 6.5 kg of ethanol through the fill port takes on the
    stand (operator). Nothing to chill, so nothing slows it."""

    load_chill_s: float = 30.0
    """Seconds a cryogen load spends chilling a room-temperature tank before
    any liquid stays in it.

    LOX poured into a warm tank does not collect: it meets the wall, flashes,
    and leaves through the vent until the metal is down at saturation. On the
    stand that takes about ten minutes of pouring (operator); here it is
    compressed so a load can be watched, and the wall temperature on the tank
    card is what falls meanwhile. The flashed oxygen leaves with the vent
    rather than pressing the ullage -- at a twentieth of the real time it would
    be twenty times the real vent flow. Zero: the liquid collects from the
    first second and the wall chills as the load goes, which is the model
    before this existed.

    Only read with :attr:`dewar_psi` at zero. A dewar load chills in real
    time, at the rate its own flow takes heat out of the wall."""

    tank_fill_s: float = 120.0
    """Seconds to take a cryogen tank from empty to :data:`FULL_FRACTION`.

    Two minutes rather than the thirty seconds it was: a LOX load has to chill
    the tank wall as it goes, and the wall gives that heat up by boiling the
    liquid it meets, at a rate the vent has to carry. Loaded in thirty
    seconds the wall is still 240 K when the vent shuts and the tank runs
    away; loaded over minutes -- which is what a dewar transfer takes -- the
    frost has formed by the time it is full. Set it to what the load takes.

    Only read with :attr:`dewar_psi` at zero; with a dewar the load takes as
    long as its line delivers."""

    dewar_psi: float = 100.0
    """LOX dewar pressure [psig] -- what pushes a cryogen load into its tank.

    The stand fills from a ~100 psig dewar (operator, 2026-10-05). The dewar
    and its fill line are GSE and not on the drawing yet, so they are this
    knob and the three below. With it set, a load is a flow: the dewar
    pressure less the tank's, through the fill line. While the tank wall is
    warm, everything that arrives boils on it and the vapour goes into the
    ullage, so the tank climbs until the vent carries what the dewar sends --
    the rise the stand shows during a chilldown, larger the faster it pours.
    Once the wall is at saturation the liquid collects. The dewar's liquid is
    taken at the tank's own liquid temperature, and the dewar's height above
    the tank is not counted.

    Zero: the fixed-rate load of :attr:`tank_fill_s` and
    :attr:`load_chill_s`, which is the model before this existed."""

    dewar_line_bore_mm: float = 7.75
    """Bore of the dewar's fill line [mm]: 3/8 in tube, 0.035 in wall
    (operator: 3/8 in lines for now). Friction by Clamond over
    :attr:`dewar_line_length_m`, plus the exit into the tank."""

    dewar_line_length_m: float = 3.0
    """Length of the dewar's fill line [m]. Estimated: a hose from a dewar
    beside the stand to the tank's fill disconnect. Measure it."""

    dewar_fill_cv: float = 0.019
    """Flow coefficient of everything on the fill line that is not tube [Cv]:
    the dewar's liquid valve, the cart's LOX Fill valve, the disconnect. In
    practice, how far the dewar valve is open.

    Calibrated, not known, and the calibration depends on the drawing's vent.
    The stand tops out near 30 psig while a LOX tank chills, in about ten
    minutes (operator). On the LE4-like test stand (the tank vented through
    its top disconnect and the cart's Cv 0.5 valve,
    tests/test_dewar_load.py) this value reads ~30 psig at 30 s and chills in
    ~4.8 min; 0.013 read ~21 there once the vent stopped taking back air the
    pressurant floor re-created (2026-10-06). LE4 (6) as drawn vents through a
    different path: there this peaks at 57 psig and chills in 5.3 min, 0.013
    at 38 psig and 6.9 min (2026-10-08). The team set it here (2026-10-08:
    nobody waits out a chilldown in the cockpit -- :meth:`Session.
    skip_chilldown`). A clean 3/8 in line from 100 psig pours ~0.7 kg/s; every
    gram of it boils on a warm wall, and the tank rides up to the dewar's own
    pressure."""

    gse_vent_cv: float = 0.5
    """Flow coefficient of the cart's vent valve [Cv] (operator: ~0.5).

    A tank with no vent valve drawn vents through a disconnect on its top and
    a valve on the cart (see ``feedtwin.pid.network._gse_vents``); where the
    drawing gives that disconnect no Cv or Cd, this is its size. It was the
    fallback valve's Cv 4, which no one chose."""

    fill_stirring: float = 20.0
    """Multiplier on a vessel's gas-to-wall conductance while gas is being
    charged into it -- the bottle during its GSE fill, a tank ullage during a
    press.

    The still-gas conductance is the vessel's ``wall_conductance``; a charge
    jet stirs the vessel and forced convection off it runs several times
    natural, which is what keeps a real 25 s fill from landing at the
    adiabatic-charge temperature. Twenty is an estimate with the right order
    of magnitude -- a 25 s GN2 High Press then ends with the gas at 336 K
    over a 316 K wall and sags 3% in the next minute, against 380 K and 12%
    for a still vessel -- to be calibrated against the bottle RTD after a
    real fill; 1 is a still vessel and the full adiabatic-charge heating."""

    bottle_delivered: bool = False
    """The pressurant bottle arrives full and cold, at the pressure and
    temperature the drawing states for it, the way a supplier's cylinder does.

    Off (the default), it starts empty and ``GN2 High Press`` fills it from
    GSE over ``copv_fill_s`` -- which is what the Diablo table's ``GSE High
    Press Control`` actuator is for. On, the bottle is cold, so the tanks it
    presses sag only by their own charge heating (~30 psi), which is what a
    stand whose bottle was filled hours earlier shows."""

    ullage_collapse: bool = True
    """Model heat leaving the ullage into the propellant surface.

    Real, and it is why a tank droops on a long hold: warm pressurant meets cold
    liquid and gives its heat up across the interface. Off, the ullage exchanges
    heat only with the vessel wall.

    Toggleable because it is a *separate* question from how much gas a bottle
    can deliver, and mixing the two makes a pressurant study impossible to read
    -- collapse and an under-sized COPV both show up as a tank that will not
    hold pressure."""

    ullage_vapour: bool = True
    """Propellant vapour in the ullage -- boil-off and condensation.

    On by default on the cockpit since 2026-09-11. It was off, on the grounds
    that for a storable at room temperature it is negligible (ethanol at
    293 K is 5.8 kPa of vapour against a 38 bar ullage) and that it is the
    more fragile model. Both still true; but a LOX tank without it cannot
    boil, so with the vent shut it sat at whatever it was pressed to
    forever, and an operator who knows a loaded LOX tank climbs read that as
    the twin being broken. With this on and ``ambient_leak`` giving the wall
    somewhere to get heat from, it climbs. The study sets its own.
    See :mod:`feedtwin.vessels.vapour`."""

    ambient_leak: float = 8.0
    """Air film on the outside of the tanks [W/(m^2.K)]; zero is a tank with
    no outside. Eight is still air on a cold surface. What the *liquid* sees
    is this in series with whatever insulation the drawing declares on the
    tank (``insulation_thickness``, ``insulation_conductivity``): an inch of
    fiberglass takes a bare tank's ~450 W down to ~75 W, half a gram a second
    of boil-off, a psi every few seconds with the vent shut. The LOX tank on
    the stand wears an inch of fiberglass (operator). An estimate either way:
    the RTD on the tank and the vent's hiss say what it really is."""

    line_walls: bool = True
    """Heat a line's own metal gives the gas flowing through it.

    **On by default** since 2026-10-03 (the team: "fitting heat should be on";
    the feed twin is the source of truth, so the cockpit and EngineDesign's
    Layer X read it from here). The Study keeps it off unless asked
    (:func:`~feedtwin.session.burn.burn_setup`). It is the thermal option with
    the largest known bias behind it. Every component is otherwise adiabatic, and
    for a liquid leg over a five-second burn that is fine; on the pressurant path
    it is not. Nitrogen leaves the regulator at 251 K into metal sitting at
    293 K, and the drawn press path carries about 420 g of tube and fittings --
    worth **6.1 K at ignition and 4.4 K averaged over the burn, 14% of the
    30.3 K Joule-Thomson drop.** A metre of line with ten fittings is 37%.

    Needs `wall_thickness` and/or `fitting_mass` on the lines to have any effect;
    a drawing that states neither has no metal to give and this changes nothing.
    See :mod:`feedtwin.comps.wall`, including what it deliberately leaves out."""

    chilldown: float = 100.0
    """Liquid-to-wall conductance [W/(m^2.K)]. Zero disables chilldown.

    The wall term the tank already had is ullage-to-wall; this is the wetted
    face. It is what cools a tank during a load, and with `ullage_vapour` on it
    is what boils the propellant while doing so. A number rather than a flag
    because the honest value depends on insulation and fill, and nobody should
    be able to turn on "chilldown" without saying how hard.

    Order of magnitude for a bare stainless tank in film boiling: 50-200. An
    insulated one is far lower. Zero is the tank this model assumed before
    2026-09-11, adiabatic below the surface; it is what the Study and Layer X
    pass, not the default.

    100 W/(m^2.K) by default (the cockpit's, and this library's) since
    2026-09-11 (it was 0): the
    ambient leak arrives at the wetted wall and this is the only way it
    reaches the liquid. Boiling on a wall a few kelvin above saturation runs
    at hundreds to thousands; a hundred passes a 400 W leak with 10 K of wall
    superheat. The study sets its own."""

    tick_budget: float = TICK_BUDGET
    """Wall-clock seconds one tick may spend before folding the rest of its
    coupling steps into one. Effectively off everywhere since the console took
    the Study's numerics (docs/PHYSICS-BENCHMARK.md 3.10): a folded step is
    exactly the under-resolved step the coupling count was chosen to avoid, and
    a console that folds integrates a different scheme from the one benchmarked.
    Lower it and the fold in :meth:`Session._integrate` comes back."""
    max_iterations: int = LIVE_ITERATIONS
    """Newton iterations the network solve may take per coupling step.

    The Study's 120 on the console too, since it held the last good flows
    through a regulator's crossover at 30. A solve that has not closed in this
    many iterations holds the last converged flows and pressures for the step
    (nothing moves right after the circuit changed), which the frame reports as
    not converged. A helium burn, whose regulator branch is nearly flat and whose
    Newton steps are correspondingly long, went from 39 failed ticks in 140 to 4
    by raising this from 30 to 60.
    """

    # ---- the constants that used to be module-level, now dialled from the
    # Configuration tab (feed-twin backend/tunables.py explains each). These are
    # the cockpit's values, which Layer X and the Study tab share. The benchmark
    # study is *not* run at them: `feedtwin.session.burn.burn_setup` turns
    # stratification, boiling onset, nucleate boiling, line walls,
    # ullage-wall-by-level, the compressible regulator seat and the automatic
    # vent off, because the expectations in docs/PHYSICS-BENCHMARK.md 2.x were
    # stated before those existed.
    wall_boiling: bool = True
    """Boil at a superheated wetted wall (needs ``ullage_vapour``)."""
    chilldown_nucleate: float = 3000.0
    """Wall-to-liquid conductance in nucleate boiling [W/(m^2.K)], once the
    wall superheat is under ``leidenfrost_K``. Zero: film value throughout."""
    leidenfrost_K: float = 40.0
    """Wall superheat above saturation at which a vapour film insulates the
    wall (film boiling) rather than the liquid wetting it [K]."""
    boiling_onset_K: float = 2.0
    """Wall superheat needed before the wetted wall boils rather than warming
    the liquid [K]; nucleate-boiling incipience for a cryogen on metal."""
    stratification: bool = True
    """Track a surface layer apart from the bulk liquid. Off: well mixed."""
    surface_layer_m: float = 0.01
    """Thickness of the stratified surface layer [m]."""
    surface_mixing: float = 5.0
    """Layer-to-bulk conductance per unit interface area [W/(m^2.K)]."""
    fill_supply_T: float = FILL_SUPPLY_T
    ambient_T: float = AMBIENT_T
    full_fraction: float = FULL_FRACTION
    charge_gamma: float = CHARGE_GAMMA
    supply_band: float = SUPPLY_BAND
    stir_band: float = STIR_BAND
    valve_travel_s: float = DEFAULT_TRAVEL
    auto_vent: bool = True
    """Go to Vent on its own when a tank runs dry during Fire."""
    low_tank: float = LOW_TANK
    warm_wall_K: float = WARM_WALL_K
    hot_bottle_K: float = HOT_BOTTLE_K
    tank_wall_kg_per_L: float = 8.0 / 17.5
    tank_wall_capacity: float = 900.0
    tank_wall_hA: float = 12.0
    wall_hA_from_gas: bool = True
    """Estimate a vessel's gas-to-wall conductance from its gas and its size
    (Churchill–Chu natural convection, ``feedtwin.vessels.convection``) when
    the drawing leaves it blank, instead of the per-litre default above. A
    value on the drawing always wins."""
    ullage_wall_by_level: bool = True
    """A tank's ullage exchanges heat with the dry wall only -- the wall above
    the liquid -- so its wall conductance is scaled by that wall's share of the
    tank. Off: the whole tank's conductance at every fill (the scheme the
    benchmark Study was stated at; ``burn_setup`` pins it off). On a 95 % full
    LOX tank the difference is ~20x, and a freshly pressed ullage fell from 548
    to 260 psig in six seconds of Ready instead of the ~30 s the stand shows."""
    wall_hA_dT: float = 10.0
    """Gas-to-wall temperature difference the still-gas film is evaluated at
    [K]. Natural convection stiffens roughly as dT^(1/4); ten kelvin is a
    blowdown in progress."""
    burst_safety_factor: float = 2.0
    """A vessel trips the stand at ``burst_pressure / this``. Two is the
    factor the team designs to; a drawing that still carries an MAWP trips
    at that instead."""
    bottle_wall_kg_per_L: float = 60.0 / 44.0
    bottle_wall_hA: float = 20.0
    bottle_volume_L: float = 4.6871
    """Water volume of a pressurant bottle the drawing gives none [L]: the
    stand's COPV. A 45 scf SCBA cylinder holds 52.8 mol of free air (70 degF,
    14.696 psia); at 4500 psi air's Z is 1.1145, so the cylinder is 4.64 L, plus
    3 in^3 of fittings (operator). It was a 44 L K-bottle, which blew LE4's
    bottle down 250 psi in a burn its real one loses thousands in. A value on
    the drawing always wins."""
    live_step: float = LIVE_STEP
    max_coupled_change: float = MAX_COUPLED_CHANGE
    coupling_safety: float = COUPLING_SAFETY
    max_mass_step: float = MAX_MASS_STEP
    body_acceleration: float = GRAVITY
    """Proper acceleration along the vehicle's long axis [m/s^2]: what an
    accelerometer on it reads. Every liquid column -- tank heads and line
    elevation -- is ``rho * this * dz``. Standard gravity on a stand or a pad
    (the default, so nothing changes unless it is set); thrust less drag over
    mass in flight: 8.6 g at liftoff and 9.8 g at burnout on LE4 flown on
    the helium drawing (Layer X, 2026-10-03), where each metre of vertical
    fuel line carries ~11 psi of head instead of ~1."""
    chamber_tolerance_psi: float = (
        0.5  # CHAMBER_TOL, in psi: 0.5 * PSI is the same float
    )
    """How closely the chamber closure solves ``g(p) = p`` each coupling step
    [psi]. Half a psi is 0.13 % of a 380 psia chamber: invisible on a panel,
    and the same order as an engine card's whole error, so a caller quoting
    thrust to a tenth of a percent (EngineDesign's Layer X) sets it tighter."""
    network_tolerance: float = LIVE_TOL
    """Scaled residual the network solve must reach each coupling step.

    Each mass balance is judged against the largest node demand (at least
    1 g/s) and each branch against the highest boundary pressure -- the
    bottle -- so 1e-4 on a full COPV is ~3 kPa on every branch, and an
    injector drop comes out a few tenths of a percent off its own relation. A
    caller quoting the engine finer than that sets this lower."""
    regulator_compressible_seat: bool = True
    """The regulator's wide-open seat seen as a gas sees it: IEC 60534-2-1's
    expansion factor ``Y = 1 - x / (3 F_gamma xT)`` and its choke at
    ``x >= F_gamma xT`` (:mod:`feedtwin.comps.iec_gas`), in place of the
    incompressible ``K rho v^2 / 2`` at the inlet density, which overstates a
    GN2 regulator's capacity near burnout by 25 % (0.398 against 0.319 kg/s on
    the COPV study's GN2 drawing; EngineDesign/docs/layerx/AUDIT.md 5.3, 9.6 C3)
    and by up to 1.5x choked. Only a wide-open regulator is affected: while it
    regulates, its outlet is the droop law and the seat never binds.

    **On by default** since 2026-10-08 (the team), in the cockpit, Layer X and
    the Study tab. Measured then: the LE4 (6) helium burn and a press from
    50 psig to lockup bit-identical; the COPV study's GN2 drawing burned off a
    1,200 psig bottle, -0.04 % thrust. :func:`~feedtwin.session.burn.burn_setup`
    pins it off, so the benchmark Study is the incompressible law its
    expectations were stated at. Off is that law, bit for bit."""
    regulator_xT: float = XT_TYPICAL
    """The seat's pressure-differential ratio factor at choked flow, for a
    regulator whose drawing gives none (a drawn ``xT`` wins). 0.70: IEC 60534's
    typical value, **assumed** -- nobody has measured the 1092's. Read only with
    :attr:`regulator_compressible_seat` on."""
    ullage_wall_T0_K: Mapping[str, float] = field(default_factory=dict)
    """Upper (ullage) wall temperature at T-0, per tank id [K].

    :meth:`Session.prime` builds a loaded tank's wetted wall at its liquid and
    its upper wall at the pressurant's temperature, 293.15 K. That is right
    for a tank pressed from warm, wrong for a LOX tank whose ullage wall has sat
    above the liquid for a hold: at 150 K it costs ~225 psi of bottle on the LE4
    helium burn and sags the tank 578 -> 565 psia in the lead-in
    (EngineDesign/docs/layerx/AUDIT.md D1, 9.5 section 2). A tank named here
    starts with its upper wall at that temperature and its gas where it was
    (freshly pressed, warm); the settle and the burn then exchange heat between
    them. Empty -- the default -- is the previous behaviour exactly. Measured by
    an RTD on the tank's upper shell, where there is one; otherwise sweep it."""
    cryogen_ullage_wall_T0_K: float = 0.0
    """The same, for every tank holding a cryogen (liquid below 150 K) that
    :attr:`ullage_wall_T0_K` does not name [K]. Zero -- the default -- leaves
    the upper wall at the pressurant's temperature, exactly as before. A dial
    for the cockpit's Configuration tab, where a per-tank map has no row."""
    ground_rests: bool = True
    """The ground support is integrated only while it is doing something. A
    cart vessel with nothing flowing in or out of it, and no built-in press
    acting on it, holds where it is: its wall, vapour and ambient leak stand
    still until a valve puts it to work. And while the engine burns, the
    ground with no open path to the vehicle leaves the solve as well -- its
    lines carry nothing and read what they last read -- so the burn is
    solved on the vehicle alone. Nothing it holds can reach the vehicle until
    a valve joins them, so the burn is a vehicle-only drawing's, number for
    number; on LE4 (6) the cart is two-thirds of the network and was most of
    a Fire tick. **Simplification** (the team, 2026-10-07: the cart's
    physics is not what the twin is for). Only a drawing with its ground
    support drawn has anything to rest. Off integrates every cart vessel
    every step, as before."""
    ignore_gse: bool = False
    """Simulate the rocket alone and fill it the simple way. On: everything
    off the vehicle (:func:`feedtwin.pid.roles.vehicle_only`) is cut from the
    drawing before it is built -- the cart's tanks, bottles, dewar,
    regulators and valves are not simulated at all, and each vehicle
    disconnect is a capped half. What a one-page drawing of the rocket gets
    then stands in for the cart: GN2 High Press charges the bottle to
    :attr:`copv_target_psi` over :attr:`copv_fill_s`, Fuel Fill pours over
    :attr:`fuel_fill_s`, Ox Fill loads from a dewar at :attr:`dewar_psi`,
    and the dome is :attr:`dome_psi`, set on the dome-loaded regulator
    itself. **Simplification** (the operator, 2026-10-08: the twin misreads
    the complicated GSE, and "the rest is only handled on the rocket, which
    is what we need"). Read when the model is assembled
    (``assemble_model(vehicle_only=...)``), so changing it opens a new
    stand; a session reports the value its model was built with. Off -- the
    default -- simulates the drawn GSE, exactly as before."""


def _not_a_liquid_tank(
    label: str, species: str, temperature: float, exc: Exception
) -> str:
    """Why a tank could not start, in the drawing's terms."""
    try:
        critical = Fluid(species).critical_temperature
    except Exception:  # noqa: BLE001 - the message must not fail too
        critical = float("nan")
    if critical == critical and temperature > critical:
        return (
            f"{label} holds {species} at {temperature:.0f} K, above its critical "
            f"temperature ({critical:.0f} K), so it cannot be a liquid and a TANK "
            "has nothing to start from. If it is the pressurant (a COPV or a "
            "bottle), draw it as a Pressurant bottle (KBOTTLE); if it is a "
            "propellant, give it the liquid's temperature."
        )
    return (
        f"{label} could not start as a {species} tank at {temperature:.0f} K "
        f"({exc}). Check its fluid and temperature; a vessel of gas is a "
        "Pressurant bottle (KBOTTLE), not a TANK."
    )


def _bottle_geometry(volume: float) -> CylindricalTank:
    """A cylinder at L/D = 4 holding this volume: the shape of a gas bottle,
    which the drawing does not give and the film only needs roughly."""
    diameter = (max(volume, 1e-9) / math.pi) ** (1.0 / 3.0)
    return cylindrical_from_volume(volume, diameter)


def _tank_geometry(volume: float, diameter: float) -> CylindricalTank:
    """A barrel of the right volume at the drawing's diameter, 2:1 heads.

    Delegates to the library so the drawing reader's static head and this
    vessel agree on where the liquid surface is.
    """
    return cylindrical_from_volume(volume, diameter)


#: Vessel-wall defaults, stated per litre and scaled by area, for a drawing
#: that declares none. Each is `estimated` and is reported as an assumption
#: whenever it is used; a drawing that knows better declares `wall_mass`,
#: `wall_capacity` and `wall_conductance` on the symbol and these never fire.
#:
#: These used to be three bare numbers -- 8 / 900 / 12 for a tank and
#: 30 / 500 / 20 for a bottle -- applied to every vessel whatever its size, so a
#: 4.7 L cylinder was given a 44 L K-bottle's wall. Mass now scales with
#: volume; conductance ``hA`` scales with surface area, hence as V^(2/3).
TANK_WALL = {
    "kg_per_litre": 8.0 / 17.5,
    "capacity": 900.0,
    "hA_ref": (12.0, 17.5),
    "basis": "aluminium tank, 8 kg at 17.5 L; hA 12 W/K at 17.5 L scaled as V^(2/3)",
}
BOTTLE_WALL = {
    "kg_per_litre": 60.0 / 44.0,
    "capacity": 500.0,
    "hA_ref": (20.0, 4.687),
    "basis": "steel K-bottle, ~60 kg at 44 L water volume; hA 20 W/K at 4.687 L "
    "scaled as V^(2/3). A composite cylinder is far lighter -- declare it",
}


def _skin_conductance(node: object, air_film: float, assumptions: list[str]) -> float:
    """Overall air-to-wall conductance per unit skin [W/(m^2.K)].

    The air film in series with the insulation the drawing declares:
    ``U = 1 / (1/h_air + t/k)``. A tank that declares no insulation is bare,
    and says so in the assumptions when it is a cryogen tank, because the
    difference is a factor of six in boil-off.
    """
    params = getattr(node, "params", {}) or {}
    label = getattr(node, "label", "") or getattr(node, "id", "vessel")
    if air_film <= 0.0:
        return 0.0
    thickness = params.get("insulation_thickness")
    conductivity = params.get("insulation_conductivity")
    t = float(thickness.si) if thickness is not None else 0.0
    k = float(conductivity.si) if conductivity is not None else 0.0
    if t <= 0.0:
        return air_film
    if k <= 0.0:
        k = FIBERGLASS_K
        assumptions.append(
            f"{label} insulation: {t * 1e3:.0f} mm on the drawing, conductivity not "
            f"specified; {k} W/(m·K) assumed (fiberglass)."
        )
    return 1.0 / (1.0 / air_film + t / k)


def _trip_limit(node: object, safety_factor: float, assumptions: list[str]) -> float:
    """Absolute pressure a vessel trips the stand at, or 0 for no limit.

    The drawing says what the vessel will take as a burst pressure -- what a
    team that built it knows -- and the stand stops at that over a stated
    factor of safety. An older drawing carrying an MAWP trips at the MAWP.

    Both are read as the drawing reads them (feedtwin.model.pressure): bare
    "psi" is gauge, so ``.si`` is already absolute. The safety factor divides
    what the wall carries -- the pressure across it, gauge -- not the absolute.
    """
    params = getattr(node, "params", {}) or {}
    label = getattr(node, "label", "") or getattr(node, "id", "vessel")
    burst = params.get("burst_pressure")
    if burst is not None and burst.si > ATMOSPHERE:
        sf = max(float(safety_factor), 1.0)
        across = (float(burst.si) - ATMOSPHERE) / sf
        assumptions.append(
            f"{label} trip limit: burst pressure / {sf:g} ({across / PSI:.0f} psig)."
        )
        return across + ATMOSPHERE
    rated_at = params.get("MAWP")
    return float(rated_at.si) if rated_at is not None else 0.0


def _vessel_wall(
    node: object,
    litres: float,
    defaults: dict[str, Any],
    assumptions: list[str],
    estimate: Callable[[], GasFilm] | None = None,
) -> tuple[float, float, float]:
    """``(wall_mass, wall_capacity, wall_conductance)`` for one vessel.

    From the drawing where it says; from the scaled defaults where it does
    not, with a note. Reading the three separately, so a drawing that weighed
    the vessel but has no idea of its film coefficient still gets credit for
    the number it knows.
    """
    params = getattr(node, "params", {}) or {}
    label = getattr(node, "label", "") or getattr(node, "id", "vessel")
    missing: list[str] = []

    def read(name: str, fallback: float) -> float:
        param = params.get(name)
        if param is not None and param.si > 0.0:
            return float(param.si)
        missing.append(name)
        return fallback

    ha_ref, litres_ref = defaults["hA_ref"]
    mass = read("wall_mass", defaults["kg_per_litre"] * litres * 1e3)
    capacity = read("wall_capacity", defaults["capacity"])
    conductance = read(
        "wall_conductance",
        ha_ref * (max(litres * 1e3, 1e-6) / litres_ref) ** (2.0 / 3.0),
    )
    # The film from the gas, when the drawing said nothing and the setup
    # asks. Replaces the per-litre default, not a declared value.
    if estimate is not None and "wall_conductance" in missing:
        try:
            film = estimate()
        except Exception as exc:  # property failure: keep the default, say so
            assumptions.append(
                f"{label} wall film: not estimable ({exc}); per-litre default "
                f"{conductance:.1f} W/K used."
            )
        else:
            conductance = film.hA
            assumptions.append(
                f"{label} wall film: hA {film.hA:.1f} W/K, natural convection in "
                f"the ullage (Churchill–Chu; h {film.h:.1f} W/(m²·K), "
                f"{film.area:.2f} m², ΔT {film.delta_T:g} K, "
                f"Ra {film.grashof * film.prandtl:.2e})."
            )
    if missing:
        assumptions.append(
            f"{label} wall: {mass:.2f} kg, {capacity:.0f} J/(kg·K), "
            f"{conductance:.1f} W/K, estimated ({defaults['basis']}). Not on the "
            f"drawing: {', '.join(missing)}."
        )
    return mass, capacity, conductance


@dataclass
class TankSim:
    """One propellant tank, integrating."""

    id: str
    label: str
    tank: Tank
    state: TankState
    ullage_node: str
    outlet_node: str
    #: Set while a Fill state is selected for this tank.
    filling: bool = False
    empty: bool = False
    fill_seconds: float = 30.0
    #: Seconds a load takes to chill this tank's wall from room temperature
    #: before liquid collects; zero for none (see :attr:`Setup.load_chill_s`).
    chill_seconds: float = 0.0
    #: The pour is still chilling the wall: nothing is collecting yet.
    chilling: bool = False
    #: Propellant the chill has flashed off and vented [kg].
    chill_boiled: float = 0.0
    #: Dewar pressure behind a cryogen load [Pa absolute]; zero loads at the
    #: fixed rate of ``fill_seconds`` instead (see :attr:`Setup.dewar_psi`).
    dewar_pressure: float = 0.0
    #: The dewar's fill line: bore [m], length [m], and the Cv of what on it
    #: is not tube. See :attr:`Setup.dewar_fill_cv`.
    fill_line_bore: float = 7.75e-3
    fill_line_length: float = 3.0
    fill_cv: float = 0.019
    #: What the dewar delivered over the last step [kg/s].
    fill_flow: float = 0.0
    #: The drawing symbol this was built from, for knobs re-read live.
    node: object = None
    #: Maximum allowable working pressure [Pa], 0 if the drawing gives none.
    mawp: float = 0.0
    #: Dials the session copies in each tick (see feed-twin backend/tunables.py).
    full_fraction: float = FULL_FRACTION
    #: What a load stops at [kg]: the engine's fire load for this tank
    #: (:meth:`Session.fire_loads`), 0 for "fill to :attr:`full_fraction`".
    load_kg: float = 0.0
    charge_gamma: float = CHARGE_GAMMA
    supply_band: float = SUPPLY_BAND
    stir_band: float = STIR_BAND
    gravity: float = GRAVITY
    """What the liquid column feels [m/s^2]; the session copies
    :attr:`Setup.body_acceleration` in each tick."""
    #: Ledger for the solver tab (feedtwin.session.diagnostics), cumulative:
    #: mass the built-in load put in [kg]; mass and ullage energy the
    #: integrator's own guards changed beyond what the rates said -- floors,
    #: clamps, a step that could not be reached -- [kg] and [J]. Read, never
    #: acted on.
    added_kg: float = 0.0
    fixed_kg: float = 0.0
    fixed_J: float = 0.0

    @property
    def pressure(self) -> float:
        return float(self.tank.pressure(self.state))

    @property
    def outlet_pressure(self) -> float:
        return float(self.tank.outlet_pressure(self.state, self.gravity))

    def take_back(self, mass: float) -> None:
        """Return pressurant this ullage sent out that no vessel took [kg].

        It left booked at the ullage's enthalpy, so it comes back at it: the
        exact reverse of the debit in :meth:`advance`.
        """
        if mass <= 0.0:
            return
        ullage = self.state.ullage
        self.state = replace(
            self.state,
            ullage=replace(
                ullage,
                mass=ullage.mass + mass,
                energy=ullage.energy + mass * self.tank.gas_enthalpy(self.state),
            ),
        )

    def readouts(self) -> dict[str, float]:
        return {
            "pressure_psi": psig(self.pressure),
            "ullage_temperature_K": self.tank.gas_temperature(self.state),
            "liquid_mass_kg": self.state.liquid_mass,
            "liquid_temperature_K": self.state.liquid_temperature,
            "fill_fraction": self.tank.fill_fraction(self.state),
            "level_m": self.tank.level(self.state),
            # The metal under the liquid. A LOX tank whose wall is still warm
            # boils hard the moment its vent shuts; the panel and the pad
            # guide need to see that before the operator does.
            "wall_temperature_K": (
                self.state.wetted_wall_temperature
                if self.state.wetted_wall_temperature is not None
                else self.state.ullage.wall_temperature
            ),
            "volume_L": self.tank.geometry.total_volume * 1e3,
            "chilling": 1.0 if self.chilling else 0.0,
            "fill_flow_g_s": self.fill_flow * 1e3,
            # The surface the ullage sees, when it is tracked apart from the
            # bulk; equal to the liquid temperature when it is not.
            "surface_temperature_K": (
                self.state.surface_temperature
                if self.state.surface_temperature is not None
                else self.state.liquid_temperature
            ),
        }

    def _chill(self, dt: float) -> bool:
        """Spend this step's pour on the wall, if the wall still wants it.

        Only for a cryogen load into a tank that holds no liquid yet: what is
        poured flashes on the metal and goes out of the vent, so nothing
        collects until the wall is down at saturation for the tank's pressure
        (plus the boiling onset, where a wall stops boiling what touches it).
        The wall falls at the rate that takes it from the room to the liquid
        in ``chill_seconds``; the heat it gives up is the propellant flashed,
        ``Q / h_fg``, booked in :attr:`chill_boiled`.

        Returns whether the step was spent chilling.
        """
        state = self.state
        if (
            self.chill_seconds <= 0.0
            or state.liquid_mass > 1e-3
            or state.liquid_temperature >= CRYOGENIC_K
        ):
            return False
        target = self._chill_target()
        walls = [state.ullage.wall_temperature]
        if state.wetted_wall_temperature is not None:
            walls.append(state.wetted_wall_temperature)
        # Half a kelvin of slack: at the target the ullage gas still hands the
        # wall a trace of heat each step, and a test against the bare target
        # called that "still chilling" forever and never let the load collect.
        if max(walls) <= target + CHILLED_BAND:
            return False
        rate = max(AMBIENT_T - state.liquid_temperature, 1.0) / self.chill_seconds
        cooled = [max(w - rate * dt, min(w, target)) for w in walls]
        capacity = self.tank.wall_mass * self.tank.wall_capacity
        heat = capacity * sum(w - c for w, c in zip(walls, cooled)) / len(walls)
        try:
            h_fg = latent_heat(self.tank.liquid, state.liquid_temperature)
        except (ValueError, PropertyError):
            h_fg = 0.0
        if h_fg > 0.0:
            self.chill_boiled += heat / h_fg
        self.state = replace(
            state,
            ullage=replace(state.ullage, wall_temperature=cooled[0]),
            wetted_wall_temperature=(
                cooled[1] if state.wetted_wall_temperature is not None else None
            ),
        )
        return True

    def _chill_target(self, pressure: float | None = None) -> float:
        """Where a load's chilldown takes the wall [K]: saturation at the tank's
        pressure (or ``pressure``), plus the boiling onset, where a wall stops
        boiling what touches it."""
        try:
            target = self.tank.liquid.get(
                "T", p=self.pressure if pressure is None else pressure, q=0.0
            )
        except (ValueError, PropertyError):
            target = self.state.liquid_temperature
        return float(target) + max(self.tank.boiling_onset, 0.0)

    def skip_chill(self) -> bool:
        """Put the wall where a chilldown leaves it, now.

        Where it leaves it once the boil-off has vented: the chill target at
        atmosphere (or at the tank's pressure, if lower). Not at the tank's
        present pressure -- a chilling tank sits above atmosphere on its own
        boil-off, that pressure falls as soon as the boiling stops, and a wall
        left at its saturation is above the new one a moment later and chilling
        again. What the metal gave up is the propellant the chill flashes off
        and vents, booked in :attr:`chill_boiled`; a load then collects from its
        next step. Returns whether there was anything to chill: not for a liquid
        that is no cryogen, nor a wall already there.
        """
        state = self.state
        if state.liquid_temperature >= CRYOGENIC_K:
            return False
        target = self._chill_target(min(self.pressure, AMBIENT))
        walls = [state.ullage.wall_temperature]
        if state.wetted_wall_temperature is not None:
            walls.append(state.wetted_wall_temperature)
        if max(walls) <= target + CHILLED_BAND:
            return False
        cooled = [min(w, target) for w in walls]
        capacity = self.tank.wall_mass * self.tank.wall_capacity
        heat = capacity * sum(w - c for w, c in zip(walls, cooled)) / len(walls)
        try:
            h_fg = latent_heat(self.tank.liquid, state.liquid_temperature)
        except (ValueError, PropertyError):
            h_fg = 0.0
        if h_fg > 0.0:
            self.chill_boiled += heat / h_fg
        self.state = replace(
            state,
            ullage=replace(state.ullage, wall_temperature=cooled[0]),
            wetted_wall_temperature=(
                cooled[1] if state.wetted_wall_temperature is not None else None
            ),
        )
        self.chilling = False
        return True

    @property
    def load_target_kg(self) -> float:
        """What a load fills this tank to [kg] (:meth:`_wanted`), for the pad
        guide: a fire load of 6.75 kg is 73 % of LE4's LOX tank, and a guide
        that wanted 90 % said the load had slipped after every T-0."""
        return self._wanted()

    def _wanted(self) -> float:
        """Liquid mass a load stops at [kg]: the fire load when there is one,
        never more than the full fraction of the tank."""
        capacity = self.tank.geometry.total_volume * self.full_fraction
        full = capacity * self.tank.liquid_density(self.state)
        return min(self.load_kg, full) if self.load_kg > 0.0 else full

    def _collect(self, added: float) -> None:
        """Put ``added`` kg of the load into the liquid."""
        # `replace`, not a fresh TankState: rebuilding field by field silently
        # drops anything added to the dataclass later, which is exactly how
        # `vapour_mass` came to reset to zero every step.
        self.state = replace(
            self.state,
            liquid_mass=self.state.liquid_mass + added,
            # A load stirs the liquid; the layer forms once it is still.
            surface_temperature=(
                None
                if self.state.surface_temperature is None
                else self.state.liquid_temperature
            ),
        )

    def fill_line_flow(self, drop: float) -> float:
        """What the dewar's fill line passes at a pressure drop [kg/s].

        Liquid through the line: ``drop = (f L / D + K_valves + 1) rho v^2 / 2``,
        the 1 being the exit into the tank, ``K_valves`` from the Cv of what on
        the line is not tube (``fluids.fittings.Cv_to_K``), and ``f`` Clamond at
        the Reynolds number the flow itself sets -- iterated, since the flow
        sets it. Nothing flows back into the dewar.
        """
        bore = self.fill_line_bore
        if drop <= 0.0 or bore <= 0.0:
            return 0.0
        state = self.state
        rho = self.tank.liquid_density(state)
        try:
            mu = self.tank.liquid.get("mu", T=state.liquid_temperature, q=0.0)
        except (ValueError, PropertyError):
            mu = 0.0
        area = math.pi * bore * bore / 4.0
        fixed = 1.0 + (Cv_to_K(self.fill_cv, bore) if self.fill_cv > 0.0 else 0.0)
        friction = 0.0
        flow = 0.0
        for _ in range(FILL_LINE_ITERATIONS):
            flow = area * math.sqrt(
                2.0 * rho * drop / (fixed + friction * self.fill_line_length / bore)
            )
            Re = reynolds(flow, bore, rho, mu)
            friction = darcy_friction_factor(
                Re, FILL_LINE_ROUGHNESS / bore, DEFAULT_FRICTION_METHOD
            )
        return flow

    def _dewar_load(self, dt: float) -> bool:
        """One step of a cryogen load pushed in by the dewar.

        What arrives is :meth:`fill_line_flow` at the dewar's pressure less the
        tank's. Into a tank holding no liquid yet, with the wall above
        saturation for the tank's pressure (plus the boiling onset, as in
        :meth:`_chill`), it boils on the wall: the wall gives up ``h_fg`` for
        every gram, and the vapour goes into the **ullage**, where only the
        vent can take it out. That is the climb the stand shows while a tank
        chills, and why it is larger the faster the dewar pours. What arrives
        once the wall is cold -- or what the wall had no heat left to boil --
        collects, up to the full fraction.

        Returns whether the step was spent chilling.
        """
        state = self.state
        room = self._wanted() - state.liquid_mass
        if room <= 0.0 or dt <= 0.0:
            return False
        arriving = self.fill_line_flow(self.dewar_pressure - self.pressure) * dt
        boiled = 0.0
        if state.liquid_mass <= 1e-3:
            try:
                target = self.tank.liquid.get("T", p=self.pressure, q=0.0)
                h_fg = latent_heat(self.tank.liquid, state.liquid_temperature)
            except (ValueError, PropertyError):
                target, h_fg = state.liquid_temperature, 0.0
            target += max(self.tank.boiling_onset, 0.0)
            walls = [state.ullage.wall_temperature]
            if state.wetted_wall_temperature is not None:
                walls.append(state.wetted_wall_temperature)
            capacity = self.tank.wall_mass * self.tank.wall_capacity
            if max(walls) > target + CHILLED_BAND and h_fg > 0.0 and capacity > 0.0:
                # Each wall gives up the same heat per kelvin, so each falls by
                # the same amount -- the one that boils what arrived -- unless
                # it reaches the target first.
                fall = arriving * h_fg / capacity
                if all(w - fall >= target for w in walls):
                    # All of it boils. Said exactly rather than as heat / h_fg,
                    # whose round-off is a femtogram of "liquid" left on a warm
                    # wall -- which heats past the critical point in one step.
                    cooled = [w - fall for w in walls]
                    boiled = arriving
                else:
                    cooled = [max(w - fall, min(w, target)) for w in walls]
                    heat = capacity * sum(w - c for w, c in zip(walls, cooled))
                    boiled = min(heat / len(walls) / h_fg, arriving)
                self.chill_boiled += boiled
                self.state = replace(
                    state,
                    ullage=replace(state.ullage, wall_temperature=cooled[0]),
                    wetted_wall_temperature=(
                        cooled[1] if state.wetted_wall_temperature is not None else None
                    ),
                    vapour_mass=state.vapour_mass + boiled,
                )
        collected = min(arriving - boiled, room)
        if collected > 0.0:
            self._collect(collected)
        self.fill_flow = (boiled + max(collected, 0.0)) / dt
        return boiled > 0.0

    def advance(
        self,
        dt: float,
        *,
        mdot_liquid_out: float,
        mdot_gas_in: float,
        mdot_gas_out: float,
        enthalpy_gas_in: float,
        supply_pressure: float = 0.0,
        stirring: float = 1.0,
        vent_fraction: float = 1.0,
        mdot_liquid_in: float = 0.0,
        liquid_in_temperature: float | None = None,
    ) -> float:
        """One vessel step, with the flows the network just produced.

        ``mdot_liquid_in`` is propellant the network delivers to this tank's
        outlet from another tank -- a cart's transfer tank loading it -- arriving
        at ``liquid_in_temperature`` and mixed into the liquid. It squeezes the
        ullage as it comes in, which ``Tank.rates`` prices as the p dV work the
        drain does in reverse.

        Returns the gas inflow it **refused** [kg/s]. The caller owes that back
        to whatever was debited for it: the network solved a flow leaving the
        bottle, and if the tank does not take it, it did not happen.

        In and out are separate, not netted. They are simultaneous during a
        fill -- pressurant on one port, vent on another -- and they carry
        different energy: gas arriving brings the supply's enthalpy, gas leaving
        takes the ullage's own. Netting them would price the whole exchange at
        the supply's enthalpy and make a venting tank warm up.
        """
        self.fill_flow = 0.0
        if (
            self.filling
            and self.dewar_pressure > 0.0
            and self.state.liquid_temperature < CRYOGENIC_K
        ):
            self.chilling = self._dewar_load(dt)
        else:
            self.chilling = self.filling and self._chill(dt)
            if self.filling and not self.chilling:
                wanted = self._wanted()
                if self.state.liquid_mass < wanted:
                    span = max(self.fill_seconds, 1e-3)
                    added = min(wanted * dt / span, wanted - self.state.liquid_mass)
                    self._collect(added)
                    self.fill_flow = added / dt if dt > 0.0 else 0.0
        self.added_kg += self.fill_flow * dt

        # Gas cannot flow into a vessel that has reached the pressure feeding
        # it. The network solve says how much is flowing *at the pressure the
        # tick started from*, so a tank filling fast sails past that point
        # between solves and keeps taking gas it could not have taken -- which
        # is why a 500 psi regulator used to leave a tank at 550 once it had
        # cooled back down. Stopping the inflow at the crossover is exact, and
        # it is the vessel's to enforce because only the vessel knows where its
        # pressure got to mid-step.
        refused = 0.0
        if supply_pressure > 0.0 and mdot_gas_in > 0.0:
            # Only once the tank is *past* its supply by a clear margin. The
            # reference here is the node next door, which in a converged solve
            # sits above the tank by exactly the line loss between them -- a
            # psi or two on a helium press line. Closing the moment the tank
            # touches it therefore closes on every sub-step that puts any gas
            # in, and the relay that produces -- fill, cross, refuse, drain
            # back, fill -- sits at exactly half duty, so the tank receives half
            # of every flow the network solved. A clean 50.0% loss that reads
            # as physics because it is perfectly steady. The margin makes the
            # clamp what it was meant to be: a backstop for the tick lag, not a
            # second regulator arguing with the first.
            # gas goes in, the tank crosses the supply, the next sub-step
            # refuses, the liquid leaving drops it back under, and the step
            # after that accepts again. That limit cycle sits at exactly half
            # duty, so the tank receives half of every flow the network solved
            # for it -- a clean 50.0% loss that looks like physics because it is
            # perfectly steady. The band is the same half percent the regulator
            # uses in `is_choked`, and for the same reason.
            band = self.supply_band * supply_pressure
            over = self.pressure - (supply_pressure + band)
            if over > 0.0:
                refused = mdot_gas_in
                mdot_gas_in = 0.0
            else:
                # Below the supply, but perhaps not by a whole step's worth.
                # The inflow is applied for `dt` at the rate the network
                # solved with the tank where it *was*; on a 0.43 L fuel
                # ullage holding twenty grams, one step near lockup put the
                # tank 35 psi past the regulator, which then shut and left it
                # there until the gas cooled. Clip the step to the mass that
                # lands the tank on the supply -- linearised, with the charge
                # heating's gamma so a hot arrival does not carry it over --
                # and refuse the rest back to the bottle it came from.
                held = self.state.ullage.mass + self.state.vapour_mass
                room = (
                    (supply_pressure + band - self.pressure)
                    / max(self.pressure, 1.0)
                    / self.charge_gamma
                    * held
                )
                allowed = room / dt if dt > 0.0 else mdot_gas_in
                if mdot_gas_in > allowed > 0.0:
                    refused = mdot_gas_in - allowed
                    mdot_gas_in = allowed

        # The charge jet stirs the ullage only while there is a charge: gas
        # arriving with the tank well below its supply. At lockup two tanks
        # on one manifold trade a few grams a second back and forth, and
        # calling every one of those arrivals a jet ran the wall exchange at
        # twenty times natural on a 293 K wall -- the ullages warmed, the
        # tanks ratcheted 16 psi above lockup in ten seconds, and the study
        # could no longer settle at T-0.
        pressing = (
            mdot_gas_in > 0.0
            and supply_pressure > 0.0
            and supply_pressure - self.pressure > self.stir_band * supply_pressure
        )
        stirring = stirring if pressing else 1.0

        # A tank cannot deliver more liquid than it holds. Without this the
        # solver happily draws propellant out of an empty vessel and the mains
        # keep flowing after the tank is dry. The session cuts its coupling
        # step at the instant a tank runs out (`Session._dry_cut`), so the
        # network never asks for more than is there; this is the backstop, and
        # what it refuses is booked, because the network has already sent it
        # downstream. Zeroing the outflow below a gram -- what this did --
        # refused the rest of the step without a word: 17-25 g of propellant
        # the engine burned and no vessel gave.
        self.empty = self.state.liquid_mass <= DRY_MASS
        mdot_liquid_in = max(mdot_liquid_in, 0.0)
        holds = max(self.state.liquid_mass, 0.0) / dt if dt > 0.0 else 0.0
        holds += mdot_liquid_in
        if mdot_liquid_out > holds:
            self.fixed_kg += (mdot_liquid_out - holds) * dt
            mdot_liquid_out = holds
        if mdot_liquid_in > 0.0 and dt > 0.0:
            if liquid_in_temperature is not None:
                arriving = mdot_liquid_in * dt
                held_liquid = max(self.state.liquid_mass, 0.0)
                mixed = (
                    held_liquid * self.state.liquid_temperature
                    + arriving * liquid_in_temperature
                ) / (held_liquid + arriving)
                self.state = replace(self.state, liquid_temperature=mixed)
            # Net through the outlet: negative is a tank being loaded.
            mdot_liquid_out -= mdot_liquid_in

        # What leaves through a vent is the ullage as it is: pressurant and
        # propellant vapour in proportion. The network solved one gas flow out
        # of the node; the split is the vessel's to make, because only the
        # vessel knows what it holds. Debiting the pressurant alone -- what
        # this did -- left every gram a LOX tank boiled sitting in the ullage,
        # and a tank venting 400 g/s through a wide-open 3/8 in vent climbed
        # to 500 psig during its own fill.
        # ...and only the part that actually reaches a vent. Two tanks at
        # lockup trade a few grams a second through the press manifold; the
        # network does not know species, so vapour that left with that slosh
        # came back as pressurant and the pair ratcheted upward. What goes to
        # the manifold and back is booked as pressurant both ways; what goes
        # out a vent takes its vapour share with it (`Session._vent_fraction`).
        held = self.state.ullage.mass + self.state.vapour_mass
        vapour_share = self.state.vapour_mass / held if held > 0.0 else 0.0
        vented = max(mdot_gas_out, 0.0) * min(max(vent_fraction, 0.0), 1.0)
        vapour_out = vented * vapour_share
        pressurant_out = mdot_gas_out - vapour_out
        # The pressurant does not go below its floor (`_settled`): it carries
        # the ullage's heat capacity. Once it is there, what the vent takes is
        # vapour -- a LOX tank chilling under its own boil-off vents oxygen,
        # not the air it started with. Split by mass share regardless, the vent
        # took air the floor then put back: ~3 g/s and 800 W through a whole
        # chilldown, booked as a guard. Only the vented part shifts; gas traded
        # with the press manifold stays pressurant (see above).
        if vented > vapour_out and dt > 0.0 and self.state.vapour_mass > 0.0:
            spare = max(
                self.state.ullage.mass - self._pressurant_floor(), 0.0
            ) / dt + max(mdot_gas_in, 0.0)
            over = min(pressurant_out, vented - vapour_out) - spare
            if over > 0.0:
                shift = min(over, self.state.vapour_mass / dt - vapour_out)
                if shift > 0.0:
                    vapour_out += shift
                    pressurant_out -= shift
        # One call, with the energy the two streams actually carry folded into
        # an effective inlet enthalpy -- the rates() signature takes a single
        # gas stream, and this keeps the physics right without forking it.
        # The vapour carries no energy term (see Tank.rates), so only the
        # pressurant's share leaves with the ullage's enthalpy.
        net_gas = mdot_gas_in - pressurant_out
        if abs(net_gas) > 1e-12:
            leaving = pressurant_out * self.tank.gas_enthalpy(self.state)
            enthalpy = (mdot_gas_in * enthalpy_gas_in - leaving) / net_gas
        else:
            enthalpy = enthalpy_gas_in
        # Sub-step on the ullage's own time constant rather than the caller's
        # clock. A 6 mm vent empties a 17 litre ullage in a fraction of a
        # second, so a step sized for the *display* rate marches straight past
        # atmosphere into a numerical vacuum -- at which point the property
        # layer is asked to price nitrogen at 0.09 kg/m^3 and refuses, which is
        # correct and useless. Bounding the fractional mass change per step
        # costs a handful of extra evaluations only while something is actually
        # moving fast.
        steps = 1
        if held > 0.0 and (abs(net_gas) > 0.0 or vapour_out > 0.0):
            by_mass = (abs(net_gas) + vapour_out) * dt / held / MAX_MASS_FRACTION
            # dT ~ (dU/dt) / (m . cv), estimated from the enthalpy crossing the
            # boundary. Only a scale -- the retry below is what guarantees it.
            gas_T = self.tank.gas_temperature(self.state)
            cv = max(self.tank.gas.get("cv", p=AMBIENT, T=gas_T), 1.0)
            d_temperature = abs(net_gas * enthalpy) * dt / (self.state.ullage.mass * cv)
            by_temperature = d_temperature / (gas_T * MAX_TEMPERATURE_FRACTION)
            steps = min(int(max(by_mass, by_temperature)) + 1, MAX_VESSEL_STEPS)
        inner = dt / steps

        for _ in range(steps):
            self._one_step(
                inner, mdot_liquid_out, net_gas, enthalpy, stirring, vapour_out
            )
        return refused

    def _one_step(
        self,
        dt: float,
        mdot_liquid_out: float,
        net_gas: float,
        enthalpy: float,
        stirring: float = 1.0,
        vapour_out: float = 0.0,
    ) -> None:
        """One vessel step that lands somewhere the gas can actually be.

        Halves itself and retries when it does not. An explicit step onto a
        small ullage during a vent can overshoot into a state the equation of
        state refuses -- correctly, since it is a solid -- and the alternative
        to retrying is the run dying at the moment it is meant to demonstrate.

        Halving shortens the piece, never the step: once a piece lands, the
        next one starts from it, until all of ``dt`` is integrated. Returning
        on the first piece that landed -- what this did -- dropped the rest of
        the step's liquid outflow, gas exchange and heat every time a vent
        forced a retry. The pieces are counted in whole ``dt / 2**halvings``
        so they sum to ``dt`` exactly; with no retry it is one piece of ``dt``,
        as before.
        """
        halvings = 0
        done = 0  # pieces of dt / 2**halvings already integrated
        while done < 1 << halvings:
            remaining = dt / (1 << halvings)
            rates = self.tank.rates(
                self.state,
                mdot_liquid_out=mdot_liquid_out,
                mdot_gas_in=net_gas,
                enthalpy_gas_in=enthalpy,
                # The press jet stirs the ullage; a venting or quiet tank is
                # back to still-gas exchange.
                stirring=stirring if net_gas > 0.0 else 1.0,
                mdot_vapour_out=vapour_out,
            )
            stepped = self.tank.step(self.state, rates, remaining)
            candidate = replace(
                stepped,
                ullage=self._settled(stepped.ullage),
                liquid_mass=max(stepped.liquid_mass, 0.0),
            )
            try:
                self.tank.pressure(candidate)
            except Exception:  # noqa: BLE001 - any refusal means "too far"
                if halvings == STEP_RETRIES:
                    break
                halvings += 1
                done *= 2
                continue
            self._ledger(rates, remaining, candidate)
            self.state = candidate
            done += 1
        else:
            return
        # Still unreachable after halving: the ullage has run out of gas to
        # give. Settle it at atmosphere against the wall, which is where a
        # fully vented tank ends up anyway.
        volume = max(self.tank.ullage_volume(self.state), 1e-9)
        wall = self.state.ullage.wall_temperature
        mass = self.tank.gas.get("rho", p=AMBIENT, T=wall) * volume
        start = self.state
        left = dt - done * dt / (1 << halvings)
        # `replace`, not a fresh TankState: rebuilding field by field drops
        # anything added to the dataclass later -- it is how vapour_mass once
        # reset every step, and it would have dropped the wetted wall here.
        self.state = replace(
            self.state,
            ullage=VesselState(
                mass=mass,
                energy=self.tank.gas.get("u", p=AMBIENT, T=wall) * mass,
                wall_temperature=wall,
            ),
            # The ullage was rebuilt from atmosphere, so any vapour that was in
            # it has gone out of the vent with the rest.
            vapour_mass=0.0,
        )
        self._ledger(rates, left, self.state, start)

    def _ledger(
        self,
        rates: TankRates,
        dt: float,
        landed: TankState,
        start: TankState | None = None,
    ) -> None:
        """Book what the guards changed: where a piece of step ``landed``
        against where the rates over its ``dt`` said it would."""
        was = start or self.state

        def total(state: TankState) -> float:
            return state.liquid_mass + state.ullage.mass + state.vapour_mass

        promised = (rates.ullage.mass + rates.liquid_mass + rates.vapour_mass) * dt
        self.fixed_kg += total(landed) - total(was) - promised
        self.fixed_J += (
            landed.ullage.energy - was.ullage.energy - rates.ullage.energy * dt
        )

    def _pressurant_floor(self, wall_temperature: float | None = None) -> float:
        """The least pressurant the ullage holds [kg]: atmosphere's worth at the
        wall, in the ullage's present volume (see :meth:`_settled`)."""
        volume = max(self.tank.ullage_volume(self.state), 1e-9)
        wall = (
            self.state.ullage.wall_temperature
            if wall_temperature is None
            else wall_temperature
        )
        return float(self.tank.gas.get("rho", p=AMBIENT, T=wall)) * volume

    def _settled(self, ullage: VesselState) -> VesselState:
        """Keep the ullage inside the states the gas can actually occupy.

        Two floors, and both are physics rather than numerics.

        A vent cannot pull a tank below the air outside it, so the **mass**
        cannot fall below what atmosphere would hold in that volume.

        The floor is on the pressurant alone because the pressurant carries the
        ullage's heat capacity: the propellant vapour has no energy term (see
        ``Tank.rates``), so an ullage vented down to vapour alone would have no
        thermal mass to integrate. What keeps the floor from *creating* gas is
        the vent's split (:meth:`advance`): once the pressurant is at its floor
        the vent takes vapour, which is what a tank chilling down under its own
        boil-off is venting.

        Only the mass, deliberately. Chilling is bounded by sizing the step
        against the energy leaving (see MAX_ENERGY_FRACTION) rather than by
        clamping the temperature afterwards: a clamp applied every sub-step is
        a ratchet that puts energy *in*, and a venting tank then climbs in
        pressure instead of falling.
        """
        floor = self._pressurant_floor(ullage.wall_temperature)
        if self.state.vapour_mass > 0.0:
            try:
                above = self.tank.pressure(self.state) > AMBIENT
            except (ValueError, PropertyError):
                above = False
            if above:
                # Vapour holds the tank above atmosphere: the floor only keeps
                # the pressurant from leaving (the vent takes vapour instead),
                # never grows it. Grown with a cooling wall -- an atmosphere of
                # air is heavier at 150 K than at 290 K -- it still added
                # ~0.03 g/s of air to a tank at 20 psig of its own boil-off.
                floor = min(floor, self.state.ullage.mass)
        mass = max(ullage.mass, floor)
        if mass == ullage.mass:
            return ullage
        # Mass was floored, so the energy that went with it has to be restated
        # or the specific energy jumps. Priced at the wall, which is what the
        # gas re-warms against once the vent is shut.
        specific = self.tank.gas.get("u", p=AMBIENT, T=ullage.wall_temperature)
        return VesselState(
            mass=mass,
            energy=specific * mass,
            wall_temperature=ullage.wall_temperature,
        )


@dataclass
class BottleSim:
    """A pressurant bottle: filled from GSE, then blowing down.

    Starts **empty**, like everything else on the stand. A COPV that is already
    at 4500 psi when the app opens is the same lie as a tank that is already
    full: it skips the step where somebody has to decide to do it.
    """

    id: str
    label: str
    volume: GasVolume
    state: VesselState
    node: str
    filling: bool = False
    venting: bool = False
    target: float = from_psig(4500.0)
    fill_seconds: float = 9.7
    #: Temperature of the cart's gas [K]; the session copies it in each tick.
    fill_supply_T: float = FILL_SUPPLY_T
    charged: bool = False
    """Whether this bottle has ever been filled. A note saying a bottle is
    "down to" fifteen psi is wrong before anybody has put gas in it -- it is
    not down to anything, it is where it started."""
    #: Ledger for the solver tab, cumulative [kg]: what the built-in charge
    #: put in, what the built-in dump took out beyond the network's draw, and
    #: what the floor at atmosphere added back.
    added_kg: float = 0.0
    dumped_kg: float = 0.0
    fixed_kg: float = 0.0
    #: Maximum allowable working pressure [Pa], 0 if the drawing gives none.
    mawp: float = 0.0

    @property
    def pressure(self) -> float:
        return float(self.volume.pressure(self.state))

    @property
    def fraction(self) -> float:
        """How full, against the target it is being filled to."""
        return min(max(self.pressure / self.target, 0.0), 1.0) if self.target else 0.0

    def advance(
        self,
        dt: float,
        *,
        mdot_out: float,
        stirring: float = 1.0,
        mdot_in: float = 0.0,
        enthalpy_in: float = 0.0,
    ) -> None:
        """``mdot_in`` is gas the drawing itself delivers (a cart drawn on the
        GSE page, charging through its own valves); zero for a bottle whose
        GSE is not drawn, which is charged by ``filling`` instead."""
        if self.pressure > 2.0 * AMBIENT:
            self.charged = True
        # The GSE cart doing the filling is not on the drawing yet, so the fill
        # is commanded by the state at a rate the operator sets rather than
        # solved. Everything after the bottle -- the regulator, the tanks, the
        # engine -- is solved.
        if self.filling and self.pressure < self.target:
            full = self.volume.initial_state(
                pressure=self.target, temperature=self.state.wall_temperature
            )
            span = max(self.fill_seconds, 1e-3)
            added = min(full.mass * dt / span, full.mass - self.state.mass)
            if added > 0.0:
                self.added_kg += added
                # Gas arrives from a bank at ambient temperature and at least
                # the target pressure: its enthalpy is the bank's, whatever
                # the bottle's wall has warmed to. The bottle still heats --
                # an adiabatic charge from empty lands near gamma times the
                # supply temperature -- but it no longer feeds on its own
                # warmth through the supply term.
                enthalpy = self.volume.fluid.get(
                    "h", p=self.target, T=self.fill_supply_T
                )
                rates = self.volume.rates(
                    self.state,
                    mdot_in=added / dt,
                    enthalpy_in=enthalpy,
                    stirring=stirring,
                )
                self.state = self.volume.step(self.state, rates, dt)
                return

        drawn = max(mdot_out, 0.0)
        if self.venting:
            mdot_out = max(mdot_out, self.state.mass / max(self.fill_seconds, 1e-3))

        if self.state.mass <= 1e-6 and mdot_in <= 0.0:
            return
        self.dumped_kg += (max(mdot_out, 0.0) - drawn) * dt
        if mdot_in > 0.0:
            rates = self.volume.rates(
                self.state,
                mdot_out=max(mdot_out, 0.0),
                mdot_in=mdot_in,
                enthalpy_in=enthalpy_in,
                stirring=stirring,
            )
        else:
            rates = self.volume.rates(self.state, mdot_out=max(mdot_out, 0.0))
        stepped = self.volume.step(self.state, rates, dt)
        floor = self.volume.fluid.get("rho", p=AMBIENT, T=stepped.wall_temperature)
        self.fixed_kg += max(floor * self.volume.volume - stepped.mass, 0.0)
        self.state = VesselState(
            mass=max(stepped.mass, floor * self.volume.volume),
            energy=stepped.energy,
            wall_temperature=stepped.wall_temperature,
        )


@dataclass(frozen=True, slots=True)
class Trip:
    """A vessel over the pressure its drawing rates it for: why the stand stopped.

    :attr:`Session.tripped` says it in words for the panel; this says it in
    numbers for a caller that has to act on it -- a burn that must stop at the
    trip rather than integrate the frozen frame to its horizon.
    """

    vessel: str
    """Drawing id of the vessel."""
    label: str
    kind: str
    """``tank`` or ``bottle``."""
    t: float
    """Session clock at the step that found it [s]."""
    pressure: float
    """Vessel pressure then, absolute [Pa]."""
    limit: float
    """The absolute pressure it trips at [Pa]: the drawing's MAWP, or its burst
    pressure over :attr:`Setup.burst_safety_factor`, plus the gauge zero."""


@dataclass
class Sample:
    """One instant of the session, as the app draws it."""

    t: float
    state: str
    pressures: Mapping[str, float]
    temperatures: Mapping[str, float]
    """Node temperature [K] at this instant.

    Recorded per sample rather than read off the live network when a plot asks,
    because a history has to carry what the stand *was*, not what it is now --
    the same reason pressures are here."""
    flows: Mapping[str, float]
    signals: Mapping[str, float]
    converged: bool
    tanks: Mapping[str, dict[str, float]]
    chamber: ChamberResult | None = None
    balance: MixtureBalance | None = None
    notes: tuple[str, ...] = ()


class Session:
    """A stand, live. Built once, ticked forever.

    The state machine commands valves, the valves decide what is connected, the
    network decides the flows and the vessels decide what that does to their
    contents. Nothing here scripts a pressure curve; every number on screen is
    the consequence of the previous tick.
    """

    def __init__(
        self,
        model: Model,
        machine: StateMachine,
        binding: Binding,
        *,
        state: str = "Idle",
        setup: Setup | None = None,
        hookup: Hookup | None = None,
    ) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.model = model
        self.machine = machine
        self.binding = binding
        #: Which knob sets which regulator (feedtwin.session.hookup). None: the
        #: one dome knob drives what it always drove, exactly as before.
        self.hookup = hookup
        #: Each knob's setting [psig], by knob id; the ``dome`` knob is
        #: ``setup.dome_psi`` and is not kept here.
        self.knobs: dict[str, float] = (
            {k.id: k.psig for k in hookup.knobs} if hookup is not None else {}
        )
        self.state = state if state in machine.states else machine.states[0]
        #: Built on the vehicle alone, the GSE cut away (Setup.ignore_gse,
        #: assemble_model(vehicle_only=...)). The setup says what the stand is.
        self.gse_ignored = bool(model.meta.get("vehicle_only"))
        self.setup = setup or Setup()
        if self.setup.ignore_gse != self.gse_ignored:
            self.setup = replace(self.setup, ignore_gse=self.gse_ignored)
        self.forced: dict[str, float] = {}
        #: Where each actuator actually is, as opposed to where it is told to be.
        self._positions: dict[str, float] = {}
        #: The pressure shut in each gated dome (DomeLine), by the loaded
        #: regulator's id [Pa abs]; atmosphere until something loads it.
        self._dome_held: dict[str, float] = {}
        #: Network node -> pressure for the dome lines, written over the solve's
        #: own (it never sees a dome line: loading gas, not feed).
        self._dome_readings: dict[str, float] = {}
        #: Prime asks for the dome as loaded on the pad, not as it was.
        self._dome_primed = False
        self._travel: dict[str, float] = {}
        #: The frame on display: the last one integrated, and the one a tripped
        #: stand holds.
        self._shown: Sample | None = None
        #: Why the stand stopped, if it has: a vessel over its MAWP. Cleared
        #: only by opening a new stand -- there is no un-bursting a tank.
        self.tripped: str | None = None
        #: The same trip in numbers; set with :attr:`tripped`, never cleared.
        self.trip: Trip | None = None
        #: Set when Fire ended by a tank running dry (see _burnout_check).
        self.burnout: str | None = None
        #: Stand time the current state was entered at (command_state).
        self._state_since = 0.0
        self.t = 0.0
        self.wall = time.monotonic()
        self.history: Deque[Sample] = deque(maxlen=HISTORY)
        #: The solver tab: one record per tick (feedtwin.session.diagnostics).
        self.solver_log: Deque[SolverRecord] = deque(maxlen=HISTORY)
        self._tick: dict[str, float] = {}
        self._boundary: frozenset[str] | None = None
        self._crossed_in = 0.0
        self._crossed_out = 0.0
        self._inventory0: float | None = None
        self._ledger0 = (0.0, 0.0, 0.0)
        self._guard_J0 = 0.0
        self.assumptions: list[str] = []
        self._last_flows: dict[str, float] = {}
        #: Node pressures of the last converged solve: what a failed one holds
        #: (:meth:`_held`).
        self._last_pressures: dict[str, float] = {}
        # Warm start. Consecutive ticks are 50 ms apart and the network barely
        # moves between them, so starting each solve from the previous answer is
        # both faster and far more robust: cold-starting a network whose bottle
        # is at 4500 psi and whose tanks are at 14.7 sends Newton into a basin
        # where a node comes back at minus two thousand bar.
        self._guess: dict[str, float] = {}
        #: Fractional vessel-pressure change over the last tick, and the dt it
        #: took. Together they set how finely the next tick has to interleave
        #: solving and integrating -- see MAX_COUPLED_CHANGE.
        self._last_change = 0.0
        self._last_dt = 1.0
        #: Which branches were shut last solve. When this changes the network is
        #: a different circuit, and a warm start taken from the old one is not a
        #: starting point -- it is a guess about a system that no longer exists.
        self._last_isolated: frozenset[str] = frozenset()
        #: The ground support resting this step while the engine burns
        #: (Setup.ground_rests, _rest_ground):
        #: its branches, out of the solve, and its vessels' ids, not integrated.
        self._resting: tuple[frozenset[str], frozenset[str]] = (
            frozenset(),
            frozenset(),
        )
        self._fire_loads: dict[str, float] | None = None
        self._resting_memo: tuple[
            frozenset[str] | None, tuple[frozenset[str], frozenset[str]]
        ] = (None, self._resting)
        #: Each ullage's stiffest reachable regulator slope, per shut set and
        #: boundaries (_regulator_slopes).
        self._regulator_memo: tuple[object, dict[str, float]] = (None, {})
        self._chamber_guess = AMBIENT
        self._last_chamber: ChamberResult | None = None
        # A cold chamber is open to atmosphere through its own nozzle, so pin
        # the boundary there before the first solve rather than leaving the
        # drawing's design chamber pressure sitting on it.
        #
        # The ENGINE symbol's `pressure` is the boundary to use when there is no
        # engine *model* on the end -- the honest "nobody has said what is on the
        # end of the pipe" case. With a model attached, `_chamber()` overwrites
        # it on the first tick anyway; leaving it until then meant the frame the
        # UI paints on open showed the whole downstream leg at design chamber
        # pressure on a stand holding nothing.
        #: The chamber boundary node, and what the drawing says it runs at.
        #:
        #: Found from the drawing rather than from `engine_ports`, which is only
        #: populated once an engine *model* is attached -- and the cold-stand
        #: problem is worse without one, because then nothing ever overwrites the
        #: drawing's design pressure.
        # Built before the chamber, because a wall takes its starting
        # temperature from the node its line hangs off and those are seeded from
        # the drawing at build time.
        self._build_line_walls()
        self._chamber_node = ""
        self._design_chamber = AMBIENT
        net_nodes = self.model.built.network.nodes
        # With an engine attached the chamber is a node the engine built
        # (`ENG.chamber`); without one it is the ENGINE symbol's own node. The
        # drawing symbol's id is *not* a network node in the first case, which is
        # why this asks `engine_ports` first rather than only walking the drawing.
        candidates = [self.model.built.engine_ports.get("chamber", "")]
        candidates += [
            self.model.built.node_of.get(symbol.id, symbol.id)
            for symbol in self.model.diagram.nodes
            if symbol.type in ("ENGINE", "INJECTOR")
        ]
        for anchor in candidates:
            if anchor and anchor in net_nodes:
                self._chamber_node = anchor
                self._design_chamber = net_nodes[anchor].pressure or AMBIENT
                net_nodes[anchor].pressure = AMBIENT
                break
        # Pressure held in a section that is shut off at both ends. The solver
        # reports such a node as its live neighbour's pressure and says so via
        # indeterminate_dead_ends -- correct as an upper bound, wrong as a
        # reading. A transducer on a trapped line reads what was trapped in it,
        # which on a stand that has not been pressurised yet is atmosphere.
        self._trapped: dict[str, float] = {}

        self.tanks: dict[str, TankSim] = {}
        self.bottles: dict[str, BottleSim] = {}
        self._build_vessels()
        self._fill_stubs = self._find_fill_stubs()
        #: Vessels whose fill the drawing itself carries: a GSE page with the
        #: cart's bottle or dewar plumbed to them. Their built-in fill (the
        #: tanker load, the cart's COPV charge) steps aside and the network
        #: fills them, or they would be filled twice. Empty on a drawing with
        #: no GSE drawn, and then nothing changes.
        self._drawn_fill: frozenset[str] = self._find_drawn_fills()
        #: Network nodes on the dome line of each dome-loaded regulator whose
        #: loader went with the GSE, by regulator id: they read the dome. Empty
        #: unless the GSE is ignored.
        self._dome_ports: dict[str, frozenset[str]] = (
            self._find_cut_dome_ports() if self.gse_ignored else {}
        )
        if self.gse_ignored:
            raw_cut = model.meta.get("ground_cut")
            cut = [str(c) for c in raw_cut] if isinstance(raw_cut, list) else []
            self.assumptions.append(
                "The drawn GSE is ignored (Configuration: Ignore the drawn GSE): "
                + (
                    f"{', '.join(cut)} and the rest of the cart are not simulated"
                    if cut
                    else "this drawing has no GSE off the vehicle to cut"
                )
                + ". The bottle charge, the loads and the dome are the GSE "
                "Controls settings, as on a drawing of the rocket alone."
            )
        # Vehicle tanks a cart tank loads through the drawing: the only tanks
        # that take liquid in at their outlet.
        # Both ends of a transfer line: liquid that sloshes back into the cart's
        # tank is propellant too, and dropping it lost mass every step.
        self._liquid_fed: frozenset[str] = frozenset(
            t for fed in self.model.built.supplies.values() for t in fed
        ) | frozenset(self.model.built.supplies)
        # The valve the crew shuts when a drawn load is in: the first one on the
        # transfer line from the cart's tank. Shut once, when the tank reaches
        # its load, as the built-in load stops at its full fraction.
        # ...and the branches of that line, which stay open to a dry tank:
        # it is filled through them (`_dry_branches`).
        self._fill_lines: dict[str, frozenset[str]] = {}
        self._fill_stops: dict[str, str] = self._find_fill_stops()
        self._fill_stopped: set[str] = set()
        #: What the crew last did with each transfer valve (open or shut), so a
        #: hand on the P&ID between changes is left alone.
        self._fill_crew: dict[str, bool] = {}
        # Shut from the start, not from the first tick: a valve that slews shut
        # over its travel lets a primed flight tank drain back into the cart.
        for valve in self._fill_stops.values():
            self._fill_crew[valve] = False
            self.forced[valve] = 0.0
            self._positions[valve] = 0.0
        #: Pressure relief valves (comps.relief) and where each one is: open or
        #: shut (its hysteresis), and its lift as the signal the solve reads.
        #: Empty on a drawing with no relief, and then nothing below runs.
        self._reliefs: list[tuple[str, Any]] = [
            (branch_id, branch)
            for branch_id, branch in self.model.built.network.branches.items()
            if getattr(branch.component, "type", "") == "relief_valve"
        ]
        self._relief_open: dict[str, bool] = {}
        self._relief_lift: dict[str, float] = {}

    # ------------------------------------------------------------ building

    @property
    def ground(self) -> frozenset[str]:
        """Drawing ids of the ground support: everything off the vehicle
        (:func:`feedtwin.pid.roles.vehicle_ids`). Empty for a drawing that is
        one piece."""
        vehicle = self.model.built.vehicle
        if vehicle is None:
            return frozenset()
        return frozenset(n.id for n in self.model.diagram.nodes if n.id not in vehicle)

    def fire_loads(self) -> dict[str, float]:
        """Propellant a fire is loaded with, per vehicle tank [kg].

        The engine's ``fire_load`` (its config's ``lox_tank.mass`` and
        ``fuel_tank.mass``) on the tank of that side. What the vehicle carries
        is fixed by the competition, not by the size of the tank drawn, so the
        pad loads this and T-0 starts with it. Empty without an engine that
        states one: then loads fill the tank to its full fraction.
        """
        if self._fire_loads is None:
            load = getattr(self.model.engine, "fire_load", None) or {}
            self._fire_loads = {
                tank_id: float(load[side])
                for tank_id in self.vehicle_tanks
                if (side := propellant_side(self.tanks[tank_id].tank.liquid.name))
                in load
            }
        return self._fire_loads

    def short_loads(self) -> list[str]:
        """Each vehicle tank too small for the engine's fire load, said.

        A load stops at the tank's full fraction (``TankSim._wanted``), so a
        drawn tank that cannot hold its fire load is loaded short, silently,
        and every burn on the stand is that much shorter than the engine was
        designed for. Empty when every tank holds its load.
        """
        out: list[str] = []
        for tank_id, kg in self.fire_loads().items():
            sim = self.tanks[tank_id]
            fraction = self.setup.full_fraction
            held = (
                sim.tank.geometry.total_volume
                * fraction
                * sim.tank.liquid_density(sim.state)
            )
            if held < kg - 0.005:
                out.append(
                    f"{sim.label} holds {held:.2f} kg at its {fraction:.0%} fill, "
                    f"under the engine's {kg:.2f} kg fire load: a fire is loaded "
                    f"with {held:.2f} kg. A bigger tank on the drawing, or a "
                    "higher full fraction (Configuration), loads the rest."
                )
        return out

    @property
    def vehicle_tanks(self) -> tuple[str, ...]:
        """The tanks the engine burns from: every tank, less the ground's."""
        ground = self.ground
        return tuple(t for t in self.tanks if t not in ground)

    def _find_drawn_fills(self) -> frozenset[str]:
        """Tanks a drawn dewar reaches, and bottles another drawn bottle or
        dewar reaches, through the drawing's lines and valves (open or shut --
        a valve is how the fill is commanded, not whether it exists) without
        passing through another vessel -- from another page of the drawing,
        which is where pid-designer puts the cart. Two flight bottles
        manifolded together on the vehicle page are not one filling the other."""
        built = self.model.built
        net = built.network
        types = {n.id: n.type for n in self.model.diagram.nodes}
        pages = {n.id: n.page or "Main" for n in self.model.diagram.nodes}
        # A vessel joined to its manifold by an unsized line shares a node with
        # the junction: the vessel is what that place is. (Keyed last-wins, a
        # cart's K-bottle read as its junction and was never found.)
        place: dict[str, str] = {}
        for sid, kind in types.items():
            where = built.node_of.get(sid, sid)
            if where not in place or kind in {"TANK", "KBOTTLE", "DEWAR"}:
                place[where] = sid
        neighbours: dict[str, set[str]] = {}
        for branch in net.branches.values():
            neighbours.setdefault(branch.upstream, set()).add(branch.downstream)
            neighbours.setdefault(branch.downstream, set()).add(branch.upstream)

        def reaches(starts: set[str], kinds: set[str], own: str) -> str:
            seen, frontier = set(starts), list(starts)
            while frontier:
                here = frontier.pop()
                for there in neighbours.get(here, ()):
                    if there in seen:
                        continue
                    seen.add(there)
                    symbol = place.get(there, "")
                    if (
                        symbol
                        and symbol != own
                        and types.get(symbol) in kinds
                        and pages.get(symbol) != pages.get(own)
                    ):
                        return symbol
                    if net.nodes[there].pressure is not None:
                        continue  # another vessel, a vent, the chamber: stop
                    frontier.append(there)
            return ""

        found: set[str] = set()
        labels = {n.id: n.label or n.id for n in self.model.diagram.nodes}
        fed_by = {
            vehicle_tank: supply_tank
            for supply_tank, fed in built.supplies.items()
            for vehicle_tank in fed
        }
        for tank_id, ports in built.tanks.items():
            if tank_id in built.supplies:
                continue  # the cart's own tank: pre-loaded, never loaded here
            supply = fed_by.get(tank_id) or reaches(
                {ports.ullage, ports.outlet}, {"DEWAR"}, tank_id
            )
            if supply:
                found.add(tank_id)
                self.assumptions.append(
                    f"{labels.get(tank_id, tank_id)} is loaded through the drawing "
                    f"(from {labels.get(supply, supply)}): the built-in tanker load is off."
                )
        ground = self.ground
        for bottle_id in self.bottles:
            if bottle_id in ground:
                continue  # a cart bottle is the supply, delivered full
            start = built.node_of.get(bottle_id, bottle_id)
            supply = reaches({start}, {"KBOTTLE", "DEWAR"}, bottle_id)
            if supply:
                found.add(bottle_id)
                self.assumptions.append(
                    f"{labels.get(bottle_id, bottle_id)} is charged through the drawing "
                    f"(from {labels.get(supply, supply)}): the cart's built-in charge is off."
                )
        return frozenset(found)

    def _find_cut_dome_ports(self) -> dict[str, frozenset[str]]:
        """The network nodes a dome-loaded regulator's dome line reaches, for
        each one with no loader left on the drawing: its loader was on the cart
        and went with it (:attr:`Setup.ignore_gse`). The line is no plumbing,
        so the solve leaves it at atmosphere; its transducer reads the dome the
        knob sets. Walked from the ``dome`` handle through junctions and
        instruments, stopping at any valve, regulator, disconnect or vessel."""
        built = self.model.built
        diagram = self.model.diagram
        by_id = {n.id: n for n in diagram.nodes}
        adjacent: dict[str, set[str]] = {}
        for edge in diagram.edges:
            adjacent.setdefault(edge.source, set()).add(edge.target)
            adjacent.setdefault(edge.target, set()).add(edge.source)
        loaded = {loader.signal for loader in built.dome_loaders.values()}
        stop = INLINE_TYPES | SOURCE_TYPES | BOUNDARY_TYPES
        out: dict[str, frozenset[str]] = {}
        for node in diagram.nodes:
            if node.type != "PR" or node.options.get("domeLoaded") != "yes":
                continue
            if built.actuators.get(node.id, "") in loaded | {""}:
                continue  # a loader still drawn sets it, or it was never built
            frontier = [
                e.target if e.source == node.id else e.source
                for e in diagram.edges
                if (e.source == node.id and e.source_handle == DOME_HANDLE)
                or (e.target == node.id and e.target_handle == DOME_HANDLE)
            ]
            seen: set[str] = set()
            while frontier:
                here = frontier.pop()
                if here in seen or here not in by_id or here == node.id:
                    continue
                seen.add(here)
                if by_id[here].type not in stop:
                    frontier.extend(adjacent.get(here, ()))
            places = {
                built.node_of[sid]
                for sid in seen
                if by_id[sid].type not in stop and sid in built.node_of
            } | {i.node for i in built.instruments if i.id in seen}
            places &= set(built.network.nodes)
            if places:
                out[node.id] = frozenset(places)
        return out

    def _build_vessels(self) -> None:
        """Turn the drawing's tanks and bottles into integrable vessels.

        Tanks start **empty and at atmosphere** whatever the drawing's pressure
        field says. That field is a design pressure, not a starting condition,
        and starting a simulator at the answer is the thing that made the last
        one useless.
        """
        by_id = {n.id: n for n in self.model.diagram.nodes}
        net = self.model.built.network

        for drawing_id, ports in self.model.built.tanks.items():
            node = by_id.get(drawing_id)
            if node is None:
                continue
            volume = node.params.get("volume")
            diameter = node.params.get("diameter")
            litres = volume.si if volume is not None else 0.0175
            bore = diameter.si if diameter is not None else 0.1524
            if diameter is None:
                self.assumptions.append(
                    f"{node.label} diameter: {bore * 1e3:.0f} mm assumed (not on the "
                    "drawing); sets the liquid column height and outlet head."
                )

            species = net.nodes[ports.outlet].fluid
            temperature = net.nodes[ports.outlet].temperature
            # The ullage node carries the pressurant, so the drawing already
            # says what is pushing on this propellant. Hard-coding nitrogen here
            # made a helium stand quietly a nitrogen one.
            pressurant = Fluid(net.nodes[ports.ullage].fluid)
            geometry = _tank_geometry(litres, bore)
            wall_mass, wall_capacity, wall_conductance = _vessel_wall(
                node,
                litres,
                self._tank_wall_defaults(),
                self.assumptions,
                estimate=self._film_estimator(pressurant, node, geometry),
            )
            tank = Tank(
                Fluid(species),
                pressurant,
                _tank_geometry(litres, bore),
                collapse=None if self.setup.ullage_collapse else NoCollapse(),
                vapour=SaturatedVapour() if self.setup.ullage_vapour else NoVapour(),
                wall_mass=wall_mass,
                wall_capacity=wall_capacity,
                wall_conductance=wall_conductance,
                wetted_conductance=self.setup.chilldown,
                nucleate_conductance=self.setup.chilldown_nucleate,
                leidenfrost_superheat=self.setup.leidenfrost_K,
                boiling_onset=self.setup.boiling_onset_K,
                surface_layer=(
                    self.setup.surface_layer_m if self.setup.stratification else 0.0
                ),
                surface_mixing=self.setup.surface_mixing,
                wall_by_level=self.setup.ullage_wall_by_level,
                # A dewar is vacuum-jacketed: its inner vessel takes no skin
                # leak worth the name (and the drawing gives it no insulation
                # to read one from).
                ambient_conductance=(
                    0.0
                    if getattr(node, "drawn_as", "") == "DEWAR"
                    else _skin_conductance(
                        node, self.setup.ambient_leak, self.assumptions
                    )
                ),
                ambient_temperature=self.setup.ambient_T,
                # Boiling at a superheated wall is what makes a shut LOX tank
                # climb; it needs the vapour somewhere to go.
                wall_boiling=self.setup.ullage_vapour and self.setup.wall_boiling,
            )
            limit = _trip_limit(node, self.setup.burst_safety_factor, self.assumptions)
            label = node.label or drawing_id
            try:
                start = tank.initial_state(
                    pressure=AMBIENT,
                    liquid_mass=0.0,
                    liquid_temperature=temperature,
                    gas_temperature=293.15,
                )
            except ValueError as exc:
                # A propellant tank starts from its saturated liquid, which does
                # not exist above the critical point. A COPV drawn with the tank
                # symbol lands here -- nitrogen at 293 K -- and CoolProp's "rhoV
                # is invalid" reached the API as a 500 naming nothing.
                raise AssemblyError(
                    "tank", _not_a_liquid_tank(label, species, temperature, exc)
                ) from exc
            self.tanks[drawing_id] = TankSim(
                id=drawing_id,
                label=label,
                tank=tank,
                node=node,
                # Gauge, like every number an operator reads: 1000 psi on the
                # drawing is what the tank's own gauge would show.
                mawp=limit,
                state=start,
                ullage_node=ports.ullage,
                outlet_node=ports.outlet,
                full_fraction=self.setup.full_fraction,
            )
            if drawing_id in self.ground:
                # A cart tank arrives filled -- a fuel transfer tank is loaded
                # in the shop and pressed on the pad -- and it is where the
                # vehicle's load comes from, not another load.
                sim = self.tanks[drawing_id]
                loaded = sim._wanted()
                # A dewar sits at its own pressure, built by its own circuit,
                # with its liquid at saturation under it; a transfer tank is
                # filled in the shop and pressed on the pad.
                dewar = getattr(node, "drawn_as", "") == "DEWAR"
                drawn = node.params.get("pressure")
                held = drawn.si if (dewar and drawn is not None) else AMBIENT
                sim.state = tank.initial_state(
                    pressure=held,
                    liquid_mass=loaded,
                    liquid_temperature=temperature,
                    # The ullage is the model's pressurant, not the dewar's own
                    # vapour; started cold it sits on nitrogen's saturation
                    # line, where the property layer cannot price it.
                    gas_temperature=293.15,
                    contact_time=PAD_HOLD_S if dewar else 0.0,
                    split_wall=dewar,
                )
                if dewar:
                    # Its inner vessel has held its liquid for days: all of
                    # the metal is at the liquid's temperature. Started warm,
                    # the wall boiled the LOX and the dewar climbed 650 psi in
                    # a minute.
                    sim.state = replace(
                        sim.state,
                        ullage=replace(sim.state.ullage, wall_temperature=temperature),
                    )
                self.assumptions.append(
                    f"{label} is ground support: it starts loaded, "
                    f"{loaded:.2f} kg ({self.setup.full_fraction:.0%} of its "
                    f"{litres * 1e3:.1f} L, Setup), at "
                    + (f"its drawn {psig(held):.0f} psig." if dewar else "atmosphere.")
                )

        for node in self.model.diagram.nodes:
            if node.type not in {"KBOTTLE", "DEWAR"} or node.id not in net.nodes:
                continue
            volume = node.params.get("volume")
            pressure = node.params.get("pressure")
            temp_param = node.params.get("temperature")
            litres = (
                volume.si if volume is not None else self.setup.bottle_volume_L * 1e-3
            )
            if volume is None:
                self.assumptions.append(
                    f"{node.label} volume: {litres * 1e3:.2f} L assumed -- the "
                    "stand's 45 scf SCBA COPV (not on the drawing); sets the "
                    "pressure droop."
                )
            wall_mass, wall_capacity, wall_conductance = _vessel_wall(
                node,
                litres,
                self._bottle_wall_defaults(),
                self.assumptions,
                estimate=self._film_estimator(
                    Fluid(net.nodes[node.id].fluid), node, _bottle_geometry(litres)
                ),
            )
            gas = GasVolume(
                Fluid(net.nodes[node.id].fluid),
                litres,
                wall_mass=wall_mass,
                wall_capacity=wall_capacity,
                wall_conductance=wall_conductance,
            )
            # The drawing's pressure is what a full bottle reads. A delivered
            # bottle starts there, at the temperature the drawing gives it;
            # one charged on the pad starts empty, at atmosphere, and the
            # drawing's pressure seeds the fill target instead.
            rated = pressure.si if pressure else 4500.0 * PSI
            ambient_T = temp_param.si if temp_param is not None else 293.15
            # A cart's K-bottle is delivered full; only the vehicle's own
            # bottle is charged on the pad (`Setup.bottle_delivered`).
            # (A dewar holds liquid, which a gas volume cannot start with; it
            # keeps the old start until it is modelled as the liquid supply it
            # is.)
            delivered = bool(self.setup.bottle_delivered) or (
                node.id in self.ground and node.type == "KBOTTLE"
            )
            self.bottles[node.id] = BottleSim(
                id=node.id,
                label=node.label or node.id,
                volume=gas,
                state=gas.initial_state(
                    pressure=rated if delivered else AMBIENT,
                    temperature=ambient_T,
                ),
                node=node.id,
                # The fill target is the panel's; with none set, the drawing's
                # own rated pressure. (`from_psig(0)` is an atmosphere, never
                # falsy, so `or rated` here never fired.)
                target=(
                    from_psig(self.setup.copv_target_psi)
                    if self.setup.copv_target_psi > 0.0
                    else rated
                ),
                fill_seconds=self.setup.copv_fill_s,
                charged=delivered,
                mawp=_trip_limit(
                    node, self.setup.burst_safety_factor, self.assumptions
                ),
            )

    # ------------------------------------------------------------- commands

    def prime(
        self,
        *,
        fill_fraction: float = 0.95,
        tank_psi: float = 500.0,
        copv_psi: float = 0.0,
        state: str = "Ready",
        hold_s: float = PAD_HOLD_S,
        loads: Mapping[str, float] | None = None,
    ) -> None:
        """Put the stand where it is at T-0, without rehearsing the pad.

        ``hold_s`` is how long the tanks have been loaded [s]. It sets two
        things the thermal models are exquisitely sensitive to and that
        ``initial_state`` cannot know: the interface contact time, whose
        collapse flux goes as ``1/sqrt(t)`` and is fifty kilowatts at a
        millisecond; and the wall temperature, which on a cryogenic tank has
        chilled to its contents by the time anybody fires. Built as if freshly
        filled -- wall at room temperature, interface a moment old -- a LOX
        tank with collapse and chilldown enabled collapsed from 550 to 411 psig
        during the study's own settle and read as a violent drop and recovery
        at ignition. That was the initial condition, not the burn.

        Loading and pressing through the sequence is the honest way to get here
        and is what the console does. It is the wrong way to *study* a burn,
        because pressing the tanks draws on the same bottle the study is about:
        an under-sized COPV then fails for two reasons at once and the trace
        cannot tell you which.

        This sets the initial condition directly -- tanks loaded to
        ``fill_fraction`` and sitting at ``tank_psi``, bottle at ``copv_psi`` --
        so the burn starts from a stated, reproducible state and the only thing
        being asked is whether the bottle can hold the tanks up.

        ``loads`` gives the propellant mass [kg] for the tanks it names, in
        place of ``fill_fraction`` -- for a vehicle whose load is fixed by mass
        (a competition rule, a measured fill) rather than by a level. A load
        that would not fit the tank is refused, not clipped.
        """
        loads = dict(loads or {})
        unknown = sorted(set(loads) - set(self.tanks))
        if unknown:
            raise ValueError(
                f"loads names {', '.join(unknown)}, which this drawing has no "
                f"tank for (tanks: {', '.join(sorted(self.tanks)) or 'none'})"
            )
        ground = self.ground
        for tank_id, sim in self.tanks.items():
            if tank_id in ground and tank_id not in loads:
                continue  # the cart's tank: T-0 is the vehicle's, not its
            capacity = sim.tank.geometry.total_volume * fill_fraction
            rho = sim.tank.liquid.get("rho", T=sim.state.liquid_temperature, q=0.0)
            if tank_id in loads:
                volume = loads[tank_id] / rho
                if not 0.0 < volume < sim.tank.geometry.total_volume:
                    raise ValueError(
                        f"{tank_id}: {loads[tank_id]:.3f} kg is "
                        f"{volume * 1e3:.2f} L of liquid in a "
                        f"{sim.tank.geometry.total_volume * 1e3:.2f} L tank"
                    )
                capacity = volume
            # A tank that has been loaded for `hold_s`: the wall under the
            # liquid has chilled to it, the wall above the ullage has not, and
            # the interface has been there the whole time. One lumped wall
            # cannot say that -- at liquid temperature it condenses the
            # pressurant on the ullage face, at ambient it boils the liquid --
            # so the primed tank carries two.
            sim.state = sim.tank.initial_state(
                pressure=from_psig(tank_psi),
                liquid_mass=capacity * rho,
                liquid_temperature=sim.state.liquid_temperature,
                gas_temperature=293.15,
                contact_time=max(hold_s, 0.0),
                split_wall=True,
            )
            upper = self._ullage_wall_T0(tank_id, sim)
            if upper is not None:
                # Only the metal: the gas is as pressed, and the two exchange
                # heat from the first step (Setup.ullage_wall_T0_K).
                sim.state = replace(
                    sim.state,
                    ullage=replace(sim.state.ullage, wall_temperature=upper),
                )
                note = (
                    f"{sim.label} upper wall at T-0: {upper:.1f} K (Setup), "
                    "not the pressurant's 293.15 K."
                )
                if note not in self.assumptions:
                    self.assumptions.append(note)
            sim.empty = False
        for bottle in self.bottles.values():
            if bottle.id in ground:
                continue  # a cart bottle keeps what it holds
            if copv_psi > 0.0:
                bottle.state = bottle.volume.initial_state(
                    pressure=from_psig(copv_psi), temperature=293.15
                )
            bottle.charged = True
        if state in self.machine.states and state != self.state:
            self.state = state
            self._state_since = self.t
        # T-0 has the dome loaded on the pad, whatever the line's valves are
        # doing when the session is put there.
        self._dome_primed = True
        self._guess = {}
        self._last_flows = {}
        self._last_pressures = {}
        self._last_isolated = frozenset()
        # The inventory was set, not reached: the mass balance starts here.
        self.reset_balance()

    def _ullage_wall_T0(self, tank_id: str, sim: TankSim) -> float | None:
        """The upper-wall T-0 temperature the setup asks of this tank [K], or
        None for the previous behaviour (the pressurant's temperature)."""
        named = self.setup.ullage_wall_T0_K.get(tank_id)
        if named is not None and named > 0.0:
            return float(named)
        cryogen = self.setup.cryogen_ullage_wall_T0_K
        if cryogen > 0.0 and sim.state.liquid_temperature < CRYOGENIC_K:
            return float(cryogen)
        return None

    def _loader_supply(self, loader: object) -> float:
        """Pressure feeding a dome control regulator [Pa].

        The bottle it hangs off, read from state rather than from the last
        solve: the dome has to be known *before* the network is solved, and a
        stale node pressure from the previous tick would put the dome one step
        behind the supply it is supposed to track.
        """
        ground = self.ground
        for bottle in sorted(self.bottles.values(), key=lambda b: b.id in ground):
            if bottle.charged:
                return float(bottle.pressure)
        return 0.0

    def _film_estimator(
        self, gas: Fluid, node: object, geometry: CylindricalTank
    ) -> Callable[[], GasFilm] | None:
        """A thunk for the still-gas film of one vessel, or None when the
        setup says to keep the per-litre default."""
        if not self.setup.wall_hA_from_gas:
            return None
        params = getattr(node, "params", {}) or {}
        nominal = params.get("pressure")
        pressure = float(nominal.si) if nominal is not None else 500.0 * PSI
        d_t = self.setup.wall_hA_dT

        def estimate() -> GasFilm:
            return still_gas_conductance(
                gas,
                pressure,
                self.setup.ambient_T,
                geometry.height,
                geometry.wetted_area(geometry.height),
                d_t,
            )

        return estimate

    def _tank_wall_defaults(self) -> dict[str, Any]:
        return {
            "kg_per_litre": self.setup.tank_wall_kg_per_L,
            "capacity": self.setup.tank_wall_capacity,
            "hA_ref": (self.setup.tank_wall_hA, 17.5),
            "basis": TANK_WALL["basis"],
        }

    def _bottle_wall_defaults(self) -> dict[str, Any]:
        return {
            "kg_per_litre": self.setup.bottle_wall_kg_per_L,
            "capacity": BOTTLE_WALL["capacity"],
            "hA_ref": (self.setup.bottle_wall_hA, 4.687),
            "basis": BOTTLE_WALL["basis"],
        }

    def apply_thermal(self) -> None:
        """Push the thermal knobs in ``setup`` onto vessels already built.

        The tanks were constructed with whatever the setup said at the time;
        the console changes it while the stand runs, and a knob that only
        took effect on the next session was a knob that did not work.
        """
        for sim in self.tanks.values():
            tank = sim.tank
            tank.collapse = (
                ConductionCollapse() if self.setup.ullage_collapse else NoCollapse()
            )
            tank.vapour = SaturatedVapour() if self.setup.ullage_vapour else NoVapour()
            tank.wetted_conductance = float(self.setup.chilldown)
            tank.nucleate_conductance = float(self.setup.chilldown_nucleate)
            tank.leidenfrost_superheat = float(self.setup.leidenfrost_K)
            tank.boiling_onset = float(self.setup.boiling_onset_K)
            tank.surface_mixing = float(self.setup.surface_mixing)
            tank.wall_by_level = bool(self.setup.ullage_wall_by_level)
            tank.surface_layer = (
                float(self.setup.surface_layer_m) if self.setup.stratification else 0.0
            )
            # A layer switched on mid-run starts at the bulk; switched off, the
            # state drops it and the liquid is well mixed from here.
            if tank.surface_layer > 0.0 and sim.state.surface_temperature is None:
                sim.state = replace(
                    sim.state, surface_temperature=sim.state.liquid_temperature
                )
            elif (
                tank.surface_layer <= 0.0 and sim.state.surface_temperature is not None
            ):
                sim.state = replace(sim.state, surface_temperature=None)
            tank.ambient_conductance = _skin_conductance(
                sim.node, float(self.setup.ambient_leak), []
            )
            tank.ambient_temperature = float(self.setup.ambient_T)
            tank.wall_boiling = bool(
                self.setup.ullage_vapour and self.setup.wall_boiling
            )

    def command_state(self, state: str) -> None:
        if state not in self.machine.states:
            raise ValueError(f"no state {state!r}")
        if not self.machine.can_go(self.state, state):
            raise PermissionError(
                f"{self.state} cannot go to {state}. From here: "
                f"{', '.join(self.machine.targets(self.state))}"
            )
        self.state = state
        self._state_since = self.t
        # A transition writes every actuator the table knows, the way the
        # DAQ does, so a valve taken by hand goes back to the table's command
        # here. Holds used to outlive the state forever: the table opened Fuel
        # Main and LOX Press in *Idle* (see NEEDS-REPAIR.md; the machine now
        # holds Idle shut), an operator shut them by hand because that was
        # plainly wrong for a cold stand, and from then on Ox Press pressed
        # nothing and Fire opened no main -- with no sign of why beyond a
        # small HELD badge. Valves the table never commands keep whatever
        # the hand set.
        for symbol in self.binding.to_symbol.values():
            self.forced.pop(symbol, None)

    @property
    def operator_held(self) -> list[str]:
        """Valves a person has taken from the state table, by drawing id.

        :attr:`forced` holds those, and also the twin's own crew on a drawn
        load -- the transfer valve it shuts at the start and opens for the
        load. Shown as the operator's "1 held" on a stand nobody had touched,
        that read as a bug (the operator, 2026-10-09). A crew valve a person
        has since turned the other way is the person's again.
        """
        crew = {
            valve
            for valve, opened in self._fill_crew.items()
            if self.forced.get(valve) == (1.0 if opened else 0.0)
        }
        return sorted(v for v in self.forced if v not in crew)

    def set_valve(self, drawing_id: str, is_open: bool) -> None:
        self.forced[drawing_id] = 1.0 if is_open else 0.0

    def release(self, drawing_id: str = "") -> None:
        """Hand a valve back to the state table; with no id, every valve a
        person took (:attr:`operator_held`) -- not the crew's on a drawn load,
        which would open the transfer line out of turn."""
        if drawing_id:
            self.forced.pop(drawing_id, None)
        else:
            for valve in self.operator_held:
                self.forced.pop(valve, None)

    def skip_chilldown(self, tank_id: str = "") -> list[str]:
        """Chill a cryogen tank's wall now rather than wait for the load to.

        A load spends minutes chilling the metal before anything collects --
        ~5 on LE4 at the calibrated dewar valve, ~10 on the stand -- and nobody
        rehearsing waits that out (the team, 2026-10-08). Each vehicle tank, or
        the one named, gets :meth:`TankSim.skip_chill`; the cart's own vessels
        are supplies and are left alone. The assumptions say so, so a burn's
        record shows its pad was cut short. Returns the labels of the tanks it
        chilled: none when every wall is already cold.
        """
        if tank_id and tank_id not in self.tanks:
            raise KeyError(f"no tank {tank_id!r}")
        ground = self.ground
        chilled: list[str] = []
        for sim in self.tanks.values():
            if (tank_id and sim.id != tank_id) or sim.id in ground:
                continue
            flashed = sim.chill_boiled
            if not sim.skip_chill():
                continue
            chilled.append(sim.label)
            self.assumptions.append(
                f"Chilldown skipped on {sim.label}: wall put at "
                f"{sim.state.ullage.wall_temperature:.0f} K, where the load's chill "
                f"takes it, without the {(sim.chill_boiled - flashed) * 1e3:.0f} g "
                "of propellant that chill flashes off."
            )
        return chilled

    # ---------------------------------------------------------------- signals

    def signals(self, dt: float = 0.0) -> dict[str, float]:
        """What the components read this tick: the state, then hand overrides.

        Valve positions *slew* toward their commanded value rather than
        snapping to it. A main valve that goes shut-to-open in zero time is a
        step input into an ullage of half a litre, and the tank pressure dip it
        produces is a property of the step, not of the stand: the drop comes
        out several times deeper than the pad shows, and it arrives before the
        chamber has lit, so the injector sees full tank pressure against
        ambient and pulls flow no real start ever pulls. Each valve carries a
        `travel_time`; this is the one place it can be honoured, because the
        state machine deals in commanded positions and knows nothing of time.
        """
        built = self.model.built
        out: dict[str, float] = {}
        commanded = self.binding.positions_for(self.machine, self.state)
        lines = {line.loader: line for line in built.dome_lines.values()}
        self._dome_readings = {}

        # The dome, through the regulator that actually loads it. `dome_psi` is
        # the knob on the *control* regulator, not the dome pressure itself:
        # that reg hangs off the same bottle as the one it controls, so its
        # outlet -- and with it the dome, and with it every tank on the stand --
        # rides up as the bottle blows down. Writing the knob straight onto the
        # dome pins it flat and silently switches the supply-pressure effect off
        # for the whole stand, which is the wrong sign to guess at and the one
        # people do guess at.
        if self.hookup is not None:
            # Each knob sets its own regulators: a loader through its own
            # outlet, as below; anything else through its dome signal, which a
            # plain regulator reads as its setpoint.
            labels = {n.id: n.label or n.id for n in self.model.diagram.nodes}
            for knob in self.hookup.knobs:
                psig_set = (
                    self.setup.dome_psi
                    if knob.id == DOME
                    else (
                        self.setup.copv_target_psi
                        if knob.id == CHARGE
                        else self.knobs.get(knob.id, knob.psig)
                    )
                )
                for regulator in knob.regulators:
                    loader = built.dome_loaders.get(regulator)
                    if loader is not None:
                        out[loader.signal] = self._gated_dome(
                            lines.get(regulator),
                            self._through_loader(loader, psig_set),
                            commanded,
                        )
                    elif regulator in labels:
                        out[f"{labels[regulator]}.dome"] = from_psig(psig_set)
        else:
            for loader in built.dome_loaders.values():
                out[loader.signal] = self._gated_dome(
                    lines.get(loader.id),
                    self._through_loader(loader, self.setup.dome_psi),
                    commanded,
                )
            if not built.dome_loaders:
                dome_signal = next(
                    (s for s in built.actuators.values() if s.endswith(".dome")), ""
                )
                if dome_signal:
                    out[dome_signal] = from_psig(self.setup.dome_psi)

        # A dome line whose loader went with the GSE reads the dome it is set to.
        for regulator, places in self._dome_ports.items():
            dome = out.get(built.actuators[regulator])
            if dome is not None:
                self._dome_readings.update(dict.fromkeys(places, dome))

        self._dome_primed = False
        for drawing_id, signal in built.actuators.items():
            if signal.endswith(".dome"):
                continue
            # Uncommanded, a valve rests where the drawing puts it: an actuated
            # valve at its unpowered position, a hand valve where the build
            # read it (`BuiltNetwork.rest`). Shut when the drawing says nothing.
            target = (
                self.forced[drawing_id]
                if drawing_id in self.forced
                else commanded.get(drawing_id, built.rest.get(drawing_id, 0.0))
            )
            out[signal] = self._slew(drawing_id, target, dt)
        return out

    def peek_signals(self, *, loaded_dome: bool = False) -> dict[str, float]:
        """What the components would read now, moving nothing.

        :meth:`signals` is the step's: it slews each valve toward its command
        (a zero ``dt`` snaps it there), spends the T-0 dome prime, and records
        what each dome line holds. A readout must do none of that -- the
        lockup under the dome knob, asked for on every console tick, snapped
        every valve to its command mid-travel, so the console's mains opened
        in one tick whatever their travel time.

        ``loaded_dome``: read each dome line as open to its loader, the dome
        the knob sets -- not what a shut line holds (atmosphere, in Idle).
        """
        positions = dict(self._positions)
        held = dict(self._dome_held)
        readings = dict(self._dome_readings)
        primed = self._dome_primed
        self._dome_primed = primed or loaded_dome
        try:
            return self.signals()
        finally:
            self._positions.clear()
            self._positions.update(positions)
            self._dome_held.clear()
            self._dome_held.update(held)
            self._dome_readings = readings
            self._dome_primed = primed

    def _gated_dome(
        self, line: DomeLine | None, live: float, commanded: Mapping[str, float]
    ) -> float:
        """The dome a gated dome line gives: its loader's outlet while the line
        is open between them, atmosphere once an open vent reaches the port
        side, and otherwise what was shut in [Pa abs].

        Walked from the dome port each tick, through what is open. A valve no
        actuator drives passes (nothing on the stand shuts it); a vent valve
        no actuator drives, and a hand valve nobody has opened, rest shut.
        """
        if line is None:
            return live
        built = self.model.built

        def is_open(valve: str) -> bool:
            if valve in self.forced:
                return self.forced[valve] >= 0.5
            if valve in commanded:
                return commanded[valve] >= 0.5
            if valve in built.hand_valves or valve in line.vents:
                return built.rest.get(valve, 0.0) >= 0.5
            return True

        def region(starts: frozenset[str] | set[str]) -> set[str]:
            reached: set[str] = set()
            frontier = list(starts)
            while frontier:
                here = frontier.pop()
                if here in reached:
                    continue
                reached.add(here)
                if here in line.valves and not is_open(here):
                    continue  # shut: its body is reached, nothing past it
                frontier.extend(line.adjacent.get(here, ()))
            return reached

        port_side = region(line.ports)
        if line.loader in port_side or self._dome_primed:
            held = live
        elif any(v in port_side and is_open(v) for v in line.vents):
            held = AMBIENT
        else:
            held = self._dome_held.get(line.loaded, AMBIENT)
        self._dome_held[line.loaded] = held
        # What the line's transducers read: the dome on its side, the loader's
        # outlet on the loader's side of a shut valve.
        loader_side = region({line.loader}) - port_side
        for symbols, value in ((port_side, held), (loader_side, live)):
            for symbol in symbols:
                for node in (
                    built.node_of.get(symbol),
                    f"{symbol}.in",
                    f"{symbol}.out",
                ):
                    if node and node in built.network.nodes:
                        self._dome_readings[node] = value
        for instrument in built.instruments:
            for symbols, value in ((port_side, held), (loader_side, live)):
                if any(
                    built.node_of.get(sym) == instrument.node
                    or instrument.node in (f"{sym}.in", f"{sym}.out")
                    for sym in symbols
                ):
                    self._dome_readings[instrument.node] = value
        return held

    def _through_loader(self, loader: DomeLoader, psig_set: float) -> float:
        """The dome a control regulator set to ``psig_set`` gives, from its
        supply now [Pa]."""
        built = self.model.built
        supply = self._loader_supply(loader)
        if supply <= 0.0 or not isinstance(loader.component, Regulator):
            return from_psig(psig_set)
        conditions = built.network.conditions(
            loader.supply_node,
            supply,
            {f"{loader.component.id}.dome": from_psig(psig_set)},
        )
        return float(loader.component.outlet_setpoint(0.0, conditions))

    def _slew(self, drawing_id: str, target: float, dt: float) -> float:
        """Move one actuator toward ``target`` at its own travel rate."""
        current = self._positions.get(drawing_id, target)
        if dt <= 0.0:
            self._positions[drawing_id] = target
            return target
        travel = self._travel_time(drawing_id)
        step = 1.0 if travel <= 0.0 else dt / travel
        if abs(target - current) <= step:
            current = target
        else:
            current += step if target > current else -step
        self._positions[drawing_id] = current
        return current

    def _travel_time(self, drawing_id: str) -> float:
        """Shut-to-open time for one actuator [s], off the drawing."""
        cached = self._travel.get(drawing_id)
        if cached is not None:
            return cached
        seconds = self.setup.valve_travel_s
        for branch_id in self.model.built.branches_of.get(drawing_id, ()):
            branch = self.model.built.network.branches.get(branch_id)
            component = getattr(branch, "component", None)
            if component is not None:
                found = component.p.get("travel_time", 0.0)
                if found > 0.0:
                    seconds = float(found)
                    break
        self._travel[drawing_id] = seconds
        return seconds

    # ------------------------------------------------------------------ tick

    def _dry_branches(self) -> frozenset[str]:
        """Feed branches leaving a tank with nothing left in it."""
        net = self.model.built.network
        out: set[str] = set()
        for sim in self.tanks.values():
            if sim.state.liquid_mass > DRY_MASS:
                continue
            filling = self._fill_lines.get(sim.id, frozenset())
            # The line it is loaded through stays open to a dry tank in its fill
            # state, and only then. Always open, an open branch flows both
            # ways: with a dump open on the far side (LE4's FD-ROT-G, which
            # nothing commands and rests open) the dry tank "drained" through
            # it at ~0.5 kg/s for as long as the stand ran, the vessel's floor
            # re-making every gram -- 20 kg of propellant from nothing in 40 s.
            # Not on the last solve's pressures: the two sides of a dry tank's
            # idle line sit within a hair of each other, the line flipped every
            # step, and a circuit that changes every step drops its flows every
            # step (a topped LOX tank's vent with them). Nor on the transfer
            # valve held open by hand, which is that drain again. A dry tank is
            # loaded through the drawing in its fill state.
            loading = self._loading(sim)
            for branch_id, branch in net.branches.items():
                if sim.outlet_node not in (branch.upstream, branch.downstream):
                    continue
                if branch_id in filling and loading:
                    continue
                out.add(branch_id)
        return frozenset(out)

    def _firing(self) -> bool:
        """Propellant reached the engine on the last solve."""
        ports = self.model.built.engine_ports
        return any(
            self._last_flows.get(ports.get(side, ""), 0.0) > 0.0
            for side in ("oxidiser", "fuel")
        )

    def _rest_ground(self, signals: Mapping[str, float]) -> None:
        """Decide which ground support rests this step (``self._resting``).

        Nothing rests here unless the engine is burning, the drawing has
        ground support, and :attr:`Setup.ground_rests` is on. (A cart vessel
        with nothing flowing rests at any time: :meth:`_move_vessels`.)
        """
        nothing: tuple[frozenset[str], frozenset[str]] = (frozenset(), frozenset())
        if not self.setup.ground_rests or not self.ground or not self._firing():
            self._resting = nothing
            return
        net = self.model.built.network
        shut = frozenset(net.isolated(signals)) | self._dry_branches()
        key, value = self._resting_memo
        if key != shut:
            value = self._unreachable_ground(shut)
            self._resting_memo = (shut, value)
        self._resting = value

    def _unreachable_ground(
        self, shut: frozenset[str]
    ) -> tuple[frozenset[str], frozenset[str]]:
        """Ground branches and vessels with no open path to the vehicle.

        Walked from the vehicle's vessels and the engine across every branch
        not ``shut``. A tank is one place, so arriving at either of its nodes
        reaches both; any other fixed node -- atmosphere -- ends the walk, or
        every vent would join the cart to the vehicle through the sky.
        """
        net = self.model.built.network
        ground = self.ground
        sibling: dict[str, str] = {}
        for sim in self.tanks.values():
            sibling[sim.ullage_node] = sim.outlet_node
            sibling[sim.outlet_node] = sim.ullage_node
        vessels = set(sibling) | {b.node for b in self.bottles.values()}
        seeds = {
            node
            for sim in self.tanks.values()
            if sim.id not in ground
            for node in (sim.ullage_node, sim.outlet_node)
        }
        seeds |= {b.node for b in self.bottles.values() if b.id not in ground}
        chamber = self.model.built.engine_ports.get("chamber")
        if chamber:
            seeds.add(chamber)
        adjacent: dict[str, list[str]] = {}
        for branch_id, branch in net.branches.items():
            if branch_id in shut:
                continue
            adjacent.setdefault(branch.upstream, []).append(branch.downstream)
            adjacent.setdefault(branch.downstream, []).append(branch.upstream)
        reached = set(seeds)
        stack = list(seeds)
        while stack:
            here = stack.pop()
            if here in sibling and sibling[here] not in reached:
                reached.add(sibling[here])
                stack.append(sibling[here])
            for there in adjacent.get(here, ()):
                if there in reached:
                    continue
                if net.nodes[there].is_fixed and there not in vessels:
                    continue  # atmosphere: a sink, not a path
                reached.add(there)
                stack.append(there)
        branches = frozenset(
            branch_id
            for branch_id, branch in net.branches.items()
            if branch_id not in shut
            and branch.upstream not in reached
            and branch.downstream not in reached
        )
        resting = {
            sim.id
            for sim in self.tanks.values()
            if sim.id in ground and sim.ullage_node not in reached
        }
        resting |= {
            b.id
            for b in self.bottles.values()
            if b.id in ground and b.node not in reached
        }
        return branches, frozenset(resting)

    def _coupling_timescale(
        self,
        signals: Mapping[str, float] | None = None,
        dt: float = 0.0,
        press: bool = True,
    ) -> float:
        """Shortest ullage RC time constant on the stand [s], or 0.

        ``C = V rho / p`` is the isothermal gas capacitance of an ullage -- how
        much mass it takes to raise its pressure by a pascal. Two resistances
        are paired with it, and the shorter product is what the coupling step
        has to resolve.

        The regulator's slope, ``flow_droop / rated_flow``: how many pascals
        its outlet gives up per kg/s drawn. That is the regulator-ullage loop.

        And the ullage's own press path (:meth:`_press_path_timescale`): what
        the flow into the tank does when the *tank* moves, with the outlet node
        next door held. Two tanks on one press manifold trade gas through
        nothing but their solenoids, and on helium that is a few milliseconds
        where the regulator's is tens. Stepped past it, each solve sent gas the
        wrong way through a solenoid for a whole coupling step: the tank fell
        15-30 psi in a quarter of a hundredth of a second, the other dumped
        into it, and every LE4 helium burn plotted a 0.5-0.8 s sawtooth that
        cost 170 N of mean thrust (2026-10-05).
        """
        resting_branches, resting = self._resting
        net = self.model.built.network
        shut = (
            frozenset(net.isolated(signals)) | self._dry_branches() | resting_branches
        )
        slopes = self._regulator_slopes(shut)
        tau = float("inf")
        for sim in self.tanks.values():
            if sim.id in resting:
                continue
            p = sim.pressure
            if p <= 0.0:
                continue
            volume = sim.tank.ullage_volume(sim.state)
            if volume <= 0.0:
                continue
            capacitance = sim.state.ullage.mass / p  # V rho / p, with V rho = m
            resistance = slopes.get(sim.ullage_node, 0.0)
            if resistance > 0.0:
                tau = min(tau, capacitance * resistance)
            if press:
                tau = min(
                    tau, self._press_path_timescale(sim, capacitance, signals, dt)
                )
        return tau if tau < float("inf") else 0.0

    def _regulator_slopes(self, shut: frozenset[str]) -> dict[str, float]:
        """Each ullage's stiffest regulator slope, ``flow_droop / rated_flow``
        [Pa/(kg/s)], over the regulators it is joined to.

        Walked from the ullage across every branch not ``shut``, never on
        through another boundary (a vessel, the sky). A regulator the tank
        has no open path to is no loop with it: every regulator on the stand
        used to be paired with every ullage, so a LOX tank topped in Ox Fill,
        its press valve shut, was stepped at the cart's fuel regulator's time
        constant -- three solves every 20 ms for a loop that did not exist.
        Remembered per shut set and boundaries, as ``Network.dead_ends`` is.
        """
        net = self.model.built.network
        fixed = frozenset(n for n, node in net.nodes.items() if node.is_fixed)
        key = (shut, fixed)
        memo_key, memo = self._regulator_memo
        if memo_key == key:
            return memo
        adjacent: dict[str, list[tuple[str, str]]] = {}
        for branch_id, branch in net.branches.items():
            if branch_id in shut:
                continue
            adjacent.setdefault(branch.upstream, []).append(
                (branch_id, branch.downstream)
            )
            adjacent.setdefault(branch.downstream, []).append(
                (branch_id, branch.upstream)
            )
        slope_of: dict[str, float] = {}
        for branch_id, branch in net.branches.items():
            comp = getattr(branch, "component", None)
            if comp is None or "Regulator" not in type(comp).__name__:
                continue
            droop = comp.p.get("flow_droop", 0.0)
            rated = comp.p.get("rated_flow", 0.0)
            if droop > 0.0 and rated > 0.0:
                slope_of[branch_id] = droop / rated
        out: dict[str, float] = {}
        for sim in self.tanks.values():
            start = sim.ullage_node
            reached = {start}
            stack = [start]
            found: list[float] = []
            while stack:
                here = stack.pop()
                for branch_id, there in adjacent.get(here, ()):
                    if branch_id in slope_of:
                        found.append(slope_of[branch_id])
                    if there in reached:
                        continue
                    reached.add(there)
                    if there not in fixed:
                        stack.append(there)
            if found:
                out[start] = min(found)
        self._regulator_memo = (key, out)
        return out

    def _press_path_timescale(
        self,
        sim: TankSim,
        capacitance: float,
        signals: Mapping[str, float] | None,
        dt: float = 0.0,
    ) -> float:
        """``C / G`` for one ullage while its tank is delivering liquid [s].

        ``G`` is the ullage's admittance: the sum over the gas branches on it of
        ``1 / (d dp / d mdot)``, each slope taken at the flow the last solve put
        through it -- or at the flow the ullage needs to replace the liquid
        leaving it, if that is more. Counting only the branch on the tank and
        not what lies beyond it overstates ``G``, so it errs toward more steps.

        Only while liquid is leaving. A tank at rest has no drain to outrun its
        press path, and at zero flow a quadratic loss has zero slope: the
        constant goes to zero and would spend the step limit on a pad hold that
        a few grams of slosh cannot disturb.

        And only while the tank rides its supply -- within ``supply_band`` of
        the node feeding it, the band in which :meth:`TankSim.advance` clamps
        the inflow. That is where a step's drain carries the tank across its
        supply and the next solve sends its gas back out. A tank sitting
        clearly under its supply cannot be carried across, and gets nothing
        from the finer steps: the shipped GN2 stand burns 6-8 psi under its
        manifold and traced identically either way, at twice the cost.

        And only while the drain is enough to matter: over the tick, more
        than :data:`PRESS_PATH_DRAIN_FRACTION` of that band. Below it the
        drain cannot carry the tank across its supply, and what is left is a
        nearly empty tank at an abort, with a trickle out and a trickle in --
        whose zero-flow slope asked for 0.3 ms steps and stalled the panel.

        Infinity when there is nothing to measure.
        """
        net = self.model.built.network
        _, liquid_out = self._split_at(sim.outlet_node, self._last_flows)
        volume = sim.tank.ullage_volume(sim.state)
        if liquid_out <= 0.0 or volume <= 0.0:
            return float("inf")
        rho_liquid = max(sim.tank.liquid_density(sim.state), 1.0)
        # Isothermal: the ullage pressure falls as p Q / V while it is unfed.
        drained = sim.pressure * liquid_out / rho_liquid / volume * dt
        # The press side only: gas branches whose far end is a free node of
        # the network -- a press line, a manifold. A vent ends at atmosphere,
        # a fixed pressure; counted, a venting tank read as riding its supply
        # and its vent valve's slope at drain flow asked an Engine Abort for
        # 0.3 ms steps. Nor a branch that can carry nothing -- shut, or a stub
        # ending at a capped port: priced at the drain flow, the wide fitting
        # under LE4 (6)'s fuel-tank top QD asked the ignition step for 0.07 ms
        # steps, three hundred solves on the first tick of Fire.
        shut = frozenset(net.isolated(signals)) | self._dry_branches()
        dead = shut | {d.branch for d in net.dead_ends(exclude=shut)}
        paths = []
        for branch_id, branch in net.branches.items():
            if sim.ullage_node not in (branch.upstream, branch.downstream):
                continue
            if branch_id in dead:
                continue
            if sim.outlet_node in (branch.upstream, branch.downstream):
                continue  # the liquid column, not a gas path
            far = (
                branch.upstream
                if branch.downstream == sim.ullage_node
                else branch.downstream
            )
            if net.nodes[far].pressure is None:
                paths.append((branch_id, branch))
        supply = max(
            (
                self._guess.get(
                    (
                        branch.upstream
                        if branch.downstream == sim.ullage_node
                        else branch.downstream
                    ),
                    0.0,
                )
                for _, branch in paths
            ),
            default=0.0,
        )
        band = self.setup.supply_band * supply
        if supply <= 0.0 or supply - sim.pressure > band:
            return float("inf")
        if drained < PRESS_PATH_DRAIN_FRACTION * band:
            return float("inf")
        rho_gas = sim.state.ullage.mass / volume
        needed = rho_gas * liquid_out / rho_liquid
        admittance = 0.0
        for branch_id, branch in paths:
            upstream = self._guess.get(branch.upstream)
            if upstream is None or upstream <= 0.0:
                continue
            flow = max(abs(self._last_flows.get(branch_id, 0.0)), needed)
            if flow <= 0.0:
                continue
            step = flow * PRESS_PATH_FD
            try:
                conditions = net.conditions(
                    branch.upstream, upstream, dict(signals or {})
                )
                slope = (
                    branch.component.total_dp(flow + step, conditions)
                    - branch.component.total_dp(flow - step, conditions)
                ) / (2.0 * step)
            except (
                Exception
            ):  # noqa: BLE001 - a branch that cannot price it says nothing
                continue
            if slope > 0.0:
                admittance += 1.0 / slope
        return capacitance / admittance if admittance > 0.0 else float("inf")

    def _vessel_pressures(self) -> dict[str, float]:
        out = {sim.id: sim.pressure for sim in self.tanks.values()}
        out.update({b.id: b.pressure for b in self.bottles.values()})
        return out

    def _ullage_storage(
        self, dt: float, isolated: frozenset[str]
    ) -> dict[str, tuple[float, float]]:
        """Each ullage's closure over a ``dt`` coupling step, for the solve.

        ``{ullage node: (C / dt, reference)}`` (``solve_steady(storage=...)``):
        where the vessel lands with no gas exchanged -- liquid still leaving at
        the last solve's rate, the ullage collapsing, a load still pouring --
        and how many kg/s over the step it takes to move it a pascal from
        there. Both read off the vessel itself, by trial steps on a copy, so
        whatever it models (charge heating, collapse, vapour) is in the slope
        the network sees.

        Without this the solve holds each tank at its start-of-step pressure,
        an explicit coupling of a tiny capacitance behind a huge conductance.
        LE4's 0.41 L ullages behind Cv 4 press solenoids flip-flopped through
        their shared manifold every coupling step: one tank 5 psi high dumping
        40 g/s, the other taking 100 g/s and refusing nearly all of it at its
        supply clip, the regulator drooping at a phantom 60 g/s and both tanks
        parked 25 psi under lockup for as long as the valves stayed open.

        The slope taken is the stiffer of gas in (at the arriving enthalpy)
        and gas out: over-stating the vessel's stiffness only damps the
        closure, under-stating it hands back some of the explicit coupling.
        A tank cut off by shut valves gets none and stays a fixed boundary.

        Except an ullage draining to the sky (:meth:`_venting`), which is
        closed on its gas-out slope alone. There the flow is one way and
        steady, so the slope is not a damping: the node lands at
        ``reference - q dt / slope`` while the vessel lands where its own
        slope puts it, and the stiffer one opens a gap between them that
        grows with the step. Over boiling LOX the two differ eightfold --
        warm gas arriving compresses the ullage, gas leaving is replaced by
        flash boil-off -- and a topped tank on its vent sat 4 psi above the
        node its vent flowed from, at 7.3 psig where finer coupling found
        3.4. A vent ends at a fixed pressure, so there is no second vessel
        across it to flip-flop with.
        """
        out: dict[str, tuple[float, float]] = {}
        if dt <= 0.0:
            return out
        net = self.model.built.network
        # A stub carries nothing either, and the solve drops a store whose
        # every branch is one (``_stores``), so its trial steps would be
        # thrown away: on a stand at rest, most of them.
        cut = set(isolated) | {d.branch for d in net.dead_ends(exclude=isolated)}
        for sim in self.tanks.values():
            node = sim.ullage_node
            touching = [
                (branch_id, sim.outlet_node in (branch.upstream, branch.downstream))
                for branch_id, branch in net.branches.items()
                if node in (branch.upstream, branch.downstream)
            ]
            live = any(
                branch_id not in isolated for branch_id, inner in touching if not inner
            ) and any(branch_id not in cut for branch_id, _ in touching)
            held = sim.state.ullage.mass + sim.state.vapour_mass
            if not live or held <= 0.0:
                continue
            liquid_in, liquid_out = self._split_at(sim.outlet_node, self._last_flows)
            if sim.id not in self._liquid_fed:
                liquid_in = 0.0
            enthalpy = self._pressurant_enthalpy(sim)

            def land(gas_in: float = 0.0, gas_out: float = 0.0) -> float:
                trial = copy.copy(sim)  # state is frozen; the copy owns its own
                trial.advance(
                    dt,
                    mdot_liquid_in=liquid_in,
                    mdot_liquid_out=liquid_out,
                    mdot_gas_in=gas_in,
                    mdot_gas_out=gas_out,
                    enthalpy_gas_in=enthalpy,
                )
                return trial.pressure

            probe = STORAGE_PROBE * held / dt
            try:
                reference = land()
                if self._venting(node, self._last_flows):
                    slope = reference - land(gas_out=probe)
                else:
                    slope = max(
                        land(gas_in=probe) - reference,
                        reference - land(gas_out=probe),
                    )
            except Exception:  # noqa: BLE001 - a vessel that cannot price it
                continue  # stays a fixed boundary, as it always was
            if slope > 0.0 and reference > 0.0:
                out[node] = (probe / slope, reference)
        return out

    def _advance_once(
        self,
        net: Network,
        signals: Mapping[str, float],
        dt: float,
        substeps: int = SUBSTEPS,
    ) -> SteadyResult:
        """One coupling step: solve the network, then move the vessels."""
        given = signals
        self._apply_vessel_pressures()
        if self.setup.regulator_compressible_seat:
            signals = {**signals, SEAT_XT_SIGNAL: float(self.setup.regulator_xT)}
        if self._reliefs:
            signals = self._relief_signals(net, signals)

        # Opening a main changes which branches exist, so the previous answer
        # describes a different circuit. Carrying it over is worse than starting
        # cold: Ready -> Fire warm-started onto a network whose mains had been
        # shut, and the solve returned no flow at all through open valves.
        # A tank that has run dry cannot push liquid, whatever its ullage
        # pressure says. The network sees a fixed-pressure boundary and keeps
        # delivering from it, so the engine went on making four kilonewtons out
        # of an empty pair of tanks. Only the session knows the inventory, so
        # only the session can say.
        dry = self._dry_branches()
        isolated = frozenset(net.isolated(signals)) | dry
        if isolated != self._last_isolated:
            # Keep the pressures, drop the flows. The circuit changed, so the
            # old flows describe paths that may no longer exist -- and a flow of
            # exactly zero is the one starting point Newton cannot move off.
            # The pressures are still close to right everywhere the topology did
            # not change, which is most of the network, and rediscovering them
            # cold is what made flipping a valve cost fifty times a quiet tick.
            self._guess = {
                node: value for node, value in self._guess.items() if node in net.nodes
            }
            self._last_flows = {}
            self._last_isolated = isolated

        # The ground at rest (_rest_ground) leaves the solve as a shut valve
        # would, but is no change of circuit: it carried nothing a step ago.
        resting = self._resting[0]
        storage = self._ullage_storage(dt, isolated | resting)
        result = self._solve(net, signals, dry | resting, storage)
        self._note_solve(result)
        self._accept(result)
        if self._reliefs and result.converged:
            # A relief decided on the last step's pressures may be on the wrong
            # side of its set or reseat pressure at this step's. If the solve
            # just made flips one, solve again with it flipped: a relief that
            # pops opens on the step its tank crossed set, not a step later.
            before = dict(self._relief_open)
            refreshed = self._relief_signals(net, signals, result.pressures)
            if self._relief_open != before:
                signals = refreshed
                isolated = frozenset(net.isolated(signals)) | dry
                if isolated != self._last_isolated:
                    self._last_flows = {}
                    self._last_isolated = isolated
                    storage = self._ullage_storage(dt, isolated | resting)
                result = self._solve(net, signals, dry | resting, storage)
                self._note_solve(result)
                self._accept(result)
        result = self._close_chamber(net, signals, dry | resting, result, storage)
        # The vessels move on the last *converged* flows. A failed solve's
        # iterate is not a flow field -- Newton stopped wherever it stopped and
        # the node balances are not closed -- so integrating on it moves
        # propellant no path carried. With a good solve on this circuit the
        # step holds its flows (the solver tab says so); right after the
        # circuit changed there is none, because `_last_flows` was emptied
        # above, and the vessels exchange nothing for the step. This used to
        # fall back on the failed iterate's flows exactly there: the Ready ->
        # Fire step, or a tank just isolated dry, that the emptying is for.
        flows = self._last_flows
        # A tank that runs dry part-way through this step can give only what it
        # holds, but the solve sees a fixed-pressure boundary and delivers the
        # whole step's flow past it: on the ethalox stand, 17-25 g that reached
        # the engine and left no vessel. So the step ends where the first tank
        # does. Everything moves that far on these flows, and the rest of the
        # step is solved again with that tank's outlet isolated, as every step
        # after it is. A step on which no tank empties is the step it was.
        span = self._dry_cut(flows, dt)
        if result.converged:
            self._propagate_temperatures(result.pressures, flows, span)

        into, out = crossing(net, flows, self._boundary_nodes())
        self._crossed_in += into * span
        self._crossed_out += out * span
        self._move_vessels(flows, self._held(result), span, substeps)
        if span < dt:
            return self._advance_once(net, given, dt - span, substeps)
        return result

    def _dry_cut(self, flows: Mapping[str, float], dt: float) -> float:
        """How much of a ``dt`` step the tanks can feed these ``flows`` [s].

        ``dt`` unless a tank still feeding would be drained before the step
        ends; then the time at which the first of them is. Only a tank above
        :data:`DRY_MASS` counts: one below it is already isolated
        (:meth:`_dry_branches`), so the remainder of a cut step cannot cut
        again on the same tank.
        """
        span = dt
        for sim in self.tanks.values():
            held = sim.state.liquid_mass
            if held <= DRY_MASS:
                continue
            arriving, leaving = self._split_at(sim.outlet_node, flows)
            if sim.id in self._liquid_fed:
                leaving -= arriving
            if leaving > 0.0 and leaving * span > held:
                span = held / leaving
        return span

    def _note_solve(self, result: SteadyResult) -> None:
        """Count one network solve into this tick's solver record."""
        t = self._tick
        t["solves"] = t.get("solves", 0.0) + 1.0
        t["iterations"] = t.get("iterations", 0.0) + result.iterations
        t["iterations_max"] = max(t.get("iterations_max", 0.0), result.iterations)
        t["residual"] = max(t.get("residual", 0.0), result.residual_norm)
        continuity = max((abs(v) for v in result.mass_residuals.values()), default=0.0)
        t["continuity"] = max(t.get("continuity", 0.0), continuity)
        if not result.converged:
            t["failed"] = t.get("failed", 0.0) + 1.0

    def _boundary_nodes(self) -> frozenset[str]:
        if self._boundary is None:
            vessels = {sim.ullage_node for sim in self.tanks.values()}
            vessels |= {sim.outlet_node for sim in self.tanks.values()}
            vessels |= {b.node for b in self.bottles.values()}
            self._boundary = boundary_nodes(self.model.built.network, vessels)
        return self._boundary

    def inventory(self) -> float:
        """Fluid held in every vessel: liquid, ullage gas, vapour, bottles [kg]."""
        held = sum(
            sim.state.liquid_mass + sim.state.ullage.mass + sim.state.vapour_mass
            for sim in self.tanks.values()
        )
        return held + sum(b.state.mass for b in self.bottles.values())

    def _ledger_totals(self) -> tuple[float, float, float]:
        """``(added, removed, guards)`` the vessels booked themselves [kg]."""
        added = sum(s.added_kg for s in self.tanks.values())
        added += sum(b.added_kg for b in self.bottles.values())
        removed = sum(b.dumped_kg for b in self.bottles.values())
        guards = sum(s.fixed_kg for s in self.tanks.values())
        guards += sum(b.fixed_kg for b in self.bottles.values())
        return added, removed, guards

    def reset_balance(self) -> None:
        """Start the mass balance from the inventory as it stands: after the
        stand is put somewhere directly (prime, a restored frame) rather than
        reached through its boundary."""
        self._crossed_in = self._crossed_out = 0.0
        self._inventory0 = self.inventory()
        self._ledger0 = self._ledger_totals()
        self._guard_J0 = sum(s.fixed_J for s in self.tanks.values())

    def _record_solver(self, couplings: int) -> None:
        """Close this tick's solver record."""
        if self._inventory0 is None:
            self.reset_balance()
        added, removed, guards = self._ledger_totals()
        added -= self._ledger0[0]
        removed -= self._ledger0[1]
        guards -= self._ledger0[2]
        crossed_in = self._crossed_in + added
        crossed_out = self._crossed_out + removed
        held = self.inventory()
        t = self._tick
        self.solver_log.append(
            SolverRecord(
                t=round(self.t, 4),
                couplings=couplings,
                iterations=int(t.get("iterations", 0.0)),
                iterations_max=int(t.get("iterations_max", 0.0)),
                residual=float(t.get("residual", 0.0)),
                continuity=float(t.get("continuity", 0.0)),
                converged=t.get("failed", 0.0) == 0.0,
                chamber_residual_psi=float(t.get("chamber_gap", 0.0)) / PSI,
                inventory_kg=held,
                crossed_in_kg=crossed_in,
                crossed_out_kg=crossed_out,
                mass_error_kg=(held - float(self._inventory0 or 0.0))
                - (crossed_in - crossed_out),
                guard_kg=guards,
                guard_J=sum(s.fixed_J for s in self.tanks.values())
                - getattr(self, "_guard_J0", 0.0),
            )
        )
        self._tick = {}

    def _relief_signals(
        self,
        net: Network,
        signals: Mapping[str, float],
        pressures: Mapping[str, float] | None = None,
    ) -> dict[str, float]:
        """Each relief valve's lift for this coupling step, as signals.

        From the pressure across it: ``pressures`` (a solve made at this step's
        vessel pressures) when given; otherwise a vessel boundary's own pressure
        where the valve's end is one, and the last converged solve's value at
        any other node. A node never yet solved leaves the valve where it was.
        See :mod:`feedtwin.comps.relief`.
        """
        out = dict(signals)
        for branch_id, branch in self._reliefs:
            component = branch.component
            ends = []
            for node_id in (branch.upstream, branch.downstream):
                if pressures is not None:
                    ends.append(pressures.get(node_id))
                    continue
                fixed = net.nodes[node_id].pressure
                value = fixed if fixed is not None else self._guess.get(node_id)
                ends.append(value)
            name = f"{component.id}.lift"
            if ends[0] is not None and ends[1] is not None:
                lift, is_open = component.lift_for(
                    float(ends[0]) - float(ends[1]),
                    self._relief_open.get(branch_id, False),
                )
                self._relief_open[branch_id] = is_open
                self._relief_lift[name] = lift
            out[name] = self._relief_lift.get(name, 0.0)
        return out

    def _accept(self, result: SteadyResult) -> None:
        """Keep a converged solve as the next one's starting point."""
        if not result.converged:
            return
        self._last_flows = dict(result.flows)
        self._last_pressures = dict(result.pressures)
        # Pressures always; flows only where something was actually moving.
        #
        # A state with the whole panel shut solves to flows of exactly zero,
        # and handing those back as the next solve's starting point is the
        # one thing solve_steady's initial guess deliberately avoids: a
        # branch starting at zero flow has a zero derivative, so the first
        # Newton step cannot move it and the solve returns nothing. Going
        # Ready -> Fire did exactly that, and the mains opened onto a
        # network that reported no flow at all.
        self._guess = {
            **result.pressures,
            **{b: f for b, f in result.flows.items() if abs(f) > 1e-9},
        }

    def _solve(
        self,
        net: Network,
        signals: Mapping[str, float],
        isolate: frozenset[str],
        storage: Mapping[str, tuple[float, float]] | None,
    ) -> SteadyResult:
        """The network at this coupling step, warm-started from the last answer.

        A solve with the ullages closed (``storage``) that fails is tried once
        more, from where the same network lands with them held: that solve is
        easy, and it puts Newton beside the answer. A failed solve holds the
        stand (:meth:`_held`), so the next step asks the same question and
        fails the same way, for good. A Fire from unpressed tanks did exactly
        that -- frozen with the chamber at 0 psig, where 384 iterations of the
        same solve converged and 9 + 4 by this route. Only a step that failed
        takes it, so every step that converges is the step it was.
        """
        result = solve_steady(
            net,
            signals=signals,
            tol=self.setup.network_tolerance,
            max_iterations=self.setup.max_iterations,
            raise_on_failure=False,
            guess=self._guess or None,
            isolate=isolate,
            storage=storage,
            report=False,
        )
        if result.converged or not storage:
            return result
        held = solve_steady(
            net,
            signals=signals,
            tol=self.setup.network_tolerance,
            max_iterations=self.setup.max_iterations,
            raise_on_failure=False,
            guess=self._guess or None,
            isolate=isolate,
            report=False,
        )
        if not held.converged:
            return result
        retried = solve_steady(
            net,
            signals=signals,
            tol=self.setup.network_tolerance,
            max_iterations=self.setup.max_iterations,
            raise_on_failure=False,
            guess={
                **held.pressures,
                **{b: f for b, f in held.flows.items() if abs(f) > 1e-9},
            },
            isolate=isolate,
            storage=storage,
            report=False,
        )
        return retried if retried.converged else result

    def _held(self, result: SteadyResult) -> Mapping[str, float]:
        """The node pressures a step acts on and shows.

        The solve's own when it converged. A failed solve's iterate is not a
        pressure field either, so every node it was solving for stays where the
        last converged solve left it; only the boundaries -- vessels,
        atmosphere, the chamber -- are taken as they stand, because the session
        set those itself. Before any solve has converged there is nothing to
        hold and the iterate is all there is.
        """
        if result.converged or not self._last_pressures:
            return result.pressures
        nodes = self.model.built.network.nodes
        return {
            node: (
                value if nodes[node].is_fixed else self._last_pressures.get(node, value)
            )
            for node, value in result.pressures.items()
        }

    def _close_chamber(
        self,
        net: Network,
        signals: Mapping[str, float],
        dry: frozenset[str],
        result: SteadyResult,
        storage: Mapping[str, tuple[float, float]] | None = None,
    ) -> SteadyResult:
        """Find the chamber pressure the network and the engine agree on.

        With the chamber pinned at ``p`` the network delivers some flow; the
        engine turns that flow into a chamber pressure ``g(p)`` through c*
        and the throat. The two agree where ``g(p) = p``. ``g`` falls as ``p``
        rises (a higher chamber takes injector drop away), it is above
        ambient at ambient whenever propellant is arriving, and it is ambient
        at the feed pressure where nothing flows -- so a root is bracketed
        and regula falsi with a bisection guard finds it in a handful of
        solves. A step where the previous answer still holds costs nothing
        extra: the first solve is the one already made.

        Sets ``_chamber_guess``, the chamber node, and ``_last_chamber``.
        """
        ports = self.model.built.engine_ports
        if self.model.chamber is None or "chamber" not in ports:
            self._chamber(self._last_flows)
            self._last_chamber = None
            return result
        node = ports["chamber"]
        model = self.model.chamber

        def into(flows: Mapping[str, float], branch_id: str) -> float:
            if not branch_id:
                return 0.0
            branch = net.branches[branch_id]
            sign = 1.0 if branch.downstream == node else -1.0
            return max(sign * flows.get(branch_id, 0.0), 0.0)

        def equilibrium(flows: Mapping[str, float]) -> ChamberResult:
            return model.evaluate(
                into(flows, ports.get("oxidiser", "")),
                into(flows, ports.get("fuel", "")),
            )

        def mismatch(res: SteadyResult, p: float) -> tuple[ChamberResult, float]:
            flows = res.flows if res.converged else self._last_flows
            eq = equilibrium(flows)
            return eq, max(eq.pressure, AMBIENT) - p

        def solve_at(p: float) -> SteadyResult:
            net.nodes[node].pressure = p
            res = self._solve(net, signals, dry, storage)
            self._note_solve(res)
            self._accept(res)
            return res

        p = max(self._chamber_guess, AMBIENT)
        eq, g = mismatch(result, p)
        tolerance = self.setup.chamber_tolerance_psi * PSI
        if abs(g) > tolerance:
            feed = max(
                [sim.outlet_pressure for sim in self.tanks.values()] + [p, AMBIENT]
            )
            lo, g_lo = (p, g) if g > 0.0 else (AMBIENT, None)
            hi, g_hi = (p, g) if g < 0.0 else (feed, None)
            p_next = min(max(p + g, AMBIENT), feed)
            for _ in range(CHAMBER_ITERATIONS):
                result = solve_at(p_next)
                p = p_next
                eq, g = mismatch(result, p)
                if abs(g) <= tolerance:
                    break
                if g > 0.0:
                    lo, g_lo = p, g
                else:
                    hi, g_hi = p, g
                if g_lo is None or g_hi is None or g_hi == g_lo:
                    p_next = 0.5 * (lo + hi)
                else:
                    p_next = hi - g_hi * (hi - lo) / (g_hi - g_lo)
                    if not lo < p_next < hi:
                        p_next = 0.5 * (lo + hi)
                if hi - lo < tolerance:
                    break
        self._chamber_guess = p
        net.nodes[node].pressure = p
        self._last_chamber = eq
        self._tick["chamber_gap"] = max(self._tick.get("chamber_gap", 0.0), abs(g))
        return result

    def _move_vessels(
        self,
        flows: Mapping[str, float],
        pressures: Mapping[str, float],
        dt: float,
        substeps: int = SUBSTEPS,
    ) -> None:
        """Integrate every vessel over ``dt`` with the flows it is given.

        The ground at rest is left where it is (:attr:`Setup.ground_rests`):
        what :meth:`_rest_ground` took out of the solve, and any cart vessel
        these flows do not touch and no built-in press is acting on."""
        inner = dt / substeps
        resting = set(self._resting[1])
        if self.setup.ground_rests:
            ground = self.ground
            for sim in self.tanks.values():
                if (
                    sim.id in ground
                    and self._split_at(sim.ullage_node, flows) == (0.0, 0.0)
                    and self._split_at(sim.outlet_node, flows) == (0.0, 0.0)
                    and self._supply_press(sim, inner)[0] <= 0.0
                ):
                    resting.add(sim.id)
            for b_id, bottle in self.bottles.items():
                if (
                    b_id in ground
                    and not (bottle.filling or bottle.venting)
                    and self._split_at(bottle.node, flows) == (0.0, 0.0)
                ):
                    resting.add(b_id)
        tanks = [sim for sim in self.tanks.values() if sim.id not in resting]
        bottles = {k: b for k, b in self.bottles.items() if k not in resting}
        vented = {sim.id: self._vent_fraction(sim.ullage_node, flows) for sim in tanks}
        for _ in range(substeps):
            refused = 0.0
            sent: dict[str, float] = {}
            for sim in tanks:
                gas_in, gas_out = self._split_at(sim.ullage_node, flows)
                liquid_in, liquid_out = self._split_at(sim.outlet_node, flows)
                if sim.id not in self._liquid_fed:
                    # Only a tank a cart tank loads takes liquid in; anywhere
                    # else an arrival at an outlet is not propellant (the
                    # chamber pushing back at an abort) and is not credited.
                    liquid_in = 0.0
                # Pressurant leaving for another vessel, not a vent.
                sent[sim.id] = gas_out * (1.0 - vented.get(sim.id, 0.0))
                pressed, target, h_cart = self._supply_press(sim, inner)
                taken = sim.advance(
                    inner,
                    mdot_liquid_out=liquid_out,
                    mdot_gas_in=gas_in + pressed,
                    mdot_gas_out=gas_out,
                    enthalpy_gas_in=(
                        self._pressurant_enthalpy(sim)
                        if pressed <= 0.0
                        else (
                            gas_in * self._pressurant_enthalpy(sim) + pressed * h_cart
                        )
                        / (gas_in + pressed)
                    ),
                    supply_pressure=(
                        target if pressed > 0.0 else self._supply_to(sim, pressures)
                    ),
                    stirring=self.setup.fill_stirring,
                    vent_fraction=vented.get(sim.id, 0.0),
                    mdot_liquid_in=liquid_in,
                    liquid_in_temperature=self._arriving_liquid_T(sim, flows),
                )
                # The stand-in press is refused first: nothing was debited for
                # it. What it did put in came from the cart, off the drawing.
                stand_in_refused = min(taken, pressed)
                sim.added_kg += (pressed - stand_in_refused) * inner
                refused += taken - stand_in_refused
            # Give back what no tank would take. A tank that has caught up with
            # its supply stops taking gas mid-tick, but the solve that debited
            # the bottle happened before that -- so without this the pressurant
            # is simply destroyed, and it is destroyed *most* when the tank sits
            # closest to the regulator, which is exactly the operating point a
            # burn spends all its time at. Helium, whose line losses are small
            # enough to park the tank within a few psi of the outlet, lost half
            # its bottle this way.
            draws = {
                b_id: -self._net_into(bottle.node, flows)
                for b_id, bottle in bottles.items()
            }
            total = sum(d for d in draws.values() if d > 0.0)
            # The bottles take back at most what they gave. The rest of what
            # was refused came from another tank -- two tanks on one press
            # manifold trade gas whenever they differ -- and goes back to it.
            # It used to be handed to the bottle too, whose draw cannot go
            # negative, so it vanished: joined straight to its press valves,
            # LE4's pair destroyed 7 g/s and emptied the COPV in its settle.
            to_bottles = min(refused, total)
            # Gas the solve pushes *into* a bottle whose GSE is not drawn --
            # back through a regulator sitting above lockup, a trickle -- has
            # nowhere to go in a bottle model that only blows down, and was
            # dropped by the clamp on its draw. It goes back to the tanks that
            # sent it, like gas a tank refuses.
            bounced = 0.0
            for b_id, bottle in bottles.items():
                draw = draws[b_id]
                if draw < 0.0 and b_id not in self._drawn_fill:
                    bounced -= draw
                    draw = 0.0
                if b_id in self._drawn_fill and draw < 0.0:
                    # Charged through the drawing: what the network delivers
                    # arrives, priced where it came from.
                    bottle.advance(
                        inner,
                        mdot_out=0.0,
                        mdot_in=-draw,
                        enthalpy_in=self._bottle_inflow_enthalpy(bottle),
                        stirring=self.setup.fill_stirring,
                    )
                    continue
                if to_bottles > 0.0 and total > 0.0 and draw > 0.0:
                    draw -= to_bottles * (draw / total)
                bottle.advance(inner, mdot_out=draw, stirring=self.setup.fill_stirring)
            excess = refused - to_bottles + bounced
            senders = sum(sent.values())
            if excess > 0.0 and senders > 0.0:
                for sim in tanks:
                    sim.take_back(excess * sent[sim.id] / senders * inner)

    def _find_fill_stops(self) -> dict[str, str]:
        """For each tank a cart tank loads: the first valve on the transfer line,
        from the cart's side. Hand or actuated; none if the line has no valve."""
        built = self.model.built
        net = built.network
        owner = {
            branch: sid
            for sid, branches in built.branches_of.items()
            if sid in built.actuators
            for branch in branches
        }
        adjacent: dict[str, list[tuple[str, str]]] = {}
        for branch in net.branches.values():
            adjacent.setdefault(branch.upstream, []).append(
                (branch.downstream, branch.id)
            )
            adjacent.setdefault(branch.downstream, []).append(
                (branch.upstream, branch.id)
            )
        out: dict[str, str] = {}
        for supply, fed in built.supplies.items():
            start = built.tanks[supply].outlet
            parent: dict[str, tuple[str, str]] = {}
            seen = {start}
            frontier = [start]
            targets = {built.tanks[t].outlet: t for t in fed} | {
                built.tanks[t].ullage: t for t in fed
            }
            while frontier:
                here = frontier.pop(0)
                for there, branch_id in adjacent.get(here, ()):
                    if there in seen:
                        continue
                    seen.add(there)
                    parent[there] = (here, branch_id)
                    if there in targets:
                        path: list[str] = []
                        step = there
                        while step != start:
                            step, via = parent[step]
                            path.append(via)
                        valve = next(
                            (owner[b] for b in reversed(path) if b in owner), ""
                        )
                        if valve:
                            out.setdefault(targets[there], valve)
                        self._fill_lines[targets[there]] = self._fill_lines.get(
                            targets[there], frozenset()
                        ) | frozenset(path)
                        continue
                    if net.nodes[there].pressure is not None:
                        continue
                    frontier.append(there)
        return out

    def _loading(self, sim: TankSim) -> bool:
        """The stand is in this tank's fill state ("Fuel Fill", "Ox Fill")."""
        name = self.state.lower()
        side = propellant_side(sim.tank.liquid.name)
        words = ("ox", "lox") if side == "lox" else ("fuel", "eth")
        return "fill" in name and any(w in name for w in words)

    def _stop_full_loads(self) -> None:
        """The crew's hand on a drawn load's transfer valve.

        Shut until the tank's fill state ("Fuel Fill") is selected, opened for
        the load, shut again once the tank holds it -- as the built-in load
        stops at its full fraction. A transfer valve left at rest is open (it is
        plumbed both sides), and a cart tank above the flight tank then siphons
        into it before anyone has started the fill. Acts only when what the
        crew would do changes, so a hand on the P&ID in between is kept.
        """
        labels = {n.id: n.label or n.id for n in self.model.diagram.nodes}
        for tank_id, valve in self._fill_stops.items():
            sim = self.tanks[tank_id]
            sim.full_fraction = self.setup.full_fraction
            sim.load_kg = self.fire_loads().get(tank_id, 0.0)
            full = sim.state.liquid_mass >= sim._wanted()
            wanted = self._loading(sim) and not full
            if self._fill_crew.get(valve) == wanted:
                continue
            self._fill_crew[valve] = wanted
            self.forced[valve] = 1.0 if wanted else 0.0
            if full and tank_id not in self._fill_stopped:
                self._fill_stopped.add(tank_id)
                self.assumptions.append(
                    f"{sim.label} holds its load ({sim.state.liquid_mass:.2f} kg): "
                    f"{labels.get(valve, valve)} "
                    "shut, as the crew shuts the fill."
                )
            note = (
                f"{labels.get(valve, valve)} is the crew's: shut until "
                f"{sim.label}'s fill state, opened for the load, shut at it."
            )
            if note not in self.assumptions:
                self.assumptions.append(note)

    def _supply_press(
        self, sim: TankSim, dt: float = 0.0
    ) -> tuple[float, float, float]:
        """The cart's press on a ground supply tank whose press line is not
        drawn: ``(rate [kg/s], target [Pa], arriving enthalpy [J/kg])``.

        A fuel transfer tank is pressed to the pressure its drawing gives while
        the table holds its press actuator ("Fuel Fill Press") open. When a
        valve on the drawing is bound to that actuator, the network presses it
        and this is zero; so is it for every tank that is not the cart's.
        """
        if sim.id not in self.model.built.supplies:
            return 0.0, 0.0, 0.0
        node = sim.node
        drawn = getattr(node, "params", {}).get("pressure") if node else None
        if drawn is None:
            return 0.0, 0.0, 0.0
        side = propellant_side(sim.tank.liquid.name)
        if getattr(node, "drawn_as", "") == "DEWAR":
            # A dewar's pressure-building circuit holds it whatever the table
            # says: it is the dewar's own, not a valve on the stand.
            pressing = ["its pressure-building circuit"]
        else:
            opened = self.machine.open_actuators(self.state)
            pressing = [
                a
                for a in opened
                if {"fill", "press"} <= _words(a)
                and side in _words(a)
                and a not in self.binding.to_symbol
            ]
        if not pressing:
            return 0.0, 0.0, 0.0
        target = float(drawn.si)
        now = sim.pressure
        held = sim.state.ullage.mass + sim.state.vapour_mass
        if now >= target or held <= 0.0:
            return 0.0, target, 0.0
        wanted = held * (target / max(now, 1.0) - 1.0)
        # A dewar's circuit is a regulator: it makes up the deficit as it opens
        # (the vessel refuses what would carry it past). The cart's press line
        # on a transfer tank takes its time.
        span = dt if getattr(node, "drawn_as", "") == "DEWAR" and dt > 0.0 else 0.0
        rate = wanted / max(span or self.setup.supply_press_s, 1e-3)
        h_cart = float(sim.tank.gas.get("h", p=target, T=self.setup.fill_supply_T))
        note = (
            f"{sim.label} is held at its drawn {psig(target):.0f} psig by "
            f"{pressing[0]} (not on the drawing; Setup supply_press_s "
            f"{self.setup.supply_press_s:g} s)."
            if pressing[0].startswith("its ")
            else f"{sim.label} is pressed to its drawn {psig(target):.0f} psig while "
            f"{pressing[0]} is open, by the cart's press line (not on the "
            f"drawing; Setup supply_press_s {self.setup.supply_press_s:g} s)."
        )
        if note not in self.assumptions:
            self.assumptions.append(note)
        return rate, target, h_cart

    def _arriving_liquid_T(
        self, sim: TankSim, flows: Mapping[str, float]
    ) -> float | None:
        """Mass-weighted temperature of what arrives at a tank's outlet [K]."""
        net = self.model.built.network
        total = weighted = 0.0
        for branch_id, branch in net.branches.items():
            flow = flows.get(branch_id, 0.0)
            if branch.downstream == sim.outlet_node and flow > 0.0:
                source = branch.upstream
            elif branch.upstream == sim.outlet_node and flow < 0.0:
                source = branch.downstream
            else:
                continue
            total += abs(flow)
            weighted += abs(flow) * net.nodes[source].temperature
        return weighted / total if total > 0.0 else None

    def _venting(self, node: str, flows: Mapping[str, float]) -> bool:
        """More of the gas at ``node`` leaves for the sky than arrives or is
        sent on to another vessel."""
        gas_in, gas_out = self._split_at(node, flows)
        if gas_out <= gas_in:
            return False
        vented = gas_out * self._vent_fraction(node, flows)
        return vented > gas_in + (gas_out - vented)

    def _vent_fraction(self, node: str, flows: Mapping[str, float]) -> float:
        """Share of the gas leaving ``node`` that ends at a vent, 0..1.

        Follow the flow out of the node through the network, splitting at
        each junction in proportion to what leaves it, until it reaches a
        fixed-pressure boundary that is not a vessel (a vent to atmosphere:
        counted), another vessel (not counted -- it will be back), or a dead
        end (not counted). Species do not exist in the network, so this is
        the only way a tank can know whether the vapour it let go is gone.
        """
        net = self.model.built.network
        vessels = {sim.ullage_node for sim in self.tanks.values()}
        vessels |= {sim.outlet_node for sim in self.tanks.values()}
        vessels |= {b.node for b in self.bottles.values()}

        def outgoing(here: str) -> list[tuple[float, str]]:
            out: list[tuple[float, str]] = []
            for branch in net.branches.values():
                flow = flows.get(branch.id, 0.0)
                if branch.upstream == here and flow > 0.0:
                    out.append((flow, branch.downstream))
                elif branch.downstream == here and flow < 0.0:
                    out.append((-flow, branch.upstream))
            return out

        vented = 0.0
        frontier: list[tuple[str, float]] = [(node, 1.0)]
        hops = 0
        while frontier and hops < 200:
            here, weight = frontier.pop()
            hops += 1
            outs = outgoing(here)
            total = sum(flow for flow, _ in outs)
            if total <= 0.0:
                continue
            for flow, far in outs:
                share = weight * flow / total
                if far in vessels:
                    continue
                if net.nodes[far].pressure is not None:
                    vented += share
                else:
                    frontier.append((far, share))
        return min(vented, 1.0)

    def _apply_vessel_pressures(self) -> None:
        net = self.model.built.network
        for sim in self.tanks.values():
            net.nodes[sim.ullage_node].pressure = sim.pressure
            net.nodes[sim.outlet_node].pressure = sim.outlet_pressure
        for bottle in self.bottles.values():
            net.nodes[bottle.node].pressure = bottle.pressure
        # A fill valve's free port is the tanker's hose, not the air. The
        # drawing infers a vent from any valve plumbed at one end, so with
        # LOX Fill open the tank drained a few hundred grams a second *out*
        # through its own fill valve while the commanded fill put liquid in.
        # Until the tanker is on the drawing the hose sits at the tank's own
        # pressure, so nothing moves through it either way; the fill itself
        # is the commanded rate.
        for stub, vessel_node in self._fill_stubs.items():
            net.nodes[stub].pressure = net.nodes[vessel_node].pressure

    def _find_fill_stubs(self) -> dict[str, str]:
        """Free boundary node of each fill valve -> the vessel node it feeds."""
        net = self.model.built.network
        vessel_nodes = {sim.outlet_node for sim in self.tanks.values()}
        vessel_nodes |= {sim.ullage_node for sim in self.tanks.values()}
        vessel_nodes |= {b.node for b in self.bottles.values()}
        out: dict[str, str] = {}
        for actuator, symbol in self.binding.to_symbol.items():
            if "fill" not in actuator.lower() or symbol not in net.branches:
                continue
            valve = net.branches[symbol]
            ends = (valve.upstream, valve.downstream)
            stubs = [
                n
                for n in ends
                if net.nodes[n].pressure is not None and n not in vessel_nodes
            ]
            if len(stubs) != 1:
                continue
            stub = stubs[0]
            # Walk from the other end to the first vessel node.
            frontier = [n for n in ends if n != stub]
            seen = set(frontier) | {stub}
            found = ""
            while frontier and not found:
                here = frontier.pop()
                if here in vessel_nodes:
                    found = here
                    break
                for branch in net.branches.values():
                    if branch.id == symbol:
                        continue
                    for a, b in (
                        (branch.upstream, branch.downstream),
                        (branch.downstream, branch.upstream),
                    ):
                        if a == here and b not in seen:
                            seen.add(b)
                            frontier.append(b)
            if found:
                out[stub] = found
        return out

    def _leaking_notes(self) -> list[str]:
        """Where a vehicle tank's propellant is going, when it is not the engine.

        On LE4 the cart's FD-ROT-G -- a dump nothing in the state table
        commands, resting open as drawn -- emptied the flight fuel tank through
        its fill line in about ten seconds after T-0, and nothing on screen said
        where the fuel went (2026-10-09). This names the way out: each branch
        carrying that propellant across the stand's boundary, and whether the
        state table drives it. Read off the last solve; changes nothing.
        """
        if self._firing():
            return []
        net = self.model.built.network
        boundary = self._boundary_nodes()
        owner = {b: sid for sid, bs in self.model.built.branches_of.items() for b in bs}
        labels = {n.id: n.label or n.id for n in self.model.diagram.nodes}
        commanded = set(self.binding.to_symbol.values())
        ground = self.ground
        notes: list[str] = []
        for sim in self.tanks.values():
            if sim.id in ground or sim.empty or sim.filling:
                continue
            arriving, leaving = self._split_at(sim.outlet_node, self._last_flows)
            rate = leaving - arriving
            if rate < LEAK_NOTE_KG_S:
                continue
            species = net.nodes[sim.outlet_node].fluid
            exits: list[str] = []
            for branch_id, branch in net.branches.items():
                flow = self._last_flows.get(branch_id, 0.0)
                if branch.downstream in boundary and branch.upstream not in boundary:
                    inside, out_flow = branch.upstream, flow
                elif branch.upstream in boundary and branch.downstream not in boundary:
                    inside, out_flow = branch.downstream, -flow
                else:
                    continue
                if out_flow < LEAK_NOTE_KG_S or net.nodes[inside].fluid != species:
                    continue
                symbol = owner.get(branch_id, branch_id)
                name = labels.get(symbol, symbol)
                if symbol not in commanded:
                    name += " (nothing in the state table commands it)"
                if name not in exits:
                    exits.append(name)
            where = f": out through {', '.join(exits)}" if exits else ""
            notes.append(
                f"{sim.label} is losing {species} at {rate:.2f} kg/s with the "
                f"engine cold{where}."
            )
        return notes

    def _split_at(self, node: str, flows: Mapping[str, float]) -> tuple[float, float]:
        """Mass arriving at and leaving a node [kg/s], kept apart.

        A tank being filled has pressurant coming in one port and vent gas going
        out another at the same time. Netting them loses the energy difference,
        and the sign of the net says nothing about either.
        """
        net = self.model.built.network
        arriving = leaving = 0.0
        for branch_id, branch in net.branches.items():
            flow = flows.get(branch_id, 0.0)
            if branch.downstream == node:
                signed = flow
            elif branch.upstream == node:
                signed = -flow
            else:
                continue
            if signed >= 0.0:
                arriving += signed
            else:
                leaving += -signed
        return arriving, leaving

    def _net_into(self, node: str, flows: Mapping[str, float]) -> float:
        arriving, leaving = self._split_at(node, flows)
        return arriving - leaving

    def step(self, dt: float) -> Sample:
        """What the operator sees ``dt`` seconds later.

        Integrated now, Fire included, as a run of :attr:`Setup.live_step`
        steps -- the Study's grid, with nothing folded to save wall clock. A
        stand too stiff for real time runs in slow motion rather than on a
        coarser scheme (docs/PHYSICS-BENCHMARK.md 3.10). A tripped stand holds
        the frame it tripped on.
        """
        if self.tripped:
            # The stand has failed. Nothing moves until it is reset; the
            # frame on display is the one it failed on.
            if self._shown is None:
                self._shown = self._integrate(1e-4)
            return self._shown
        # A panel tick is a run of study-sized steps, so the console and the
        # Study tab integrate on the same grid.
        dt = max(min(dt, MAX_STEP), 1e-4)
        steps = max(int(round(dt / self.setup.live_step)), 1)
        inner = dt / steps
        for _ in range(steps):
            self._shown = self._integrate(inner)
            if self.tripped:
                break
        # `steps` is clamped to at least 1, so the loop above always assigned a
        # frame -- including on the tick that trips the stand, which breaks
        # after the assignment, not before.
        assert self._shown is not None
        return self._shown

    def _integrate(self, dt: float) -> Sample:
        """Advance the stand by ``dt`` seconds and return where it is."""
        dt = max(min(dt, MAX_STEP), 1e-4)
        self._tick = {}
        self._stop_full_loads()
        signals = self.signals(dt)
        net = self.model.built.network
        net.gravity = self.setup.body_acceleration

        loads = self.fire_loads()
        for sim in self.tanks.values():
            sim.filling = self._fills(sim) and sim.id not in self._drawn_fill
            sim.full_fraction = self.setup.full_fraction
            sim.load_kg = loads.get(sim.id, 0.0)
            sim.charge_gamma = self.setup.charge_gamma
            sim.supply_band = self.setup.supply_band
            sim.stir_band = self.setup.stir_band
            sim.gravity = self.setup.body_acceleration
            # A dewar transfer that has to chill the wall, or a pour.
            cryogen = sim.state.liquid_temperature < CRYOGENIC_K
            sim.fill_seconds = (
                self.setup.tank_fill_s if cryogen else self.setup.fuel_fill_s
            )
            sim.chill_seconds = self.setup.load_chill_s
            sim.dewar_pressure = (
                from_psig(self.setup.dewar_psi) if self.setup.dewar_psi > 0.0 else 0.0
            )
            sim.fill_line_bore = self.setup.dewar_line_bore_mm * 1e-3
            sim.fill_line_length = self.setup.dewar_line_length_m
            sim.fill_cv = self.setup.dewar_fill_cv
        # The cart's vent valve, on every GSE vent the drawing does not size.
        for branch in self.model.built.gse_vents:
            net.branches[branch].component.p["Cv"] = self.setup.gse_vent_cv
        # The GSE side of the bottle is not on the drawing, so its fill and
        # vent are the table's own GSE actuators, read as the DAQ reads them:
        # `GSE High Press Control` charges it (GN2 High Press), `GSE High
        # Press Vent` dumps it (GSE Abort, Emergency Abort). GN2 High Vent
        # opens `GN2 Vent`, which is on the drawing -- the regulated manifold
        # -- and the network vents exactly what that valve reaches. It used
        # to match on the state's name and drain the bottle in GN2 High Vent
        # through a valve the table never opens there.
        opened = self.machine.open_actuators(self.state)
        ground = self.ground
        for bottle in self.bottles.values():
            # A bottle the drawing charges (the cart drawn on its GSE page) is
            # filled and dumped by the network, through the valves drawn there.
            # A cart's own vessel (its K-bottles, its dewar) is the supply, and
            # the built-in charge stands in for the vehicle's alone: it once
            # "charged" a LOX dewar to the COPV target as if it were gas.
            off_drawing = bottle.id not in self._drawn_fill and bottle.id not in ground
            bottle.filling = off_drawing and GSE_CHARGE in opened
            bottle.fill_supply_T = self.setup.fill_supply_T
            bottle.venting = off_drawing and GSE_DUMP in opened
            bottle.target = from_psig(self.setup.copv_target_psi)
            bottle.fill_seconds = self.setup.copv_fill_s

        self._rest_ground(signals)
        resting = self._resting[1]

        # How many times to re-solve inside this tick. Chosen from how fast the
        # vessels moved last time: quiet states cost one solve, a press
        # transient costs a handful, and nothing else has to know.
        coupling = 1
        if self._last_change > 0.0:
            coupling = (
                int(
                    self._last_change
                    * dt
                    / self._last_dt
                    / self.setup.max_coupled_change
                )
                + 1
            )
        # ...and never coarser than the regulator-ullage time constant allows.
        # The change-based rule above reacts to motion it has already seen; the
        # time constant says how fast the loop *can* move, before it does.
        tau = self._coupling_timescale(signals, dt, press=False)
        if tau > 0.0:
            coupling = max(coupling, int(dt / (self.setup.coupling_safety * tau)) + 1)
        # ...and never let one coupling step move more than MAX_COUPLED_CHANGE
        # of an ullage's mass. The RC estimate uses the regulator's droop
        # slope, which is the loop's stiffness *near lockup*; wide open, a
        # Cv 0.8 regulator passes half a kilogram a second into a fuel ullage
        # of 0.43 L holding twenty grams -- a third of the ullage in one 14 ms
        # step -- and the tank overshot lockup by 43 psi on the step that
        # crossed it. Sized from the flows the last solve produced, so it
        # sees the press coming rather than reacting to it.
        #
        # Gas a tank vents to atmosphere is not counted. A vent ends at a
        # fixed pressure, and the solve closes the ullage against it
        # implicitly (`_ullage_storage`), so it needs no finer coupling. A LOX
        # tank topped to its load in Ox Fill passes ~20 g/s of boil-off
        # through a 0.45 g ullage to its vent; counted, it asked for nine
        # solves of the whole stand every 20 ms and the fill ran at a third
        # of real time.
        for sim in self.tanks.values():
            if sim.id in resting:
                continue
            gas_in, gas_out = self._split_at(sim.ullage_node, self._last_flows)
            if gas_out > gas_in:
                gas_out *= 1.0 - self._vent_fraction(sim.ullage_node, self._last_flows)
            rate = max(gas_in, gas_out)
            inventory = sim.state.ullage.mass
            if rate > 0.0 and inventory > 0.0:
                coupling = max(
                    coupling,
                    int(dt * rate / (inventory * self.setup.max_mass_step)) + 1,
                )
        coupling = min(coupling, MAX_COUPLING_STEPS)
        # ...and the press path's own constant (`_press_path_timescale`), last
        # and apart. It is about how often the network is re-solved, not about
        # how finely the vessels integrate: those were already stepped as
        # finely as the rules above ask. So the extra solves it adds take
        # fewer vessel sub-steps each, and every vessel step stays exactly as
        # fine as it would have been without it. Four sub-steps of each of
        # nine couplings had taken a guarded helium burn to 0.6 ms vessel steps
        # and spent most of the tick on them. (Thinning the sub-steps of
        # couplings the mass rule asked for instead moved the chamber
        # benchmark by 13 psi: those are the vessels' own stiffness.)
        vessel_couplings = coupling
        press_tau = self._coupling_timescale(signals, dt)
        if 0.0 < press_tau < tau or (tau <= 0.0 and press_tau > 0.0):
            coupling = max(
                coupling, int(dt / (self.setup.coupling_safety * press_tau)) + 1
            )
            coupling = min(coupling, MAX_COUPLING_STEPS)
        inner_dt = dt / coupling
        substeps = max(1, -(-SUBSTEPS * vessel_couplings // coupling))
        before = self._vessel_pressures()

        result = None
        started = time.monotonic()
        couplings_done = 0
        for index in range(coupling):
            remaining = coupling - index
            couplings_done += 1
            # Out of time: fold what is left of the tick into one last step
            # rather than stalling the cockpit for the rest of the budget.
            if index and time.monotonic() - started > self.setup.tick_budget:
                result = self._advance_once(
                    net, signals, inner_dt * remaining, substeps
                )
                break
            result = self._advance_once(net, signals, inner_dt, substeps)

        assert result is not None
        chamber = self._last_chamber
        after = self._vessel_pressures()
        self._last_change = max(
            (abs(after[k] - before[k]) / max(before[k], 1.0) for k in before),
            default=0.0,
        )
        self._last_dt = max(dt, 1e-6)

        # Only *stub* nodes get the held value. A vessel boundary is never
        # trapped -- its pressure comes from the vessel, not from the solve --
        # and freezing one would nail a tank's transducer to whatever it read
        # the first time a neighbouring branch went quiet.
        vessels = {sim.ullage_node for sim in self.tanks.values()}
        vessels |= {sim.outlet_node for sim in self.tanks.values()}
        vessels |= {b.node for b in self.bottles.values()}
        held = set(result.indeterminate_nodes) - vessels

        # A failed solve shows, and leaves as the trapped value, what the last
        # converged one found -- not the iterate it stopped on.
        solved = self._held(result)
        pressures = dict(solved)
        for node in held:
            pressures[node] = self._trapped.get(node, AMBIENT)
        pressures.update(self._dome_readings)
        for node, value in solved.items():
            if node not in held:
                self._trapped[node] = value
        self.t += dt
        self._check_limits()
        self._burnout_check()
        self._record_solver(couplings_done)
        sample = Sample(
            t=round(self.t, 4),
            state=self.state,
            pressures=pressures,
            temperatures={
                node_id: node.temperature
                for node_id, node in self.model.built.network.nodes.items()
            },
            flows=dict(self._last_flows),
            # A relief's lift is decided per coupling step, inside the solve
            # loop; the frame shows where the last one left it.
            signals={**signals, **self._relief_lift} if self._relief_lift else signals,
            converged=result.converged,
            tanks={sim.id: sim.readouts() for sim in self.tanks.values()},
            chamber=chamber,
            balance=None,
            notes=tuple(self._notes()),
        )
        self.history.append(sample)
        return sample

    def _supply_to(self, sim: TankSim, pressures: Mapping[str, float]) -> float:
        """Pressure of whatever is feeding this ullage [Pa], or zero.

        The highest upstream node across a branch carrying gas *into* the
        ullage. Zero when nothing is, which leaves the vessel unclamped.
        """
        net = self.model.built.network
        best = 0.0
        for branch in net.branches.values():
            if branch.downstream != sim.ullage_node:
                continue
            upstream = pressures.get(branch.upstream)
            if upstream is not None:
                best = max(best, upstream)
        return best

    def _pressurant_enthalpy(self, sim: TankSim) -> float:
        """Enthalpy of the gas arriving at this ullage [J/kg].

        **A regulator is a throttle, so enthalpy is what carries across it**, not
        temperature and not entropy. The gas that reaches the tank has the
        specific enthalpy it had in the bottle; its *temperature* is then
        whatever that enthalpy corresponds to at the delivery pressure, and that
        is a real-gas question with an answer that reverses between fluids.

        Nitrogen at room temperature sits above its Joule-Thomson inversion
        curve, so throttling from 4500 psi to 500 cools it about thirty kelvin.
        Helium's inversion temperature is around forty-five kelvin, far below
        anything on a pad, so the same expansion *warms* it about seventeen. A
        tank being pressed with helium therefore receives gas nearly fifty
        kelvin warmer than the same tank on nitrogen -- which is most of why the
        two behave so differently out of a small bottle.

        Assuming a fixed delivery temperature, as this used to, erases that
        entirely: both gases arrive at 293 K and the only thing left telling
        them apart is molar mass.
        """
        # What actually reached this ullage's node this tick, mass-weighted
        # over every branch feeding it. The walk carries enthalpy from
        # whichever node the gas *came from* -- the bottle through the
        # regulator, or the other tank through the shared press manifold --
        # and adds the line-wall pickup when that model is on.
        #
        # This used to read the walk only with the line walls on and quote the
        # bottle otherwise, on the argument that an adiabatic path conserves
        # enthalpy so the two agree. They agree only for gas that came *from
        # the bottle*. Two primed tanks sitting on one press manifold at the
        # same pressure trade gas back and forth every step, and gas arriving
        # from the fuel tank's 293 K ullage was priced at the bottle's
        # enthalpy: helium's is higher at 4500 psi than at 550 (it warms
        # through a throttle), so every exchange pumped energy into both
        # ullages and the pair warmed six kelvin and rose fifteen psi above
        # lockup with nothing flowing through the regulator. Nitrogen ran the
        # same error the other way and cooled.
        arrived = self.arriving_enthalpy.get(sim.ullage_node)
        if arrived is not None:
            return float(arrived)

        # Nothing walked to this node this tick (no flow above the walk's
        # floor, or a property gap): fall back to the bottle it hangs off.
        supply = self._bottle_for(sim)
        if supply is not None:
            try:
                return float(supply.volume.enthalpy(supply.state))
            except Exception:  # noqa: BLE001 - a property gap must not stop a tick
                pass
        try:
            return float(
                sim.tank.gas.get("h", p=from_psig(self.setup.dome_psi), T=293.15)
            )
        except Exception:  # noqa: BLE001 - a property gap must not stop a tick
            return 0.0

    def _bottle_inflow_enthalpy(self, bottle: BottleSim) -> float:
        """Specific enthalpy of gas the drawing delivers into a bottle [J/kg]:
        the walk's arrival at its node, else cart gas at the fill temperature."""
        arrived = self.arriving_enthalpy.get(bottle.node)
        if arrived is not None:
            return float(arrived)
        return float(
            bottle.volume.fluid.get(
                "h", p=max(bottle.pressure, AMBIENT), T=self.setup.fill_supply_T
            )
        )

    def _bottle_for(self, sim: TankSim) -> BottleSim | None:
        """The bottle feeding this ullage, if one is reachable.

        Matched on species rather than walked: a stand has one pressurant, and a
        walk would have to cross the regulator's dome branch to find it.
        """
        wanted = sim.tank.gas.name
        # The vehicle's own bottle first: the cart's K-bottles hold the same
        # gas and are not what presses a flight tank.
        ground = self.ground
        ordered = sorted(self.bottles.values(), key=lambda b: b.id in ground)
        for bottle in ordered:
            if bottle.volume.fluid.name == wanted:
                return bottle
        return next(iter(ordered), None)

    def _fills(self, sim: TankSim) -> bool:
        """Whether the current state is filling this tank. Never a cart's tank:
        that is where a load comes from, pre-loaded.

        Matched on the state's name against the tank's fluid, because fill comes
        from a tanker that is not on the drawing -- see FILL_RATE.
        """
        name = self.state.lower()
        if "fill" not in name or sim.id in self.ground:
            return False
        net = self.model.built.network
        species = net.nodes[sim.outlet_node].fluid
        if species == "oxygen":
            return "ox" in name or "lox" in name
        return "fuel" in name or "eth" in name

    def _build_line_walls(self) -> None:
        """One lumped wall per line, started at the temperature its line holds.

        This is the whole of the "soak" question, answered without a soak model.
        A wall left to sit converges on the temperature of the fluid inside it,
        so that is where it starts -- and it falls out per line for free:

        * a line full of liquid oxygen has been sitting near 90 K, so its
          fittings are cold and have little heat to give;
        * the ullage side above that tank holds cold vapour, cooler than the room
          and nowhere near the liquid;
        * a pressurant line that has only ever seen ambient gas is at ambient,
          and is the one with real heat in it.

        Three very different wall temperatures, none of them assumed. Tracking
        how a stand drifts while it sits would need an ambient boundary, an
        insulation state and an hours-long clock on every line, and would land
        in the same place this does.
        """
        self.walls: dict[str, LineWall] = {}
        self.wall_temperature: dict[str, float] = {}
        #: Specific enthalpy the walk delivered to each node this tick [J/kg].
        #: Read by `_pressurant_enthalpy` so a tank is fed what actually reached
        #: it rather than what left the bottle.
        self.arriving_enthalpy: dict[str, float] = {}
        net = self.model.built.network
        for branch_id, branch in net.branches.items():
            component = branch.component
            bore = component.p.get("bore", 0.0)
            length = component.p.get("length", 0.0)
            # One weighed figure for the whole run beats every estimate below.
            weighed = component.p.get("line_mass", 0.0)
            if weighed > 0.0 and bore > 0.0:
                self.walls[branch_id] = LineWall(
                    mass=weighed, area=math.pi * bore * max(length, bore), bore=bore
                )
                continue
            thickness = component.p.get("wall_thickness", 0.0)
            fittings = component.p.get("fitting_mass", 0.0)
            if fittings <= 0.0:
                # No weighed figure, so fall back to what the user counted.
                # Mass wins when both are given: somebody who went and weighed
                # the run has better information than a bore-scaled estimate.
                fittings = fitting_metal(component.p.get("fitting_count", 0.0), bore)
            if bore <= 0.0:
                continue
            tube = 0.0
            if thickness > 0.0 and length > 0.0:
                outer = bore + 2.0 * thickness
                tube = math.pi / 4.0 * (outer**2 - bore**2) * length * STAINLESS_DENSITY
            mass = tube + fittings
            if mass <= 0.0:
                continue
            self.walls[branch_id] = LineWall(
                mass=mass, area=math.pi * bore * max(length, bore), bore=bore
            )
        # Temperatures are *not* set here. At build time a node still carries
        # whatever the drawing declared, so seeding the metal now would put the
        # line off a LOX ullage at liquid temperature rather than vapour
        # temperature. `_propagate_temperatures` seeds each wall on the first
        # tick it has settled node temperatures to seed it from, which costs one
        # tick of no wall heat and gets the three tiers -- liquid, ullage
        # vapour, ambient pressurant -- right without a soak model.

    def _propagate_temperatures(
        self,
        pressures: Mapping[str, float],
        flows: Mapping[str, float],
        dt: float = 0.0,
    ) -> None:
        """Carry enthalpy along the flow path, so every node has a real temperature.

        Node temperatures were set once at build time and never written again.
        The vessel models track cooling carefully -- a LOX ullage at 268.7 K
        where the drawing said 293.15 -- and the network then metered gas out of
        that node at the temperature it was born with. A 24.5 K error is about
        9% on density and 4.5% on the flow through it, and it grew through a
        burn, so it was a drifting error rather than a constant one.

        **Enthalpy, not temperature, is what propagates.** Every component here
        is adiabatic, and an adiabatic component with no shaft work conserves
        enthalpy -- which is exactly the argument this codebase already makes for
        the regulator, and the reason nitrogen cools ~30 K through it while
        helium warms ~17 K. Carrying ``h`` and re-solving ``T(h, p)`` at each
        node's own pressure therefore gets Joule-Thomson right at *every*
        throttle for free, rather than special-casing the one we thought about.

        What it does not model: heat into the line walls, and viscous heating.
        Both are small against a five-second burn and neither is free to add --
        a wall needs its own thermal state per line.

        Lagged by one tick, deliberately. This runs *after* the solve and
        annotates the network, so it cannot perturb the Newton iteration; the
        next tick's solve picks up the new temperatures. Same arrangement as the
        chamber boundary, and for the same reason.
        """
        net = self.model.built.network
        # Cleared, not carried: a node that stops being fed this tick must fall
        # back to the bottle rather than keep quoting last tick's arrival.
        self.arriving_enthalpy.clear()
        known: dict[str, float] = {}
        #: Heat each line gave its stream this pass, and the stream's inlet
        #: temperature, so the repay step knows what the wall is relaxing
        #: toward and cannot step past it. [(W, K)]
        heat_drawn: dict[str, tuple[float, float]] = {}

        # Seeds: anything whose temperature is a state we already integrate.
        for sim in self.tanks.values():
            known[sim.ullage_node] = sim.tank.gas_temperature(sim.state)
            known[sim.outlet_node] = sim.state.liquid_temperature
        for bottle in self.bottles.values():
            known[bottle.node] = bottle.volume.temperature(bottle.state)

        for node_id, temperature in known.items():
            node = net.nodes.get(node_id)
            if node is not None and temperature > 0.0:
                node.temperature = temperature

        # Then walk outwards along the flow, mass-weighting the arrivals. A few
        # sweeps is plenty for a stand -- the longest path from a bottle to the
        # injector face is under a dozen branches -- and bounding it keeps a
        # recirculating drawing from spinning here.
        # Which lines feed each node, in branch order. The flows are fixed for
        # the whole walk, so this is worked out once rather than by asking
        # every line on the stand about every node on every sweep.
        feeding: dict[str, list[tuple[str, float, str]]] = {}
        for branch_id, branch in net.branches.items():
            mdot = flows.get(branch_id, 0.0)
            if abs(mdot) < _TEMPERATURE_MIN_FLOW:
                continue
            source = branch.upstream if mdot > 0.0 else branch.downstream
            sink = branch.downstream if mdot > 0.0 else branch.upstream
            if source not in net.nodes:
                continue
            feeding.setdefault(sink, []).append((branch_id, mdot, source))

        for _ in range(_TEMPERATURE_SWEEPS):
            settled = True
            for node_id, node in net.nodes.items():
                pinned = node_id in known
                arriving: list[tuple[float, float]] = []
                for branch_id, mdot, source in feeding.get(node_id, ()):
                    upstream = net.nodes[source]
                    p_up = pressures.get(source)
                    if p_up is None or p_up <= 0.0:
                        continue
                    try:
                        # The network's own instance: a fresh Fluid builds fresh
                        # CoolProp states, and doing that per branch per sweep was
                        # a third of a burning tick.
                        fluid = net.fluid(upstream.fluid)
                        T_in = upstream.temperature
                        h = fluid.get("h", p=p_up, T=T_in)
                        # The line's own metal, if it has any and the run wants
                        # it. Enthalpy is still what propagates; this adds the
                        # heat the wall gave the stream on the way through, so
                        # Joule-Thomson and wall pickup compose rather than
                        # compete for the same term.
                        wall = self.walls.get(branch_id)
                        seeded = self.wall_temperature.get(branch_id)
                        if (
                            wall is not None
                            and seeded is not None
                            and self.setup.line_walls
                        ):
                            exchange = wall.exchange(
                                mdot=mdot,
                                wall_temperature=seeded,
                                inlet_temperature=T_in,
                                density=fluid.get("rho", p=p_up, T=T_in),
                                viscosity=fluid.get("mu", p=p_up, T=T_in),
                                conductivity=fluid.get("k", p=p_up, T=T_in),
                                heat_capacity=fluid.get("cp", p=p_up, T=T_in),
                            )
                            h += exchange.heat / max(abs(mdot), 1e-12)
                            heat_drawn[branch_id] = (exchange.heat, T_in)
                    except (ValueError, PropertyError):
                        continue
                    arriving.append((abs(mdot), h))
                if not arriving:
                    continue
                total = sum(mdot for mdot, _ in arriving)
                if total <= 0.0:
                    continue
                enthalpy = sum(mdot * h for mdot, h in arriving) / total
                self.arriving_enthalpy[node_id] = enthalpy
                if pinned:
                    # A vessel node's temperature is a state this session
                    # integrates; the walk may not overwrite it. What arrives
                    # there is still worth keeping -- it is what the tank is
                    # being fed, wall pickup and all, and `_pressurant_enthalpy`
                    # reads it.
                    continue
                p_here = pressures.get(node_id)
                if p_here is None or p_here <= 0.0:
                    continue
                try:
                    # h is conserved across the component; T falls out of the
                    # equation of state at this node's own pressure. That step
                    # is the Joule-Thomson effect.
                    landed = net.fluid(node.fluid).get("T", p=p_here, h=enthalpy)
                except (ValueError, PropertyError):
                    continue
                if landed > 0.0 and abs(landed - node.temperature) > _TEMPERATURE_TOL:
                    node.temperature = landed
                    settled = False
            if settled:
                break

        # Metal that has not been given a temperature yet takes the one the
        # fluid standing in it has, now that the walk has settled and the node
        # temperatures are real rather than whatever the drawing was built with.
        #
        # This is the whole of the "what temperature is the metal at?" model,
        # and it is deliberately this small. A LOX line is seeded at LOX
        # temperature, a line off the ullage at the ullage's, a pressurant line
        # at the bottle's -- because that is the fluid sitting in each at rest.
        # What it does *not* do is track how a stand cools while it sits: that
        # would need a soak model, an ambient film on every line, and a history
        # of how long the vehicle has been loaded, to predict a starting
        # temperature that the fluid inventory already tells us.
        for branch_id in self.walls:
            if branch_id in self.wall_temperature:
                continue
            line = net.branches.get(branch_id)
            at_rest = ROOM
            if line is not None:
                inlet = net.nodes.get(line.upstream)
                if inlet is not None:
                    at_rest = inlet.temperature
            self.wall_temperature[branch_id] = at_rest if at_rest > 0.0 else ROOM

        # The wall pays for what it gave. Integrated here rather than inside the
        # sweep so a wall cools once per tick on the heat it actually delivered,
        # not once per sweep on a figure that was still converging.
        for branch_id, (heat, stream) in heat_drawn.items():
            wall = self.walls.get(branch_id)
            if wall is None or dt <= 0.0:
                continue
            temperature = self.wall_temperature[branch_id]
            capacity = wall.capacity(temperature)
            if capacity <= 0.0:
                continue
            moved = temperature - heat * dt / capacity
            # Bounded by the wall reaching the stream: metal cannot drive itself
            # past the gas it is warming, and an over-long step must not let it.
            # Sign-agnostic, because this runs both ways -- warm gas through a
            # cold LOX line is the same equation with the heat reversed, and is
            # the frost on the downstream fittings.
            if (temperature - stream) * (moved - stream) < 0.0:
                moved = stream
            self.wall_temperature[branch_id] = moved

    def _chamber(self, flows: Mapping[str, float]) -> None:
        """The chamber boundary when there is no engine model on the drawing."""
        ports = self.model.built.engine_ports
        net = self.model.built.network
        if self.model.chamber is not None and "chamber" in ports:
            return
        if not self._chamber_node:
            return
        # No engine model, so the ENGINE symbol's own `pressure` is the
        # boundary -- the honest "nobody has said what is on the end of the
        # pipe" case, and the back pressure a burn needs to flow against.
        #
        # But that number is a *design chamber pressure*, and a chamber only
        # holds it while it is lit. Applying it at rest put the whole
        # downstream leg at 350 psi on a cold stand with every valve shut,
        # which is what a gauge there would never show. Cold, the chamber is
        # open to atmosphere through its own nozzle.
        # "Is it lit?" asked of the flow, not of the state machine.
        #
        # The obvious test -- are the mains commanded open -- is defeated by
        # the shipped table, whose `Idle` row opens the fuel main. Propellant
        # actually arriving at the chamber is the physical question and does
        # not care what the table says.
        chamber = self._chamber_node
        arriving = sum(
            abs(flows.get(branch_id, 0.0))
            for branch_id, branch in net.branches.items()
            if chamber in (branch.upstream, branch.downstream)
        )
        net.nodes[chamber].pressure = (
            self._design_chamber if arriving > MIN_CHAMBER_FLOW else AMBIENT
        )

    def _burnout_check(self) -> None:
        """Burnout: a tank ran dry during Fire, so the sequence goes to Vent.

        The stand's fire is timed and ends in Vent; the twin's ends when the
        propellant does. Without this the mains stayed open on empty tanks and
        both sat at lockup with the regulator holding them there, which the
        operator rightly read as "nothing vented". Vent is what the table
        says it is: both tank vents, both press valves, the manifold vent.
        """
        if not self.setup.auto_vent or self.state != "Fire":
            return
        dry = [sim for sim in self.tanks.values() if sim.empty]
        if not dry or not self.machine.can_go(self.state, "Vent"):
            return
        # T+ from Fire, not the stand clock: "T+302.7 s" after a 3.5 s burn
        # read as a five-minute one.
        lit = self.t - self._state_since
        self.command_state("Vent")
        self.burnout = (
            f"Burnout at T+{lit:.2f} s: {', '.join(sim.label for sim in dry)} ran "
            "dry, so the sequence went to Vent."
        )

    def _check_limits(self) -> None:
        """Trip the stand if a vessel is over the pressure the drawing rates it for.

        A hand-loaded regulator turned too far, a shut LOX tank left to boil,
        a fill with the vent closed: the model would happily carry a tank to
        the propellant's critical pressure and beyond. A real one lets go.
        Above its MAWP the stand stops, says which vessel and how far, and
        asks to be reset -- the operator learns what they did, and nothing
        pretends to run on past a failure.
        """
        if self.tripped:
            return
        for sim in self.tanks.values():
            if sim.mawp > 0.0 and sim.pressure > sim.mawp:
                self.trip = Trip(
                    sim.id, sim.label, "tank", self.t, sim.pressure, sim.mawp
                )
                self.tripped = (
                    f"{sim.label} reached {psig(sim.pressure):.0f} psig against a "
                    f"{psig(sim.mawp):.0f} psig MAWP. The tank would have failed. "
                    "Reset the stand and start over."
                )
                return
        for bottle in self.bottles.values():
            if bottle.mawp > 0.0 and bottle.pressure > bottle.mawp:
                self.trip = Trip(
                    bottle.id,
                    bottle.label,
                    "bottle",
                    self.t,
                    bottle.pressure,
                    bottle.mawp,
                )
                self.tripped = (
                    f"{bottle.label} reached {psig(bottle.pressure):.0f} psig against a "
                    f"{psig(bottle.mawp):.0f} psig MAWP. The bottle would have failed. "
                    "Reset the stand and start over."
                )
                return

    def _notes(self) -> list[str]:
        out: list[str] = []
        if self.burnout and self.state == "Vent":
            out.append(self.burnout)
        for sim in self.tanks.values():
            if sim.chilling:
                out.append(
                    f"{sim.label} is chilling down: wall at "
                    f"{sim.state.ullage.wall_temperature:.0f} K. The LOX flashes off "
                    "and vents until the metal is at saturation; nothing collects yet."
                )
            elif sim.empty:
                out.append(f"{sim.label} is empty.")
            elif (
                sim.tank.fill_fraction(sim.state) < self.setup.low_tank
                and not sim.filling
            ):
                # "down to 2%" while the tank is loading read as a leak.
                out.append(
                    f"{sim.label} is down to "
                    f"{sim.tank.fill_fraction(sim.state) * 100:.0f}%."
                )
            readouts = sim.readouts()
            excess = readouts["wall_temperature_K"] - sim.state.liquid_temperature
            boiling = False
            if (
                not sim.empty
                and sim.tank.wall_boiling
                and excess > self.setup.warm_wall_K
            ):
                # Only while it actually can: a wall above saturation at the
                # tank's total pressure. Pressed to 38 bar the same warm wall
                # grows no bubbles and the note would be crying wolf.
                try:
                    boiling = readouts["wall_temperature_K"] > sim.tank.liquid.get(
                        "T", p=sim.pressure, q=0.0
                    )
                except (
                    Exception
                ):  # noqa: BLE001 - above the critical point, say nothing
                    boiling = False
            if (
                not sim.empty
                and sim.state.liquid_temperature < CRYOGENIC_K
                and excess > self.setup.warm_wall_K
                and boiling
            ):
                # The thing that turns a shut LOX tank into a runaway. A
                # warm wall boils the liquid it touches at kilowatts, and
                # with the vent shut that all goes into the ullage. The
                # operator's move is to keep venting until the frost forms;
                # the note says so before the gauge does.
                out.append(
                    f"{sim.label} wall is {excess:.0f} K above the liquid and "
                    "boiling it; keep the vent open until it chills, or the "
                    "tank climbs hard the moment it shuts."
                )
            try:
                p_crit = float(sim.tank.liquid.critical_pressure)
            except Exception:  # noqa: BLE001 - a measured table has no critical point
                p_crit = 0.0
            if p_crit > 0.0 and sim.pressure > 0.97 * p_crit:
                out.append(
                    f"{sim.label} is at its propellant's critical pressure "
                    f"({p_crit / PSI - 14.7:.0f} psig) and the model can go no "
                    "higher. The drawing has no relief valve; a real tank would "
                    "have lifted one long ago. Vent it."
                )
        out.extend(self._leaking_notes())
        ground = self.ground
        verbs = {GSE_CHARGE: "charge", GSE_DUMP: "dump"}
        for bottle in self.bottles.values():
            # Its GSE is not drawn, so only the table's own actuators fill and
            # dump it. Renamed or dropped from the CSV, they silently would not.
            undrawn = bottle.id not in self._drawn_fill and bottle.id not in ground
            missing = [
                name for name in verbs if undrawn and name not in self.machine.actuators
            ]
            if missing:
                out.append(
                    f"{bottle.label}'s fill is not on the drawing and the state "
                    f"table has no {' or '.join(repr(m) for m in missing)} row, "
                    f"so no state can {' or '.join(verbs[m] for m in missing)} it."
                )
            if not bottle.charged:
                out.append(f"{bottle.label} is not charged.")
            elif (
                bottle.volume.temperature(bottle.state) - bottle.state.wall_temperature
                > self.setup.hot_bottle_K
            ):
                # The number an operator reads as a leak. An adiabatic fill
                # lands well above the steel and the pressure follows the gas
                # down as the two settle; naming it here is what stops the
                # next person hunting a leak through the regulator.
                excess = (
                    bottle.volume.temperature(bottle.state)
                    - bottle.state.wall_temperature
                )
                out.append(
                    f"{bottle.label} is {excess:.0f} K hotter than its wall from the "
                    "fill; it will sag as it cools -- that is the fill, not a leak. "
                    "Top up before Ready."
                )
            elif bottle.pressure < LOW_BOTTLE * bottle.target:
                out.append(
                    f"{bottle.label} is down to {bottle.pressure / PSI:.0f} psi, "
                    f"{bottle.fraction * 100:.0f}% of what it was filled to."
                )
        return out
