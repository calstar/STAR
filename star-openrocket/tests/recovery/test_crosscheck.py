"""The three-way comparison. PLAN.md §2.

The individual ports are validated in `test_openrocket.py` and
`test_mastersheet.py`; this file is about the *alignment* -- that the three
models are being asked the same question, and that a model which cannot answer
one reports an absence rather than a zero.

That last point carries the most weight here. OpenRocket computes no opening
load at all, and a `None` rendered as `0` would put "0 N" in a load column next
to our 1613 N, which reads as OpenRocket predicting no load rather than
OpenRocket having no opinion.
"""

import json
import os
import subprocess
import sys

import pytest

from physics.crosscheck import MODELS, crosscheck, run_mastersheet
from physics.openrocket import simulate
from physics.report import render_crosscheck
from physics.schema import Config

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


@pytest.fixture
def config():
    with open(os.path.join(FIXTURES, "worked_example.json"), encoding="utf-8") as fh:
        return Config.model_validate(json.load(fh))


def test_every_metric_reports_all_three_models(config):
    """A model is either a number or an explicit None -- never missing."""
    c = crosscheck(config)
    assert c.metrics
    for m in c.metrics:
        assert set(m.values) == set(MODELS), m.key
        for model, value in m.values.items():
            assert value is None or isinstance(value, float), (m.key, model)


def test_absences_are_none_and_carry_a_reason(config):
    """The three quantities a model genuinely cannot produce.

    Each is an absence with a cause, not a small number, and each carries a
    note so the UI has something to render in place of a value.
    """
    c = crosscheck(config)
    by_key = {m.key: m for m in c.metrics}

    # OpenRocket has no opening-load calculation anywhere (§2 defect 2).
    assert by_key["F_peak"].values["openrocket"] is None
    assert "no opening load" in by_key["F_peak"].note

    # The mastersheet assumes terminal velocity, so it has no acceleration.
    assert by_key["peak_decel"].values["mastersheet"] is None
    assert by_key["peak_decel"].note

    # Only the mastersheet models wind.
    drift = by_key["drift"]
    assert drift.values["ours"] is None
    assert drift.values["openrocket"] is None
    assert drift.values["mastersheet"] is not None
    assert drift.note


def test_spread_ignores_models_that_did_not_answer(config):
    """`spread` is over the models that produced a number.

    If it counted a None as zero, every row with an absence would report an
    infinite spread and the genuinely divergent rows would be invisible.
    """
    c = crosscheck(config, wind_ms=9.8)
    by_key = {m.key: m for m in c.metrics}

    # Two answers out of three still gives a spread.
    assert by_key["F_peak"].spread is not None
    assert by_key["F_peak"].spread == pytest.approx(
        max(by_key["F_peak"].values["ours"],
            by_key["F_peak"].values["mastersheet"])
        / min(by_key["F_peak"].values["ours"],
              by_key["F_peak"].values["mastersheet"]))

    # One answer gives none at all.
    assert by_key["drift"].spread is None


def test_the_three_agree_on_the_things_they_all_model(config):
    """Descent time, impact speed and energy are within a few percent.

    This is the sanity floor: three independent models of the same descent
    should not disagree by a factor. If this test ever fails, one of the ports
    has broken rather than the models genuinely differing.
    """
    c = crosscheck(config)
    for key in ("descent_time", "impact_velocity", "impact_ke"):
        metric = next(m for m in c.metrics if m.key == key)
        assert metric.spread < 1.10, key


def test_openrocket_overstates_peak_deceleration_fourfold(config):
    """§2 defect 1, as the number the whole tab exists to produce.

    Opening a canopy to full area between two integration points produces a
    deceleration spike four times our finite-inflation value. It is an
    artefact of the step function, not a load prediction -- which is exactly
    why OpenRocket not computing a load from it is a mercy.
    """
    c = crosscheck(config)
    peak = next(m for m in c.metrics if m.key == "peak_decel")
    assert peak.values["openrocket"] / peak.values["ours"] == pytest.approx(
        4.11, abs=0.15)


def test_our_load_and_the_mastersheets_agree_within_a_few_percent(config):
    """Both compute the infinite-mass bound, so they SHOULD agree closely.

    They differ only through the deployment velocity -- ours integrated to line
    stretch, the sheet's assumed terminal under the drogue -- and through the
    atmosphere. Agreement to a few percent is evidence both are implementing
    eq (23) rather than a tautology: the two arrive at v_s by completely
    different routes.
    """
    c = crosscheck(config)
    load = next(m for m in c.metrics if m.key == "F_peak")
    ratio = load.values["mastersheet"] / load.values["ours"]
    assert ratio == pytest.approx(1.03, abs=0.05)


def test_mastersheet_phases_follow_openrocket_deployment_order(config):
    """The sheet's inputs come from OpenRocket, so ours do too.

    Its author pasted a velocity and an altitude out of OpenRocket into the
    yellow cells; `run_mastersheet` reads them off the OpenRocket trajectory
    instead of inventing them. The phases must therefore be in deployment
    order and chain end-to-start.
    """
    or_run = simulate(config)
    sheet = run_mastersheet(config, or_run)

    assert [p.name for p in sheet.phases] == ["drogue", "main"]
    assert sheet.phases[0].z_end == pytest.approx(sheet.phases[1].z_deploy)
    assert sheet.phases[-1].z_end == pytest.approx(0.0)
    # The drogue's altitude comes off the OpenRocket trajectory, since a TIME
    # trigger has no altitude of its own.
    assert 880.0 < sheet.phases[0].z_deploy < 914.0

    # The main's is NOT its configured 152 m: it is ~145 m, where OpenRocket
    # actually opened it after overshooting by one 0.5 s step. That inherited
    # lateness is correct and is the point -- a mastersheet fed from OpenRocket
    # inherits OpenRocket's deployment error along with its velocities, which
    # is exactly what happened to the real sheets.
    assert sheet.phases[1].z_deploy == pytest.approx(144.9, abs=0.5)
    assert sheet.phases[1].z_deploy < 152.0


def test_a_config_where_nothing_deploys_is_a_clear_error(config):
    """`run_mastersheet` has no phases to build, and says so."""
    cfg = config.model_copy(deep=True)
    cfg.vehicle.h_a = 20.0
    for d in cfg.devices:
        d.trigger.value = 10000.0 if d.trigger.kind.value == "TIME" else 5.0
    or_run = simulate(cfg)
    if not any(c.deployed for c in or_run.canopies):
        with pytest.raises(ValueError, match="no device deploys"):
            run_mastersheet(cfg, or_run)


def test_render_marks_absences_and_never_prints_a_zero(config):
    """The text report must not put `0.000` where a model has no opinion."""
    text = render_crosscheck(crosscheck(config, wind_ms=9.8))
    assert "CROSS-CHECK" in text
    assert "Peak opening load" in text
    # The OpenRocket load cell is a dash with a footnote, not a number.
    line = next(ln for ln in text.splitlines() if "Peak opening load" in ln)
    assert "--" in line
    assert "0.000" not in line
    assert "no opening load" in text


def test_cli_crosscheck_runs(config):
    """§11.2 keeps the CLI an invariant, so the new flag joins it."""
    proc = subprocess.run(
        [sys.executable, "-m", "physics",
         os.path.join(FIXTURES, "worked_example.json"),
         "--which", "axial", "--crosscheck", "--wind", "9.8"],
        cwd=ROOT, capture_output=True, text=True, timeout=300,
    )
    assert proc.returncode == 0, proc.stderr
    assert "CROSS-CHECK" in proc.stdout
    assert "OpenRocket" in proc.stdout
    assert "mastersheet" in proc.stdout


def test_cli_crosscheck_json_is_a_sibling_key(config):
    """It must not land inside `payload`, which is indexed by airframe bound."""
    proc = subprocess.run(
        [sys.executable, "-m", "physics",
         os.path.join(FIXTURES, "worked_example.json"),
         "--which", "axial", "--crosscheck", "--json"],
        cwd=ROOT, capture_output=True, text=True, timeout=300,
    )
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert "axial" in payload
    assert "crosscheck" in payload
    keys = {m["key"] for m in payload["crosscheck"]["metrics"]}
    assert {"descent_time", "F_peak", "peak_decel", "drift"} <= keys
    load = next(m for m in payload["crosscheck"]["metrics"]
                if m["key"] == "F_peak")
    assert load["values"]["openrocket"] is None
