"""Barrowman body CoP against analytic shapes.

A tessellated surface of revolution is fed through axis detection, profile
extraction and the Barrowman body maths, and checked against the closed-form
results OpenRocket would produce: a cone has CNa = 2 (its own base area) and
x_cp = 2L/3 from the tip; adding a straight tube changes neither.
"""

from __future__ import annotations

import math

import numpy as np

from backend.onshape.aero.barrowman_body import body_aero, body_cna, body_cp
from backend.onshape.aero.profile import build_profile


def surface_of_revolution(
    z: np.ndarray, r: np.ndarray, segments: int = 64
) -> np.ndarray:
    """Triangulate a surface of revolution about +z into (T, 3, 3) triangles.

    ``z`` and ``r`` are the profile stations (radius r at height z). Facet corners
    lie exactly on the surface, as Onshape's tessellation does.
    """
    theta = np.linspace(0, 2 * np.pi, segments, endpoint=False)
    cos, sin = np.cos(theta), np.sin(theta)
    tris = []
    for i in range(len(z) - 1):
        z0, z1, r0, r1 = z[i], z[i + 1], r[i], r[i + 1]
        for j in range(segments):
            k = (j + 1) % segments
            a = (r0 * cos[j], r0 * sin[j], z0)
            b = (r0 * cos[k], r0 * sin[k], z0)
            c = (r1 * cos[j], r1 * sin[j], z1)
            d = (r1 * cos[k], r1 * sin[k], z1)
            tris.append([a, b, c])
            tris.append([b, d, c])
    return np.asarray(tris, dtype=np.float64)


def rotate_translate(tris: np.ndarray, axis_angle: tuple, offset) -> np.ndarray:
    """Rigidly move triangles to prove axis detection is orientation-free."""
    ax, angle = np.asarray(axis_angle[0], float), axis_angle[1]
    ax = ax / np.linalg.norm(ax)
    K = np.array([[0, -ax[2], ax[1]], [ax[2], 0, -ax[0]], [-ax[1], ax[0], 0]])
    R = np.eye(3) + math.sin(angle) * K + (1 - math.cos(angle)) * (K @ K)
    return (tris.reshape(-1, 3) @ R.T + np.asarray(offset)).reshape(tris.shape)


def test_cone_cp_is_two_thirds_length():
    L, R = 0.5, 0.05
    z = np.linspace(0, L, 200)
    r = R * z / L
    tris = surface_of_revolution(z, r)

    profile, axis = build_profile(tris)
    aero = body_aero(
        x_fore=profile.x_fore,
        x_aft=profile.x_aft,
        r_fore=profile.r_fore,
        r_aft=profile.r_aft,
        volume=profile.volume,
        r_max=profile.r_max,
    )

    cp_from_nose = aero.cp - profile.x_fore
    assert abs(cp_from_nose - 2 * L / 3) < 0.01 * L
    assert abs(aero.cna - 2.0) < 0.02


def test_cone_cp_is_orientation_independent():
    L, R = 0.5, 0.05
    z = np.linspace(0, L, 200)
    r = R * z / L
    tris = rotate_translate(
        surface_of_revolution(z, r), (np.array([0.3, 1.0, 0.5]), 0.9), (1.2, -0.4, 3.0)
    )

    profile, _ = build_profile(tris)
    aero = body_aero(
        x_fore=profile.x_fore, x_aft=profile.x_aft,
        r_fore=profile.r_fore, r_aft=profile.r_aft,
        volume=profile.volume, r_max=profile.r_max,
    )
    assert abs((aero.cp - profile.x_fore) - 2 * L / 3) < 0.01 * L
    assert abs(aero.cna - 2.0) < 0.02


def test_tube_added_to_cone_does_not_move_cp():
    """A straight tube has CNa 0 and must not shift the cp (OpenRocket isTube)."""
    L_nose, L_tube, R = 0.3, 0.7, 0.05
    z_nose = np.linspace(0, L_nose, 120)
    r_nose = R * z_nose / L_nose
    z_tube = np.linspace(L_nose, L_nose + L_tube, 120)[1:]
    r_tube = np.full_like(z_tube, R)
    z = np.concatenate([z_nose, z_tube])
    r = np.concatenate([r_nose, r_tube])
    tris = surface_of_revolution(z, r)

    profile, _ = build_profile(tris)
    aero = body_aero(
        x_fore=profile.x_fore, x_aft=profile.x_aft,
        r_fore=profile.r_fore, r_aft=profile.r_aft,
        volume=profile.volume, r_max=profile.r_max,
    )
    # cp still governed by the nose alone: 2/3 of the nose length from the tip.
    assert abs((aero.cp - profile.x_fore) - 2 * L_nose / 3) < 0.02 * L_nose
    assert abs(aero.cna - 2.0) < 0.03


def test_body_cna_and_cp_closed_form():
    """Direct unit check of the two formulas, independent of meshing."""
    R = 0.05
    a = math.pi * R * R
    # cone: fore area 0, aft area a, volume a*L/3, ref = a
    L = 0.4
    assert body_cna(0.0, a, a) == 2.0
    assert abs(body_cp(0.0, L, 0.0, a, a * L / 3) - 2 * L / 3) < 1e-12
    # boattail: area shrinks, CNa negative
    assert body_cna(a, a / 4, a) < 0
