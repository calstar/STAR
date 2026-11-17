"""Make ``orweb`` (the repo root) and the tests' helpers importable however pytest is run."""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
for p in (HERE.parent, HERE):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))


def pytest_configure(config):
    config.addinivalue_line("markers", "oracle: runs OpenRocket itself (needs a JDK and OPENROCKET_JAR)")
