"""Mesh volume/centroid integration and vertex welding."""

from __future__ import annotations

import numpy as np
import pytest

from backend.onshape.geometry import (
    transform_point,
    transform_points,
    volume_and_centroid,
    weld_vertices,
)


def unit_cube(offset=(0.0, 0.0, 0.0)) -> tuple[np.ndarray, np.ndarray]:
    """A closed unit cube with outward winding, optionally translated."""
    vertices = np.array(
        [
            [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
            [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
        ],
        dtype=np.float64,
    ) + np.asarray(offset, dtype=np.float64)
    faces = np.array(
        [
            [0, 3, 2], [0, 2, 1],  # bottom
            [4, 5, 6], [4, 6, 7],  # top
            [0, 1, 5], [0, 5, 4],  # front
            [2, 3, 7], [2, 7, 6],  # back
            [1, 2, 6], [1, 6, 5],  # right
            [0, 4, 7], [0, 7, 3],  # left
        ],
        dtype=np.uint32,
    )
    return vertices, faces


def test_unit_cube_volume_and_centroid():
    vertices, faces = unit_cube()
    volume, centroid = volume_and_centroid(vertices, faces)
    assert abs(volume) == pytest.approx(1.0, rel=1e-12)
    assert centroid == pytest.approx([0.5, 0.5, 0.5], abs=1e-12)


def test_centroid_is_correct_when_origin_is_outside_the_mesh():
    """Signed tetrahedron volumes must cancel regardless of where the origin sits.

    Parts are rarely centred on their Part Studio origin, so this is the normal
    case rather than an edge case.
    """
    vertices, faces = unit_cube(offset=(10.0, -5.0, 3.0))
    volume, centroid = volume_and_centroid(vertices, faces)
    assert abs(volume) == pytest.approx(1.0, rel=1e-10)
    assert centroid == pytest.approx([10.5, -4.5, 3.5], abs=1e-10)


def test_inverted_winding_flips_sign_but_not_position():
    vertices, faces = unit_cube()
    volume, centroid = volume_and_centroid(vertices, faces[:, ::-1].copy())
    assert volume == pytest.approx(-1.0, rel=1e-12)
    assert centroid == pytest.approx([0.5, 0.5, 0.5], abs=1e-12)


def test_degenerate_mesh_falls_back_to_vertex_mean():
    """A flat sheet has no volume; the centroid must still be somewhere sane."""
    vertices = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], dtype=np.float64)
    faces = np.array([[0, 1, 2]], dtype=np.uint32)
    volume, centroid = volume_and_centroid(vertices, faces)
    assert volume == 0.0
    assert centroid == pytest.approx(vertices.mean(axis=0))


def test_empty_mesh_is_safe():
    volume, centroid = volume_and_centroid(np.zeros((0, 3)), np.zeros((0, 3), dtype=np.uint32))
    assert volume == 0.0
    assert centroid.tolist() == [0.0, 0.0, 0.0]


def test_weld_collapses_duplicates():
    points = np.array([[0, 0, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]], dtype=np.float64)
    unique, indices = weld_vertices(points)
    assert len(unique) == 3
    assert np.allclose(unique[indices], points)


def test_weld_keeps_original_coordinates():
    """Quantising is used only for grouping; a 1e-7 bias must not be introduced."""
    points = np.array([[0.123456789, 0.0, 0.0], [0.123456789, 0.0, 0.0]], dtype=np.float64)
    unique, _ = weld_vertices(points)
    assert unique[0][0] == 0.123456789


def test_weld_preserves_distinct_points():
    points = np.array([[0, 0, 0], [1e-3, 0, 0]], dtype=np.float64)
    unique, _ = weld_vertices(points)
    assert len(unique) == 2


def test_weld_of_empty_input():
    unique, indices = weld_vertices(np.zeros((0, 3)))
    assert len(unique) == 0
    assert len(indices) == 0


def test_transform_applies_rotation_and_translation():
    # 90 degrees about Z, then translate by (1, 2, 3). Row-major.
    matrix = [0, -1, 0, 1, 1, 0, 0, 2, 0, 0, 1, 3, 0, 0, 0, 1]
    assert transform_point([1, 0, 0], matrix) == pytest.approx([1, 3, 3])
    assert transform_point([0, 0, 0], matrix) == pytest.approx([1, 2, 3])


def test_transform_points_matches_single_point():
    matrix = [1, 0, 0, 5, 0, 1, 0, 6, 0, 0, 1, 7, 0, 0, 0, 1]
    points = np.array([[0, 0, 0], [1, 1, 1]], dtype=np.float64)
    out = transform_points(points, matrix)
    assert out[0] == pytest.approx([5, 6, 7])
    assert out[1] == pytest.approx([6, 7, 8])


def test_welded_cube_volume_survives_indexing():
    """Welding must not perturb the integrated volume."""
    vertices, faces = unit_cube()
    soup = vertices[faces].reshape(-1, 3)
    unique, indices = weld_vertices(soup)
    volume, centroid = volume_and_centroid(unique, indices.reshape(-1, 3))
    assert abs(volume) == pytest.approx(1.0, rel=1e-12)
    assert centroid == pytest.approx([0.5, 0.5, 0.5], abs=1e-12)
