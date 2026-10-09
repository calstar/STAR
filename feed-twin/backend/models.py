"""What crosses the API.

Ids are **drawing ids** in every frame. The solver works in network ids and the
dashboard works in what somebody clicked on; the translation happens once, on
the way out, so neither side has to know the other's naming.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ArtifactOut(BaseModel):
    id: str
    kind: str
    name: str
    sha256: str
    size: int
    imported_at: str
    source: str
    notes: str = ""
    summary: dict[str, object] = Field(default_factory=dict)
    #: An engine's EngineDesign card, as it describes itself; empty when the
    #: engine has none and fires feedtwin's simplified model.
    card: dict[str, object] = Field(default_factory=dict)


class ImportResult(BaseModel):
    artifact: ArtifactOut
    already_present: bool
    """True when the same bytes were already in the library. Not an error --
    saving from pid-designer twice in a session is normal."""
    card_error: str = ""
    """Why an engine came in without EngineDesign's card, when it did."""


class FreshnessOut(BaseModel):
    """Whether an artifact pulled from a design tool is still what that tool holds."""

    artifact_id: str
    tracked: bool
    """Pulled from a design tool, so there is something to compare with."""
    current: bool | None = None
    """``None`` when the tool could not be asked."""
    detail: str = ""


class Actuator(BaseModel):
    id: str
    tag: str
    signal: str


class AssumptionOut(BaseModel):
    component: str
    parameter: str
    value: float
    unit: str
    source: str
    reference: str = ""


class ReportOut(BaseModel):
    """What the assembly read, built, and had to invent."""

    diagram: str
    engine: str = ""
    coupled: bool = False
    symbols: int = 0
    lines: int = 0
    nodes: int = 0
    branches: int = 0
    instruments: int = 0
    actuators: int = 0
    unchecked: int = 0
    assumptions: list[AssumptionOut] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    #: Operator overrides that took effect, as assumptions are shown: what,
    #: how much, on whose say-so.
    overrides: list[AssumptionOut] = Field(default_factory=list)
    #: Short hash of `overrides`; empty when there are none.
    overrides_hash: str = ""


class ModelView(BaseModel):
    """The assembly, described without solving anything. The drawing itself is
    `/api/diagram`."""

    diagram_id: str
    engine_id: str = ""
    title: str
    actuators: list[Actuator]
    report: ReportOut
    engine: dict[str, object] = Field(default_factory=dict)
    # Which sheet of the drawing each node is on, by node id. The console
    # splits its panels by it when a stand spans more than one.
    pages: dict[str, str] = Field(default_factory=dict)
    #: What the team has hidden from the console, by node id. Shared, not per
    #: browser; set from the console's menus or the P&ID tab.
    console_hidden: list[str] = Field(default_factory=list)
    #: The order the console draws transducers and tanks in ({pts, tanks}).
    console_order: dict[str, list[str]] = Field(default_factory=dict)
    # Drawing ids off the vehicle (feedtwin.pid.roles.ground_ids): the cart.
    # The console starts its transducers and vessels hidden. Empty for a
    # drawing of the rocket alone, or one built with the GSE ignored.
    ground: list[str] = Field(default_factory=list)
    # The cart's K-bottles and dewars: the console does not show them at all
    # (nobody reads their level on the pad). The cart's tanks it can.
    ground_bottles: list[str] = Field(default_factory=list)
    # Built with the drawn GSE ignored: the vessels that were cut, by label.
    # Empty when nothing was (a drawing of the rocket alone, or the GSE kept).
    ground_cut: list[str] = Field(default_factory=list)


class Channel(BaseModel):
    id: str
    tag: str
    unit: str
    values: list[float]
    #: Where the console's bar turns amber and red [psig], from what the
    #: transducer reads (main._channel_limits); absent, the console falls back
    #: on the DAQ's guesses by tag.
    nop: float | None = None
    meop: float | None = None
    #: Where those two came from, for the bar's hover.
    limits: str = ""


class EngineState(BaseModel):
    chamber_psi: float = 0.0
    mdot_ox: float = 0.0
    mdot_fuel: float = 0.0
    mixture_ratio: float = 0.0
    chamber_temperature_K: float = 0.0
    cstar: float = 0.0
    thrust_N: float = 0.0
    isp_s: float = 0.0
    outside_table: bool = False


class LegOut(BaseModel):
    """One propellant's arrival at the injector face."""

    propellant: str
    mdot_kg_s: float
    density: float
    area_mm2: float
    cd: float
    injector_dp_psi: float
    feed_loss_psi: float
    stiffness: float
    """``dp_injector / p_c`` -- the injector's authority over its own flow."""

    band_min: float = 0.0
    band_max: float = 0.0
    """The stiffness band this side was designed to, read from the engine
    config's own ``injector_dp_ratio_*``. Zero means it stated none, and the
    rule of thumb applies instead."""

    velocity_m_s: float


class BalanceOut(BaseModel):
    """The delivered O/F, split into the face's half and the stand's half.

    ``mixture_ratio == face_ratio * feed_term`` exactly, so the two terms are a
    fault localisation: one is the engine designer's to change, the other the
    stand builder's.
    """

    mixture_ratio: float
    face_ratio: float
    feed_term: float
    design_ratio: float = 0.0
    design_error: float = 0.0
    residual: float = 0.0
    chamber_psi: float = 0.0
    trim_psi: float = 0.0
    oxidiser: LegOut
    fuel: LegOut
    notes: list[str] = Field(default_factory=list)


class SourceOut(BaseModel):
    """A sibling design tool feed-twin can import from."""

    key: str
    label: str
    kind: str
    base_url: str
    reachable: bool = False
    detail: str = ""


class SourceDocument(BaseModel):
    """One design in a sibling tool's store."""

    id: str
    name: str
    owner: str = ""
    owner_name: str = ""
    updated_at: str = ""
    mine: bool = False
    releases: list[str] = Field(default_factory=list)


class StateMachineOut(BaseModel):
    """The stand's states, its legal moves, and how it binds to this drawing."""

    name: str
    states: list[str]
    transitions: dict[str, list[str]]
    """State -> the states reachable from it."""

    actuators: list[str]
    bound: dict[str, str]
    """State-machine actuator -> drawing symbol id."""

    unmatched: list[str]
    """Actuators with no symbol on this drawing. A main valve here is serious:
    nothing commands it, so a fire opens one side only."""

    uncommanded: list[str]
    """Drawing valves the machine never commands; they hold what you set."""

    positions: dict[str, dict[str, bool]]
    """``positions[state][symbol_id]`` — what each state commands, already
    translated into drawing ids so the app never has to do the join."""

    warnings: list[str] = Field(default_factory=list)
    """Problems in the state tables themselves."""


class TankOut(BaseModel):
    """A propellant tank's inventory, which is what makes a sequence mean
    something: an empty tank reads atmosphere, a full one holds what you put
    in it."""

    id: str
    label: str
    pressure_psi: float
    ullage_temperature_K: float
    liquid_mass_kg: float
    liquid_temperature_K: float
    fill_fraction: float
    level_m: float
    #: The metal under the liquid [K]. Warm on a LOX tank means it is still
    #: chilling down and will boil hard if the vent shuts.
    wall_temperature_K: float = 0.0
    surface_temperature_K: float = 0.0
    #: What the drawing says the vessel holds [L], so the panel shows what it
    #: is simulating -- a 44 L K-bottle does not blow down like a 4.7 L COPV.
    volume_L: float = 0.0
    #: ``lox`` or ``fuel`` -- which leg the tank is on, from what it holds. The
    #: pad guide used to find the LOX tank by "ox" in its label, and LE4's are
    #: TK-2 and TK-3: it watched the empty fuel tank for the LOX load forever.
    side: str = ""
    #: A cryogen load is still chilling the wall: what is poured flashes off
    #: and nothing collects yet. The card shows the wall temperature meanwhile.
    chilling: bool = False
    #: What the load is delivering into the tank [g/s]: the dewar's flow
    #: through its fill line, boiling on the wall or collecting. Zero when
    #: nothing is loading.
    fill_flow_g_s: float = 0.0
    #: Where the regulator feeding this tank locks up right now [psig]:
    #: dome + bias - S x the vehicle bottle, so it climbs as the bottle falls.
    #: ``None`` for a tank no regulator feeds.
    lockup_psi: float | None = None


class StudyCaseOut(BaseModel):
    """One study case: the stand with its changes, burned from T-0.

    Pressures are gauge. ``t`` is from Fire, negative through the lead-in."""

    label: str
    x: float | None = None
    changes: list[str] = Field(default_factory=list)
    t0: dict[str, Any] = Field(default_factory=dict)
    t: list[float] = Field(default_factory=list)
    tanks: dict[str, list[float]] = Field(default_factory=dict)
    bottles: dict[str, list[float]] = Field(default_factory=dict)
    chamber_psi: list[float] = Field(default_factory=list)
    thrust_n: list[float] = Field(default_factory=list)
    converged: list[bool] = Field(default_factory=list)
    outcome: dict[str, Any] = Field(default_factory=dict)
    depleted_s: float | None = None
    tripped: str = ""
    failed_ticks: int = 0
    notes: list[str] = Field(default_factory=list)
    error: str = ""


class StudyOut(BaseModel):
    """Where the study has got to, and the cases it has finished."""

    running: bool = False
    progress: float = 0.0
    stage: str = ""
    error: str = ""
    stand: str = ""
    """What it ran on: the stand's name, or the drawing's."""
    engine_name: str = ""
    sweep: str = ""
    horizon_s: float = 0.0
    planned: int = 0
    cases: list[StudyCaseOut] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class LiveKnobOut(BaseModel):
    """A knob as the GSE page draws it: its setting now, and what it turns."""

    id: str
    label: str
    psig: float
    low: float
    high: float
    regulators: list[str] = Field(default_factory=list)
    """Labels of the regulators it sets."""


class SessionOut(BaseModel):
    """One tick of a live stand."""

    id: str
    t: float
    knobs: list[LiveKnobOut] = Field(default_factory=list)
    # The hookup's console names, by drawing (channel) id: what the console
    # shows in place of a valve's or transducer's tag.
    aliases: dict[str, str] = Field(default_factory=dict)
    state: str
    reachable: list[str]
    converged: bool
    pressure_psi: dict[str, float]
    """Instrument readings [psig]. Gauge, like the transducers on the stand: a
    vented line reads 0.0. Every `*_psi` on this API is gauge; the model
    underneath is absolute (see feedtwin.session.gauge.psig)."""
    temperature_K: dict[str, float] = Field(default_factory=dict)
    node_psi: dict[str, float]
    flow_kg_s: dict[str, float]
    open: dict[str, bool]
    held: list[str]
    tanks: list[TankOut]
    bottles: list[TankOut]
    setup: dict[str, float | bool] = Field(default_factory=dict)
    engine: "EngineState | None" = None
    notes: list[str] = Field(default_factory=list)
    #: Why the stand stopped, if it has -- a vessel over its MAWP. Only a
    #: reset clears it.
    tripped: str | None = None
    #: Hash of the operator overrides this stand was built with. A drawing
    #: view whose hash differs is waiting on a Reset.
    overrides_hash: str = ""


class StateEvent(BaseModel):
    """The stand entering a state, for a rule across the plots."""

    t: float
    label: str


class RunOut(BaseModel):
    """A session's trace, in the shape the plots read."""

    message: str
    times_s: list[float]
    channels: list[Channel]
    #: Every state change in the window, from the unthinned history, so a
    #: transition between two kept samples is not lost.
    events: list[StateEvent] = Field(default_factory=list)
    balance: BalanceOut | None = None
    """Why the mixture ratio came out where it did, at the last solved instant.
    ``None`` when there is no engine, or when the drawing gave it only one
    leg -- half an injector cannot be balanced."""


class BurnTankOut(BaseModel):
    id: str
    label: str
    side: str
    start_psi: float
    """Tank pressure when Fire was commanded [psig]."""
    min_psi: float
    """Lowest tank pressure at full flow [psig]."""
    start_kg: float
    end_kg: float


class BurnOut(BaseModel):
    """One burn, totalled from the stand's history (``feedtwin.session.report``).

    Chamber pressure is gauge, like every pressure on the console.
    """

    start_s: float
    end_s: float
    duration_s: float
    burning: bool
    """Still lit at the newest sample: the numbers are running totals."""
    impulse_Ns: float
    thrust_mean_N: float
    thrust_peak_N: float
    thrust_min_N: float
    pc_mean_psi: float
    pc_min_psi: float
    pc_max_psi: float
    of_mean: float
    of_min: float
    of_max: float
    isp_s: float
    cstar_mps: float
    oxidiser_kg: float
    fuel_kg: float
    stiffness_oxidiser_min: float
    stiffness_fuel_min: float
    extrapolated_steps: int
    steps: int
    tanks: list[BurnTankOut] = Field(default_factory=list)
    engine_model: str = ""
    """``card`` (EngineDesign's engine) or ``simplified`` (feedtwin's own)."""
    run_id: str = ""
    """The run this burn was recorded as, once it has ended."""
    series: dict[str, Any] | None = None
    """The recorded traces (``t`` from ignition, ``thrust_N``, ``pc_psig``,
    ``of``, ``tanks``, ``labels``), once recorded."""


class BurnsOut(BaseModel):
    engine_id: str
    engine_model: str
    burns: list[BurnOut]


class KnobOut(BaseModel):
    """A dial on the GSE page and the regulators (drawing ids) it sets [psig]."""

    id: str
    label: str
    regulators: list[str] = Field(default_factory=list)
    psig: float = 500.0
    low: float = 0.0
    high: float = 1000.0


class HookupBody(BaseModel):
    """What a person decided: pinned valves (actuator -> drawing id, "" for
    none) and the knobs."""

    valves: dict[str, str] = Field(default_factory=dict)
    knobs: list[KnobOut] = Field(default_factory=list)
    # What the console calls a valve or transducer, by drawing (channel) id.
    aliases: dict[str, str] = Field(default_factory=dict)


class HookupValveOut(BaseModel):
    id: str
    label: str
    page: str
    role: list[str] = Field(default_factory=list)


class HookupRegulatorOut(BaseModel):
    id: str
    label: str
    kind: str
    """``loader``, ``dome`` or ``plain`` (feedtwin.session.hookup.RegulatorInfo)."""
    page: str
    drawn_psig: float | None = None


class HookupOut(BaseModel):
    """A drawing's hookup, what the twin would suggest, and everything there is
    to link: the state machine's actuators, the drawing's valves and regulators."""

    lineage: str
    saved: bool
    hookup: HookupBody
    suggested: HookupBody
    actuators: list[str]
    valves: list[HookupValveOut]
    regulators: list[HookupRegulatorOut]
    bound: dict[str, str]
    unmatched: list[str]
    uncommanded: list[str]
    by_role: list[str]
    by_user: list[str]
    pages: list[str]
    mated: list[list[str]]


class SolverOut(BaseModel):
    """The solver tab: one entry per tick (feedtwin.session.diagnostics).

    Columns rather than rows, as the plots read them. ``summary`` is what the
    headline says: is this run's arithmetic to be trusted.
    """

    t: list[float]
    couplings: list[int]
    iterations: list[int]
    iterations_max: list[int]
    residual: list[float]
    continuity: list[float]
    converged: list[bool]
    chamber_residual_psi: list[float]
    inventory_kg: list[float]
    mass_error_kg: list[float]
    guard_kg: list[float]
    guard_J: list[float]
    #: Cumulative mass across the boundary, in plus out [kg]: what the mass
    #: error is measured against, tick by tick.
    crossed_kg: list[float] = Field(default_factory=list)
    summary: dict[str, float] = Field(default_factory=dict)


# ------------------------------------------------------------------ drawing


class ParamValue(BaseModel):
    value: float
    unit: str
    source: str
    reference: str = ""


class OverrideOut(ParamValue):
    by: str = ""
    at: str = ""
    #: What the drawing said when the override was made, if it said anything.
    was: ParamValue | None = None


class DrawingParam(BaseModel):
    """One number on one symbol: what the drawing says, what was filled in,
    what somebody typed over it, and which of those the model uses."""

    name: str
    drawing: ParamValue | None = None
    assumed: ParamValue | None = None
    """Filled in by the library because the drawing said nothing."""
    override: OverrideOut | None = None
    effective: ParamValue | None = None
    #: The drawing has changed this value since the override was made.
    stale: bool = False
    #: Superseded by an itemised run; shown, not editable.
    locked: str = ""
    #: Units an override may be written in -- the same dimension.
    units: list[str] = Field(default_factory=list)


class DrawingElement(BaseModel):
    id: str
    kind: str
    """``symbol`` or ``line``."""
    tag: str
    type: str
    role: str = ""
    fluid: str = ""
    params: list[DrawingParam] = Field(default_factory=list)
    options: dict[str, str] = Field(default_factory=dict)
    segments: int = 0
    #: Something the console draws: a gauge, a vessel, a valve.
    on_console: bool = False
    console_hidden: bool = False
    hidden_by: str = ""


class DrawingOut(BaseModel):
    """What feed-twin pulled from a drawing, and what it did to it."""

    diagram_id: str
    key: str
    """The name overrides are kept under; survives a re-import."""
    source: str
    imported_at: str
    elements: list[DrawingElement]
    #: Overrides naming a symbol or line this drawing does not have.
    orphaned: list[str] = Field(default_factory=list)
    overrides_hash: str = ""
    override_sources: list[str] = Field(default_factory=list)
