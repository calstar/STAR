"""Layer X phase 6: the burn flown, and the flight's acceleration fed back into it.

Checked by hand or by direction, never against a stored answer:

* the drawing is the feed system: flying adds no geometry to it. A line's head in flight is its
  elevation_change as drawn or restated; a line with none carries none, and the preflight says so;
* the proper acceleration read off the flight is thrust over mass at liftoff, F/m;
* flown with the fuel line falling further than the LOX line, the fuel injector inlet gains more
  than LOX, so the burn runs fuel-richer than on the pad. A burn that ignored the acceleration
  would show none of it;
* off by default: a run that does not ask to fly is the phase 3 run.
"""

from __future__ import annotations

import math
from pathlib import Path

import pytest

pytest.importorskip("feedtwin", reason="lib/feedtwin is not installed")

from engine.layerx import DrawingStore, LayerXSettings, prepare, run_prepared  # noqa: E402
from engine.layerx import flight as flt  # noqa: E402
from engine.layerx.measurements import Override  # noqa: E402
from engine.layerx.sources import shipped_drawings_dir  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "ethalox_6500N_doublet_cad_2026-09-28.yaml"
GN2 = "copv_study_gn2"
# The GN2 drawing is a nitrogen-over-LOX hot fire, refused since 2026-10-03 unless acknowledged
# (engine/layerx/prepare.py gn2_on_lox); these tests study its burn, so their settings acknowledge it.
pytestmark = pytest.mark.skipif(not (shipped_drawings_dir() / f"{GN2}.json").is_file(),
                                reason="feed-twin's shipped drawings are not next to this checkout")
G0 = 9.80665


@pytest.fixture(scope="module")
def config():
    return load_config(str(FIXTURE))


@pytest.fixture(scope="module")
def drawing():
    return {d.name: d for d in DrawingStore(None).list()}[GN2]


def _line_head(prep, edge_id: str) -> float:
    branch = prep.model.built.network.branches[edge_id]
    return float(branch.component.p.get("elevation_change", 0.0))


def test_off_by_default_no_line_heads(config, drawing):
    prep = prepare(config, None, drawing, LayerXSettings(drawing_id=drawing.id, ack_gn2_condensation=True))
    assert not prep.vehicle_lines and not any(o["parameter"] == "elevation_change" for o in prep.overrides)
    assert _line_head(prep, "l_fu2") == 0.0 and _line_head(prep, "l_ox2") == 0.0


def test_flying_adds_no_geometry_to_the_drawing(config, drawing):
    """The stand drawing states no line heights: flown, its lines stay as drawn (no head, no
    length changed) and the preflight names the gap instead of guessing it from the config."""
    pad = prepare(config, None, drawing, LayerXSettings(drawing_id=drawing.id, ack_gn2_condensation=True))
    prep = prepare(config, None, drawing, LayerXSettings(drawing_id=drawing.id, ack_gn2_condensation=True, flight=True))
    assert prep.ok
    assert not any(o.get("origin") == "vehicle" for o in prep.overrides)
    for edge in ("l_fu1", "l_fu2", "l_ox1", "l_ox2"):
        assert _line_head(prep, edge) == 0.0
        assert prep.model.built.network.branches[edge].component.p.get("length") == \
            pad.model.built.network.branches[edge].component.p.get("length")
    rows = {r["side"]: r for r in prep.vehicle_lines}
    assert rows["fuel"]["lines"] == ["l_fu1", "l_fu2"] and rows["oxidiser"]["lines"] == ["l_ox1", "l_ox2"]
    assert rows["fuel"]["length_m"] == pytest.approx(0.9144 + 0.05)   # 36 in + the valve outlet, as drawn
    assert {r["used"] for r in rows.values()} == {"none"}
    check = next(c for c in prep.checks if c.key == "vehicle_lines")
    assert check.status == "warn" and "no height" in check.detail


def _with_heights(drawing, heights):
    import copy
    from dataclasses import replace

    payload = copy.deepcopy(drawing.payload)
    for edge_id, value in heights.items():
        edge = next(e for e in payload["edges"] if e["id"] == edge_id)
        edge.setdefault("data", {}).setdefault("params", {})["elevation_change"] = {
            "value": value, "unit": "m", "source": "measured", "reference": "test"}
    return replace(drawing, payload=payload)


def test_a_drawn_or_restated_height_is_the_head(config, drawing):
    mine = Override(target="edge:l_fu1", parameter="elevation_change", value=-0.8, unit="m",
                    source="tape measure on the vehicle, 2026-10-02")
    prep = prepare(config, None, drawing, LayerXSettings(drawing_id=drawing.id, ack_gn2_condensation=True, flight=True), [mine])
    rows = {r["side"]: r for r in prep.vehicle_lines}
    assert rows["fuel"]["used"] == "restated" and rows["fuel"]["drop_m"] == pytest.approx(0.8)
    assert rows["oxidiser"]["used"] == "none"
    assert _line_head(prep, "l_fu1") == pytest.approx(-0.8)

    prep = prepare(config, None, _with_heights(drawing, {"l_ox1": -0.07}),
                   LayerXSettings(drawing_id=drawing.id, ack_gn2_condensation=True, flight=True))
    rows = {r["side"]: r for r in prep.vehicle_lines}
    assert rows["oxidiser"]["used"] == "drawing" and rows["oxidiser"]["drop_m"] == pytest.approx(0.07)
    assert _line_head(prep, "l_ox1") == pytest.approx(-0.07)


def test_a_line_that_falls_further_than_it_is_long_is_flagged(config, drawing):
    prep = prepare(config, None, _with_heights(drawing, {"l_fu2": -1.0}),
                   LayerXSettings(drawing_id=drawing.id, ack_gn2_condensation=True, flight=True))
    rows = {r["side"]: r for r in prep.vehicle_lines}
    assert rows["fuel"]["too_steep"] == ["l_fu2"]
    check = next(c for c in prep.checks if c.key == "vehicle_lines")
    assert check.status == "warn" and "l_fu2 falls further than it is drawn long" in check.detail


def test_the_acceleration_at_liftoff_is_thrust_over_mass(config):
    """A flat 6.5 kN, 3 s burn. At the first instant the vehicle has not moved and drag is zero,
    so the proper acceleration along the axis is F/m exactly; it then grows as mass burns off."""
    n = 61
    t = [3.0 * k / (n - 1) for k in range(n)]
    payload = {"data": {"time": t, "thrust_kN": [6.5] * n, "mdot_O_kg_s": [1.8] * n, "mdot_F_kg_s": [1.2] * n}}
    out = flt.fly(config, payload, {"oxidiser": 6.0, "fuel": 4.0}, 94_070.0)
    assert out["ok"], out.get("error")
    # Flown at the site, the thrust reference is the site's ambient, so the first instant is 6.5 kN.
    assert out["liftoff_accel_g"] * G0 == pytest.approx(6500.0 / out["liftoff_mass_kg"], rel=2e-3)
    a = out["schedule"]["accel_m_s2"]
    assert len(a) == n and out["schedule"]["t"] == t
    assert a[n // 2] > a[1] and out["max_accel_g"] * G0 >= a[n // 2]
    assert out["apogee_agl_m"] > 1000.0


def test_change_between_histories():
    old = {"t": [0.0, 1.0, 2.0], "accel_m_s2": [80.0, 85.0, 90.0]}
    assert flt.schedule_change(None, old) == math.inf
    assert flt.schedule_change(old, old) == 0.0
    new = {"t": [0.0, 1.0, 2.0], "accel_m_s2": [80.0, 85.9, 90.0]}
    assert flt.schedule_change(old, new) == pytest.approx(0.9 / 85.9)
    # The last sample (the depletion instant) does not count.
    tail = {"t": [0.0, 1.0, 2.0], "accel_m_s2": [80.0, 85.0, 70.0]}
    assert flt.schedule_change(old, tail) == 0.0


def test_flown_the_fuel_side_gains_the_head(config, drawing):
    """The whole loop, on drawn heights: the fuel line falls 0.9 m, the LOX line 0.07 m (each
    within its drawn length). Under ~9 g the fuel inlet gains far more than LOX, so the burn runs
    fuel-rich of the pad, and the loop settles."""
    drawn = _with_heights(drawing, {"l_fu1": -0.9, "l_ox1": -0.07})
    prep = prepare(config, None, drawn, LayerXSettings(drawing_id=drawing.id, ack_gn2_condensation=True, flight=True))
    res = run_prepared(prep, config=config)
    f = res["flight"]
    assert f["ok"] and res["converged"]
    assert res["passes"][-1]["accel_inline"] and not res["passes"][0].get("accel_inline")
    pad, air = f["pad"], f["in_flight"]
    gain_fuel = air["fuel_manifold_mean_psia"] - pad["fuel_manifold_mean_psia"]
    gain_ox = air["ox_manifold_mean_psia"] - pad["ox_manifold_mean_psia"]
    assert gain_fuel > 5.0 and gain_fuel > 2.0 * gain_ox
    assert air["of_mean"] < pad["of_mean"] - 0.01
    assert 7.0 < f["liftoff_accel_g"] < f["max_accel_g"] < 11.0


def test_the_flight_follows_the_end_of_the_curve(config):
    """Cut a flat burn short by 10, 20, 30 ms: every cut is impulse lost, so every cut is apogee
    lost, by about the same amount each time. Before ui/flight_sim.py sampled an untruncated
    curve itself, RocketPy re-sampled it at 50 points; the apogee held still across these cuts
    and then fell in one step."""
    n = 61
    apogees = []
    for cut in (0.0, 0.01, 0.02, 0.03):
        t = [3.0 * k / (n - 1) for k in range(n)]
        t[-1] -= cut
        payload = {"data": {"time": t, "thrust_kN": [6.5] * n, "mdot_O_kg_s": [1.8] * n, "mdot_F_kg_s": [1.2] * n}}
        out = flt.fly(config, payload, {"oxidiser": 6.0, "fuel": 4.0}, 94_070.0)
        assert out["ok"], out.get("error")
        apogees.append(out["apogee_agl_m"])
    steps = [a - b for a, b in zip(apogees, apogees[1:])]
    assert all(s > 0.5 for s in steps), apogees
    assert max(steps) < 2.0 * min(steps), apogees
