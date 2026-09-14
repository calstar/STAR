"""Structured triangular meridional mesh (paper Section III.F).

A "meridional mesh" is a 2-D triangulation of the half-plane Omega = {(x, r): r >= 0}
obtained by revolving the chamber contour about the axis of symmetry. Every axisymmetric
mode family (m=0 longitudinal/radial, m=1 first tangential, ...) is solved on the *same*
2-D mesh — only the azimuthal wavenumber ``m`` changes between solves (Eq. 9).

``cylinder_mesh`` builds the mesh for the uniform right-circular cylinder used by
verification case V1. Later tiers replace it with a mesh built from the true chamber
contour (revolved via gmsh), without touching the assembly or eigensolver code.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class MeridionalMesh:
    """P1 (linear) triangular mesh of the meridional half-plane.

    ``nodes[k] = (x_k, r_k)`` and ``triangles[e] = (i, j, k)`` are node indices with
    counter-clockwise winding in the (x, r) plane.
    """

    nodes: np.ndarray       # (n_nodes, 2)
    triangles: np.ndarray   # (n_tri, 3), int64

    @property
    def n_nodes(self) -> int:
        return int(self.nodes.shape[0])

    @property
    def n_tri(self) -> int:
        return int(self.triangles.shape[0])

    def axis_nodes(self, tol: float = 1e-9) -> np.ndarray:
        """Node indices on the r=0 axis.

        Needed for the axis-regularity condition (Section III.E): p=0 there for m>=1
        (essential Dirichlet BC), nothing imposed for m=0 (the ``1/r`` weak-form measure
        already enforces the natural condition automatically).
        """
        return np.nonzero(self.nodes[:, 1] <= tol)[0]

    def nodes_at_x(self, x_value: float, tol: float = 1e-9) -> np.ndarray:
        """Node indices lying on the vertical (constant-x) line ``x = x_value``, sorted
        by radius. Used to find the boundary column for a Robin/admittance condition
        (verification case V3's choked-nozzle end) — any structured mesh built by
        ``_structured_mesh`` has an exact shared column there, so this is exact, not a
        nearest-node approximation, as long as ``x_value`` matches a column that was
        actually built into the grid (e.g. ``L`` for ``cylinder_mesh(L, ...)``).
        """
        idx = np.nonzero(np.abs(self.nodes[:, 0] - x_value) <= tol)[0]
        return idx[np.argsort(self.nodes[idx, 1])]

    def locate_point(self, x0: float, r0: float, tol: float = 1e-9
                     ) -> tuple[int, np.ndarray]:
        """Find the element containing ``(x0, r0)`` and its P1 barycentric weights there.

        Needed to place a *compact* (point) source — like V3's point flame — at an
        arbitrary location that generally does not sit exactly on a mesh node: the
        weak-form contribution of a point source is the test function evaluated there,
        which for a P1 field is exactly the barycentric-coordinate interpolation
        returned here (see ``assembly.point_sampling_vector``).

        A plain linear scan over triangles, computing barycentric coordinates and
        checking they are all in [0, 1] — simple and unambiguous, and fast enough for
        the verification-case mesh sizes this is used on (a handful of thousand
        triangles, done once per case setup, not per eigen-solve iteration).

        Returns ``(triangle_index, weights)`` with ``weights`` the 3 barycentric
        coordinates (summing to 1) at the 3 nodes of that triangle.
        """
        for e, tri in enumerate(self.triangles):
            v = self.nodes[tri]
            x1, r1 = v[0]; x2, r2 = v[1]; x3, r3 = v[2]
            denom = (r2 - r3) * (x1 - x3) + (x3 - x2) * (r1 - r3)
            if abs(denom) < 1e-30:
                continue   # degenerate triangle, skip
            w1 = ((r2 - r3) * (x0 - x3) + (x3 - x2) * (r0 - r3)) / denom
            w2 = ((r3 - r1) * (x0 - x3) + (x1 - x3) * (r0 - r3)) / denom
            w3 = 1.0 - w1 - w2
            if (w1 >= -tol) and (w2 >= -tol) and (w3 >= -tol):
                return e, np.array([w1, w2, w3])
        raise ValueError(f"point ({x0}, {r0}) not found inside any mesh triangle")


def _grid_triangles(nx: int, nr: int) -> np.ndarray:
    """Triangulation topology of an nx-by-nr logical node grid (node id = i*nr + j):
    each logical quad cell split into 2 triangles along the same diagonal.

    Shared by the plain tensor-product meshes below AND the wall-mapped meshes of
    ``contour.py`` (where r depends on x): the topology is identical, only the node
    coordinates differ — so the triangulation convention lives in exactly one place.
    """
    def nid(i: int, j: int) -> int:
        return i * nr + j

    tris = []
    for i in range(nx - 1):
        for j in range(nr - 1):
            n00, n10 = nid(i, j), nid(i + 1, j)
            n01, n11 = nid(i, j + 1), nid(i + 1, j + 1)
            # diagonal n00-n11; both triangles wound consistently in (x, r)
            tris.append((n00, n10, n11))
            tris.append((n00, n11, n01))
    return np.asarray(tris, dtype=np.int64)


def _structured_mesh(xs: np.ndarray, rs: np.ndarray) -> MeridionalMesh:
    """Shared builder: structured triangulation over an arbitrary (not necessarily
    uniform) axial node grid ``xs`` crossed with a radial node grid ``rs``.

    Both ``cylinder_mesh`` (uniform ``xs`` spacing) and ``two_zone_duct_mesh`` (two
    uniformly-spaced runs of ``xs`` stitched together, with a shared column at the
    zone interface) delegate to this.
    """
    nx, nr = len(xs), len(rs)
    X, Rr = np.meshgrid(xs, rs, indexing="ij")   # shape (nx, nr); node id = i*nr + j
    nodes = np.column_stack([X.ravel(), Rr.ravel()])
    return MeridionalMesh(nodes=nodes, triangles=_grid_triangles(nx, nr))


def cylinder_mesh(L: float, R: float, nx: int, nr: int) -> MeridionalMesh:
    """Structured mesh of the rectangle [0, L] x [0, R] (uniform cylinder, case V1).

    ``nx``, ``nr`` are node counts (not cell counts) along the axial and radial
    directions. Each of the ``(nx-1)*(nr-1)`` rectangular cells is split into 2
    triangles sharing the same diagonal, so refinement is simply increasing nx, nr.
    """
    if nx < 2 or nr < 2:
        raise ValueError("cylinder_mesh needs at least 2 nodes per direction")
    if L <= 0 or R <= 0:
        raise ValueError("L and R must be positive")

    return _structured_mesh(np.linspace(0.0, L, nx), np.linspace(0.0, R, nr))


def two_zone_duct_mesh(L1: float, L2: float, R: float, nx1: int, nx2: int, nr: int
                       ) -> tuple[MeridionalMesh, np.ndarray]:
    """Structured mesh of a duct [0, L1+L2] x [0, R] with an exact node column at the
    zone interface ``x = L1`` (verification case V2, temperature-jump duct).

    Why an exact shared column, and not two independent grids glued approximately:
    the pressure field itself is physically continuous across a sound-speed
    discontinuity (only its second derivative jumps — see the derivation in
    ``validation/v2_temperature_jump.py``), so the standard, exact way to represent
    that in FEM is a single shared node at the interface, with each side's *element*
    (not node) carrying its own material property. Building ``xs`` as two runs of
    ``linspace`` that share their common endpoint (rather than gluing two separately-
    spaced grids) guarantees that shared column exists exactly, with no search or
    tolerance-based node-snapping needed.

    Returns ``(mesh, zone_of_element)`` where ``zone_of_element`` is an ``(n_tri,)``
    int array, 1 for elements entirely in ``[0, L1]`` and 2 for elements entirely in
    ``[L1, L1+L2]`` — unambiguous because no element straddles the shared column by
    construction.
    """
    if nx1 < 2 or nx2 < 2 or nr < 2:
        raise ValueError("two_zone_duct_mesh needs at least 2 nodes per direction/zone")
    if L1 <= 0 or L2 <= 0 or R <= 0:
        raise ValueError("L1, L2, and R must be positive")

    xs1 = np.linspace(0.0, L1, nx1)                 # nx1 columns, last one at x=L1
    xs2 = np.linspace(L1, L1 + L2, nx2)             # nx2 columns, first one at x=L1 (shared)
    xs = np.concatenate([xs1, xs2[1:]])             # drop the duplicate shared column
    rs = np.linspace(0.0, R, nr)
    mesh = _structured_mesh(xs, rs)

    interface_col = nx1 - 1   # 0-indexed column at x=L1
    n_r_cells = nr - 1
    zone_of_element = []
    for i in range(len(xs) - 1):
        zone = 1 if (i < interface_col) else 2
        zone_of_element += [zone, zone] * n_r_cells   # 2 triangles per (i, j) cell
    return mesh, np.asarray(zone_of_element, dtype=np.int64)
