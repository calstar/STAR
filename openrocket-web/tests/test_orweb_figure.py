"""The side-view figure is the geometry the physics used."""

from __future__ import annotations

import math

import pytest

from _orweb_check import HERE
from orweb import build_rocket, read_ork, side_figure
from orweb.components import BodyTube, FinSet, SymmetricComponent, TubeFinSet
from orweb.util.coordinate import Coordinate

EXAMPLES = sorted((HERE / "rockets").glob("*.ork"))
VARIANTS = sorted((HERE / "variants" / "rockets").glob("*.ork"))


@pytest.fixture(scope="module", params=EXAMPLES + VARIANTS, ids=[p.stem for p in EXAMPLES + VARIANTS])
def fig(request):
    r = build_rocket(read_ork(request.param, keep_simulations=False))
    return r, side_figure(r)


def test_shapes_well_formed(fig):
    _, f = fig
    b = f["bounds"]
    assert f["shapes"]
    for s in f["shapes"]:
        assert s["kind"] in {"body", "fin", "internal", "recovery", "motor"}
        assert s["closed"] is True and len(s["points"]) >= 3
        for x, y in s["points"]:
            assert b["xmin"] <= x <= b["xmax"] and b["ymin"] <= y <= b["ymax"]


def test_one_outline_per_instance(fig):
    r, f = fig
    cfg = r.get_selected_configuration()
    count = {}
    for s in f["shapes"]:
        count[(s["id"], s["kind"])] = count.get((s["id"], s["kind"]), 0) + 1
    for c, ctxs in cfg.get_active_instances().items():
        if isinstance(c, (FinSet,)):
            expect = len(ctxs) * (2 if c.get_tab_points_with_root() else 1)
            assert count.get((c.id, "fin")) == expect
        elif isinstance(c, TubeFinSet):
            assert count.get((c.id, "fin")) == len(ctxs)
        elif isinstance(c, BodyTube):
            assert count.get((c.id, "body")) == len(ctxs)
    motors = sum(len(mc.get_mount().get_component_locations()) for mc in cfg.get_active_motors())
    assert sum(1 for s in f["shapes"] if s["kind"] == "motor") == motors


def test_body_outlines_are_the_radius(fig):
    r, f = fig
    cfg = r.get_selected_configuration()
    for c, ctxs in cfg.get_active_instances().items():
        if not isinstance(c, SymmetricComponent):
            continue
        for ctx in ctxs:
            loc = ctx.transform.transform(Coordinate())
            outline = next(s for s in f["shapes"] if s["id"] == c.id and s["kind"] == "body"
                           and min(p[0] for p in s["points"]) == pytest.approx(loc.x, abs=1e-6)
                           and abs(sum(p[1] for p in s["points"]) / len(s["points"]) - loc.y) < 1e-9)
            for x, y in outline["points"]:
                local = x - loc.x
                if isinstance(c, BodyTube):
                    assert abs(abs(y - loc.y) - c.get_outer_radius()) < 1e-12
                elif 0 < local < c.get_length():
                    assert abs(y - loc.y) == pytest.approx(c.get_radius(local), abs=1e-12)


def test_fin_tip_projects_by_roll_angle():
    r = build_rocket(read_ork(HERE / "rockets" / "A simple model rocket.ork", keep_simulations=False))
    f = side_figure(r)
    fins = next(c for c in r if isinstance(c, FinSet))
    tops = sorted(max(y for _, y in s["points"]) for s in f["shapes"] if s["id"] == fins.id)
    body_r = fins.get_body_radius()
    span = fins.get_span()
    # three fins at 0, 120, 240 degrees: the upright one reaches r + span, the others are below the axis
    assert tops[-1] == pytest.approx(body_r + span, abs=1e-12)
    lows = sorted(min(y for _, y in s["points"]) for s in f["shapes"] if s["id"] == fins.id)
    assert lows[0] == pytest.approx((body_r + span) * math.cos(2 * math.pi / 3), abs=1e-12)
