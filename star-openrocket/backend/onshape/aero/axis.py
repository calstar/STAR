"""Longitudinal axis detection and axial/radial coordinates.

A rocket is long and slender, so the axis of the airframe is overwhelmingly the
direction of greatest spatial extent. We take it as the first principal component
of the outer-surface vertices (equivalently the largest-eigenvalue eigenvector of
their covariance). This is robust to which faces are selected as long as they span
the length of the airframe.

The result is an origin (a point on the axis) and a unit direction. Everything
downstream works in axial ``s`` (distance along the axis) and radial ``rho``
(distance from the axis), which is the natural frame for a body of revolution.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class Axis:
    origin: np.ndarray  # (3,) a point on the axis (the point cloud centroid)
    direction: np.ndarray  # (3,) unit vector along the rocket's length

    def axial_radial(self, points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Map (N,3) world points to axial ``s`` and radial ``rho`` arrays."""
        rel = np.asarray(points, dtype=np.float64) - self.origin
        s = rel @ self.direction
        radial_vec = rel - np.outer(s, self.direction)
        rho = np.linalg.norm(radial_vec, axis=1)
        return s, rho

    def flipped(self) -> "Axis":
        return Axis(origin=self.origin, direction=-self.direction)


def detect_axis(points: np.ndarray) -> Axis:
    """Principal axis of a point cloud (largest-variance direction)."""
    pts = np.asarray(points, dtype=np.float64)
    if len(pts) < 2:
        raise ValueError("need at least two points to detect an axis")
    origin = pts.mean(axis=0)
    centred = pts - origin
    # SVD is more numerically stable than forming the covariance explicitly.
    _, _, vh = np.linalg.svd(centred, full_matrices=False)
    direction = vh[0]
    direction = direction / np.linalg.norm(direction)
    return Axis(origin=origin, direction=direction)
