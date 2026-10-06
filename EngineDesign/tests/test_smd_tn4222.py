"""Impinging-jet drop size is NACA TN 4222 (Ingebo 1958), and it reproduces TN 4222's own data.

TN 4222 Table I: pairs of impinging n-heptane jets in an airstream (82 F, 29.3 in Hg). Columns:
jet velocity Vj [ft/s], airstream velocity Va [ft/s], orifice Dj [in], measured D30 [micron].
The fitted correlation is Dj/D30 = 2.64 (Dj Vj)^0.5 + 0.97 Dj dV. The function this replaced cited
the report but ran a different (crossflow, TN 4087) form and came out ~0.47x the measured size.
"""
import math

import numpy as np
import pytest

from engine.core.spray import (
    TN4222_D32_OVER_D30, TN4222_HEPTANE_MU, TN4222_HEPTANE_RHO, TN4222_HEPTANE_SIGMA,
    TN4222_RHO_AIR, smd_impinging_tn4222,
)

FT, IN = 0.3048, 0.0254
TABLE_I = [(65, 65, .089, 347), (65, 65, .060, 293), (65, 65, .029, 200), (100, 100, .029, 162),
           (100, 65, .029, 134), (65, 100, .029, 160), (65, 180, .029, 113), (65, 300, .029, 68),
           (65, 100, .060, 212), (65, 180, .060, 131), (65, 300, .060, 79), (65, 100, .089, 240),
           (65, 180, .089, 142), (65, 300, .089, 87), (30, 65, .029, 270), (30, 180, .029, 126)]


def _d30_um(vj, va, dj):
    d32 = smd_impinging_tn4222(dj * IN, vj * FT, TN4222_HEPTANE_RHO, TN4222_HEPTANE_MU,
                               TN4222_HEPTANE_SIGMA, TN4222_RHO_AIR, dv=abs(va - vj) * FT)
    return d32 / TN4222_D32_OVER_D30 * 1e6


def test_reproduces_the_measured_table():
    ratios = [_d30_um(vj, va, dj) / m for vj, va, dj, m in TABLE_I]
    assert np.median(ratios) == pytest.approx(1.0, abs=0.10)
    assert min(ratios) > 0.70 and max(ratios) < 1.35


@pytest.mark.parametrize("run,expected", [(1, 347), (8, 68)])
def test_named_runs(run, expected):
    vj, va, dj, m = TABLE_I[run - 1]
    assert _d30_um(vj, va, dj) == pytest.approx(expected, rel=0.25)


def test_heptane_in_the_test_air_needs_no_property_transfer():
    a = smd_impinging_tn4222(0.001, 20.0, TN4222_HEPTANE_RHO, TN4222_HEPTANE_MU,
                             TN4222_HEPTANE_SIGMA, TN4222_RHO_AIR)
    b = smd_impinging_tn4222(0.001, 20.0, TN4222_HEPTANE_RHO, TN4222_HEPTANE_MU,
                             TN4222_HEPTANE_SIGMA, TN4222_RHO_AIR, scale_properties=False)
    assert a == pytest.approx(b, rel=1e-12)


def test_property_transfer_follows_ingebo_tn4087_exponents():
    base = dict(d_jet=0.0015, v_jet=30.0, rho_liq=789.0, mu_liq=1.2e-3, sigma=0.0223, rho_gas=2.0)
    d0 = smd_impinging_tn4222(**base)
    assert smd_impinging_tn4222(**dict(base, mu_liq=2.4e-3)) == pytest.approx(d0 * 2 ** 0.25)
    assert smd_impinging_tn4222(**dict(base, rho_gas=4.0)) == pytest.approx(d0 * 2 ** -0.25)


def test_the_injector_uses_it_per_stream(monkeypatch):
    monkeypatch.setenv("ED_ACCEL", "off")
    from engine.pipeline.io import load_config
    from engine.core.injectors.impinging import ImpingingInjector
    cfg = load_config("configs/ethalox_6500N.yaml")
    _, _, d = ImpingingInjector(cfg).solve(3.6e6, 3.6e6, 2.6e6)
    rho_g = 2.6e6 / (cfg.spray.smd.chamber_gas_R * cfg.spray.smd.chamber_gas_T)
    fo = cfg.fluids["fuel"]
    want = cfg.spray.smd.smd_scale * smd_impinging_tn4222(
        cfg.injector.geometry.fuel.d_jet, d["u_F"], fo.density, fo.viscosity, fo.surface_tension, rho_g)
    assert d["D32_F"] == pytest.approx(want, rel=1e-9)
