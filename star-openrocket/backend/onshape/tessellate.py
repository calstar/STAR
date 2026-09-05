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
    """An indexed triangle mesh in its Part Studio's local frame.

    Triangles are stored grouped by their originating B-rep face, in the order
    the faces appear in the response. ``face_ids[k]`` is the Onshape face id of
    the k-th group and ``face_tri_counts[k]`` how many triangles it contributed;
    the groups partition ``indices`` contiguously, so triangle ``i`` belongs to
    the face whose cumulative count first exceeds ``i``. Welding only dedupes
    *vertices*; triangle order (and therefore this grouping) is preserved.
    """

    part_id: str
    vertices: np.ndarray  # (N, 3) float64, metres
    indices: np.ndarray  # (M, 3) uint32
    facet_count: int
    face_ids: list[str]  # one entry per face group, in triangle order
    face_tri_counts: list[int]  # triangles per face group, aligned with face_ids

    @property
    def triangle_count(self) -> int:
        return len(self.indices)

    def face_id_per_triangle(self) -> np.ndarray:
        """(M,) array giving the face id string index for each triangle.

        Returns integer indices into ``face_ids``; callers that want the string
        can index back through ``face_ids``. Kept as ints so it can ride along
        cheaply in the geometry sidecar.
        """
        return np.repeat(np.arange(len(self.face_ids)), self.face_tri_counts).astype(np.int32)


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
        face_ids: list[str] = []
        face_tri_counts: list[int] = []

        for face_index, face in enumerate(body.get("faces") or []):
            face_tris = 0
            for facet in face.get("facets") or []:
                vertices = facet.get("vertices") or []
                if len(vertices) != 3:
                    # Onshape emits triangles only; anything else is malformed
                    # and safer to drop than to guess at.
                    continue
                for vertex in vertices:
                    points.append((vertex["x"], vertex["y"], vertex["z"]))
                facet_count += 1
                face_tris += 1

            if face_tris:
                # A face id is usually present; fall back to a positional id so a
                # face never silently merges into its neighbour's group.
                face_ids.append(face.get("id") or f"face{face_index}")
                face_tri_counts.append(face_tris)

        if not points:
            continue

        raw = np.asarray(points, dtype=np.float64)
        unique, flat_indices = weld_vertices(raw)
        meshes[part_id] = PartMesh(
            part_id=part_id,
            vertices=unique,
            indices=flat_indices.reshape(-1, 3),
            facet_count=facet_count,
            face_ids=face_ids,
            face_tri_counts=face_tri_counts,
        )

    return meshes
