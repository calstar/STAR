"""A library of its own, per test session.

``backend.main`` builds its :class:`~backend.library.Library` at import time
from ``FEEDTWIN_LIBRARY``, so this has to be set before that import happens --
which is what a root ``conftest.py`` is for. Without it the suite runs against
the shipped store and every listing assertion depends on what somebody last
imported by hand.

The shipped drawings still seed into it, because seeding is content-addressed
and reads from the package rather than the store.
"""

from __future__ import annotations

import os
import tempfile

_STORE = tempfile.mkdtemp(prefix="feedtwin-tests-")
os.environ["FEEDTWIN_LIBRARY"] = _STORE
# Stands and runs: per-user documents, never in the developer's own .userdata.
# Tests that check sharing point it at their own tmp_path on top of this.
os.environ["USERDATA_DIR"] = tempfile.mkdtemp(prefix="feedtwin-userdata-")

# Importing an engine asks EngineDesign for its engine card. The suite never
# talks to a real EngineDesign -- a developer's dev server on 8000 would make
# every engine import a 15 s card build and the results depend on whatever
# design it has loaded. Nothing listens on the discard port, so the ask fails
# at once and the engine comes in on the simplified model, as it always did;
# tests that want a card stub the transport (test_engine_card_api.py).
os.environ["ENGINE_DESIGN_URL"] = "http://127.0.0.1:9"


# ------------------------------------------------------------------ test tiers
#
# The suite integrates a stand and takes ~11 minutes. The fast tier
# (`scripts/check.sh`, `pytest -m "not slow"`) leaves out what takes longest; CI
# and `scripts/check.sh full` run everything. Measured 2026-10-06 with
# `--durations`: everything here took over ~8 s on a developer's machine, and
# together they were ~90 % of the suite's time. Re-measure before adding to it.
import pytest  # noqa: E402

SLOW_MODULES = {
    "test_operator_walks.py",
    "test_walkthrough.py",
    "test_walls.py",
}
SLOW_TESTS = {
    "test_walking_the_state_machine_at_random_stays_sane",
    "test_an_insulated_shut_lox_tank_climbs_slower_than_a_bare_one",
    "test_the_dome_setting_decides_where_a_tank_lands",
    "test_a_shut_lox_tank_climbs_and_the_panel_says_why",
    "test_firing_burns_propellant_at_a_sensible_mixture_ratio",
    "test_venting_puts_a_pressed_tank_back_to_atmosphere",
    "test_joule_thomson_falls_out_of_enthalpy_conservation",
    "test_firing_droops_the_tanks_and_the_bottle",
    "test_pressing_one_tank_leaves_the_other_at_atmosphere",
    "test_a_pressed_tank_holds_when_the_valve_shuts",
    "test_every_thermal_model_on_settles_at_lockup",
    "test_a_tick_is_fast_enough_to_feel_live",
    "test_a_small_ullage_press_lands_on_lockup_not_past_it",
}


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    for item in items:
        if item.path.name in SLOW_MODULES or item.name.split("[")[0] in SLOW_TESTS:
            item.add_marker(pytest.mark.slow)
