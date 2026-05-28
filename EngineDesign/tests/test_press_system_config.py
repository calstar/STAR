"""Tests for PressSystemConfig schema extension (Agent-A Feature 1)."""
import pytest
import yaml
from pathlib import Path
from pydantic import ValidationError
from engine.pipeline.config_schemas import PressSystemConfig, PintleEngineConfig


class TestPressSystemConfigModel:
    def test_defaults_are_correct(self):
        cfg = PressSystemConfig(reg_setpoint_psi=450.0, reg_initial_copv_psi=4500.0)
        assert cfg.reg_cv == pytest.approx(0.06)
        assert cfg.reg_droop_coeff == pytest.approx(0.070)
        assert cfg.line_cv_lox is None
        assert cfg.line_cv_fuel is None

    def test_line_cv_can_be_set(self):
        cfg = PressSystemConfig(reg_setpoint_psi=450.0, reg_initial_copv_psi=4500.0, line_cv_lox=0.04, line_cv_fuel=0.05)
        assert cfg.line_cv_lox == pytest.approx(0.04)
        assert cfg.line_cv_fuel == pytest.approx(0.05)

    def test_missing_reg_setpoint_raises(self):
        with pytest.raises(ValidationError):
            PressSystemConfig(reg_initial_copv_psi=4500.0)

    def test_missing_reg_initial_copv_raises(self):
        with pytest.raises(ValidationError):
            PressSystemConfig(reg_setpoint_psi=450.0)

    def test_negative_reg_cv_raises(self):
        with pytest.raises(ValidationError):
            PressSystemConfig(reg_cv=-0.01, reg_setpoint_psi=450.0, reg_initial_copv_psi=4500.0)

    def test_negative_line_cv_raises(self):
        with pytest.raises(ValidationError):
            PressSystemConfig(reg_setpoint_psi=450.0, reg_initial_copv_psi=4500.0, line_cv_lox=-0.01)


class TestDiabloConfigIntegration:
    def test_diablo_config_loads_with_press_system(self, diablo_config):
        assert diablo_config.press_system is not None
        assert diablo_config.press_system.reg_cv == pytest.approx(0.06)
        assert diablo_config.press_system.line_cv_lox is None
        assert diablo_config.press_system.line_cv_fuel is None

    def test_press_tank_still_has_free_volume_L(self, diablo_config):
        """Regression: free_volume_L must remain in press_tank."""
        assert diablo_config.press_tank is not None
        assert diablo_config.press_tank.free_volume_L is not None
        assert diablo_config.press_tank.free_volume_L > 0

    def test_backward_compat_without_press_system(self):
        """Configs missing press_system must load (press_system=None)."""
        p = Path(__file__).parent.parent / "configs" / "diablo_config.yaml"
        raw = yaml.safe_load(p.read_text())
        raw.pop("press_system", None)
        cfg = PintleEngineConfig(**raw)
        assert cfg.press_system is None
