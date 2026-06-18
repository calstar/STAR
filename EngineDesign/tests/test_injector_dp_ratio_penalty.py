"""Piecewise injector ΔP/Pc hinge penalty for Layer 1 (per-stream bands)."""

import unittest

from engine.optimizer.injector_dp_penalty import (
    injector_dp_ratio_penalty_weighted,
    injector_dp_ratios_from_eval_result,
    injector_dp_ratio_within_gate,
    stream_injector_dp_band_hinge_squared,
    stream_injector_dp_raw_terms,
    stream_injector_dp_soft_floor_squared,
)


class TestInjectorDpRatioPenalty(unittest.TestCase):
    def test_weight_linear_scaling(self):
        """Doubling W_DP doubles weighted penalty for identical ratios."""
        band_o = band_f = (0.20, 0.35)
        r_o, r_f = 0.88, 1.62
        p_lo = injector_dp_ratio_penalty_weighted(
            r_o, r_f, 40.0, 120.0, o_band=band_o, f_band=band_f
        )
        p_hi = injector_dp_ratio_penalty_weighted(
            r_o, r_f, 80.0, 240.0, o_band=band_o, f_band=band_f
        )
        self.assertAlmostEqual(p_hi, 2.0 * p_lo, places=9)

    def test_zero_inside_default_bands(self):
        """Defaults: O and F preferred intervals yield zero penalty."""
        p = injector_dp_ratio_penalty_weighted(0.25, 0.85, 1.0, 1.0)
        self.assertAlmostEqual(p, 0.0, places=12)

    def test_zero_on_oxidizer_band_explicit(self):
        for r in (0.20, 0.27, 0.35):
            self.assertAlmostEqual(stream_injector_dp_band_hinge_squared(r, 0.20, 0.35), 0.0, places=12)

    def test_fuel_wide_band_reduces_penalty_vs_narrow_reference(self):
        """Fuel at 0.85 is penalized under narrow fuel band but not under default wide fuel band."""
        narrow_all = (0.20, 0.35)
        p_narrow = injector_dp_ratio_penalty_weighted(
            0.25, 0.85, 1.0, 0.0, o_band=narrow_all, f_band=narrow_all
        )
        p_default = injector_dp_ratio_penalty_weighted(0.25, 0.85, 1.0, 0.0)
        self.assertGreater(p_narrow, 0.0)
        self.assertAlmostEqual(p_default, 0.0, places=12)

    def test_positive_below_low_edge(self):
        self.assertGreater(stream_injector_dp_band_hinge_squared(0.10, 0.20, 0.35), 0.0)

    def test_oxidizer_soft_floor_penalizes_small_ratio_only(self):
        self.assertAlmostEqual(stream_injector_dp_soft_floor_squared(0.02, 0.15), (0.15 - 0.02) ** 2)
        self.assertAlmostEqual(stream_injector_dp_soft_floor_squared(0.40, 0.15), 0.0, places=12)
        band = (0.20, 0.37)
        p_base = injector_dp_ratio_penalty_weighted(
            0.014, 0.45, 100.0, 0.0, o_band=band, f_band=band, w_dp_o=100.0, w_dp_f=100.0
        )
        p_floor = injector_dp_ratio_penalty_weighted(
            0.014,
            0.45,
            100.0,
            0.0,
            o_band=band,
            f_band=band,
            w_dp_o=100.0,
            w_dp_f=100.0,
            o_soft_floor=0.15,
            w_dp_o_floor=1000.0,
        )
        self.assertGreater(p_floor, p_base)

    def test_asymmetric_stream_weights(self):
        """w_dp_o and w_dp_f scale hinges independently."""
        p_sym = injector_dp_ratio_penalty_weighted(
            0.50,
            0.85,
            100.0,
            0.0,
            w_dp_o=100.0,
            w_dp_f=100.0,
        )
        p_asym = injector_dp_ratio_penalty_weighted(
            0.50,
            0.85,
            100.0,
            0.0,
            w_dp_o=300.0,
            w_dp_f=100.0,
        )
        # Higher oxidizer weight triples oxidizer hinge contribution only (fuel hinge zero inside band).
        self.assertAlmostEqual(p_asym, 3.0 * p_sym, places=9)

    def test_two_streams_independent_bands(self):
        band = (0.20, 0.35)
        p_o = injector_dp_ratio_penalty_weighted(
            0.10, 0.27, 1.0, 0.0, o_band=band, f_band=band
        )
        p_f = injector_dp_ratio_penalty_weighted(
            0.27, 0.10, 1.0, 0.0, o_band=band, f_band=band
        )
        self.assertAlmostEqual(p_o, p_f, places=12)

    def test_deprecated_raw_terms_matches_lox_band(self):
        d, h = stream_injector_dp_raw_terms(0.40)
        span = 0.35 - 0.20
        expected = ((0.40 - 0.35) / span) ** 2
        self.assertAlmostEqual(d, expected, places=12)
        self.assertAlmostEqual(h, 0.0, places=12)

    def test_ratios_from_eval_result_prefers_delta_p(self):
        pc = 2e6
        res = {
            "diagnostics": {"delta_p_injector_O": 0.5e6, "delta_p_injector_F": 0.7e6},
        }
        ro, rf = injector_dp_ratios_from_eval_result(pc, res)
        self.assertAlmostEqual(ro, 0.25)
        self.assertAlmostEqual(rf, 0.35)

    def test_ratios_fallback_to_p_inj_minus_pc(self):
        pc = 1e6
        res = {
            "diagnostics": {"P_injector_O": 1.4e6, "P_injector_F": 1.35e6},
        }
        ro, rf = injector_dp_ratios_from_eval_result(pc, res)
        self.assertAlmostEqual(ro, 0.4)
        self.assertAlmostEqual(rf, 0.35)

    def test_ratio_within_gate_allows_micro_creep_above_upper_edge(self):
        """Closure noise can yield ΔP/Pc ≡ hi plus float dust; hinge is ~zero but plain ``<= hi`` can fail."""
        lo, hi = 0.15, 0.35
        self.assertTrue(injector_dp_ratio_within_gate(0.35, lo, hi))
        creep = hi + 3.0e-5
        self.assertTrue(injector_dp_ratio_within_gate(creep, lo, hi))
        far = hi + 0.02
        self.assertFalse(injector_dp_ratio_within_gate(far, lo, hi))
        self.assertIsNone(injector_dp_ratio_within_gate(None, lo, hi))


if __name__ == "__main__":
    unittest.main()
