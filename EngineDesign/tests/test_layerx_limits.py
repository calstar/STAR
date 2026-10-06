"""One graded list of limits for a Layer X burn (engine/layerx/diag/limits.py).

What these check, and against what:

* **Today's UI grades.** ``verdictItems`` in ``frontend/src/components/layerx/LayerXResult.tsx`` is
  transcribed below, line for line, as an independent oracle (``_ui_verdict``), and every saved burn
  in ``.userdata`` (read only) must grade the same through :func:`grade`. The saved runs are the
  user's; when none is present the parity test skips and the hand-built results below still run.
* **Worst-case times, by hand.** For the 2026-10-02 flown GN2 run ``7e47d1`` the audit (AUDIT 9.9 D)
  worked out each limit's worst time from the series by hand: LOX dP/Pc 0.3082 at 0.75 s, fuel
  0.2858 at 0.20 s, both tank peaks at burnout (3.466 s), the sag at 0.40 s (fuel), chug 1.2046 at
  0.80 s. Those numbers are asserted.
* **The index is the time.** For every series-backed limit on every saved run, the series value at
  ``index_worst`` is the graded value and ``series.t[index_worst]`` is ``t_worst``.
* **Each new grader on a hand-built result**: thresholds at, just inside and just outside their
  edges, so a flipped comparison or a wrong default goes red.
"""

from __future__ import annotations

import copy
import glob
import json
import math
from pathlib import Path

import pytest

from engine.layerx.diag.limits import THRESHOLDS, breaks, grade, overall, requirements

RUNS = Path(__file__).resolve().parents[1] / ".userdata" / "local" / "engine" / "layerx" / "runs"
REFERENCE = RUNS / "20261002-231658-7e47d1.json"
PSI = 6894.757293168361


def _saved_burns():
    out = []
    for f in sorted(glob.glob(str(RUNS / "*.json"))):
        try:
            d = json.loads(Path(f).read_text())
        except Exception:  # noqa: BLE001 - a half-written run is not a test input
            continue
        if d.get("kind") == "run" and isinstance(d.get("result"), dict) and d["result"].get("series"):
            out.append((Path(f).name, d["result"]))
    return out


SAVED = _saved_burns()
needs_saved = pytest.mark.skipif(not SAVED, reason="no saved Layer X burns in .userdata (the user's runs)")


def _by_key(entries):
    return {e["key"]: e for e in entries}


# ---------------------------------------------------------------- the UI, transcribed


VERDICT = {"copvHeadroomPsi": 100, "droopPsi": (30, 60), "residualKg": 0.2, "stiffnessFloor": 0.15,
           "chugMarginWarn": 1.2, "ratingUse": 0.8, "depletionTie": 0.03, "replayAgreement": (0.005, 0.02)}


def _ui_verdict(result):
    """``verdictItems`` + the context ``LayerXResultView`` builds, as the UI ran on 2026-10-02.
    Returns {my key: grade} for the items the UI would show."""
    s = result["summary"]
    prov = result.get("provenance") or {}
    d = prov.get("derived") or {}
    band = d.get("stiffness_band") or {}
    roles = d.get("roles") or {}
    mawps = d.get("tank_mawp_psi") or {}
    ambient = d["ambient_pa"] / PSI if isinstance(d.get("ambient_pa"), (int, float)) else 14.6959
    dvs = (result.get("delivered") or {}).get("summary")
    out = {}

    def stiff(v, b):
        if v is None:
            return "warn"
        if b:
            return "bad" if v < b[0] else "warn" if v > b[1] else "ok"
        return "bad" if v < VERDICT["stiffnessFloor"] else "ok"

    if dvs and dvs.get("chug_margin_min") is not None and math.isfinite(dvs["chug_margin_min"]):
        m = dvs["chug_margin_min"]
        out["chug_margin"] = "bad" if m < 1 else "warn" if m < VERDICT["chugMarginWarn"] else "ok"
    out["stiffness_ox"] = stiff(s["ox"].get("stiffness_min"), band.get("oxidiser"))
    out["stiffness_fuel"] = stiff(s["fuel"].get("stiffness_min"), band.get("fuel"))
    for side, short in (("oxidiser", "ox"), ("fuel", "fuel")):
        peak = s[short].get("peak_psia")
        rating = mawps.get(roles.get(side))
        if peak is None or rating is None:
            continue
        use = (peak - ambient) / rating
        # Information since 2026-10-03 (the team: "don't worry about tank limits for now").
        out[f"tank_mawp_{short}"] = "info"
    lockup = max(s["ox"]["t0_psia"], s["fuel"]["t0_psia"])
    margin = s["copv_end_psia"] - lockup if s.get("copv_end_psia") is not None else None
    h = VERDICT["copvHeadroomPsi"]
    out["bottle_margin"] = "warn" if margin is None else "bad" if margin < h else "warn" if margin < 2 * h else "ok"
    droop = max(s["ox"]["t0_psia"] - (s["ox"].get("min_psia") if s["ox"].get("min_psia") is not None else s["ox"]["t0_psia"]),
                s["fuel"]["t0_psia"] - (s["fuel"].get("min_psia") if s["fuel"].get("min_psia") is not None else s["fuel"]["t0_psia"]))
    out["tank_sag"] = "bad" if droop > VERDICT["droopPsi"][1] else "warn" if droop > VERDICT["droopPsi"][0] else "ok"
    side = s.get("depleted_side")
    residual = s["fuel"]["residual_kg"] if side == "oxidiser" else s["ox"]["residual_kg"] if side == "fuel" else None
    if residual is not None:
        tie = VERDICT["depletionTie"] * (s["ox"]["loaded_kg"] + s["fuel"]["loaded_kg"])
        # Information since 2026-10-03 (the team: one tank always runs dry first).
        out["depletion_tie"] = "info"
        if residual > VERDICT["residualKg"]:
            out["residual"] = "warn"
    if result.get("converged") is False:
        out["unsettled"] = "warn"
    if s.get("card_outside_steps"):
        out["card_outside"] = "warn"
    ec = result.get("engine_check") or {}
    if ec.get("available") and ec.get("worst"):
        w = ec["worst"]
        gap = max(w["pc"], w["mdot_O"], w["mdot_F"], 0 if ec.get("against") == "replay" else w["thrust"])
        if gap >= VERDICT["replayAgreement"][0]:
            out["engine_fit"] = "warn" if gap < VERDICT["replayAgreement"][1] else "bad"
    if s.get("failed_steps") or not s.get("t0_settled"):
        out["solver"] = "warn"
    return out


@needs_saved
@pytest.mark.parametrize("name,result", SAVED, ids=[n for n, _ in SAVED])
def test_every_saved_burn_grades_as_the_ui_graded_it(name, result):
    ui = _ui_verdict(result)
    mine = _by_key(grade(result))
    for key, g in ui.items():
        assert key in mine, f"{name}: the UI grades {key}, the server does not"
        assert mine[key]["grade"] == g, f"{name}: {key} is {mine[key]['grade']} here, {g} in the UI"
    # What the UI showed only when it was off is graded ok here, never worse.
    for key in ("residual", "card_outside", "engine_fit", "solver"):
        if key in mine and key not in ui:
            assert mine[key]["grade"] == "ok", f"{name}: {key} graded {mine[key]['grade']} where the UI showed nothing"
    # The overall verdict agrees whenever the server adds nothing the UI did not grade.
    extra = {k for k, e in mine.items() if k not in ui and e["grade"] in ("warn", "bad")}
    if not extra:
        ui_overall = "bad" if "bad" in ui.values() else "warn" if "warn" in ui.values() else "ok"
        assert overall(list(mine.values())) == ui_overall


@pytest.mark.skipif(not REFERENCE.is_file(), reason="the 2026-10-02 reference run 7e47d1 is not in .userdata")
def test_the_reference_run_matches_the_audits_hand_worked_worst_times():
    """AUDIT 9.9 D, worked by hand from the series of run 7e47d1."""
    result = json.loads(REFERENCE.read_text())["result"]
    g = _by_key(grade(result))
    assert g["chug_margin"]["value"] == pytest.approx(1.2046, abs=1e-4)
    assert g["chug_margin"]["t_worst"] == pytest.approx(0.80, abs=1e-9)
    assert g["chug_margin"]["grade"] == "ok"
    assert g["stiffness_ox"]["value"] == pytest.approx(0.3082, abs=1e-4)
    assert g["stiffness_ox"]["t_worst"] == pytest.approx(0.75, abs=1e-9)
    assert g["stiffness_fuel"]["value"] == pytest.approx(0.2858, abs=1e-4)
    assert g["stiffness_fuel"]["t_worst"] == pytest.approx(0.20, abs=1e-9)
    # The ignition minimum the summary leaves out: 0.2860 at 0.15 s, reported, not graded.
    assert g["stiffness_fuel_ignition"]["value"] == pytest.approx(0.2860, abs=1e-4)
    assert g["stiffness_fuel_ignition"]["t_worst"] == pytest.approx(0.15, abs=1e-9)
    assert g["stiffness_fuel_ignition"]["grade"] == "info"
    for short in ("ox", "fuel"):
        assert g[f"tank_mawp_{short}"]["t_worst"] == pytest.approx(3.4663, abs=1e-4)
    assert g["tank_mawp_ox"]["value"] == pytest.approx(580.28 - 94069.72225 / PSI, abs=0.01)
    assert g["bottle_margin"]["value"] == pytest.approx(1405.71 - 578.05, abs=0.01)
    assert g["tank_sag"]["value"] == pytest.approx(578.0486 - 552.0311, abs=1e-3)
    assert g["tank_sag"]["t_worst"] == pytest.approx(0.40, abs=1e-9)
    assert g["depletion_tie"]["grade"] == "info" and g["depletion_tie"]["value"] == pytest.approx(0.0177, abs=1e-4)
    # The design cap (600 psi) is read from the YAML the run recorded.
    assert g["tank_cap_fuel"]["limit"] == 600.0 and g["tank_cap_fuel"]["grade"] == "info"
    # Its only amber was which tank runs dry first, information since 2026-10-03.
    assert overall(list(g.values())) == "ok"


SERIES_BACKED = {"stiffness_ox": "ox.stiffness", "stiffness_fuel": "fuel.stiffness",
                 "tank_mawp_ox": "ox.tank_psia", "tank_mawp_fuel": "fuel.tank_psia",
                 "tank_cap_ox": "ox.tank_psia", "tank_cap_fuel": "fuel.tank_psia"}


@needs_saved
@pytest.mark.parametrize("name,result", SAVED, ids=[n for n, _ in SAVED])
def test_the_worst_index_points_at_the_graded_value(name, result):
    series = result["series"]
    d = result["provenance"].get("derived") or {}
    ambient = d.get("ambient_pa", 101325.0) / PSI
    t = series["t"]
    for e in grade(result):
        i = e["index_worst"]
        if i is not None:
            assert 0 <= i < len(t)
            if e["group"] == "flight":
                # Flight limits are timed on RocketPy's trajectory samples (max-Q at 3.4334 s on the
                # 2026-10-03 He flights), not on the twin's steps: the index is the step nearest them.
                nearest = min(range(len(t)), key=lambda k: abs(t[k] - e["t_worst"]))
                assert i == nearest, f"{name}: {e['key']}"
            else:
                assert t[i] == pytest.approx(e["t_worst"], abs=1e-9), f"{name}: {e['key']}"
        path = SERIES_BACKED.get(e["key"])
        if path is None:
            continue
        side, col = path.split(".")
        v = series[side][col][i]
        expect = v - ambient if e["key"].startswith("tank_mawp") else v
        assert expect == pytest.approx(e["value"], rel=1e-12), f"{name}: {e['key']} at index {i}"


# ---------------------------------------------------------------- hand-built results


def _result(n=8, dt=0.05):
    """A small burn: two lead-in samples, ``n`` firing steps, dull numbers."""
    t = [-0.05, 0.0] + [dt * (k + 1) for k in range(n)]
    firing = [False, False] + [True] * n
    flat = lambda v: [v] * len(t)  # noqa: E731
    side = lambda: {"tank_psia": flat(578.0), "stiffness": [0.0, 0.0] + [0.30] * n,  # noqa: E731
                    "liquid_kg": flat(5.0)}
    s = {"ox": side(), "fuel": side()}
    summary = {
        "depleted_side": "oxidiser", "burn_time_s": t[-1], "copv_end_psia": 1500.0, "copv_t0_psia": 4500.0,
        "ox": {"t0_psia": 578.0, "min_psia": 570.0, "stiffness_min": 0.30, "peak_psia": 578.0,
               "loaded_kg": 6.0, "residual_kg": 0.0},
        "fuel": {"t0_psia": 578.0, "min_psia": 572.0, "stiffness_min": 0.30, "peak_psia": 578.0,
                 "loaded_kg": 4.0, "residual_kg": 0.5},
        "failed_steps": 0, "t0_settled": True, "card_outside_steps": 0, "steps": len(t),
    }
    return {
        "series": {"t": t, "dt": [dt] * len(t), "firing": firing, "converged": [True] * len(t),
                   "copv_psia": flat(1500.0), **s},
        "summary": summary,
        "events": [],
        "converged": True,
        "provenance": {"derived": {"stiffness_band": {"oxidiser": [0.2, 0.4], "fuel": [0.2, 0.4]},
                                   "roles": {"oxidiser": "OXT", "fuel": "FUT"},
                                   "tank_mawp_psi": {"OXT": 1000.0, "FUT": 1000.0},
                                   "ambient_pa": 101325.0}},
    }


def test_a_burn_with_nothing_to_grade_grades_nothing():
    assert grade({}) == []
    assert grade({"series": {"t": []}}) == []


def test_chug_from_the_stability_diagnostics_grades_the_settled_minimum_and_reports_the_start():
    r = _result()
    r["diagnostics"] = {"stability": {
        "basis": "drawing", "t": r["series"]["t"], "margin": [None, None] + [1.15, 1.3, 1.31, 1.32, 1.33, 1.34, 1.35, 1.36],
        "worst": {"t": 0.05, "index": 2, "margin": 1.15, "frequency_hz": 34.6},
        "settled_min": {"t": 0.10, "index": 3, "margin": 1.30, "frequency_hz": 22.0}, "start_window_s": 0.1,
        "other_basis": {"basis": "config", "margin_min": 1.25, "t": 0.1}}}
    g = _by_key(grade(r))
    assert g["chug_margin"]["value"] == 1.30 and g["chug_margin"]["t_worst"] == 0.10
    assert g["chug_margin"]["index_worst"] == 3
    # The frequency travels with the graded point, not with the start window's worst (AUDIT 5.1).
    assert g["chug_margin"]["frequency_hz"] == 22.0 and g["chug_margin_start"]["frequency_hz"] == 34.6
    assert g["chug_margin"]["series_ref"] == "diagnostics.stability.margin"
    assert g["chug_margin"]["grade"] == "ok" and "drawing feed basis" in g["chug_margin"]["basis"]
    assert g["chug_margin_start"]["grade"] == "info" and g["chug_margin_start"]["value"] == 1.15
    assert g["chug_margin_start"]["index_worst"] == 2
    assert g["chug_margin_other_basis"]["grade"] == "info"


@pytest.mark.parametrize("margin,expect", [(0.99, "bad"), (1.0, "warn"), (1.19, "warn"), (1.2, "ok"), (1.5, "ok")])
def test_chug_margin_is_red_below_one_and_amber_below_one_point_two(margin, expect):
    r = _result()
    r["delivered"] = {"t": r["series"]["t"][2:], "chug_margin": [margin] * 8,
                      "summary": {"chug_margin_min": margin, "chug_margin_min_t": 0.05}}
    g = _by_key(grade(r))
    assert g["chug_margin"]["grade"] == expect
    assert g["chug_margin"]["limit"] == 1.0 and g["chug_margin"]["warn"] == 1.2


def test_the_chug_amber_edge_follows_a_requirement_above_one_point_two_but_never_below_it():
    r = _result()
    r["delivered"] = {"t": r["series"]["t"][2:], "chug_margin": [1.3] * 8,
                      "summary": {"chug_margin_min": 1.3, "chug_margin_min_t": 0.05}}

    class Cfg:
        class design_requirements:  # noqa: N801 - mimics the config attribute
            min_stability_margin = 1.05

    assert _by_key(grade(r, config=Cfg))["chug_margin"]["warn"] == 1.2
    Cfg.design_requirements.min_stability_margin = 1.5
    g = _by_key(grade(r, config=Cfg))["chug_margin"]
    assert g["warn"] == 1.5 and g["grade"] == "warn"
    assert "1.5" in g["hint"]


def test_the_delivered_chug_minimum_maps_onto_the_series_by_firing_step():
    r = _result()
    col = [1.4, 1.35, 1.3, 1.25, 1.21, 1.3, 1.4, 1.5]
    r["delivered"] = {"t": r["series"]["t"][2:], "chug_margin": col,
                      "summary": {"chug_margin_min": 1.21, "chug_margin_min_t": 0.25}}
    g = _by_key(grade(r))["chug_margin"]
    assert g["index_worst"] == 2 + 4 and r["series"]["t"][g["index_worst"]] == pytest.approx(0.25)


def test_stiffness_band_edges_and_the_rule_of_thumb_without_a_band():
    r = _result()
    r["summary"]["ox"]["stiffness_min"] = 0.199
    r["summary"]["fuel"]["stiffness_min"] = 0.401
    g = _by_key(grade(r))
    assert g["stiffness_ox"]["grade"] == "bad" and g["stiffness_fuel"]["grade"] == "warn"
    assert g["stiffness_ox"]["band"] == [0.2, 0.4]
    r["provenance"]["derived"]["stiffness_band"] = {"oxidiser": None, "fuel": None}
    r["summary"]["ox"]["stiffness_min"] = 0.149
    r["summary"]["fuel"]["stiffness_min"] = 0.9
    g = _by_key(grade(r))
    assert g["stiffness_ox"]["grade"] == "bad" and g["stiffness_ox"]["limit"] == THRESHOLDS["stiffness_floor"]["value"]
    assert g["stiffness_fuel"]["grade"] == "ok"


def test_stiffness_worst_time_ignores_the_first_fifth_of_a_second():
    r = _result()
    st = r["series"]["ox"]["stiffness"]
    st[2] = 0.10          # t = 0.05: the start, left out of the graded minimum
    st[6] = 0.25          # t = 0.25: the graded minimum
    r["summary"]["ox"]["stiffness_min"] = 0.25
    g = _by_key(grade(r))["stiffness_ox"]
    assert g["index_worst"] == 6 and g["t_worst"] == pytest.approx(0.25)


def test_tank_peak_against_mawp_meop_and_the_design_cap():
    r = _result()
    r["series"]["fuel"]["tank_psia"][5] = 619.0
    r["summary"]["fuel"]["peak_psia"] = 619.0
    ambient = 101325.0 / PSI

    class Cfg:
        class design_requirements:  # noqa: N801
            max_lox_tank_pressure_psi = 600.0
            max_fuel_tank_pressure_psi = 600.0

    g = _by_key(grade(r, config=Cfg, meop_psi={"fuel": 600.0}))
    assert g["tank_mawp_fuel"]["value"] == pytest.approx(619.0 - ambient)
    assert g["tank_mawp_fuel"]["index_worst"] == 5
    # The tank limits are reported, not graded (the team, 2026-10-03: "don't worry about tank limits
    # for now"): MAWP, MEOP (619 - 14.7 = 604.3 psi > 600) and the design cap are all information.
    assert {g[k]["grade"] for k in ("tank_mawp_fuel", "tank_cap_fuel", "tank_cap_ox", "tank_meop_fuel")} == {"info"}
    assert "tank_meop_ox" not in g
    r["provenance"]["derived"]["tank_mawp_psi"]["FUT"] = 600.0
    assert _by_key(grade(r))["tank_mawp_fuel"]["grade"] == "info"


def test_a_design_cap_the_design_never_stated_is_reported_not_graded():
    """``max_*_tank_pressure_psi`` default to 700 / 850 psi in the schema with no source. A design that
    states its caps (LE4: 600 / 600) is graded against them; one that does not gets the default
    reported as information, and says so, rather than amber against a number nobody chose."""
    from engine.pipeline.config_schemas import DesignRequirementsConfig

    r = _result()
    r["series"]["ox"]["tank_psia"][5] = 710.0
    r["summary"]["ox"]["peak_psia"] = 710.0

    class Stated:
        design_requirements = DesignRequirementsConfig(max_lox_tank_pressure_psi=700.0,
                                                       max_fuel_tank_pressure_psi=850.0, min_stability_margin=1.05)

    class Unstated:
        design_requirements = DesignRequirementsConfig()

    stated = _by_key(grade(r, config=Stated))["tank_cap_ox"]
    assert stated["limit"] == 700.0 and stated["grade"] == "info" and stated["cap_source"] == "design_requirements"
    unstated = _by_key(grade(r, config=Unstated))["tank_cap_ox"]
    assert unstated["limit"] == 700.0 and unstated["grade"] == "info" and unstated["cap_source"] == "schema default"
    assert "schema's default" in unstated["basis"]
    # The amber edge of chug does not move (max(1.2, 1.2)), but the hint names the default as one.
    r["delivered"] = {"t": r["series"]["t"][2:], "chug_margin": [1.3] * 8,
                      "summary": {"chug_margin_min": 1.3, "chug_margin_min_t": 0.05}}
    assert "does not state" in _by_key(grade(r, config=Unstated))["chug_margin"]["hint"]
    assert "does not state" not in _by_key(grade(r, config=Stated))["chug_margin"]["hint"]


def test_bottle_sag_and_depletion_edges():
    r = _result()
    r["summary"]["copv_end_psia"] = 578.0 + 99.0
    r["summary"]["fuel"]["min_psia"] = 578.0 - 31.0
    r["series"]["fuel"]["tank_psia"][4] = 578.0 - 31.0
    r["summary"]["fuel"]["residual_kg"] = 0.29        # tie = 0.03 * 10 kg = 0.30
    g = _by_key(grade(r))
    assert g["bottle_margin"]["grade"] == "bad" and g["bottle_margin"]["value"] == pytest.approx(99.0)
    assert g["tank_sag"]["grade"] == "warn" and g["tank_sag"]["index_worst"] == 4
    assert g["depletion_tie"]["grade"] == "info" and g["residual"]["grade"] == "warn"
    assert "LOX runs dry first" in g["depletion_tie"]["detail"]
    r["summary"]["copv_end_psia"] = 578.0 + 201.0
    r["summary"]["fuel"]["residual_kg"] = 0.2
    g = _by_key(grade(r))
    assert g["bottle_margin"]["grade"] == "ok" and g["residual"]["grade"] == "ok"


def test_a_burn_that_never_ran_dry_says_so():
    r = _result()
    r["summary"]["depleted_side"] = ""
    g = _by_key(grade(r))
    assert g["depletion"]["grade"] == "warn" and "depletion_tie" not in g


def test_a_vessel_trip_is_red_at_its_instant():
    r = _result()
    r["tripped"] = {"vessel": "FUT", "t": 0.2, "p_psia": 764.7, "mawp_psia": 764.7}
    r["converged"] = False
    g = _by_key(grade(r))
    assert g["vessel_trip"]["grade"] == "bad" and g["vessel_trip"]["index_worst"] == 5
    assert g["unsettled"]["grade"] == "warn"
    assert any("Vessel trip" in b for b in breaks(list(g.values())))


def test_diagnostics_blocks_are_graded_when_present_and_skipped_when_absent():
    r = _result()
    base = {e["key"] for e in grade(r)}
    assert not any(k.startswith(("saturation_", "cavitation_", "water_hammer_", "regulator_", "conservation_"))
                   for k in base)
    n = len(r["series"]["t"])
    r["diagnostics"] = {
        "saturation": {"nodes": [{"id": "OXT.out", "label": "LOX tank outlet", "side": "ox",
                                  "margin_psi": [None, 30.0] + [20.0, 9.0, 12.0, 15.0, 16.0, 17.0, 18.0, 19.0],
                                  "min_psi": 9.0, "t_min": 0.10}]},
        "cavitation": {"ox": {"margin": [None, None, 2.0, 1.9, 1.8, 1.1, 1.5, 1.6, 1.7, 1.8], "min_margin": 1.1,
                              "min_K": 1.76, "K_incipient": 1.6, "t_min": 0.2, "flip_risk": False},
                       "fuel": {"margin": [None] * n, "min_margin": 0.9, "min_K": 1.4, "K_incipient": 1.6,
                                "t_min": 0.2, "flip_risk": True}},
        "water_hammer": [{"line": "l_ox1", "side": "ox", "closure_s": 0.05, "peak_psia": 2900.0, "rating_psia": 1014.7,
                          "ok": False, "opening": {"peak_psia": 900.0}}],
        "regulator": {"t": r["series"]["t"], "use_frac": [0.1] * (n - 1) + [0.85], "wide_open": [False] * n},
        "vv": {"mass": {"ox": {"error_pct": 1e-7}, "fuel": {"error_pct": 0.5}},
               "pressurant": {"error_pct": 3.0}, "energy": {"error_pct": 12.0, "basis": "x"}},
    }
    g = _by_key(grade(r))
    assert g["saturation_OXT.out"]["grade"] == "warn" and g["saturation_OXT.out"]["index_worst"] == 3
    assert g["cavitation_ox"]["grade"] == "warn" and g["cavitation_ox"]["index_worst"] == 5
    assert g["cavitation_fuel"]["grade"] == "bad" and g["cavitation_fuel"]["index_worst"] == 5
    # The mains never close (the team, 2026-10-03): only the opening surge is listed, as information,
    # and the closing figure (2900 here) is not graded.
    assert g["water_hammer_l_ox1"]["grade"] == "info" and g["water_hammer_l_ox1"]["value"] == 900.0
    assert g["regulator_wide_open"]["grade"] == "warn" and g["regulator_wide_open"]["index_worst"] == n - 1
    assert g["conservation_mass_ox"]["grade"] == "ok"
    assert g["conservation_mass_fuel"]["grade"] == "warn"
    assert g["conservation_pressurant"]["grade"] == "bad"
    assert g["conservation_energy"]["grade"] == "info"
    r["diagnostics"]["regulator"]["wide_open"][-2] = True
    assert _by_key(grade(r))["regulator_wide_open"]["grade"] == "bad"


@pytest.mark.parametrize("ratio,expect", [(0.99, "bad"), (1.0, "warn"), (1.19, "warn"), (1.2, "ok")])
def test_cavitation_is_red_once_the_orifice_cavitates_and_amber_near_it(ratio, expect):
    r = _result()
    r["diagnostics"] = {"cavitation": {"ox": {"min_margin": ratio, "t_min": 0.1, "flip_risk": False}}}
    assert _by_key(grade(r))["cavitation_ox"]["grade"] == expect


def test_a_stated_flag_margin_moves_the_saturation_amber_edge():
    r = _result()
    node = {"id": "MVO.in", "side": "ox", "min_psi": 40.0, "t_min": 0.1, "min_static_psi": 20.0, "t_min_static": 0.15}
    r["diagnostics"] = {"saturation": {"nodes": [node]}}
    g = _by_key(grade(r))["saturation_MVO.in"]
    # Graded on the static margin (what boils a moving liquid), at its own time.
    assert g["value"] == 20.0 and g["t_worst"] == 0.15 and g["grade"] == "warn" and g["warn"] == 25.0
    r["diagnostics"]["saturation"]["flag_margin_psi"] = 15.0
    assert _by_key(grade(r))["saturation_MVO.in"]["grade"] == "ok"


def test_separation_from_the_hardware_block_and_schmucker_as_amber():
    r = _result()
    r["diagnostics"] = {"hardware": {"t": [0.05, 0.2, 0.4], "separation": {
        "ratio": [1.1, 1.03, 1.2], "summerfield": [False] * 3, "schmucker": [False, False, False]}}}
    g = _by_key(grade(r))["separation"]
    assert g["value"] == 1.03 and g["t_worst"] == 0.2 and g["index_worst"] == 5 and g["grade"] == "ok"
    r["diagnostics"]["hardware"]["separation"]["schmucker"][1] = True
    assert _by_key(grade(r))["separation"]["grade"] == "warn"


def test_nozzle_separation_from_the_delivered_exit_pressure():
    r = _result()
    r["delivered"] = {"t": r["series"]["t"][2:], "p_exit_psia": [15.0, 14.0, 6.0, 15.0, 15.0, 15.0, 15.0, 15.0],
                      "ambient_psia": [14.0] * 8, "summary": {}}
    g = _by_key(grade(r))["separation"]
    assert g["value"] == pytest.approx(6.0 / 14.0) and g["grade"] == "ok" and g["index_worst"] == 4
    r["delivered"]["p_exit_psia"][2] = 5.5
    assert _by_key(grade(r))["separation"]["grade"] == "bad"


def test_flight_limits_need_their_requirement():
    r = _result()
    r["flight"] = {"ok": True, "apogee_agl_m": 3000.0, "rail_exit_velocity_m_s": 21.7, "rail_exit_time_s": 0.3,
                   "stability": {"liftoff_static_margin_cal": 1.4, "min_static_margin_cal": 1.3,
                                 "min_static_margin_t": 0.2, "max_q_pa": 36800.0, "max_q_t": 0.4}}
    g = _by_key(grade(r))
    assert "rail_exit" not in g
    assert g["static_margin_min"]["grade"] == "info" and g["max_q"]["grade"] == "info"
    assert g["max_q"]["index_worst"] == 9

    class Cfg:
        class design_requirements:  # noqa: N801
            min_rail_exit_velocity_m_s = 25.91
            min_static_margin_cal = 1.5

    g = _by_key(grade(r, config=Cfg))
    assert g["rail_exit"]["grade"] == "bad" and g["rail_exit"]["t_worst"] == 0.3
    assert g["static_margin_min"]["grade"] == "bad"


def test_requirements_are_read_from_the_recorded_yaml_without_a_config():
    r = _result()
    r["provenance"]["reproduce"] = {"design_yaml": "design_requirements:\n  max_fuel_tank_pressure_psi: 650\n"}
    assert requirements(r)["max_fuel_tank_pressure_psi"] == 650
    assert _by_key(grade(r))["tank_cap_fuel"]["limit"] == 650.0


def test_a_malformed_block_costs_only_its_own_grades():
    r = _result()
    r["diagnostics"] = {"saturation": {"nodes": [{"id": "x", "margin_psi": "not a list", "min_psi": object()}]}}
    keys = {e["key"] for e in grade(copy.deepcopy(r))}
    assert "bottle_margin" in keys and "stiffness_ox" in keys


def test_every_entry_carries_the_contract_keys():
    r = _result()
    want = {"key", "label", "group", "value", "unit", "limit", "warn", "direction", "grade", "t_worst",
            "index_worst", "series_ref", "basis", "hint"}
    groups = {"stability", "injector", "tanks", "pressurant", "propellant", "flight", "hardware", "model"}
    for e in grade(r):
        assert want <= set(e), e["key"]
        assert e["group"] in groups and e["grade"] in ("ok", "warn", "bad", "info")
        assert e["direction"] in ("min", "max") and e["hint"]
        json.dumps(e)
