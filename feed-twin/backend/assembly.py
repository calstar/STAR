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

Building and auditing the model is library code now
(:mod:`feedtwin.session.model`); this module is the half that reads artifacts
out of this app's store and hands them over.
"""

from __future__ import annotations

import json
from typing import Callable, Mapping

from feedtwin.engine import EngineDesign
from feedtwin.engine.importer import EngineImportError, engine_from_config
from feedtwin.pid import Diagram, DiagramError, read_diagram
from feedtwin.session.model import (
    AssemblyError,
    AssemblyReport,
    Assumption,
    Model,
    assemble_model,
    chamber_for,
    diagram_summary,
    engine_summary,
    find_engine_reference,
    swap_fluids,
)

from backend.library import Library, LibraryError

__all__ = [
    "AssemblyError",
    "AssemblyReport",
    "Assumption",
    "Model",
    "assemble",
    "assemble_model",
    "chamber_for",
    "diagram_summary",
    "engine_from_bytes",
    "engine_summary",
    "find_engine_reference",
    "load_diagram_artifact",
    "load_engine_artifact",
    "swap_fluids",
]


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

    # An explicit engine wins over the drawing's own reference, so a user can
    # try a different engine on the same stand without editing the drawing.
    reference = engine_id or find_engine_reference(diagram)
    engine: EngineDesign | None = None
    resolved = ""
    if reference:
        engine = load_engine_artifact(library, reference)
        resolved = cea_cache or (cea_resolver(engine) if cea_resolver else "")

    return assemble_model(
        diagram,
        diagram_id=diagram_id,
        engine=engine,
        engine_reference=reference,
        cea_cache=resolved,
        fluid_swap=fluid_swap,
        multiphase=multiphase,
        meta={"diagram_name": artifact.name, "diagram_sha256": artifact.sha256},
    )
