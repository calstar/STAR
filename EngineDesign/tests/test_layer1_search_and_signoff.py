"""Layer 1 search mechanics and sign-off: the design that is scored is the design that is shipped.

L1-01  validation never raises tank pressure or swaps the candidate to make a design "solve".
L1-04  the derived throat is solved to tolerance, independent of where CMA proposed it.
L1-05  sign-off re-checks every declared geometric limit at face value.
L1-07  the block stage searches no derived DOF and uses per-coordinate scaling.
L1-08  valley escape fires only on the infeasible plateau, not on a shaping-term floor.
DEF-09 the chamber OD floor follows the smallest reachable throat, not the envelope cap.
"""
from __future__ import annotations

import copy
import math
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

import engine.optimizer.layers.layer1_static_optimization as L1
from engine.pipeline.io import load_config

ROOT = Path(__file__).resolve().parents[1]
PSI = 6894.757


def test_derived_throat_is_independent_of_the_proposed_start():
    """L1-04: two secant steps from the proposal left +0.4..0.9 % thrust depending on the start."""
    from engine import accel
    from engine.core.runner import PintleEngineRunner
    cfg = load_config(str(ROOT / "configs" / "ethalox_6500N.yaml"))
    runner = PintleEngineRunner(copy.deepcopy(cfg))
    cg = cfg.chamber_geometry
    wall = L1._layer1_total_wall_thickness_m(cfg)
    P = 583.1 * PSI

    def ev():
        r = accel.evaluate(runner.config, runner.cea_cache, P, P, 94070.0)
        if r is None:
            try:
                r = runner.evaluate(P, P, P_ambient=94070.0, silent=True)
            except Exception:
                r = None
        return r

    c = dict(layer1_derive_expansion_ratio=True, layer1_derive_throat_from_thrust=True,
             layer1_derive_max_iters=getattr(L1, "_LAYER1_DERIVE_MAX_ITERS_DEFAULT", 2),
             layer1_derive_thrust_tol_rel=1e-3, derive_eps_min=4.0, derive_eps_max=14.0,
             derive_At_min=5e-4, derive_At_max=6e-3, P_ambient=94070.0, target_thrust=6500.0,
             TOTAL_WALL_THICKNESS_M=wall, max_nozzle_exit=0.2032)
    errs = []
    for f0 in (0.8, 1.0, 1.3, 1.66):
        x = np.array([cg.A_throat * f0, cg.Lstar, cg.expansion_ratio, cg.chamber_diameter + wall])
        L1._layer1_apply_chamber_geometry_to_config(
            runner.config, A_throat=x[0], Lstar=x[1], expansion_ratio=x[2],
            D_chamber_outer=x[3], max_nozzle_exit=0.2032, wall_thickness_m=wall)
        res = L1._layer1_solve_derived_geometry(x, runner.config, c, ev, ev())
        errs.append(abs(res["F"] / 6500.0 - 1.0))
    assert max(errs) <= 1.0e-3, errs


def test_signoff_enforces_the_declared_element_pitch():
    """L1-05: 24 doublets in a 127 mm bore is a 22.97 mm pitch against the 6500 N config's
    22.5 mm limit; the 4.4e-4 squared miss hid under gate_eps and every seed said VALID."""
    cfg = load_config(str(ROOT / "configs" / "ethalox_6500N.yaml"))
    req = cfg.design_requirements.model_dump()
    gates = L1._layer1_declared_limit_gates(cfg, req, {})
    ok, msg = gates["element_pitch"]
    pitch = math.sqrt(math.pi / 4.0 * 0.127 ** 2 / 24)
    assert pitch == pytest.approx(0.02297, abs=1e-5)
    assert not ok and "22.97 mm > limit 22.50 mm" in msg
    assert gates["engine_length"][0]         # 244 mm against 400 mm
    assert gates["free_jet"][0]              # 5-6 d against SP-8089's 7 d


def test_validation_does_not_boost_tanks_to_make_a_design_close():
    """L1-01: the replay retried at 1.03-1.72x tank pressure, took the first that solved,
    and stamped the design VALID with the un-raised pressures written to the YAML."""
    real_cfg = load_config(str(ROOT / "configs" / "impinging_smoke.yaml"))
    state = {"val": False, "nom": None}
    base = {"F": 7000.0, "Pc": 2.5e6, "MR": 2.3, "Cf": 1.55, "Cf_actual": 1.55,
            "mdot_O": 1.0, "mdot_F": 0.45, "stability_results": {}}

    def evaluate(po, pf, **kw):
        if state["val"]:
            if state["nom"] is None:
                state["nom"] = po
            if po < 1.02 * state["nom"]:
                raise ValueError("Supply < Demand at all Pc")
        return dict(base)

    engine_mock = MagicMock()
    engine_mock.evaluate.side_effect = evaluate
    x13 = [0.002, 1.0, 8.0, 0.14, 12.0, 0.002, 45.0, 0.012, 0.0022, 45.0, 0.011, 550.0, 650.0]

    def _dc(obj, memo=None):
        return real_cfg if obj is real_cfg else copy.deepcopy(obj)

    def _rebuild(*a, **k):
        state["val"] = True
        return None

    with patch("engine.optimizer.layers.layer1_static_optimization.copy.deepcopy", side_effect=_dc), \
            patch("engine.optimizer.layers.layer1_static_optimization.PintleEngineRunner",
                  return_value=engine_mock), \
            patch("engine.optimizer.layers.layer1_static_optimization._layer1_rebuild_final_config",
                  side_effect=_rebuild), \
            patch("engine.optimizer.layers.layer1_static_optimization.cma.CMAEvolutionStrategy") as mcma, \
            patch("engine.optimizer.layers.layer1_static_optimization.minimize") as mmin, \
            patch("engine.optimizer.layers.layer1_static_optimization.ProcessPoolExecutor"):
        mcma.return_value.stop.return_value = True
        mcma.return_value.result.xbest = x13
        mcma.return_value.result.fbest = 0.1
        lb = MagicMock(); lb.x = np.array(x13); lb.fun = 0.05; lb.success = True
        mmin.return_value = lb
        req = real_cfg.design_requirements.model_dump()
        _, results = L1.run_layer1_optimization(
            config_obj=real_cfg, runner=MagicMock(), requirements=req, target_burn_time=10.0,
            tolerances={"thrust": 0.1}, pressure_config={"mode": "optimizer_controlled"},
            layer1_max_iterations=1, layer1_cma_restarts=1)
    perf = results["performance"]
    assert perf["layer1_validation_tank_pressure_scale"] == pytest.approx(1.03)
    assert perf["pressure_candidate_valid"] is False
    assert any("own tank pressures" in r for r in perf["failure_reasons"])


def test_blocks_search_no_derived_dof_and_scale_per_coordinate():
    """L1-07: blocks ran isotropic CMA (sigma = 0.2 x median span) over coordinates whose
    ranges differ by 1e5 and searched the solved throat, eps and fuel pitch freely."""
    from engine.pipeline.config_schemas import HybridOptimizerConfig
    calls = []

    def fake_core(objective_fn, x0, sigma0, bounds, budget, popsize, **kw):
        calls.append(dict(kw, x0=np.asarray(x0), sigma0=sigma0, n=len(bounds)))
        return np.asarray(x0, dtype=float), float(objective_fn(np.asarray(x0, dtype=float))), 1

    lo = np.array([1e-4, 0.8, 4.0, 0.1, 6, 5e-4, 20, 3e-3, 5e-4, 20, 3e-3, 300, 300], float)
    hi = np.array([4e-3, 1.5, 14.0, 0.2, 30, 4e-3, 80, 3e-2, 4e-3, 80, 3e-2, 600, 600], float)
    x0 = 0.5 * (lo + hi)
    fixed = {0: x0[0], 2: x0[2], 10: x0[10]}
    hc = HybridOptimizerConfig(num_blocks=3, cycles=2, per_block_budget_fraction=0.5,
                               refresh_every_pass=False, block_method="random")
    with patch.object(L1, "run_cma_core", side_effect=fake_core):
        L1.run_hybrid_optimization(lambda x: float(np.sum(((x - lo) / (hi - lo)) ** 2)),
                                   list(zip(lo, hi)), x0, hc, total_budget=20000,
                                   fixed_variables=fixed, integer_dims=[4, 6, 9], seed=3)
    blocks = [c for c in calls if c.get("true_objective_fn") is not None]
    assert blocks
    for c in blocks:
        assert c.get("cma_stds") is not None
        assert len(c["cma_stds"]) == c["n"]
    # derived dims never appear in a block: one cycle's blocks cover the 10 searched dims only
    assert sum(c["n"] for c in blocks[:3]) == 13 - len(fixed)


def test_valley_escape_ignores_a_constant_shaping_floor():
    """L1-08: 'best > 100/150/300' read the ~1970-point mass floor as stuck on every 6500 N
    run (7 sigma kicks) and never fired on blank runs."""
    tracker = {"function_evaluations": 2000, "last_best_eval": 1600, "best_objective": 2000.0,
               "valley_escape_tier": 0, "cooldown_until": 0}
    L1.run_cma_core(lambda x: 2000.0 + float(np.sum(x ** 2)), np.ones(3), 0.3,
                    [(-2.0, 2.0)] * 3, 64, 8, seed=1, valley_escape_tracker=tracker)
    assert tracker["valley_escape_tier"] == 0
    stuck = dict(tracker, best_objective=1.5e6)
    L1.run_cma_core(lambda x: 1.5e6 + float(np.sum(x ** 2)), np.ones(3), 0.3,
                    [(-2.0, 2.0)] * 3, 64, 8, seed=1, valley_escape_tracker=stuck)
    assert stuck["valley_escape_tier"] == 1


def _captured_bounds(cfg, monkeypatch):
    """Run Layer-1 setup up to the worker pool and return (bounds, constants)."""
    from engine.core.runner import PintleEngineRunner
    cap = {}

    class _Stop(Exception):
        pass

    def spy(config_dict, bounds_array, requirements_dict, constants_dict, debug_strict):
        cap.update(b=np.asarray(bounds_array), c=constants_dict)
        raise _Stop()

    monkeypatch.setenv("ED_L1_WORKERS", "1")
    monkeypatch.setattr(L1, "_init_worker", spy)
    req = cfg.design_requirements.model_dump()
    with pytest.raises(_Stop):
        L1.run_layer1_optimization(
            copy.deepcopy(cfg), PintleEngineRunner(copy.deepcopy(cfg)), req,
            float(req.get("target_burn_time") or 4.0), {"thrust": 0.1},
            {"mode": "optimizer_controlled",
             "max_lox_pressure_psi": req["max_lox_tank_pressure_psi"],
             "max_fuel_pressure_psi": req["max_fuel_tank_pressure_psi"]})
    return cap["b"], cap["c"]


def test_od_floor_admits_the_shape_band_at_low_thrust(monkeypatch):
    """DEF-09: the OD floor was 0.5 x cap -- a 72.9 mm bore under a 1 kN engine whose
    D/Dt band (2.2-3.2) wants a 41-60 mm bore."""
    from engine.pipeline.config_schemas import PintleEngineConfig
    cfg = load_config(str(ROOT / "configs" / "ethalox_6500N.yaml"))
    dr = cfg.design_requirements
    dr.target_thrust = 1000.0
    dr.max_chamber_outer_diameter = 0.2032
    dr.target_chamber_pressure_psi = None
    dr.frozen_parameters = None
    b, c = _captured_bounds(cfg, monkeypatch)
    wall = float(c["TOTAL_WALL_THICKNESS_M"])
    At_1kN = 1000.0 / (1.40 * 378.0 * PSI)          # hand: F / (Cf Pc) at the blank point
    assert b[3][0] - wall <= 2.2 * math.sqrt(4.0 * At_1kN / math.pi)


def test_a_one_dimensional_block_does_not_crash_cma():
    """Dropping the derived DOFs can leave a block with one coordinate; CMA_stds on a 1-D
    problem raised IndexError inside cma (seen on configs/ethalox_6500N.yaml, seeds 3 and 4)."""
    from engine.pipeline.config_schemas import HybridOptimizerConfig
    lo, hi = np.zeros(4), np.array([1.0, 1.0, 100.0, 1e-3])
    x0 = 0.5 * (lo + hi)
    hc = HybridOptimizerConfig(num_blocks=2, cycles=1, per_block_budget_fraction=0.5,
                               refresh_every_pass=False, block_method="random")
    x, f, n = L1.run_hybrid_optimization(
        lambda v: float(np.sum(((v - 0.3 * hi) / hi) ** 2)), list(zip(lo, hi)), x0, hc,
        total_budget=600, fixed_variables={0: x0[0], 1: x0[1]}, seed=5)
    assert np.isfinite(f)


def test_element_count_scan_crosses_basins_along_constant_injector_area():
    """Seeds ended at n = 5, 5, 7, 13 with objectives 20 % apart: at fixed jet diameters each
    count is a different injector, so an integer CMA step never crossed between them. Scored
    along constant flow area and pitch circle, every count is reachable in one batch."""
    A0 = 5 * 4.0e-3 ** 2                       # n d^2 of the start: 5 holes of 4 mm

    def fake_eval(x):
        x = np.asarray(x, dtype=float)
        n, d, s = x[4], x[5], x[7]
        area = n * d * d / A0 - 1.0
        ring = n * s / (5 * 0.0071) - 1.0
        return {"value": float((n - 12.0) ** 2 + 1e4 * area ** 2 + 1e4 * ring ** 2),
                "success": True, "x_solved": x.tolist()}

    lo = np.array([1e-4, 0.8, 4, 0.1, 5, 5e-4, 20, 2e-3, 5e-4, 20, 2e-3, 300, 300], float)
    hi = np.array([4e-3, 1.5, 14, 0.2, 20.499, 6e-3, 80, 3e-2, 6e-3, 80, 5e-2, 600, 600], float)
    x = np.array([1.7e-3, 0.76, 5.0, 0.13, 5.0, 4.0e-3, 39, 0.0071, 3.6e-3, 52, 0.047, 600, 574])
    with patch.object(L1, "_eval_candidate", side_effect=fake_eval):
        xb, fb, n_ev = L1._layer1_iso_area_count_scan(
            x, fake_eval(x)["value"], list(zip(lo, hi)), L1._LocalSerialExecutor(), [4, 6, 9],
            (4, (5, 8), (7, 10)))
    assert int(round(xb[4])) == 12 and fb < 1e-6
    assert xb[5] == pytest.approx(4.0e-3 * math.sqrt(5 / 12), rel=1e-12)
    assert n_ev <= 2 * 15
    # a count whose rescaled holes leave the search box is not proposed
    lo[7] = 3e-3
    with patch.object(L1, "_eval_candidate", side_effect=fake_eval):
        xb2, _, _ = L1._layer1_iso_area_count_scan(
            x, fake_eval(x)["value"], list(zip(lo, hi)), L1._LocalSerialExecutor(), [4, 6, 9],
            (4, (5, 8), (7, 10)))
    assert int(round(xb2[4])) == 11
