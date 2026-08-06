"""Tessellation: fetch triangle meshes per Part Studio and index them by part id.

The response schema here is NOT the one described in orkv2.md 6 (Phase 3). That
section describes a ``partId -> faces[] -> facets[]`` mapping where each facet
carries a single ``normal``. The API pinned in client.py actually returns:

    { "bodies": [                        # a list, not a dict
        { "id": "JoD",                   # <- the part id
          "faces": [ { "id": "JoK",
              "facets": [ { "vertices": [ {"x":_, "y":_, "z":_}, ...3 ],
                            "normals":  [ ... ] } ] } ] } ] }

so: bodies is a list whose ``id`` is the part id, vertex components are named
object fields rather than array entries, and normals are per-vertex and plural.
The top-level ``facetPoints`` and ``bodiesInfo`` keys are present but empty and
are not the geometry.

Part identity is carried in the response itself, so no name matching is needed
and the mesh-to-mass join is exact.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .assembly import SourceKey
from .client import OnshapeClient


@dataclass
class PartMesh:
    """An indexed triangle mesh in its Part Studio's local frame."""

    part_id: str
    vertices: np.ndarray  # (N, 3) float64, metres
    indices: np.ndarray  # (M, 3) uint32
    facet_count: int

    @property
    def triangle_count(self) -> int:
        return len(self.indices)


def fetch_source_meshes(
    client: OnshapeClient, source: SourceKey, link_document_id: str | None = None
) -> dict[str, PartMesh]:
    """Tessellate one Part Studio, returning meshes keyed by part id.

    `link_document_id` must be the *root* document id whenever `source` lives in
    a different document (orkv2.md 7.5).
    """
    payload = client.get_json(
        f"/partstudios/{source.path_prefix()}/tessellatedfaces",
        {
            "configuration": source.configuration,
            "linkDocumentId": link_document_id,
            "outputVertexNormals": "false",
            "outputFacetNormals": "false",
            "outputTextureCoordinates": "false",
        },
    )
    return parse_tessellation(payload)


def parse_tessellation(payload: dict) -> dict[str, PartMesh]:
    """Parse a tessellatedfaces response into welded, indexed meshes per part."""
    from .geometry import weld_vertices

    meshes: dict[str, PartMesh] = {}

    for body in payload.get("bodies") or []:
        part_id = body.get("id")
        if not part_id:
            continue

        points: list[tuple[float, float, float]] = []
        facet_count = 0

        for face in body.get("faces") or []:
            for facet in face.get("facets") or []:
                vertices = facet.get("vertices") or []
                if len(vertices) != 3:
                    # Onshape emits triangles only; anything else is malformed
                    # and safer to drop than to guess at.
                    continue
                for vertex in vertices:
                    points.append((vertex["x"], vertex["y"], vertex["z"]))
                facet_count += 1

        if not points:
            continue

        raw = np.asarray(points, dtype=np.float64)
        unique, flat_indices = weld_vertices(raw)
        meshes[part_id] = PartMesh(
            part_id=part_id,
            vertices=unique,
            indices=flat_indices.reshape(-1, 3),
            facet_count=facet_count,
        )

    return meshes
