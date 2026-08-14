"""pytest configuration for the recovery calculator.

Follows the repo's quarantine convention (EngineDesign/tests/conftest.py):
gate on guards that catch *new* breakage, not on pre-existing drift. Nothing
here deletes a test -- the code stays visible and the reason is recorded.

Also puts the subproject root on sys.path so `physics` imports without
an editable install, matching EngineDesign/backend/main.py. Nothing in this
repo is pip-installed.
"""

import os
import sys

import pytest

# App root (star-openrocket/), so `physics` and `backend` import without an
# editable install. tests/recovery/ is two levels below the root.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

# filename -> reason. Empty is the desired state.
_QUARANTINE_FILES = {}

# "<file>::<test>" -> reason. Empty is the desired state.
# These read the recovery frontend source / climatology bundle, which land under
# frontend/src/recovery/ in Phase 3 of the STAR OpenRocket merge. Un-quarantine
# once the frontend is relocated (the paths above already point at the new home).
_MERGE_PHASE3 = "pending Phase 3 frontend relocation (frontend/src/recovery/)"
_QUARANTINE_TESTS = {
    "test_api.py::test_climatology_route_resolves_to_a_real_file": _MERGE_PHASE3,
    "test_api.py::test_climatology_serves_the_bundle_shape": _MERGE_PHASE3,
    "test_api.py::test_the_gui_default_sweep_matches_the_backend_default_sweep": _MERGE_PHASE3,
    "test_api.py::test_the_gui_and_backend_agree_on_the_airframe_band": _MERGE_PHASE3,
    "test_api.py::test_crosscheck_metric_kinds_are_ones_the_frontend_knows": _MERGE_PHASE3,
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
