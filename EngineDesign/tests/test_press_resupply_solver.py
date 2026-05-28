"""Tests for copv/press_resupply_solver.py (Agent-A ODE solver)."""
import numpy as np
import pytest
from engine.pipeline.config_schemas import PressSystemConfig
from copv.press_resupply_solver import (
    cv_to_effective_area,
    series_cv,
    n2_mass_flow_cv,
    regulator_outlet_pressure,
    simulate_press_resupply,
    fit_cv_line_from_static_test,
)

PSI = 6894.757  # Pa per psi

@pytest.fixture
def ps():
    return PressSystemConfig(
        reg_cv=0.06,
        reg_droop_coeff=0.070,
        reg_setpoint_psi=450.0,
        reg_initial_copv_psi=4500.0,
        line_cv=0.04,
    )


class TestCvHelpers:
    def test_cv_to_area_positive(self):
        assert cv_to_effective_area(0.06) > 0

    def test_series_cv_less_than_smallest_input(self):
        cv = series_cv(0.06, 0.04)
        assert cv < 0.04   # must be smaller than the smaller Cv

    def test_series_cv_symmetric(self):
        assert series_cv(0.06, 0.04) == pytest.approx(series_cv(0.04, 0.06))

    def test_series_cv_formula(self):
        cv = series_cv(0.06, 0.04)
        expected = 1.0 / np.sqrt(1/0.06**2 + 1/0.04**2)
        assert cv == pytest.approx(expected)


class TestN2MassFlow:
    def test_positive_for_high_upstream(self):
        mdot = n2_mass_flow_cv(0.06, 4500*PSI, 450*PSI, 300.0)
        assert mdot > 0

    def test_zero_when_pressures_equal(self):
        assert n2_mass_flow_cv(0.06, 450*PSI, 450*PSI, 300.0) == pytest.approx(0.0)

    def test_zero_for_reverse_flow(self):
        assert n2_mass_flow_cv(0.06, 400*PSI, 450*PSI, 300.0) == pytest.approx(0.0)

    def test_choked_greater_than_subsonic(self):
        """At very high ΔP (choked), mdot should exceed subsonic estimate."""
        choked   = n2_mass_flow_cv(0.06, 4500*PSI, 100*PSI,  300.0)  # high ΔP → choked
        subsonic = n2_mass_flow_cv(0.06, 460*PSI,  455*PSI,  300.0)  # tiny ΔP → subsonic
        assert choked > subsonic

    def test_flow_increases_with_upstream_pressure(self):
        m1 = n2_mass_flow_cv(0.06, 2000*PSI, 400*PSI, 300.0)
        m2 = n2_mass_flow_cv(0.06, 4000*PSI, 400*PSI, 300.0)
        assert m2 > m1

    def test_flow_decreases_with_downstream_pressure(self):
        m1 = n2_mass_flow_cv(0.06, 4500*PSI, 4000*PSI, 300.0)
        m2 = n2_mass_flow_cv(0.06, 4500*PSI, 4400*PSI, 300.0)
        assert m1 > m2


class TestRegulatorDroop:
    def test_droop_increases_outlet_as_copv_drops(self):
        P_initial = regulator_outlet_pressure(4500*PSI, 450.0, 4500.0, 0.070)
        P_lower   = regulator_outlet_pressure(3000*PSI, 450.0, 4500.0, 0.070)
        assert P_lower > P_initial

    def test_droop_amount_per_spec(self):
        """70 psi rise per 1000 psi drop in COPV (Aqua 1120 spec)."""
        # COPV drops by 1000 psi: expect P_reg to rise by 0.070*1000 = 70 psi
        P0 = regulator_outlet_pressure(4500*PSI, 450.0, 4500.0, 0.070)
        P1 = regulator_outlet_pressure(3500*PSI, 450.0, 4500.0, 0.070)
        delta_psi = (P1 - P0) / PSI
        assert delta_psi == pytest.approx(70.0, rel=0.01)

    def test_copv_pressure_caps_output(self):
        """When COPV drops below setpoint, P_reg should not exceed P_copv."""
        # COPV at 300 psi, setpoint at 450 psi → droop would push P_reg above 450
        # but P_reg must be capped at P_copv
        P_reg = regulator_outlet_pressure(300*PSI, 450.0, 4500.0, 0.070)
        assert P_reg <= 300*PSI + 1.0  # allow 1 Pa tolerance


class TestSimulatePressResupply:
    def test_output_keys(self, ps):
        t = np.linspace(0, 2.0, 100)
        r = simulate_press_resupply(
            t, P_copv_initial_Pa=4500*PSI, P_tank_initial_Pa=400*PSI,
            V_copv_m3=0.0045, V_ull_initial_m3=0.005,
            press_system_config=ps, solenoid_schedule=[(0.0, 2.0)],
        )
        for k in ('time','P_copv_Pa','P_tank_Pa','mdot_press','P_reg_Pa','solenoid_open'):
            assert k in r, f"Missing key: {k}"

    def test_output_lengths(self, ps):
        t = np.linspace(0, 2.0, 100)
        r = simulate_press_resupply(
            t, P_copv_initial_Pa=4500*PSI, P_tank_initial_Pa=400*PSI,
            V_copv_m3=0.0045, V_ull_initial_m3=0.005,
            press_system_config=ps, solenoid_schedule=[(0.0, 2.0)],
        )
        for k in ('P_copv_Pa','P_tank_Pa','mdot_press','P_reg_Pa','solenoid_open'):
            assert len(r[k]) == 100

    def test_tank_pressurizes_when_open(self, ps):
        t = np.linspace(0, 5.0, 250)
        r = simulate_press_resupply(
            t, P_copv_initial_Pa=4500*PSI, P_tank_initial_Pa=400*PSI,
            V_copv_m3=0.0045, V_ull_initial_m3=0.005,
            press_system_config=ps, solenoid_schedule=[(0.5, 4.0)],
        )
        assert r['P_tank_Pa'][-1] > r['P_tank_Pa'][0]

    def test_copv_depletes_when_open(self, ps):
        t = np.linspace(0, 3.0, 150)
        r = simulate_press_resupply(
            t, P_copv_initial_Pa=4500*PSI, P_tank_initial_Pa=400*PSI,
            V_copv_m3=0.0045, V_ull_initial_m3=0.005,
            press_system_config=ps, solenoid_schedule=[(0.0, 3.0)],
        )
        assert r['P_copv_Pa'][-1] < r['P_copv_Pa'][0]

    def test_no_flow_when_closed(self, ps):
        t = np.linspace(0, 2.0, 100)
        r = simulate_press_resupply(
            t, P_copv_initial_Pa=4500*PSI, P_tank_initial_Pa=400*PSI,
            V_copv_m3=0.0045, V_ull_initial_m3=0.005,
            press_system_config=ps, solenoid_schedule=[],
        )
        assert r['P_copv_Pa'][-1] == pytest.approx(r['P_copv_Pa'][0], rel=1e-3)
        assert r['P_tank_Pa'][-1] == pytest.approx(r['P_tank_Pa'][0], rel=1e-3)

    def test_multiple_intervals(self, ps):
        """Tank should pressurize in steps matching solenoid open intervals."""
        t = np.linspace(0, 6.0, 300)
        r = simulate_press_resupply(
            t, P_copv_initial_Pa=4500*PSI, P_tank_initial_Pa=400*PSI,
            V_copv_m3=0.0045, V_ull_initial_m3=0.005,
            press_system_config=ps,
            solenoid_schedule=[(0.5, 1.5), (3.0, 4.0)],
        )
        # Tank should be higher at end than beginning
        assert r['P_tank_Pa'][-1] > r['P_tank_Pa'][0]

    def test_mdot_zero_when_solenoid_closed(self, ps):
        t = np.linspace(0, 3.0, 150)
        # Only open 1–2 s
        r = simulate_press_resupply(
            t, P_copv_initial_Pa=4500*PSI, P_tank_initial_Pa=400*PSI,
            V_copv_m3=0.0045, V_ull_initial_m3=0.005,
            press_system_config=ps, solenoid_schedule=[(1.0, 2.0)],
        )
        # Before 1s and after 2s, mdot should be near zero
        idx_before = np.where(t < 0.9)[0]
        idx_after  = np.where(t > 2.1)[0]
        assert np.all(r['mdot_press'][idx_before] < 1e-6)
        assert np.all(r['mdot_press'][idx_after]  < 1e-6)

    def test_line_cv_none_uses_reg_cv_only(self):
        """If line_cv is None, the regulator Cv alone limits flow."""
        ps_no_line = PressSystemConfig(
            reg_cv=0.06, reg_droop_coeff=0.070,
            reg_setpoint_psi=450.0, reg_initial_copv_psi=4500.0,
            line_cv=None,
        )
        t = np.linspace(0, 2.0, 100)
        r = simulate_press_resupply(
            t, P_copv_initial_Pa=4500*PSI, P_tank_initial_Pa=400*PSI,
            V_copv_m3=0.0045, V_ull_initial_m3=0.005,
            press_system_config=ps_no_line, solenoid_schedule=[(0.0, 2.0)],
        )
        # Should still run without error and show flow
        assert r['P_tank_Pa'][-1] > r['P_tank_Pa'][0]


class TestFitCvLine:
    def _make_synthetic_data(self, n=20):
        """Synthetic: COPV drops from 4500→4480, tank rises 400→418 over 2s."""
        t = np.linspace(0, 2.0, n)
        # Drop must be small enough that resulting mdot isn't greater than what reg_cv can provide
        P_copv = np.linspace(4500*PSI, 4490*PSI, n)  # 10 psi drop
        P_tank = np.linspace(400*PSI,  405*PSI,  n)  # 5 psi rise
        return t, P_copv, P_tank

    def _ps(self):
        return PressSystemConfig(reg_cv=0.06, reg_droop_coeff=0.070,
                                 reg_setpoint_psi=450.0, reg_initial_copv_psi=4500.0)

    def test_returns_positive_cv_line(self):
        t, Pc, Pt = self._make_synthetic_data()
        r = fit_cv_line_from_static_test(t, Pc, Pt, V_copv_m3=0.0045, V_ull_m3=0.005,
                                         press_system_config=self._ps())
        assert r['cv_line_median'] > 0

    def test_output_keys_present(self):
        t, Pc, Pt = self._make_synthetic_data()
        r = fit_cv_line_from_static_test(t, Pc, Pt, V_copv_m3=0.0045, V_ull_m3=0.005,
                                         press_system_config=self._ps())
        for k in ('cv_line_median','cv_line_mean','cv_line_per_step',
                  'mdot_copv_side','mdot_tank_side','cross_check_ratio'):
            assert k in r, f"Missing key: {k}"

    def test_cross_check_ratio_near_one(self):
        """For consistent synthetic data, COPV and tank side should agree."""
        t, Pc, Pt = self._make_synthetic_data(50)
        r = fit_cv_line_from_static_test(t, Pc, Pt, V_copv_m3=0.0045, V_ull_m3=0.005,
                                         press_system_config=self._ps())
        # Allow wide tolerance since pressures/temperatures are simplified
        assert 0.3 < r['cross_check_ratio'] < 3.0

    def test_raises_on_no_flow(self):
        """Flat COPV pressure (no flow) should raise ValueError."""
        t = np.linspace(0, 2.0, 20)
        P_copv = np.full(20, 4500*PSI)
        P_tank = np.full(20, 400*PSI)
        with pytest.raises(ValueError, match="No positive mdot"):
            fit_cv_line_from_static_test(t, P_copv, P_tank, V_copv_m3=0.0045, V_ull_m3=0.005,
                                         press_system_config=self._ps())
