"""B-rep face surface types, from Onshape's ``bodydetails`` endpoint.

Tessellation gives triangles but not what surface they came from. ``bodydetails``
gives, per face, the analytic surface: ``CYLINDER`` / ``CONE`` / ``SPUN`` (a spun,
i.e. revolved, surface -- an ogive nose) / ``SPHERE`` / ``TORUS`` are surfaces of
revolution; ``PLANE`` / ``SWEEP`` are not. The airframe is exactly the coaxial
surfaces of revolution, so this is what lets the auto-detector find the body and
its axis authoritatively rather than guessing from the mesh.

The face ids here are the *same ids* the tessellation uses (verified: every
tessellated face id has a bodydetails match), so the join is exact and needs no
geometric matching. Cylinders/cones/spun carry an ``axis`` and ``origin`` in the
Part Studio local frame -- the same frame as the tessellation vertices -- so the
occurrence transform maps both into the root frame together.
"""

from __future__ import annotations

from dataclasses import dataclass

from .assembly import SourceKey
from .client import OnshapeClient

#: Surface types that are bodies of revolution -- candidates for the airframe.
SOR_TYPES = frozenset({"CYLINDER", "CONE", "SPUN", "SPHERE", "TORUS"})


@dataclass(frozen=True)
class FaceSurface:
    """One B-rep face's analytic surface, in the Part Studio local frame."""

    face_id: str
    type: str
    origin: list[float] | None  # a point on the axis (or sphere centre)
    axis: list[float] | None  # unit axis direction, when the surface has one
    radius: float | None

    @property
    def is_sor(self) -> bool:
        return self.type in SOR_TYPES


def _vec(node: dict | None) -> list[float] | None:
    if not node:
        return None
    return [float(node.get("x", 0.0)), float(node.get("y", 0.0)), float(node.get("z", 0.0))]


def parse_bodydetails(payload: dict) -> dict[str, dict[str, FaceSurface]]:
    """Parse a bodydetails response into ``{part_id: {face_id: FaceSurface}}``."""
    out: dict[str, dict[str, FaceSurface]] = {}
    for body in payload.get("bodies") or []:
        part_id = body.get("id")
        if not part_id:
            continue
        faces: dict[str, FaceSurface] = {}
        for face in body.get("faces") or []:
            fid = face.get("id")
            if not fid:
                continue
            surface = face.get("surface") or {}
            faces[fid] = FaceSurface(
                face_id=fid,
                type=surface.get("type", "OTHER"),
                origin=_vec(surface.get("origin")),
                axis=_vec(surface.get("axis")),
                radius=(float(surface["radius"]) if surface.get("radius") is not None else None),
            )
        out[part_id] = faces
    return out


def fetch_source_surfaces(
    client: OnshapeClient, source: SourceKey, link_document_id: str | None = None
) -> dict[str, dict[str, FaceSurface]]:
    """Fetch face surface descriptions for one Part Studio, keyed by part id."""
    payload = client.get_json(
        f"/partstudios/{source.path_prefix()}/bodydetails",
        {"configuration": source.configuration, "linkDocumentId": link_document_id},
    )
    return parse_bodydetails(payload)
