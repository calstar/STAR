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
