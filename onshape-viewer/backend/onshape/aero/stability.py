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
from .barrowman_fins import fin_set_aero
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


#: A face counts as normal to the axis when its normal is within this angle of the axis
#: direction. cos(15 deg) ~= 0.966; a mount face milled square to the tube clears it easily.
_AXIS_NORMAL_COS = 0.9659


def _face_axial_position(triangles: np.ndarray, axis: Axis) -> tuple[float, float]:
    """Area-weighted axial position of a set of triangles, and how axis-normal they are.

    Returns ``(axial, cos)`` where ``axial`` is the face centroid projected onto the axis
    (same coordinate as ``profile.x_*``) and ``cos`` is the area-weighted mean of each
    triangle's ``|unit_normal . axis_dir|`` -- 1.0 only when *every* facet is square to the
    axis (a flat plane normal to it). Summing the raw normals instead would be fooled by a
    cone, whose radial components cancel to leave a spurious axial resultant.
    """
    v0, v1, v2 = triangles[:, 0], triangles[:, 1], triangles[:, 2]
    cross = np.cross(v1 - v0, v2 - v0)  # length is twice each triangle's area
    areas = np.linalg.norm(cross, axis=1)
    total = float(areas.sum())
    if total <= 0:
        raise ValueError("motor reference face has no area")
    centroids = triangles.mean(axis=1)
    centroid = (centroids * areas[:, None]).sum(axis=0) / total
    # Per-triangle unit normals; skip degenerate (zero-area) facets.
    good = areas > 0
    unit = cross[good] / areas[good, None]
    cos = float(np.abs(unit @ axis.direction) @ areas[good] / total)
    axial = float((centroid - axis.origin) @ axis.direction)
    return axial, cos


def _aftmost_axial(store: GeometryStore, axis: Axis) -> float | None:
    """The aft-most point of the whole model, as an axial coordinate.

    Axial coordinates increase nose->tail, so this is the maximum projection of every
    triangle vertex onto the axis -- the true rear of the rocket, including anything that
    protrudes past the airframe skin (a nozzle, retainer, boat tail, motor mount). Returns
    ``None`` when the model has no geometry.
    """
    aftmost: float | None = None
    for fg in store.iter_faces():
        verts = fg.triangles.reshape(-1, 3)
        if verts.size == 0:
            continue
        m = float(((verts - axis.origin) @ axis.direction).max())
        if aftmost is None or m > aftmost:
            aftmost = m
    return aftmost


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
    the motor CG measured from its own forward end. ``diameter`` is only used to draw the
    motor cylinder.

    Placement is measured from a datum plane normal to the rocket axis. By default the datum
    is the airframe's aft (base) end; if ``ref_face`` is given it is that face's axial
    position instead (the face is required to be normal to the axis). ``aft_offset`` then
    shifts the motor's aft end along the axis from that datum -- positive is aft (rearward,
    out the back), negative recesses it forward into the body. Aft-flush is ``aft_offset=0``
    with no ``ref_face``.
    """

    mass: float
    length: float
    cmx: float
    diameter: float = 0.0
    aft_offset: float = 0.0
    #: (occurrence_key, face_id) of a face to measure the aft end from; None = airframe base.
    ref_face: tuple[str, str] | None = None


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
    #: Motor aft end offset from its datum (airframe base, or the reference face) in m.
    motor_aft_from_base: float | None = None
    #: Motor cylinder endpoints in the world (Onshape Z-up) frame, and its radius (m), for
    #: drawing the motor in the scene. None when no motor was placed.
    motor_aft_world: list[float] | None = None
    motor_fore_world: list[float] | None = None
    motor_radius: float | None = None
    #: Motor CG in the world frame for the chosen state (wet/dry), so the loaded-CM marker
    #: can blend it in and move with the wet/dry toggle. None when no motor was placed.
    motor_cg_world: list[float] | None = None

    @property
    def cp_from_nose(self) -> float:
        return self.cp_axial - self.nose_axial

    @property
    def cg_from_nose(self) -> float:
        return self.cg_axial - self.nose_axial


@dataclass
class AeroCore:
    """Body-of-revolution profile, axis, and merged CoP -- the geometry/aero setup
    shared by ``compute_stability`` and the flight simulator."""

    profile: object
    axis: Axis
    cp_axial: float
    cna_total: float
    fin_count: int
    fin_cna: float
    fin_pf: object
    #: Body-only contribution (Mach-flat), kept so the fin part can be re-evaluated
    #: at any Mach and re-merged without re-tessellating -- see ``cp_axial_at_mach``.
    body_cna: float = 0.0
    body_cp_axial: float = 0.0


def aero_core(
    store: GeometryStore,
    outer_faces: list[tuple[str, str]],
    axis: Axis | None = None,
    fin_faces: list[tuple[str, str]] | None = None,
    n_fins: int | None = None,
    include_fins: bool = True,
    mach: float = 0.3,
) -> AeroCore:
    """Resolve the airframe profile/axis and the merged (body + fins) centre of pressure.

    Fins are used as given, else auto-detected. Body and fins are combined the way
    OpenRocket merges components: a CNa-weighted average of their cps.
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

    fin_count = 0
    fin_cna = 0.0
    fin_pf = None
    if include_fins:
        if fin_faces is None:
            fin_faces = detect_fin_faces(store.iter_faces(), axis, profile.r_max)
        fin_geo = store.faces_for(fin_faces) if fin_faces else []
        if fin_geo:
            fin_aero, fin_pf = fin_set_aero_from_faces(
                fin_geo, axis, body_radius=profile.r_max, r_ref=profile.r_max, n_fins=n_fins, mach=mach
            )
            fin_count = fin_pf.n_fins
            fin_cna = fin_aero.cna
            contributions.append(CPContribution(cna=fin_aero.cna, cp_axial=fin_aero.cp))

    cp_axial, cna_total = merge_cp(contributions)
    return AeroCore(
        profile, axis, cp_axial, cna_total, fin_count, fin_cna, fin_pf,
        body_cna=aero.cna, body_cp_axial=aero.cp,
    )


def aero_at_mach(core: AeroCore, mach: float) -> tuple[float, float]:
    """Merged (body + fins) ``(cp_axial, cna_total)`` at an arbitrary Mach.

    The body is Mach-flat, so only the fin CNa/CP are re-evaluated (from the stored
    planform) and re-merged -- no re-tessellation. Falls back to the body-only values
    when there are no fins.
    """
    contributions = [CPContribution(cna=core.body_cna, cp_axial=core.body_cp_axial)]
    pf = core.fin_pf
    if pf is not None:
        fin_aero = fin_set_aero(
            pf.chord_lead, pf.chord_trail, pf.span, pf.body_radius, pf.n_fins,
            core.profile.r_max, mach,
        )
        contributions.append(CPContribution(cna=fin_aero.cna, cp_axial=fin_aero.cp))
    return merge_cp(contributions)


def cp_axial_at_mach(core: AeroCore, mach: float) -> float:
    """Merged (body + fins) CoP at an arbitrary Mach (see ``aero_at_mach``)."""
    return aero_at_mach(core, mach)[0]


@dataclass
class MotorAxial:
    """A placed motor's axial coordinates (nose->tail) and world points."""

    fore_axial: float
    aft_axial: float
    aft_from_base: float
    #: CG axial position for the placement's ``cmx`` (the resolved state's CG from the fore end).
    cg_axial: float
    cg_world: np.ndarray
    aft_world: np.ndarray
    fore_world: np.ndarray
    radius: float


def place_motor(store: GeometryStore, profile, axis: Axis, motor: MotorPlacement) -> MotorAxial:
    """Resolve where the motor sits on the centerline, from the aft-most datum (or a chosen
    axis-normal face) plus ``aft_offset``. Axial coordinates increase nose->tail."""
    # The base datum is the true aft-most point of the whole model (not just the airframe skin),
    # so a nozzle or retainer that protrudes past the tube is what the motor sits flush with by
    # default. Fall back to the skin's aft if there is no geometry.
    base_axial = _aftmost_axial(store, axis)
    if base_axial is None:
        base_axial = profile.x_aft
    datum_axial = base_axial
    if motor.ref_face is not None:
        ref_geo = store.faces_for([motor.ref_face])
        if not ref_geo:
            raise ValueError("motor reference face was not found in the model")
        ref_tris = np.concatenate([fg.triangles for fg in ref_geo], axis=0)
        datum_axial, cos = _face_axial_position(ref_tris, axis)
        if cos < _AXIS_NORMAL_COS:
            raise ValueError("the selected motor reference face is not normal to the rocket axis")
    # aft_offset is measured aft-positive from the datum; the motor extends forward.
    aft_axial = datum_axial + motor.aft_offset
    fore_axial = aft_axial - motor.length
    cg_axial = fore_axial + motor.cmx
    return MotorAxial(
        fore_axial=fore_axial,
        aft_axial=aft_axial,
        aft_from_base=aft_axial - base_axial,
        cg_axial=cg_axial,
        cg_world=axis.origin + cg_axial * axis.direction,
        aft_world=axis.origin + aft_axial * axis.direction,
        fore_world=axis.origin + fore_axial * axis.direction,
        radius=motor.diameter / 2.0,
    )


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
    mach: float = 0.3,
) -> StabilityResult:
    """Stability from the outer surface, plus fins (given, or auto-detected).

    Body and fins are combined the way OpenRocket merges components: a CNa-weighted
    average of their cps. Pass ``fin_faces`` to fix the fin selection, ``n_fins``
    to override the detected count, or ``include_fins=False`` for a body-only run.
    ``mach`` sets the flight condition (default 0.3, OpenRocket's design-view number);
    fin CNa and CP migrate with it, the body is Mach-flat.
    """
    core = aero_core(store, outer_faces, axis, fin_faces, n_fins, include_fins, mach=mach)
    profile, axis = core.profile, core.axis
    cp_axial, cna_total = core.cp_axial, core.cna_total
    fin_pf = core.fin_pf
    cp_world = axis.origin + cp_axial * axis.direction

    # Motor: place along the centerline and fold into CG like any part.
    extra_masses: list[tuple[float, np.ndarray]] = []
    motor_mass = 0.0
    motor_cg_from_nose: float | None = None
    motor_aft_from_base: float | None = None
    motor_aft_world: list[float] | None = None
    motor_fore_world: list[float] | None = None
    motor_radius: float | None = None
    motor_cg_world_out: list[float] | None = None
    if motor is not None and motor.mass > 0:
        placed = place_motor(store, profile, axis, motor)
        motor_cg_from_nose = placed.cg_axial - profile.x_fore
        motor_aft_from_base = placed.aft_from_base
        motor_cg_world_out = placed.cg_world.tolist()
        motor_aft_world = placed.aft_world.tolist()
        motor_fore_world = placed.fore_world.tolist()
        motor_radius = placed.radius
        extra_masses.append((motor.mass, placed.cg_world))
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
        n_fins=core.fin_count,
        fin_cna=core.fin_cna,
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
        motor_aft_from_base=motor_aft_from_base,
        motor_aft_world=motor_aft_world,
        motor_fore_world=motor_fore_world,
        motor_radius=motor_radius,
        motor_cg_world=motor_cg_world_out,
    )
