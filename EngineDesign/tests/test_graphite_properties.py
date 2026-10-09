"""The graphite insert's specific heat follows temperature (graphite_insert.specific_heat_model).

The configs carried graphite's room-temperature specific heat, 710 J/(kg K), at every temperature;
it is ~2000 J/(kg K) at the throat's running temperature, so the surface heated ~2.5x too fast and
the surface chemistry ran early. Expected values here are independent of the code:
  * NIST-JANAF graphite Cp: 8.517 J/(mol K) at 298.15 K, 21.610 J/(mol K) at 1000 K;
  * a slab with an adiabatic back stores exactly the heat put into its face, int rho H(T) dy = q t.
"""
import copy
import os
import sys

import numpy as np
import pytest
from scipy.integrate import quad

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.core.runner import PintleEngineRunner  # noqa: E402
from engine.pipeline.io import load_config  # noqa: E402
from engine.pipeline.thermal.graphite_properties import cp_butland_maddison  # noqa: E402
from engine.pipeline.thermal.wall_conduction import Layer, WallModel  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "configs", "ethalox_6500N.yaml")
PSI = 6894.757293168361
MW_C = 12.0107e-3  # kg/mol
RHO, K = 1810.0, 92.67  # GR001CC datasheet


@pytest.fixture(autouse=True)
def _python_physics(monkeypatch):
    monkeypatch.setenv("ED_ACCEL", "off")


@pytest.mark.parametrize("T, cp_janaf", [(298.15, 8.517), (1000.0, 21.610)])
def test_specific_heat_matches_janaf(T, cp_janaf):
    assert float(cp_butland_maddison(T)) == pytest.approx(cp_janaf / MW_C, rel=0.03)


def _slab(cp_of=None):
    return WallModel([Layer(0.006, K, RHO, 710.0, "graphite", cp_of=cp_of)], 300.0, n_first=40, first_cell=2e-5)


def test_a_heated_slab_stores_the_heat_it_was_given():
    q, dt, n = 5.0e6, 0.01, 100           # the solver's wall substep
    wall = _slab(cp_butland_maddison)
    for _ in range(n):
        wall.step(dt, q_in=lambda s: q)

    def enthalpy(T):
        return quad(lambda x: float(cp_butland_maddison(x)), 300.0, T)[0]

    stored = np.trapezoid(RHO * np.array([enthalpy(T) for T in wall.T]), wall.y)
    assert stored == pytest.approx(q * dt * n, rel=0.01)
    # the constant room-temperature cp runs the face ~260 K hotter for the same heat
    flat = _slab()
    for _ in range(n):
        flat.step(dt, q_in=lambda s: q)
    assert flat.T[0] > wall.T[0] + 150.0


def test_a_constant_cp_function_is_the_constant_model():
    a, b = _slab(), _slab(lambda T: np.full_like(np.asarray(T, float), 710.0))
    for _ in range(50):
        a.step(0.01, q_in=lambda s: 4.0e6, chemical_mass_flux=lambda s: 0.3, rho_surface=RHO)
        b.step(0.01, q_in=lambda s: 4.0e6, chemical_mass_flux=lambda s: 0.3, rho_surface=RHO)
    assert np.array_equal(a.T, b.T) and a.receded == b.receded


def _burn(mutate):
    cfg = load_config(CFG)
    mutate(cfg)
    t = np.linspace(0.0, 1.0, 6)
    P = np.full_like(t, 584.27 * PSI)
    return PintleEngineRunner(copy.deepcopy(cfg)).evaluate_arrays_with_time(t, P, P, use_coupled_solver=True)


def test_the_insert_heats_slower_with_its_real_specific_heat():
    def model(name):
        def m(cfg):
            cfg.graphite_insert.specific_heat_model = name
        return m

    flat = _burn(model("constant"))
    real = _burn(model("butland_maddison_1973"))
    assert real["T_graphite_surface"][1] < flat["T_graphite_surface"][1] - 100.0
    assert real["recession_throat"][-1] < flat["recession_throat"][-1]


def test_the_model_changes_nothing_without_an_insert():
    def off(name):
        def m(cfg):
            cfg.graphite_insert.enabled = False
            cfg.graphite_insert.specific_heat_model = name
        return m

    a, b = _burn(off("constant")), _burn(off("butland_maddison_1973"))
    for key in ("F", "Pc", "A_throat"):
        assert np.array_equal(np.asarray(a[key]), np.asarray(b[key]))
