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

import functools
import hashlib
import logging
import re
import json
from dataclasses import asdict, dataclass, field, replace
import time
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

from fastapi import Body, FastAPI, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware

import feedtwin
from feedtwin.pid import INLINE_TYPES, INSTRUMENT_TYPES, SOURCE_TYPES
from feedtwin.pid.document import PidNode
from feedtwin.pid.network import SINK_TYPES, propellant_side

from backend.assembly import (
    AssemblyError,
    Model,
    assemble,
    card_summary,
    diagram_summary,
    engine_from_bytes,
    engine_summary,
    load_diagram_artifact,
)
from feedtwin.engine import EngineDesign
from feedtwin.engine.balance import MixtureBalance, SideBalance
from feedtwin.engine.chamber import ChamberResult
from feedtwin.engine.importer import EngineImportError

from backend import designtools
from backend.designtools import DesignTool, DesignToolError, tools
from backend.library import Artifact, Library, LibraryError
from backend.overrides import (
    OVERRIDE_SOURCES,
    Applied,
    SUPERSEDED_BY_SEGMENTS,
    OverrideError,
    OverrideStore,
    apply_overrides,
    fingerprint,
)
from feedtwin.model.param import Param
from feedtwin.model.units import UnknownUnit, dimension_of, registered_units
from backend.models import (
    DrawingElement,
    DrawingOut,
    DrawingParam,
    OverrideOut,
    ParamValue,
    Actuator,
    ArtifactOut,
    AssumptionOut,
    BalanceOut,
    Channel,
    EngineState,
    BurnOut,
    BurnsOut,
    BoardOut,
    ChannelOut,
    HookupBody,
    HookupOut,
    HookupRegulatorOut,
    HookupSymbolOut,
    HookupValveOut,
    KnobOut,
    LiveKnobOut,
    SolverOut,
    StateEvent,
    BurnTankOut,
    FreshnessOut,
    ImportResult,
    LegOut,
    ModelView,
    ReportOut,
    RunOut,
    SessionOut,
    StudyCaseOut,
    StudyOut,
    SourceDocument,
    StateMachineOut,
    SourceOut,
    TankOut,
)
from backend.live import Stand
from feedtwin.session.gauge import PSI, from_psig, psig
from backend.session import MAX_STEP, Sample as SessionSample, Session, Setup
from feedtwin.session.burn import (
    BurnPlan,
    find_probes,
    jump_to_t0,
    regulator_lockup,
    run_burn,
)
from stardesign.userdata import slug_user
from feedtwin.pid.roles import ground_ids
from feedtwin.session.hookup import (
    CHARGE,
    DOME,
    Hookup,
    binding as hookup_binding,
    knob_starts,
    lost_connectors as hookup_lost,
    on_vehicle as hookup_on_vehicle,
    regulators as hookup_regulators,
    suggest as suggest_hookup,
    valves as hookup_valves,
)
from feedtwin.session.report import (
    FULL_FLOW_FRACTION,
    BurnReport,
    burns as find_burns,
    finite,
)
from backend.version import VALIDATION, code_version
from backend.tunables import TUNABLES
from backend.tunables import describe as describe_tunables, parse_setup, wire_setup
from backend.study import StudyCase, StudyRequest, StudyRunner
from backend.statemachine import available as sm_available, load_machine
from backend import daqbox
from feedtwin.session.statemachine import StateMachine, machine_from_dict
from feedtwin.session.core import builtin_rows
from backend import runs as run_records
from backend import userdata
from backend.routers import stands, users

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

# Stands: shared, checked-out, versioned documents in the store pid-designer
# keeps its diagrams in (lib/stardesign).
app.include_router(stands.router)
app.include_router(users.router)

library = Library()

#: Operator overrides and console visibility, beside the library so a deployment
#: that mounts the library keeps them too. See backend.overrides.
overrides = OverrideStore(library.root / "overrides.json")


def _drawing_key(diagram_id: str) -> str:
    """What overrides are kept under: the drawing's name, so a re-import keeps
    them. Raises LibraryError for an unknown id."""
    return library.get(diagram_id).name


def _overrides_for(diagram_id: str) -> dict[str, Any]:
    return overrides.entry(_drawing_key(diagram_id))


@functools.lru_cache(maxsize=64)
def _ground_of(diagram_id: str) -> frozenset[str]:
    """The drawing's ground support (feedtwin.pid.roles). Artifacts are
    content-addressed, so an id's answer never changes."""
    try:
        return frozenset(ground_ids(load_diagram_artifact(library, diagram_id)))
    except (LibraryError, AssemblyError, ValueError):
        return frozenset()


def _console_hidden(diagram_id: str) -> set[str]:
    """What the console leaves off for everyone: what the team hid, and the
    ground support it has not chosen to show."""
    try:
        entry = _overrides_for(diagram_id)
    except (LibraryError, OverrideError):
        return set()
    ground = _ground_of(diagram_id)
    return (set(entry["console_hidden"]) | ground) - set(entry["console_shown"])


def _console_order(diagram_id: str) -> dict[str, list[str]]:
    try:
        order = _overrides_for(diagram_id)["console_order"]
    except (LibraryError, OverrideError):
        return {}
    return {k: list(v) for k, v in order.items()}


def _who(request: Request) -> str:
    """Who is asking, the way every other route here names them."""
    return str(userdata.store.current_user(request))


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
    fields = {k: getattr(artifact, k) for k in ArtifactOut.model_fields if k != "card"}
    return ArtifactOut(**fields, card=_card_info(artifact))


def _card_info(artifact: Artifact) -> dict[str, object]:
    """An engine's stored card, as it describes itself; empty without one."""
    if artifact.kind != "engine":
        return {}
    try:
        raw = library.attachment(artifact.id, "card")
        return card_summary(json.loads(raw.decode("utf-8"))) if raw else {}
    except (LibraryError, ValueError):
        return {}


async def _build_card(artifact_id: str, data: bytes, headers: Mapping[str, str]) -> str:
    """Ask EngineDesign for this engine's card and store it with the engine.

    Returns why not, or "" when it worked. An engine without a card still
    imports -- it fires feedtwin's simplified engine, and the report says so.
    """
    try:
        answer = await designtools.engine_card(data, headers)
    except DesignToolError as exc:
        return str(exc)
    library.attach(artifact_id, "card", json.dumps(answer).encode("utf-8"))
    return ""


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
    diagram_id: str,
    engine_id: str,
    fluid_set: str,
    multiphase: bool = False,
    swap: Mapping[str, tuple[str, float]] | None = None,
    vehicle_only: bool = False,
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
            fluid_swap={**FLUID_SETS[fluid_set], **dict(swap or {})},
            cea_resolver=_cea_for,
            multiphase=multiphase,
            overrides=_overrides_for(diagram_id),
            vehicle_only=vehicle_only,
        )
    except (AssemblyError, LibraryError, OverrideError) as exc:
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
        overrides=[
            AssumptionOut(
                component=o.element,
                parameter=o.parameter,
                value=o.value,
                unit=o.unit,
                source=o.source,
                reference=f"{o.by}: {o.reference}" if o.by else o.reference,
            )
            for o in _applied(model)
        ],
        overrides_hash=fingerprint(_applied(model)),
    )


def _applied(model: Model) -> tuple[Applied, ...]:
    """The operator overrides that took effect on this assembly."""
    applied = model.meta.get("overrides")
    return applied if isinstance(applied, tuple) else ()


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


# ------------------------------------------------------------------- health


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "healthy"}


@app.get("/api/version")
async def version() -> dict[str, object]:
    """The code this instance runs (app, library, commit, uncommitted changes)
    and the physics stack under it."""
    return {
        **code_version(),
        "stack": feedtwin.stack_versions(),
        "validation": VALIDATION,
    }


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
async def import_engine(request: Request, file: UploadFile) -> ImportResult:
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
    problem = ""
    if not _card_info(artifact):
        problem = await _build_card(artifact.id, data, request.headers)
    return ImportResult(
        artifact=_out(artifact), already_present=existed, card_error=problem
    )


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
    problem = ""
    if tool.kind == "engine" and not _card_info(artifact):
        problem = await _build_card(artifact.id, data, request.headers)
    return ImportResult(
        artifact=_out(artifact), already_present=existed, card_error=problem
    )


@app.post("/api/library/{artifact_id}/card")
async def build_engine_card(request: Request, artifact_id: str) -> ImportResult:
    """(Re)build an engine's EngineDesign card, so the stand fires the engine
    EngineDesign designed rather than feedtwin's simplified one."""
    try:
        artifact = library.get(artifact_id)
    except LibraryError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if artifact.kind != "engine":
        raise HTTPException(status_code=400, detail="only an engine has a card")
    problem = await _build_card(artifact_id, library.read(artifact_id), request.headers)
    if problem:
        raise HTTPException(status_code=502, detail=problem)
    return ImportResult(artifact=_out(artifact), already_present=True)


@app.get("/api/library/{artifact_id}/freshness")
async def artifact_freshness(request: Request, artifact_id: str) -> FreshnessOut:
    """Is this still what the design tool it was pulled from holds?

    A pulled engine is a copy. EngineDesign moves on -- holes redrilled, a
    throat resized -- and a stand firing last month's copy disagrees with
    Layer X, which fires the live design, for no reason anybody can see.
    """
    try:
        artifact = library.get(artifact_id)
    except LibraryError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    parsed = designtools.parse_source(artifact.source)
    if parsed is None:
        return FreshnessOut(
            artifact_id=artifact_id,
            tracked=False,
            detail="Uploaded, not pulled from a design tool: nothing to compare with.",
        )
    key, owner, doc_id, release = parsed
    if release:
        return FreshnessOut(
            artifact_id=artifact_id,
            tracked=True,
            current=True,
            detail=f"Release {release}: a release never changes.",
        )
    try:
        data, _ = await designtools.fetch(
            _tool(key), doc_id, owner=owner, headers=request.headers
        )
    except DesignToolError as exc:
        return FreshnessOut(artifact_id=artifact_id, tracked=True, detail=str(exc))
    current = hashlib.sha256(data).hexdigest() == artifact.sha256
    return FreshnessOut(
        artifact_id=artifact_id,
        tracked=True,
        current=current,
        detail=(
            "Same as the working copy."
            if current
            else f"The working copy of {doc_id} has changed since this was pulled."
        ),
    )


@app.post("/api/library/{artifact_id}/refresh")
async def refresh_artifact(request: Request, artifact_id: str) -> ImportResult:
    """Pull the design tool's working copy again, as a new artifact, and (for
    an engine) build its card. The old artifact stays: runs made on it still
    name what they ran on."""
    try:
        artifact = library.get(artifact_id)
    except LibraryError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    parsed = designtools.parse_source(artifact.source)
    if parsed is None:
        raise HTTPException(
            status_code=400, detail="uploaded, not pulled: nothing to refresh from"
        )
    key, owner, doc_id, release = parsed
    tool = _tool(key)
    try:
        data, provenance = await designtools.fetch(
            tool, doc_id, owner=owner, release=release, headers=request.headers
        )
    except DesignToolError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if tool.kind == "engine":
        try:
            summary = engine_summary(engine_from_bytes(data, name=artifact.name))
        except (AssemblyError, EngineImportError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    else:
        summary = diagram_summary(json.loads(data.decode("utf-8")))
    fresh, existed = library.add(
        data,
        kind=tool.kind,
        name=artifact.name,
        source=provenance,
        suffix=tool.suffix,
        summary=summary,
    )
    problem = ""
    if tool.kind == "engine" and not _card_info(fresh):
        problem = await _build_card(fresh.id, data, request.headers)
    return ImportResult(
        artifact=_out(fresh), already_present=existed, card_error=problem
    )


@app.delete("/api/library/{artifact_id}")
async def remove_artifact(artifact_id: str) -> dict[str, str]:
    try:
        library.remove(artifact_id)
    except LibraryError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"removed": artifact_id}


# -------------------------------------------------------------------- model


@app.get("/api/diagram")
async def diagram_document(diagram: str) -> dict[str, list[Any]]:
    """The drawing itself, as pid-designer saved it.

    The schematic is pid-designer's own canvas, so it is handed the document
    that canvas draws -- every symbol, rotation, port, tag offset, colour,
    page and routed corner -- not a projection of it. `/api/model` is the
    assembly's view of the same drawing: what it read and what it invented.
    """
    try:
        artifact = library.get(diagram)
        data = library.read(diagram)
    except LibraryError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if artifact.kind != "diagram":
        raise HTTPException(
            status_code=422,
            detail=f"{artifact.label} is an {artifact.kind}, not a drawing",
        )
    try:
        document = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=422, detail=f"{artifact.label} is not readable JSON ({exc})"
        ) from exc
    return {"nodes": document.get("nodes") or [], "edges": document.get("edges") or []}


def _pages(nodes: Sequence[PidNode]) -> dict[str, str]:
    """Which sheet each node is on, by id -- and the engine's own channels
    (``engine.pc``) on the sheet its symbol is, since they are its readings
    though not drawn instruments."""
    pages = {n.id: n.page or "Main" for n in nodes}
    engine = next((n for n in nodes if n.type == "ENGINE"), None)
    if engine is not None:
        for channel, *_ in ENGINE_CHANNELS:
            pages[channel] = engine.page or "Main"
    return pages


@app.get("/api/model")
async def model_view(
    diagram: str, engine: str = "", fluid_set: str = "hotfire", ignore_gse: bool = False
) -> ModelView:
    """Assemble and describe, without solving.

    Split from the run so the drawing is on screen the moment a stand is picked,
    and the assembly report -- what was read, what defaulted -- is readable
    before anybody waits on a solve. ``ignore_gse``: the vehicle alone, as a
    session with ``Setup.ignore_gse`` builds it.
    """
    model = _assemble(diagram, engine, fluid_set, vehicle_only=ignore_gse)
    return ModelView(
        diagram_id=diagram,
        engine_id=model.report.engine,
        title=str(model.meta.get("diagram_name", "stand")),
        actuators=[
            Actuator(id=d, tag=s.split(".")[0], signal=s)
            for d, s in model.built.actuators.items()
            if not s.endswith(".dome")
        ],
        report=_report(model),
        pages=_pages(model.diagram.nodes),
        console_hidden=sorted(_console_hidden(diagram)),
        console_order=_console_order(diagram),
        ground_cut=[
            str(c) for c in cast(list[Any], model.meta.get("ground_cut") or [])
        ],
        drawn_knobs={
            k: round(v, 1)
            for k, v in _drawn_knobs(
                diagram,
                engine,
                fluid_set,
                model,
                _hookup_for(diagram, model)[0],
                ignore_gse,
            ).items()
        },
        ground=sorted(ground := ground_ids(model.diagram)),
        ground_bottles=sorted(
            n.id
            for n in model.diagram.nodes
            if n.id in ground and (n.drawn_as or n.type) in ("KBOTTLE", "DEWAR")
        ),
        engine=(
            {
                **engine_summary(model.engine),
                **{
                    k: v
                    for k, v in model.meta.items()
                    if k == "engine_model" or k == "why" or k.startswith("card_")
                },
            }
            if model.engine
            else {}
        ),
    )


# ------------------------------------------------------------------ drawing
#
# What was pulled from the drawing, what the operator typed over it, and what
# the console shows. The drawing itself is never edited -- see backend.overrides.


def _value(p: Param) -> ParamValue:
    return ParamValue(
        value=p.value, unit=p.unit, source=p.source.value, reference=p.reference
    )


def _role(component_type: str) -> str:
    """What part a symbol plays, as the drawing panel groups it."""
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


def _same_dimension(unit: str) -> list[str]:
    try:
        dim = dimension_of(unit)
    except UnknownUnit:
        return [unit]
    return [u for u in registered_units() if dimension_of(u) == dim]


@app.get("/api/drawing")
async def drawing_view(
    diagram: str, engine: str = "", fluid_set: str = "hotfire"
) -> DrawingOut:
    """Every symbol and line feed-twin read, parameter by parameter.

    Assembled *without* the overrides, so what the library had to fill in is
    still visible under a number somebody has since typed over it.
    """
    try:
        artifact = library.get(diagram)
        entry = _overrides_for(diagram)
        raw = assemble(
            library,
            diagram,
            engine_id=engine,
            fluid_swap=FLUID_SETS.get(fluid_set),
            cea_resolver=_cea_for,
        )
    except (AssemblyError, LibraryError, OverrideError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    by_label = {n.label: n.id for n in raw.diagram.nodes if n.label}
    assumed: dict[str, dict[str, ParamValue]] = {}
    for a in raw.report.assumptions:
        element = (
            a.component
            if raw.diagram.node(a.component)
            else by_label.get(a.component, a.component)
        )
        assumed.setdefault(element, {})[a.parameter] = ParamValue(
            value=a.value, unit=a.unit, source=a.source, reference=a.reference
        )

    stored = entry["params"]
    hidden = _console_hidden(diagram)
    built = raw.built
    instruments = {i.id for i in built.instruments}
    console = (
        instruments
        | set(built.tanks)
        | {d for d, sig in built.actuators.items() if not sig.endswith(".dome")}
        | {n.id for n in raw.diagram.nodes if n.type in {"KBOTTLE", "DEWAR"}}
    )
    _, applied = apply_overrides(raw.diagram, entry)

    def params_of(
        element: str, declared: Mapping[str, Param], segmented: bool
    ) -> list[DrawingParam]:
        own = stored.get(element) or {}
        filled = assumed.get(element, {})
        out = []
        for name in sorted(set(declared) | set(filled) | set(own)):
            drawn = declared.get(name)
            # A declared estimate also shows up as an assumption; it is the
            # drawing's own number, so it is shown once, as the drawing's.
            fill = filled.get(name) if drawn is None else None
            o = own.get(name)
            locked = (
                "superseded by the line's itemised run"
                if segmented and name in SUPERSEDED_BY_SEGMENTS
                else ""
            )
            override = None
            stale = False
            if o is not None:
                was = o.get("was")
                override = OverrideOut(
                    value=o["value"],
                    unit=o["unit"],
                    source=o["source"],
                    reference=o.get("reference", ""),
                    by=o.get("by", ""),
                    at=o.get("at", ""),
                    was=ParamValue(**was, reference="") if was else None,
                )
                if was is None:
                    stale = drawn is not None
                else:
                    stale = drawn is None or (drawn.value, drawn.unit) != (
                        was["value"],
                        was["unit"],
                    )
            base = _value(drawn) if drawn is not None else fill
            effective = (
                ParamValue(
                    value=override.value,
                    unit=override.unit,
                    source=override.source,
                    reference=override.reference,
                )
                if override is not None and not locked
                else base
            )
            unit = (override or base or ParamValue(value=0, unit="-", source="")).unit
            out.append(
                DrawingParam(
                    name=name,
                    drawing=_value(drawn) if drawn is not None else None,
                    assumed=fill,
                    override=override,
                    effective=effective,
                    stale=stale,
                    locked=locked,
                    units=_same_dimension(unit),
                )
            )
        return out

    elements: list[DrawingElement] = []
    for n in raw.diagram.nodes:
        if n.is_annotation:
            continue
        elements.append(
            DrawingElement(
                id=n.id,
                kind="symbol",
                tag=n.label or n.id,
                type=n.type,
                role=_role(n.type),
                fluid=n.fluid,
                params=params_of(n.id, n.params, False),
                options=dict(n.options),
                on_console=n.id in console,
                console_hidden=n.id in hidden,
                hidden_by=(
                    (entry["console_hidden"].get(n.id) or {}).get("by", "")
                    if n.id in hidden
                    else ""
                ),
            )
        )
    labels = {n.id: n.label or n.id for n in raw.diagram.nodes}
    for e in raw.diagram.edges:
        elements.append(
            DrawingElement(
                id=e.id,
                kind="line",
                tag=f"{labels.get(e.source, e.source)} → {labels.get(e.target, e.target)}",
                type=e.line_type,
                params=params_of(e.id, e.params, bool(e.segments)),
                options=dict(e.options),
                segments=len(e.segments),
            )
        )
    known = {el.id for el in elements}
    return DrawingOut(
        diagram_id=diagram,
        key=artifact.name,
        source=artifact.source,
        imported_at=artifact.imported_at,
        elements=elements,
        orphaned=sorted(
            [f"{el}.{p}" for el, ps in stored.items() if el not in known for p in ps]
            + [f"{el} (console)" for el in hidden if el not in known]
        ),
        overrides_hash=fingerprint(applied),
        override_sources=list(OVERRIDE_SOURCES),
    )


@app.put("/api/drawing/override")
async def set_override(
    request: Request,
    diagram: str = Body(...),
    element: str = Body(...),
    parameter: str = Body(...),
    value: float = Body(...),
    unit: str = Body(...),
    source: str = Body(...),
    reference: str = Body(...),
) -> dict[str, Any]:
    """Type a number over the drawing's. Takes effect on the next Reset."""
    try:
        drawing = load_diagram_artifact(library, diagram)
        key = _drawing_key(diagram)
    except (AssemblyError, LibraryError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    node = drawing.node(element)
    edge = next((e for e in drawing.edges if e.id == element), None)
    if node is None and edge is None:
        raise HTTPException(
            status_code=404, detail=f"the drawing has no symbol or line {element!r}"
        )
    if edge is not None and edge.segments and parameter in SUPERSEDED_BY_SEGMENTS:
        raise HTTPException(
            status_code=422,
            detail=f"{parameter} on this line is superseded by its itemised run "
            "and would be ignored. Change the segments in pid-designer.",
        )
    declared = (node.params if node is not None else edge.params).get(parameter)  # type: ignore[union-attr]
    if declared is not None:
        try:
            if dimension_of(unit) != dimension_of(declared.unit):
                raise HTTPException(
                    status_code=422,
                    detail=f"{unit} is not a {dimension_of(declared.unit)}; the "
                    f"drawing gives {parameter} in {declared.unit}.",
                )
        except UnknownUnit as exc:
            raise HTTPException(
                status_code=422, detail=f"unknown unit {unit!r}"
            ) from exc
    try:
        entry = overrides.set_param(
            key,
            element,
            parameter,
            value=value,
            unit=unit,
            source=source,
            reference=reference,
            by=_who(request),
            was=declared,
        )
    except OverrideError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"key": key, "params": entry["params"].get(element, {})}


@app.delete("/api/drawing/override")
async def clear_override(diagram: str, element: str, parameter: str) -> dict[str, Any]:
    """Back to the drawing's number."""
    try:
        key = _drawing_key(diagram)
        entry = overrides.clear_param(key, element, parameter)
    except (LibraryError, OverrideError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"key": key, "params": entry["params"].get(element, {})}


@app.get("/api/drawing/console")
async def console_visibility(diagram: str) -> dict[str, Any]:
    """Which symbols the console hides, and the order it draws its
    transducers and tanks in. Cheap; the console polls it."""
    try:
        _drawing_key(diagram)
    except LibraryError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {
        "hidden": sorted(_console_hidden(diagram)),
        "order": _console_order(diagram),
    }


@app.put("/api/drawing/console")
async def set_console_visibility(
    request: Request,
    diagram: str = Body(...),
    element: str = Body(...),
    hidden: bool = Body(...),
) -> dict[str, list[str]]:
    """Hide a symbol from the console, or show it again, for everyone. The
    ground support starts hidden, so for it this records a showing."""
    try:
        key = _drawing_key(diagram)
        if element in _ground_of(diagram):
            overrides.set_console_shown(key, element, not hidden, by=_who(request))
        else:
            overrides.set_console_hidden(key, element, hidden, by=_who(request))
    except (LibraryError, OverrideError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"hidden": sorted(_console_hidden(diagram))}


@app.put("/api/drawing/console/order")
async def set_console_order(
    diagram: str = Body(...), order: dict[str, list[str]] = Body(...)
) -> dict[str, Any]:
    """The order the console draws transducers and tanks in, for everyone."""
    try:
        overrides.set_console_order(_drawing_key(diagram), order)
    except (LibraryError, OverrideError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {
        "hidden": sorted(_console_hidden(diagram)),
        "order": _console_order(diagram),
    }


@app.put("/api/drawing/console/view")
async def set_console_view(
    request: Request,
    diagram: str = Body(...),
    hidden: list[str] = Body(...),
    order: dict[str, list[str]] | None = Body(None),
) -> dict[str, Any]:
    """Make the console what a saved stand had: exactly ``hidden`` off it,
    in ``order``. Opening a stand puts its view back this way."""
    try:
        overrides.set_console_view(
            _drawing_key(diagram),
            hidden=set(hidden),
            ground=set(_ground_of(diagram)),
            order=order,
            by=_who(request),
        )
    except (LibraryError, OverrideError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {
        "hidden": sorted(_console_hidden(diagram)),
        "order": _console_order(diagram),
    }


def _stand(
    diagram: str,
    engine: str,
    fluid_set: str,
    machine: str,
    multiphase: bool = False,
    swap: Mapping[str, tuple[str, float]] | None = None,
    vehicle_only: bool = False,
) -> "Stand":
    """A model with the stand's state machine bound to its valves.

    ``vehicle_only`` (``Setup.ignore_gse``) builds the rocket alone: the
    drawing's hookup keeps its vehicle pins, and its knobs are the cut
    drawing's (:func:`feedtwin.session.hookup.on_vehicle`)."""
    model = _assemble(diagram, engine, fluid_set, multiphase, swap, vehicle_only)
    shipped = _shipped_machine(machine)
    hookup, _, problem = _hookup_for(diagram, model)
    drawn = _drawn_knobs(diagram, engine, fluid_set, model, hookup, vehicle_only)
    whole = (
        _assemble(diagram, engine, fluid_set, multiphase, swap)
        if vehicle_only
        else model
    )
    lost = _lost_note(hookup, whole)
    if vehicle_only:
        hookup = hookup_on_vehicle(hookup, model)
    # The drawing's own state table when somebody edited it, else the DAQ's.
    loaded = hookup.machine or shipped
    return Stand(
        model=model,
        machine=loaded,
        binding=hookup_binding(model, loaded, hookup),
        hookup=hookup,
        drawn=drawn,
        notes=tuple(n for n in (problem, lost) if n),
        whole_ids=frozenset(n.id for n in whole.diagram.nodes),
    )


def _lost_note(hookup: Hookup, whole: Model) -> str:
    """Say which connectors go to symbols the drawing no longer has: their
    rows are matched by name instead (feedtwin.session.hookup.binding)."""
    lost = hookup_lost(hookup, whole)
    if not lost:
        return ""
    named = ", ".join(f"{c.name} ({c.symbol})" for c in lost)
    return (
        f"The DAQ box cables {named} to symbols this drawing no longer has; "
        "matched by name instead. Rewire them on the P&ID tab."
    )


def _shipped_machine(machine: str) -> StateMachine:
    """The DAQ's state table this app ships, by name."""
    try:
        loaded: StateMachine = load_machine(machine)
    except (OSError, ValueError) as exc:
        raise HTTPException(
            status_code=404,
            detail=f"No state machine {machine!r}. Shipped: "
            f"{', '.join(sm_available())}. ({exc})",
        ) from exc
    return loaded


#: The record kind a drawing's hookup is kept under (Library.put_record).
HOOKUPS = "hookups"


def _lineage(artifact: Artifact) -> str:
    """Where a drawing comes from, whatever its bytes: the pid-designer
    document, the shipped file, or the name it was uploaded under (a browser's
    " (3)" on a re-download stripped). A hookup is kept per lineage, so saving
    the drawing again -- a new artifact by content -- keeps what was linked."""
    parsed = designtools.parse_source(artifact.source)
    if parsed is not None:
        key, owner, doc_id, _ = parsed
        return f"{key}:{owner}/{doc_id}"
    if artifact.source.startswith("shipped:"):
        return artifact.source
    return "name:" + re.sub(r"\s*\(\d+\)$", "", artifact.name).strip()


def _drawn_knobs(
    diagram: str,
    engine: str,
    fluid_set: str,
    model: Model,
    hookup: Hookup,
    vehicle_only: bool,
) -> dict[str, float]:
    """Where each knob starts on this drawing [psig], by knob id: the
    regulators' drawn settings. Rocket only, the cart's settings are still the
    drawing's, though the cart is not simulated: the COPV fill charges to its
    fill regulator's setting."""
    drawn: dict[str, float] = dict(knob_starts(hookup, model))
    if vehicle_only:
        whole = _assemble(diagram, engine, fluid_set)
        drawn = {**knob_starts(_hookup_for(diagram, whole)[0], whole), **drawn}
    return drawn


def _hookup_for(diagram_id: str, model: Model) -> tuple[Hookup, bool, str]:
    """The drawing's saved hookup, or the twin's suggestion; whether saved; and
    why a saved one was not used, or "".

    A saved hookup that cannot be read falls back to the suggestion like one
    never saved, and used to be indistinguishable from it: the stand ran on a
    different wiring and nothing said so."""
    try:
        lineage = _lineage(library.get(diagram_id))
    except LibraryError:
        suggested = suggest_hookup(model, Setup().dome_psi, Setup().copv_target_psi)
        return suggested, False, ""
    stored = library.record(HOOKUPS, lineage)
    problem = ""
    if stored is not None:
        try:
            raw = stored.get("hookup")
            return Hookup.from_dict(raw if isinstance(raw, Mapping) else {}), True, ""
        except (ValueError, KeyError, TypeError, AttributeError) as exc:
            problem = (
                f"This drawing's saved hookup could not be read ({exc}); the "
                "suggested hookup is wired instead. Check the Hookup tab and save "
                "it again."
            )
            logging.getLogger("feed-twin.hookup").warning(
                "hookup for %s unreadable: %s", lineage, exc
            )
    suggested = suggest_hookup(model, Setup().dome_psi, Setup().copv_target_psi)
    return suggested, False, problem


#: Instrument types that read a temperature rather than a pressure.
#:
#: A channel used to be `unit="psi"` for every instrument and its values taken
#: from the pressure field, so a thermocouple plotted as a pressure trace in psi.
THERMAL_INSTRUMENTS = frozenset({"TC", "RTD"})


def _channel_unit(instrument_type: str) -> str:
    return "K" if instrument_type in THERMAL_INSTRUMENTS else "psig"


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


@dataclass
class _Opened:
    """What a session was opened on, for the run record its burns leave."""

    diagram: str
    engine: str
    fluid_set: str
    machine: str
    multiphase: bool
    user: str
    stand: dict[str, Any] | None = None
    """``{id, owner, name, modified}`` when opened from a stand document."""
    burning: bool = False
    recorded: set[float] = field(default_factory=set)
    """Burn start times already recorded: every burnout records every finished
    burn still in the history, so one is recorded once however many follow."""
    kept: list[dict[str, Any]] = field(default_factory=list)
    """The recorded burns, ``{run_id, outcome, series}``, newest last: the
    Engine tab keeps showing a burn after it leaves the session's history."""
    notices: list[str] = field(default_factory=list)
    """Said in the console's notes on every frame: what the stand was opened on
    that the operator should know (a hookup that could not be used). The
    session's own ``assumptions`` reach only the run record."""
    unrecorded: str = ""
    """Why the last burn could not be recorded; cleared once a record lands."""


def _notices(session_id: str) -> list[str]:
    """The backend's notes for a session's console, beside the stand's own."""
    opened = _OPENED.get(session_id)
    if opened is None:
        return []
    return [*opened.notices, *([opened.unrecorded] if opened.unrecorded else [])]


_OPENED: dict[str, _Opened] = {}

#: Recorded burns a session keeps for its Engine tab.
KEPT_BURNS = 20


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


def _live_knobs(session: Session) -> list[LiveKnobOut]:
    if session.hookup is None:
        return []
    labels = {n.id: n.label or n.id for n in session.model.diagram.nodes}
    return [
        LiveKnobOut(
            id=k.id,
            label=k.label,
            psig=(
                session.setup.dome_psi
                if k.id == DOME
                else (
                    session.setup.copv_target_psi
                    if k.id == CHARGE
                    else session.knobs.get(k.id, k.psig)
                )
            ),
            low=k.low,
            high=k.high,
            regulators=[labels.get(r, r) for r in k.regulators],
        )
        for k in session.hookup.knobs
    ]


def _lockup_psig(
    session: Session,
    tank_id: str,
    inlet_psig: float | None = None,
    loaded_dome: bool = False,
) -> float | None:
    """The regulator lockup feeding a vehicle tank [psig], or None: right now,
    or with the bottle at ``inlet_psig`` (and ``loaded_dome``: the dome at its
    knob's setting, though the dome line is shut). A readout: moves nothing."""
    if tank_id in session.ground:
        return None
    inlet = None if inlet_psig is None else from_psig(inlet_psig)
    lockup = regulator_lockup(session, tank_id, inlet, loaded_dome=loaded_dome)
    return None if lockup is None else round(psig(lockup), 1)


def _lockup_range(session: Session, tank_id: str) -> list[float] | None:
    """Where a vehicle tank locks up with the COPV charged to its fill setting
    and with it empty [psig]: the range the tank sees as the bottle blows down
    (the supply effect, measured from zero inlet). The dome knob's number."""
    # At the dome the knob sets: in Idle a cart's dome line is shut and the
    # dome reads atmosphere, which put this at "-5 -> 50".
    charged = _lockup_psig(
        session, tank_id, float(session.setup.copv_target_psi), loaded_dome=True
    )
    empty = _lockup_psig(session, tank_id, 0.0, loaded_dome=True)
    return None if charged is None or empty is None else [charged, empty]


def _wired(session: Session) -> list[str] | None:
    """What the stand's DAQ box sees, by drawing id: every symbol on a
    connector and every valve a table row drives (rocket only, a vent row
    finds the tank-top disconnect with no connector of its own). ``None``
    when the hookup is not wired: everything is, as it was before the box."""
    hookup = session.hookup
    if hookup is None or hookup.channels is None:
        return None
    return sorted(
        {c.symbol for c in hookup.channels} | set(session.binding.to_symbol.values())
    )


def _session_out(session: Session, sample: SessionSample) -> SessionOut:
    built = session.model.built
    signals_of = {d: s for d, s in built.actuators.items() if not s.endswith(".dome")}
    return SessionOut(
        id=session.id,
        t=sample.t,
        knobs=_live_knobs(session),
        aliases=session.hookup.names() if session.hookup is not None else {},
        wired=_wired(session),
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
        held=session.operator_held,
        tripped=session.tripped,
        overrides_hash=fingerprint(_applied(session.model)),
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
                side=propellant_side(built.network.nodes[sim.outlet_node].fluid),
                chilling=bool(values.get("chilling", 0.0)),
                fill_flow_g_s=round(values.get("fill_flow_g_s", 0.0), 2),
                load_kg=round(sim.load_target_kg, 3),
                fire_load_kg=session.fire_loads().get(sim.id),
                lockup_psi=_lockup_psig(session, sim.id),
                lockup_range_psi=_lockup_range(session, sim.id),
                mawp_psi=round(psig(sim.mawp), 1) if sim.mawp > 0.0 else None,
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
                mawp_psi=round(psig(b.mawp), 1) if b.mawp > 0.0 else None,
            )
            for b in session.bottles.values()
        ],
        setup=wire_setup(session.setup),
        engine=_engine_state(sample.chamber),
        notes=[*sample.notes, *_notices(session.id)],
    )


@app.post("/api/session")
async def open_session(
    request: Request,
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
    setup = _setup(settings)
    stand = _stand(
        diagram, engine, fluid_set, machine, multiphase, vehicle_only=setup.ignore_gse
    )
    # The dome and the COPV fill start where the drawing sets them; the
    # client sends them only when the operator has turned them (or a stand
    # carries them). They used to start at 500 and 4,500 whatever was drawn.
    setup = _setup(
        {
            key: stand.drawn[knob]
            for key, knob in (("dome", DOME), ("copv_target", CHARGE))
            if key not in settings and knob in stand.drawn
        },
        setup,
    )
    hookup, binding, table = stand.hookup, stand.binding, stand.machine
    hookup_note = ""
    raw = settings.get("hookup")
    if isinstance(raw, Mapping) and raw:
        # A stand document carries its own hookup: used for this session only,
        # never written over the drawing's saved one. A hookup made for another
        # drawing (the stand was saved on one drawing and the cockpit has
        # moved to another) is not this drawing's: the session opens on the
        # drawing's own hookup and says so, rather than refusing to open.
        try:
            candidate = Hookup.from_dict(raw)
            if setup.ignore_gse:
                candidate = hookup_on_vehicle(candidate, stand.model)
            known = {r.id for r in hookup_regulators(stand.model)}
            stray = sorted({r for k in candidate.knobs for r in k.regulators} - known)
            if stray:
                hookup_note = (
                    "The stand's hookup was made for another drawing (it names "
                    f"{', '.join(stray)}); using this drawing's own hookup."
                )
            else:
                hookup = candidate
                table = candidate.machine or _shipped_machine(machine)
                binding = hookup_binding(stand.model, table, hookup)
                gone = sorted(
                    {c.symbol for c in Hookup.from_dict(raw).channels or ()}
                    - stand.whole_ids
                )
                if gone:
                    hookup_note = (
                        "The stand's DAQ box cables connectors to symbols this "
                        f"drawing no longer has ({', '.join(gone)}); matched by "
                        "name instead. Rewire them on the P&ID tab."
                    )
        except (ValueError, KeyError, TypeError, AttributeError) as exc:
            hookup_note = f"The stand's hookup could not be read ({exc}); using this drawing's own."
    try:
        session = Session(
            stand.model,
            table,
            binding,
            state=str(settings.get("state") or "Idle"),
            setup=setup,
            hookup=hookup,
        )
    except AssemblyError as exc:
        # A drawing that assembles can still fail to *start* -- a COPV drawn
        # as a tank has no liquid to begin from. Said, not a bare 500.
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    # The drawing's hookup notes, while it is the drawing's hookup that is wired.
    notices = [
        *(stand.notes if hookup is stand.hookup else ()),
        *([hookup_note] if hookup_note else []),
        *session.short_loads(),
    ]
    session.assumptions.extend(notices)
    if len(_SESSIONS) >= _SESSION_LIMIT:
        _OPENED.pop(_SESSIONS.pop(next(iter(_SESSIONS))).id, None)
    _SESSIONS[session.id] = session
    _OPENED[session.id] = _Opened(
        diagram=diagram,
        engine=engine,
        fluid_set=fluid_set,
        machine=machine,
        multiphase=multiphase,
        user=userdata.store.current_user(request),
        stand=_stand_ref(request, settings.get("stand")),
        notices=notices,
    )
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
    # Time warp: a tick may carry several steps' worth of stand time, run as
    # consecutive full steps of the session's own size -- nothing is coarsened,
    # it only goes faster when the machine can (a 20-minute LOX load watched at
    # x20). The cockpit drops back to x1 at Fire.
    dt = min(max(float(settings.get("dt") or 0.1), 0.0), MAX_TICK_S)
    left = dt
    try:
        while True:
            chunk = min(left, MAX_STEP)
            sample = session.step(chunk)
            _record_on_burnout(session, sample)
            left -= chunk
            if left <= 1e-9 or session.tripped or session.state == "Fire":
                break
    except Exception as exc:  # noqa: BLE001 - surfaced verbatim to the operator
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _session_out(session, sample)


#: The most stand time one tick may carry [s]: x20 on a 200 ms tick, with
#: room. A backgrounded tab resumes; it does not catch up an hour.
MAX_TICK_S = 6.0


_STUDY = StudyRunner()


def _study_out() -> StudyOut:
    runner = _STUDY
    request = runner.request
    cases = runner.result.cases if runner.result is not None else list(runner.partial)
    return StudyOut(
        running=runner.running,
        progress=round(runner.progress, 3),
        stage=runner.stage,
        error=runner.error,
        stand=request.stand if request else "",
        engine_name=request.engine_name if request else "",
        sweep=request.sweep if request else "",
        horizon_s=request.horizon_s if request else 0.0,
        planned=len(request.cases) if request else 0,
        cases=[StudyCaseOut(**asdict(c)) for c in cases],
        notes=list(runner.result.notes) if runner.result is not None else [],
    )


def _study_outcome(session: Session) -> dict[str, Any]:
    """The study case's burn, totalled as the Engine tab and a run total it."""
    history = list(session.history)
    found = find_burns(history, find_probes(session).injector_inlet)
    if not found:
        return {}
    longest = max(found, key=lambda b: b.duration_s)
    model_kind = str(session.model.meta.get("engine_model", ""))
    out = _burn_out(session, history, longest, model_kind).model_dump()
    out.pop("series", None)
    return out


@app.get("/api/study")
async def study_status() -> StudyOut:
    """Where the study has got to, and the cases it has finished."""
    return _study_out()


@app.post("/api/study")
async def start_study(body: dict[str, Any] | None = Body(None)) -> StudyOut:
    """Run a study on the stand a cockpit session has open.

    ``{"session": id, "cases": [...], "horizon_s": s, "sweep": "what x is"}``.
    Every case starts from the session's stand as it is now -- drawing,
    engine, settings, hookup, knobs -- with the case's changes on top
    (:class:`backend.study.StudyCase`). Minutes, not seconds; collected by
    polling this endpoint.
    """
    settings = dict(body or {})
    session_id = str(settings.get("session") or "")
    if not session_id:
        raise HTTPException(
            status_code=422, detail="Open a stand in the cockpit first."
        )
    session = _session(session_id)
    opened = _OPENED.get(session_id)
    if opened is None:
        raise HTTPException(
            status_code=409, detail="Reset the stand, then run the study."
        )
    if session.model.engine is None:
        raise HTTPException(
            status_code=422,
            detail="No engine on this stand: pick one in Library and the study fires it.",
        )
    raw_cases = settings.get("cases")
    if not isinstance(raw_cases, list) or not raw_cases:
        raise HTTPException(status_code=422, detail="Add at least one case.")
    if len(raw_cases) > 40:
        raise HTTPException(status_code=422, detail="40 cases at most in one study.")
    try:
        cases = tuple(StudyCase.parse(c, i) for i, c in enumerate(raw_cases))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    known = set(session.knobs) | {DOME, CHARGE}
    stray = sorted({k for c in cases for k in c.knobs} - known)
    if stray:
        raise HTTPException(
            status_code=422,
            detail=f"No knob {', '.join(stray)} on this stand. Knobs: "
            f"{', '.join(sorted(known)) or 'none'}.",
        )
    keys = {t.key for t in TUNABLES}
    unknown = sorted({k for c in cases for k in c.setup} - keys)
    if unknown:
        raise HTTPException(
            status_code=422, detail=f"No Configuration row {', '.join(unknown)}."
        )
    horizon = min(max(float(settings.get("horizon_s") or 20.0), 1.0), 120.0)
    base = {
        "diagram": opened.diagram,
        "engine": opened.engine,
        "fluid_set": opened.fluid_set,
        "machine": opened.machine,
        "multiphase": opened.multiphase,
        "setup": wire_setup(session.setup),
        **_hookup_inputs(session),
        "knobs": {k: round(float(v), 3) for k, v in session.knobs.items()},
    }
    engine_name = opened.engine
    try:
        engine_name = library.get(opened.engine).name
    except LibraryError:
        pass
    stand = (opened.stand or {}).get("name") or ""
    if not stand:
        try:
            stand = library.get(opened.diagram).name
        except LibraryError:
            stand = opened.diagram
    request = StudyRequest(
        base=base,
        cases=cases,
        horizon_s=horizon,
        sweep=str(settings.get("sweep") or ""),
        stand=str(stand),
        engine_name=engine_name,
    )
    if not _STUDY.start(request, _session_from_inputs, _study_outcome):
        raise HTTPException(status_code=409, detail="a study is already running")
    return _study_out()


@app.post("/api/study/cancel")
async def cancel_study() -> StudyOut:
    """Stop at the end of the case running now, keeping the ones finished."""
    _STUDY.cancel()
    return _study_out()


@app.post("/api/session/{session_id}/command")
async def command_session(
    session_id: str, body: dict[str, Any] | None = Body(None)
) -> SessionOut:
    """Change state, take a valve by hand or release one, turn a knob, change
    the setup, or skip a load's chilldown (``skip_chill``)."""
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
        # honest and it is never a frozen screen.
    knob = settings.get("knob")
    if isinstance(knob, Mapping) and session.hookup is not None:
        found = next((k for k in session.hookup.knobs if k.id == knob.get("id")), None)
        if found is None:
            raise HTTPException(status_code=404, detail=f"No knob {knob.get('id')!r}.")
        try:
            value = min(max(float(knob.get("value", "")), found.low), found.high)
        except (TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=422, detail="knob value is a number"
            ) from exc
        if found.id == DOME:
            session.setup = _setup({"dome": value}, session.setup)
        elif found.id == CHARGE:
            session.setup = _setup({"copv_target": value}, session.setup)
        else:
            session.knobs[found.id] = value
    aliases = settings.get("aliases")
    if isinstance(aliases, Mapping):
        # Names only: the running stand takes them without reopening.
        # (A session with no hookup drives the dome the old way; an empty
        # hookup would stop that, so it has nowhere to keep names.)
        if session.hookup is None:
            raise HTTPException(
                status_code=409, detail="This stand has no hookup to name things in."
            )
        named = Hookup.from_dict({"aliases": aliases}).aliases
        session.hookup = replace(session.hookup, aliases=named)
    names = settings.get("names")
    if isinstance(names, Mapping):
        # The console's names, live: aliases, and the DAQ box when only what
        # its connectors are called changed. A name a table row goes by is
        # wiring -- renaming a valve's connector moves it off its row -- so
        # that needs a fresh stand, and is refused here rather than half done.
        if session.hookup is None:
            raise HTTPException(
                status_code=409, detail="This stand has no hookup to name things in."
            )
        try:
            fresh = Hookup.from_dict(
                {
                    "aliases": names.get("aliases") or {},
                    "channels": names.get("channels"),
                }
            )
        except (ValueError, KeyError, TypeError, AttributeError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        # Names without connectors leave the box as it is.
        channels = fresh.channels if "channels" in names else session.hookup.channels
        if channels is not None and session.hookup.channels is not None:
            here = {n.id for n in session.model.diagram.nodes}
            channels = tuple(c for c in channels if c.symbol in here)
        renamed = replace(
            session.hookup,
            aliases=fresh.aliases,
            channels=channels if session.hookup.channels is not None else None,
        )
        before = {(c.board, c.slot, c.symbol) for c in session.hookup.channels or ()}
        after = {(c.board, c.slot, c.symbol) for c in renamed.channels or ()}
        rebound = hookup_binding(session.model, session.machine, renamed).to_symbol
        if before != after or dict(rebound) != dict(session.binding.to_symbol):
            raise HTTPException(
                status_code=409,
                detail="That changes what a state-table row drives; save it to "
                "restart the stand wired the new way.",
            )
        session.hookup = renamed
    if "valve" in settings:
        try:
            session.set_valve(str(settings["valve"]), bool(settings.get("open")))
        except PermissionError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    if settings.get("release") is not None:
        session.release(str(settings.get("release") or ""))
    skip = settings.get("skip_chill")
    if skip:
        # True: every vehicle tank still chilling; a tank id: that one.
        try:
            session.skip_chilldown("" if skip is True else str(skip))
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
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
        # ...except what the stand was built from: ignoring the GSE is a
        # different network, so it takes a new stand, and this one says what
        # it is.
        if session.setup.ignore_gse != session.gse_ignored:
            session.setup = replace(session.setup, ignore_gse=session.gse_ignored)

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
    events = [
        StateEvent(t=round(b.t, 3), label=b.state)
        for a, b in zip(kept, kept[1:])
        if b.state != a.state
    ]
    if max_points > 0 and len(kept) > max_points:
        stride = -(-len(kept) // max_points)
        kept = kept[::-1][::stride][::-1]
    limits = _channel_limits(session)
    return RunOut(
        message=f"live session, {len(kept)} samples",
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
                **limits.get(i.id, {}),
            )
            for i in built.instruments
        ]
        + [
            c.model_copy(update=limits.get(c.id, {}))
            for c in (
                _engine_channels(kept) if session.model.engine is not None else []
            )
        ],
        events=events,
        balance=_session_balance(session),
    )


#: The chamber's bar turns amber this far over the engine's design chamber
#: pressure, and red this far over: a display band, not a limit of the engine
#: (it has no MAWP on the drawing). The DAQ's fixed 400 / 500 psig made a
#: nominal 7 kN burn read amber from ignition to burnout.
PC_NOP_OVER_DESIGN = 1.10
PC_MEOP_OVER_DESIGN = 1.25


def _channel_limits(session: Session) -> dict[str, dict[str, Any]]:
    """Each pressure channel's amber and red lines [psig], from what it reads.

    A transducer on a vessel: amber above the operating pressure the drawing
    gives the vessel, red above the pressure the stand trips at (its MAWP).
    The chamber: bands over the engine's design chamber pressure. Anything
    else -- a line, a dome -- is left to the console's guess by tag. The
    guesses were all there was, and a COPV transducer tagged HP-1 read red at
    1,800 psig against the propellant tanks' 700.
    """
    out: dict[str, dict[str, Any]] = {}
    params = {n.id: n.params for n in session.model.diagram.nodes}

    def drawn(vessel_id: str) -> float | None:
        param = params.get(vessel_id, {}).get("pressure")
        return psig(param.si) if param is not None else None

    for inst in session.model.built.instruments:
        if inst.type in THERMAL_INSTRUMENTS:
            continue
        for sim in session.tanks.values():
            if inst.node in (sim.ullage_node, sim.outlet_node) and sim.mawp > 0.0:
                nop = drawn(sim.id)
                meop = psig(sim.mawp)
                out[inst.id] = {
                    "nop": round(nop, 1) if nop is not None and nop < meop else None,
                    "meop": round(meop, 1),
                    "limits": f"{sim.label}: "
                    + (
                        f"operating {nop:.0f} psig on the drawing · "
                        if nop is not None
                        else ""
                    )
                    + f"trips at {meop:.0f} psig (MAWP)",
                }
        for bottle in session.bottles.values():
            if inst.node == bottle.node and bottle.mawp > 0.0:
                nop = drawn(bottle.id)
                meop = psig(bottle.mawp)
                out[inst.id] = {
                    "nop": round(nop, 1) if nop is not None and nop < meop else None,
                    "meop": round(meop, 1),
                    "limits": f"{bottle.label}: "
                    + (
                        f"charged to {nop:.0f} psig on the drawing · "
                        if nop is not None
                        else ""
                    )
                    + f"trips at {meop:.0f} psig (MAWP)",
                }
    engine = session.model.engine
    design = (
        getattr(engine, "design_chamber_pressure", 0.0) if engine is not None else 0.0
    )
    if design > 0.0:
        pc = psig(design)
        out["engine.pc"] = {
            "nop": round(pc * PC_NOP_OVER_DESIGN, 1),
            "meop": round(pc * PC_MEOP_OVER_DESIGN, 1),
            "limits": f"design chamber {pc:.0f} psig · amber 10 % over, red 25 % over",
        }
    # A missing NOP falls back on the tag's own, which may sit over a drawn
    # MEOP: say nothing rather than draw red under amber.
    return {k: v for k, v in out.items() if v.get("meop") is not None}


#: How far back the Engine page's O/F split looks for a sample that flowed.
BALANCE_LOOKBACK = 400


def _session_balance(session: Session) -> BalanceOut | None:
    """The O/F split at the newest sample in which both legs flowed.

    A cockpit sample carries the pressures, flows and valve signals of its
    solve, which is all the split needs; it used to be built only for the
    one-shot ``/api/fire`` run, so the cockpit's Engine page never had one.
    Read at the newest flowing sample, so it stays on the page after the mains
    shut -- the last thing the stand did is what a person wants to look at.
    """
    from backend.analysis import mixture_balance

    if session.model.engine is None:
        return None
    history = list(session.history)
    for sample in reversed(history[-BALANCE_LOOKBACK:]):
        if sample.chamber is None or sample.chamber.mdot_total <= 0.0:
            continue
        try:
            found = mixture_balance(session.model, cast(Any, sample), sample.signals)
        except (ValueError, ZeroDivisionError):
            found = None
        if found is not None:
            return _balance(found)
    return None


def _hookup_body(hookup: Hookup) -> HookupBody:
    return HookupBody(
        valves=dict(hookup.valves),
        knobs=[KnobOut(**k.to_dict()) for k in hookup.knobs],
        aliases=dict(hookup.aliases),
        channels=(
            None
            if hookup.channels is None
            else [ChannelOut(**c.to_dict()) for c in hookup.channels]
        ),
        rows=dict(hookup.rows),
        machine=None if hookup.machine is None else hookup.machine.to_dict(),
    )


def _hookup_from_body(body: HookupBody) -> Hookup:
    """A hookup as the API sends it, refused (422) when it contradicts itself."""
    try:
        return Hookup.from_dict(
            {
                "valves": body.valves,
                "knobs": [k.model_dump() for k in body.knobs],
                "aliases": body.aliases,
                "channels": (
                    None
                    if body.channels is None
                    else [c.model_dump() for c in body.channels]
                ),
                "rows": body.rows,
                "machine": body.machine,
            }
        )
    except (ValueError, KeyError, TypeError, AttributeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _hookup_out(
    diagram: str,
    engine: str,
    fluid_set: str,
    machine: str,
    vehicle_only: bool = False,
    own: Hookup | None = None,
) -> HookupOut:
    """A drawing's hookup as the panels show it: the saved one or the
    suggestion -- or ``own``, a stand's -- always as a DAQ box (a hookup that
    is not wired comes with the box its matching amounts to), with the state
    table it runs and how that binds."""
    model = _assemble(diagram, engine, fluid_set)
    shipped = _shipped_machine(machine)
    if own is None:
        hookup, saved, _ = _hookup_for(diagram, model)
    else:
        hookup, saved = own, True
    table = hookup.machine or shipped
    b = hookup_binding(model, table, hookup)
    if vehicle_only:
        # Rocket only (Setup.ignore_gse): the wiring the stand runs is the cut
        # drawing's -- a vent bound to the cart's solenoid is bound to the
        # rocket's capped disconnect instead. The hookup itself stays the whole
        # drawing's, so saving a name from here never drops the cart's knobs
        # and connectors (on_vehicle keeps the vehicle's half at session start).
        cut = _assemble(diagram, engine, fluid_set, vehicle_only=True)
        b = hookup_binding(cut, table, hookup_on_vehicle(hookup, cut))
    suggested = suggest_hookup(model, Setup().dome_psi, Setup().copv_target_psi)
    return HookupOut(
        lineage=_lineage(library.get(diagram)),
        saved=saved,
        hookup=_hookup_body(daqbox.wiring(hookup, model, table)),
        suggested=_hookup_body(daqbox.wiring(suggested, model, shipped)),
        actuators=list(table.actuators),
        valves=[
            HookupValveOut(id=v.id, label=v.label, page=v.page, role=list(v.role))
            for v in hookup_valves(model)
        ],
        regulators=[
            HookupRegulatorOut(
                id=r.id,
                label=r.label,
                kind=r.kind,
                page=r.page,
                drawn_psig=None if r.drawn_psig is None else round(r.drawn_psig, 1),
            )
            for r in hookup_regulators(model)
        ],
        bound=dict(b.to_symbol),
        unmatched=list(b.unmatched),
        uncommanded=list(b.uncommanded),
        by_role=list(b.by_role),
        by_user=list(b.by_user),
        pages=sorted({n.page or "Main" for n in model.diagram.nodes}),
        mated=[list(pair) for pair in model.built.mated],
        vehicle_only=vehicle_only,
        wired=hookup.wired,
        boards=[BoardOut(id=x.id, label=x.label, kind=x.kind) for x in daqbox.BOARDS],
        symbols=[
            HookupSymbolOut(
                id=x.id,
                label=x.label,
                type=x.type,
                page=x.page,
                kind=x.kind,
                board=x.board,
                ground=x.ground,
            )
            for x in daqbox.symbols(model)
        ],
        machine_shipped=shipped.to_dict(),
        machine_warnings=list(table.warnings),
        builtin=builtin_rows(table),
    )


@app.get("/api/hookup")
async def get_hookup(
    diagram: str,
    engine: str = "",
    fluid_set: str = "hotfire",
    machine: str = "diablo",
    ignore_gse: bool = False,
) -> HookupOut:
    """The drawing's DAQ box, state table and knobs: saved, or the twin's
    suggestion. ``ignore_gse``: bound as a rocket-only stand runs it."""
    return _hookup_out(diagram, engine, fluid_set, machine, ignore_gse)


@app.post("/api/hookup/view")
async def view_hookup(
    diagram: str,
    body: HookupBody,
    engine: str = "",
    fluid_set: str = "hotfire",
    machine: str = "diablo",
    ignore_gse: bool = False,
) -> HookupOut:
    """A hookup that is not the drawing's -- a stand's own -- shown as the
    drawing's would be, and bound the way that stand runs it. Writes nothing,
    but refuses (422) what a save would: the panels check a stand's hookup
    here before keeping it with the stand."""
    hookup = _hookup_from_body(body)
    _refuse_impossible(hookup, _assemble(diagram, engine, fluid_set))
    return _hookup_out(diagram, engine, fluid_set, machine, ignore_gse, own=hookup)


def _refuse_impossible(hookup: Hookup, model: Model) -> None:
    """422 for a hookup this drawing cannot have: a knob on a regulator it
    lacks, a cable on the wrong board or to a symbol that is not here."""
    known = {r.id for r in hookup_regulators(model)}
    stray = sorted({r for k in hookup.knobs for r in k.regulators} - known)
    if stray:
        raise HTTPException(
            status_code=422,
            detail=f"Not regulators on this drawing: {', '.join(stray)}.",
        )
    wrong = daqbox.problems(hookup, model)
    if wrong:
        raise HTTPException(status_code=422, detail=" ".join(wrong))


@app.put("/api/hookup")
async def save_hookup(
    diagram: str,
    body: HookupBody,
    engine: str = "",
    fluid_set: str = "hotfire",
    machine: str = "diablo",
    ignore_gse: bool = False,
) -> HookupOut:
    """Keep a hookup for this drawing's lineage. New stands open with it."""
    hookup = _hookup_from_body(body)
    _refuse_impossible(hookup, _assemble(diagram, engine, fluid_set))
    library.put_record(
        HOOKUPS,
        _lineage(library.get(diagram)),
        {"hookup": hookup.to_dict(), "diagram": diagram},
    )
    return _hookup_out(diagram, engine, fluid_set, machine, ignore_gse)


@app.delete("/api/hookup")
async def reset_hookup(
    diagram: str,
    engine: str = "",
    fluid_set: str = "hotfire",
    machine: str = "diablo",
    ignore_gse: bool = False,
) -> HookupOut:
    """Forget this drawing's saved hookup: back to the twin's suggestion."""
    library.drop_record(HOOKUPS, _lineage(library.get(diagram)))
    return _hookup_out(diagram, engine, fluid_set, machine, ignore_gse)


@app.post("/api/statemachine/check")
async def check_state_machine(table: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """What is wrong with a state table being edited: the warnings the twin
    would give it once saved, or why it cannot be read at all."""
    try:
        machine = machine_from_dict(table)
    except (ValueError, KeyError, TypeError, AttributeError) as exc:
        return {"ok": False, "error": str(exc), "warnings": []}
    return {"ok": True, "error": "", "warnings": list(machine.warnings)}


@app.get("/api/session/{session_id}/burns")
async def session_burns(session_id: str) -> BurnsOut:
    """Every burn still in the stand's history, oldest first: what the engine
    did, totalled the way Layer X totals a burn."""
    session = _session(session_id)
    history = list(session.history)
    model_kind = str(session.model.meta.get("engine_model", ""))
    if session.model.engine is None:
        return BurnsOut(engine_id="", engine_model="", burns=[])
    inlets = find_probes(session).injector_inlet
    live = [
        _burn_out(session, history, burn, model_kind)
        for burn in find_burns(history, inlets)
    ]
    # A recorded burn carries its run and its traces, and stays listed after
    # the history has rolled past it.
    opened = _OPENED.get(session_id)
    kept = {
        round(float(k["outcome"]["start_s"]), 3): k
        for k in (opened.kept if opened else [])
    }
    burns: list[BurnOut] = []
    for out in live:
        found = kept.pop(round(out.start_s, 3), None)
        if found is not None:
            out = out.model_copy(
                update={"run_id": found["run_id"], "series": found["series"]}
            )
        burns.append(out)
    burns.extend(
        BurnOut(**{**k["outcome"], "run_id": k["run_id"], "series": k["series"]})
        for k in kept.values()
    )
    return BurnsOut(
        engine_id=session.model.report.engine,
        engine_model=model_kind,
        burns=sorted(burns, key=lambda b: b.start_s),
    )


def _burn_out(
    session: Session,
    history: list[SessionSample],
    burn: BurnReport,
    engine_model: str,
) -> BurnOut:
    inside = [s for s in history if burn.start_s < s.t <= burn.end_s + 1e-9]
    before = next((s for s in reversed(history) if s.t <= burn.start_s + 1e-9), None)
    first = before or (inside[0] if inside else None)
    last = inside[-1] if inside else None
    # The tank's lowest is read at full flow, like every other minimum on the
    # report: in the first step after Fire a press valve is still opening, and
    # an ullage that sagged while the stand sat in Ready reads at its sag.
    flows = [s.chamber.mdot_total for s in inside if s.chamber is not None]
    median = sorted(flows)[len(flows) // 2] if flows else 0.0
    full = [
        s
        for s in inside
        if s.chamber is not None and s.chamber.mdot_total >= FULL_FLOW_FRACTION * median
    ] or inside
    tanks: list[BurnTankOut] = []
    if first is not None and last is not None:
        built = session.model.built
        for sim in session.tanks.values():
            if sim.id not in first.tanks:
                continue
            tanks.append(
                BurnTankOut(
                    id=sim.id,
                    label=sim.label,
                    side=propellant_side(built.network.nodes[sim.outlet_node].fluid),
                    start_psi=round(first.tanks[sim.id]["pressure_psi"], 1),
                    min_psi=round(
                        min(s.tanks[sim.id]["pressure_psi"] for s in full), 1
                    ),
                    start_kg=round(first.tanks[sim.id]["liquid_mass_kg"], 3),
                    end_kg=round(last.tanks[sim.id]["liquid_mass_kg"], 3),
                )
            )
    r = burn
    return BurnOut(
        start_s=round(r.start_s, 3),
        end_s=round(r.end_s, 3),
        duration_s=round(r.duration_s, 3),
        burning=r.burning,
        impulse_Ns=round(r.impulse_Ns, 1),
        thrust_mean_N=round(r.thrust_mean_N, 1),
        thrust_peak_N=round(r.thrust_peak_N, 1),
        thrust_min_N=round(r.thrust_min_N, 1),
        pc_mean_psi=round(psig(r.pc_mean_Pa), 1),
        pc_min_psi=round(psig(r.pc_min_Pa), 1),
        pc_max_psi=round(psig(r.pc_max_Pa), 1),
        of_mean=round(finite(r.of_mean), 3),
        of_min=round(finite(r.of_min), 3),
        of_max=round(finite(r.of_max), 3),
        isp_s=round(finite(r.isp_s), 1),
        cstar_mps=round(finite(r.cstar_mps), 1),
        oxidiser_kg=round(r.oxidiser_kg, 3),
        fuel_kg=round(r.fuel_kg, 3),
        stiffness_oxidiser_min=round(finite(r.stiffness_oxidiser_min), 3),
        stiffness_fuel_min=round(finite(r.stiffness_fuel_min), 3),
        extrapolated_steps=r.extrapolated_steps,
        steps=r.steps,
        tanks=tanks,
        engine_model=engine_model,
    )


#: The engine's channels on the plots, beside the instruments: id, tag, unit,
#: and how each is read off a sample's chamber. Zero while it is not burning.
ENGINE_CHANNELS: tuple[tuple[str, str, str, Any], ...] = (
    ("engine.pc", "PC", "psig", lambda c: round(psig(c.pressure), 2)),
    ("engine.thrust", "Thrust", "N", lambda c: round(c.thrust, 1)),
    ("engine.of", "O/F", "O/F", lambda c: round(c.mixture_ratio, 4)),
    ("engine.mdot_ox", "LOX flow", "kg/s", lambda c: round(c.mdot_oxidiser, 5)),
    ("engine.mdot_fuel", "Fuel flow", "kg/s", lambda c: round(c.mdot_fuel, 5)),
)


def _engine_channels(kept: list[SessionSample]) -> list[Channel]:
    from feedtwin.session.report import is_burning

    return [
        Channel(
            id=key,
            tag=tag,
            unit=unit,
            values=[read(s.chamber) if is_burning(s) else 0.0 for s in kept],
        )
        for key, tag, unit, read in ENGINE_CHANNELS
    ]


@app.get("/api/session/{session_id}/solver")
async def session_solver(
    session_id: str, seconds: float = 300.0, max_points: int = 2000
) -> SolverOut:
    """Residuals, continuity, chamber closure and the mass balance, per tick.

    Thinned to ``max_points`` by keeping, from each stride, the tick with the
    worst residual -- a spike a plot thins away is the one a person needed to
    see.
    """
    session = _session(session_id)
    log = list(session.solver_log)
    cutoff = session.t - max(seconds, 1.0)
    kept = [r for r in log if r.t >= cutoff]
    if max_points > 0 and len(kept) > max_points:
        stride = -(-len(kept) // max_points)
        kept = [
            max(kept[i : i + stride], key=lambda r: r.residual)
            for i in range(0, len(kept), stride)
        ]
    last = log[-1] if log else None
    throughput = last.crossed_in_kg + last.crossed_out_kg if last else 0.0
    scale = max(throughput, last.inventory_kg if last else 0.0, 1e-9)
    summary: dict[str, float] = {
        "ticks": float(len(log)),
        "unconverged": float(sum(1 for r in log if not r.converged)),
        "worst_residual": max((r.residual for r in log), default=0.0),
        "worst_continuity": max((r.continuity for r in log), default=0.0),
        "worst_chamber_psi": max((r.chamber_residual_psi for r in log), default=0.0),
        "mass_error_kg": last.mass_error_kg if last else 0.0,
        "mass_error_ppm": (last.mass_error_kg / scale * 1e6) if last else 0.0,
        "guard_kg": last.guard_kg if last else 0.0,
        "guard_J": last.guard_J if last else 0.0,
        "throughput_kg": throughput,
        # The leak detector: mass no vessel booked and no boundary carried.
        # The mass error alone counts the guards' own (booked) corrections
        # as lost, and read 178,000 ppm "not kept" on a LOX load whose every
        # gram was accounted for.
        "unexplained_kg": (last.mass_error_kg - last.guard_kg) if last else 0.0,
        "unexplained_ppm": (
            (last.mass_error_kg - last.guard_kg) / scale * 1e6 if last else 0.0
        ),
        "guard_ppm": (last.guard_kg / scale * 1e6) if last else 0.0,
    }
    return SolverOut(
        t=[r.t for r in kept],
        couplings=[r.couplings for r in kept],
        iterations=[r.iterations for r in kept],
        iterations_max=[r.iterations_max for r in kept],
        residual=[r.residual for r in kept],
        continuity=[r.continuity for r in kept],
        converged=[r.converged for r in kept],
        chamber_residual_psi=[r.chamber_residual_psi for r in kept],
        inventory_kg=[r.inventory_kg for r in kept],
        mass_error_kg=[r.mass_error_kg for r in kept],
        guard_kg=[r.guard_kg for r in kept],
        guard_J=[r.guard_J for r in kept],
        crossed_kg=[r.crossed_in_kg + r.crossed_out_kg for r in kept],
        summary=summary,
    )


# ------------------------------------------------------------------------ runs
#
# Every burn the cockpit fires is kept (backend/runs.py): the inputs it ran on,
# the code, the stand version, the outcome and the solver's own summary. A
# record is written at burnout -- the tick whose sample stops burning -- so
# nobody has to remember to save the one that mattered.

_log = logging.getLogger("feed-twin.runs")


def _stand_ref(request: Request, raw: Any) -> dict[str, Any] | None:
    """The stand a session is opened from, checked: the caller may edit it."""
    if not isinstance(raw, Mapping) or not raw.get("id"):
        return None
    viewer = userdata.store.current_user(request)
    owner = slug_user(str(raw["owner"])) if raw.get("owner") else viewer
    doc_id = str(raw["id"])
    record = stands.store.find_record(owner, doc_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"No stand {doc_id!r}")
    shared = record.get("sharedWith") or []
    if viewer != owner and not any(slug_user(str(e)) == viewer for e in shared):
        raise HTTPException(status_code=403, detail="This stand is not shared with you")
    return {
        "id": doc_id,
        "owner": owner,
        "name": str(record.get("name") or doc_id),
        "updatedAt": str(record.get("updatedAt") or ""),
        "release": str(raw.get("release") or ""),
    }


def _t0(session: Session, sample: SessionSample) -> dict[str, Any]:
    """Where the stand was at the last sample before ignition."""
    return {
        "state": sample.state,
        "tanks": {
            sim.id: {
                "label": sim.label,
                "psig": round(sample.tanks[sim.id]["pressure_psi"], 2),
                "liquid_kg": round(sample.tanks[sim.id]["liquid_mass_kg"], 4),
                "liquid_K": round(sample.tanks[sim.id]["liquid_temperature_K"], 2),
                "ullage_K": round(sample.tanks[sim.id]["ullage_temperature_K"], 2),
            }
            for sim in session.tanks.values()
            if sim.id in sample.tanks
        },
        "bottles": {
            b.id: {"label": b.label, "psig": round(psig(sample.pressures[b.node]), 1)}
            for b in session.bottles.values()
            if b.node in sample.pressures
        },
    }


def _hookup_inputs(session: Session) -> dict[str, Any]:
    """The hookup as a run records it. An edited state table goes under its
    own key, ``machine_table``, so a diff names it apart from the box; the
    Explain ladder still swaps the two together (runs.GROUPS), because the
    box's connector names are the table's rows. A run on the shipped table
    records no ``machine_table`` at all, so it diffs clean against a run
    recorded before tables could be edited."""
    if session.hookup is None:
        return {"hookup": {}}
    raw = session.hookup.to_dict()
    table = raw.pop("machine", None)
    return {"hookup": raw, **({"machine_table": table} if table else {})}


def _inputs(session: Session, opened: _Opened, before: SessionSample) -> dict[str, Any]:
    return {
        "diagram": opened.diagram,
        "engine": opened.engine,
        "fluid_set": opened.fluid_set,
        "machine": opened.machine,
        "multiphase": opened.multiphase,
        "setup": wire_setup(session.setup),
        **_hookup_inputs(session),
        "knobs": {k: round(float(v), 3) for k, v in session.knobs.items()},
        "t0": _t0(session, before),
    }


def _burn_solver(session: Session, start: float, end: float) -> dict[str, float]:
    """The solver's summary over one burn's ticks: whether its numbers were
    converged, and the mass the burn's own steps cannot account for."""
    log = list(session.solver_log)
    inside = [r for r in log if start - 1e-9 <= r.t <= end + 1e-9]
    prior = next((r for r in reversed(log) if r.t < start - 1e-9), None)
    if not inside:
        return {"ticks": 0.0}
    last = inside[-1]
    error = last.mass_error_kg - (prior.mass_error_kg if prior else 0.0)
    guard = last.guard_kg - (prior.guard_kg if prior else 0.0)
    moved = last.throughput_kg - (prior.throughput_kg if prior else 0.0)
    return {
        "guard_kg": guard,
        "unexplained_kg": error - guard,
        "unexplained_ppm": (error - guard) / max(moved, 1e-9) * 1e6,
        "ticks": float(len(inside)),
        "unconverged": float(sum(1 for r in inside if not r.converged)),
        "worst_residual": max(r.residual for r in inside),
        "worst_continuity": max(r.continuity for r in inside),
        "worst_chamber_psi": max(r.chamber_residual_psi for r in inside),
        "mass_error_kg": error,
        "throughput_kg": moved,
        "mass_error_ppm": error / max(moved, 1e-9) * 1e6,
    }


def _burn_series(
    session: Session, history: list[SessionSample], start: float, end: float
) -> dict[str, Any]:
    from feedtwin.session.report import is_burning

    window = [s for s in history if start - 1.0 <= s.t <= end + 1.0]
    keep = run_records.stride_indices(len(window))
    picked = [window[i] for i in keep]

    def engine(read: Any) -> list[float]:
        return [
            round(read(s.chamber), 4) if is_burning(s) and s.chamber else 0.0
            for s in picked
        ]

    return {
        "t": [round(s.t - start, 4) for s in picked],
        "thrust_N": engine(lambda c: c.thrust),
        "pc_psig": engine(lambda c: psig(c.pressure)),
        "of": engine(lambda c: c.mixture_ratio),
        "tanks": {
            sim.id: [round(s.tanks[sim.id]["pressure_psi"], 2) for s in picked]
            for sim in session.tanks.values()
            if all(sim.id in s.tanks for s in picked)
        },
        "labels": {sim.id: sim.label for sim in session.tanks.values()},
    }


def _record_burns(session: Session, opened: _Opened) -> list[dict[str, Any]]:
    """Record every finished burn in the history not yet recorded."""
    if session.model.engine is None:
        return []
    history = list(session.history)
    inlets = find_probes(session).injector_inlet
    model_kind = str(session.model.meta.get("engine_model", ""))
    saved: list[dict[str, Any]] = []
    for burn in find_burns(history, inlets):
        key = round(burn.start_s, 3)
        if burn.burning or key in opened.recorded:
            continue
        before = next(
            (s for s in reversed(history) if s.t <= burn.start_s + 1e-9), None
        )
        if before is None:
            continue
        record = {
            "schema": run_records.SCHEMA,
            "id": run_records.new_id(),
            "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "user": opened.user,
            # Kept in the schema; nothing sets one since the record-on-demand
            # route went (2026-10-08).
            "label": "",
            "stand": opened.stand,
            "code": code_version(),
            "validation": VALIDATION["status"],
            "inputs": _inputs(session, opened, before),
            "outcome": _burn_out(session, history, burn, model_kind).model_dump(),
            "solver": _burn_solver(session, burn.start_s, burn.end_s),
            "series": _burn_series(session, history, burn.start_s, burn.end_s),
            "clock": {"start_s": burn.start_s, "end_s": burn.end_s},
            "notes": list(dict.fromkeys(session.assumptions))[-40:],
        }
        owner = opened.stand["owner"] if opened.stand else opened.user
        saved.append(run_records.store.save(owner, record))
        opened.recorded.add(key)
        opened.kept.append(
            {
                "run_id": record["id"],
                "outcome": record["outcome"],
                "series": record["series"],
            }
        )
        del opened.kept[:-KEPT_BURNS]
    # Every finished burn in the history is recorded now, including any whose
    # record failed before.
    opened.unrecorded = ""
    return saved


def _record_on_burnout(session: Session, sample: SessionSample) -> None:
    from feedtwin.session.report import is_burning

    opened = _OPENED.get(session.id)
    if opened is None:
        return
    burning = is_burning(sample)
    ended = opened.burning and not burning
    opened.burning = burning
    if not ended:
        return
    try:
        _record_burns(session, opened)
    except Exception as exc:  # noqa: BLE001 - a lost record must not stop the stand
        _log.exception("run not recorded for session %s", session.id)
        # ...nor go unsaid: a burn with no record has no provenance, and only
        # the server log knew.
        opened.unrecorded = (
            f"The burn that ended at t = {sample.t:.1f} s was not recorded "
            f"({type(exc).__name__}: {exc}); it is not in Runs."
        )


def _session_from_inputs(
    inputs: Mapping[str, Any], pressurant: str | None = None
) -> Session:
    """A fresh session on the stand a run record (or a study) describes: its
    drawing, engine, fluids, settings, hookup and knobs, in Idle, the
    automatic vent at burnout off.

    ``pressurant`` swaps the gas in the bottle and the press lines (helium or
    nitrogen, whichever the drawing has) for the other, at 293 K.
    """
    swap: dict[str, tuple[str, float]] = {}
    if pressurant:
        other = {"helium": "nitrogen", "nitrogen": "helium"}[pressurant]
        swap = {other: (pressurant, 293.15)}
    setup = replace(parse_setup(dict(inputs.get("setup") or {})), auto_vent=False)
    stand = _stand(
        str(inputs["diagram"]),
        str(inputs.get("engine") or ""),
        str(inputs.get("fluid_set") or "hotfire"),
        str(inputs.get("machine") or "diablo"),
        bool(inputs.get("multiphase")),
        swap,
        vehicle_only=setup.ignore_gse,
    )
    raw = inputs.get("hookup")
    if isinstance(raw, Mapping) and raw and inputs.get("machine_table"):
        raw = {**raw, "machine": inputs["machine_table"]}
    drawn, _, _ = _hookup_for(str(inputs["diagram"]), stand.model)
    hookup = Hookup.from_dict(raw) if isinstance(raw, Mapping) and raw else drawn
    if setup.ignore_gse:
        drawn = hookup_on_vehicle(drawn, stand.model)
        hookup = hookup_on_vehicle(hookup, stand.model)
    known = {r.id for r in hookup_regulators(stand.model)}
    if any(r not in known for k in hookup.knobs for r in k.regulators):
        hookup = drawn
    # The table the run was recorded on, not whatever the drawing has now.
    table = hookup.machine or _shipped_machine(str(inputs.get("machine") or "diablo"))
    session = Session(
        stand.model,
        table,
        hookup_binding(stand.model, table, hookup),
        state="Idle",
        setup=setup,
        hookup=hookup,
    )
    for knob, value in dict(inputs.get("knobs") or {}).items():
        if knob in session.knobs:
            session.knobs[knob] = float(value)
    return session


def _replay(
    inputs: Mapping[str, Any], cancelled: Any, *, horizon_s: float
) -> tuple[dict[str, float], list[str]]:
    """One run's inputs, burned headless from its T-0: the ladder's rung.

    The record's settings, hookup and knobs, its tanks loaded to their T-0
    mass, primed at their mean T-0 pressure and settled by the regulators, the
    bottle at its T-0 charge, then Fire for ``horizon_s`` or to depletion. The
    cockpit's automatic vent at burnout is off: it would act after the window
    being compared.
    """
    session = _session_from_inputs(inputs)
    t0 = dict(inputs.get("t0") or {})
    tanks = {k: v for k, v in dict(t0.get("tanks") or {}).items() if k in session.tanks}
    pressures = [float(v["psig"]) for v in tanks.values()]
    bottles = [float(v["psig"]) for v in dict(t0.get("bottles") or {}).values()]
    plan = BurnPlan(
        tank_psi=sum(pressures) / len(pressures) if pressures else 550.0,
        copv_psi=bottles[0] if bottles else 4500.0,
        loads={k: float(v["liquid_kg"]) for k, v in tanks.items()} or None,
        horizon_s=horizon_s,
        end_on_depletion=True,
    )
    trace = run_burn(session, plan, cancelled=cancelled)
    history = list(session.history)
    found = find_burns(history, find_probes(session).injector_inlet)
    if not found:
        raise RuntimeError("the replay did not burn: " + "; ".join(trace.notes[-3:]))
    longest = max(found, key=lambda b: b.duration_s)
    out = _burn_out(session, history, longest, "").model_dump()
    numbers = {
        key: float(out[key])
        for key, _, _ in run_records.OUTCOME_KEYS
        if isinstance(out.get(key), (int, float))
    }
    return numbers, list(trace.notes)


_EXPLAIN = run_records.Explainer()


def _run_for(request: Request, run_id: str, owner: str | None) -> dict[str, Any]:
    who = slug_user(owner) if owner else userdata.store.current_user(request)
    record = run_records.store.get(who, run_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"No run {run_id!r}")
    return record


@app.post("/api/session/{session_id}/t0")
async def session_t0(session_id: str) -> SessionOut:
    """Jump to T-0: tanks loaded, bottle charged to the COPV target, every tank
    at the lockup its regulator gives at the knobs as set, in Ready.

    The pad (fills, chilldown, presses) is skipped -- the same initial
    condition the Study and Layer X burn from (`feedtwin.session.burn.
    jump_to_t0`). What it did goes into the session's assumptions, which the
    run record of the next burn carries as its notes.
    """
    session = _session(session_id)
    try:
        t0 = jump_to_t0(
            session,
            copv_psi=session.setup.copv_target_psi,
            fill_fraction=session.setup.full_fraction,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    opened = _OPENED.get(session_id)
    if opened is not None:
        opened.burning = False
    lockups = ", ".join(
        f"{session.tanks[k].label} {v:.0f}" for k, v in t0.lockup_psi.items()
    )
    session.assumptions.append(
        f"Jumped to T-0: tanks primed at {t0.tank_psi:.0f} psig"
        + (f" (regulator lockup: {lockups} psig)" if lockups else "")
        + f", bottle at {session.setup.copv_target_psi:.0f} psig."
    )
    session.assumptions.extend(t0.notes)
    return _session_out(session, session.step(1e-3))


@app.get("/api/twin/runs")
async def list_runs(
    request: Request, stand: str | None = None, owner: str | None = None
) -> list[dict[str, Any]]:
    """Run summaries, newest first: a stand's (in its owner's folder, so the
    people it is shared with see the same list), or your own."""
    who = slug_user(owner) if owner else userdata.store.current_user(request)
    return run_records.store.list([who], stand=stand)


@app.get("/api/twin/runs/diff")
async def diff_runs(
    request: Request,
    a: str,
    b: str,
    owner_a: str | None = None,
    owner_b: str | None = None,
) -> dict[str, Any]:
    """What differs between two runs: every changed input, the code, and the
    outcome, with deltas. Not which input caused it -- that is ``explain``."""
    return run_records.diff(
        _run_for(request, a, owner_a), _run_for(request, b, owner_b)
    )


@app.get("/api/twin/runs/explain")
async def explain_status() -> dict[str, Any]:
    return dict(_EXPLAIN.state)


@app.post("/api/twin/runs/explain")
async def explain_runs(
    request: Request, body: dict[str, Any] = Body(...)
) -> dict[str, Any]:
    """Re-run both runs from T-0, then the first with one input group at a time
    taken from the second; the answer is each group's share of the change, and
    the interaction the single swaps leave unexplained."""
    first = _run_for(request, str(body.get("a") or ""), body.get("owner_a"))
    second = _run_for(request, str(body.get("b") or ""), body.get("owner_b"))
    longest = max(
        float((first.get("outcome") or {}).get("duration_s") or 0.0),
        float((second.get("outcome") or {}).get("duration_s") or 0.0),
    )
    horizon = min(max(longest + 1.0, 2.0), 60.0)

    def replay(
        inputs: Mapping[str, Any], cancelled: Any
    ) -> tuple[dict[str, float], list[str]]:
        return _replay(inputs, cancelled, horizon_s=horizon)

    if not _EXPLAIN.start(first, second, replay):
        raise HTTPException(status_code=409, detail="An explanation is already running")
    return dict(_EXPLAIN.state)


@app.post("/api/twin/runs/explain/cancel")
async def explain_cancel() -> dict[str, Any]:
    _EXPLAIN.cancel()
    return dict(_EXPLAIN.state)


@app.get("/api/twin/runs/{run_id}")
async def get_run(
    request: Request, run_id: str, owner: str | None = None
) -> dict[str, Any]:
    return _run_for(request, run_id, owner)


@app.get("/api/tunables")
async def tunables() -> list[dict[str, Any]]:
    """Every number the twin assumes: label, unit, bounds, what it stands for,
    its default, and whether a change applies live or on the next Reset. The
    current values ride on the session's ``setup`` echo."""
    return describe_tunables()


def _machine_out(m: StateMachine, b: Any, edited: bool) -> StateMachineOut:
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
        layout={s: [r, c] for s, (r, c) in m.layout.items()},
        aborts=[s for s in m.states if m.is_abort(s)],
        table=m.to_dict(),
        edited=edited,
        builtin=builtin_rows(m),
    )


@app.get("/api/statemachine")
async def state_machine(
    diagram: str,
    engine: str = "",
    fluid_set: str = "hotfire",
    machine: str = "diablo",
    ignore_gse: bool = False,
) -> StateMachineOut:
    """The drawing's states and how they bind to its valves (the vehicle's
    alone with ``ignore_gse``): its own table if somebody edited one, else the
    DAQ's."""
    stand = _stand(diagram, engine, fluid_set, machine, vehicle_only=ignore_gse)
    edited = stand.hookup is not None and stand.hookup.machine is not None
    return _machine_out(stand.machine, stand.binding, edited)


@app.get("/api/session/{session_id}/statemachine")
async def session_state_machine(session_id: str) -> StateMachineOut:
    """The table a running stand commands and how it is bound -- a stand's own
    hookup included, which the drawing's endpoint cannot see."""
    session = _session(session_id)
    edited = session.hookup is not None and session.hookup.machine is not None
    return _machine_out(session.machine, session.binding, edited)
