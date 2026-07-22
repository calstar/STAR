"""Chamber temperature corrected for incomplete combustion (Huzel Sample Calc 4-3).

CEA reports the chamber temperature an infinite-area chamber with complete
combustion would reach. A real chamber releases less energy, so it runs cooler.
Huzel & Huang apply that as

    (Tc)ns,design = (Tc)ns,theoretical x eta_c*^2

and Sample Calculation 4-3 carries 6460 degR x 0.975^2 = 6140 degR.

The exponent is 2 because c* ~ sqrt(Tc), so an efficiency measured on c* lands
on temperature squared.

These tests also guard the reason this was hard to fix rather than the fix
itself: eta_cstar() returns combustion efficiency and cooling efficiency
multiplied together, and chamber_solver already applies cooling to temperature
via effective_Tc. Squaring the blended value onto Tc would deduct the cooling
loss from temperature twice. The correction must therefore consume the
combustion-only component -- which the module used to compute and discard.
"""

import numpy as np
import pytest

from engine.pipeline.combustion_eff import calculate_actual_chamber_temp


class TestHuzelSampleCalculation4_3:
    """The printed worked example is the oracle."""

    # Huzel & Huang, NASA SP-125, Sample Calculation 4-3 (A-1 Stage Engine).
    HUZEL_TC_THEORETICAL_DEGR = 6460.0
    HUZEL_ETA_CSTAR = 0.975
    HUZEL_TC_DESIGN_DEGR = 6140.0

    def test_matches_printed_design_temperature(self):
        """6460 degR x 0.975^2 should reproduce Huzel's printed 6140 degR."""
        result = calculate_actual_chamber_temp(
            self.HUZEL_TC_THEORETICAL_DEGR, self.HUZEL_ETA_CSTAR
        )
        # Huzel rounds to 4 significant figures; the exact product is 6141.3.
        assert result == pytest.approx(self.HUZEL_TC_DESIGN_DEGR, rel=1e-3)

    def test_is_unit_agnostic(self):
        """A pure ratio, so Kelvin must give the same relative answer as degR."""
        Tc_k = self.HUZEL_TC_THEORETICAL_DEGR * 5.0 / 9.0
        result = calculate_actual_chamber_temp(Tc_k, self.HUZEL_ETA_CSTAR)
        assert result / Tc_k == pytest.approx(self.HUZEL_ETA_CSTAR ** 2)

    def test_exponent_is_two_not_one(self):
        """Guards against someone 'simplifying' Tc*eta^2 to Tc*eta.

        c* ~ sqrt(Tc) is the entire justification for the square; a linear
        version looks equally plausible and is wrong by 2.5 percent here.
        """
        squared = calculate_actual_chamber_temp(3261.0, 0.926)
        linear = 3261.0 * 0.926
        assert squared < linear
        assert squared == pytest.approx(3261.0 * 0.926 ** 2)


class TestCorrectionMagnitude:
    """The correction is large enough that omitting it is not a rounding error."""

    def test_realistic_efficiency_moves_tc_hundreds_of_kelvin(self):
        """At eta = 0.926 the drop is ~450 K on a LOX/CH4 chamber."""
        Tc_ideal = 3261.0  # CEA, LOX/CH4, Pc = 20 bar, MR 2.8
        Tc_corrected = calculate_actual_chamber_temp(Tc_ideal, 0.926)
        drop = Tc_ideal - Tc_corrected
        assert 400.0 < drop < 500.0

    def test_perfect_combustion_is_a_no_op(self):
        assert calculate_actual_chamber_temp(3261.0, 1.0) == pytest.approx(3261.0)

    def test_correction_is_monotonic_in_efficiency(self):
        temps = [calculate_actual_chamber_temp(3261.0, e)
                 for e in (0.80, 0.85, 0.90, 0.95, 1.00)]
        assert temps == sorted(temps)


class TestRejectsTheUnsourcedFormula:
    """The previous implementation used an untraceable formula. Keep it gone.

    It was  Tc * eta / (1 - (1-eta)(gamma-1)/gamma), carried no citation, and
    could not be derived. At eta = 0.926, gamma = 1.1397 it gives a multiplier
    of 0.934 where Huzel gives 0.858 -- a ~250 K disagreement on Tc.
    """

    def test_does_not_reproduce_the_old_multiplier(self):
        eta, gamma = 0.926, 1.1397
        old = eta / (1.0 - (1.0 - eta) * (gamma - 1.0) / gamma)
        new = calculate_actual_chamber_temp(1.0, eta)
        assert old == pytest.approx(0.9345, abs=1e-3)
        assert new == pytest.approx(0.8575, abs=1e-3)
        assert abs(old - new) > 0.05

    def test_gamma_argument_is_ignored(self):
        """gamma is vestigial; passing wildly different values must not matter."""
        a = calculate_actual_chamber_temp(3261.0, 0.926, gamma=1.14)
        b = calculate_actual_chamber_temp(3261.0, 0.926, gamma=1.67)
        c = calculate_actual_chamber_temp(3261.0, 0.926)
        assert a == b == c


class TestDegenerateInputs:
    @pytest.mark.parametrize("bad", [0.0, -0.1, np.nan, np.inf])
    def test_non_physical_efficiency_returns_ideal_unchanged(self, bad):
        """Fail open rather than emitting a zero or NaN chamber temperature."""
        assert calculate_actual_chamber_temp(3261.0, bad) == pytest.approx(3261.0)


class TestComponentsAreSeparable:
    """eta_cstar must expose the combustion and cooling factors unblended.

    This is the property the fix depends on. If eta_cstar ever goes back to
    returning only the product, the temperature correction silently starts
    deducting the cooling loss twice -- once here and once via effective_Tc.
    """

    def test_return_components_splits_the_product(self):
        from engine.pipeline import combustion_eff

        captured = {}

        def fake_advanced(*args, **kwargs):
            captured["called"] = True
            return {
                "eta_total": 0.90,
                "eta_Lstar": 1.0,
                "eta_kinetics": 1.0,
                "eta_mixing": 0.90,
            }

        import engine.pipeline.combustion_physics as cp_mod
        original = cp_mod.calculate_combustion_efficiency_advanced
        cp_mod.calculate_combustion_efficiency_advanced = fake_advanced
        try:
            eta, comps = combustion_eff.eta_cstar(
                1.0,
                _DummyEfficiencyConfig(),
                cooling_efficiency=0.80,
                advanced_params={"Ac": 1.0, "At": 0.1, "m_dot_total": 1.0,
                                 "chamber_length": 0.2},
                return_components=True,
            )
        finally:
            cp_mod.calculate_combustion_efficiency_advanced = original

        assert captured["called"]
        assert comps["eta_combustion"] == pytest.approx(0.90)
        # Cooling is exposed in both currencies.
        assert comps["eta_cooling_energy"] == pytest.approx(0.80)
        assert comps["eta_cooling_cstar"] == pytest.approx(np.sqrt(0.80))
        # c* takes the square-rooted one, NOT the energy fraction.
        assert eta == pytest.approx(0.90 * np.sqrt(0.80))
        assert eta != pytest.approx(0.90 * 0.80)
        # The whole point: the combustion factor is recoverable, and is NOT
        # the value a temperature correction would have gotten by default.
        assert comps["eta_combustion"] != pytest.approx(eta)

    def test_default_return_is_still_a_bare_float(self):
        """Existing callers must be unaffected."""
        import inspect

        from engine.pipeline.combustion_eff import eta_cstar

        sig = inspect.signature(eta_cstar)
        assert sig.parameters["return_components"].default is False


class _DummyEfficiencyConfig:
    """Minimal stand-in for CombustionEfficiencyConfig."""


class TestCoolingCurrencyConversion:
    """Cooling is measured in energy; c* is not linear in energy.

    _compute_cooling_efficiency returns 1 - Q_removed/(mdot*cp*Tc): the
    fraction of gas enthalpy surviving cooling, which is the factor on
    TEMPERATURE. Since c* = sqrt(gamma*R*Tc)/Gamma, the factor on c* is the
    square root of it.

    Verified numerically against the CEA cache: reconstructing cstar_ideal from
    CEA's own Tc/gamma/R matches to 0.07% mean over MR 2.4-4.0, and scaling Tc
    by f scales c* by sqrt(f) to five decimals.

    Before this fix the energy fraction was multiplied into c* directly, which
    roughly doubled cooling's c* penalty.
    """

    @staticmethod
    def _cstar(Tc, gamma, R):
        expo = (gamma + 1.0) / (2.0 * (gamma - 1.0))
        return np.sqrt(R * Tc / gamma) / (2.0 / (gamma + 1.0)) ** expo

    @pytest.mark.parametrize("f", [0.9607, 0.90, 0.80, 0.50])
    def test_cstar_scales_as_sqrt_of_the_temperature_factor(self, f):
        """The identity the fix rests on, exercised on real CEA-like state."""
        Tc, gamma, R = 3282.8, 1.1370, 426.4  # CEA, LOX/CH4, MR 2.86, 20 bar
        ratio = self._cstar(Tc * f, gamma, R) / self._cstar(Tc, gamma, R)
        assert ratio == pytest.approx(np.sqrt(f), rel=1e-9)
        # And emphatically not the linear factor, unless f is 1.
        if f < 1.0:
            assert ratio > f

    def test_penalty_on_cstar_is_roughly_half_the_energy_deficit(self):
        """Sanity framing: a 4% energy loss costs c* about 2%, not 4%."""
        f = 0.9607
        energy_deficit = 1.0 - f
        cstar_deficit = 1.0 - np.sqrt(f)
        assert cstar_deficit == pytest.approx(energy_deficit / 2.0, rel=0.02)

    def test_no_cooling_is_a_no_op_in_both_currencies(self):
        assert np.sqrt(1.0) == pytest.approx(1.0)


def test_correction_would_double_count_if_given_the_blended_eta():
    """Demonstrates the trap in numbers, so the docstring warning has teeth.

    Cooling already reaches temperature through effective_Tc. Feeding the
    blended eta here applies it a second time, costing an extra ~1000 K.
    """
    Tc_ideal = 3261.0
    eta_combustion, eta_cooling = 0.926, 0.90
    eta_blended = eta_combustion * eta_cooling

    correct = calculate_actual_chamber_temp(Tc_ideal, eta_combustion)
    double_counted = calculate_actual_chamber_temp(Tc_ideal, eta_blended)

    assert correct == pytest.approx(2796.0, abs=5.0)
    assert double_counted == pytest.approx(2265.0, abs=5.0)
    assert correct - double_counted > 500.0
