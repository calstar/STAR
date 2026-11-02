"""Layer X holds each vessel to the pressure the feed twin trips the stand at.

The twin trips a vessel when its absolute pressure is over ``_trip_limit``: the drawing's burst
pressure over ``Setup.burst_safety_factor`` (across the wall) when one is drawn, else its MAWP --
both read as the drawing reads them, a bare psi being gauge, so ``.si`` is already absolute.

Before 2026-11-02 Layer X read the MAWP as a pressure *across* the wall: preflight passed a lockup
up to one atmosphere plus the site's over the trip (``target - ambient > MAWP.si``), the optimiser
and set point capped the lockup at ``MAWP.si + ambient``, the water-hammer rating added another
atmosphere, and the limits graded ``peak - ambient`` against the absolute figure. And it read no
burst pressure at all, which is how LE4 (3) rates every vessel: preflight said "nothing checks
those vessels" while the twin tripped its tanks at 764.7 psia.

Worked by hand: copv_study_gn2's tanks are drawn MAWP 1000 psi -> 1014.70 psia. LE4 (3)-style burst
1500 psi over a factor of 2 -> (1500 / 2) psig = 764.70 psia; 15000 psi -> 7514.70 psia.
"""

from __future__ import annotations

import copy
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

pytest.importorskip("feedtwin", reason="lib/feedtwin is not installed")

from engine.layerx import DrawingStore, LayerXSettings, prepare  # noqa: E402
from engine.layerx import optimize as opt  # noqa: E402
from engine.layerx import setpoint as sp  # noqa: E402
from engine.layerx.diag.limits import grade  # noqa: E402
from engine.layerx.sources import shipped_drawings_dir  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402

PSI = 6894.757293168361
ATM_PSI = 101325.0 / PSI
GN2 = "copv_study_gn2"
CFG = Path(__file__).resolve().parent / "fixtures" / "ethalox_6500N_doublet_cad_2026-09-28.yaml"

needs_drawing = pytest.mark.skipif(not (shipped_drawings_dir() / f"{GN2}.json").is_file(),
                                   reason="feed-twin's shipped drawings are not next to this checkout")


@pytest.fixture(scope="module")
def config():
    return load_config(str(CFG))


@pytest.fixture(scope="module")
def drawing():
    return {d.name: d for d in DrawingStore(None).list()}[GN2]


def _prep(config, drawing, **settings):
    # The native engine: these checks are the drawing's and the plan's, not the engine card's.
    return prepare(config, None, drawing, LayerXSettings(drawing_id=drawing.id, replay=False, engine_model="native",
                                                         **settings))


def _burst_rated(drawing, tank_psi=1500.0, bottle_psi=15000.0, relief_psi=None):
    """``drawing`` rated as LE4 (3) is: burst pressures, no MAWP; optionally a relief on the bottle's manifold."""
    payload = copy.deepcopy(drawing.payload)
    for node in payload["nodes"]:
        params = (node.get("data") or {}).get("params") or {}
        if node["id"] in ("OXT", "FUT", "KB1"):
            params.pop("MAWP", None)
            params["burst_pressure"] = {"value": bottle_psi if node["id"] == "KB1" else tank_psi, "unit": "psi",
                                        "source": "estimated"}
    if relief_psi is not None:
        payload["nodes"].append({"id": "RV9", "position": {"x": 150, "y": 380}, "data": {
            "componentType": "RV", "label": "COPV-RV", "fluid": "nitrogen", "options": {"flowCoefficient": "Cd"},
            "params": {"set_pressure": {"value": relief_psi, "unit": "psi", "source": "estimated"}}}})
        payload["edges"].append({"id": "l_rv9", "source": "MF1", "target": "RV9", "targetHandle": "r",
                                 "data": {"lineType": "pipe", "params": {}}})
    return replace(drawing, id=drawing.id + "-burst", payload=payload)


def _fails(prep):
    return {c.key: c.detail for c in prep.checks if c.status == "fail"}


@needs_drawing
def test_a_lockup_over_the_mawp_trip_fails_preflight(config, drawing):
    """1000 psi MAWP trips at 1014.70 psia. 1012 passes; 1022 -- under MAWP.si plus the site's 13.64
    psia, which the old check allowed -- fails, naming the trip. The session holds the same limit."""
    from feedtwin.session.burn import open_session

    ok = _prep(config, drawing, tank_pressure_psia=1012.0)
    assert not any(k.startswith("mawp_") for k in _fails(ok))
    assert ok.derived["tank_mawp_psi"] == pytest.approx({"OXT": 1000.0 + ATM_PSI, "FUT": 1000.0 + ATM_PSI})
    session = open_session(ok.assembler(), ok.machine, setup=ok.setup)
    assert {k: s.mawp / PSI for k, s in session.tanks.items()} == pytest.approx(ok.derived["tank_mawp_psi"])

    over = _prep(config, drawing, tank_pressure_psia=1022.0)
    fails = _fails(over)
    assert {"mawp_OXT", "mawp_FUT"} <= set(fails)
    assert "1014.7 psia (MAWP 1000 psig" in fails["mawp_OXT"]


@needs_drawing
def test_burst_pressure_is_the_rating_when_drawn(config, drawing):
    from feedtwin.session.burn import open_session

    burst = _burst_rated(drawing)
    prep = _prep(config, burst, tank_pressure_psia=600.0)
    assert prep.ok, _fails(prep)
    trip = 750.0 + ATM_PSI
    assert prep.derived["tank_mawp_psi"] == pytest.approx({"OXT": trip, "FUT": trip})
    assert prep.derived["copv_mawp_psi"] == pytest.approx(7500.0 + ATM_PSI)
    assert prep.derived["vessel_ratings"]["OXT"]["basis"] == "burst"
    ratings = next(c for c in prep.checks if c.key == "ratings")
    assert "nothing checks" not in ratings.detail
    assert "TK-LOX trips at 764.7 psia (burst 1500 psig over a safety factor of 2, estimated)" in ratings.detail
    session = open_session(prep.assembler(), prep.machine, setup=prep.setup)
    assert {k: s.mawp / PSI for k, s in session.tanks.items()} == pytest.approx(prep.derived["tank_mawp_psi"])
    assert [b.mawp / PSI for b in session.bottles.values()] == pytest.approx([prep.derived["copv_mawp_psi"]])

    assert {"mawp_OXT", "mawp_FUT"} <= set(_fails(_prep(config, burst, tank_pressure_psia=770.0)))
    assert "mawp_KB1" in _fails(_prep(config, burst, tank_pressure_psia=600.0, copv_pressure_psia=7600.0))


@needs_drawing
def test_a_fill_over_the_bottles_relief_is_said(config, drawing):
    """A relief on the bottle's manifold at 4000 psi lifts at 4014.7 psia: a 4500 psia fill vents in
    the settle, so preflight warns; a 3900 psia one does not."""
    burst = _burst_rated(drawing, relief_psi=4000.0)
    over = _prep(config, burst, tank_pressure_psia=600.0, copv_pressure_psia=4500.0)
    relief = next((c for c in over.checks if c.key == "relief"), None)
    assert relief is not None and relief.status == "warn"
    assert "COPV-RV's 4000 psi set pressure on COPV-GN2 (4014.7 psia)" in relief.detail
    under = _prep(config, burst, tank_pressure_psia=600.0, copv_pressure_psia=3900.0)
    assert not any(c.key == "relief" for c in under.checks)


@needs_drawing
def test_a_burn_that_starts_off_its_datum_is_not_a_settled_answer(config, drawing):
    """The 4500 psia fill vents through the 4000 psi relief in the settle (to ~3895 psia) and the tanks
    follow the regulator's supply effect: T-0 is not the burn asked for. The run said only "T-0 did not
    settle" and stood as converged; it now says what it started from and is not converged."""
    from engine.layerx.analysis import run_prepared

    burst = _burst_rated(drawing, relief_psi=4000.0)
    prep = _prep(config, burst, tank_pressure_psia=600.0, copv_pressure_psia=4500.0, horizon_s=1.0)
    result = run_prepared(prep, replay=False)
    assert result["summary"]["t0_settled"] is False
    assert result["converged"] is False
    event = next(e for e in result["events"] if e["label"] == "T-0 did not settle")
    assert "Asked for a 600.0 psia lockup from a 4500 psia bottle; T-0 is LOX" in event["detail"]
    assert result["summary"]["copv_t0_psia"] < 4100.0


def _burn(peak_ox: float, peak_fuel: float):
    """Two lead-in samples and four firing steps, flat but for each tank's peak."""
    t = [-0.05, 0.0, 0.05, 0.10, 0.15, 0.20]
    tank = lambda peak: [600.0, 600.0, 600.0, peak, 600.0, 600.0]  # noqa: E731
    side = lambda peak: {"tank_psia": tank(peak), "stiffness": [0.0, 0.0, 0.3, 0.3, 0.3, 0.3],  # noqa: E731
                         "liquid_kg": [5.0] * 6}
    block = lambda peak: {"t0_psia": 600.0, "min_psia": 600.0, "stiffness_min": 0.3, "peak_psia": peak,  # noqa: E731
                          "loaded_kg": 5.0, "residual_kg": 0.0}
    return {
        "series": {"t": t, "dt": [0.05] * 6, "firing": [False, False, True, True, True, True], "converged": [True] * 6,
                   "copv_psia": [1500.0] * 6, "ox": side(peak_ox), "fuel": side(peak_fuel)},
        "summary": {"depleted_side": "oxidiser", "burn_time_s": 0.2, "copv_end_psia": 1500.0, "copv_t0_psia": 4500.0,
                    "ox": block(peak_ox), "fuel": block(peak_fuel), "failed_steps": 0, "t0_settled": True,
                    "card_outside_steps": 0, "steps": 6},
        "events": [], "converged": True,
        "provenance": {"derived": {"roles": {"oxidiser": "OXT", "fuel": "FUT"}, "ambient_pa": 94069.72,
                                   "gauge_zero_pa": 101325.0,
                                   "tank_mawp_psi": {"OXT": 750.0 + ATM_PSI, "FUT": 750.0 + ATM_PSI},
                                   "vessel_ratings": {"OXT": {"basis": "burst", "words": "764.7 psia (burst 1500 psig "
                                                              "over a safety factor of 2, estimated)"}}}},
    }


def test_the_limits_grade_the_tank_peak_on_the_trip():
    """``tank_mawp_psi`` is absolute: a 770 psia peak against a 764.70 psia trip is 755.30 psig of 750.00,
    100.7 % -- over the red line, where reading the trip as across the wall (peak less the site's
    13.64 psia, against 764.70) put it at 756.36, under. 700 psia is 685.30 of 750.00, 91 %: amber."""
    rows = {r["key"]: r for r in grade(_burn(770.0, 700.0))}
    ox, fuel = rows["tank_mawp_ox"], rows["tank_mawp_fuel"]
    assert ox["limit"] == pytest.approx(750.0) and ox["value"] == pytest.approx(770.0 - ATM_PSI)
    assert ox["value"] > ox["limit"]
    assert fuel["value"] == pytest.approx(700.0 - ATM_PSI) and ox["warn"] < fuel["value"] < ox["limit"]
    assert ox["grade"] == "info"   # the team, 2026-10-03: tank limits are information; the trip itself is graded
    assert "burst 1500 psig" in ox["basis"] and ox["rating_source"] == "burst"


def test_the_set_point_and_optimiser_caps_are_the_trip():
    """The optimiser's lockup ceiling, the set point's MAWP cap and the set point's fallback grade all
    stop at the trip itself; each used to add the site's atmosphere (13.64 psia) on top."""
    # +15 % of 700 is 805, over the 764.70 psia trip: the trip binds.
    d = {"target_lockup_psia": 700.0, "ambient_pa": 94069.72, "copv_psig": 4500.0, "copv_drawn_psig": 4500.0,
         "tank_mawp_psi": {"OXT": 764.6959, "FUT": 764.6959}, "copv_mawp_psi": 7514.6959}
    variables = {v.key: v for v in opt.default_variables(SimpleNamespace(derived=d), SimpleNamespace(design_requirements=None))}
    assert variables["lockup_psia"].hi == pytest.approx(764.7)
    assert sp.lockup_ceiling_psia(d) == pytest.approx(764.6959)
    assert sp.lockup_ceiling_psia({"tank_mawp_psi": {}}) == float("inf")
    res = {"summary": {"ox": {"peak_psia": 770.0}, "fuel": {"peak_psia": 700.0}}, "converged": True}
    prep = SimpleNamespace(derived=d, roles={"oxidiser": "OXT", "fuel": "FUT"})
    rows = {r["key"]: r for r in sp._fallback_limits(res, prep, SimpleNamespace(design_requirements=None), {})}
    assert rows["tank_peak_mawp.oxidiser"]["limit"] == pytest.approx(764.6959)
    assert rows["tank_peak_mawp.oxidiser"]["grade"] == "bad" and rows["tank_peak_mawp.fuel"]["grade"] == "ok"
