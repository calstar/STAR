"""Write the CAD rocket out as an OpenRocket ``.ork`` that OpenRocket agrees with.

Not a component-for-component translation -- the CAD has no notion of "a nose cone"
-- but a file whose **outer shape, CP and CG** are the ones this app computed. What
each piece becomes, and why that reproduces the numbers:

* **Airframe** -> a chain of conical ``transition`` and ``bodytube`` components
  through the vertices of the outer profile r(s) (``profile.build_profile``),
  simplified to within ``PROFILE_TOLERANCE``. OpenRocket's body CP is the
  per-component Barrowman sum, which telescopes to the same single integral
  ``barrowman_body`` evaluates (see its docstring), and OpenRocket integrates a
  conical frustum's volume exactly (``SymmetricComponent.integrate``). So the only
  CP difference is the volume the simplification removes, which
  ``ExportedRocket.body_cp`` measures rather than assumes.
* **Fins** -> one ``freeformfinset`` whose outline is the extracted planform's 48
  leading- and 48 trailing-edge points. Those are sampled at exactly the spanwise
  stations ``FinSetCalc`` integrates over, so OpenRocket reads back the same chords.
  Thickness and cross-section come from ``fins.extract_fin_section``; neither moves
  CP. The set hangs off the airframe component under the fin's root leading edge,
  and ``FinSetCalc`` takes its body radius from that component there -- equal to the
  ``r_max`` the app uses whenever the fins sit on the full-diameter tube.
* **Mass** -> one ``masscomponent`` per CAD part that has mass, at the part's own
  centroid (off the axis too, when the part is), sized so its inertia is the
  part's: see ``part_masses``.
  Every other component (airframe sections, fins, motor mount, parachutes) is a
  shape only, its mass overridden to zero. So the structure CG is the app's
  mass-weighted mean of the same parts -- identical by construction -- and the
  moments of inertia come from where the parts actually are. That is why this is
  not a single stage-level override: ``MassCalculation.calculateStructure`` zeroes
  overridden children's *mass* but keeps their *inertia*, which would leave the
  pitch inertia to the placeholder materials. Motors are added separately by
  OpenRocket from its own data.
* **Motor** -> an ``innertube`` motor mount whose aft end is the placed motor's aft
  end, holding the motor by manufacturer, designation and digest. OpenRocket looks
  it up in its own database on load (``DatabaseMotorFinder``); the thrust curve is
  not embedded, and cannot be.

* **Recovery** -> one ``parachute`` per device, with ``cd = CdS / (pi D0^2 / 4)`` so
  OpenRocket's drag area (``cd`` times the canopy area at ``diameter``) is the app's
  CdS. An ALTITUDE trigger stays an altitude deployment; a TIME trigger, measured
  from apogee, becomes an apogee deployment delayed by trigger + delay -- the same
  mapping ``tools/openrocket-golden/README.md`` uses. They carry zero mass: a
  canopy modelled in the CAD is one of the parts above, and one that is not is not
  in the app's CG either.
* **Environment** -> a simulation whose conditions are the launch site, the pad
  atmosphere (OpenRocket's extended ISA re-fits from the pad temperature and
  pressure the same way ``physics.atmosphere`` does; a measured lapse rate has no
  OpenRocket equivalent and is reported), the rail, and the wind: a constant wind as
  OpenRocket's average model, a profile as its multi-level model level for level,
  with the altitude-weighted mean written as the average model too, for releases
  before 24.12 that only read that.

Mach 0.3, AoA 0 is what OpenRocket's design view shows and what
``stability.compute_stability`` computes by default; the comparison is stated there.
"""

from __future__ import annotations

import io
import math
import uuid
import zipfile
from dataclasses import dataclass, field
from xml.sax.saxutils import escape

import numpy as np

from physics.atmosphere import Atmosphere
from physics.site import FAR_ELEV_M, FAR_LAT, FAR_LON

from .barrowman_fins import DIVISIONS, fin_set_aero
from .fins import FinSection
from .stability import AeroCore, CPContribution, MotorAxial, merge_cp

#: The OpenRocket release the file is written for; ``version`` is its file format.
OPENROCKET_RELEASE = "24.12"
ORK_FILE_VERSION = "1.10"

#: Largest radial deviation (m) the simplified airframe may have from the profile.
#: 0.1 mm keeps a 400-station profile to a few dozen components and moves CP by
#: well under a millimetre (``ExportedRocket.body_cp`` reports the actual shift).
PROFILE_TOLERANCE = 1e-4

#: Wall thickness given to the airframe components. Their mass is overridden to
#: zero, so this only keeps OpenRocket's geometry checks quiet.
WALL = 0.002

#: Axial length and radius given to a part with mass but no geometry (a mass typed
#: in for something the CAD does not model). Only its inertia sees these.
MASSLESS_GEOMETRY_SIZE = 0.01

#: Radial clearance and wall of the generated motor-mount tube.
MOUNT_CLEARANCE = 0.0005
MOUNT_WALL = 0.0005


@dataclass(frozen=True)
class Segment:
    """One airframe component, axial positions measured from the nose tip."""

    x0: float
    x1: float
    r0: float
    r1: float

    @property
    def length(self) -> float:
        return self.x1 - self.x0

    @property
    def is_tube(self) -> bool:
        return self.r0 == self.r1

    def radius_at(self, x: float) -> float:
        if self.length <= 0:
            return self.r1
        f = min(max((x - self.x0) / self.length, 0.0), 1.0)
        return self.r0 + f * (self.r1 - self.r0)

    @property
    def volume(self) -> float:
        """Solid frustum volume, the way ``SymmetricComponent`` integrates a cone."""
        return math.pi / 3.0 * self.length * (self.r0**2 + self.r0 * self.r1 + self.r1**2)


@dataclass(frozen=True)
class PartMass:
    """One CAD part as an OpenRocket mass component, axial positions from the nose."""

    name: str
    mass: float
    x: float  # centroid, axial
    length: float  # the cylinder is centred on ``x``
    radius: float
    #: Centroid's distance off the rocket axis, and its direction (degrees), as
    #: OpenRocket's ``radialposition``/``radialdirection``.
    radial_position: float = 0.0
    radial_direction: float = 0.0
    #: True when the size reproduces the part's inertia tensor; False when it is the
    #: bounding-extent estimate (a model built before inertia was recorded).
    exact: bool = False

    @property
    def longitudinal_unit_inertia(self) -> float:
        """``MassObject.getLongitudinalUnitInertia``: a solid cylinder's."""
        return (3 * self.radius**2 + self.length**2) / 12

    @property
    def rotational_unit_inertia(self) -> float:
        """``MassObject.getRotationalUnitInertia``."""
        return self.radius**2 / 2

    @property
    def offset_yz(self) -> tuple[float, float]:
        """Where OpenRocket puts the centroid off-axis (``MassObject`` shiftY/shiftZ)."""
        a = math.radians(self.radial_direction)
        return self.radial_position * math.cos(a), self.radial_position * math.sin(a)


def cylinder_for_inertia(spin: float, pitch: float) -> tuple[float, float]:
    """(length, radius) of the solid cylinder with these inertias per kg about its centre.

    OpenRocket models a mass component as a solid cylinder (``MassObject``): spin
    ``r^2/2`` and pitch ``(3r^2 + L^2)/12``. Two sizes, two inertias, so the
    cylinder can match any part: ``r^2 = 2 spin``, ``L^2 = 12 pitch - 6 spin``.
    The second is never negative for a real body -- in any frame the two
    transverse moments sum to at least the third (their excess is ``2 sum z^2 dm``),
    so the mean transverse moment is at least half the spin one. A thin tube comes
    out exactly: radius sqrt(2) r, its own length.
    """
    radius = math.sqrt(max(2.0 * spin, 0.0))
    length = math.sqrt(max(12.0 * pitch - 6.0 * spin, 0.0))
    return length, radius


def part_masses(store, axis, x_nose: float, manifest_parts: list[dict],
                overrides: dict[str, float] | None = None) -> list[PartMass]:
    """Every part with mass: where it sits, and a cylinder with its inertia.

    Mass and centroid are exactly what ``stability.compute_cg`` uses (manifest mass
    or the override), so the parts' weighted mean is the app's CG. The inertia is
    the part's own tensor about its centroid (``inertiaPerKgWorld``, from Onshape or
    the mesh, times the mass in use): its moment about the rocket axis is the spin,
    the mean of the two transverse moments the pitch -- OpenRocket keeps one of each
    per component, so a lopsided part's difference between its transverse axes is
    averaged, and nothing else is lost. Off-axis centroids are placed off-axis, which
    is what puts their m r^2 into OpenRocket's spin and pitch sums.

    A model built before inertia was recorded falls back to a cylinder the size of
    the part's axial and radial extent, and is marked ``exact=False``.
    """
    overrides = overrides or {}
    extent: dict[str, tuple[float, float, float]] = {}
    for fg in store.iter_faces():
        s, rho = axis.axial_radial(fg.triangles.reshape(-1, 3))
        lo, hi, r = extent.get(fg.occurrence_key, (np.inf, -np.inf, 0.0))
        extent[fg.occurrence_key] = (min(lo, float(s.min())), max(hi, float(s.max())), max(r, float(rho.max())))

    d = axis.direction
    u = np.cross(d, [1.0, 0.0, 0.0] if abs(d[0]) < 0.9 else [0.0, 1.0, 0.0])
    u /= np.linalg.norm(u)
    v = np.cross(d, u)

    out = []
    for p in manifest_parts:
        m = overrides.get(p["key"], p["mass"])
        if not (m > 0):
            continue
        rel = np.asarray(p["centroidWorld"], dtype=float) - axis.origin
        x = float(rel @ d) - x_nose
        off = rel - (rel @ d) * d
        radial = float(np.linalg.norm(off))
        direction = math.degrees(math.atan2(float(off @ v), float(off @ u))) if radial > 1e-9 else 0.0

        per_kg = p.get("inertiaPerKgWorld")
        if per_kg:
            tensor = np.asarray(per_kg, dtype=float).reshape(3, 3)
            spin = float(d @ tensor @ d)
            pitch = (float(np.trace(tensor)) - spin) / 2.0
            length, radius = cylinder_for_inertia(spin, pitch)
            exact = True
        elif p["key"] in extent:
            lo, hi, r = extent[p["key"]]
            length, radius, exact = max(hi - lo, 1e-4), max(r, 1e-4), False
        else:
            length = radius = MASSLESS_GEOMETRY_SIZE
            exact = False
        out.append(PartMass(name=str(p.get("name") or p["key"]), mass=float(m), x=x,
                            length=length, radius=radius, radial_position=radial,
                            radial_direction=direction, exact=exact))
    return out


def _douglas_peucker(x: np.ndarray, r: np.ndarray, tol: float) -> list[int]:
    """Indices of the vertices of r(x) kept by Douglas-Peucker, deviation <= ``tol``.

    Deviation is measured in r at fixed x (not perpendicular distance): for the
    airframe a radius error is what changes the volume and so the CP, and for a fin
    edge (x(y) there) a chordwise error is what changes the strip chords.
    """
    keep = {0, len(x) - 1}
    stack = [(0, len(x) - 1)]
    while stack:
        i, j = stack.pop()
        if j - i < 2:
            continue
        xs, rs = x[i + 1 : j], r[i + 1 : j]
        if x[j] == x[i]:
            dev = np.abs(rs - r[i])
        else:
            dev = np.abs(rs - (r[i] + (r[j] - r[i]) * (xs - x[i]) / (x[j] - x[i])))
        k = int(np.argmax(dev))
        if dev[k] > tol:
            m = i + 1 + k
            keep.add(m)
            stack.extend([(i, m), (m, j)])
    return sorted(keep)


def airframe_segments(
    s_grid: np.ndarray, r_grid: np.ndarray, x_nose: float, tol: float = PROFILE_TOLERANCE
) -> list[Segment]:
    """The outer profile as a nose-to-tail chain of conical segments.

    Consecutive vertices whose radii agree within ``tol`` are snapped to one radius
    so a straight tube exports as a ``bodytube`` rather than a near-flat transition.
    """
    x = np.asarray(s_grid, dtype=float) - x_nose
    r = np.asarray(r_grid, dtype=float)
    idx = _douglas_peucker(x, r, tol)
    xs, rs = x[idx], r[idx].copy()

    # Snap runs of near-equal radius (length-weighted mean, so the run's volume holds).
    i = 0
    while i < len(rs) - 1:
        j = i
        while j + 1 < len(rs) and abs(rs[j + 1] - rs[i]) <= tol:
            j += 1
        if j > i:
            w = np.diff(xs[i : j + 1])
            mid = 0.5 * (rs[i:j] + rs[i + 1 : j + 1])
            rs[i : j + 1] = float(np.average(mid, weights=w)) if w.sum() > 0 else rs[i]
        i = j + 1 if j > i else i + 1

    return [
        Segment(float(xs[k]), float(xs[k + 1]), float(rs[k]), float(rs[k + 1]))
        for k in range(len(xs) - 1)
        if xs[k + 1] > xs[k]
    ]


@dataclass
class ExportedRocket:
    """What was written, and the CP/CG OpenRocket should read back from it.

    The ``*_app`` values are this app's; ``cp_ork`` is the same Barrowman model
    evaluated on the exported components (simplified airframe, fins on the radius of
    the component they are attached to), so the difference is what the export
    itself costs, not a modelling disagreement.
    """

    segments: list[Segment]
    fin_parent: int | None
    fin_body_radius: float | None
    r_ref: float
    cp_app: float
    cp_ork: float
    cna_ork: float
    structure_mass: float
    structure_cg: float
    #: The structure's pitch inertia about its own CG, as OpenRocket will compute it
    #: from the mass components (kg m^2).
    structure_inertia: float
    #: ...and its spin (roll) inertia about the rocket axis.
    structure_spin_inertia: float
    launch_mass: float
    launch_cg: float
    warnings: list[str] = field(default_factory=list)
    parts: list[PartMass] = field(default_factory=list)


def _fmt(v: float) -> str:
    return repr(float(v))


def _material(indent: str) -> str:
    # Placeholder: the component carries no mass (see _no_mass); this only names it.
    return f'{indent}<material type="bulk" density="1850.0" group="Composites">Fiberglass</material>\n'


def _no_mass(indent: str) -> str:
    """This component is shape only; its children keep their own mass."""
    return (f"{indent}<overridemass>0.0</overridemass>\n"
            f"{indent}<overridesubcomponentsmass>false</overridesubcomponentsmass>\n")


def _mass_xml(part: PartMass, offset: float, indent: str) -> str:
    i2 = indent + "  "
    return (
        f"{indent}<masscomponent>\n"
        f"{i2}<name>{escape(part.name)}</name>\n"
        f"{i2}<id>{uuid.uuid4()}</id>\n"
        f'{i2}<axialoffset method="top">{_fmt(offset)}</axialoffset>\n'
        f'{i2}<position type="top">{_fmt(offset)}</position>\n'
        f"{i2}<packedlength>{_fmt(part.length)}</packedlength>\n"
        f"{i2}<packedradius>{_fmt(part.radius)}</packedradius>\n"
        f"{i2}<radialposition>{_fmt(part.radial_position)}</radialposition>\n"
        f"{i2}<radialdirection>{_fmt(part.radial_direction)}</radialdirection>\n"
        f"{i2}<mass>{_fmt(part.mass)}</mass>\n"
        f"{i2}<masscomponenttype>masscomponent</masscomponenttype>\n"
        f"{indent}</masscomponent>\n"
    )


def _segment_xml(seg: Segment, n: int, children: str, indent: str) -> str:
    i2 = indent + "  "
    body = f"{i2}<name>{'Body tube' if seg.is_tube else 'Section'} {n}</name>\n"
    body += f"{i2}<id>{uuid.uuid4()}</id>\n"
    body += f"{i2}<finish>smooth</finish>\n" + _material(i2) + _no_mass(i2)
    body += f"{i2}<length>{_fmt(seg.length)}</length>\n"
    if seg.is_tube:
        body += f"{i2}<thickness>{_fmt(min(WALL, seg.r0))}</thickness>\n"
        body += f"{i2}<radius>{_fmt(seg.r0)}</radius>\n"
        tag = "bodytube"
    else:
        body += f"{i2}<thickness>{_fmt(min(WALL, max(seg.r0, seg.r1)))}</thickness>\n"
        body += f"{i2}<shape>conical</shape>\n"
        body += f"{i2}<shapeclipped>false</shapeclipped>\n"
        body += f"{i2}<shapeparameter>0.0</shapeparameter>\n"
        body += f"{i2}<foreradius>{_fmt(seg.r0)}</foreradius>\n"
        body += f"{i2}<aftradius>{_fmt(seg.r1)}</aftradius>\n"
        for end in ("fore", "aft"):
            body += f"{i2}<{end}shoulderradius>0.0</{end}shoulderradius>\n"
            body += f"{i2}<{end}shoulderlength>0.0</{end}shoulderlength>\n"
            body += f"{i2}<{end}shoulderthickness>0.0</{end}shoulderthickness>\n"
            body += f"{i2}<{end}shouldercapped>false</{end}shouldercapped>\n"
        tag = "transition"
    if children:
        body += f"{i2}<subcomponents>\n{children}{i2}</subcomponents>\n"
    return f"{indent}<{tag}>\n{body}{indent}</{tag}>\n"


#: Largest chordwise deviation (m) a dropped fin-outline point may have from the line
#: through its neighbours. Far below anything that moves CP.
FIN_POINT_TOLERANCE = 1e-6


def fin_points(core: AeroCore) -> list[tuple[float, float]]:
    """The freeform outline: root LE at (0, 0), x aft, y outward from the body surface.

    Leading edge root->tip, then trailing edge tip->root, through the 48 spanwise
    stations ``FinSetCalc`` integrates over -- less any point collinear with its
    neighbours. Those have to go: ``FreeformFinSet.intersects`` tests every pair of
    non-adjacent edges with ``Line2D.intersectsLine``, which reports rounding-level
    overlaps between collinear edges as a crossing, and OpenRocket then silently
    swaps the whole outline for its default fin. Dropping them changes no chord,
    because OpenRocket interpolates linearly between the points that remain.
    """
    pf = core.fin_pf
    y = np.linspace(0.0, pf.span, DIVISIONS)
    x0 = float(pf.chord_lead[0])
    lead = np.asarray(pf.chord_lead, dtype=float) - x0
    trail = np.asarray(pf.chord_trail, dtype=float) - x0
    keep_lead = _douglas_peucker(y, lead, FIN_POINT_TOLERANCE)
    keep_trail = _douglas_peucker(y, trail, FIN_POINT_TOLERANCE)
    pts = [(float(lead[i]), float(y[i])) for i in keep_lead]
    pts += [(float(trail[i]), float(y[i])) for i in reversed(keep_trail)]
    out: list[tuple[float, float]] = []
    for p in pts:
        if not out or abs(p[0] - out[-1][0]) > 1e-9 or abs(p[1] - out[-1][1]) > 1e-9:
            out.append(p)
    out[0] = (0.0, 0.0)
    out[-1] = (out[-1][0], 0.0)
    return out


def _strips(points: list[tuple[float, float]], span: float) -> tuple[np.ndarray, np.ndarray]:
    """Leading/trailing edge x at the 48 ``FinSetCalc`` stations, read off an outline."""
    tip = max(range(len(points)), key=lambda i: points[i][1])  # the leading-edge tip
    # A finite tip chord has a second tip point, where the trailing edge starts; a
    # pointed tip shares one point between both edges.
    flat_tip = tip + 1 < len(points) and points[tip + 1][1] == points[tip][1]
    le = points[: tip + 1]
    te = points[tip + 1 if flat_tip else tip :][::-1]
    y = np.linspace(0.0, span, DIVISIONS)
    lead = np.interp(y, [p[1] for p in le], [p[0] for p in le])
    trail = np.interp(y, [p[1] for p in te], [p[0] for p in te])
    return lead, trail


def _finset_xml(
    core: AeroCore, offset: float, section: FinSection | None, indent: str
) -> str:
    pf = core.fin_pf
    i2 = indent + "  "
    thickness = section.thickness if section else 0.003
    shape = section.shape if section else "square"
    pts = "".join(f'{i2}  <point x="{_fmt(x)}" y="{_fmt(y)}"/>\n' for x, y in fin_points(core))
    return (
        f"{indent}<freeformfinset>\n"
        f"{i2}<name>Fins</name>\n"
        f"{i2}<id>{uuid.uuid4()}</id>\n"
        f"{i2}<instancecount>{pf.n_fins}</instancecount>\n"
        f"{i2}<fincount>{pf.n_fins}</fincount>\n"
        f'{i2}<radiusoffset method="surface">0.0</radiusoffset>\n'
        f'{i2}<angleoffset method="relative">0.0</angleoffset>\n'
        f'{i2}<axialoffset method="top">{_fmt(offset)}</axialoffset>\n'
        f'{i2}<position type="top">{_fmt(offset)}</position>\n'
        f"{i2}<finish>smooth</finish>\n" + _material(i2) + _no_mass(i2)
        + f"{i2}<thickness>{_fmt(thickness)}</thickness>\n"
        f"{i2}<crosssection>{shape}</crosssection>\n"
        f"{i2}<cant>0.0</cant>\n"
        f"{i2}<filletradius>0.0</filletradius>\n"
        f"{i2}<finpoints>\n{pts}{i2}</finpoints>\n"
        f"{indent}</freeformfinset>\n"
    )


@dataclass(frozen=True)
class OrkMotor:
    """The motor as OpenRocket's database knows it, and where it sits."""

    manufacturer: str
    designation: str
    digest: str
    motor_type: str  # "SINGLE" | "RELOAD" | "HYBRID" | "UNKNOWN"
    diameter: float
    length: float
    launch_mass: float
    launch_cgx: float  # from the motor's fore end
    placed: MotorAxial


def _mount_xml(motor: OrkMotor, offset: float, config_id: str, indent: str) -> str:
    i2 = indent + "  "
    r_out = motor.diameter / 2.0 + MOUNT_CLEARANCE + MOUNT_WALL
    mtype = motor.motor_type.lower()
    type_xml = f"{i2}    <type>{mtype}</type>\n" if mtype in ("single", "reload", "hybrid") else ""
    # Plugged: no motor ejection charge. Every deployment is the recovery devices'
    # own trigger; a motor delay would fire an ejection event OpenRocket does not need.
    delay = "none"
    return (
        f"{indent}<innertube>\n"
        f"{i2}<name>Motor mount</name>\n"
        f"{i2}<id>{uuid.uuid4()}</id>\n"
        f'{i2}<axialoffset method="top">{_fmt(offset)}</axialoffset>\n'
        f'{i2}<position type="top">{_fmt(offset)}</position>\n' + _material(i2) + _no_mass(i2)
        + f"{i2}<length>{_fmt(motor.length)}</length>\n"
        f"{i2}<radialposition>0.0</radialposition>\n"
        f"{i2}<radialdirection>0.0</radialdirection>\n"
        f"{i2}<outerradius>{_fmt(r_out)}</outerradius>\n"
        f"{i2}<thickness>{_fmt(MOUNT_WALL)}</thickness>\n"
        f"{i2}<clusterconfiguration>single</clusterconfiguration>\n"
        f"{i2}<clusterscale>1.0</clusterscale>\n"
        f"{i2}<clusterrotation>0.0</clusterrotation>\n"
        f"{i2}<motormount>\n"
        f"{i2}  <ignitionevent>automatic</ignitionevent>\n"
        f"{i2}  <ignitiondelay>0.0</ignitiondelay>\n"
        f"{i2}  <overhang>0.0</overhang>\n"
        f'{i2}  <motor configid="{config_id}">\n'
        + type_xml
        + f"{i2}    <manufacturer>{escape(motor.manufacturer)}</manufacturer>\n"
        f"{i2}    <digest>{escape(motor.digest)}</digest>\n"
        f"{i2}    <designation>{escape(motor.designation)}</designation>\n"
        f"{i2}    <diameter>{_fmt(motor.diameter)}</diameter>\n"
        f"{i2}    <length>{_fmt(motor.length)}</length>\n"
        f"{i2}    <delay>{delay}</delay>\n"
        f"{i2}  </motor>\n"
        f"{i2}</motormount>\n"
        f"{indent}</innertube>\n"
    )


def _segment_at(segments: list[Segment], x: float) -> int:
    """Index of the segment containing axial ``x`` (clamped to the ends)."""
    for k, seg in enumerate(segments):
        if x < seg.x1:
            return k
    return len(segments) - 1


def plan_export(
    core: AeroCore,
    cp_app: float,
    structure_mass: float,
    structure_cg: float,
    motor: OrkMotor | None = None,
    mach: float = 0.3,
    tol: float = PROFILE_TOLERANCE,
    parts: list[PartMass] | None = None,
) -> ExportedRocket:
    """Lay the rocket out as OpenRocket components and predict what it will compute.

    ``cp_app`` and ``structure_cg`` are measured from the nose tip; ``structure_*``
    excludes the motor.
    """
    profile = core.profile
    x_nose = profile.x_fore
    segments = airframe_segments(profile.s_grid, profile.r_grid, x_nose, tol)
    r_ref = max(max(s.r0, s.r1) for s in segments)
    a_ref = math.pi * r_ref * r_ref
    warnings: list[str] = []

    # Body: OpenRocket's per-component Barrowman (SymmetricComponentCalc), summed.
    contributions = []
    for seg in segments:
        a0, a1 = math.pi * seg.r0**2, math.pi * seg.r1**2
        if seg.is_tube or a1 == a0:
            continue
        cna = 2.0 * (a1 - a0) / a_ref
        cp = seg.x0 + (seg.length * a1 - seg.volume) / (a1 - a0)
        contributions.append(CPContribution(cna=cna, cp_axial=cp))

    fin_parent = None
    fin_body_radius = None
    pf = core.fin_pf
    if pf is not None:
        root_le = float(pf.chord_lead[0]) - x_nose
        fin_parent = _segment_at(segments, root_le)
        fin_body_radius = segments[fin_parent].radius_at(root_le)
        if abs(fin_body_radius - pf.body_radius) > tol:
            warnings.append(
                "The fins' root leading edge sits where the airframe radius is "
                f"{fin_body_radius * 1000:.1f} mm, not the {pf.body_radius * 1000:.1f} mm "
                "the app roots them at; OpenRocket will use the local radius, so its fin "
                "CP and CNa will differ."
            )
        lead, trail = _strips(fin_points(core), pf.span)
        lead, trail = lead + root_le, trail + root_le
        fins = fin_set_aero(lead, trail, pf.span, fin_body_radius, pf.n_fins, r_ref, mach)
        contributions.append(CPContribution(cna=fins.cna, cp_axial=fins.cp))

    cp_ork, cna_ork = merge_cp(contributions)

    parts = list(parts or [])
    # What OpenRocket will sum (RigidBody.rebase): each component's own pitch
    # inertia plus m (dx^2 + dz^2) about the structure CG, and spin plus m (dy^2 + dz^2).
    total = sum(p.mass for p in parts)
    cy = sum(p.mass * p.offset_yz[0] for p in parts) / total if total else 0.0
    cz = sum(p.mass * p.offset_yz[1] for p in parts) / total if total else 0.0
    structure_inertia = sum(
        p.mass * (p.longitudinal_unit_inertia + (p.x - structure_cg) ** 2 + (p.offset_yz[1] - cz) ** 2)
        for p in parts
    )
    structure_spin_inertia = sum(
        p.mass * (p.rotational_unit_inertia + (p.offset_yz[0] - cy) ** 2 + (p.offset_yz[1] - cz) ** 2)
        for p in parts
    )
    if parts and not all(p.exact for p in parts):
        warnings.append(
            f"{sum(not p.exact for p in parts)} part(s) have no recorded inertia (a model built "
            "before it was stored); their masses are sized from their extent, so the "
            "inertia is approximate. Rebuild the model to make it exact."
        )

    launch_mass, launch_cg = structure_mass, structure_cg
    if motor is not None:
        motor_cg = motor.placed.fore_axial - x_nose + motor.launch_cgx
        launch_mass = structure_mass + motor.launch_mass
        launch_cg = (structure_mass * structure_cg + motor.launch_mass * motor_cg) / launch_mass

    return ExportedRocket(
        segments=segments,
        fin_parent=fin_parent,
        fin_body_radius=fin_body_radius,
        r_ref=r_ref,
        cp_app=cp_app,
        cp_ork=cp_ork,
        cna_ork=cna_ork,
        structure_mass=structure_mass,
        structure_cg=structure_cg,
        structure_inertia=structure_inertia,
        structure_spin_inertia=structure_spin_inertia,
        launch_mass=launch_mass,
        launch_cg=launch_cg,
        warnings=warnings,
        parts=parts,
    )


def _comment(
    plan: ExportedRocket, source: str, motor: OrkMotor | None, launch: LaunchConditions | None
) -> str:
    mm = 1000.0
    lines = [
        f"Exported by STAR OpenRocket from {source}.",
        "Airframe and fins come from the CAD as zero-mass shapes; every CAD part with "
        f"mass is a mass component at its own centroid ({len(plan.parts)} parts), "
        "sized to carry the part's own inertia.",
        f"STAR: CP {plan.cp_app * mm:.1f} mm from nose (Mach 0.3, AoA 0); "
        f"structure {plan.structure_mass:.4f} kg, CG {plan.structure_cg * mm:.1f} mm.",
        f"Expected in OpenRocket: CP {plan.cp_ork * mm:.1f} mm; CG {plan.launch_cg * mm:.1f} mm "
        f"at {plan.launch_mass:.4f} kg"
        + (f" with the {motor.manufacturer} {motor.designation} loaded." if motor else " (no motor)."),
    ]
    if motor is not None:
        lines.append(
            "The motor is referenced by manufacturer, designation and digest; if your "
            "OpenRocket motor database does not have it, add the thrust-curve file STAR "
            "exports for it (Preferences > Options > user-defined thrust curves), or the "
            "CG above will not include it."
        )
    if launch is not None:
        if launch.devices:
            lines.append(
                "Parachutes: CdS, diameter and deployment from the Recovery tab; zero "
                "mass here, as in the app's CG."
            )
        lines.append(
            "The 'STAR launch conditions' simulation carries the site, pad atmosphere, "
            "rail and wind from the Environment and Flight tabs."
        )
    lines += plan.warnings
    return "\n".join(lines)


@dataclass(frozen=True)
class LaunchConditions:
    """What the app's ascent and descent fly through, for the .ork's simulation.

    ``site`` and ``wind`` are the ``physics.schema`` objects the flight endpoints take
    (either may be None: the standard column, calm air); ``devices`` the recovery
    devices. Rail angle is from horizontal and heading from north, as in the app.
    """

    devices: list = field(default_factory=list)
    site: object | None = None
    wind: object | None = None
    rail_length: float | None = None
    inclination: float = 90.0
    heading: float = 0.0


#: Packed size given to each exported parachute. Its mass is overridden and its
#: position does not enter CP, so this only has to be plausible in the 3D view.
CHUTE_PACKED_LENGTH = 0.06


def _parachute_xml(dev, offset: float, packed_radius: float, indent: str) -> str:
    i2 = indent + "  "
    s0 = math.pi * dev.D0 * dev.D0 / 4.0
    if dev.trigger.kind.value == "ALTITUDE":
        event, altitude, delay = "altitude", dev.trigger.value, dev.delay
    else:  # TIME: seconds after apogee
        event, altitude, delay = "apogee", 0.0, dev.trigger.value + dev.delay
    return (
        f"{indent}<parachute>\n"
        f"{i2}<name>{escape(dev.name)}</name>\n"
        f"{i2}<id>{uuid.uuid4()}</id>\n"
        f'{i2}<axialoffset method="top">{_fmt(offset)}</axialoffset>\n'
        f'{i2}<position type="top">{_fmt(offset)}</position>\n'
        f"{i2}<packedlength>{_fmt(CHUTE_PACKED_LENGTH)}</packedlength>\n"
        f"{i2}<packedradius>{_fmt(packed_radius)}</packedradius>\n"
        f"{i2}<radialposition>0.0</radialposition>\n"
        f"{i2}<radialdirection>0.0</radialdirection>\n"
        f"{i2}<cd>{_fmt(dev.CdS / s0)}</cd>\n"
        f'{i2}<material type="surface" density="0.067" group="Fabrics">Ripstop nylon</material>\n'
        + _no_mass(i2)
        + f"{i2}<deployevent>{event}</deployevent>\n"
        f"{i2}<deployaltitude>{_fmt(altitude)}</deployaltitude>\n"
        f"{i2}<deploydelay>{_fmt(delay)}</deploydelay>\n"
        f"{i2}<diameter>{_fmt(dev.D0)}</diameter>\n"
        f"{i2}<linecount>6</linecount>\n"
        f"{i2}<linelength>{_fmt(dev.D0)}</linelength>\n"
        f'{i2}<linematerial type="line" density="0.0018" group="Custom">Elastic cord (round 2mm, 1/16 in)</linematerial>\n'
        f"{indent}</parachute>\n"
    )


def _wind_levels(wind) -> list[tuple[float, float, float]]:
    """(altitude MSL, speed, direction-from in radians) per level of a profile wind."""
    out = []
    for z, u, v in sorted(zip(wind.heights_msl, wind.u, wind.v)):
        # u east / v north is where the air goes; OpenRocket, like a METAR, takes
        # the bearing it comes FROM, clockwise from north.
        out.append((float(z), math.hypot(u, v), math.atan2(-u, -v) % (2 * math.pi)))
    return out


def _mean_wind(levels: list[tuple[float, float, float]]) -> tuple[float, float]:
    """Altitude-weighted mean of a profile's vector wind: (speed, direction-from rad)."""
    if len(levels) == 1:
        return levels[0][1], levels[0][2]
    z = np.array([lv[0] for lv in levels])
    ue = np.array([-lv[1] * math.sin(lv[2]) for lv in levels])
    vn = np.array([-lv[1] * math.cos(lv[2]) for lv in levels])
    span = z[-1] - z[0]
    if span <= 0:
        u_m, v_m = float(ue.mean()), float(vn.mean())
    else:
        trap = np.trapezoid if hasattr(np, "trapezoid") else np.trapz
        u_m, v_m = float(trap(ue, z) / span), float(trap(vn, z) / span)
    return math.hypot(u_m, v_m), math.atan2(-u_m, -v_m) % (2 * math.pi)


def _conditions_xml(launch: LaunchConditions, config_id: str, warnings: list[str]) -> str:
    i = "        "
    rows = [f"{i}<configid>{config_id}</configid>"]
    if launch.rail_length is not None:
        rows.append(f"{i}<launchrodlength>{_fmt(launch.rail_length)}</launchrodlength>")
    rows += [
        f"{i}<launchintowind>false</launchintowind>",
        f"{i}<launchrodangle>{_fmt(90.0 - launch.inclination)}</launchrodangle>",
        f"{i}<launchroddirection>{_fmt(launch.heading % 360.0)}</launchroddirection>",
    ]

    wind = launch.wind
    levels: list[tuple[float, float, float]] = []
    if wind is None:
        speed, direction = 0.0, 0.0
    elif getattr(wind, "kind", None) == "profile":
        levels = _wind_levels(wind)
        speed, direction = _mean_wind(levels)
    else:
        speed, direction = float(wind.speed), math.radians(wind.direction) % (2 * math.pi)
    rows += [
        f"{i}<windaverage>{_fmt(speed)}</windaverage>",
        f"{i}<windturbulence>0.0</windturbulence>",
        f"{i}<winddirection>{_fmt(direction)}</winddirection>",
        f'{i}<wind model="average">',
        f"{i}  <speed>{_fmt(speed)}</speed>",
        f"{i}  <direction>{_fmt(direction)}</direction>",
        f"{i}  <standarddeviation>0.0</standarddeviation>",
        f"{i}</wind>",
    ]
    if levels:
        rows.append(f'{i}<wind model="multilevel" altituderef="msl">')
        rows += [
            f'{i}  <windlevel altitude="{_fmt(z)}" speed="{_fmt(sp)}" direction="{_fmt(d)}" standarddeviation="0.0"/>'
            for z, sp, d in levels
        ]
        rows.append(f"{i}</wind>")
    rows.append(f"{i}<windmodeltype>{'MultiLevel' if levels else 'Average'}</windmodeltype>")

    rows += [
        f"{i}<launchaltitude>{_fmt(FAR_ELEV_M)}</launchaltitude>",
        f"{i}<launchlatitude>{_fmt(FAR_LAT)}</launchlatitude>",
        f"{i}<launchlongitude>{_fmt(FAR_LON)}</launchlongitude>",
        f"{i}<geodeticmethod>spherical</geodeticmethod>",
    ]
    site = launch.site
    t_pad = getattr(site, "T_pad", None)
    p_pad = getattr(site, "p_pad", None)
    if t_pad is None and p_pad is None:
        rows.append(f'{i}<atmosphere model="isa"/>')
    else:
        atm = Atmosphere(FAR_ELEV_M, T_pad=t_pad, p_pad=p_pad)
        rows += [
            f'{i}<atmosphere model="extendedisa">',
            f"{i}  <basetemperature>{_fmt(atm.T_pad)}</basetemperature>",
            f"{i}  <basepressure>{_fmt(atm.p_pad)}</basepressure>",
            f"{i}</atmosphere>",
        ]
    if getattr(site, "lapse", None) is not None:
        warnings.append(
            f"The measured lapse rate ({site.lapse * 1000:.2f} K/km) has no OpenRocket "
            "equivalent; its extended ISA re-fits the lapse from the pad temperature instead."
        )
    rows += [f"{i}<timestep>0.05</timestep>", f"{i}<maxtime>1200.0</maxtime>"]

    return (
        "  <simulations>\n"
        '    <simulation status="outdated">\n'
        "      <name>STAR launch conditions</name>\n"
        "      <simulator>RK4Simulator</simulator>\n"
        "      <calculator>BarrowmanCalculator</calculator>\n"
        "      <conditions>\n" + "\n".join(rows) + "\n      </conditions>\n"
        "    </simulation>\n"
        "  </simulations>\n"
    )


def write_ork(
    core: AeroCore,
    plan: ExportedRocket,
    name: str,
    source: str,
    section: FinSection | None = None,
    motor: OrkMotor | None = None,
    launch: LaunchConditions | None = None,
) -> bytes:
    """The ``.ork`` (a zip holding ``rocket.ork``) for ``plan``.

    Conditions the file cannot express are appended to ``plan.warnings``, which
    also land in the rocket's comment.
    """
    config_id = str(uuid.uuid4())
    ind = "          "  # stage subcomponents
    x_nose = core.profile.x_fore

    children: dict[int, str] = {}
    if plan.fin_parent is not None:
        seg = plan.segments[plan.fin_parent]
        offset = float(core.fin_pf.chord_lead[0]) - x_nose - seg.x0
        children[plan.fin_parent] = _finset_xml(core, offset, section, ind + "    ")
    if motor is not None:
        fore = motor.placed.fore_axial - x_nose
        k = _segment_at(plan.segments, motor.placed.aft_axial - x_nose - 1e-9)
        offset = fore - plan.segments[k].x0
        children[k] = children.get(k, "") + _mount_xml(motor, offset, config_id, ind + "    ")

    for part in plan.parts:
        k = _segment_at(plan.segments, part.x)
        offset = part.x - part.length / 2 - plan.segments[k].x0
        children[k] = children.get(k, "") + _mass_xml(part, offset, ind + "    ")

    devices = list(launch.devices) if launch else []
    if devices:
        # All canopies in the longest tube, stacked from its top.
        k = max(range(len(plan.segments)), key=lambda n: (plan.segments[n].is_tube, plan.segments[n].length))
        seg = plan.segments[k]
        packed_r = 0.8 * min(seg.r0, seg.r1)
        children[k] = children.get(k, "") + "".join(
            _parachute_xml(dev, min(n * CHUTE_PACKED_LENGTH, max(seg.length - CHUTE_PACKED_LENGTH, 0.0)),
                           packed_r, ind + "    ")
            for n, dev in enumerate(devices)
        )

    simulations = _conditions_xml(launch, config_id, plan.warnings) if launch else ""

    body = "".join(
        _segment_xml(seg, n + 1, children.get(n, ""), ind) for n, seg in enumerate(plan.segments)
    )

    motor_config = (
        f'    <motorconfiguration configid="{config_id}" default="true">\n'
        '      <stage number="0" active="true"/>\n'
        "    </motorconfiguration>\n"
    )
    xml = (
        "<?xml version='1.0' encoding='utf-8'?>\n"
        f'<openrocket version="{ORK_FILE_VERSION}" creator="STAR OpenRocket (for OpenRocket {OPENROCKET_RELEASE})">\n'
        "  <rocket>\n"
        f"    <name>{escape(name)}</name>\n"
        f"    <id>{uuid.uuid4()}</id>\n"
        '    <axialoffset method="absolute">0.0</axialoffset>\n'
        '    <position type="absolute">0.0</position>\n'
        f"    <comment>{escape(_comment(plan, source, motor, launch))}</comment>\n"
        + motor_config
        + "    <referencetype>maximum</referencetype>\n"
        "    <subcomponents>\n"
        "      <stage>\n"
        "        <name>Sustainer</name>\n"
        f"        <id>{uuid.uuid4()}</id>\n"
        "        <subcomponents>\n"
        + body
        + "        </subcomponents>\n"
        "      </stage>\n"
        "    </subcomponents>\n"
        "  </rocket>\n"
        + simulations
        + "</openrocket>\n"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("rocket.ork", xml)
    return buf.getvalue()


def export_from_cad(
    store,
    manifest_parts: list[dict],
    outer_faces: list[tuple[str, str]],
    axis=None,
    overrides: dict[str, float] | None = None,
    fin_faces: list[tuple[str, str]] | None = None,
    n_fins: int | None = None,
    motor_placement=None,
    motor_record=None,
    name: str = "STAR rocket",
    source: str = "CAD",
    launch: LaunchConditions | None = None,
) -> tuple[bytes, ExportedRocket]:
    """The same inputs as ``compute_stability``, written out as an ``.ork``.

    ``motor_placement`` is the ``MotorPlacement`` the stability call would get and
    ``motor_record`` the ``backend.motors.motor.Motor`` it came from; the file always
    carries the motor at launch, which is what OpenRocket's design view shows.
    """
    from .fins import extract_fin_section, is_fin_face
    from .stability import aero_core, compute_cg, place_motor

    core = aero_core(store, outer_faces, axis, fin_faces, n_fins)
    x_nose = core.profile.x_fore

    cg_world, mass = compute_cg(manifest_parts, overrides)
    if mass <= 0:
        raise ValueError("the model has no mass; assign materials or masses before exporting")
    structure_cg = float((cg_world - core.axis.origin) @ core.axis.direction) - x_nose

    section = None
    if core.fin_pf is not None:
        if fin_faces is None:
            from .fins import detect_fin_faces

            fin_faces = detect_fin_faces(store.iter_faces(), core.axis, core.profile.r_max)
        fin_geo = [fg for fg in store.faces_for(fin_faces) if is_fin_face(fg, core.axis)]
        section = extract_fin_section(fin_geo, core.axis, core.fin_pf)

    motor = None
    if motor_placement is not None and motor_record is not None:
        placed = place_motor(store, core.profile, core.axis, motor_placement)
        motor = OrkMotor(
            manufacturer=motor_record.manufacturer,
            designation=motor_record.designation,
            digest=motor_record.digest,
            motor_type=motor_record.motor_type,
            diameter=motor_record.diameter,
            length=motor_record.length,
            launch_mass=motor_record.launch_mass,
            launch_cgx=motor_record.launch_cgx,
            placed=placed,
        )

    parts = part_masses(store, core.axis, x_nose, manifest_parts, overrides)
    plan = plan_export(core, core.cp_axial - x_nose, mass, structure_cg, motor, parts=parts)
    return write_ork(core, plan, name, source, section, motor, launch), plan
