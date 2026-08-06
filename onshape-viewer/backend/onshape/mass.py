"""Mass properties and materials.

Two API behaviours drive the shape of this module.

**Per-part breakdown requires ``massAsGroup=false``.** orkv2.md 6 (Phase 2)
states the Part Studio massproperties response is keyed by part id with an
``-all-`` aggregate alongside. It is not: by default the response contains only
``-all-``. Passing repeated ``partId=`` parameters *filters* which bodies are
included but still returns a single aggregate -- which looks like it worked and
quietly gives every part the same mass. ``massAsGroup=false`` is what actually
returns per-part entries.

**Parts with no material are zeroed, not omitted.** They come back with
``hasMass: false``, ``mass: 0`` and ``centroid: [0, 0, 0]``, and the assembly
total excludes them entirely. Per orkv2.md 7.1 no density is substituted for
them: they carry no mass until someone assigns one in the viewer, and they are
flagged so it is visible which parts those are. Volume is exact regardless, and
their centroid comes from the mesh, so an assigned mass lands in the right
place.
"""

from __future__ import annotations

from dataclasses import dataclass

from .assembly import SourceKey
from .client import OnshapeClient


@dataclass
class AssemblyTotals:
    """Ground truth from the assembly-level endpoint.

    `mass` and `centroid` cover only the parts Onshape could compute, so they
    exclude every part in `mass_missing_count`.
    """

    mass: float
    centroid: list[float]
    has_mass: bool
    mass_missing_count: int


@dataclass
class BodyMass:
    part_id: str
    mass: float
    volume: float
    centroid: list[float]
    has_mass: bool


@dataclass
class Material:
    name: str
    density: float


def fetch_assembly_totals(client: OnshapeClient, path_prefix: str) -> AssemblyTotals:
    """Assembly-level mass properties -- the number every other total is checked against."""
    payload = client.get_json(f"/assemblies/{path_prefix}/massproperties")
    return AssemblyTotals(
        mass=_scalar(payload.get("mass")),
        # `centroid` is 9 numbers: 3 coordinates then 6 bound components.
        # Reading past index 2 silently produces nonsense (orkv2.md 6, Phase 2).
        centroid=list((payload.get("centroid") or [0.0, 0.0, 0.0])[:3]),
        has_mass=bool(payload.get("hasMass")),
        mass_missing_count=int(payload.get("massMissingCount") or 0),
    )


def fetch_source_bodies(
    client: OnshapeClient, source: SourceKey, link_document_id: str | None = None
) -> dict[str, BodyMass]:
    """Per-part mass properties for one Part Studio, keyed by part id."""
    payload = client.get_json(
        f"/partstudios/{source.path_prefix()}/massproperties",
        {
            "configuration": source.configuration,
            "linkDocumentId": link_document_id,
            # Without this the response collapses to a single `-all-` entry.
            "massAsGroup": "false",
        },
    )

    bodies: dict[str, BodyMass] = {}
    for part_id, body in (payload.get("bodies") or {}).items():
        if part_id == "-all-":
            continue
        bodies[part_id] = BodyMass(
            part_id=part_id,
            mass=_scalar(body.get("mass")),
            volume=_scalar(body.get("volume")),
            centroid=list((body.get("centroid") or [0.0, 0.0, 0.0])[:3]),
            has_mass=bool(body.get("hasMass")),
        )
    return bodies


def fetch_source_materials(
    client: OnshapeClient, source: SourceKey, link_document_id: str | None = None
) -> dict[str, Material]:
    """Materials for one Part Studio, keyed by part id.

    Parts with no assigned material are absent from the result rather than
    present with a zero density, so callers must treat a missing key as
    "unassigned" and not as "weightless".
    """
    payload = _fetch_parts(client, source, link_document_id)

    materials: dict[str, Material] = {}
    for part in payload or []:
        material = part.get("material")
        if not material:
            continue
        density = None
        for prop in material.get("properties") or []:
            if prop.get("name") == "DENS":
                density = prop.get("value")
                break
        if density is None:
            continue
        materials[part["partId"]] = Material(
            name=material.get("displayName") or material.get("id") or "unknown",
            density=float(density),
        )
    return materials


def fetch_source_part_names(
    client: OnshapeClient, source: SourceKey, link_document_id: str | None = None
) -> dict[str, str]:
    """Part Studio names, keyed by part id.

    Not the same thing as the name on an assembly instance: Onshape appends an
    instance counter there, so one part called "Bulkhead" appears as
    "Bulkhead <1>", "Bulkhead <2>" and so on. Telling that suffix apart from a
    part whose name genuinely ends in angle brackets is only possible by
    comparing against the name here, which is why the viewer carries both.

    Same endpoint as the materials fetch, so on a real build this costs a cache
    hit rather than a second request.
    """
    payload = _fetch_parts(client, source, link_document_id)

    names: dict[str, str] = {}
    for part in payload or []:
        name = part.get("name")
        if name:
            names[part["partId"]] = name
    return names


def _fetch_parts(
    client: OnshapeClient, source: SourceKey, link_document_id: str | None
) -> list[dict]:
    return client.get_json(
        f"/parts/{source.path_prefix()}",
        {"configuration": source.configuration, "linkDocumentId": link_document_id},
    )


def _scalar(value: object) -> float:
    """Read index [0] out of an Onshape [nominal, lower, upper] triple."""
    if isinstance(value, (list, tuple)):
        return float(value[0]) if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    return 0.0
