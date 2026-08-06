"""Mesh geometry helpers: welding, and volume/centroid from a closed mesh.

orkv2.md 3.1 is emphatic that the centre of mass must never be integrated from
the mesh, because tessellation is lossy and the error is silent. That rule holds
for every part Onshape will give us numbers for, and this module is not used for
those.

It exists for the parts Onshape refuses to answer for. A part with no assigned
material comes back with ``hasMass: false``, ``mass: 0`` *and a centroid of
exactly [0, 0, 0]* -- the position is zeroed along with the mass. Defaulting a
density gets the mass back, but the centroid has to come from somewhere, and the
only remaining source is the geometry.

So the split is:
  * mass     <- exact API ``volume`` x assumed density
  * centroid <- integrated from the mesh, here

which keeps the lossy path confined to parts whose mass was already an
assumption. Parts with real materials never touch this code.
"""

from __future__ import annotations

import numpy as np


def volume_and_centroid(vertices: np.ndarray, indices: np.ndarray) -> tuple[float, np.ndarray]:
    """Volume and volume-centroid of a closed triangle mesh, via the divergence theorem.

    Each triangle forms a tetrahedron with the origin. Signed tetrahedron volumes
    cancel out the parts that face away, so the sum is correct for any closed
    surface regardless of where the origin sits relative to it.

    Args:
        vertices: (N, 3) float array.
        indices: (M, 3) int array of triangle vertex indices.

    Returns:
        (volume, centroid). Volume may be negative if the winding is inverted;
        callers should use ``abs()``. If the mesh is degenerate the centroid
        falls back to the vertex mean, which is at least inside the part.
    """
    if len(indices) == 0 or len(vertices) == 0:
        return 0.0, np.zeros(3)

    tris = vertices[indices]  # (M, 3, 3)
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]

    # Signed volume of the tetrahedron (origin, a, b, c).
    signed = np.einsum("ij,ij->i", a, np.cross(b, c)) / 6.0
    total = float(signed.sum())

    if abs(total) < 1e-18:
        # Open, degenerate, or zero-thickness mesh -- the tetrahedra cancelled.
        # The vertex mean is a poor centroid but a defensible one.
        return 0.0, vertices.mean(axis=0)

    # Centroid of each tetrahedron is the mean of its four vertices, one of
    # which is the origin.
    tet_centroids = (a + b + c) / 4.0
    centroid = (signed[:, None] * tet_centroids).sum(axis=0) / total
    return total, centroid


def weld_vertices(points: np.ndarray, epsilon: float = 1e-7) -> tuple[np.ndarray, np.ndarray]:
    """Collapse duplicate vertices, returning unique points and an index array.

    Onshape returns facet soup: every triangle carries its own three vertices, so
    a shared edge duplicates its endpoints across each adjoining face. Welding at
    1e-7 m (orkv2.md 6, Phase 4) typically cuts vertex count by 3-6x.

    Quantising to an integer lattice rather than doing a true radius query means
    two points either side of a cell boundary can survive as separate vertices.
    That is a cosmetic seam at worst, and it keeps this O(n) instead of O(n log n).
    """
    if len(points) == 0:
        return points.reshape(0, 3), np.zeros((0,), dtype=np.uint32)

    quantised = np.round(points / epsilon).astype(np.int64)
    _, first_index, inverse = np.unique(quantised, axis=0, return_index=True, return_inverse=True)

    # Keep the original float coordinates of the first occurrence, not the
    # quantised value, so we do not introduce a systematic 1e-7 bias.
    unique_points = points[first_index]
    return unique_points, inverse.astype(np.uint32).ravel()


def transform_points(points: np.ndarray, matrix_row_major: list[float]) -> np.ndarray:
    """Apply a row-major 4x4 transform to (N, 3) points."""
    matrix = np.asarray(matrix_row_major, dtype=np.float64).reshape(4, 4)
    rotation, translation = matrix[:3, :3], matrix[:3, 3]
    return points @ rotation.T + translation


def transform_point(point: np.ndarray | list[float], matrix_row_major: list[float]) -> np.ndarray:
    """Apply a row-major 4x4 transform to a single point."""
    return transform_points(np.asarray(point, dtype=np.float64).reshape(1, 3), matrix_row_major)[0]
