"""Per-user data: the userdata helper, /api/settings, and /api/configs.

Identity comes from X-Auth-Email (Caddy sets it in prod; a `local` fallback in
dev). The app never gates -- a missing header is the local user, not a 401 --
and one user's data must never be visible to another.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

pytest.importorskip("fastapi", reason="API tests need fastapi")
pytest.importorskip("httpx", reason="fastapi TestClient needs httpx")

from fastapi.testclient import TestClient  # noqa: E402

from backend import userdata  # noqa: E402
from backend.main import app  # noqa: E402

A = {"X-Auth-Email": "alice@berkeley.edu"}
B = {"X-Auth-Email": "bob@berkeley.edu"}


@pytest.fixture(autouse=True)
def _isolate_userdata(tmp_path, monkeypatch):
    """Every test gets a fresh, empty data root."""
    monkeypatch.setenv("USERDATA_DIR", str(tmp_path))


@pytest.fixture
def client():
    return TestClient(app)


# ── userdata helper ──────────────────────────────────────────────────────────


class _Req:
    def __init__(self, headers):
        self.headers = headers


def test_current_user_falls_back_to_local_without_header():
    assert userdata.current_user(_Req({})) == "local"


def test_current_user_lowercases_and_uses_the_email():
    assert userdata.current_user(_Req({"X-Auth-Email": "Alice@Berkeley.EDU"})) == "alice@berkeley.edu"


def test_identity_cannot_escape_the_root_via_traversal():
    who = userdata.current_user(_Req({"X-Auth-Email": "../../etc/passwd"}))
    assert "/" not in who and ".." not in who


def test_write_read_list_delete_roundtrip():
    userdata.write_config("u@x.edu", "My Baseline", {"a": 1})
    userdata.write_config("u@x.edu", "Higher Pc!!", {"a": 2})
    slugs = [c["slug"] for c in userdata.list_configs("u@x.edu")]
    assert slugs == ["higher-pc", "my-baseline"]  # newest first
    blob = userdata.read_config("u@x.edu", "my-baseline")
    assert blob["config"] == {"a": 1} and blob["name"] == "My Baseline"
    assert userdata.delete_config("u@x.edu", "my-baseline") is True
    assert userdata.delete_config("u@x.edu", "my-baseline") is False


def test_write_rejects_a_name_with_no_usable_characters():
    with pytest.raises(ValueError):
        userdata.write_config("u@x.edu", "***", {})


def test_read_with_a_traversal_slug_returns_none():
    assert userdata.read_config("u@x.edu", "../../../etc/passwd") is None


# ── /api/settings (per user) ─────────────────────────────────────────────────


def test_settings_are_isolated_per_user(client):
    client.put("/api/settings", json={"units": {"mass": "imperial"}, "precision": {}}, headers=A)
    assert client.get("/api/settings", headers=A).json()["units"] == {"mass": "imperial"}
    assert client.get("/api/settings", headers=B).json()["units"] == {}


def test_settings_without_a_header_use_the_local_user(client):
    assert client.get("/api/settings").json() == {"units": {}, "precision": {}}


# ── /api/configs (per user) ──────────────────────────────────────────────────


def test_configs_crud_and_isolation(client):
    assert client.get("/api/configs", headers=A).json() == {"configs": []}
    r = client.post("/api/configs", json={"name": "Camelot", "config": {"m": 20}}, headers=A)
    assert r.status_code == 200 and r.json()["slug"] == "camelot"
    # Alice sees hers; Bob sees nothing of hers.
    assert [c["slug"] for c in client.get("/api/configs", headers=A).json()["configs"]] == ["camelot"]
    assert client.get("/api/configs", headers=B).json() == {"configs": []}
    assert client.get("/api/configs/camelot", headers=B).status_code == 404
    assert client.get("/api/configs/camelot", headers=A).json()["config"] == {"m": 20}


def test_saving_an_invalid_name_is_a_422(client):
    assert client.post("/api/configs", json={"name": "***", "config": {}}, headers=A).status_code == 422


def test_deleting_a_missing_config_is_a_404(client):
    assert client.delete("/api/configs/nope", headers=A).status_code == 404
