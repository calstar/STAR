"""The design-point stamp records what the optimized geometry ACHIEVES, not the seed values.

Layer 1 optimizes geometry but does not touch chamber_geometry.design_*, so after a regeneration the
stamp would still show seed values (7000 N while the geometry makes 8000 N) -- a lying provenance
record. stamp_achieved_design_point fixes that at regen time without touching Layer 1's logic.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.optimizer.helpers import (  # noqa: E402
    stamp_achieved_design_point,
    stamp_achieved_design_point_from_results,
)
from engine.pipeline.io import load_config  # noqa: E402


def _canonical():
    return load_config(str(ROOT / "configs" / "canonical" / "impinging.yaml"))


def test_stamps_achieved_values():
    cfg = _canonical()
    assert cfg.chamber_geometry.design_thrust == 7000.0   # seed
    stamp_achieved_design_point(cfg, thrust_n=8020.0, mr=2.772, pc_pa=2.5e6)
    assert cfg.chamber_geometry.design_thrust == pytest.approx(8020.0)
    assert cfg.chamber_geometry.design_MR == pytest.approx(2.772)
    assert cfg.chamber_geometry.design_pressure == pytest.approx(2.5e6)


def test_skips_non_finite_and_nonpositive():
    cfg = _canonical()
    before = (cfg.chamber_geometry.design_thrust, cfg.chamber_geometry.design_MR,
              cfg.chamber_geometry.design_pressure)
    stamp_achieved_design_point(cfg, thrust_n=float("nan"), mr=-1.0, pc_pa=0.0)
    after = (cfg.chamber_geometry.design_thrust, cfg.chamber_geometry.design_MR,
             cfg.chamber_geometry.design_pressure)
    assert before == after   # garbage never overwrites a good stamp


def test_from_results_reads_performance_block():
    cfg = _canonical()
    stamped = stamp_achieved_design_point_from_results(
        cfg, {"performance": {"F": 8000.0, "MR": 2.8, "Pc": 2.4e6}}
    )
    assert stamped == (8000.0, 2.8, 2.4e6)
    assert cfg.chamber_geometry.design_thrust == pytest.approx(8000.0)


def test_from_results_missing_performance_is_noop():
    cfg = _canonical()
    before = cfg.chamber_geometry.design_thrust
    assert stamp_achieved_design_point_from_results(cfg, {}) is None
    assert cfg.chamber_geometry.design_thrust == before
