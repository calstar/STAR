"""Future integration shim for the native physics kernel.

This package is intentionally NOT imported by any production code path (runner.py,
Layer 1, routers, frontend). It exists so a later PR can opt in via the env var
ED_USE_NATIVE=1. Importing it never triggers native loading by itself; call
ed_native.load() explicitly.

See engine/native/README.md ("Future integration plan").
"""

import os

ED_USE_NATIVE = os.environ.get("ED_USE_NATIVE", "0") == "1"

__all__ = ["ED_USE_NATIVE"]
