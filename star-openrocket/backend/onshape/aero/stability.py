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

import math
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

from ..geometry_store import GeometryStore
from .axis import Axis
from .barrowman_body import body_aero
from .barrowman_fins import fin_set_aero
from .fins import (
    detect_fin_faces,
    fin_set_aero_from_faces,
    fins_symmetric,
    is_fin_face,
    planform_outline_3d,
)
from .outer_surface import detect_axis_from_cylinders
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
    #: Unit axis direction (nose->tail), so the client can project a live-edited CG onto the
    #: axis and recompute the margin as pure algebra -- no backend round-trip. CP is fixed by
    #: geometry, so only a surface change needs a recompute.
    axis_direction: list[float] | None = None
    #: Whether the detected fins are azimuthally symmetric. False (e.g. a fin removed) means
    #: the true CP sits off-axis and this axial model under-states the instability -- warn.
    fin_symmetric: bool = True

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
    #: The fin faces the fin set was read from (given or detected), so a later pass
    #: over the same fins -- the drag geometry's section -- need not detect them again.
    fin_faces: list | None = None


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

    if axis is None:
        # The tubes' own cylinder axes, as the outer-surface preview draws. Left to
        # build_profile, the axis is a principal-axis fit of the skin's vertices,
        # which asymmetric features (camera shrouds, rail lugs) pull off-centre:
        # on LE4 SD 1.9 mm and 0.08 deg, worth 6.5 mm of radius at the tail, so the
        # 203.4 mm airframe read as 216.5 mm and every margin shrank by 6 %.
        axis = detect_axis_from_cylinders(faces)

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
        # Drop anything that is not a fin surface (a protruding edge whose plane does
        # not pass through the axis), so a stray/left-over edge face cannot keep a fin
        # alive after its flat faces are deselected.
        fin_geo = [fg for fg in fin_geo if is_fin_face(fg, axis)]
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
        body_cna=aero.cna, body_cp_axial=aero.cp, fin_faces=fin_faces if include_fins else None,
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
        axis_direction=axis.direction.tolist(),
        fin_symmetric=fins_symmetric(fin_pf.azimuths) if fin_pf is not None else True,
    )


# -- The same aero and mass, as the 6-DOF needs them -----------------------------------
#
# The static margin above treats the body as one Barrowman component. A flight
# simulation also needs *where* along the body the lift acts -- pitch damping goes
# as each component's CNa times its arm squared -- so the body is split at its
# radius changes. The Barrowman body integral telescopes,
#
#     CNa * cp = (2 / A_ref) (x_aft A_aft - x_fore A_fore - V),
#
# so any split into contiguous intervals sums back to exactly the static CNa and
# CP: the 6-DOF and the stability panel fly one airframe.


@dataclass
class AeroComponent:
    """One lifting component: CNa (on A_ref = pi r_max^2) as a function of Mach,
    acting at a fixed axial CP."""

    name: str
    cna_at: Callable[[float], float]
    cp_axial: float

    @property
    def cna(self) -> float:
        return self.cna_at(0.3)


#: Body intervals whose |CNa| is below this carry no lift worth a surface.
_MIN_COMPONENT_CNA = 1e-4
#: At most this many body components: each is evaluated every integration step.
_MAX_BODY_COMPONENTS = 6


def _body_intervals(s: np.ndarray, r: np.ndarray) -> list[tuple[int, int]]:
    """Index ranges [i0, i1] covering the profile, one around each run of stations
    where the radius changes (nose, boattail, any shoulder), split in the flat tube
    between runs."""
    changing = np.abs(np.diff(r)) > 1e-7 * max(float(r.max()), 1e-9)
    runs: list[list[int]] = []
    for k, active in enumerate(changing):
        if active:
            if runs and runs[-1][1] == k:
                runs[-1][1] = k + 1
            else:
                runs.append([k, k + 1])
    if not runs:
        return [(0, len(s) - 1)]
    # Merge the closest neighbours until few enough remain.
    while len(runs) > _MAX_BODY_COMPONENTS:
        gaps = [s[runs[i + 1][0]] - s[runs[i][1]] for i in range(len(runs) - 1)]
        i = int(np.argmin(gaps))
        runs[i] = [runs[i][0], runs[i + 1][1]]
        del runs[i + 1]
    bounds = [0]
    for a, b in zip(runs[:-1], runs[1:]):
        # Split the flat stretch between two runs at its middle station.
        bounds.append((a[1] + b[0]) // 2)
    bounds.append(len(s) - 1)
    return list(zip(bounds[:-1], bounds[1:]))


def aero_components(core: AeroCore) -> list[AeroComponent]:
    """The airframe's Barrowman aero as separate components (body intervals + fins).

    Their CNa-weighted CP is ``core.cp_axial`` and their CNa sum ``core.cna_total``,
    exactly (see the note above); the fins keep their Mach dependence.
    """
    prof = core.profile
    s, r = np.asarray(prof.s_grid, dtype=np.float64), np.asarray(prof.r_grid, dtype=np.float64)
    a_ref = math.pi * prof.r_max**2
    out: list[AeroComponent] = []
    for i0, i1 in _body_intervals(s, r):
        seg_s, seg_r = s[i0 : i1 + 1], r[i0 : i1 + 1]
        vol = float((math.pi / 3.0) * np.sum(np.diff(seg_s) * (seg_r[:-1] ** 2 + seg_r[:-1] * seg_r[1:] + seg_r[1:] ** 2)))
        a_fore, a_aft = math.pi * seg_r[0] ** 2, math.pi * seg_r[-1] ** 2
        cna = 2.0 * (a_aft - a_fore) / a_ref
        if abs(cna) < _MIN_COMPONENT_CNA:
            continue
        cp = (seg_s[-1] * a_aft - seg_s[0] * a_fore - vol) / (a_aft - a_fore)
        kind = "nose" if i0 == 0 else ("boattail" if i1 == len(s) - 1 and cna < 0 else "body")
        cna, cp = float(cna), float(cp)
        out.append(AeroComponent(f"{kind} (cp {cp - prof.x_fore:.3f} m)", (lambda _m, c=cna: c), cp))
    pf = core.fin_pf
    if pf is not None:
        def fin_cna(mach: float, pf=pf) -> float:
            return fin_set_aero(pf.chord_lead, pf.chord_trail, pf.span, pf.body_radius,
                                pf.n_fins, prof.r_max, max(float(mach), 0.0)).cna
        fin_cp = fin_set_aero(pf.chord_lead, pf.chord_trail, pf.span, pf.body_radius,
                              pf.n_fins, prof.r_max, 0.3).cp
        out.append(AeroComponent(f"fins ({pf.n_fins})", fin_cna, float(fin_cp)))
    return out


@dataclass
class RigidBody:
    """Mass properties about the body's own CG, on the rocket axis."""

    mass: float
    cg_axial: float
    i_transverse: float  # kg m^2, pitch/yaw, about the CG
    i_axial: float  # kg m^2, roll
    #: Fraction of the mass whose parts carried their own inertia tensor; the rest
    #: count as point masses at their centroids.
    tensor_fraction: float


def rigid_body_inertia(
    parts: list[dict], axis: Axis, overrides: dict[str, float] | None = None
) -> RigidBody | None:
    """The airframe's inertia from its parts: each part's own tensor (per kg, times
    its mass -- the viewer's override if there is one) plus the parallel-axis term.
    On LE4 SD this reproduces Onshape's assembly inertia to the 4th digit.

    None when no part has mass.
    """
    overrides = overrides or {}
    ms, cs, tens = [], [], []
    for p in parts:
        m = overrides.get(p["key"], p["mass"])
        if not (m > 0):
            continue
        ms.append(float(m))
        cs.append(np.asarray(p["centroidWorld"], dtype=np.float64))
        per_kg = p.get("inertiaPerKgWorld")
        tens.append(None if per_kg is None else np.asarray(per_kg, dtype=np.float64).reshape(3, 3))
    if not ms:
        return None
    m = np.asarray(ms)
    c = np.asarray(cs)
    total = float(m.sum())
    cg = (m[:, None] * c).sum(axis=0) / total
    tensor = np.zeros((3, 3))
    covered = 0.0
    for mi, ci, ti in zip(m, c, tens):
        if ti is not None:
            tensor += mi * ti
            covered += mi
        d = ci - cg
        tensor += mi * (float(d @ d) * np.eye(3) - np.outer(d, d))
    u = np.asarray(axis.direction, dtype=np.float64)
    u = u / np.linalg.norm(u)
    i_axial = float(u @ tensor @ u)
    i_transverse = float((np.trace(tensor) - i_axial) / 2.0)
    return RigidBody(total, float((cg - axis.origin) @ u), i_transverse, i_axial, covered / total)
