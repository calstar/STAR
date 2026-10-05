"""LE4 burned with every diagnostic wired in: the baseline must not move, and every block must be there.

Slow (three LE4 burns, ~6 min): skipped unless ``LAYERX_GOLDEN=1``, like tests/test_layerx_golden.py,
whose baseline, config and tolerances these use.

* **he_pad, diagnostics on** (as the router runs every burn): the golden figures are reproduced
  within the golden bands (the diagnostics read the burn and change nothing in it), every
  DATA-CONTRACT 3 block is present with its contract keys and finite numbers, the limits follow
  the coordinator decisions, every event has a unique stable key, the run record lists every model,
  and the diagnostics cost under 10 % of the burn.
* **he_flight**: the helium hot-fire drawing flies now that the flight prices its ullage and refill
  as helium. It reproduces the baseline's "He ullage" what-if (AUDIT 8 first gave 24,235.2 N·s, 3.4461 s, apogee
  3,249 m AGL), which reached it by patching the config and flying the retired RocketPy outer loop.
  The burn settles on the pad first -- the same burn as he_pad, figure for figure -- then flies
  with the 1-DOF ascent stepped inside it (AUDIT D5-C), within 0.5 % of RocketPy's specific force.

Every burn records the whole feed network (``result.network``, DATA-CONTRACT 2, wired 2026-10-03), so
the blocks that read it (ladder, regulator, solenoids, saturation, the pressurant floor, the stability
block's start window) must all be there, and agree with the AUDIT's own hand figures for this burn.

* **The AUDIT's trip** (section 5, #1): TK-FUEL's MAWP restated to 600 psi. Before the wiring Layer X
  integrated the frozen stand to the 14 s horizon (99,478 N s, "Horizon reached", no trip). Now the
  burn stops where the tank crosses 614.7 psia (~3.1 s): its impulse, delivered impulse and burn time
  end there, it carries ``tripped``, a ``fail`` event keyed ``trip``, ``converged`` false, and a bad
  ``vessel_trip`` limit, with every diagnostics block still built.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import math
import os
from pathlib import Path
from typing import Any, Dict

import pytest

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT / "docs" / "layerx" / "baseline-2026-10-03d.json"

pytestmark = [
    pytest.mark.skipif(os.environ.get("LAYERX_GOLDEN") != "1",
                       reason="slow LE4 burns: set LAYERX_GOLDEN=1 to run them"),
]

#: DATA-CONTRACT 3: the keys each block must carry when it is available.
CONTRACT: Dict[str, tuple] = {
    "stability": ("basis", "t", "margin", "frequency_hz", "worst", "settled_min", "start_window_s", "nyquist",
                  "tau_sweep", "acoustic", "other_basis", "model"),
    "hardware": ("t", "throat_d_mm", "At_ratio", "eps", "Lstar_m", "contraction", "liner_min_mm", "insert_back_K",
                 "insert_back_basis", "contour", "separation", "isp", "soak", "heatmap", "model"),
    "pressurant": ("species", "loaded_kg", "used_kg", "residual_kg", "required_kg", "margin_kg", "bottle_T_K", "jt_dT_K"),
    "cavitation": ("ox", "fuel"),
    "injector": ("t", "v_ox", "v_fuel", "momentum_ratio", "design_momentum_ratio", "resultant_angle_deg", "eta_cstar"),
    "thrust_shape": ("mean_N", "dev_max_pct", "dev_rms_pct", "breakdown"),
    "start": ("t", "pc_psia", "mdot_ox", "mdot_fuel", "mr", "fuel_lead_s", "valve_travel_s", "prime_ox_s",
              "prime_fuel_s", "ignition_s", "impulse_deficit_Ns", "hard_start", "model"),
    "shutdown": ("first_dry", "mode", "tail_mr_max", "model"),
    "vv": ("mass", "pressurant", "energy", "convergence"),
    "ladder": ("t", "ox", "fuel"),
    "regulator": ("t", "inlet_psia", "outlet_psia", "mdot", "capacity_mdot", "use_frac", "droop_psi", "spe_psi",
                  "choked", "wide_open", "cv"),
    "saturation": ("nodes",),
}
ROWS = {
    "water_hammer": ("line", "side", "closure_s", "joukowsky_psi", "slow_close_psi", "peak_psia", "rating_psia", "ok"),
    "outflow": ("tank", "side", "ingestion_onset_s", "residual_kg", "outlet_d_mm", "model"),
    "ledger": ("key", "label", "design_value", "unit", "delivered", "series_ref", "replaced", "note"),
    "solenoids": ("id", "side", "cv", "dp_psi", "share_of_reg_to_tank"),
}
#: Scalars that must be finite numbers when their block is available.
FINITE = {
    "start": ("fuel_lead_s", "valve_travel_s", "prime_ox_s", "prime_fuel_s", "ignition_s", "impulse_deficit_Ns"),
    "shutdown": ("tail_mr_max",),
    "pressurant": ("loaded_kg", "used_kg", "residual_kg"),
    "thrust_shape": ("mean_N", "dev_max_pct", "dev_rms_pct"),
    "stability": ("start_window_s",),
}
NEEDS_NETWORK = ("ladder", "regulator", "solenoids", "saturation")
#: The full LE4 he_pad burn: 24,236.0 N s (docs/layerx/baseline-2026-10-03d.json).
FULL_IMPULSE_NS = 24236.034725891644


def _script():
    spec = importlib.util.spec_from_file_location("layerx_baseline", ROOT / "scripts" / "layerx_baseline.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _golden():
    spec = importlib.util.spec_from_file_location("golden", ROOT / "tests" / "test_layerx_golden.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _burn(case: str, overrides=(), **settings: Any) -> Dict[str, Any]:
    """One LE4 burn as the router runs it: a private copy of the baseline's config, its own runner,
    diagnostics on, the sidecar kept."""
    import time

    pytest.importorskip("feedtwin", reason="lib/feedtwin is not installed")
    from engine.core.runner import PintleEngineRunner
    from engine.layerx import LayerXSettings, prepare, run_prepared

    lb = _script()
    config, _ = lb.load_engine_config(BASELINE)
    drawing = lb.find_drawing("copv_study_he")
    cfg = copy.deepcopy(config)
    runner = PintleEngineRunner(cfg)
    prep = prepare(cfg, runner, drawing, LayerXSettings(drawing_id=drawing.id, **settings), list(overrides))
    assert prep.ok, [f"{c.key}: {c.detail}" for c in prep.checks if c.status == "fail"]
    sidecars: Dict[str, Any] = {}
    t0 = time.perf_counter()
    result = run_prepared(prep, runner=runner, replay=prep.settings.replay, config=cfg, diagnostics=True,
                          sidecars=sidecars)
    return {"result": result, "prep": prep, "sidecars": sidecars, "metrics": lb.metrics(result, prep),
            "wall_s": time.perf_counter() - t0, "case": case}


@pytest.fixture(scope="module")
def he_pad():
    return _burn("he_pad")


@pytest.fixture(scope="module")
def he_flight():
    return _burn("he_flight", flight=True)


@pytest.fixture(scope="module")
def he_trip():
    from engine.layerx.measurements import Override

    restated = Override(target="node:FUT", parameter="MAWP", value=600.0, unit="psi",
                        source="AUDIT 5.2 what-if (not a measurement)")
    return _burn("he_pad_fuel_mawp_600", overrides=[restated])


# ---------------------------------------------------------------- he_pad


def test_the_baseline_does_not_move_with_the_diagnostics_on(he_pad):
    golden = _golden()
    want = json.loads(BASELINE.read_text())["cases"]["he_pad"]["metrics"]
    moved = []
    for key, (kind, tol) in golden.TOLERANCES.items():
        a, b = golden._get(want, key), golden._get(he_pad["metrics"], key)
        if kind == "eq":
            ok = a == b
        elif kind == "rel":
            ok = a is not None and b is not None and abs(b / a - 1.0) <= tol
        else:
            ok = a is not None and b is not None and abs(b - a) <= tol
        if not ok:
            moved.append(f"{key}: {a!r} -> {b!r}")
    assert not moved, moved


def test_every_diagnostics_block_is_there_with_its_contract_keys_and_finite_numbers(he_pad):
    from engine.layerx.analysis import DIAGNOSTIC_KEYS

    r = he_pad["result"]
    d = r["diagnostics"]
    assert set(d) == set(DIAGNOSTIC_KEYS)
    json.dumps(r, allow_nan=False)              # strict JSON: no NaN or inf anywhere in the run
    n = len(r["series"]["t"])
    for name, keys in CONTRACT.items():
        block = d[name]
        assert block.get("available", True) is not False, (name, block.get("error"))
        missing = [k for k in keys if k not in block]
        assert not missing, (name, missing)
        for k in FINITE.get(name, ()):
            assert isinstance(block[k], (int, float)) and math.isfinite(block[k]), (name, k, block[k])
    for name, keys in ROWS.items():
        rows = d[name]
        assert isinstance(rows, list) and rows, (name, rows)
        for row in rows:
            assert row.get("available", True) is not False, (name, row.get("error"))
            assert not [k for k in keys if k not in row], (name, [k for k in keys if k not in row])
    # The bottle's floor needs the regulator's capacity, which reads the recorded network.
    pr = d["pressurant"]
    assert math.isfinite(pr["required_kg"]) and math.isfinite(pr["margin_kg"]) and pr["margin_kg"] > 0
    # Lists that follow the series are as long as it.
    assert len(d["injector"]["t"]) == n and len(d["injector"]["momentum_ratio"]) == n
    # The ones on the replay's points say which steps they are.
    st = d["stability"]
    assert len(st["t"]) == len(st["margin"]) == len(st["index"])
    assert [r["series"]["t"][i] for i in st["index"]] == st["t"]
    # The model blocks are complete.
    for name in ("stability", "hardware", "start", "shutdown", "vv"):
        m = d[name]["model"]
        assert m.get("name") and m.get("source") and isinstance(m.get("assumptions"), list), name
    # D7 (2026-10-03): the block is on the drawing's lines; the design's lumped feed is the other
    # basis, whose minimum is the replay's own chug margin (to the start window's extra steps).
    assert st["basis"] == "drawing" and st["other_basis"]["basis"] == "config"
    assert st["other_basis"]["margin_min"] == pytest.approx(min(r["replay"]["chug_margin"]), rel=0.02)


def test_the_network_is_recorded_and_its_blocks_match_the_audit(he_pad):
    r = he_pad["result"]
    net, d = r["network"], r["diagnostics"]
    assert net["t"] == r["series"]["t"]
    assert set(net["paths"]) == {"ox", "fuel"}
    # The ladder telescopes: bottle to chamber, rung by rung, on every step.
    for side in ("ox", "fuel"):
        assert d["ladder"][side]["closes"] and d["ladder"][side]["max_abs_residual_psi"] < 1e-6
    # AUDIT 9.6 C: on helium the dome regulator runs at 5-18 % of its IEC choked capacity, and the
    # 1.7 Cv press solenoids cost 1.3-3.0 psi per tank.
    assert 0.05 < d["regulator"]["use_frac_max"] < 0.20 and not d["regulator"]["any_wide_open"]
    for row in d["solenoids"]:
        assert 1.0 < row["dp_max_psi"] < 3.5, row["id"]
    # The start window opens on the main valves' recorded state, not on the travel-time rule.
    assert d["stability"]["start"]["t_open_basis"] == "recorded valve state"
    # The run record carries it: about 1 MB with the network (~0.67 MB without).
    assert len(json.dumps(r, allow_nan=False)) < 2_000_000


def test_le4_limits_follow_the_decisions(he_pad):
    """The team's answers of 2026-10-03: D7 (drawing lines, eroded engine, from the first full-flow
    step), tank limits and the opening surge as information, the mains never closing."""
    r = he_pad["result"]
    g = {e["key"]: e for e in r["limits"]}
    st = r["diagnostics"]["stability"]
    assert g["chug_margin"]["value"] == pytest.approx(st["settled_min"]["margin"], rel=1e-12)
    assert g["chug_margin"]["t_worst"] > 0.05 and "decision" not in g["chug_margin"]
    assert g["chug_margin_other_basis"]["grade"] == "info"
    assert g["chug_margin_other_basis"]["value"] == pytest.approx(st["other_basis"]["margin_min"])
    # D7 raises the graded figure above the old whole-burn, lumped-feed one (1.398 -> ~1.47 on LE4).
    assert g["chug_margin"]["value"] > g["chug_margin_other_basis"]["value"]
    for key in ("water_hammer_l_fu1", "water_hammer_l_ox1", "tank_cap_ox", "tank_mawp_ox", "tank_mawp_fuel"):
        assert g[key]["grade"] == "info", key
    assert g["water_hammer_l_fu1"]["label"].startswith("Opening surge")
    # LE4 on helium: nothing to look at.
    assert not [e["key"] for e in r["limits"] if e["grade"] in ("bad", "warn")]


def test_le4_events_record_sidecar_and_cost(he_pad):
    r = he_pad["result"]
    keys = [e["key"] for e in r["events"]]
    assert len(keys) == len(set(keys)) and all(keys)
    assert {"t0", "fire", "ignition", "min_tank_ox", "min_tank_fuel", "min_chug", "dry_ox", "burnout"} <= set(keys)
    ev = {e["key"]: e for e in r["events"]}
    assert 0.0 < ev["ignition"]["t"] < 0.05 and ev["burnout"]["t"] == pytest.approx(r["summary"]["burn_time_s"])
    assert r["test_mode"] == "hotfire"
    assert r["provenance"]["derived"]["options"]["chug_basis"] == "drawing"
    models = r["provenance"]["models"]
    assert len(models) >= 10 and all(m["name"] and m["source"] for m in models)
    assert {"diagnostics.stability", "diagnostics.hardware", "diagnostics.start", "diagnostics.vv"} <= {m["block"] for m in models}
    ax = he_pad["sidecars"]["axial"]
    assert len(ax["q_MW_m2"]) == len(ax["t"]) and all(len(row) == len(ax["x_mm"]) for row in ax["q_MW_m2"])
    assert r["diagnostics"]["hardware"]["heatmap"] == "sidecar:axial"
    assert r["diagnostics"]["hardware"]["soak"]["available"]
    cost = r["provenance"]["diagnostics_wall_s"]
    assert cost["diagnostics"] < 0.10 * cost["burn"], cost


# ---------------------------------------------------------------- flight


def test_the_helium_drawing_flies_and_matches_the_audits_he_ullage_what_if(he_flight):
    r = he_flight["result"]
    f = r["flight"]
    assert f["ok"], f.get("error")
    assert f["pressurant_gas"] == "Helium"
    what_if = json.loads(BASELINE.read_text())["cases"]["he_flight_he_ullage"]["metrics"]
    m = he_flight["metrics"]
    assert m["total_impulse_Ns"] == pytest.approx(what_if["total_impulse_Ns"], rel=5e-4)
    assert m["burn_time_s"] == pytest.approx(what_if["burn_time_s"], rel=5e-4)
    assert f["apogee_agl_m"] == pytest.approx(what_if["apogee_agl_m"], abs=5.0)
    assert r["converged"] and f["stability"]["available"]
    # The flight's acceleration reaches the gas-ingestion diagnostic.
    assert "flight" in r["diagnostics"]["outflow"][0]["model"]["inputs"]["accel"]["provenance"]


def test_the_flight_settles_on_the_pad_first_then_flies_inline(he_flight, he_pad):
    from engine.layerx import flight as flt

    r = he_flight["result"]
    f = r["flight"]
    assert f["ok"] and f["coupling"] == "inline" and f["inline"]["available"]
    assert f["inline"]["vs_rocketpy"] < flt.ACCEL_TOLERANCE
    assert f["inline"]["liftoff_mass_kg"] == pytest.approx(f["liftoff_mass_kg"], abs=0.01)
    passes = r["passes"]
    pad = [p for p in passes if not p.get("accel_inline")]
    # The pad's passes are he_pad's own, and its figures are he_pad's burn.
    assert len(pad) == len(he_pad["result"]["passes"]) and len(passes) > len(pad)
    assert all(p.get("accel_inline") for p in passes[len(pad):])
    assert f["pad"]["total_impulse_Ns"] == pytest.approx(he_pad["metrics"]["total_impulse_Ns"], rel=1e-9)
    assert f["pad"]["of_mean"] == pytest.approx(he_pad["result"]["summary"]["of_mean"], rel=1e-9)
    assert f["in_flight"]["total_impulse_Ns"] == pytest.approx(he_flight["metrics"]["total_impulse_Ns"], rel=1e-9)


# ---------------------------------------------------------------- the AUDIT's trip


def test_the_audits_trip_stops_the_burn_at_the_trip(he_trip, he_pad):
    r = he_trip["result"]
    trip = r["tripped"]
    assert trip["vessel"] == "FUT" and trip["kind"] == "tank"
    assert trip["mawp_psia"] == pytest.approx(600.0 + 101325.0 / 6894.757293168361, abs=1e-6)
    assert 2.5 < trip["t"] < r["summary"]["burn_time_s"] + 1e-9 < 3.4
    s, dv = r["summary"], r["delivered"]["summary"]
    # Not the 4x horizon artefact (99,478 N s over 14.000 s): the impulse stops at the trip.
    assert s["burn_time_s"] == pytest.approx(trip["t"], abs=1e-12)
    assert r["series"]["t"][-1] == pytest.approx(trip["t"], abs=1e-12)
    assert 0.8 * FULL_IMPULSE_NS < s["total_impulse_Ns"] < FULL_IMPULSE_NS
    assert 0.8 * FULL_IMPULSE_NS < dv["total_impulse_Ns"] < FULL_IMPULSE_NS
    assert r["delivered"]["t"][-1] == pytest.approx(trip["t"], abs=1e-12)
    # Up to the trip it is the same burn as he_pad's first pass would be: the untripped burn's
    # impulse to the same instant, within the throat schedule's (one replay pass vs settled) effect.
    pad = he_pad["result"]["series"]
    upto = sum(f * dt for f, dt, on, t in zip(pad["chamber"]["thrust_N"], pad["dt"], pad["firing"], pad["t"])
               if on and t <= trip["t"] + 1e-9)
    assert s["total_impulse_Ns"] == pytest.approx(upto, rel=0.01)
    assert r["converged"] is False and len(r["passes"]) == 1 and r["passes"][0]["tripped"]
    ev = {e["key"]: e for e in r["events"]}
    assert ev["trip"]["kind"] == "fail" and ev["trip"]["t"] == pytest.approx(trip["t"])
    assert not any(e["label"] in ("Horizon reached", "Burn did not settle") for e in r["events"])
    g = {e["key"]: e for e in r["limits"]}
    # The trip is the stand stopping, graded red; the tank limit itself is information (2026-10-03).
    assert g["vessel_trip"]["grade"] == "bad" and g["tank_mawp_fuel"]["grade"] == "info"
    for name, block in r["diagnostics"].items():
        rows = block if isinstance(block, list) else [block]
        assert all(row.get("available", True) is not False for row in rows), (name, rows[0].get("error"))
    assert len(r["network"]["t"]) == len(r["series"]["t"])
