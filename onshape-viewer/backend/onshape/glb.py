"""glTF/GLB writer: one mesh per distinct part, one node per occurrence.

Three conventions have to be right here, and each one fails by producing a scene
that looks plausible rather than by raising:

**Row-major vs column-major.** Onshape occurrence transforms are row-major 16
element arrays. glTF ``node.matrix`` is column-major. The transpose is applied in
``_column_major`` and nowhere else.

**Z-up vs Y-up.** Onshape works in Z-up metres, glTF is Y-up. This is handled
exactly once, as a -90 degree rotation about X baked into a single root node, and
recorded in the manifest as ``upAxisHandling: "glb-root"``. The viewer must not
apply it a second time -- a double-applied axis swap produces a scene that looks
fine and a centre of mass that is wrong (orkv2.md 6, Phase 4).

**Instancing.** Geometry is emitted once per distinct part and referenced by one
node per occurrence. Duplicating geometry per instance is the thing this design
exists to avoid.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pygltflib
from pygltflib import GLTF2

from .assembly import Occurrence
from .tessellate import PartMesh

# -90 degrees about X, as a glTF [x, y, z, w] quaternion. Maps Onshape
# (x, y, z) -> glTF (x, z, -y), so the Onshape Z axis becomes glTF up.
Z_UP_TO_Y_UP = [-0.7071067811865476, 0.0, 0.0, 0.7071067811865476]

FLOAT = 5126
UNSIGNED_INT = 5125
ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963


@dataclass
class MeshKey:
    """Identifies geometry that can be shared across occurrences."""

    element_id: str
    part_id: str
    configuration: str

    def __hash__(self) -> int:
        return hash((self.element_id, self.part_id, self.configuration))

    def __eq__(self, other: object) -> bool:
        return isinstance(other, MeshKey) and (
            self.element_id,
            self.part_id,
            self.configuration,
        ) == (other.element_id, other.part_id, other.configuration)


def _column_major(row_major: list[float]) -> list[float]:
    """Transpose a row-major 4x4 into the column-major order glTF expects."""
    return np.asarray(row_major, dtype=np.float64).reshape(4, 4).T.flatten().tolist()


class GLBBuilder:
    """Accumulates meshes and occurrence nodes, then writes a GLB or glTF."""

    def __init__(self) -> None:
        self._blob = bytearray()
        self._buffer_views: list[pygltflib.BufferView] = []
        self._accessors: list[pygltflib.Accessor] = []
        self._meshes: list[pygltflib.Mesh] = []
        self._mesh_index: dict[MeshKey, int] = {}
        self._nodes: list[pygltflib.Node] = []

    # -- buffer plumbing ------------------------------------------------------

    def _append(self, data: bytes, target: int) -> int:
        """Append bytes to the blob as a new bufferView, returning its index."""
        # glTF requires 4-byte alignment for accessor-referenced views. Every
        # component we write is 4 bytes wide, so this only pads at the tail.
        while len(self._blob) % 4:
            self._blob.append(0)
        offset = len(self._blob)
        self._blob.extend(data)
        self._buffer_views.append(
            pygltflib.BufferView(buffer=0, byteOffset=offset, byteLength=len(data), target=target)
        )
        return len(self._buffer_views) - 1

    def _add_positions(self, vertices: np.ndarray) -> int:
        # float32 keeps the GLB small. Positions are for display only; every
        # number the centre of mass depends on stays float64 in the manifest.
        data = vertices.astype(np.float32)
        view = self._append(data.tobytes(), ARRAY_BUFFER)
        self._accessors.append(
            pygltflib.Accessor(
                bufferView=view,
                componentType=FLOAT,
                count=len(data),
                type="VEC3",
                # Required by spec for POSITION, and used by viewers to frame
                # the scene without walking the vertex data.
                min=data.min(axis=0).tolist(),
                max=data.max(axis=0).tolist(),
            )
        )
        return len(self._accessors) - 1

    def _add_indices(self, indices: np.ndarray) -> int:
        data = indices.astype(np.uint32).ravel()
        view = self._append(data.tobytes(), ELEMENT_ARRAY_BUFFER)
        self._accessors.append(
            pygltflib.Accessor(
                bufferView=view, componentType=UNSIGNED_INT, count=len(data), type="SCALAR"
            )
        )
        return len(self._accessors) - 1

    # -- content --------------------------------------------------------------

    def add_mesh(self, key: MeshKey, mesh: PartMesh, name: str) -> int:
        """Register geometry once; repeat calls for the same key are no-ops."""
        if key in self._mesh_index:
            return self._mesh_index[key]

        position = self._add_positions(mesh.vertices)
        indices = self._add_indices(mesh.indices)
        self._meshes.append(
            pygltflib.Mesh(
                name=name,
                primitives=[
                    pygltflib.Primitive(attributes=pygltflib.Attributes(POSITION=position), indices=indices)
                ],
            )
        )
        index = len(self._meshes) - 1
        self._mesh_index[key] = index
        return index

    def add_occurrence(self, occurrence: Occurrence, mesh_index: int) -> None:
        """Place one instance of a registered mesh, carrying its identity in `extras`."""
        self._nodes.append(
            pygltflib.Node(
                name=occurrence.name,
                mesh=mesh_index,
                matrix=_column_major(occurrence.transform),
                # The join to manifest.json. Kept minimal -- the manifest holds
                # the detail, and every byte here is multiplied by occurrence
                # count (orkv2.md 5.2).
                extras={
                    "key": occurrence.key,
                    "partId": occurrence.part_id,
                    "name": occurrence.name,
                },
            )
        )

    def has_geometry(self) -> bool:
        return bool(self._nodes)

    # -- output ---------------------------------------------------------------

    def build(self) -> GLTF2:
        # Every occurrence node hangs off a single root that carries the axis
        # conversion, so the swap exists in exactly one place.
        child_indices = list(range(len(self._nodes)))
        nodes = list(self._nodes)
        nodes.append(
            pygltflib.Node(name="OnshapeRoot_ZupToYup", rotation=Z_UP_TO_Y_UP, children=child_indices)
        )
        root_index = len(nodes) - 1

        gltf = GLTF2(
            scene=0,
            scenes=[pygltflib.Scene(nodes=[root_index])],
            nodes=nodes,
            meshes=self._meshes,
            accessors=self._accessors,
            bufferViews=self._buffer_views,
            buffers=[pygltflib.Buffer(byteLength=len(self._blob))],
            asset=pygltflib.Asset(generator="onshape-viewer", version="2.0"),
        )
        gltf.set_binary_blob(bytes(self._blob))
        return gltf

    def save(self, path: Path, also_gltf: bool = False) -> None:
        """Write the GLB, optionally alongside a readable .gltf for inspection."""
        gltf = self.build()
        path.parent.mkdir(parents=True, exist_ok=True)
        gltf.save_binary(str(path))
        if also_gltf:
            # save_json emits a .gltf that references an external .bin; writing
            # both lets `jq` read the node extras during development.
            gltf.save_json(str(path.with_suffix(".gltf")))

    def stats(self) -> dict[str, int]:
        vertex_bytes = sum(v.byteLength for v in self._buffer_views)
        return {
            "meshes": len(self._meshes),
            "nodes": len(self._nodes),
            "bufferBytes": vertex_bytes,
        }
