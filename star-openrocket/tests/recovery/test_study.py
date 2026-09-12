"""The design study: physics/study.py and POST /api/study.

Two things are being pinned here. First the contract -- the shapes
`frontend/src/api/client.ts` builds against -- for the same reason
`test_api.py` exists: nothing else looks at field names.

Second, and more importantly, the *isolation* properties. A study mutates a
copy of the config per design point, and every bug this can have is a quiet
one: an axis that leaks onto the wrong device, a canopy swap that also moves
the packing parameters, a deploy altitude walked past apogee so the device
never fires and the point is reported as though it were the design asked for.
None of those show up as an error; they show up as a plausible wrong number.
"""

import json
import os
import pathlib

import pytest

from physics.schema import Config
from physics.study import MAX_RUNS, axis_values, run_count, run_points

pytest.importorskip("fastapi", reason="API tests need fastapi")
pytest.importorskip("httpx", reason="fastapi TestClient needs httpx")

from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "fixtures", "worked_example.json")
ROOT = pathlib.Path(__file__).resolve().parent.parent


def load_fixture():
    with open(FIXTURE, encoding="utf-8") as handle:
        return json.load(handle)


def with_study(*axes):
    body = load_fixture()
    body["study"] = list(axes)
    return body


def cfg(*axes):
    return Config.model_validate(with_study(*axes))


def client():
    return TestClient(app)


def linear(key, device=None, start=0.0, stop=1.0, points=2, **kw):
    return {"key": key, "device": device, "mode": "linear",
            "start": start, "stop": stop, "points": points, **kw}


def listed(key, values, device=None, **kw):
    return {"key": key, "device": device, "mode": "list",
            "values": values, **kw}


IRIS_48 = {"label": "Iris 48", "CdS": 2.489, "D0": 1.601, "m_c": 0.213, "j": 2}
IRIS_60 = {"label": "Iris 60", "CdS": 3.889, "D0": 2.002, "m_c": 0.298, "j": 2}


def canopies(*rows, device="main"):
    return {"key": "canopy", "device": device, "mode": "list",
            "canopies": list(rows)}


# --- the resolver ----------------------------------------------------------
#
# THE SHARED CASE TABLE. `frontend/src/lib/study.test.ts` asserts the same
# cases against `axisValues`, because the GUI shows the resolved grid and the
# run count before the backend is ever called -- so if the two resolvers
# disagree, the user is shown a study that is not the one computed.

LINEAR_CASES = [
    # (start, stop, points, expected)
    (0.0, 1.0, 2, [0.0, 1.0]),
    (800.0, 2000.0, 5, [800.0, 1100.0, 1400.0, 1700.0, 2000.0]),
    (5.0, 5.0, 3, [5.0, 5.0, 5.0]),
    (1.0, 2.0, 1, [1.0]),
    (2000.0, 800.0, 3, [2000.0, 1400.0, 800.0]),
]


@pytest.mark.parametrize("start,stop,points,expected", LINEAR_CASES)
def test_linear_includes_both_ends(start, stop, points, expected):
    """`points` is how many values you get, not how many gaps.

    A reader who asks for 800-2000 in 5 points and gets 1760 at the top has to
    work out why; there is no reading of "5 points from 800 to 2000" under
    which the answer excludes 2000.
    """
    axis = cfg(linear("m", start=start, stop=stop, points=points)).study[0]
    got = axis_values(axis)
    assert len(got) == points
    assert got == pytest.approx(expected)


def test_linear_top_is_the_stop_verbatim():
    """Not start + (n-1)*step, which differs in the last digit.

    A sweep whose top reads 1999.9999999999998 in the table looks like a bug in
    the physics rather than in IEEE 754.
    """
    axis = cfg(linear("m", start=1.0, stop=2.0, points=7)).study[0]
    assert axis_values(axis)[-1] == 2.0


def test_list_is_taken_verbatim():
    axis = cfg(listed("n", [6.0, 8.0, 12.0], device="main")).study[0]
    assert axis_values(axis) == [6.0, 8.0, 12.0]


def test_run_count_is_the_product():
    c = cfg(listed("n", [6.0, 8.0], device="main"),
            linear("m", start=5.0, stop=6.0, points=3))
    assert run_count(c) == 6
    assert len(run_points(c)) == 6


def test_disabled_axis_costs_nothing():
    """Off is not the same as pinned: the parameter keeps whatever the config
    already carries, and contributes a factor of one rather than of zero."""
    c = cfg(listed("n", [6.0, 8.0], device="main"),
            listed("Cx", [1.2, 1.8], device="main", enabled=False))
    assert run_count(c) == 2


# --- the cap ---------------------------------------------------------------


def test_exactly_the_limit_is_accepted():
    body = with_study(linear("m", start=5.0, stop=7.0, points=MAX_RUNS))
    res = client().post("/api/study", json=body)
    assert res.status_code == 200
    assert res.json()["runs"] == MAX_RUNS


def test_one_over_the_limit_is_rejected():
    """A cap, not a truncation. Silently running the first 20 of 21 answers a
    question nobody asked and looks exactly like the one they did."""
    body = with_study(linear("m", start=5.0, stop=7.0, points=MAX_RUNS + 1))
    res = client().post("/api/study", json=body)
    assert res.status_code == 422
    assert "over the limit" in json.dumps(res.json())


def test_the_cap_counts_the_product_not_the_longest_axis():
    body = with_study(listed("n", [6.0, 8.0, 10.0, 12.0, 14.0], device="main"),
                      listed("Cx", [1.2, 1.4, 1.6, 1.8, 2.0], device="main"))
    res = client().post("/api/study", json=body)
    assert res.status_code == 422  # 25, not 5


# --- rejections, each with a reason ----------------------------------------


@pytest.mark.parametrize("axis,needle", [
    (listed("CdS", [1.0, 2.0], device="nope"), "does not exist"),
    (listed("m", [5.0, 6.0], device="main"), "takes no device"),
    (listed("CdS", [1.0, 2.0]), "name which device"),
    ({"key": "canopy", "device": "main", "mode": "linear",
      "start": 1.0, "stop": 2.0, "points": 3}, "only be swept as a list"),
    ({"key": "m", "mode": "linear", "start": 5.0}, "linear sweep needs"),
    (listed("m", []), "at least one value"),
    (canopies(), "at least one canopy"),
    ({"key": "m", "mode": "list", "values": [5.0], "start": 1.0},
     "cannot also carry start"),
    ({"key": "m", "mode": "linear", "start": 1.0, "stop": 2.0, "points": 3,
      "values": [5.0]}, "cannot also carry a value list"),
])
def test_bad_axes_are_rejected_by_name(axis, needle):
    res = client().post("/api/study", json=with_study(axis))
    assert res.status_code == 422
    assert needle in json.dumps(res.json())


def test_duplicate_axis_is_rejected():
    """Two grids on the same target is ambiguous, not harmless -- whichever the
    resolver applied last would silently win."""
    res = client().post("/api/study", json=with_study(
        listed("CdS", [1.0, 2.0], device="main"),
        listed("CdS", [3.0, 4.0], device="main")))
    assert res.status_code == 422
    assert "duplicate study axis" in json.dumps(res.json())


def test_same_key_on_two_devices_is_fine():
    """It is the (key, device) PAIR that must be unique. Sweeping both canopies'
    fill constants independently is a legitimate two-dimensional study."""
    res = client().post("/api/study", json=with_study(
        listed("n", [6.0, 12.0], device="main"),
        listed("n", [6.0, 12.0], device="drogue")))
    assert res.status_code == 200
    assert res.json()["runs"] == 4


def test_trigger_swept_above_apogee_is_a_422_naming_the_point():
    """The re-validation step earning its place.

    Without it this study would run: the main's trigger sits above apogee, so
    it never fires on a descending crossing, and the point would come back as a
    descent under drogue alone -- reported as though it were the design asked
    for.
    """
    res = client().post("/api/study", json=with_study(
        linear("trigger", device="main", start=152.0, stop=2000.0, points=3)))
    assert res.status_code == 422
    detail = json.dumps(res.json())
    assert "above apogee" in detail
    assert "trigger=1076.0" in detail  # the offending point, named


# --- isolation: what a study must NOT change -------------------------------


def test_a_per_device_axis_leaves_the_other_device_alone():
    c = cfg(listed("CdS", [1.0, 2.0], device="main"))
    for _, result in run_points(c):
        drogue = next(d for d in result.run.devices if d.name == "drogue")
        assert drogue.CdS == 0.15
        assert drogue.n == 8.0


def test_a_canopy_swap_replaces_four_fields_and_no_others():
    """The vendor supplies drag area, diameter, mass and cloth type. It does
    NOT supply the filling constant, the opening coefficient, the delay, the
    separation velocity or the trigger -- those are how you deploy it and how
    it was packed, and a swap that quietly reset them would make two canopies
    incomparable for reasons nothing on screen would explain."""
    c = cfg(canopies(IRIS_48, IRIS_60))
    seen = []
    for values, result in run_points(c):
        main = next(d for d in result.run.devices if d.name == "main")
        seen.append((values["canopy"], main.CdS, main.D0, main.m_c, main.j))
        # Untouched, from the fixture.
        assert main.n == 8.0
        assert main.Cx == 1.8
        assert main.delay == 0.0
        assert main.v_rel == 10.0
        assert main.k_eff == 17400.0
        assert main.trigger.value == 152.0
    assert seen == [
        ("Iris 48", 2.489, 1.601, 0.213, 2),
        ("Iris 60", 3.889, 2.002, 0.298, 2),
    ]


def test_the_posted_config_is_never_mutated():
    """`run_points` copies per point. If it did not, point 2 would inherit
    point 1's canopy and every result after the first would be wrong in a way
    that still looked like a plausible descent."""
    c = cfg(canopies(IRIS_48, IRIS_60))
    run_points(c)
    main = next(d for d in c.devices if d.name == "main")
    assert main.CdS == 2.489


def test_a_bigger_canopy_descends_slower_and_lands_softer():
    """The sanity check the whole tab exists for. If this ever inverts, the
    axis is being applied to the wrong object."""
    c = cfg(canopies(IRIS_48, IRIS_60))
    (_, small), (_, big) = run_points(c)
    assert big.run.t_ground > small.run.t_ground
    assert abs(big.run.v_impact) < abs(small.run.v_impact)


# --- the wire contract -----------------------------------------------------


def test_response_shape():
    res = client().post("/api/study", json=with_study(canopies(IRIS_48, IRIS_60)))
    assert res.status_code == 200
    body = res.json()
    assert set(body) >= {"runs", "max_runs", "axes", "nominal", "points",
                         "warnings"}
    assert body["runs"] == 2
    assert body["max_runs"] == MAX_RUNS
    assert body["axes"] == [{"key": "canopy", "device": "main", "mode": "list",
                             "labels": ["Iris 48", "Iris 60"],
                             # The fixture's main IS the Iris 48, so the
                             # reference row can say so.
                             "current": "Iris 48"}]

    # The four Recovery-summary figures, on every point AND on the reference.
    four = {"descent_time", "impact_velocity", "impact_ke", "F_peak"}
    assert four <= set(body["nominal"])
    for point in body["points"]:
        assert four <= set(point)
        assert set(point["values"]) == {"canopy"}


def test_each_axis_reports_where_the_current_config_sits():
    """The reference row says what today's design is on every axis, so a blank
    cell never has to be read as "no value" when it means "not compared"."""
    body = client().post("/api/study", json=with_study(
        linear("trigger", device="main", start=152.0, stop=457.0, points=3),
        linear("m", start=5.0, stop=6.0, points=2),
    )).json()
    current = {a["key"]: a["current"] for a in body["axes"]}
    assert current == {"trigger": 152.0, "m": 5.67}


def test_a_fitted_canopy_among_the_compared_ones_is_named():
    """The common case: you are comparing upgrades against what is on the
    vehicle now, and the table should show the correspondence rather than
    leaving the reader to match drag areas by eye."""
    body = client().post("/api/study",
                         json=with_study(canopies(IRIS_48, IRIS_60))).json()
    assert body["axes"][0]["current"] == "Iris 48"


def test_a_fitted_canopy_that_is_not_compared_is_null_not_a_guess():
    """None means "not among these", which is different from unknown -- the
    GUI says "not compared" rather than showing an empty cell."""
    other = {"label": "Classic 24", "CdS": 0.437, "D0": 0.61, "m_c": 0.057,
             "j": 2}
    body = client().post("/api/study",
                         json=with_study(canopies(IRIS_60, other))).json()
    assert body["axes"][0]["current"] is None


def test_nominal_is_the_unstudied_config():
    """It is generally NOT one of the points -- the fitted canopy need not be
    among the ones being compared -- which is what makes it the reference."""
    body = client().post("/api/study",
                         json=with_study(canopies(IRIS_60))).json()
    simulated = client().post("/api/simulate", json=load_fixture()).json()
    nominal = simulated["cases"]["nominal"]
    assert body["nominal"]["descent_time"] == pytest.approx(
        nominal["descent_time"])
    assert body["nominal"]["F_peak"] == pytest.approx(nominal["F_peak_max"])
    # And the single studied point is a different vehicle.
    assert body["points"][0]["descent_time"] != pytest.approx(
        nominal["descent_time"])


def test_F_peak_is_unfactored():
    """Matching Recovery's "Max load (F_peak)" and the Corners cards. F_design
    is this times the safety factor, and the two must never be swapped."""
    body = client().post("/api/study",
                         json=with_study(canopies(IRIS_48))).json()
    point = body["points"][0]
    assert point["F_design"] == pytest.approx(point["F_peak"] * 1.5)


def test_trajectories_are_opt_in():
    body = with_study(canopies(IRIS_48, IRIS_60))
    off = client().post("/api/study", json=body).json()
    assert "trajectory" not in off["points"][0]
    assert "trajectory" not in off["nominal"]

    on = client().post("/api/study?trajectories=1", json=body).json()
    assert len(on["points"][0]["trajectory"]) > 50
    assert len(on["nominal"]["trajectory"]) > 50
    # Identical scalars either way -- the flag adds data, it does not change
    # the computation.
    assert on["points"][0]["descent_time"] == pytest.approx(
        off["points"][0]["descent_time"])


def test_trajectory_keeps_the_tension_peak():
    """The sweep grid is coarse (10 ms / 250 ms against simulate's 2/100), so
    the guarantee worth testing is that decimation never eats the opening
    spike -- `resample_for_wire` force-keeps argmax(F_T)."""
    from physics.study import run_points as points_of

    body = with_study(canopies(IRIS_48))
    wire = client().post("/api/study?trajectories=1", json=body).json()
    on_wire = max(s["F_T"] for s in wire["points"][0]["trajectory"])
    _, result = points_of(cfg(canopies(IRIS_48)))[0]
    assert on_wire == pytest.approx(float(result.run.traj.F_T.max()))


def test_ids_are_stable_across_identical_requests():
    body = with_study(listed("n", [6.0, 8.0, 12.0], device="main"))
    a = client().post("/api/study", json=body).json()
    b = client().post("/api/study", json=body).json()
    assert [p["id"] for p in a["points"]] == ["p0", "p1", "p2"]
    assert [p["values"] for p in a["points"]] == [p["values"] for p in b["points"]]


# --- the other endpoints are unaffected ------------------------------------


def test_a_study_on_the_body_does_not_disturb_simulate_or_sweep():
    """All three take one body (§11.7). A study rides along on /api/simulate
    and must be ignored there rather than rejected or acted on."""
    plain = load_fixture()
    with_axes = with_study(canopies(IRIS_48, IRIS_60))

    for route in ("/api/simulate", "/api/sweep"):
        a = client().post(route, json=plain)
        b = client().post(route, json=with_axes)
        assert a.status_code == b.status_code == 200

    a = client().post("/api/simulate", json=plain).json()
    b = client().post("/api/simulate", json=with_axes).json()
    assert (a["cases"]["nominal"]["F_peak_max"]
            == pytest.approx(b["cases"]["nominal"]["F_peak_max"]))


def test_no_study_is_a_single_run():
    """A config with no study is not an error -- it is one design, the one you
    have. That keeps the endpoint callable before any axis is added."""
    res = client().post("/api/study", json=load_fixture())
    assert res.status_code == 200
    assert res.json()["runs"] == 1
    assert res.json()["points"][0]["values"] == {}


# --- the site axes ---------------------------------------------------------
#
# `pad_source` and `pad_month` are the third scope, added after the vehicle and
# device ones. They are the only axes that move the *atmosphere* rather than
# the vehicle, which is the property worth pinning: `run_points` is handed an
# `Atmosphere` built from the config as posted, and a site axis has to rebuild
# it per point or every month of the year silently flies through January air.

ISA_PAD = {"label": "ISA standard column",
           "T_pad": None, "p_pad": None, "lapse": None}
JAN_PAD = {"label": "KNID Jan normal",
           "T_pad": 281.0, "p_pad": 92100.0, "lapse": -0.0071}
JUL_PAD = {"label": "KNID Jul normal",
           "T_pad": 308.0, "p_pad": 91500.0, "lapse": -0.0079}


def pads(*rows, key="pad_source"):
    return {"key": key, "device": None, "mode": "list", "pads": list(rows)}


def test_a_pad_axis_rebuilds_the_atmosphere_per_point():
    """The whole point of the axis. Hot July air is thinner, so the same
    vehicle under the same canopies descends FASTER and lands HARDER -- if the
    two points came out equal, the caller's atmosphere had been reused."""
    points = run_points(cfg(pads(JAN_PAD, JUL_PAD)))
    (_, jan), (_, jul) = points
    assert jul.run.t_ground < jan.run.t_ground
    assert jul.run.v_impact > jan.run.v_impact
    # And by a margin worth reporting, not a rounding difference.
    assert jul.run.v_impact / jan.run.v_impact > 1.02


def test_a_pad_point_sets_all_three_fields_including_the_nulls():
    """Copying only the non-null fields would leave a monthly normal's measured
    lapse rate in place under an ISA point -- an atmosphere that never existed,
    and one nothing downstream could detect."""
    from physics.study import _apply

    c = cfg(pads(JUL_PAD, ISA_PAD))
    mutated = c.model_copy(deep=True)
    _apply(mutated, c.study[0], c.study[0].pads[0])
    assert (mutated.site.T_pad, mutated.site.lapse) == (308.0, -0.0079)
    _apply(mutated, c.study[0], c.study[0].pads[1])
    assert (mutated.site.T_pad, mutated.site.p_pad, mutated.site.lapse) \
        == (None, None, None)


def test_a_pad_axis_takes_no_device():
    """There is one atmosphere over the whole flight, so "which device" is not
    a question a site axis can answer."""
    res = client().post("/api/study",
                        json=with_study(dict(pads(ISA_PAD), device="main")))
    assert res.status_code == 422
    assert "takes no device" in json.dumps(res.json())


def test_the_two_pad_axes_cannot_be_crossed():
    """Different keys, same three fields. `_check_study`'s duplicate test is
    per (key, device) so it does not catch this: crossing them is not a grid,
    it is whichever axis the resolver applied last."""
    res = client().post("/api/study", json=with_study(
        pads(ISA_PAD, JAN_PAD),
        pads(JAN_PAD, JUL_PAD, key="pad_month")))
    assert res.status_code == 422
    assert "cannot be crossed" in json.dumps(res.json())


def test_a_pad_axis_cannot_be_a_linear_grid():
    """There is no month halfway between March and April, and no pad state
    halfway between a METAR and the standard column."""
    res = client().post("/api/study", json=with_study(
        {"key": "pad_month", "device": None, "mode": "linear",
         "start": 1.0, "stop": 12.0, "points": 12}))
    assert res.status_code == 422
    assert "only be swept as a list" in json.dumps(res.json())


def test_a_pad_axis_carries_pads_not_values():
    res = client().post("/api/study",
                        json=with_study(dict(pads(ISA_PAD), values=[1.0])))
    assert res.status_code == 422
    assert "not values" in json.dumps(res.json())


def test_an_empty_pad_axis_is_rejected():
    res = client().post("/api/study", json=with_study(pads()))
    assert res.status_code == 422
    assert "at least one pad state" in json.dumps(res.json())


def test_the_labels_travel_so_a_column_can_be_read():
    """`p_pad = 92100` is not something a reader can match back to "January"."""
    body = client().post("/api/study",
                         json=with_study(pads(ISA_PAD, JAN_PAD))).json()
    assert body["axes"][0]["labels"] == ["ISA standard column",
                                         "KNID Jan normal"]
    assert [p["values"]["pad_source"] for p in body["points"]] \
        == ["ISA standard column", "KNID Jan normal"]


def test_the_configured_pad_state_is_named_when_it_is_among_the_points():
    """Same rule as the fitted canopy: two points that resolve to the same
    three numbers are the same design point, whatever they were picked from."""
    body = load_fixture()
    body["site"] = {"T_pad": JAN_PAD["T_pad"], "p_pad": JAN_PAD["p_pad"],
                    "lapse": JAN_PAD["lapse"]}
    body["study"] = [pads(ISA_PAD, JAN_PAD)]
    out = client().post("/api/study", json=body).json()
    assert out["axes"][0]["current"] == "KNID Jan normal"


def test_an_unlisted_pad_state_is_null_not_a_guess():
    body = client().post("/api/study",
                         json=with_study(pads(JAN_PAD, JUL_PAD))).json()
    assert body["axes"][0]["current"] is None


def test_a_month_axis_is_the_same_machinery_under_a_different_name():
    """The two keys differ only in what question the column header asks."""
    body = client().post("/api/study", json=with_study(
        pads(JAN_PAD, JUL_PAD, key="pad_month"))).json()
    assert body["runs"] == 2
    assert body["axes"][0]["key"] == "pad_month"
    assert body["axes"][0]["labels"] == ["KNID Jan normal", "KNID Jul normal"]
