"""Optimize rebuilt (docs/layerx/AUDIT.md D6, 9.10): the trade study's removal, Hardware mode, the
catalogues it draws from, and the one change-list format Optimize and Injector holes share.

Set point has its own file (tests/test_layerx_setpoint.py). Nothing here burns: the burn is the
function every mode is handed, and the tests hand it a closed-form stand.
"""

from __future__ import annotations

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.routers import layerx as lx  # noqa: E402
from backend.session import UserSession, get_session  # noqa: E402


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("USERDATA_DIR", str(tmp_path))
    session = UserSession(f"optmodes-{tmp_path.name}")
    app = FastAPI()
    app.include_router(lx.router)
    app.dependency_overrides[get_session] = lambda: session
    yield TestClient(app), session
    with lx._JOBS_LOCK:
        for job_id in [j.id for j in lx._JOBS.values() if j.user == session.user]:
            lx._JOBS.pop(job_id, None)


def _saved(session, run_id: str, kind: str, result=None) -> None:
    job = lx.Job(session.user, lx.Settings(drawing_id="d"), "design", kind=kind)
    job.id = run_id
    job.status, job.finished = "done", 1.0
    job.result = result or {"summary": {"burn_time_s": 3.5, "total_impulse_Ns": 24000.0}}
    lx._persist(lx._runs_dir(session), job)


# ------------------------------------------------------------------ the trade study is gone


def test_saved_trade_studies_stay_listed_and_readable_as_legacy(api):
    client, session = api
    _saved(session, "20261002-093657-c71a29", "trade", {"x": {"key": "lockup_psia"}, "points": [{"ok": True}]})
    _saved(session, "20261002-100000-aaaaaa", "run")
    listed = {r["id"]: r for r in client.get("/api/layerx/runs").json()}
    assert listed["20261002-093657-c71a29"]["legacy"] is True
    assert "legacy" not in listed["20261002-100000-aaaaaa"]
    got = client.get("/api/layerx/runs/20261002-093657-c71a29").json()
    assert got["legacy"] is True and got["kind"] == "trade" and got["result"]["points"] == [{"ok": True}]
    # Marked at read time only: the files on disk are as they were written.
    index = json.loads((lx._runs_dir(session) / "_index" / "20261002-093657-c71a29.json").read_text())
    assert "legacy" not in index


def test_the_trade_endpoints_and_module_are_gone(api):
    import importlib.util

    client, _ = api
    assert importlib.util.find_spec("engine.layerx.trade") is None
    for path in ("/api/layerx/trade", "/api/layerx/trade/axes"):
        assert client.post(path, json={}).status_code in (404, 405)
    # What the sweep shares with it stays.
    from engine.layerx.pool import Cancelled, WorkerPool, default_workers  # noqa: F401


# ------------------------------------------------------------------ the catalogues


def test_drills_come_from_the_reconcile_table_and_rows_need_provenance(tmp_path):
    from engine.layerx import catalog as cat

    cs = cat.load_catalogs(None)
    no51 = next(r for r in cs["drills"] if r["id"] == "drill-no51")
    assert cat.param_si(no51, "d") == pytest.approx(0.0670 * 25.4)          # ASME B94.11M #51 = 0.0670 in
    assert "B94.11M" in no51["provenance"]
    # Seeded with the named parts only: the Aqua 1092-50 at Cv 0.8 and the 1.7 Cv press solenoid.
    by = {r["id"]: r for r in cs["valves"]}
    assert cat.param_si(by["aqua-1092-50"], "Cv") == 0.8 and cat.param_si(by["press-solenoid-cv1.7"], "Cv") == 1.7
    for kind in cat.FILE_KINDS:
        for r in cs[kind]:
            assert r["provenance"].strip() and r["source"] in cat.SOURCES, r["id"]
    # A person's row replaces a shipped one by id; a row with no provenance is refused, and said so.
    udir = tmp_path / "layerx" / "catalog"
    udir.mkdir(parents=True)
    (udir / "valves.json").write_text(json.dumps({"schema": cat.SCHEMA, "kind": "valves", "rows": [
        {"id": "press-solenoid-cv1.7", "label": "x", "applies_to": ["SOL"], "params": {"Cv": {"value": 1.75, "unit": "Cv"}},
         "source": "measured", "provenance": "flow bench 2026-10-04"}]}))
    mine = {r["id"]: r for r in cat.load_catalogs(tmp_path)["valves"]}
    assert cat.param_si(mine["press-solenoid-cv1.7"], "Cv") == 1.75 and mine["press-solenoid-cv1.7"]["origin"] == "user"
    (udir / "tubes.json").write_text(json.dumps({"schema": cat.SCHEMA, "kind": "tubes", "rows": [
        {"id": "t", "label": "x", "applies_to": ["line"], "params": {"bore": {"value": 4.0, "unit": "mm"}},
         "source": "manufacturer", "provenance": ""}]}))
    out = cat.load_catalogs(tmp_path)
    assert any("no provenance" in p for p in out["problems"]) and out["tubes"]          # shipped rows stand


# ------------------------------------------------------------------ Hardware mode, closed-form stand


def test_trim_orifice_K_by_hand():
    """D 10.92 mm (l_ox1), Do 9.70 mm, C 0.6: beta 0.888278, beta^4 0.622582;
    K = [sqrt(1 - 0.622582 x 0.64) / (0.6 x 0.789038) - 1]^2 = 0.407389 (ISO 5167-2 permanent loss)."""
    from engine.layerx.optimize import trim_orifice_C, trim_orifice_K

    assert trim_orifice_K(10.92e-3, 9.70e-3, 0.6) == pytest.approx(0.4073891, rel=1e-6)
    # Reader-Harris/Gallagher, corner taps, at the LOX line's flow: the audit's 0.542 (AUDIT 5.3).
    assert trim_orifice_C(10.92e-3, 9.70e-3, 1142.1, 1.9e-4, 1.826) == pytest.approx(0.542, abs=1e-3)


def _he_payload():
    from engine.layerx.sources import shipped_drawings_dir

    path = shipped_drawings_dir() / "copv_study_he.json"
    if not path.is_file():
        pytest.skip("feed-twin's shipped drawings are not next to this checkout")
    return json.loads(path.read_text())


class _Net:
    def conditions(self, node, p, signals=None):
        from types import SimpleNamespace

        return SimpleNamespace(rho=1142.1, mu=1.9e-4)


def _prep(payload):
    from types import SimpleNamespace

    return SimpleNamespace(
        drawing=SimpleNamespace(payload=payload, name="copv_study_he", id="he", sha256="s"), measurements=[],
        derived={"species": {"oxidiser": "oxygen", "fuel": "ethanol"}, "target_lockup_psia": 578.0,
                 "inlet_nodes": {"oxidiser": "ox_in", "fuel": "fu_in"}},
        inlet_nodes={"oxidiser": "ox_in", "fuel": "fu_in"},
        model=SimpleNamespace(built=SimpleNamespace(network=_Net())), config_sha256="a" * 64)


D_O0, D_F0 = 1.6318401623160582e-3, 1.4715307322406754e-3


def _hw_stand(calls=None):
    """O/F = 1.5212 (dO/dO0)^2 (dF0/dF)^2 / sqrt(1 + 0.03 dK_lox); mean thrust 7013 + 10.1 (L - 578);
    spread 6.4 - 0.3 (Cv_lox_press - 1.7) %."""

    def evaluate(args_list):
        out = []
        for a in args_list:
            if calls is not None:
                calls.append(a)
            g = a["config"].injector.geometry
            ov = {(o.target, o.parameter): o.value for o in a.get("extra_overrides") or []}
            dK = ov.get(("edge:l_ox1", "K_minor"), 0.5) - 0.5
            cv = ov.get(("node:SV_LOX_PRESS", "Cv"), 1.7)
            L = a.get("lockup_psia") or 578.0
            of = 1.5212 * (g.oxidizer.d_jet / D_O0) ** 2 * (D_F0 / g.fuel.d_jet) ** 2 / (1.0 + 0.03 * dK) ** 0.5
            F = 7013.0 + 10.1 * (L - 578.0)
            figs = {"mean_thrust_N": F, "of_mean": of, "thrust_spread_pct": 6.4 - 0.3 * (cv - 1.7),
                    "total_impulse_Ns": F * 3.45, "burn_time_s": 3.45, "copv_spare_psi": 900.0, "ox_used_kg": 6.3,
                    "fuel_used_kg": 6.3 / of, "lockup_psia": L, "pc_mean_psia": 0.69 * L}
            out.append({"ok": True, "preflight": [], "lockup_psia": L, "fill_psig": 4500.0, "replay": True,
                        "dome_psig": L - 64.4, "figures": figs, "limits": [], "tripped": None,
                        "derived": {"config_sha256": "a" * 64, "drawing": {"id": "he"}}})
        return out

    return evaluate


@pytest.fixture(scope="module")
def le4():
    pytest.importorskip("feedtwin")
    from engine.pipeline.io import load_config

    return load_config(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "configs",
                                    "ethalox_6800N.yaml"))


def _hardware(config, payload, **req):
    from types import SimpleNamespace

    from engine.layerx import catalog as cat
    from engine.layerx.optimize import HardwareRequest, run_hardware

    return run_hardware(config, None, SimpleNamespace(replay=True), [], HardwareRequest.from_dict(req),
                        catalogs=cat.load_catalogs(None), evaluate=_hw_stand(), prep=_prep(payload))


def test_hardware_picks_the_drill_that_brings_of_home_and_re_solves_the_set_point(le4):
    """LOX holes 1.6318 mm, O/F 1.5212 against 1.5. Neighbour drills and the stand's O/F by hand:
    #52 1.6129 mm -> 1.4861 (0.93 % off); 1.60 -> 1.4624 (2.5 %); 1.65 -> 1.5552 (3.7 %);
    1.70 -> 1.6509 (10 %); drawn 1.4 % off. #52 wins; a smaller hole is a new plate."""
    out = _hardware(le4, _he_payload(), components=[{"target": "design:oxidizer.d_jet"}], objective="of_error",
                    target_thrust_N=7200.0, design_of=1.5, neighbours=2)
    assert out["improves"] and out["winner"]["summary"].startswith("LOX holes #52")
    assert out["winner"]["figures"]["of_mean"] == pytest.approx(1.5212 * (0.0635 * 25.4e-3 / D_O0) ** 2, rel=1e-9)
    assert len(out["candidates"]) == 4 and out["candidates"][0]["rank"] is not None
    by = {c["field"]: c for c in out["change_list"]["changes"]}
    assert by["d_jet"]["after"] == pytest.approx(1.6129, abs=1e-4) and by["d_jet"]["cad_impact"] == "new plate"
    assert by["d_jet"]["target"] == "design:injector.geometry.oxidizer.d_jet" and by["d_jet"]["drill"]["drill"] == "#52"
    assert by["orifice_l_over_d"]["after"] == pytest.approx(5.0 * D_O0 / 1.6129e-3, rel=1e-4)
    assert by["lockup_psia"]["cad_impact"] == "setting only"                    # the set point, re-solved
    assert out["final"]["figures"]["mean_thrust_N"] == pytest.approx(7200.0, abs=7.2)
    w = out["change_list"]["exports"]["design_write"]
    assert w["method"] == "PUT" and w["query"] == {"expect_sha256": "a" * 64} and w["requires_confirmation"]
    assert w["body"]["injector"]["geometry"]["oxidizer"]["d_jet"] == pytest.approx(1.6129e-3, abs=1e-7)
    assert out["change_list"]["exports"]["pid_designer"] is None                # nothing on the drawing moved


def test_a_trim_orifice_is_sized_from_the_baseline_and_listed_for_pid_designer(le4):
    """Baseline: O/F 1.5212, lockup 578, Pc 398.82 psia. A trim taking O/F to 1.5 at a fixed drop
    needs (1 - (1.5/1.5212)^2) x 179.18 psi = 4.959 psi of permanent loss in l_ox1."""
    from engine.layerx.optimize import trim_orifice_C, trim_orifice_K

    payload = _he_payload()
    before = json.dumps(payload, sort_keys=True)
    out = _hardware(le4, payload, components=[{"target": "edge:l_ox1", "kind": "trim_orifice"}], objective="of_error",
                    design_of=1.5, neighbours=2, verify=False)
    trims = [c["trim"] for c in out["candidates"]]
    assert trims and all(t["sized_for_psi"] == pytest.approx(4.9594, abs=1e-3) for t in trims)
    mdot = 6.3 / 3.45
    for t in trims:
        C = trim_orifice_C(10.92e-3, t["bore_mm"] * 1e-3, 1142.1, 1.9e-4, mdot)
        assert t["K"] == pytest.approx(trim_orifice_K(10.92e-3, t["bore_mm"] * 1e-3, C), rel=1e-9)
    # The drills bracket the bore that gives exactly the loss: one smaller (more loss), one larger.
    v = mdot / (1142.1 * 3.141592653589793 * 10.92e-3 ** 2 / 4)
    dps = sorted(t["K"] * 0.5 * 1142.1 * v * v / 6894.757293168361 for t in trims)
    assert dps[0] < 4.9594 < dps[-1]
    assert out["needs_pid_designer"][0]["target"] == "edge:l_ox1"
    (ch,) = [c for c in out["change_list"]["changes"] if c["field"] == "K_minor"]
    assert ch["domain"] == "drawing" and ch["cad_impact"] == "new part" and ch["before"] == 0.5
    exp = out["change_list"]["exports"]["pid_designer"]
    l_ox1 = next(e for e in exp["edges"] if e["id"] == "l_ox1")
    assert l_ox1["data"]["params"]["K_minor"]["value"] == pytest.approx(ch["after"])
    assert exp["needs_pid_designer"] and json.dumps(payload, sort_keys=True) == before   # the drawing is untouched
    assert out["trim_model"]["inputs"]["C"]["provenance"].startswith("Reader-Harris")


def test_a_valve_from_the_catalogue_carries_its_row_into_the_change_list(le4):
    """SV_LOX_PRESS is 1.7 Cv; the catalogue's other solenoid rows are 1.2, 3.8 and 26.1. Spread
    6.4 - 0.3 (Cv - 1.7): the 26.1 Cv ball valve flattens most (estimated, and said so)."""
    out = _hardware(le4, _he_payload(), components=[{"target": "node:SV_LOX_PRESS"}], objective="thrust_flatness",
                    neighbours=2, verify=False)
    assert sorted(c["summary"] for c in out["candidates"]) == sorted([
        "SV-LOX-PRESS: Solenoid, Cv 1.2 (ethalox_stand drawing)", "SV-LOX-PRESS: Vent solenoid, Cv 3.8 (calibrated)",
        "SV-LOX-PRESS: Main valve, 1/2 in full-port ball valve"])
    cv = next(c for c in out["change_list"]["changes"] if c["field"] == "Cv")
    assert cv["after"] == 26.1 and cv["before"] == 1.7 and cv["source"] == "estimated"
    assert cv["catalog"]["id"] == "main-ball-valve-half-inch" and "Crane TP-410" in cv["provenance"]
    assert cv["pid_node_id"] == "SV_LOX_PRESS" and cv["cad_impact"] == "new part"
    # Each number keeps its own provenance: the ball valve's Cv is estimated (Crane), its 1/2 in bore is
    # the manufacturer's -- not the row's one tag for both.
    bore = next(c for c in out["change_list"]["changes"] if c["field"] == "bore")
    assert (bore["before"], bore["after"], bore["source"]) == (6.35, 12.7, "manufacturer")
    exp = out["change_list"]["exports"]["pid_designer"]
    sv = next(n for n in exp["nodes"] if n["id"] == "SV_LOX_PRESS")["data"]["params"]
    assert (sv["Cv"]["source"], sv["bore"]["source"]) == ("estimated", "manufacturer")


def test_the_drawn_bottle_row_does_not_call_its_estimates_measured():
    """KB1 on the drawings: volume measured, service pressure manufacturer, wall mass and MAWP
    estimated. The catalogue row carries each, and a wrong per-parameter tag is refused."""
    from engine.layerx import catalog as cat

    (row,) = cat.load_catalogs(None)["bottles"]
    assert {k: p["source"] for k, p in row["params"].items()} == {
        "volume": "measured", "pressure": "manufacturer", "wall_mass": "estimated", "MAWP": "estimated"}
    with pytest.raises(ValueError, match="source 'guessed'"):
        cat._check_row("bottles", {**row, "params": {"volume": {"value": 5.0, "unit": "L", "source": "guessed"}}}, "x")


def test_a_better_objective_that_breaks_a_limit_is_not_an_improvement(le4):
    """Every candidate breaks a limit the drawn hardware keeps (the stand marks it). #52 still ranks
    first among them on O/F, but it is not reported as an improvement."""
    from engine.layerx import catalog as cat
    from engine.layerx.optimize import HardwareRequest, run_hardware
    from types import SimpleNamespace

    stand = _hw_stand()

    def evaluate(args_list):
        out = stand(args_list)
        for a, b in zip(args_list, out):
            if a.get("tag") != "baseline":
                b["limits"] = [{"key": "stiffness_ox", "label": "LOX injector dP/Pc", "grade": "bad"}]
        return out

    out = run_hardware(le4, None, SimpleNamespace(replay=True), [],
                       HardwareRequest.from_dict({"components": [{"target": "design:oxidizer.d_jet"}],
                                                  "objective": "of_error", "design_of": 1.5, "verify": False}),
                       catalogs=cat.load_catalogs(None), evaluate=evaluate, prep=_prep(_he_payload()))
    assert out["winner"]["summary"].startswith("LOX holes #52") and out["winner"]["limits_bad"]
    assert out["improves"] is False
    assert any("within the limits" in n for n in out["notes"])


def test_hardware_refuses_an_objective_it_cannot_score_and_a_segmented_line(le4):
    from types import SimpleNamespace

    from engine.layerx import catalog as cat
    from engine.layerx.optimize import HardwareRequest, plan_candidates, run_hardware

    no_of = SimpleNamespace(design_requirements=SimpleNamespace(optimal_of_ratio=None, target_thrust=7200.0))
    with pytest.raises(ValueError, match="needs a design O/F"):
        run_hardware(no_of, None, SimpleNamespace(replay=True), [],
                     HardwareRequest.from_dict({"components": [{"target": "node:SV_LOX_PRESS"}]}),
                     catalogs=cat.load_catalogs(None), evaluate=_hw_stand(), prep=_prep(_he_payload()))
    # A line itemised into segments: feedtwin drops its own bore and K_minor, so a restated tube or trim
    # would burn as drawn. Refused, not burned as a no-op.
    payload = _he_payload()
    edge = next(e for e in payload["edges"] if e["id"] == "l_ox1")
    edge["data"]["segments"] = [{"kind": "straight", "length": {"value": 0.07, "unit": "m", "source": "measured"}}]
    for comp in ({"target": "edge:l_ox1"}, {"target": "edge:l_ox1", "kind": "trim_orifice"}):
        with pytest.raises(ValueError, match="itemised into 1 segment"):
            plan_candidates(_prep(payload), le4, HardwareRequest.from_dict({"components": [comp]}), cat.load_catalogs(None))


def test_hardware_refuses_what_the_drawing_lacks(le4):
    from engine.layerx import catalog as cat
    from engine.layerx.optimize import HardwareRequest, plan_candidates

    prep = _prep(_he_payload())
    with pytest.raises(ValueError, match="no node:NOPE"):
        plan_candidates(prep, le4, HardwareRequest.from_dict({"components": [{"target": "node:NOPE"}]}),
                        cat.load_catalogs(None))
    with pytest.raises(ValueError, match="trim orifice goes in a line"):
        HardwareRequest.from_dict({"components": [{"target": "node:SV_LOX_PRESS", "kind": "trim_orifice"}]})
    # Row ids as a bare string would be matched by substring: refused.
    with pytest.raises(ValueError, match="a list of catalogue row ids"):
        HardwareRequest.from_dict({"components": [{"target": "edge:l_ox1", "rows": "tube-6.35-bore"}]})
    with pytest.raises(ValueError, match="no catalogue row"):
        plan_candidates(prep, le4, HardwareRequest.from_dict({"components": [{"target": "node:KB1"}]}),
                        cat.load_catalogs(None))


# ------------------------------------------------------------------ Injector holes in the same format


def test_a_reconcile_result_reads_as_a_change_list_and_keeps_its_keys():
    """A saved reconcile's numbers (AUDIT 9.10 5: 1.6318 -> 1.6633 mm LOX, 1.4715 -> 1.5112 mm fuel; #51/#53
    gave O/F 1.5501, the 1.65/1.50 mm pair 1.4982 against 1.5)."""
    from engine.layerx import diff

    result = {
        "config_sha256": "b" * 64, "condition": "in flight", "lockup_psia": 578.0,
        "target": {"thrust_N": 6800.0, "of": 1.5, "source": "custom"},
        "before": {"d_O_mm": 1.6318, "d_F_mm": 1.4715},
        "changes": [
            {"item": "LOX orifice diameter", "unit": "mm", "from": 1.6318, "to": 1.6633, "fabrication": "re-drill larger"},
            {"item": "LOX passage L/d", "unit": "", "from": 5.0, "to": 4.905, "fabrication": "passage stays 8.16 mm long"},
            {"item": "Fuel orifice diameter", "unit": "mm", "from": 1.4715, "to": 1.5112, "fabrication": "re-drill larger"}],
        "design_update": {"injector": {"geometry": {"oxidizer": {"d_jet": 1.6633e-3}, "fuel": {"d_jet": 1.5112e-3}}},
                          "discharge": {"oxidizer": {"orifice_l_over_d": 4.905}},
                          "feed_system": {"oxidizer": {"K0": 1.1104, "derived_from": {"by": "Layer X injector reconcile"}}}},
        "drill_options": {"oxidizer": [{"drill": "#51", "d_mm": 1.7018}], "fuel": [{"drill": "#53", "d_mm": 1.5113}]},
        "drill_grid": [
            {"oxidizer": "#51", "fuel": "#53", "d_O_mm": 1.7018, "d_F_mm": 1.5113, "thrust_N": 6902.0, "of": 1.5501},
            {"oxidizer": "1.65 mm", "fuel": "1.50 mm", "d_O_mm": 1.65, "d_F_mm": 1.50, "thrust_N": 6758.0, "of": 1.4982},
            # On thrust alone this pair would win (made up for the test: thrust exact, O/F 4 % off).
            {"oxidizer": "#50", "fuel": "1.45 mm", "d_O_mm": 1.778, "d_F_mm": 1.45, "thrust_N": 6800.0, "of": 1.56},
            # On O/F alone this one would (made up: O/F exact, thrust 5.9 % short).
            {"oxidizer": "1.60 mm", "fuel": "1.45 mm", "d_O_mm": 1.60, "d_F_mm": 1.45, "thrust_N": 6400.0, "of": 1.5}],
        "before_burn": {"mean_thrust_N": 6600.0, "of_mean": 1.53}, "after_burn": {"mean_thrust_N": 6861.0, "of_mean": 1.501},
        "notes": [],
    }
    keys = set(result)
    cl = diff.from_reconcile(result)
    assert set(result) == keys                                            # the old keys stay, unchanged
    by = {(c["target"]): c for c in cl["changes"]}
    lox = by["design:injector.geometry.oxidizer.d_jet"]
    assert (lox["before"], lox["after"], lox["cad_impact"], lox["source"]) == (1.6318, 1.6633, "re-drill", "solved")
    # The pair nearest in thrust and O/F together is 1.65/1.50 (0.62 % + 0.12 %): not the nearest drills
    # (#51/#53: 1.5 % + 3.3 %), not the exact-thrust pair (0 % + 4 %), not the exact-O/F one (5.9 % + 0 %).
    assert lox["drill"]["picked"]["pair"] == {"oxidizer": "1.65 mm", "fuel": "1.50 mm"}
    assert lox["effect"]["mean_thrust_N"] == pytest.approx(261.0)
    assert by["design:discharge.oxidizer.orifice_l_over_d"]["cad_impact"] == "none"
    assert by["model:feed_system.oxidizer.K0"]["domain"] == "model"
    w = cl["exports"]["design_write"]
    assert w["query"] == {"expect_sha256": "b" * 64} and w["body"] == result["design_update"]
    for c in cl["changes"]:
        assert set(c) >= {"component", "pid_node_id", "field", "before", "after", "unit", "provenance", "effect", "cad_impact"}


def test_the_hardware_route_refuses_before_a_slot_is_taken(api):
    client, session = api
    settings = {"drawing_id": "d"}
    assert client.post("/api/layerx/hardware", json={"settings": settings, "components": []}).status_code == 422
    assert client.post("/api/layerx/hardware", json={"settings": settings, "components": [{"target": "node:X"}],
                                                     "objective": "apogee"}).status_code == 422
    r = client.post("/api/layerx/hardware", json={"settings": settings, "components": [{"target": "node:X"}]})
    assert r.status_code in (400, 404)
    with lx._JOBS_LOCK:
        assert not [j for j in lx._JOBS.values() if j.user == session.user]


def test_setpoint_and_hardware_routes_start_their_jobs(api, monkeypatch):
    """The wiring only: preflight, the module's refusal check, the job's kind and its result. The
    burns are stubbed (the modules' own tests burn closed-form stands)."""
    import time
    from types import SimpleNamespace

    from engine.layerx import optimize as opt
    from engine.layerx import setpoint as sp

    client, session = api
    prep = SimpleNamespace(ok=True, checks=[], drawing="D", settings="S", measurements=[])
    config = SimpleNamespace(design_requirements=SimpleNamespace(target_thrust=7200.0))
    monkeypatch.setattr(lx, "_prepare", lambda s, settings: (prep, None, config))
    seen = {}

    def fake_setpoint(cfg, drawing, settings, overrides, request, progress=None, cancelled=None):
        seen["setpoint"] = request
        return {"mode": "setpoint", "summary": {"mean_thrust_N": 7200.0}}

    def fake_hardware(cfg, drawing, settings, overrides, request, catalogs=None, progress=None, cancelled=None):
        seen["hardware"] = (request, sorted(catalogs))
        return {"mode": "hardware", "summary": {"objective": request.objective}}

    monkeypatch.setattr(sp, "run_setpoint", fake_setpoint)
    monkeypatch.setattr(opt, "run_hardware", fake_hardware)
    monkeypatch.setattr(opt, "plan_candidates", lambda *a, **k: {"candidates": []})

    def finish(r):
        assert r.status_code == 200, r.text
        for _ in range(100):
            got = client.get(f"/api/layerx/runs/{r.json()['id']}").json()
            if got["status"] in ("done", "failed"):
                return got
            time.sleep(0.02)
        raise AssertionError("job did not finish")

    got = finish(client.post("/api/layerx/setpoint", json={"settings": {"drawing_id": "d"}, "meop_psi": {"fuel": 750},
                                                           "target_thrust_N": 7100}))
    assert got["kind"] == "setpoint" and got["status"] == "done" and got["result"]["mode"] == "setpoint"
    assert seen["setpoint"].target_thrust_N == 7100 and seen["setpoint"].meop_psi == {"fuel": 750.0}
    got = finish(client.post("/api/layerx/hardware", json={"settings": {"drawing_id": "d"},
                                                           "components": [{"target": "node:SV_LOX_PRESS"}]}))
    assert got["kind"] == "hardware" and got["status"] == "done"
    request, kinds = seen["hardware"]
    assert request.objective == "of_error" and "valves" in kinds and "drills" in kinds
    assert "legacy" not in got
    # Neither new kind is legacy in the listing.
    assert all(not r.get("legacy") for r in client.get("/api/layerx/runs").json())
    # With no target thrust in the design and none sent, Set point is refused before a slot is taken.
    monkeypatch.setattr(lx, "_prepare", lambda s, settings: (prep, None, SimpleNamespace(design_requirements=None)))
    r = client.post("/api/layerx/setpoint", json={"settings": {"drawing_id": "d"}})
    assert r.status_code == 422 and "target thrust" in r.json()["detail"]["message"]
