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
    #: A sphere enclosing every vertex (world centre, radius), when the store set one:
    #: lets a whole-model scan skip a face without touching its triangles.
    bound_center: np.ndarray | None = None
    bound_radius: float | None = None

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
        self._faces: list[FaceGeometry] | None = None

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
        """Every face of every occurrence, geometry + axis resolved to world.

        Resolved once per store and cached: callers treat the result as read-only.
        """
        if self._faces is None:
            self._faces = self._resolve_faces()
        return self._faces

    def _resolve_faces(self) -> list[FaceGeometry]:
        """Every occurrence's faces in world, batched per occurrence.

        Each occurrence's triangles are sorted by face once and every face's
        ``triangles`` is a read-only view of that block (a mask per face was
        O(faces x triangles): 55 s of LE4 SD's 96 s). Axes, centres and radii are
        transformed for the whole mesh at once.
        """
        out: list[FaceGeometry] = []
        for occ in self._occurrences:
            mesh = self._meshes[occ.mesh]
            matrix = np.asarray(occ.transform, dtype=np.float64).reshape(4, 4)
            rotation = matrix[:3, :3]
            world = transform_points(mesh.vertices, occ.transform)  # (N, 3)
            order = np.argsort(mesh.face_per_tri, kind="stable")
            tris = world[mesh.indices[order]]  # (M, 3, 3), grouped by face
            tris.flags.writeable = False
            n_faces = len(mesh.face_ids)
            bounds = np.searchsorted(mesh.face_per_tri[order], np.arange(n_faces + 1))

            has_axis = np.isfinite(mesh.face_axes).all(axis=1)
            dirs = mesh.face_axes @ rotation.T
            norms = np.linalg.norm(dirs, axis=1)
            has_axis &= norms > 0
            dirs = dirs / np.where(has_axis, norms, 1.0)[:, None]
            # A sphere has a centre but no axis; it still needs the centre, which is
            # how outer-surface detection tells a rounded nose tip from a stray dome.
            # Gating this on the axis dropped every sphere centre, and with it BART's
            # 2.5 mm tip cap -- leaving the nose blunt at the cone/cap seam.
            has_origin = np.isfinite(mesh.face_origins).all(axis=1)
            origins = transform_points(mesh.face_origins, occ.transform)
            has_radius = np.isfinite(mesh.face_radii)

            counts = np.diff(bounds)
            k_of_face = np.cumsum(counts > 0) - 1
            if counts.any():
                verts = tris.reshape(-1, 3)
                vstarts = 3 * bounds[:-1][counts > 0]
                # The sphere around each face's bounding box: two reductions, no temporaries.
                lo_c = np.minimum.reduceat(verts, vstarts, axis=0)
                hi_c = np.maximum.reduceat(verts, vstarts, axis=0)
                centres = 0.5 * (lo_c + hi_c)
                radii_b = 0.5 * np.linalg.norm(hi_c - lo_c, axis=1)

            for face_index, face_id in enumerate(mesh.face_ids):
                lo, hi = bounds[face_index], bounds[face_index + 1]
                if lo == hi:
                    continue
                out.append(
                    FaceGeometry(
                        occurrence_key=occ.key,
                        part_id=occ.part_id,
                        face_id=face_id,
                        triangles=tris[lo:hi],
                        surface_type=mesh.face_types[face_index],
                        axis_origin=origins[face_index] if has_origin[face_index] else None,
                        axis_dir=dirs[face_index] if has_axis[face_index] else None,
                        radius=float(mesh.face_radii[face_index]) if has_radius[face_index] else None,
                        bound_center=centres[k_of_face[face_index]],
                        bound_radius=float(radii_b[k_of_face[face_index]]),
                    )
                )
        return out

    def faces_for(self, selection: list[tuple[str, str]]) -> list[FaceGeometry]:
        """Resolve an explicit ``(occurrence_key, face_id)`` selection to geometry."""
        wanted = {(k, f) for k, f in selection}
        return [fg for fg in self.iter_faces() if (fg.occurrence_key, fg.face_id) in wanted]


#: Triangles per batch in the per-face reductions below. LE4 SD has 15 M triangles
#: (1.1 GB per float64 copy) on a 5 GB box: stacking them all at once swapped, and
#: ran slower than the face-by-face loop it replaced.
CHUNK_TRIANGLES = 250_000


def stack_triangles(faces: list[FaceGeometry]) -> tuple[np.ndarray, np.ndarray]:
    """The faces' triangles as one ``(T, 3, 3)`` array, and each face's first
    triangle index (``(F,)``), for per-face reductions with ``np.*.reduceat``.
    For a handful of faces; a whole model goes through :func:`face_chunks`."""
    counts = np.fromiter((len(fg.triangles) for fg in faces), dtype=np.int64, count=len(faces))
    starts = np.concatenate([[0], np.cumsum(counts)[:-1]]).astype(np.int64) if len(faces) else counts
    if counts.sum() == 0:
        return np.zeros((0, 3, 3)), starts
    return np.concatenate([fg.triangles for fg in faces]), starts


def face_chunks(faces: list[FaceGeometry], max_triangles: int | None = None):
    """Yield ``(lo, hi, tris, starts)``: faces ``lo:hi`` stacked by :func:`stack_triangles`,
    about ``max_triangles`` (default :data:`CHUNK_TRIANGLES`) at a time; a bigger face
    goes alone."""
    max_triangles = max_triangles or CHUNK_TRIANGLES
    lo, n = 0, 0
    for i, fg in enumerate(faces):
        if n and n + len(fg.triangles) > max_triangles:
            yield (lo, i, *stack_triangles(faces[lo:i]))
            lo, n = i, 0
        n += len(fg.triangles)
    if lo < len(faces):
        yield (lo, len(faces), *stack_triangles(faces[lo:]))


def _per_face(ufunc, values: np.ndarray, starts: np.ndarray, n_values: int, fill: float) -> np.ndarray:
    """``ufunc.reduceat`` over face blocks; ``fill`` where a face has no triangles."""
    out = np.full(len(starts), fill)
    nz = np.diff(np.append(starts, n_values)) > 0
    if nz.any():
        out[nz] = ufunc.reduceat(values, starts[nz])
    return out


def reach_bound(faces: list[FaceGeometry], axis) -> np.ndarray:
    """An upper bound on each face's radial reach from ``axis``, ``(F,)``: the bounding
    sphere's centre distance plus its radius, or ``inf`` for a face without one. A face
    whose bound is under a threshold certainly stays under it."""
    out = np.full(len(faces), np.inf)
    idx = [i for i, fg in enumerate(faces) if fg.bound_center is not None]
    if idx:
        c = np.array([faces[i].bound_center for i in idx])
        r = np.array([faces[i].bound_radius for i in idx])
        rel = c - axis.origin
        s = rel @ axis.direction
        out[idx] = np.linalg.norm(rel - np.outer(s, axis.direction), axis=1) + r
    return out


def face_areas(faces: list[FaceGeometry]) -> np.ndarray:
    """Each face's triangulated area, ``(F,)``."""
    out = np.zeros(len(faces))
    for lo, hi, tris, starts in face_chunks(faces):
        a = 0.5 * np.linalg.norm(np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]), axis=1)
        out[lo:hi] = _per_face(np.add, a, starts, len(tris), 0.0)
    return out


def face_extents(faces: list[FaceGeometry], axis) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Each face's axial min and max and its radial max about ``axis`` (an
    ``aero.axis.Axis``), ``(F,)`` each; NaN for a face with no triangles."""
    s_lo, s_hi, r_hi = (np.full(len(faces), np.nan) for _ in range(3))
    for lo, hi, tris, starts in face_chunks(faces):
        s, rho = axis.axial_radial(tris.reshape(-1, 3))
        vs, nv = 3 * starts, 3 * len(tris)
        s_lo[lo:hi] = _per_face(np.minimum, s, vs, nv, np.nan)
        s_hi[lo:hi] = _per_face(np.maximum, s, vs, nv, np.nan)
        r_hi[lo:hi] = _per_face(np.maximum, rho, vs, nv, np.nan)
    return s_lo, s_hi, r_hi


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
