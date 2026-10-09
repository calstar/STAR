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
    """Run the search and return what it *did*: every point it evaluated, in order.

    The first version of this test compared the final best point of two seeds, and that
    is a coin flip: at a 600-evaluation budget the search often never improves on the
    start at all -- seed 7 returns the start point on every machine tried, seed 8 finds
    something marginally better here and nothing at all on the CI runner -- so "the two
    seeds landed in different places" passed or failed on luck. Whether the seed reaches
    the sampler is visible in the *sequence of candidates*, which differs between seeds
    on the very first iteration and is identical between equal seeds, whatever the
    search then makes of them.
    """
    dim = 5
    seen = []

    def objective(x):
        seen.append(np.array(x, dtype=float).round(12))
        return _rosenbrock(np.asarray(x, dtype=float))

    cfg = HybridOptimizerConfig(
        elite_k=20, block_method="corr_greedy", num_blocks=2, cycles=2,
        per_block_budget_fraction=0.5, refresh_every_pass=True,
        refresh_budget_fraction=0.1, refresh_sigma_scale=0.2,
    )
    best_x, best_f, evals = run_hybrid_optimization(
        objective, [(-5.0, 5.0)] * dim, np.zeros(dim), cfg,
        total_budget=budget, logger=None, seed=seed,
    )
    return np.array(seen), np.asarray(best_x, dtype=float), float(best_f), int(evals)


def test_same_seed_same_search():
    sa, xa, fa, ea = _run(7)
    sb, xb, fb, eb = _run(7)
    assert ea == eb, "same seed spent a different number of evaluations"
    assert sa.shape == sb.shape, "same seed evaluated a different number of points"
    np.testing.assert_array_equal(sa, sb, err_msg="same seed, different candidates")
    assert fa == fb
    np.testing.assert_array_equal(xa, xb)


def test_different_seed_different_search():
    # A different seed must sample different candidates; if it does not, the seed is not
    # reaching the sampler at all and the previous test passed for the wrong reason.
    # Judged on the candidates, not on where the search ended up -- see `_run`.
    sa, _, _, ea = _run(7)
    sb, _, _, eb = _run(8)
    assert ea > 0 and eb > 0, f"the search spent no evaluations (evals {ea}, {eb})"
    n = min(len(sa), len(sb))
    # The start point is evaluated first under both seeds; everything after it is sampled.
    assert not np.array_equal(sa[1:n], sb[1:n]), "seed had no effect on the candidates sampled"


def test_unseeded_still_runs():
    # seed=None keeps the old behaviour (fresh entropy each run) and must not raise.
    _, x, f, e = _run(None, budget=300)
    assert np.isfinite(f) and e > 0
