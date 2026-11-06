"""A design whose fluid block disagrees with its propellant preset says so.

An explicit ``fluids`` block wins over the preset on load, so a design saved before the ethalox
preset was corrected against CoolProp keeps LOX cp 2300 (CoolProp Oxygen 90 K: 1699 J/(kg K)),
bulk modulus 1.5e9 (rho a^2: 0.94e9 Pa) and viscosity 1.8e-4 (1.96e-4 Pa s) with no word. The LE4
(3) stand's engine carries that block: forward thrust barely moves, but its chug gate goes 1.445 ->
1.420, the LOX water hammer 3182 -> 2561 psi and the line quarter-wave 2697 -> 2170 Hz.
"""

from __future__ import annotations

from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
STALE_LOX = {"specific_heat": 2300.0, "bulk_modulus_pa": 1.5e9, "viscosity": 1.8e-4}


def _cfg(path):
    from engine.pipeline.io import load_config

    return load_config(str(path))


def test_the_stale_lox_block_is_named_with_the_presets_values():
    from engine.pipeline.config_switch import design_staleness

    cfg = _cfg(REPO / "configs" / "ethalox_doublet_7000N.yaml")
    for k, v in STALE_LOX.items():
        setattr(cfg.fluids["oxidizer"], k, v)
    w = design_staleness(cfg) or ""
    assert "ethalox preset" in w, w
    assert "specific_heat 2300 (preset 1700)" in w
    assert "bulk_modulus_pa 1.5e+09 (preset 9.4e+08)" in w
    assert "viscosity 0.00018 (preset 0.0002)" in w


def test_a_design_on_the_presets_fluids_is_quiet():
    from engine.pipeline.config_switch import design_staleness

    assert design_staleness(_cfg(REPO / "configs" / "default.yaml")) is None


def test_a_rounding_is_not_drift():
    """default.yaml's LOX boiling point is 90.19 against the methalox preset's 90.2."""
    from engine.pipeline.config_switch import preset_fluid_drift

    cfg = _cfg(REPO / "configs" / "default.yaml")
    cfg.fluids["oxidizer"].temperature = 92.0  # a couple of kelvin warmer: still quiet
    assert preset_fluid_drift(cfg) is None


def test_a_config_without_a_preset_is_not_compared():
    from engine.pipeline.config_switch import preset_fluid_drift

    cfg = _cfg(REPO / "configs" / "ethalox_doublet_7000N.yaml")
    cfg.fluids["oxidizer"].specific_heat = 2300.0
    cfg.propellant_preset = None
    assert preset_fluid_drift(cfg) is None


@pytest.mark.parametrize("name", ["ethalox_doublet_7000N.yaml", "ethalox_8000N_designpoint.yaml"])
def test_the_shipped_ethalox_designs_carry_the_corrected_lox(name):
    from engine.pipeline.config_switch import preset_fluid_drift

    cfg = _cfg(REPO / "configs" / name)
    lox = cfg.fluids["oxidizer"]
    assert (lox.specific_heat, lox.bulk_modulus_pa, lox.viscosity) == pytest.approx((1700.0, 0.94e9, 2.0e-4))
    assert preset_fluid_drift(cfg) is None
