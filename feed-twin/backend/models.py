"""What crosses the API.

Ids are **drawing ids** in every frame. The solver works in network ids and the
dashboard works in what somebody clicked on; the translation happens once, on
the way out, so neither side has to know the other's naming.
"""

from __future__ import annotations

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


class ImportResult(BaseModel):
    artifact: ArtifactOut
    already_present: bool
    """True when the same bytes were already in the library. Not an error --
    saving from pid-designer twice in a session is normal."""


class Symbol(BaseModel):
    id: str
    tag: str
    type: str
    x: float
    y: float
    fluid: str = ""
    role: str = "component"


class Line(BaseModel):
    id: str
    source: str
    target: str
    kind: str = "pipe"
    fluid: str = ""


class Actuator(BaseModel):
    id: str
    tag: str
    signal: str


class ControlSpec(BaseModel):
    key: str
    label: str
    unit: str
    default: float
    minimum: float
    maximum: float
    step: float
    note: str = ""


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


class ModelView(BaseModel):
    """Everything needed to draw the schematic, without solving anything."""

    diagram_id: str
    engine_id: str = ""
    title: str
    symbols: list[Symbol]
    lines: list[Line]
    actuators: list[Actuator]
    controls: list[ControlSpec]
    fluid_sets: list[str]
    report: ReportOut
    engine: dict[str, object] = Field(default_factory=dict)


class Channel(BaseModel):
    id: str
    tag: str
    unit: str
    values: list[float]


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


class ActuatorOut(BaseModel):
    """A valve on the drawing, and what the state machine calls it."""

    id: str
    tag: str
    signal: str
    role: str = ""
    """The state machine's name for it, empty when nothing commands it."""


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


class StudyTraceOut(BaseModel):
    """One burn from the COPV study, sampled."""

    key: str
    gas: str
    label: str
    litres: float
    collapse: bool
    t: list[float]
    ox_psi: list[float]
    fuel_psi: list[float]
    copv_psi: list[float]
    chamber_psi: list[float]
    thrust_n: list[float]
    converged: list[bool]
    depleted_s: float | None = None
    failed_ticks: int = 0


class StudySweepOut(BaseModel):
    gas: str
    litres: float
    cubic_inches: float
    floor_psi: float
    burn_s: float | None = None
    failed_ticks: int = 0


class StudyOut(BaseModel):
    """Where the COPV study has got to, and what it has produced."""

    running: bool = False
    progress: float = 0.0
    stage: str = ""
    error: str = ""
    #: Set once a run has finished; absent while one is in flight.
    bottle_litres: float = 0.0
    bottle_cubic_inches: float = 0.0
    traces: list[StudyTraceOut] = Field(default_factory=list)
    sweep: list[StudySweepOut] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
    #: What the finished result was run with, so the view can label it.
    gases: list[str] = Field(default_factory=list)
    bigger: bool = False
    collapse: bool = False
    swept: bool = False
    vapour: bool = False
    chilldown: float = 0.0
    line_walls: bool = False


class SessionOut(BaseModel):
    """One tick of a live stand."""

    id: str
    t: float
    state: str
    reachable: list[str]
    converged: bool
    pressure_psi: dict[str, float]
    """Instrument readings [psig]. Gauge, like the transducers on the stand: a
    vented line reads 0.0. Every `*_psi` on this API is gauge; the model
    underneath is absolute (see backend.run.psig)."""
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
    #: A run is being integrated ahead of the display; nothing advances yet.
    computing: bool = False
    #: Why the stand stopped, if it has -- a vessel over its MAWP. Only a
    #: reset clears it.
    tripped: str | None = None
    #: Fraction of that run finished, 0..1.
    progress: float = 0.0
    #: The display is serving a run computed ahead, at wall-clock pace.
    replaying: bool = False


class Frame(BaseModel):
    t: float
    pressure_psi: dict[str, float]
    temperature_K: dict[str, float] = Field(default_factory=dict)
    node_psi: dict[str, float] = Field(default_factory=dict)
    flow_kg_s: dict[str, float] = Field(default_factory=dict)
    open: dict[str, bool] = Field(default_factory=dict)
    engine: EngineState | None = None


class RunOut(BaseModel):
    diagram_id: str
    engine_id: str = ""
    fluid_set: str
    state: str = ""
    """The state machine state this was solved in."""

    converged: bool
    message: str
    elapsed_s: float
    times_s: list[float]
    channels: list[Channel]
    frames: list[Frame]
    controls: dict[str, float] = Field(default_factory=dict)
    report: ReportOut
    balance: BalanceOut | None = None
    """Why the mixture ratio came out where it did, at the last solved instant.
    ``None`` when there is no engine, or when the drawing gave it only one
    leg -- half an injector cannot be balanced."""
