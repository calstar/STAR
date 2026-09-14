"""Assembly: artifacts in, a solvable model out, with a record of what happened.

Importing a drawing is not one step, it is four, and each can go wrong in a way
worth naming:

1. **Read** the drawing. Malformed JSON, a line to nowhere, a parameter with no
   provenance -- all refused here, with the field named.
2. **Resolve** what it points at. The engine symbol names a Layer-1 config; that
   config has to be in the library and has to import.
3. **Build** the network. Symbols become nodes and branches; a tank becomes two
   pressures; the engine becomes an injector face and a chamber.
4. **Fill in** what the drawing did not say -- and record every one of those.

The output is a :class:`Model` and an :class:`AssemblyReport`. The report is the
point. A drawing that omits a bore still solves, and the answer is still worth
having, but it is a *different kind of claim* from one where every number was
measured -- and the difference must never be invisible. So the report carries
what was read, what was assumed, what was refused, and the hash of every artifact
that went in.

That is also what makes a run reproducible: a result names the artifacts by
content, so "which drawing was this" is answerable a year later.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping

from feedtwin.engine import CEATable, Chamber, ConstantCStar, EngineDesign
from feedtwin.engine.importer import EngineImportError, engine_from_config
from feedtwin.model.param import assumed_params
from feedtwin.pid import (
    BuiltNetwork,
    Diagram,
    DiagramError,
    PidNode,
    build_network,
    read_diagram,
)

from backend.library import Artifact, Library, LibraryError


class AssemblyError(ValueError):
    """The model could not be assembled, naming which step failed."""

    def __init__(self, step: str, detail: str) -> None:
        super().__init__(f"{step}: {detail}")
        self.step = step


@dataclass(frozen=True, slots=True)
class Assumption:
    component: str
    parameter: str
    value: float
    unit: str
    source: str
    reference: str = ""


@dataclass(frozen=True, slots=True)
class AssemblyReport:
    """What went into the model, and what the model had to invent."""

    diagram: str
    """Artifact id of the drawing."""

    engine: str = ""
    """Artifact id of the engine config, empty if the engine is a boundary."""

    symbols: int = 0
    lines: int = 0
    nodes: int = 0
    branches: int = 0
    instruments: int = 0
    actuators: int = 0
    assumptions: tuple[Assumption, ...] = ()
    warnings: tuple[str, ...] = ()

    @property
    def unchecked(self) -> int:
        """Parameters nobody has even estimated. The number to worry about."""
        return sum(1 for a in self.assumptions if a.source == "default")

    @property
    def coupled(self) -> bool:
        return bool(self.engine)


@dataclass(frozen=True, slots=True)
class Model:
    """Everything a run needs, assembled and audited."""

    diagram: Diagram
    built: BuiltNetwork
    report: AssemblyReport
    engine: EngineDesign | None = None
    chamber: Chamber | None = None
    #: Extra context for the report and the UI.
    meta: Mapping[str, object] = field(default_factory=dict)


def diagram_summary(payload: Mapping[str, Any]) -> dict[str, object]:
    """A listing-level look at a drawing without building anything."""
    raw_nodes = payload.get("nodes")
    raw_edges = payload.get("edges")
    nodes: list[Any] = list(raw_nodes) if isinstance(raw_nodes, list) else []
    edges: list[Any] = list(raw_edges) if isinstance(raw_edges, list) else []

    kinds: dict[str, int] = {}
    engine_ref = ""
    for node in nodes:
        if not isinstance(node, dict):
            continue
        data = node.get("data")
        if not isinstance(data, dict):
            data = {}
        # The same precedence the reader uses: a symbol's kind is in its data
        # when the editor put it there, and in the node's own type when it did
        # not -- junctions and text carry no data block at all. Reading only
        # the first counted every one of those as "?".
        kind = str(data.get("componentType") or node.get("type") or "?")
        kinds[kind] = kinds.get(kind, 0) + 1
        options = data.get("options")
        if isinstance(options, dict) and options.get("engineConfig"):
            engine_ref = str(options["engineConfig"])
    return {
        "symbols": len(nodes),
        "lines": len(edges),
        "kinds": kinds,
        "engineConfig": engine_ref,
    }


def engine_summary(design: EngineDesign) -> dict[str, object]:
    return {
        "injector": design.injector_type,
        "oxidiser": design.oxidiser.propellant,
        "fuel": design.fuel.propellant,
        "throat_mm2": round(design.throat_area * 1e6, 1),
        "thrust_N": design.design_thrust,
        "mixture_ratio": design.design_mixture_ratio,
        "warnings": list(design.warnings),
    }


def engine_from_bytes(raw: bytes, *, name: str) -> EngineDesign:
    """Import a Layer-1 config from bytes, whatever they arrived on.

    Split out from :func:`load_engine_artifact` so an upload can be validated
    *before* it is stored. Storing first and removing on failure looks
    equivalent and is not: a re-upload of something already in the library
    hashes to the same id, so the removal takes out the copy in use.
    """
    try:
        import yaml

        config = yaml.safe_load(raw.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001 - any parse failure is the same story
        raise AssemblyError("resolve", f"engine config is not readable ({exc})")
    if not isinstance(config, Mapping):
        raise AssemblyError(
            "resolve",
            "that file is not an engine config: expected a YAML mapping with "
            "'injector', 'fluids' and 'chamber_geometry' at the top level.",
        )
    try:
        return engine_from_config(config, name=name)
    except EngineImportError as exc:
        raise AssemblyError("resolve", str(exc)) from exc


def load_engine_artifact(library: Library, artifact_id: str) -> EngineDesign:
    """Read a Layer-1 config out of the library."""
    try:
        raw = library.read(artifact_id)
    except LibraryError as exc:
        raise AssemblyError("resolve", str(exc)) from exc
    return engine_from_bytes(raw, name=library.get(artifact_id).name)


def load_diagram_artifact(library: Library, artifact_id: str) -> Diagram:
    try:
        raw = library.read(artifact_id)
    except LibraryError as exc:
        raise AssemblyError("read", str(exc)) from exc
    try:
        payload = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise AssemblyError("read", f"drawing is not valid JSON ({exc})") from exc
    if not isinstance(payload, Mapping):
        raise AssemblyError("read", "drawing is not a JSON object")
    try:
        return read_diagram(payload, name=library.get(artifact_id).name)
    except DiagramError as exc:
        raise AssemblyError("read", str(exc)) from exc


def find_engine_reference(diagram: Diagram) -> str:
    """The engine artifact the drawing points at, if it points at one.

    Read from the engine symbol's ``engineConfig`` option. Absent is fine and
    common -- the engine stays a pressure boundary and the report says so.
    """
    for node in diagram.nodes:
        if node.type in {"ENGINE", "INJECTOR"}:
            reference = str(node.options.get("engineConfig", ""))
            if reference:
                return reference
    return ""


def assemble(
    library: Library,
    diagram_id: str,
    *,
    engine_id: str = "",
    fluid_swap: Mapping[str, tuple[str, float]] | None = None,
    cea_cache: str = "",
    cea_resolver: Callable[[EngineDesign], str] | None = None,
    multiphase: bool = False,
) -> Model:
    """Read, resolve, build, and audit. The whole import in one call.

    Args:
        cea_cache: An explicit combustion table. Direct and unconditional.
        cea_resolver: Called with the imported engine to *find* one, when which
            table is wanted depends on what the engine burns. Inverted this way
            round because the alternative is assembling twice -- once to learn
            the propellant pair, once to use it -- and an assembly is a network
            build, a fluid walk and an engine import, not a lookup. feedtwin
            still knows nothing about where EngineDesign keeps its caches; it
            just asks whoever does.
    """
    artifact = library.get(diagram_id)
    diagram = load_diagram_artifact(library, diagram_id)

    if fluid_swap:
        diagram = _swap_fluids(diagram, fluid_swap)

    # An explicit engine wins over the drawing's own reference, so a user can
    # try a different engine on the same stand without editing the drawing.
    reference = engine_id or find_engine_reference(diagram)
    engine: EngineDesign | None = None
    chamber: Chamber | None = None
    warnings: list[str] = []

    if reference:
        engine = load_engine_artifact(library, reference)
        warnings.extend(engine.warnings)
        resolved = cea_cache or (cea_resolver(engine) if cea_resolver else "")
        chamber = _chamber_for(engine, resolved)

    try:
        built = build_network(diagram, engine=engine, multiphase=multiphase)
    except DiagramError as exc:
        raise AssemblyError("build", str(exc)) from exc

    warnings.extend(built.warnings)

    assumptions = tuple(
        Assumption(
            component=branch.component.instance.id,
            parameter=name,
            value=branch.component.instance.params[name].value,
            unit=branch.component.instance.params[name].unit,
            source=branch.component.instance.params[name].source.value,
            reference=branch.component.instance.params[name].reference,
        )
        for branch in built.network.branches.values()
        for name in assumed_params(branch.component.instance.params)
    )

    # The engine's own provenance, in the same shape. A config carries its
    # design point twice -- `design_requirements` (intent) and
    # `chamber_geometry` (what the geometry was last sized at) -- and they
    # drift. Intent wins on import, and *which* was used belongs on the report
    # beside every other stated-versus-assumed number rather than shouted as a
    # warning: a disagreement is the normal state of a config being worked on,
    # and a warning that fires on healthy input teaches people to skim.
    if engine is not None:
        # provenance key -> (attribute on the design, unit for the report)
        engine_fields = {
            "mixture_ratio": ("design_mixture_ratio", "-"),
            "design_chamber_pressure": ("design_chamber_pressure", "Pa"),
        }
        engine_notes: list[Assumption] = []
        for key, note in sorted(engine.provenance.items()):
            field = engine_fields.get(key)
            if field is None:
                continue
            attribute, unit = field
            engine_notes.append(
                Assumption(
                    component="engine",
                    parameter=key,
                    value=float(getattr(engine, attribute, 0.0) or 0.0),
                    unit=unit,
                    # "resolved" when the config disagreed with itself and
                    # intent won; "measured" when it simply stated one value.
                    source="resolved" if "intent wins" in note else "measured",
                    reference=note,
                )
            )
        assumptions = assumptions + tuple(engine_notes)

    report = AssemblyReport(
        diagram=diagram_id,
        engine=reference,
        symbols=len(diagram.nodes),
        lines=len(diagram.edges),
        nodes=len(built.network.nodes),
        branches=len(built.network.branches),
        instruments=len(built.instruments),
        actuators=len(built.actuators),
        assumptions=assumptions,
        warnings=tuple(warnings),
    )

    return Model(
        diagram=diagram,
        built=built,
        report=report,
        engine=engine,
        chamber=chamber,
        meta={"diagram_name": artifact.name, "diagram_sha256": artifact.sha256},
    )


def _chamber_for(engine: EngineDesign, cea_cache: str) -> Chamber:
    """A chamber for this engine, from a CEA table when one is reachable.

    A constant ``c*`` is the fallback and it is a real loss: with it, mixture
    ratio still moves during a run but nothing downstream of it responds, which
    reads as "O/F drift does not matter here" when it means "this model cannot
    see it". So the fallback is named in the warnings rather than taken quietly.
    """
    from pathlib import Path

    # is_file, not exists: a directory passes an existence check and then dies
    # inside numpy with an IsADirectoryError that names neither the setting nor
    # the caller.
    losses = {
        "efficiency": engine.cstar_efficiency,
        "nozzle_efficiency": engine.nozzle_efficiency,
    }
    if cea_cache and Path(cea_cache).is_file():
        return Chamber(
            engine.throat_area,
            CEATable(cea_cache, expansion_ratio=engine.expansion_ratio),
            **losses,
        )
    return Chamber(engine.throat_area, ConstantCStar(cstar=1700.0), **losses)


def _swap_fluids(diagram: Diagram, swaps: Mapping[str, tuple[str, float]]) -> Diagram:
    """Tank contents replaced, for a cold flow. Temperature travels with the
    species -- water at the LOX tank's 90 K is ice."""
    from dataclasses import replace

    from feedtwin.model.param import Param, Provenance

    def swapped(node: PidNode) -> PidNode:
        if node.type != "TANK" or node.fluid not in swaps:
            return node
        species, temperature = swaps[node.fluid]
        params = dict(node.params)
        params["temperature"] = Param(
            temperature, "K", Provenance.MEASURED, f"{species} for this test"
        )
        return replace(node, fluid=species, params=params)

    return replace(diagram, nodes=tuple(swapped(n) for n in diagram.nodes))
