"""Outer radius profile r(s) of an airframe, and the Barrowman body scalars.

Given the triangles of the selected outer surface and a detected axis, we build a
radial envelope r(s): at each axial station, the radius of the airframe is the
largest radial distance of any surface vertex there. Onshape tessellates with
facet corners lying *on* the true surface, so a vertex's radius is an exact
surface radius and the max over a thin band recovers r(s) with no bias.

From r(s) we produce exactly what ``barrowman_body`` needs:

  * x_fore / x_aft : the axial span, oriented nose (small radius) -> tail
  * r_fore / r_aft : radius at each end (nose tip, base)
  * r_max          : reference radius (OpenRocket ReferenceType.MAXIMUM)
  * volume         : the enclosed solid volume of revolution, ∫π r² ds

The volume uses the exact conical-frustum formula per segment, which is exact for
the piecewise-linear profile a faceted body produces (a cone integrates to
πR²L/3 regardless of station count), rather than a trapezoid of r² which would
bias the cp.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .axis import Axis, detect_axis


@dataclass(frozen=True)
class BodyProfile:
    x_fore: float
    x_aft: float
    r_fore: float
    r_aft: float
    r_max: float
    volume: float
    s_grid: np.ndarray  # station positions (nose->tail), for inspection/plots
    r_grid: np.ndarray  # radius at each station


def _stations(s: np.ndarray, rho: np.ndarray, n_stations: int) -> tuple[np.ndarray, np.ndarray]:
    """Radial envelope: max rho per axial bin, empty bins interpolated."""
    s_min, s_max = float(s.min()), float(s.max())
    if s_max - s_min < 1e-12:
        raise ValueError("degenerate axial extent; the surface has no length")

    edges = np.linspace(s_min, s_max, n_stations + 1)
    centres = 0.5 * (edges[:-1] + edges[1:])
    # np.digitize -> bin index in [1, n_stations]; clamp the top edge in.
    idx = np.clip(np.digitize(s, edges) - 1, 0, n_stations - 1)

    # Seed with -inf, not NaN: np.maximum propagates NaN and would wipe the bin.
    r_grid = np.full(n_stations, -np.inf)
    np.maximum.at(r_grid, idx, rho)

    # Fill empty bins (still -inf) by linear interpolation over their centres,
    # and clamp the ends so a leading/trailing empty bin takes its neighbour.
    known = np.isfinite(r_grid)
    if not known.any():
        raise ValueError("no surface points fell into any station")
    r_grid = np.interp(centres, centres[known], r_grid[known])

    # Prepend/append the true extremes so the span isn't truncated to bin centres.
    s_grid = np.concatenate([[s_min], centres, [s_max]])
    r_grid = np.concatenate([[r_grid[0]], r_grid, [r_grid[-1]]])
    return s_grid, r_grid


def _frustum_volume(s_grid: np.ndarray, r_grid: np.ndarray) -> float:
    """∫π r² ds via exact conical frustums between consecutive stations."""
    ds = np.diff(s_grid)
    r0, r1 = r_grid[:-1], r_grid[1:]
    return float((math.pi / 3.0) * np.sum((r0 * r0 + r0 * r1 + r1 * r1) * ds))


def build_profile(
    triangles: np.ndarray,
    axis: Axis | None = None,
    n_stations: int = 400,
) -> tuple[BodyProfile, Axis]:
    """Build the body profile from outer-surface triangles.

    ``triangles`` is (T, 3, 3) world-frame vertices. If ``axis`` is None it is
    detected from the vertices. The axis is oriented so the nose (small-radius
    end) is at ``x_fore``, matching OpenRocket's nose->tail x convention.
    """
    verts = np.asarray(triangles, dtype=np.float64).reshape(-1, 3)
    if len(verts) < 3:
        raise ValueError("need triangles to build a profile")

    if axis is None:
        axis = detect_axis(verts)

    s, rho = axis.axial_radial(verts)

    # Orient nose->tail: the nose tapers to a small radius. Compare the mean
    # radius of the extreme 5% of the length at each end and flip if needed.
    span = s.max() - s.min()
    lo_end = s <= s.min() + 0.05 * span
    hi_end = s >= s.max() - 0.05 * span
    if rho[lo_end].mean() > rho[hi_end].mean():
        axis = axis.flipped()
        s, rho = axis.axial_radial(verts)

    s_grid, r_grid = _stations(s, rho, n_stations)

    profile = BodyProfile(
        x_fore=float(s_grid[0]),
        x_aft=float(s_grid[-1]),
        r_fore=float(r_grid[0]),
        r_aft=float(r_grid[-1]),
        r_max=float(r_grid.max()),
        volume=_frustum_volume(s_grid, r_grid),
        s_grid=s_grid,
        r_grid=r_grid,
    )
    return profile, axis
