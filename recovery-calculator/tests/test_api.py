"""API surface. PLAN.md §11.2, §11.3.

These test the *contract* -- the shapes `frontend/src/types/schema.ts` builds
against -- rather than the physics, which the rest of the suite covers. A
passing physics suite and a broken wire format is a real and easy failure
mode, because nothing else looks at field names.
"""

import json
import math
import os
import pathlib

import pytest

from physics.schema import Config

pytest.importorskip("fastapi", reason="API tests need fastapi")
pytest.importorskip("httpx", reason="fastapi TestClient needs httpx")

from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "fixtures", "worked_example.json")


def load_fixture():
    with open(FIXTURE, encoding="utf-8") as handle:
        return json.load(handle)


def client():
    return TestClient(app)


# --- health ----------------------------------------------------------------


def test_health_reports_a_git_sha():
    """§11.4: when a number reaches a design review, which version of the
    physics produced it must be recoverable."""
    with client() as c:
        body = c.get("/api/health").json()
    assert body["status"] == "healthy"
    assert body["git_sha"]
    assert body["schema_version"]


# --- simulate --------------------------------------------------------------


def test_simulate_returns_all_four_cases():
    """§11.5: not optional, not a separate mode. A report showing only the
    nominal case hides a single-point failure worth 11x the design load."""
    with client() as c:
        body = c.post("/api/simulate", json=load_fixture()).json()
    assert set(body["cases"]) == {"nominal", "simultaneous", "no_main",
                                  "no_drogue"}


def test_simulate_matches_the_frontend_result_contract():
    """Field-for-field against frontend/src/types/schema.ts. A rename here is
    a broken chart there, with no type error to catch it."""
    with client() as c:
        body = c.post("/api/simulate", json=load_fixture()).json()

    for key in ("schema_version", "git_sha", "generated", "config",
                "warnings", "cases", "pad", "body_drag_band"):
        assert key in body, key

    case = body["cases"]["nominal"]
    for key in ("case", "trajectory", "events", "device_loads",
                "descent_time", "impact_velocity", "impact_ke", "h_equiv",
                "F_max", "F_peak_max", "safety_factor", "F_design",
                "status", "governing_link"):
        assert key in case, key

    sample = case["trajectory"][0]
    assert set(sample) == {"t", "z", "v", "a", "F_T", "CdS_tot"}

    load = case["device_loads"][0]
    for key in ("device", "v_s", "A", "X1", "F_inf", "F_peak", "F_snatch",
                "t_fill", "below_validity_floor"):
        assert key in load, key

    event = case["events"][0]
    assert set(event) == {"t", "kind", "device", "z", "v", "label"}
    assert case["status"] in ("pass", "fail", "na")


def test_simulate_reproduces_the_worked_example():
    """The API must not quietly transform the physics on its way out."""
    with client() as c:
        body = c.post("/api/simulate", json=load_fixture()).json()
    nominal = body["cases"]["nominal"]
    assert nominal["descent_time"] == pytest.approx(54.8, abs=0.15)
    assert nominal["impact_velocity"] == pytest.approx(6.04, abs=0.02)
    assert nominal["F_design"] == pytest.approx(2420.0, abs=5.0)

    # The GUI leads with the unfactored load, so the wire has to carry the
    # exact relationship rather than leaving the frontend to divide.
    assert nominal["F_peak_max"] * nominal["safety_factor"] == pytest.approx(
        nominal["F_design"], abs=1e-6)

    main = next(d for d in nominal["device_loads"] if d["device"] == "main")
    assert main["F_inf"] == pytest.approx(1613.0, abs=2.0)
    assert main["F_peak"] == pytest.approx(433.0, abs=1.0)   # eq (28)
    assert main["t_fill"] == pytest.approx(0.509, abs=0.002)  # eq (10)
    assert main["below_validity_floor"] is False


def test_simulate_carries_the_airframe_band():
    """§6.4 forbids presenting one bound silently, so the response says which
    one it used and what the other would have been."""
    with client() as c:
        body = c.post("/api/simulate?which=axial", json=load_fixture()).json()
    assert body["airframe_bound"] == "axial"
    band = body["body_drag_band"]
    assert band["broadside"] / band["axial"] == pytest.approx(36.1, abs=0.1)


def test_both_bounds_endpoint_differs_by_the_expected_factor():
    with client() as c:
        body = c.post("/api/simulate/both", json=load_fixture()).json()
    ax = body["axial"]["cases"]["nominal"]["F_design"]
    br = body["broadside"]["cases"]["nominal"]["F_design"]
    assert ax / br == pytest.approx(2.1, abs=0.05)


def test_trajectory_is_thinned_for_the_wire_but_keeps_the_peak():
    """§11.6: full resolution where the curvature is, coarse elsewhere. The
    load analysis still runs on the full <=5 ms grid, so decimation can never
    lose a peak."""
    with client() as c:
        body = c.post("/api/simulate", json=load_fixture()).json()
    case = body["cases"]["nominal"]
    traj = case["trajectory"]

    assert len(traj) < 3000, "wire payload should be thinned"
    assert max(s["F_T"] for s in traj) == pytest.approx(case["F_max"], rel=1e-9)
    assert len(json.dumps(body)) < 2_000_000


def test_events_cover_the_flight():
    with client() as c:
        body = c.post("/api/simulate", json=load_fixture()).json()
    kinds = [e["kind"] for e in body["cases"]["nominal"]["events"]]
    assert kinds[0] == "start"
    assert kinds[-1] == "ground"
    assert kinds.count("trigger") == 2
    assert kinds.count("line_stretch") == 2


def test_warnings_travel_as_data_and_the_run_still_happens():
    """§11.7: warnings run anyway and display inline. Only genuinely
    un-runnable configurations are rejected."""
    with client() as c:
        body = c.post("/api/simulate", json=load_fixture()).json()
    assert body["warnings"]
    assert body["cases"]["nominal"]["descent_time"] > 0


def test_invalid_config_is_rejected_not_papered_over():
    """A 4xx is a real answer about the config. The frontend deliberately does
    NOT fall back to a fixture on rejection, so this must be a 422."""
    bad = load_fixture()
    bad["devices"][0]["CdS"] = -1.0
    with client() as c:
        assert c.post("/api/simulate", json=bad).status_code == 422

    above = load_fixture()
    above["devices"][1]["trigger"]["value"] = 99999.0
    with client() as c:
        assert c.post("/api/simulate", json=above).status_code == 422


def test_unknown_field_is_rejected():
    """schema.py sets extra='forbid', so the UI's bookkeeping fields (uid,
    catalog, collapsed) must be stripped before posting -- and it must be a
    422 rather than a silent ignore, or the mistake never surfaces."""
    payload = load_fixture()
    payload["devices"][0]["uid"] = "react-key-1"
    with client() as c:
        assert c.post("/api/simulate", json=payload).status_code == 422


def test_bad_bound_name_is_a_400():
    with client() as c:
        r = c.post("/api/simulate?which=sideways", json=load_fixture())
    assert r.status_code == 400


# --- devices ---------------------------------------------------------------


def test_device_search_finds_by_multiple_tokens():
    """'iris 48' must find the IFC-48, whose description reads
    'IFC-48 - 48 in diameter Iris Ultra Standard...'. The words are present
    but not adjacent, so a raw substring test finds nothing."""
    with client() as c:
        hits = c.get("/api/devices", params={"q": "iris 48"}).json()
    assert hits
    assert any(d["sku"] == "IFC-48" for d in hits)


def test_device_search_serves_converted_si_values():
    """§11.3: the picker removes the §4.1 trap by construction. It must serve
    CdS already converted by eq (A1), never a raw diameter the UI might
    square."""
    with client() as c:
        hit = c.get("/api/devices/IFC-48").json()
    assert hit["CdS"] == pytest.approx(2.489, abs=0.001)
    assert hit["D0"] == pytest.approx(1.601, abs=0.001)
    assert hit["m_c"] == pytest.approx(0.2126, abs=0.001)
    assert hit["j"] == 2


def test_device_list_is_multi_vendor():
    with client() as c:
        vendors = c.get("/api/devices/vendors").json()
    counts = {v["vendor"]: v["count"] for v in vendors}
    assert counts["Fruity Chutes"] == 68
    assert sum(counts.values()) == 121


def test_unknown_device_is_404():
    with client() as c:
        assert c.get("/api/devices/NOPE-1").status_code == 404


# --- atmosphere ------------------------------------------------------------


def test_atmosphere_resolves_the_pad_and_a_profile():
    with client() as c:
        body = c.post("/api/atmosphere",
                      json={"T_pad": 284.0554}).json()
    assert body["pad"]["z_site"] == 630.0     # FAR, the only site
    assert body["pad"]["lapse"] == pytest.approx(-0.0065, abs=2e-7)
    assert body["pad"]["p_pad"] == pytest.approx(93983.0, abs=2.0)
    assert "standard column" in body["pad"]["p_source"]
    assert len(body["profile"]) == 40
    assert body["profile"][0]["rho"] > body["profile"][-1]["rho"]


def test_metar_decode_reports_the_raw_setting_error():
    """The trap: using the altimeter setting raw as station pressure is an
    11-18% density error at high desert sites and exactly 0% at sea level."""
    raw = ("METAR KNID 290456Z AUTO 19013KT 10SM CLR 31/M03 A2981 "
           "RMK AO2 SLP070 T03061028 $")
    with client() as c:
        body = c.post("/api/atmosphere/metar",
                      json={"raw": raw, "z_site": 610.0,
                            "station_elev": 697.0}).json()
    assert body["station"] == "KNID"
    assert body["temp_c"] == pytest.approx(30.6)
    assert body["T_transferred"] is True
    assert body["T_pad"] == pytest.approx(304.32, abs=0.01)
    assert body["p_pad"] == pytest.approx(93858.8, abs=1.0)
    assert body["p_naive_error_pct"] > 6.0
    assert body["maintenance_flag"] is True


# --- climatology -----------------------------------------------------------


def test_climatology_route_resolves_to_a_real_file():
    """This route is pure path arithmetic, which is exactly the kind of code
    that is wrong until something looks. An off-by-one in the dirname chain
    made every candidate point at recovery-calculator/recovery-calculator/...
    and turned the route into a guaranteed 404 that no other test noticed.
    """
    from backend.routers.climatology import _locate

    path = _locate()
    assert path is not None, "no climatology bundle found on any candidate path"
    assert os.path.isfile(path)
    assert "recovery-calculator/recovery-calculator" not in path


def test_climatology_serves_the_bundle_shape():
    """The frontend compiles a copy in and works with no server; this route
    must serve the identical shape so the components do not change."""
    with client() as c:
        r = c.get("/api/climatology")
    assert r.status_code == 200
    body = r.json()
    for key in ("meta", "surface", "upper", "soundings"):
        assert key in body, key


# --- sweep -----------------------------------------------------------------


def test_sweep_runs_every_corner():
    """Five enabled parameters, two values each, so 2^5 = 32 runs at ~40 ms."""
    from physics.cases import default_sweep

    config = Config.model_validate(load_fixture())
    enabled = [p for p in default_sweep(config) if p.enabled]
    expected = 2 ** len(enabled)
    with client() as c:
        body = c.post("/api/sweep", json=load_fixture()).json()
    assert body["runs"] == expected
    assert len(body["corners"]) == expected
    assert body["defaulted"] is True
    assert body["worst"]["F_design"] == pytest.approx(2420.0, abs=5.0)
    assert body["range"]["ratio"] > 3.0


# --- the library boundary --------------------------------------------------


def test_config_model_round_trips_through_the_wire():
    """§11.7: the form state IS the config schema -- one serialiser, no
    translation layer. The file the GUI saves is what the CLI accepts."""
    raw = load_fixture()
    config = Config.model_validate(raw)
    with client() as c:
        body = c.post("/api/simulate", json=raw).json()
    assert Config.model_validate(body["config"]) == config


def test_sweep_reports_a_worst_corner_per_category():
    """§11.9 with §11.5's lesson applied: the categories are decided by
    different metrics, so they have different worst corners. For this vehicle
    structure is worst at the AXIAL airframe bound and drift at BROADSIDE --
    the opposite corner. One headline number would contradict itself.
    """
    with client() as c:
        body = c.post("/api/sweep", json=load_fixture()).json()

    by_cat = body["worst_by_category"]
    assert set(by_cat) == {"structure", "drift", "impact"}
    assert by_cat["structure"]["attitude"] == "axial"
    assert by_cat["drift"]["attitude"] == "broadside"
    assert by_cat["structure"]["corner"] != by_cat["drift"]["corner"]


def test_delay_is_swept():
    """§15.7 ranks the charge-to-line-stretch lag THIRD, above both v_rel and
    n -- and the original corner set swept those two while omitting this one.
    It only reaches F_design on a drogue-governed design, which is exactly the
    case a sweep without it would miss."""
    from physics.cases import default_sweep

    config = Config.model_validate(load_fixture())
    delay = next(p for p in default_sweep(config) if p.key.value == "delay")
    assert delay.enabled
    with client() as c:
        body = c.post("/api/sweep", json=load_fixture()).json()
    seen = {row["corner"]["delay"] for row in body["corners"]}
    assert seen == set(delay.bounds)


def test_sweep_marks_parameters_that_did_not_matter():
    """F_design is identical at v_rel 5 and 20 whenever the infinite-mass
    bound governs, so max() breaks that tie arbitrarily. Naming the winner
    without saying so invites 'v_rel = 5 is the dangerous case', which is
    backwards -- v_rel = 20 is where snatch governs."""
    with client() as c:
        body = c.post("/api/sweep", json=load_fixture()).json()
    assert "v_rel" in body["worst_by_category"]["structure"]["irrelevant"]


def test_sweep_reports_which_candidate_governs_where():
    """The governing candidate changes across the sweep -- the bound at
    Cx = 1.8, snatch at Cx = 1.2 -- so which fix helps depends on the corner."""
    with client() as c:
        body = c.post("/api/sweep", json=load_fixture()).json()
    counts = body["governing_candidates"]
    assert sum(counts.values()) == body["runs"]
    assert len(counts) > 1, "this vehicle should change candidate across corners"


# --- a caller-supplied corner set -------------------------------------------


def _with_sweep(params):
    """The fixture plus an explicit `config.sweep`."""
    raw = load_fixture()
    raw["sweep"] = params
    return raw


def test_default_sweep_matches_the_canonical_corners_exactly():
    """The corner set became configurable; it must not have become different.

    Omitting `sweep` has to reproduce the fixed 32-corner table this endpoint
    shipped with, to the last newton -- otherwise the refactor silently
    restated every load in the plan.
    """
    with client() as c:
        body = c.post("/api/sweep", json=load_fixture()).json()
    assert body["runs"] == 32
    assert body["worst_by_category"]["structure"]["F_design"] == pytest.approx(
        2419.94, abs=0.05)
    assert body["range"]["min"] == pytest.approx(766.14, abs=0.05)
    assert body["range"]["max"] == pytest.approx(2419.94, abs=0.05)
    assert body["governing_candidates"] == {
        "main / F_inf (bound)": 20, "main / snatch": 12}


def test_disabling_a_parameter_halves_the_run_count():
    raw = _with_sweep([
        {"key": "Cx", "low": 1.2, "high": 1.8},
        {"key": "delay", "enabled": False, "low": 0.0, "high": 1.0},
    ])
    with client() as c:
        body = c.post("/api/sweep", json=raw).json()
    assert body["runs"] == 2
    assert body["defaulted"] is False
    # A disabled parameter is absent from the corner, not pinned to a bound --
    # each device keeps whatever its own config carries.
    assert set(body["corners"][0]["corner"]) == {"Cx"}


def test_custom_bounds_change_the_answer():
    """The whole point of accepting bounds: a narrower Cx band must produce a
    narrower spread. If it did not, the endpoint would be ignoring the spec."""
    wide = _with_sweep([{"key": "Cx", "low": 1.2, "high": 1.8}])
    narrow = _with_sweep([{"key": "Cx", "low": 1.7, "high": 1.8}])
    with client() as c:
        w = c.post("/api/sweep", json=wide).json()
        n = c.post("/api/sweep", json=narrow).json()
    assert w["range"]["ratio"] > n["range"]["ratio"] > 1.0
    assert n["swept"][0]["low"] == pytest.approx(1.7)


def test_pinned_bounds_collapse_to_one_run():
    """low == high is a pin, not a zero-width range: it must cost one run, not
    two identical ones."""
    raw = _with_sweep([{"key": "Cx", "low": 1.5, "high": 1.5}])
    with client() as c:
        body = c.post("/api/sweep", json=raw).json()
    assert body["runs"] == 1
    assert body["corners"][0]["corner"]["Cx"] == pytest.approx(1.5)


def test_inverted_bounds_are_normalised_not_rejected():
    raw = _with_sweep([{"key": "Cx", "low": 1.8, "high": 1.2}])
    with client() as c:
        body = c.post("/api/sweep", json=raw).json()
    assert body["swept"][0]["low"] == pytest.approx(1.2)
    assert body["swept"][0]["high"] == pytest.approx(1.8)


def test_mass_is_sweepable_but_off_by_default():
    """Mass is measurable, so it is a tolerance rather than an unknown -- but
    a caller who wants it should get a real 5% perturbation, not a no-op."""
    from physics.cases import default_sweep

    config = Config.model_validate(load_fixture())
    entry = next(p for p in default_sweep(config) if p.key.value == "m")
    assert entry.enabled is False

    raw = _with_sweep([{"key": "m", "low": 4.0, "high": 8.0}])
    with client() as c:
        body = c.post("/api/sweep", json=raw).json()
    assert body["runs"] == 2
    speeds = sorted(row["impact_velocity"] for row in body["corners"])
    assert speeds[1] > speeds[0] * 1.2, "heavier must land measurably faster"


def test_an_unknown_sweep_key_is_rejected():
    """`extra='forbid'` on the value side, an enum on the key side. A typo has
    to 422 rather than silently narrowing the sweep the caller asked for."""
    with client() as c:
        assert c.post("/api/sweep",
                      json=_with_sweep([{"key": "Cd", "low": 1, "high": 2}])
                      ).status_code == 422
        assert c.post("/api/sweep",
                      json=_with_sweep([{"key": "Cx", "low": 1, "high": 2,
                                         "nominal": 1.5}])
                      ).status_code == 422


def test_duplicate_sweep_keys_are_rejected():
    """Two entries for one key carry two sets of bounds, and whichever the
    resolver saw last would silently win."""
    with client() as c:
        r = c.post("/api/sweep", json=_with_sweep([
            {"key": "Cx", "low": 1.2, "high": 1.8},
            {"key": "Cx", "low": 1.0, "high": 3.0},
        ]))
    assert r.status_code == 422
    assert "duplicate" in r.text.lower()


def test_the_sweep_spec_rides_on_the_same_body_as_simulate():
    """§11.7: one serialiser, no translation layer. A config carrying a sweep
    spec must still be a valid /api/simulate body, and must round-trip."""
    raw = _with_sweep([{"key": "Cx", "low": 1.4, "high": 1.6}])
    with client() as c:
        assert c.post("/api/simulate", json=raw).status_code == 200
    assert Config.model_validate(raw).sweep[0].high == pytest.approx(1.6)


def test_the_gui_default_sweep_matches_the_backend_default_sweep():
    """The GUI ships its own copy of the corner bounds, in serialise.ts.

    It has to, because the form needs labels and units the wire schema forbids.
    But the *bounds* are the documented §15.7 band rather than a UI preference,
    and the two copies had already drifted: Cx read 1.4-2.2 in the GUI against
    1.2-1.8 here, and v_rel 5-15 against 5-20. The effect was that the GUI and
    the CLI answered the same vehicle with different sweeps and neither said
    so, which is worse than either bound being wrong.

    Parsed rather than duplicated a third time here, so this fails when they
    diverge instead of when someone forgets to update a list.
    """
    import re

    from physics.cases import default_sweep

    src = (ROOT / "frontend" / "src" / "lib" / "serialise.ts").read_text()
    block = src.split("sweep: [", 1)[1].split("\n    ],", 1)[0]
    gui = {
        m.group("key"): (float(m.group("lo")), float(m.group("hi")))
        for m in re.finditer(
            r"key: '(?P<key>\w+)'.*?min: (?P<lo>[\d.]+).*?max: (?P<hi>[\d.]+)",
            block, re.S)
    }
    # CdS_body is derived from the vehicle on both sides and rounded for
    # display in the GUI, so it is compared by the vehicle, not by the literal.
    gui.pop("CdS_body", None)
    gui.pop("m", None)

    config = Config.model_validate(load_fixture())
    backend = {p.key.value: (p.low, p.high) for p in default_sweep(config)}

    assert gui, "could not parse the GUI sweep defaults -- has the shape moved?"
    for key, (lo, hi) in gui.items():
        assert key in backend, "GUI sweeps %r, backend does not" % key
        assert backend[key] == pytest.approx((lo, hi)), (
            "%s: GUI has %s, backend has %s" % (key, (lo, hi), backend[key]))


def test_the_gui_and_backend_agree_on_the_airframe_band():
    """eqs (14)/(15) exist in both `physics/devices.airframe_band` and
    `frontend/src/lib/units.airframeBand`, because the GUI shows the band it
    cannot edit. Two copies of a formula is one more than is safe."""
    import re

    from physics.devices import airframe_band

    src = (ROOT / "frontend" / "src" / "lib" / "units.ts").read_text()
    body = re.search(r"export function airframeBand[^{]*\{(.*?)\n\}", src, re.S)
    assert body, "airframeBand not found in units.ts"

    # `**`, `*` and `/` mean the same thing in both languages, so the only
    # translation needed is the pi constant. Narrow on purpose: anything more
    # elaborate than the two-term expression this is checking should fail here
    # rather than be accommodated.
    expr = body.group(1).strip()
    assert expr.startswith("return [") and expr.endswith("]")
    d, ell = 0.1016, 1.44
    lo, hi = eval(  # noqa: S307 -- repo source, not input
        expr[len("return ["):-1].replace("Math.PI", "math.pi"),
        {"math": math, "d_body": d, "l_body": ell},
    )
    assert (lo, hi) == pytest.approx(airframe_band(d, ell))


# --- sweep trajectories ------------------------------------------------------


def test_sweep_omits_trajectories_by_default():
    """They are the entire cost of this response -- 32 descents against a few
    kB of scalars -- so every caller that only reads the numbers pays nothing."""
    with client() as c:
        body = c.post("/api/sweep", json=load_fixture()).json()
    assert all("trajectory" not in row for row in body["corners"])


def test_sweep_returns_a_trajectory_per_corner_when_asked():
    with client() as c:
        body = c.post("/api/sweep?trajectories=1", json=load_fixture()).json()
    assert len(body["corners"]) == body["runs"]
    for row in body["corners"]:
        assert len(row["trajectory"]) > 50
        assert set(row["trajectory"][0]) == {"t", "z", "v", "a", "F_T", "CdS_tot"}


def test_sweep_corner_ids_are_unique_and_stable():
    """The chart keys selection and colour off these, and pre-selects the
    worst-case corners by id -- so a reshuffle between two identical requests
    would silently repaint and reselect."""
    with client() as c:
        a = c.post("/api/sweep", json=load_fixture()).json()
        b = c.post("/api/sweep", json=load_fixture()).json()

    ids = [row["id"] for row in a["corners"]]
    assert len(set(ids)) == len(ids)
    assert ids == [row["id"] for row in b["corners"]]
    # Same id must mean the same corner, not merely the same position.
    for x, y in zip(a["corners"], b["corners"]):
        assert x["corner"] == y["corner"]

    # Every worst-case entry points at a real corner, which is what lets the
    # chart pre-select them.
    by_id = {row["id"]: row for row in a["corners"]}
    for name, entry in a["worst_by_category"].items():
        assert entry["id"] in by_id, name
        assert by_id[entry["id"]]["corner"] == entry["corner"]


def test_the_coarse_sweep_grid_still_carries_the_tension_peak():
    """The decimation guarantee, and the only reason coarsening is safe.

    The sweep sends a ~7x coarser grid than /api/simulate to keep 32 flight
    histories near 2 MB instead of 6. That is fine for comparing descent
    shapes and would be useless if it clipped the opening spike -- which is
    the one feature of the tension channel anybody looks at, and which lasts
    a few hundred milliseconds in a 55 s flight.

    `resample_for_wire` force-keeps argmax(F_T) for exactly this. Assert it
    against the un-decimated peak the physics computed.
    """
    from physics.cases import sweep as run_sweep_lib

    config = Config.model_validate(load_fixture())
    true_peaks = [float(cr.run.traj.F_T.max()) for _, cr in run_sweep_lib(config)]

    with client() as c:
        body = c.post("/api/sweep?trajectories=1", json=load_fixture()).json()

    for row, true_peak in zip(body["corners"], true_peaks):
        wire_peak = max(s["F_T"] for s in row["trajectory"])
        assert wire_peak == pytest.approx(true_peak, rel=1e-9), row["id"]


def test_simulate_resolution_is_untouched_by_the_sweep_grid():
    """`resample_for_wire` grew keyword arguments so the sweep could ask for a
    coarser grid. The defaults are /api/simulate's, so its output must not have
    moved by a single sample."""
    with client() as c:
        body = c.post("/api/simulate", json=load_fixture()).json()
    assert len(body["cases"]["nominal"]["trajectory"]) == 1238


def test_the_sweep_grid_is_coarser_than_simulates():
    """If these ever converge the constants have been collapsed, and the 32-run
    response quietly becomes a 6 MB one."""
    with client() as c:
        sim = c.post("/api/simulate", json=load_fixture()).json()
        swp = c.post("/api/sweep?trajectories=1", json=load_fixture()).json()

    fine = len(sim["cases"]["nominal"]["trajectory"])
    coarse = max(len(row["trajectory"]) for row in swp["corners"])
    assert coarse < fine / 2, "sweep grid %d vs simulate %d" % (coarse, fine)


# --- settings ---------------------------------------------------------------


@pytest.fixture
def settings_file(tmp_path, monkeypatch):
    """Point per-user storage at a scratch dir and return the local user's file.

    Settings are now per user (keyed by X-Auth-Email, `local` with no header --
    which is how these tests hit the API). Setting USERDATA_DIR isolates the
    suite from whatever units the developer running it happens to have chosen.
    """
    monkeypatch.setenv("USERDATA_DIR", str(tmp_path))
    d = tmp_path / "local" / "recovery"
    d.mkdir(parents=True, exist_ok=True)
    return d / "units.json"


def test_settings_are_empty_before_anything_is_saved(settings_file):
    """A fresh checkout has no file. That is not an error -- the frontend
    supplies its own defaults, so an empty envelope is the right answer."""
    assert not settings_file.exists()
    with client() as c:
        r = c.get("/api/settings")
    assert r.status_code == 200
    assert r.json() == {"units": {}, "precision": {}}


def test_settings_round_trip(settings_file):
    with client() as c:
        put = c.put("/api/settings", json={
            "units": {"mass": "metric", "force": "imperial"},
            "precision": {"maxDecimals": 4, "minSigFigs": 3},
        })
        assert put.status_code == 200
        got = c.get("/api/settings").json()

    assert got == {"units": {"mass": "metric", "force": "imperial"},
                   "precision": {"maxDecimals": 4, "minSigFigs": 3}}
    # Unset kinds are dropped rather than stored as null, so the file says only
    # what the user actually chose.
    assert json.loads(settings_file.read_text(encoding="utf-8")) == got


def test_unknown_kind_is_rejected(settings_file):
    """extra='forbid', matching physics/schema.py. The frontend strips unknown
    keys when it reads, so a rejection here means the writer is wrong."""
    with client() as c:
        r = c.put("/api/settings", json={"units": {"furlongs": "imperial"}})
    assert r.status_code == 422
    assert not settings_file.exists()


def test_unknown_system_is_rejected(settings_file):
    with client() as c:
        r = c.put("/api/settings", json={"units": {"mass": "cubits"}})
    assert r.status_code == 422


def test_a_corrupt_file_does_not_stop_the_gui_opening(settings_file):
    """A half-written file must degrade to defaults, never to a 500. The next
    save overwrites it anyway."""
    settings_file.write_text('{"units": {"mass": "met', encoding="utf-8")
    with client() as c:
        r = c.get("/api/settings")
    assert r.status_code == 200
    assert r.json() == {"units": {}, "precision": {}}


def test_a_file_from_before_precision_existed_still_loads(settings_file):
    """Adding a section must not orphan an existing settings file."""
    settings_file.write_text('{"units": {"mass": "metric"}}', encoding="utf-8")
    with client() as c:
        r = c.get("/api/settings")
    assert r.status_code == 200
    assert r.json() == {"units": {"mass": "metric"}, "precision": {}}


def test_one_mangled_section_does_not_lose_the_other(settings_file):
    settings_file.write_text('{"units": {"mass": "metric"}, "precision": 7}',
                             encoding="utf-8")
    with client() as c:
        body = c.get("/api/settings").json()
    assert body == {"units": {"mass": "metric"}, "precision": {}}


@pytest.mark.parametrize("bad", [
    {"maxDecimals": -3},    # reaches Number.toFixed(-3) in the browser, which
    {"maxDecimals": 99},    # throws and blanks the page -- so reject it here
    {"minSigFigs": 0},
    {"minSigFigs": 7},
    {"sigFigs": 3},         # not a field
])
def test_out_of_range_precision_is_rejected(settings_file, bad):
    with client() as c:
        r = c.put("/api/settings", json={"units": {}, "precision": bad})
    assert r.status_code == 422
    assert not settings_file.exists()


def test_the_write_leaves_no_temp_file_behind(settings_file, tmp_path):
    """It is written to a sibling temp file and renamed, because a truncated
    write loses the user's preferences outright."""
    with client() as c:
        c.put("/api/settings", json={"units": {"mass": "metric"}})
    assert [p.name for p in settings_file.parent.iterdir()] == ["units.json"]


def test_every_kind_the_frontend_knows_about_is_accepted(settings_file):
    """The field list here mirrors `Kind` in frontend/src/lib/quantities.ts.
    A kind added there and forgotten here is a 422 the user sees as a silent
    failure to save."""
    kinds = ("altitude", "length", "distance", "area", "mass", "speed",
             "accel", "force", "stiffness", "energy", "pressure",
             "temperature", "tempDelta", "density", "lapse")
    with client() as c:
        r = c.put("/api/settings",
                  json={"units": {k: "imperial" for k in kinds}})
    assert r.status_code == 200
    assert set(r.json()["units"]) == set(kinds)


# --- /api/crosscheck -------------------------------------------------------


def test_crosscheck_returns_all_three_models():
    res = client().post("/api/crosscheck", json=load_fixture())
    assert res.status_code == 200
    body = res.json()

    assert set(body["models"]) == {"ours", "openrocket", "mastersheet"}
    for name, model in body["models"].items():
        assert model["label"]
        assert model["trajectory"], name
        assert isinstance(model["computes_load"], bool)

    # §11.4 again, for the foreign model: which OpenRocket produced the
    # comparison has to be recoverable from the response alone.
    assert body["openrocket_version"]["release"] == "release-24.12"
    assert body["openrocket_version"]["commit"]


def test_crosscheck_sends_absences_as_null_not_zero():
    """The contract the whole tab rests on.

    A load of `0` next to our 1613 N reads as OpenRocket predicting no load.
    `null` reads as OpenRocket having no opinion, which is the truth. If this
    ever regresses to 0 the UI will render a passing number for a check nobody
    performed.
    """
    body = client().post("/api/crosscheck", json=load_fixture()).json()
    by_key = {m["key"]: m for m in body["metrics"]}

    assert by_key["F_peak"]["values"]["openrocket"] is None
    assert by_key["peak_decel"]["values"]["mastersheet"] is None
    assert by_key["drift"]["values"]["ours"] is None
    assert by_key["drift"]["values"]["openrocket"] is None
    for key in ("F_peak", "peak_decel", "drift"):
        assert by_key[key]["note"], key

    assert body["models"]["openrocket"]["computes_load"] is False
    # ...and the trajectory carries the same absence, so the tension channel
    # draws a gap rather than a line along zero.
    assert all(p["F_T"] is None
               for p in body["models"]["openrocket"]["trajectory"])


def test_crosscheck_metric_kinds_are_ones_the_frontend_knows():
    """An unknown `kind` does not render badly — it blanks the whole page.

    `unitFor` does `QUANTITIES[kind].units[prefs[kind]]`, so a kind the
    frontend has never heard of throws "Cannot read properties of undefined
    (reading 'undefined')" during render and React unmounts the app. It shipped
    exactly once, with `descent_time` carrying `kind: "time"` — and
    `lib/quantities.ts` deliberately has no `time`, because seconds have no
    imperial form and a unit dropdown for them would be a control that does
    nothing.

    The union is read out of the TypeScript rather than restated here, so this
    cannot drift the way a hand-copied list would. `null` is legal and means
    "no imperial form": the row then carries a literal `unit` instead.
    """
    import re

    source = (ROOT / "frontend" / "src" / "lib" / "quantities.ts").read_text(
        encoding="utf-8")
    match = re.search(r"export type Kind\s*=(.*?)\n\n", source, re.S)
    assert match, "could not find the Kind union in quantities.ts"
    known = set(re.findall(r"'([A-Za-z]+)'", match.group(1)))
    assert "altitude" in known and "force" in known, known
    assert "time" not in known, "quantities.ts gained a `time` kind"

    body = client().post("/api/crosscheck", json=load_fixture()).json()
    for metric in body["metrics"]:
        kind = metric["kind"]
        if kind is None:
            assert metric["unit"], (
                "%s has no kind, so it must carry a literal unit"
                % metric["key"])
        else:
            assert kind in known, "%s: %r is not a Kind" % (metric["key"], kind)


def test_crosscheck_wind_moves_drift_and_nothing_else():
    still = client().post("/api/crosscheck?wind=0", json=load_fixture()).json()
    windy = client().post("/api/crosscheck?wind=9.8", json=load_fixture()).json()

    def by_key(body):
        return {m["key"]: m["values"] for m in body["metrics"]}

    a, b = by_key(still), by_key(windy)
    assert a["drift"]["mastersheet"] == 0.0
    assert b["drift"]["mastersheet"] > 0.0
    for key in ("descent_time", "impact_velocity", "impact_ke", "F_peak"):
        assert a[key] == b[key], key


def test_crosscheck_rejects_an_unrunnable_config():
    bad = load_fixture()
    bad["devices"][0]["CdS"] = -1.0
    assert client().post("/api/crosscheck", json=bad).status_code == 422
