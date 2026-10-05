"""Layer X: the feed twin and this engine, burned together (engine/layerx).

What these check, and against what:

* The dome dial Layer X solves for is checked against the regulator relation
  written out by hand from the drawing's own numbers: bias, supply-pressure
  effect, gauge zero. It is not checked against the twin's solver.
* The engine card (phase 2) has to reproduce EngineDesign on solves it was not
  fitted to, through the whole burn the twin runs on it, and has to fail its
  check against an engine it was not built from.
* The boundary between the twin's lines and the card is the line exit. What
  EngineDesign loses between the line exit and its manifold is exactly the
  Borda dump of the line's velocity head, checked by hand.
* The T-0 fit (phase 1, kept for comparison) has to make the twin reproduce
  EngineDesign exactly at the calibration point: chamber pressure, thrust, and
  the line-exit-to-chamber drop at EngineDesign's flows.
* A burn has to conserve propellant. Mass that left the tanks equals mass the
  chamber burned, step by step. The tank that runs dry first has to be the one
  the load ratio and the delivered O/F say it is.
* Preflight has to refuse a load that does not fit and a drawing that carries the
  wrong propellant, naming the problem rather than raising.

Physics in the twin itself is covered by lib/feedtwin's suite and by
scripts/physics_benchmark.py. These tests cover the seam.
"""

from __future__ import annotations

import copy
import json
import time
from pathlib import Path

import pytest

feedtwin = pytest.importorskip("feedtwin", reason="lib/feedtwin is not installed (pip install -e ../lib/feedtwin)")

from engine.core.runner import PintleEngineRunner  # noqa: E402
from engine.layerx import DrawingStore, LayerXSettings, prepare, run_prepared  # noqa: E402
from engine.layerx.link import twin_injector_check  # noqa: E402
from engine.layerx.prepare import PSI, lockup_for_dome  # noqa: E402
from engine.layerx.sources import Drawing, drawing_id, normalise, sha256, shipped_drawings_dir  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "ethalox_6500N_doublet_cad_2026-09-28.yaml"
GN2 = "copv_study_gn2"
# The GN2 drawing is a nitrogen-over-LOX hot fire, refused since 2026-10-03 unless acknowledged
# (engine/layerx/prepare.py gn2_on_lox); these tests study its burn, so their settings acknowledge it.

pytestmark = pytest.mark.skipif(
    not (shipped_drawings_dir() / f"{GN2}.json").is_file(),
    reason="feed-twin's shipped drawings are not next to this checkout",
)


@pytest.fixture(scope="module")
def config():
    return load_config(str(FIXTURE))


@pytest.fixture(scope="module")
def runner(config):
    return PintleEngineRunner(copy.deepcopy(config))


@pytest.fixture(scope="module")
def drawing() -> Drawing:
    found = {d.name: d for d in DrawingStore(None).list()}
    return found[GN2]


@pytest.fixture(scope="module")
def prepared(config, runner, drawing):
    return prepare(config, runner, drawing, LayerXSettings(drawing_id=drawing.id, ack_gn2_condensation=True, tank_pressure_psia=578.0))


def _check(prep, key):
    return next(c for c in prep.checks if c.key == key)


# ------------------------------------------------------------------ the dome dial


def test_dome_dial_matches_the_regulator_relation_by_hand(prepared, drawing):
    """lockup = dome + atmosphere + bias + S (p_ref - p_bottle), all in psi.

    Every number is read off the drawing JSON directly, not through feedtwin:
    PR-DOME's dome_bias 50 psi, supply_coefficient 17 psi/1000 psi and
    inlet_reference 4500 psi (absolute, as feedtwin reads "psi"). The bottle is
    4500 psig, the gauge zero is 101325 Pa, and PR-CTRL adds no bias of its own.
    """
    nodes = {n["id"]: n for n in drawing.payload["nodes"]}
    dome_params = nodes["PR_D"]["data"]["params"]
    bias = dome_params["dome_bias"]["value"]
    spe = dome_params["supply_coefficient"]["value"] / 1000.0
    reference = dome_params["inlet_reference"]["value"]
    atmosphere = 101325.0 / PSI
    bottle_psia = 4500.0 + atmosphere
    by_hand = 578.0 - atmosphere - bias - spe * (reference - bottle_psia)
    assert prepared.derived["dome_psig"] == pytest.approx(by_hand, abs=1e-6)
    # And the relation run forward through the drawing's own components lands on the target.
    from feedtwin.session.gauge import from_psig

    got = lockup_for_dome(prepared.model, prepared.derived["dome_psig"], from_psig(4500.0))
    assert got / PSI == pytest.approx(578.0, abs=1e-6)


# ------------------------------------------------------------------ the T-0 calibration


def test_t0_fit_reproduces_enginedesign_at_t0(config, runner, drawing):
    prep = prepare(config, runner, drawing, LayerXSettings(drawing_id=drawing.id, ack_gn2_condensation=True, tank_pressure_psia=578.0,
                                                           engine_model="calibrated"))
    link = prep.link
    ref = link.reference
    got = link.chamber.evaluate(ref["mdot_O"], ref["mdot_F"])
    assert got.pressure == pytest.approx(ref["Pc"], rel=1e-6)
    assert got.thrust == pytest.approx(ref["F"], rel=1e-6)

    inlet = prep.inlet_nodes
    net = prep.model.built.network

    def fluid_at(side, pressure):
        cond = net.conditions(inlet[side], pressure)
        return cond.rho, cond.mu

    for side, (twin_dp, ed_dp) in twin_injector_check(link, fluid_at).items():
        assert twin_dp == pytest.approx(ed_dp, rel=1e-9), side


# ------------------------------------------------------------------ the engine card


def test_the_line_exit_loses_exactly_the_borda_dump(config):
    """EngineDesign at the line exit (its line losses zeroed) drops, between the line exit
    and its still manifold, exactly K_exit rho v^2/2 at the exit bore -- by hand from the
    config's own density and bore."""
    import math as _m

    from engine.layerx.card import line_exit_config

    cfg = line_exit_config(config)
    res = PintleEngineRunner(cfg).evaluate(578.0 * PSI, 578.0 * PSI, silent=True)
    d = res["diagnostics"]
    for side, key, mdot in (("oxidizer", "O", res["mdot_O"]), ("fuel", "F", res["mdot_F"])):
        feed = cfg.feed_system[side]
        rho = cfg.fluids[side].density
        area = _m.pi * (feed.d_exit / 2) ** 2 if feed.d_exit else feed.A_hydraulic
        by_hand = feed.K_exit * 0.5 * rho * (mdot / (rho * area)) ** 2
        assert d[f"delta_p_feed_{key}"] == pytest.approx(by_hand, rel=1e-9), side
        assert by_hand > 5.0 * PSI  # it is not a rounding error: ~26 psi LOX on this engine


def test_the_card_matches_enginedesign_on_solves_it_never_saw(prepared, config):
    from engine.layerx.card import ENVELOPE_LEVELS, ENVELOPE_RATIOS, TOLERANCE, EngineSampler, _random, check_card

    card = prepared.link.card
    assert card.provenance["within_tolerance"]
    sampler = EngineSampler(config, prepared.ambient_pa)
    fresh = _random(sampler, 578.0 * PSI, 25, ENVELOPE_LEVELS, ENVELOPE_RATIOS, seed=1234)
    errors = check_card(card, fresh, prepared.ambient_pa)
    for key in ("closed_pc", "closed_thrust", "closed_mdot", "chamber_pc", "chamber_thrust", "dp_O", "dp_F"):
        assert errors[key] < TOLERANCE, (key, errors[key])


def test_a_card_for_another_engine_fails_its_check(prepared, config):
    """A card is a sampled engine. Check it against a different one -- a 3 % larger throat --
    and the check has to say so; served for the new config it is not even the same card."""
    from engine.layerx.card import (ENVELOPE_LEVELS, ENVELOPE_RATIOS, TOLERANCE, EngineSampler, _random,
                                    card_for, check_card)

    other = copy.deepcopy(config)
    other.chamber_geometry.A_throat *= 1.03
    sampler = EngineSampler(other, prepared.ambient_pa)
    points = _random(sampler, 578.0 * PSI, 10, ENVELOPE_LEVELS, ENVELOPE_RATIOS, seed=99)
    errors = check_card(prepared.link.card, points, prepared.ambient_pa)
    assert errors["closed_pc"] > TOLERANCE
    assert card_for(other, center_pa=578.0 * PSI, ambient_pa=prepared.ambient_pa) is not prepared.link.card


def test_native_engine_is_not_enginedesign(config, runner, drawing):
    """The gap the calibration closes is real: the twin's own Reynolds-law Cd
    drops a different pressure across the injector at EngineDesign's flows."""
    prep = prepare(config, runner, drawing, LayerXSettings(drawing_id=drawing.id, ack_gn2_condensation=True, engine_model="native"))
    inlet = prep.inlet_nodes
    net = prep.model.built.network

    def fluid_at(side, pressure):
        cond = net.conditions(inlet[side], pressure)
        return cond.rho, cond.mu

    gaps = twin_injector_check(prep.link, fluid_at)
    assert any(abs(tw / ed - 1.0) > 0.2 for tw, ed in gaps.values())
    assert _check(prep, "engine_link").status == "warn"


# ------------------------------------------------------------------ preflight refusals


def test_preflight_refuses_a_load_that_does_not_fit(config, runner, drawing):
    heavy = copy.deepcopy(config)
    heavy.lox_tank.mass = 40.0  # 35 L of LOX into a 15.1 L tank
    prep = prepare(heavy, runner, drawing, LayerXSettings(drawing_id=drawing.id, ack_gn2_condensation=True))
    assert _check(prep, "load_oxidiser").status == "fail"
    assert not prep.ok


def test_preflight_refuses_a_drawing_without_the_engines_fuel(config, runner, drawing):
    payload = copy.deepcopy(drawing.payload)
    for node in payload["nodes"]:
        if node["id"] == "FUT":
            node["data"]["fluid"] = "water"
    raw = normalise(payload)
    wrong = Drawing(id=drawing_id(raw), name="wrong fuel", source="test", sha256=sha256(raw), payload=json.loads(raw))
    prep = prepare(config, runner, wrong, LayerXSettings(drawing_id=wrong.id))
    assert _check(prep, "tank_fuel").status == "fail"
    assert "ethanol" in _check(prep, "tank_fuel").detail
    assert not prep.ok


def test_settings_ignore_unknown_keys_and_nulls():
    s = LayerXSettings.from_dict({"drawing_id": "x", "tank_pressure_psia": None, "dt": 0.02, "bogus": 1})
    assert s.drawing_id == "x" and s.tank_pressure_psia is None and s.dt == 0.02


# ------------------------------------------------------------------ a burn


@pytest.fixture(scope="module")
def burned(prepared, runner):
    """The default: card engine, closed against EngineDesign's eroding-chamber replay."""
    return run_prepared(prepared, runner=runner)


@pytest.fixture(scope="module")
def burned_static(prepared):
    """The twin's pass alone, as-built throat: the engine card and nothing else."""
    return run_prepared(prepared, replay=False)


def test_a_burn_conserves_propellant(burned, prepared, config):
    s = burned["summary"]
    series = burned["series"]
    dt = s["dt"]
    loads = {"ox": float(config.lox_tank.mass), "fuel": float(config.fuel_tank.mass)}
    for side, key in (("ox", "ox"), ("fuel", "fuel")):
        # The feed twin's propellant vapour (on since 2026-10-03, the twin's own Setup) boils a few
        # tens of milligrams off the LOX over the 300 s hold: the T-0 load is the config's within a gram.
        assert s[key]["loaded_kg"] == pytest.approx(loads[side], abs=1e-3)
        left = s[key]["loaded_kg"] - s[key]["residual_kg"]
        # Each step at its own length (the last is cut to land on depletion).
        burned_kg = sum(m * h for m, h, f in zip(series[side]["mdot"], series["dt"], series["firing"]) if f)
        # Within one step's flow of what left the tank: the tank integrates within the step, the
        # sum holds the step's end value across it.
        one_step = max(series[side]["mdot"]) * dt
        assert abs(burned_kg - left) < 0.5 * one_step, (side, burned_kg, left)
    assert s["propellant_used_kg"] == pytest.approx(
        sum(s[k]["loaded_kg"] - s[k]["residual_kg"] for k in ("ox", "fuel")), rel=1e-12)
    assert s["isp_mean_s"] == pytest.approx(s["total_impulse_Ns"] / (s["propellant_used_kg"] * 9.80665), rel=1e-12)


def test_the_tank_that_runs_dry_is_the_one_the_load_says(burned, config):
    """Load ratio below the delivered O/F means LOX runs out first, and above
    it, fuel. Independent of how either was computed."""
    s = burned["summary"]
    load_ratio = float(config.lox_tank.mass) / float(config.fuel_tank.mass)
    expected = "oxidiser" if s["of_mean"] > load_ratio else "fuel"
    assert s["depleted_side"] == expected
    assert s["burn_time_s"] > 0.0


def test_a_card_burn_runs_enginedesigns_engine_all_the_way(burned_static):
    """At instants across the burn, the twin's chamber and flows against EngineDesign solved at
    the same injector-inlet pressures and the same (as-built) geometry. The card's own error is
    ~0.01 %; the twin's network solve (its 1e-4 tolerance) adds a few hundredths. 0.2 % is the
    phase-2 tolerance."""
    check = burned_static["engine_check"]
    assert check["available"] and check["mode"] == "card" and check.get("against") != "replay"
    assert len([r for r in check["rows"] if r["available"]]) >= 8
    for key, worst in check["worst"].items():
        assert worst < 2.0e-3, (key, worst)
    assert burned_static["summary"]["card_outside_steps"] == 0
    assert "replay" not in burned_static


# ------------------------------------------------------------------ phase 3: the replay


def test_the_replay_loop_needs_its_feedback_and_closes(burned):
    """EngineDesign's replay erodes the throat; the twin's first pass, at the as-built throat,
    is percents off it. Fed the replay's throat history the twin agrees to a few tenths of a
    percent, and the history stops moving. A loop that never applied the history would fail
    the second half."""
    passes = burned["passes"]
    assert len(passes) >= 2 and burned["converged"]
    first, last = passes[0]["agreement"]["worst"], passes[-1]["agreement"]["worst"]
    assert passes[0]["throat_growth"] > 0.01  # the config's graphite throat and liner recede
    assert max(first.values()) > 0.01
    assert max(last.values()) < 5.0e-3
    assert passes[-1]["schedule_change"] < 2.0e-4
    check = burned["engine_check"]
    assert check["against"] == "replay"
    assert max(check["worst"]["pc"], check["worst"]["mdot_O"], check["worst"]["mdot_F"]) < 5.0e-3


def test_delivered_numbers_are_the_replays(burned):
    d = burned["delivered"]
    series = burned["series"]
    lengths = [h for h, f in zip(series["dt"], series["firing"]) if f]
    # Each step at its own length: the burn ends on depletion, so the last is short.
    assert lengths[-1] < burned["summary"]["dt"] - 1e-9
    assert d["summary"]["total_impulse_Ns"] == pytest.approx(sum(f * h for f, h in zip(d["thrust_N"], lengths)), rel=1e-12)
    assert d["summary"]["throat_area_growth"] == pytest.approx(burned["replay"]["throat_area_ratio"][-1] - 1.0)
    # The replay's thrust at its own points is what the delivered curve passes through.
    rp = burned["replay"]
    fire = [i for i, f in enumerate(burned["series"]["firing"]) if f]
    for k, i in enumerate(rp["index"]):
        assert d["thrust_N"][fire.index(i)] == pytest.approx(rp["thrust_N"][k], rel=1e-12)


def test_the_hand_off_is_what_forward_and_flight_read(burned):
    ts = burned["timeseries"]
    data, summary = ts["data"], ts["summary"]
    need = ("time", "P_tank_O_psi", "P_tank_F_psi", "Pc_psi", "thrust_kN", "Isp_s", "MR", "mdot_O_kg_s",
            "mdot_F_kg_s", "mdot_total_kg_s", "cstar_actual_m_s", "gamma")
    n = len(data["time"])
    assert n > 10 and data["time"][0] == pytest.approx(0.0, abs=1e-9)
    for key in need:
        assert len(data[key]) == n, key
    assert summary["total_impulse_kNs"] == pytest.approx(burned["delivered"]["summary"]["total_impulse_Ns"] / 1e3)
    # Readers integrate the curve from its first sample (backend/routers/flight.py re-zeroes time
    # there). Without the sample at Fire, the first step was lost: 1.4 % of impulse.
    import numpy as np

    t = np.asarray(data["time"])
    impulse = np.trapezoid(np.asarray(data["thrust_kN"]) * 1e3, t)
    # It ends where the burn ended: on depletion, the last step cut to land there.
    assert t[-1] == pytest.approx(burned["summary"]["burn_time_s"])
    assert impulse == pytest.approx(burned["delivered"]["summary"]["total_impulse_Ns"], rel=3e-3)
    burned_kg = np.trapezoid(np.asarray(data["mdot_total_kg_s"]), t)
    assert burned_kg == pytest.approx(burned["summary"]["propellant_used_kg"], rel=1e-2)
    assert data["lox_mass_remaining_kg"][0] == pytest.approx(burned["summary"]["ox"]["loaded_kg"])
    assert summary["burn_time_s"] == burned["summary"]["burn_time_s"]
    assert data["thrust_kN"][-1] * 1e3 == pytest.approx(burned["delivered"]["thrust_N"][-1])


def test_a_burn_starts_at_its_lockup_and_reports_its_provenance(burned, drawing):
    s = burned["summary"]
    assert s["t0_settled"]
    assert s["ox"]["t0_psia"] == pytest.approx(578.0, abs=4.0)
    assert s["fuel"]["t0_psia"] == pytest.approx(578.0, abs=4.0)
    p = burned["provenance"]
    assert p["drawing"]["sha256"] == drawing.sha256
    assert len(p["config_sha256"]) == 64
    assert p["calibration"]["mode"] == "card"
    assert p["phase"] == 3
    # The pressure ladder is ordered while firing: tank above inlet above chamber.
    series = burned["series"]
    for i, firing in enumerate(series["firing"]):
        if not firing or series["t"][i] < 0.2:
            continue
        for side in ("ox", "fuel"):
            assert series[side]["tank_psia"][i] > series[side]["inlet_psia"][i] > series["chamber"]["pc_psia"][i]
    cc = burned["cross_check"]
    assert cc["available"] and {r["key"] for r in cc["rows"]} >= {"pc_psia", "thrust_N", "inlet_O_psia"}


# ------------------------------------------------------------------ the API


def test_the_api_runs_a_burn(config, drawing, monkeypatch, tmp_path):
    # pytest's own temp dir: mkdtemp left one behind per run.
    monkeypatch.setenv("USERDATA_DIR", str(tmp_path))
    try:
        from fastapi.testclient import TestClient
    except RuntimeError as exc:  # starlette's test client needs an HTTP client package
        pytest.skip(str(exc))

    from backend.main import app
    from backend.session import registry

    client = TestClient(app)
    assert client.get("/api/layerx/status").json()["feedtwin"]["available"]
    session = registry.get("local")
    # The shared "local" session: put its design back afterwards for whatever test runs next.
    before = (session.app_state.config, getattr(session.app_state, "config_path", None)) if session.app_state.has_config() else None
    if before is not None:
        monkeypatch.setattr(session.app_state, "config", before[0])
    session.app_state.set_config(copy.deepcopy(config), str(FIXTURE))

    ids = {d["name"]: d["id"] for d in client.get("/api/layerx/drawings").json()}
    assert ids[GN2] == drawing.id
    assert client.post("/api/layerx/preflight", json={"drawing_id": "nope"}).status_code == 404
    pf = client.post("/api/layerx/preflight", json={"drawing_id": drawing.id, "ack_gn2_condensation": True}).json()
    assert pf["ok"], [c for c in pf["checks"] if c["status"] == "fail"]

    started = client.post("/api/layerx/runs", json={"drawing_id": drawing.id, "dt": 0.1, "ack_gn2_condensation": True}).json()
    deadline = time.time() + 300
    while True:
        view = client.get(f"/api/layerx/runs/{started['id']}").json()
        if view["status"] in ("done", "failed", "cancelled") or time.time() > deadline:
            break
        time.sleep(0.25)
    assert view["status"] == "done", view.get("error")
    assert view["result"]["summary"]["burn_time_s"] > 0
    listed = client.get("/api/layerx/runs").json()
    assert listed[0]["id"] == started["id"] and listed[0]["summary"]["total_impulse_Ns"] > 0
