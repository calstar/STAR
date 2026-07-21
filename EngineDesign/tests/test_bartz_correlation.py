"""Bartz gas-side film coefficient against Huzel & Huang Sample Calculation 4-3.

Huzel works eq. (4-13) for the A-1 stage engine and prints every intermediate
group, which makes this a genuine oracle rather than a plausibility check --
each of the four bracketed terms is asserted separately, so a failure says
WHICH one is wrong instead of just "the correlation".

WHAT IS BEING CHECKED AGAINST WHAT. Every reference value below is a number
printed in Huzel & Huang (NASA SP-125), chapter IV. None is inferred, curve-fit
or taken from a secondary source:

    eq. (4-13), p. 100        the correlation
    eq. (4-14), p. 101        sigma in closed form -- transcribed verbatim and
                              re-transcribed independently in
                              TestSigmaAgainstFigure4_24, so the implementation
                              is pinned to the printed equation, not to a
                              reconstruction from the chart
    fig. 4-24,  p. 101        sigma tabulated; a cross-check on eq. (4-14),
                              NOT the source of it
    eqs. (4-15)/(4-16)        Pr and mu, checked in TestHuzelInputRelations
    Sample Calc (4-3), pp. 102-103   all four groups, their product, and the
                              three station h_g values

Two tolerances are deliberately loose, in both cases because HUZEL's side is
the imprecise one, not ours: his printed intermediates are rounded on the page
(see TestHuzelInputRelations), and figure 4-24 is a small log-scale plot read
to two significant figures. Both are documented where they occur rather than
tuned until they pass.

    LO2/RP-1, (Pc)ns = 1000 psia, MR 2.35
    (Tc)ns theoretical 6460 degR -> design 6460 x 0.975^2 = 6140 degR
    m = 22.5 lb/mol, gamma = 1.222
    design c* = 5660 ft/sec, D_t = 24.9 in
    throat contour mean radius R = (18.68 + 4.75)/2 = 11.71 in

        cp = gamma*R/((gamma-1)*J) = 0.485 Btu/lb-degF     (eq. 4-1 form)
        Pr = 4*gamma/(9*gamma-5)   = 0.816                 (eq. 4-15)
        mu = 46.6e-10 * m^0.5 * T^0.6 = 4.18e-6 lb/in-sec  (eq. 4-16)

        h_g = [0.01366 x 0.046 x 4.02 x 1.078] (A_t/A)^0.9 sigma
            = 0.0027 (A_t/A)^0.9 sigma   Btu/(in^2 sec degF)

Two details in that data are load-bearing elsewhere and are pinned here too:
mu is evaluated at the COMBUSTION-CORRECTED temperature (6140, not 6460), and
R is a throat contour curvature radius -- a quantity unrelated to any chamber
diameter, which is what the old (D_chamber/D_throat)^0.1 term wrongly used.
"""

import math

import pytest

from engine.pipeline.thermal.bartz import (
    BTU_IN2_S_F_TO_W_M2_K,
    bartz_groups_imperial,
    bartz_h_g,
    bartz_h_g_imperial,
)

# --- Sample Calculation 4-3, A-1 stage -------------------------------------
D_THROAT_IN = 24.9
PC_PSIA = 1000.0
CSTAR_FT_S = 5660.0
R_CURV_IN = (18.68 + 4.75) / 2.0        # 11.71
MU_LB_IN_S = 4.18e-6
CP_BTU_LB_F = 0.485
PR = 0.816

HUZEL = dict(diameter=0.01366, transport=0.046, mass_flux_group=4.02,
             curvature=1.078, product=0.0027)


@pytest.fixture(scope="module")
def groups():
    return bartz_groups_imperial(
        D_THROAT_IN, PC_PSIA, CSTAR_FT_S, R_CURV_IN, MU_LB_IN_S, CP_BTU_LB_F, PR)


class TestHuzelSampleCalculation4_3:
    """Every printed intermediate, checked on its own."""

    def test_diameter_group(self, groups):
        """0.026 / 24.9^0.2 -> 0.01366."""
        assert groups["diameter"] == pytest.approx(HUZEL["diameter"], rel=1e-3)

    def test_transport_group(self, groups):
        """mu^0.2 cp / Pr^0.6 -> 0.046. Huzel prints only 2 significant figures."""
        assert groups["transport"] == pytest.approx(HUZEL["transport"], rel=2e-2)

    def test_mass_flux_is_a_mass_flux_not_a_pressure(self, groups):
        """(Pc)ns g / c* = 1000 x 32.2 / 5660 = 5.69 lb/(in^2 sec).

        Guards the single most likely misreading of eq. 4-13: treating this
        group as a pressure term and dropping g, or using a g in the wrong
        units. A wrong g here is a silent multiplier on every heat flux.
        """
        assert groups["mass_flux"] == pytest.approx(5.69, rel=5e-3)

    def test_mass_flux_group(self, groups):
        """(5.69)^0.8 -> 4.02."""
        assert groups["mass_flux_group"] == pytest.approx(HUZEL["mass_flux_group"], rel=2e-3)

    def test_curvature_group(self, groups):
        """(24.9/11.71)^0.1 -> 1.078."""
        assert groups["curvature"] == pytest.approx(HUZEL["curvature"], rel=1e-3)

    def test_full_bracket(self, groups):
        """Product of all four -> 0.0027 Btu/(in^2 sec degF)."""
        assert groups["product"] == pytest.approx(HUZEL["product"], rel=1e-2)

    def test_h_g_at_the_throat(self):
        """At the throat A_t/A = 1, so h_g is the bracket itself (sigma = 1)."""
        h = bartz_h_g_imperial(
            D_THROAT_IN, PC_PSIA, CSTAR_FT_S, R_CURV_IN,
            MU_LB_IN_S, CP_BTU_LB_F, PR, area_ratio_At_over_A=1.0)
        assert h == pytest.approx(HUZEL["product"], rel=1e-2)


class TestHuzelInputRelations:
    """The property correlations feeding the sample, so the inputs are pinned too.

    Tolerances here are looser than in the group tests above because Huzel
    rounds his intermediates on the page and the printed results inherit that.
    Both discrepancies below were traced to his rounding, not to an error on
    either side, so they are pinned at the level his arithmetic supports rather
    than tightened until they pass by coincidence.
    """

    def test_prandtl_from_equation_4_15(self):
        """4*1.222/(9*1.222-5) = 0.81494; Huzel prints 0.816 (0.13% high)."""
        gamma = 1.222
        assert 4.0 * gamma / (9.0 * gamma - 5.0) == pytest.approx(0.816, rel=2e-3)

    def test_viscosity_from_equation_4_16_at_the_corrected_temperature(self):
        """46.6e-10 * 22.5^0.5 * 6140^0.6 -> 4.18e-6 lb/in-sec.

        6140 degR is the design (Tc)ns -- theoretical 6460 knocked down by the
        c* correction squared. Using 6460 here gives 4.26e-6, ~3 percent high,
        and the error propagates as mu^0.2 into h_g. This is Huzel evaluating
        transport properties AFTER the combustion-efficiency correction.

        Exact evaluation gives 4.1436e-6 against his printed 4.18e-6, 0.87%
        apart. That gap is his rounding, visible in the line he shows:
        22.5^0.5 = 4.7434 printed as 4.76, and 6140^0.6 = 187.4 printed as 188.
        Carrying those rounded factors reproduces 4.17e-6. So the tolerance is
        set to accommodate his precision, not ours.
        """
        mu = 46.6e-10 * 22.5 ** 0.5 * 6140.0 ** 0.6
        assert mu == pytest.approx(4.18e-6, rel=1e-2)

        # His own printed intermediates, to show where the gap comes from.
        assert 22.5 ** 0.5 == pytest.approx(4.7434, rel=1e-4)
        assert 6140.0 ** 0.6 == pytest.approx(187.4, rel=1e-3)
        assert 46.6e-10 * 4.76 * 188.0 == pytest.approx(4.17e-6, rel=5e-3)

        mu_uncorrected = 46.6e-10 * 22.5 ** 0.5 * 6460.0 ** 0.6
        assert mu_uncorrected > mu
        assert mu_uncorrected / mu == pytest.approx((6460.0 / 6140.0) ** 0.6, rel=1e-9)

    def test_design_temperature_is_theoretical_times_eta_squared(self):
        assert 6460.0 * 0.975 ** 2 == pytest.approx(6140.0, rel=1e-3)


class TestAreaAndSigmaScaling:
    def test_h_g_peaks_at_the_throat(self):
        """(A_t/A)^0.9 -- heat flux is highest where the gas is fastest."""
        at_throat = bartz_h_g_imperial(
            D_THROAT_IN, PC_PSIA, CSTAR_FT_S, R_CURV_IN,
            MU_LB_IN_S, CP_BTU_LB_F, PR, area_ratio_At_over_A=1.0)
        in_chamber = bartz_h_g_imperial(
            D_THROAT_IN, PC_PSIA, CSTAR_FT_S, R_CURV_IN,
            MU_LB_IN_S, CP_BTU_LB_F, PR, area_ratio_At_over_A=1.0 / 2.0)
        assert in_chamber < at_throat
        assert in_chamber / at_throat == pytest.approx(0.5 ** 0.9, rel=1e-9)

    def test_sigma_scales_linearly(self):
        base = bartz_h_g_imperial(D_THROAT_IN, PC_PSIA, CSTAR_FT_S, R_CURV_IN,
                                  MU_LB_IN_S, CP_BTU_LB_F, PR)
        scaled = bartz_h_g_imperial(D_THROAT_IN, PC_PSIA, CSTAR_FT_S, R_CURV_IN,
                                    MU_LB_IN_S, CP_BTU_LB_F, PR, sigma=1.3)
        assert scaled / base == pytest.approx(1.3, rel=1e-12)


class TestSigmaAgainstFigure4_24:
    """eq. (4-14) as implemented vs the sigma values Huzel reads off figure 4-24.

    The implementation IS Huzel's printed eq. (4-14) (p. 101), so this class is
    a consistency check between his equation and his own chart -- not a
    validation of the equation, which is the primary source and is pinned
    exactly by test_matches_huzel_equation_4_14_literally below.

    Sample Calculation 4-3 states "a (Twg/(Tc)ns) value of 0.8 is used to
    determine the a values from figure 4-24 (gamma ~ 1.2)" and then applies
    1.05 in the chamber, 1.0 at the throat and 0.8 at eps = 5. Those three
    numbers appear as running prose on p. 103, not as a table.

    Tolerance is 5 percent because the CHART is the imprecise side: it is a
    small log-scale plot read to two significant figures, and the printed "1.0"
    at the throat is the giveaway. All three deviations are positive, which is
    what a consistently-rounded chart read looks like.

    The Mach numbers are solved from the isentropic area-Mach relation at
    gamma = 1.2, since figure 4-24 is indexed by area ratio rather than Mach.
    """

    TWG_OVER_TC = 0.8
    GAMMA = 1.2

    @pytest.mark.parametrize("station, mach, chart", [
        ("chamber (Ac/At = 1.6)", 0.4046, 1.05),
        ("throat", 1.0, 1.0),
        ("exit, eps = 5", 2.7850, 0.8),
    ])
    def test_matches_chart(self, station, mach, chart):
        from engine.pipeline.thermal.bartz import bartz_sigma
        sigma = bartz_sigma(self.TWG_OVER_TC, self.GAMMA, mach)
        assert sigma == pytest.approx(chart, rel=5e-2), station

    def test_sigma_decreases_along_the_nozzle(self):
        """Chamber > throat > exit, matching the chart's trend."""
        from engine.pipeline.thermal.bartz import bartz_sigma
        chamber = bartz_sigma(self.TWG_OVER_TC, self.GAMMA, 0.4046)
        throat = bartz_sigma(self.TWG_OVER_TC, self.GAMMA, 1.0)
        exit_ = bartz_sigma(self.TWG_OVER_TC, self.GAMMA, 2.7850)
        assert chamber > throat > exit_

    def test_matches_huzel_equation_4_14_literally(self):
        """Transcribe eq. (4-14) independently and require an exact match.

        Guards the implementation against a later "simplification" -- dropping
        a 0.5, folding the two brackets together, or swapping the 0.68 and 0.12
        exponents, none of which would be obvious from the resulting numbers.
        """
        from engine.pipeline.thermal.bartz import bartz_sigma
        for tr in (0.35, 0.6, 0.8, 1.0):
            for gamma in (1.14, 1.2, 1.222, 1.4):
                for mach in (0.0, 0.3, 1.0, 2.5, 4.0):
                    k = 1.0 + (gamma - 1.0) / 2.0 * mach ** 2
                    expected = 1.0 / ((0.5 * tr * k + 0.5) ** 0.68 * k ** 0.12)
                    assert bartz_sigma(tr, gamma, mach) == pytest.approx(
                        expected, rel=1e-12), (tr, gamma, mach)

    def test_cold_wall_raises_h_g(self):
        """sigma > 1 for a cold wall -- it is NOT a knockdown factor.

        Easy to assume any 'correction factor' reduces the answer. A cold wall
        thins the boundary layer and increases heat transfer, so getting this
        backwards would under-predict heat load, which is the dangerous
        direction for a liner.
        """
        from engine.pipeline.thermal.bartz import bartz_sigma
        cold = bartz_sigma(0.35, self.GAMMA, 0.2)   # realistic chamber wall
        hot = bartz_sigma(0.95, self.GAMMA, 0.2)    # wall near gas temperature
        assert cold > 1.0
        assert cold > hot

    def test_reduces_to_unity_when_wall_is_at_stagnation_temperature(self):
        """Twg/(Tc)ns = 1 at M = 0 means no property variation to correct."""
        from engine.pipeline.thermal.bartz import bartz_sigma
        assert bartz_sigma(1.0, self.GAMMA, 0.0) == pytest.approx(1.0, rel=1e-12)

    @pytest.mark.parametrize("bad_gamma", [1.0, 0.9, -1.0, float("nan")])
    def test_rejects_bad_gamma(self, bad_gamma):
        from engine.pipeline.thermal.bartz import bartz_sigma
        with pytest.raises(ValueError):
            bartz_sigma(0.8, bad_gamma, 1.0)


class TestSampleCalculation4_3StationValues:
    """The three h_g values Huzel prints, end to end with his chart sigmas."""

    @pytest.mark.parametrize("station, area_ratio_At_over_A, sigma, expected", [
        ("chamber", 1.0 / 1.6, 1.05, 0.00185),
        ("throat", 1.0, 1.0, 0.0027),
        ("exit eps=5", 1.0 / 5.0, 0.8, 0.000507),
    ])
    def test_station_h_g(self, station, area_ratio_At_over_A, sigma, expected):
        h = bartz_h_g_imperial(
            D_THROAT_IN, PC_PSIA, CSTAR_FT_S, R_CURV_IN,
            MU_LB_IN_S, CP_BTU_LB_F, PR,
            area_ratio_At_over_A=area_ratio_At_over_A, sigma=sigma)
        assert h == pytest.approx(expected, rel=2e-2), station

    def test_area_terms_match_huzels_printed_values(self):
        """(1/1.6)^0.9 -> 0.655 and (1/5)^0.9 -> 0.235."""
        assert (1.0 / 1.6) ** 0.9 == pytest.approx(0.655, rel=5e-3)
        assert (1.0 / 5.0) ** 0.9 == pytest.approx(0.235, rel=5e-3)

    def test_throat_is_the_hottest_station(self):
        """Sanity on the whole assembly: 0.0027 > 0.00185 > 0.000507."""
        assert 0.0027 > 0.00185 > 0.000507


class TestPrandtlExponentIsBartzNotColburn:
    """Pr^-0.6 in eq. 4-13 means n = 0.4. Do not swap in eq. 4-12's Pr^0.34.

    Huzel offers 4-12 (Colburn) and 4-13 (Bartz) as alternatives -- "or as
    Bartz has shown". Quoting 4-12's exponent at 4-13 is an easy and wrong
    edit, so it is locked down here with the algebra that connects them:
    substituting k = mu*cp/Pr into h = (k/D) C Re^0.8 Pr^n gives
    h ~ mu^0.2 cp Pr^(n-1), and n-1 = -0.6 exactly when n = 0.4.
    """

    def test_exponent_corresponds_to_n_equals_0_4(self):
        from engine.pipeline.thermal import bartz
        assert bartz.BARTZ_PR_EXPONENT == pytest.approx(0.6)
        implied_n = 1.0 - bartz.BARTZ_PR_EXPONENT
        assert implied_n == pytest.approx(0.4)
        assert implied_n != pytest.approx(0.34)

    def test_colburn_exponent_would_change_the_answer(self, groups):
        """Not a large error -- which is why it could slip in unnoticed."""
        colburn = (MU_LB_IN_S ** 0.2 * CP_BTU_LB_F) / PR ** 0.66
        ratio = colburn / groups["transport"]
        assert 1.0 < ratio < 1.05


class TestSIWrapper:
    """SI in, SI out, with exactly one conversion boundary."""

    def test_round_trips_the_sample_calculation(self):
        h_si = bartz_h_g(
            D_throat_m=D_THROAT_IN * 0.0254,
            Pc_pa=PC_PSIA * 6894.757293168361,
            cstar_m_s=CSTAR_FT_S * 0.3048,
            throat_curvature_radius_m=R_CURV_IN * 0.0254,
            mu_pa_s=MU_LB_IN_S * 17.857967302549516,
            cp_j_kg_k=CP_BTU_LB_F * 4186.8,
            Pr=PR,
        )
        expected = HUZEL["product"] * BTU_IN2_S_F_TO_W_M2_K
        assert h_si == pytest.approx(expected, rel=1e-2)

    def test_conversion_constant(self):
        """Btu/(in^2 s degF) -> W/(m^2 K) is about 2.9436e6."""
        assert BTU_IN2_S_F_TO_W_M2_K == pytest.approx(2.9436e6, rel=1e-4)

    def test_result_is_physically_plausible_for_a_large_kerolox_throat(self):
        h_si = HUZEL["product"] * BTU_IN2_S_F_TO_W_M2_K
        assert 5_000.0 < h_si < 12_000.0


class TestRejectsBadInput:
    @pytest.mark.parametrize("bad", [0.0, -1.0, float("nan"), float("inf")])
    def test_non_physical_inputs_raise(self, bad):
        with pytest.raises(ValueError):
            bartz_groups_imperial(bad, PC_PSIA, CSTAR_FT_S, R_CURV_IN,
                                  MU_LB_IN_S, CP_BTU_LB_F, PR)

    def test_zero_area_ratio_raises(self):
        with pytest.raises(ValueError):
            bartz_h_g_imperial(D_THROAT_IN, PC_PSIA, CSTAR_FT_S, R_CURV_IN,
                               MU_LB_IN_S, CP_BTU_LB_F, PR,
                               area_ratio_At_over_A=0.0)

    def test_curvature_radius_must_be_separate_from_diameter(self):
        """A rough guard that R is not being fed a chamber dimension.

        Not enforceable in general, but D_t/R for a real contour lands near 2,
        giving a curvature factor close to 1.08. Feeding it something wildly
        off produces a visibly different factor, which this documents.
        """
        sane = bartz_groups_imperial(D_THROAT_IN, PC_PSIA, CSTAR_FT_S, R_CURV_IN,
                                     MU_LB_IN_S, CP_BTU_LB_F, PR)["curvature"]
        assert 1.0 < sane < 1.15
        wrong = bartz_groups_imperial(D_THROAT_IN, PC_PSIA, CSTAR_FT_S, 200.0,
                                      MU_LB_IN_S, CP_BTU_LB_F, PR)["curvature"]
        assert wrong < 0.82
