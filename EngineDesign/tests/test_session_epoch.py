"""A recreated backend session is recognisable, so the design bar never autosaves its default.

2026-10-01: a backend restart left the session holding configs/default.yaml (methalox); the design
bar's autosave read it as an edit and saved it over an ethalox design. The bar now compares the
session epoch it loaded the design into with the one the backend reports, and restores the design
when they differ. This guards the backend half: every session object has its own epoch, and the
config routes the bar reads report it.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.session import UserSession, get_session  # noqa: E402


def test_every_session_has_its_own_epoch():
    a, b = UserSession("epoch-a"), UserSession("epoch-a")
    assert a.epoch and b.epoch and a.epoch != b.epoch


def test_the_config_routes_report_the_epoch():
    from backend.routers import config as config_router

    session = UserSession("epoch-b")
    app = FastAPI()
    app.include_router(config_router.router)
    app.dependency_overrides[get_session] = lambda: session
    client = TestClient(app)
    got = client.get("/api/config").json()
    assert got["session_epoch"] == session.epoch
    loaded = client.post("/api/config/load", json=got["config"]).json()
    assert loaded["session_epoch"] == session.epoch
