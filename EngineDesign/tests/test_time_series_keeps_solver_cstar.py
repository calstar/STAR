"""The coupled time-series path reports the chamber solve's c* and eta_c*, not an assumed 0.85.

runner.evaluate_arrays_with_time used to overwrite the time-varying solver's results with
cstar_ideal = cstar_actual / 0.85, which set eta_c* to exactly 0.85 at every step (the Time-Series
tab and Layer 2/3 read it).
"""
import numpy as np
import pytest

PSI = 6894.757


def test_eta_cstar_is_the_solvers_not_a_constant():
    from engine.pipeline.io import load_config
    from engine.core.runner import PintleEngineRunner

    cfg = load_config("configs/ethalox_6500N.yaml")
    runner = PintleEngineRunner(cfg)
    P_O = cfg.lox_tank.initial_pressure_psi * PSI
    P_F = cfg.fuel_tank.initial_pressure_psi * PSI
    times = np.array([0.0, 0.5])
    ts = runner.evaluate_arrays_with_time(times, np.full(2, P_O), np.full(2, P_F), use_coupled_solver=True)
    point = runner.evaluate(P_O, P_F, silent=True)
    eta = np.asarray(ts["eta_cstar"], dtype=float)
    assert not np.allclose(eta, 0.85)
    assert eta[0] == pytest.approx(point["eta_cstar"], rel=2e-3)
    assert np.asarray(ts["cstar_ideal"])[0] == pytest.approx(point["cstar_ideal"], rel=2e-3)
