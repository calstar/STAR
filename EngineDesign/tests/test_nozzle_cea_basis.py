"""Nozzle exit state, ambient Cf and the finite-area combustor, on CEA's own basis.

CN-4: the exit pressure came from an isentrope at the chamber's equilibrium gamma and landed
      above both CEA bounds (94.0 kPa where CEA gives 87.2 equilibrium / 78.7 frozen).
CN-6: the injector-end pressure was used as the nozzle's stagnation pressure at every
      contraction ratio (no Rayleigh loss), so a skinny chamber cost nothing.
CN-8: CEACache.eval ignored the Pa it was given (Cf_ideal was always the 14.7 psia value) and
      clamped out-of-table inputs without a word.

Reference values are NASA CEA (rocketcea 1.2.3), LOX/ethanol, quoted here:
  * O/F 1.5013, Pc 433.65 psia, eps 5.5985, shifting equilibrium: Pc/Pe = 34.2806
    (Pe = 87.22 kPa); the eps whose Pe is 94069.7 Pa is 5.2995.
  * finite-area combustor ("fac", CR = 2 / 3 / 5): CEA's printed Pinj/Pinf 1.051824 / 1.022720
    / 1.008126 at gamma_s 1.1375.
  * Pc 433.97 psia, O/F 1.49930, eps 5.59852: get_PambCf at Pamb 13.6437 psia -> 1.50134.
"""
import copy
import math
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.core.runner import PintleEngineRunner  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "configs", "ethalox_6500N.yaml")
PSI = 6894.757293168361
P_TANK = 584.27 * PSI


@pytest.fixture(autouse=True)
def _python_physics(monkeypatch):
    monkeypatch.setenv("ED_ACCEL", "off")


@pytest.fixture(scope="module")
def runner():
    return PintleEngineRunner(load_config(CFG))


def test_exit_pressure_is_ceas_shifting_equilibrium(runner):
    ex = runner.cea_cache.aux.exit_state(1.5013, 433.65 * PSI, 5.5985)
    assert ex["P_exit"] == pytest.approx(433.65 * PSI / 34.2806, rel=0.005)


def test_ambient_matched_expansion_ratio(runner):
    from engine.core.nozzle import expansion_ratio_for_exit_pressure
    eps = expansion_ratio_for_exit_pressure(runner.cea_cache, 1.5013, 433.65 * PSI, 94069.7)
    assert eps == pytest.approx(5.2995, rel=0.01)


def test_runner_exit_state_is_on_the_thrust_basis(runner):
    """The reported Pe is the CEA expansion of the nozzle stagnation pressure the thrust uses."""
    from engine.core.nozzle import calculate_thrust, contraction_ratio_of, nozzle_stagnation_loss
    res = runner.evaluate(P_TANK, P_TANK, silent=True)
    cg = runner.config.chamber_geometry
    kappa = nozzle_stagnation_loss(contraction_ratio_of(cg), res["gamma"])
    ex = runner.cea_cache.aux.exit_state(res["MR"], res["Pc"] / kappa, cg.expansion_ratio)
    assert res["P_exit"] == pytest.approx(ex["P_exit"], rel=1e-9)
    # the separation margin Pe/Pa is reported alongside
    t = calculate_thrust(res["Pc"], res["MR"], res["mdot_total"], runner.cea_cache, runner.config,
                         res["P_ambient"])
    assert t["exit_to_ambient_ratio"] == pytest.approx(res["P_exit"] / res["P_ambient"], rel=1e-9)


@pytest.mark.parametrize("CR, ceas", [(2.0, 1.051824), (3.0, 1.022720), (5.0, 1.008126)])
def test_rayleigh_loss_matches_ceas_finite_area_combustor(CR, ceas):
    from engine.core.nozzle import nozzle_stagnation_loss
    assert nozzle_stagnation_loss(CR, 1.1375) == pytest.approx(ceas, rel=5e-4)


def test_demand_uses_the_nozzle_stagnation_pressure():
    """At CR = 2 the throat sees Pc/1.0518: mdot c*_actual / At = Pc / kappa (was = Pc)."""
    cfg = load_config(CFG)
    At = cfg.chamber_geometry.A_throat
    cfg.chamber_geometry.chamber_diameter = math.sqrt(4 * 2.0 * At / math.pi)
    res = PintleEngineRunner(copy.deepcopy(cfg)).evaluate(P_TANK, P_TANK, silent=True)
    ratio = res["mdot_total"] * res["cstar_actual"] / At / res["Pc"]
    from engine.core.nozzle import nozzle_stagnation_loss
    assert 1.0 / ratio == pytest.approx(nozzle_stagnation_loss(2.0, res["gamma"]), rel=2e-3)
    assert 1.0 / ratio > 1.04


def test_cache_ambient_coefficient_uses_the_ambient_it_is_given(runner):
    c = runner.cea_cache
    Pc, MR, eps = 433.97 * PSI, 1.49930, 5.59852
    at_site = c.eval(MR, Pc, 13.6437 * PSI, eps)
    assert at_site["Cf_ideal"] == pytest.approx(1.50134, rel=5e-4)
    vac = c.eval(MR, Pc, 0.0, eps)
    assert vac["Cf_ideal"] == pytest.approx(vac["Cf_vac"], rel=1e-12)


def test_cache_flags_what_it_clamps(runner):
    c = runner.cea_cache
    assert c.eval(1.5, 3.0e6, 101325.0, 5.6)["extrapolated"] is False
    low = c.eval(0.8, 3.0e6, 101325.0, 5.6)
    assert low["extrapolated"] is True and "MR" in low["clamped"]


def test_geometry_fallback_sizes_the_throat_on_the_delivered_basis(runner):
    """F = zeta Cf_vac P0 At - Pa Ae is what the runner delivers, so the sizing must depend on Pa
    (it did not: vacuum and sea level gave the same throat)."""
    from engine.core.chamber_geometry_solver import solve_chamber_geometry_with_cea
    cg = runner.config.chamber_geometry
    kw = dict(pc_design=cg.design_pressure, thrust_design=cg.design_thrust, cea_cache=runner.cea_cache,
              MR=cg.design_MR, diameter_inner=cg.chamber_diameter, diameter_exit=cg.exit_diameter,
              l_star=cg.Lstar, nozzle_efficiency=cg.nozzle_efficiency)
    At_site = solve_chamber_geometry_with_cea(Pa=94069.7, **kw)[3]["final_A_throat"]
    At_vac = solve_chamber_geometry_with_cea(Pa=0.0, **kw)[3]["final_A_throat"]
    assert (At_site - At_vac) / At_vac > 0.10
