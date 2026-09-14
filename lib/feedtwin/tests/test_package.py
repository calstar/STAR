"""Phase 00's exit criterion, as a test.

The whole point of this phase is that ``import feedtwin`` works from two very
different environments -- the feed-twin API container and EngineDesign's
optimizer process -- and that the physics stack it needs is actually resolvable
in both. That is not a formality: an optimizer that discovers a missing CoolProp
15 minutes into a Layer X run has wasted the run.
"""

from __future__ import annotations

import importlib
import importlib.metadata
import subprocess
import sys

import pytest

import feedtwin

#: Everything whose absence would make a physics answer impossible, not merely
#: degraded. Kept in step with the dependency list in pyproject.toml.
REQUIRED_STACK = ["numpy", "scipy", "CoolProp", "fluids", "ht"]


def test_version_is_declared() -> None:
    assert feedtwin.__version__


def test_version_matches_installed_metadata() -> None:
    """``__init__.py`` is the only place the version is written.

    pyproject.toml reads it from there via ``[tool.setuptools.dynamic]``, so the
    two cannot disagree in a fresh install. They can still disagree after
    bumping ``__version__`` without reinstalling, and that matters: run
    provenance stamps the attribute while anything resolving the distribution
    sees the metadata. This turns that into a failed test rather than two
    versions of the truth in a results file.
    """
    installed = importlib.metadata.version("feedtwin")
    assert installed == feedtwin.__version__, (
        f"installed metadata says {installed}, feedtwin.__version__ says "
        f"{feedtwin.__version__} -- reinstall with `pip install -e lib/feedtwin`"
    )


def test_package_carries_no_web_framework() -> None:
    """The library must stay importable in a process with no web stack.

    EngineDesign's optimizer will import this package directly (ADR-0001). If a
    FastAPI import ever creeps into the physics -- through a Pydantic model that
    drags in starlette, most likely -- that call path acquires a dependency it
    has no use for, and the separation this package exists to maintain is gone.

    Checked in a subprocess, not against this process's ``sys.modules``: pytest
    itself, or a sibling test, may legitimately have imported a web framework
    already, and asserting on a shared interpreter would make this pass or fail
    on test ordering rather than on what feedtwin actually pulls in.
    """
    probe = (
        "import sys; import feedtwin; "
        "leaked = {'fastapi', 'starlette', 'uvicorn'} & set(sys.modules); "
        "print(','.join(sorted(leaked)))"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe],
        capture_output=True,
        text=True,
        check=True,
    )

    leaked = result.stdout.strip()
    assert not leaked, f"importing feedtwin pulled in a web framework: {leaked}"


@pytest.mark.parametrize("module", REQUIRED_STACK)
def test_physics_stack_is_importable(module: str) -> None:
    """Each dependency resolves in whatever environment is running these tests."""
    assert importlib.import_module(module) is not None


def test_stack_versions_reports_every_dependency() -> None:
    """Run provenance covers the whole stack, not just feedtwin's own version."""
    versions = feedtwin.stack_versions()

    assert versions["feedtwin"] == feedtwin.__version__
    assert versions["python"]

    missing = [name for name in REQUIRED_STACK if versions.get(name) is None]
    assert not missing, f"stack_versions() could not report versions for {missing}"
