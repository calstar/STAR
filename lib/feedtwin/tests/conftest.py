"""Test tiers for the physics core.

The fast tier (`scripts/check.sh`, `pytest -m "not slow"`) leaves out the tests
that integrate a whole burn; CI runs everything. Measured 2026-10-06 with
`--durations`: each of these took over ~3.5 s. Re-measure before adding to it.
"""

from __future__ import annotations

import pytest

SLOW_TESTS = {
    "test_chamber_pressure_moves_less_than_tank_pressure",
    "test_a_layer1_engine_fires_on_a_real_feed_system",
    "test_mixture_ratio_drifts_over_a_burn",
    "test_a_chilling_tank_climbs_and_climbs_more_the_harder_the_dewar_pushes",
    "test_radau_agrees_with_bdf",
    "test_expulsion_matches_closed_form",
    "test_the_ox_lead_shows_up_in_the_trace",
    "test_expulsion_deviation_is_the_compressibility",
}


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    for item in items:
        if item.name.split("[")[0] in SLOW_TESTS:
            item.add_marker(pytest.mark.slow)
