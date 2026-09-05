"""Stability combiner and outer-surface auto-detection on synthetic geometry."""

from __future__ import annotations

import numpy as np
import pytest

from backend.onshape.aero.outer_surface import detect_outer_surface
from backend.onshape.aero.stability import (
    CPContribution,
    MotorPlacement,
    compute_cg,
    compute_stability,
    merge_cp,
)
from backend.onshape.geometry_store import FaceGeometry
from test_aero_body import surface_of_revolution


class StubStore:
    """Minimal GeometryStore stand-in: only what the aero code reads."""

    def __init__(self, faces: list[FaceGeometry]):
        self._faces = faces

    def iter_faces(self):
        return list(self._faces)

    def faces_for(self, selection):
        wanted = set(selection)
        return [f for f in self._faces if (f.occurrence_key, f.face_id) in wanted]


def _sor_face(occ, fid, tris, radius, surface_type="CYLINDER"):
    """A coaxial surface-of-revolution face about +z, as the store would yield."""
    return FaceGeometry(
        occurrence_key=occ,
        part_id="part",
        face_id=fid,
        triangles=tris,
        surface_type=surface_type,
        axis_origin=np.array([0.0, 0.0, 0.0]),
        axis_dir=np.array([0.0, 0.0, 1.0]),
        radius=radius,
    )


def cone_tube_faces():
    L_nose, L_tube, R = 0.3, 0.7, 0.05
    z_nose = np.linspace(0, L_nose, 120)
    z_tube = np.linspace(L_nose, L_nose + L_tube, 120)[1:]
    z = np.concatenate([z_nose, z_tube])
    r = np.concatenate([R * z_nose / L_nose, np.full_like(z_tube, R)])
    tris = surface_of_revolution(z, r)
    return _sor_face("occ:body", "F_outer", tris, R), L_nose, L_tube, R


def test_merge_cp_is_cna_weighted():
    cp, cna = merge_cp([CPContribution(2.0, 0.2), CPContribution(6.0, 1.0)])
    assert cna == 8.0
    assert cp == (2.0 * 0.2 + 6.0 * 1.0) / 8.0


def test_compute_cg_applies_overrides():
    parts = [
        {"key": "a", "mass": 1.0, "centroidWorld": [0, 0, 0.0]},
        {"key": "b", "mass": 0.0, "centroidWorld": [0, 0, 1.0]},  # material-less
    ]
    cg, mass = compute_cg(parts, overrides={"b": 1.0})
    assert mass == 2.0
    assert cg[2] == 0.5  # override gave part b mass, pulling CG to the midpoint


def test_body_stability_cop_and_margin():
    face, L_nose, L_tube, R = cone_tube_faces()
    store = StubStore([face])

    # Two point masses along the body axis (+z): nose-ward and tail-ward.
    total_len = L_nose + L_tube
    parts = [
        {"key": "m_fwd", "mass": 2.0, "centroidWorld": [0, 0, 0.2 * total_len]},
        {"key": "m_aft", "mass": 1.0, "centroidWorld": [0, 0, 0.9 * total_len]},
    ]

    result = compute_stability(store, parts, outer_faces=[("occ:body", "F_outer")])

    # CoP governed by the nose: ~2/3 of nose length from the tip.
    assert abs(result.cp_from_nose - 2 * L_nose / 3) < 0.02 * L_nose
    assert abs(result.cna - 2.0) < 0.03
    assert abs(result.ref_diameter - 2 * R) < 1e-3

    # CG is the mass-weighted axial position, measured from the nose tip.
    expected_cg = (2.0 * 0.2 * total_len + 1.0 * 0.9 * total_len) / 3.0
    assert abs(result.cg_from_nose - expected_cg) < 2e-3

    # Margin = (cp - cg)/d_ref; here CG is well aft of the nose CoP -> unstable (<0).
    assert result.static_margin == (result.cp_axial - result.cg_axial) / result.ref_diameter
    assert result.static_margin < 0


def test_compute_cg_blends_extra_point_mass():
    parts = [{"key": "a", "mass": 1.0, "centroidWorld": [0, 0, 0.0]}]
    cg, mass = compute_cg(parts, extra_masses=[(3.0, np.array([0, 0, 4.0]))])
    assert mass == 4.0
    assert cg[2] == (1.0 * 0.0 + 3.0 * 4.0) / 4.0  # 3.0


def test_motor_placement_shifts_cg_aft_and_reduces_margin():
    face, L_nose, L_tube, R = cone_tube_faces()
    store = StubStore([face])
    total_len = L_nose + L_tube
    # A single light part at the nose, so the motor dominates the CG shift.
    parts = [{"key": "nose", "mass": 0.5, "centroidWorld": [0, 0, 0.1 * total_len]}]

    base = compute_stability(store, parts, outer_faces=[("occ:body", "F_outer")])

    # A 0.2 m motor, 1 kg, CG at its own mid, aft-flush with the base (aft_offset=0).
    motor = MotorPlacement(mass=1.0, length=0.2, cmx=0.1)
    withm = compute_stability(
        store, parts, outer_faces=[("occ:body", "F_outer")], motor=motor
    )

    # Aft-flush default: aft end at the body base, i.e. zero offset from the base.
    assert withm.motor_aft_from_base == 0.0
    # Motor CG sits (length - cmx) forward of the base.
    assert withm.motor_cg_from_nose == total_len - 0.2 + 0.1
    assert withm.motor_mass == 1.0
    # Cylinder endpoints straddle the base along +z (the axis here).
    assert abs(withm.motor_aft_world[2] - total_len) < 1e-9
    assert abs(withm.motor_fore_world[2] - (total_len - 0.2)) < 1e-9
    assert withm.motor_radius == pytest.approx(0.0)  # no diameter given
    # Adding aft mass moves CG aft and total mass up.
    assert withm.cg_from_nose > base.cg_from_nose
    assert withm.mass == base.mass + 1.0
    # CP is mass-independent, so a bigger cg (aft) shrinks the margin.
    assert withm.cp_from_nose == base.cp_from_nose
    assert withm.static_margin < base.static_margin


def test_motor_aft_offset_pushes_motor_rearward():
    face, L_nose, L_tube, R = cone_tube_faces()
    store = StubStore([face])
    total_len = L_nose + L_tube
    parts = [{"key": "nose", "mass": 0.5, "centroidWorld": [0, 0, 0.1 * total_len]}]

    # 50 mm aft offset: the motor's aft end protrudes past the base.
    motor = MotorPlacement(mass=1.0, length=0.2, cmx=0.1, diameter=0.05, aft_offset=0.05)
    withm = compute_stability(
        store, parts, outer_faces=[("occ:body", "F_outer")], motor=motor
    )
    assert withm.motor_aft_from_base == pytest.approx(0.05)
    assert withm.motor_aft_world[2] == pytest.approx(total_len + 0.05)
    assert withm.motor_radius == pytest.approx(0.025)


def test_motor_default_datum_is_aftmost_geometry_not_skin():
    face, L_nose, L_tube, R = cone_tube_faces()
    total_len = L_nose + L_tube  # the skin's aft end
    # A retainer disc protruding 40 mm past the skin's aft end.
    z0 = total_len + 0.04
    ring = np.linspace(0, 2 * np.pi, 24)
    hub = np.array([0.0, 0.0, z0])
    tris = [
        [hub, np.array([R * np.cos(a), R * np.sin(a), z0]),
         np.array([R * np.cos(b), R * np.sin(b), z0])]
        for a, b in zip(ring[:-1], ring[1:])
    ]
    retainer = _sor_face("occ:body", "F_ret", np.array(tris), R, surface_type="PLANE")
    store = StubStore([face, retainer])
    parts = [{"key": "nose", "mass": 0.5, "centroidWorld": [0, 0, 0.1]}]

    # No reference face: aft-flush should sit on the protruding retainer, not the skin.
    motor = MotorPlacement(mass=1.0, length=0.2, cmx=0.1)
    withm = compute_stability(
        store, parts, outer_faces=[("occ:body", "F_outer")], motor=motor
    )
    assert withm.motor_aft_world[2] == pytest.approx(z0)
    assert withm.motor_aft_from_base == pytest.approx(0.0)  # flush with the aft-most point


def test_motor_reference_face_places_from_that_plane():
    face, L_nose, L_tube, R = cone_tube_faces()
    # A cap disc normal to +z at z = 0.4 m, standing in for a motor mount bulkhead.
    z0 = 0.4
    ring = np.linspace(0, 2 * np.pi, 24)
    hub = np.array([0.0, 0.0, z0])
    tris = []
    for a, b in zip(ring[:-1], ring[1:]):
        p1 = np.array([R * np.cos(a), R * np.sin(a), z0])
        p2 = np.array([R * np.cos(b), R * np.sin(b), z0])
        tris.append([hub, p1, p2])
    disc = _sor_face("occ:body", "F_cap", np.array(tris), R, surface_type="PLANE")
    store = StubStore([face, disc])
    parts = [{"key": "nose", "mass": 0.5, "centroidWorld": [0, 0, 0.1]}]

    motor = MotorPlacement(
        mass=1.0, length=0.2, cmx=0.1, ref_face=("occ:body", "F_cap")
    )
    withm = compute_stability(
        store, parts, outer_faces=[("occ:body", "F_outer")], motor=motor
    )
    # Aft end sits on the cap plane; datum-relative offset is zero.
    assert withm.motor_aft_from_base == pytest.approx(z0 - (L_nose + L_tube))
    assert withm.motor_aft_world[2] == pytest.approx(z0)
    assert withm.motor_fore_world[2] == pytest.approx(z0 - 0.2)


def test_motor_reference_face_must_be_axis_normal():
    face, L_nose, L_tube, R = cone_tube_faces()
    # The outer cone/tube skin is parallel to the axis, not normal to it -> rejected.
    store = StubStore([face])
    parts = [{"key": "nose", "mass": 0.5, "centroidWorld": [0, 0, 0.1]}]
    motor = MotorPlacement(
        mass=1.0, length=0.2, cmx=0.1, ref_face=("occ:body", "F_outer")
    )
    with pytest.raises(ValueError, match="normal to the rocket axis"):
        compute_stability(
            store, parts, outer_faces=[("occ:body", "F_outer")], motor=motor
        )


def test_detect_outer_surface_rejects_inner_bore():
    face, _, _, R = cone_tube_faces()

    # An inner coaxial tube at half the radius -- shares the axis, so it is a
    # candidate, but sits below the outer envelope and must be dropped.
    L = 1.0
    z = np.linspace(0.0, L, 100)
    bore = surface_of_revolution(z, np.full_like(z, 0.5 * R))
    bore_face = _sor_face("occ:body", "F_bore", bore, 0.5 * R)

    store = StubStore([face, bore_face])
    guess = detect_outer_surface(store)

    picked = set(guess.faces)
    assert ("occ:body", "F_outer") in picked
    assert ("occ:body", "F_bore") not in picked


def test_detect_outer_surface_rejects_fin_plane():
    """A PLANE face (a fin flat) is not a surface of revolution -> excluded."""
    face, _, _, R = cone_tube_faces()
    # A fin: an off-axis planar quad sticking out radially.
    quad = np.array([
        [[R, 0, 0.4], [3 * R, 0, 0.4], [3 * R, 0, 0.7]],
        [[R, 0, 0.4], [3 * R, 0, 0.7], [R, 0, 0.7]],
    ])
    fin = FaceGeometry("occ:body", "part", "F_fin", quad, "PLANE", None, None, None)

    store = StubStore([face, fin])
    guess = detect_outer_surface(store)
    picked = set(guess.faces)
    assert ("occ:body", "F_outer") in picked
    assert ("occ:body", "F_fin") not in picked
