"""Graphite throat chemistry: H2O, CO2 and OH are the oxidisers, and they absorb heat (TH-7).

The old model attacked carbon with O2 only, at an invented 3.75 % mole fraction (CEA has
0.34 %), and heated the surface with the C + O2 -> CO2 enthalpy (+32.8 MJ/kg). Expected
values below are independent:
  * CEA equilibrium throat composition, LOX/ethanol O/F 1.50, 433.65 psia (rocketcea
    get_SpeciesMoleFractions, throat column);
  * reaction enthalpies from JANAF heats of formation at 298 K;
  * the diffusion limit g ln(1 + B') of film theory (Spalding), B' = MW_C sum(nu_i X_i)/MW.
"""
import math
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.pipeline.config_schemas import GraphiteInsertConfig, SurfaceReactionConfig  # noqa: E402
from engine.pipeline.thermal.graphite_cooling import carbon_oxidation  # noqa: E402

THROAT = {"H2O": 0.4659, "CO": 0.2412, "CO2": 0.1491, "H2": 0.1006, "OH": 0.0241,
          "H": 0.0139, "O2": 0.00341, "O": 0.00187, "MW": 22.475}
P_THROAT = 433.65 * 6894.757 / 1.735          # Pc / (Pc/Pt), CEA
G0 = 4.8                                      # h/cp at the throat, Bartz, kg/(m^2 s)
RHO = 2260.0

# JANAF 298 K heats of formation [kJ/mol]
HF = {"H2O": -241.826, "CO": -110.527, "CO2": -393.522, "OH": 37.3, "H": 217.999, "O": 249.18}
MWC = 12.0107


def _cfg(**kw):
    return GraphiteInsertConfig(enabled=True, **kw)


def test_water_and_carbon_dioxide_attack_without_oxygen():
    no_o2 = dict(THROAT, O2=0.0, O=0.0)
    ox = carbon_oxidation(2500.0, P_THROAT, no_o2, THROAT["MW"], G0, _cfg())
    rate = ox["mass_flux"] / RHO
    assert rate > 0.15e-3                    # ~0.3 mm/s; the O2-only model gave 0.00026 mm/s
    assert ox["species"]["H2O"] > ox["species"]["CO2"] > 0


def test_the_reactions_are_a_heat_sink():
    ox = carbon_oxidation(2400.0, P_THROAT, THROAT, THROAT["MW"], G0, _cfg())
    assert ox["q_chem"] > 0                  # absorbed at the surface (old: +1.5 MW/m^2 heating)
    only_h2o = {"H2O": 0.4659, "MW": THROAT["MW"]}
    ox = carbon_oxidation(2400.0, P_THROAT, only_h2o, THROAT["MW"], G0, _cfg())
    dH = (HF["CO"] - HF["H2O"]) * 1e3 / (MWC * 1e-3)       # C + H2O -> CO + H2
    assert ox["q_chem"] / ox["mass_flux"] == pytest.approx(dH, rel=0.005)
    only_co2 = {"CO2": 0.1491, "MW": THROAT["MW"]}
    ox = carbon_oxidation(2400.0, P_THROAT, only_co2, THROAT["MW"], G0, _cfg())
    dH = (2 * HF["CO"] - HF["CO2"]) * 1e3 / (MWC * 1e-3)   # C + CO2 -> 2 CO
    assert ox["q_chem"] / ox["mass_flux"] == pytest.approx(dH, rel=0.005)


def test_fast_kinetics_reach_the_film_theory_limit():
    fast = SurfaceReactionConfig(A=1e12, E=0.0, n=0.5)
    cfg = _cfg(oxidation_H2O=fast, oxidation_CO2=fast, oxidation_OH=fast)
    ox = carbon_oxidation(3000.0, P_THROAT, THROAT, THROAT["MW"], G0, cfg)
    Bp = MWC * (THROAT["H2O"] + THROAT["CO2"] + THROAT["OH"] + 2 * THROAT["O2"] + THROAT["O"]) / THROAT["MW"]
    assert Bp == pytest.approx(0.346, abs=0.002)
    assert ox["mass_flux"] == pytest.approx(G0 * math.log1p(Bp), rel=0.03)


def test_rate_follows_the_surface_temperature():
    """The surface temperature is an input from the insert's conduction, and the kinetics
    make the rate climb steeply with it (the old loop returned 1.02e-4 m/s for any T_s)."""
    r = [carbon_oxidation(T, P_THROAT, THROAT, THROAT["MW"], G0, _cfg())["mass_flux"] for T in (1800, 2200, 2600)]
    assert r[0] < r[1] < r[2]
    assert r[2] / r[0] > 3
