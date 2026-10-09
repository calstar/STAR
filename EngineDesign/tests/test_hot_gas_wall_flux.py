"""The chamber wall's gas-side load: Bartz convection, H2O/CO2 gas radiation, the real bore.

Findings TH-3, TH-4, TH-5, TH-10 and TH-11 of the 2026-09-25 overnight review. The old model
took its bore, k, Pr, recovery factor, emissivity and turbulence from the DISABLED regen block,
radiated the gas as a blackbody at the wall's emissivity 0.85, tripled the convection with an
unsourced turbulence factor, pinned the surface at a 1200 K "limit" and then subtracted the
wall's own emission a second time toward a 600 K sink.

Expected numbers are computed here by hand: Bartz (Huzel & Huang eq. 4-13), the exact
isentropic area-Mach relation, and CEA frozen transport for LOX/ethanol at O/F 1.50, 430 psia
(rocketcea get_Chamber_Transport, frozen: cp 0.534 BTU/lbm R = 2236 J/(kg K), mu 1.041 mP,
Pr 0.664; these move < 1 % over O/F 1.45-1.55 and 400-450 psia).
"""
import copy
import math
import os
import sys

import pytest
from scipy.optimize import brentq

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.core.runner import PintleEngineRunner  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "configs", "ethalox_6500N.yaml")
PSI = 6894.757293168361
P_TANK = 584.27 * PSI
SIGMA = 5.670374419e-8
CEA_MU, CEA_CP, CEA_PR = 1.041e-4, 2236.0, 0.664


@pytest.fixture(autouse=True)
def _python_physics(monkeypatch):
    # The numba kernel mirrors the Python physics after the fact; this checks the Python.
    monkeypatch.setenv("ED_ACCEL", "off")


def _evaluate(mutate=None, silent=True):
    cfg = load_config(CFG)
    if mutate is not None:
        mutate(cfg)
    return PintleEngineRunner(copy.deepcopy(cfg)).evaluate(P_TANK, P_TANK, silent=silent)


def _abl(res):
    return res["diagnostics"]["cooling"]["ablative"]


def _mach_sub(ar, g):
    f = lambda M: (1 / M) * ((2 / (g + 1)) * (1 + (g - 1) / 2 * M * M)) ** ((g + 1) / (2 * (g - 1))) - ar
    return brentq(f, 1e-9, 1 - 1e-12)


def _hand_bartz(res, Tw, area_ratio):
    """H&H eq. 4-13 with the stagnation state of the solve; r_c the mean of the drawn contour's
    1.5 Rt / 0.382 Rt throat radii."""
    d = res["diagnostics"]
    cfg = load_config(CFG)
    At = cfg.chamber_geometry.A_throat
    Dt = math.sqrt(4 * At / math.pi)
    rc = 0.5 * (1.5 + 0.382) * Dt / 2
    g, T0 = d["gamma"], d["Tc_ideal"]
    M = _mach_sub(area_ratio, g)
    k = 1 + (g - 1) / 2 * M * M
    sigma = 1 / ((0.5 * Tw / T0 * k + 0.5) ** 0.68 * k ** 0.12)
    h = (0.026 / Dt ** 0.2 * (CEA_MU ** 0.2 * CEA_CP / CEA_PR ** 0.6) * (d["mdot_total"] / At) ** 0.8
         * (Dt / rc) ** 0.1 * (1 / area_ratio) ** 0.9 * sigma)
    r = CEA_PR ** (1 / 3)
    Taw = T0 * (1 + r * (k - 1)) / k
    return h, Taw


def test_barrel_convection_is_bartz_on_the_real_bore():
    res = _evaluate()
    a = _abl(res)
    cfg = load_config(CFG)
    CR = (math.pi / 4 * cfg.chamber_geometry.chamber_diameter ** 2) / cfg.chamber_geometry.A_throat
    h, Taw = _hand_bartz(res, a["surface_temperature"], CR)
    assert a["h_gas"] == pytest.approx(h, rel=0.05)
    # recovery at the barrel's Mach 0.07 is essentially total: Taw >= 0.999 T0 (old: 0.94 T0)
    assert a["adiabatic_wall_temperature"] >= 0.999 * res["diagnostics"]["Tc_ideal"]
    assert a["heat_flux_from_gas_convective"] == pytest.approx(h * (Taw - a["surface_temperature"]), rel=0.05)


def test_disabled_regen_block_does_not_reach_the_liner():
    base = _abl(_evaluate())["heat_removed"]

    def bore(value):
        def m(cfg):
            cfg.regen_cooling.chamber_inner_diameter = value
            cfg.regen_cooling.radiation_emissivity_hot = 0.3
            cfg.regen_cooling.hot_gas_thermal_conductivity = 0.9
            cfg.regen_cooling.gas_turbulence_intensity = 0.4
        return m

    for mutate in (bore(0.05), bore(0.127), bore(None)):
        assert _abl(_evaluate(mutate))["heat_removed"] == pytest.approx(base, rel=1e-9)

    def no_regen(cfg):
        cfg.regen_cooling = None
    assert _abl(_evaluate(no_regen))["heat_removed"] == pytest.approx(base, rel=1e-9)


def test_no_turbulence_multiplier():
    base = _abl(_evaluate())

    def m(cfg):
        cfg.ablative_cooling.turbulence_sensitivity = 0.0
    assert _abl(_evaluate(m))["heat_removed"] == pytest.approx(base["heat_removed"], rel=1e-9)
    assert "turbulence_multiplier" not in base or base["turbulence_multiplier"] == 1.0


def test_gas_radiation_uses_a_gas_emissivity():
    """H2O 45 % / CO2 14 % at ~29 bar over an 8-12 cm beam: Leckner eps_g 0.15-0.30, i.e.
    0.8-2 MW/m^2 onto a 1200 K wall -- not 0.85 sigma Tc^4 = 5.1 MW/m^2."""
    from engine.pipeline.thermal.gas_side import HotGasState, profile, wall_contour
    gas = HotGasState(T0=3225.0, P0=2.965e6, gamma=1.1375, mass_flux_throat=1835.0, mu=CEA_MU,
                      cp=CEA_CP, Pr=CEA_PR, x_H2O=0.453, x_CO2=0.141)
    At = 1.5337e-3
    c = wall_contour(At, 0.127, At)
    p = profile(gas, c, 1200.0, 0.85)
    q_barrel = p["q_rad"][int(len(p["x"]) * 0.2)]
    assert 0.8e6 < q_barrel < 2.0e6
    # and in the solve, on the liner at its own surface temperature
    a = _abl(_evaluate())
    assert 0.12 < a["gas_emissivity"] < 0.35
    assert 0.4e6 < a["heat_flux_from_gas_radiative"] < 1.5e6


def test_radiation_grows_with_bore():
    from engine.pipeline.thermal.gas_side import HotGasState, profile, wall_contour
    gas = HotGasState(T0=3225.0, P0=2.965e6, gamma=1.1375, mass_flux_throat=1835.0, mu=CEA_MU,
                      cp=CEA_CP, Pr=CEA_PR, x_H2O=0.453, x_CO2=0.141)
    At = 1.5337e-3
    q = []
    for D in (0.10, 0.20):
        c = wall_contour(At, D, 1.2 * D * math.pi / 4 * D * D)  # same L/D
        p = profile(gas, c, 1200.0, 0.85)
        i = int(len(p["x"]) * 0.2)  # a barrel station
        q.append(p["q_rad"][i])
    assert q[1] > q[0]


def test_leckner_anchors_hottel():
    """Zero-pressure H2O emissivity at 1000 K and 1 bar cm is 0.034 (Hottel/Leckner)."""
    from engine.pipeline.thermal.gas_side import _LECKNER_H2O, _leckner_eps0
    assert 0.03 < float(_leckner_eps0(_LECKNER_H2O, 1.0, 1.0)) < 0.04


def test_surface_runs_at_the_ablation_temperature_without_a_sink():
    """The hot face sits at the material's ablation temperature (a config property), and the
    net flux is exactly blown convection plus gas radiation: no second wall-emission term."""
    a = _abl(_evaluate())
    cfg = load_config(CFG)
    assert a["surface_temperature"] == cfg.ablative_cooling.ablation_surface_temperature
    f = a["blowing_reduction"]
    q = f * a["heat_flux_from_gas_convective"] + a["heat_flux_from_gas_radiative"]
    assert a["effective_heat_flux"] == pytest.approx(q, rel=1e-12)
    E = cfg.ablative_cooling.heat_of_ablation + cfg.ablative_cooling.specific_heat * (
        a["surface_temperature"] - cfg.ablative_cooling.ambient_temperature)
    assert a["recession_rate"] == pytest.approx(q / E / cfg.ablative_cooling.material_density, rel=1e-9)

    def hotter(cfg):
        cfg.ablative_cooling.ablation_surface_temperature = 2300.0
    assert _abl(_evaluate(hotter))["recession_rate"] < a["recession_rate"]

    def sink(cfg):
        cfg.ablative_cooling.radiative_sink_fallback_temperature = 1500.0
    assert _abl(_evaluate(sink))["recession_rate"] == pytest.approx(a["recession_rate"], rel=1e-12)


def test_displayed_profile_is_bartz_along_the_contour():
    res = _evaluate(silent=False)
    a = _abl(res)
    x, qc = a["segment_x"], a["segment_q_conv"]
    it = a["throat_index"]
    cfg = load_config(CFG)
    Tw = a["profile_wall_temperature"]
    h_t, Taw_t = _hand_bartz(res, Tw, 1.0 + 1e-9)
    assert qc[it] == pytest.approx(h_t * (Taw_t - Tw), rel=0.05)
    # flat along the barrel: no Gaussian bump, no cone drawn from the face
    barrel = [q for xi, q in zip(x, qc) if xi < -0.06]
    assert max(barrel) / min(barrel) < 1.02
    # falls monotonically down the nozzle (the old Newton missed a factor 2 and zig-zagged)
    nozzle = [q for xi, q in zip(x, qc) if xi > 1e-6]
    assert all(b < a_ for a_, b in zip(nozzle, nozzle[1:]))
    # the supersonic station at A/A* = 2 against Bartz with the exact Mach number
    from engine.pipeline.thermal.gas_side import mach_from_area_ratio
    assert mach_from_area_ratio(1.511, 1.1375, True) == pytest.approx(1.754, abs=1e-3)


def test_regen_march_radiates_the_gas_not_a_blackbody():
    """With regen on, radiation_emissivity_hot is the WALL's emissivity: the gas term is Leckner's,
    1-2 MW/m^2 here, not 0.85 sigma Tc^4 (~5-6 MW/m^2)."""
    def regen(eps_wall):
        def m(cfg):
            cfg.regen_cooling.enabled = True
            cfg.regen_cooling.chamber_inner_diameter = cfg.chamber_geometry.chamber_diameter
            cfg.regen_cooling.radiation_emissivity_hot = eps_wall
        return m

    q85 = _evaluate(regen(0.85))["diagnostics"]["cooling"]["regen"]["heat_flux_radiative"]
    assert 0.5e6 < q85 < 2.0e6
