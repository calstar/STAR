"""``layer1_random_seed`` must actually pin the hybrid search.

Measured before this test existed: three Layer 1 runs of configs/ethalox_6500N.yaml, all
with ``layer1_random_seed: 37``, returned three different injectors (included angle 89 / 87 /
83 deg, O/F 1.5023 / 1.5106 / 1.5144). The seed reached the 16-trial warm start and nothing
after it: ``run_hybrid_optimization`` built its own ``np.random.default_rng()`` with no seed
and called ``run_cma_core`` without ``seed=`` in Stage A, every block and every refresh, so
CMA seeded itself from the clock. The legacy CMA path passes ``_cma_restart_seed``; the hybrid
path -- the one every shipped config selects -- did not.

The objective here is deliberately a plain function, not the engine: what is under test is
that the SEARCH is a deterministic function of its seed, and nothing else.
"""
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.optimizer.layers.layer1_static_optimization import run_hybrid_optimization  # noqa: E402
from engine.pipeline.config_schemas import HybridOptimizerConfig  # noqa: E402


def _rosenbrock(x):
    return float(sum(100.0 * (x[1:] - x[:-1] ** 2.0) ** 2.0 + (1 - x[:-1]) ** 2.0))


def _run(seed, budget=600):
    dim = 5
    cfg = HybridOptimizerConfig(
        elite_k=20, block_method="corr_greedy", num_blocks=2, cycles=2,
        per_block_budget_fraction=0.5, refresh_every_pass=True,
        refresh_budget_fraction=0.1, refresh_sigma_scale=0.2,
    )
    best_x, best_f, evals = run_hybrid_optimization(
        _rosenbrock, [(-5.0, 5.0)] * dim, np.zeros(dim), cfg,
        total_budget=budget, logger=None, seed=seed,
    )
    return np.asarray(best_x, dtype=float), float(best_f), int(evals)


def test_same_seed_same_search():
    xa, fa, ea = _run(7)
    xb, fb, eb = _run(7)
    assert ea == eb, "same seed spent a different number of evaluations"
    assert fa == fb, f"same seed, different best f: {fa} vs {fb}"
    np.testing.assert_array_equal(xa, xb)


def test_different_seed_different_search():
    # A different seed must be allowed to land somewhere else; if it cannot, the seed is
    # not reaching the sampler at all and the previous test passed for the wrong reason.
    xa, fa, _ = _run(7)
    xb, fb, _ = _run(8)
    assert not (fa == fb and np.array_equal(xa, xb)), "seed had no effect on the search"


def test_unseeded_still_runs():
    # seed=None keeps the old behaviour (fresh entropy each run) and must not raise.
    x, f, e = _run(None, budget=300)
    assert np.isfinite(f) and e > 0
