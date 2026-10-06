"""Layer X integration: the wave-1 diagnostics wired into the burn, the run record and the API.

What these hold (fast; the LE4 burns are tests/test_layerx_integration_le4.py, LAYERX_GOLDEN=1):

* **Defaults are today's.** Every new setting is ``None`` and resolves to the behaviour before it
  existed; the router mirrors them with the same defaults; the baseline's list of defaults is
  unchanged by their arrival.
* **GN2 on LOX** is refused for a hot fire on the physical criterion (nitrogen's saturation pressure
  at the LOX temperature, CoolProp), checked by hand, and runs with the acknowledgement.
* **The tanks at burnout** (preflight ``tank_rise``) follow the drawing's regulator law at the
  bottle's isentropic end pressure, re-derived here independently.
* **Limits** keep today's chug grade on the default basis with the settled and drawing-basis
  margins beside it (D7), and cap the new diagnostics at amber without touching the old limits.
* **Events** carry unique stable keys; **models** are flattened into the run record.
* **Router**: sidecars are written beside the run, served, pruned and deleted with it; exports;
  trade and optimise runs are listed as legacy.
"""

from __future__ import annotations

import importlib
import io
import json
import math
import os
import sys
import zipfile
from dataclasses import asdict, fields
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT / "docs" / "layerx" / "baseline-2026-10-03d.json"
PSI = 6894.757293168361

NEW_SETTINGS = ("chug_basis", "chug_eroded", "card_eroded_nozzle", "flight_coupling", "fuel_lead_s",
                "valve_travel_s", "outlet_d_mm", "ack_gn2_condensation", "test_mode")


# ---------------------------------------------------------------- settings


def test_new_settings_are_unset_and_resolve_to_the_decided_defaults():
    """Unset resolves to the default; for the chug that is D7 as the user decided it on 2026-10-03
    (the drawing's lines, the eroded engine, graded from the first full-flow step)."""
    from engine.layerx.prepare import LayerXSettings, options

    s = LayerXSettings(drawing_id="d")
    for name in NEW_SETTINGS:
        assert getattr(s, name) is None, name
    assert options(s) == {
        "chug_basis": "drawing", "chug_eroded": True, "card_eroded_nozzle": True, "flight_coupling": "inline",
        "fuel_lead_s": 0.0, "valve_travel_s": None, "outlet_d_mm": [None, None], "ack_gn2_condensation": False,
        "test_mode": "hotfire"}
    # The baseline's defaults (tests/test_layerx_golden.py) do not move: every old field is as recorded
    # and every new one is None, which is what a missing key reads as.
    was = json.loads(BASELINE.read_text())["layerx_settings_defaults"]
    now = {k: v for k, v in asdict(s).items() if k != "drawing_id"}
    # The thermal models are the feed twin's own since 2026-10-03 (None runs its Setup).
    twin = ("ullage_collapse", "ullage_vapour", "chilldown", "line_walls")
    assert all(now[k] is None for k in twin)
    assert {k: v for k, v in now.items() if k in was and k not in twin} == {k: v for k, v in was.items() if k not in twin}
    assert all(now[k] is None for k in now if k not in was)


def test_what_the_physics_or_the_drawing_decides_is_not_a_setting():
    """2026-10-03: the eroded nozzle's thrust, the eroded chug, the inline ascent are the physics;
    the valve opening and the tank outlet bore are the drawing's. Saved settings that carry them
    are accepted and change nothing."""
    from engine.layerx.prepare import LayerXSettings, options

    want = options(LayerXSettings(drawing_id="d"))
    old = LayerXSettings(drawing_id="d", chug_basis="config", chug_eroded=False, card_eroded_nozzle=False,
                         flight_coupling="outer", valve_travel_s=0.2, outlet_d_mm=9.5)
    assert options(old) == want


@pytest.mark.parametrize("bad", [{"chug_basis": "both"}, {"flight_coupling": "sideways"}, {"test_mode": "coldflow_water"},
                                 {"fuel_lead_s": -1.0}, {"outlet_d_mm": [1.0, 2.0, 3.0]}, {"outlet_d_mm": 0.01}])
def test_an_option_it_cannot_take_fails_preflight_before_anything_is_built(bad):
    from engine.layerx.prepare import LayerXSettings, prepare

    drawing = SimpleNamespace(payload={"nodes": [], "edges": []}, name="x", id="x", sha256="")
    prep = prepare(SimpleNamespace(model_dump=lambda **_: {}), None, drawing, LayerXSettings(drawing_id="x", **bad))
    assert not prep.ok
    assert [c.key for c in prep.checks] == ["options"]


def test_the_router_mirrors_every_setting_with_the_same_default():
    from backend.routers.layerx import Settings
    from engine.layerx.prepare import LayerXSettings

    # card_center_psia is the optimiser's, set in-process for its candidates; a person never sends it.
    engine = {f.name: f.default for f in fields(LayerXSettings) if f.name not in ("drawing_id", "card_center_psia")}
    router = Settings(drawing_id="d").model_dump()
    for name, default in engine.items():
        assert name in router, name
        assert router[name] == default, (name, router[name], default)
    # And the router refuses what the engine would.
    for bad in ({"chug_basis": "both"}, {"flight_coupling": "x"}, {"test_mode": "coldflow_ln2"},
                {"fuel_lead_s": -0.1}, {"outlet_d_mm": [1.0, 2.0, 3.0]}, {"outlet_d_mm": 0.1}):
        with pytest.raises(Exception):
            Settings(drawing_id="d", **bad)
    ok = Settings(drawing_id="d", chug_basis="drawing", flight_coupling="inline", outlet_d_mm=[9.0, None],
                  ack_gn2_condensation=True, test_mode="hotfire")
    from engine.layerx.prepare import options

    assert options(LayerXSettings.from_dict(ok.model_dump()))["outlet_d_mm"] == [None, None]


# ---------------------------------------------------------------- GN2 on LOX


def _tank(T=None, fluid="oxygen", source="measured"):
    params = {}
    if T is not None:
        params["temperature"] = SimpleNamespace(si=T, source=SimpleNamespace(value=source))
    return SimpleNamespace(id="OXT", fluid=fluid, params=params)


def test_gn2_on_lox_is_refused_above_nitrogens_saturation_pressure_by_hand():
    import CoolProp.CoolProp as CP

    from engine.layerx.prepare import gn2_on_lox

    T = 90.0
    psat_n2 = CP.PropsSI("P", "T", T, "Q", 0, "Nitrogen")
    pv_o2 = CP.PropsSI("P", "T", T, "Q", 0, "Oxygen")
    assert 51.5 < psat_n2 / PSI < 53.0          # "~52 psia at 90 K" (the coordinator's figure)
    edge = psat_n2 + pv_o2                       # the lockup at which the ullage's N2 reaches saturation
    below = gn2_on_lox("nitrogen", _tank(T), edge - 0.1 * PSI)
    above = gn2_on_lox("nitrogen", _tank(T), edge + 0.1 * PSI)
    assert below["status"] == "info" and above["status"] == "fail"
    assert f"{psat_n2 / PSI:.1f} psia" in above["detail"] and "ack_gn2_condensation" in above["detail"]
    assert gn2_on_lox("nitrogen", _tank(T), 578.0 * PSI, acknowledged=True)["status"] == "warn"
    # Not a nitrogen bottle, not LOX, not a hot fire: the check does not apply.
    assert gn2_on_lox("helium", _tank(T), 578.0 * PSI) is None
    assert gn2_on_lox("nitrogen", _tank(T, fluid="ethanol"), 578.0 * PSI) is None
    assert gn2_on_lox("nitrogen", _tank(T), 578.0 * PSI, test_mode="coldflow_water") is None
    # Above nitrogen's critical temperature nothing condenses, whatever the pressure.
    assert gn2_on_lox("nitrogen", _tank(130.0), 2000.0 * PSI)["status"] == "info"
    # No temperature on the drawing: LOX's normal boiling point, said so.
    nbp = gn2_on_lox("nitrogen", _tank(None), 578.0 * PSI)
    assert nbp["status"] == "fail" and "normal boiling point" in nbp["detail"]


def test_the_492_psia_constant_is_gone():
    p = importlib.import_module("engine.layerx.prepare")   # the package re-exports a function of that name

    assert not hasattr(p, "N2_CRITICAL_PSIA")
    assert "492.5" not in Path(p.__file__).read_text().replace("(492.5 psia)", "")


# ---------------------------------------------------------------- tanks at burnout


def test_expected_tank_rise_is_the_regulator_law_at_the_isentropic_bottle_by_hand():
    """An affine regulator law (the drawing's: outlet rises ``k`` per psi the supply falls) and a
    helium bottle, solved here by a separate fixed point."""
    import CoolProp.CoolProp as CP

    p = importlib.import_module("engine.layerx.prepare")   # the package re-exports a function of that name

    k, lock0, p0, T0, Vb = 0.017, 578.0 * PSI, 4514.7 * PSI, 293.15, 4.6871e-3
    ull, exp = 3.6e-3, 11.37e-3
    law = lambda model, dome, supply: lock0 + k * (p0 - supply)  # noqa: E731
    orig = p.lockup_for_dome
    p.lockup_for_dome = law
    try:
        got = p.expected_tank_rise(None, dome_psig=513.0, gas="Helium", bottle_pa=p0, bottle_K=T0, bottle_m3=Vb,
                                   lockup_pa=lock0, ullage_m3=ull, expelled_m3=exp)
    finally:
        p.lockup_for_dome = orig
    s0 = CP.PropsSI("S", "P", p0, "T", T0, "Helium")
    m0 = CP.PropsSI("D", "P", p0, "T", T0, "Helium") * Vb
    rho_lock = CP.PropsSI("D", "P", lock0, "T", T0, "Helium")
    end = lock0
    for _ in range(50):
        need = CP.PropsSI("D", "P", end, "T", T0, "Helium") * (ull + exp) - rho_lock * ull
        pb = CP.PropsSI("P", "D", (m0 - need) / Vb, "S", s0, "Helium")
        end = lock0 + k * (p0 - pb)
    # The module stops when the end pressure moves under 0.01 psi; the hand loop runs to the bitter end.
    assert got["converged"]
    assert abs(got["end_pa"] - end) < 0.01 * PSI
    assert abs(got["bottle_end_pa"] - pb) < 0.1 * PSI
    assert abs(got["rise_pa"] - k * (p0 - pb)) < 0.01 * PSI
    assert 40.0 < got["rise_pa"] / PSI < 60.0   # the order of the LE4 burn's +40 psi
    # The isentrope is the larger drop (and so the larger rise) than holding the bottle's temperature.
    pb_isothermal = CP.PropsSI("P", "D", (m0 - need) / Vb, "T", T0, "Helium")
    assert pb < pb_isothermal


def test_a_bottle_that_cannot_hold_lockup_says_so():
    p = importlib.import_module("engine.layerx.prepare")   # the package re-exports a function of that name

    orig = p.lockup_for_dome
    p.lockup_for_dome = lambda model, dome, supply: 578.0 * PSI
    try:
        got = p.expected_tank_rise(None, dome_psig=513.0, gas="Helium", bottle_pa=1000.0 * PSI, bottle_K=293.15,
                                   bottle_m3=1e-3, lockup_pa=578.0 * PSI, ullage_m3=1e-3, expelled_m3=20e-3)
    finally:
        p.lockup_for_dome = orig
    assert got["end_pa"] is None and got["bottle_end_pa"] is None and got["gas_kg"] > 0


# ---------------------------------------------------------------- limits


def _result(n=8, dt=0.05):
    t = [-0.05, 0.0] + [dt * (k + 1) for k in range(n)]
    firing = [False, False] + [True] * n
    flat = lambda v: [v] * len(t)  # noqa: E731
    side = lambda: {"tank_psia": flat(578.0), "stiffness": [0.0, 0.0] + [0.30] * n, "liquid_kg": flat(5.0)}  # noqa: E731
    summary = {
        "depleted_side": "oxidiser", "burn_time_s": t[-1], "copv_end_psia": 1500.0, "copv_t0_psia": 4500.0,
        "ox": {"t0_psia": 578.0, "min_psia": 570.0, "stiffness_min": 0.30, "peak_psia": 578.0, "loaded_kg": 6.0, "residual_kg": 0.0},
        "fuel": {"t0_psia": 578.0, "min_psia": 572.0, "stiffness_min": 0.30, "peak_psia": 1100.0, "loaded_kg": 4.0, "residual_kg": 0.5},
        "failed_steps": 0, "t0_settled": True, "card_outside_steps": 0, "steps": len(t),
    }
    return {
        "series": {"t": t, "dt": [dt] * len(t), "firing": firing, "converged": [True] * len(t), "copv_psia": flat(1500.0),
                   "ox": side(), "fuel": side()},
        "summary": summary, "events": [], "converged": True,
        "delivered": {"t": t[2:], "chug_margin": [1.31, 1.4, 1.41, 1.42, 1.43, 1.44, 1.45, 1.46],
                      "summary": {"chug_margin_min": 1.31, "chug_margin_min_t": 0.05}},
        "provenance": {"derived": {"stiffness_band": {"oxidiser": [0.2, 0.4], "fuel": [0.2, 0.4]},
                                   "roles": {"oxidiser": "OXT", "fuel": "FUT"},
                                   "tank_mawp_psi": {"OXT": 1000.0, "FUT": 1000.0}, "ambient_pa": 101325.0}},
        "diagnostics": {
            "stability": {"basis": "config", "t": t, "margin": [None, None] + [1.20, 1.30, 1.31, 1.32, 1.33, 1.34, 1.35, 1.36],
                          "worst": {"t": 0.05, "index": 2, "margin": 1.20, "frequency_hz": 34.6},
                          "settled_min": {"t": 0.10, "index": 3, "margin": 1.30, "frequency_hz": 22.0},
                          "start_window_s": 0.1, "other_basis": {"basis": "drawing", "margin_min": 1.45, "t": 0.1}},
            "water_hammer": [{"line": "l_fu1", "side": "fuel", "peak_psia": 2906.0, "rating_psia": 1014.7, "ok": False}],
        },
    }


def _by_key(entries):
    return {e["key"]: e for e in entries}


def test_the_default_chug_grade_is_todays_whole_burn_minimum_with_the_new_margins_beside_it():
    from engine.layerx.analysis import grade_limits

    r = _result()
    g = _by_key(grade_limits(r, None, None, {"chug_basis": "config"}))
    # Today's: the delivered minimum, start included, on the config basis.
    assert g["chug_margin"]["value"] == 1.31 and g["chug_margin"]["series_ref"] == "delivered.chug_margin"
    assert g["chug_margin"]["decision"] == "D7" and "D7" in g["chug_margin"]["hint"]
    # Alongside, not graded: the settled minimum and the other basis.
    assert g["chug_margin_settled"]["value"] == 1.30 and g["chug_margin_settled"]["grade"] == "info"
    assert g["chug_margin_settled"]["frequency_hz"] == 22.0
    assert g["chug_margin_other_basis"]["value"] == 1.45 and g["chug_margin_other_basis"]["grade"] == "info"
    assert "chug_margin_start" not in g          # the graded minimum already includes the start
    # Exactly the grade the result had before the stability block existed.
    from engine.layerx.diag.limits import grade

    before = {**r, "diagnostics": {k: v for k, v in r["diagnostics"].items() if k != "stability"}}
    old = _by_key(grade(before))["chug_margin"]
    assert {k: g["chug_margin"][k] for k in ("value", "grade", "t_worst", "index_worst", "basis")} == \
        {k: old[k] for k in ("value", "grade", "t_worst", "index_worst", "basis")}


def test_the_drawing_basis_grades_the_stability_blocks_settled_minimum():
    from engine.layerx.analysis import grade_limits

    r = _result()
    r["diagnostics"]["stability"]["basis"] = "drawing"
    g = _by_key(grade_limits(r, None, None, {"chug_basis": "drawing"}))
    assert g["chug_margin"]["value"] == 1.30 and g["chug_margin"]["series_ref"] == "diagnostics.stability.margin"
    assert g["chug_margin_start"]["grade"] == "info" and "chug_margin_settled" not in g


def test_new_diagnostics_grade_amber_at_worst_and_old_limits_keep_their_grades():
    from engine.layerx.analysis import grade_limits

    r = _result()
    r["diagnostics"]["saturation"] = {"nodes": [{"id": "FUT.out", "label": "Fuel tank outlet", "side": "fuel",
                                                 "margin_psi": [-5.0] * len(r["series"]["t"]), "min_psi": -5.0, "t_min": 0.1}]}
    g = _by_key(grade_limits(r, None, None, {"chug_basis": "config"}))
    sat = g["saturation_FUT.out"]
    assert sat["grade"] == "warn" and sat["capped_from"] == "bad" and sat["review_pending"]
    assert "reviewed" in sat["hint"]
    # The mains never close (2026-10-03): the closing surge is not listed; this fixture has no opening one.
    assert "water_hammer_l_fu1" not in g
    # The tank limits are information for now (2026-10-03), the 1100 psia peak included.
    assert g["tank_mawp_fuel"]["grade"] == "info" and "capped_from" not in g["tank_mawp_fuel"]


def test_without_diagnostics_the_limits_are_diag_limits_own():
    from engine.layerx.analysis import grade_limits
    from engine.layerx.diag.limits import grade

    r = _result()
    r.pop("diagnostics")
    assert [e["key"] for e in grade_limits(r, None, None, {"chug_basis": "config"})] == [e["key"] for e in grade(r)]


# ---------------------------------------------------------------- events and models


def test_every_event_gets_a_unique_stable_key():
    from engine.layerx.analysis import _key_events

    r = _result()
    r["events"] = [
        {"t": -0.05, "kind": "t0", "key": "t0", "label": "T-0 state", "detail": ""},
        {"t": 0.0, "kind": "fire", "key": "fire", "label": "Fire", "detail": ""},
        {"t": 0.05, "kind": "min", "key": "min_tank_ox", "label": "LOX tank lowest", "detail": ""},
        {"t": 0.4, "kind": "end", "key": "dry_ox", "label": "LOX tank dry", "detail": ""},
        {"t": 0.4, "kind": "warn", "label": "Unconverged steps", "detail": ""},
        {"t": 0.1, "kind": "warn", "label": "Something earlier", "detail": ""},
    ]
    r["diagnostics"]["start"] = {"available": True, "fuel_lead_s": 0.3, "ignition_s": 0.017, "prime_ox_s": 0.0096,
                                 "prime_fuel_s": 0.0173}
    r["limits"] = [{"key": "chug_margin", "value": 1.31, "t_worst": 0.05, "basis": "config"}]
    r["tripped"] = {"vessel": "FUT", "t": 0.3, "p_psia": 1020.0, "mawp_psia": 1014.7, "message": "FUT over MAWP"}
    _key_events(r, None, {})
    keys = [e["key"] for e in r["events"]]
    assert len(keys) == len(set(keys))
    assert {"t0", "fire", "fuel_lead", "ignition", "min_tank_ox", "min_chug", "dry_ox", "burnout", "trip"} <= set(keys)
    assert [e["key"] for e in r["events"] if e["key"].startswith("warn:")] == ["warn:0", "warn:1"]
    assert next(e for e in r["events"] if e["key"] == "warn:0")["label"] == "Something earlier"
    assert next(e for e in r["events"] if e["key"] == "fuel_lead")["t"] == -0.3
    assert [e["t"] for e in r["events"]] == sorted(e["t"] for e in r["events"])


def test_the_model_record_flattens_every_block():
    from engine.layerx.analysis import model_record

    m = lambda n: {"name": n, "source": "s", "assumptions": ["a"], "inputs": {"x": {"value": 1}}}  # noqa: E731
    r = {"diagnostics": {"stability": {"model": m("chug")}, "water_hammer": [{"model": m("moc")}, {"available": False}],
                         "hardware": {"soak": {"model": m("soak")}, "model": m("hw")}},
         "flight": {"stability": {"model": m("barrowman")}}, "replay": {"soak": {"model": m("soak")}}}
    got = {(x["block"], x["name"]) for x in model_record(r)}
    assert got == {("diagnostics.stability", "chug"), ("diagnostics.water_hammer[0]", "moc"), ("diagnostics.hardware", "hw"),
                   ("diagnostics.hardware.soak", "soak"), ("flight.stability", "barrowman")}


def test_a_failing_diagnostic_is_reported_and_the_rest_stand(monkeypatch):
    from engine.layerx import analysis
    from engine.layerx.diag import stability, vv

    def boom(*a, **k):
        raise RuntimeError("broken on purpose")

    monkeypatch.setattr(stability, "stability_block", boom)
    monkeypatch.setattr(vv, "check", lambda result, prep=None: {"mass": {}, "model": {"name": "vv"}})
    prep = SimpleNamespace(link=None, settings=None, roles={}, derived={}, ambient_pa=101325.0)
    out, wall = analysis.diagnostics_of(prep, _result(), None, None, {
        "chug_basis": "config", "chug_eroded": False, "fuel_lead_s": 0.0, "valve_travel_s": None, "outlet_d_mm": [None, None]})
    assert out["stability"] == {"available": False, "error": "RuntimeError: broken on purpose"}
    assert out["vv"]["model"]["name"] == "vv"
    assert set(out) == set(analysis.DIAGNOSTIC_KEYS)
    assert set(wall) >= {"stability", "hardware", "feed", "start", "outflow", "shutdown", "water_hammer", "vv"}


# ---------------------------------------------------------------- router


@pytest.fixture()
def api(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.routers import layerx as lx
    from backend.session import UserSession, get_session

    monkeypatch.setenv("USERDATA_DIR", str(tmp_path))
    session = UserSession(f"integ-{tmp_path.name}")
    app = FastAPI()
    app.include_router(lx.router)
    app.dependency_overrides[get_session] = lambda: session
    yield TestClient(app), session, lx
    with lx._JOBS_LOCK:
        for job_id in [j.id for j in lx._JOBS.values() if j.user == session.user]:
            lx._JOBS.pop(job_id, None)


def _export_run():
    """A small finished burn the exporters can read (as tests/test_layerx_export.py builds it)."""
    t = [-0.1, -0.05, 0.0, 0.05, 0.1, 0.15, 0.2, 0.25]
    n = len(t)
    fire = [False, False, False, True, True, True, True, True]
    ramp = lambda a, b: [a + (b - a) * k / (n - 1) for k in range(n)]  # noqa: E731
    side = lambda p: {"tank_psia": ramp(p, p + 3.0), "stiffness": [0.0] * 3 + [0.31, 0.32, 0.33, 0.34, 0.35],  # noqa: E731
                      "mdot": [0.0] * 3 + [1.9] * 5}
    return {
        "series": {"t": t, "dt": [0.05] * n, "firing": fire, "converged": [True] * n, "copv_psia": ramp(4500.0, 4300.0),
                   "ox": side(578.0), "fuel": side(578.1),
                   "chamber": {"pc_psia": [0.0] * 3 + [395.0, 396.0, 397.0, 398.0, 399.0], "thrust_N": [0.0] * 3 + [6900.0] * 5}},
        "summary": {"burn_time_s": 0.25, "total_impulse_Ns": 1725.0},
        "provenance": {"config_sha256": "abc", "drawing": {"name": "stand", "sha256": "def"}},
    }


def _save(lx, session, run_id, kind="run", sidecars=None, result=None):
    job = lx.Job(session.user, lx.Settings(drawing_id="d"), "design", kind=kind)
    job.id = run_id
    job.status, job.finished = "done", 1.0
    job.result = result or {"summary": {"burn_time_s": 3.5, "total_impulse_Ns": 24000.0}, "provenance": {"drawing": {"name": "stand"}}}
    job.sidecars = sidecars or {}
    lx._persist(lx._runs_dir(session), job)
    return job


AXIAL = {"x_mm": [-10.0, 0.0, 10.0], "t": [0.05, 0.25], "q_MW_m2": [[1.0, 9.0, 3.0], [1.1, 9.5, 3.1]],
         "T_wall_K": [[500.0, 2000.0, 900.0], [520.0, 2100.0, 950.0]]}


def test_a_runs_sidecar_is_written_beside_it_served_and_deleted_with_it(api):
    client, session, lx = api
    rid = "20261003-000001-aaaaaa"
    _save(lx, session, rid, sidecars={"axial": AXIAL, "unknown": {"x": 1}})
    runs_dir = lx._runs_dir(session)
    assert (runs_dir / "_sidecar" / f"{rid}.axial.json").is_file()
    assert not (runs_dir / "_sidecar" / f"{rid}.unknown.json").exists()
    assert client.get(f"/api/layerx/runs/{rid}/sidecar/axial").json() == AXIAL
    assert client.get(f"/api/layerx/runs/{rid}/sidecar/unknown").status_code == 404
    assert client.get("/api/layerx/runs/20261003-000002-bbbbbb/sidecar/axial").status_code == 404
    assert client.get("/api/layerx/runs/..%2F..%2Fetc/sidecar/axial").status_code == 404
    # The listing never reads a sidecar as a run.
    assert [r["id"] for r in client.get("/api/layerx/runs").json()] == [rid]
    assert client.delete(f"/api/layerx/runs/{rid}").json()["deleted"]
    assert not (runs_dir / "_sidecar" / f"{rid}.axial.json").exists()


def test_pruning_takes_a_runs_sidecar_with_it(api, monkeypatch):
    client, session, lx = api
    monkeypatch.setattr(lx, "KEEP_RUNS", 1)
    _save(lx, session, "20261003-000001-aaaaaa", sidecars={"axial": AXIAL})
    _save(lx, session, "20261003-000002-bbbbbb", sidecars={"axial": AXIAL})
    left = sorted(p.name for p in (lx._runs_dir(session) / "_sidecar").iterdir())
    assert left == ["20261003-000002-bbbbbb.axial.json"]


def test_the_run_job_hands_its_sidecars_to_the_job_not_the_result(api):
    client, session, lx = api
    job = lx.Job(session.user, lx.Settings(drawing_id="d"), "design")
    with lx._JOBS_LOCK:
        lx._JOBS[job.id] = job
    lx._execute(job, lambda progress, cancelled: {**_export_run(), "sidecars": ["axial"], "_sidecars": {"axial": AXIAL}},
                lx._runs_dir(session))
    assert job.status == "done" and "_sidecars" not in job.result
    assert client.get(f"/api/layerx/runs/{job.id}/sidecar/axial").json() == AXIAL


def test_a_finished_burn_exports_csv_parquet_and_the_fea_bundle(api):
    client, session, lx = api
    rid = "20261003-000001-aaaaaa"
    _save(lx, session, rid, sidecars={"axial": AXIAL}, result=_export_run())
    csv = client.get(f"/api/layerx/runs/{rid}/export/csv")
    assert csv.status_code == 200 and csv.headers["content-type"].startswith("text/csv")
    assert f'filename="layerx-{rid}.csv"' in csv.headers["content-disposition"]
    assert csv.text.splitlines()[0].startswith("t [s],dt [s],firing [bool]")
    pq = client.get(f"/api/layerx/runs/{rid}/export/parquet")
    try:
        import pyarrow  # noqa: F401

        assert pq.status_code == 200 and pq.content[:4] == b"PAR1"
    except ImportError:
        assert pq.status_code == 501
    fea = client.get(f"/api/layerx/runs/{rid}/export/fea")
    names = zipfile.ZipFile(io.BytesIO(fea.content)).namelist()
    assert fea.status_code == 200 and {"pc_t.csv", "thrust_t.csv", "heatflux_xt.csv", "loads.json"} <= set(names)
    assert client.get(f"/api/layerx/runs/{rid}/export/xls").status_code == 404
    _save(lx, session, "20261003-000002-bbbbbb", kind="setpoint", result={"mode": "setpoint"})
    assert client.get("/api/layerx/runs/20261003-000002-bbbbbb/export/csv").status_code == 400


def test_trade_and_optimise_runs_are_listed_and_read_as_legacy(api):
    client, session, lx = api
    for i, kind in enumerate(("run", "trade", "optimize", "setpoint", "hardware", "reconcile", "uncertainty")):
        _save(lx, session, f"20261003-00000{i}-aaaaa{i}", kind=kind)
    listed = {r["kind"]: bool(r.get("legacy")) for r in client.get("/api/layerx/runs").json()}
    assert listed == {"run": False, "trade": True, "optimize": True, "setpoint": False, "hardware": False,
                      "reconcile": False, "uncertainty": False}
    assert client.get("/api/layerx/runs/20261003-000002-aaaaa2").json()["legacy"] is True


def test_the_catalogue_lists_shipped_rows_and_a_users_over_them(api):
    client, session, lx = api
    body = client.get("/api/layerx/catalog").json()
    assert body["problems"] == [] and body["drills"]
    shipped = {k: v for k, v in body.items() if k not in ("drills", "problems")}
    assert shipped and all(r["origin"] == "shipped" for rows in shipped.values() for r in rows)
    kind, rows = next((k, v) for k, v in shipped.items() if v)
    udir = lx._user_dir(session) / "layerx" / "catalog"
    udir.mkdir(parents=True, exist_ok=True)
    (udir / f"{kind}.json").write_text("not json")
    again = client.get("/api/layerx/catalog").json()
    assert again["problems"] and again[kind] == rows      # reported, and the shipped rows stand
