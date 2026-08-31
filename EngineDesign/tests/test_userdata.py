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


# ── cross-user helpers (added for design sharing) ────────────────────────────


def test_slug_user_matches_current_user_exactly():
    """An ?owner= param and the injected header must normalize identically, or
    an ownership check hinges on two slightly different transforms."""
    for raw in ["Alice@Berkeley.EDU", "alice@berkeley.edu", "  Alice@Berkeley.EDU  "]:
        assert userdata.slug_user(raw) == userdata.current_user(_Req({"X-Auth-Email": raw}))


def test_slug_user_cannot_escape_the_root():
    for raw in ["../..", "a/b", ".", "..", ""]:
        slug = userdata.slug_user(raw)
        assert "/" not in slug and slug not in ("", ".", "..")


def test_user_dir_create_false_does_not_conjure_a_tree(tmp_path):
    """The cross-user browse inspects every sibling folder; if inspection
    created them, one listing would invent a directory per user it looked at."""
    userdata.user_dir("ghost@x.edu", create=False)
    assert list(tmp_path.iterdir()) == []

    userdata.user_dir("real@x.edu")
    assert (tmp_path / "real@x.edu" / userdata.APP).is_dir()


def test_all_users_lists_only_people_with_data_for_this_app(tmp_path):
    assert userdata.all_users() == []

    userdata.user_dir("alice@x.edu")
    userdata.user_dir("bob@x.edu")
    userdata.user_dir("carol@x.edu", app="someotherapp")
    (tmp_path / ".hidden").mkdir()
    (tmp_path / "stray-file").write_text("")

    assert userdata.all_users() == ["alice@x.edu", "bob@x.edu"]
    assert userdata.all_users(app="someotherapp") == ["carol@x.edu"]


def test_all_users_survives_a_missing_root(tmp_path, monkeypatch):
    monkeypatch.setenv("USERDATA_DIR", str(tmp_path / "not-created-yet"))
    assert userdata.all_users() == []
