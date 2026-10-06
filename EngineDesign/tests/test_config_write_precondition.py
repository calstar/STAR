"""A write computed for one design is refused when another is live (PUT /api/config?expect_sha256=).

Layer X's fitted K0 and reconciled holes are fitted to the design a burn ran on. The UI's guard
read a preflight that is stale for seconds after a design load; the server is the guard now.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.checkout import require_design_checkout  # noqa: E402
from backend.session import UserSession, get_session  # noqa: E402


def _client(session):
    from backend.routers import config as config_router

    app = FastAPI()
    app.include_router(config_router.router)
    app.dependency_overrides[get_session] = lambda: session
    app.dependency_overrides[require_design_checkout] = lambda: None
    return TestClient(app)


def test_a_write_for_another_design_is_refused_and_the_right_one_lands():
    from engine.layerx.fingerprint import config_fingerprint

    session = UserSession("precondition")
    client = _client(session)
    client.get("/api/config")
    live = config_fingerprint(session.app_state.config)
    stale = "0" * 64
    refused = client.put(f"/api/config?expect_sha256={stale}", json={"thrust": {"burn_time": 3.0}})
    assert refused.status_code == 409
    assert config_fingerprint(session.app_state.config) == live          # nothing was written
    landed = client.put(f"/api/config?expect_sha256={live}", json={"rocket": {"fin_thickness_m": 0.004}})
    assert landed.status_code == 200
    assert client.put("/api/config", json={"rocket": {"fin_thickness_m": 0.005}}).status_code == 200   # no precondition: as before
