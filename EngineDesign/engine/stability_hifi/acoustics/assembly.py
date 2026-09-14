"""FEM assembly of the passive (no flame, no boundary impedance) axisymmetric
thermoacoustic operator: the ``K``, ``Km``, ``M2`` matrices of Eq. (10)/(11) in
``docs/stability/thermoacoustic_global_stability_paper.md``.

    K   = int_Omega  c^2 (grad p . grad phi)      r  dOmega     stiffness
    Km  = int_Omega  (c^2 / r)  p  phi                 dOmega     azimuthal term (x m^2)
    M2  = int_Omega  p  phi                        r  dOmega     mass

With these, the passive discrete eigenproblem (flame off, rigid walls: C=0, F=0) is

    (K + m^2 Km) p = -lambda^2 M2 p

a *linear* generalized eigenvalue problem in mu = -lambda^2 (real, >= 0 for a lossless
rigid-wall cavity, since K, Km, M2 are all real symmetric positive-(semi)definite) —
see ``eigen/passive.py``.

Why K and M2 have exact closed forms but Km does not
-----------------------------------------------------
On a P1 (linear) triangle, the shape functions N_i are the barycentric coordinates
L_i, and grad(N_i) is *constant* over the element. The radial coordinate r(x) is
itself a linear (degree-1) function of position, since it is a coordinate. So:

  - K's integrand, c^2 * (grad N_i . grad N_j) * r, is (const) * (linear in r) ->
    integrable exactly by the 1-point centroid rule: int_T r dA = Area * r_centroid.

  - M2's integrand, N_i * N_j * r, is a *cubic* polynomial (degree 2 from N_i N_j,
    degree 1 from r). Triangle integrals of monomials in barycentric coordinates have
    a standard closed form (see ``_mass_r_element`` below), so M2 is also exact.

  - Km's integrand, N_i * N_j / r, is *not* polynomial (r appears in the denominator)
    so no closed form exists; it is evaluated with a 6-point Gauss quadrature rule
    (exact for polynomials up to degree 4), which is far more resolution than the
    (non-polynomial) 1/r factor needs for engineering accuracy, and cheap since it
    only touches the m>=1 (transverse) matrix.

Mean-flow fields (``c``, i.e. sound speed) are supplied per-node and averaged over the
three vertices of an element to get a single c^2 per element — piecewise-constant per
element, consistent with the P1 discretization.
"""

from __future__ import annotations

import math
from typing import Tuple

import numpy as np
from scipy import sparse

from engine.stability_hifi.acoustics.mesh import MeridionalMesh


# ---------------------------------------------------------------------------
# Quadrature and element-level geometry
# ---------------------------------------------------------------------------

# 6-point symmetric Gauss quadrature on the reference triangle, exact to degree 4
# (Dunavant 1985). Rows are barycentric coordinates (lambda1, lambda2, lambda3) of
# the quadrature point; weights sum to 1 (fraction-of-area convention, so a physical
# integral is `area * sum_q w_q * f(point_q)`).
_GAUSS6_BARY = np.array([
    [0.108103018168070, 0.445948490915965, 0.445948490915965],
    [0.445948490915965, 0.108103018168070, 0.445948490915965],
    [0.445948490915965, 0.445948490915965, 0.108103018168070],
    [0.816847572980459, 0.091576213509771, 0.091576213509771],
    [0.091576213509771, 0.816847572980459, 0.091576213509771],
    [0.091576213509771, 0.091576213509771, 0.816847572980459],
])
_GAUSS6_W = np.array([
    0.223381589678011, 0.223381589678011, 0.223381589678011,
    0.109951743655322, 0.109951743655322, 0.109951743655322,
])


def _element_geometry(v: np.ndarray) -> Tuple[float, np.ndarray]:
    """Triangle area and constant P1 shape-function gradients.

    ``v`` is (3, 2): vertex (x, r) coordinates. Returns ``(area, grad)`` with
    ``grad[i] = (dN_i/dx, dN_i/dr)``, constant over the element (standard P1 formula).
    """
    x = v[:, 0]
    r = v[:, 1]
    two_area = x[0] * (r[1] - r[2]) + x[1] * (r[2] - r[0]) + x[2] * (r[0] - r[1])
    area = 0.5 * abs(two_area)
    b = np.array([r[1] - r[2], r[2] - r[0], r[0] - r[1]])
    c = np.array([x[2] - x[1], x[0] - x[2], x[1] - x[0]])
    grad = np.column_stack([b, c]) / two_area
    return area, grad


# Exact triangle-integral tensor for int L_i L_j L_k dA, from the standard formula
#   int_T L1^a L2^b L3^c dA = a! b! c! / (a+b+c+2)!  *  2*Area .
# For a triple of shape-function indices (i, j, k) drawn from {0,1,2} (repeats
# allowed), (a, b, c) is just the multiplicity of label 0, 1, 2 among the triple, so
# the value depends only on how many of (i, j, k) coincide:
#   all three equal   -> 3!0!0!/5! * 2A = A/10
#   exactly two equal  -> 2!1!0!/5! * 2A = A/30
#   all three distinct -> 1!1!1!/5! * 2A = A/60
def _triple_integral_factor(i: int, j: int, k: int) -> float:
    counts = [0, 0, 0]
    for idx in (i, j, k):
        counts[idx] += 1
    prod = math.factorial(counts[0]) * math.factorial(counts[1]) * math.factorial(counts[2])
    return prod / math.factorial(3 + 2)   # = prod/120; multiply by 2*Area for the integral


_TRIPLE_FACTOR = np.array(
    [[[_triple_integral_factor(i, j, k) for k in range(3)] for j in range(3)] for i in range(3)]
)  # (3,3,3); integral = 2*Area * _TRIPLE_FACTOR[i,j,k]


def _mass_r_element(area: float, r_vertices: np.ndarray) -> np.ndarray:
    """Exact element mass matrix ``int_T N_i N_j r dA`` (r linear -> cubic integrand).

    Expand ``r = sum_k N_k r_k`` and use the exact triple-product triangle integral.
    """
    # Me[i,j] = sum_k r_k * (2*Area * _TRIPLE_FACTOR[i,j,k])
    return 2.0 * area * np.tensordot(_TRIPLE_FACTOR, r_vertices, axes=([2], [0]))


def _stiffness_r_element(area: float, grad: np.ndarray, r_vertices: np.ndarray) -> np.ndarray:
    """Exact element stiffness ``int_T (grad N_i . grad N_j) r dA`` (centroid rule).

    ``grad`` is constant over the element, and ``r`` is linear, so the 1-point
    centroid rule (`int_T r dA = Area * mean(r_vertices)`) is exact.
    """
    r_bar = float(np.mean(r_vertices))
    return area * r_bar * (grad @ grad.T)


def _azimuthal_element(area: float, r_vertices: np.ndarray) -> np.ndarray:
    """Element ``int_T N_i N_j / r dA`` via 6-point Gauss quadrature (no closed form)."""
    Ke = np.zeros((3, 3))
    for bary, w in zip(_GAUSS6_BARY, _GAUSS6_W):
        r_q = float(bary @ r_vertices)
        if r_q <= 0.0:
            continue   # quadrature point exactly on the axis: 1/r term vanishes weakly
        Ke += (w * area / r_q) * np.outer(bary, bary)
    return Ke


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def assemble_passive(mesh: MeridionalMesh, c_sound: np.ndarray, m: int
                     ) -> Tuple[sparse.csr_matrix, sparse.csr_matrix, sparse.csr_matrix]:
    """Assemble the passive (flame-off, rigid-wall) K, Km, M2 matrices (Eq. 10, 11).

    ``c_sound`` is the sound-speed field [m/s], given EITHER per-node (shape
    ``(n_nodes,)`` — the mean flow varies smoothly, e.g. V1's uniform field or a real
    CFD/parametric temperature profile; each element's c^2 is the mean of its 3 vertex
    values, i.e. the P1 linear interpolant evaluated at the centroid) OR per-element
    (shape ``(n_tri,)`` — the material is piecewise-constant across a genuine interface
    that a shared node cannot represent, e.g. V2's temperature-jump duct; each element's
    c^2 is used directly, with no averaging across the interface). See
    ``_element_c_squared`` above for why this distinction matters physically.

    ``m`` is the azimuthal wavenumber; ``Km`` is returned *without* the m^2 factor
    (caller multiplies when assembling ``K + m^2 * Km``), so the m=0 matrix (which has
    no 1/r term at all) can be skipped cheaply by callers that only need
    longitudinal/radial modes.

    Returns ``(K, Km, M2)`` as real symmetric sparse CSR matrices of size n_nodes^2.
    Axis-regularity Dirichlet elimination for m>=1 is the caller's job (``eigen/passive.py``),
    since it depends on how the reduced system is solved, not on the assembly.
    """
    n = mesh.n_nodes
    rows, cols, vK, vKm, vM = [], [], [], [], []

    need_azimuthal = (m != 0)

    c_sound = np.asarray(c_sound)
    if c_sound.shape[0] == mesh.n_nodes:
        per_element_c2 = None    # computed inside the loop, by averaging vertex values
    elif c_sound.shape[0] == mesh.n_tri:
        per_element_c2 = c_sound ** 2   # already one value per element; use directly
    else:
        raise ValueError(
            f"c_sound has length {c_sound.shape[0]}, expected n_nodes={mesh.n_nodes} "
            f"(smooth per-node field) or n_tri={mesh.n_tri} (piecewise-constant per-element field)"
        )

    for e, tri in enumerate(mesh.triangles):
        v = mesh.nodes[tri]                    # (3, 2)
        r_vertices = v[:, 1]
        area, grad = _element_geometry(v)
        if area <= 0.0:
            raise ValueError("degenerate (zero-area) triangle in mesh")

        c2_e = float(per_element_c2[e]) if per_element_c2 is not None else float(np.mean(c_sound[tri]) ** 2)

        Ke = c2_e * _stiffness_r_element(area, grad, r_vertices)
        Me = _mass_r_element(area, r_vertices)
        Kme = c2_e * _azimuthal_element(area, r_vertices) if need_azimuthal else np.zeros((3, 3))

        for a in range(3):
            for b in range(3):
                rows.append(tri[a]); cols.append(tri[b])
                vK.append(Ke[a, b]); vKm.append(Kme[a, b]); vM.append(Me[a, b])

    K = sparse.coo_matrix((vK, (rows, cols)), shape=(n, n)).tocsr()
    Km = sparse.coo_matrix((vKm, (rows, cols)), shape=(n, n)).tocsr()
    M2 = sparse.coo_matrix((vM, (rows, cols)), shape=(n, n)).tocsr()
    return K, Km, M2


# ---------------------------------------------------------------------------
# Boundary admittance term C (Eq. 8, 10) — new for verification case V3
# ---------------------------------------------------------------------------
#
# Section III.E, Eq. (8): a Robin condition grad(p_hat).n = -(lambda / (c*z)) * p_hat
# on a boundary patch with specific impedance z (admittance y = 1/z). In the weak form
# (Eq. 10) this becomes a boundary integral that, after moving everything to one side,
# contributes a term "+ lambda * C" to the discrete operator N(lambda), where
#
#     C = int_Gamma (c_bar / z) p_tilde phi_bar  r  dGamma  =  int_Gamma (c_bar * y) ... r dGamma
#
# For the *compact* choked-nozzle admittance (Appendix C), y = y_noz = (gamma-1)*Mbar_e/2
# is a REAL CONSTANT (no dependence on lambda or position along the boundary), so C here
# is just a fixed real matrix -- the general C(lambda) notation in the paper allows for a
# frequency-dependent z(lambda) (e.g. the quasi-1D nozzle admittance ODE, Section III.E),
# which is not needed for this compact case.
#
# Geometrically the boundary here is the disk at x = L (all r in [0, R]): revolved about
# the axis, a "boundary edge" of the meridional mesh is a radial line segment between two
# adjacent boundary nodes, and dGamma = dr along it (x fixed). The r-weighted edge mass
# matrix int_edge N_i N_j r dr has the same kind of exact closed form as the volume mass
# matrix M2 (Eq. above): r is linear along the edge, so N_i*N_j*r is a cubic polynomial
# in the edge's local (1-D barycentric) coordinate, integrated exactly below.

def _boundary_mass_r_edge(r_a: float, r_b: float) -> np.ndarray:
    """Exact 2x2 edge matrix ``int_edge N_i N_j r dr`` for a radial edge from r_a to r_b.

    Derived the same way as ``_mass_r_element`` but for a 1-D edge (2 nodes) instead of
    a 2-D triangle (3 nodes): expand r(zeta) = r_a*(1-zeta) + r_b*zeta linearly in the
    edge's local coordinate and integrate exactly (integrals of monomials in 1-D
    barycentric coordinates have the same style of closed form as the 2-D case).
    """
    L = abs(r_b - r_a)
    return L * np.array([
        [r_a / 4.0 + r_b / 12.0,   (r_a + r_b) / 12.0],
        [(r_a + r_b) / 12.0,       r_a / 12.0 + r_b / 4.0],
    ])


def assemble_boundary_admittance(mesh: MeridionalMesh, boundary_nodes: np.ndarray,
                                 coefficient: float) -> sparse.csr_matrix:
    """Assemble ``C`` for a compact (frequency-independent) admittance boundary patch.

    ``boundary_nodes`` must be the node indices along the boundary, SORTED BY RADIUS
    (exactly what ``MeridionalMesh.nodes_at_x`` returns) — consecutive pairs are treated
    as the mesh's boundary edges there. ``coefficient`` is ``c_bar * y`` (real, for the
    compact admittance case); the caller multiplies the returned matrix into ``lambda*C``
    when assembling the full operator.
    """
    n = mesh.n_nodes
    rows, cols, vals = [], [], []
    r_vals = mesh.nodes[boundary_nodes, 1]
    for e in range(len(boundary_nodes) - 1):
        i, j = boundary_nodes[e], boundary_nodes[e + 1]
        Ce = coefficient * _boundary_mass_r_edge(r_vals[e], r_vals[e + 1])
        for a, ia in enumerate((i, j)):
            for b, ib in enumerate((i, j)):
                rows.append(ia); cols.append(ib); vals.append(Ce[a, b])
    return sparse.coo_matrix((vals, (rows, cols)), shape=(n, n)).tocsr()


# ---------------------------------------------------------------------------
# Compact-flame vectors b_k, g_k — new for verification case V3
# ---------------------------------------------------------------------------
#
# Eq. 11's flame matrix is F(lambda) = (gamma-1) * sum_k exp(-lambda*tau_k) * g_k @ b_k.T
# with two DIFFERENT roles, not one vector reused twice:
#
#   b_k = [N_i(x_ref,k)]_i   a plain POINT SAMPLE (Eq. 7a: the flame reads the pressure
#                             at one reference point x_ref, dimensionless interpolation,
#                             no r-weighting).
#   g_k = [int_Omega n_p (qbar_dot/pbar) N_i r dOmega]_i   a VOLUME-INTEGRATED weight
#                             (how much of the domain's test function each node's
#                             energy-injection couples to; carries the same r dOmega
#                             measure as every other matrix here).
#
# Treating both as the same plain point sample (an easy mistake — an earlier attempt at
# this module did exactly that) silently makes the flame's effect on the discrete system
# depend on the chamber radius R in an unphysical way: g_k, unlike b_k, needs the r
# dOmega measure to have consistent physical scale against K, M2, and C, all of which
# carry the same measure. Concretely: a point-sampled g_k does not shrink as R shrinks,
# but M2 and K do (both are r-weighted volume integrals) — so on a smaller-radius mesh
# the flame term becomes artificially, arbitrarily stronger relative to everything else.
# Verified numerically before trusting this: with a point-sampled g_k, even a nominally
# "very weak" flame_gain moved the mode's frequency by hundreds of Hz, an obviously
# unphysical sensitivity for a small parameter, and the shift did not scale down when
# flame_gain was reduced further -- the tell that the *coupling itself*, not just its
# value, was mis-scaled. Fixed below by giving g_k its own, properly r-weighted builder.

def point_sampling_vector(mesh: MeridionalMesh, x0: float, r0: float) -> np.ndarray:
    """The b_k vector: nodal weights such that ``g @ p`` = the P1-interpolated value of
    field ``p`` at the point ``(x0, r0)`` — a plain point sample, Eq. 7a's x_ref.

    Nonzero only at the 3 nodes of the triangle containing the point (its barycentric
    weights there — see ``MeridionalMesh.locate_point``).
    """
    tri_index, weights = mesh.locate_point(x0, r0)
    b = np.zeros(mesh.n_nodes)
    b[mesh.triangles[tri_index]] = weights
    return b


def disk_load_vector(mesh: MeridionalMesh, column_nodes: np.ndarray) -> np.ndarray:
    """The g_k vector for a compact-in-x, UNIFORM-across-the-cross-section flame at the
    axial column given by ``column_nodes`` (node indices there, SORTED BY RADIUS —
    exactly what ``MeridionalMesh.nodes_at_x`` returns; the flame location must
    therefore fall on an exact mesh column, e.g. by building the mesh with
    ``two_zone_duct_mesh`` even when there is no real material jump, purely to get an
    exact shared column at the flame's axial location).

    ``g_i = int_r N_i(x_f, r) * r dr`` along that column: same r dOmega measure as K,
    M2, C (see the module-level note above for why that consistency matters), computed
    per edge via the same barycentric-monomial exact-integral trick as
    ``_boundary_mass_r_edge``, but for a LOAD VECTOR (int N_i * 1 * r dr) rather than a
    mass MATRIX (int N_i N_j r dr): for an edge from r_a to r_b, the exact two-node
    contribution is ``L*[r_a/3+r_b/6, r_a/6+r_b/3]`` (L = r_b - r_a).

    Sanity check used while developing this: summed over the whole column, ``g``'s
    total is exactly ``int_0^R r dr = R^2/2`` — reproduced below to machine precision,
    confirming the exact-integral bookkeeping is right.
    """
    n = mesh.n_nodes
    g = np.zeros(n)
    r_vals = mesh.nodes[column_nodes, 1]
    for e in range(len(column_nodes) - 1):
        r_a, r_b = r_vals[e], r_vals[e + 1]
        edge_len = r_b - r_a
        g[column_nodes[e]] += edge_len * (r_a / 3.0 + r_b / 6.0)
        g[column_nodes[e + 1]] += edge_len * (r_a / 6.0 + r_b / 3.0)
    return g
