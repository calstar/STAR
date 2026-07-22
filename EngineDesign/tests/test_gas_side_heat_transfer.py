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
        """h_g for a chamber of this class is ~2000-5000 W/(m^2.K).

        Anchored on NASA CEA transport properties for these products
        (LOX/CH4, Pc = 20 bar, MR 2.8, FROZEN reactions):

            mu = 1.03e-4 Pa.s   cp = 2463 J/(kg.K)
            k  = 0.394 W/(m.K)  Pr = 0.644

        Those give h_g ~ 2060 here. The dominant sensitivity is k: the
        conductivity used by the code has the largest error of the four, and it
        alone moves h_g by a factor of ~3.
        """
        h_g = _hot_wall()["h_hot"]
        assert 1.5e3 < h_g < 6.0e3, (
            f"h_hot = {h_g:.1f} W/(m^2.K) is outside the 1500-6000 band Bartz "
            f"gives for a chamber of this class; check cp/k/Pr, which must come "
            f"from the gas mixture rather than being derived from gamma"
        )

    def test_prandtl_is_physical(self):
        """A combustion gas has Pr ~ 0.5-1.0; nothing else is possible.

        Deriving Pr as mu*cp/k from three independently-wrong values produced
        2.25 here, which no gas exhibits. cp in particular must not come from
        gamma*R/(gamma-1): that identity holds for a calorically perfect gas,
        but CEA's GAMMAs is the isentropic exponent of a DISSOCIATING mixture,
        not cp/cv, and the derived cp overshoots by ~40%.
        """
        Pr = _hot_wall()["gas_prandtl"]
        assert 0.3 < Pr < 1.2, (
            f"hot-gas Prandtl = {Pr:.3f} is not physical for a combustion gas "
            f"(CEA frozen gives 0.644 for these products)"
        )

    def test_convective_flux_magnitude(self):
        """Convective flux at an ablative wall: a few MW/m^2 at this Pc."""
        q_conv = _hot_wall()["heat_flux_conv"]
        assert 2.0e6 < q_conv < 8.0e6, (
            f"convective flux {q_conv/1e6:.2f} MW/m^2 is outside the plausible "
            f"2-8 MW/m^2 band for a 20 bar chamber with a 1200 K wall"
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

    def test_convection_dominates_over_radiation(self):
        """Convection must carry the bulk of the load.

        A near-total collapse of the convective term is invisible in the
        headline number, because the total is the only value surfaced to the
        UI -- so this asserts the *split*, not just the sum.

        Reference for the expected split (measured, not folklore): Goebel,
        Kniesner, Frey, Knab & Mundt, "Radiative Heat Transfer Analysis in
        Modern Rocket Combustion Chambers", EUCASS 2013 / CEAS Space Journal
        6:79 (2014). For a subscale CH4/O2 chamber, radiative/total wall heat
        flux is 8% at its local peak (injector inlet) and 2.5% integrated over
        the chamber; H2/O2 peaks at 9-10%. Convection therefore carries
        >90% of the load, which is what the 0.75 threshold below guards.
        """
        result = _hot_wall()
        q_conv = result["heat_flux_conv"]
        q_total = result["heat_flux_total"]
        # 0.75 (i.e. radiation under 25%) rather than a bare majority: with the
        # transport properties corrected, convection alone already carries ~40%,
        # so a 0.5 threshold would flip to XPASS on an unrelated nudge while
        # radiation is still ~10x too high.
        assert q_conv / q_total > 0.75, (
            f"convection is only {100*q_conv/q_total:.1f}% of the total heat "
            f"flux; for a rocket chamber it should dominate"
        )


class TestCarbonDepositWarning:
    """Kerosene-class fuels must be flagged; clean fuels must not be.

    The gas-side model omits the carbon-deposit resistance (Huzel 4-17/4-18),
    which over-predicts kerolox heat load by ~5x. A silent 5x is exactly the
    failure mode this whole exercise has been about, so it warns. Equally, a
    warning that cried wolf on methalox would be worse than none -- hence the
    negative cases carry as much weight as the positive one.
    """

    @staticmethod
    def _cfg(fuel: str, ablative: bool = True):
        import types

        return types.SimpleNamespace(
            combustion=types.SimpleNamespace(cea=types.SimpleNamespace(fuel_name=fuel)),
            ablative_cooling=types.SimpleNamespace(enabled=ablative),
            regen_cooling=types.SimpleNamespace(enabled=False),
            graphite_insert=types.SimpleNamespace(enabled=False),
        )

    def _warn(self, fuel: str, ablative: bool = True):
        from engine.pipeline.thermal import gas_transport

        gas_transport._warned_fuels.clear()  # warns once per fuel by design
        return gas_transport.warn_if_carbon_depositing(self._cfg(fuel, ablative))

    @pytest.mark.parametrize("fuel", ["RP-1", "RP1", "Kerosene", "JP-8", "Jet-A"])
    def test_warns_for_kerosene_class(self, fuel):
        msg = self._warn(fuel)
        assert msg is not None, f"{fuel} deposits carbon but was not flagged"
        assert "over-predicted" in msg

    @pytest.mark.parametrize("fuel", ["CH4", "Ethanol", "Methanol", "LH2"])
    def test_silent_for_clean_fuels(self, fuel):
        assert self._warn(fuel) is None, (
            f"{fuel} does not lay down a carbon deposit; warning here would train "
            f"users to ignore the message"
        )

    def test_silent_when_no_wall_model_runs(self):
        """No heat-transfer model enabled -> the limitation is irrelevant."""
        assert self._warn("RP-1", ablative=False) is None

    def test_warns_only_once_per_fuel(self):
        from engine.pipeline.thermal import gas_transport

        gas_transport._warned_fuels.clear()
        cfg = self._cfg("RP-1")
        assert gas_transport.warn_if_carbon_depositing(cfg) is not None
        assert gas_transport.warn_if_carbon_depositing(cfg) is None, (
            "repeat calls must stay quiet; a per-timestep warning would be noise"
        )


class TestWallTemperatureSolver:
    """calculate_steady_state_temperature_profile must actually solve.

    Its previous iteration reduced algebraically to Ts_new = Ts_guess - q_rad/h,
    an identity that never referenced the wall stack. With q_rad = 0 it returned
    its own initial guess (0.8 * T_hot_gas) for every input; with q_rad > 0 it
    drifted by a fixed 10 iterations, reaching -16 650 K on realistic boundary
    conditions. Both failure modes are invisible unless something asserts that
    the output responds to the inputs, which is what these do.
    """

    @staticmethod
    def _profile(h_gas=2038.0, q_rad=3.5e5, k_abl=0.35):
        from engine.pipeline.thermal_analysis import (
            MaterialLayer,
            ThermalBoundaryConditions,
            calculate_steady_state_temperature_profile,
        )
        layers = [
            MaterialLayer("ablator", 0.010, k_abl, 1600.0, 1500.0, emissivity=0.85),
            MaterialLayer("steel", 0.003, 16.0, 7900.0, 500.0),
        ]
        return calculate_steady_state_temperature_profile(
            layers,
            ThermalBoundaryConditions(T_hot_gas=3016.0, h_hot_gas=h_gas, q_rad_hot=q_rad),
        )

    def test_temperatures_are_physical(self):
        r = self._profile()
        assert 300.0 < r["T_surface_hot"] < 4000.0, (
            f"hot-surface temperature {r['T_surface_hot']:.1f} K is not physical"
        )
        assert r["T_surface_cold"] <= r["T_surface_hot"], (
            "back face is hotter than the hot surface — heat is flowing uphill"
        )

    def test_responds_to_gas_side_coefficient(self):
        """More convective coupling must raise the surface temperature."""
        cold = self._profile(h_gas=500.0)["T_surface_hot"]
        hot = self._profile(h_gas=20000.0)["T_surface_hot"]
        assert hot > cold + 50.0, (
            f"surface temperature barely moved with h_g ({cold:.1f} -> {hot:.1f} K); "
            f"the solve is ignoring the gas-side boundary condition"
        )

    def test_matches_huzel_sample_calculation_4_7(self):
        """Reproduce a published worked example: Huzel & Huang Sample Calc 4-7.

        This is the strongest check in the file -- every other assertion here is
        a plausibility bound we chose ourselves, whereas this one has a printed
        answer we must land on.

        Huzel eq. (4-38), radiation-cooled nozzle extension:

            h_gc * (T_aw - T_wg) = eps * sigma * T_wg^4

        which is exactly the surface balance this solver implements, in the
        limit q_rad_in = 0 (no gas radiation term), T_ambient -> 0 (radiating to
        space) and R_wall -> infinity (negligible drop through the metal, which
        is the stated assumption). That the general form collapses onto Huzel's
        is the justification for including the re-radiation term at all.

        Given (A-4 stage nozzle extension at area ratio 8):
            h_gc = 7.1e-5 Btu/(in^2.sec.degR),  T_aw = 4900 degR,  eps = 0.95
        Printed answer:
            T_wg = 2660 degR,  q = 0.159 Btu/(in^2.sec)
        """
        from engine.pipeline.thermal_analysis import (
            MaterialLayer,
            ThermalBoundaryConditions,
            calculate_steady_state_temperature_profile,
        )

        BTU_J = 1055.05585
        IN2_M2 = 6.4516e-4
        h_si = 7.1e-5 * BTU_J / IN2_M2 * 1.8   # Btu/(in^2.s.degR) -> W/(m^2.K)
        Taw_si = 4900.0 / 1.8                  # degR -> K

        layers = [MaterialLayer("refractory", 0.002, 100.0, 10000.0, 300.0,
                                emissivity=0.95)]
        r = calculate_steady_state_temperature_profile(
            layers,
            ThermalBoundaryConditions(
                T_hot_gas=Taw_si, h_hot_gas=h_si, q_rad_hot=0.0,
                T_ambient=1e-6,     # radiating to space
                h_ambient=1e-9,     # adiabatic back face
            ),
        )
        T_wg_degR = r["T_surface_hot"] * 1.8
        q_si = h_si * (Taw_si - r["T_surface_hot"])
        q_huzel = 0.159 * BTU_J / IN2_M2

        assert T_wg_degR == pytest.approx(2660.0, rel=0.01), (
            f"wall temperature {T_wg_degR:.0f} degR does not reproduce Huzel "
            f"Sample Calc 4-7 (2660 degR)"
        )
        assert q_si == pytest.approx(q_huzel, rel=0.02), (
            f"heat flux {q_si/1e3:.1f} kW/m^2 does not reproduce Huzel's "
            f"{q_huzel/1e3:.1f} kW/m^2"
        )

    def test_responds_to_wall_conductivity(self):
        """A better-conducting liner must run a hotter back face."""
        insulating = self._profile(k_abl=0.1)["T_surface_cold"]
        conducting = self._profile(k_abl=16.0)["T_surface_cold"]
        assert conducting > insulating + 50.0, (
            f"back-face temperature barely moved with liner conductivity "
            f"({insulating:.1f} -> {conducting:.1f} K); the conduction "
            f"resistances are computed but not used"
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
