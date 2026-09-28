"""The time-varying solve's wall, geometry and bookkeeping (TH-6, TH-8, TH-9, CN-7, TH-12, TH-2).

What each test guards, and what the code did before:
  * the nozzle exit stayed put only on paper: it grew at the chamber liner's rate even with
    ``nozzle_ablative: false`` (eps rose 10 % over the burn);
  * t = 0 rebuilt the chamber as a full-bore cylinder of cg.length (L* 1.08 for a 1.00 design);
  * thrust used the post-step throat while Pc was solved on the pre-step one;
  * the graphite surface was the caller's 2000 K guess and the insert conducted steadily into a
    300 K sink, so a 3 mm and a 12 mm insert burned identically;
  * the state carried a 2 GW/m^2 "nozzle heat flux", an 86,000 K nozzle wall and 3e7 K case.
"""
import copy
import math
import os
import sys

import numpy as np
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


def _series(times, mutate=None):
    cfg = load_config(CFG)
    if mutate is not None:
        mutate(cfg)
    t = np.asarray(times, dtype=float)
    P = np.full_like(t, P_TANK)
    return cfg, PintleEngineRunner(copy.deepcopy(cfg)).evaluate_arrays_with_time(t, P, P, use_coupled_solver=True)


@pytest.fixture(scope="module")
def burn():
    os.environ["ED_ACCEL"] = "off"
    return _series(np.linspace(0.0, 2.0, 9))


def test_exit_does_not_recede_on_a_non_ablative_nozzle(burn):
    cfg, tv = burn
    assert cfg.ablative_cooling.nozzle_ablative is False
    A_exit = np.asarray(tv["A_exit"])
    assert np.all(A_exit == A_exit[0])
    assert np.all(np.asarray(tv["recession_exit"]) == 0.0)
    # only the graphite throat opens, so the expansion ratio falls
    assert tv["eps"][-1] < tv["eps"][0]


def test_exit_recedes_when_the_nozzle_is_ablative():
    def m(cfg):
        cfg.ablative_cooling.nozzle_ablative = True
    _, tv = _series([0.0, 0.5, 1.0], m)
    assert tv["A_exit"][-1] > tv["A_exit"][0]


def test_t0_geometry_is_the_design(burn):
    cfg, tv = burn
    cg = cfg.chamber_geometry
    assert tv["V_chamber"][0] == pytest.approx(cg.volume, rel=1e-12)
    assert tv["Lstar"][0] == pytest.approx(cg.volume / cg.A_throat, rel=1e-12)


def test_thrust_is_computed_on_the_geometry_pc_was_solved_on(burn):
    cfg, tv = burn
    i = len(tv["F"]) - 1
    c2 = copy.deepcopy(cfg)
    cg = c2.chamber_geometry
    cg.A_throat = float(tv["A_throat"][i])
    cg.A_exit = float(tv["A_exit"][i])
    cg.expansion_ratio = cg.A_exit / cg.A_throat
    cg.volume = float(tv["V_chamber"][i])
    cg.Lstar = cg.volume / cg.A_throat
    cg.chamber_diameter = float(tv["D_chamber"][i])
    steady = PintleEngineRunner(c2).evaluate(P_TANK, P_TANK, silent=True)
    assert float(tv["Pc"][i]) == pytest.approx(float(steady["Pc"]), rel=1e-6)
    assert float(tv["F"][i]) == pytest.approx(float(steady["F"]), rel=1e-6)


def test_solver_reports_the_solved_efficiency():
    from engine.core.runner import PintleEngineRunner as R
    from engine.pipeline.time_varying_solver import TimeVaryingCoupledSolver
    cfg = load_config(CFG)
    r = R(copy.deepcopy(cfg))
    s = TimeVaryingCoupledSolver(r.config, r.cea_cache)
    t = np.array([0.0, 0.25])
    s.solve_time_series(t, np.full(2, P_TANK), np.full(2, P_TANK))
    out = s.get_results_dict()
    for i, d in enumerate(out["diagnostics"]):
        assert out["eta_cstar"][i] == pytest.approx(d["eta_cstar"], rel=1e-12)
        assert out["cstar_ideal"][i] == pytest.approx(d["cstar_ideal"], rel=1e-12)
    assert 0.85 < out["eta_cstar"][0] < 1.0 and out["eta_cstar"][0] != 0.85
    # c*_ideal is CEA's: 1700-1760 m/s for LOX/ethanol at O/F 1.4-1.6, 400-450 psia
    assert 1690.0 < out["cstar_ideal"][0] < 1760.0


def test_a_thinner_insert_runs_hotter_and_recedes_faster():
    def thick(t):
        def m(cfg):
            cfg.graphite_insert.initial_thickness = t
        return m
    _, thin = _series([0.0, 1.0, 2.0], thick(0.003))
    _, fat = _series([0.0, 1.0, 2.0], thick(0.012))
    assert thin["T_graphite_surface"][-1] > fat["T_graphite_surface"][-1] + 50.0
    assert thin["T_graphite_back"][-1] > fat["T_graphite_back"][-1] + 300.0
    assert thin["recession_graphite"][-1] > fat["recession_graphite"][-1]


def test_liner_waits_for_its_ablation_temperature(burn):
    """The cold liner first has to heat to its ablation temperature -- semi-infinite onset
    t = (pi/4) k rho c (T_abl - T0)^2 / q^2, a few tenths of a second here -- so the first
    0.25 s recedes far less than steady ablation would; by 2 s it ablates at the Landau rate."""
    cfg, tv = burn
    abl = cfg.ablative_cooling
    q = float(tv["q_conv_chamber"][-1] + tv["q_rad_chamber"][-1])
    t_on = math.pi / 4 * abl.thermal_conductivity * abl.material_density * abl.specific_heat * (
        abl.ablation_surface_temperature - abl.ambient_temperature) ** 2 / q ** 2
    assert 0.05 < t_on < 1.0
    assert tv["recession_chamber"][1] < 0.3 * tv["ablative_recession_rate"][-1] * 0.25
    assert tv["T_liner_surface"][-1] == pytest.approx(abl.ablation_surface_temperature, abs=1e-6)
    # late in the burn the transient rate is the quasi-steady one of the same step
    qs = tv["diagnostics"][-1]["cooling"]["ablative"]["recession_rate_quasi_steady"]
    assert tv["ablative_recession_rate"][-1] == pytest.approx(qs, rel=0.1)
    assert 0 < tv["char_depth_chamber"][-1] < abl.initial_thickness


def test_state_is_physical(burn):
    _, tv = burn
    for k, v in tv.items():
        if k.startswith("T_") and k not in ("T_exit",):
            a = np.asarray(v, dtype=float)
            a = a[np.isfinite(a)]
            assert np.all((a >= 200.0) & (a <= 4000.0)), k
    assert not any(k.startswith("nozzle_") for k in tv)
    assert not any("stainless" in k for k in tv)
    assert np.all(np.asarray(tv["heat_flux_throat"]) < 1e8)


def test_soak_back_after_shutdown():
    from engine.core.runner import PintleEngineRunner as R
    from engine.pipeline.time_varying_solver import TimeVaryingCoupledSolver
    cfg = load_config(CFG)
    r = R(copy.deepcopy(cfg))
    s = TimeVaryingCoupledSolver(r.config, r.cea_cache)
    t = np.array([0.0, 1.0])
    s.solve_time_series(t, np.full(2, P_TANK), np.full(2, P_TANK))
    back_at_burnout = s.get_results_dict()["T_graphite_back"][-1]
    soak = s.soak_back(30.0)
    assert soak["throat"]["T_back_peak"] >= back_at_burnout


def test_legacy_geometry_helper_grows_from_the_declared_volume():
    """The non-coupled path's helper: a micron of recession must not jump the volume to a
    full-bore cylinder of cg.length (+8 % on this chamber)."""
    from engine.pipeline.thermal.ablative_geometry import update_chamber_geometry_from_ablation
    cg = load_config(CFG).chamber_geometry
    Dt = math.sqrt(4 * cg.A_throat / math.pi)
    V, At, Dc, Dt_new, _ = update_chamber_geometry_from_ablation(
        cg.volume, cg.A_throat, cg.chamber_diameter, Dt, cg.length, 1e-6, recession_thickness_throat=0.0)
    shell = math.pi * ((cg.chamber_diameter / 2 + 1e-6) ** 2 - (cg.chamber_diameter / 2) ** 2) * cg.length
    assert V == pytest.approx(cg.volume + shell, rel=1e-12)
