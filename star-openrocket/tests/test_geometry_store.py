"""GeometryStore's batched face resolution and the per-face reductions over it.

Each is checked against the plain face-by-face computation it replaced, written out
here, on a mesh whose faces' triangles are interleaved and one face has none.
"""

from __future__ import annotations

import numpy as np
import pytest

from backend.onshape import geometry_store as gs
from backend.onshape.aero import stability
from backend.onshape.aero.axis import Axis
from backend.onshape.geometry import transform_points

RNG = np.random.default_rng(7)


def _transform(angle: float, shift: tuple[float, float, float]) -> list[float]:
    c, s = np.cos(angle), np.sin(angle)
    m = np.array([[c, -s, 0, shift[0]], [s, c, 0, shift[1]], [0, 0, 1, shift[2]], [0, 0, 0, 1.0]])
    return m.ravel().tolist()


def _store() -> gs.GeometryStore:
    n_v, n_t = 40, 60
    face_per_tri = RNG.choice([0, 1, 3], size=n_t).astype(np.int32)  # face 2 has none
    mesh = gs._MeshData(
        face_ids=["A", "B", "C", "D"],
        face_types=["CYLINDER", "PLANE", "PLANE", "SPHERE"],
        vertices=RNG.normal(size=(n_v, 3)),
        indices=RNG.integers(0, n_v, size=(n_t, 3)).astype(np.uint32),
        face_per_tri=face_per_tri,
        face_origins=np.array([[0, 0, 1.0], [np.nan] * 3, [np.nan] * 3, [1, 2, 3.0]]),
        face_axes=np.array([[0, 0, 2.0], [np.nan] * 3, [np.nan] * 3, [np.nan] * 3]),
        face_radii=np.array([0.5, np.nan, np.nan, 0.2]),
    )
    occs = [
        gs._OccData("o1", "p", 0, _transform(0.3, (1, 2, 3))),
        gs._OccData("o2", "p", 0, _transform(-1.1, (0, 0, -5))),
    ]
    return gs.GeometryStore([mesh], occs)


def _faces_by_mask(store: gs.GeometryStore) -> list[tuple]:
    """The old resolution: one mask over every triangle per face."""
    out = []
    for occ in store._occurrences:
        mesh = store._meshes[occ.mesh]
        rot = np.asarray(occ.transform).reshape(4, 4)[:3, :3]
        tris = transform_points(mesh.vertices, occ.transform)[mesh.indices]
        for i, fid in enumerate(mesh.face_ids):
            sel = mesh.face_per_tri == i
            if not sel.any():
                continue
            ax = mesh.face_axes[i]
            d = rot @ ax / np.linalg.norm(rot @ ax) if np.isfinite(ax).all() else None
            o = mesh.face_origins[i]
            org = transform_points(o.reshape(1, 3), occ.transform)[0] if np.isfinite(o).all() else None
            out.append((occ.key, fid, tris[sel], d, org))
    return out


def test_faces_match_the_mask_per_face_resolution():
    store = _store()
    faces = store.iter_faces()
    ref = _faces_by_mask(store)
    assert [(f.occurrence_key, f.face_id) for f in faces] == [(r[0], r[1]) for r in ref]
    assert "C" not in {f.face_id for f in faces}
    for f, (_, _, tris, d, org) in zip(faces, ref):
        np.testing.assert_array_equal(f.triangles, tris)  # same triangles, same order
        if d is None:
            assert f.axis_dir is None
        else:
            np.testing.assert_allclose(f.axis_dir, d, atol=1e-15)
        if org is None:
            assert f.axis_origin is None
        else:
            np.testing.assert_allclose(f.axis_origin, org, atol=1e-15)


def test_faces_are_resolved_once_and_read_only():
    store = _store()
    assert store.iter_faces() is store.iter_faces()
    with pytest.raises(ValueError):
        store.iter_faces()[0].triangles[0, 0, 0] = 1.0


AXIS = Axis(origin=np.array([0.2, -0.1, 0.0]), direction=np.array([0.0, 0.6, 0.8]))


@pytest.mark.parametrize("chunk", [1, 7, 10_000])
def test_per_face_reductions_match_a_loop_at_any_chunk(monkeypatch, chunk):
    monkeypatch.setattr(gs, "CHUNK_TRIANGLES", chunk)
    faces = _store().iter_faces()
    s_lo, s_hi, r_hi = gs.face_extents(faces, AXIS)
    areas = gs.face_areas(faces)
    for i, f in enumerate(faces):
        s, rho = AXIS.axial_radial(f.triangles.reshape(-1, 3))
        assert (s_lo[i], s_hi[i], r_hi[i]) == pytest.approx((s.min(), s.max(), rho.max()), abs=1e-14)
        t = f.triangles
        a = 0.5 * np.linalg.norm(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1).sum()
        assert areas[i] == pytest.approx(a, abs=1e-14)


def test_reach_bound_never_under_states_a_face():
    faces = _store().iter_faces()
    _, _, r_hi = gs.face_extents(faces, AXIS)
    bound = gs.reach_bound(faces, AXIS)
    assert np.all(bound >= r_hi - 1e-12)
    assert np.all(bound < 3 * r_hi.max())  # and is a bound worth having


def test_per_face_reductions_leave_an_empty_face_empty():
    faces = list(_store().iter_faces()[:3])
    empty = gs.FaceGeometry("o", "p", "E", np.zeros((0, 3, 3)), "PLANE", None, None, None)
    for at in (0, 2, 3):
        mixed = faces[:at] + [empty] + faces[at:]
        s_lo, s_hi, r_hi = gs.face_extents(mixed, AXIS)
        assert np.isnan([s_lo[at], s_hi[at], r_hi[at]]).all()
        np.testing.assert_allclose(np.delete(r_hi, at), gs.face_extents(faces, AXIS)[2])
        assert gs.face_areas(mixed)[at] == 0.0


def _plane_store(tris: np.ndarray) -> gs.GeometryStore:
    """One face per triangle of ``tris`` ``(F, 3, 3)``, untransformed."""
    f = len(tris)
    mesh = gs._MeshData(
        face_ids=[f"F{i}" for i in range(f)],
        face_types=["PLANE"] * f,
        vertices=tris.reshape(-1, 3),
        indices=np.arange(3 * f, dtype=np.uint32).reshape(f, 3),
        face_per_tri=np.arange(f, dtype=np.int32),
        face_origins=np.full((f, 3), np.nan),
        face_axes=np.full((f, 3), np.nan),
        face_radii=np.full(f, np.nan),
    )
    return gs.GeometryStore([mesh], [gs._OccData("o", "p", 0, _transform(0.0, (0, 0, 0)))])


def test_aftmost_point_survives_a_box_centre_above_every_vertex():
    """A triangle across the three unit axes, seen down (1,1,1): its box centre is at
    0.866 but its furthest vertex only 0.577. A small face at 0.7 is the answer, and a
    cut that took box centres as lower bounds would throw it away."""
    d = np.ones(3) / np.sqrt(3)
    wide = np.eye(3)
    small = 0.7 * d + 1e-3 * np.eye(3)
    store = _plane_store(np.stack([wide, small]))
    want = float((small @ d).max())
    assert stability._aftmost_axial(store, Axis(origin=np.zeros(3), direction=d)) == pytest.approx(want)


def test_aftmost_point_is_the_brute_force_one():
    """Many small faces close together, over many directions: the pruning must never
    drop the face holding the aftmost vertex."""
    centres = RNG.normal(size=(300, 1, 3))
    centres /= np.linalg.norm(centres, axis=2, keepdims=True)
    tris = centres + RNG.uniform(0.002, 0.05, size=(300, 1, 1)) * RNG.normal(size=(300, 3, 3))
    store = _plane_store(tris)
    verts = tris.reshape(-1, 3)
    for d in RNG.normal(size=(200, 3)):
        axis = Axis(origin=np.zeros(3), direction=d / np.linalg.norm(d))
        want = float((verts @ axis.direction).max())
        assert stability._aftmost_axial(store, axis) == pytest.approx(want, abs=1e-14)
