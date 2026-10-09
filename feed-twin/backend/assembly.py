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
from dataclasses import replace
from typing import Any, Callable, Mapping

from feedtwin.engine import EngineDesign
from feedtwin.engine.card import EngineCard
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
from backend.overrides import Applied, apply_overrides

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
    "load_engine_card",
    "card_summary",
    "SIMPLIFIED_ENGINE",
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
    overrides: Mapping[str, Any] | None = None,
) -> Model:
    """Read, resolve, build, and audit. The whole import in one call.

    Args:
        overrides: One drawing's entry from the override store
            (:mod:`backend.overrides`). Applied to the drawing before anything
            reads it; what took effect is ``meta["overrides"]``, part of the
            record for the same reason the artifact hashes are.
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
    applied: tuple[Applied, ...] = ()
    if overrides:
        diagram, applied = apply_overrides(diagram, overrides)

    # An explicit engine wins over the drawing's own reference, so a user can
    # try a different engine on the same stand without editing the drawing.
    reference = engine_id or find_engine_reference(diagram)
    engine: EngineDesign | None = None
    chamber = None
    resolved = ""
    notes: list[str] = []
    engine_meta: dict[str, Any] = {}
    if reference:
        engine = load_engine_artifact(library, reference)
        resolved = cea_cache or (cea_resolver(engine) if cea_resolver else "")
        card, card_meta = load_engine_card(library, reference)
        if fluid_swap:
            # A card is the engine at its propellants' densities, burning. A
            # cold flow swaps the fluids and burns nothing.
            engine_meta = {"engine_model": "simplified", "why": "cold flow"}
        elif card is not None:
            try:
                engine, chamber = card.install(engine)
                engine_meta = {"engine_model": "card", **card_meta}
            except ValueError as exc:
                notes.append(
                    f"The engine card stored with this engine does not fit it ({exc}); "
                    "firing feedtwin's simplified engine instead. Rebuild the card in Library."
                )
                engine_meta = {"engine_model": "simplified", "why": "card does not fit"}
        elif card_meta.get("unreadable"):
            notes.append(
                "The engine card stored with this engine could not be read "
                f"({card_meta['unreadable']}); firing feedtwin's simplified engine "
                "instead. Rebuild the card in Library."
            )
            engine_meta = {"engine_model": "simplified", "why": "card unreadable"}
        else:
            notes.append(SIMPLIFIED_ENGINE)
            engine_meta = {"engine_model": "simplified", "why": "no card"}

    model = assemble_model(
        diagram,
        diagram_id=diagram_id,
        engine=engine,
        engine_reference=reference,
        cea_cache=resolved,
        chamber=chamber,
        fluid_swap=fluid_swap,
        multiphase=multiphase,
        meta={
            "diagram_name": artifact.name,
            "diagram_sha256": artifact.sha256,
            **engine_meta,
            **({"overrides": applied} if applied else {}),
        },
    )
    if notes:
        model = replace(
            model,
            report=replace(model.report, warnings=(*notes, *model.report.warnings)),
        )
    return model


#: Said on the report when an engine fires without EngineDesign's card.
SIMPLIFIED_ENGINE = (
    "The engine is feedtwin's simplified model (one orifice per side, c* straight "
    "off the CEA table, no manifold or nozzle losses), not EngineDesign's: no engine "
    "card is stored with it. On LE4 it read ~5 % low in thrust and ~10 % high in Isp "
    "against EngineDesign. Build the card in Library."
)


def load_engine_card(
    library: Library, engine_id: str
) -> tuple[EngineCard | None, dict[str, Any]]:
    """The EngineDesign card stored with an engine, and what it says about
    itself; ``(None, {})`` when there is none.

    A card that is stored but cannot be read is ``(None, {"unreadable":
    why})``. It used to be ``(None, {})`` too, and the report then said no
    card was stored -- sending whoever read it to build one that already
    exists, rather than to the attachment that is broken."""
    try:
        raw = library.attachment(engine_id, "card")
    except LibraryError:
        return None, {}
    if raw is None:
        return None, {}
    try:
        stored = json.loads(raw.decode("utf-8"))
        card = EngineCard.from_dict(stored["card"])
    except (ValueError, KeyError, TypeError) as exc:
        return None, {"unreadable": f"{type(exc).__name__}: {exc}"}
    return card, card_summary(stored)


def card_summary(stored: Mapping[str, Any]) -> dict[str, Any]:
    """What a stored card says about itself, small enough for a listing."""
    provenance = (stored.get("card") or {}).get("provenance") or {}
    return {
        "card_config_sha256": stored.get("config_sha256", ""),
        "card_center_psia": stored.get("center_psia"),
        "card_ambient_pa": stored.get("ambient_pa"),
        "card_within_tolerance": bool(stored.get("within_tolerance", False)),
        "card_error": stored.get("envelope_worst"),
        "card_built": provenance.get("built"),
    }
