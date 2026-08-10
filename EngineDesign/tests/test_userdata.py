"""Per-user data helper (backend/userdata.py).

Identity comes from X-Auth-Email (Caddy in prod; a `local` fallback in dev), and
one user's saved configs must never be visible to another. Tests the module
directly so it needs neither the full app nor its heavy deps.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

pytest.importorskip("fastapi", reason="userdata imports fastapi.Request")

from backend import userdata  # noqa: E402


class _Req:
    def __init__(self, headers):
        self.headers = headers


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setenv("USERDATA_DIR", str(tmp_path))


def test_current_user_falls_back_to_local_without_header():
    assert userdata.current_user(_Req({})) == "local"


def test_current_user_lowercases_the_email():
    assert userdata.current_user(_Req({"X-Auth-Email": "Alice@Berkeley.EDU"})) == "alice@berkeley.edu"


def test_identity_cannot_escape_via_traversal():
    who = userdata.current_user(_Req({"X-Auth-Email": "../../etc/passwd"}))
    assert "/" not in who and ".." not in who


def test_write_read_list_delete_roundtrip():
    userdata.write_config("u@x.edu", "My Baseline", {"input": {"a": 1}})
    userdata.write_config("u@x.edu", "Higher Pc!!", {"input": {"a": 2}})
    assert [c["slug"] for c in userdata.list_configs("u@x.edu")] == ["higher-pc", "my-baseline"]
    blob = userdata.read_config("u@x.edu", "my-baseline")
    assert blob["config"] == {"input": {"a": 1}} and blob["name"] == "My Baseline"
    assert userdata.delete_config("u@x.edu", "my-baseline") is True
    assert userdata.delete_config("u@x.edu", "my-baseline") is False


def test_users_are_isolated():
    userdata.write_config("alice@x.edu", "one", {"input": {}})
    assert userdata.list_configs("bob@x.edu") == []


def test_invalid_name_rejected():
    with pytest.raises(ValueError):
        userdata.write_config("u@x.edu", "***", {})


def test_traversal_slug_reads_nothing():
    assert userdata.read_config("u@x.edu", "../../../etc/passwd") is None
