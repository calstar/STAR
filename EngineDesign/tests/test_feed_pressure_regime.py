"""Layer-2 feed-pressure regime selection (Phase 2 dispatch skeleton).

The regime decides how Layer 2 treats tank pressure:
  blowdown       -- passive ullage expansion; P(t) is a consequence, not a free variable
  dome_regulated -- regulator holds Layer 1's pressure as a setpoint, with EOB droop
  active         -- legacy free-form segmented curve (needs closed-loop pressure control)

Critical behaviour under test: an undeclared/unrecognised regime must resolve to ``active`` so
configs that never declared one keep the free-curve search they have today, rather than silently
being routed into a different physical model.
"""

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.optimizer.feed_pressure_model import (  # noqa: E402
    VALID_FEED_PRESSURE_MODELS,
    get_feed_pressure_model,
)


def _cfg(model):
    return SimpleNamespace(design_requirements=SimpleNamespace(feed_pressure_model=model))


@pytest.mark.parametrize("regime", VALID_FEED_PRESSURE_MODELS)
def test_valid_regimes_round_trip(regime):
    assert get_feed_pressure_model(_cfg(regime)) == regime


@pytest.mark.parametrize(
    "raw,expected",
    [("  BLOWDOWN ", "blowdown"), ("Dome_Regulated", "dome_regulated"), ("ACTIVE", "active")],
)
def test_regime_is_normalised(raw, expected):
    assert get_feed_pressure_model(_cfg(raw)) == expected


@pytest.mark.parametrize(
    "cfg",
    [
        SimpleNamespace(design_requirements=None),
        SimpleNamespace(),
        SimpleNamespace(design_requirements=SimpleNamespace(feed_pressure_model=None)),
        SimpleNamespace(design_requirements=SimpleNamespace(feed_pressure_model="turbopump")),
    ],
    ids=["dr_is_none", "no_dr_attr", "field_is_none", "unrecognised_value"],
)
def test_unknown_or_missing_falls_back_to_active(cfg):
    """Behaviour preservation: an undeclared regime keeps the legacy free-curve search."""
    assert get_feed_pressure_model(cfg) == "active", (
        "An undeclared or unrecognised feed_pressure_model must resolve to 'active' (the legacy "
        "segment search). Resolving to 'blowdown' would silently route such configs into the "
        "physical blowdown model and change their results."
    )


def test_schema_rejects_unknown_regime():
    """The field is a validated 3-value enum, so the GUI can render it and typos fail loudly."""
    from pydantic import ValidationError

    from engine.pipeline.config_schemas import DesignRequirementsConfig

    DesignRequirementsConfig(feed_pressure_model="active")  # valid value constructs fine

    with pytest.raises(ValidationError) as exc:
        DesignRequirementsConfig(feed_pressure_model="turbopump")
    assert "feed_pressure_model" in str(exc.value)


def test_canonical_config_resolves_to_dome_regulated():
    import os

    from engine.pipeline.io import load_config

    cwd = os.getcwd()
    os.chdir(ROOT)
    try:
        cfg = load_config(str(ROOT / "configs" / "canonical" / "impinging.yaml"))
    finally:
        os.chdir(cwd)
    assert get_feed_pressure_model(cfg) == "dome_regulated"
