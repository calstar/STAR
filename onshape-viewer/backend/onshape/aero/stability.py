"""Combine body (and later fin) aerodynamics with mass into a stability result.

This is the single backend source of truth for CG, CoP and static margin, so the
same code path produces both halves of the margin. CoP combination follows
OpenRocket's ``AerodynamicForces.merge``: a CNa-weighted average of component cps.
In the body-only phase there is one contributor (the body), so the total cp is the
body cp; the weighting machinery is written so fins slot in unchanged.

Static margin uses OpenRocket's convention, in calibers of the reference diameter:

    margin = (x_cp − x_cg) / d_ref ,   d_ref = 2·r_max

positive when the CoP is aft of the CG (stable). All axial positions are measured
along the detected nose->tail axis, so CG (a 3-D point) is projected onto that axis.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..geometry_store import GeometryStore
from .axis import Axis
from .barrowman_body import body_aero
from .fins import detect_fin_faces, fin_set_aero_from_faces, planform_outline_3d
from .profile import build_profile


@dataclass
class CPContribution:
    """One CNa-weighted cp contributor, in axial coordinates."""

    cna: float
    cp_axial: float


def merge_cp(contributions: list[CPContribution]) -> tuple[float, float]:
    """CNa-weighted cp, mirroring AerodynamicForces.merge/getCP.

    Returns (cp_axial, cna_total). Contributors with zero total weight collapse
    to a zero result, as OpenRocket returns Coordinate.NaN->handled upstream.
    """
    cna_total = sum(c.cna for c in contributions)
    if abs(cna_total) < 1e-12:
        return 0.0, 0.0
    cp = sum(c.cna * c.cp_axial for c in contributions) / cna_total
    return cp, cna_total


def compute_cg(
    parts: list[dict],
    overrides: dict[str, float] | None = None,
    include_keys: set[str] | None = None,
    extra_masses: list[tuple[float, np.ndarray]] | None = None,
) -> tuple[np.ndarray, float]:
    """Mass-weighted CG in the world (Onshape Z-up) frame.

    ``overrides`` maps an occurrence key to a resolved mass in kg (the frontend
    resolves material/density to a number), overriding the manifest mass -- this
    is how a mass typed in for a material-less part reaches the CG. ``parts`` are
    manifest part dicts with ``key``, ``mass`` and ``centroidWorld``. ``extra_masses``
    are additional ``(mass, world_point)`` contributors -- the motor enters here, so it
    blends into CG exactly like a part.
    """
    overrides = overrides or {}
    acc = np.zeros(3)
    mass = 0.0
    for p in parts:
        key = p["key"]
        if include_keys is not None and key not in include_keys:
            continue
        m = overrides.get(key, p["mass"])
        if not (m > 0):
            continue
        acc += np.asarray(p["centroidWorld"], dtype=np.float64) * m
        mass += m
    for m, point in extra_masses or []:
        if not (m > 0):
            continue
        acc += np.asarray(point, dtype=np.float64) * m
        mass += m
    if mass <= 0:
        return np.zeros(3), 0.0
    return acc / mass, mass


@dataclass
class MotorPlacement:
    """A selected motor to fold into the CG, placed along the detected axis.

    ``mass`` and ``cmx`` are resolved for the chosen state (launch or burnout); ``cmx`` is
    the motor CG measured from its own forward end. ``aft_from_nose`` positions the motor's
    aft end measured from the nose tip; ``None`` means aft-flush with the airframe base.
    """

    mass: float
    length: float
    cmx: float
    aft_from_nose: float | None = None


@dataclass
class StabilityResult:
    cg_world: list[float]
    cg_axial: float
    mass: float
    cp_world: list[float]
    cp_axial: float
    cna: float
    ref_diameter: float
    r_max: float
    static_margin: float | None
    body_length: float
    #: Axial position of the nose tip, so cp/cg can be read from the nose.
    nose_axial: float
    #: Fin contribution (0 / empty when no fins were given or detected).
    n_fins: int
    fin_cna: float
    fin_root_chord: float
    fin_tip_chord: float
    fin_sweep: float
    fin_span: float
    fin_area: float
    #: Per-fin planform outline (Onshape frame): {"lead":[[x,y,z]...],"trail":[...]}.
    fin_planforms: list
    #: Motor contribution (0 / None when no motor was given). Masses in kg, positions in m.
    motor_mass: float = 0.0
    motor_cg_from_nose: float | None = None
    motor_aft_from_nose: float | None = None

    @property
    def cp_from_nose(self) -> float:
        return self.cp_axial - self.nose_axial

    @property
    def cg_from_nose(self) -> float:
        return self.cg_axial - self.nose_axial


def compute_stability(
    store: GeometryStore,
    manifest_parts: list[dict],
    outer_faces: list[tuple[str, str]],
    axis: Axis | None = None,
    overrides: dict[str, float] | None = None,
    fin_faces: list[tuple[str, str]] | None = None,
    n_fins: int | None = None,
    include_fins: bool = True,
    motor: MotorPlacement | None = None,
) -> StabilityResult:
    """Stability from the outer surface, plus fins (given, or auto-detected).

    Body and fins are combined the way OpenRocket merges components: a CNa-weighted
    average of their cps. Pass ``fin_faces`` to fix the fin selection, ``n_fins``
    to override the detected count, or ``include_fins=False`` for a body-only run.
    """
    faces = store.faces_for(outer_faces)
    if not faces:
        raise ValueError("no geometry resolved for the selected outer faces")
    triangles = np.concatenate([fg.triangles for fg in faces], axis=0)

    profile, axis = build_profile(triangles, axis=axis)
    aero = body_aero(
        x_fore=profile.x_fore,
        x_aft=profile.x_aft,
        r_fore=profile.r_fore,
        r_aft=profile.r_aft,
        volume=profile.volume,
        r_max=profile.r_max,
    )

    contributions = [CPContribution(cna=aero.cna, cp_axial=aero.cp)]

    # Fins: use the given selection, else auto-detect faces protruding past the
    # airframe. The fin attaches at the airframe radius (r_max for a straight body).
    fin_count = 0
    fin_cna = 0.0
    fin_pf = None
    if include_fins:
        if fin_faces is None:
            fin_faces = detect_fin_faces(store.iter_faces(), axis, profile.r_max)
        fin_geo = store.faces_for(fin_faces) if fin_faces else []
        if fin_geo:
            fin_aero, fin_pf = fin_set_aero_from_faces(
                fin_geo, axis, body_radius=profile.r_max, r_ref=profile.r_max, n_fins=n_fins
            )
            fin_count = fin_pf.n_fins
            fin_cna = fin_aero.cna
            contributions.append(CPContribution(cna=fin_aero.cna, cp_axial=fin_aero.cp))

    cp_axial, cna_total = merge_cp(contributions)
    cp_world = axis.origin + cp_axial * axis.direction

    # Motor: place along the centerline and fold into CG like any part. The nose tip is at
    # profile.x_fore in axial coords; "from nose" distances add along the axis direction.
    body_length = profile.x_aft - profile.x_fore
    extra_masses: list[tuple[float, np.ndarray]] = []
    motor_mass = 0.0
    motor_cg_from_nose: float | None = None
    motor_aft_from_nose: float | None = None
    if motor is not None and motor.mass > 0:
        motor_aft_from_nose = (
            motor.aft_from_nose if motor.aft_from_nose is not None else body_length
        )
        motor_cg_from_nose = (motor_aft_from_nose - motor.length) + motor.cmx
        motor_cg_axial = profile.x_fore + motor_cg_from_nose
        motor_cg_world = axis.origin + motor_cg_axial * axis.direction
        extra_masses.append((motor.mass, motor_cg_world))
        motor_mass = motor.mass

    cg_world, mass = compute_cg(manifest_parts, overrides, extra_masses=extra_masses)
    cg_axial = float((cg_world - axis.origin) @ axis.direction) if mass > 0 else 0.0

    ref_diameter = 2.0 * profile.r_max
    static_margin = None
    if mass > 0 and ref_diameter > 0 and abs(cna_total) > 1e-12:
        static_margin = (cp_axial - cg_axial) / ref_diameter

    return StabilityResult(
        cg_world=cg_world.tolist(),
        cg_axial=cg_axial,
        mass=mass,
        cp_world=cp_world.tolist(),
        cp_axial=cp_axial,
        cna=cna_total,
        ref_diameter=ref_diameter,
        r_max=profile.r_max,
        static_margin=static_margin,
        body_length=profile.x_aft - profile.x_fore,
        nose_axial=profile.x_fore,
        n_fins=fin_count,
        fin_cna=fin_cna,
        fin_root_chord=(fin_pf.root_chord if fin_pf else 0.0),
        fin_tip_chord=(fin_pf.tip_chord if fin_pf else 0.0),
        fin_sweep=(fin_pf.sweep if fin_pf else 0.0),
        fin_span=(fin_pf.span if fin_pf else 0.0),
        fin_area=(fin_pf.area if fin_pf else 0.0),
        fin_planforms=(
            [planform_outline_3d(fin_pf, axis, az) for az in fin_pf.azimuths] if fin_pf else []
        ),
        motor_mass=motor_mass,
        motor_cg_from_nose=motor_cg_from_nose,
        motor_aft_from_nose=motor_aft_from_nose,
    )
