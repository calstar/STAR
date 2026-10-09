"""Engineering views of the impinging injector in its sleeve, as drawing primitives.

Presentation of ``engine.core.injectors.layout`` only: nothing here derives geometry, it places
what the layout computed. The frontend renders these primitives to SVG and to DXF from the same
list, so the screen and the CAD file cannot disagree, and neither can disagree with Layer 1.

Section views: x is radius (the axis at x = 0, the other half mirrored to x < 0), y is axial
with the face datum at y = 0, the plug's back face at y = +t and the chamber toward -y. Face
views: the face plane, origin on the axis.

Primitive shapes::

    {"t": "poly",   "layer": L, "pts": [[x, y], ...], "closed": bool, "id": optional}
    {"t": "circle", "layer": L, "c": [x, y], "r": r, "id": optional}
    {"t": "dim",    "layer": "DIM", "a": [x, y], "b": [x, y], "off": [dx, dy], "text": str,
                    "side": optional "right"}
    {"t": "text",   "layer": L, "at": [x, y], "text": str, "anchor": "start"|"middle"|"end"}

``id`` ties the same physical hole across views ("O3" = LOX element 3).
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

Pt = Tuple[float, float]

_ELLIPSE_PTS = 28


def _r(v: float) -> float:
    return round(v, 7)     # 0.1 um -- far below any machining tolerance


def poly(layer: str, ps: List[Pt], closed: bool = False, id: Optional[str] = None) -> Dict[str, Any]:
    out = {"t": "poly", "layer": layer, "pts": [[_r(x), _r(y)] for x, y in ps], "closed": closed}
    if id:
        out["id"] = id
    return out


def circle(layer: str, c: Pt, r: float, id: Optional[str] = None) -> Dict[str, Any]:
    out = {"t": "circle", "layer": layer, "c": [_r(c[0]), _r(c[1])], "r": _r(r)}
    if id:
        out["id"] = id
    return out


def dim(a: Pt, b: Pt, off: Pt, text: str, side: Optional[str] = None) -> Dict[str, Any]:
    """``side="right"`` puts a vertical dimension's text right of its line (default: left)."""
    out = {"t": "dim", "layer": "DIM", "a": [_r(a[0]), _r(a[1])], "b": [_r(b[0]), _r(b[1])],
           "off": [_r(off[0]), _r(off[1])], "text": text}
    if side:
        out["side"] = side
    return out


def text(layer: str, at: Pt, s: str, anchor: str = "start") -> Dict[str, Any]:
    return {"t": "text", "layer": layer, "at": [_r(at[0]), _r(at[1])], "text": s, "anchor": anchor}


def ellipse(layer: str, c: Pt, a: float, b: float, rot: float, id: Optional[str] = None) -> Dict[str, Any]:
    """Closed polyline: semi-axis ``a`` along angle ``rot`` (radians), ``b`` across it."""
    ca, sa = math.cos(rot), math.sin(rot)
    ps = []
    for i in range(_ELLIPSE_PTS):
        tt = 2 * math.pi * i / _ELLIPSE_PTS
        x, y = a * math.cos(tt), b * math.sin(tt)
        ps.append((c[0] + x * ca - y * sa, c[1] + x * sa + y * ca))
    return poly(layer, ps, closed=True, id=id)


def _mm(v: float, d: int = 2) -> str:
    return f"{v * 1000:.{d}f}"


def _sin(th: float) -> float:
    return math.sin(math.radians(th))


def _cos(th: float) -> float:
    return math.cos(math.radians(th))


# =============================================================================================
# Section
# =============================================================================================

def _zigzag(x: float, y0: float, y1: float, n: int = 4) -> List[Pt]:
    """A break line across a part that continues past the view (x fixed, y0 -> y1)."""
    amp = 0.12 * (y1 - y0) / n
    pts = [(x, y0)]
    for i in range(1, 2 * n):
        pts.append((x + (amp if i % 2 else -amp), y0 + (y1 - y0) * i / (2 * n)))
    pts.append((x, y1))
    return pts


def _plug_outline(lay: Dict[str, Any]) -> List[Pt]:
    """The plug's half-section outline in (x = z, y = r), from the port wall around to it again:
    along the face (groove included) out to the sleeve bore, down the rim, back along the back
    face with each channel notched in, up the hub, and the port wall."""
    if lay.get("profile"):
        # The half-section the layout built (or read from the drawing): (r, z) -> (x = z, y = r).
        return [(z, r) for r, z in lay["profile"]["loop"]]
    f, inp, env = lay["face"], lay["inputs"], lay["envelope"]
    t = float(inp["plate_thickness"])
    ign = lay.get("igniter") or {}
    r_port = 0.5 * ign["tap_drill"] if ign else 0.0          # the drilled hole; threads cut beyond it
    hub_t = (ign.get("hub_thickness") or t) if ign else t
    hub_r = 0.5 * (ign.get("hub_diameter") or 0.0) if ign else 0.0
    r_plate = env["r_sleeve_id"]
    face = [(z, r) for r, z in f["profile"] if r > r_port]
    face.insert(0, (0.0, r_port))
    face[-1] = (0.0, r_plate)
    back: List[Pt] = [(-t, r_plate)]
    chans = sorted((p["channel"] for p in lay["passages"].values() if p.get("channel")),
                   key=lambda c: -c["r_center"])
    for ch in chans:                       # outward -> inward along the back
        lo, hi = max(ch["r_lo"], r_port), min(ch["r_hi"], r_plate)   # a channel off the plug is flagged, not drawn into the sleeve
        if hi <= lo:
            continue
        zf = lambda rr, ch=ch: max(-t, ch["end"][1] + ch["floor_slope"] * (rr - ch["r_center"]))  # noqa: E731
        back += [(-t, hi), (zf(hi), hi), (zf(lo), lo), (-t, lo)]
    if hub_t > t and hub_r > r_port:
        back += [(-t, hub_r), (-hub_t, hub_r), (-hub_t, r_port)]
    else:
        back += [(-t, r_port)]
    return face + back


#: How each named inlet is cut at the hole's entry edge, as (kind, size / d). The fillets use the
#: r/d the Cd table is keyed to (engine.core.discharge.INLET_GEOMETRY_RD); the chamfer is that
#: table's "~45 deg x 0.1 d break". A countersink's size does not enter the Cd model; it is drawn
#: 45 deg to the wall, 0.2 d a side (90 deg included, to about 1.4 d on a square entry).
_INLET_CUT = {"chamfered": ("chamfer", 0.10), "conical": ("chamfer", 0.20)}


def _inlet_shape(p: Dict[str, Any]) -> Optional[Tuple[str, float]]:
    """(kind, size / d) for a passage's declared inlet; None for sharp or not set."""
    from engine.core.discharge import INLET_GEOMETRY_RD
    cd = p.get("cd") or {}
    rd, name = cd.get("inlet_r_over_d"), cd.get("inlet_name")
    if rd is not None:
        return ("fillet", float(rd)) if rd > 0 else None
    if name in _INLET_CUT:
        return _INLET_CUT[name]
    if name in INLET_GEOMETRY_RD and INLET_GEOMETRY_RD[name] > 0:
        return ("fillet", INLET_GEOMETRY_RD[name])
    return None


def _unit(v: Pt) -> Pt:
    n = math.hypot(v[0], v[1])
    return (v[0] / n, v[1] / n) if n > 0 else (0.0, 0.0)


def _inlet_corner(P: Pt, w: Pt, f: Pt, shape: Optional[Tuple[str, float]], d: float, n: int = 12) -> List[Pt]:
    """The entry edge at corner P, from the hole wall (unit ray ``w``, toward the exit) round to
    the floor (unit ray ``f``, away from the hole). The metal is the wedge between the two rays;
    a chamfer or fillet takes its corner off. Sharp: just P."""
    if not shape:
        return [P]
    kind, size = shape
    cos_a = max(-1.0, min(1.0, w[0] * f[0] + w[1] * f[1]))
    alpha = math.acos(cos_a)                       # the metal wedge's angle
    if kind == "chamfer":
        c = size * d
        return [(P[0] + w[0] * c, P[1] + w[1] * c), (P[0] + f[0] * c, P[1] + f[1] * c)]
    r = size * d
    t = r / math.tan(0.5 * alpha)                  # tangent points' distance from the corner
    h = r / math.sin(0.5 * alpha)
    b = _unit((w[0] + f[0], w[1] + f[1]))
    C = (P[0] + b[0] * h, P[1] + b[1] * h)
    T1 = (P[0] + w[0] * t, P[1] + w[1] * t)
    T2 = (P[0] + f[0] * t, P[1] + f[1] * t)
    a1 = math.atan2(T1[1] - C[1], T1[0] - C[0])
    a2 = math.atan2(T2[1] - C[1], T2[0] - C[0])
    sweep = (a2 - a1 + math.pi) % (2 * math.pi) - math.pi     # the short way round, past P
    return [(C[0] + r * math.cos(a1 + sweep * i / n), C[1] + r * math.sin(a1 + sweep * i / n))
            for i in range(n + 1)]


def _passage_parts(lay: Dict[str, Any], k: str) -> List[Tuple[Pt, ...]]:
    f, inp = lay["face"], lay["inputs"]
    p = lay["passages"][k]
    st = inp["oxidizer" if k == "O" else "fuel"]
    th, d = float(st["impingement_angle"]), float(st["d_jet"])
    inner = (k == "O") == bool(f["ox_is_inner"])
    sgn = -1.0 if inner else 1.0
    ux, uy = -_cos(th), sgn * _sin(th)       # along the axis, into the plug (x = z, y = r)
    nx, ny = sgn * _sin(th), _cos(th)        # across it, in the section plane
    ex, ey = p["exit"][1], p["exit"][0]      # exit in (x, y)
    t = float(inp["plate_thickness"])
    ch = p.get("channel")

    def edge(off: float, s0: float, s1: float, start_x: Optional[float], end_x: Optional[float]):
        ox, oy = ex + off * nx, ey + off * ny
        a, b = s0, s1
        if start_x is not None:
            a = (start_x - ox) / ux              # x(s) = ox + s ux  ->  s where x = start_x
        if end_x is not None:
            b = (end_x - ox) / ux
        return (ox + a * ux, oy + a * uy), (ox + b * ux, oy + b * uy)

    start_x = None if f["contoured"] else 0.0            # contoured: the exit is square on the flank
    if ch is not None:
        end_x = None if ch["floor"] in ("coned", "spot", "drawing") else ch["end"][1]
        L = ch["length"]
        (a1, a2), (b1, b2) = (edge(+0.5 * d, 0.0, L, start_x, end_x),
                              edge(-0.5 * d, 0.0, L, start_x, end_x))
        return [(a1, a2, b2, b1)]
    land, bore = p["land"], p["bore"]
    (a1, a2), (b1, b2) = (edge(+0.5 * d, 0.0, land, start_x, None),
                          edge(-0.5 * d, 0.0, land, start_x, None))
    if p["bore_len"] <= 0:
        (a1, a2), (b1, b2) = (edge(+0.5 * d, 0.0, 0.0, start_x, -t),
                              edge(-0.5 * d, 0.0, 0.0, start_x, -t))
    parts: List[Tuple[Pt, ...]] = [(a1, a2, b2, b1)]
    if p["bore_len"] > 0:
        c1, c2 = edge(+0.5 * bore, land, 0.0, None, -t)
        e1, e2 = edge(-0.5 * bore, land, 0.0, None, -t)
        parts.append((c1, c2, e2, e1))
    return parts


def _passage_cut(lay: Dict[str, Any], k: str) -> Tuple[List[List[Pt]], List[List[Pt]]]:
    """The cut of one passage by the section plane (which contains its axis): a strip of width d
    from the exit to where it ends, each end the shape it really has -- square to the axis on a
    contoured flank or a coned floor; cut obliquely by a flat face, a flat channel floor, or the
    back face -- with the declared inlet (chamfer, countersink, radius) cut into its entry edge.

    Returns (fills, walls): the open space as closed polygons, and the hole's walls as open
    polylines. The ends where the hole opens (onto the face, into a channel) are not edges."""
    parts = _passage_parts(lay, k)
    a1, a2, b2, b1 = parts[0]
    d = float(lay["inputs"]["oxidizer" if k == "O" else "fuel"]["d_jet"])
    shape = _inlet_shape(lay["passages"][k])
    ca = _inlet_corner(a2, _unit((a1[0] - a2[0], a1[1] - a2[1])), _unit((a2[0] - b2[0], a2[1] - b2[1])), shape, d)
    cb = _inlet_corner(b2, _unit((b1[0] - b2[0], b1[1] - b2[1])), _unit((b2[0] - a2[0], b2[1] - a2[1])), shape, d)
    # The fill runs a hair past both openings so the floor and face lines do not show across them.
    ax = _unit((0.5 * (a1[0] + b1[0] - a2[0] - b2[0]), 0.5 * (a1[1] + b1[1] - a2[1] - b2[1])))
    e = 0.04 * d
    out_a, out_b = (a1[0] + ax[0] * e, a1[1] + ax[1] * e), (b1[0] + ax[0] * e, b1[1] + ax[1] * e)
    in_a = (ca[-1][0] - ax[0] * e, ca[-1][1] - ax[1] * e)
    in_b = (cb[-1][0] - ax[0] * e, cb[-1][1] - ax[1] * e)
    fills = [[out_a, a1, *ca, in_a, in_b, *reversed(cb), b1, out_b]] + [list(q) for q in parts[1:]]
    wa, wb = [a1, *ca], [b1, *cb]
    if len(parts) > 1:                  # counterbore: its bottom out to its wall, then up to the back
        c1, c2, e2, e1 = parts[1]
        wa += [c1, c2]
        wb += [e1, e2]
    return fills, [wa, wb]


def _passage_polys(lay: Dict[str, Any], k: str) -> List[List[Pt]]:
    """The open space of one passage in the section plane (see ``_passage_cut``)."""
    return _passage_cut(lay, k)[0]


def _inlet_note(p: Dict[str, Any], d: float) -> str:
    """', rounded inlet r 0.19' for a hole label; empty for sharp or not set."""
    shape = _inlet_shape(p)
    if shape is None:
        return ""
    cd = p.get("cd") or {}
    what = f"r/d {cd['inlet_r_over_d']:g}" if cd.get("inlet_r_over_d") is not None else cd.get("inlet_name")
    kind, size = shape
    return f", {what} inlet " + (f"r {_mm(size * d, 2)}" if kind == "fillet" else f"{_mm(size * d, 2)}×45°")


def _rot(prims: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Model frame (x = z, y = r) -> drawing frame (X = r across, Y = -z up): the plug lies
    across the view with the manifold side on top and the chamber below."""
    R = lambda q: [_r(q[1]), _r(-q[0])]  # noqa: E731
    out = []
    for p in prims:
        p = dict(p)
        if p["t"] == "poly":
            p["pts"] = [R(q) for q in p["pts"]]
        elif p["t"] == "circle":
            p["c"] = R(p["c"])
        elif p["t"] == "text":
            p["at"] = R(p["at"])
        out.append(p)
    return out


def _section(lay: Dict[str, Any], through_doublet: bool) -> List[Dict[str, Any]]:
    """Half section of the plug in its sleeve, true scale. Radius runs across the view (axis at
    the left edge, the other half mirrored to the left), the back face is on top and the chamber
    below. Each channel carries its width and depth, and each passage's axis is drawn through to
    the channel floor with the channel's centre line, so the two meet where the hole enters."""
    f, P, inp, env = lay["face"], lay["passages"], lay["inputs"], lay["envelope"]
    ign = lay.get("igniter")
    t = float(inp["plate_thickness"])
    n = int(f["n"])
    r_b, r_s, r_so = env["r_bore"], env["r_sleeve_id"], env["r_sleeve_od"]
    hub_t = ((ign or {}).get("hub_thickness") or t)
    r_port = 0.5 * ign["thread_od"] if ign else 0.0
    r_port_major, r_tap = r_port, (0.5 * ign["tap_drill"] if ign else 0.0)
    x_ch = max(2.5 * max(f["z_imp"], 0.0) + 0.004, 0.015)     # enough chamber to show the jets meet
    x_aft = -max(hub_t, t) - 0.25 * t
    outline = _plug_outline(lay)
    chans = {k: P[k].get("channel") for k in ("O", "F")}

    # ---- geometry, built in the model frame (x = z, y = r) and turned at the end ------------
    geo: List[Dict[str, Any]] = []
    phi_top = 0.0 if through_doublet else math.pi / n
    for half, phi in ((1, phi_top), (-1, phi_top + math.pi)):
        kk = phi * n / (2 * math.pi)
        has_doublet = abs(kk - round(kk)) < 1e-6

        def H(ps: List[Pt], half: int = half) -> List[Pt]:
            return [(x, half * y) for x, y in ps]

        geo.append(poly("PLATE", H(outline), closed=True))
        if env["sleeve_declared"]:
            geo.append(poly("SLEEVE", H([(x_aft, r_s), (x_ch, r_s), (x_ch, r_so), (x_aft, r_so)]), closed=True))
        if env["liner_thickness"] > 0:
            geo.append(poly("LINER", H([(0.0, r_b), (x_ch, r_b), (x_ch, r_b + env["liner_thickness"]),
                                        (0.0, r_b + env["liner_thickness"])]), closed=True))
        if ign:
            # Tapped from the back: the thread's major diameter (NPT, 1 in 16 on diameter, large
            # end at the back) over the length the metal gives, closed onto the drilled wall
            # where the thread runs out. Red when the thread needs more than that (L2).
            z_back = -max(hub_t, t)
            run = min(ign["l2"], -z_back)
            r_end = r_port_major - run / 32.0
            geo.append(poly("THREAD" if ign["l2"] <= -z_back + 1e-9 else "BAD",
                            H([(z_back, r_port_major), (z_back + run, r_end), (z_back + run, r_tap)])))
        for ch in chans.values():
            if ch:   # the channel's centre line, back face to floor
                rf = ch.get("r_floor", ch["r_center"])
                geo.append(poly("CENTER", H([(-t, rf), (-t + ch["depth"], rf)])))
        if has_doublet and not f["degenerate"]:
            idx = int(round(kk)) % n
            for k in ("O", "F"):
                fills, walls = _passage_cut(lay, k)
                for ps in fills:
                    geo.append(poly("HOLE_" + k, H(ps), closed=True, id=f"{k}{idx}"))
                for ps in walls:
                    geo.append(poly("PASSAGE_" + k, H(ps), id=f"{k}{idx}"))
                ex = (P[k]["exit"][1], P[k]["exit"][0])
                end = chans[k]["end"] if chans[k] else None
                # The hole's axis, from where the jets meet back through the exit to where it
                # enters its channel.
                axis = [(f["z_imp"], f["r_imp"]), ex] + ([(end[1], end[0])] if end else [])
                geo.append(poly("JET_" + k, H(axis), id=f"{k}{idx}"))
            geo.append(circle("IMPINGE", (f["z_imp"], half * f["r_imp"]), max(0.00035, 0.012 * f["l_imp"])))
        geo.append(poly("CHAMBER", H([(0.0, r_b), (x_ch, r_b)])))
        # The sleeve and liner continue past the view: zig-zag break lines, not ends.
        top = r_so if env["sleeve_declared"] else r_b + env["liner_thickness"]
        if top > r_b:
            geo.append(poly("BREAK", H(_zigzag(x_ch, r_b, top))))
        if env["sleeve_declared"]:
            geo.append(poly("BREAK", H(_zigzag(x_aft, r_s, r_so))))
    geo.append(poly("CENTER", [(x_aft - 0.003, 0.0), (x_ch, 0.0)]))
    prims = _rot(geo)

    # ---- annotation, in the drawing frame (X = r, Y = -z: back face at Y = t) ----------------
    fs = 0.0021                       # about the renderer's text height at this view's size
    top_y = max(hub_t, t)
    prims.append(text("NOTE", (0.5 * r_b, -0.85 * x_ch), "chamber", "middle"))
    if env["liner_thickness"] > 0:
        prims.append(text("NOTE", (r_b + 0.5 * env["liner_thickness"], -0.6 * x_ch), "phenolic", "middle"))
    if env["sleeve_declared"]:
        prims.append(text("NOTE", (r_so + 0.0015, -0.6 * x_ch), "sleeve", "start"))
    land_out = max([c["r_hi"] for c in chans.values() if c] or [r_port])
    prims.append(text("NOTE", (0.5 * (land_out + r_s), 0.5 * t - 0.4 * fs), "injector", "middle"))
    for k, name in (("O", "LOX"), ("F", "fuel")):
        ch = chans[k]
        if not ch:
            continue
        rf = ch.get("r_floor", ch["r_center"])
        z_floor = t - ch["depth"]             # the floor, drawing frame
        prims.append(dim((ch["r_lo"], t), (ch["r_hi"], t), (0.0, 0.0015), _mm(ch["width"])))
        prims.append(dim((rf, t), (rf, z_floor), (ch["r_hi"] - rf + 0.0012, 0.0), _mm(ch["depth"]), side="right"))
        prims.append(text("PASSAGE_" + k, (0.5 * (ch["r_lo"] + ch["r_hi"]), t + 0.0015 + 1.6 * fs),
                          f"{name} channel", "middle"))
    if ign:
        # The thread line runs the engagement the thread needs (L2) from the back; red when the
        # metal at the port is shorter than that.
        # Left of the centre line, level with the port: the one clear place in a half section.
        prims.append(text("NOTE", (-0.0015, 0.5 * top_y + 0.6 * fs),
                          f"{ign['thread']} port, L2 {_mm(ign['l2'])}", "end"))
        if ign["l2"] > top_y:
            prims.append(text("BAD", (-0.0015, 0.5 * top_y - 0.9 * fs), f"needs {_mm(ign['l2'])}, has {_mm(top_y)}", "end"))

    grooves = (lay.get("profile") or {}).get("grooves") or []
    if grooves:
        g0 = grooves[0]
        prims.append(text("NOTE", (0.5 * (g0["r_inner"] + g0["r_outer"]), t + 0.0015 + 1.6 * fs), "seal", "middle"))
    ref = r_so if env["sleeve_declared"] else r_s
    prims.append(dim((r_s, 0.0), (r_s, t), (ref - r_s + 0.003, 0.0), f"plate {_mm(t)}", side="right"))
    if hub_t > t and ign and ign.get("hub_diameter"):
        prims.append(dim((0.5 * ign["hub_diameter"], 0.0), (0.5 * ign["hub_diameter"], hub_t),
                         (0.003, 0.0), f"centre {_mm(hub_t)}", side="right"))
    if through_doublet and not f["degenerate"]:
        prims.append(text("NOTE", (f["r_imp"], -f["z_imp"] - 1.6 * fs),
                          f"meet {_mm(f['z_imp'], 1)} in front, ⌀{_mm(2 * f['r_imp'], 1)}", "middle"))
        # Both hole labels stacked in the clear chamber space inside the inner exit, colour-coded:
        # right of it the jets, the phenolic and the sleeve leave no room.
        x_lab = min(P["O"]["exit"][0], P["F"]["exit"][0]) - 0.002
        for row, (k, name) in enumerate((("O", "LOX"), ("F", "fuel"))):
            p = P[k]
            st = inp["oxidizer" if k == "O" else "fuel"]
            prims.append(text("PASSAGE_" + k, (x_lab, -(1.4 + 1.4 * row) * fs),
                              f"{name} {st['impingement_angle']:.0f}° ⌀{_mm(st['d_jet'], 3)} L/d {p['land_ld']:.1f}"
                              + _inlet_note(p, float(st["d_jet"])), "end"))
    return prims


# =============================================================================================
# Face and back views
# =============================================================================================

def _face(lay: Dict[str, Any], back: bool) -> List[Dict[str, Any]]:
    f, P, inp, env = lay["face"], lay["passages"], lay["inputs"], lay["envelope"]
    ign = lay.get("igniter")
    n = int(f["n"])
    r_b, r_s = env["r_bore"], env["r_sleeve_id"]
    mx = -1.0 if back else 1.0          # seen from the back, clocking is mirrored
    prims: List[Dict[str, Any]] = []
    if env["sleeve_declared"]:
        prims.append(circle("SLEEVE", (0.0, 0.0), env["r_sleeve_od"]))
    prims.append(circle("PLATE", (0.0, 0.0), r_s))
    if not back:
        if env["liner_thickness"] > 0:
            prims.append(circle("LINER", (0.0, 0.0), r_b + env["liner_thickness"]))
        prims.append(circle("CHAMBER", (0.0, 0.0), r_b))
        g = f.get("groove")
        if g:
            for rr in (g["groove_edge_in"], g["groove_edge_out"]):
                prims.append(circle("GROOVE", (0.0, 0.0), rr))
    else:
        prims.append(circle("HIDDEN", (0.0, 0.0), r_b))
        for k in ("O", "F"):
            ch = P[k].get("channel")
            if ch:
                prims.append(circle("CHANNEL_" + k, (0.0, 0.0), ch["r_lo"]))
                prims.append(circle("CHANNEL_" + k, (0.0, 0.0), ch["r_hi"]))
        for g in (lay.get("profile") or {}).get("grooves") or []:
            prims.append(circle("SEAL", (0.0, 0.0), g["r_inner"]))
            prims.append(circle("SEAL", (0.0, 0.0), g["r_outer"]))
    for k in ("O", "F"):
        st = inp["oxidizer" if k == "O" else "fuel"]
        th, d = float(st["impingement_angle"]), float(st["d_jet"])
        p = P[k]
        ch = p.get("channel")
        if back:
            r_c = p["r_back"]
            if ch:
                a, b = 0.5 * ch["footprint"], 0.5 * d     # breakthrough on the channel floor
            else:
                w = p["entry_d"]
                a, b = 0.5 * w / max(0.1, _cos(th)), 0.5 * w
        else:
            r_c = f["r_O"] if k == "O" else f["r_F"]
            if f["contoured"]:
                a, b = 0.5 * d * _cos(th), 0.5 * d        # a round exit on a flank, seen along the axis
            else:
                a, b = 0.5 * d / max(0.1, _cos(th)), 0.5 * d
            prims.append(circle("PITCH_" + k, (0.0, 0.0), r_c))
        n_k = n if k == "O" else int(f.get("n_F", n))
        for i in range(n_k):
            ang = 2 * math.pi * i / n_k + math.pi / 2
            c = (mx * r_c * math.cos(ang), r_c * math.sin(ang))
            prims.append(ellipse("PASSAGE_" + k, c, a, b, math.atan2(c[1], c[0]), id=f"{k}{i}"))
    if not back and not f["degenerate"]:
        prims.append(circle("IMPINGE_RING", (0.0, 0.0), f["r_imp"]))
    if ign:
        prims.append(circle("IGNITER", (0.0, 0.0), 0.5 * ign["thread_od"]))
        if back and ign.get("hub_diameter"):
            prims.append(circle("IGNITER", (0.0, 0.0), 0.5 * ign["hub_diameter"]))
    keep = (lay.get("centre_keepout") or {}).get("dia") or 0.0
    if not back and keep > 0:
        prims.append(circle("KEEPOUT", (0.0, 0.0), 0.5 * keep))
    if not back:
        prims.append(text("NOTE", (0.0, -(r_b - 0.0035)), "bore", "middle"))
        if env["liner_thickness"] > 0:
            prims.append(text("NOTE", (0.0, -(r_b + 0.5 * env["liner_thickness"]) - 0.001), "liner end", "middle"))
        if f.get("groove"):
            prims.append(text("NOTE", (0.0, f["groove"]["groove_edge_out"] + 0.0015), "groove", "middle"))
    else:
        for k, name in (("O", "LOX"), ("F", "fuel")):
            ch = P[k].get("channel")
            if ch:
                prims.append(text("PASSAGE_" + k, (0.0, ch["r_hi"] + 0.0015), f"{name} channel", "middle"))
    if back and lay["back"].get("lands"):
        L = lay["back"]["lands"]
        inner = "O" if f["ox_is_inner"] else "F"
        outer = "F" if inner == "O" else "O"
        ci, co = P[inner]["channel"], P[outer]["channel"]
        prims.append(text("NOTE", (0.0, -0.5 * (ci["r_hi"] + co["r_lo"])), f"land {_mm(L['between'])}", "middle"))
        prims.append(text("NOTE", (0.0, -0.5 * (co["r_hi"] + r_s)), f"land {_mm(L['outer'])}", "middle"))
    R = env["r_sleeve_od"] if env["sleeve_declared"] else r_s
    prims.append(poly("CENTER", [(-R * 1.04, 0.0), (R * 1.04, 0.0)]))
    prims.append(poly("CENTER", [(0.0, -R * 1.04), (0.0, R * 1.04)]))
    return prims


# =============================================================================================
# Port plate and revolve sketch
# =============================================================================================

def _ports(lay: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The cover plate from above: its feed ports over the channels (hidden), the igniter."""
    ports, env, P = lay["ports"], lay["envelope"], lay["passages"]
    r_s = env["r_sleeve_id"]
    prims: List[Dict[str, Any]] = [circle("PLATE", (0.0, 0.0), r_s)]
    for k in ("O", "F"):
        ch = P[k]["channel"]
        prims.append(circle("HIDDEN", (0.0, 0.0), ch["r_lo"]))
        prims.append(circle("HIDDEN", (0.0, 0.0), ch["r_hi"]))
    for g in (lay.get("profile") or {}).get("grooves") or []:
        prims.append(circle("SEAL", (0.0, 0.0), g["r_inner"]))
        prims.append(circle("SEAL", (0.0, 0.0), g["r_outer"]))
    for k, name in (("O", "LOX"), ("F", "fuel")):
        ring = ports["rings"][k]
        for i, a in enumerate(ring["angles_deg"]):
            ang = math.radians(90.0 - a)          # the first port at 12 o'clock, clockwise
            c = (ring["r"] * math.cos(ang), ring["r"] * math.sin(ang))
            prims.append(circle("PASSAGE_" + k, c, 0.5 * ports["bore"], id=f"P{k}{i}"))
            prims.append(circle("THREAD", c, 0.5 * ports["thread_od"]))
        a = math.radians(90.0 - ring["angles_deg"][0])
        prims.append(text("PASSAGE_" + k, (ring["r"] * math.cos(a) + 0.5 * ports["thread_od"] + 0.0015,
                                           ring["r"] * math.sin(a)),
                          f"{name} {ports['per_ring']}× {ports['thread']} on ⌀{_mm(2 * ring['r'], 1)}", "start"))
    ign = lay.get("igniter")
    if ign:
        prims.append(circle("IGNITER", (0.0, 0.0), 0.5 * ign["tap_drill"]))
        prims.append(circle("THREAD", (0.0, 0.0), 0.5 * ign["thread_od"]))
        prims.append(text("NOTE", (0.0, -0.5 * ign["thread_od"] - 0.004), f"igniter {ign['thread']}", "middle"))
    prims.append(poly("CENTER", [(-r_s * 1.04, 0.0), (r_s * 1.04, 0.0)]))
    prims.append(poly("CENTER", [(0.0, -r_s * 1.04), (0.0, r_s * 1.04)]))
    return prims


def _revolve(lay: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The plate's half-section as a CAD revolve sketch: one closed profile, radius across (x),
    axial up from the face (y = 0 at the face, the back face at y = t), and the axis. Nothing
    else, so it revolves as it is."""
    loop = lay["profile"]["loop"]
    t = float(lay["profile"]["thickness"])
    return [poly("PLATE", [(r, -z) for r, z in loop], closed=True),
            poly("CENTER", [(0.0, -0.1 * t), (0.0, 1.1 * t)])]


def injector_drawings(lay: Dict[str, Any]) -> Dict[str, Any]:
    """All views of a layout."""
    out = {
        "face": _face(lay, back=False),
        "back": _face(lay, back=True),
        "section_doublet": _section(lay, True),
        "section_between": _section(lay, False),
    }
    if lay.get("profile"):
        out["revolve"] = _revolve(lay)
    if lay.get("ports"):
        out["ports"] = _ports(lay)
    return out
