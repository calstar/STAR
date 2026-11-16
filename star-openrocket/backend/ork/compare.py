"""Two models side by side: the numbers that decide whether a CAD model and an .ork
describe the same rocket.

Both sides go through the same code -- ``aero_core`` for the airframe and fins,
``compute_stability`` for mass, CG, CP and margin -- so a difference in the table is
a difference in the models, never in how they were measured. Geometry is read off
each model's own surfaces, which is why the nose is compared by its radius at fixed
fractions of its length rather than by a shape name only an .ork has.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..onshape.aero.stability import MotorPlacement, aero_core, compute_stability

#: Fractions of the nose length the profile is sampled at.
NOSE_STATIONS = (0.1, 0.25, 0.5, 0.75)


@dataclass
class Side:
    """One model, with the selection and motor its stability request carries."""

    store: object
    parts: list[dict]
    outer_faces: list[tuple[str, str]]
    fin_faces: list[tuple[str, str]] | None
    n_fins: int | None
    overrides: dict[str, float]
    launch: MotorPlacement | None
    burnout: MotorPlacement | None


def _tube_span(store, outer_faces, axis, x_fore: float, body_r: float) -> tuple[float, float] | None:
    """Fore and aft ends of the body-radius tubes on the skin, from the nose tip.

    The nose ends where the first body tube starts, and the boattail where the last
    one stops. Reading it off the radius instead fails on a tangent ogive, which
    meets the tube so gradually that it is within 0.1 % of the body radius 31 mm
    before its end."""
    lo, hi = None, None
    for fg in store.faces_for(outer_faces):
        if fg.surface_type != "CYLINDER" or not fg.radius or abs(fg.radius - body_r) > 0.002 * body_r:
            continue
        s, _ = axis.axial_radial(fg.triangles.reshape(-1, 3))
        lo = float(s.min()) if lo is None else min(lo, float(s.min()))
        hi = float(s.max()) if hi is None else max(hi, float(s.max()))
    if lo is None:
        return None
    return lo - x_fore, hi - x_fore


def _airframe(profile, span: tuple[float, float] | None = None) -> dict:
    s = np.asarray(profile.s_grid) - profile.x_fore
    r = np.asarray(profile.r_grid)
    # The body radius is the one most of the *length* sits at: tubes dominate a
    # rocket, so this ignores a camera shroud standing proud of one tube. Weighted by
    # length, not by station: a tube is two stations and a nose hundreds.
    width = np.gradient(s) if len(s) > 1 else np.ones_like(s)
    order = np.argsort(r)
    cum = np.cumsum(width[order])
    body_r = float(r[order][np.searchsorted(cum, cum[-1] / 2)])
    at_body = np.nonzero(r >= 0.999 * body_r)[0]
    nose_len = float(s[at_body[0]]) if len(at_body) else float(s[-1])
    tail_start = float(s[at_body[-1]]) if len(at_body) else float(s[-1])
    if span is not None:
        nose_len, tail_start = span
    nose = {
        f"{int(f * 100)}": float(np.interp(f * nose_len, s, r)) for f in NOSE_STATIONS
    }
    return {
        "length": float(s[-1]),
        "bodyDiameter": 2 * body_r,
        "refDiameter": 2 * float(profile.r_max),
        "noseLength": nose_len,
        "noseRadius": nose,
        "tailLength": float(s[-1]) - tail_start,
        "aftDiameter": 2 * float(r[-1]),
    }


def summarize(side: Side) -> dict:
    core = aero_core(side.store, side.outer_faces, None, side.fin_faces, side.n_fins)
    airframe = _airframe(core.profile)
    span = _tube_span(side.store, side.outer_faces, core.axis, core.profile.x_fore, airframe["bodyDiameter"] / 2)
    out = {"airframe": _airframe(core.profile, span), "fins": None}
    pf = core.fin_pf
    if pf is not None:
        out["fins"] = {
            "count": pf.n_fins,
            "rootChord": pf.root_chord,
            "tipChord": pf.tip_chord,
            "sweep": pf.sweep,
            "span": pf.span,
            "area": pf.area,
            "leadingEdgeFromNose": float(pf.chord_lead[0]) - core.profile.x_fore,
        }
    for state, motor in (("dry", None), ("launch", side.launch), ("burnout", side.burnout)):
        if state != "dry" and motor is None:
            out[state] = None
            continue
        r = compute_stability(
            side.store, side.parts, side.outer_faces, overrides=side.overrides,
            fin_faces=side.fin_faces, n_fins=side.n_fins, motor=motor,
        )
        out[state] = {
            "mass": r.mass,
            "cgFromNose": r.cg_from_nose,
            "cpFromNose": r.cp_from_nose,
            "staticMargin": r.static_margin,
        }
    return out


# (key path, label, kind). Values stay SI; ``kind`` is the frontend's unit kind
# (frontend/src/lib/units), so the table shows the user's chosen units. "count"
# and "margin" (calibres) have no unit to convert.
_ROWS: list[tuple[str, str, str]] = [
    ("airframe.length", "Length", "length"),
    ("airframe.bodyDiameter", "Body diameter", "smallLength"),
    ("airframe.refDiameter", "Reference diameter", "smallLength"),
    ("airframe.noseLength", "Nose length", "length"),
    *[(f"airframe.noseRadius.{int(f * 100)}", f"Nose radius at {int(f * 100)} % of its length", "smallLength")
      for f in NOSE_STATIONS],
    ("airframe.tailLength", "Boattail length", "length"),
    ("airframe.aftDiameter", "Aft diameter", "smallLength"),
    ("fins.count", "Fin count", "count"),
    ("fins.rootChord", "Fin root chord", "smallLength"),
    ("fins.tipChord", "Fin tip chord", "smallLength"),
    ("fins.sweep", "Fin sweep", "smallLength"),
    ("fins.span", "Fin span", "smallLength"),
    ("fins.area", "Fin area (one fin)", "area"),
    ("fins.leadingEdgeFromNose", "Fin leading edge from nose", "length"),
    ("dry.mass", "Mass, no motor", "mass"),
    ("dry.cgFromNose", "CG, no motor", "length"),
    ("dry.cpFromNose", "CP (Mach 0.3)", "length"),
    ("launch.mass", "Mass at launch", "mass"),
    ("launch.cgFromNose", "CG at launch", "length"),
    ("launch.staticMargin", "Static margin at launch", "margin"),
    ("burnout.mass", "Mass at burnout", "mass"),
    ("burnout.cgFromNose", "CG at burnout", "length"),
    ("burnout.staticMargin", "Static margin at burnout", "margin"),
]

#: A difference no larger than this (SI) is "the same": about what a build can
#: resolve -- a millimetre of geometry, 5 mm of CG/CP, 0.1 kg, a twentieth of a calibre.
TOLERANCE = {"length": 0.005, "smallLength": 0.001, "area": 5e-4, "mass": 0.1, "margin": 0.05, "count": 0.0}


def _get(tree: dict | None, path: str):
    node = tree
    for key in path.split("."):
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node if isinstance(node, (int, float)) else None


def compare(a: Side, b: Side) -> dict:
    sa, sb = summarize(a), summarize(b)
    rows = []
    for path, label, kind in _ROWS:
        va, vb = _get(sa, path), _get(sb, path)
        if va is None and vb is None:
            continue
        # Plain floats: numpy scalars do not serialise.
        va = None if va is None else float(va)
        vb = None if vb is None else float(vb)
        delta = None if va is None or vb is None else vb - va
        rel = None if delta is None or not va else delta / abs(va)
        differs = bool(delta is not None and abs(delta) > TOLERANCE[kind] + 1e-12)
        rows.append({"key": path, "label": label, "kind": kind, "a": va, "b": vb,
                     "delta": delta, "relative": rel, "differs": differs})
    return {"a": sa, "b": sb, "rows": rows}
