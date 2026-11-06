"""The Time-Series COPV panel checks the charge the config loads, and labels a sized number as one.

It always SIZED: the P0 that just meets the curve in the configured volume, so the margin is zero
by construction -- and the panel showed that as "P0 2644 psia, Min Margin 0.1 psi" in green on the
LE4 (3) stand, whose press_tank.initial_gas_mass of 1.312 kg in 4.619 L is a ~3,800 psia charge.
"""

from __future__ import annotations

import numpy as np
import pytest

from backend.routers import timeseries as ts

CFG = "tests/fixtures/ethalox_6500N_doublet_cad_2026-09-28.yaml"
R_N2, T0 = 296.8, 300.0


@pytest.fixture
def cfg():
    from engine.pipeline.io import load_config

    return load_config(CFG)


def _run(cfg):
    t = np.linspace(0.0, 4.0, 41)
    return ts._run_copv_analysis(cfg, t, [1.87] * 41, [1.24] * 41, 578.0 * np.ones(41), 578.0 * np.ones(41))


def test_a_configured_charge_is_checked_not_sized(cfg):
    assert cfg.press_tank.initial_gas_mass == pytest.approx(1.312)
    out = _run(cfg)
    assert out["copv_mode"] == "configured"
    assert out["copv_initial_mass_kg"] == pytest.approx(1.312)
    # P0 is the charge's own state at T0: m0 = P0 V / (Z R T0), Z from the solver's own table.
    V = cfg.press_tank.free_volume_L / 1000.0
    P0 = out["copv_initial_pressure_psi"] * 6894.757
    Z = P0 * V / (1.312 * R_N2 * T0)
    assert 0.95 < Z < 1.3, Z
    assert out["copv_pressure_psi"][0] == pytest.approx(out["copv_initial_pressure_psi"], rel=1e-6)
    # the requirement still reported beside it, and below it: this charge has margin to spare
    assert out["copv_required_mass_kg"] < 1.312
    assert out["copv_required_pressure_psi"] < out["copv_initial_pressure_psi"]
    assert out["copv_min_margin_psi"] > 500.0, "the check returned the sized (zero) margin"


def test_without_a_charge_the_panel_sizes_and_says_so(cfg):
    cfg.press_tank.initial_gas_mass = None
    cfg.press_tank.mass = None
    out = _run(cfg)
    assert out["copv_mode"] == "sized"
    assert out["copv_initial_pressure_psi"] == pytest.approx(out["copv_required_pressure_psi"])
    assert abs(out["copv_min_margin_psi"]) < 5.0, "sized for zero margin"


def test_the_check_and_the_sizing_agree_on_the_sized_charge(cfg):
    """Checking the charge the sizing asks for gives back the sizing's P0 and a ~zero margin."""
    cfg.press_tank.initial_gas_mass = None
    cfg.press_tank.mass = None
    sized = _run(cfg)
    cfg.press_tank.initial_gas_mass = sized["copv_required_mass_kg"]
    checked = _run(cfg)
    assert checked["copv_mode"] == "configured"
    assert checked["copv_initial_pressure_psi"] == pytest.approx(sized["copv_required_pressure_psi"], rel=1e-4)
    assert abs(checked["copv_min_margin_psi"]) < 5.0
