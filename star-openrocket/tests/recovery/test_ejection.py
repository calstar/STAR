"""Separation joints: shear pins, ejection charge, vent holes.

Expectations are hand calculations and outside calculators, not this code:
the mastersheets' black powder column (reference/mastersheets/, which came from
rocketrycalculator.com's BP estimator) and rocketrycalculator.com's vent port
result recorded in the Camelot sheet.
"""

import json
import math
import os

import pytest

from physics.atmosphere import Atmosphere
from physics.constants import IN_TO_M, LBF_TO_N
from physics.site import FAR_ELEV_M
from physics.ejection import (
    PIN_CATALOG,
    Joint,
    Settings,
    Vehicle,
    area,
    bp_mass,
    pins_required,
    size_joint,
    vent_hole,
)

PSI = LBF_TO_N / IN_TO_M ** 2
IN = IN_TO_M
LBF = LBF_TO_N


# --- black powder ----------------------------------------------------------


@pytest.mark.parametrize("length_in, psi, sheet_g", [
    (7.5, 8.0, 0.86),      # Camelot drogue, 8 psi
    (18.5, 15.0, 3.97),    # Camelot main, 15 psi
    (21.22, 10.0, 3.06),   # LE3 main, 10 psi
    (27.75, 25.0, 9.99),   # LE3 drogue, 25 psi
])
def test_black_powder_matches_the_mastersheets(length_in, psi, sheet_g):
    """6 in bay. Within 2.5%: the sheets' calculator rounds 454 g/lb."""
    V = area(6 * IN) * length_in * IN
    assert bp_mass(psi * PSI, V) * 1e3 == pytest.approx(sheet_g, rel=0.025)


def test_black_powder_by_hand():
    """6 x 7.5 in at 8 psi: 212.06 in^3 * 8 psi / (22.16 * 3307 ft-lbf/lbm)
    = 1696.5 in-lbf / 879 400 in-lbf/lbm = 1.929e-3 lbm = 0.875 g."""
    V = area(6 * IN) * 7.5 * IN
    assert bp_mass(8 * PSI, V) * 1e3 == pytest.approx(0.875, abs=0.002)


# --- vent holes ------------------------------------------------------------


def test_vent_hole_matches_rocketrycalculator():
    """The Camelot sheet records rocketrycalculator.com: 6 in x 9 in, 4 ports,
    12.76/64 in, drilled 13/64."""
    v = vent_hole(6 * IN, 9 * IN, 4)
    assert v.d / IN * 64 == pytest.approx(12.76, abs=0.01)
    assert v.d_64ths == 13


def test_vent_hole_is_not_the_mastersheet_formula():
    """The sheet's 0.004396 * D_cm * sqrt(L_cm / N) gave 0.156 cm for a
    5.83 x 9 in bay with 4 holes; the rule gives 0.49 cm (sqrt 10 apart)."""
    v = vent_hole(5.83 * IN, 9 * IN, 4)
    assert v.d * 100 == pytest.approx(0.492, abs=0.002)
    assert v.d * 100 / 0.1556 == pytest.approx(math.sqrt(10), rel=0.01)


# --- pin count -------------------------------------------------------------


def test_pins_round_up_not_to_nearest():
    """230 lbf on 75 lbf pins is 3.07 pins: 4 hold it, 3 do not."""
    assert pins_required(230 * LBF, 75 * LBF, 1.0) == 4


def test_exact_multiple_does_not_round_up_again():
    assert pins_required(150 * LBF, 75 * LBF, 2.0) == 4


def test_at_least_one_pin():
    assert pins_required(0.0, 75 * LBF, 2.0) == 1


# --- loads -----------------------------------------------------------------


def _joint(role="main", **kw):
    base = dict(name=role, role=role, bay_id=6 * IN, bay_length=20 * IN,
                m_forward=10.0)
    base.update(kw)
    return Joint(**base)


VEH = Vehicle(m_burnout=50.0, D_burnout=900.0, m_descending=40.0,
              p_pad=94000.0, p_apogee=30000.0)


def test_drag_separation_by_hand():
    """10 kg forward of a 50 kg vehicle with 900 N of drag: 180 N."""
    r = size_joint(_joint(), VEH, Settings(trapped_pressure=False,
                                           dual_separation=False))
    assert r.F_drag == pytest.approx(180.0)
    assert r.F_trapped == 0.0 and r.F_drogue == 0.0
    assert r.governing == "drag" and r.F_hold == pytest.approx(180.0)


def test_trapped_pressure_by_hand():
    r = size_joint(_joint(), VEH, Settings(dual_separation=False))
    assert r.F_trapped == pytest.approx((94000.0 - 30000.0) * area(6 * IN))
    assert r.governing == "trapped"


def test_drogue_opening_only_on_the_main_joint_with_dual_separation():
    s = Settings(trapped_pressure=False)
    main = size_joint(_joint("main"), VEH, s, F_drogue_open=2000.0)
    assert main.F_drogue == pytest.approx(10.0 * 2000.0 / 40.0)
    drogue = size_joint(_joint("drogue"), VEH, s, F_drogue_open=2000.0)
    assert drogue.F_drogue == 0.0
    single = size_joint(_joint("main"), VEH,
                        Settings(trapped_pressure=False, dual_separation=False),
                        F_drogue_open=2000.0)
    assert single.F_drogue == 0.0


def test_every_catalog_pin_is_sized():
    """One option per catalog pin, each holding the load at its weakest with
    the hold factor, and its charge shearing them at their strongest with the
    ejection factor. The grams follow from the pressure."""
    r = size_joint(_joint(), VEH, Settings())
    assert [o.key for o in r.options] == list(PIN_CATALOG)
    for o in r.options:
        pin = PIN_CATALOG[o.key]
        assert o.n_pins == pins_required(r.F_hold, pin.F_min, 2.0)
        assert o.n_pins * pin.F_min >= 2.0 * r.F_hold
        assert o.F_eject == pytest.approx(1.5 * o.n_pins * pin.F_max)
        assert o.m_bp == pytest.approx(bp_mass(o.P_eject, r.volume))


def test_weaker_pins_need_more_of_them():
    r = size_joint(_joint(), VEH, Settings())
    by = {o.key: o.n_pins for o in r.options}
    assert by["2-56"] > by["4-40"] > by["6-32"]


def test_inverted_pin_range_refused():
    from physics.ejection import PinSpec
    bad = PinSpec("x", "x", 500.0, 100.0, "test")
    with pytest.raises(ValueError):
        size_joint(_joint(), VEH, Settings(), pins=(bad,))


# --- API -------------------------------------------------------------------

pytest.importorskip("fastapi")
pytest.importorskip("httpx")
from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "fixtures", "worked_example.json")


def _request():
    with open(FIXTURE, encoding="utf-8") as fh:
        config = json.load(fh)
    joint = dict(bay_id=0.098, bay_length=0.3, m_forward=1.0)
    return {
        "config": config,
        "ejection": {
            "m_burnout": 6.0, "D_burnout": 60.0,
            "joints": [dict(joint, name="Drogue", role="drogue"),
                       dict(joint, name="Main", role="main")],
            "vent": {"bay_id": 0.098, "bay_length": 0.2, "n_holes": 3},
        },
    }


def test_api_sizes_both_joints_and_the_vent():
    with TestClient(app) as c:
        res = c.post("/api/ejection", json=_request())
    assert res.status_code == 200, res.text
    body = res.json()
    cond = body["conditions"]
    atm = Atmosphere(FAR_ELEV_M, 284.0554)
    assert cond["p_apogee"] == pytest.approx(atm.p(914.0))
    assert cond["drogue"]["device"] == "drogue"
    drogue, main = body["joints"]
    assert drogue["F_drogue"] == 0.0
    assert main["F_drogue"] == pytest.approx(
        1.0 * cond["drogue"]["F"] / cond["m_descending"])
    assert body["vent"]["d"] > 0
    assert [o["key"] for o in main["options"]] == list(PIN_CATALOG)


def test_api_refuses_unknown_fields():
    req = _request()
    req["ejection"]["bogus"] = 1
    with TestClient(app) as c:
        assert c.post("/api/ejection", json=req).status_code == 422


def test_pin_catalog_endpoint():
    with TestClient(app) as c:
        pins = c.get("/api/ejection/pins").json()
    assert {p["key"] for p in pins} == set(PIN_CATALOG)
    assert all(p["F_min"] < p["F_max"] and p["source"] for p in pins)


def test_api_warns_when_forward_mass_exceeds_the_vehicle():
    """15 lb forward of a main joint on a 12.5 lb descending vehicle is two
    different rockets, and the drogue load scales with their ratio."""
    req = _request()
    req["ejection"]["joints"][1]["m_forward"] = 7.0   # > 5.67 kg and > 6 kg
    with TestClient(app) as c:
        warnings = c.post("/api/ejection", json=req).json()["warnings"]
    assert any("exceeds the mass at burnout" in w for w in warnings)
    assert any("exceeds the descending mass" in w for w in warnings)
    req["ejection"]["joints"][1]["m_forward"] = 1.0
    with TestClient(app) as c:
        assert c.post("/api/ejection", json=req).json()["warnings"] == []
