"""The layout's checks that need a solve or a load: channel velocity head from the production
callers, orifice cavitation in place of the invented short-wall rule, and plate bending.

Design: the 6.5 kN doublet (24 doublets, 35/48 deg, contoured face,
flat-floored channels with one feed port each, 12.7 mm plate, 1/2 NPT igniter).

Expected values are hand arithmetic: Timoshenko & Woinowsky-Krieger §19 closed forms for the
plate (written out here, independent of the layout's own solve), Nurick (1976) for cavitation.
"""
from __future__ import annotations

import copy
import importlib.util
import math
from pathlib import Path

import pytest
import yaml

from engine.core.injectors.layout import (
    ATM, PLATE_YIELD_FACTOR, PSI, flows_from_result, layout_from_config, plate_bending_moments,
)

ROOT = Path(__file__).resolve().parents[1]
DESIGN = ROOT / "tests/fixtures/doublet_6500N_autochannel.yaml"


def _yaml():
    return yaml.safe_load(DESIGN.read_text())


def _codes(out):
    return {w["code"]: w for w in out["warnings"]}


@pytest.fixture(scope="module")
def flows():
    from engine.core.runner import PintleEngineRunner
    from engine.pipeline.io import load_config
    c = load_config(str(DESIGN))
    r = PintleEngineRunner(copy.deepcopy(c)).evaluate(
        c.lox_tank.initial_pressure_psi * PSI, c.fuel_tank.initial_pressure_psi * PSI, silent=True)
    return flows_from_result(r, c)


# =============================================================================================
# Manifold: the production callers pass the solve
# =============================================================================================

def test_design_audit_runs_the_manifold_check_and_flags_the_lox_channel(capsys):
    spec = importlib.util.spec_from_file_location("design_audit", ROOT / "scripts/design_audit.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    ok = mod.audit(str(DESIGN))
    printed = capsys.readouterr().out
    bad = [ln for ln in printed.splitlines() if "drawing bad" in ln]
    assert any("LOX channel velocity head" in ln for ln in bad), printed
    assert "manifold_q_O" in printed          # named in the failed "layout: nothing impossible"
    assert ok is False


def test_manifold_reports_q_over_dp_and_the_area_for_1_2_4_ports(flows):
    out = layout_from_config(_yaml(), drawings=False, flows=flows)
    for k in ("O", "F"):
        ch = out["passages"][k]["channel"]
        m, rho, dp = flows[f"mdot_{k}"], flows[f"rho_{k}"], flows[f"dp_{k}"]
        v = (m / 2.0) / (rho * ch["flow_area"])
        assert ch["q_over_dp"] == pytest.approx(0.5 * rho * v * v / dp, rel=1e-9)
        for n in (1, 2, 4):
            A = (m / (2.0 * n)) / math.sqrt(2.0 * rho * 0.05 * dp)
            assert ch["area_needed_by_ports"][str(n)] == pytest.approx(A, rel=1e-9)
        w = _codes(out)[f"manifold_q_{k}"]
        assert w["level"] == "bad"
        assert "% of design flow" not in w["text"]
        for n in (1, 2, 4):
            assert f"{ch['area_needed_by_ports'][str(n)] * 1e6:.0f} mm² ({n} port" in w["text"]
    assert out["passages"]["O"]["channel"]["q_over_dp"] > 0.05


# =============================================================================================
# Cavitation number replaces the short-wall L/d
# =============================================================================================

def test_cavitation_check_replaces_the_short_wall_rule(flows):
    out = layout_from_config(_yaml(), drawings=False, flows=flows)
    codes = _codes(out)
    assert not [c for c in codes if c.startswith("short_wall")]
    for k, th in (("O", 35.0), ("F", 48.0)):
        ch = out["passages"][k]["channel"]
        assert "short_wall_l_over_d" not in ch
        assert ch["entry_lip_deg"] == pytest.approx(90.0 - th)
        assert codes[f"oblique_inlet_{k}"]["level"] == "info"
        assert f"{90 - th:.0f}°" in codes[f"oblique_inlet_{k}"]["text"]
        P, Pc, Pv, Cd = flows[f"P_inj_{k}"], flows["Pc"], flows[f"Pv_{k}"], flows[f"Cd_{k}"]
        cav = out["passages"][k]["cavitation"]
        assert cav["K"] == pytest.approx((P - Pv) / (P - Pc), rel=1e-12)
        assert cav["K_crit"] == pytest.approx((Cd / 0.62) ** 2, rel=1e-12)   # sharp inlet, Cc 0.62
        assert codes[f"cavitation_{k}"]["level"] == ("bad" if cav["K"] < cav["K_crit"] else "info")


def test_a_cavitating_orifice_is_bad(flows):
    f = dict(flows)
    f["Pv_O"] = f["P_inj_O"] - 0.5 * (f["P_inj_O"] - f["Pc"])     # K = 0.5 < K_crit
    out = layout_from_config(_yaml(), drawings=False, flows=f)
    assert out["passages"]["O"]["cavitation"]["K"] == pytest.approx(0.5)
    assert _codes(out)["cavitation_O"]["level"] == "bad"


def test_coned_floor_has_a_square_lip_and_no_oblique_note():
    cfg = _yaml()
    cfg["injector"]["plate"]["channel_floor"] = "coned"
    out = layout_from_config(cfg, drawings=False)
    assert out["passages"]["O"]["channel"]["entry_lip_deg"] == 90.0
    assert "oblique_inlet_O" not in _codes(out)


# =============================================================================================
# Plate bending
# =============================================================================================

def _timoshenko(r, a, b, p, nu, support):
    """Solid plate, uniform p over r <= b (Timoshenko & Woinowsky-Krieger §19)."""
    k = p * b * b / 4.0                       # P / (4 pi), P = pi b^2 p
    if r <= b:
        Mr = k * ((1 + nu) * math.log(a / b) + 1 - (1 - nu) * b * b / (4 * a * a) - (3 + nu) * r * r / (4 * b * b))
        Mt = k * ((1 + nu) * math.log(a / b) + 1 - (1 - nu) * b * b / (4 * a * a) - (1 + 3 * nu) * r * r / (4 * b * b))
    else:
        Mr = k * ((1 + nu) * math.log(a / r) + (1 - nu) * b * b / (4 * r * r) * (1 - r * r / (a * a)))
        Mt = k * ((1 + nu) * math.log(a / r) + (1 - nu) - (1 - nu) * b * b / (4 * r * r) - (1 - nu) * b * b / (4 * a * a))
    if support == "clamped":
        Mr += k * (-1 + b * b / (2 * a * a))
        Mt += k * (-1 + b * b / (2 * a * a))
    return Mr, Mt


@pytest.mark.parametrize("support", ["simply_supported", "clamped"])
@pytest.mark.parametrize("r", [1e-4, 0.02, 0.0495, 0.0635, 0.07, 0.0762])
def test_plate_moments_are_timoshenko(support, r):
    a, b, p, nu = 0.0762, 0.0635, 2.4e6, 0.3
    got = plate_bending_moments(r, a=a, b=b, p=p, nu=nu, support=support)
    assert got == pytest.approx(_timoshenko(r, a, b, p, nu, support), rel=1e-7, abs=1e-6)


def test_plate_moments_reduce_to_roarks_uniform_plate():
    a, p, nu, t = 0.05, 1e6, 0.3, 0.01
    Mr0, _ = plate_bending_moments(1e-6, a=a, b=a, p=p, nu=nu, support="simply_supported")
    assert 6 * Mr0 / t ** 2 == pytest.approx(3 * (3 + nu) * p * a * a / (8 * t * t), rel=1e-6)
    Mra, _ = plate_bending_moments(a, a=a, b=a, p=p, nu=nu, support="clamped")
    assert 6 * abs(Mra) / t ** 2 == pytest.approx(3 * p * a * a / (4 * t * t), rel=1e-9)


def test_a_centre_hole_frees_the_radial_moment_at_its_edge():
    Mr, Mt = plate_bending_moments(0.0107, a=0.0762, b=0.0635, p=2e6, nu=0.3, r_hole=0.0107)
    assert abs(Mr) < 1e-6 and Mt > _timoshenko(0.0107, 0.0762, 0.0635, 2e6, 0.3, "simply_supported")[1]


@pytest.mark.parametrize("support", ["simply_supported", "clamped"])
def test_plate_check_channel_root_stress_is_the_hand_calc(support):
    cfg = _yaml()
    cfg["injector"]["igniter"] = None                    # the solid plate the closed form is for
    cfg["injector"]["plate"]["support"] = support
    out = layout_from_config(cfg, drawings=False)
    pb = out["plate_bending"]
    t, a, b, nu = 0.0127, 0.5 * 0.1651 - 0.00635, 0.5 * 0.127, 0.3
    p = 375.0 * PSI - ATM                                # target_chamber_pressure_psi, no solve
    assert (pb["r_plate"], pb["r_loaded"], pb["p_gauge"]) == pytest.approx((a, b, p), rel=1e-12)
    for k in ("O", "F"):
        ch = out["passages"][k]["channel"]
        worst = pb["channels"][k]
        hand = []
        for r in (ch["r_lo"], ch["r_center"], ch["r_hi"]):
            t_lig = t - ch["depth"]                        # flat floor, face datum above
            Mr, Mt = _timoshenko(r, a, b, p, nu, support)
            sr = 6 * Mr / t_lig ** 2
            st = nu * sr + 6 * (Mt - nu * Mr) * t_lig / t ** 3
            hand.append(max(abs(sr), abs(st), abs(sr - st)))
        assert worst["t_net"] == pytest.approx(t - ch["depth"], rel=1e-9)
        assert worst["sigma"] == pytest.approx(max(hand), rel=1e-3)
    assert _codes(out)["plate_bending"]["level"] == "info"
    assert "material undeclared" in _codes(out)["plate_bending"]["text"]


def test_plate_check_against_a_declared_yield():
    cfg = _yaml()
    base = layout_from_config(cfg, drawings=False)["plate_bending"]["max"]["sigma"]
    cfg["injector"]["plate"]["yield_strength"] = 0.9 * PLATE_YIELD_FACTOR * base
    assert _codes(layout_from_config(cfg, drawings=False))["plate_bending"]["level"] == "bad"
    cfg["injector"]["plate"]["yield_strength"] = 1.1 * PLATE_YIELD_FACTOR * base
    assert _codes(layout_from_config(cfg, drawings=False))["plate_bending"]["level"] == "info"
