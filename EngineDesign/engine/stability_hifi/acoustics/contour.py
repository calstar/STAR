"""Real chamber contour -> meridional acoustic mesh (P1, paper Sections III.F and IX).

Replaces the synthetic rectangles of the P0 verification cases with the true chamber
shape. The wall geometry deliberately MIRRORS the suite's hardware construction
(``engine/core/chamber_geometry.py`` / ``chamber_geometry_solver.py`` — the same code
that drives the DXF export), rather than inventing its own parameterization, so the
acoustic domain is the machined part:

    x = 0 (injector face)
      |-- cylindrical section, radius R_c, length L_cyl
      |-- straight contraction cone at half-angle theta_c (hardware default 45 deg)
      |-- circular entrance arc, radius f*R_t (hardware f = 1.5), tangent to the cone
      |   and to the throat: center at (x_throat, (1+f)*R_t), swept down to the throat
      x = x_end (truncation plane; the throat itself is never in the domain)

Tangency algebra (matches ``rao()``'s entrance arc and
``contraction_length_horizontal_calc`` exactly): the arc point at angle theta from its
center has slope theta from vertical, so the cone (slope theta_c) meets it smoothly at

    r_tangent = R_t * (1 + f*(1 - cos(theta_c))),
    L_cone    = (R_c - r_tangent) / tan(theta_c),
    arc axial span (tangency -> throat) = f * R_t * sin(theta_c).

Where does the ACOUSTIC domain end? (paper Section III.E)
---------------------------------------------------------
Not at the throat: the mean flow is sonic there, and the Helmholtz reduction (paper
Appendix B, assumption i) requires low Mach. Instead the domain is truncated at a plane
in the subsonic chamber, and everything downstream of that plane — convergent remainder,
throat, supersonic bell — is represented by the Marble–Candel compact-nozzle admittance
y = (gamma-1)*Mbar_e/2 (paper Appendix C) applied AT the truncation plane, with Mbar_e
the mean Mach number there. Two defensible conventions, both supported:

  * ``truncate_area_ratio=None`` (default): truncate at the convergence-start plane
    (end of the cylinder). This is the classical rocket-stability treatment and the
    paper's own words ("applied at the nozzle-entrance plane"): the ENTIRE convergent
    section + throat is "the compact nozzle". Mbar_e is then the chamber Mach — low
    (M ~ 0.1 for a contraction ratio of 6), where the Helmholtz assumptions are most
    comfortable. Price: the convergent section's volume is excluded from the mode
    computation, so longitudinal frequencies come out slightly high.
  * ``truncate_area_ratio = A_plane/A_t in (1, CR)``: extend the domain down the cone/
    arc to the plane with that area ratio, and evaluate Mbar_e there. Captures the
    convergent volume's effect on the modes (more accurate frequencies); price is that
    the neglected mean-flow terms, O(M), grow toward the plane. Keep the plane where
    M <~ 0.4 (area ratio >~ 1.6) unless deliberately studying the sensitivity.

Mbar_e comes from the subsonic branch of the isentropic area–Mach relation
(``subsonic_mach_from_area_ratio``); the compact admittance itself is deliberately NOT
computed here — geometry provides the Mach number, ``bcs``/assembly applies
(gamma-1)/2 * M, keeping the physics of the boundary condition in one place.

Meshing a mapped domain
-----------------------
The wall is now a function r_wall(x) instead of a constant, so the structured grid maps
radially: logical node (i, j) sits at (x_i, r_wall(x_i) * j/(nr-1)). The triangulation
topology (``mesh._grid_triangles``) is IDENTICAL to the P0 rectangles — which is the
point: axis handling (row j=0 is exactly r=0), ``nodes_at_x`` for the admittance
column (x_end is an exact grid column by construction), and all of ``assembly.py``
work unchanged. The rigid sloped wall costs nothing: homogeneous Neumann is the
natural BC of the weak form — it is imposed by NOT adding a boundary term there.

The axial grid is built per segment (cylinder / cone / arc), sharing endpoints, so the
segment breaks are exact node columns and no element straddles a slope discontinuity
(same reasoning as ``two_zone_duct_mesh``'s interface column: the pressure is smooth
there, but the wall slope is not, and elements that straddle a corner would smear it).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np
from scipy.optimize import brentq

from engine.stability_hifi.acoustics.mesh import MeridionalMesh, _grid_triangles


# ---------------------------------------------------------------------------
# Isentropic area–Mach relation (subsonic branch)
# ---------------------------------------------------------------------------

def area_ratio_from_mach(M: float, gamma: float) -> float:
    """Isentropic A/A* as a function of Mach number (either branch).

    A/A* = (1/M) * [ (2/(gamma+1)) * (1 + (gamma-1)/2 * M^2) ]^((gamma+1)/(2(gamma-1)))

    Standard 1-D compressible flow result (mass conservation + isentropic relations
    between a plane at Mach M and the sonic throat).
    """
    if M <= 0:
        return float("inf")
    g = gamma
    term = (2.0 / (g + 1.0)) * (1.0 + 0.5 * (g - 1.0) * M * M)
    return float(term ** ((g + 1.0) / (2.0 * (g - 1.0))) / M)


def subsonic_mach_from_area_ratio(area_ratio: float, gamma: float) -> float:
    """Invert the area–Mach relation on the SUBSONIC branch (0 < M < 1).

    The relation is not analytically invertible; on (0, 1) it is strictly decreasing
    from +inf to 1, so for any area_ratio > 1 there is exactly one subsonic root,
    bracketed and found by Brent's method. Used to get the mean Mach at the acoustic
    truncation plane for the Marble–Candel admittance.
    """
    if area_ratio < 1.0:
        raise ValueError(f"area_ratio must be >= 1 (got {area_ratio}); A < A* is unphysical")
    if area_ratio == 1.0:
        return 1.0
    return float(brentq(lambda M: area_ratio_from_mach(M, gamma) - area_ratio, 1e-8, 1.0 - 1e-12))


# ---------------------------------------------------------------------------
# The contour
# ---------------------------------------------------------------------------

@dataclass
class ChamberAcousticContour:
    """Piecewise wall description of the acoustic domain (module docstring for geometry).

    All x measured from the injector face. ``x_throat`` lies BEYOND ``x_end`` (the
    throat is never inside the acoustic domain); it is kept for reference/plotting.
    """
    R_c: float               # chamber (cylinder) radius [m]
    R_t: float               # throat radius [m]
    theta_c: float           # contraction cone half-angle [rad]
    arc_factor: float        # entrance-arc radius / R_t (hardware: 1.5)
    L_cyl: float             # cylinder length [m]
    x_cone_end: float        # cone/arc tangency plane [m] (= L_cyl + L_cone)
    x_throat: float          # virtual throat plane [m]
    x_end: float             # acoustic truncation plane [m]
    area_ratio_end: float    # A(x_end) / A_throat
    mach_end: float          # subsonic Mach at x_end (for the Marble–Candel BC)

    def r_wall(self, x) -> np.ndarray:
        """Wall radius at axial position(s) x — piecewise cylinder / cone / arc."""
        x = np.asarray(x, dtype=float)
        r = np.full_like(x, self.R_c)
        on_cone = (x > self.L_cyl) & (x <= self.x_cone_end)
        r = np.where(on_cone, self.R_c - (x - self.L_cyl) * np.tan(self.theta_c), r)
        on_arc = x > self.x_cone_end
        rho = self.arc_factor * self.R_t
        dx = np.minimum(np.abs(x - self.x_throat), rho)   # clamp: past-throat query saturates at R_t
        r = np.where(on_arc, (1.0 + self.arc_factor) * self.R_t - np.sqrt(rho * rho - dx * dx), r)
        return r if r.ndim else float(r)


def build_chamber_contour(*, chamber_diameter: float, A_throat: float,
                          length_cylindrical: float, gamma: float,
                          theta_contraction_deg: float = 45.0,
                          arc_factor: float = 1.5,
                          truncate_area_ratio: Optional[float] = None
                          ) -> ChamberAcousticContour:
    """Build the acoustic contour from the same inputs the hardware geometry uses
    (``ChamberGeometryConfig``: chamber_diameter, A_throat, length_cylindrical;
    the 45 deg cone and 1.5*R_t arc are the hardware defaults from
    ``chamber_geometry_solver.solved_chamber_plot``).

    ``truncate_area_ratio`` selects the acoustic truncation plane (module docstring):
    None = convergence-start plane; else the plane where A(x)/A_t equals it.
    """
    R_c = 0.5 * chamber_diameter
    R_t = float(np.sqrt(A_throat / np.pi))
    if R_t >= R_c:
        raise ValueError(f"throat radius {R_t:.4f} m >= chamber radius {R_c:.4f} m")
    theta = np.radians(theta_contraction_deg)
    f = arc_factor

    r_tangent = R_t * (1.0 + f * (1.0 - np.cos(theta)))
    if r_tangent >= R_c:
        raise ValueError("entrance arc alone exceeds the chamber radius; "
                         "contraction ratio too small for this arc_factor/theta")
    L_cone = (R_c - r_tangent) / np.tan(theta)
    x_cone_end = length_cylindrical + L_cone
    x_throat = x_cone_end + f * R_t * np.sin(theta)

    CR = (R_c / R_t) ** 2
    if truncate_area_ratio is None:
        x_end = length_cylindrical
        area_ratio_end = CR
    else:
        if not (1.05 <= truncate_area_ratio < CR):
            raise ValueError(
                f"truncate_area_ratio must be in [1.05, CR={CR:.2f}) — the throat plane "
                f"(ratio 1) is sonic and outside Helmholtz validity")
        r_trunc = R_t * np.sqrt(truncate_area_ratio)
        if r_trunc >= r_tangent:
            # plane lands on the straight cone
            x_end = length_cylindrical + (R_c - r_trunc) / np.tan(theta)
        else:
            # plane lands on the entrance arc: invert r_arc(x)
            rho = f * R_t
            dx = np.sqrt(rho ** 2 - ((1.0 + f) * R_t - r_trunc) ** 2)
            x_end = x_throat - dx
        area_ratio_end = truncate_area_ratio

    mach_end = subsonic_mach_from_area_ratio(area_ratio_end, gamma)
    return ChamberAcousticContour(R_c=R_c, R_t=R_t, theta_c=theta, arc_factor=f,
                                  L_cyl=length_cylindrical, x_cone_end=x_cone_end,
                                  x_throat=x_throat, x_end=x_end,
                                  area_ratio_end=area_ratio_end, mach_end=mach_end)


# ---------------------------------------------------------------------------
# Wall-mapped mesh
# ---------------------------------------------------------------------------

def _segment_xs(contour: ChamberAcousticContour, n_axial: int) -> np.ndarray:
    """Axial node columns: per-segment linspaces sharing endpoints, counts allocated
    proportionally to segment length (minimum 2 columns per nonempty segment), so the
    cylinder/cone and cone/arc breaks — and x_end itself — are exact node columns.
    """
    breaks = [0.0, min(contour.L_cyl, contour.x_end)]
    if contour.x_end > contour.L_cyl:
        breaks.append(min(contour.x_cone_end, contour.x_end))
    if contour.x_end > contour.x_cone_end:
        breaks.append(contour.x_end)
    breaks = np.array(sorted(set(breaks)))

    lengths = np.diff(breaks)
    total = lengths.sum()
    xs_parts = []
    for k, (a, b) in enumerate(zip(breaks[:-1], breaks[1:])):
        n_seg = max(2, int(round(n_axial * (b - a) / total)) + 1)
        seg = np.linspace(a, b, n_seg)
        xs_parts.append(seg if k == 0 else seg[1:])   # drop duplicated shared endpoint
    return np.concatenate(xs_parts)


def contour_mesh(contour: ChamberAcousticContour, n_axial: int, nr: int) -> MeridionalMesh:
    """Wall-mapped structured mesh of the acoustic domain.

    Logical node (i, j) -> (x_i, r_wall(x_i) * j/(nr-1)): row j=0 is exactly the axis,
    row j=nr-1 exactly the wall, and every column is a constant-x line (so
    ``nodes_at_x(contour.x_end)`` finds the admittance-plane column exactly, as the
    boundary assembly requires). Topology shared with the P0 meshes via
    ``_grid_triangles`` — nothing downstream (assembly, axis conditions, solvers)
    changes for a mapped domain.
    """
    if nr < 2 or n_axial < 4:
        raise ValueError("need nr >= 2 and n_axial >= 4")
    xs = _segment_xs(contour, n_axial)
    r_wall = contour.r_wall(xs)                     # (nx,)
    eta = np.linspace(0.0, 1.0, nr)                 # radial mapping coordinate
    X = np.repeat(xs, nr)
    Rr = np.outer(r_wall, eta).ravel()
    nodes = np.column_stack([X, Rr])
    return MeridionalMesh(nodes=nodes, triangles=_grid_triangles(len(xs), nr))
