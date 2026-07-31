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

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# filename -> reason. Empty is the desired state.
_QUARANTINE_FILES = {}

# "<file>::<test>" -> reason. Empty is the desired state.
_QUARANTINE_TESTS = {}


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
