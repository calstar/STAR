"""A blank doublet design flows its holes as the drilled passages the layout draws.

The layout drills every doublet hole as an L/d-4 passage (SP-8089 3.1.2.2: "an orifice L/d of
at least 4"), so a design started from configs/default.yaml (what a new session loads) or
configs/canonical/impinging.yaml (what an injector switch loads) must use that passage's Cd. A
sharp-entry drilled hole reattaches inside the bore: Lichtarowicz, Duggins & Markland (1965),
Cd_u = 0.827 - 0.0085 L/d for 2 <= L/d <= 10, i.e. 0.793 at L/d 4. Both blank configs used to
fall through to the thin-plate diameter model, 0.60 x (d / 2 mm)^0.2 = 0.566 at 1.5 mm: holes
sized on it come out ~1.4x too large in area and run at half the design injector dp.

That small-hole exponent also had the wrong sign. ISO 5167 and Sutton & Biblarz Table 8-2 both
have small sharp holes flowing slightly more, not less; the thin-plate path is now the flat
0.60 asymptote below d_ref.

Expected values are the published fit and an energy balance built on ``fluids``, not the module.
"""
from __future__ import annotations

import math
from pathlib import Path

import pytest

from engine.core.discharge import cd_inf_from_inlet_geometry, cd_inf_from_orifice_diameter
from engine.pipeline.config_schemas import DischargeConfig

ROOT = Path(__file__).resolve().parents[1]
BLANKS = ["configs/default.yaml", "configs/canonical/impinging.yaml"]


@pytest.fixture(autouse=True, scope="module")
def _python_physics():
    """The authoritative Python path; engine/accel mirrors it and test_numba_ab_parity holds the
    two together."""
    from engine import accel
    real = accel.enabled, accel.require
    accel.enabled = lambda: False
    accel.require = lambda: False
    try:
        yield
    finally:
        accel.enabled, accel.require = real


def _lichtarowicz(ld: float) -> float:
    return 0.827 - 0.0085 * ld


def _short_tube_band(ld: float, Re: float = 3.0e5):
    """Energy balance through a short tube, Cd = (1 + K_entrance + f L/d)^-1/2, with the sharp
    entrance K from Rennels (0.57) and Idelchik (0.5) and a smooth-wall Colebrook f."""
    from fluids.fittings import entrance_sharp
    from fluids.friction import friction_factor
    f = friction_factor(Re=Re, eD=0.0)
    cds = [1.0 / math.sqrt(1.0 + entrance_sharp(method=m) + f * ld) for m in ("Rennels", "Idelchik")]
    return min(cds), max(cds)


@pytest.mark.parametrize("path", BLANKS)
@pytest.mark.parametrize("side", ["oxidizer", "fuel"])
def test_blank_doublet_gets_the_drilled_hole_cd(path, side):
    from engine.pipeline.io import load_config
    from engine.pipeline.config_switch import switch_config
    cfg = switch_config(load_config(str(ROOT / path)).model_dump(mode="json"), propellant_preset="ethalox")
    dc = DischargeConfig(**cfg["discharge"][side])
    cd = cd_inf_from_orifice_diameter(1.5e-3, dc)
    lo, hi = _short_tube_band(4.0)
    assert lo <= cd <= hi, f"{path} {side}: Cd {cd:.4f} outside the short-tube energy balance {lo:.4f}-{hi:.4f}"
    assert cd == pytest.approx(_lichtarowicz(4.0), abs=2e-3), (
        f"{path} {side}: Cd {cd:.4f}; a sharp L/d-4 hole is {_lichtarowicz(4.0):.4f} (Lichtarowicz 1965)")


def test_blank_hole_ld_is_the_one_the_layout_draws():
    """One number drives the drawing and the Cd: the layout's passage L/d is the discharge L/d."""
    import yaml
    from engine.core.injectors.layout import ORIFICE_LD_MIN
    for path in BLANKS:
        dis = yaml.safe_load((ROOT / path).read_text())["discharge"]
        for side in ("oxidizer", "fuel"):
            assert dis[side]["inlet_geometry"] == "sharp"
            assert dis[side]["orifice_l_over_d"] == ORIFICE_LD_MIN


@pytest.mark.parametrize("ld", [2.0, 4.0, 5.0, 8.0, 10.0])
def test_default_length_model_is_the_published_fit(ld):
    """No plateau over L/d 2-5: the default is Lichtarowicz, not the piecewise curve."""
    dc = DischargeConfig(Cd_inf=0.6, a_Re=0.18, inlet_geometry="sharp", orifice_l_over_d=ld)
    assert cd_inf_from_inlet_geometry(dc) == pytest.approx(_lichtarowicz(ld), abs=1e-9)


def test_past_the_fit_is_recorded_not_silent():
    from engine.pipeline import assumptions
    dc = DischargeConfig(Cd_inf=0.6, a_Re=0.18, inlet_geometry="sharp", orifice_l_over_d=13.0)
    with assumptions.scope() as used:
        cd_inf_from_inlet_geometry(dc)
    assert any("orifice_l_over_d" in k for k in used), used


@pytest.mark.parametrize("d_mm", [0.8, 1.0, 1.5, 1.9])
def test_thin_plate_path_has_no_small_hole_penalty(d_mm):
    """Below d_ref the thin-plate path is the 0.60 sharp-orifice asymptote (ISO 5167 C ~ 0.60-0.62),
    not 0.60 x (d/2 mm)^0.2."""
    dc = DischargeConfig(Cd_inf=0.60, a_Re=0.18)
    assert 0.60 - 1e-12 <= cd_inf_from_orifice_diameter(d_mm * 1e-3, dc) <= 0.62


def test_impinging_solve_on_the_thin_plate_path_says_so():
    """An impinging config that still declares no inlet is told its Cd is a thin plate."""
    from engine.pipeline import assumptions
    from engine.pipeline.config_schemas import PintleEngineConfig
    from engine.core.injectors.impinging import ImpingingInjector
    from engine.pipeline.io import load_config
    base = load_config(str(ROOT / "configs/ethalox_6500N.yaml")).model_dump()
    base["discharge"] = {s: {**base["discharge"][s], "inlet_geometry": None, "orifice_l_over_d": None}
                         for s in ("oxidizer", "fuel")}
    cfg = PintleEngineConfig.model_validate(base)
    PSI = 6894.757
    with assumptions.scope() as used:
        ImpingingInjector(cfg).solve(584.27 * PSI, 584.27 * PSI, 430.0 * PSI)
    assert "discharge.oxidizer.inlet_geometry" in used and "discharge.fuel.inlet_geometry" in used, used
