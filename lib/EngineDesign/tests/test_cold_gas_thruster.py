"""Tests for the cold gas thruster analysis module."""

import numpy as np
import pytest
from payload.cold_gas_thruster import (
    ColdGasThruster,
    ColdGasThrusterConfig,
    ColdGasThrusterResult,
    G0,
)


def _make_config(**overrides) -> ColdGasThrusterConfig:
    """Helper to build a config with sensible test defaults."""
    defaults = dict(
        throat_diameter=0.003,    # 3 mm
        exit_diameter=0.006,      # 6 mm  → ε ≈ 4
        inlet_pressure=500_000,   # 500 kPa
        chamber_diameter=0.010,   # 10 mm
        chamber_length=0.015,     # 15 mm
    )
    defaults.update(overrides)
    return ColdGasThrusterConfig(**defaults)


# -------------------------------------------------------------------
# Basic physics sanity checks
# -------------------------------------------------------------------
class TestColdGasThrusterPhysics:
    """Verify the isentropic analysis gives physically reasonable results."""

    def test_thrust_positive(self):
        result = ColdGasThruster(_make_config()).compute()
        assert result.thrust > 0, "Thrust must be positive"

    def test_mass_flow_positive(self):
        result = ColdGasThruster(_make_config()).compute()
        assert result.mass_flow > 0

    def test_exit_mach_supersonic(self):
        """Expansion ratio > 1 should give M > 1."""
        result = ColdGasThruster(_make_config()).compute()
        assert result.exit_mach > 1.0

    def test_exit_temperature_below_inlet(self):
        """Isentropic expansion must cool the gas."""
        cfg = _make_config()
        result = ColdGasThruster(cfg).compute()
        assert result.exit_temperature < cfg.inlet_temperature

    def test_isp_in_expected_range(self):
        """CO₂ cold gas Isp should be roughly 40–80 s."""
        result = ColdGasThruster(_make_config()).compute()
        assert 30 < result.specific_impulse < 100, (
            f"Isp = {result.specific_impulse:.1f} s — outside expected CO₂ range"
        )

    def test_thrust_identity(self):
        """F should equal ṁ·v + (Pe-Pa)·Ae."""
        result = ColdGasThruster(_make_config()).compute()
        reconstructed = (
            result.mass_flow * result.exit_velocity
            + (result.exit_pressure - _make_config().ambient_pressure) * result.exit_area
        )
        np.testing.assert_allclose(result.thrust, reconstructed, rtol=1e-10)

    def test_mass_flow_isp_thrust_identity(self):
        """F should equal ṁ · Isp · g₀."""
        result = ColdGasThruster(_make_config()).compute()
        np.testing.assert_allclose(
            result.thrust, result.mass_flow * result.specific_impulse * G0, rtol=1e-10
        )


# -------------------------------------------------------------------
# Torque and angular dynamics
# -------------------------------------------------------------------
class TestTorqueDynamics:

    def test_torque_positive(self):
        result = ColdGasThruster(_make_config()).compute()
        assert result.torque > 0

    def test_torque_equals_f_times_arm(self):
        cfg = _make_config()
        result = ColdGasThruster(cfg).compute()
        expected = result.thrust * cfg.moment_arm
        np.testing.assert_allclose(result.torque, expected, rtol=1e-12)

    def test_angular_accel_positive(self):
        result = ColdGasThruster(_make_config()).compute()
        assert result.angular_accel > 0

    def test_angular_accel_equals_torque_over_moi(self):
        result = ColdGasThruster(_make_config()).compute()
        expected = result.torque / result.moi_estimate
        np.testing.assert_allclose(result.angular_accel, expected, rtol=1e-12)


# -------------------------------------------------------------------
# Scaling behaviour
# -------------------------------------------------------------------
class TestScaling:

    def test_higher_pressure_more_thrust(self):
        r_lo = ColdGasThruster(_make_config(inlet_pressure=200_000)).compute()
        r_hi = ColdGasThruster(_make_config(inlet_pressure=800_000)).compute()
        assert r_hi.thrust > r_lo.thrust

    def test_larger_throat_more_flow(self):
        r_small = ColdGasThruster(_make_config(throat_diameter=0.002)).compute()
        r_large = ColdGasThruster(_make_config(throat_diameter=0.005)).compute()
        assert r_large.mass_flow > r_small.mass_flow


# -------------------------------------------------------------------
# Nozzle contour
# -------------------------------------------------------------------
class TestNozzleContour:

    def test_contour_shape(self):
        cgt = ColdGasThruster(_make_config())
        pts = cgt.generate_nozzle_contour(do_plot=False)
        assert pts.ndim == 2
        assert pts.shape[1] == 2
        assert len(pts) > 10

    def test_contour_starts_converging(self):
        """Nozzle throat should have smaller radius than the chamber."""
        cgt = ColdGasThruster(_make_config())
        pts = cgt.generate_nozzle_contour(do_plot=False)
        # Chamber radius is pts[0, 1]
        # Throat radius should be the minimum radius in the contour
        r_min = np.min(pts[:, 1])
        assert r_min < pts[0, 1], (
            f"Throat radius {r_min:.3f} should be smaller than chamber radius {pts[0, 1]:.3f}"
        )

    def test_contour_ends_at_exit_radius(self):
        """Last contour point should be near the exit radius."""
        cfg = _make_config()
        cgt = ColdGasThruster(cfg)
        pts = cgt.generate_nozzle_contour(do_plot=False)
        r_exit = cfg.exit_diameter / 2.0
        np.testing.assert_allclose(pts[-1, 1], r_exit, rtol=0.01)

    def test_contour_includes_chamber(self):
        """First segment should be at the chamber radius and length."""
        cfg = _make_config()
        cgt = ColdGasThruster(cfg)
        pts = cgt.generate_nozzle_contour(do_plot=False)
        r_chamber = cfg.chamber_diameter / 2.0
        # Check first point matches chamber radius
        np.testing.assert_allclose(pts[0, 1], r_chamber, rtol=1e-10)
        # Check total length includes chamber length
        # (rao contour nozzle length is approx L_noz + x_entrance)
        # We just check the x-range is at least as large as chamber_length
        x_range = np.max(pts[:, 0]) - np.min(pts[:, 0])
        assert x_range > cfg.chamber_length


# -------------------------------------------------------------------
# Config validation
# -------------------------------------------------------------------
class TestConfig:

    def test_expansion_ratio_computed(self):
        cfg = _make_config()
        expected = (cfg.exit_diameter / cfg.throat_diameter) ** 2
        np.testing.assert_allclose(cfg.expansion_ratio, expected, rtol=1e-12)

    def test_moment_arm(self):
        cfg = _make_config(rocket_length=10.0, cg_from_tail=4.0)
        assert cfg.moment_arm == 6.0

    def test_r_specific(self):
        cfg = _make_config()
        expected = 8.314462618 / 0.04401
        np.testing.assert_allclose(cfg.R_specific, expected, rtol=1e-10)

    def test_use_solved_plot_false_by_default(self):
        cfg = _make_config()
        assert cfg._use_solved_plot is False

    def test_use_solved_plot_true_when_volume_set(self):
        cfg = _make_config(volume_chamber=1e-6)
        assert cfg._use_solved_plot is True

    def test_effective_volume_chamber_auto_estimate(self):
        """When volume_chamber=0, should estimate from A_chamber * chamber_length."""
        cfg = _make_config(chamber_diameter=0.010, chamber_length=0.015)
        expected = np.pi / 4.0 * 0.010 ** 2 * 0.015
        np.testing.assert_allclose(cfg._effective_volume_chamber, expected, rtol=1e-12)

    def test_effective_volume_chamber_uses_explicit(self):
        cfg = _make_config(volume_chamber=5e-6)
        assert cfg._effective_volume_chamber == 5e-6


# -------------------------------------------------------------------
# Solved chamber plot path
# -------------------------------------------------------------------
def _make_solved_config(**overrides) -> ColdGasThrusterConfig:
    """Config with volume_chamber set so the solved_chamber_plot path is used."""
    base = dict(
        throat_diameter=0.003,
        exit_diameter=0.006,
        chamber_diameter=0.010,
        chamber_length=0.020,
        # chamber volume = A_chamber * length as a realistic value
        volume_chamber=np.pi / 4.0 * 0.010 ** 2 * 0.020,
        inlet_pressure=500_000,
    )
    base.update(overrides)
    return ColdGasThrusterConfig(**base)


class TestSolvedChambertPlotPath:
    """Verify generate_nozzle_contour() works correctly via solved_chamber_plot."""

    def test_solved_path_selected(self):
        cfg = _make_solved_config()
        assert cfg._use_solved_plot is True

    def test_contour_shape(self):
        cgt = ColdGasThruster(_make_solved_config())
        pts = cgt.generate_nozzle_contour(do_plot=False)
        assert pts.ndim == 2
        assert pts.shape[1] == 2
        assert len(pts) > 10

    def test_contour_starts_at_chamber_radius(self):
        cfg = _make_solved_config()
        cgt = ColdGasThruster(cfg)
        pts = cgt.generate_nozzle_contour(do_plot=False)
        np.testing.assert_allclose(pts[0, 1], cfg.chamber_diameter / 2.0, rtol=1e-8)

    def test_contour_ends_at_exit_radius(self):
        cfg = _make_solved_config()
        cgt = ColdGasThruster(cfg)
        pts = cgt.generate_nozzle_contour(do_plot=False)
        np.testing.assert_allclose(pts[-1, 1], cfg.exit_diameter / 2.0, rtol=0.02)

    def test_contour_has_throat(self):
        """Minimum radius in the contour should be ~= throat radius."""
        cfg = _make_solved_config()
        cgt = ColdGasThruster(cfg)
        pts = cgt.generate_nozzle_contour(do_plot=False)
        r_min = np.min(pts[:, 1])
        np.testing.assert_allclose(r_min, cfg.throat_diameter / 2.0, rtol=0.05)

    def test_contour_throat_smaller_than_chamber(self):
        cfg = _make_solved_config()
        cgt = ColdGasThruster(cfg)
        pts = cgt.generate_nozzle_contour(do_plot=False)
        assert np.min(pts[:, 1]) < pts[0, 1]

    def test_lstar_auto_computed(self):
        """If Lstar=0, it should be computed from volume/A_throat without error."""
        cfg = _make_solved_config(Lstar=0.0)
        cgt = ColdGasThruster(cfg)
        pts = cgt.generate_nozzle_contour(do_plot=False)
        assert len(pts) > 10

    def test_lstar_explicit(self):
        """Providing an explicit Lstar should also work without error."""
        cfg = _make_solved_config(Lstar=1.5)
        cgt = ColdGasThruster(cfg)
        pts = cgt.generate_nozzle_contour(do_plot=False)
        assert len(pts) > 10


# -------------------------------------------------------------------
# Fallback path unchanged
# -------------------------------------------------------------------
class TestFallbackPathUnchanged:
    """Confirm the legacy hand-rolled path still works when volume_chamber=0."""

    def test_fallback_path_selected(self):
        cfg = _make_config()
        assert cfg._use_solved_plot is False

    def test_fallback_starts_at_chamber_radius(self):
        cfg = _make_config()
        cgt = ColdGasThruster(cfg)
        pts = cgt.generate_nozzle_contour(do_plot=False)
        np.testing.assert_allclose(pts[0, 1], cfg.chamber_diameter / 2.0, rtol=1e-10)

    def test_fallback_ends_at_exit_radius(self):
        cfg = _make_config()
        cgt = ColdGasThruster(cfg)
        pts = cgt.generate_nozzle_contour(do_plot=False)
        np.testing.assert_allclose(pts[-1, 1], cfg.exit_diameter / 2.0, rtol=0.01)
