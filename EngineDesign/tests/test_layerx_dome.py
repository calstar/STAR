"""The dome dial is an input (2026-10-07): the drawing's by default, the rail's when set, solved for a
tank pressure when that is what the rail gives. Every pressure on the rail is absolute.

On the helium study drawing the dial is PR-CTRL's 500 psig setpoint (a dome loader on PR-DOME), so the
default lockup is what that dial gives, not the config's 578 psia design tank pressure.
"""

from __future__ import annotations

import copy
from pathlib import Path

import pytest

pytest.importorskip("feedtwin", reason="lib/feedtwin is not installed")

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "configs" / "ethalox_6800N.yaml"
ATM_PSIA = 101325.0 / 6894.757293168361


@pytest.fixture(scope="module")
def setup():
    from engine.layerx import DrawingStore
    from engine.pipeline.io import load_config

    drawing = next(d for d in DrawingStore(None).list() if d.name == "copv_study_he")
    return load_config(str(CONFIG)), drawing


def _prep(setup, **settings):
    from engine.core.runner import PintleEngineRunner
    from engine.layerx import LayerXSettings, prepare

    config, drawing = setup
    cfg = copy.deepcopy(config)
    return prepare(cfg, PintleEngineRunner(cfg), drawing, LayerXSettings(drawing_id=drawing.id, **settings), [])


def test_by_default_the_dial_is_the_drawings(setup):
    p = _prep(setup)
    d = p.derived
    assert p.ok
    assert d["dome_source"] == "as drawn"
    assert d["dome_regulator_label"] == "PR-CTRL"
    assert d["dome_psia"] == pytest.approx(500.0 + ATM_PSIA, abs=1e-6)
    assert d["dome_psia"] == pytest.approx(d["dome_drawn_psia"], abs=1e-9)
    # Not the config's 578 psia: the drawing's dial sets the tanks.
    assert d["target_lockup_psia"] < 575.0


def test_a_dome_on_the_rail_sets_the_lockup(setup):
    base = _prep(setup).derived
    up = _prep(setup, dome_psia=base["dome_psia"] + 20.0).derived
    assert up["dome_source"] == "set on the rail"
    assert up["target_lockup_psia"] == pytest.approx(base["target_lockup_psia"] + 20.0, abs=1.0)


def test_a_tank_pressure_on_the_rail_solves_the_dome(setup):
    d = _prep(setup, tank_pressure_psia=578.0).derived
    assert d["dome_source"] == "solved for the rail's tank pressure"
    assert d["target_lockup_psia"] == pytest.approx(578.0, abs=1e-9)
    back = _prep(setup, dome_psia=d["dome_psia"]).derived
    assert back["target_lockup_psia"] == pytest.approx(578.0, abs=0.01)


def test_the_bottle_in_psia_is_the_bottle_in_psig(setup):
    a = _prep(setup, copv_pressure_psia=4000.0 + ATM_PSIA).derived
    b = _prep(setup, copv_pressure_psig=4000.0).derived
    assert a["copv_psia"] == pytest.approx(b["copv_psia"], abs=1e-9)
    assert a["copv_psia"] == pytest.approx(4000.0 + ATM_PSIA, abs=1e-9)


def test_naming_a_regulator_the_drawing_does_not_have_refuses_the_run(setup):
    p = _prep(setup, dome_regulator="nope")
    assert not p.ok
    assert [c.key for c in p.checks if c.status == "fail"] == ["dome_regulator"]


def test_naming_the_default_regulator_changes_nothing(setup):
    auto = _prep(setup).derived
    named = _prep(setup, dome_regulator=auto["dome_regulator"]).derived
    assert named["target_lockup_psia"] == pytest.approx(auto["target_lockup_psia"], abs=1e-6)
