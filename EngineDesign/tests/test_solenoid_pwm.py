"""Tests for solenoid PWM extension to the blowdown timeseries feature (Agent-B)."""
import pytest
from pydantic import ValidationError
from backend.routers.timeseries import SolenoidSchedule, SegmentsRequest


class TestSolenoidScheduleModel:
    def test_valid_interval(self):
        s = SolenoidSchedule(t_open=1.0, t_close=2.5)
        assert s.t_open == 1.0
        assert s.t_close == 2.5

    def test_t_close_before_t_open_raises(self):
        with pytest.raises(ValidationError):
            SolenoidSchedule(t_open=3.0, t_close=1.0)

    def test_t_close_equal_t_open_raises(self):
        with pytest.raises(ValidationError):
            SolenoidSchedule(t_open=2.0, t_close=2.0)

    def test_zero_t_open_allowed(self):
        s = SolenoidSchedule(t_open=0.0, t_close=1.0)
        assert s.t_open == 0.0

    def test_negative_t_open_raises(self):
        with pytest.raises(ValidationError):
            SolenoidSchedule(t_open=-0.5, t_close=1.0)


class TestSegmentsRequestSolenoidFields:
    def test_solenoid_fields_default_to_none(self):
        req = SegmentsRequest(
            duration_s=5.0, n_points=50,
            blowdown_mode=True,
            lox_initial_pressure_psi=600.0,
            fuel_initial_pressure_psi=600.0,
        )
        assert req.lox_solenoid_schedule is None
        assert req.fuel_solenoid_schedule is None

    def test_accepts_lox_schedule(self):
        req = SegmentsRequest(
            duration_s=5.0, n_points=50,
            blowdown_mode=True,
            lox_initial_pressure_psi=600.0,
            fuel_initial_pressure_psi=600.0,
            lox_solenoid_schedule=[{"t_open": 0.5, "t_close": 2.0},
                                    {"t_open": 3.0, "t_close": 4.5}],
        )
        assert len(req.lox_solenoid_schedule) == 2
        assert req.lox_solenoid_schedule[0].t_open == 0.5

    def test_accepts_empty_schedule_list(self):
        req = SegmentsRequest(
            duration_s=5.0, n_points=50,
            blowdown_mode=True,
            lox_initial_pressure_psi=600.0,
            fuel_initial_pressure_psi=600.0,
            lox_solenoid_schedule=[],
        )
        assert req.lox_solenoid_schedule == []

    def test_invalid_interval_in_schedule_raises(self):
        with pytest.raises(ValidationError):
            SegmentsRequest(
                duration_s=5.0, n_points=50,
                blowdown_mode=True,
                lox_initial_pressure_psi=600.0,
                fuel_initial_pressure_psi=600.0,
                lox_solenoid_schedule=[{"t_open": 3.0, "t_close": 1.0}],  # invalid
            )
