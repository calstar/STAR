"""Huzel & Huang's combustion-gas viscosity fit, mu = 46.6e-10 M^0.5 T[R]^0.6, is in lbm/(in s).

It was converted with the lbf s/in^2 factor (6894.76) instead of 17.858, which made the gas
viscosity g_c = 386x too high and the Bartz convective coefficient ~117x too low -- the
long-standing "ablative convection ~283x low". Checked against NASA CEA transport properties,
not against the code.
"""
import math

import pytest

from engine.pipeline.constants import LBM_PER_IN_S_TO_PA_S


def test_the_conversion_is_mass_pounds():
    assert LBM_PER_IN_S_TO_PA_S == pytest.approx(0.45359237 / 0.0254, rel=1e-12)
    assert LBM_PER_IN_S_TO_PA_S == pytest.approx(17.857967, rel=1e-6)


@pytest.mark.parametrize("T, M, mu_cea", [
    # LOX/ethanol, O/F 1.5, Pc 434 psia chamber: CEA frozen transport 1.04e-4 Pa s
    (3226.0, 22.25, 1.04e-4),
])
def test_huzel_viscosity_is_the_right_order_against_cea(T, M, mu_cea):
    from engine.pipeline.thermal.regen_cooling import calculate_gas_viscosity_huzel
    mu = calculate_gas_viscosity_huzel(T, M)
    # Huzel's fit is an approximation; within a factor 1.6 of CEA. The wrong unit gave 264x.
    assert mu_cea / 1.6 < mu < mu_cea * 1.6
    assert mu == pytest.approx(46.6e-10 * math.sqrt(M) * (T * 1.8) ** 0.6 * 17.857967, rel=1e-6)


def test_every_copy_of_the_fit_agrees():
    from engine.pipeline.thermal.regen_cooling import calculate_gas_viscosity_huzel
    from engine.accel.chamber import _huzel_mu as _gas_viscosity_huzel   # the spray march film
    T, M = 3226.0, 22.25
    assert _gas_viscosity_huzel(T, M) == pytest.approx(calculate_gas_viscosity_huzel(T, M), rel=1e-12)
    src = open("engine/pipeline/thermal/ablative_cooling.py").read()
    assert "6894.76" not in src, "ablative_cooling.py converts the Huzel fit with the lbf factor again"
