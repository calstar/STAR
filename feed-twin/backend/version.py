"""Which code produced an answer.

A run is only reproducible if it can say what it ran on -- the drawing and the
engine (the library's content hashes do that) *and the code*. This is the code
half: the app's own version, the physics library's, and the commit, with a
flag when the working tree had changes the commit does not contain. A run
recorded off a dirty tree is still recorded; it just cannot claim the commit
reproduces it.

The commit comes from ``FEEDTWIN_COMMIT`` when a deployment sets it (an image
has no ``.git``), else from git, else is empty.
"""

from __future__ import annotations

import os
import subprocess
from functools import lru_cache
from pathlib import Path

import feedtwin

#: The app's version. Bump with a CHANGELOG.md entry (feed-twin/CHANGELOG.md).
__version__ = "0.2.0"

_ROOT = Path(__file__).resolve().parents[2]


def _git(*args: str) -> str:
    try:
        out = subprocess.run(
            ["git", *args],
            cwd=_ROOT,
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return out.stdout.strip()


#: What the model's answers have been checked against, said on every screen
#: and stamped on every run. Change it when the evidence changes -- the first
#: calibration against a stand test is what moves it off "unvalidated".
VALIDATION: dict[str, object] = {
    "status": "unvalidated",
    "label": "Not validated against test data",
    "checked": [
        "Closed-form results against hand calculation, fluids, CoolProp and the "
        "handbook (scripts/physics_benchmark.py, docs/PHYSICS-BENCHMARK.md)",
        "Layer X and the cockpit agree to 0.1 N on the same inputs "
        "(EngineDesign/tests/test_layerx_cockpit_parity.py)",
        "Mass conserved tick by tick, tank depletion included (Solver tab)",
    ],
    "not_checked": [
        "Any trace against a hot fire or water flow from the stand's DAQ",
        "Regulator droop and lockup against the 1092-50's own test",
    ],
}


@lru_cache(maxsize=1)
def code_version() -> dict[str, object]:
    """``{"app", "library", "commit", "dirty"}`` for this process."""
    commit = os.environ.get("FEEDTWIN_COMMIT", "") or _git(
        "rev-parse", "--short=12", "HEAD"
    )
    dirty = bool(
        not os.environ.get("FEEDTWIN_COMMIT")
        and _git("status", "--porcelain", "--", "feed-twin", "lib/feedtwin")
    )
    return {
        "app": __version__,
        "library": feedtwin.__version__,
        "commit": commit,
        "dirty": dirty,
    }
