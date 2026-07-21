"""Physical-sanity guards for the gas-side heat transfer chain.

This chain had no test coverage at all, which is how a 386x unit error in the
gas viscosity survived: nothing ever asserted that any intermediate value was
physically possible, and the one number surfaced in the UI happened to look
right because two large errors cancelled.

The assertions here are deliberately *loose*. They are not accuracy checks --
they are "is this physically possible" checks, with bounds wide enough that
only a genuine modelling error trips them. A correct model should clear them
by a wide margin.

Reference for the correlations under test:
    Huzel & Huang, "Design of Liquid Propellant Rocket Engines" (NASA SP-125),
    ch. 4 -- eq. (4-12) Nusselt form and nomenclature, (4-13) Bartz h_g,
    (4-15) Prandtl estimate, (4-16) gas viscosity.

Note the nomenclature under eq. (4-12): "mu = Viscosity, lb/in sec". That unit
string is what fixes the conversion factor used by eq. (4-16).

Tests marked ``xfail(strict=True)`` describe defects that are known-open and
scheduled. Strict mode means that when the underlying fix lands, the XPASS is
reported as a failure -- that is the intended signal to delete the marker.
"""

from __future__ import annotations

import numpy as np
import pytest

from engine.pipeline.thermal.regen_cooling import (
    calculate_gas_viscosity_huzel,
    estimate_hot_wall_heat_flux,
)


# A representative LOX/CH4 operating point: ~20 bar chamber, 100 mm bore.
# Values are order-of-magnitude realistic; nothing here depends on them being
# a specific engine.
TC_K = 3400.0
PC_PA = 2.0e6
GAMMA = 1.14
R_GAS = 378.0
M_MOL = 22.0
D_CHAMBER_M = 0.10
L_CHAMBER_M = 0.25
MDOT_KG_S = 2.0
T_WALL_K = 1200.0


def _gas_props():
    return {
        "Tc": TC_K,
        "Pc": PC_PA,
        "gamma": GAMMA,
        "R": R_GAS,
        "M": M_MOL,
        "chamber_length": L_CHAMBER_M,
        "chamber_area": np.pi * (D_CHAMBER_M / 2.0) ** 2,
    }


def _hot_wall():
    # config=None is the path taken by time_varying_solver.py, which passes no
    # regen config.
    return estimate_hot_wall_heat_flux(
        _gas_props(),
        None,
        wall_temperature=T_WALL_K,
        mdot_total=MDOT_KG_S,
    )


class TestGasViscosity:
    """Huzel eq. (4-16). The anchor test -- everything downstream depends on it."""

    def test_magnitude_is_gas_like(self):
        """Combustion gas at 3400 K is ~1e-4 Pa.s, not ~1e-2 (that is light oil).

        Applying the psi->Pa factor (6894.76) instead of the lb/(in.s)->Pa.s
        factor (17.858) inflates this by exactly g_c = 386.088 in/s^2.
        """
        mu = calculate_gas_viscosity_huzel(TC_K, M_MOL)
        assert 5.0e-5 < mu < 1.2e-4, (
            f"gas viscosity {mu:.3e} Pa.s is not physically possible for a "
            f"combustion gas at {TC_K} K (expected ~7e-5). A value near 2.8e-2 "
            f"means the lb/(in.s) -> Pa.s conversion used the psi -> Pa factor."
        )

    def test_scales_with_temperature_and_mass(self):
        """Sanity on the functional form: mu ~ M^0.5 T^0.6, both increasing."""
        assert calculate_gas_viscosity_huzel(3400.0, 22.0) > calculate_gas_viscosity_huzel(2000.0, 22.0)
        assert calculate_gas_viscosity_huzel(3400.0, 30.0) > calculate_gas_viscosity_huzel(3400.0, 22.0)


class TestGasSideCoefficient:
    """The convective film coefficient and the flow regime that sets it."""

    def test_flow_is_turbulent(self):
        """A rocket chamber is never laminar.

        This is the assertion that would have caught the viscosity bug directly:
        an inflated mu drove Re below the 2000 threshold in
        estimate_hot_wall_heat_flux, silently selecting the laminar Nu = 4.36
        branch and collapsing h_g by ~200x.
        """
        mu = calculate_gas_viscosity_huzel(TC_K, M_MOL)
        rho = PC_PA / (R_GAS * TC_K)
        area = np.pi * (D_CHAMBER_M / 2.0) ** 2
        velocity = MDOT_KG_S / (rho * area)
        reynolds = rho * velocity * D_CHAMBER_M / mu

        assert reynolds > 1.0e4, (
            f"chamber Reynolds number {reynolds:.3e} implies laminar or "
            f"transitional flow, which no liquid rocket chamber exhibits"
        )

    def test_h_gas_magnitude(self):
        """h_g for a chamber of this class is O(10^3) W/(m^2.K).

        The lower bound is set well below the physically expected 2000-5000 on
        purpose: the default hot-gas thermal conductivity is itself suspect
        (0.1 W/m.K, vs ~0.3-0.5 for combustion products at 3400 K), which drags
        the computed value down. Tighten this bound once that is addressed.
        """
        h_g = _hot_wall()["h_hot"]
        assert 300.0 < h_g < 2.0e4, (
            f"h_hot = {h_g:.1f} W/(m^2.K) is outside any plausible range for a "
            f"rocket chamber; single digits indicate the laminar Nu branch"
        )


class TestHeatFlux:
    """Total wall heat flux and its convective/radiative split."""

    def test_total_flux_magnitude(self):
        """1-10 MW/m^2 is the accepted band for a chamber at this pressure."""
        q_total = _hot_wall()["heat_flux_total"]
        assert 0.5e6 < q_total < 1.5e7, (
            f"chamber heat flux {q_total/1e6:.2f} MW/m^2 is outside the "
            f"plausible 0.5-15 MW/m^2 band"
        )

    @pytest.mark.xfail(
        strict=True,
        reason=(
            "Gas emissivity is hardcoded to the wall's surface emissivity "
            "(0.8-0.85). That value is correct for charred phenolic but wrong "
            "for the gas: LOX/CH4 products are non-luminous CO2/H2O band "
            "radiators, not a grey body, so radiation is overstated by roughly "
            "an order of magnitude. Needs a separate gas_emissivity, ideally "
            "from mean beam length + Hottel/WSGG. Delete this marker when fixed."
        ),
    )
    def test_convection_dominates_over_radiation(self):
        """Convection must carry the bulk of the load.

        A near-total collapse of the convective term is invisible in the
        headline number, because the total is the only value surfaced to the
        UI -- so this asserts the *split*, not just the sum. Huzel/Sutton
        design guidance puts radiation at ~5% of the total for non-luminous
        propellants, and up to ~40% only for metallised or heavily sooting ones.
        """
        result = _hot_wall()
        q_conv = result["heat_flux_conv"]
        q_total = result["heat_flux_total"]
        assert q_conv / q_total > 0.5, (
            f"convection is only {100*q_conv/q_total:.1f}% of the total heat "
            f"flux; for a rocket chamber it should dominate"
        )


class TestNativeParity:
    """The C port reimplements the same viscosity correlation."""

    def test_python_and_c_viscosity_agree(self):
        ed_native = pytest.importorskip(
            "engine.native.python.ed_native",
            reason="native extension not built",
        )
        fn = getattr(ed_native, "ed_gas_viscosity_huzel", None)
        if fn is None:
            pytest.skip("native build does not expose ed_gas_viscosity_huzel")

        py_mu = calculate_gas_viscosity_huzel(TC_K, M_MOL)
        c_mu = fn(TC_K, M_MOL)
        assert py_mu == pytest.approx(c_mu, rel=1e-9), (
            "Python and C viscosity disagree -- the shared conversion constant "
            "is defined in two places (constants.py and ed_phys_const.h) and "
            "they have drifted"
        )
