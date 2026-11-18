"""openrocket-web API, standalone (:8004): docs/SCHEMA.md's routes at /api.

The routes themselves live in ``orweb.api`` so star-openrocket can mount the very
same router (at /api/ork, as its OpenRocket tab). This app only picks the prefix
and the examples: the full set under tests/rockets when the checkout has them
(the API tests run every one against OpenRocket's golden output), else the few
the package ships.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI

from orweb.api import PACKAGED_EXAMPLES, create_router

ROOT = Path(__file__).resolve().parent.parent
TEST_EXAMPLES = ROOT / "tests" / "rockets"
EXAMPLES = TEST_EXAMPLES if TEST_EXAMPLES.is_dir() else PACKAGED_EXAMPLES

app = FastAPI(title="openrocket-web", description="OpenRocket 24.12's design view, ported to Python.")
app.include_router(create_router(EXAMPLES), prefix="/api")
