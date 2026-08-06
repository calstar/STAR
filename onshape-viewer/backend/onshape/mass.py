"""Mass properties and materials, with a default density for unassigned parts.

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
total excludes them entirely. orkv2.md 7.1 says never to substitute a default
density; that has been overridden by an explicit product decision, so this module
does substitute one -- but records it per part, totals it separately, and never
lets it contaminate the reconciliation against the assembly total.
"""

from __future__ import annotations

from dataclasses import dataclass

from .assembly import SourceKey
from .client import OnshapeClient

# Fiberglass, the material already dominant in the reference assembly. Only ever
# applied to parts with no material of their own, and always flagged.
DEFAULT_DENSITY = 1750.0


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
    payload = client.get_json(
        f"/parts/{source.path_prefix()}",
        {"configuration": source.configuration, "linkDocumentId": link_document_id},
    )

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


def _scalar(value: object) -> float:
    """Read index [0] out of an Onshape [nominal, lower, upper] triple."""
    if isinstance(value, (list, tuple)):
        return float(value[0]) if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    return 0.0
