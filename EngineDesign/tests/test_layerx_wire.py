"""Layer X records the whole feed network on every burn, and a vessel trip ends the burn.

Two lib/feedtwin features wired into ``engine/layerx/analysis.py`` (DATA-CONTRACT 2 and 4):

* **The network recorder** (``Probes(network=True)``, ``network_dict``). Recording only: a GN2 burn
  with it and one without give the same series and summary to the last bit, and the block it writes
  telescopes -- each side's rungs add up, step by step, to its first node minus the chamber.
* **The vessel trip** (``BurnEnd.tripped``, ``trip_record``). The AUDIT's case is a tank whose MAWP
  is restated below the pressure the burn reaches (AUDIT section 5, #1: Layer X then integrated the
  frozen frame to the 14 s horizon, 99,478 N s for a ~24,240 N s load). Here TK-FUEL is restated to
  566.3 psi on the helium drawing, which trips 0.575 s after Fire: the result must stop at the trip
  (series, burn time, impulse), say so (``tripped``, a ``fail`` event keyed ``trip``, ``converged``
  false, ``vessel_trip`` graded bad), and every tool that grades burns must count it as failing.
  The same with the AUDIT's own 600 psi, through the replay and the diagnostics, is in
  tests/test_layerx_integration_le4.py (LAYERX_GOLDEN=1).

Trips in the settle and in the lead-in cannot be reached from a drawing that passes preflight (the
T-0 lockup is checked against the MAWP), so those two paths are driven by tripping the session
directly, the way ``Session._check_limits`` does.
"""

from __future__ import annotations

import dataclasses
import math
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

feedtwin = pytest.importorskip("feedtwin", reason="lib/feedtwin is not installed")

from engine.layerx import DrawingStore, LayerXSettings, StandTripped, prepare, run_prepared  # noqa: E402
from engine.layerx.measurements import Override  # noqa: E402
from engine.layerx.sources import shipped_drawings_dir  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "configs", "ethalox_6800N.yaml")
PSI = 6894.757293168361
ATM_PSI = 101325.0 / PSI
#: TK-FUEL restated just above the T-0 lockup's 564.4 psi across the wall, so preflight passes and the
#: helium burn's supply-effect climb trips it early (0.575 s), keeping the test short. Chosen so the trip
#: lands inside a 50 ms burn step (on its first 25 ms live step): 566.0 trips on a step boundary.
LOW_MAWP_PSI = 566.3

pytestmark = pytest.mark.skipif(
    not (shipped_drawings_dir() / "copv_study_he.json").is_file()
    or not (shipped_drawings_dir() / "copv_study_gn2.json").is_file(),
    reason="feed-twin's shipped drawings are not next to this checkout")


def _drawing(name):
    return {d.name: d for d in DrawingStore(None).list()}[name]


def _low_mawp(psi: float = LOW_MAWP_PSI) -> Override:
    return Override(target="node:FUT", parameter="MAWP", value=psi, unit="psi",
                    source="test what-if (not a measurement)")


@pytest.fixture(scope="module")
def cfg():
    return load_config(CFG)


@pytest.fixture(scope="module")
def he():
    return _drawing("copv_study_he")


@pytest.fixture(scope="module")
def gn2_pair(cfg):
    """One GN2 burn as Layer X runs it (network recorded) and the same burn with the recorder off."""
    import feedtwin.session.burn as fb

    drawing = _drawing("copv_study_gn2")
    settings = LayerXSettings(drawing_id=drawing.id, ack_gn2_condensation=True, replay=False)
    prep = prepare(cfg, None, drawing, settings, [])
    assert prep.ok
    on = run_prepared(prep, replay=False)
    original = fb.BurnTrace.recorder

    def without_network(self, session):
        self.probes = dataclasses.replace(self.probes, network=False)
        return original(self, session)

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(fb.BurnTrace, "recorder", without_network)
        off = run_prepared(prepare(cfg, None, drawing, settings, []), replay=False)
    return {"on": on, "off": off, "prep": prep}


@pytest.fixture(scope="module")
def tripped(cfg, he):
    """The early trip as the router runs a burn: erosion replay, flight asked for, diagnostics on.
    The flight is a stub that counts its calls: a tripped burn must not be flown."""
    from engine.core.runner import PintleEngineRunner
    from engine.layerx import flight as flt

    runner = PintleEngineRunner(cfg)
    prep = prepare(cfg, runner, he, LayerXSettings(drawing_id=he.id, flight=True), [_low_mawp()])
    assert prep.ok, [c.detail for c in prep.checks if c.status == "fail"]
    calls = []
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(flt, "fly", lambda *a, **k: calls.append(1) or {"ok": False, "error": "flown"})
        result = run_prepared(prep, runner=runner, config=cfg, diagnostics=True)
    return {"prep": prep, "result": result, "fly_calls": len(calls)}


@pytest.fixture(scope="module")
def tripped_bare(cfg, he):
    """The same trip as the sweep burns it: no replay, no flight, so no passes decide ``converged``."""
    prep = prepare(cfg, None, he, LayerXSettings(drawing_id=he.id, replay=False), [_low_mawp()])
    return run_prepared(prep, replay=False)


# ---------------------------------------------------------------- the network recorder


def test_recording_the_network_moves_no_number(gn2_pair):
    on, off = gn2_pair["on"], gn2_pair["off"]
    assert "network" in on and "network" not in off
    # Exact, not approximate: the recorder reads the sample a step already produced.
    assert on["series"] == off["series"]
    assert on["summary"] == off["summary"]
    assert [(e["t"], e["key"]) for e in on["events"]] == [(e["t"], e["key"]) for e in off["events"]]


def test_the_network_block_is_the_contracts_and_its_rungs_telescope(gn2_pair):
    r = gn2_pair["on"]
    net, series = r["network"], r["series"]
    n = len(series["t"])
    assert net["t"] == series["t"]
    kinds = {nd["kind"] for nd in net["nodes"].values()}
    assert {"bottle", "tank", "tank_outlet", "chamber", "injector_inlet"} <= kinds
    for nid, nd in net["nodes"].items():
        assert {"label", "kind", "side", "phase", "p_psia", "T_K"} <= set(nd), nid
        assert len(nd["p_psia"]) == n and len(nd["T_K"]) == n
    for bid, br in net["branches"].items():
        assert {"label", "kind", "from", "to", "side", "mdot", "dp_psi"} <= set(br), bid
        assert br["from"] in net["nodes"] and br["to"] in net["nodes"]
        assert len(br["mdot"]) == n and len(br["dp_psi"]) == n
    chamber = next(k for k, nd in net["nodes"].items() if nd["kind"] == "chamber")
    for side, key in (("ox", "ox"), ("fuel", "fuel")):
        path = net["paths"][side]
        first = net["branches"][path[0]]
        assert net["nodes"][first["from"]]["kind"] == "bottle"
        assert net["branches"][path[-1]]["kind"] == "injector" and net["branches"][path[-1]]["to"] == chamber
        assert any(net["branches"][b]["kind"] == "tank_head" for b in path)
        for i in range(n):
            rungs = sum(net["branches"][b]["dp_psi"][i] for b in path)
            whole = net["nodes"][first["from"]]["p_psia"][i] - net["nodes"][chamber]["p_psia"][i]
            assert rungs == pytest.approx(whole, abs=1e-6), (side, i)
        # The injector branch carries the chamber's own flow on every firing step.
        inj = net["branches"][path[-1]]["mdot"]
        for i, on in enumerate(series["firing"]):
            if on:
                assert inj[i] == pytest.approx(series[key]["mdot"][i], rel=1e-9, abs=1e-12)


def test_the_feed_diagnostics_build_from_the_recorded_network(gn2_pair, cfg):
    from engine.layerx.analysis import diagnostics_of

    r, prep = gn2_pair["on"], gn2_pair["prep"]
    d, _ = diagnostics_of(prep, r, cfg, None)
    for name in ("ladder", "regulator", "saturation"):
        assert d[name].get("available", True) is not False, (name, d[name].get("error"))
    assert d["ladder"]["ox"]["closes"] and d["ladder"]["fuel"]["closes"]
    assert isinstance(d["solenoids"], list) and d["solenoids"]
    assert all(row.get("available", True) is not False for row in d["solenoids"])
    # The bottle's floor needs the regulator's capacity, which reads the recorded network.
    assert math.isfinite(d["pressurant"]["required_kg"]) and math.isfinite(d["pressurant"]["margin_kg"])
    assert "network record" in d["vv"]["mass"]["ox"]["basis"]
    # And without the record they say so rather than guess.
    bare = {k: v for k, v in r.items() if k != "network"}
    d0, _ = diagnostics_of(prep, bare, cfg, None)
    for name in ("ladder", "regulator", "saturation"):
        assert d0[name].get("available") is False and "network" in d0[name]["error"], name


# ---------------------------------------------------------------- a trip ends the burn


def test_a_trip_ends_the_burn_where_it_happened(tripped):
    r, prep = tripped["result"], tripped["prep"]
    trip = r["tripped"]
    assert trip["vessel"] == "FUT" and trip["kind"] == "tank"
    assert trip["mawp_psia"] == pytest.approx(LOW_MAWP_PSI + ATM_PSI, abs=1e-6)
    assert trip["p_psia"] > trip["mawp_psia"]
    s, series = r["summary"], r["series"]
    assert 0.0 < trip["t"] < 2.0                       # early: the full burn is ~3.5 s
    # The burn's clock, burn time and totals end at the trip -- not a step later, not at the horizon.
    assert series["t"][-1] == pytest.approx(trip["t"], abs=1e-12) and series["firing"][-1]
    assert s["burn_time_s"] == pytest.approx(trip["t"], abs=1e-12)
    # The trip landed inside the last 50 ms step: the session stopped there, so that step is short.
    assert series["dt"][-1] < prep.plan.dt - 1e-6
    assert series["dt"][-1] == pytest.approx(series["t"][-1] - series["t"][-2], abs=1e-12)
    impulse = sum(f * dt for f, dt, on in zip(series["chamber"]["thrust_N"], series["dt"], series["firing"]) if on)
    assert s["total_impulse_Ns"] == pytest.approx(impulse, rel=1e-12)
    assert s["total_impulse_Ns"] < 1.1 * s["peak_thrust_N"] * trip["t"]
    assert s["depleted_side"] == "" and s["impulse_to_depletion_Ns"] is None
    assert r["converged"] is False
    assert len(r["network"]["t"]) == len(series["t"])
    assert any("Burn stopped at t =" in note for note in r["provenance"]["notes"])
    # Replayed once for its delivered figures, which end at the trip too; never iterated, never flown.
    assert len(r["passes"]) == 1 and r["passes"][0]["tripped"]
    dv = r["delivered"]
    assert dv["t"][-1] == pytest.approx(trip["t"], abs=1e-12)
    assert 0.0 < dv["summary"]["total_impulse_Ns"] < 1.1 * s["peak_thrust_N"] * trip["t"]
    assert tripped["fly_calls"] == 0
    assert r["flight"]["ok"] is False and "vessel trip" in r["flight"]["error"]


def test_a_trip_is_unconverged_even_with_nothing_to_iterate(tripped_bare, tripped):
    r = tripped_bare
    assert "passes" not in r and r["converged"] is False
    assert r["tripped"]["t"] == pytest.approx(tripped["result"]["tripped"]["t"], abs=1e-12)
    assert r["series"]["t"][-1] == pytest.approx(r["tripped"]["t"], abs=1e-12)


def test_the_diagnostics_read_a_tripped_burn(tripped):
    d = tripped["result"]["diagnostics"]
    for name, block in d.items():
        rows = block if isinstance(block, list) else [block]
        assert isinstance(block, list) or block.get("available", True) is not False, (name, block.get("error"))
        assert all(row.get("available", True) is not False for row in rows), name
    # No tank ran dry: the tail-off is a cutoff at the trip, both tanks wet.
    sd = d["shutdown"]
    assert "vessel trip" in sd["first_dry_basis"]
    assert sd["valve_command_s"] == pytest.approx(tripped["result"]["tripped"]["t"])


def test_a_trip_is_a_fail_event_and_a_bad_limit_not_a_horizon(tripped):
    r = tripped["result"]
    trip = r["tripped"]
    ev = {e["key"]: e for e in r["events"]}
    assert ev["trip"]["kind"] == "fail" and ev["trip"]["t"] == pytest.approx(trip["t"])
    assert "TK-FUEL" in ev["trip"]["label"]
    assert not any(e["label"] == "Horizon reached" for e in r["events"])
    assert "dry_ox" not in ev and "dry_fuel" not in ev
    assert ev["burnout"]["t"] == pytest.approx(trip["t"]) and "trip" in ev["burnout"]["detail"]
    keys = [e["key"] for e in r["events"]]
    assert len(keys) == len(set(keys))
    g = {e["key"]: e for e in r["limits"]}
    assert g["vessel_trip"]["grade"] == "bad" and g["vessel_trip"]["t_worst"] == pytest.approx(trip["t"])
    assert "vessel trip" in g["depletion"]["hint"]


def test_the_listing_marks_a_tripped_run(tripped):
    from backend.routers.layerx import _listing_summary

    out = _listing_summary(tripped["result"])
    assert out["tripped"]["vessel"] == "FUT" and out["tripped"]["t"] == tripped["result"]["tripped"]["t"]
    assert "tripped" not in _listing_summary({k: v for k, v in tripped["result"].items() if k != "tripped"})


# ---------------------------------------------------------------- every tool counts it as failing


def test_the_set_point_and_hardware_tools_do_not_use_a_tripped_burn(tripped, cfg, he, monkeypatch):
    import engine.layerx.analysis as A
    from engine.layerx import setpoint as sp

    monkeypatch.setattr(A, "run_prepared", lambda prep, **kw: tripped["result"])
    p = sp.burn_point({"config": cfg, "drawing": he, "settings": LayerXSettings(drawing_id=he.id),
                       "overrides": [_low_mawp()], "replay": False})
    assert p["ok"] and p["tripped"]["vessel"] == "FUT"
    assert not sp.usable(p) and not sp.feasible(p)
    assert next(r for r in p["limits"] if r["key"] == "vessel_trip")["grade"] == "bad"


def test_the_sweep_leaves_a_tripped_case_out_of_the_swings_and_lists_it(tripped, cfg, he, monkeypatch):
    import engine.layerx.analysis as A
    from engine.layerx import uncertainty as U

    monkeypatch.setattr(A, "run_prepared", lambda prep, **kw: tripped["result"])
    case = U._burn_case((cfg, he, LayerXSettings(drawing_id=he.id), [], {"id": "x|high"}))
    assert case["ok"] is False and case["tripped"]["vessel"] == "FUT"
    assert case["error"].startswith("vessel trip: TK-FUEL")

    # The sweep itself: a nominal that burns and one case that trips.
    nominal = {"ok": True, "case": "nominal", "metrics": {k: 1.0 for k in U.METRICS}, "thrust": [], "depleted": "oxidiser",
               "lockup_psia": 578.0}

    def fake_case(args):
        cid = args[4]["id"]
        if cid == "nominal":
            return nominal
        if cid.endswith("|high"):
            return {"ok": False, "case": cid, "tripped": tripped["result"]["tripped"],
                    "error": U._trip_words(tripped["result"]["tripped"])}
        return {**nominal, "case": cid}

    monkeypatch.setattr(U, "_burn_case", fake_case)
    out = U.run_sweep(cfg, he, LayerXSettings(drawing_id=he.id), [], workers=1)
    trips = [c for c in out["crossings"] if c.get("tripped")]
    assert trips and all(c["side"] == "high" for c in trips)
    assert all(c["breaks"][0].startswith("vessel trip") for c in trips)
    for f in out["factors"]:
        for side, cs in f["cases"].items():
            assert cs["ok"] is (side != "high")
            if side == "high":
                assert cs["tripped"]["vessel"] == "FUT" and "delta" not in cs
    assert any("tripped the stand" in n for n in out["notes"])
    assert not any("failed:" in n for n in out["notes"])

    monkeypatch.setattr(U, "_burn_case", lambda args: {"ok": False, "case": args[4]["id"],
                                                         "tripped": tripped["result"]["tripped"],
                                                         "error": U._trip_words(tripped["result"]["tripped"])})
    with pytest.raises(RuntimeError, match="vessel trip"):
        U.run_sweep(cfg, he, LayerXSettings(drawing_id=he.id), [], workers=1)


def test_the_legacy_optimiser_and_reconcile_refuse_a_tripped_burn(tripped, cfg, he, monkeypatch):
    import engine.layerx.analysis as A
    from engine.layerx import optimize as opt
    from engine.layerx import reconcile as R

    f = opt._figures(tripped["result"])
    assert f["tripped"]["vessel"] == "FUT"
    g = opt.grade({"ok": True, "preflight": [], "figures": f, "x": {"lockup_psia": 578.0}},
                  opt.OptimizeRequest(), {}, None)
    keys = {c["key"]: c for c in g["constraints"]}
    assert not keys["vessel_trip"]["ok"] and "depletion" not in keys      # not read as a regulator dropout
    assert g["violation"] >= 1.0

    monkeypatch.setattr(A, "run_prepared", lambda prep, **kw: tripped["result"])
    with pytest.raises(ValueError, match="tripped"):
        R.run_reconcile(cfg, he, LayerXSettings(drawing_id=he.id, replay=False), [], R.ReconcileRequest(max_passes=1))


# ---------------------------------------------------------------- trips before Fire


def _trip_now(session, vessel="FUT"):
    from feedtwin.session.core import Trip

    sim = session.tanks[vessel]
    session.trip = Trip(vessel, sim.label, "tank", session.t, sim.pressure, sim.pressure * 0.99)
    session.tripped = f"{sim.label} over its MAWP (test)."


def test_a_trip_in_the_settle_raises_with_its_record(cfg, he, monkeypatch):
    import feedtwin.session.burn as fb
    from engine.layerx import setpoint as sp
    from engine.layerx import uncertainty as U

    original = fb.prime_at_t0

    def prime(session, plan):
        settled = original(session, plan)
        _trip_now(session)
        return settled

    monkeypatch.setattr(fb, "prime_at_t0", prime)
    prep = prepare(cfg, None, he, LayerXSettings(drawing_id=he.id, replay=False), [])
    with pytest.raises(StandTripped) as caught:
        run_prepared(prep, replay=False)
    assert caught.value.record["vessel"] == "FUT" and "settle" in str(caught.value)
    p = sp.burn_point({"config": cfg, "drawing": he, "settings": LayerXSettings(drawing_id=he.id), "overrides": [],
                       "replay": False})
    assert p["ok"] is False and p["tripped"]["vessel"] == "FUT" and not sp.usable(p)
    case = U._burn_case((cfg, he, LayerXSettings(drawing_id=he.id), [], {"id": "nominal"}))
    assert case["ok"] is False and case["tripped"]["vessel"] == "FUT"


def test_a_trip_in_the_lead_in_fires_nothing_and_is_not_replayed(cfg, he, monkeypatch):
    import feedtwin.session.burn as fb
    from engine.core.runner import PintleEngineRunner

    original = fb.prime_at_t0

    def prime(session, plan):
        settled = original(session, plan)
        step = session.step
        calls = {"n": 0}

        def stepped(dt):
            sample = step(dt)
            calls["n"] += 1
            if calls["n"] == 3:
                _trip_now(session)
            return sample

        session.step = stepped
        return settled

    monkeypatch.setattr(fb, "prime_at_t0", prime)
    runner = PintleEngineRunner(cfg)
    prep = prepare(cfg, runner, he, LayerXSettings(drawing_id=he.id), [])
    assert prep.link is not None and prep.link.sampler is not None      # the replay loop is armed
    r = run_prepared(prep, runner=runner, config=cfg)
    trip = r["tripped"]
    assert trip["t"] < 0.0 and not any(r["series"]["firing"])
    assert r["summary"]["total_impulse_Ns"] == 0.0 and r["summary"]["burn_time_s"] == 0.0
    assert r["converged"] is False and len(r["passes"]) == 1 and r["passes"][0]["tripped"]
    assert r["replay"]["available"] is False and "before Fire" in r["replay"]["error"]
    labels = [e["label"] for e in r["events"]]
    assert "Erosion replay failed" not in labels and "Burn did not settle" not in labels
    assert next(e for e in r["events"] if e["key"] == "trip")["kind"] == "fail"
    assert "burnout" not in {e["key"] for e in r["events"]}            # nothing burned, nothing burned out
