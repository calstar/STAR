"""Layer 1 refuses a target O/F outside the propellant's CEA table instead of optimizing garbage."""

import pytest

from engine.optimizer.layers.layer1_static_optimization import _layer1_check_of_target_in_cea_range
from engine.pipeline.config_switch import load_canonical_config, apply_propellant
from engine.pipeline.config_schemas import PintleEngineConfig


def _ethalox_pintle():
    return PintleEngineConfig(**load_canonical_config("pintle"))   # ethalox, MR_range [1.0, 2.5]


def test_in_range_target_passes():
    cfg = _ethalox_pintle()
    lo, hi = cfg.combustion.cea.MR_range
    _layer1_check_of_target_in_cea_range(cfg, 0.5 * (lo + hi))
    _layer1_check_of_target_in_cea_range(cfg, lo)
    _layer1_check_of_target_in_cea_range(cfg, hi)


def test_out_of_range_target_is_refused_with_the_fix_in_the_message():
    cfg = _ethalox_pintle()
    with pytest.raises(ValueError, match=r"outside the CEA table for ethalox .*\[1\.00, 2\.50\]"):
        _layer1_check_of_target_in_cea_range(cfg, 3.5)


def test_stale_target_after_propellant_switch_is_caught():
    """The ethalox canonical carries optimal_of_ratio 1.4; overlay methalox (table 2.4-4.2) and the
    untouched target must be refused, not silently pinned at the table edge."""
    switched = PintleEngineConfig(**apply_propellant(load_canonical_config("pintle"), "methalox"))
    with pytest.raises(ValueError, match="outside the CEA table for methalox"):
        _layer1_check_of_target_in_cea_range(switched, switched.design_requirements.optimal_of_ratio)


def test_missing_table_range_does_not_block():
    cfg = _ethalox_pintle()
    cfg.combustion.cea.MR_range = None
    _layer1_check_of_target_in_cea_range(cfg, 99.0)
