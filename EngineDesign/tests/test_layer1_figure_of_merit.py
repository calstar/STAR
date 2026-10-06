"""Layer 1's figure of merit: delivered Isp against chamber mass (L1-02, DEF-07).

With no performance term the blank ethalox objective reached exactly 0 for any feasible engine,
so six seeds returned six engines (Pc 368-405 psia, L* 1.14-1.49 m, n 6-12). The term is the
propellant the delivered Isp costs for the required total impulse, I/(g0 Isp) (Sutton &
Biblarz ch. 2), relative to an ideal engine, and it is blind to the requirement-pinned O/F and
Pc so it cannot pull them off target. Also L1-12 (an O/F outside the CEA table no longer
aborts) and L1-13 (expansion ratio from the table's own exit pressure).

Independent references: rocketcea (NASA CEA, shifting equilibrium) and hand arithmetic.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pytest

import engine.optimizer.layers.layer1_static_optimization as L1

rocketcea = pytest.importorskip("rocketcea.cea_obj")

ROOT = Path(__file__).resolve().parents[1]
PSI = 6894.757
PA = 94070.0
G0 = 9.80665


@pytest.fixture(scope="module")
def cea():
    from engine.pipeline.io import load_config
    from engine.pipeline.cea_cache import CEACache
    return CEACache(load_config(str(ROOT / "configs" / "ethalox_6500N.yaml")).combustion.cea)


@pytest.fixture(scope="module")
def rc():
    return rocketcea.CEA_Obj(oxName="LOX", fuelName="Ethanol")


def _rc_isp(rc, pc_psi, of, eps):
    return rc.estimate_Ambient_Isp(Pc=pc_psi, MR=of, eps=eps, Pamb=PA / PSI)[0]


def _constants(**over):
    from test_layer1_objective_unified import _constants as base
    return base(**over)


def _setup():
    from test_layer1_objective_unified import _req, _result, _x
    return _req, _result, _x


def test_objective_prefers_the_engine_that_delivers_more_isp():
    """Two designs that differ only in delivered Isp must not tie (they did: 0 and 0)."""
    _req, _result, _x = _setup()
    c = _constants(layer1_W_ISP=1000.0, layer1_Isp_ref_s=264.0)
    assert (L1._compute_objective_value(_result(Isp=237.0), _x(), _req(), c)
            < L1._compute_objective_value(_result(Isp=230.0), _x(), _req(), c))
    lo = L1._compute_objective_value(_result(Isp=230.0), _x(), _req(), c, return_terms=True)
    hi = L1._compute_objective_value(_result(Isp=237.0), _x(), _req(), c, return_terms=True)
    # readable: the propellant beyond an ideal engine's, per mille (hand arithmetic)
    assert lo["terms"]["isp_penalty"] == pytest.approx(1000.0 * (264.0 / 230.0 - 1.0), rel=1e-12)
    assert hi["terms"]["isp_penalty"] == pytest.approx(1000.0 * (264.0 / 237.0 - 1.0), rel=1e-12)


def test_isp_merit_holds_the_required_of(cea, rc):
    """O/F is a requirement: a design that runs at 1.6 against 1.5 gets no thermodynamic
    credit for the 1.6 (ideal Isp 1.1 % higher there). Ratio from rocketcea."""
    pc_psi, eps = 431.1, 5.3
    ratio = _rc_isp(rc, pc_psi, 1.5, eps) / _rc_isp(rc, pc_psi, 1.6, eps)
    res = {"Isp": 237.0, "MR": 1.6, "Pc": pc_psi * PSI, "eps": eps}
    merit = L1._layer1_isp_merit_s(res, {"optimal_of": 1.5, "P_ambient": PA}, cea)
    assert merit / 237.0 == pytest.approx(ratio, rel=3e-4)
    assert ratio < 0.995        # the hold is not a no-op at this point
    on_target = dict(res, MR=1.5)
    assert L1._layer1_isp_merit_s(on_target, {"optimal_of": 1.5, "P_ambient": PA}, cea) == 237.0


def test_isp_merit_holds_a_pc_target_to_its_band(cea, rc):
    """With a Pc target the merit sees at most the +0.8 % aim band (inside the 1 % gate)."""
    eps = 5.3
    res = {"Isp": 237.0, "MR": 1.5, "Pc": 450.0 * PSI, "eps": eps}
    c = {"optimal_of": 1.5, "P_ambient": PA, "layer1_target_Pc_pa": 430.0 * PSI}
    ratio = _rc_isp(rc, 430.0 * 1.008, 1.5, eps) / _rc_isp(rc, 450.0, 1.5, eps)
    assert L1._layer1_isp_merit_s(res, c, cea) / 237.0 == pytest.approx(ratio, rel=5e-5)


def test_default_weights_price_chamber_mass_like_propellant(cea, rc):
    """DEF-07: a blank design (W_MASS null) had W_MASS = W_LSTAR = 0 and nothing to choose L*
    with. The defaults price a kilogram of chamber like a kilogram of propellant."""
    pc = 430.0 * PSI
    w = L1._layer1_merit_weights({}, cea, 1.5, pc, PA, (4.0, 14.0), 6500.0, 3.9, 0.0, 5.0)
    eps_rc = rc.get_eps_at_PcOvPe(Pc=430.0, MR=1.5, PcOvPe=pc / PA)
    isp_ref = _rc_isp(rc, 430.0, 1.5, eps_rc)
    assert w["Isp_ref_s"] == pytest.approx(isp_ref, rel=1e-3)
    m_prop = 6500.0 * 3.9 / (G0 * isp_ref)
    assert w["m_prop_ref_kg"] == pytest.approx(m_prop, rel=1e-3)
    assert w["W_ISP"] == 1000.0
    # marginal price per kg equal at the reference mass: W_ISP/m_prop = 2 W_MASS/m_ref
    assert 2.0 * w["W_MASS"] / 5.0 == pytest.approx(1000.0 / m_prop, rel=1e-3)
    # an explicit W_MASS is the user's and is kept
    w2 = L1._layer1_merit_weights({"layer1_W_MASS": 3000.0}, cea, 1.5, pc, PA, (4.0, 14.0),
                                  6500.0, 3.9, 3000.0, 5.0)
    assert w2["W_MASS"] == 3000.0


def test_blank_design_lstar_is_no_longer_a_flat_direction(cea):
    """DEF-07 test (b): L* 1.14 and 1.49 m scored identically (0.0) on the blank config."""
    _req, _result, _x = _setup()
    w = L1._layer1_merit_weights({}, cea, 1.5, 430.0 * PSI, PA, (4.0, 14.0), 6500.0, 3.9, 0.0, 5.0)
    c = _constants(layer1_W_ISP=w["W_ISP"], layer1_Isp_ref_s=w["Isp_ref_s"],
                   layer1_W_MASS=w["W_MASS"], layer1_chamber_wall_density_kg_m3=2000.0)
    a = L1._compute_objective_value(_result(), _x(lstar=1.14), _req(), c)
    b = L1._compute_objective_value(_result(), _x(lstar=1.49), _req(), c)
    assert a < 1e6 and b < 1e6 and b > a


def test_out_of_table_of_target_designs_to_peak_isp(cea, rc):
    """L1-12: the blank impinging template keeps O/F 2.8; ethalox's table stops at 2.5 and
    Layer 1 aborted every run. It now designs to the peak ideal Isp O/F (rocketcea) and says so."""
    from engine.pipeline.io import load_config
    cfg = load_config(str(ROOT / "configs" / "ethalox_6500N.yaml"))
    pc_psi = 461.5
    of, msg = L1._layer1_resolve_of_target(cfg, 2.8, cea, pc_psi * PSI, PA)
    grid = np.linspace(1.0, 2.5, 151)
    isp = [_rc_isp(rc, pc_psi, m, rc.get_eps_at_PcOvPe(Pc=pc_psi, MR=m, PcOvPe=pc_psi * PSI / PA))
           for m in grid]
    assert of == pytest.approx(float(grid[int(np.argmax(isp))]), abs=0.03)
    assert msg and "outside the CEA table" in msg
    assert L1._layer1_resolve_of_target(cfg, 1.5, cea, pc_psi * PSI, PA) == (1.5, None)
    of_edge, msg_edge = L1._layer1_resolve_of_target(cfg, 2.8, None)
    assert of_edge == 2.5 and msg_edge


def test_layer1_does_not_abort_on_an_out_of_table_of_target():
    """L1-12, end to end: run_layer1_optimization raised ValueError before any work."""
    import copy
    from unittest.mock import MagicMock, patch
    from engine.pipeline.io import load_config
    real_cfg = load_config(str(ROOT / "configs" / "impinging_smoke.yaml"))
    lo, hi = real_cfg.combustion.cea.MR_range
    mock_engine = MagicMock()
    mock_engine.evaluate.return_value = {"F": 7000.0, "Pc": 2.5e6, "MR": float(hi), "Cf": 1.55,
                                         "Cf_actual": 1.55, "mdot_O": 1.0, "mdot_F": 0.45,
                                         "stability_results": {}}
    x13 = [0.002, 1.0, 8.0, 0.14, 12.0, 0.002, 45.0, 0.012, 0.0022, 45.0, 0.011, 550.0, 650.0]

    def _dc(obj, memo=None):
        return real_cfg if obj is real_cfg else copy.deepcopy(obj)

    with patch("engine.optimizer.layers.layer1_static_optimization.copy.deepcopy", side_effect=_dc), \
            patch("engine.optimizer.layers.layer1_static_optimization.PintleEngineRunner",
                  return_value=mock_engine), \
            patch("engine.optimizer.layers.layer1_static_optimization.cma.CMAEvolutionStrategy") as mcma, \
            patch("engine.optimizer.layers.layer1_static_optimization.minimize") as mmin, \
            patch("engine.optimizer.layers.layer1_static_optimization.ProcessPoolExecutor"):
        mcma.return_value.stop.return_value = True
        mcma.return_value.result.xbest = x13
        mcma.return_value.result.fbest = 0.1
        lb = MagicMock(); lb.x = np.array(x13); lb.fun = 0.05; lb.success = True
        mmin.return_value = lb
        req = real_cfg.design_requirements.model_dump()
        req["optimal_of_ratio"] = float(hi) + 1.3
        _, results = L1.run_layer1_optimization(
            config_obj=real_cfg, runner=MagicMock(), requirements=req, target_burn_time=10.0,
            tolerances={"thrust": 0.1}, pressure_config={"mode": "optimizer_controlled"},
            layer1_max_iterations=1, layer1_cma_restarts=1)
    warns = results["performance"].get("layer1_warnings") or []
    assert any("outside the CEA table" in w for w in warns)


def test_derived_expansion_ratio_puts_the_table_exit_pressure_at_ambient(cea, rc):
    """L1-13: the chamber-gamma isentrope gave eps 5.60 at 433.9 psia, Pe/Pa 0.93 in CEA;
    rocketcea's matched eps there is 5.30."""
    pc_psi = 433.9
    res = {"Pc": pc_psi * PSI, "MR": 1.5, "gamma": 1.1375}
    eps = L1._layer1_matched_eps(res, PA, cea, 5.6)
    pe = pc_psi * PSI / rc.get_PcOvPe(Pc=pc_psi, MR=1.5, eps=eps)
    assert pe == pytest.approx(PA, rel=0.01)
    assert eps == pytest.approx(rc.get_eps_at_PcOvPe(Pc=pc_psi, MR=1.5, PcOvPe=pc_psi * PSI / PA),
                                rel=2e-3)
