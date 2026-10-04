"""Conservation checks on a Layer X burn (engine/layerx/diag/vv.py).

What these check, and against what:

* **Propellant mass** on a hand-built burn: the balance closes when the numbers do, and a leak shows
  as exactly its own size. The trapped liquid is checked by hand: pi/4 d^2 L of the drawing's
  tank-to-engine lines at CoolProp's saturated density, the fill and vent lines left out.
* **Pressurant mass and gas-side energy** on a pressurisation integrated here, independently of the
  twin: a bottle feeds an ullage that grows as the liquid leaves, explicit Euler, every state from
  CoolProp's (rho, u). Mass is conserved by construction and the first law holds step by step, so the
  checks must close to the quadrature error of the boundary work (~1e-4 of it). Leaving the work
  out, or the ullage volume wrong, must not close.
* **The 2026-10-02 reference run** (read only, skipped when absent): the twin's own bookkeeping
  closes, the pressurant to round-off.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

CP = pytest.importorskip("CoolProp.CoolProp")

from engine.layerx.diag.limits import grade  # noqa: E402
from engine.layerx.diag.vv import check, energy_balance, feed_lines, mass_balance, pressurant_balance  # noqa: E402

PSI = 6894.757293168361
RUNS = Path(__file__).resolve().parents[1] / ".userdata" / "local" / "engine" / "layerx" / "runs"
REFERENCE = RUNS / "20261002-231658-7e47d1.json"


def _p(value, unit, source="estimated"):
    return {"value": value, "unit": unit, "source": source, "reference": "test"}


#: A drawing in the shape the shipped ones take: a LOX tank with a fill line in, a vent line out and
#: two feed lines to the engine through a main valve.
DOC = {
    "nodes": [
        {"id": "OXT", "data": {"componentType": "TANK", "fluid": "oxygen", "params": {}}},
        {"id": "FILL", "data": {"componentType": "SOL", "fluid": "oxygen", "params": {}}},
        {"id": "VENT", "data": {"componentType": "SOL", "fluid": "helium", "params": {}}},
        {"id": "MVO", "data": {"componentType": "SOL", "fluid": "oxygen", "params": {}}},
        {"id": "ENG", "data": {"componentType": "ENGINE", "params": {}}},
    ],
    "edges": [
        {"id": "l_fill", "source": "FILL", "target": "OXT", "data": {"params": {"length": _p(0.4, "m"), "bore": _p(12.7, "mm")}}},
        {"id": "l_vent", "source": "OXT", "target": "VENT", "data": {"params": {"length": _p(0.4, "m"), "bore": _p(9.525, "mm")}}},
        {"id": "l_ox1", "source": "OXT", "target": "MVO", "data": {"params": {"length": _p(2.0, "in"), "bore": _p(10.92, "mm")}}},
        {"id": "l_ox2", "source": "MVO", "target": "ENG", "data": {"params": {"length": _p(0.07, "m"), "bore": _p(10.92, "mm")}}},
    ],
}


def test_the_feed_walk_takes_the_lines_to_the_engine_and_nothing_else():
    lines = feed_lines(DOC, "OXT")
    assert [ln["id"] for ln in lines] == ["l_ox1", "l_ox2"]
    assert lines[0]["length_m"] == pytest.approx(0.0508)
    assert lines[1]["volume_m3"] == pytest.approx(math.pi / 4 * 0.01092 ** 2 * 0.07, rel=1e-12)


def _burn(n=20, dt=0.05, mdot=(1.9, 1.25), loaded=(6.0, 4.0)):
    t = [-0.05, 0.0] + [dt * (k + 1) for k in range(n)]
    firing = [False, False] + [True] * n
    side = lambda m: {"mdot": [0.0, 0.0] + [m] * n, "liquid_K": [90.0] * len(t)}  # noqa: E731
    burned = [m * dt * n for m in mdot]
    return {
        "series": {"t": t, "dt": [dt] * len(t), "firing": firing, "ox": side(mdot[0]), "fuel": side(mdot[1])},
        "summary": {"ox": {"loaded_kg": loaded[0], "residual_kg": loaded[0] - burned[0]},
                    "fuel": {"loaded_kg": loaded[1], "residual_kg": loaded[1] - burned[1]}},
        "provenance": {"derived": {"roles": {"oxidiser": "OXT", "fuel": "FUT"},
                                   "species": {"oxidiser": "oxygen", "fuel": "ethanol"}}},
    }


def test_a_consistent_burn_closes_and_counts_its_lines_by_hand():
    r = _burn()
    m = mass_balance(r, document=DOC)
    ox = m["ox"]
    rho = CP.PropsSI("D", "T", 90.0, "Q", 0, "Oxygen")
    vol = math.pi / 4 * 0.01092 ** 2 * (0.0508 + 0.07)
    assert ox["trapped_kg"] == pytest.approx(rho * vol, rel=1e-9)
    assert ox["burned_kg"] == pytest.approx(1.9 * 0.05 * 20, rel=1e-12)
    assert ox["loaded_kg"] == pytest.approx(6.0 + rho * vol, rel=1e-12)
    assert abs(ox["error_pct"]) < 1e-10
    # No drawing carries the fuel tank here: the balance closes without its lines, and says so.
    assert m["fuel"]["trapped_kg"] is None and abs(m["fuel"]["error_pct"]) < 1e-10
    assert "Lines not counted" in m["fuel"]["basis"]


def test_a_leak_shows_as_exactly_its_own_size():
    r = _burn()
    r["summary"]["ox"]["residual_kg"] -= 0.05          # 50 g gone somewhere the flow did not take it
    ox = mass_balance(r)["ox"]
    assert ox["error_kg"] == pytest.approx(0.05, rel=1e-9)
    assert ox["error_pct"] == pytest.approx(100 * 0.05 / 6.0, rel=1e-9)


def test_the_burned_mass_counts_each_step_by_its_own_length():
    """Each recorded flow is the end-of-step sample of its own step: mdot[i] * dt[i]. The flow
    climbs here (as it does when the tanks rise) so that pairing a flow with any other step's
    length -- the neighbour's, or a constant -- changes the sum; with a constant flow it would not."""
    r = _burn()
    n = len(r["series"]["t"])
    r["series"]["ox"]["mdot"] = [0.0, 0.0] + [1.80 + 0.01 * k for k in range(n - 2)]
    r["series"]["dt"][-1] = 0.02                         # the last step cut to land on depletion
    burned = sum(1.80 + 0.01 * k for k in range(n - 3)) * 0.05 + (1.80 + 0.01 * (n - 3)) * 0.02
    r["summary"]["ox"]["residual_kg"] = r["summary"]["ox"]["loaded_kg"] - burned
    ox = mass_balance(r)["ox"]
    assert ox["burned_kg"] == pytest.approx(burned, rel=1e-12)
    assert abs(ox["error_pct"]) < 1e-10


# ---------------------------------------------------------------- a pressurisation, integrated here


def _pressurise(n=300, gas="Nitrogen", bottle_L=4.6871, p_b0=300e5, tank_L=15.1, fill0=0.95,
                p_u0=40e5, T0=293.15, burn_s=3.5):
    """A bottle feeding one ullage that grows as the liquid leaves; adiabatic everywhere. The flow
    holds the ullage's density (what a regulator nearly does). Explicit Euler on (m, U) of each
    volume, h out of the bottle at the step's start, work p dV at the step's start."""
    Vb = bottle_L * 1e-3
    Vt = tank_L * 1e-3
    q_liq = Vt * (fill0 - 0.05) / burn_s                 # m^3/s of liquid leaving
    dt = burn_s / n
    rho_b = CP.PropsSI("D", "P", p_b0, "T", T0, gas)
    mb, Ub = rho_b * Vb, rho_b * Vb * CP.PropsSI("U", "P", p_b0, "T", T0, gas)
    Vu = Vt * (1 - fill0)
    rho_u = CP.PropsSI("D", "P", p_u0, "T", T0, gas)
    mu, Uu = rho_u * Vu, rho_u * Vu * CP.PropsSI("U", "P", p_u0, "T", T0, gas)
    rec = {"t": [], "copv_psia": [], "copv_mass_kg": [], "p": [], "T": [], "fill": []}
    W = 0.0

    def record(k):
        rec["t"].append(k * dt)
        rec["copv_psia"].append(CP.PropsSI("P", "D", mb / Vb, "U", Ub / mb, gas) / PSI)
        rec["copv_mass_kg"].append(mb)
        rec["p"].append(CP.PropsSI("P", "D", mu / Vu, "U", Uu / mu, gas) / PSI)
        rec["T"].append(CP.PropsSI("T", "D", mu / Vu, "U", Uu / mu, gas))
        rec["fill"].append(1.0 - Vu / Vt)

    record(0)
    for k in range(n):
        h_b = CP.PropsSI("H", "D", mb / Vb, "U", Ub / mb, gas)
        p_u = CP.PropsSI("P", "D", mu / Vu, "U", Uu / mu, gas)
        dV = q_liq * dt
        mdot = (mu / Vu) * q_liq
        mb, Ub = mb - mdot * dt, Ub - h_b * mdot * dt
        mu, Uu = mu + mdot * dt, Uu + h_b * mdot * dt - p_u * dV
        Vu += dV
        W += p_u * dV
        record(k + 1)
    m = len(rec["t"])
    flat = lambda v: [v] * m  # noqa: E731
    result = {
        "series": {"t": rec["t"], "dt": [dt] * m, "firing": [True] * m, "copv_psia": rec["copv_psia"],
                   "copv_mass_kg": rec["copv_mass_kg"], "copv_wall_K": flat(T0),
                   "ox": {"tank_psia": rec["p"], "ullage_K": rec["T"], "fill_fraction": rec["fill"]},
                   "fuel": {"tank_psia": flat(p_u0 / PSI), "ullage_K": flat(T0), "fill_fraction": flat(0.95)}},
        "provenance": {"derived": {"roles": {"oxidiser": "OXT", "fuel": "FUT"},
                                   "tank_volumes_L": {"OXT": tank_L, "FUT": 8.67}, "copv_volume_L": bottle_L,
                                   "pressurant_gas": gas.lower()},
                       "settings": {"ullage_vapour": False}},
    }
    return result, W


@pytest.fixture(scope="module")
def pressurised():
    return _pressurise()


def test_the_pressurant_balance_closes_on_an_independent_integration(pressurised):
    r, _ = pressurised
    p = pressurant_balance(r)
    assert p["available"]
    assert p["bottle_out_kg"] > 0.1
    assert abs(p["error_pct"]) < 1e-6
    assert p["vented_kg"] is None and "vents taken as shut" in p["basis"]


def test_a_wrong_ullage_volume_does_not_close(pressurised):
    r, _ = pressurised
    r = json.loads(json.dumps(r))
    r["provenance"]["derived"]["tank_volumes_L"]["OXT"] *= 1.01
    assert abs(pressurant_balance(r)["error_pct"]) > 0.1


def test_the_energy_balance_closes_to_the_quadrature_of_the_work(pressurised):
    r, W = pressurised
    e = energy_balance(r)
    assert e["available"]
    assert e["boundary_work_J"] == pytest.approx(W, rel=2e-3)
    # The integration took the work at each step's start; the check takes the trapezoid. Everything
    # else is exact by construction, so R is exactly the difference: W_left - W_trap = -1/2 sum dp dV.
    s = r["series"]["ox"]
    p = [v * PSI for v in s["tank_psia"]]
    V = [15.1e-3 * (1 - f) for f in s["fill_fraction"]]
    quad = -0.5 * sum((p[k + 1] - p[k]) * (V[k + 1] - V[k]) for k in range(len(p) - 1))
    assert e["unclosed_J"] == pytest.approx(quad, rel=1e-5, abs=1e-6)
    assert abs(e["error_pct"]) < 0.1, e
    # No wall declared: the bottle wall term is not invented.
    assert e["bottle_wall_heat_J"] is None


def test_heat_into_the_ullage_shows_as_the_unclosed_part(pressurised):
    """Warm the ullage gas at the end by 2 K at fixed density: that energy was never in the
    balance, so R falls by it (R is minus the heat the walls gave the gas)."""
    r, _ = pressurised
    r = json.loads(json.dumps(r))
    s = r["series"]["ox"]
    p, T = s["tank_psia"][-1] * PSI, s["ullage_K"][-1]
    rho = CP.PropsSI("D", "P", p, "T", T, "Nitrogen")
    vol = 15.1e-3 * (1 - s["fill_fraction"][-1])
    u0 = CP.PropsSI("U", "P", p, "T", T, "Nitrogen")
    s["ullage_K"][-1] = T + 2.0
    s["tank_psia"][-1] = CP.PropsSI("P", "D", rho, "T", T + 2.0, "Nitrogen") / PSI
    q = rho * vol * (CP.PropsSI("U", "D", rho, "T", T + 2.0, "Nitrogen") - u0)
    before = energy_balance(_pressurise()[0])["unclosed_J"]
    after = energy_balance(r)
    # The boundary work's last trapezoid moves with the end pressure too: count it.
    dp = s["tank_psia"][-1] * PSI - p
    dV = 15.1e-3 * (r["series"]["ox"]["fill_fraction"][-2] - r["series"]["ox"]["fill_fraction"][-1])
    assert after["unclosed_J"] - before == pytest.approx(-q - 0.5 * dp * dV, rel=1e-6)


def test_vapour_in_the_ullage_is_refused_rather_than_booked_as_error(pressurised):
    r, _ = pressurised
    r = json.loads(json.dumps(r))
    r["provenance"]["settings"]["ullage_vapour"] = True
    assert not pressurant_balance(r)["available"] and "vapour" in pressurant_balance(r)["error"]
    assert not energy_balance(r)["available"]
    # The propellant balance still closes what it can, and says the evaporated mass sits in its error.
    b = _burn()
    assert mass_balance(b)["ox"]["includes_evaporation"] is False
    b["provenance"]["settings"] = {"ullage_vapour": True}
    m = mass_balance(b)["ox"]
    assert m["includes_evaporation"] is True and "evaporated" in m["basis"]


def test_check_never_raises_and_says_what_it_could_not_do():
    out = check({"series": {"t": [0.0, 1.0]}, "summary": {"ox": "nonsense"}})
    for key in ("mass", "pressurant", "energy"):
        assert key in out
    assert out["pressurant"]["available"] is False
    assert out["convergence"] == []
    assert out["model"]["name"] == "layerx_vv_balances"


def test_convergence_lists_every_pass_against_its_tolerance():
    from engine.layerx.flight import ACCEL_TOLERANCE
    from engine.layerx.replay import THROAT_TOLERANCE

    r = {"passes": [{"pass": 1, "schedule_change": 0.04}, {"pass": 2, "schedule_change": 5e-5, "accel_change": 1e-3,
                                                           "agreement": {"worst": {"pc": 0.001, "mdot_O": -0.002}}}]}
    c = check(r)["convergence"]
    assert [p["pass"] for p in c] == [1, 2]
    assert c[1]["throat_residual"] == 5e-5 and c[1]["throat_tolerance"] == THROAT_TOLERANCE
    assert c[1]["accel_tolerance"] == ACCEL_TOLERANCE and c[0]["accel_tolerance"] is None
    assert c[1]["agreement_worst"] == 0.002


def test_limits_grade_the_balances(pressurised):
    r, _ = pressurised
    r = json.loads(json.dumps(r))
    r["summary"] = {"ox": {"loaded_kg": 6.0, "residual_kg": 6.0, "t0_psia": 580.0}, "fuel": {"loaded_kg": 4.0, "residual_kg": 4.0, "t0_psia": 580.0}}
    r["series"]["ox"]["mdot"] = [0.0] * len(r["series"]["t"])
    r["series"]["fuel"]["mdot"] = [0.0] * len(r["series"]["t"])
    r["diagnostics"] = {"vv": check(r)}
    g = {e["key"]: e for e in grade(r)}
    assert g["conservation_pressurant"]["grade"] == "ok"
    assert g["conservation_mass_ox"]["grade"] == "ok"
    assert g["conservation_energy"]["grade"] == "info"


@pytest.mark.skipif(not REFERENCE.is_file(), reason="the 2026-10-02 reference run 7e47d1 is not in .userdata")
def test_the_reference_run_conserves_what_it_must():
    r = json.loads(REFERENCE.read_text())["result"]
    v = check(r)
    for side, lines in (("ox", ["l_ox1", "l_ox2"]), ("fuel", ["l_fu1", "l_fu2"])):
        m = v["mass"][side]
        # The recorded flows are end-of-step samples of finer sub-steps: 0.002-0.004 %, well under 0.1 %.
        assert abs(m["error_pct"]) < 0.01
        if m["trapped_kg"] is not None:          # the shipped drawing is next to this checkout
            assert [ln["id"] for ln in m["lines"]] == lines
    assert abs(v["pressurant"]["error_pct"]) < 1e-6
    assert v["pressurant"]["bottle_out_kg"] == pytest.approx(r["series"]["copv_mass_kg"][0] - r["series"]["copv_mass_kg"][-1])
    last = v["convergence"][-1]
    assert last["throat_residual"] < last["throat_tolerance"] and last["accel_residual"] < last["accel_tolerance"]
