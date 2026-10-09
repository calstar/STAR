"""The wall conduction model against closed-form solutions (Carslaw & Jaeger; Landau 1950).

Every expected number here is a textbook formula evaluated in the test, not a number the
model produced.
"""
import math
import os
import sys

import numpy as np
from scipy.special import erfc

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.pipeline.thermal.wall_conduction import Layer, WallModel  # noqa: E402

K, RHO, CP = 0.35, 1600.0, 1500.0      # phenolic-like
ALPHA = K / (RHO * CP)


def test_constant_flux_surface_temperature():
    """Semi-infinite solid, constant flux: Ts - T0 = 2 q sqrt(t/pi) / sqrt(k rho c)."""
    q, t_end, dt = 2.0e6, 0.2, 0.001
    w = WallModel([Layer(0.0127, K, RHO, CP)], 300.0)
    for _ in range(int(round(t_end / dt))):
        w.step(dt, q_in=lambda s: q)
    expect = 300.0 + 2.0 * q * math.sqrt(t_end / math.pi) / math.sqrt(K * RHO * CP)
    assert abs(w.T[0] - expect) / (expect - 300.0) < 0.01


def test_constant_surface_temperature_profile():
    """Surface stepped to Ts: T(y,t) = T0 + (Ts-T0) erfc(y / 2 sqrt(alpha t))."""
    Ts, T0, t_end, dt = 1500.0, 300.0, 1.0, 0.002
    w = WallModel([Layer(0.0127, K, RHO, CP)], T0)
    # a very stiff film holds the face at Ts
    for _ in range(int(round(t_end / dt))):
        w.step(dt, q_in=lambda s: 1e9 * (Ts - s))
    y = np.array([0.1e-3, 0.3e-3, 0.6e-3])
    got = np.interp(y, w.y, w.T)
    expect = T0 + (Ts - T0) * erfc(y / (2.0 * math.sqrt(ALPHA * t_end)))
    assert np.all(np.abs(got - expect) < 0.02 * (Ts - T0))


def test_steady_ablation_is_landaus():
    """Quasi-steady ablation at T_abl: v = q / (rho (H + cp (T_abl - T0))); the T_p isotherm sits
    (alpha/v) ln((T_abl - T0)/(T_p - T0)) below the receding face."""
    q, H, T_abl, T0, Tp = 2.0e6, 2.5e6, 1986.0, 300.0, 950.0
    w = WallModel([Layer(0.05, K, RHO, CP)], T0)
    for _ in range(1500):
        out = w.step(0.005, q_in=lambda s: q, T_ablation=T_abl, H_surface=H, rho_surface=RHO)
    v = q / (RHO * (H + CP * (T_abl - T0)))
    assert abs(out["recession"] / 0.005 - v) / v < 0.03
    depth = ALPHA / v * math.log((T_abl - T0) / (Tp - T0))
    assert abs(w.depth_of_isotherm(Tp) - depth) / depth < 0.05
    assert w.T[0] == T_abl


def test_soak_conserves_energy():
    """Adiabatic faces after shutdown: the profile relaxes to the mean, energy conserved."""
    lay = [Layer(0.006, 100.0, 2260.0, 710.0)]
    w = WallModel(lay, 300.0, n_first=40, first_cell=2e-5)
    for _ in range(100):
        w.step(0.01, q_in=lambda s: 5e6)
    C = w._C
    E_before = float(np.sum(C * w.T))
    peaks = w.soak(60.0, dt=0.1)
    E_after = float(np.sum(w._C * w.T))
    assert abs(E_after - E_before) / E_before < 1e-6
    T_mean = E_before / float(np.sum(C))
    assert abs(w.T_back - T_mean) < 1.0
    assert peaks["T_back_peak"] >= w.T_back - 1e-9
