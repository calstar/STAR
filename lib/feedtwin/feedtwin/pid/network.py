"""Turning a drawing into a network.

The two graphs are not the same shape, and that is the whole problem this
module solves.

A **P&ID** puts hardware on symbols *and* on lines: a ball valve is a symbol, a
tube run is a line, and both resist flow. A **feed-twin network** puts pressures
on nodes and hardware on branches, exclusively. So the transform is not a
relabelling, it is a rewrite:

.. code-block:: text

    P&ID                         network
    ----                         -------
    tank / K-bottle / dewar      a fixed-pressure node
    junction / manifold          a free node
    valve, regulator, check      a BRANCH, with a node spliced either side
    line between two symbols     a branch
    transducer, gauge, RTD       nothing -- an observer on the node it clips to
    text, section box            nothing

The interesting case is the third. An inline symbol has to become a branch, so
the two lines that met at it are cut and its own node pair takes their place.
Get that wrong and a drawing with six valves solves as a drawing with none,
which converges beautifully and means nothing.

Instruments are deliberately *not* dead-end stubs here. Phase 04 can peel a
stub exactly, but a transducer is not plumbing at all -- it is a label on a
place. Making it a node would put a fictitious branch in every mass balance and
report an anomaly on every run.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from typing import Callable, Iterable, Mapping

from feedtwin.comps import HydraulicComponent, build_component
from feedtwin.model.component import ComponentInstance
from feedtwin.model.param import Param, Provenance
from feedtwin.model.segments import LineSegment
from feedtwin.pid.document import Diagram, DiagramError, PidEdge, PidNode
from feedtwin.pid.roles import ground_ids, vehicle_ids
from feedtwin.solve.network import Network
from feedtwin.vessels.geometry import cylindrical_from_volume, level_of_volume

#: P&ID component type to (feed-twin type, fidelity model).
BRANCH_KINDS: dict[str, tuple[str, str]] = {
    "MAN": ("valve", "cv"),
    "ROT": ("valve", "cv"),
    "SOL": ("valve", "cv"),
    "MOV": ("valve", "cv"),
    "PR": ("regulator", "droop"),
    "RV": ("valve", "cv"),
    "CV": ("check_valve", "cv"),
    "QD": ("fitting", "K"),
}

LINE_KINDS: dict[str, tuple[str, str]] = {
    "pipe": ("pipe", "darcy"),
    "flex_hose": ("flex_hose", "darcy"),
    "bend": ("bend", "darcy"),
    "fitting": ("fitting", "K"),
}

#: Filled in when the drawing does not say. Every one is `DEFAULT`, so the run
#: report counts it and the app shows it -- a drawing that omits a bore should
#: produce an answer with a visible hole in it, not a confident number.
FALLBACKS: dict[str, dict[str, tuple[float, str]]] = {
    "valve": {"Cv": (4.0, "Cv"), "bore": (9.5, "mm")},
    "relief_valve": {"Cv": (4.0, "Cv"), "bore": (9.5, "mm")},
    "check_valve": {
        "Cv": (4.0, "Cv"),
        "bore": (9.5, "mm"),
        "cracking_pressure": (3.0, "psi"),
    },
    # flow_droop and rated_flow are here because without them a regulator's
    # branch equation is satisfied by *every* mass flow -- see
    # feedtwin.comps.regulator. A drawing that omits them would otherwise
    # produce a singular Jacobian rather than an answer.
    "regulator": {
        "setpoint": (500.0, "psi"),
        "Cv": (0.8, "Cv"),
        "bore": (7.75, "mm"),
        "flow_droop": (20.0, "psi"),
        "rated_flow": (0.05, "kg/s"),
    },
    "fitting": {"bore": (9.5, "mm")},
    "pipe": {"length": (1.0, "m"), "bore": (9.5, "mm"), "roughness": (0.0015, "mm")},
    "flex_hose": {
        "length": (0.5, "m"),
        "bore": (9.5, "mm"),
        "roughness": (0.0015, "mm"),
        "installed_bend_radius": (150.0, "mm"),
        "min_bend_radius": (100.0, "mm"),
    },
    "bend": {
        "bore": (9.5, "mm"),
        "bend_radius": (30.0, "mm"),
        "angle": (90.0, "deg"),
        "roughness": (0.0015, "mm"),
    },
}


#: Where the feed system ends. An engine is not a place the fluid sits, it is
#: the pressure the fluid is delivered against -- so it becomes a fixed-pressure
#: boundary rather than a free node. Left free, both propellant legs would
#: dead-end into it and mass balance would demand that one leg flow backwards
#: into the other, which converges and is nonsense.
SINK_TYPES = frozenset({"ENGINE", "INJECTOR", "VENT"})

#: Where an *engine* attaches. A strict subset of SINK_TYPES, and the two must
#: stay apart: SINK_TYPES answers "is this a fixed-pressure boundary", which a
#: vent also is, while this answers "is this the thing the injector bolts to".
#: Conflating them tried to build an injector face onto a vent stack.
ENGINE_TYPES = frozenset({"ENGINE", "INJECTOR"})

#: pid-designer's name for a dome-loaded regulator's loading port
#: (``components/pid/ports.ts``: ``['l', 'r', 'dome']``).
DOME_HANDLE = "dome"

#: Where the system discharges to atmosphere. A vent valve with nothing on its
#: downstream side is a dead end that carries no flow, so venting does nothing
#: -- which is the difference between a tank that blows down when you open its
#: vent and one that sits there. Fixed at ambient unless the drawing says
#: otherwise, because that is what a vent line ends at.
AMBIENT_TYPES = frozenset({"VENT"})

#: Standard atmosphere [Pa].
AMBIENT = 101325.0

#: Fill fraction the static head of a tank is taken at when the drawing gives a
#: volume but no level -- the uncoupled steady build's only view of the liquid
#: column. Matches the study's T-0 prime, so a steady build and the first frame
#: of a study agree on what the outlet transducer reads.
STATIC_HEAD_FILL = 0.95
#: Tank bore assumed when the drawing omits one [m]. 6 in. tube, the stand's
#: usual. Reported as an assumption whenever it is used.
DEFAULT_TANK_BORE = 0.1524
#: Tank volume assumed when the drawing omits one [m^3]. Reported likewise.
DEFAULT_TANK_LITRES = 0.0175

#: Valve symbols that vent to atmosphere when one side is left unplumbed.
#:
#: The two design tools had each solved venting, separately, and neither knew
#: about the other's answer. feed-twin required an explicit ``VENT`` symbol (see
#: AMBIENT_TYPES above). pid-designer infers it -- ``components/pid/vents.ts``:
#: *"A valve open on one side is a vent to atmosphere. Not a symbol you place. A
#: vent valve is drawn as a valve with nothing on its downstream side, which is
#: what a P&ID already does and what people already draw without being asked."*
#: It draws the arrow and passes its own checks on that basis.
#:
#: But the inference never reached the saved file -- it feeds the vent arrow and
#: the checks panel, not the export -- so the drawing a user is *told* to make
#: for a vent arrived here as a valve with a dead end behind it, and the network
#: failed to solve at all. Reading the same rule here means both apps read one
#: drawing the same way, and neither has to remember to say it twice.
#:
#: The rule is deliberately narrow, and narrow for pid-designer's stated reason:
#: **valves only**, and only with exactly one port in use. A spare manifold port
#: or a blanked tee branch is a plug, and plugs are not drawn -- inferring an
#: open boundary from one would model a tank venting through a fitting that
#: holds pressure.
VENTING_VALVE_TYPES = frozenset({"MAN", "ROT", "SOL", "MOV", "RV"})

#: Valves the state machine can command: solenoid, rotary-actuated and
#: motorised. Each rests where the drawing's ``failState`` puts it (shut unless
#: it says "open") until the table commands it.
ACTUATED_VALVE_TYPES = frozenset({"ROT", "SOL", "MOV"})

#: Valves a person turns. Never commanded by the state machine -- the table
#: does not know a hand valve exists -- but turned on the P&ID by hand, and
#: resting where the drawing (``options.normalPosition``) or the plumbing puts
#: them: a hand valve with one side open to atmosphere is a vent, a bleed or a
#: dump, and those are shut until somebody opens them; one plumbed on both
#: sides is an isolation valve, open. They used to have no position at all,
#: which a valve reads as wide open: every hand bleed on a GSE page was a
#: permanent hole to atmosphere, and a fuel tank vented through its cart's hand
#: vent could never hold press.
HAND_VALVE_TYPES = frozenset({"MAN"})


@dataclass(frozen=True, slots=True)
class Instrument:
    """A transducer, and the network node it reads."""

    id: str
    tag: str
    type: str
    node: str


@dataclass(frozen=True, slots=True)
class Placement:
    """Where a drawing symbol sits, so the app can draw the same picture."""

    id: str
    tag: str
    type: str
    x: float
    y: float
    fluid: str = ""


@dataclass(frozen=True, slots=True)
class TankPorts:
    """A tank is one symbol and two places.

    Pressurant arrives at the top and propellant leaves the bottom, and they are
    at different pressures by the height of the liquid column. Modelled as one
    node, the regulator would be feeding the same point the propellant leaves
    from -- the tank would have no inventory and no head, and the solve would be
    asked to balance an inflow against an outflow at a single pressure.

    Which port a line lands on is read from the fluid at its other end: a line
    carrying something other than what the tank holds is the pressurant side.
    That is more robust than reading the handle it was dropped on, and it is
    right for the same reason the drawing colours lines by fluid.
    """

    ullage: str
    outlet: str


@dataclass(frozen=True, slots=True)
class DomeLoader:
    """The hand-loaded regulator that sets a dome-loaded one's dome.

    It is lifted out of the flow network -- its outlet goes to a dome port and
    carries almost nothing -- but lifting it out is not the same as deleting
    it. The loader hangs off the *same* supply as the regulator it controls, so
    its own outlet rides up as that supply decays, and the dome rides with it.
    Dropping the component and keeping only its setpoint pins the dome to a
    constant, which is the one thing a dome on a blowing-down bottle does not
    do: it turns the supply-pressure effect off for the whole stand and hides
    it as a modelling choice nobody made.

    Carried here so a caller can evaluate the dome against the supply pressure
    of the moment, with the loader's own declared coefficients, rather than
    re-deriving the formula somewhere else.
    """

    #: Drawing id of the control regulator.
    id: str
    #: The built regulator, evaluated at zero flow to get its outlet.
    component: HydraulicComponent
    #: Signal name it drives, e.g. ``"PR-DOME.dome"``.
    signal: str
    #: Network node whose pressure feeds it.
    supply_node: str


@dataclass(frozen=True, slots=True)
class BuiltNetwork:
    """A network, plus everything needed to draw and drive it."""

    network: Network
    #: Network node id for each drawing symbol that became one.
    node_of: Mapping[str, str] = field(default_factory=dict)
    #: Branch ids contributed by each drawing symbol or line.
    branches_of: Mapping[str, tuple[str, ...]] = field(default_factory=dict)
    instruments: tuple[Instrument, ...] = ()
    placements: tuple[Placement, ...] = ()
    #: Drawing id to its two network nodes, for every tank.
    tanks: Mapping[str, TankPorts] = field(default_factory=dict)
    #: ``{"chamber": node, "oxidiser": branch, "fuel": branch}`` once an engine
    #: has been attached. Empty when the drawing's engine is still a boundary.
    engine_ports: Mapping[str, str] = field(default_factory=dict)
    #: Commandable valves: drawing id to the signal name components read.
    actuators: Mapping[str, str] = field(default_factory=dict)
    #: Control regulators that set a dome, by drawing id. See :class:`DomeLoader`.
    dome_loaders: Mapping[str, DomeLoader] = field(default_factory=dict)
    warnings: tuple[str, ...] = ()
    #: What each commandable valve does, read off the network: drawing id to
    #: words like ``{"fuel", "press"}`` or ``{"lox", "main"}``. Empty for a
    #: valve whose job the topology does not settle. See :func:`_valve_roles`.
    valve_roles: Mapping[str, frozenset[str]] = field(default_factory=dict)
    #: Branches of the disconnects read as GSE vents (see :func:`_gse_vents`)
    #: whose size the drawing does not give. The valve that sets it is on the
    #: cart, so a session sizes them from its own setup (``gse_vent_cv``).
    gse_vents: tuple[str, ...] = ()
    #: Paired disconnects read as mated couplings, by drawing id: where the
    #: drawing's pages (rocket, GSE) join. See :func:`_mate_disconnects`.
    mated: tuple[tuple[str, str], ...] = ()
    #: Where each commandable valve rests until something commands it, 0..1, by
    #: drawing id: an actuated valve at its ``failState``, a hand valve at its
    #: ``normalPosition`` or where its plumbing puts it (HAND_VALVE_TYPES).
    rest: Mapping[str, float] = field(default_factory=dict)
    #: Hand valves, by drawing id: turned by a person, never by the table.
    hand_valves: frozenset[str] = frozenset()
    #: Drawing ids on the vehicle (:func:`feedtwin.pid.roles.vehicle_ids`);
    #: ``None`` when the drawing is one piece, which is all vehicle.
    vehicle: frozenset[str] | None = None
    #: Ground-support tanks that load a vehicle tank through the drawing: a
    #: fuel transfer tank piped through a mated disconnect into the flight
    #: tank's fill port. Supply tank id -> the vehicle tanks it reaches.
    supplies: Mapping[str, frozenset[str]] = field(default_factory=dict)


def _accepted_options(kind: str, options: Mapping[str, str]) -> dict[str, str]:
    """Keep only the options the physics component declares.

    A drawing carries more than a solve needs -- how many ports a tank lid has,
    which side of the umbilical a QD is, whether a regulator is dome loaded.
    Those are real and belong on the drawing; passing them through would be
    rejected at load, and dropping them silently would lose the ones the
    transform *does* read. So they are filtered here and read explicitly where
    they matter.
    """
    from feedtwin.model.spec import SpecError, get_component_spec

    try:
        spec = get_component_spec(kind)
    except SpecError:
        return {}
    allowed = {o.name for o in spec.options}
    return {k: v for k, v in options.items() if k in allowed}


#: Line-level parameters a segment list supersedes.
#:
#: Not merged, not averaged, not used as a cross-check: dropped. The drawing's
#: editor greys these out the moment a line gets its first segment, so a value
#: still sitting in one is a leftover from before the run was itemised. Summing
#: the segments *and* the line-level length is the double-count this whole path
#: exists to avoid.
#:
#: The spec would drop them anyway -- none of them belongs to the ``segmented``
#: model -- but it drops them silently, and a 9.9 m length quietly evaporating
#: is the kind of thing this library says out loud. Hence both the explicit
#: filter and :func:`_superseded_warnings`.
_SUPERSEDED_BY_SEGMENTS = frozenset({"length", "bore", "K_minor"})


def _superseded_warnings(edge: PidEdge) -> list[str]:
    """Say which line-level numbers the segment list overrode.

    Worth a line in the run report rather than a silent drop: somebody typed
    those, and if the segments are wrong the stale line-level value is the first
    place to look.
    """
    leftover = sorted(_SUPERSEDED_BY_SEGMENTS & set(edge.params))
    if not leftover:
        return []
    stated = ", ".join(
        f"{name} = {edge.params[name].value:g} {edge.params[name].unit}"
        for name in leftover
    )
    return [
        f"{edge.id}: the run is itemised into {len(edge.segments)} segment(s), "
        f"so the line-level {stated} is superseded and not used"
    ]


def _instance(
    tag: str,
    kind: str,
    model: str,
    params: Mapping[str, Param],
    options: Mapping[str, str],
    *,
    segments: tuple[LineSegment, ...] = (),
) -> HydraulicComponent:
    filled = dict(params)
    for name, (value, unit) in FALLBACKS.get(kind, {}).items():
        if name not in filled:
            filled[name] = Param(
                value,
                unit,
                Provenance.DEFAULT,
                f"not on the drawing; feed-twin fallback for a {kind}",
            )
    from feedtwin.model.spec import SpecError

    try:
        instance = ComponentInstance.build(
            tag,
            kind,
            filled,
            options=_accepted_options(kind, options),
            model=model,
            segments=segments,
        )
    except SpecError as exc:
        # The spec knows the kind ("valve"), not which one; on a drawing with
        # five solenoids that is no help. Named here, where the tag is known.
        raise SpecError(f"{tag}: {exc}") from exc
    return build_component(instance)


def build_network(
    diagram: Diagram,
    *,
    default_temperature: float = 293.15,
    default_fluid: str = "nitrogen",
    engine: object | None = None,
    multiphase: bool = False,
) -> BuiltNetwork:
    """Build a solvable network from a drawing.

    Raises:
        DiagramError: the drawing cannot be a feed system -- no source, or an
            inline symbol with the wrong number of connections. Refused rather
            than patched: a drawing missing its tank solves as an empty system
            and reports zero flow, which looks like an answer.

    Args:
        multiphase: Let the property layer decide phase from ``(p, T)``. Off,
            so a declared liquid is solved as a liquid. See
            :attr:`feedtwin.solve.network.Network.multiphase`.
    """
    by_id = {n.id: n for n in diagram.nodes}
    net = Network(multiphase=multiphase)
    node_of: dict[str, str] = {}
    branches_of: dict[str, tuple[str, ...]] = {}
    instruments: list[Instrument] = []
    tanks: dict[str, TankPorts] = {}
    placements: list[Placement] = []
    actuators: dict[str, str] = {}
    rest: dict[str, float] = {}
    hand: set[str] = set()
    warnings: list[str] = []
    vents: list[str] = []
    vent_ids: set[str] = set()
    unsized: list[tuple[str, str]] = []
    direct: list[tuple[str, str, str]] = []
    into_engine: dict[str, str] = {}
    #: Every network node a drawn line landed on: what tells a disconnect's
    #: plumbed side from its free one when it is mated (_mate_disconnects).
    landed: set[str] = set()

    # Where the pressurant network and the vent stacks reach. Both are ullage
    # side, and a tank must not paint either with its contents.
    # A relief valve (an RV with a set pressure) drawn straight onto a tank
    # relieves its ullage, whatever is drawn beyond it; see _tank_reliefs.
    # So is whatever is drawn off a tank's top port; see _top_port_reach.
    _vent_side = (
        _vent_reach(diagram) | _tank_reliefs(diagram) | _top_port_reach(diagram)
    )
    fluids, temperatures = _fluid_of(diagram, _pressurant_reach(diagram) | _vent_side)
    # Which symbols the pressurant network reaches without passing through a
    # tank. Topology, not fluid identity: on a cold flow the ox tank holds LN2
    # and the pressurant is GN2, so "the line carrying something else is the
    # pressurant one" stops working exactly when you most want it to.
    pressurant = _pressurant_reach(diagram)
    # What the gas supplies hold. Every ullage on the drawing is filled with
    # this, whatever the tanks below them contain.
    # A K-bottle first: a dewar is a liquid supply (a LOX dewar listed before
    # the cart's nitrogen made every ullage on the drawing oxygen), and only a
    # drawing whose only gas source is a dewar takes its species.
    pressurant_species = next(
        (n.fluid for n in diagram.nodes if n.type == "KBOTTLE" and n.fluid),
        next(
            (n.fluid for n in diagram.nodes if n.type == "DEWAR" and n.fluid),
            default_fluid,
        ),
    )
    # Vent lines are ullage lines too; see _vent_reach. So is a tank's relief.
    ullage_side = pressurant | _vent_side

    for node in diagram.nodes:
        if node.drawn_as == "TANK":
            warnings.append(
                f"{node.label or node.id} is drawn as a TANK but holds {node.fluid} "
                "above its critical temperature, so it can only be gas: read as the "
                "pressurant supply (a Pressurant bottle, KBOTTLE). Draw it as one to "
                "make that explicit."
            )

    # 1. Places. Sources are boundaries; junctions and manifolds are free.
    sources = [n for n in diagram.nodes if n.is_source]
    if not sources:
        raise DiagramError(
            f"{diagram.name}: nothing on this drawing declares a pressure. A "
            "feed solve starts at a tank, a K-bottle or a dewar; add one, or "
            "this is a schematic rather than a system."
        )

    for node in diagram.nodes:
        if node.is_annotation or node.is_instrument or node.is_inline:
            continue
        fluid = fluids.get(node.id, default_fluid)
        temperature = _temperature(node, temperatures.get(node.id, default_temperature))
        if node.type == "TANK":
            # The tank symbol's node *is* its ullage, and an ullage holds
            # pressurant, not propellant. Painting it with the tank's contents
            # priced a vent line as liquid oxygen at 1140 kg/m^3 instead of
            # nitrogen at forty -- so venting a tank moved thirty times the mass
            # it should, and the solve had a boundary it could not reconcile.
            fluid = pressurant_species
            temperature = _temperature(node, default_temperature)

        if node.is_source or node.type in SINK_TYPES:
            pressure = _pressure(node)
            if pressure is None and node.type in AMBIENT_TYPES:
                # A vent ends at atmosphere. That is not an assumption worth
                # warning about -- it is what the symbol means.
                pressure = AMBIENT
            if pressure is None:
                default = 500.0 if node.is_source else 350.0
                pressure = default * 6894.757293168361
                warnings.append(
                    f"{node.label} has no pressure on the drawing; assumed "
                    f"{default:.0f} psi."
                )
            net.add_node(node.id, fluid, temperature, pressure=pressure)
        else:
            net.add_node(node.id, fluid, temperature)
        node_of[node.id] = node.id

        if node.type == "TANK":
            # The drawing's pressure and temperature are the tank's *nominal*
            # values -- what is written on the symbol -- and a steady solve
            # takes them as its boundary, which is what a nominal is for. A
            # transient does not: the cockpit starts every tank vented and
            # empty and presses it from the bottle, so a drawing's operating
            # pressure never becomes an initial condition there.
            #
            # A tank is two boundary pressures, not two nodes with a pipe
            # between them. The vessel sets both -- ullage at the top, ullage
            # plus the liquid column at the outlet -- so a connecting branch
            # would be a resistance that does not exist, and a branch with no
            # resistance sits permanently on the derivative floor and stops the
            # whole network converging.
            outlet = f"{node.id}.out"
            contents = fluids.get(node.id, default_fluid)
            liquid_T = _temperature(
                node, temperatures.get(node.id, default_temperature)
            )
            head, head_warnings = _column_head(node, contents, liquid_T)
            warnings.extend(head_warnings)
            base = _pressure(node) or 500.0 * 6894.757293168361
            warnings.extend(_tank_warnings(node, contents, liquid_T, base))
            net.add_node(outlet, contents, liquid_T, pressure=base + head)
            tanks[node.id] = TankPorts(ullage=node.id, outlet=outlet)

    # A dome-loaded regulator is set by a second, hand-loaded one upstream --
    # the dome control regulator. That one is *not* in the flow path: its
    # outlet goes to a dome port and carries almost nothing. So it is lifted
    # out of the network entirely and its setpoint becomes the dome pressure
    # of the regulator it loads, which is what the knob on the stand does.
    dome_loaders = _dome_loaders(diagram)
    built_loaders: dict[str, DomeLoader] = {}
    for loader, loaded in dome_loaders.items():
        warnings.append(
            f"{by_id[loader].label} loads the dome of {by_id[loaded].label}; "
            "read as a setpoint, not as a flow path."
        )

    # 2. Inline symbols become branches with a node spliced either side. The
    #    two lines that met at the symbol will attach to those, not to it.
    for node in diagram.nodes:
        if not node.is_inline or node.id in dome_loaders:
            continue
        kind, model = _kind_and_model(node)
        if node.type == "RV" and kind != "relief_valve":
            # A relief valve is shut until its set pressure, and with no set
            # pressure it never lifts -- which, for the network, is a branch
            # that is not there. It used to be built as a plain Cv valve that is
            # always open: a hole to atmosphere on every tank it guards, so a
            # stand could not hold press at all. Its lines now end at a capped
            # port, exactly like a shut valve's.
            warnings.append(
                f"{node.label} is a relief valve with no set_pressure, so it is "
                "read as shut -- a relief that never lifts. Give it a "
                "set_pressure (and its Cv) to model one that lifts and reseats."
            )
            continue
        fluid = fluids.get(node.id, default_fluid)
        temperature = _temperature(node, temperatures.get(node.id, default_temperature))
        upstream, downstream = f"{node.id}.in", f"{node.id}.out"
        net.add_node(upstream, fluid, temperature)
        net.add_node(downstream, fluid, temperature)
        node_of[node.id] = upstream

        options = dict(node.options)
        params = dict(node.params)
        if node.type == "PR" and options.get("domeLoaded") == "yes":
            params.setdefault(
                "dome_bias",
                Param(50.0, "psi", Provenance.DEFAULT, "dome-loaded; bias unstated"),
            )
            loaded_by = None
            for loader, loaded_id in dome_loaders.items():
                if loaded_id != node.id:
                    continue
                setpoint = by_id[loader].params.get("setpoint")
                if setpoint is not None:
                    params["dome_pressure"] = setpoint
                elif not _hand_loaded(by_id[loader]):
                    continue
                # A loader with no setpoint on the drawing is hand-loaded: the
                # dome knob sets it, through its own outlet.
                actuators[loader] = f"{node.label}.dome"
                built_loaders[loader] = _build_dome_loader(
                    by_id[loader], f"{node.label}.dome", diagram, node_of
                )
                loaded_by = loader
            if loaded_by is None:
                # Nothing drawn loads the dome -- it is filled through a QD, or
                # off-drawing -- so the dome is the operator's setting, and its
                # signal is how they set it: the cockpit's dome knob and Layer
                # X's lockup solve both drive `<tag>.dome`. Without it the dome
                # sat at the drawn value whatever the knob said.
                actuators[node.id] = f"{node.label}.dome"
        component = _instance(node.label, kind, model, params, options)
        net.add_branch(node.id, component, upstream, downstream)
        branches_of[node.id] = (node.id,)
        placements.append(
            Placement(node.id, node.label, node.type, node.x, node.y, fluid)
        )
        if node.type in ACTUATED_VALVE_TYPES:
            actuators[node.id] = f"{node.label}.command"
            rest[node.id] = 1.0 if options.get("failState") == "open" else 0.0
        elif node.type in HAND_VALVE_TYPES:
            actuators[node.id] = f"{node.label}.command"
            hand.add(node.id)

    # 3. Instruments observe. They join the network at the place they clip to.
    for node in diagram.nodes:
        if node.id in dome_loaders:
            placements.append(Placement(node.id, node.label, node.type, node.x, node.y))
        if not node.is_instrument:
            continue
        anchor = _instrument_anchor(node, by_id, node_of, diagram)
        if anchor is None:
            warnings.append(
                f"{node.label} is not clipped to anything and reads nothing."
            )
            continue
        instruments.append(Instrument(node.id, node.label, node.type, anchor))
        placements.append(Placement(node.id, node.label, node.type, node.x, node.y))

    # 4. Lines. An end that landed on an inline symbol is redirected to that
    #    symbol's own node -- into it if the line arrives, out of it if the
    #    line leaves. Unless the direction leaves a symbol one-sided and the
    #    ports say better; see _sides_by_port.
    plumbing: list[PidEdge] = []
    for edge in diagram.edges:
        source = by_id.get(edge.source)
        target = by_id.get(edge.target)
        if source is None or target is None:
            continue
        if source.is_instrument or target.is_instrument:
            continue  # a clip line, not plumbing
        if source.is_annotation or target.is_annotation:
            continue
        if edge.source in dome_loaders or edge.target in dome_loaders:
            continue  # a dome line, not a flow path
        if (source.type == "PR" and edge.source_handle == DOME_HANDLE) or (
            target.type == "PR" and edge.target_handle == DOME_HANDLE
        ):
            # Drawn onto a regulator's dome port: loading gas, not feed. It
            # used to land on the regulator's inlet or outlet like any line,
            # which plumbed the dome-control line -- through its solenoids and
            # the mated disconnects, back to the GSE control regulator -- into
            # the tank press manifold.
            continue
        plumbing.append(edge)
    by_port, port_warnings = _sides_by_port(diagram, plumbing)
    warnings.extend(port_warnings)

    for edge in plumbing:
        source = by_id[edge.source]
        target = by_id[edge.target]
        upstream = _attach(
            source,
            target,
            ullage_side,
            tanks,
            outgoing=by_port.get((edge.id, source.id), True),
        )
        downstream = _attach(
            target,
            source,
            ullage_side,
            tanks,
            outgoing=by_port.get((edge.id, target.id), False),
        )
        if upstream not in net.nodes or downstream not in net.nodes:
            continue
        if upstream == downstream:
            continue
        landed.update((upstream, downstream))

        kind, model = LINE_KINDS.get(edge.line_type, LINE_KINDS["pipe"])
        # Named apart from the symbol loop's `params`/`options` above: this
        # is the line's, and shadowing those two has bitten this file before.
        line_params: Mapping[str, Param] = edge.params
        line_options: Mapping[str, str] = edge.options
        segments = edge.segments.segments
        if segments:
            # The drawing itemised this run, so the itemised model is the one
            # in force and the geometry comes from the segments.
            kind, model = "pipe", "segmented"
            line_params = {
                name: value
                for name, value in edge.params.items()
                if name not in _SUPERSEDED_BY_SEGMENTS
            }
            line_options = _accepted_options(kind, edge.options)
            warnings.extend(edge.segments.warnings)
            warnings.extend(_superseded_warnings(edge))
        elif kind in {"pipe", "flex_hose"} and not (
            "length" in line_params or "bore" in line_params
        ):
            # A line with no size is a direct connection: two parts drawn
            # apart that are screwed together on the stand, a tank's port
            # into its valve. It has no length to lose pressure over, so it is
            # not a branch -- its two ends are one place (see _join_direct).
            # It used to be solved as the fallback tube, 1 m of 9.5 mm, which
            # cost a drawn tank-valve-engine feed 94 psi it does not have.
            if engine is not None and (
                source.type in ENGINE_TYPES or target.type in ENGINE_TYPES
            ):
                # Straight into the injector: the leg starts at this end.
                into_engine[edge.id] = (
                    upstream if target.type in ENGINE_TYPES else downstream
                )
            else:
                direct.append((edge.id, upstream, downstream))
            continue
        elif kind in {"pipe", "flex_hose"} and not (
            "length" in line_params and "bore" in line_params
        ):
            # Half a size: the half the drawing left out is the fallback's.
            unsized.append(
                (edge.id, f"{source.label or source.id} -> {target.label or target.id}")
            )
        component = _instance(
            edge.id, kind, model, line_params, line_options, segments=segments
        )
        net.add_branch(edge.id, component, upstream, downstream)
        branches_of[edge.id] = (edge.id,)

    # 4a. Disconnects paired across the drawing's pages are mated: the rocket
    #     half and the GSE half are one coupling, so their free sides are one
    #     place. A drawing that pairs nothing builds exactly as before.
    mates, mate_warnings = _mate_disconnects(diagram, net, landed)
    warnings.extend(mate_warnings)
    direct.extend(mates)
    mated = tuple((a, b) for a, b in (tuple(m[0].split(":")[1:3]) for m in mates))

    if direct:
        edges_by_id = {e.id: e for e in diagram.edges}
        rename, shorted, kept = _join_direct(net, direct)
        for edge_id, upstream, downstream in kept:
            # Two fixed pressures -- a bottle straight into a tank -- cannot be
            # one place. The line stays a line, on the fallback tube.
            if edge_id.startswith("mate:"):
                _, a, b = edge_id.split(":")
                source, target = by_id[a], by_id[b]
            else:
                line = edges_by_id[edge_id]
                source, target = by_id[line.source], by_id[line.target]
            net.add_branch(
                edge_id,
                _instance(edge_id, "pipe", "darcy", {}, {}),
                upstream,
                downstream,
            )
            branches_of[edge_id] = (edge_id,)
            unsized.append(
                (edge_id, f"{source.label or source.id} -> {target.label or target.id}")
            )
        node_of = {k: rename.get(v, v) for k, v in node_of.items()}
        instruments = [replace(i, node=rename.get(i.node, i.node)) for i in instruments]
        built_loaders = {
            k: replace(v, supply_node=rename.get(v.supply_node, v.supply_node))
            for k, v in built_loaders.items()
        }
        into_engine = {k: rename.get(v, v) for k, v in into_engine.items()}
        for symbol_id in shorted:
            shown = by_id[symbol_id].label if symbol_id in by_id else symbol_id
            warnings.append(
                f"{shown or symbol_id} has both sides joined "
                "directly to the same place, so it carries nothing and is left out."
            )
            branches_of.pop(symbol_id, None)

    # 4b. A valve with one side unplumbed is a vent to atmosphere.
    #
    #     Read off the drawing rather than demanded as a second statement of it
    #     -- see VENTING_VALVE_TYPES for why, and for how the two tools came to
    #     disagree about this.
    for node in diagram.nodes:
        if node.type not in VENTING_VALVE_TYPES or node.id in dome_loaders:
            continue
        if node.id not in net.branches:
            continue  # never became a branch (instrument clip, annotation)
        # Which of the valve's own two nodes did a line actually land on?
        branch = net.branches[node.id]
        attached = {
            end
            for other in net.branches.values()
            if other is not branch
            for end in (other.upstream, other.downstream)
        }
        # Joined straight into the engine: plumbed, by an injector leg that is
        # added below. Missing this read a LOX main drawn into the engine as a
        # vent and dumped the tank overboard at 14 kg/s.
        attached |= set(into_engine.values())
        free = [
            port
            for port in (branch.upstream, branch.downstream)
            if port not in attached
        ]
        if len(free) != 1:
            continue  # plumbed both ends, or undrawn entirely -- not a vent
        port = net.nodes[free[0]]
        if port.pressure is not None:
            continue
        net.nodes[free[0]] = replace(port, pressure=AMBIENT)
        vents.append(node.label or node.id)
        vent_ids.add(node.id)

    resting_shut: list[str] = []
    for valve_id in sorted(hand):
        drawn = str(by_id[valve_id].options.get("normalPosition", "") or "")
        if drawn in {"open", "closed"}:
            rest[valve_id] = 1.0 if drawn == "open" else 0.0
            continue
        # A hand valve open to atmosphere on one side is a vent, a bleed or a
        # dump: shut until a person opens it. Plumbed both sides: isolation.
        rest[valve_id] = 0.0 if valve_id in vent_ids else 1.0
        if valve_id in vent_ids:
            resting_shut.append(by_id[valve_id].label or valve_id)
    if resting_shut:
        warnings.append(
            f"{len(resting_shut)} hand valve(s) open to atmosphere are read as "
            f"shut until opened by hand: {', '.join(resting_shut)}. Give a hand "
            "valve its normal position on the drawing to say otherwise."
        )

    if vents:
        warnings.append(
            f"{len(vents)} valve(s) have one side open and are read as venting "
            f"to atmosphere: {', '.join(sorted(vents))}. That is how a P&ID "
            "draws a vent; add a VENT symbol if you meant something else."
        )

    # 4c. What each node holds, declared from topology rather than guessed
    #     from temperature. The pressurant reach and the vent stacks are gas;
    #     a tank's outlet and everything painted with a tank's contents is
    #     liquid. The property layer's fallback rule -- "below the critical
    #     temperature means liquid" -- is right for LOX and wrong for an
    #     ethanol *vapour* line, and only the drawing knows which is which.
    tank_contents = {fluids.get(tank_id, default_fluid) for tank_id in tanks}
    for drawing_id, anchor in node_of.items():
        if drawing_id in tanks:
            continue
        if drawing_id in ullage_side:
            hint = "gas"
        elif fluids.get(drawing_id, "") in tank_contents:
            hint = "liquid"
        else:
            continue
        for candidate in (anchor, f"{drawing_id}.in", f"{drawing_id}.out"):
            found = net.nodes.get(candidate)
            if found is not None:
                found.phase = hint
    for ports in tanks.values():
        net.nodes[ports.ullage].phase = "gas"
        net.nodes[ports.outlet].phase = "liquid"

    if unsized:

        def wet(edge_id: str) -> bool:
            branch = net.branches.get(edge_id)
            return branch is not None and "liquid" in (
                net.nodes[branch.upstream].phase,
                net.nodes[branch.downstream].phase,
            )

        feeds = [name for edge_id, name in unsized if wet(edge_id)]
        tube = FALLBACKS["pipe"]
        warnings.append(
            f"{len(unsized)} line(s) give only part of their size, or join two "
            "fixed pressures directly, and are solved with feed-twin's fallback "
            f"tube for what is missing ({tube['length'][0]:g} m of "
            f"{tube['bore'][0]:g} mm)"
            + (
                f". Propellant lines among them, which set what the engine "
                f"sees: {', '.join(feeds)}"
                if feeds
                else ""
            )
            + f". All: {', '.join(name for _, name in unsized)}. Give them their size."
        )

    # 5. The engine. Without one it stays a fixed pressure boundary, which is
    #    the honest thing to be: nobody has said what is on the end of the pipe.
    #    With one, its injector face is real -- the lines that arrived at the
    #    symbol now terminate on injector legs, and the chamber node behind them
    #    is driven by the coupled solve rather than by a number somebody typed.
    engine_ports: dict[str, str] = {}
    if engine is not None:
        engine_ports, engine_warnings = _attach_engine(
            net,
            diagram,
            engine,
            fluids,
            temperatures,
            default_temperature,
            into_engine=into_engine,
        )
        warnings.extend(engine_warnings)

    # 6. A tank with no vent valve drawn is vented through the GSE, beyond a
    #    disconnect on its top; see _gse_vents.
    # 6a. Vehicle and ground support (feedtwin.pid.roles), and which ground
    #     tanks load a vehicle tank through the drawing.
    vehicle = vehicle_ids(diagram)
    ground = ground_ids(diagram)
    supplies = _supplies(net, tanks, ground)
    shut_by_hand = frozenset(v for v in hand if rest.get(v, 1.0) < 0.5)
    roles = _valve_roles(
        net,
        diagram,
        actuators,
        tanks,
        fluids,
        engine_ports,
        ground=ground,
        shut=shut_by_hand,
    )
    gse = _gse_vents(net, diagram, tanks, fluids, engine_ports, roles)
    gse_unsized = tuple(qd.id for qd, _ in gse if not {"Cv", "Cd"} & set(qd.params))
    if gse:
        for qd, _ in gse:
            actuators[qd.id] = f"{qd.label}.command"
        roles = _valve_roles(
            net,
            diagram,
            actuators,
            tanks,
            fluids,
            engine_ports,
            gse=frozenset(qd.id for qd, _ in gse),
            ground=ground,
            shut=shut_by_hand,
        )
        warnings.append(
            f"No vent valve is drawn on {_and(sorted(t for _, t in gse))}, "
            f"so {_and(sorted(qd.label for qd, _ in gse))} on the tank top "
            f"{'is' if len(gse) == 1 else 'are'} read as where the GSE vent "
            "couples: a valve to atmosphere the state machine's vent opens. The GSE side is not on the drawing, so "
            "its size is the disconnect's own Cv/Cd if it has one and the "
            "cart's vent valve (the session's setup) otherwise. Draw the vent valve to say what it is."
        )

    return BuiltNetwork(
        network=net,
        tanks=tanks,
        engine_ports=engine_ports,
        node_of=node_of,
        branches_of=branches_of,
        instruments=tuple(instruments),
        placements=tuple(placements),
        actuators=actuators,
        dome_loaders=built_loaders,
        warnings=tuple(warnings),
        valve_roles=roles,
        gse_vents=gse_unsized,
        mated=mated,
        rest=rest,
        hand_valves=frozenset(hand),
        vehicle=None if not ground else vehicle,
        supplies=supplies,
    )


def _mate_disconnects(
    diagram: Diagram, net: Network, landed: set[str]
) -> tuple[list[tuple[str, str, str]], list[str]]:
    """Paired quick-disconnects, as direct connections between their free sides.

    pid-designer has no off-page connector. A line from the rocket page to the
    GSE page is drawn as a disconnect on each page, the two paired through
    ``options.pairedWith`` -- the same coupling the stand has, a half on the
    vehicle and a half on the cart. Read separately, each half has a free side
    and the two pages are two unconnected systems; a GSE drawing then cannot
    feed the vehicle at all. Mated, the free sides are one place and the two
    halves' own losses stay in series.

    Pairing need not be written on both halves (pid-designer saves only the
    half that was edited); two halves naming different partners are a drawing
    error and are left unmated, said so. A half that has lines on both of its
    sides, or none, has no free side to mate and is left as it is.

    Returns ``("mate:<a>:<b>", free side of a, free side of b)`` per pair, in
    the shape of the direct connections ``_join_direct`` takes.
    """
    by_id = {n.id: n for n in diagram.nodes}

    def partner(node: PidNode) -> str:
        found = (node.options.get("pairedWith") or "").strip()
        return "" if found in {"", "none"} else found

    pairs: set[tuple[str, str]] = set()
    warnings: list[str] = []
    for node in diagram.nodes:
        if node.type != "QD":
            continue
        other = partner(node)
        if not other:
            continue
        label = node.label or node.id
        mate = by_id.get(other)
        if mate is None or mate.type != "QD":
            warnings.append(
                f"{label} is paired with {other!r}, which is not a disconnect on "
                "this drawing: left unmated."
            )
            continue
        back = partner(mate)
        if back and back != node.id:
            warnings.append(
                f"{label} is paired with {mate.label or mate.id}, which is paired "
                f"with {back!r}: left unmated. Pair the two halves with each other."
            )
            continue
        a, b = sorted((node.id, mate.id))
        pairs.add((a, b))

    out: list[tuple[str, str, str]] = []
    for a, b in sorted(pairs):
        free: dict[str, list[str]] = {}
        for qd in (a, b):
            ends = (f"{qd}.in", f"{qd}.out")
            free[qd] = [e for e in ends if e in net.nodes and e not in landed]
        lone = [q for q in (a, b) if len(free[q]) != 1]
        if lone:
            warnings.append(
                f"{_and(sorted(by_id[q].label or q for q in lone))} "
                f"{'has' if len(lone) == 1 else 'have'} no single free side to "
                f"couple: {by_id[a].label or a} and {by_id[b].label or b} left unmated."
            )
            continue
        out.append((f"mate:{a}:{b}", free[a][0], free[b][0]))
        pages = {by_id[a].page or "Main", by_id[b].page or "Main"}
        warnings.append(
            f"{by_id[a].label or a} and {by_id[b].label or b} are paired, so they "
            "are read as one mated coupling"
            + (f" joining pages {_and(sorted(pages))}." if len(pages) > 1 else ".")
        )
    return out, warnings


def _join_direct(
    net: Network, direct: list[tuple[str, str, str]]
) -> tuple[dict[str, str], list[str], list[tuple[str, str, str]]]:
    """Make each direct connection's two ends one network node.

    Where one end is a fixed pressure -- a tank port, a bottle, atmosphere --
    the joined place keeps it: a valve screwed into a tank sees the tank. Two
    fixed pressures cannot be one place, so such a line is handed back to be
    built as a line. Returns the renaming (merged node -> the node it became),
    the branches left joining a place to itself (dropped), and the lines kept.
    """
    parent: dict[str, str] = {}

    def find(node: str) -> str:
        while parent.get(node, node) != node:
            node = parent[node]
        return node

    kept: list[tuple[str, str, str]] = []
    for edge_id, a, b in direct:
        ra, rb = find(a), find(b)
        if ra == rb:
            continue
        a_fixed = net.nodes[ra].pressure is not None
        b_fixed = net.nodes[rb].pressure is not None
        if a_fixed and b_fixed:
            kept.append((edge_id, a, b))
            continue
        if b_fixed:
            ra, rb = rb, ra
        parent[rb] = ra

    rename = {node: find(node) for node in parent}
    shorted: list[str] = []
    for branch_id, branch in list(net.branches.items()):
        branch.upstream = rename.get(branch.upstream, branch.upstream)
        branch.downstream = rename.get(branch.downstream, branch.downstream)
        if branch.upstream == branch.downstream:
            del net.branches[branch_id]
            shorted.append(branch_id)
    for node in rename:
        net.nodes.pop(node, None)
    kept = [(e, rename.get(a, a), rename.get(b, b)) for e, a, b in kept]
    return rename, shorted, kept


def _and(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


#: Propellant species read as the oxidiser side of a stand; everything else a
#: tank holds is fuel. Matches the state machines' vocabulary ("LOX ...").
_OXIDISERS = frozenset({"oxygen", "nitrousoxide", "n2o", "hydrogenperoxide"})


def _valve_roles(
    net: Network,
    diagram: Diagram,
    actuators: Mapping[str, str],
    tanks: Mapping[str, TankPorts],
    fluids: Mapping[str, str],
    engine_ports: Mapping[str, str],
    *,
    gse: frozenset[str] = frozenset(),
    ground: frozenset[str] = frozenset(),
    shut: frozenset[str] = frozenset(),
) -> dict[str, frozenset[str]]:
    """What each commandable valve does, from what its two sides reach.

    A valve between the regulated supply and a tank's ullage *is* that tank's
    press valve, whatever the drawing calls it; one between a tank's outlet and
    the engine is its main; one between an ullage and atmosphere is its vent.
    A state machine names its valves in a crew's words ("Fuel Press") and a
    drawing in a draughtsman's ("FU_SOL_R"), and when the words do not meet the
    plumbing still does -- so this is what lets a drawing nobody wrote for the
    table still be driven by it (see :func:`feedtwin.session.statemachine.bind`).

    Each side is walked through pipes, fittings, manifolds, regulators and check
    valves, but not through another commandable valve or a relief, and stops at
    the first fixed pressure it meets. A valve whose sides do not settle one job
    gets no role; nothing is guessed. ``gse`` names disconnects read as GSE
    vents (see :func:`_gse_vents`), which are commandable valves here too.
    """
    # Valves stop a walk; a dome-loaded regulator carries a `.dome` signal and
    # is an actuator too, but the press line runs through it.
    valves = {n.id for n in diagram.nodes if n.type in ACTUATED_VALVE_TYPES} | gse
    # A hand valve resting shut separates what is either side of it, as an
    # actuated valve does; one resting open is a length of pipe.
    stops = valves | shut | {n.id for n in diagram.nodes if n.type == "RV"}
    reach = _reacher(net, diagram, tanks, engine_ports, stops)
    dewars = {n.id for n in diagram.nodes if n.type == "DEWAR"}

    def side(tank: str) -> str:
        return _side(tank, diagram, fluids)

    def job(
        a: dict[str, set[str]], b: dict[str, set[str]], on_ground: bool = False
    ) -> frozenset[str] | None:
        # Ground support first: a cart tank's press and vent are "fill" press
        # and vent ("Fuel Fill Press"), not the flight tank's, and the valve
        # that lets the cart's propellant into a flight tank is its fill.
        flight_in = {t for t in a["ullage"] | a["outlet"] if t not in ground}
        if (
            len(flight_in) == 1
            and ({t for t in b["outlet"] if t in ground} or (b["supply"] & dewars))
            and not b["engine"]
        ):
            return frozenset({side(next(iter(flight_in))), "fill"})
        if len(a["ullage"]) == 1 and next(iter(a["ullage"])) in ground:
            tank = next(iter(a["ullage"]))
            if b["supply"] and not a["supply"]:
                return frozenset({side(tank), "fill", "press"})
            if b["ambient"] and not (a["supply"] or b["supply"]):
                return frozenset({side(tank), "fill", "vent"})
        if (
            len(a["outlet"]) == 1
            and b["ambient"]
            and not (a["ullage"] or a["supply"] or b["supply"])
            and on_ground
        ):
            return frozenset({side(next(iter(a["outlet"]))), "dump"})
        if len(a["ullage"]) == 1 and b["supply"] and not a["supply"]:
            return frozenset({side(next(iter(a["ullage"]))), "press"})
        if len(a["outlet"]) == 1 and b["engine"]:
            return frozenset({side(next(iter(a["outlet"]))), "main"})
        if len(a["ullage"]) == 1 and b["ambient"] and not (a["supply"] or b["supply"]):
            return frozenset({side(next(iter(a["ullage"]))), "vent"})
        if (
            a["supply"]
            and b["ambient"]
            and not any(a[k] or b[k] for k in ("ullage", "outlet"))
        ):
            return frozenset({"gn2", "vent"})
        return None

    roles: dict[str, frozenset[str]] = {}
    for drawing_id in actuators:
        if drawing_id not in valves or drawing_id not in net.branches:
            continue
        # The branch's own ends: a valve joined directly to a tank has the
        # tank's node for a side, not "<id>.in".
        branch = net.branches[drawing_id]
        a, b = reach(branch.upstream), reach(branch.downstream)
        here = drawing_id in ground
        found = job(a, b, here) or job(b, a, here)
        if found:
            roles[drawing_id] = found
    return roles


Reach = Callable[[str], dict[str, set[str]]]


def _supplies(
    net: Network, tanks: Mapping[str, TankPorts], ground: frozenset[str]
) -> dict[str, frozenset[str]]:
    """Ground tanks that load a vehicle tank, and the vehicle tanks each reaches.

    Walked on the built network -- so across mated disconnects -- from the
    ground tank's outlet, through every branch (a fill valve is how the load is
    commanded, not whether the line exists), stopping at any fixed pressure.
    A vehicle tank met on the way is loaded from it.
    """
    if not ground:
        return {}
    adjacent: dict[str, list[str]] = {}
    for branch in net.branches.values():
        adjacent.setdefault(branch.upstream, []).append(branch.downstream)
        adjacent.setdefault(branch.downstream, []).append(branch.upstream)
    port_of = {}
    for tank_id, ports in tanks.items():
        port_of[ports.ullage] = tank_id
        port_of[ports.outlet] = tank_id
    out: dict[str, frozenset[str]] = {}
    for tank_id, ports in tanks.items():
        if tank_id not in ground:
            continue
        reached: set[str] = set()
        seen = {ports.outlet}
        frontier = [ports.outlet]
        while frontier:
            here = frontier.pop()
            for there in adjacent.get(here, ()):
                if there in seen:
                    continue
                seen.add(there)
                owner = port_of.get(there)
                if owner is not None and owner not in ground:
                    reached.add(owner)
                if net.nodes[there].pressure is not None:
                    continue
                frontier.append(there)
        if reached:
            out[tank_id] = frozenset(reached)
    return out


def _reacher(
    net: Network,
    diagram: Diagram,
    tanks: Mapping[str, TankPorts],
    engine_ports: Mapping[str, str],
    stops: set[str] | frozenset[str],
) -> Reach:
    """A walk from one network node to the fixed pressures it meets.

    Through every branch but ``stops``, stopping at each boundary, and sorting
    what it met into tank ullages and outlets, supplies, the engine and
    atmosphere.
    """
    adjacent: dict[str, list[str]] = {}
    for branch in net.branches.values():
        if branch.id in stops:
            continue
        adjacent.setdefault(branch.upstream, []).append(branch.downstream)
        adjacent.setdefault(branch.downstream, []).append(branch.upstream)

    ullage = {ports.ullage: tank for tank, ports in tanks.items()}
    outlet = {ports.outlet: tank for tank, ports in tanks.items()}
    supply = {n.id for n in diagram.nodes if n.type in {"KBOTTLE", "DEWAR"}}
    engine = {n.id for n in diagram.nodes if n.type in ENGINE_TYPES}
    if engine_ports.get("chamber"):
        engine.add(engine_ports["chamber"])

    def reach(start: str) -> dict[str, set[str]]:
        found: dict[str, set[str]] = {
            "ullage": set(),
            "outlet": set(),
            "supply": set(),
            "engine": set(),
            "ambient": set(),
        }
        seen = {start}
        queue = [start]
        while queue:
            here = queue.pop()
            node = net.nodes.get(here)
            if node is not None and node.pressure is not None:
                if here in ullage:
                    found["ullage"].add(ullage[here])
                elif here in outlet:
                    found["outlet"].add(outlet[here])
                elif here in supply:
                    found["supply"].add(here)
                elif here in engine:
                    found["engine"].add(here)
                elif abs(node.pressure - AMBIENT) < 1.0:
                    found["ambient"].add(here)
                if here != start:
                    continue  # a boundary: what lies beyond it is somebody else's
            for nxt in adjacent.get(here, ()):
                if nxt not in seen:
                    seen.add(nxt)
                    queue.append(nxt)
        return found

    return reach


def propellant_side(species: str) -> str:
    """``lox`` or ``fuel``: which leg of a stand a propellant is on, in the
    state machines' words. The cockpit asks this rather than reading a tank's
    label, which on LE4 is "TK-3" and says nothing."""
    compact = species.lower().replace(" ", "").replace("-", "")
    return "lox" if compact in _OXIDISERS else "fuel"


def _side(tank: str, diagram: Diagram, fluids: Mapping[str, str]) -> str:
    """``lox`` or ``fuel``: which leg of the stand a tank is on."""
    by_id = {n.id: n for n in diagram.nodes}
    return propellant_side(
        fluids.get(tank, "") or (by_id[tank].fluid if tank in by_id else "")
    )


def _gse_vents(
    net: Network,
    diagram: Diagram,
    tanks: Mapping[str, TankPorts],
    fluids: Mapping[str, str],
    engine_ports: Mapping[str, str],
    roles: Mapping[str, frozenset[str]],
) -> list[tuple[PidNode, str]]:
    """Disconnects on a tank's top that are where its GSE vent couples.

    A flight tank often carries no vent valve of its own: the vent line comes
    off the ground cart through a quick-disconnect on the tank's top manifold,
    and the valve that opens it is on the cart. The drawing then shows a QD
    with nothing beyond it -- LE4's QD_OVA and QD_FVA. Read as capped, which a
    disconnected QD is, the tank cannot vent at all: the pad's fill boils its
    ullage up to the critical pressure and the sequence never gets past it.

    So a QD is read as the GSE vent, a valve to atmosphere, when all of these
    hold, and otherwise stays capped exactly as before:

    * one of its ends is plumbed and the other is not;
    * the plumbed end reaches one tank's ullage and nothing else fixed -- no
      outlet, no supply, no engine, no atmosphere (a vent already drawn);
    * no commandable valve on the drawing already vents that leg; and
    * it is the only such QD on that tank.

    Returns each QD read this way with the tank it vents. The network is
    edited in place: the QD's branch becomes a valve and its free end
    atmosphere.
    """
    by_id = {n.id: n for n in diagram.nodes}
    labels = {n.id: n.label or n.id for n in diagram.nodes}
    vented = {
        next(iter(role - {"vent"}))
        for role in roles.values()
        if "vent" in role and len(role) == 2
    }
    stops = {n.id for n in diagram.nodes if n.type in {"ROT", "SOL", "RV"}}
    candidates: dict[str, list[tuple[PidNode, str]]] = {}
    for node in diagram.nodes:
        if node.type != "QD" or node.id not in net.branches:
            continue
        branch = net.branches[node.id]
        attached = {
            end
            for other in net.branches.values()
            if other is not branch
            for end in (other.upstream, other.downstream)
        }
        ends = (branch.upstream, branch.downstream)
        free = [end for end in ends if end not in attached]
        if len(free) != 1 or net.nodes[free[0]].pressure is not None:
            continue
        plumbed = ends[1] if free[0] == ends[0] else ends[0]
        found = _reacher(net, diagram, tanks, engine_ports, stops | {node.id})(plumbed)
        if len(found["ullage"]) != 1 or any(
            found[k] for k in ("outlet", "supply", "engine", "ambient")
        ):
            continue
        tank = next(iter(found["ullage"]))
        if _side(tank, diagram, fluids) in vented:
            continue
        candidates.setdefault(tank, []).append((node, free[0]))

    out: list[tuple[PidNode, str]] = []
    for tank, found_qds in candidates.items():
        if len(found_qds) != 1:
            continue  # which of them the cart couples to is not on the drawing
        node, vent_end = found_qds[0]
        model = "cd" if "Cd" in node.params else "cv"
        net.branches[node.id].component = _instance(
            node.label, "valve", model, node.params, node.options
        )
        net.nodes[vent_end] = replace(
            net.nodes[vent_end], pressure=AMBIENT, phase="gas"
        )
        out.append((node, labels.get(tank, tank)))
    return out


#: Which side of a two-port symbol each of pid-designer's ports is. Its inline
#: symbols (SOL, MAN, ROT, RV, CV, QD, PR) all have exactly ``l`` and ``r``, and
#: its check valve's artwork and checks both say ``l`` is the inlet
#: (``CV_INLET`` in its ``ports.ts``). For a symmetric valve the choice only has
#: to put the two lines on different sides.
PORT_SIDES: Mapping[str, bool] = {"l": False, "r": True}  # True: the outlet


def _sides_by_port(
    diagram: Diagram, plumbing: list[PidEdge]
) -> tuple[dict[tuple[str, str], bool], list[str]]:
    """Where a line's direction cannot say which side of a symbol it is on.

    A line's direction is read as flow -- out of the symbol it leaves, into the
    one it reaches -- which is right for a drawing authored in flow order and is
    kept wherever it works. But pid-designer's lines have no direction ("walking
    any line in either direction", its ``checks.ts``); ``source`` is only the
    end the mouse started at. Draw a press line from the tank to its solenoid
    and both of the solenoid's lines *arrive*: both land on its inlet, the
    outlet hangs open, and step 4b reads the press valve as a vent from the
    regulator to atmosphere.

    So where direction leaves one side of an inline symbol with nothing on it,
    and every line on the symbol says which of its ports it was drawn on, the
    port decides instead. Nothing else changes: a symbol with lines on both
    sides reads exactly as before, ports or no ports.

    Returns ``{(edge id, node id): outgoing}`` overrides, and one warning per
    symbol read this way.
    """
    ends: dict[str, list[tuple[str, bool, str]]] = {}
    for edge in plumbing:
        ends.setdefault(edge.source, []).append((edge.id, True, edge.source_handle))
        ends.setdefault(edge.target, []).append((edge.id, False, edge.target_handle))

    overrides: dict[tuple[str, str], bool] = {}
    warnings: list[str] = []
    for node in diagram.nodes:
        here = ends.get(node.id, [])
        if not node.is_inline or len(here) < 2:
            continue
        if len({outgoing for _, outgoing, _ in here}) != 1:
            continue  # lines on both sides already: the direction works
        ports = {port for _, _, port in here}
        if ports != set(PORT_SIDES):
            continue  # nothing to read, or not pid-designer's two ports
        for edge_id, _, port in here:
            overrides[(edge_id, node.id)] = PORT_SIDES[port]
        drawn = "into" if not here[0][1] else "out of"
        warnings.append(
            f"{node.label or node.id}: every line was drawn {drawn} it, so its "
            "inlet and outlet were read from the ports the lines were drawn on "
            "(l in, r out)."
        )
    return overrides, warnings


def _attach(
    node: PidNode,
    other: PidNode,
    ullage_side: frozenset[str],
    tanks: Mapping[str, TankPorts],
    *,
    outgoing: bool,
) -> str:
    """Which network node a line's end lands on.

    An inline symbol has a node either side, so a line leaving it attaches to
    its outlet and a line arriving attaches to its inlet.

    A tank has two, and the choice is made by *topology*: a line whose other end
    reaches either a gas supply or atmosphere is an ullage line -- pressurant in
    at the top, vent out at the top. Deciding it by fluid instead -- "the line
    carrying something else" -- breaks on both of the cases it is most needed
    for: a cold flow where the ox tank holds LN2 and the pressurant is GN2, and
    any vent at all, whose line carries the tank's own contents.
    """
    if node.is_inline:
        return f"{node.id}.out" if outgoing else f"{node.id}.in"
    ports = tanks.get(node.id)
    if ports is None:
        return node.id
    return ports.ullage if other.id in ullage_side else ports.outlet


def _reach(diagram: Diagram, start: frozenset[str]) -> frozenset[str]:
    """Symbols reachable from these kinds without passing through a vessel.

    A tank is a barrier because it is where the walk's meaning changes: the
    pressurant side of a tank and its liquid side are different places, and a
    search that walked straight through would call the whole system one.
    """
    return _walk(diagram, [n.id for n in diagram.nodes if n.type in start])


def _walk(diagram: Diagram, starts: Iterable[str]) -> frozenset[str]:
    """These symbols and everything they reach short of a vessel or an engine."""
    adjacency: dict[str, list[str]] = {}
    for edge in diagram.edges:
        adjacency.setdefault(edge.source, []).append(edge.target)
        adjacency.setdefault(edge.target, []).append(edge.source)
    types = {n.id: n.type for n in diagram.nodes}

    seen: set[str] = set()
    queue = list(starts)
    seen.update(queue)
    while queue:
        current = queue.pop(0)
        for neighbour in adjacency.get(current, []):
            if neighbour in seen:
                continue
            seen.add(neighbour)
            if types.get(neighbour) not in {"TANK", "ENGINE", "INJECTOR"}:
                queue.append(neighbour)
    return frozenset(seen)


def _pressurant_reach(diagram: Diagram) -> frozenset[str]:
    """Symbols the gas supplies reach without going through a tank."""
    return _reach(diagram, frozenset({"KBOTTLE", "DEWAR"}))


def _vent_reach(diagram: Diagram) -> frozenset[str]:
    """Symbols that reach atmosphere without going through a tank.

    A tank's vent belongs on its **ullage**, not its outlet, and nothing about
    the fluid says so -- a LOX tank's vent line carries oxygen exactly like its
    feed line does. Topology settles it: the line that ends at atmosphere is
    the one that takes gas off the top.

    Landing it on the liquid side instead is silent and ruinous. The tank never
    relieves, so filling one compresses its ullage to hundreds of psi, and a
    vent state does nothing at all -- which is most of what a pad sequence is
    for."""
    return _reach(diagram, AMBIENT_TYPES)


def _top_port_reach(diagram: Diagram) -> frozenset[str]:
    """What is drawn off a tank's top port, and what that reaches short of a
    vessel.

    Topology alone reads a tank line as ullage when it reaches a supply or
    atmosphere. A manifold on the tank's top carrying only a transducer, a
    capped vent disconnect and a relief reaches neither, so it landed on the
    tank's *liquid outlet*: LE4's LOX vent manifold read as full of liquid, its
    transducer read the outlet, and the disconnect the GSE vents through could
    only ever have dumped LOX. The port the line was drawn on says where it is.
    Only an upright tank's ``t`` ports (a turned-over tank's ``b`` ports) are
    read this way; at any other turn the port says nothing about up, and
    topology decides as before.
    """
    tanks = {n.id: n for n in diagram.nodes if n.type == "TANK"}
    types = {n.id: n.type for n in diagram.nodes}

    def on_top(tank: PidNode, handle: str) -> bool:
        side, number = handle[:1], handle[1:]
        if side not in {"t", "b"} or not (number == "" or number.isdigit()):
            return False
        if tank.rotation == 0.0:
            return side == "t"
        if tank.rotation == 180.0:
            return side == "b"
        return False

    starts: set[str] = set()
    for edge in diagram.edges:
        for end, handle, other in (
            (edge.source, edge.source_handle, edge.target),
            (edge.target, edge.target_handle, edge.source),
        ):
            tank = tanks.get(end)
            if tank is None or not on_top(tank, handle):
                continue
            if types.get(other) not in {"TANK", "ENGINE", "INJECTOR"}:
                starts.add(other)
    return _walk(diagram, starts) if starts else frozenset()


def _tank_reliefs(diagram: Diagram) -> frozenset[str]:
    """Relief valves -- RVs that declare a ``set_pressure`` -- drawn onto a tank.

    They relieve the ullage. A relief exhausting through its own free port has
    no VENT symbol for :func:`_vent_reach` to find, so without this its line
    landed on the tank's *outlet* and the relief would have dumped liquid. An RV
    with no set pressure is not a relief model and keeps its old attachment.
    """
    tanks = {n.id for n in diagram.nodes if n.type == "TANK"}
    reliefs = {
        n.id for n in diagram.nodes if n.type == "RV" and "set_pressure" in n.params
    }
    found: set[str] = set()
    for edge in diagram.edges:
        if edge.source in reliefs and edge.target in tanks:
            found.add(edge.source)
        elif edge.target in reliefs and edge.source in tanks:
            found.add(edge.target)
    return frozenset(found)


def _build_dome_loader(
    node: PidNode,
    signal: str,
    diagram: Diagram,
    node_of: Mapping[str, str],
) -> DomeLoader:
    """Build the control regulator and note which node supplies it.

    Its supply is whatever it is drawn connected to that is not the dome it
    loads -- normally the same manifold the dome regulator feeds from, which is
    the whole reason its outlet moves during a burn.
    """
    supply = ""
    # Its inlet port first: on a dome line drawn through solenoids and a mated
    # disconnect, the first line found can be the dome side.
    touching = sorted(
        (e for e in diagram.edges if node.id in (e.source, e.target)),
        key=lambda e: (e.target_handle if e.target == node.id else e.source_handle)
        != "l",
    )
    for edge in touching:
        other = edge.source if edge.target == node.id else edge.target
        if other and other in node_of:
            supply = node_of[other]
            break
    kind, model = BRANCH_KINDS.get(node.type, ("regulator", "droop"))
    component = _instance(
        node.label, kind, model, dict(node.params), dict(node.options)
    )
    return DomeLoader(
        id=node.id, component=component, signal=signal, supply_node=supply
    )


def _hand_loaded(node: PidNode) -> bool:
    """A regulator the drawing gives no setting at all: set by a hand on its
    knob, not by a number on the sheet (GSE regulators usually are)."""
    return node.type == "PR" and not ({"setpoint", "dome_pressure"} & set(node.params))


def _dome_loaders(diagram: Diagram) -> dict[str, str]:
    """``{control regulator id: the regulator whose dome it loads}``.

    A regulator drawn connected to a dome-loaded regulator, where the second
    declares ``domeLoaded: yes``, is loading its dome. Anything more clever --
    inferring it from geometry, or from which port a line lands on -- would
    guess; this reads what the drawing states.
    """
    regulators = {n.id: n for n in diagram.nodes if n.type == "PR"}
    loaded = {n.id for n in regulators.values() if n.options.get("domeLoaded") == "yes"}
    out: dict[str, str] = {}
    for edge in diagram.edges:
        for a, b in ((edge.source, edge.target), (edge.target, edge.source)):
            if a in regulators and a not in loaded and b in loaded:
                out[a] = b
    # A dome line is often longer than one line: the control regulator on the
    # GSE cart, its solenoid, a mated disconnect, the vehicle's dome solenoid,
    # then the dome port. Walk it from the port -- the line drawn on the
    # regulator's ``dome`` handle -- through junctions, valves and paired
    # disconnects, and the one regulator it reaches is the loader. Stops at
    # vessels, the engine and reliefs; more than one regulator is ambiguous and
    # left as the operator's knob.
    by_id = {n.id: n for n in diagram.nodes}
    adjacent: dict[str, set[str]] = {}
    for edge in diagram.edges:
        adjacent.setdefault(edge.source, set()).add(edge.target)
        adjacent.setdefault(edge.target, set()).add(edge.source)
    for node in diagram.nodes:
        mate = str(node.options.get("pairedWith", "") or "").strip()
        if node.type == "QD" and mate and mate != "none" and mate in by_id:
            adjacent.setdefault(node.id, set()).add(mate)
            adjacent.setdefault(mate, set()).add(node.id)
    barrier = {"TANK", "KBOTTLE", "DEWAR", "RV", "VENT"} | ENGINE_TYPES
    for b in sorted(loaded - set(out.values())):
        starts = [
            edge.target if edge.source == b else edge.source
            for edge in diagram.edges
            if (edge.source == b and edge.source_handle == DOME_HANDLE)
            or (edge.target == b and edge.target_handle == DOME_HANDLE)
        ]
        found: set[str] = set()
        seen = {b}
        frontier = list(starts)
        while frontier:
            here = frontier.pop()
            if here in seen or here not in by_id:
                continue
            seen.add(here)
            kind = by_id[here].type
            if kind == "PR":
                found.add(here)
                continue
            if kind in barrier:
                continue
            frontier.extend(adjacent.get(here, ()))
        if len(found) == 1:
            out[found.pop()] = b
    return out


def _attach_engine(
    net: Network,
    diagram: Diagram,
    engine: object,
    fluids: Mapping[str, str],
    temperatures: Mapping[str, float],
    default_temperature: float,
    *,
    into_engine: Mapping[str, str] = {},
) -> tuple[dict[str, str], list[str]]:
    """Replace the engine boundary with a real injector face and chamber.

    The drawing says *where* the engine is and which lines reach it; the engine
    config says what it is. Neither alone is enough, which is why this needs
    both and why the symbol carries a reference rather than a copy of the
    injector geometry -- a drawing is not where a datasheet lives.

    Which leg is which is decided by the fluid on the line, not by the order the
    lines were drawn in. Getting that backwards would feed oxidiser through the
    fuel orifices, which is smaller, so the model would quietly run rich.
    """
    from feedtwin.engine.component import injector_legs

    warnings: list[str] = []
    labels = {n.id: n.label or n.id for n in diagram.nodes}
    symbol = next((n for n in diagram.nodes if n.type in ENGINE_TYPES), None)
    if symbol is None:
        return {}, [
            "An engine config was supplied but the drawing has no engine "
            "symbol to attach it to, so the run is uncoupled: nothing sets "
            "chamber pressure and the feed system discharges to whatever the "
            "drawing's end pressure says."
        ]

    ox_leg, fuel_leg = injector_legs(engine)  # type: ignore[arg-type]
    ox_species = getattr(engine, "oxidiser").propellant
    fuel_species = getattr(engine, "fuel").propellant

    chamber = f"{symbol.id}.chamber"
    if chamber not in net.nodes:
        net.add_node(
            chamber,
            fluids.get(symbol.id, ox_species),
            temperatures.get(symbol.id, default_temperature),
            pressure=net.nodes[symbol.id].pressure,
        )

    ports: dict[str, str] = {"chamber": chamber}

    # Each line that arrived at the engine now stops at an injector face, and an
    # injector leg carries it the rest of the way into the chamber.
    for edge in diagram.edges:
        other = (
            edge.source
            if edge.target == symbol.id
            else edge.target if edge.source == symbol.id else None
        )
        if other is None or (
            edge.id not in net.branches and edge.id not in into_engine
        ):
            continue
        species = fluids.get(other, "")
        if species == ox_species:
            leg, side = ox_leg, "oxidiser"
        elif species == fuel_species:
            leg, side = fuel_leg, "fuel"
        else:
            # Silence here was a real trap: a line whose fluid matches neither
            # propellant used to be skipped, leaving the engine with one leg
            # and a mixture ratio computed against a zero. Every number
            # downstream stayed plausible.
            warnings.append(
                f"The line from {labels.get(other, other)} reaches the "
                f"engine carrying {species or 'nothing identifiable'}, which is "
                f"neither {ox_species} nor {fuel_species}. It is not connected "
                "to an injector leg. Check the fluid on that line, or on the "
                "tank that feeds it."
            )
            continue

        if edge.id in into_engine:
            # Drawn straight into the engine with no line between: the
            # injector leg starts at the part it is joined to.
            branch_id = f"{symbol.id}.{side}.injector"
            if branch_id not in net.branches:
                net.add_branch(branch_id, leg, into_engine[edge.id], chamber)
            ports[side] = branch_id
            continue
        face = f"{symbol.id}.{side}"
        if face not in net.nodes:
            # The face is at the temperature of the line arriving at it, not
            # the engine symbol's. An engine is a barrier in the fluid walk, so
            # it is painted by whichever propellant reached it first -- and
            # inheriting that would ask the property layer for ethanol at 90 K,
            # which is a solid.
            net.add_node(
                face,
                species,
                temperatures.get(other, default_temperature),
            )
            net.nodes[face].phase = "liquid"
        branch = net.branches[edge.id]
        if branch.downstream == symbol.id:
            branch.downstream = face
        elif branch.upstream == symbol.id:
            branch.upstream = face

        branch_id = f"{symbol.id}.{side}.injector"
        if branch_id not in net.branches:
            net.add_branch(branch_id, leg, face, chamber)
        ports[side] = branch_id

    for side, species in (("oxidiser", ox_species), ("fuel", fuel_species)):
        if side not in ports:
            warnings.append(
                f"No line reaching {symbol.label} carries {species}, so the "
                f"engine has no {side} leg. The chamber cannot be solved from "
                "the feed system this way -- the run will report an uncoupled "
                "boundary rather than a mixture ratio taken against a missing "
                "flow."
            )

    # The old boundary node is now behind the injector and takes no part.
    if "oxidiser" in ports or "fuel" in ports:
        for branch in net.branches.values():
            if symbol.id in (branch.upstream, branch.downstream):
                break
        else:
            net.nodes.pop(symbol.id, None)
    return ports, warnings


def _column_head(
    node: PidNode, fluid: str, temperature: float
) -> tuple[float, list[str]]:
    """Static head of the liquid column [Pa], ``rho g h``, and what was assumed.

    The level comes from the tank's own geometry -- the drawn volume and bore,
    2:1 heads, filled to :data:`STATIC_HEAD_FILL` -- inverted the same way the
    cockpit inverts it, so the two agree. A metre of LOX is about 1.6 psi:
    small against a 500 psi tank and not nothing against a 130 psi feed-line
    budget.

    This used to carry a factor of 0.75 and an assumed 152 mm bore with no
    provenance on either. The bore is now the drawing's, and the fill fraction
    is a named constant with a stated basis, and both are reported when a
    default is used.
    """
    notes: list[str] = []
    label = node.label or node.id
    volume = node.params.get("volume")
    diameter = node.params.get("diameter")
    litres = volume.si if volume is not None else DEFAULT_TANK_LITRES
    bore = diameter.si if diameter is not None else DEFAULT_TANK_BORE
    if volume is None:
        notes.append(
            f"{label} has no volume on the drawing; its static head assumes "
            f"{DEFAULT_TANK_LITRES * 1e3:.1f} L."
        )
    if diameter is None:
        notes.append(
            f"{label} has no diameter on the drawing; its static head assumes a "
            f"{DEFAULT_TANK_BORE * 1e3:.0f} mm bore."
        )
    geometry = cylindrical_from_volume(litres, bore)
    level = level_of_volume(geometry, STATIC_HEAD_FILL * geometry.total_volume)
    try:
        from feedtwin.props import Fluid

        density = Fluid(fluid).get("rho", T=temperature, q=0.0)
    except Exception:  # noqa: BLE001 - a property gap must not stop a build
        density = 1000.0
        notes.append(
            f"{label}: no liquid density for {fluid} at {temperature:.0f} K; its "
            "static head assumes water."
        )
    return density * 9.80665 * level, notes


#: Roles pid-designer colours a line by. They are not species -- "fuel" is a
#: role, ethanol is a fluid -- but a drawing that carries only the role still
#: says something useful, and saying nothing about it is worse than saying it is
#: not enough.
FLUID_ROLES = frozenset({"fuel", "lox", "oxidizer", "pressurant"})


def _tank_warnings(
    node: PidNode, fluid: str, temperature: float, pressure: float
) -> list[str]:
    """Things about a propellant tank that are almost certainly a drawing gap.

    Two of them, and the second is the one that costs an afternoon.

    A tank with **no fluid** on the drawing takes the network default, which is
    nitrogen. Downstream of a tank that is the whole leg, so a silent default
    here quietly reprices an entire propellant line.

    A tank whose fluid is **not liquid at its stated temperature** is nearly
    always a missing temperature rather than a design choice. Oxygen at the
    ambient default is a gas at about 40 kg/m^3 where liquid oxygen is 1140 --
    a factor of thirty on every density, and therefore on every flow, in a
    system that still converges and still reports plausible numbers. The
    saturation temperature is named because that is the number the drawing is
    missing.
    """
    out: list[str] = []
    label = node.label or node.id

    if not node.fluid:
        role = node.role
        hint = (
            f" The drawing colours it {role!r}, which is a role rather than a "
            "fluid -- set the fluid itself."
            if role in FLUID_ROLES
            else ""
        )
        out.append(
            f"{label} does not say what it holds, so it is being solved as "
            f"{fluid}.{hint}"
        )
        return out

    try:
        from feedtwin.props import Fluid

        probe = Fluid(fluid)
        if probe.phase(p=pressure, T=temperature).is_liquid_like:
            return out
        if node.params.get("temperature") is not None:
            # Stated, and still a gas: not a missing temperature but a vessel
            # of gas drawn with the propellant-tank symbol. pid-designer offers
            # "copv" as a tank *wall material*, which makes this easy to do --
            # and then nothing on the drawing supplies the press lines.
            out.append(
                f"{label} holds {fluid} at {temperature:.0f} K, which is a gas, "
                "and is drawn as a TANK, so it is read as a propellant tank and "
                "nothing on the drawing supplies the press lines. If it is the "
                "pressurant, draw it as a Pressurant bottle (KBOTTLE)."
            )
            return out
        saturation = probe.get("T", p=pressure, q=0.0)
    except Exception:  # noqa: BLE001 - a property gap must not stop a build
        return out

    out.append(
        f"{label} holds {fluid} at the assumed {temperature:.0f} K, where it is "
        f"a gas, not a liquid. At {pressure / 6894.757293168361:.0f} psi it "
        f"condenses at about {saturation:.0f} K. If this is a propellant tank "
        "the drawing is missing its temperature, and every density and flow on "
        "that leg is wrong by the ratio of gas to liquid."
    )
    return out


def _kind_and_model(node: PidNode) -> tuple[str, str]:
    """Which catalogue component and fidelity model a symbol becomes.

    The table is :data:`BRANCH_KINDS`; the one thing that moves it is how the
    drawing gave the coefficient. A valve or a check valve with a ``Cd`` is
    the ``cd`` model -- the number the team measured, not the Cv the drawing
    derived beside it for readers that could not. A disconnect is a fitting
    with a K unless the drawing gave it a coefficient, in which case it is a
    full-open valve, which is what a QD is hydraulically.
    """
    kind, model = BRANCH_KINDS[node.type]
    if node.type == "RV" and "set_pressure" in node.params:
        # A relief that says when it lifts is a relief. One that does not stays
        # the Cv valve it always was (and build_network says so).
        return "relief_valve", "spring"
    has_cd = "Cd" in node.params
    has_cv = "Cv" in node.params
    if node.type == "QD" and (has_cd or has_cv):
        return "valve", "cd" if has_cd else "cv"
    if kind in {"valve", "check_valve"} and has_cd:
        return kind, "cd"
    return kind, model


def _pressure(node: PidNode) -> float | None:
    param = node.params.get("pressure")
    if param is None and node.type in ENGINE_TYPES:
        # pid-designer's engine symbol asks for "Chamber pressure" and saves it
        # as `chamber_pressure`; the drawings written by hand say `pressure`.
        param = node.params.get("chamber_pressure")
    return param.si if param is not None else None


def _temperature(node: PidNode, fallback: float) -> float:
    param = node.params.get("temperature")
    return param.si if param is not None else fallback


def _instrument_anchor(
    node: PidNode,
    by_id: Mapping[str, PidNode],
    node_of: Mapping[str, str],
    diagram: Diagram,
) -> str | None:
    """Which network node a transducer reads.

    Its declared clip first; failing that, whatever it is drawn connected to.

    A transducer clipped to an inline symbol reads that symbol's **upstream**
    side by default, because that is the side most taps are on -- a regulator's
    inlet gauge, a valve's supply side.

    ``options.side = "downstream"`` reads the other one, and the stand has a real
    need for it: a main valve's *downstream* PT is the pressure that sets
    injector delta-p, and it is one of the numbers a propulsion engineer looks at
    first. Without this the only clip that resolved past a main valve was the
    ENGINE symbol -- which is a fixed-pressure boundary at the chamber, so the
    gauge read the design chamber pressure forever, including at rest with the
    stand cold and every valve shut. That is how PT-OX-DN and PT-FU-DN came to
    sit at 420 psi on a stand holding nothing.
    """
    if node.attached_to and node.attached_to in node_of:
        anchor = node_of[node.attached_to]
        if node.options.get("side", "upstream") == "downstream":
            target = by_id.get(node.attached_to)
            if target is not None and target.is_inline:
                return f"{target.id}.out"
        return anchor
    for edge in diagram.edges:
        other = (
            edge.target
            if edge.source == node.id
            else edge.source if edge.target == node.id else None
        )
        if other is not None and other in node_of:
            return node_of[other]
    return None


def _fluid_of(
    diagram: Diagram, ullage_side: frozenset[str] = frozenset()
) -> tuple[dict[str, str], dict[str, float]]:
    """Spread each source's declared fluid *and its temperature* through what it
    reaches.

    The temperature travels with the fluid, and it has to. A feed line
    downstream of a LOX tank carries oxygen at 90 K; inherit the species and
    leave the temperature at an ambient default and the line is solved as
    *gaseous* oxygen at 46 kg/m^3 instead of liquid at 1140 -- a factor of 25
    in density, which shows up as a flow rate that is confidently wrong rather
    than obviously so.

    The same walk pid-designer does on the drawing, repeated here rather than
    imported, because the drawing may arrive from a file rather than from the
    app. Barriers stop it: an engine has fuel on one port and oxidiser on the
    other, and a walk that carried on through would paint the whole fuel side
    as oxidiser.
    """
    # A tank is a barrier for the same reason an engine is: two different
    # fluids meet there legitimately. Pressurant arrives at the ullage and
    # propellant leaves the bottom, so a walk that carried on through would
    # paint the whole pressurant network as LOX -- and then every line from
    # the bottle to the tank would land on the tank's liquid side, leaving the
    # ullage with nothing attached to it.
    barriers = {"ENGINE", "INJECTOR", "TANK"}
    adjacency: dict[str, list[str]] = {}
    for edge in diagram.edges:
        adjacency.setdefault(edge.source, []).append(edge.target)
        adjacency.setdefault(edge.target, []).append(edge.source)

    types = {n.id: n.type for n in diagram.nodes}
    out: dict[str, str] = {}
    temps: dict[str, float] = {}

    def spread(seeds: list[PidNode], skip: frozenset[str] = frozenset()) -> None:
        # Seeds are enqueued unconditionally: what a symbol *declares* always
        # wins over what reached it. A tank painted nitrogen because the
        # pressurant line got there first is a tank whose own contents have
        # been overwritten by the gas pushing on them.
        queue: list[tuple[str, str, float]] = []
        for seed in seeds:
            declared = seed.params.get("temperature")
            queue.append((seed.id, seed.fluid, declared.si if declared else 0.0))
        while queue:
            current, fluid, temperature = queue.pop(0)
            for neighbour in adjacency.get(current, []):
                if neighbour in skip:
                    continue
                known = out.get(neighbour)
                if known is not None:
                    # Already painted. If it was painted by a *declaration*
                    # rather than by this walk, it may still be missing a
                    # temperature -- a drawing that labels every valve with its
                    # fluid, which is good practice, turns each one into a seed
                    # that carries no temperature of its own. Skipping it
                    # outright pins the whole line downstream at the ambient
                    # default, so a LOX feed solves as gaseous oxygen at 40
                    # kg/m^3 instead of liquid at 1140.
                    #
                    # Only across the *same* fluid: inheriting a temperature
                    # from a line carrying something else is how an ethanol face
                    # ends up at 90 K.
                    if known == fluid and temperature > 0.0 and neighbour not in temps:
                        temps[neighbour] = temperature
                        if types.get(neighbour) not in barriers:
                            queue.append((neighbour, fluid, temperature))
                    continue
                out[neighbour] = fluid
                if temperature > 0.0:
                    temps[neighbour] = temperature
                if types.get(neighbour) not in barriers:
                    queue.append((neighbour, fluid, temperature))

    # Two passes, not one interleaved walk. A single breadth-first search from
    # every source at once assigns by *distance*, so a manifold one hop from the
    # ox tank and three from the bottle comes out as oxygen -- and then the
    # pressurant line into that tank lands on its liquid side. Supplies fill the
    # plumbing between themselves and whatever they feed; tanks then fill what
    # leaves them.
    declared = [n for n in diagram.nodes if n.fluid]
    for node in declared:
        out[node.id] = node.fluid
        own = node.params.get("temperature")
        if own is not None:
            temps[node.id] = own.si
    spread([n for n in declared if n.type != "TANK"])
    # A tank spreads its *contents* down its outlet, and must not spread them up
    # its vent: what leaves the top of a tank is the gas pushing on the
    # propellant, not the propellant. Painting a vent line with the tank's
    # contents priced it as liquid, and a vent then moved thirty times the mass
    # it should.
    spread([n for n in declared if n.type == "TANK"], skip=ullage_side)
    return out, temps
