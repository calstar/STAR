"""Rupe's mixing criterion for an unlike doublet, reported by the impinging solve.

Rupe (JPL PR 20-195 / 20-209), restated by Elverum & Morey, JPL Memo 30-5 (1959) eq. 1: the
most uniform mixture-ratio distribution of a one-on-one unlike doublet occurs at

    M = rho_O v_O^2 d_O / (rho_F v_F^2 d_F) = 1,

and eq. 4 gives the same number in flow terms, (rho_F/rho_O)(mdot_O/mdot_F)^2 (d_F/d_O)^3 per
element pair. The solver's ``momentum_ratio_R`` is sqrt(rho_O v_O^2 / rho_F v_F^2); with
mdot = Cd A sqrt(2 rho dp), rho v^2 = 2 Cd^2 dp, so R is (Cd_O/Cd_F) sqrt(dp_O/dp_F) exactly --
no density, no hole size, and not Rupe's criterion.

Expected values here come from eq. 4 on the solved flows, not from the module's own formula.
"""
from __future__ import annotations

import math
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PSI = 6894.757
P_TANK = 584.2669657943025 * PSI


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


def _cfg(**geom):
    from engine.pipeline.io import load_config
    from engine.pipeline.config_schemas import PintleEngineConfig
    d = load_config(str(ROOT / "configs/ethalox_6500N.yaml")).model_dump()
    for side, kv in geom.items():
        d["injector"]["geometry"][side].update(kv)
    if d["injector"].get("plate"):
        # Rupe/R identities at the holes' own drop: the plenum closure (with ring channels part
        # of the drop is spent in the manifold; see test_injector_ring_manifold).
        d["injector"]["plate"]["manifold_model"] = "plenum"
    return PintleEngineConfig.model_validate(d)


def _em_eq4(cfg, diag, mdot_O, mdot_F):
    g = cfg.injector.geometry
    rho_O, rho_F = cfg.fluids["oxidizer"].density, cfg.fluids["fuel"].density
    nO, nF = g.oxidizer.n_elements, g.fuel.n_elements
    return (rho_F / rho_O) * ((mdot_O / nO) / (mdot_F / nF)) ** 2 * (g.fuel.d_jet / g.oxidizer.d_jet) ** 3


@pytest.fixture(scope="module")
def solved():
    from engine.core.injectors.impinging import ImpingingInjector
    cfg = _cfg()
    mO, mF, diag = ImpingingInjector(cfg).solve(P_TANK, P_TANK, 431.75 * PSI)
    return cfg, mO, mF, diag


def test_rupe_M_is_reported_and_is_elverum_morey_eq4(solved):
    cfg, mO, mF, diag = solved
    assert "rupe_M" in diag
    assert diag["rupe_M"] == pytest.approx(_em_eq4(cfg, diag, mO, mF), rel=1e-9)


def test_R_is_the_cd_dp_ratio_it_always_was(solved):
    _, _, _, diag = solved
    R = (diag["Cd_O"] / diag["Cd_F"]) * math.sqrt(diag["delta_p_injector_O"] / diag["delta_p_injector_F"])
    assert diag["momentum_ratio_R"] == pytest.approx(R, rel=1e-5)
    # M = R^2 d_O / d_F: the hole-size term R leaves out
    assert diag["rupe_M"] == pytest.approx(diag["momentum_ratio_R"] ** 2 * diag["d_jet_O"] / diag["d_jet_F"], rel=1e-9)


def test_6500N_design_point_is_lox_dominant():
    """The shipped holes at the solved design point: M 1.21 (hand, from v_O 32.61 / v_F 37.22 m/s,
    d_O 1.548 / d_F 1.421 mm), where R 1.05 reads as balanced."""
    from engine.core.runner import PintleEngineRunner
    cfg = _cfg()
    r = PintleEngineRunner(cfg).evaluate(P_tank_O=P_TANK, P_tank_F=P_TANK)
    diag = r["diagnostics"]
    assert diag["rupe_M"] == pytest.approx(_em_eq4(cfg, diag, r["mdot_O"], r["mdot_F"]), rel=1e-6)
    assert 1.1 < diag["rupe_M"] < 1.3


def test_M_carries_the_hole_size_R_does_not():
    """Same injector dp on both sides, larger LOX hole: M grows with d_O, R does not see it."""
    from engine.core.injectors.impinging import rupe_mixing_ratio, momentum_ratio_R_from_bulk_velocities
    rho_O, rho_F, dp = 1140.0, 789.0, 900e3
    v = lambda rho: 0.8 * math.sqrt(2.0 * dp / rho)  # noqa: E731  same Cd and dp both sides
    for dO in (1.4e-3, 1.55e-3, 1.7e-3):
        M = rupe_mixing_ratio(rho_O, v(rho_O), dO, rho_F, v(rho_F), 1.42e-3)
        assert M == pytest.approx(dO / 1.42e-3, rel=1e-12)
        assert momentum_ratio_R_from_bulk_velocities(rho_O, rho_F, v(rho_O), v(rho_F)) == pytest.approx(1.0)
