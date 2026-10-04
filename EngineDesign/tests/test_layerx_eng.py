"""A Layer X burn exported as a RASP .eng thrust curve for OpenRocket (engine/layerx/eng.py).

Expected values are independent of the exporter:
  * the impulse of a step-held curve is the sum of thrust x step, by hand;
  * the 6.8 kN engine's diameter is its drawn stack, 5.000 in bore + 2 x (0.5 in ablative + 0.25 in
    steel) = 6.5 in = 165.1 mm; its length is the face-to-throat of the chamber plus a Rao 80 % bell,
    recomputed here from A_t, L*, the bore and epsilon.
"""
import math
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.layerx.eng import EDGE_S, check, motor_header, to_eng  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DT = 0.02
N = 175  # 3.5 s


def _result(thrust=lambda k: 6800.0 - 2.0 * k, motor=True):
    # The hand-off shape: a sample at Fire carrying the first step, then one per step end.
    f = [thrust(0)] + [thrust(k) for k in range(N)]
    t = [0.0] + [DT * (k + 1) for k in range(N)]
    r = {
        "timeseries": {"data": {"time": t, "thrust_kN": [v * 1e-3 for v in f]},
                       "summary": {"lox_propellant_kg": 6.35, "fuel_propellant_kg": 4.40}},
        "provenance": {"drawing": {"name": "stand"}, "settings": {}, "derived": {"target_lockup_psia": 578.0}},
    }
    if motor:
        r["motor"] = {"diameter_mm": 165.1, "length_mm": 309.9, "dry_kg": 14.54, "basis": {}}
    return r, sum(thrust(k) * DT for k in range(N))


def test_the_file_reads_back_as_the_burn():
    r, impulse = _result()
    eng = check(to_eng(r, run_id="abc"))
    assert eng["increasing"]
    assert eng["time"][0] == 0.0 and eng["thrust"][0] == 0.0       # OpenRocket's start
    assert eng["thrust"][-1] == 0.0                                # and its required end
    assert eng["time"][1] == pytest.approx(EDGE_S)
    assert eng["time"][-2] == pytest.approx(N * DT) and eng["time"][-1] == pytest.approx(N * DT + EDGE_S)
    assert eng["impulse"] == pytest.approx(impulse, rel=2e-4)
    # the ramps in and out cancel to half an edge of (last - first) thrust
    t, f = r["timeseries"]["data"]["time"], [v * 1e3 for v in r["timeseries"]["data"]["thrust_kN"]]
    curve = sum(0.5 * (f[i] + f[i + 1]) * (t[i + 1] - t[i]) for i in range(len(t) - 1))
    assert abs(eng["impulse"] - curve) < 0.5
    assert eng["delays"] == "P"
    assert eng["propellant_kg"] == pytest.approx(10.75)
    assert eng["total_kg"] == pytest.approx(10.75 + 14.54)
    assert (eng["diameter_mm"], eng["length_mm"]) == (165.1, 309.9)
    assert eng["name"].startswith("STAR-") and " " not in eng["name"]


def test_given_dimensions_override_the_run():
    r, _ = _result()
    eng = check(to_eng(r, diameter_mm=152.4, length_mm=500.0, dry_kg=0.0))
    assert (eng["diameter_mm"], eng["length_mm"]) == (152.4, 500.0)
    assert eng["total_kg"] == pytest.approx(eng["propellant_kg"])


def test_without_dimensions_it_refuses():
    r, _ = _result(motor=False)
    with pytest.raises(ValueError, match="did not record the engine diameter or length"):
        to_eng(r)


def test_the_header_is_the_drawn_engine():
    cfg = load_config(os.path.join(ROOT, "configs", "ethalox_6800N.yaml"))
    m = motor_header(cfg)
    # The 6.5 in chamber is wider than the 156.7 mm airframe: the file carries the body diameter,
    # which is what OpenRocket's motor mount accepts, and keeps the chamber's OD alongside.
    assert m["chamber_od_mm"] == pytest.approx(6.5 * 25.4, abs=0.05)
    assert m["diameter_mm"] == pytest.approx(2.0 * cfg.rocket.radius * 1e3, abs=0.05)
    cg = cfg.chamber_geometry
    R_t = math.sqrt(cg.A_throat / math.pi)
    theta = math.radians(cfg.design_requirements.layer1_contraction_half_angle_deg or 45.0)
    # chamber volume = cylinder + cone frustum to the entrance-arc tangency, then the arc to the throat
    r_c, r_tan = cg.chamber_diameter / 2.0, R_t * (1.0 + 1.5 * (1.0 - math.cos(theta)))
    L_cone = (r_c - r_tan) / math.tan(theta)
    V_cone = math.pi * L_cone / 3.0 * (r_c ** 2 + r_c * r_tan + r_tan ** 2)
    L_cyl = (cg.Lstar * cg.A_throat - V_cone) / (math.pi * r_c ** 2)
    bell = 0.8 * (math.sqrt(cg.expansion_ratio) - 1.0) * R_t / math.tan(math.radians(15.0))
    expected = (L_cyl + L_cone + 1.5 * R_t * math.sin(theta) + bell) * 1e3
    assert m["length_mm"] == pytest.approx(expected, rel=0.02)
    assert m["dry_kg"] == pytest.approx(cfg.rocket.engine_mass)
