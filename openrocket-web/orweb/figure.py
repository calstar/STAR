"""The side view (docs/SCHEMA.md "Figure"): every active component instance as polygons.

Ported from OpenRocket 24.12 (GPLv3): info.openrocket.swing.gui.rocketfigure.RocketFigure
(instance iteration, motors), SymmetricComponentShapes (profile sampling), TransitionShapes,
BodyTubeShapes / TubeShapes, FinSetShapes (side view), TubeFinSetShapes, RingComponentShapes,
MassComponentShapes / ShockCordShapes / ParachuteShapes / StreamerShapes, LaunchLugShapes,
RailButtonShapes (simplified to its outline).

Coordinates are absolute: x aft from the nose tip, y up, metres. Each instance is drawn
with the same transform the physics uses (FlightConfiguration.getActiveInstances), so
a fin at roll angle phi appears with its span projected by cos(phi), a pod at its
radial offset, a clustered motor at each cluster position.
"""

from __future__ import annotations

import math

from .components.fins import FinSet, TubeFinSet
from .components.internal import RingComponent
from .components.lugs import LaunchLug, RailButton
from .components.massobjects import MassObject, RecoveryDevice
from .components.symmetric import BodyTube, Shape, SymmetricComponent, Transition
from .config import get_motor_config
from .util import mathutil as mu
from .util.coordinate import ZERO, Coordinate

MINPOINTS = 91
ACCEPTABLE_ANGLE = math.cos(7.0 * math.pi / 180.0)


def _rect(x: float, y: float, w: float, h: float) -> list[list[float]]:
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]


def _tube(transform, length: float, radius: float) -> list[list[float]]:
    """TubeShapes.getShapesSide."""
    p = transform.transform(ZERO)
    return _rect(p.x, p.y - radius, length, 2 * radius)


def _cos_angle(v1: Coordinate, v2: Coordinate, v3: Coordinate) -> float:
    a, b = v1.sub(v2), v2.sub(v3)
    ln = mu.safe_sqrt(a.length2() * b.length2())
    return a.dot(b) / ln if ln else 1.0


def symmetric_profile(c: SymmetricComponent) -> list[Coordinate]:
    """SymmetricComponentShapes' adaptive (x, r) samples along the component."""
    delta = 0.0000001
    length = c.get_length()
    pts = [Coordinate(delta, c.get_radius(delta), 0.0)]
    for i in range(1, MINPOINTS - 1):
        x = length * i / (MINPOINTS - 1)
        pts.append(Coordinate(x, c.get_radius(x), 0.0))
    x = length - delta
    pts.append(Coordinate(x, c.get_radius(x), 0.0))
    i = 0
    while i < len(pts) - 2:
        if _cos_angle(pts[i], pts[i + 1], pts[i + 2]) > ACCEPTABLE_ANGLE or pts[i + 1].x - pts[i].x < 0.001:
            i += 1
            continue
        n = i + 1 if (pts[i + 2].x - pts[i + 1].x > pts[i + 1].x - pts[i].x) else i
        x = (pts[n].x + pts[n + 1].x) / 2
        pts.insert(n + 1, Coordinate(x, c.get_radius(x), 0.0))
    return pts


def _symmetric_side(c: SymmetricComponent, transform) -> list[list[list[float]]]:
    nose = transform.transform(ZERO)
    if isinstance(c, BodyTube):
        return [_tube(transform, c.get_length(), c.get_outer_radius())]
    shapes = []
    if isinstance(c, Transition) and c.get_shape_type() is Shape.CONICAL:
        L, r1, r2 = c.get_length(), c.get_fore_radius(), c.get_aft_radius()
        shapes.append([[nose.x, nose.y + r1], [nose.x + L, nose.y + r2], [nose.x + L, nose.y - r2],
                       [nose.x, nose.y - r1]])
    else:
        pts = symmetric_profile(c)
        upper = [[nose.x + p.x, nose.y + p.y] for p in reversed(pts)]
        lower = [[nose.x + p.x, nose.y - p.y] for p in pts]
        shapes.append(upper + lower)
    if isinstance(c, Transition):
        if c.get_fore_shoulder_length() > 0.0005:
            from .util.coordinate import Transformation
            t = transform.apply_transformation(Transformation.translation(-c.get_fore_shoulder_length(), 0.0, 0.0))
            shapes.append(_tube(t, c.get_fore_shoulder_length(), c.get_fore_shoulder_radius()))
        if c.get_aft_shoulder_length() > 0.0005:
            from .util.coordinate import Transformation
            t = transform.apply_transformation(Transformation.translation(c.get_length(), 0.0, 0.0))
            shapes.append(_tube(t, c.get_aft_shoulder_length(), c.get_aft_shoulder_radius()))
    return shapes


def _fin_side(c: FinSet, transform) -> list[list[list[float]]]:
    """FinSetShapes.getShapesSide: the fin outline (and tab) through transform * cant."""
    t = transform.apply_transformation(c.get_cant_rotation())
    out = []
    fin = [t.transform(p) for p in c.get_fin_points_with_root()]
    out.append([[p.x, p.y] for p in fin])
    tab = c.get_tab_points_with_root()
    if tab:
        out.append([[q.x, q.y] for q in (t.transform(p) for p in tab)])
    return out


def _mass_object_side(c: MassObject, transform) -> list[list[float]]:
    rd, ra = c.get_radial_position(), c.get_radial_direction()
    p = transform.transform(Coordinate(0.0, rd * math.cos(ra), rd * math.sin(ra)))
    r = c.get_radius()
    return _rect(p.x, p.y - r, c.get_length(), 2 * r)


def _rail_button_side(c: RailButton, transform) -> list[list[float]]:
    loc = transform.transform(ZERO)
    unit = transform.transform(Coordinate(0.0, 1.0, 0.0))
    view_rot = -math.atan2(unit.y - loc.y, unit.z - loc.z) + math.pi / 2
    cosr = math.cos(c.get_angle_offset() + view_rot)
    r = c.get_outer_diameter() / 2
    h = c.get_total_height() * cosr
    return _rect(loc.x - r, min(loc.y, loc.y + h), 2 * r, abs(h))


def side_figure(rocket, config=None) -> dict:
    """SCHEMA Figure for a configuration (default: the selected one)."""
    config = config or rocket.get_selected_configuration()
    shapes: list[dict] = []

    def add(c, kind: str, pts) -> None:
        shapes.append({"id": c.id, "kind": kind, "points": pts, "closed": True})

    for comp, contexts in config.get_active_instances().items():
        for ctx in contexts:
            t = ctx.transform
            if isinstance(comp, SymmetricComponent):
                for s in _symmetric_side(comp, t):
                    add(comp, "body", s)
            elif isinstance(comp, FinSet):
                for s in _fin_side(comp, t):
                    add(comp, "fin", s)
            elif isinstance(comp, TubeFinSet):
                r = comp.get_outer_radius()
                loc = t.transform(Coordinate(0.0, r, 0.0))
                add(comp, "fin", _rect(loc.x, loc.y - r, comp.get_length(), 2 * r))
            elif isinstance(comp, LaunchLug):
                add(comp, "body", _tube(t, comp.get_length(), comp.get_outer_radius()))
            elif isinstance(comp, RailButton):
                add(comp, "body", _rail_button_side(comp, t))
            elif isinstance(comp, RingComponent):
                orad, irad = comp.get_outer_radius(), comp.get_inner_radius()
                add(comp, "internal", _tube(t, comp.get_length(), orad))
                if orad - irad >= 0.0012 and irad > 0:
                    add(comp, "internal", _tube(t, comp.get_length(), irad))
            elif isinstance(comp, RecoveryDevice):
                add(comp, "recovery", _mass_object_side(comp, t))
            elif isinstance(comp, MassObject):
                add(comp, "internal", _mass_object_side(comp, t))

    # motors (RocketFigure.paintComponent): one per mount location
    for mc in config.get_active_motors():
        mount, motor = mc.get_mount(), mc.get_motor()
        r = motor.get_diameter() / 2
        mx = mc.get_x()
        for loc in mount.get_component_locations():
            shapes.append({"id": mount.id, "kind": "motor", "points": _rect(loc.x + mx, loc.y - r, motor.get_length(), 2 * r),
                           "closed": True, "motor": motor.get_designation()})

    xs = [p[0] for s in shapes for p in s["points"]]
    ys = [p[1] for s in shapes for p in s["points"]]
    bounds = ({"xmin": min(xs), "xmax": max(xs), "ymin": min(ys), "ymax": max(ys)} if xs
              else {"xmin": 0.0, "xmax": 0.0, "ymin": 0.0, "ymax": 0.0})
    return {"bounds": bounds, "shapes": shapes}
