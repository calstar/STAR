"""Read the injector plate's revolved half-section from a CAD DXF.

The sketch is the plate's cross-section on one side of its axis: one closed profile of LINEs and
ARCs, radius on one sketch axis and axial position on the other (the revolve axis is the profile
edge at radius 0, or the profile sits entirely at radius >= 0). Units come from $INSUNITS.

From it: the plate thickness, the recesses in the back face (deep ones are the manifold channels;
shallow ones are seal grooves, reported and ignored), the recess in the chamber face (the groove
the orifices exit), a hole on the axis if there is one, and gland recesses on the rim.

Only geometry the engine design determines is used; seal features are the designer's and are
listed, never interpreted. Orifices and feed ports are not revolved features and are not here.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Tuple

_UNIT_M = {0: None, 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1.0}
#: A back-face recess deeper than this fraction of the plate thickness is a manifold channel;
#: shallower ones (seal grooves) are listed and not modelled.
CHANNEL_MIN_DEPTH_FRAC = 0.25


def _arc_points(cx, cy, r, a0, a1, step_deg=5.0):
    a0, a1 = math.radians(a0), math.radians(a1)
    if a1 <= a0:
        a1 += 2 * math.pi
    n = max(2, int(math.ceil((a1 - a0) / math.radians(step_deg))) + 1)
    return [(cx + r * math.cos(a0 + (a1 - a0) * i / (n - 1)),
             cy + r * math.sin(a0 + (a1 - a0) * i / (n - 1))) for i in range(n)]


def _segments(path: str) -> Tuple[List[List[Tuple[float, float]]], float]:
    import ezdxf
    doc = ezdxf.readfile(path)
    unit = _UNIT_M.get(int(doc.header.get("$INSUNITS", 0) or 0))
    if unit is None:
        raise ValueError(f"{path}: $INSUNITS is not set; export with units (inches or mm)")
    segs = []
    for e in doc.modelspace():
        t = e.dxftype()
        if t == "LINE":
            segs.append([tuple(e.dxf.start)[:2], tuple(e.dxf.end)[:2]])
        elif t == "ARC":
            c = e.dxf.center
            segs.append(_arc_points(c[0], c[1], e.dxf.radius, e.dxf.start_angle, e.dxf.end_angle))
        elif t == "LWPOLYLINE":
            pts = [tuple(p[:2]) for p in e.get_points()]
            if e.closed:
                pts.append(pts[0])
            segs.append(pts)
    return segs, unit


def _chain(segs, tol):
    """Join segments end to end into one closed loop."""
    segs = [list(s) for s in segs]
    loop = segs.pop(0)
    close = lambda a, b: abs(a[0] - b[0]) < tol and abs(a[1] - b[1]) < tol
    while segs:
        for i, s in enumerate(segs):
            if close(s[0], loop[-1]):
                loop += s[1:]
            elif close(s[-1], loop[-1]):
                loop += s[::-1][1:]
            else:
                continue
            segs.pop(i)
            break
        else:
            raise ValueError("the profile is not one closed loop (a gap or a second loop)")
    if not close(loop[0], loop[-1]):
        raise ValueError("the profile does not close")
    return loop[:-1]


def _area(poly):
    return 0.5 * abs(sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1]
                         for i in range(len(poly))))


def _recesses(loop, on_line, depth_of, full):
    """Runs of the loop that leave a boundary line and come back: (vertices, r-range, depth, area).
    The run that wraps round the rest of the profile (depth reaching ``full``) is not a recess."""
    n = len(loop)
    idx = [i for i in range(n) if on_line(loop[i])]
    out = []
    for a, b in zip(idx, idx[1:] + [idx[0] + n]):
        if b - a <= 1:
            continue
        run = [loop[k % n] for k in range(a, b + 1)]
        inner = run[1:-1]
        if not inner or all(on_line(p) for p in inner):
            continue
        depth = max(depth_of(p) for p in inner)
        if depth <= 1e-9 or depth >= full * (1.0 - 1e-6):
            continue
        out.append({"pts": run, "depth": depth, "area": _area(run),
                    "r_lo": min(p[0] for p in run), "r_hi": max(p[0] for p in run)})
    return out


def read_plate_profile(path: str) -> Dict[str, Any]:
    """The plate's revolved half-section, in metres. See the module docstring."""
    segs, unit = _segments(path)
    if not segs:
        raise ValueError(f"{path}: no LINE/ARC/LWPOLYLINE entities")
    pts = [p for s in segs for p in s]
    span = max(max(abs(p[0]) for p in pts), max(abs(p[1]) for p in pts))
    loop = _chain(segs, tol=1e-6 * max(span, 1.0))
    # Radius is the sketch axis on which the profile starts at 0 and never goes negative.
    xs, ys = [p[0] for p in loop], [p[1] for p in loop]
    if min(xs) > -1e-9 and (min(ys) < -1e-9 or max(xs) - min(xs) > max(ys) - min(ys)):
        rz = [(x * unit, y * unit) for x, y in loop]
    else:
        rz = [(y * unit, x * unit) for x, y in loop]
    tol = 1e-6
    zs = [z for _, z in rz]
    z0, z1 = min(zs), max(zs)
    R = max(r for r, _ in rz)
    t = z1 - z0
    face_recs = _recesses(rz, lambda p: abs(p[1] - z0) < tol, lambda p: p[1] - z0, t)
    back_recs = _recesses(rz, lambda p: abs(p[1] - z1) < tol, lambda p: z1 - p[1], t)
    # Which side is the back: the one with the deep recesses (the channels).
    deep = lambda recs: [r for r in recs if r["depth"] > CHANNEL_MIN_DEPTH_FRAC * t]
    if deep(face_recs) and not deep(back_recs):
        face_recs, back_recs = back_recs, face_recs
        flip = True
    else:
        flip = False
    channels = sorted(deep(back_recs), key=lambda r: r["r_lo"])
    seals = [r for r in back_recs if r["depth"] <= CHANNEL_MIN_DEPTH_FRAC * t]
    rim = _recesses(rz, lambda p: abs(p[0] - R) < tol, lambda p: R - p[0], R)
    axis_touch = any(abs(r) < tol for r, _ in rz)
    face_line = z1 if flip else z0

    out_channels = []
    for ch in channels:
        # Metal left under the channel: thickness minus the deepest floor point.
        out_channels.append({
            "r_lo": ch["r_lo"], "r_hi": ch["r_hi"], "r_center": 0.5 * (ch["r_lo"] + ch["r_hi"]),
            "width": ch["r_hi"] - ch["r_lo"], "depth": ch["depth"], "flow_area": ch["area"],
            "ligament_min": t - ch["depth"],
            "hydraulic_diameter": 4.0 * ch["area"] / _perimeter_wetted(ch["pts"], closed_by=ch["r_hi"] - ch["r_lo"]),
            "floor": [(p[0], abs((z1 if not flip else z0) - p[1])) for p in ch["pts"]],
            # Radius of the section's centroid: the ring the flow goes round.
            "r_centroid": _centroid_r(ch["pts"]),
            "_pts": ch["pts"],
        })
    face_groove = None
    if face_recs:
        g = max(face_recs, key=lambda r: r["area"])
        pts = g["pts"]
        flanks = []
        for (ra, za), (rb, zb) in zip(pts, pts[1:]):
            dr, dz = rb - ra, zb - za
            if abs(dr) > 1e-9 and abs(dz) > 1e-9:
                mid = (0.5 * (ra + rb), abs(0.5 * (za + zb) - face_line))
                flanks.append({"r_mid": mid[0], "depth_mid": mid[1],
                               "angle_from_face_deg": math.degrees(math.atan2(abs(dz), abs(dr))),
                               "length": math.hypot(dr, dz)})
        face_groove = {"r_lo": g["r_lo"], "r_hi": g["r_hi"], "depth": g["depth"], "flanks": flanks}
    return {
        "source": path, "units_m": unit, "plate_radius": R, "thickness": t,
        "axis_hole": not axis_touch, "channels": out_channels, "face_groove": face_groove,
        "seal_grooves_back": [{"r_lo": s["r_lo"], "r_hi": s["r_hi"], "depth": s["depth"]} for s in seals],
        "rim_recesses": [{"depth": s["depth"], "z_lo": min(p[1] for p in s["pts"]),
                          "z_hi": max(p[1] for p in s["pts"])} for s in rim],
        "loop": rz,
        "_face_line": face_line,
        "_face_groove_pts": (max(face_recs, key=lambda r: r["area"])["pts"] if face_recs else None),
    }


def _centroid_r(poly):
    a = cx = 0.0
    for i in range(len(poly)):
        (x0, y0), (x1, y1) = poly[i], poly[(i + 1) % len(poly)]
        cr = x0 * y1 - x1 * y0
        a += cr
        cx += (x0 + x1) * cr
    return cx / (3.0 * a) if abs(a) > 1e-30 else 0.5 * (min(p[0] for p in poly) + max(p[0] for p in poly))


def _perimeter_wetted(pts, closed_by):
    """Wetted perimeter of a channel closed by the cover across its mouth."""
    per = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))
    return per + closed_by


def ring_channel(profile: Dict[str, Any], r_hole_entry: float) -> Dict[str, Any]:
    """The channel a ring's holes break into: the one whose radial span holds the entry radius,
    else the nearest."""
    chs = profile["channels"]
    if not chs:
        raise ValueError("the plate profile has no back-face channels")
    inside = [c for c in chs if c["r_lo"] - 1e-9 <= r_hole_entry <= c["r_hi"] + 1e-9]
    return inside[0] if inside else min(chs, key=lambda c: abs(c["r_center"] - r_hole_entry))


def _sloped(pts, face_line):
    """The sloped straight segments of a run, as (A, B, angle from the face plane [deg]) in
    (r, depth-from-face) coordinates."""
    out = []
    for (ra, za), (rb, zb) in zip(pts, pts[1:]):
        dr, dz = rb - ra, zb - za
        if abs(dr) > 1e-9 and abs(dz) > 1e-9:
            A, B = (ra, abs(za - face_line)), (rb, abs(zb - face_line))
            out.append((A, B, math.degrees(math.atan2(abs(dz), abs(dr)))))
    return out


def drilled_passages(profile: Dict[str, Any], angles: Dict[str, float], *, tol_deg: float = 1.0
                     ) -> Dict[str, Dict[str, Any]]:
    """Where each ring's orifice runs, from the drawing alone.

    A drilled passage is not a revolved feature, but its two ends are: the channel facet it is
    drilled square into and the face-groove flank it leaves through, both inclined at the jet
    angle. The passage is the facet's normal through the facet's midpoint -- where a drill spotted
    square on that facet goes -- until it meets the flank of the same angle. ``angles``:
    ``{"O": deg, "F": deg}`` from the chamber axis. A side with no facet/flank pair at its angle
    is left out (that drawing does not locate its passage)."""
    face_line = profile["_face_line"]
    flanks = _sloped(profile["_face_groove_pts"], face_line) if profile.get("_face_groove_pts") else []
    out: Dict[str, Dict[str, Any]] = {}
    for k, th in angles.items():
        th = float(th)
        s, c = math.sin(math.radians(th)), math.cos(math.radians(th))
        for ci, ch in enumerate(profile["channels"]):
            for (A, B, ang) in _sloped(ch["_pts"], face_line):
                if abs(ang - th) > tol_deg:
                    continue
                P = (0.5 * (A[0] + B[0]), 0.5 * (A[1] + B[1]))
                for (F0, F1, fang) in flanks:
                    if abs(fang - th) > tol_deg:
                        continue
                    for sign in (1.0, -1.0):
                        u = (sign * s, -c)                      # toward the face
                        e = (F1[0] - F0[0], F1[1] - F0[1])
                        den = u[0] * (-e[1]) - u[1] * (-e[0])
                        if abs(den) < 1e-15:
                            continue
                        w = (F0[0] - P[0], F0[1] - P[1])
                        t = (w[0] * (-e[1]) - w[1] * (-e[0])) / den
                        v = (u[0] * w[1] - u[1] * w[0]) / den
                        if t <= 0 or not (-1e-6 <= v <= 1 + 1e-6):
                            continue
                        E = (P[0] + t * u[0], P[1] + t * u[1])
                        out[k] = {
                            "exit_r": E[0], "exit_depth": E[1], "entry_r": P[0], "entry_depth": P[1],
                            "length": t, "channel": ci, "facet_deg": ang, "flank_deg": fang,
                            "entry_off_square_deg": abs(ang - th),
                            "flank": (F0, F1), "facet": (A, B),
                            # Slant from the exit centre to each edge of the flank it leaves by.
                            "flank_slant": (math.hypot(E[0] - F0[0], E[1] - F0[1]),
                                            math.hypot(E[0] - F1[0], E[1] - F1[1])),
                            "inward": sign < 0,
                        }
    return out


_CACHE: Dict[Tuple[str, float], Dict[str, Any]] = {}


def resolve_path(path: str) -> str:
    """A drawing path as written in a config: absolute, else relative to the working directory,
    else to the EngineDesign root."""
    import os
    if os.path.isabs(path) or os.path.exists(path):
        return os.path.abspath(path)
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    return os.path.join(root, path)


def load_plate_profile(path: str) -> Dict[str, Any]:
    """``read_plate_profile``, cached on the file's path and modification time."""
    import os
    p = resolve_path(path)
    key = (p, os.path.getmtime(p))
    if key not in _CACHE:
        _CACHE.clear()
        _CACHE[key] = read_plate_profile(p)
    return _CACHE[key]


def section_thickness(profile: Dict[str, Any], r: Any) -> Any:
    """Metal on the axial line at each radius r [m]: the length of that line inside the profile
    (the whole plate, less the face groove, a channel, a seal groove, whatever is cut there)."""
    return loop_section(profile["loop"], r)


def loop_section(loop: List[Tuple[float, float]], r: Any) -> Any:
    """``section_thickness`` of a closed (r, z) loop."""
    import numpy as np
    rr = np.atleast_1d(np.asarray(r, dtype=float))
    out = np.zeros_like(rr)
    n = len(loop)
    for i, x in enumerate(rr):
        zs = []
        for j in range(n):
            (r0, z0), (r1, z1) = loop[j], loop[(j + 1) % n]
            if (r0 <= x < r1) or (r1 <= x < r0):
                zs.append(z0 + (z1 - z0) * (x - r0) / (r1 - r0))
        zs.sort()
        out[i] = sum(zs[k + 1] - zs[k] for k in range(0, len(zs) - 1, 2))
    return out if np.ndim(r) else float(out[0])


def loop_deviation(a: List[Tuple[float, float]], b: List[Tuple[float, float]], *, step: float = 5e-5
                   ) -> Dict[str, Any]:
    """How far apart two closed outlines are: for points every ``step`` along each, the distance
    to the other outline. ``max`` is the Hausdorff distance; ``where_a`` / ``where_b`` the points
    on each that sit farthest from the other."""
    import numpy as np

    def samples(L):
        P = np.asarray(L + L[:1], dtype=float)
        out = [P[0:1]]
        for i in range(len(P) - 1):
            seg = P[i + 1] - P[i]
            n = max(1, int(math.ceil(np.hypot(*seg) / step)))
            out.append(P[i] + np.outer(np.arange(1, n + 1) / n, seg))
        return np.vstack(out)

    def dist(Q, L):
        P = np.asarray(L + L[:1], dtype=float)
        A, B = P[:-1], P[1:]
        AB = B - A
        L2 = np.maximum((AB ** 2).sum(1), 1e-30)
        best = np.full(len(Q), np.inf)
        for j in range(len(A)):
            tt = np.clip(((Q - A[j]) @ AB[j]) / L2[j], 0.0, 1.0)
            d = np.hypot(*(Q - (A[j] + np.outer(tt, AB[j]))).T)
            best = np.minimum(best, d)
        return best

    Sa, Sb = samples(list(a)), samples(list(b))
    da, db = dist(Sa, list(b)), dist(Sb, list(a))
    ia, ib = int(np.argmax(da)), int(np.argmax(db))
    return {"max": float(max(da[ia], db[ib])), "a_to_b": float(da[ia]), "b_to_a": float(db[ib]),
            "where_a": tuple(float(v) for v in Sa[ia]), "where_b": tuple(float(v) for v in Sb[ib])}
