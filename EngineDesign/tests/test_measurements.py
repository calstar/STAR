"""Measured values in place of assumptions (engine/pipeline/measurements.py).

Opt-in: no measurements, the config is used exactly as given. Each measurement reaches the physics
where the assumed number entered, and forward mode marks the input measured (◇ -> ●)."""
import copy

import pytest

PSI = 6894.757
CFG = "tests/fixtures/ethalox_6500N_doublet_cad_2026-09-28.yaml"


def _cfg():
    from engine.pipeline.io import load_config
    return load_config(CFG)


def _mv(v):
    from engine.pipeline.config_schemas import MeasuredValue
    return MeasuredValue(value=v, source="test rig")


def _solve(cfg):
    from engine.core.runner import PintleEngineRunner
    P = cfg.lox_tank.initial_pressure_psi * PSI
    return PintleEngineRunner(copy.deepcopy(cfg)).evaluate(P, P, silent=True, rich_stability=True)


def test_no_measurements_changes_nothing():
    from engine.pipeline.measurements import apply_measurements
    cfg = _cfg()
    assert apply_measurements(cfg) is cfg


@pytest.fixture(scope="module")
def pair():
    from engine.pipeline.config_schemas import MeasurementsConfig
    base = _cfg()
    m = copy.deepcopy(base)
    m.measurements = MeasurementsConfig(cd_O=_mv(0.72), cd_F=_mv(0.70), em=_mv(0.85),
                                        d32_O_um=_mv(80.0), d32_F_um=_mv(120.0), chug_frequency_hz=_mv(31.0))
    return _solve(base), _solve(m), m


def test_each_measurement_reaches_the_physics(pair):
    r0, r1, _ = pair
    assert r1["Cd_O"] == pytest.approx(0.72, abs=1e-9) and r1["Cd_F"] == pytest.approx(0.70, abs=1e-9)
    assert r1["diagnostics"]["cstar_efficiency"]["rupe_Em"] == pytest.approx(0.85, abs=1e-9)
    assert r1["diagnostics"]["D32_O"] == pytest.approx(80e-6) and r1["diagnostics"]["D32_F"] == pytest.approx(120e-6)
    # the stability model reads the same sprays
    assert r1["stability_rich"]["vaporization"]["streams"][1]["smd_um"] == pytest.approx(120.0)
    assert r1["F"] != pytest.approx(r0["F"], rel=1e-3)


def test_forward_mode_marks_them_measured(pair):
    from engine.pipeline.forward_report import forward_report
    _, r1, m = pair
    rep = forward_report(m, r1)
    cal = rep["calibration"]
    assert cal["cd"]["state"] == "measured" and cal["em"]["state"] == "measured" and cal["smd"]["state"] == "measured"
    assert cal["nozzle"]["state"] == "assumed"
    st = next(s for s in rep["sections"] if s["key"] == "stability")
    assert next(q for q in st["quantities"] if q["key"] == "chug_f_measured")["value"] == 31.0


def test_half_a_pair_is_partial():
    from engine.pipeline.config_schemas import MeasurementsConfig
    from engine.pipeline.measurements import calibration_state
    c = _cfg()
    c.measurements = MeasurementsConfig(cd_O=_mv(0.7))
    assert calibration_state(c)["cd"]["state"] == "partial"


def test_a_measurement_without_a_source_is_refused():
    from pydantic import ValidationError
    from engine.pipeline.config_schemas import MeasuredValue
    with pytest.raises(ValidationError):
        MeasuredValue(value=0.7, source="")
