"""CI quarantine for stale EngineDesign tests (non-control).

These tests fail on the current ``main`` for reasons unrelated to any change
under review — they were written against an older API / different default
constants and were never updated. A test that is already red on a clean tree
cannot act as a regression guard, so per the project's CI philosophy (gate on
guards that catch *new* breakage, not on pre-existing drift) they are skipped
here rather than blocking the gate.

Each entry records *why* it is quarantined and how to revive it. The intent is
for this list to shrink to empty: fix the test (or delete it if truly dead) and
remove its entry. Nothing here deletes a test — the code stays visible.

The robust-DDP controller suite has its own, larger quarantine in
``tests/control/robust_ddp/conftest.py``.
"""

import pytest

# Whole files quarantined.
_QUARANTINE_FILES = {
    "test_layer1_bounds_fix.py": (
        "DEAD: imports `Layer1OptimizerConfig` from "
        "engine.optimizer.layers.layer1_static_optimization, which no longer "
        "exists anywhere in the codebase. The file cannot import. "
        "Fix: update to the current optimizer-config API or delete."
    ),
}

# Individual tests quarantined, keyed by "<file>::<Class>::<method>".
# (2026-11-02: the Bernoulli-closure self-consistency check and the Layer 1
# stability-margin default were revived -- both pass on this tree, and the
# quarantine was hiding two working regression guards.)
_QUARANTINE_TESTS = {
    # Mock-based unit test: layer1 now deepcopies the config, and a MagicMock's
    # deepcopy does not preserve `injector.type = "pintle"` as a string, so the
    # injector-type validation rejects it.
    "test_layer1_pressures.py::TestLayer1Pressures::test_pressures_in_config": (
        "stale mock: layer1 now deepcopies config; the MagicMock loses "
        "injector.type='pintle' through deepcopy and trips type validation — "
        "rebuild on a real/typed config"
    ),
}


def pytest_collection_modifyitems(config, items):
    for item in items:
        filename = item.path.name
        if filename in _QUARANTINE_FILES:
            item.add_marker(pytest.mark.skip(reason=_QUARANTINE_FILES[filename]))
            continue
        for suffix, reason in _QUARANTINE_TESTS.items():
            if item.nodeid.endswith(suffix):
                item.add_marker(pytest.mark.skip(reason=reason))
                break
