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

import hashlib
import logging
import re
import json
import threading
from dataclasses import asdict, dataclass, field, replace
import time
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

import httpx
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
    BurnOut,
    BurnsOut,
    HookupBody,
    HookupOut,
    HookupRegulatorOut,
    HookupValveOut,
    KnobOut,
    LiveKnobOut,
    SolverOut,
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
from backend.live import FireOptions, Stand, fire, solve_at
from backend.run import PSI, Sample, psig
from backend.session import Sample as SessionSample, Session, Setup
from feedtwin.session.burn import (
    BurnPlan,
    find_probes,
    jump_to_t0,
    regulator_lockup,
    run_burn,
)
from stardesign.userdata import slug_user
from feedtwin.session.hookup import (
    CHARGE,
    DOME,
    Hookup,
    binding as hookup_binding,
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
from backend.statemachine import available as sm_available, bind, load_machine
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
    diagram: str, engine: str = "", fluid_set: str = "hotfire"
) -> ModelView:
    """Assemble and describe, without solving.

    Split from the run so the drawing is on screen the moment a stand is picked,
    and the assembly report -- what was read, what defaulted -- is readable
    before anybody waits on a solve.
    """
    model = _assemble(diagram, engine, fluid_set)
    return ModelView(
        diagram_id=diagram,
        engine_id=model.report.engine,
        title=str(model.meta.get("diagram_name", "stand")),
        actuators=[
            Actuator(id=d, tag=s.split(".")[0], signal=s)
            for d, s in model.built.actuators.items()
            if not s.endswith(".dome")
        ],
        controls=CONTROLS,
        fluid_sets=sorted(FLUID_SETS),
        report=_report(model),
        pages=_pages(model.diagram.nodes),
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


def _stand(
    diagram: str,
    engine: str,
    fluid_set: str,
    machine: str,
    multiphase: bool = False,
    swap: Mapping[str, tuple[str, float]] | None = None,
) -> "Stand":
    """A model with the stand's state machine bound to its valves."""
    model = _assemble(diagram, engine, fluid_set, multiphase, swap)
    try:
        loaded = load_machine(machine)
    except (OSError, ValueError) as exc:
        raise HTTPException(
            status_code=404,
            detail=f"No state machine {machine!r}. Shipped: "
            f"{', '.join(sm_available())}. ({exc})",
        ) from exc
    hookup, _ = _hookup_for(diagram, model)
    return Stand(
        model=model,
        machine=loaded,
        binding=hookup_binding(model, loaded, hookup),
        hookup=hookup,
    )


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


def _hookup_for(diagram_id: str, model: Model) -> tuple[Hookup, bool]:
    """The drawing's saved hookup, or the twin's suggestion; and whether saved."""
    try:
        lineage = _lineage(library.get(diagram_id))
    except LibraryError:
        return suggest_hookup(model, Setup().dome_psi, Setup().copv_target_psi), False
    stored = library.record(HOOKUPS, lineage)
    if stored is not None:
        try:
            raw = stored.get("hookup")
            return Hookup.from_dict(raw if isinstance(raw, Mapping) else {}), True
        except (ValueError, KeyError, TypeError):
            pass
    return suggest_hookup(model, Setup().dome_psi, Setup().copv_target_psi), False


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
    """Burn start times already recorded, so a rewind past one and a second
    falling edge does not record it twice."""
    kept: list[dict[str, Any]] = field(default_factory=list)
    """The recorded burns, ``{run_id, outcome, series}``, newest last: the
    Engine tab keeps showing a burn after it leaves the session's history."""


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


def _lockup_psig(session: Session, tank_id: str) -> float | None:
    """The regulator lockup feeding a vehicle tank right now [psig], or None."""
    if tank_id in session.ground:
        return None
    lockup = regulator_lockup(session, tank_id)
    return None if lockup is None else round(psig(lockup), 1)


def _session_out(session: Session, sample: SessionSample) -> SessionOut:
    built = session.model.built
    signals_of = {d: s for d, s in built.actuators.items() if not s.endswith(".dome")}
    return SessionOut(
        id=session.id,
        t=sample.t,
        knobs=_live_knobs(session),
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
                side=propellant_side(built.network.nodes[sim.outlet_node].fluid),
                chilling=bool(values.get("chilling", 0.0)),
                fill_flow_g_s=round(values.get("fill_flow_g_s", 0.0), 2),
                lockup_psi=_lockup_psig(session, sim.id),
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
        notes=list(sample.notes),
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
    stand = _stand(diagram, engine, fluid_set, machine, multiphase)
    hookup, binding = stand.hookup, stand.binding
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
            known = {r.id for r in hookup_regulators(stand.model)}
            stray = sorted({r for k in candidate.knobs for r in k.regulators} - known)
            if stray:
                hookup_note = (
                    "The stand's hookup was made for another drawing (it names "
                    f"{', '.join(stray)}); using this drawing's own hookup."
                )
            else:
                hookup = candidate
                binding = hookup_binding(stand.model, stand.machine, hookup)
        except (ValueError, KeyError, TypeError) as exc:
            hookup_note = f"The stand's hookup could not be read ({exc}); using this drawing's own."
    try:
        session = Session(
            stand.model,
            stand.machine,
            binding,
            state=str(settings.get("state") or "Idle"),
            setup=_setup(settings),
            hookup=hookup,
        )
    except AssemblyError as exc:
        # A drawing that assembles can still fail to *start* -- a COPV drawn
        # as a tank has no liquid to begin from. Said, not a bare 500.
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if hookup_note:
        session.assumptions.append(hookup_note)
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
    dt = float(settings.get("dt") or 0.1)
    try:
        sample = session.step(dt)
    except Exception as exc:  # noqa: BLE001 - surfaced verbatim to the operator
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    _record_on_burnout(session, sample)
    return _session_out(session, sample)


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
        "hookup": session.hookup.to_dict() if session.hookup is not None else {},
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
        ]
        + (_engine_channels(kept) if session.model.engine is not None else []),
        frames=[],
        controls={"dome": session.setup.dome_psi},
        report=_report(session.model),
        balance=_session_balance(session),
    )


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
    )


def _hookup_out(diagram: str, engine: str, fluid_set: str, machine: str) -> HookupOut:
    stand = _stand(diagram, engine, fluid_set, machine)
    model, b = stand.model, stand.binding
    hookup, saved = _hookup_for(diagram, model)
    return HookupOut(
        lineage=_lineage(library.get(diagram)),
        saved=saved,
        hookup=_hookup_body(hookup),
        suggested=_hookup_body(
            suggest_hookup(model, Setup().dome_psi, Setup().copv_target_psi)
        ),
        actuators=list(stand.machine.actuators),
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
    )


@app.get("/api/hookup")
async def get_hookup(
    diagram: str, engine: str = "", fluid_set: str = "hotfire", machine: str = "diablo"
) -> HookupOut:
    """Which valve each actuator drives and which knob sets which regulator, on
    this drawing: saved, or the twin's suggestion."""
    return _hookup_out(diagram, engine, fluid_set, machine)


@app.put("/api/hookup")
async def save_hookup(
    diagram: str,
    body: HookupBody,
    engine: str = "",
    fluid_set: str = "hotfire",
    machine: str = "diablo",
) -> HookupOut:
    """Keep a hookup for this drawing's lineage. New stands open with it."""
    try:
        hookup = Hookup.from_dict(
            {"valves": body.valves, "knobs": [k.model_dump() for k in body.knobs]}
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    model = _assemble(diagram, engine, fluid_set)
    known = {r.id for r in hookup_regulators(model)}
    stray = sorted({r for k in hookup.knobs for r in k.regulators} - known)
    if stray:
        raise HTTPException(
            status_code=422,
            detail=f"Not regulators on this drawing: {', '.join(stray)}.",
        )
    library.put_record(
        HOOKUPS,
        _lineage(library.get(diagram)),
        {"hookup": hookup.to_dict(), "diagram": diagram},
    )
    return _hookup_out(diagram, engine, fluid_set, machine)


@app.delete("/api/hookup")
async def reset_hookup(
    diagram: str, engine: str = "", fluid_set: str = "hotfire", machine: str = "diablo"
) -> HookupOut:
    """Forget this drawing's saved hookup: back to the twin's suggestion."""
    library.drop_record(HOOKUPS, _lineage(library.get(diagram)))
    return _hookup_out(diagram, engine, fluid_set, machine)


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


def _inputs(session: Session, opened: _Opened, before: SessionSample) -> dict[str, Any]:
    return {
        "diagram": opened.diagram,
        "engine": opened.engine,
        "fluid_set": opened.fluid_set,
        "machine": opened.machine,
        "multiphase": opened.multiphase,
        "setup": wire_setup(session.setup),
        "hookup": session.hookup.to_dict() if session.hookup is not None else {},
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


def _record_burns(
    session: Session, opened: _Opened, label: str = ""
) -> list[dict[str, Any]]:
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
            "label": label,
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
    except Exception:  # noqa: BLE001 - a lost record must not stop the stand
        _log.exception("run not recorded for session %s", session.id)


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
    stand = _stand(
        str(inputs["diagram"]),
        str(inputs.get("engine") or ""),
        str(inputs.get("fluid_set") or "hotfire"),
        str(inputs.get("machine") or "diablo"),
        bool(inputs.get("multiphase")),
        swap,
    )
    raw = inputs.get("hookup")
    drawn, _ = _hookup_for(str(inputs["diagram"]), stand.model)
    hookup = Hookup.from_dict(raw) if isinstance(raw, Mapping) and raw else drawn
    known = {r.id for r in hookup_regulators(stand.model)}
    if any(r not in known for k in hookup.knobs for r in k.regulators):
        hookup = drawn
    setup = replace(parse_setup(dict(inputs.get("setup") or {})), auto_vent=False)
    session = Session(
        stand.model,
        stand.machine,
        hookup_binding(stand.model, stand.machine, hookup),
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
    jump_to_t0`). What it did is in the returned notes.
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


@app.post("/api/session/{session_id}/runs")
async def record_session_runs(
    session_id: str, body: dict[str, Any] | None = Body(None)
) -> list[dict[str, Any]]:
    """Record any finished burn on this stand not recorded yet. Burnout records
    on its own; this is for a label, or a burn ended by a rewind."""
    session = _session(session_id)
    opened = _OPENED.get(session_id)
    if opened is None:
        raise HTTPException(status_code=404, detail="Session opened before runs")
    label = str((body or {}).get("label") or "")
    return [run_records.summary(r) for r in _record_burns(session, opened, label)]


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


@app.delete("/api/twin/runs/{run_id}")
async def delete_run(request: Request, run_id: str) -> dict[str, bool]:
    """Your own records only: a run on someone's stand is theirs to keep."""
    if not run_records.store.delete(userdata.store.current_user(request), run_id):
        raise HTTPException(status_code=404, detail=f"No run {run_id!r} of yours")
    return {"deleted": True}


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
