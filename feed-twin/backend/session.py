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

import math
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field, replace
from typing import Deque, Mapping, Callable

from feedtwin.comps.regulator import Regulator
from feedtwin.engine.balance import MixtureBalance
from feedtwin.engine.chamber import ChamberResult
from feedtwin.comps.wall import STAINLESS_DENSITY, LineWall, fitting_metal
from feedtwin.props import Fluid, PropertyError
from feedtwin.vessels.convection import GasFilm, still_gas_conductance
from feedtwin.solve.network import Network
from feedtwin.solve.steady import SteadyResult, solve_steady
from feedtwin.vessels.geometry import CylindricalTank, cylindrical_from_volume
from feedtwin.vessels.collapse import ConductionCollapse, NoCollapse
from feedtwin.vessels.vapour import NoVapour, SaturatedVapour
from feedtwin.vessels.tank import Tank, TankState
from feedtwin.vessels.volume import GasVolume, VesselState

from backend.assembly import Model
from backend.run import ATMOSPHERE, PSI, from_psig, psig
from backend.statemachine import Binding, StateMachine

#: Standard atmosphere [Pa]. What a vented vessel sits at, and the zero of every
#: gauge on the stand -- see `backend.run.psig`.
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

MIN_CHAMBER_FLOW = 1.0e-3
"""Propellant arriving at the chamber that counts as "lit" [kg/s].

Well below a seat leak and far below any real injector flow, so it separates a
shut stand from a burning one without a tuning question."""

DRY_MASS = 1.0e-3

#: Cap on those re-solves. One tick is allowed to cost this many network solves
#: and no more; past it the step is simply taken, and the next tick corrects.
#:
#: Raised from 12 once the coupling was sized from the ullage time constant
#: (see COUPLING_SAFETY): a helium ullage of half a litre behind a regulator has
#: a time constant of two or three milliseconds, and a 50 ms cockpit tick needs
#: far more than twelve solves to resolve it. The tick budget, not this cap, is
#: what protects the panel from a slow tick.
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

#: How hard the chamber node chases the flows each tick. See Session._chamber.
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
#: Vessel sub-steps inside one coupling step. The vessels are stiffer than the
#: network is expensive, so they take several short steps per solve.
SUBSTEPS = 4

#: Temperature of the gas a GSE fill delivers [K]: a bank at ambient.
FILL_SUPPLY_T = 293.15
#: The room [K], for the heat that leaks through a tank skin.
AMBIENT_T = 293.15
#: Fiberglass batt, for a drawing that gives a thickness and no conductivity.
FIBERGLASS_K = 0.04
#: A liquid colder than this is a cryogen for the purposes of the notes.
CRYOGENIC_K = 150.0
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
    1092-50 delivers 50 psi above it, so 500 here is the 550 psig the tanks
    lock up at on the stand."""

    copv_target_psi: float = 4500.0
    """Bottle fill target [psig], as its gauge would read it."""
    """What GN2 High Press fills the bottle to."""

    copv_fill_s: float = 25.0
    """Seconds to take the bottle from empty to target: what GN2 High Press
    takes on the stand (operator). How hot the bottle ends up is
    ``fill_stirring``'s business, not this number's -- an adiabatic charge
    lands near the same temperature whether it takes 25 s or 300."""

    fuel_fill_s: float = 15.0
    """Seconds to take the fuel tank from empty to :data:`FULL_FRACTION`:
    about what pouring 6.5 kg of ethanol through the fill port takes on the
    stand (operator). Nothing to chill, so nothing slows it."""

    tank_fill_s: float = 120.0
    """Seconds to take a cryogen tank from empty to :data:`FULL_FRACTION`.

    Two minutes rather than the thirty seconds it was: a LOX load has to chill
    the tank wall as it goes, and the wall gives that heat up by boiling the
    liquid it meets, at a rate the vent has to carry. Loaded in thirty
    seconds the wall is still 240 K when the vent shuts and the tank runs
    away; loaded over minutes -- which is what a dewar transfer takes -- the
    frost has formed by the time it is full. Set it to what the load takes."""

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

    line_walls: bool = False
    """Heat a line's own metal gives the gas flowing through it.

    **Off by default**, like the other thermal options, but this is the one with
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
    insulated one is far lower. Zero -- the default -- is the tank the rest of
    this model has always assumed: adiabatic below the surface.

    100 W/(m^2.K) by default on the cockpit since 2026-09-11 (it was 0): the
    ambient leak arrives at the wetted wall and this is the only way it
    reaches the liquid. Boiling on a wall a few kelvin above saturation runs
    at hundreds to thousands; a hundred passes a 400 W leak with 10 K of wall
    superheat. The study sets its own."""

    tick_budget: float = TICK_BUDGET
    """Wall-clock seconds one tick may spend before folding the rest of its
    coupling steps into one. A cockpit wants this small so the panel stays
    live; a study wants it effectively off, because a folded step is exactly
    the under-resolved step the coupling count was chosen to avoid."""
    max_iterations: int = LIVE_ITERATIONS
    """Newton iterations the network solve may take per tick.

    A cockpit and a study want different answers here. The default bounds tick
    latency so the panel stays live: a solve that has not closed in this many
    iterations hands back the last good state, which costs one slightly stale
    frame. A study wants the opposite trade -- a helium burn, whose regulator
    branch is nearly flat and whose Newton steps are correspondingly long, goes
    from 39 failed ticks in 140 to 4 by raising this to 60, at the cost of a
    worst-case tick near a second. Nobody watching a panel would accept that;
    nobody reading a pressure curve would accept the 39.
    """
    """Model heat leaving the ullage into the propellant surface.

    Real, and it is why a tank droops on a long hold: warm pressurant meets cold
    liquid and gives its heat up across the interface. Off, the ullage exchanges
    heat only with the vessel wall.

    Toggleable because it is a *separate* question from how much gas a bottle
    can deliver, and mixing the two makes a pressurant study impossible to read
    -- collapse and an under-sized COPV both show up as a tank that will not
    hold pressure."""

    # ---- the constants that used to be module-level, now dialled from the
    # Configuration tab (backend/tunables.py explains each). Defaults are the
    # values the benchmarks were run with.
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
    live_step: float = LIVE_STEP
    max_coupled_change: float = MAX_COUPLED_CHANGE
    coupling_safety: float = COUPLING_SAFETY
    max_mass_step: float = MAX_MASS_STEP


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
            f"{label} declares {t * 1e3:.0f} mm of insulation but no conductivity; "
            f"assumed {k} W/(m.K), fiberglass."
        )
    return 1.0 / (1.0 / air_film + t / k)


def _trip_limit(node: object, safety_factor: float, assumptions: list[str]) -> float:
    """Absolute pressure a vessel trips the stand at, or 0 for no limit.

    The drawing says what the vessel will take as a burst pressure -- what a
    team that built it knows -- and the stand stops at that over a stated
    factor of safety. An older drawing carrying an MAWP trips at the MAWP.
    Gauge on the drawing, like every number an operator reads.
    """
    params = getattr(node, "params", {}) or {}
    label = getattr(node, "label", "") or getattr(node, "id", "vessel")
    burst = params.get("burst_pressure")
    if burst is not None and burst.si > 0.0:
        sf = max(float(safety_factor), 1.0)
        assumptions.append(
            f"{label} trips at burst pressure / {sf:g} "
            f"({burst.si / sf / PSI:.0f} psig)."
        )
        return float(burst.si) / sf + ATMOSPHERE
    rated_at = params.get("MAWP")
    return (float(rated_at.si) + ATMOSPHERE) if rated_at is not None else 0.0


def _vessel_wall(
    node: object,
    litres: float,
    defaults: dict,
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
                f"{label}: still-gas film could not be estimated ({exc}); "
                f"using the per-litre default {conductance:.1f} W/K."
            )
        else:
            conductance = film.hA
            assumptions.append(
                f"{label} gas-to-wall hA {film.hA:.1f} W/K estimated from its "
                f"gas: h = {film.h:.1f} W/(m²·K) over {film.area:.2f} m² at "
                f"ΔT = {film.delta_T:g} K (Churchill–Chu, Ra = "
                f"{film.grashof * film.prandtl:.2e})."
            )
    if missing:
        assumptions.append(
            f"{label} does not declare {', '.join(missing)}; assumed "
            f"{mass:.2f} kg, {capacity:.0f} J/(kg.K), {conductance:.1f} W/K "
            f"({defaults['basis']}). These set how much the wall fights the gas "
            "cooling, and they are estimates."
        )
    return mass, capacity, conductance


@dataclass(frozen=True, slots=True)
class Snapshot:
    """The stand's mutable state at one instant, by value.

    What a replay frame carries alongside the sample, so a command given while
    the operator is watching a run computed ahead can put the stand back to the
    frame being shown. Typed rather than a dict of ``object`` because a restore
    that assigns the wrong thing to the wrong field is exactly the bug a type
    checker exists to catch, and one that a test on a happy path never would.
    """

    tanks: dict[str, tuple[TankState, bool, bool]]
    bottles: dict[str, tuple[VesselState, bool, bool, bool]]
    t: float
    state: str
    guess: dict[str, float]
    last_flows: dict[str, float]
    last_isolated: frozenset[str]
    positions: dict[str, float]
    chamber: float
    trapped: dict[str, float]
    last_change: float
    last_dt: float
    forced: dict[str, float]
    history: int


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
    #: The drawing symbol this was built from, for knobs re-read live.
    node: object = None
    #: Maximum allowable working pressure [Pa], 0 if the drawing gives none.
    mawp: float = 0.0
    #: Dials the session copies in each tick (see backend/tunables.py).
    full_fraction: float = FULL_FRACTION
    charge_gamma: float = CHARGE_GAMMA
    supply_band: float = SUPPLY_BAND
    stir_band: float = STIR_BAND

    @property
    def pressure(self) -> float:
        return float(self.tank.pressure(self.state))

    @property
    def outlet_pressure(self) -> float:
        return float(self.tank.outlet_pressure(self.state))

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
            # The surface the ullage sees, when it is tracked apart from the
            # bulk; equal to the liquid temperature when it is not.
            "surface_temperature_K": (
                self.state.surface_temperature
                if self.state.surface_temperature is not None
                else self.state.liquid_temperature
            ),
        }

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
    ) -> float:
        """One vessel step, with the flows the network just produced.

        Returns the gas inflow it **refused** [kg/s]. The caller owes that back
        to whatever was debited for it: the network solved a flow leaving the
        bottle, and if the tank does not take it, it did not happen.

        In and out are separate, not netted. They are simultaneous during a
        fill -- pressurant on one port, vent on another -- and they carry
        different energy: gas arriving brings the supply's enthalpy, gas leaving
        takes the ullage's own. Netting them would price the whole exchange at
        the supply's enthalpy and make a venting tank warm up.
        """
        if self.filling:
            capacity = self.tank.geometry.total_volume * self.full_fraction
            rho = self.tank.liquid_density(self.state)
            wanted = capacity * rho
            if self.state.liquid_mass < wanted:
                span = max(self.fill_seconds, 1e-3)
                added = min(wanted * dt / span, wanted - self.state.liquid_mass)
                # `replace`, not a fresh TankState: rebuilding field by field
                # silently drops anything added to the dataclass later, which is
                # exactly how `vapour_mass` came to reset to zero every step.
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

        # A tank with nothing in it cannot deliver liquid. Without this the
        # solver happily draws propellant out of an empty vessel and the mains
        # keep flowing after the tank is dry.
        self.empty = self.state.liquid_mass <= 1e-3
        if self.empty:
            mdot_liquid_out = 0.0

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
        vapour_out = (
            max(mdot_gas_out, 0.0) * vapour_share * min(max(vent_fraction, 0.0), 1.0)
        )
        pressurant_out = mdot_gas_out - vapour_out
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
        """
        remaining = dt
        for _ in range(STEP_RETRIES + 1):
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
                remaining *= 0.5
                continue
            self.state = candidate
            return
        # Still unreachable after halving: the ullage has run out of gas to
        # give. Settle it at atmosphere against the wall, which is where a
        # fully vented tank ends up anyway.
        volume = max(self.tank.ullage_volume(self.state), 1e-9)
        wall = self.state.ullage.wall_temperature
        mass = self.tank.gas.get("rho", p=AMBIENT, T=wall) * volume
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

    def _settled(self, ullage: VesselState) -> VesselState:
        """Keep the ullage inside the states the gas can actually occupy.

        Two floors, and both are physics rather than numerics.

        A vent cannot pull a tank below the air outside it, so the **mass**
        cannot fall below what atmosphere would hold in that volume.

        Only the mass, deliberately. Chilling is bounded by sizing the step
        against the energy leaving (see MAX_ENERGY_FRACTION) rather than by
        clamping the temperature afterwards: a clamp applied every sub-step is
        a ratchet that puts energy *in*, and a venting tank then climbs in
        pressure instead of falling.
        """
        volume = max(self.tank.ullage_volume(self.state), 1e-9)
        mass = max(
            ullage.mass,
            self.tank.gas.get("rho", p=AMBIENT, T=ullage.wall_temperature) * volume,
        )
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
    fill_seconds: float = 25.0
    #: Temperature of the cart's gas [K]; the session copies it in each tick.
    fill_supply_T: float = FILL_SUPPLY_T
    charged: bool = False
    """Whether this bottle has ever been filled. A note saying a bottle is
    "down to" fifteen psi is wrong before anybody has put gas in it -- it is
    not down to anything, it is where it started."""
    #: Maximum allowable working pressure [Pa], 0 if the drawing gives none.
    mawp: float = 0.0

    @property
    def pressure(self) -> float:
        return float(self.volume.pressure(self.state))

    @property
    def fraction(self) -> float:
        """How full, against the target it is being filled to."""
        return min(max(self.pressure / self.target, 0.0), 1.0) if self.target else 0.0

    def advance(self, dt: float, *, mdot_out: float, stirring: float = 1.0) -> None:
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

        if self.venting:
            mdot_out = max(mdot_out, self.state.mass / max(self.fill_seconds, 1e-3))

        if self.state.mass <= 1e-6:
            return
        rates = self.volume.rates(self.state, mdot_out=max(mdot_out, 0.0))
        stepped = self.volume.step(self.state, rates, dt)
        floor = self.volume.fluid.get("rho", p=AMBIENT, T=stepped.wall_temperature)
        self.state = VesselState(
            mass=max(stepped.mass, floor * self.volume.volume),
            energy=stepped.energy,
            wall_temperature=stepped.wall_temperature,
        )


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
    ) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.model = model
        self.machine = machine
        self.binding = binding
        self.state = state if state in machine.states else machine.states[0]
        self.setup = setup or Setup()
        self.forced: dict[str, float] = {}
        #: Where each actuator actually is, as opposed to where it is told to be.
        self._positions: dict[str, float] = {}
        self._travel: dict[str, float] = {}
        #: The run computed ahead of the display. Each entry is the sample the
        #: operator will see and the stand's state at that instant, so a command
        #: given mid-replay can put the stand back exactly where the operator
        #: thinks it is. See :meth:`precompute`.
        self._replay: list[tuple[Sample, Snapshot]] = []
        self._replay_at: int = 0
        self._replay_clock: float = 0.0
        self._replay_t0: float = 0.0
        self._shown: Sample | None = None
        #: Why the stand stopped, if it has: a vessel over its MAWP. Cleared
        #: only by opening a new stand -- there is no un-bursting a tank.
        self.tripped: str | None = None
        #: Set when Fire ended by a tank running dry (see _burnout_check).
        self.burnout: str | None = None
        self.computing: bool = False
        self.progress: float = 0.0
        self._cancel = threading.Event()
        self._lock = threading.RLock()
        self.t = 0.0
        self.wall = time.monotonic()
        self.history: Deque[Sample] = deque(maxlen=HISTORY)
        self.assumptions: list[str] = []
        self._last_flows: dict[str, float] = {}
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

    # ------------------------------------------------------------ building

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
                    f"{node.label} has no diameter on the drawing; assumed "
                    f"{bore * 1e3:.0f} mm, which sets the liquid column and so "
                    "the head at the outlet."
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
                ambient_conductance=_skin_conductance(
                    node, self.setup.ambient_leak, self.assumptions
                ),
                ambient_temperature=self.setup.ambient_T,
                # Boiling at a superheated wall is what makes a shut LOX tank
                # climb; it needs the vapour somewhere to go.
                wall_boiling=self.setup.ullage_vapour and self.setup.wall_boiling,
            )
            limit = _trip_limit(node, self.setup.burst_safety_factor, self.assumptions)
            self.tanks[drawing_id] = TankSim(
                id=drawing_id,
                label=node.label or drawing_id,
                tank=tank,
                node=node,
                # Gauge, like every number an operator reads: 1000 psi on the
                # drawing is what the tank's own gauge would show.
                mawp=limit,
                state=tank.initial_state(
                    pressure=AMBIENT,
                    liquid_mass=0.0,
                    liquid_temperature=temperature,
                    gas_temperature=293.15,
                ),
                ullage_node=ports.ullage,
                outlet_node=ports.outlet,
            )

        for node in self.model.diagram.nodes:
            if node.type not in {"KBOTTLE", "DEWAR"} or node.id not in net.nodes:
                continue
            volume = node.params.get("volume")
            pressure = node.params.get("pressure")
            temp_param = node.params.get("temperature")
            litres = volume.si if volume is not None else 0.044
            if volume is None:
                self.assumptions.append(
                    f"{node.label} has no volume on the drawing; assumed "
                    f"{litres * 1e3:.0f} L, which sets how far it droops."
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
            delivered = bool(self.setup.bottle_delivered)
            self.bottles[node.id] = BottleSim(
                id=node.id,
                label=node.label or node.id,
                volume=gas,
                state=gas.initial_state(
                    pressure=rated if delivered else AMBIENT,
                    temperature=ambient_T,
                ),
                node=node.id,
                target=from_psig(self.setup.copv_target_psi) or rated,
                fill_seconds=self.setup.copv_fill_s,
                charged=delivered,
                mawp=_trip_limit(node, self.setup.burst_safety_factor, self.assumptions),
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
        """
        for sim in self.tanks.values():
            capacity = sim.tank.geometry.total_volume * fill_fraction
            rho = sim.tank.liquid.get("rho", T=sim.state.liquid_temperature, q=0.0)
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
            sim.empty = False
        for bottle in self.bottles.values():
            if copv_psi > 0.0:
                bottle.state = bottle.volume.initial_state(
                    pressure=from_psig(copv_psi), temperature=293.15
                )
            bottle.charged = True
        self.state = state if state in self.machine.states else self.state
        self._guess = {}
        self._last_flows = {}
        self._last_isolated = frozenset()

    def _loader_supply(self, loader: object) -> float:
        """Pressure feeding a dome control regulator [Pa].

        The bottle it hangs off, read from state rather than from the last
        solve: the dome has to be known *before* the network is solved, and a
        stale node pressure from the previous tick would put the dome one step
        behind the supply it is supposed to track.
        """
        for bottle in self.bottles.values():
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

    def _tank_wall_defaults(self) -> dict:
        return {
            "kg_per_litre": self.setup.tank_wall_kg_per_L,
            "capacity": self.setup.tank_wall_capacity,
            "hA_ref": (self.setup.tank_wall_hA, 17.5),
            "basis": TANK_WALL["basis"],
        }

    def _bottle_wall_defaults(self) -> dict:
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
        self._leave_replay()
        if state not in self.machine.states:
            raise ValueError(f"no state {state!r}")
        if not self.machine.can_go(self.state, state):
            raise PermissionError(
                f"{self.state} cannot go to {state}. From here: "
                f"{', '.join(self.machine.targets(self.state))}"
            )
        self.state = state
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

    def set_valve(self, drawing_id: str, is_open: bool) -> None:
        self._leave_replay()
        self.forced[drawing_id] = 1.0 if is_open else 0.0

    def release(self, drawing_id: str = "") -> None:
        self._leave_replay()
        if drawing_id:
            self.forced.pop(drawing_id, None)
        else:
            self.forced.clear()

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

        # The dome, through the regulator that actually loads it. `dome_psi` is
        # the knob on the *control* regulator, not the dome pressure itself:
        # that reg hangs off the same bottle as the one it controls, so its
        # outlet -- and with it the dome, and with it every tank on the stand --
        # rides up as the bottle blows down. Writing the knob straight onto the
        # dome pins it flat and silently switches the supply-pressure effect off
        # for the whole stand, which is the wrong sign to guess at and the one
        # people do guess at.
        for loader in built.dome_loaders.values():
            supply = self._loader_supply(loader)
            if supply <= 0.0:
                out[loader.signal] = from_psig(self.setup.dome_psi)
                continue
            conditions = built.network.conditions(
                loader.supply_node,
                supply,
                {f"{loader.component.id}.dome": from_psig(self.setup.dome_psi)},
            )
            component = loader.component
            if not isinstance(component, Regulator):
                out[loader.signal] = from_psig(self.setup.dome_psi)
                continue
            out[loader.signal] = float(component.outlet_setpoint(0.0, conditions))
        if not built.dome_loaders:
            dome_signal = next(
                (s for s in built.actuators.values() if s.endswith(".dome")), ""
            )
            if dome_signal:
                out[dome_signal] = from_psig(self.setup.dome_psi)

        commanded = self.binding.positions_for(self.machine, self.state)
        for drawing_id, signal in built.actuators.items():
            if signal.endswith(".dome"):
                continue
            target = (
                self.forced[drawing_id]
                if drawing_id in self.forced
                else commanded.get(drawing_id, 0.0)
            )
            out[signal] = self._slew(drawing_id, target, dt)
        return out

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
            for branch_id, branch in net.branches.items():
                if sim.outlet_node in (branch.upstream, branch.downstream):
                    out.add(branch_id)
        return frozenset(out)

    def _coupling_timescale(self) -> float:
        """Shortest regulator-ullage RC time constant on the stand [s], or 0.

        ``C = V rho / p`` is the isothermal gas capacitance of an ullage -- how
        much mass it takes to raise its pressure by a pascal. ``R`` is the slope
        of the regulator feeding it, ``flow_droop / rated_flow``: how many
        pascals the outlet gives up per kg/s drawn. Their product is the time
        the pair takes to settle, and the smallest such product on the stand is
        what the coupling step has to resolve. Line resistance is left out on
        purpose: it only lengthens the constant, so ignoring it errs toward more
        steps, never fewer.
        """
        slopes = []
        for branch in self.model.built.network.branches.values():
            comp = getattr(branch, "component", None)
            if comp is None or "Regulator" not in type(comp).__name__:
                continue
            droop = comp.p.get("flow_droop", 0.0)
            rated = comp.p.get("rated_flow", 0.0)
            if droop > 0.0 and rated > 0.0:
                slopes.append(droop / rated)
        if not slopes:
            return 0.0
        resistance = min(slopes)
        tau = float("inf")
        for sim in self.tanks.values():
            p = sim.pressure
            if p <= 0.0:
                continue
            volume = sim.tank.ullage_volume(sim.state)
            if volume <= 0.0:
                continue
            capacitance = sim.state.ullage.mass / p  # V rho / p, with V rho = m
            tau = min(tau, capacitance * resistance)
        return tau if tau < float("inf") else 0.0

    def _vessel_pressures(self) -> dict[str, float]:
        out = {sim.id: sim.pressure for sim in self.tanks.values()}
        out.update({b.id: b.pressure for b in self.bottles.values()})
        return out

    def _advance_once(
        self, net: Network, signals: Mapping[str, float], dt: float
    ) -> SteadyResult:
        """One coupling step: solve the network, then move the vessels."""
        self._apply_vessel_pressures()

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

        result = solve_steady(
            net,
            signals=signals,
            tol=LIVE_TOL,
            max_iterations=self.setup.max_iterations,
            raise_on_failure=False,
            guess=self._guess or None,
            isolate=dry,
        )
        self._accept(result)
        result = self._close_chamber(net, signals, dry, result)
        flows = self._last_flows or dict(result.flows)
        if result.converged:
            self._propagate_temperatures(result.pressures, flows, dt)

        self._move_vessels(flows, result.pressures, dt)
        return result

    def _accept(self, result: SteadyResult) -> None:
        """Keep a converged solve as the next one's starting point."""
        if not result.converged:
            return
        self._last_flows = dict(result.flows)
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

    def _close_chamber(
        self,
        net: Network,
        signals: Mapping[str, float],
        dry: frozenset[str],
        result: SteadyResult,
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
            self._chamber(self._last_flows or dict(result.flows))
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
            res = solve_steady(
                net,
                signals=signals,
                tol=LIVE_TOL,
                max_iterations=self.setup.max_iterations,
                raise_on_failure=False,
                guess=self._guess or None,
                isolate=dry,
            )
            self._accept(res)
            return res

        p = max(self._chamber_guess, AMBIENT)
        eq, g = mismatch(result, p)
        if abs(g) > CHAMBER_TOL:
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
                if abs(g) <= CHAMBER_TOL:
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
                if hi - lo < CHAMBER_TOL:
                    break
        self._chamber_guess = p
        net.nodes[node].pressure = p
        self._last_chamber = eq
        return result

    def _move_vessels(
        self, flows: Mapping[str, float], pressures: Mapping[str, float], dt: float
    ) -> None:
        """Integrate every vessel over ``dt`` with the flows it is given."""
        inner = dt / SUBSTEPS
        vented = {
            sim.id: self._vent_fraction(sim.ullage_node, flows)
            for sim in self.tanks.values()
        }
        for _ in range(SUBSTEPS):
            refused = 0.0
            for sim in self.tanks.values():
                gas_in, gas_out = self._split_at(sim.ullage_node, flows)
                _, liquid_out = self._split_at(sim.outlet_node, flows)
                refused += sim.advance(
                    inner,
                    mdot_liquid_out=liquid_out,
                    mdot_gas_in=gas_in,
                    mdot_gas_out=gas_out,
                    enthalpy_gas_in=self._pressurant_enthalpy(sim),
                    supply_pressure=self._supply_to(sim, pressures),
                    stirring=self.setup.fill_stirring,
                    vent_fraction=vented.get(sim.id, 0.0),
                )
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
                for b_id, bottle in self.bottles.items()
            }
            total = sum(d for d in draws.values() if d > 0.0)
            for b_id, bottle in self.bottles.items():
                draw = draws[b_id]
                if refused > 0.0 and total > 0.0 and draw > 0.0:
                    draw -= refused * (draw / total)
                bottle.advance(inner, mdot_out=draw, stirring=self.setup.fill_stirring)

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

    @property
    def replaying(self) -> bool:
        """Serving a run computed ahead, rather than integrating live."""
        return bool(self._replay) and not self.computing

    def step(self, dt: float) -> Sample:
        """What the operator sees ``dt`` seconds later.

        Three regimes, and the operator should only ever notice one of them.

        **Live.** Integrate now and return the result -- the pad, fills, presses,
        holds. Cheap enough to do inside a tick.

        **Computing.** A run is being integrated ahead in the background, because
        resolving the regulator-ullage loop at a quarter of its time constant
        costs seconds of wall clock per second of stand and a panel cannot wait
        on it. The display holds its last frame and reports progress; nothing
        advances until the run is in.

        **Replaying.** The run is in. Each tick hands back the buffered frame for
        the stand time the display has reached, at wall-clock pace. The stand
        itself is already at the *end* of the run; the operator is watching it
        catch up. A command given during replay restores the stand to the frame
        being shown, discards the future, and continues live from there -- the
        same thing that would have happened had the run never been computed
        ahead, only a little later.
        """
        if self.computing:
            if self._shown is None:
                with self._lock:
                    self._shown = self._integrate(1e-4)
            return self._shown
        if self._replay:
            dt = max(min(dt, MAX_STEP), 1e-4)
            self._replay_clock += dt
            target = self._replay_t0 + self._replay_clock
            while (
                self._replay_at < len(self._replay)
                and self._replay[self._replay_at][0].t <= target + 1e-9
            ):
                self._replay_at += 1
            if self._replay_at == 0:
                return self._shown or self._replay[0][0]
            shown = self._replay[self._replay_at - 1][0]
            self._shown = shown
            if self._replay_at >= len(self._replay):
                # Caught up. The stand is already here; live from now on.
                self._replay.clear()
                self._replay_at = 0
            return shown
        if self.tripped:
            # The stand has failed. Nothing moves until it is reset; the
            # frame on display is the one it failed on.
            if self._shown is None:
                with self._lock:
                    self._shown = self._integrate(1e-4)
            return self._shown
        with self._lock:
            # A panel tick is a run of study-sized steps, so the console and
            # the Study tab integrate on the same grid.
            dt = max(min(dt, MAX_STEP), 1e-4)
            steps = max(int(round(dt / self.setup.live_step)), 1)
            inner = dt / steps
            for _ in range(steps):
                self._shown = self._integrate(inner)
                if self.tripped:
                    break
        return self._shown

    def precompute(self, horizon: float, dt: float = 0.02) -> int:
        """Integrate ``horizon`` seconds ahead at study accuracy, for replay.

        Returns the number of frames buffered. Stops early when the tanks run
        dry, since a blowdown into empty tanks is not a run anybody asked for.
        Runs at the study settings -- no latency budget, a generous Newton
        allowance -- because the whole point is that this is allowed to take
        as long as accuracy needs; the cost is paid here, once, and the panel
        pays it back as a delay before the burn starts rather than as noise
        through it.
        """
        with self._lock:
            self.computing = True
            self.progress = 0.0
            saved = (self.setup.tick_budget, self.setup.max_iterations)
            self.setup.tick_budget = 1e9
            self.setup.max_iterations = max(self.setup.max_iterations, 120)
            self._replay.clear()
            self._replay_at = 0
            self._replay_clock = 0.0
            self._replay_t0 = self.t
            steps = max(int(horizon / dt), 1)
            self._cancel.clear()
            start = self._snapshot()
            try:
                for i in range(steps):
                    if self._cancel.is_set():
                        # A command arrived while the run was being computed. The
                        # operator has seen nothing past the frame the display is
                        # holding, so the stand goes back there and the command
                        # applies to it -- an abort during "running" must act on
                        # the stand the operator is looking at, and must never be
                        # refused.
                        self._restore(start)
                        self._replay.clear()
                        break
                    sample = self._integrate(dt)
                    self._replay.append((sample, self._snapshot()))
                    self.progress = (i + 1) / steps
                    if all(sim.empty for sim in self.tanks.values()):
                        break
            finally:
                self.setup.tick_budget, self.setup.max_iterations = saved
                self.computing = False
                self.progress = 1.0
            return len(self._replay)

    def _snapshot(self) -> "Snapshot":
        """Everything that changes as the stand runs, by value."""
        return Snapshot(
            tanks={
                k: (sim.state, sim.filling, sim.empty) for k, sim in self.tanks.items()
            },
            bottles={
                k: (b.state, b.filling, b.venting, b.charged)
                for k, b in self.bottles.items()
            },
            t=self.t,
            state=self.state,
            guess=dict(self._guess),
            last_flows=dict(self._last_flows),
            last_isolated=self._last_isolated,
            positions=dict(self._positions),
            chamber=self._chamber_guess,
            trapped=dict(self._trapped),
            last_change=self._last_change,
            last_dt=self._last_dt,
            forced=dict(self.forced),
            history=len(self.history),
        )

    def _restore(self, snap: "Snapshot") -> None:
        for k, (tstate, filling, empty) in snap.tanks.items():
            sim = self.tanks[k]
            sim.state, sim.filling, sim.empty = tstate, filling, empty
        for k, (bstate, bfilling, venting, charged) in snap.bottles.items():
            b = self.bottles[k]
            b.state, b.filling, b.venting, b.charged = (
                bstate,
                bfilling,
                venting,
                charged,
            )
        self.t = snap.t
        self.state = snap.state
        self._guess = dict(snap.guess)
        self._last_flows = dict(snap.last_flows)
        self._last_isolated = snap.last_isolated
        self._positions = dict(snap.positions)
        self._chamber_guess = snap.chamber
        self._trapped = dict(snap.trapped)
        self._last_change = snap.last_change
        self._last_dt = snap.last_dt
        self.forced = dict(snap.forced)
        while len(self.history) > snap.history:
            self.history.pop()

    def _leave_replay(self) -> None:
        """A command has arrived: put the stand where the operator sees it.

        Mid-replay, that is the frame being shown. Mid-compute, it is the frame
        the display has been holding since the run started; the run is cancelled
        at its next step boundary and the stand restored to that frame before
        the command goes through. Acquiring the lock is what waits for the
        computing thread to notice and step aside.
        """
        if self.computing:
            self._cancel.set()
            with self._lock:
                pass
        if not self._replay:
            return
        index = max(self._replay_at - 1, 0)
        self._restore(self._replay[index][1])
        self._replay.clear()
        self._replay_at = 0

    def _integrate(self, dt: float) -> Sample:
        """Advance the stand by ``dt`` seconds and return where it is."""
        dt = max(min(dt, MAX_STEP), 1e-4)
        signals = self.signals(dt)
        net = self.model.built.network

        for sim in self.tanks.values():
            sim.filling = self._fills(sim)
            sim.full_fraction = self.setup.full_fraction
            sim.charge_gamma = self.setup.charge_gamma
            sim.supply_band = self.setup.supply_band
            sim.stir_band = self.setup.stir_band
            # A dewar transfer that has to chill the wall, or a pour.
            cryogen = sim.state.liquid_temperature < CRYOGENIC_K
            sim.fill_seconds = (
                self.setup.tank_fill_s if cryogen else self.setup.fuel_fill_s
            )
        # The GSE side of the bottle is not on the drawing, so its fill and
        # vent are the table's own GSE actuators, read as the DAQ reads them:
        # `GSE High Press Control` charges it (GN2 High Press), `GSE High
        # Press Vent` dumps it (GSE Abort, Emergency Abort). GN2 High Vent
        # opens `GN2 Vent`, which is on the drawing -- the regulated manifold
        # -- and the network vents exactly what that valve reaches. It used
        # to match on the state's name and drain the bottle in GN2 High Vent
        # through a valve the table never opens there.
        opened = self.machine.open_actuators(self.state)
        for bottle in self.bottles.values():
            bottle.filling = "GSE High Press Control" in opened
            bottle.fill_supply_T = self.setup.fill_supply_T
            bottle.venting = "GSE High Press Vent" in opened
            bottle.target = from_psig(self.setup.copv_target_psi)
            bottle.fill_seconds = self.setup.copv_fill_s

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
        tau = self._coupling_timescale()
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
        for sim in self.tanks.values():
            gas_in, gas_out = self._split_at(sim.ullage_node, self._last_flows)
            rate = max(gas_in, gas_out)
            held = sim.state.ullage.mass
            if rate > 0.0 and held > 0.0:
                coupling = max(
                    coupling, int(dt * rate / (held * self.setup.max_mass_step)) + 1
                )
        coupling = min(coupling, MAX_COUPLING_STEPS)
        inner_dt = dt / coupling
        before = self._vessel_pressures()

        result = None
        started = time.monotonic()
        for index in range(coupling):
            remaining = coupling - index
            # Out of time: fold what is left of the tick into one last step
            # rather than stalling the cockpit for the rest of the budget.
            if index and time.monotonic() - started > self.setup.tick_budget:
                result = self._advance_once(net, signals, inner_dt * remaining)
                break
            result = self._advance_once(net, signals, inner_dt)

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

        pressures = dict(result.pressures)
        for node in held:
            pressures[node] = self._trapped.get(node, AMBIENT)
        for node, value in result.pressures.items():
            if node not in held:
                self._trapped[node] = value
        self.t += dt
        self._check_limits()
        self._burnout_check()
        sample = Sample(
            t=round(self.t, 4),
            state=self.state,
            pressures=pressures,
            temperatures={
                node_id: node.temperature
                for node_id, node in self.model.built.network.nodes.items()
            },
            flows=dict(self._last_flows),
            signals=signals,
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

    def _bottle_for(self, sim: TankSim) -> BottleSim | None:
        """The bottle feeding this ullage, if one is reachable.

        Matched on species rather than walked: a stand has one pressurant, and a
        walk would have to cross the regulator's dome branch to find it.
        """
        wanted = sim.tank.gas.name
        for bottle in self.bottles.values():
            if bottle.volume.fluid.name == wanted:
                return bottle
        return next(iter(self.bottles.values()), None)

    def _fills(self, sim: TankSim) -> bool:
        """Whether the current state is filling this tank.

        Matched on the state's name against the tank's fluid, because fill comes
        from a tanker that is not on the drawing -- see FILL_RATE.
        """
        name = self.state.lower()
        if "fill" not in name:
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
        for _ in range(_TEMPERATURE_SWEEPS):
            settled = True
            for node_id, node in net.nodes.items():
                pinned = node_id in known
                arriving: list[tuple[float, float]] = []
                for branch_id, branch in net.branches.items():
                    mdot = flows.get(branch_id, 0.0)
                    if abs(mdot) < _TEMPERATURE_MIN_FLOW:
                        continue
                    source = branch.upstream if mdot > 0.0 else branch.downstream
                    sink = branch.downstream if mdot > 0.0 else branch.upstream
                    if sink != node_id or source not in net.nodes:
                        continue
                    upstream = net.nodes[source]
                    p_up = pressures.get(source)
                    if p_up is None or p_up <= 0.0:
                        continue
                    try:
                        fluid = Fluid(upstream.fluid)
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
                    landed = Fluid(node.fluid).get("T", p=p_here, h=enthalpy)
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
        self.command_state("Vent")
        self.burnout = (
            f"Burnout at T+{self.t:.1f} s: {', '.join(sim.label for sim in dry)} ran "
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
                self.tripped = (
                    f"{sim.label} reached {psig(sim.pressure):.0f} psig against a "
                    f"{psig(sim.mawp):.0f} psig MAWP. The tank would have failed. "
                    "Reset the stand and start over."
                )
                return
        for bottle in self.bottles.values():
            if bottle.mawp > 0.0 and bottle.pressure > bottle.mawp:
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
            if sim.empty:
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
        for bottle in self.bottles.values():
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
