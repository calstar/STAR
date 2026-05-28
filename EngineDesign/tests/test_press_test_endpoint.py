"""Integration tests for /api/experiment/press_test_fit and press_test_save_cv_line."""
import shutil
import tempfile
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from backend.main import app
from backend.state import app_state
from engine.pipeline.config_schemas import PintleEngineConfig

client = TestClient(app)

VALID_ROW = {
    "tank": "lox",
    "ullage_fraction": 1.0,
    "copv_p_start_psi": 4500.0, "copv_p_end_psi": 4490.0,
    "copv_t_start_s":   0.0,    "copv_t_end_s":   2.0,
    "tank_p_start_psi": 400.0,  "tank_p_end_psi": 405.0,
    "tank_t_start_s":   0.1,    "tank_t_end_s":   2.0,
}

BASE_PAYLOAD = {
    "rows": [VALID_ROW],
    "tank_volume_lox_m3": 0.00915,
    "tank_volume_fuel_m3": 0.00915,
    "copv_volume_L": 4.5,
    "T_copv_K": 300.0,
    "T_ull_K": 293.0,
    "reg_cv": 0.06,
    "reg_droop_coeff": 0.070,
    "reg_setpoint_psi": 450.0,
    "reg_initial_copv_psi": 4500.0,
}


class TestPressFeedFitEndpoint:
    def test_200_with_valid_payload(self):
        resp = client.post("/api/experiment/press_test_fit", json=BASE_PAYLOAD)
        assert resp.status_code == 200, resp.text

    def test_response_shape(self):
        resp = client.post("/api/experiment/press_test_fit", json=BASE_PAYLOAD)
        data = resp.json()
        for field in (
            "cv_line_lox_fitted",
            "cv_line_lox_std",
            "cv_line_fuel_fitted",
            "cv_line_fuel_std",
            "cv_reg",
            "cv_eff_lox",
            "cv_eff_fuel",
            "recommendation",
            "rows",
            "row_diagnostics",
            "save_available",
        ):
            assert field in data, f"Missing field: {field}"
        assert len(data["row_diagnostics"]) == 1
        assert data["row_diagnostics"][0]["status"] == "ok"
        assert data["row_diagnostics"][0]["row_index"] == 0

    def test_cv_line_positive(self):
        data = client.post("/api/experiment/press_test_fit", json=BASE_PAYLOAD).json()
        assert data["cv_line_lox_fitted"] > 0

    def test_cv_eff_less_than_reg_cv(self):
        data = client.post("/api/experiment/press_test_fit", json=BASE_PAYLOAD).json()
        # Series combination must be less than reg_cv
        assert data["cv_eff_lox"] < data["cv_reg"]

    def test_multiple_rows_returns_all_results(self):
        payload = {**BASE_PAYLOAD, "rows": [VALID_ROW, VALID_ROW, VALID_ROW]}
        data = client.post("/api/experiment/press_test_fit", json=payload).json()
        assert len(data["rows"]) == 3

    def test_missing_tank_volume_returns_422(self):
        bad = {k: v for k, v in BASE_PAYLOAD.items() if k != "tank_volume_lox_m3" and k != "tank_volume_fuel_m3"}
        resp = client.post("/api/experiment/press_test_fit", json=bad)
        assert resp.status_code == 422

    def test_missing_rows_returns_422(self):
        bad = {**BASE_PAYLOAD, "rows": []}
        resp = client.post("/api/experiment/press_test_fit", json=bad)
        assert resp.status_code == 422

    def test_row_result_fields_present(self):
        data = client.post("/api/experiment/press_test_fit", json=BASE_PAYLOAD).json()
        row = data["rows"][0]
        for f in (
            "row_index",
            "label",
            "cv_line_estimate",
            "mdot_copv_avg",
            "mdot_tank_avg",
            "cross_check_ratio",
            "copv_dp_psi",
            "tank_dp_psi",
        ):
            assert f in row, f"Row missing field: {f}"

    def test_skipped_row_has_diagnostic_message(self):
        bad = {
            **VALID_ROW,
            "copv_t_start_s": 2.0,
            "copv_t_end_s": 1.0,
        }
        payload = {**BASE_PAYLOAD, "rows": [bad]}
        resp = client.post("/api/experiment/press_test_fit", json=payload)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["rows"] == []
        assert data["cv_line_lox_fitted"] is None
        assert len(data["row_diagnostics"]) == 1
        d0 = data["row_diagnostics"][0]
        assert d0["status"] == "skipped"
        assert "COPV time window" in d0["message"]

    def test_mixed_rows_diagnostics_length(self):
        bad = {**VALID_ROW, "copv_t_start_s": 2.0, "copv_t_end_s": 1.0}
        payload = {**BASE_PAYLOAD, "rows": [bad, VALID_ROW]}
        data = client.post("/api/experiment/press_test_fit", json=payload).json()
        assert len(data["row_diagnostics"]) == 2
        assert data["row_diagnostics"][0]["status"] == "skipped"
        assert data["row_diagnostics"][1]["status"] == "ok"
        assert len(data["rows"]) == 1
        assert data["rows"][0]["row_index"] == 1

    def test_copv_dp_is_correct(self):
        data = client.post("/api/experiment/press_test_fit", json=BASE_PAYLOAD).json()
        row = data["rows"][0]
        # COPV drops from 4500 to 4490 = 10 psi
        assert row["copv_dp_psi"] == pytest.approx(10.0, abs=1.0)

    def test_tank_dp_is_correct(self):
        data = client.post("/api/experiment/press_test_fit", json=BASE_PAYLOAD).json()
        row = data["rows"][0]
        # Tank rises from 400 to 405 = 5 psi
        assert row["tank_dp_psi"] == pytest.approx(5.0, abs=1.0)


class TestPressFeedSaveEndpoint:
    def test_save_without_config_returns_400(self):
        # Ensure no config is loaded for this test
        prev_config, prev_path = app_state.config, app_state.config_path
        app_state.config = None
        app_state.config_path = None
        try:
            resp = client.post("/api/experiment/press_test_save_cv_line",
                               json={"cv_line_lox": 0.035})
            assert resp.status_code == 400
        finally:
            app_state.config = prev_config
            app_state.config_path = prev_path

    def test_save_negative_cv_returns_422(self):
        resp = client.post("/api/experiment/press_test_save_cv_line",
                           json={"cv_line_lox": -0.01})
        assert resp.status_code == 422

    def test_save_persists_to_disk(self, tmp_path):
        """Save endpoint must write the fitted Cv_line values to app_state.config_path.

        Regression: previously the endpoint only mutated in-memory state, so values
        were lost on backend restart or on 'Reload from Config (disk)'.
        """
        src = Path("configs/diablo_config.yaml")
        assert src.exists(), f"expected fixture config at {src}"
        tmp_cfg = tmp_path / "tmp_config.yaml"
        shutil.copy(src, tmp_cfg)

        data = yaml.safe_load(tmp_cfg.read_text())
        cfg = PintleEngineConfig(**data)

        prev_config, prev_path, prev_runner = app_state.config, app_state.config_path, app_state.runner
        app_state.set_config(cfg, str(tmp_cfg), defer_runner=True)
        try:
            resp = client.post(
                "/api/experiment/press_test_save_cv_line",
                json={"cv_line_lox": 0.0321, "cv_line_fuel": 0.0456},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["status"] == "saved"
            assert body["persisted_to_disk"] is True
            assert body["config_path"] == str(tmp_cfg)
            assert body["cv_line_lox"] == pytest.approx(0.0321)
            assert body["cv_line_fuel"] == pytest.approx(0.0456)

            # The values must actually be on disk — re-parse the YAML.
            reread = yaml.safe_load(tmp_cfg.read_text())
            assert reread["press_system"]["line_cv_lox"] == pytest.approx(0.0321)
            assert reread["press_system"]["line_cv_fuel"] == pytest.approx(0.0456)

            # Reloading from disk must reproduce the same values (round-trip through pydantic).
            reloaded = PintleEngineConfig(**reread)
            assert reloaded.press_system.line_cv_lox == pytest.approx(0.0321)
            assert reloaded.press_system.line_cv_fuel == pytest.approx(0.0456)
        finally:
            app_state.config = prev_config
            app_state.config_path = prev_path
            app_state.runner = prev_runner

    def test_save_only_lox_leaves_fuel_unchanged(self, tmp_path):
        src = Path("configs/diablo_config.yaml")
        tmp_cfg = tmp_path / "tmp_config.yaml"
        shutil.copy(src, tmp_cfg)
        data = yaml.safe_load(tmp_cfg.read_text())
        cfg = PintleEngineConfig(**data)

        prev_config, prev_path, prev_runner = app_state.config, app_state.config_path, app_state.runner
        app_state.set_config(cfg, str(tmp_cfg), defer_runner=True)
        # Seed both values so we can verify fuel survives a LOX-only save.
        app_state.config.press_system.line_cv_lox = 0.01
        app_state.config.press_system.line_cv_fuel = 0.99
        try:
            resp = client.post(
                "/api/experiment/press_test_save_cv_line",
                json={"cv_line_lox": 0.0222},
            )
            assert resp.status_code == 200, resp.text
            reread = yaml.safe_load(tmp_cfg.read_text())
            assert reread["press_system"]["line_cv_lox"] == pytest.approx(0.0222)
            assert reread["press_system"]["line_cv_fuel"] == pytest.approx(0.99)
        finally:
            app_state.config = prev_config
            app_state.config_path = prev_path
            app_state.runner = prev_runner
