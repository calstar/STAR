"""Feed diagnostics (engine/layerx/diag: ladder, regulator, solenoids, pressurant, saturation,
cavitation, injector, thrust shape, ledger) against hand calculations, CoolProp and ``fluids``.

Most tests run on a synthetic result with a contract-shaped ``network`` (DATA-CONTRACT 2), whose
numbers are chosen so each answer can be worked by hand in the test. One test burns the LE4 helium
drawing and is skipped unless ``LAYERX_GOLDEN=1`` and lib/feedtwin records the network.
"""

from __future__ import annotations

import copy
import math
import os
from types import SimpleNamespace

import pytest

from engine.layerx.diag import ladder as L

PSI = 6894.757293168361


# ---- a small synthetic stand ----------------------------------------------------------------------
#
# bottle KB1 -l_kb-> MF1 -l_reg-> PR_D.in =PR_D=> PR_D.out -l_reg_out-> MF2
#   MF2 -l_oxpress_in-> SV_LOX_PRESS.in =SV_LOX_PRESS=> .out -l_oxpress-> OXT (ullage)
#   OXT.out -l_ox1-> MVO.in =MVO=> MVO.out -l_ox2-> ENG.oxidiser =injector=> ENG.chamber
# and the same for fuel. Four steps: two before Fire (mains shut), two firing.

N = 4
T = [-0.1, 0.0, 0.05, 0.10]
FIRING = [False, False, True, True]


def _lin(a, b):
    return [a + (b - a) * k / (N - 1) for k in range(N)]


def _synthetic():
    nodes = {}
    branches = {}

    def node(nid, label, kind, side, phase, p, T_K):
        nodes[nid] = {"label": label, "kind": kind, "side": side, "phase": phase, "p_psia": p, "T_K": T_K}

    def branch(bid, label, kind, frm, to, side, mdot, cv=None):
        branches[bid] = {"label": label, "kind": kind, "from": frm, "to": to, "side": side,
                         "mdot": mdot, "dp_psi": [a - b for a, b in zip(nodes[frm]["p_psia"], nodes[to]["p_psia"])],
                         "cv": cv, "state": None}

    bottle = _lin(4000.0, 3000.0)
    node("KB1", "COPV", "bottle", "gas", "gas", bottle, [293.15] * N)
    node("MF1", "MAN-GN2", "manifold", "gas", "gas", [p - 1.0 for p in bottle], [293.0] * N)
    node("PR_D.in", "PR-DOME.in", "junction", "gas", "gas", [p - 5.0 for p in bottle], [292.9] * N)
    reg_out = [600.0, 600.0, 598.0, 601.0]
    node("PR_D.out", "PR-DOME.out", "junction", "gas", "gas", reg_out, [300.0] * N)
    node("MF2", "MAN-REG", "manifold", "gas", "gas", [p - 1.0 for p in reg_out], [300.0] * N)
    gas = [0.0, 0.0, 0.02, 0.03]
    branch("l_kb", "l_kb", "line", "KB1", "MF1", "gas", gas)
    branch("l_reg", "l_reg", "line", "MF1", "PR_D.in", "gas", gas)
    branch("PR_D", "PR-DOME", "regulator", "PR_D.in", "PR_D.out", "gas", gas, cv=0.8)
    branch("l_reg_out", "l_reg_out", "line", "PR_D.out", "MF2", "gas", gas)
    for side, tank, pre, mv, eng, T_liq, head in (("ox", "OXT", "SV_LOX_PRESS", "MVO", "ENG.oxidiser", 90.0, 0.5),
                                                  ("fuel", "FUT", "SV_FUEL_PRESS", "MVF", "ENG.fuel", 293.15, 0.3)):
        mf2 = nodes["MF2"]["p_psia"]
        sv_in = [p - 0.3 for p in mf2]
        sv_drop = [0.0, 0.0, 1.5, 2.0] if side == "ox" else [0.0, 0.0, 1.2, 1.7]
        sv_out = [a - b for a, b in zip(sv_in, sv_drop)]
        ull = [p - 0.3 for p in sv_out]
        node(f"{pre}.in", f"{pre}.in", "junction", side, "gas", sv_in, [300.0] * N)
        node(f"{pre}.out", f"{pre}.out", "junction", side, "gas", sv_out, [300.0] * N)
        node(tank, f"TK-{side}", "tank", side, "gas", ull, [293.0] * N)
        node(f"{tank}.out", f"TK-{side}.out", "tank_outlet", side, "liquid", [p + head for p in ull], [T_liq] * N)
        mdot = [0.0, 0.0, 1.8, 1.9] if side == "ox" else [0.0, 0.0, 1.2, 1.25]
        line1 = [0.0, 0.0, 15.0, 16.0] if side == "ox" else [0.0, 0.0, 31.0, 33.0]
        mv_in = [a - b for a, b in zip(nodes[f"{tank}.out"]["p_psia"], line1)]
        mv_out = [p - (564.0 if not f else 1.1) for p, f in zip(mv_in, FIRING)]
        node(f"{mv}.in", f"{mv}.in", "junction", side, "liquid", mv_in, [T_liq] * N)
        node(f"{mv}.out", f"{mv}.out", "junction", side, "liquid", mv_out, [T_liq] * N)
        exit_p = [p - (0.0 if not f else 2.2) for p, f in zip(mv_out, FIRING)]
        node(eng, eng, "junction", side, "liquid", exit_p, [T_liq] * N)
        pv = 0.0 if side == "ox" else 0.0
        gas_side = [g * (0.55 if side == "ox" else 0.45) for g in gas]
        branch(f"l_{side}press_in", f"l_{side}press_in", "line", "MF2", f"{pre}.in", side, gas_side)
        branch(pre, pre, "solenoid", f"{pre}.in", f"{pre}.out", side, gas_side, cv=1.7)
        branch(f"l_{side}press", f"l_{side}press", "line", f"{pre}.out", tank, side, gas_side)
        branch(f"l_{side}1", f"l_{side}1", "line", f"{tank}.out", f"{mv}.in", side, mdot)
        branch(mv, mv, "valve", f"{mv}.in", f"{mv}.out", side, mdot, cv=26.1)
        branch(f"l_{side}2", f"l_{side}2", "line", f"{mv}.out", eng, side, mdot)
        del pv
    node("ENG.chamber", "ENG.chamber", "chamber", "ox", "gas", [14.7, 14.7, 400.0, 401.0], [85.0] * N)
    branch("ENG.oxidiser.injector", "ENG.oxidiser.injector", "injector", "ENG.oxidiser", "ENG.chamber", "ox",
           branches["l_ox2"]["mdot"])
    branch("ENG.fuel.injector", "ENG.fuel.injector", "injector", "ENG.fuel", "ENG.chamber", "fuel",
           branches["l_fuel2"]["mdot"])
    paths = {side: ["l_kb", "l_reg", "PR_D", "l_reg_out", f"l_{side}press_in", pre, f"l_{side}press",
                    f"l_{side}1", mv, f"l_{side}2", f"{eng}.injector"]
             for side, pre, mv, eng in (("ox", "SV_LOX_PRESS", "MVO", "ENG.oxidiser"),
                                        ("fuel", "SV_FUEL_PRESS", "MVF", "ENG.fuel"))}
    network = {"t": list(T), "nodes": nodes, "branches": branches, "paths": paths}

    def side_series(side, eng, tank):
        inlet = nodes[eng]["p_psia"]
        pc = nodes["ENG.chamber"]["p_psia"]
        dump = [0.0, 0.0, 25.0, 26.0] if side == "ox" else [0.0, 0.0, 15.5, 16.0]
        manifold = [a - b for a, b in zip(inlet, dump)]
        dpi = [max(m - c, 0.0) if f else 0.0 for m, c, f in zip(manifold, pc, FIRING)]
        # before Fire the injector branch carries the whole inlet-to-chamber difference
        dump = [d if f else 0.0 for d, f in zip(dump, FIRING)]
        dpi = [x if f else a - c for x, a, c, f in zip(dpi, inlet, pc, FIRING)]
        return {"tank_psia": nodes[tank]["p_psia"], "outlet_psia": nodes[f"{tank}.out"]["p_psia"],
                "inlet_psia": inlet, "dump_psi": dump, "manifold_psia": manifold,
                "dp_injector_psi": dpi, "mdot": branches[f"l_{side}1"]["mdot"],
                "liquid_K": [90.0 if side == "ox" else 293.15] * N}

    series = {"t": list(T), "firing": list(FIRING),
              "ox": side_series("ox", "ENG.oxidiser", "OXT"),
              "fuel": side_series("fuel", "ENG.fuel", "FUT"),
              "chamber": {"pc_psia": nodes["ENG.chamber"]["p_psia"]}}
    return {"series": series, "network": network}


# ---- 1. ladder ------------------------------------------------------------------------------------

def test_ladder_elements_sum_to_end_to_end_and_head_is_a_gain():
    res = _synthetic()
    lad = L.build_ladder(res)
    assert "error" not in lad, lad
    for side, head in (("ox", 0.5), ("fuel", 0.3)):
        s = lad[side]
        kinds = [e["kind"] for e in s["elements"]]
        # bottle -> regulator -> solenoid -> tank head -> lines/valve -> dump -> orifices -> chamber
        assert kinds == ["line", "line", "regulator", "line", "line", "solenoid", "line", "tank_head",
                         "line", "valve", "line", "dump", "orifice"]
        assert s["start"] == "KB1" and s["end"] == "ENG.chamber"
        # end to end, by hand: bottle minus chamber
        hand = [b - c for b, c in zip(res["network"]["nodes"]["KB1"]["p_psia"],
                                      res["network"]["nodes"]["ENG.chamber"]["p_psia"])]
        assert s["total_psi"] == pytest.approx(hand, abs=1e-9)
        assert s["sum_psi"] == pytest.approx(hand, abs=1e-9)
        assert s["closes"] and s["max_abs_residual_psi"] < 1e-9
        tank_head = s["elements"][7]
        assert tank_head["dp_psi"] == pytest.approx([-head] * N, abs=1e-12)
        # shares add to one at every step
        for k in range(N):
            assert sum(e["share"][k] for e in s["elements"]) == pytest.approx(1.0, abs=1e-12)
    # the injector split: dump + orifices = inlet - Pc, firing
    ox = {e["id"]: e for e in lad["ox"]["elements"]}
    assert ox["ENG.oxidiser.injector:dump"]["dp_psi"][2] == pytest.approx(25.0)
    inlet = res["series"]["ox"]["inlet_psia"][2]
    assert ox["ENG.oxidiser.injector:orifice"]["dp_psi"][2] == pytest.approx(inlet - 25.0 - 400.0)
    assert ox["ENG.oxidiser.injector:orifice"]["check_psi"] == pytest.approx(0.0, abs=1e-9)
    # the solenoid's own drop is what the drawing's branch recorded
    assert ox["SV_LOX_PRESS"]["dp_psi"] == pytest.approx([0.0, 0.0, 1.5, 2.0])


def test_ladder_reports_a_recorder_that_does_not_telescope():
    res = _synthetic()
    # a recorder writing the solenoid's loss without, say, a static term: off by 0.7 psi
    res["network"]["branches"]["SV_LOX_PRESS"]["dp_psi"] = [x + 0.7 for x in
                                                            res["network"]["branches"]["SV_LOX_PRESS"]["dp_psi"]]
    lad = L.build_ladder(res)
    assert not lad["ox"]["closes"]
    assert lad["ox"]["max_abs_residual_psi"] == pytest.approx(0.7)
    assert lad["fuel"]["closes"]


def test_ladder_without_network_is_unavailable_not_a_raise():
    res = _synthetic()
    del res["network"]
    lad = L.build_ladder(res)
    assert lad["available"] is False and "network" in lad["error"]


# ---- 2. regulator and solenoids -------------------------------------------------------------------

from engine.layerx.diag import regulator as R  # noqa: E402


def _he(p_psia, T_K):
    import CoolProp.CoolProp as CP
    p = p_psia * PSI
    rho = CP.PropsSI("D", "P", p, "T", T_K, "Helium")
    gamma = CP.PropsSI("CPMASS", "P", p, "T", T_K, "Helium") / CP.PropsSI("CVMASS", "P", p, "T", T_K, "Helium")
    Z = CP.PropsSI("Z", "P", p, "T", T_K, "Helium")
    mu = CP.PropsSI("V", "P", p, "T", T_K, "Helium")
    return p, rho, gamma, Z, mu


@pytest.mark.parametrize("p2_psia, choked", [(400.0, True), (2500.0, False)])
def test_iec_capacity_by_hand_and_against_fluids(p2_psia, choked):
    from fluids.control_valve import size_control_valve_g
    p1, rho, gamma, Z, mu = _he(3000.0, 293.15)
    p2 = p2_psia * PSI
    got = R.iec_gas_flow(p1, p2, rho, gamma, 0.8, 0.7)
    # by hand, IEC 60534-2-1: Kv = Cv / 1.156, N6 = 3.16 (kg/h, kPa)
    f_gamma = gamma / 1.40
    x = (p1 - p2) / p1
    x_eff = min(x, f_gamma * 0.7)
    Y = 1 - x_eff / (3 * f_gamma * 0.7)
    hand = 3.16 * (0.8 / 1.156099) * Y * math.sqrt(x_eff * p1 / 1e3 * rho) / 3600.0
    assert got["choked"] is choked
    assert got["mdot"] == pytest.approx(hand, rel=2e-5)
    # the library, sizing the other way: the valve that passes this flow is Cv 0.8. fluids takes
    # the flow at 0 degC and 1 atm and the Z form of the same equation; IEC's N9 is rounded.
    q_std = got["mdot"] / (101325.0 * 4.002602e-3 / (8.314462618 * 273.15))
    kv = size_control_valve_g(T=293.15, MW=4.002602, mu=mu, gamma=gamma, Z=Z, P1=p1, P2=p2, Q=q_std,
                              allow_laminar=False)
    assert kv * 1.156099 == pytest.approx(0.8, rel=3e-3)


def test_iec_solenoid_drop_matches_the_audit_hand_check():
    # AUDIT 9.6 D: He, LOX press solenoid at 0.5 s: 0.01121 kg/s, 581.6 psia, 298 K, Cv 1.7.
    # Twin (incompressible Cv law) 1.720 psi, IEC with Y 1.724 psi.
    p1, rho, gamma, Z, mu = _he(581.6, 298.0)
    dp = R.iec_gas_drop(0.01121, p1, rho, gamma, 1.7, 0.7)
    assert dp / PSI == pytest.approx(1.724, abs=0.004)
    # it inverts the flow function
    assert R.iec_gas_flow(p1, p1 - dp, rho, gamma, 1.7, 0.7)["mdot"] == pytest.approx(0.01121, rel=1e-6)
    # incompressible Cv law (Y = 1) by hand: dp = rho (W / (N6' Kv rho))^2 -> smaller than with Y < 1
    kv = 1.7 / 1.156099
    dp_inc = ((0.01121 * 3600.0) / (3.16 * kv)) ** 2 / rho * 1e3
    assert dp_inc / PSI == pytest.approx(1.720, abs=0.004)
    assert dp > dp_inc
    # twice the Cv, a quarter of the drop (to the Y correction)
    dp2 = R.iec_gas_drop(0.01121, p1, rho, gamma, 3.4, 0.7)
    assert dp2 / dp == pytest.approx(0.25, rel=0.01)
    # more than the choked capacity has no drop that passes it
    assert math.isnan(R.iec_gas_drop(10.0, p1, rho, gamma, 1.7, 0.7))


REG_PARAMS = {
    "Cv": (0.8, "manufacturer: TB 1031"),
    "bore": (0.005842, "manufacturer: TB 1031"),
    "supply_coefficient": (0.017, "manufacturer: TB 1031"),
    "inlet_reference": (4500.0 * PSI, "measured"),
    "flow_droop": (8.3 * PSI, "measured"),
    "rated_flow": (0.09646, "measured"),
    "dome_bias": (50.0 * PSI, "manufacturer"),
    "dial": (528.25 * PSI, "Layer X dial"),
}


def _reg_target(p_in, mdot):
    return 528.25 + 50.0 + 0.017 * (4500.0 - p_in) - 8.3 * mdot / 0.09646


def test_regulator_law_split_and_wide_open_by_hand():
    res = _synthetic()
    net = res["network"]
    p_in = net["nodes"]["PR_D.in"]["p_psia"]
    mdot = net["branches"]["PR_D"]["mdot"]
    out_p = [_reg_target(p_in[k], mdot[k]) for k in range(N)]
    out_p[3] -= 11.0                       # starved: 11 psi under its law while flowing
    net["nodes"]["PR_D.out"]["p_psia"] = out_p
    reg = R.build_regulator(res, None, params=REG_PARAMS, gas="helium")
    assert "error" not in reg, reg
    # supply effect and droop at step 2, by hand
    assert reg["spe_psi"][2] == pytest.approx(0.017 * (4500.0 - p_in[2]))
    assert reg["droop_psi"][2] == pytest.approx(8.3 * 0.02 / 0.09646)
    assert reg["target_psia"][2] == pytest.approx(out_p[2])
    assert reg["residual_psi"][:3] == pytest.approx([0.0, 0.0, 0.0], abs=1e-9)
    assert reg["residual_psi"][3] == pytest.approx(-11.0)
    assert reg["wide_open"] == [False, False, False, True]
    assert reg["dome_psia"] == pytest.approx([528.25] * N)
    # capacity: IEC at the inlet node's own state, and the use fraction is flow over it
    p1, rho, gamma, _, _ = _he(p_in[2], 292.9)
    cap = R.iec_gas_flow(p1, out_p[2] * PSI, rho, gamma, 0.8, 0.7)["mdot"]
    assert reg["capacity_mdot"][2] == pytest.approx(cap, rel=1e-9)
    assert reg["use_frac"][2] == pytest.approx(0.02 / cap, rel=1e-9)
    assert reg["choked"][2] is True
    # the outlet's rise over the firing steps is the supply effect minus the droop's growth
    rise = reg["rise"]
    assert rise["outlet_rise_psi"] == pytest.approx(rise["spe_psi"] + rise["droop_psi"] + rise["residual_psi"])
    assert rise["residual_psi"] == pytest.approx(-11.0)
    # the model block names its inputs with provenance
    assert reg["model"]["inputs"]["supply_coefficient"]["provenance"].startswith("manufacturer")
    assert reg["model"]["inputs"]["xT"]["provenance"].startswith("assumed")


def test_solenoid_share_of_regulator_to_tank_by_hand():
    res = _synthetic()
    sol = R.build_solenoids(res, None, gas="helium")
    assert isinstance(sol, list) and len(sol) == 2, sol
    ox = next(s for s in sol if s["side"] == "ox")
    assert ox["id"] == "SV_LOX_PRESS" and ox["cv"] == 1.7
    # regulator outlet 598 -> MF2 597 -> SV.in 596.7 -> SV.out 595.2 -> tank 594.9: 3.1 psi, 1.5 of it the valve
    assert ox["reg_to_tank_psi"][2] == pytest.approx(3.1)
    assert ox["share_of_reg_to_tank"][2] == pytest.approx(1.5 / 3.1)
    assert ox["dp_iec_psi"][0] == 0.0
    p1, rho, gamma, _, _ = _he(596.7, 300.0)
    assert ox["dp_iec_psi"][2] == pytest.approx(R.iec_gas_drop(0.011, p1, rho, gamma, 1.7) / PSI, rel=1e-9)


# ---- 3. pressurant --------------------------------------------------------------------------------

from engine.layerx.diag import pressurant as P  # noqa: E402


def _jt_by_integration(fluid, p1, T1, p2, steps=400):
    """dT along the isenthalp by integrating CoolProp's own Joule-Thomson coefficient (dT/dp)_h,
    RK4 in pressure: a different path through the equation of state than the (p, h) flash."""
    import CoolProp.CoolProp as CP

    def mu(p, T):
        return CP.PropsSI("d(T)/d(P)|Hmass", "P", p, "T", T, fluid)

    T, p = T1, p1
    h = (p2 - p1) / steps
    for _ in range(steps):
        k1 = mu(p, T)
        k2 = mu(p + h / 2, T + h / 2 * k1)
        k3 = mu(p + h / 2, T + h / 2 * k2)
        k4 = mu(p + h, T + h * k3)
        T += h / 6 * (k1 + 2 * k2 + 2 * k3 + k4)
        p += h
    return T - T1


@pytest.mark.parametrize("fluid, sign", [("helium", +1), ("nitrogen", -1)])
def test_joule_thomson_sign_and_magnitude(fluid, sign):
    p1, p2 = 3000.0 * PSI, 600.0 * PSI
    dT = P.jt_temperature_change(fluid, p1, 293.15, p2)
    # helium sits above its inversion temperature at room temperature and warms; nitrogen cools
    assert sign * dT > 1.0
    name = "Helium" if fluid == "helium" else "Nitrogen"
    assert dT == pytest.approx(_jt_by_integration(name, p1, 293.15, p2), abs=2e-3)
    # a small throttle is mu_JT * dp
    import CoolProp.CoolProp as CP
    mu = CP.PropsSI("d(T)/d(P)|Hmass", "P", p1, "T", 293.15, name)
    small = P.jt_temperature_change(fluid, p1, 293.15, p1 - 1e4)
    assert small == pytest.approx(-mu * 1e4, rel=1e-3)


def test_pressurant_budget_and_floor_by_hand():
    import CoolProp.CoolProp as CP
    res = _synthetic()
    V = 4.6871e-3
    T_true = [293.15, 293.15, 288.0, 283.0]
    p_b = res["network"]["nodes"]["KB1"]["p_psia"]
    mass = [CP.PropsSI("D", "P", p * PSI, "T", T, "Helium") * V for p, T in zip(p_b, T_true)]
    res["series"]["copv_mass_kg"] = mass
    res["series"]["copv_psia"] = p_b
    out_end = res["network"]["nodes"]["PR_D.out"]["p_psia"][3]
    pr = P.build_pressurant(res, None, gas="helium", volume_m3=V, regulator={"id": "PR_D", "cv": 0.8})
    assert "error" not in pr, pr
    assert pr["bottle_T_K"] == pytest.approx(T_true, abs=1e-6)
    assert pr["loaded_kg"] == pytest.approx(mass[0])
    assert pr["residual_kg"] == pytest.approx(mass[3])
    assert pr["used_kg"] == pytest.approx(mass[0] - mass[3])
    # The floor state satisfies its four defining equations (checked here at the returned point):
    assert pr["floor_converged"]
    p_b_end, T_b_end = p_b[3] * PSI, T_true[3]
    f_in, T_in = pr["floor_regulator_inlet_psia"] * PSI, pr["floor_regulator_inlet_T_K"]
    f_b, T_b = pr["floor_psia"] * PSI, pr["floor_bottle_T_K"]
    # (1) the regulator, wide open at its inlet state, passes exactly the burnout flow (IEC)
    rho, gamma = R.gas_state("helium", f_in, T_in)
    assert R.iec_gas_flow(f_in, out_end * PSI, rho, gamma, 0.8, 0.7)["mdot"] == pytest.approx(0.03, rel=1e-6)
    # (2) the bottle sits on its burnout isentrope (no heat after burnout: ds = 0)
    s_end = CP.PropsSI("SMASS", "P", p_b_end, "T", T_b_end, "Helium")
    assert CP.PropsSI("SMASS", "P", f_b, "T", T_b, "Helium") == pytest.approx(s_end, rel=1e-6)
    # ... which for helium, near-ideal, is close to T (p/p0)^((gamma-1)/gamma) with gamma = 5/3
    assert T_b == pytest.approx(T_b_end * (f_b / p_b_end) ** 0.4, rel=0.02)
    assert T_b < T_b_end - 30.0                                 # 3000 -> ~600 psia: much colder
    # (3) the regulator inlet gas is the bottle gas throttled through the line (h conserved)
    h_b = CP.PropsSI("HMASS", "P", f_b, "T", T_b, "Helium")
    assert CP.PropsSI("HMASS", "P", f_in, "T", T_in, "Helium") == pytest.approx(h_b, rel=1e-6)
    # (4) the line's 5 psi burnout drop, carried to the floor at the same flow as K mdot^2/(2 rho A^2)
    assert pr["line_drop_end_psi"] == pytest.approx(5.0)
    rho_in_end = CP.PropsSI("D", "P", res["network"]["nodes"]["PR_D.in"]["p_psia"][3] * PSI, "T", 292.9, "Helium")
    drop = 5.0 * rho_in_end / CP.PropsSI("D", "P", f_in, "T", T_in, "Helium")
    assert pr["floor_line_drop_psi"] == pytest.approx(drop, rel=1e-4)
    assert pr["floor_psia"] == pytest.approx(pr["floor_regulator_inlet_psia"] + pr["floor_line_drop_psi"], abs=1e-3)
    assert drop > 10.0                    # a fifth of the pressure, colder: under half the density
    unusable = CP.PropsSI("D", "P", f_b, "T", T_b, "Helium") * V
    assert pr["unusable_kg"] == pytest.approx(unusable, rel=1e-9)
    assert pr["required_kg"] == pytest.approx(mass[0] - mass[3] + unusable)
    assert pr["margin_kg"] == pytest.approx(mass[3] - unusable)
    # the other bound (bottle held at its burnout temperature, line at its burnout drop) is smaller
    f_held = P.regulator_inlet_floor("helium", 0.03, out_end * PSI, 292.9, 0.8, 0.7) + 5.0 * PSI
    held = CP.PropsSI("D", "P", f_held, "T", T_b_end, "Helium") * V
    assert pr["unusable_held_T_kg"] == pytest.approx(held, rel=1e-9)
    assert pr["unusable_held_T_kg"] < pr["unusable_kg"]
    # the burn's own check: the isentrope from the loaded state to the burnout pressure
    s0 = CP.PropsSI("SMASS", "P", p_b[0] * PSI, "T", T_true[0], "Helium")
    assert pr["bottle_T_end_isentropic_K"] == pytest.approx(CP.PropsSI("T", "P", p_b_end, "SMASS", s0, "Helium"))
    # JT on the regulator's inlet node state and outlet node pressure
    p_in = res["network"]["nodes"]["PR_D.in"]["p_psia"][2] * PSI
    p_out = res["network"]["nodes"]["PR_D.out"]["p_psia"][2] * PSI
    assert pr["jt_dT_K"][2] == pytest.approx(P.jt_temperature_change("helium", p_in, 292.9, p_out))
    assert pr["jt_dT_K"][2] > 0


# ---- 4. saturation and cavitation -----------------------------------------------------------------

from engine.layerx.diag import saturation as S  # noqa: E402


def _fake_prep(res):
    """What the diagnostics read off a prepared model: branch bores, node fluids, species."""
    bores = {"l_ox1": 0.01092, "MVO": 0.0127, "l_ox2": 0.01092, "l_fuel1": 0.01092, "MVF": 0.0127,
             "l_fuel2": 0.01092, "ENG.oxidiser.injector": 0.008, "ENG.fuel.injector": 0.0072}
    branches = {bid: SimpleNamespace(component=SimpleNamespace(p={"bore": bores[bid]} if bid in bores else {}))
                for bid in res["network"]["branches"]}
    fluid = {"ox": "oxygen", "fuel": "ethanol", "gas": "helium"}
    nodes = {nid: SimpleNamespace(fluid=("oxygen" if nd["phase"] == "liquid" and nd["side"] == "ox" else
                                         "ethanol" if nd["phase"] == "liquid" else fluid.get(nd["side"], "helium")))
             for nid, nd in res["network"]["nodes"].items()}
    built = SimpleNamespace(network=SimpleNamespace(branches=branches, nodes=nodes), dome_loaders={})
    return SimpleNamespace(model=SimpleNamespace(built=built), setup=None,
                           derived={"species": {"oxidiser": "oxygen", "fuel": "ethanol"}, "pressurant_gas": "helium",
                                    "inlet_nodes": {"oxidiser": "ENG.oxidiser", "fuel": "ENG.fuel"}})


def _fake_config():
    geo = SimpleNamespace(
        oxidizer=SimpleNamespace(n_elements=24, d_jet=0.0016318401623160582, impingement_angle=35.0,
                                 spacing=0.008312130562622994),
        fuel=SimpleNamespace(n_elements=24, d_jet=0.0014715307322406754, impingement_angle=48.0,
                             spacing=0.011038509387163336))
    dis = {"oxidizer": SimpleNamespace(orifice_l_over_d=5.0, inlet_geometry="sharp", inlet_radius_ratio=None,
                                       l_over_d_source="declared"),
           "fuel": SimpleNamespace(orifice_l_over_d=5.545, inlet_geometry="sharp", inlet_radius_ratio=None,
                                   l_over_d_source="declared")}
    return SimpleNamespace(injector=SimpleNamespace(geometry=geo), discharge=dis,
                           fluids={"oxidizer": SimpleNamespace(density=1140.0), "fuel": SimpleNamespace(density=789.0)})


def test_saturation_margin_total_and_static_by_hand():
    import CoolProp.CoolProp as CP
    res = _synthetic()
    sat = S.build_saturation(res, _fake_prep(res))
    assert "error" not in sat, sat
    rows = {r["id"]: r for r in sat["nodes"]}
    assert "ENG.chamber" not in rows and "OXT" not in rows          # gas and chamber nodes excluded
    psat_lox = CP.PropsSI("P", "T", 90.0, "Q", 0, "Oxygen") / PSI     # 14.41 psia
    psat_eth = CP.PropsSI("P", "T", 293.15, "Q", 0, "Ethanol") / PSI  # 0.85 psia
    p = res["network"]["nodes"]["MVO.in"]["p_psia"]
    assert rows["MVO.in"]["margin_psi"] == pytest.approx([x - psat_lox for x in p])
    p_f = res["network"]["nodes"]["MVF.in"]["p_psia"]
    assert rows["MVF.in"]["margin_psi"] == pytest.approx([x - psat_eth for x in p_f])
    # static: less the larger velocity head of l_ox1 (10.92 mm) and MVO (12.7 mm) at the
    # saturated-liquid density -> the 10.92 mm line's
    rho = CP.PropsSI("D", "T", 90.0, "Q", 0, "Oxygen")
    A = math.pi * 0.01092 ** 2 / 4
    q3 = 1.9 ** 2 / (2 * rho * A * A) / PSI                        # ~26 psi at 17.8 m/s
    assert rows["MVO.in"]["margin_static_psi"][3] == pytest.approx(p[3] - psat_lox - q3)
    assert 20.0 < q3 < 30.0
    # the line exit's static uses the line, not the orifices' area on the engine leg
    pe = res["network"]["nodes"]["ENG.oxidiser"]["p_psia"]
    assert rows["ENG.oxidiser"]["margin_static_psi"][3] == pytest.approx(pe[3] - psat_lox - q3)
    # min over the firing steps only
    k = 2 if p[2] - psat_lox < p[3] - psat_lox else 3
    assert rows["MVO.in"]["min_psi"] == pytest.approx(p[k] - psat_lox) and rows["MVO.in"]["t_min"] == T[k]
    # past the shut main, before Fire, the twin holds the line near atmosphere: not graded
    pmo = res["network"]["nodes"]["MVO.out"]["p_psia"]
    assert pmo[0] - psat_lox < 25.0
    assert rows["MVO.out"]["min_psi"] == pytest.approx(min(pmo[2], pmo[3]) - psat_lox)
    assert not any(r["flagged"] for r in sat["nodes"])
    # a node 10 psi over saturation is flagged against the default 25 psi margin
    res["network"]["nodes"]["MVF.in"]["p_psia"] = [psat_eth + 10.0 + q for q in (0, 0, 0, 0)]
    sat = S.build_saturation(res, _fake_prep(res))
    assert {r["id"]: r for r in sat["nodes"]}["MVF.in"]["flagged"]


def test_cavitation_number_by_hand_and_flip_risk():
    import CoolProp.CoolProp as CP
    res = _synthetic()
    cfg = _fake_config()
    cav = S.build_cavitation(res, _fake_prep(res), cfg)
    assert "error" not in cav, cav
    ox = cav["ox"]
    pv = CP.PropsSI("P", "T", 90.0, "Q", 0, "Oxygen") / PSI
    p_up = res["series"]["ox"]["manifold_psia"][3]
    pc = res["series"]["chamber"]["pc_psia"][3]
    assert ox["K"][3] == pytest.approx((p_up - pv) / (p_up - pc))
    A = 24 * math.pi * 0.0016318401623160582 ** 2 / 4
    cd = 1.9 / (A * math.sqrt(2 * 1140.0 * (p_up - pc) * PSI))
    assert ox["Cd_eff"][3] == pytest.approx(cd)
    assert ox["K_crit"][3] == pytest.approx((cd / 0.62) ** 2)       # sharp entry, r/d 0: Cc = Cc0
    assert ox["K"][0] is None                                        # not firing
    assert not ox["cavitates"] and not ox["flip_risk"]
    # starve the orifice: manifold 500 psia against a 150 psia chamber -> K = 1.39 < K_crit 1.6
    s = res["series"]
    s["chamber"]["pc_psia"] = [14.7, 14.7, 400.0, 150.0]
    s["ox"]["manifold_psia"][3] = 500.0
    s["ox"]["dp_injector_psi"][3] = 350.0
    s["ox"]["mdot"][3] = 0.78 * A * math.sqrt(2 * 1140.0 * 350.0 * PSI)
    cav = S.build_cavitation(res, _fake_prep(res), cfg)
    assert cav["ox"]["K"][3] == pytest.approx((500.0 - pv) / 350.0)
    assert cav["ox"]["K_crit"][3] == pytest.approx((0.78 / 0.62) ** 2)
    assert cav["ox"]["cavitates"] and cav["ox"]["flip_risk"]          # L/d 5.0 <= 5.0
    assert cav["ox"]["t_min"] == T[3]
    cfg.discharge["oxidizer"].orifice_l_over_d = 8.0
    cav = S.build_cavitation(res, _fake_prep(res), cfg)
    assert cav["ox"]["cavitates"] and not cav["ox"]["flip_risk"]
    assert cav["model"]["inputs"]["flip_l_over_d_max"]["provenance"].startswith("assumed")


# ---- 5. injector ----------------------------------------------------------------------------------

from engine.layerx.diag import injector as J  # noqa: E402


def test_injector_velocities_momentum_ratio_and_tilt_by_hand():
    res = _synthetic()
    res["replay"] = {"t": [0.05, 0.15], "eta_cstar": [0.91, 0.93]}
    cfg = _fake_config()
    fwd = {"mdot_O": 1.85, "mdot_F": 1.22, "eta_cstar": 0.9105,
           "diagnostics": {"momentum_ratio_R": 1.0304, "rupe_M": 1.1774, "Cd_O": 0.784, "Cd_F": 0.776}}
    inj = J.build_injector(res, None, cfg, forward=fwd)
    assert "error" not in inj, inj
    d_o, d_f = 0.0016318401623160582, 0.0014715307322406754
    A_o, A_f = 24 * math.pi * d_o ** 2 / 4, 24 * math.pi * d_f ** 2 / 4
    m_o, m_f = 1.9, 1.25
    v_o, v_f = m_o / (1140.0 * A_o), m_f / (789.0 * A_f)
    assert inj["v_ox"][3] == pytest.approx(v_o) and inj["v_fuel"][3] == pytest.approx(v_f)
    assert inj["v_ox"][0] is None                                     # not firing
    R_hand = math.sqrt(1140.0 * v_o ** 2 / (789.0 * v_f ** 2))
    assert inj["momentum_ratio"][3] == pytest.approx(R_hand)
    # the closed form the audit's ledger uses: R = O/F (A_F/A_O) sqrt(rho_F/rho_O)
    assert inj["momentum_ratio"][3] == pytest.approx((m_o / m_f) * (A_f / A_o) * math.sqrt(789.0 / 1140.0))
    assert inj["rupe_M"][3] == pytest.approx(R_hand ** 2 * d_o / d_f)
    # tilt: LOX ring inboard (s_O < s_F), so LOX travels outward to the collision, fuel inward
    p_o, p_f = m_o * v_o, m_f * v_f
    pr = p_o * math.sin(math.radians(35.0)) - p_f * math.sin(math.radians(48.0))
    pz = p_o * math.cos(math.radians(35.0)) + p_f * math.cos(math.radians(48.0))
    assert inj["resultant_angle_deg"][3] == pytest.approx(math.degrees(math.atan2(pr, pz)))
    assert inj["design_momentum_ratio"] == 1.0304
    # eta_c*: inside the replay's span by linear interpolation, null outside it
    assert inj["eta_cstar"][2] == pytest.approx(0.91)
    assert inj["eta_cstar"][3] == pytest.approx(0.92)
    assert inj["eta_cstar"][1] is None


# ---- 6. thrust shape ------------------------------------------------------------------------------

from engine.layerx.diag import thrustshape as TS  # noqa: E402

PC0 = 400.0 * PSI          # a chamber held at 400 psia
C_FLOW = {"ox": 1.9 / math.sqrt(170.0 * PSI), "fuel": 1.25 / math.sqrt(160.0 * PSI)}
K_THRUST = 2300.0          # N per kg/s


def _fake_engine(p_O, p_F):
    """mdot = c sqrt(p_line - Pc0), F = k (mdot_O + mdot_F): closed-form, so the feed solve has one."""
    mO = C_FLOW["ox"] * math.sqrt(max(p_O - PC0, 0.0))
    mF = C_FLOW["fuel"] * math.sqrt(max(p_F - PC0, 0.0))
    return {"mdot_O": mO, "mdot_F": mF, "F": K_THRUST * (mO + mF)}


def _fed(p_out, K, side):
    """Closed form of mdot = c sqrt(p_out - K mdot^2 - Pc0)."""
    c = C_FLOW[side]
    return math.sqrt(c * c * (p_out - PC0) / (1.0 + c * c * K))


def _thrust_result(K_drift=0.0, accel=None):
    t = [0.0, 0.05, 0.1, 0.2, 0.3, 0.4]
    firing = [False, True, True, True, True, True]
    K0 = {"ox": 17.0 * PSI / 1.9 ** 2, "fuel": 33.0 * PSI / 1.25 ** 2}
    head = {"ox": 0.5, "fuel": 0.3}
    series = {"t": t, "firing": firing, "dt": [0.05, 0.05, 0.05, 0.1, 0.1, 0.1]}
    for s in ("ox", "fuel"):
        tank = [578.0 + 100.0 * x for x in t]
        a = [9.80665] * len(t) if accel is None else accel
        outlet = [p + head[s] * ai / 9.80665 for p, ai in zip(tank, a)]
        K = [K0[s] * (1.0 + K_drift * x) for x in t]
        m = [_fed(o * PSI, k, s) for o, k in zip(outlet, K)]
        inlet = [o - k * mm * mm / PSI for o, k, mm in zip(outlet, K, m)]
        series[s] = {"tank_psia": tank, "outlet_psia": outlet, "inlet_psia": inlet, "mdot": m}
    idx = [1, 2, 3, 4, 5]
    F_ab = [_fake_engine(series["ox"]["inlet_psia"][i] * PSI, series["fuel"]["inlet_psia"][i] * PSI)["F"] for i in idx]
    F_del = [f * (1.0 + 0.01 * t[i]) for f, i in zip(F_ab, idx)]
    replay = {"t": [t[i] for i in idx], "index": idx, "thrust_N": F_del,
              "inlet_O_psia": [series["ox"]["inlet_psia"][i] for i in idx],
              "inlet_F_psia": [series["fuel"]["inlet_psia"][i] for i in idx]}
    delivered = {"t": [t[i] for i in idx], "thrust_N": F_del,
                 "summary": {"mean_thrust_N": sum(F_del) / len(F_del)}}
    res = {"series": series, "replay": replay, "delivered": delivered}
    if accel is not None:
        res["flight"] = {"ok": True, "schedule": {"t": t, "accel_m_s2": accel}}
    return res, K0, head, F_ab, F_del


def test_thrust_breakdown_by_closed_form():
    res, K0, head, F_ab, F_del = _thrust_result(K_drift=0.5)
    ts = TS.build_thrust_shape(res, None, None, sampler=_fake_engine, target_N=7000.0)
    assert "error" not in ts, ts
    b = ts["breakdown"]
    assert b["k0"] == 2 and b["t0"] == 0.2                             # first replay point 0.2 s after Fire
    t = [0.05, 0.1, 0.2, 0.3, 0.4]

    def F_T(j):  # the as-built engine through the k0 lines from the one-g tank outlet
        i = res["replay"]["index"][j]
        return K_THRUST * sum(_fed(res["series"][s]["outlet_psia"][i] * PSI, K0[s] * (1 + 0.5 * 0.2), s)
                              for s in ("ox", "fuel"))

    for j in (3, 4):
        assert b["erosion_N"][j] == pytest.approx((F_del[j] - F_ab[j]) - (F_del[2] - F_ab[2]), rel=1e-9)
        assert b["tank_pressure_N"][j] == pytest.approx(F_T(j) - F_T(2), rel=1e-6)
        assert b["accel_head_N"][j] == pytest.approx(0.0, abs=1e-9)
        # the components add to the delivered change, and the residual is the drifting K's doing
        assert b["dF_N"][j] == pytest.approx(F_del[j] - F_del[2])
        total = b["tank_pressure_N"][j] + b["erosion_N"][j] + b["accel_head_N"][j] + b["residual_N"][j]
        assert total == pytest.approx(b["dF_N"][j], rel=1e-12)
        assert b["residual_N"][j] == pytest.approx((F_ab[j] - F_ab[2]) - (F_T(j) - F_T(2)), abs=1e-6)
        assert b["residual_N"][j] < -1.0                                # the line got lossier
    assert b["dF_N"][0] is None                                         # before k0
    # with the lines' K fixed, the fixed-K feed explains the feed entirely
    res, *_ = _thrust_result(K_drift=0.0)
    b0 = TS.build_thrust_shape(res, None, None, sampler=_fake_engine)["breakdown"]
    assert b0["residual_N"][4] == pytest.approx(0.0, abs=1e-5)
    assert b0["feed_solve"]["converged"]
    # shape: about the delivered mean, over t >= 0.2 s
    mean = sum(F_del) / 5
    dev = [f - mean for f, tt in zip(F_del, t) if tt >= 0.2]
    assert ts["dev_max_pct"] == pytest.approx(max(abs(d) for d in dev) / mean * 100)
    w = [0.05, 0.1, 0.05]                                               # trapezoid weights on 0.2/0.3/0.4
    assert ts["dev_rms_pct"] == pytest.approx(math.sqrt(sum(wi * d * d for wi, d in zip(w, dev)) / 0.2) / mean * 100)
    assert ts["target_N"] == 7000.0 and ts["target_source"] == "restated for this run"


def test_thrust_breakdown_acceleration_head_when_flown():
    accel = [9.80665 * (1.0 + 20.0 * x) for x in [0.0, 0.05, 0.1, 0.2, 0.3, 0.4]]
    res, K0, head, F_ab, F_del = _thrust_result(K_drift=0.0, accel=accel)
    b = TS.build_thrust_shape(res, None, None, sampler=_fake_engine)["breakdown"]
    assert b["accel_basis"].startswith("flight")

    def F_T(j, flown):
        i = res["replay"]["index"][j]
        tot = 0.0
        for s in ("ox", "fuel"):
            p = res["series"][s]["tank_psia"][i] + head[s] * (accel[i] / 9.80665 if flown else 1.0)
            tot += _fed(p * PSI, K0[s], s)
        return K_THRUST * tot

    want = (F_T(4, True) - F_T(4, False)) - (F_T(2, True) - F_T(2, False))
    assert b["accel_head_N"][4] == pytest.approx(want, rel=1e-6)
    assert b["accel_head_N"][4] > 0.0                                   # more g, more head, more thrust
    assert b["tank_pressure_N"][4] == pytest.approx(F_T(4, False) - F_T(2, False), rel=1e-6)
    assert b["residual_N"][4] == pytest.approx(0.0, abs=1e-5)


# ---- 7. ledger ------------------------------------------------------------------------------------

from engine.layerx.diag import ledger as LG  # noqa: E402


def test_ledger_rows_design_from_forward_delivered_from_the_burn():
    import CoolProp.CoolProp as CP
    res = _synthetic()
    s = res["series"]
    s["dt"] = [0.05, 0.05, 0.05, 0.10]
    s["ox"]["stiffness"] = [0.0, 0.0, 0.36, 0.40]
    s["regulators"] = {"PR_D": {"label": "PR-DOME", "outlet_psia": res["network"]["nodes"]["PR_D.out"]["p_psia"]}}
    res["delivered"] = {"t": [0.05, 0.10], "pc_psia": [400.0, 401.0], "thrust_N": [6750.0, 6800.0],
                        "throat_area_ratio": [1.0, 1.04], "mr": [1.52, 1.51], "ambient_psia": [13.64, 13.64],
                        "summary": {"total_impulse_Ns": 24240.0}}
    res["replay"] = {"t": [0.05, 0.10], "eta_cstar": [0.910, 0.912]}
    res["summary"] = {"burn_time_s": 3.456}
    cfg = _fake_config()
    cfg.chamber_geometry = SimpleNamespace(A_throat=1.7947e-3, expansion_ratio=4.8276, Lstar=1.3586,
                                           nozzle_efficiency=0.95)
    cfg.thrust = SimpleNamespace(burn_time=3.994)
    cfg.design_requirements = SimpleNamespace(lox_tank_capacity_kg=6.611, fuel_tank_capacity_kg=4.404)
    fwd = {"Pc": 393.22 * PSI, "F": 6803.7, "MR": 1.5232, "Isp": 224.77, "mdot_O": 1.8633, "mdot_F": 1.2233,
           "eta_cstar": 0.9105, "P_ambient": 94069.7, "Cd_O": 0.784, "Cd_F": 0.776,
           "_basis": {"tank_psia": 578.0},
           "diagnostics": {"delta_p_feed_O": 41.34 * PSI, "delta_p_feed_F": 47.31 * PSI,
                           "delta_p_injector_O": 143.44 * PSI, "delta_p_injector_F": 137.47 * PSI,
                           "P_injector_O": 536.66 * PSI, "P_injector_F": 530.69 * PSI}}
    led = LG.build_ledger(res, None, cfg, forward=fwd)
    assert isinstance(led, list), led
    rows = {r["key"]: r for r in led}
    # design: the Forward solve at the lockup, not config fields
    assert rows["pc"]["design_value"] == pytest.approx(393.22)
    assert rows["feed_loss_ox"]["design_value"] == pytest.approx(41.34)
    assert rows["stiffness_ox"]["design_value"] == pytest.approx(143.44 / 393.22)
    assert rows["tank_pressure_ox"]["design_value"] == 578.0
    assert rows["ambient"]["design_value"] == pytest.approx(94069.7 / PSI)
    assert rows["impulse"]["design_value"] == pytest.approx((6.611 + 4.404) * 224.77 * 9.80665)
    # delivered: firing steps only, dt-weighted mean
    tank = s["ox"]["tank_psia"]
    d = rows["tank_pressure_ox"]["delivered"]
    assert d["start"] == pytest.approx(tank[2]) and d["end"] == pytest.approx(tank[3])
    assert d["mean"] == pytest.approx((tank[2] * 0.05 + tank[3] * 0.10) / 0.15)
    loss = [a - b for a, b in zip(s["ox"]["tank_psia"], s["ox"]["manifold_psia"])]
    assert rows["feed_loss_ox"]["delivered"]["max"] == pytest.approx(max(loss[2:]))
    assert rows["stiffness_ox"]["delivered"]["max"] == pytest.approx(0.40)
    assert rows["throat_area"]["delivered"]["end"] == pytest.approx(1.7947e-3 * 1.04 * 1e6)
    assert rows["eta_cstar"]["delivered"]["mean"] == pytest.approx(0.911)
    # Cd from the twin's flow and orifice drop
    A = 24 * math.pi * 0.0016318401623160582 ** 2 / 4
    dpi = s["ox"]["dp_injector_psi"][3] * PSI
    assert rows["cd_ox"]["delivered"]["end"] == pytest.approx(1.9 / (A * math.sqrt(2 * 1140.0 * dpi)))
    # density: config for the engine, the twin's saturated line delivered
    assert rows["density_ox"]["design_value"] == 1140.0
    assert rows["density_ox"]["delivered"]["mean"] == pytest.approx(CP.PropsSI("D", "T", 90.0, "Q", 0, "Oxygen"))
    assert rows["density_ox"]["replaced"] == "no"
    # pad: one g, and the tank head EngineDesign does not have
    assert rows["specific_force"]["delivered"]["mean"] == 1.0
    assert rows["tank_head_ox"]["design_value"] == 0.0
    assert rows["tank_head_ox"]["delivered"]["mean"] == pytest.approx(0.5)
    for r in led:
        assert r["replaced"] in ("yes", "partly", "no")
    # without a Forward solve the Forward rows say so instead of guessing
    led = {r["key"]: r for r in LG.build_ledger(res, None, cfg)}
    assert led["pc"]["design_value"] is None and "no Forward" in led["pc"]["design_source"]


# ---- the recorder's own shape: the tank head as an element on the path -----------------------------

def _recorder_style(res):
    """lib/feedtwin's NetworkTrace puts ``<tank>.head`` (kind tank_head) on each path and calls a
    drawn SOL main valve a solenoid. Reshape the synthetic stand the same way."""
    net = res["network"]
    for side, tank, mv in (("ox", "OXT", "MVO"), ("fuel", "FUT", "MVF")):
        up, dn = net["nodes"][tank]["p_psia"], net["nodes"][f"{tank}.out"]["p_psia"]
        net["branches"][f"{tank}.head"] = {"label": f"TK-{side} liquid head", "kind": "tank_head",
                                           "from": tank, "to": f"{tank}.out", "side": side,
                                           "mdot": net["branches"][f"l_{side}1"]["mdot"],
                                           "dp_psi": [a - b for a, b in zip(up, dn)]}
        net["branches"][mv]["kind"] = "solenoid"
        path = net["paths"][side]
        path.insert(path.index(f"l_{side}1"), f"{tank}.head")
    for nid in ("ENG.oxidiser", "ENG.fuel"):
        net["nodes"][nid]["kind"] = "injector_inlet"
    net["nodes"]["MVO.out"]["T_K"] = [0.0, 0.0, 90.0, 90.0]     # the recorder's 0.0: not reached
    net["nodes"]["MVF.in"]["T_K"] = [0.0] * N                     # never reached by the walk
    return res


def test_diagnostics_on_the_recorder_shape():
    res = _recorder_style(_synthetic())
    lad = L.build_ladder(res)
    for side, head in (("ox", 0.5), ("fuel", 0.3)):
        s = lad[side]
        assert s["closes"]
        assert [e["kind"] for e in s["elements"]][7] == "tank_head"
        assert s["elements"][7]["dp_psi"] == pytest.approx([-head] * N)
    sol = R.build_solenoids(res, None, gas="helium")
    # the press solenoids only: the mains past the tank are not on the regulator-to-tank leg
    assert sorted(r["id"] for r in sol) == ["SV_FUEL_PRESS", "SV_LOX_PRESS"]
    ox = next(r for r in sol if r["side"] == "ox")
    assert ox["share_of_reg_to_tank"][2] == pytest.approx(1.5 / 3.1)
    sat = S.build_saturation(res, _fake_prep(res))
    mvo = {r["id"]: r for r in sat["nodes"]}["MVO.out"]
    assert mvo["margin_psi"][0] is None and mvo["margin_psi"][2] is not None
    # a node the walk never reached falls back to the tank's bulk liquid temperature
    mvf = {r["id"]: r for r in sat["nodes"]}["MVF.in"]
    assert mvf["T_source"].startswith("series.fuel.liquid_K")
    assert mvf["min_psi"] is not None


# ---- the LE4 helium burn (slow; LAYERX_GOLDEN=1) ----------------------------------------------------

@pytest.mark.skipif(os.environ.get("LAYERX_GOLDEN") != "1", reason="slow LE4 burn: set LAYERX_GOLDEN=1 to run it")
def test_feed_diagnostics_on_the_le4_helium_burn(monkeypatch):
    """The baseline design on copv_study_he, pad, default settings, with lib/feedtwin's network
    recorder on, against the hand checks of AUDIT 9.6-9.7 and the baseline (section 8)."""
    import dataclasses
    import importlib.util
    from pathlib import Path

    fb = pytest.importorskip("feedtwin.session.burn")
    if "network" not in {f.name for f in dataclasses.fields(fb.Probes)}:
        pytest.skip("lib/feedtwin has no network recorder")
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location("layerx_baseline", root / "scripts" / "layerx_baseline.py")
    lb = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(lb)
    from engine.core.runner import PintleEngineRunner
    from engine.layerx import LayerXSettings, prepare, run_prepared

    traces = []
    find = fb.find_probes
    monkeypatch.setattr(fb, "find_probes", lambda s: dataclasses.replace(find(s), network=True))
    rec = fb.BurnTrace.recorder
    monkeypatch.setattr(fb.BurnTrace, "recorder", lambda self, s: (traces.append(self), rec(self, s))[1])

    config, _ = lb.load_engine_config(root / "docs" / "layerx" / "baseline-2026-10-02.json")
    drawing = lb.find_drawing("copv_study_he")
    cfg = copy.deepcopy(config)
    runner = PintleEngineRunner(cfg)
    prep = prepare(cfg, runner, drawing, LayerXSettings(drawing_id=drawing.id), [])
    result = run_prepared(prep, runner=runner, replay=True, config=cfg)
    if not isinstance(result.get("network"), dict) or "nodes" not in result["network"]:
        result["network"] = fb.network_record(traces[-1])
    from engine.layerx.diag.ledger import build_feed_diagnostics

    d = build_feed_diagnostics(result, prep, cfg, runner=runner, target_N=7200.0)
    for key, block in d.items():
        assert not (isinstance(block, dict) and block.get("available") is False), (key, block)
    t = result["series"]["t"]
    k05 = min(range(len(t)), key=lambda i: abs(t[i] - 0.5))
    # ladder: closes on node values; AUDIT 9.6 B2 at 0.5 s
    for side in ("ox", "fuel"):
        assert d["ladder"][side]["closes"], d["ladder"][side]["max_abs_residual_psi"]
    sol = {r["id"]: r for r in d["solenoids"]}
    assert sol["SV_LOX_PRESS"]["dp_psi"][k05] == pytest.approx(1.72, abs=0.03)
    assert sol["SV_FUEL_PRESS"]["dp_psi"][k05] == pytest.approx(1.42, abs=0.03)
    assert sol["SV_LOX_PRESS"]["dp_iec_psi"][k05] == pytest.approx(sol["SV_LOX_PRESS"]["dp_psi"][k05], rel=0.01)
    # regulator: on its drawn law; outlet rise is the supply effect less the droop (AUDIT C2: +47.1)
    reg = d["regulator"]
    assert max(abs(x) for x, f in zip(reg["residual_psi"], result["series"]["firing"]) if f) < 0.05
    assert reg["rise"]["outlet_rise_psi"] == pytest.approx(47.1, abs=0.5)
    assert not reg["any_wide_open"] and 0.15 < reg["use_frac_max"] < 0.25
    # pressurant: AUDIT 8 (0.0906 kg He used); helium warms across the regulator, as the twin walks it
    pr = d["pressurant"]
    assert pr["species"] == "helium" and pr["used_kg"] == pytest.approx(0.0906, abs=0.001)
    live = [(a, b) for a, b, f in zip(pr["jt_dT_K"], pr["twin_dT_K"], result["series"]["firing"]) if f]
    assert all(a > 0 for a, _ in live) and max(abs(a - b) for a, b in live) < 0.05
    assert pr["margin_kg"] > 0
    # saturation and cavitation: AUDIT 9.5 4 (LOX >= ~540 psi of margin); K well above K_crit
    assert min(r["min_psi"] for r in d["saturation"]["nodes"] if r["side"] == "ox") > 500.0
    assert not d["cavitation"]["ox"]["cavitates"] and 3.0 < d["cavitation"]["ox"]["min_K"] < 4.0
    # injector: AUDIT ledger #18, R 1.0311 -> 1.0279
    lo, hi = d["injector"]["range"]["momentum_ratio"]
    assert lo == pytest.approx(1.0279, abs=5e-4) and hi == pytest.approx(1.0311, abs=5e-4)
    # thrust shape: AUDIT 1 #5 / 9.7 #11 -- 29 steps within 2 % of 7.2 kN, first at 2.90 s
    ts = d["thrust_shape"]
    assert ts["t_first_at_target"] == pytest.approx(2.90, abs=0.051)
    end = ts["breakdown"]["at_end"]
    assert end["tank_pressure_N"] + end["erosion_N"] + end["accel_head_N"] + end["residual_N"] == \
        pytest.approx(end["dF_N"], abs=1e-6)
    assert abs(end["residual_N"]) < 0.05 * end["dF_N"]
    # ledger: AUDIT 4 #1 and #4
    led = {r["key"]: r for r in d["ledger"]}
    assert led["tank_pressure_ox"]["delivered"]["end"] == pytest.approx(618.35, abs=3.0)
    assert led["feed_loss_ox"]["design_value"] == pytest.approx(41.34, abs=0.1)
