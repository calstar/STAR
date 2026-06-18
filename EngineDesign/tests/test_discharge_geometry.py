"""Geometry-based discharge coefficient (Cd_inf from orifice diameter)."""

import math
import unittest

from engine.core.discharge import (
    cd_from_re,
    cd_inf_from_orifice_diameter,
    discharge_cd_inf_ratio,
)
from engine.pipeline.config_schemas import DischargeConfig


def _impinging_discharge() -> DischargeConfig:
    return DischargeConfig(
        Cd_inf=0.6,
        a_Re=0.18,
        Cd_min=0.35,
        use_geometry_cd=True,
        d_ref_m=0.002,
        cd_small_hole_exponent=0.20,
        cd_large_hole_log_gain=0.015,
        cd_inf_max=0.62,
        cd_inf_min_geom=0.48,
        d_min_m=0.0004,
    )


class TestDischargeGeometry(unittest.TestCase):
    def test_baseline_at_d_ref(self):
        cfg = _impinging_discharge()
        self.assertAlmostEqual(cd_inf_from_orifice_diameter(0.002, cfg), 0.6, places=6)

    def test_smaller_hole_penalty(self):
        cfg = _impinging_discharge()
        cd_small = cd_inf_from_orifice_diameter(0.001, cfg)
        self.assertLess(cd_small, 0.6)
        self.assertGreaterEqual(cd_small, 0.48)

    def test_larger_hole_mild_increase_capped(self):
        cfg = _impinging_discharge()
        cd_large = cd_inf_from_orifice_diameter(0.003, cfg)
        self.assertGreater(cd_large, 0.6)
        self.assertLessEqual(cd_large, 0.62)

    def test_matched_hole_style_similar_cd_ratio_at_mr_scaled_jets(self):
        """MR-rescaled O/F jets differ in d; Cd_inf tracks diameter (ratio stays O(1))."""
        cfg = _impinging_discharge()
        ratio = discharge_cd_inf_ratio(0.00228, 0.00175, cfg, cfg)
        self.assertGreater(ratio, 0.95)
        self.assertLess(ratio, 1.08)

    def test_cd_from_re_uses_geometry_ceiling(self):
        cfg = _impinging_discharge()
        cd_hi = cd_from_re(1.0e6, cfg, d_hyd_m=0.002)
        self.assertAlmostEqual(cd_hi, 0.6, places=3)
        cd_lo = cd_from_re(100.0, cfg, d_hyd_m=0.0008)
        self.assertLess(cd_lo, 0.6)
        self.assertGreaterEqual(cd_lo, cfg.Cd_min)

    def test_geometry_disabled_returns_baseline(self):
        cfg = DischargeConfig(Cd_inf=0.55, a_Re=0.1, use_geometry_cd=False)
        self.assertAlmostEqual(cd_inf_from_orifice_diameter(0.001, cfg), 0.55, places=6)


if __name__ == "__main__":
    unittest.main()
