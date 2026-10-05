"""Set point (engine/layerx/setpoint.py): the dome, lockup and fill for a target mean thrust.

The solve is checked against closed-form stands, where the root is known by hand, through the same
``evaluate`` seam the burns go through. One real burn smoke test runs with ``LAYERX_SLOW=1``.

Hand numbers used below:

* Linear stand, F(L) = 7013 + 10.1 (L - 578) N (LE4's slope, docs/layerx/AUDIT.md 9.10 3.2):
  F = 7200 N at L = 578 + 187/10.1 = 596.5149 psia. The secant is exact on a line, so two opening
  burns and one Newton burn.
* Coupled stand, the same thrust plus 0.015 N per psig of fill above 4500, and the bottle spare
  S = F_fill + 14.7 - 6 L psi (a draw of 5 psi per psia of lockup, so 3000 psi at 600 psia):
  S = 100 gives F_fill = 85.3 + 6 L; substituted, (10.1 + 0.09) L = 7200 - 7013 + 5837.8
  + 0.015 * 4414.7 = 6091.0205, so L = 597.7449 psia and F_fill = 3671.77 psig.
"""

from __future__ import annotations

import math
import os
import sys
from types import SimpleNamespace
from typing import Any, Dict, List, Optional, Tuple

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.layerx import setpoint as sp  # noqa: E402

AMB = 13.64


def _stand(thrust, spare=None, *, peak_rise: float = 41.0, meop: Optional[float] = None,
           trip_above: Optional[float] = None, calls: Optional[list] = None):
    """A closed-form stand behind the ``evaluate`` seam."""

    def evaluate(points: List[Tuple[float, Optional[float], bool]]) -> List[Dict[str, Any]]:
        out = []
        for L, F, rp in points:
            if calls is not None:
                calls.append((L, F, rp))
            if trip_above is not None and L > trip_above:
                out.append({"ok": True, "preflight": [], "lockup_psia": L, "fill_psig": F, "replay": rp,
                            "tripped": {"vessel": "TK_FUEL", "t": 2.1, "p_psia": 764.7},
                            # What a trip looks like if it is not read: the frozen frame integrated to the
                            # horizon, a plausible-looking mean thrust (AUDIT finding 1).
                            "figures": {"mean_thrust_N": 7150.0, "copv_spare_psi": 900.0}, "limits": []})
                continue
            peak = L + peak_rise
            limits = []
            if meop is not None:
                limits.append({"key": "tank_peak_meop.fuel", "label": "Fuel tank peak vs MEOP", "value": peak,
                               "limit": meop + AMB, "direction": "max",
                               "grade": "bad" if peak > meop + AMB else "ok"})
            figs = {"mean_thrust_N": thrust(L, F), "of_mean": 1.5212 - 3e-5 * (L - 578.0),
                    "copv_spare_psi": spare(L, F) if spare else 900.0, "fuel_peak_psia": peak,
                    "total_impulse_Ns": thrust(L, F) * 3.45, "burn_time_s": 3.45}
            out.append({"ok": True, "preflight": [], "lockup_psia": L, "fill_psig": F, "replay": rp,
                        "dome_psig": L - 64.4 + 0.017 * (F - 4500.0), "dome_per_1000psi_fill": 17.0,
                        "figures": figs, "limits": limits, "tripped": None,
                        "derived": {"stand_ids": {"loader": "PR_C", "regulator": "PR_D", "bottle": "KB1"},
                                    "config_sha256": "c" * 64, "drawing": {"id": "d", "name": "he", "sha256": "s"}}})
        return out

    return evaluate


def linear(L: float, F: float) -> float:
    return 7013.0 + 10.1 * (L - 578.0)


def coupled(L: float, F: float) -> float:
    return linear(L, F) + 0.015 * (F - 4500.0)


def coupled_spare(L: float, F: float) -> float:
    return F + 14.7 - 6.0 * L


CONFIG = SimpleNamespace(design_requirements=SimpleNamespace(target_thrust=7200.0, optimal_of_ratio=1.5),
                         lox_tank=SimpleNamespace(initial_pressure_psi=578.0))
SETTINGS = SimpleNamespace(tank_pressure_psia=578.0, copv_pressure_psig=4500.0)
STAND = {"lockup_psia": 578.0, "fill_psig": 4500.0, "max_fill_psig": 4500.0, "reference_thrust_N": 6751.0}


def _run(evaluate, **req):
    return sp.run_setpoint(CONFIG, None, SETTINGS, [], sp.SetpointRequest(**req), evaluate=evaluate, stand=STAND)


# ------------------------------------------------------------------ the solve


def test_the_secant_lands_on_the_hand_root_of_a_linear_stand_in_three_burns():
    out = _run(_stand(linear), solve_fill=False)
    assert out["converged"] and out["burns"] == 3
    assert out["settings_card"]["lockup_psia"] == pytest.approx(578.0 + 187.0 / 10.1, abs=1e-6)  # 596.5149
    assert out["solution"]["mean_thrust_N"] == pytest.approx(7200.0, abs=1e-6)
    # The opening pair burned together, from EngineDesign's T-0 thrust: 578 * 7200 / 6751 = 616.44.
    assert [round(h["asked"]["lockup_psia"], 2) for h in out["history"][:2]] == [578.0, 616.44]


def test_a_curved_stand_converges_to_its_closed_form_root():
    """F = 300 sqrt(L): F = 7200 N at L = (7200/300)^2 = 576 psia."""
    out = _run(_stand(lambda L, F: 300.0 * math.sqrt(L)), solve_fill=False, thrust_tol_rel=1e-5)
    assert out["converged"]
    assert out["settings_card"]["lockup_psia"] == pytest.approx(576.0, rel=2e-5)
    assert out["burns"] <= 5


def test_lockup_and_fill_together_land_on_the_hand_solution():
    out = _run(_stand(coupled, coupled_spare), solve_fill=True, margin_psi=100.0, margin_tol_psi=1.0, max_burns=10)
    assert out["converged"] and out["fill_status"] == "solved"
    L, F = out["settings_card"]["lockup_psia"], out["settings_card"]["copv_fill_psig"]
    # By hand (module docstring): 597.7449 psia, 3671.77 psig. Within the stated tolerances: 7.2 N is
    # 0.71 psi of lockup, 1 psi of spare is ~1 psi of fill.
    assert L == pytest.approx(597.7449, abs=0.75)
    assert F == pytest.approx(3671.77, abs=6.0)
    assert abs(out["solution"]["mean_thrust_N"] - 7200.0) <= 7.2
    assert abs(out["solution"]["copv_spare_psi"] - 100.0) <= 1.0
    assert out["burns"] <= 7


def test_broyden_learns_the_fill_column_it_was_not_given():
    """Near dropout the spare rises only 0.5 psi per psi of fill, not the 1.0 the first Jacobian
    assumes, and the thrust-fill coupling is not the 0 it assumes. Stand: thrust as ``coupled``;
    spare S = 944 + 0.5 (F - 4500) - 5.5 (L - 600.36) (AUDIT 9.10 3.2/3.4 numbers). With
    u = L - 578, v = F - 4500 the root solves 10.1 u + 0.015 v = 187, 0.5 v - 5.5 u = -966.98:
    v = -1702.48, u = 21.0433, i.e. L = 599.043 psia, F = 2797.5 psig. A fixed first Jacobian closes the
    spare only by half each burn and runs out of burns; Broyden's update does not."""
    def spare(L, F):
        return 944.0 + 0.5 * (F - 4500.0) - 5.5 * (L - 600.36)

    out = _run(_stand(coupled, spare), solve_fill=True, margin_psi=100.0, margin_tol_psi=1.0, max_burns=8)
    assert out["converged"] and out["fill_status"] == "solved"
    assert out["settings_card"]["lockup_psia"] == pytest.approx(599.043, abs=0.75)
    assert out["settings_card"]["copv_fill_psig"] == pytest.approx(2797.5, abs=4.0)
    # Here the first Jacobian is wrong only in its fill column and the first fill step runs almost
    # along the fill, so one rank-one secant update along that step nearly corrects it: three lockup
    # burns and two fill burns. A wrong update (the outer product transposed) still creeps in, but
    # takes a sixth burn (review mutation check).
    assert out["burns"] <= 5


def test_an_accepted_fill_never_leaves_less_than_the_margin():
    """The fill band is one-sided. Stand: spare rises 1.02 psi per psi of fill, where the first
    Jacobian assumes 1.0, so the first fill step overshoots low by 2 % of the distance: from 965 psi
    at the full bottle, a two-sided +-20 psi band around 100 would accept the 82.7 psi it lands on --
    a "solved" fill that the shared ``bottle_margin`` limit (100 psi) grades bad. Aiming at 110 +- 10
    it lands at 92.9, is refused, and Broyden's update brings it into [100, 120]."""
    def spare(L, F):
        return 944.0 + 1.02 * (F - 4500.0) - 5.5 * (L - 600.36)

    out = _run(_stand(linear, spare), solve_fill=True, margin_psi=100.0, margin_tol_psi=20.0, max_burns=8)
    assert out["converged"] and out["fill_status"] == "solved"
    assert 100.0 <= out["solution"]["copv_spare_psi"] <= 120.0


def test_figures_by_hand():
    """A burn's flat figures, on the delivered basis where there is one. The bottle's spare is over the
    higher tank's T-0 pressure (the shared ``bottle_margin``'s basis), not the lockup asked for:
    706.38 - 597.93 = 108.45 psi (the builder's real LE4 burn: 108.57 over the 597.81 lockup)."""
    res = {"summary": {"mean_thrust_N": 7158.0, "peak_thrust_N": 7380.0, "min_thrust_N": 6950.0,
                       "total_impulse_Ns": 24700.0, "burn_time_s": 3.45, "of_mean": 1.5212, "copv_end_psia": 706.38,
                       "ox": {"peak_psia": 634.5, "t0_psia": 597.93, "loaded_kg": 6.5, "residual_kg": 0.0},
                       "fuel": {"peak_psia": 635.1, "t0_psia": 597.90, "loaded_kg": 4.3, "residual_kg": 0.06}},
           "delivered": {"summary": {"mean_thrust_N": 7199.4, "peak_thrust_N": 7420.0, "min_thrust_N": 6990.0},
                         "thrust_N": [None, 6980.0, 7000.0]}}
    f = sp.figures(res, 597.81)
    assert f["mean_thrust_N"] == 7199.4 and f["thrust_t0_N"] == 6980.0 and f["replayed"] is True
    assert f["thrust_spread_pct"] == pytest.approx((7420.0 - 6990.0) / 7199.4 * 100.0)
    assert f["copv_spare_psi"] == pytest.approx(706.38 - 597.93)
    assert f["fuel_used_kg"] == pytest.approx(4.24) and f["ox_used_kg"] == pytest.approx(6.5)
    # A run that reports no tank T-0 pressure falls back to the lockup asked for.
    bare = {"summary": {**res["summary"], "ox": {}, "fuel": {}}}
    assert sp.figures(bare, 597.81)["copv_spare_psi"] == pytest.approx(706.38 - 597.81)
    assert sp.figures(bare, 597.81)["replayed"] is False


def test_a_bottle_too_small_for_the_margin_is_said_not_hidden():
    out = _run(_stand(linear, lambda L, F: F + 14.7 - 7.9 * L), solve_fill=True, margin_psi=100.0)
    # At 596.5 psia a full bottle leaves 4514.7 - 7.9 * 596.5 = -197.7 psi: short.
    assert out["fill_status"] == "bottle_short"
    assert out["settings_card"]["copv_fill_psig"] == 4500.0
    assert any("cannot keep the margin" in n for n in out["notes"])


def test_a_set_point_over_the_meop_is_infeasible_and_says_where_the_limit_binds():
    """Peak = lockup + 41 psi; MEOP 585 psi + 13.64 = 598.64 psia, reached at 557.64 psia lockup,
    where the line gives 7013 + 10.1 (557.64 - 578) = 6807.4 N."""
    out = _run(_stand(linear, meop=585.0), solve_fill=False)
    assert out["converged"] and not out["feasible"]
    (b,) = out["binding"]
    assert b["key"] == "tank_peak_meop.fuel"
    assert b["lockup_psia_est"] == pytest.approx(557.64, abs=1e-6)
    assert b["mean_thrust_N_est"] == pytest.approx(6807.36, abs=0.01)


def test_a_trip_is_never_a_root():
    """The stand trips above 610 psia: the opening guess (616.4) trips, the solve still finds 596.5."""
    calls: list = []
    out = _run(_stand(linear, trip_above=610.0, calls=calls), solve_fill=False)
    assert out["converged"]
    assert out["settings_card"]["lockup_psia"] == pytest.approx(596.5149, abs=0.75)
    assert not out["solution"].get("tripped")


def test_a_target_beyond_a_trip_homes_on_the_trip_and_says_so():
    """7400 N needs 616.3 psia on the line, but the stand trips above 605 psia. Each burn that trips
    bounds the next step at halfway to it, so the solve closes on the highest usable lockup."""
    out = _run(_stand(linear, trip_above=605.0), solve_fill=False, target_thrust_N=7400.0)
    assert not out["converged"]
    assert 604.0 < out["settings_card"]["lockup_psia"] <= 605.0
    assert not out["solution"].get("tripped")
    assert any("trips the stand" in n for n in out["notes"])


def test_without_the_replay_the_answer_is_verified_with_it_and_corrected_once():
    """The replay adds a constant +41 N (AUDIT 9.10 4a: 7013 vs 6972 N at 578 psia)."""
    calls: list = []

    def thrust(L, F):
        return linear(L, F)

    base = _stand(thrust, calls=calls)

    def evaluate(points):
        out = base(points)
        for p, (_, _, rp) in zip(out, points):
            if rp:
                p["figures"]["mean_thrust_N"] += 41.0
        return out

    out = _run(evaluate, solve_fill=False, replay=False, verify=True)
    assert [c[2] for c in calls][-2:] == [True, True]          # verify, then the corrected verify
    assert out["solution"]["mean_thrust_N"] == pytest.approx(7200.0, abs=1e-6)
    assert out["settings_card"]["lockup_psia"] == pytest.approx(578.0 + (187.0 - 41.0) / 10.1, abs=1e-6)


# ------------------------------------------------------------------ the outputs


def test_the_card_change_list_and_model_block():
    from engine.layerx import diff

    out = _run(_stand(linear), solve_fill=False)
    card = out["settings_card"]
    assert card["dome_psig"] == pytest.approx(card["lockup_psia"] - 64.4)
    assert card["fuel_lead"].startswith("not modelled")
    cl = out["change_list"]
    assert cl["schema"] == diff.SCHEMA and cl["tool"] == "setpoint"
    by = {c["target"]: c for c in cl["changes"]}
    assert set(by) == {"op:dome_psig", "op:lockup_psia"}             # the fill did not move
    for c in cl["changes"]:
        assert c["cad_impact"] == "setting only" and c["domain"] == "operation" and c["provenance"].startswith("solved")
        assert set(c) >= {"component", "pid_node_id", "field", "before", "after", "unit", "provenance", "effect", "cad_impact"}
    assert by["op:lockup_psia"]["pid_node_id"] == "PR_D" and by["op:dome_psig"]["pid_node_id"] == "PR_C"
    assert by["op:lockup_psia"]["effect"]["mean_thrust_N"] == pytest.approx(187.0, abs=1e-6)
    assert cl["exports"]["settings_patch"] == {"tank_pressure_psia": pytest.approx(596.51, abs=0.01)}
    m = out["model"]
    assert m["name"] and "Broyden" in m["source"] and m["assumptions"]
    for name, v in m["inputs"].items():
        assert set(v) == {"value", "unit", "provenance"}, name
    assert out["of"]["settable_here"] is False and out["of"]["offset_rel"] == pytest.approx(
        out["solution"]["of_mean"] / 1.5 - 1.0)
    assert out["unmeasured"] and out["summary"]["lockup_psia"] == card["lockup_psia"]


def test_the_target_defaults_to_the_design_and_refuses_none():
    assert sp.target_thrust(CONFIG, sp.SetpointRequest())[0] == 7200.0
    assert sp.target_thrust(CONFIG, sp.SetpointRequest(target_thrust_N=6800.0)) == (6800.0, "request")
    with pytest.raises(ValueError, match="target thrust"):
        sp.target_thrust(SimpleNamespace(design_requirements=None), sp.SetpointRequest())


# ------------------------------------------------------------------ the grade it uses


def test_the_fallback_grade_by_hand():
    """Peaks 642.0 (LOX) / 642.5 (fuel) psia at 13.64 psia ambient: MAWP 1000 psi -> 1013.64 psia, ok;
    the design cap 600 -> warn (AUDIT D11); fuel MEOP 625 psi -> 638.64 psia, bad by 3.86 psi."""
    pytest.importorskip("feedtwin")
    res = {"summary": {"ox": {"peak_psia": 642.0, "stiffness_min": 0.37, "min_psia": 600.0, "residual_kg": 0.0},
                       "fuel": {"peak_psia": 642.5, "stiffness_min": 0.36, "min_psia": 600.0, "residual_kg": 0.07},
                       "copv_end_psia": 1544.4, "total_impulse_Ns": 24000.0, "impulse_to_depletion_Ns": 24000.0,
                       "failed_steps": 0},
           "converged": True}
    prep = SimpleNamespace(derived={"target_lockup_psia": 600.36, "ambient_pa": AMB * sp.PSI,
                                    "tank_mawp_psi": {"TK_LOX": 1000.0, "TK_FUEL": 1000.0},
                                    "stiffness_band": {"oxidiser": [0.2, 0.4], "fuel": [0.2, 0.4]}},
                           roles={"oxidiser": "TK_LOX", "fuel": "TK_FUEL"})
    config = SimpleNamespace(design_requirements=SimpleNamespace(max_lox_tank_pressure_psi=600.0,
                                                                 max_fuel_tank_pressure_psi=600.0))
    rows = {r["key"]: r for r in sp._fallback_limits(res, prep, config, {"margin_psi": 100.0})}
    assert rows["dropout"]["value"] == pytest.approx(1544.4 - 600.36) and rows["dropout"]["grade"] == "ok"
    assert rows["tank_peak_mawp.fuel"]["limit"] == pytest.approx(1013.64) and rows["tank_peak_mawp.fuel"]["grade"] == "ok"
    assert rows["tank_peak_cap.oxidiser"]["grade"] == "warn"
    graded, basis = sp.grade_limits(res, prep, config, {"margin_psi": 100.0, "meop_psi": {"fuel": 625.0}})
    by = {r["key"]: r for r in graded}
    assert by["tank_peak_meop.fuel"]["limit"] == pytest.approx(638.64) and by["tank_peak_meop.fuel"]["grade"] == "bad"
    assert by["vessel_trip"]["grade"] == "ok"
    assert not sp.feasible({"ok": True, "figures": {"mean_thrust_N": 1.0}, "limits": graded})
    tripped, _ = sp.grade_limits({**res, "tripped": {"vessel": "TK_FUEL"}}, prep, config, {"margin_psi": 100.0})
    assert next(r for r in tripped if r["key"] == "vessel_trip")["grade"] == "bad"


def test_the_shared_grade_gets_the_meop_and_it_is_graded_once(monkeypatch):
    """With engine/layerx/diag/limits.py present, the request's MEOP is handed to it (graded on the
    contract's basis, psi across the wall) and the set point adds no second MEOP row of its own."""
    from engine.layerx.diag import limits

    seen = {}

    def shared(result, prep=None, config=None, *, meop_psi=None):
        seen["meop_psi"] = meop_psi
        across = 642.5 - AMB
        return [{"key": "tank_meop_fuel", "label": "Fuel tank peak vs MEOP", "group": "tanks", "value": across,
                 "unit": "psi", "limit": 625.0, "warn": None, "direction": "max", "grade": "bad"}]

    monkeypatch.setattr(limits, "grade", shared)
    prep = SimpleNamespace(derived={"ambient_pa": AMB * sp.PSI})
    rows, basis = sp.grade_limits({"summary": {"fuel": {"peak_psia": 642.5}}}, prep, None,
                                  {"margin_psi": 100.0, "meop_psi": {"fuel": 625.0}})
    assert seen["meop_psi"] == {"fuel": 625.0} and basis == "engine.layerx.diag.limits.grade"
    assert [r["key"] for r in rows if "meop" in r["key"]] == ["tank_meop_fuel"]
    assert [r["key"] for r in rows if r["key"] == "vessel_trip"] == ["vessel_trip"]


# ------------------------------------------------------------------ the route


def test_the_route_refuses_before_a_slot_is_taken(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.routers import layerx as lx
    from backend.session import UserSession, get_session

    monkeypatch.setenv("USERDATA_DIR", str(tmp_path))
    session = UserSession(f"setpoint-{tmp_path.name}")
    app = FastAPI()
    app.include_router(lx.router)
    app.dependency_overrides[get_session] = lambda: session
    client = TestClient(app)
    bad = client.post("/api/layerx/setpoint", json={"settings": {"drawing_id": "d"}, "meop_psi": {"lox": 750}})
    assert bad.status_code == 422
    r = client.post("/api/layerx/setpoint", json={"settings": {"drawing_id": "d"}})
    assert r.status_code in (400, 404)                       # no design loaded / no drawing: refused
    with lx._JOBS_LOCK:
        assert not [j for j in lx._JOBS.values() if j.user == session.user]


# ------------------------------------------------------------------ one real burn pair


@pytest.mark.skipif(os.environ.get("LAYERX_SLOW") != "1", reason="burns: set LAYERX_SLOW=1")
def test_smoke_the_real_stand_reaches_a_target_in_three_burns():
    """LE4 on the He drawing, on the pad, no replay (as-built throat): AUDIT 9.10 3.2 measured 6972 N at
    578 psia and 7196 N at 600 psia. Target 7100 N: the answer lies between, ~589.5 psia."""
    pytest.importorskip("feedtwin")
    from engine.layerx import DrawingStore, LayerXSettings
    from engine.pipeline.io import load_config

    drawings = {d.name: d for d in DrawingStore(None).list()}
    if "copv_study_he" not in drawings:
        pytest.skip("feed-twin's shipped drawings are not next to this checkout")
    config = load_config(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                      "configs", "ethalox_6800N.yaml"))
    settings = LayerXSettings(drawing_id=drawings["copv_study_he"].id, replay=False, flight=False)
    out = sp.run_setpoint(config, drawings["copv_study_he"], settings, [],
                          sp.SetpointRequest(target_thrust_N=7100.0, solve_fill=False, replay=False, verify=False,
                                             thrust_tol_rel=5e-3, max_burns=3), workers=2)
    assert out["burns"] <= 3
    assert abs(out["solution"]["mean_thrust_N"] / 7100.0 - 1.0) < 5e-3
    assert 580.0 < out["settings_card"]["lockup_psia"] < 600.0
    assert out["settings_card"]["dome_psig"] is not None
    assert out["limits"], "every burn is graded"
