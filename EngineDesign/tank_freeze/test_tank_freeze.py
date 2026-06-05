"""Sanity / unit tests for the tank-freeze model (guide section 9).

Run from the EngineDesign directory (or anywhere):
    python tank_freeze/test_tank_freeze.py
"""

import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np

from tank_freeze import (
    TankFreezeInputs,
    cold_path,
    convection,
    get_ethanol_table,
    oxygen_Tsat,
    oxygen_chf_zuber,
    run_tank_freeze,
    run_tank_freeze_bounds,
)


def base_inputs(**overrides) -> TankFreezeInputs:
    kw = dict(
        r_i=0.10,
        r_o=0.103,
        H=1.0,
        P_tank_pa=101325.0,
        T_eth0=293.0,
        m_liq0=24.6,  # ~ rho(293K) * pi * r_i^2 * H
        t_mission_s=1200.0,
        t_solidify_max_s=4 * 3600.0,
    )
    kw.update(overrides)
    return TankFreezeInputs(**kw)


def test_churchill_chu_reference():
    """Nu(Ra=1e9, Pr=7) hand-computed from the correlation: 152.5."""
    Ra, Pr = 1e9, 7.0
    Nu_hand = (0.825 + 0.387 * Ra ** (1 / 6) / (1 + (0.492 / Pr) ** (9 / 16)) ** (8 / 27)) ** 2
    assert abs(Nu_hand - 152.5) / 152.5 < 0.01, f"hand Nu = {Nu_hand:.1f}, expected ~152.5"

    # And the model's convection() must reproduce the same formula given the
    # film-temperature properties it looks up itself.
    inp = base_inputs()
    table = get_ethanol_table(350.0)
    T_eth = 293.0
    h1, Ra_m, regime, _ = convection(T_eth, inp.r_i, inp, table)
    T_f = 0.5 * (T_eth + inp.T_fr)
    p = table.props(T_f)
    nu, alpha = p.mu / p.rho, p.k / (p.rho * p.cp)
    Pr_m = nu / alpha
    Nu_expected = (
        0.825 + 0.387 * Ra_m ** (1 / 6) / (1 + (0.492 / Pr_m) ** (9 / 16)) ** (8 / 27)
    ) ** 2
    h1_expected = Nu_expected * p.k / inp.H
    assert abs(h1 - h1_expected) / h1_expected < 1e-9
    print(f"  Churchill-Chu OK: Nu(1e9, 7) = {Nu_hand:.1f}; model h1(293K) = {h1:.1f} W/m^2K ({regime})")


def test_conduction_limit_stefan():
    """h1 = 0 -> quasi-steady Stefan growth, delta ~ sqrt(2 k_s dT t / (rho_s L)).

    For small delta/r_i the cylindrical solution is close to planar; compare
    at t = 40 s where delta ~ 5 mm on r_i = 100 mm.
    """
    inp = base_inputs(h1_multiplier=0.0, t_mission_s=40.0)
    res = run_tank_freeze(inp)
    T_LOX = oxygen_Tsat(inp.P_tank_pa)
    t_end = inp.t_mission_s
    delta_model = res.ice_at_mission_m
    delta_analytic = math.sqrt(2 * inp.k_s * (inp.T_fr - T_LOX) * t_end / (inp.rho_s * inp.L_fus))
    err = abs(delta_model - delta_analytic) / delta_analytic
    assert err < 0.10, f"conduction-limit Stefan error {100*err:.1f}% (model {delta_model*1e3:.2f} mm vs analytic {delta_analytic*1e3:.2f} mm)"
    print(f"  Conduction-limit Stefan OK: {delta_model*1e3:.2f} mm vs analytic {delta_analytic*1e3:.2f} mm ({100*err:.1f}%)")


def test_resistance_ordering():
    """R_w << R_ice once a finite ice layer exists (guide section 9)."""
    inp = base_inputs()
    T_LOX = oxygen_Tsat(inp.P_tank_pa)
    _, _, R_ice, R_w = cold_path(inp.r_i - 0.005, inp, T_LOX)  # 5 mm of ice
    assert R_w < 0.05 * R_ice, f"R_w = {R_w:.2e} not << R_ice = {R_ice:.2e}"
    print(f"  Resistance ordering OK: R_ice = {R_ice:.2e} K/W, R_w = {R_w:.2e} K/W")


def test_energy_balance():
    """integral(Qout) closes against bulk sensible loss + latent heat (<5%)."""
    res = run_tank_freeze(base_inputs())
    assert abs(res.energy_balance_error_pct) < 5.0, (
        f"energy balance error {res.energy_balance_error_pct:.2f}%"
    )
    print(f"  Energy balance OK: {res.energy_balance_error_pct:+.2f}%")


def test_step_and_seed_independence():
    """Halving delta_seed / tightening sampling must not move the answer."""
    a = run_tank_freeze(base_inputs())
    b = run_tank_freeze(base_inputs(delta_seed=5e-6, plot_points=800))
    rel = abs(a.ice_at_mission_m - b.ice_at_mission_m) / max(a.ice_at_mission_m, 1e-12)
    assert rel < 0.02, f"ice_at_mission moved {100*rel:.2f}% with smaller seed"
    print(
        f"  Seed/step independence OK: ice(mission) = {a.ice_at_mission_m*1e3:.2f} mm "
        f"vs {b.ice_at_mission_m*1e3:.2f} mm ({100*rel:.2f}%)"
    )


def test_bounds_ordering():
    """Guide section 8: h1-high -> faster bulk cool-down and sooner freeze.

    Note the ice-THICKNESS ordering (h1-low -> more ice) is a quasi-static
    expectation that can flip in deeply unbounded transients (faster cooling
    dominates), so it is reported, not asserted — the UI takes worst-case
    numbers across both bounds.
    """
    hi, lo = run_tank_freeze_bounds(base_inputs(), mode="both")
    assert hi.bound_label == "h1_high" and lo.bound_label == "h1_low"
    assert hi.T_eth_at_mission_K < lo.T_eth_at_mission_K, (
        "expected faster bulk cool-down from h1_high"
    )
    if hi.t_solidify_s is not None and lo.t_solidify_s is not None:
        assert hi.t_solidify_s <= lo.t_solidify_s, (
            f"expected h1_high to solidify sooner ({hi.t_solidify_s:.0f} s vs {lo.t_solidify_s:.0f} s)"
        )
    print(
        f"  Bounds ordering OK: T_eth(mission) h1_high = {hi.T_eth_at_mission_K:.1f} K < "
        f"h1_low = {lo.T_eth_at_mission_K:.1f} K; "
        f"ice(mission) h1_high = {hi.ice_at_mission_m*1e3:.2f} mm, h1_low = {lo.ice_at_mission_m*1e3:.2f} mm"
    )


def test_headline_outputs():
    """Smoke test: full bounds run produces finite, sane deliverables."""
    t0 = time.time()
    results = run_tank_freeze_bounds(base_inputs(mu_pump_max=0.01, delta_ice_max=0.01), mode="both")
    dt = time.time() - t0
    for r in results:
        assert r.classification in ("BOUNDED", "UNBOUNDED")
        assert np.isfinite(r.ice_at_mission_m) and 0 < r.ice_at_mission_m < 0.1
        assert np.isfinite(r.T_eth_at_mission_K)
        assert len(r.t_s) == len(r.ice_thickness_m) == len(r.mu_eth_Pa_s)
        assert all(np.isfinite(r.ice_thickness_m))
        assert r.T_LOX_K < 95.0
        assert r.lox_chf_W_m2 > 1e4
        deq = "none (full solidification)" if r.delta_eq_m is None else f"{r.delta_eq_m*1e3:.2f} mm"
        tsol = (
            f"> {base_inputs().t_solidify_max_s/60:.0f} min" if r.solidify_capped
            else (f"{r.t_solidify_s/60:.1f} min" if r.t_solidify_s else "n/a")
        )
        print(
            f"  [{r.bound_label}] {r.classification}; delta_eq = {deq}; "
            f"ice(20 min) = {r.ice_at_mission_m*1e3:.2f} mm; "
            f"T_eth(20 min) = {r.T_eth_at_mission_K:.1f} K; "
            f"mu(20 min) = {r.mu_at_mission_Pa_s*1e3:.2f} mPa s; t_solidify = {tsol}; "
            f"E-bal = {r.energy_balance_error_pct:+.2f}%"
        )
    print(f"  CHF (Zuber, 1 atm) = {oxygen_chf_zuber(101325.0):.2e} W/m^2")
    print(f"  Headline smoke test OK ({dt:.1f} s for both bounds)")


def swapped_inputs(**overrides) -> TankFreezeInputs:
    """LOX inner / ethanol outer annulus: ice grows outward from r_o to r_t."""
    kw = dict(
        fluid_inner="lox",
        fluid_outer="ethanol",
        r_i=0.10,
        r_o=0.103,
        r_t=0.15,
        H=1.0,
        P_tank_pa=101325.0,
        T_eth0=293.0,
        m_liq0=25.0,
        t_mission_s=1200.0,
        t_solidify_max_s=4 * 3600.0,
    )
    kw.update(overrides)
    return TankFreezeInputs(**kw)


def test_outward_conduction_limit():
    """Swapped geometry, h1 = 0: early outward growth matches planar Stefan."""
    inp = swapped_inputs(h1_multiplier=0.0, t_mission_s=40.0)
    res = run_tank_freeze(inp)
    T_LOX = oxygen_Tsat(inp.P_tank_pa)
    delta_model = res.ice_at_mission_m
    delta_analytic = math.sqrt(2 * inp.k_s * (inp.T_fr - T_LOX) * 40.0 / (inp.rho_s * inp.L_fus))
    err = abs(delta_model - delta_analytic) / delta_analytic
    assert err < 0.10, f"outward conduction-limit error {100*err:.1f}%"
    print(f"  Outward conduction-limit OK: {delta_model*1e3:.2f} mm vs analytic {delta_analytic*1e3:.2f} mm ({100*err:.1f}%)")


def test_swapped_config_smoke():
    """LOX inner / ethanol outer: bounds run, ice grows outward, energy closes."""
    results = run_tank_freeze_bounds(swapped_inputs(), mode="both")
    for r in results:
        assert r.mode == "freeze" and r.bulk_fluid == "ethanol" and not r.bulk_inside
        assert 0.0 < r.ice_at_mission_m <= (0.15 - 0.103) + 1e-9
        assert all(0.0 <= v <= (0.15 - 0.103) + 1e-9 for v in r.ice_thickness_m)
        assert abs(r.energy_balance_error_pct) < 5.0
        print(
            f"  [swapped {r.bound_label}] {r.classification}: ice(20 min) = "
            f"{r.ice_at_mission_m*1e3:.2f} mm (outward), E-bal = {r.energy_balance_error_pct:+.2f}%"
        )


def test_ethanol_methane():
    """Methane sink (111.7 K) drives less ice than LOX (90.2 K) — smaller dT."""
    vs_lox = run_tank_freeze(base_inputs())
    vs_ch4 = run_tank_freeze(base_inputs(fluid_outer="methane"))
    assert vs_ch4.sink_fluid == "methane" and abs(vs_ch4.T_LOX_K - 111.7) < 0.5
    assert vs_ch4.ice_at_mission_m < vs_lox.ice_at_mission_m
    print(
        f"  Ethanol/methane OK: ice(20 min) = {vs_ch4.ice_at_mission_m*1e3:.2f} mm vs "
        f"{vs_lox.ice_at_mission_m*1e3:.2f} mm against LOX"
    )


def test_methane_lox_modes():
    """Methane vs LOX: marginal freeze at 1 atm; cooling-only at 30 psia."""
    kw = dict(fluid_inner="methane", fluid_outer="lox", r_i=0.10, r_o=0.103, H=1.0,
              T_eth0=105.0, m_liq0=13.5, t_mission_s=1200.0, t_solidify_max_s=7200.0)
    marginal = run_tank_freeze(TankFreezeInputs(P_tank_pa=101325.0, **kw))
    assert marginal.mode == "freeze" and marginal.bulk_fluid == "methane"
    assert 0.0 < marginal.ice_at_mission_m < 0.01  # tiny: only ~0.5 K of driving dT
    cooling = run_tank_freeze(TankFreezeInputs(P_tank_pa=30 * 6894.757, **kw))
    assert cooling.mode == "cooling" and cooling.classification == "NO_FREEZING"
    assert cooling.ice_at_mission_m == 0.0
    T = cooling.T_eth_K
    assert all(T[i + 1] <= T[i] + 1e-9 for i in range(len(T) - 1)), "bulk must cool monotonically"
    assert T[-1] >= cooling.T_LOX_K - 0.1, "bulk cannot cool below the sink"
    print(
        f"  Methane/LOX OK: 1 atm -> {marginal.ice_at_mission_m*1e3:.2f} mm of methane ice "
        f"(T_sink {marginal.T_LOX_K:.2f} K vs T_fr {DEFAULTS_CH4_TFR} K); "
        f"30 psia -> NO_FREEZING, T: 105 -> {T[-1]:.1f} K (T_sink {cooling.T_LOX_K:.1f} K)"
    )


DEFAULTS_CH4_TFR = 90.69


def test_fuel_pressure_shift():
    """Clausius-Clapeyron T_fr elevation: negligible for ethanol, decisive
    for the marginal methane/LOX case. Ambient fuel pressure = no change."""
    P500 = 500.0 * 6894.757
    # Ethanol: < 2% effect on ice at 500 psi
    base = run_tank_freeze(base_inputs())
    pressurized = run_tank_freeze(base_inputs(P_fuel_pa=P500))
    rel = abs(pressurized.ice_at_mission_m - base.ice_at_mission_m) / base.ice_at_mission_m
    assert rel < 0.02, f"ethanol fuel-pressure effect should be tiny, got {100*rel:.1f}%"
    assert any("freezing point" in f and "Clausius" in f for f in pressurized.flags)
    # Ambient explicit == default exactly
    ambient = run_tank_freeze(base_inputs(P_fuel_pa=101325.0))
    assert ambient.ice_at_mission_m == base.ice_at_mission_m
    # Methane vs LOX at 1 atm sink: 500 psi fuel multiplies the ~0.5 K margin
    kw = dict(fluid_inner="methane", fluid_outer="lox", r_i=0.10, r_o=0.103, H=1.0,
              T_eth0=105.0, m_liq0=13.5, t_mission_s=1200.0, t_solidify_max_s=7200.0,
              P_tank_pa=101325.0)
    ch4_base = run_tank_freeze(TankFreezeInputs(**kw))
    ch4_press = run_tank_freeze(TankFreezeInputs(P_fuel_pa=P500, **kw))
    assert ch4_press.ice_at_mission_m > 1.5 * ch4_base.ice_at_mission_m, (
        f"expected pressurized methane to freeze much more: "
        f"{ch4_press.ice_at_mission_m*1e3:.2f} vs {ch4_base.ice_at_mission_m*1e3:.2f} mm"
    )
    print(
        f"  Fuel-pressure shift OK: ethanol ice {base.ice_at_mission_m*1e3:.2f} -> "
        f"{pressurized.ice_at_mission_m*1e3:.2f} mm ({100*rel:.1f}%); methane/LOX ice "
        f"{ch4_base.ice_at_mission_m*1e3:.2f} -> {ch4_press.ice_at_mission_m*1e3:.2f} mm at 500 psia"
    )


def test_same_fluid_flat():
    """LOX/LOX: no dT, no heat flow — flat output with explanatory flag."""
    r = run_tank_freeze(TankFreezeInputs(
        fluid_inner="lox", fluid_outer="lox", r_i=0.10, r_o=0.103, H=1.0,
        P_tank_pa=101325.0, T_eth0=90.2, m_liq0=30.0, t_mission_s=1200.0,
    ))
    assert r.classification == "NO_HEAT_FLOW" and r.mode == "no_heat_flow"
    assert all(v == 0.0 for v in r.Qout_W + r.Qin_W + r.ice_thickness_m)
    assert all(v == 90.2 for v in r.T_eth_K)
    assert any("no heat flows" in f for f in r.flags)
    print(f"  Same-fluid OK: NO_HEAT_FLOW, flat at {r.T_eth_K[0]} K, {len(r.t_s)} samples")


if __name__ == "__main__":
    tests = [
        test_churchill_chu_reference,
        test_resistance_ordering,
        test_conduction_limit_stefan,
        test_energy_balance,
        test_step_and_seed_independence,
        test_bounds_ordering,
        test_headline_outputs,
        test_outward_conduction_limit,
        test_swapped_config_smoke,
        test_ethanol_methane,
        test_methane_lox_modes,
        test_fuel_pressure_shift,
        test_same_fluid_flat,
    ]
    failed = 0
    for t in tests:
        print(f"\n{t.__name__}:")
        try:
            t()
        except AssertionError as e:
            failed += 1
            print(f"  FAILED: {e}")
        except Exception as e:
            failed += 1
            print(f"  ERROR: {type(e).__name__}: {e}")
    print(f"\n{'ALL TESTS PASSED' if failed == 0 else f'{failed} TEST(S) FAILED'}")
    sys.exit(1 if failed else 0)
