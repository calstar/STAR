"""The airframe as the drag models see it: body segments, fin sets, protuberances.

One description, two sources:

* :func:`from_core` reads it off a CAD build -- the same radial profile, axis and fin
  planform the stability panel uses (``stability.aero_core``), plus the fin section
  (``fins.extract_fin_section``) and any outer-surface features that stand proud of
  the tube (rail lugs, buttons, camera shrouds).
* An imported .ork is a CAD build too (``backend.ork.importer`` meshes it), so it goes
  through :func:`from_core` as well, but its manifest carries what a mesh cannot say:
  each piece's surface finish, the nose shape, the fins' cross-section, and the fin sets
  and rail buttons OpenRocket modelled. :func:`apply_ork_hints` lays those over.

Nothing here computes drag; ``drag_openrocket`` and ``drag_buildup`` do.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace

import numpy as np

#: OpenRocket's ``ExternalComponent.Finish`` table (24.12): equivalent sand-grain
#: roughness, metres. ``smooth`` ("Smooth paint") is OpenRocket's default for a new
#: component's finish and ours for a CAD model, which records none.
FINISHES: dict[str, float] = {
    "rough": 500e-6,
    "roughunfinished": 250e-6,
    "unfinished": 150e-6,
    "normal": 60e-6,
    "smooth": 20e-6,
    "optimum": 5e-6,
    "polished": 2e-6,
    "finishpolished": 0.5e-6,
    "mirror": 0.0,
}
DEFAULT_FINISH = "smooth"


@dataclass(frozen=True)
class BodySegment:
    """One axisymmetric piece: a nose, a tube, a transition or a boattail."""

    kind: str  # "nose" | "tube" | "transition" | "boattail"
    x_fore: float  # m from the nose tip
    x_aft: float
    r_fore: float
    r_aft: float
    wet_area: float  # m^2, lateral surface
    roughness: float  # m, equivalent sand grain
    #: OpenRocket shape name and parameter when known (an .ork), else None: the
    #: pressure-drag interpolator then uses the ogive form with ``sinphi`` alone.
    shape: str | None = None
    param: float | None = None
    #: Sine of the surface angle at the aft end, from the radius at 99 % of the length
    #: (OpenRocket's ``SymmetricComponentCalc`` definition).
    sinphi: float = 0.0

    @property
    def length(self) -> float:
        return self.x_aft - self.x_fore


@dataclass(frozen=True)
class FinSetDrag:
    """A fin set, read the way OpenRocket's ``FinSetCalc`` reads one."""

    name: str
    count: int
    area: float  # one fin's planform area, m^2
    span: float
    mac: float  # mean aerodynamic chord length
    cos_lead: float  # mean cosine of the leading-edge sweep, over the span
    thickness: float
    section: str  # "airfoil" | "square" | "rounded"
    roughness: float
    root_chord: float
    x_root_lead: float  # m from the nose tip


@dataclass(frozen=True)
class Protuberance:
    """Something standing proud of the tube that is not a fin: a lug, a button, a shroud.

    ``kind`` "bluff" is drag-rated as a short cylinder across the flow (OpenRocket's rail
    button); "faired" -- slender along the flow, ``length`` more than twice both its
    height and its width -- as a rounded-edge fin of chord ``length``, span ``height``
    and thickness ``width``, the way the LE4 .ork models its camera shrouds. A bolt
    head or a rail lug is bluff.
    """

    name: str
    kind: str
    count: int
    height: float  # radial, m
    width: float  # across the flow, m
    length: float  # axial, m
    x: float  # m from the nose tip, fore end
    frontal_area: float  # one instance, m^2
    roughness: float = FINISHES[DEFAULT_FINISH]


@dataclass(frozen=True)
class DragGeometry:
    ref_radius: float
    segments: tuple[BodySegment, ...]
    fins: tuple[FinSetDrag, ...] = ()
    protuberances: tuple[Protuberance, ...] = ()
    #: What was assumed, for the result's approximations list.
    notes: tuple[str, ...] = ()
    #: Nozzle exit radius (m) for the power-on base annulus; None when unknown.
    nozzle_radius: float | None = None

    @property
    def ref_area(self) -> float:
        return math.pi * self.ref_radius**2

    @property
    def length(self) -> float:
        """OpenRocket's ``getLengthAerodynamic``: nose tip to the aft end of the body."""
        return self.segments[-1].x_aft - self.segments[0].x_fore

    @property
    def max_radius(self) -> float:
        return max(max(s.r_fore, s.r_aft) for s in self.segments)

    @property
    def base_radius(self) -> float:
        return self.segments[-1].r_aft

    def with_nozzle(self, radius: float | None) -> "DragGeometry":
        return replace(self, nozzle_radius=radius)


# -- geometry helpers ------------------------------------------------------------


def frustum_wet_area(x: np.ndarray, r: np.ndarray) -> float:
    """Lateral area of the surface of revolution through stations (x, r)."""
    x, r = np.asarray(x, dtype=np.float64), np.asarray(r, dtype=np.float64)
    return float(np.sum(math.pi * (r[1:] + r[:-1]) * np.hypot(np.diff(r), np.diff(x))))


def sinphi_at_aft(x: np.ndarray, r: np.ndarray) -> float:
    """``SymmetricComponentCalc``: (r_aft - r(0.99 L)) / hypot(that, 0.01 L)."""
    x, r = np.asarray(x, dtype=np.float64), np.asarray(r, dtype=np.float64)
    length = float(x[-1] - x[0])
    if length <= 0:
        return 0.0
    r99 = float(np.interp(x[0] + 0.99 * length, x, r))
    dr = float(r[-1]) - r99
    return dr / math.hypot(dr, 0.01 * length)


#: Span stations ``FinSetCalc`` sums over (its ``DIVISIONS``).
DIVISIONS = 48


def planform_from_chords(lead: np.ndarray, trail: np.ndarray, span: float) -> tuple[float, float, float]:
    """(area, MAC, mean cos of leading-edge sweep) from chord lead/trail at even span
    stations, root first.

    ``FinSetCalc.calculateFinGeometry``: the MAC is sum(c^2) / sum(c) over the
    stations and the sweep cosine the mean over the strips; the area it rates drag
    on is the exact planform area (``FinSet.getPlanformArea``), here the trapezoidal
    integral of the chord, exact for straight edges.
    """
    lead, trail = np.asarray(lead, dtype=np.float64), np.asarray(trail, dtype=np.float64)
    n = len(lead)
    dy = span / (n - 1)
    chord = trail - lead
    area = float(np.sum((chord[1:] + chord[:-1]) / 2) * dy)
    mac = float(np.sum(chord * chord) / np.sum(chord)) if np.sum(chord) > 0 else 0.0
    cos_lead = float(np.mean(dy / np.hypot(np.diff(lead), dy))) if n > 1 else 1.0
    return area, mac, cos_lead


def trapezoid_chords(root: float, tip: float, sweep: float, n: int = DIVISIONS) -> tuple[np.ndarray, np.ndarray]:
    """Chord lead/trail along the span of an OpenRocket trapezoidal fin."""
    u = np.linspace(0.0, 1.0, n)
    lead = sweep * u
    trail = root + (sweep + tip - root) * u
    return lead, trail


def polygon_chords(points: np.ndarray, n: int = DIVISIONS) -> tuple[np.ndarray, np.ndarray, float]:
    """Chord lead/trail at ``n`` span stations of a fin outline (x aft, y outward)."""
    pts = np.asarray(points, dtype=np.float64)
    span = float(pts[:, 1].max())
    lead, trail = np.full(n, np.inf), np.full(n, -np.inf)
    closed = np.vstack([pts, pts[:1]])
    for k, y in enumerate(np.linspace(0.0, span, n) * (1 - 1e-9) + 1e-12):
        for (x1, y1), (x2, y2) in zip(closed[:-1], closed[1:]):
            if (y1 - y) * (y2 - y) <= 0 and abs(y2 - y1) > 1e-12:
                xq = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
                lead[k], trail[k] = min(lead[k], xq), max(trail[k], xq)
    lead = np.where(np.isfinite(lead), lead, 0.0)
    trail = np.where(np.isfinite(trail), trail, lead)
    return lead, trail, span


@dataclass
class _Builder:
    notes: list[str] = field(default_factory=list)


def segments_from_profile(
    s: np.ndarray, r: np.ndarray, roughness: float, tube_radius: float | None = None
) -> list[BodySegment]:
    """Split a radial profile (nose tip at s = 0) into nose / tube / boattail segments.

    Stations within 0.5 mm of the tube radius count as tube, so a bump on the profile
    from a protuberance (a shroud, a lug) stays tube here -- it is drag-rated as a
    :class:`Protuberance` instead, not as a step in the body.
    """
    s, r = np.asarray(s, dtype=np.float64), np.asarray(r, dtype=np.float64)
    if tube_radius is None:
        tube_radius = float(np.median(r))
    tol = 5e-4
    is_tube = np.abs(r - tube_radius) <= tol
    above = r > tube_radius + tol
    r = np.where(above, tube_radius, r)  # flatten protuberance bumps
    is_tube = is_tube | above
    # Runs of "tube" and "not tube" stations; each run of not-tube is a shaped piece.
    segs: list[BodySegment] = []
    i = 0
    n = len(s)
    while i < n - 1:
        j = i
        flag = bool(is_tube[i] and is_tube[min(i + 1, n - 1)])
        while j < n - 1 and bool(is_tube[j] and is_tube[j + 1]) == flag:
            j += 1
        xs, rs = s[i : j + 1], r[i : j + 1]
        if flag:
            kind = "tube"
            r0 = r1 = tube_radius
        else:
            r0, r1 = float(rs[0]), float(rs[-1])
            # A shaped piece meets the tube it runs into: the profile is one continuous
            # surface, so a gap inside the tolerance is faceting, not a step to rate.
            if abs(r0 - tube_radius) <= tol:
                r0 = tube_radius
            if abs(r1 - tube_radius) <= tol:
                r1 = tube_radius
            kind = "nose" if i == 0 and r0 < r1 else ("boattail" if r1 < r0 and j == n - 1 else "transition")
        segs.append(
            BodySegment(
                kind=kind, x_fore=float(xs[0]), x_aft=float(xs[-1]),
                r_fore=float(r0), r_aft=float(r1),
                wet_area=frustum_wet_area(xs, rs if not flag else np.full_like(rs, tube_radius)),
                roughness=roughness, sinphi=sinphi_at_aft(xs, rs) if not flag else 0.0,
            )
        )
        i = j
    return [sg for sg in segs if sg.length > 1e-9]


def from_core(
    store,
    outer_faces,
    core,
    *,
    finish: str = DEFAULT_FINISH,
    fin_faces=None,
) -> DragGeometry:
    """The drag geometry of a CAD build, from the stability panel's ``AeroCore``."""
    from .fins import detect_fin_faces, extract_fin_section, is_fin_face

    notes: list[str] = []
    finish = finish if finish in FINISHES else DEFAULT_FINISH
    k = FINISHES[finish]
    prof = core.profile
    s = np.asarray(prof.s_grid, dtype=np.float64) - prof.x_fore
    r = np.asarray(prof.r_grid, dtype=np.float64)
    tube_r = _tube_radius(s, r)
    segments = segments_from_profile(s, r, k, tube_r)
    notes.append(f"surface finish: {finish} ({k * 1e6:.0f} um) on every surface"
                 " -- the CAD records none")

    fins: list[FinSetDrag] = []
    pf = core.fin_pf
    if pf is not None:
        if fin_faces is None:
            fin_faces = getattr(core, "fin_faces", None)
        if fin_faces is None:
            fin_faces = detect_fin_faces(store.iter_faces(), core.axis, prof.r_max)
        fin_geo = [fg for fg in store.faces_for(fin_faces) if is_fin_face(fg, core.axis)]
        section = extract_fin_section(fin_geo, core.axis, pf)
        _, mac, cos_lead = planform_from_chords(pf.chord_lead, pf.chord_trail, pf.span)
        area = float(pf.area)
        if section is None:
            thickness, shape = 0.003, "square"
            notes.append("fin thickness unknown (one side selected): 3 mm square edges assumed")
        else:
            thickness, shape = section.thickness, section.shape
        fins.append(
            FinSetDrag(
                name=f"fins ({pf.n_fins})", count=pf.n_fins, area=area, span=pf.span, mac=mac,
                cos_lead=cos_lead, thickness=thickness, section=shape, roughness=k,
                root_chord=pf.root_chord, x_root_lead=float(pf.chord_lead[0]) - prof.x_fore,
            )
        )

    fin_keys = set(map(tuple, fin_faces or []))
    protuberances = detect_protuberances(store, outer_faces, core, tube_r, fin_keys, k)
    if protuberances:
        n = sum(p.count for p in protuberances)
        big = sorted(protuberances, key=lambda p: -p.count * p.frontal_area)[:5]
        notes.append(
            f"{n} protuberances read off the CAD skin; the largest: "
            + ", ".join(f"{p.count}x {p.kind} {p.length * 1e3:.0f}x{p.width * 1e3:.0f}x{p.height * 1e3:.0f} mm"
                        f" at {p.x:.2f} m" for p in big)
        )
    return DragGeometry(
        ref_radius=float(prof.r_max), segments=tuple(segments), fins=tuple(fins),
        protuberances=tuple(protuberances), notes=tuple(notes),
    )


def _tube_radius(s: np.ndarray, r: np.ndarray) -> float:
    """Length-weighted median radius: the tube, not a shroud or a nose station."""
    ds = np.gradient(s)
    order = np.argsort(r)
    cum = np.cumsum(ds[order])
    return float(r[order][np.searchsorted(cum, cum[-1] / 2)])


def detect_protuberances(store, outer_faces, core, tube_r: float, fin_keys: set, roughness: float) -> list[Protuberance]:
    """Parts standing proud of the tube, other than the fins: lugs, buttons, shrouds.

    One pass over every face in the model (``GeometryStore.faces_for`` walks them all
    per call, so a call per face cost 24x on LE4 SD), grouped by part occurrence:
    whatever a part has outside ``tube_r`` + 0.5 mm along the tube is one feature.
    The outer-surface selection is not enough -- on LE4 SD neither the camera shrouds
    nor the rail lugs are in it. The fins' own parts are skipped (their edges and roots
    stand proud too). Features of the same size at the same station are one set
    (``count``). Height is the radial reach above the tube, width the spread across the
    flow, length the axial extent; the frontal area is the projection of the proud part
    on the plane normal to the axis (half the |n . axis| area of a closed surface).
    """
    o = np.asarray(core.axis.origin, dtype=np.float64)
    d = np.asarray(core.axis.direction, dtype=np.float64)
    x0, x1 = core.profile.x_fore, core.profile.x_aft
    fin_occ = {k for k, _ in fin_keys}
    e1 = _perp(d)
    e2 = np.cross(d, e1)
    proud: dict[str, list[np.ndarray]] = {}
    for fg in store.iter_faces():
        if fg.occurrence_key in fin_occ:
            continue
        t = fg.triangles
        if len(t) == 0:
            continue
        rel = t.reshape(-1, 3) - o
        sax = rel @ d
        rad = np.linalg.norm(rel - np.outer(sax, d), axis=1)
        if rad.max() < tube_r + 1e-3:
            continue
        tri_out = (rad.reshape(-1, 3) > tube_r + 5e-4).any(axis=1)
        tri_s = sax.reshape(-1, 3)
        # Along the tube only: the nose and the tail's own ends are not protuberances.
        tri_out &= (tri_s.min(axis=1) > x0 + 1e-3) & (tri_s.max(axis=1) < x1 - 1e-3)
        if tri_out.any():
            proud.setdefault(fg.occurrence_key, []).append(t[tri_out])

    feats: list[tuple[float, float, float, float, float]] = []  # x, length, height, width, frontal
    for tris in proud.values():
        t = np.concatenate(tris)
        verts = t.reshape(-1, 3) - o
        vs = verts @ d
        radial = verts - np.outer(vs, d)
        vrad = np.linalg.norm(radial, axis=1)
        height = float(vrad.max() - tube_r)
        if height < 1e-3:
            continue
        az = np.arctan2(radial @ e2, radial @ e1)
        az_c = math.atan2(float(np.sin(az).mean()), float(np.cos(az).mean()))
        dz = np.angle(np.exp(1j * (az - az_c)))
        width = float((dz.max() - dz.min()) * tube_r)
        n = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
        frontal = 0.25 * float(np.sum(np.abs(n @ d)))
        feats.append((float(vs.min() - x0), float(vs.max() - vs.min()), height, width, frontal))

    # Group features of the same size at the same station into one set.
    sets: list[list] = []
    for f in sorted(feats):
        for st in sets:
            g = st[0]
            if abs(f[0] - g[0]) < 0.01 and abs(f[1] - g[1]) < 0.01 and abs(f[2] - g[2]) < 0.003:
                st.append(f)
                break
        else:
            sets.append([f])
    out_list = []
    for i, st in enumerate(sets):
        x, length, height, width, frontal = (float(np.mean([f[j] for f in st])) for j in range(5))
        frontal = frontal if frontal > 0 else height * width
        kind = "faired" if length > 2 * max(height, width) else "bluff"
        out_list.append(Protuberance(name=f"protuberance {i + 1}", kind=kind, count=len(st), height=height,
                                     width=width, length=length, x=x, frontal_area=frontal, roughness=roughness))
    return out_list


def _perp(d: np.ndarray) -> np.ndarray:
    a = np.array([1.0, 0.0, 0.0]) if abs(d[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    p = a - (a @ d) * d
    return p / np.linalg.norm(p)


def apply_ork_hints(geom: DragGeometry, hints: dict | None) -> DragGeometry:
    """Lay an imported .ork's own drag inputs (``manifest["ork"]["drag"]``) over the
    geometry read off its mesh: per-piece finish and nose shape, the fin section and
    finish, and the extra fin sets and rail buttons it declares, which then replace
    anything :func:`detect_protuberances` found."""
    if not hints:
        return geom
    pieces = hints.get("pieces", [])

    def piece_at(x: float) -> dict | None:
        for p in pieces:
            if p["x"] - 1e-6 <= x <= p["x"] + p["length"] + 1e-6:
                return p
        return None

    segs = []
    for sg in geom.segments:
        mid = piece_at((sg.x_fore + sg.x_aft) / 2)
        if mid is None:
            segs.append(sg)
            continue
        k = FINISHES.get(mid.get("finish") or DEFAULT_FINISH, FINISHES[DEFAULT_FINISH])
        if sg.kind == "tube":
            # A tube segment spans several .ork tubes: weight their finishes by area.
            covered = [p for p in pieces if p["x"] < sg.x_aft and p["x"] + p["length"] > sg.x_fore]
            w = [(min(sg.x_aft, p["x"] + p["length"]) - max(sg.x_fore, p["x"]),
                  FINISHES.get(p.get("finish") or DEFAULT_FINISH, FINISHES[DEFAULT_FINISH])) for p in covered]
            tot = sum(a for a, _ in w)
            segs.append(replace(sg, roughness=sum(a * kk for a, kk in w) / tot if tot > 0 else k))
        else:
            segs.append(replace(sg, roughness=k, shape=mid.get("shape"), param=mid.get("param")))

    fins = list(geom.fins)
    declared = hints.get("fins", [])
    if declared:
        # The mesh's detected set is the main fins: give it the .ork's section and finish
        # (matched by count and root chord), and add every other declared set.
        main = None
        if fins:
            main = min(declared, key=lambda f: abs(f["rootChord"] - fins[0].root_chord) + 10 * abs(f["count"] - fins[0].count))
            fins[0] = replace(fins[0], section=main["section"], thickness=main["thickness"],
                              roughness=FINISHES.get(main.get("finish") or DEFAULT_FINISH, fins[0].roughness))
        for f in declared:
            if f is main:
                continue
            lead, trail, span = polygon_chords(np.asarray(f["points"]))
            area, mac, cos_lead = planform_from_chords(lead, trail, span)
            fins.append(FinSetDrag(
                name=f["name"], count=f["count"], area=area, span=span, mac=mac, cos_lead=cos_lead,
                thickness=f["thickness"], section=f["section"],
                roughness=FINISHES.get(f.get("finish") or DEFAULT_FINISH, FINISHES[DEFAULT_FINISH]),
                root_chord=f["rootChord"], x_root_lead=f["x"],
            ))
    prot = tuple(
        Protuberance(name=b["name"], kind="bluff", count=b["count"], height=b["height"], width=b["width"],
                     length=b["width"], x=b["x"], frontal_area=b["frontalArea"])
        for b in hints.get("buttons", [])
    )
    notes = [n for n in geom.notes if not n.startswith(("surface finish", "protuberances"))]
    notes.append("finish, nose shape, fin section and fin sets from the .ork")
    return replace(geom, segments=tuple(segs), fins=tuple(fins), protuberances=prot, notes=tuple(notes))
