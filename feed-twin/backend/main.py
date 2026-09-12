"""The feed-twin API.

Import a drawing. Import an engine. Assemble them into a model. Run it.

Those are four verbs and four groups of routes, and the shape is deliberate: an
imported artifact is addressed by the hash of its own bytes, an assembly is
reproducible from those hashes, and a run says which assembly produced it. A
result a year old can still name exactly what it was run on.

Run with::

    cd feed-twin
    uvicorn backend.main:app --reload --port 8003
"""

from __future__ import annotations

import json
import threading
from dataclasses import asdict, replace
import time
from pathlib import Path
from typing import Any, Mapping

import httpx
from fastapi import Body, FastAPI, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware

import feedtwin
from feedtwin.pid import INLINE_TYPES, INSTRUMENT_TYPES, SOURCE_TYPES
from feedtwin.pid.network import SINK_TYPES

from backend.assembly import (
    AssemblyError,
    Model,
    assemble,
    diagram_summary,
    engine_from_bytes,
    engine_summary,
)
from feedtwin.engine import EngineDesign
from feedtwin.engine.balance import MixtureBalance, SideBalance
from feedtwin.engine.chamber import ChamberResult
from feedtwin.engine.importer import EngineImportError

from backend import designtools
from backend.designtools import DesignTool, DesignToolError, tools
from backend.library import Artifact, Library, LibraryError
from backend.models import (
    Actuator,
    ArtifactOut,
    AssumptionOut,
    BalanceOut,
    Channel,
    ControlSpec,
    EngineState,
    Frame,
    ImportResult,
    LegOut,
    Line,
    ModelView,
    ReportOut,
    RunOut,
    SessionOut,
    StudyOut,
    StudySweepOut,
    StudyTraceOut,
    SourceDocument,
    StateMachineOut,
    SourceOut,
    TankOut,
    Symbol,
)
from backend.live import FireOptions, Stand, fire, solve_at
from backend.run import PSI, Sample, psig
from backend.session import Sample as SessionSample, Session, Setup
from backend.tunables import describe as describe_tunables, parse_setup, wire_setup
from backend.study import DIAGRAMS as STUDY_DIAGRAMS
from backend.study import StudyRequest, StudyRunner
from backend.study import find_diagram as find_study_diagram
from backend.statemachine import available as sm_available, bind, load_machine

app = FastAPI(title="feed-twin API", version=feedtwin.__version__)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5177",
        "http://127.0.0.1:5177",
        "https://feed-twin.starberkeley.org",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

library = Library()

#: Where a CEA table is looked for. Absent, the chamber falls back to a constant
#: c* and says so in the warnings.
CEA_SEARCH = [
    Path(__file__).resolve().parents[2] / "EngineDesign" / "output" / "cache",
]

#: The stands shipped with the app, seeded into the library on first start so
#: there is something real on screen before anybody imports anything.
SEEDS = Path(__file__).parent / "diagrams"

FLUID_SETS: dict[str, dict[str, tuple[str, float]]] = {
    "hotfire": {},
    "cold-flow": {"oxygen": ("nitrogen", 80.0), "ethanol": ("water", 288.15)},
    "water-flow": {"oxygen": ("water", 288.15), "ethanol": ("water", 288.15)},
}

CONTROLS = [
    ControlSpec(
        key="dome",
        label="Dome control regulator",
        unit="psig",
        default=450.0,
        minimum=200.0,
        maximum=560.0,
        step=10.0,
        note="1092-50 delivers +50 psi",
    ),
    ControlSpec(
        key="open_at",
        label="Main valves open",
        unit="s",
        default=0.20,
        minimum=0.0,
        maximum=1.5,
        step=0.05,
    ),
    ControlSpec(
        key="ox_lead",
        label="Ox lead",
        unit="s",
        default=0.04,
        minimum=-0.20,
        maximum=0.20,
        step=0.01,
    ),
    ControlSpec(
        key="duration",
        label="Run length",
        unit="s",
        default=1.0,
        minimum=0.5,
        maximum=4.0,
        step=0.5,
    ),
]


def _seed() -> None:
    """Put the shipped drawings in the library, once.

    Content-addressed, so this is idempotent -- restarting does not multiply
    them, and a shipped drawing that never changes keeps the same id forever.
    """
    if not SEEDS.is_dir():
        return
    for path in sorted(SEEDS.glob("*.json")):
        data = path.read_bytes()
        try:
            payload = json.loads(data)
        except json.JSONDecodeError:
            continue
        current, _ = library.add(
            data,
            kind="diagram",
            name=path.stem.replace("_", " ").title(),
            source=f"shipped:{path.name}",
            suffix=".json",
            summary=diagram_summary(payload),
        )
        # A shipped drawing that changed on disk has a new id, and every
        # revision before it is still in the library under the same source.
        # Nothing wants those: a picker offering seven "Ethalox Stand"s, six
        # of them without the wall metal the current one carries, is how a
        # run ends up on a drawing nobody meant. Retire them.
        for stale in library.list("diagram"):
            if stale.source == current.source and stale.id != current.id:
                library.remove(stale.id)


_seed()


def _out(artifact: Artifact) -> ArtifactOut:
    return ArtifactOut(**{k: getattr(artifact, k) for k in ArtifactOut.model_fields})


def _cea_for(engine: EngineDesign) -> str:
    """The combustion table for what this engine burns, if one is on disk."""
    ox, fuel = engine.oxidiser.propellant, engine.fuel.propellant
    wanted = {"oxygen": "LOX", "ethanol": "Ethanol", "methane": "CH4"}
    key = f"{wanted.get(ox, ox)}_{wanted.get(fuel, fuel)}"
    for directory in CEA_SEARCH:
        if not directory.is_dir():
            continue
        for candidate in sorted(directory.glob("cea_cache_*.npz")):
            if key.lower() in candidate.stem.lower():
                return str(candidate)
    return ""


def _assemble(
    diagram_id: str, engine_id: str, fluid_set: str, multiphase: bool = False
) -> Model:
    if fluid_set not in FLUID_SETS:
        raise HTTPException(
            status_code=404,
            detail=f"No fluid set {fluid_set!r}. Available: "
            f"{', '.join(sorted(FLUID_SETS))}",
        )
    # Deliberately not cached between requests. An assembly is ~20 ms against a
    # solve of several seconds, and a Model is mutable -- run() writes solved
    # pressures back into its nodes -- so a shared one would alias state across
    # requests to save nothing worth having.
    try:
        return assemble(
            library,
            diagram_id,
            engine_id=engine_id,
            fluid_swap=FLUID_SETS[fluid_set],
            cea_resolver=_cea_for,
            multiphase=multiphase,
        )
    except (AssemblyError, LibraryError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _report(model: Model) -> ReportOut:
    r = model.report
    return ReportOut(
        diagram=r.diagram,
        engine=r.engine,
        coupled=r.coupled,
        symbols=r.symbols,
        lines=r.lines,
        nodes=r.nodes,
        branches=r.branches,
        instruments=r.instruments,
        actuators=r.actuators,
        unchecked=r.unchecked,
        assumptions=[
            AssumptionOut(
                component=a.component,
                parameter=a.parameter,
                value=a.value,
                unit=a.unit,
                source=a.source,
                reference=a.reference,
            )
            for a in r.assumptions
        ],
        warnings=list(r.warnings),
    )


def _leg_out(side: SideBalance, chamber_pressure: float) -> LegOut:
    return LegOut(
        propellant=side.propellant,
        mdot_kg_s=round(side.mdot, 5),
        density=round(side.density, 2),
        area_mm2=round(side.area * 1e6, 3),
        cd=round(side.cd, 4),
        injector_dp_psi=round(side.injector_dp / PSI, 2),
        feed_loss_psi=round(side.feed_loss(chamber_pressure) / PSI, 2),
        stiffness=round(side.stiffness(chamber_pressure), 4),
        band_min=side.band[0],
        band_max=side.band[1],
        velocity_m_s=round(side.velocity, 2),
    )


def _balance(balance: MixtureBalance) -> BalanceOut:
    pc = balance.chamber_pressure
    return BalanceOut(
        mixture_ratio=round(balance.mixture_ratio, 4),
        face_ratio=round(balance.face_ratio, 4),
        feed_term=round(balance.feed_term, 4),
        design_ratio=round(balance.design_ratio, 4),
        design_error=round(balance.design_error, 5),
        residual=balance.residual,
        chamber_psi=round(psig(pc), 2),
        trim_psi=round(balance.trim_pressure() / PSI, 1),
        oxidiser=_leg_out(balance.oxidiser, pc),
        fuel=_leg_out(balance.fuel, pc),
        notes=balance.notes(),
    )


def _role(component_type: str) -> str:
    if component_type == "TANK":
        return "tank"
    if component_type in SOURCE_TYPES:
        return "source"
    if component_type in INLINE_TYPES:
        return "inline"
    if component_type in INSTRUMENT_TYPES:
        return "instrument"
    if component_type in SINK_TYPES:
        return "sink"
    return "component"


# ------------------------------------------------------------------- health


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "healthy"}


@app.get("/api/version")
async def version() -> dict[str, object]:
    return {"stack": feedtwin.stack_versions()}


# ------------------------------------------------------------------ library


@app.get("/api/library")
async def list_artifacts(kind: str | None = None) -> list[ArtifactOut]:
    if kind not in (None, "diagram", "engine"):
        raise HTTPException(status_code=400, detail="kind is 'diagram' or 'engine'")
    return [_out(a) for a in library.list(kind)]  # type: ignore[arg-type]


@app.post("/api/library/diagrams")
async def import_diagram(file: UploadFile) -> ImportResult:
    """Import a P&ID saved out of pid-designer."""
    data = await file.read()
    try:
        payload = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=422,
            detail=f"that file is not a P&ID: expected JSON with 'nodes' and "
            f"'edges' ({exc})",
        ) from exc
    if not isinstance(payload, dict) or "nodes" not in payload:
        raise HTTPException(
            status_code=422,
            detail="that JSON has no 'nodes'. Export the diagram from "
            "pid-designer rather than a browser page save.",
        )
    artifact, existed = library.add(
        data,
        kind="diagram",
        name=Path(file.filename or "diagram").stem.replace("_", " "),
        source="upload",
        suffix=".json",
        summary=diagram_summary(payload),
    )
    return ImportResult(artifact=_out(artifact), already_present=existed)


@app.post("/api/library/engines")
async def import_engine(file: UploadFile) -> ImportResult:
    """Import a Layer-1 engine config from EngineDesign."""
    data = await file.read()
    # Parsed before it is stored, not after. Storing first meant a failed import
    # had to be un-stored -- and when the upload was a *re-*upload of something
    # already in the library, that removal deleted the copy somebody was using.
    try:
        design = engine_from_bytes(data, name=Path(file.filename or "engine").name)
    except (AssemblyError, EngineImportError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    artifact, existed = library.add(
        data,
        kind="engine",
        name=Path(file.filename or "engine").stem.replace("_", " "),
        source="upload",
        suffix=".yaml",
        summary=engine_summary(design),
    )
    return ImportResult(artifact=_out(artifact), already_present=existed)


@app.post("/api/library/pull")
async def pull_from_designer(
    url: str = Body(..., embed=True), name: str = Body("", embed=True)
) -> ImportResult:
    """Fetch a diagram straight out of pid-designer.

    The url is supplied by the caller rather than configured, because there is
    no single pid-designer -- there is a dev one, a deployed one, and whatever
    somebody is running locally.
    """
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(url)
            response.raise_for_status()
            data = response.content
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502, detail=f"could not reach {url}: {exc}"
        ) from exc
    try:
        payload = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=422, detail=f"{url} did not return a diagram ({exc})"
        ) from exc
    artifact, existed = library.add(
        data,
        kind="diagram",
        name=name or "pulled diagram",
        source=f"pid-designer:{url}",
        suffix=".json",
        summary=diagram_summary(payload),
    )
    return ImportResult(artifact=_out(artifact), already_present=existed)


# ------------------------------------------------------------------ sources
#
# The other design tools, imported from directly. See backend.designtools for
# why this beats an export-and-upload loop: identity is carried through, and a
# release is an immutable label on bytes, which is what makes a run's provenance
# mean something a year later.


@app.get("/api/sources")
async def list_sources(request: Request) -> list[SourceOut]:
    """Which design tools this instance can see, and whether they answer."""
    out: list[SourceOut] = []
    for tool in tools().values():
        reachable, detail = True, ""
        try:
            await designtools.list_documents(tool, request.headers)
        except DesignToolError as exc:
            reachable, detail = False, str(exc)
        out.append(
            SourceOut(
                key=tool.key,
                label=tool.label,
                kind=tool.kind,
                base_url=tool.base_url,
                reachable=reachable,
                detail=detail,
            )
        )
    return out


def _tool(key: str) -> DesignTool:
    found = tools().get(key)
    if found is None:
        raise HTTPException(
            status_code=404,
            detail=f"No design tool {key!r}. Known: {', '.join(sorted(tools()))}",
        )
    return found


@app.get("/api/sources/{key}/documents")
async def source_documents(
    request: Request, key: str, with_releases: bool = False
) -> list[SourceDocument]:
    """List what the caller may import from one design tool.

    ``with_releases`` costs one extra call per document, so it is opt-in: the
    picker lists first and asks for releases only for the one being opened.
    """
    tool = _tool(key)
    try:
        found = await designtools.list_documents(tool, request.headers)
        out = [SourceDocument(**d) for d in found]
        if with_releases:
            for doc in out:
                doc.releases = [
                    r["label"]
                    for r in await designtools.releases(
                        tool, doc.id, doc.owner, request.headers
                    )
                ]
    except DesignToolError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return out


@app.get("/api/sources/{key}/documents/{doc_id}/releases")
async def source_releases(
    request: Request, key: str, doc_id: str, owner: str = ""
) -> list[dict[str, str]]:
    try:
        return await designtools.releases(_tool(key), doc_id, owner, request.headers)
    except DesignToolError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/sources/{key}/import")
async def import_from_source(
    request: Request,
    key: str,
    doc_id: str = Body(..., embed=True),
    owner: str = Body("", embed=True),
    release: str = Body("", embed=True),
    name: str = Body("", embed=True),
) -> ImportResult:
    """Pull one design into the library, as the calling user.

    The result is an ordinary artifact: same store, same content addressing. Two
    people pulling the same release get the same id, and a pull that matches
    something already uploaded resolves to the artifact already there.
    """
    tool = _tool(key)
    try:
        data, provenance = await designtools.fetch(
            tool, doc_id, owner=owner, release=release, headers=request.headers
        )
    except DesignToolError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    summary: dict[str, object] = {}
    if tool.kind == "diagram":
        try:
            summary = diagram_summary(json.loads(data.decode("utf-8")))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HTTPException(
                status_code=422, detail=f"{tool.label} returned unreadable JSON ({exc})"
            ) from exc
    else:
        try:
            summary = engine_summary(engine_from_bytes(data, name=name or doc_id))
        except (AssemblyError, EngineImportError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    label = name or doc_id
    artifact, existed = library.add(
        data,
        kind=tool.kind,
        name=f"{label} ({release})" if release else label,
        source=provenance,
        suffix=tool.suffix,
        summary=summary,
    )
    return ImportResult(artifact=_out(artifact), already_present=existed)


@app.delete("/api/library/{artifact_id}")
async def remove_artifact(artifact_id: str) -> dict[str, str]:
    try:
        library.remove(artifact_id)
    except LibraryError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"removed": artifact_id}


# -------------------------------------------------------------------- model


@app.get("/api/model")
async def model_view(
    diagram: str, engine: str = "", fluid_set: str = "hotfire"
) -> ModelView:
    """Assemble and describe, without solving.

    Split from the run so the drawing is on screen the moment a stand is picked,
    and the assembly report -- what was read, what defaulted -- is readable
    before anybody waits on a solve.
    """
    model = _assemble(diagram, engine, fluid_set)
    fluids = {p.id: p.fluid for p in model.built.placements}
    symbols = [
        Symbol(
            id=n.id,
            tag=n.label,
            type=n.type,
            x=n.x,
            y=n.y,
            fluid=fluids.get(n.id, ""),
            role=_role(n.type),
        )
        for n in model.diagram.nodes
        if n.type not in {"TEXT", "REGION"}
    ]
    drawn = {s.id for s in symbols}
    return ModelView(
        diagram_id=diagram,
        engine_id=model.report.engine,
        title=str(model.meta.get("diagram_name", "stand")),
        symbols=symbols,
        lines=[
            Line(
                id=e.id,
                source=e.source,
                target=e.target,
                kind=e.line_type,
                fluid=fluids.get(e.source, ""),
            )
            for e in model.diagram.edges
            if e.source in drawn and e.target in drawn
        ],
        actuators=[
            Actuator(id=d, tag=s.split(".")[0], signal=s)
            for d, s in model.built.actuators.items()
            if not s.endswith(".dome")
        ],
        controls=CONTROLS,
        fluid_sets=sorted(FLUID_SETS),
        report=_report(model),
        engine=engine_summary(model.engine) if model.engine else {},
    )


def _stand(
    diagram: str,
    engine: str,
    fluid_set: str,
    machine: str,
    multiphase: bool = False,
) -> "Stand":
    """A model with the stand's state machine bound to its valves."""
    model = _assemble(diagram, engine, fluid_set, multiphase)
    try:
        loaded = load_machine(machine)
    except (OSError, ValueError) as exc:
        raise HTTPException(
            status_code=404,
            detail=f"No state machine {machine!r}. Shipped: "
            f"{', '.join(sm_available())}. ({exc})",
        ) from exc
    labels = {
        node.id: node.label or node.id
        for node in model.diagram.nodes
        if node.id in model.built.actuators
    }
    return Stand(model=model, machine=loaded, binding=bind(loaded, labels))


#: Instrument types that read a temperature rather than a pressure.
#:
#: A channel used to be `unit="psi"` for every instrument and its values taken
#: from the pressure field, so a thermocouple plotted as a pressure trace in psi.
THERMAL_INSTRUMENTS = frozenset({"TC", "RTD"})


def _channel_unit(instrument_type: str) -> str:
    return "K" if instrument_type in THERMAL_INSTRUMENTS else "psig"


def _frame(stand: Stand, sample: Sample) -> Frame:
    built = stand.model.built
    signals_of = {d: s for d, s in built.actuators.items() if not s.endswith(".dome")}
    return Frame(
        t=round(sample.t, 5),
        pressure_psi={
            i.id: round(psig(sample.pressures[i.node]), 3)
            for i in built.instruments
            if i.node in sample.pressures
        },
        # Thermocouples and RTDs read the node they are clipped to, the same way
        # a transducer does. Every instrument gets an entry -- a PT's own node
        # has a temperature too, and a stand that wants it plotted should not
        # need a second symbol to get it.
        temperature_K={
            i.id: round(sample.temperatures.get(i.node, 0.0), 2)
            for i in built.instruments
            if i.node in sample.temperatures
        },
        node_psi={
            d: round(psig(sample.pressures[n]), 3)
            for d, n in built.node_of.items()
            if n in sample.pressures
        },
        flow_kg_s={
            d: round(sum(sample.flows.get(b, 0.0) for b in ids), 5)
            for d, ids in built.branches_of.items()
        },
        open={d: sample.signals.get(s, 0.0) > 0.5 for d, s in signals_of.items()},
        engine=_engine_state(sample.chamber),
    )


def _engine_state(chamber: ChamberResult | None) -> EngineState | None:
    if chamber is None:
        return None
    return EngineState(
        chamber_psi=round(psig(chamber.pressure), 3),
        mdot_ox=round(chamber.mdot_oxidiser, 5),
        mdot_fuel=round(chamber.mdot_fuel, 5),
        mixture_ratio=round(chamber.mixture_ratio, 4),
        chamber_temperature_K=round(chamber.combustion.temperature, 1),
        cstar=round(chamber.combustion.cstar, 1),
        thrust_N=round(chamber.thrust, 1),
        isp_s=round(chamber.specific_impulse, 2),
        outside_table=chamber.combustion.extrapolated,
    )


# ------------------------------------------------------------------ session
#
# A stand that exists in time. Everything else in this API answers "what would
# happen if"; this one answers "what is happening". See backend.session.

_SESSIONS: dict[str, Session] = {}
_SESSION_LIMIT = 8


def _setup(settings: Mapping[str, Any], base: Setup | None = None) -> Setup:
    """The dials, from whatever the client sent. Anything unsent is kept."""
    return parse_setup(settings, base)


def _session(session_id: str) -> Session:
    found = _SESSIONS.get(session_id)
    if found is None:
        raise HTTPException(
            status_code=404,
            detail=f"No session {session_id!r}. It may have been dropped on a "
            "restart -- start a new one.",
        )
    return found


def _session_out(session: Session, sample: SessionSample) -> SessionOut:
    built = session.model.built
    signals_of = {d: s for d, s in built.actuators.items() if not s.endswith(".dome")}
    return SessionOut(
        id=session.id,
        t=sample.t,
        # The stand's state, not the frame's. While a run is being computed the
        # frame on display is the one from before the command that started it,
        # and offering its transitions would offer the wrong ones.
        state=session.state,
        reachable=session.machine.targets(session.state),
        converged=sample.converged,
        pressure_psi={
            i.id: round(psig(sample.pressures[i.node]), 2)
            for i in built.instruments
            if i.node in sample.pressures
        },
        # Thermocouples and RTDs read the node they are clipped to, the same way
        # a transducer does. Every instrument gets an entry -- a PT's own node
        # has a temperature too, and a stand that wants it plotted should not
        # need a second symbol to get it.
        temperature_K={
            i.id: round(sample.temperatures.get(i.node, 0.0), 2)
            for i in built.instruments
            if i.node in sample.temperatures
        },
        node_psi={
            d: round(psig(sample.pressures[n]), 2)
            for d, n in built.node_of.items()
            if n in sample.pressures
        },
        flow_kg_s={
            d: round(sum(sample.flows.get(b, 0.0) for b in ids), 5)
            for d, ids in built.branches_of.items()
        },
        open={d: sample.signals.get(s, 0.0) > 0.5 for d, s in signals_of.items()},
        held=sorted(session.forced),
        computing=session.computing,
        tripped=session.tripped,
        progress=round(session.progress, 3),
        replaying=session.replaying,
        tanks=[
            TankOut(
                id=sim.id,
                label=sim.label,
                pressure_psi=round(values["pressure_psi"], 2),
                ullage_temperature_K=round(values["ullage_temperature_K"], 1),
                liquid_mass_kg=round(values["liquid_mass_kg"], 3),
                liquid_temperature_K=round(values["liquid_temperature_K"], 1),
                fill_fraction=round(values["fill_fraction"], 4),
                level_m=round(values["level_m"], 4),
                wall_temperature_K=round(values.get("wall_temperature_K", 0.0), 1),
                surface_temperature_K=round(
                    values.get("surface_temperature_K", 0.0), 1
                ),
                volume_L=round(values.get("volume_L", 0.0), 2),
            )
            for sim in session.tanks.values()
            for values in [sample.tanks[sim.id]]
        ],
        bottles=[
            TankOut(
                id=b.id,
                label=b.label,
                pressure_psi=round(psig(b.pressure), 1),
                ullage_temperature_K=round(b.volume.temperature(b.state), 1),
                liquid_mass_kg=round(b.state.mass, 3),
                liquid_temperature_K=0.0,
                fill_fraction=round(b.fraction, 4),
                level_m=0.0,
                volume_L=round(b.volume.volume * 1e3, 2),
            )
            for b in session.bottles.values()
        ],
        setup=wire_setup(session.setup),
        engine=_engine_state(sample.chamber),
    )


def _engine_state(chamber: ChamberResult | None) -> EngineState | None:
    if chamber is None:
        return None
    return EngineState(
        chamber_psi=round(psig(chamber.pressure), 3),
        mdot_ox=round(chamber.mdot_oxidiser, 5),
        mdot_fuel=round(chamber.mdot_fuel, 5),
        mixture_ratio=round(chamber.mixture_ratio, 4),
        chamber_temperature_K=round(chamber.combustion.temperature, 1),
        cstar=round(chamber.combustion.cstar, 1),
        thrust_N=round(chamber.thrust, 1),
        isp_s=round(chamber.specific_impulse, 2),
        outside_table=chamber.combustion.extrapolated,
    )


# ------------------------------------------------------------------ session
#
# A stand that exists in time. Everything else in this API answers "what would
# happen if"; this one answers "what is happening". See backend.session.

_SESSIONS: dict[str, Session] = {}
_SESSION_LIMIT = 8


def _setup(settings: Mapping[str, Any], base: Setup | None = None) -> Setup:
    """The dials, from whatever the client sent. Anything unsent is kept."""
    return parse_setup(settings, base)


def _session(session_id: str) -> Session:
    found = _SESSIONS.get(session_id)
    if found is None:
        raise HTTPException(
            status_code=404,
            detail=f"No session {session_id!r}. It may have been dropped on a "
            "restart -- start a new one.",
        )
    return found


def _session_out(session: Session, sample: SessionSample) -> SessionOut:
    built = session.model.built
    signals_of = {d: s for d, s in built.actuators.items() if not s.endswith(".dome")}
    return SessionOut(
        id=session.id,
        t=sample.t,
        # The stand's state, not the frame's. While a run is being computed the
        # frame on display is the one from before the command that started it,
        # and offering its transitions would offer the wrong ones.
        state=session.state,
        reachable=session.machine.targets(session.state),
        converged=sample.converged,
        pressure_psi={
            i.id: round(psig(sample.pressures[i.node]), 2)
            for i in built.instruments
            if i.node in sample.pressures
        },
        # Thermocouples and RTDs read the node they are clipped to, the same way
        # a transducer does. Every instrument gets an entry -- a PT's own node
        # has a temperature too, and a stand that wants it plotted should not
        # need a second symbol to get it.
        temperature_K={
            i.id: round(sample.temperatures.get(i.node, 0.0), 2)
            for i in built.instruments
            if i.node in sample.temperatures
        },
        node_psi={
            d: round(psig(sample.pressures[n]), 2)
            for d, n in built.node_of.items()
            if n in sample.pressures
        },
        flow_kg_s={
            d: round(sum(sample.flows.get(b, 0.0) for b in ids), 5)
            for d, ids in built.branches_of.items()
        },
        open={d: sample.signals.get(s, 0.0) > 0.5 for d, s in signals_of.items()},
        held=sorted(session.forced),
        computing=session.computing,
        tripped=session.tripped,
        progress=round(session.progress, 3),
        replaying=session.replaying,
        tanks=[
            TankOut(
                id=sim.id,
                label=sim.label,
                pressure_psi=round(values["pressure_psi"], 2),
                ullage_temperature_K=round(values["ullage_temperature_K"], 1),
                liquid_mass_kg=round(values["liquid_mass_kg"], 3),
                liquid_temperature_K=round(values["liquid_temperature_K"], 1),
                fill_fraction=round(values["fill_fraction"], 4),
                level_m=round(values["level_m"], 4),
                wall_temperature_K=round(values.get("wall_temperature_K", 0.0), 1),
                surface_temperature_K=round(
                    values.get("surface_temperature_K", 0.0), 1
                ),
                volume_L=round(values.get("volume_L", 0.0), 2),
            )
            for sim in session.tanks.values()
            for values in [sample.tanks[sim.id]]
        ],
        bottles=[
            TankOut(
                id=b.id,
                label=b.label,
                pressure_psi=round(psig(b.pressure), 1),
                ullage_temperature_K=round(b.volume.temperature(b.state), 1),
                liquid_mass_kg=round(b.state.mass, 3),
                liquid_temperature_K=0.0,
                fill_fraction=round(b.fraction, 4),
                level_m=0.0,
                volume_L=round(b.volume.volume * 1e3, 2),
            )
            for b in session.bottles.values()
        ],
        setup={
            "dome": session.setup.dome_psi,
            "copv_target": session.setup.copv_target_psi,
            "copv_fill_s": session.setup.copv_fill_s,
            "tank_fill_s": session.setup.tank_fill_s,
            "fuel_fill_s": session.setup.fuel_fill_s,
            "bottle_delivered": session.setup.bottle_delivered,
            "fill_stirring": session.setup.fill_stirring,
            "ullage_collapse": session.setup.ullage_collapse,
            "ullage_vapour": session.setup.ullage_vapour,
            "chilldown": session.setup.chilldown,
            "line_walls": session.setup.line_walls,
            "ambient_leak": session.setup.ambient_leak,
        },
        engine=_engine_state(sample.chamber),
        notes=list(sample.notes),
    )


@app.post("/api/session")
async def open_session(
    diagram: str,
    engine: str = "",
    fluid_set: str = "hotfire",
    machine: str = "diablo",
    multiphase: bool = False,
    body: dict[str, Any] | None = Body(None),
) -> SessionOut:
    """Start a stand. Tanks empty, everything at atmosphere.

    ``multiphase`` lets the property layer decide phase from (p, T). Off: a
    declared liquid is solved as a liquid, so a leg cannot come back as a gas at
    a thirtieth of the density. Not ready for flashing work yet.
    """
    settings = dict(body or {})
    stand = _stand(diagram, engine, fluid_set, machine, multiphase)
    session = Session(
        stand.model,
        stand.machine,
        stand.binding,
        state=str(settings.get("state") or "Idle"),
        setup=_setup(settings),
    )
    if len(_SESSIONS) >= _SESSION_LIMIT:
        _SESSIONS.pop(next(iter(_SESSIONS)))
    _SESSIONS[session.id] = session
    return _session_out(session, session.step(1e-3))


@app.post("/api/session/{session_id}/tick")
async def tick_session(
    session_id: str, body: dict[str, Any] | None = Body(None)
) -> SessionOut:
    """Advance the stand by ``dt`` seconds.

    Driven by the client rather than a background task, so the stand stops when
    nobody is watching it -- which is what you want from a tab left open, and
    keeps a session from burning CPU forever after its browser is gone.
    """
    session = _session(session_id)
    settings = dict(body or {})
    dt = float(settings.get("dt") or 0.1)
    try:
        sample = session.step(dt)
    except Exception as exc:  # noqa: BLE001 - surfaced verbatim to the operator
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _session_out(session, sample)


_STUDY = StudyRunner()


def _study_out() -> StudyOut:
    runner = _STUDY
    result = runner.result
    request = runner.request
    out = StudyOut(
        running=runner.running,
        progress=round(runner.progress, 3),
        stage=runner.stage,
        error=runner.error,
        gases=list(request.gases) if request else [],
        bigger=bool(request and request.bigger),
        collapse=bool(request and request.collapse),
        swept=bool(request and request.sweep),
        vapour=bool(request and request.vapour),
        chilldown=float(request.chilldown) if request else 0.0,
        line_walls=bool(request and request.line_walls),
    )
    if result is not None:
        out.bottle_litres = result.bottle_litres
        out.bottle_cubic_inches = result.bottle_cubic_inches
        out.notes = list(result.notes)
        out.traces = [StudyTraceOut(**asdict(t)) for t in result.traces]
        out.sweep = [StudySweepOut(**asdict(p)) for p in result.sweep]
    return out


@app.get("/api/study")
async def study_status() -> StudyOut:
    """Where the COPV study has got to, and its last result."""
    return _study_out()


@app.post("/api/study")
async def start_study(body: dict[str, Any] | None = Body(None)) -> StudyOut:
    """Run the COPV sizing study.

    Minutes, not seconds -- see :mod:`backend.study` for why accuracy costs wall
    clock here. Started on a worker and collected by polling this endpoint.
    """
    settings = dict(body or {})
    # `or` would be wrong here: an explicitly empty list is a mistake worth
    # reporting, not a request for the default pair.
    asked = settings.get("gases")
    gases = tuple(str(g) for g in asked) if asked is not None else ("gn2", "he")
    if not gases:
        raise HTTPException(status_code=422, detail="pick at least one gas")
    unknown = [g for g in gases if g not in STUDY_DIAGRAMS]
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=f"no drawing for {', '.join(unknown)}. "
            f"Known: {', '.join(sorted(STUDY_DIAGRAMS))}",
        )
    missing = [
        name
        for gas, name in STUDY_DIAGRAMS.items()
        if gas in gases and find_study_diagram(library, gas) is None
    ]
    if missing:
        raise HTTPException(
            status_code=404,
            detail=f"the study drawings are not in the library: {', '.join(missing)}",
        )
    engines = library.list("engine")
    if not engines:
        raise HTTPException(
            status_code=404, detail="the study needs an engine in the library"
        )
    engine = engines[0]
    design = engine_from_bytes(library.path(engine.id).read_bytes(), name=engine.name)
    request = StudyRequest(
        gases=gases,
        bigger=bool(settings.get("bigger")),
        collapse=bool(settings.get("collapse")),
        sweep=bool(settings.get("sweep")),
        vapour=bool(settings.get("vapour")),
        chilldown=min(max(float(settings.get("chilldown") or 0.0), 0.0), 5000.0),
        line_walls=bool(settings.get("line_walls")),
    )
    if not _STUDY.start(library, engine.id, _cea_for(design), request):
        raise HTTPException(status_code=409, detail="a study is already running")
    return _study_out()


@app.post("/api/study/cancel")
async def cancel_study() -> StudyOut:
    """Stop the run at its next case boundary, keeping what it has."""
    _STUDY.cancel()
    return _study_out()


def _start_precompute(session: Session, horizon: float) -> None:
    if session.computing:
        return
    # Marked before the thread starts, not by the thread. A tick that lands in
    # the gap otherwise sees a live frame, and a client polling `computing`
    # to know when the burn is ready concludes it already is.
    session.computing = True
    session.progress = 0.0
    threading.Thread(
        target=session.precompute,
        args=(horizon,),
        daemon=True,
        name=f"precompute-{session.id}",
    ).start()


@app.post("/api/session/{session_id}/precompute")
async def precompute_session(
    session_id: str, body: dict[str, Any] | None = Body(None)
) -> SessionOut:
    """Integrate the next ``horizon`` seconds ahead, for replay at full accuracy."""
    session = _session(session_id)
    settings = dict(body or {})
    _start_precompute(session, horizon=float(settings.get("horizon") or 15.0))
    return _session_out(session, session.step(1e-4))


@app.post("/api/session/{session_id}/command")
async def command_session(
    session_id: str, body: dict[str, Any] | None = Body(None)
) -> SessionOut:
    """Change state, take a valve by hand, or release one."""
    session = _session(session_id)
    settings = dict(body or {})

    if session.tripped and "state" in settings:
        raise HTTPException(status_code=409, detail=session.tripped)
    if "state" in settings:
        try:
            session.command_state(str(settings["state"]))
        except PermissionError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        # A burn is integrated live, like every other state. It used to be
        # computed ahead and replayed: the panel froze on "Running sim..." for
        # ten seconds after Fire -- which read as Fire doing nothing -- and
        # then played back a run the operator could not touch. A stand whose
        # regulator-ullage loop is too stiff for real time now simply runs
        # slower than the wall clock, and the panel says by how much; that is
        # honest and it is never a frozen screen. `precompute_session` is
        # still there for a client that asks for it.
        if settings.get("precompute") and "fire" in session.state.lower():
            _start_precompute(session, horizon=float(settings.get("horizon") or 15.0))
    if "valve" in settings:
        try:
            session.set_valve(str(settings["valve"]), bool(settings.get("open")))
        except PermissionError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    if settings.get("release") is not None:
        session.release(str(settings.get("release") or ""))
    if "setup" in settings or "dome" in settings:
        session.setup = _setup(
            {
                **dict(settings.get("setup") or {}),
                **({"dome": settings["dome"]} if "dome" in settings else {}),
            },
            session.setup,
        )
        # The tanks were built with the old knobs; a physics toggle that only
        # took effect on the next session was a toggle that did not work.
        session.apply_thermal()

    return _session_out(session, session.step(1e-3))


@app.get("/api/session/{session_id}/history")
async def session_history(
    session_id: str, seconds: float = 120.0, max_points: int = 0
) -> RunOut:
    """The trace so far, in the shape the plots already read.

    ``max_points`` thins the window to at most that many samples, evenly,
    keeping the newest. The console integrates at 50 Hz and plots a
    five-minute window; a plot wants a couple of thousand points, not fifteen
    thousand, and the wire does not want them every second and a half.
    """
    session = _session(session_id)
    built = session.model.built
    cutoff = session.t - max(seconds, 1.0)
    kept = [s for s in session.history if s.t >= cutoff]
    if max_points > 0 and len(kept) > max_points:
        stride = -(-len(kept) // max_points)
        kept = kept[::-1][::stride][::-1]
    return RunOut(
        diagram_id=session.model.report.diagram,
        engine_id=session.model.report.engine,
        fluid_set="",
        state=session.state,
        converged=all(s.converged for s in kept) if kept else True,
        message=f"live session, {len(kept)} samples",
        elapsed_s=round(session.t, 2),
        times_s=[s.t for s in kept],
        channels=[
            Channel(
                id=i.id,
                tag=i.tag,
                unit=_channel_unit(i.type),
                values=(
                    [round(s.temperatures.get(i.node, 0.0), 2) for s in kept]
                    if i.type in THERMAL_INSTRUMENTS
                    else [round(psig(s.pressures.get(i.node, 0.0)), 2) for s in kept]
                ),
            )
            for i in built.instruments
        ],
        frames=[],
        controls={"dome": session.setup.dome_psi},
        report=_report(session.model),
    )


@app.get("/api/tunables")
async def tunables() -> list[dict[str, Any]]:
    """Every number the twin assumes: label, unit, bounds, what it stands for,
    its default, and whether a change applies live or on the next Reset. The
    current values ride on the session's ``setup`` echo."""
    return describe_tunables()


@app.get("/api/statemachine")
async def state_machine(
    diagram: str, engine: str = "", fluid_set: str = "hotfire", machine: str = "diablo"
) -> StateMachineOut:
    """The stand's states and how they bind to this drawing's valves."""
    stand = _stand(diagram, engine, fluid_set, machine)
    m, b = stand.machine, stand.binding
    return StateMachineOut(
        name=m.name,
        states=list(m.states),
        transitions={s: m.targets(s) for s in m.states},
        actuators=list(m.actuators),
        bound=dict(b.to_symbol),
        unmatched=list(b.unmatched),
        uncommanded=list(b.uncommanded),
        warnings=list(m.warnings),
        positions={
            state: {
                sid: value > 0.5 for sid, value in b.positions_for(m, state).items()
            }
            for state in m.states
        },
    )


@app.post("/api/state")
async def go_to_state(
    diagram: str,
    engine: str = "",
    fluid_set: str = "hotfire",
    machine: str = "diablo",
    body: dict[str, Any] | None = Body(None),
) -> RunOut:
    """Solve the stand in one state. The call behind every click.

    Returns the same shape a fire does, with a single frame, so the app draws
    one thing whether it is sitting in a state or watching a burn.
    """
    settings = dict(body or {})
    state = str(settings.get("state") or "Idle")
    stand = _stand(diagram, engine, fluid_set, machine)
    if state not in stand.machine.states:
        raise HTTPException(
            status_code=404,
            detail=f"No state {state!r} on {machine}. "
            f"States: {', '.join(stand.machine.states)}",
        )
    # The twin refuses what the stand refuses. Without this the API is a
    # back door around the state machine the whole app is built on, and a
    # scripted client could jump Idle straight to Fire.
    current = str(settings.get("from") or "")
    if current and not stand.machine.can_go(current, state):
        raise HTTPException(
            status_code=409,
            detail=f"{current} cannot go to {state} on {machine}. From there: "
            f"{', '.join(stand.machine.targets(current))}",
        )
    forced = {str(k): float(v) for k, v in dict(settings.get("forced") or {}).items()}
    dome = float(settings.get("dome") or 0.0)

    started = time.perf_counter()
    try:
        sample = solve_at(stand, state, forced=forced, dome_psi=dome)
    except Exception as exc:  # noqa: BLE001 - surfaced verbatim to the operator
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return _run_out(
        stand,
        [sample],
        state=state,
        fluid_set=fluid_set,
        elapsed=time.perf_counter() - started,
        message=f"steady state in {state}",
        controls={"dome": dome},
    )


@app.post("/api/fire")
async def fire_endpoint(
    diagram: str,
    engine: str = "",
    fluid_set: str = "hotfire",
    machine: str = "diablo",
    body: dict[str, Any] | None = Body(None),
) -> RunOut:
    """Run a burn: hold the pre-fire state, transition, sample."""
    settings = dict(body or {})
    stand = _stand(diagram, engine, fluid_set, machine)

    options = FireOptions(
        duration=max(float(settings.get("duration") or 5.0), 0.05),
        lead_in=max(float(settings.get("lead_in") or 0.5), 0.0),
        sample_hz=max(float(settings.get("sample_hz") or 20.0), 1.0),
        prefire=str(settings.get("prefire") or "Ready"),
        state=str(settings.get("state") or "Fire"),
        dome_psi=float(settings.get("dome") or 0.0),
        forced={
            str(k): float(v) for k, v in dict(settings.get("forced") or {}).items()
        },
    )
    for name in (options.prefire, options.state):
        if name not in stand.machine.states:
            raise HTTPException(
                status_code=404, detail=f"No state {name!r} on {machine}"
            )

    started = time.perf_counter()
    try:
        samples, rate = fire(stand, options)
    except Exception as exc:  # noqa: BLE001 - surfaced verbatim to the operator
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return _run_out(
        stand,
        samples,
        state=options.state,
        fluid_set=fluid_set,
        elapsed=time.perf_counter() - started,
        message=(
            f"{options.duration:g} s in {options.state} at {rate:.0f} Hz; each "
            "sample is its own steady solve, tanks held where the regulator "
            "puts them"
        ),
        controls={
            "duration": options.duration,
            "lead_in": options.lead_in,
            "sample_hz": rate,
            "dome": options.dome_psi,
        },
    )


def _run_out(
    stand: Stand,
    samples: list[Sample],
    *,
    state: str,
    fluid_set: str,
    elapsed: float,
    message: str,
    controls: dict[str, float],
) -> RunOut:
    built = stand.model.built
    frames = [_frame(stand, s) for s in samples]
    last = next((s for s in reversed(samples) if s.balance is not None), None)
    return RunOut(
        diagram_id=stand.model.report.diagram,
        engine_id=stand.model.report.engine,
        fluid_set=fluid_set,
        state=state,
        converged=all(s.converged for s in samples),
        message=message,
        elapsed_s=round(elapsed, 2),
        times_s=[f.t for f in frames],
        channels=[
            Channel(
                id=i.id,
                tag=i.tag,
                unit=_channel_unit(i.type),
                values=(
                    [f.temperature_K.get(i.id, 0.0) for f in frames]
                    if i.type in THERMAL_INSTRUMENTS
                    else [f.pressure_psi.get(i.id, 0.0) for f in frames]
                ),
            )
            for i in built.instruments
        ],
        frames=frames,
        controls=controls,
        report=_report(stand.model),
        balance=(
            _balance(last.balance)
            if last is not None and last.balance is not None
            else None
        ),
    )
