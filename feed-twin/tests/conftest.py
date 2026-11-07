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
from collections.abc import Iterator
from pathlib import Path

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
    "test_the_study_and_the_console_end_a_burn_in_the_same_place",
    "test_a_small_ullage_press_lands_on_lockup_not_past_it",
}


# Tests that assert wall-clock time. Across xdist workers on a small CI runner the
# other workers' load lands in their numbers (a 0.21 s median tick read 0.26 s),
# so CI and `scripts/check.sh full` run them on their own, as lib's timing gate.
TIMING_TESTS = {
    "test_a_tick_is_fast_enough_to_feel_live",
}


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    for item in items:
        name = item.name.split("[")[0]
        if item.path.name in SLOW_MODULES or name in SLOW_TESTS:
            item.add_marker(pytest.mark.slow)
        if name in TIMING_TESTS:
            item.add_marker(pytest.mark.timing)


# ------------------------------------------------------- the shipped drawings
@pytest.fixture(autouse=True)
def _shipped_drawings_stay() -> None:
    """Every test starts with the shipped drawings in its library.

    The library is content-addressed, so a test that uploads a shipped file
    (``backend/diagrams/ethalox_stand.json``) gets the seeded artifact back,
    and removing "its" upload afterwards removes the seed -- for every later
    test in that worker. test_study's ``stand`` fixture did, and
    test_overrides' ``stand_id()`` then found no Ethalox Stand whenever the
    two shared a worker (2026-10-09). Seeding again is idempotent; it runs
    only when one is missing.
    """
    from backend import main

    have = {a.source for a in main.library.list("diagram")}
    if any(f"shipped:{p.name}" not in have for p in main.SEEDS.glob("*.json")):
        main._seed(revive=True)


# ------------------------------------------------------- a full server
@pytest.fixture(autouse=True)
def _no_console_watches(monkeypatch: pytest.MonkeyPatch) -> None:
    """A test's stands are not consoles being watched.

    A full server refuses a new stand rather than close one touched in the
    last ``_WATCHED_S`` (a console ticking it). One worker opens far more than
    twelve stands a minute, and none is anyone's console, so here the
    idlest is closed as it always was; the test of the refusal sets the
    window itself."""
    from backend import main

    monkeypatch.setattr(main, "_WATCHED_S", 0.0)


# ------------------------------------------------------- one test's server
#: What the library keeps for a drawing's *lineage* rather than for an
#: artifact: the operator's overrides and the saved hookups. An upload of a
#: shipped file is the shipped artifact (content-addressed), so every test
#: that uploads ``ethalox_stand.json`` shares one lineage, and whatever one
#: of them leaves there wires the next one's stand.
_LINEAGE_STATE = ("overrides.json", "hookups")


def _lineage_state(root: Path) -> dict[str, bytes]:
    held: dict[str, bytes] = {}
    for name in _LINEAGE_STATE:
        path = root / name
        found = [path] if path.is_file() else sorted(path.glob("*.json"))
        for file in found:
            held[str(file.relative_to(root))] = file.read_bytes()
    return held


@pytest.fixture(autouse=True)
def _a_test_leaves_the_server_as_it_found_it() -> Iterator[None]:
    """Every test starts on the server the one before it started on.

    A worker runs whatever tests xdist hands it, in no fixed order, on one
    ``backend.main``: the stands a test opened stayed open, a study it started
    went on burning in its thread, and a test that cleaned up only in the
    *next* test of its own file (test_overrides' ``setup_function``) left its
    overrides for whichever test came next. Twelve stands later the server
    is full and the next open closes the oldest -- a burn still going in an
    earlier test's stand, recorded into this test's runs as cut short
    (test_run_endings failed on it in a fixed order). So: studies and
    attributions started here are stopped, stands opened here are dropped
    unrecorded, and the lineage records are put back as they were.
    """
    from backend import main

    root = Path(main.library.root)
    opened = set(main._SESSIONS)
    kept = _lineage_state(root)
    yield
    for runner in list(main._STUDIES.values()):
        runner.cancel()
        runner.wait(60.0)
    for explainer in list(main._EXPLAIN.values()):
        explainer.cancel()
        thread = explainer._thread
        if thread is not None:
            thread.join(60.0)
    for sid in set(main._SESSIONS) - opened:
        main._SESSIONS.pop(sid, None)
        main._OPENED.pop(sid, None)
        main._TOUCHED.pop(sid, None)
    now = _lineage_state(root)
    for name in set(now) - set(kept):
        (root / name).unlink(missing_ok=True)
    for name, data in kept.items():
        if now.get(name) != data:
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            (root / name).write_bytes(data)
