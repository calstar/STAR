"""Offline geometry sidecar: per-occurrence triangle meshes with face grouping.

The stability/CoP endpoint needs the actual airframe geometry, in the root
assembly frame, long after the build ran and with **zero Onshape calls**. The GLB
carries geometry too, but it is display-oriented (float32, axis-swapped, welded
for rendering) and awkward to read back per face. So the build writes a second,
analysis-oriented copy here:

    <model>/geometry.npz    vertices / indices / per-triangle face group + axes
    <model>/geometry.json   the index: occurrences -> (mesh, transform), face ids/types

Each face also carries its B-rep surface type (CYLINDER/CONE/SPUN/PLANE/...) and,
for surfaces of revolution, the surface axis -- both from bodydetails.py. That is
what lets the auto-detector pick out the coaxial airframe authoritatively. Axes
are stored in the local frame and transformed to world on read, alongside the
triangles, so they never drift apart. Everything stays float64.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .geometry import transform_points

SIDECAR_VERSION = 2


@dataclass
class FaceGeometry:
    """One B-rep face of one placed occurrence, in the root assembly frame."""

    occurrence_key: str
    part_id: str
    face_id: str
    #: (T, 3, 3) triangle vertices in world (Onshape Z-up) metres.
    triangles: np.ndarray
    surface_type: str
    #: World-frame surface axis for a body of revolution, else None.
    axis_origin: np.ndarray | None
    axis_dir: np.ndarray | None
    radius: float | None

    @property
    def is_sor(self) -> bool:
        from .bodydetails import SOR_TYPES

        return self.surface_type in SOR_TYPES


@dataclass
class _MeshData:
    face_ids: list[str]
    face_types: list[str]
    vertices: np.ndarray  # (N, 3) f64, local frame
    indices: np.ndarray  # (M, 3) u32
    face_per_tri: np.ndarray  # (M,) int32, index into face_ids
    face_origins: np.ndarray  # (F, 3) f64, NaN where the face has no axis
    face_axes: np.ndarray  # (F, 3) f64, NaN where the face has no axis
    face_radii: np.ndarray  # (F,) f64, NaN where none


@dataclass
class _OccData:
    key: str
    part_id: str
    mesh: int
    transform: list[float]  # row-major 4x4


class GeometryStore:
    """Reader over a built model's geometry sidecar."""

    def __init__(self, meshes: list[_MeshData], occurrences: list[_OccData]) -> None:
        self._meshes = meshes
        self._occurrences = occurrences

    # -- loading --------------------------------------------------------------

    @classmethod
    def load(cls, model_dir: Path) -> "GeometryStore":
        index = json.loads((model_dir / "geometry.json").read_text())
        if index.get("version") != SIDECAR_VERSION:
            raise ValueError(
                f"geometry.json version {index.get('version')} != {SIDECAR_VERSION}; rebuild the model."
            )
        arrays = np.load(model_dir / "geometry.npz")
        meshes = [
            _MeshData(
                face_ids=list(m["faceIds"]),
                face_types=list(m["faceTypes"]),
                vertices=arrays[f"v{j}"],
                indices=arrays[f"i{j}"],
                face_per_tri=arrays[f"f{j}"],
                face_origins=arrays[f"o{j}"],
                face_axes=arrays[f"x{j}"],
                face_radii=arrays[f"r{j}"],
            )
            for j, m in enumerate(index["meshes"])
        ]
        occurrences = [
            _OccData(key=o["key"], part_id=o["partId"], mesh=o["mesh"], transform=o["transform"])
            for o in index["occurrences"]
        ]
        return cls(meshes, occurrences)

    @staticmethod
    def exists(model_dir: Path) -> bool:
        return (model_dir / "geometry.json").exists() and (model_dir / "geometry.npz").exists()

    # -- access ---------------------------------------------------------------

    def occurrence_keys(self) -> list[str]:
        return [o.key for o in self._occurrences]

    def iter_faces(self) -> list[FaceGeometry]:
        """Every face of every occurrence, geometry + axis resolved to world."""
        out: list[FaceGeometry] = []
        for occ in self._occurrences:
            mesh = self._meshes[occ.mesh]
            matrix = np.asarray(occ.transform, dtype=np.float64).reshape(4, 4)
            rotation = matrix[:3, :3]
            world = transform_points(mesh.vertices, occ.transform)  # (N, 3)
            tris = world[mesh.indices]  # (M, 3, 3)
            for face_index, face_id in enumerate(mesh.face_ids):
                sel = mesh.face_per_tri == face_index
                if not sel.any():
                    continue
                origin = mesh.face_origins[face_index]
                axis = mesh.face_axes[face_index]
                has_axis = np.isfinite(axis).all()
                axis_dir = None
                axis_org = None
                if has_axis:
                    d = rotation @ axis
                    n = np.linalg.norm(d)
                    axis_dir = d / n if n > 0 else None
                    axis_org = transform_points(origin.reshape(1, 3), occ.transform)[0]
                radius = mesh.face_radii[face_index]
                out.append(
                    FaceGeometry(
                        occurrence_key=occ.key,
                        part_id=occ.part_id,
                        face_id=face_id,
                        triangles=tris[sel],
                        surface_type=mesh.face_types[face_index],
                        axis_origin=axis_org,
                        axis_dir=axis_dir,
                        radius=(float(radius) if np.isfinite(radius) else None),
                    )
                )
        return out

    def faces_for(self, selection: list[tuple[str, str]]) -> list[FaceGeometry]:
        """Resolve an explicit ``(occurrence_key, face_id)`` selection to geometry."""
        wanted = {(k, f) for k, f in selection}
        return [fg for fg in self.iter_faces() if (fg.occurrence_key, fg.face_id) in wanted]


def _dedup_meshes(parts, sources) -> tuple[list[_MeshData], list[_OccData]]:
    """Collect unique part meshes (with surface info) and occurrence mapping."""
    from .glb import MeshKey

    mesh_list: list[_MeshData] = []
    mesh_index: dict[MeshKey, int] = {}
    occ_list: list[_OccData] = []

    for record in parts:
        occ = record.occurrence
        data = sources[occ.source]
        mesh = data.meshes.get(occ.part_id)
        if mesh is None:
            continue
        key = MeshKey(occ.source.element_id, occ.part_id, occ.source.configuration)
        if key not in mesh_index:
            surfaces = (data.surfaces or {}).get(occ.part_id, {})
            f = len(mesh.face_ids)
            types: list[str] = []
            origins = np.full((f, 3), np.nan)
            axes = np.full((f, 3), np.nan)
            radii = np.full(f, np.nan)
            for k, fid in enumerate(mesh.face_ids):
                s = surfaces.get(fid)
                types.append(s.type if s else "OTHER")
                if s and s.origin is not None:
                    origins[k] = s.origin
                if s and s.axis is not None:
                    axes[k] = s.axis
                if s and s.radius is not None:
                    radii[k] = s.radius
            mesh_index[key] = len(mesh_list)
            mesh_list.append(
                _MeshData(
                    face_ids=list(mesh.face_ids),
                    face_types=types,
                    vertices=mesh.vertices,
                    indices=mesh.indices,
                    face_per_tri=mesh.face_id_per_triangle(),
                    face_origins=origins,
                    face_axes=axes,
                    face_radii=radii,
                )
            )
        occ_list.append(
            _OccData(key=occ.key, part_id=occ.part_id, mesh=mesh_index[key], transform=occ.transform)
        )

    return mesh_list, occ_list


def write_geometry(model_dir: Path, parts, sources) -> dict:
    """Write geometry.npz + geometry.json for a built model. Returns small stats."""
    mesh_list, occ_list = _dedup_meshes(parts, sources)

    arrays: dict[str, np.ndarray] = {}
    for j, m in enumerate(mesh_list):
        arrays[f"v{j}"] = m.vertices.astype(np.float64)
        arrays[f"i{j}"] = m.indices.astype(np.uint32)
        arrays[f"f{j}"] = m.face_per_tri.astype(np.int32)
        arrays[f"o{j}"] = m.face_origins.astype(np.float64)
        arrays[f"x{j}"] = m.face_axes.astype(np.float64)
        arrays[f"r{j}"] = m.face_radii.astype(np.float64)

    model_dir.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(model_dir / "geometry.npz", **arrays)

    index = {
        "version": SIDECAR_VERSION,
        "meshes": [{"faceIds": m.face_ids, "faceTypes": m.face_types} for m in mesh_list],
        "occurrences": [
            {"key": o.key, "partId": o.part_id, "mesh": o.mesh, "transform": o.transform}
            for o in occ_list
        ],
    }
    (model_dir / "geometry.json").write_text(json.dumps(index))

    return {"meshes": len(mesh_list), "occurrences": len(occ_list)}
