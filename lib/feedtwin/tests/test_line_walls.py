"""Which lines get a wall: `Session._build_line_walls` against the drawing.

The wall model itself is held in ``test_wall.py``. This holds the build: a line
the drawing itemised into segments is solved as a ``segmented`` pipe whose bore
and length live in its segments, not in ``p`` (``_SUPERSEDED_BY_SEGMENTS``).
Reading only ``p["bore"]`` left every such line bare, which on the LE4 (3)
stand -- every line itemised -- made the default-on fitting heat a silent
no-op in Hotbench and Layer X alike.
"""

from __future__ import annotations

import math
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from feedtwin.comps.wall import fitting_metal
from feedtwin.pid import build_network, read_diagram
from feedtwin.session.core import Session

HERE = Path(__file__).resolve().parent
LE4 = HERE / "fixtures" / "le4_rocket_and_gse.json"

#: The LE4 (3) run from the regulator to the ox tank, as pid-designer saves it:
#: 727.08 mm of 0.43 in. bore tube, three sketched 45 degree bends of 29.92 mm
#: each, and the line-level numbers the sketch writes on save (length 0.817 m
#: end to end, fitting_count 3 counted off the segment list).
BORE_MM = 10.922
TUBE_MM = 727.08
BEND_MM = 29.923670025442775


def _measured(value: float, unit: str) -> dict[str, object]:
    return {"value": value, "unit": unit, "source": "measured"}


def _drawing(segmented: bool, **line: dict[str, object]) -> dict[str, object]:
    params: dict[str, object] = {
        "length": _measured((TUBE_MM + 3 * BEND_MM) / 1000.0, "m"),
        "bore": _measured(BORE_MM, "mm"),
        "fitting_count": _measured(3, "-"),
        **line,
    }
    data: dict[str, object] = {"lineType": "pipe", "params": params}
    if segmented:
        data["segments"] = [
            {
                "id": "seg_1",
                "method": "itemised",
                "bore": _measured(BORE_MM, "mm"),
                "length": _measured(TUBE_MM, "mm"),
                "lengthBasis": "tube",
                "fittings": [
                    {"id": f"fit_{i}", "kind": "bend", "count": 1, "lengthMm": BEND_MM}
                    for i in range(3)
                ],
            }
        ]
    return {
        "name": "one line",
        "nodes": [
            {
                "id": "n1",
                "type": "KBOTTLE",
                "data": {
                    "label": "K-01",
                    "fluidType": "nitrogen",
                    "params": {
                        "pressure": _measured(2000.0, "psi"),
                        "volume": _measured(50.0, "L"),
                    },
                },
            },
            {"id": "n2", "type": "VENT", "data": {"label": "V-01"}},
        ],
        "edges": [{"id": "L1", "source": "n1", "target": "n2", "data": data}],
    }


def _walls(doc: dict[str, object]) -> dict[str, Any]:
    """`_build_line_walls` on the drawing's network, nothing else of a session."""
    built = build_network(read_diagram(doc))
    stub: Any = SimpleNamespace(model=SimpleNamespace(built=built))
    Session._build_line_walls(stub)
    return dict(stub.walls)


def test_a_one_segment_line_gets_the_darcy_pipes_wall() -> None:
    """The same run, itemised or not, carries the same metal and the same area."""
    plain = _walls(_drawing(segmented=False))
    itemised = _walls(_drawing(segmented=True))
    assert set(plain) == {"L1"}
    assert set(itemised) == {"L1"}, "the itemised run was left bare"
    a, b = plain["L1"], itemised["L1"]
    assert b.bore == pytest.approx(a.bore, rel=1e-12)
    assert b.mass == pytest.approx(a.mass, rel=1e-12)
    # pid-designer rounds the line-level length to the millimetre; the segments
    # are exact, so the areas agree to that rounding and no further.
    assert b.area == pytest.approx(a.area, rel=1e-3)


def test_the_metal_is_the_counted_fittings_at_the_segment_bore() -> None:
    """Worked by hand: three 1/2 in.-class unions scaled to a 10.922 mm bore."""
    wall = _walls(_drawing(segmented=True))["L1"]
    bore = BORE_MM / 1000.0
    assert wall.mass == pytest.approx(fitting_metal(3, bore))
    assert wall.mass == pytest.approx(3 * 0.113 * (10.922 / 10.92) ** 2, rel=1e-9)
    run = (TUBE_MM + 3 * BEND_MM) / 1000.0
    assert wall.area == pytest.approx(math.pi * bore * run, rel=1e-12)


def test_a_drawn_wall_thickness_adds_the_tube_on_every_segment() -> None:
    thickness = _measured(0.89, "mm")
    plain = _walls(_drawing(segmented=False, wall_thickness=thickness))["L1"]
    itemised = _walls(_drawing(segmented=True, wall_thickness=thickness))["L1"]
    assert itemised.mass > fitting_metal(3, BORE_MM / 1000.0)
    assert itemised.mass == pytest.approx(plain.mass, rel=1e-3)


def test_an_itemised_run_with_no_bore_anywhere_stays_bare() -> None:
    doc = _drawing(segmented=True)
    edge: Any = doc["edges"]
    edge[0]["data"]["segments"][0].pop("bore")
    edge[0]["data"]["params"].pop("bore")
    assert _walls(doc) == {}


def test_the_le4_press_lines_get_their_walls() -> None:
    """The shipped LE4 drawing: every pressurant run is itemised."""
    import json

    built = build_network(read_diagram(json.loads(LE4.read_text()), name="LE4"))
    stub: Any = SimpleNamespace(model=SimpleNamespace(built=built))
    Session._build_line_walls(stub)
    for line in ("node_2-junc_49", "junc_49-junc_48", "node_38-node_36"):
        assert line in stub.walls, (line, sorted(stub.walls))
    # Drawn with no bore at all: nothing to size a wall on, so none.
    assert "node_15-node_38" not in stub.walls
