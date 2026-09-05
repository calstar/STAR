"""Import the canonical pad-state module from physics.

Equations (7a), (7b) and the METAR decoder live in exactly one place --
`physics/pad_state.py` -- because a second copy of the physics is a
second copy to get wrong.

This shim exists only to put the subproject root on `sys.path`, which is the
same thing `EngineDesign/backend/main.py` does. It is not a package-import
workaround: `physics.pad_state` is an ordinary dotted import, and both
names are valid identifiers.

`physics.pad_state` and `physics.atmosphere` are stdlib-only by
design, so importing them here does not drag numpy or scipy into this tree.
`physics/__init__.py` is deliberately empty to keep that true.
"""

import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from physics import atmosphere, pad_state, site  # noqa: E402

__all__ = ["atmosphere", "pad_state", "site"]
