"""The share picker's roster (backend/directory.py).

Sharing needs a list of people, and this app has never had one. The roster is
the union of the auth service's login records and whoever already has data on
the shared volume -- it needs both, because auth only learns about someone when
they log in (30-day sessions, so the roster starts nearly empty) and dev runs
with no auth service at all.

The invariant that matters: auth being unset, down, slow, or lying must never
break listing or sharing designs.
"""

import json
import os
import sys
import urllib.error

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

pytest.importorskip("fastapi", reason="directory imports fastapi.Request")

from backend import directory, userdata  # noqa: E402


class _Req:
    def __init__(self, cookie=""):
        self.headers = {"cookie": cookie} if cookie else {}


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setenv("USERDATA_DIR", str(tmp_path))
    monkeypatch.delenv("AUTH_USERS_URL", raising=False)
    # The roster cache is process-wide; a stale entry would leak between tests.
    monkeypatch.setattr(directory, "_cache", (0.0, []))


def _fake_auth(monkeypatch, rows, *, calls=None):
    def fake(req, timeout=None):
        if calls is not None:
            calls.append(req)

        class _Resp:
            def read(self):
                return json.dumps(rows).encode()

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        return _Resp()

    monkeypatch.setenv("AUTH_USERS_URL", "https://auth.example.org")
    monkeypatch.setattr(directory.urllib.request, "urlopen", fake)


def test_volume_users_alone_when_auth_is_unset():
    """Dev, and the first weeks in prod: no auth roster, but the picker still
    has to be usable."""
    userdata.user_dir("alice@berkeley.edu")
    userdata.user_dir("bob@berkeley.edu")
    assert directory.roster(_Req()) == [
        {"email": "alice@berkeley.edu", "name": ""},
        {"email": "bob@berkeley.edu", "name": ""},
    ]


def test_union_prefers_auths_spelling_and_name(monkeypatch):
    """The volume only ever holds the slug; auth knows the real address and the
    display name, and the same person must not appear twice."""
    userdata.user_dir("alice@berkeley.edu")
    _fake_auth(monkeypatch, [
        {"email": "Alice@Berkeley.edu", "name": "Alice Adams"},
        {"email": "carol@berkeley.edu", "name": "Carol Chen"},
    ])
    assert directory.roster(_Req()) == [
        {"email": "Alice@Berkeley.edu", "name": "Alice Adams"},
        {"email": "carol@berkeley.edu", "name": "Carol Chen"},
    ]


def test_auth_users_who_never_opened_this_app_are_still_shareable(monkeypatch):
    _fake_auth(monkeypatch, [{"email": "dana@berkeley.edu", "name": "Dana"}])
    assert [u["email"] for u in directory.roster(_Req())] == ["dana@berkeley.edu"]


def test_forwards_only_the_session_cookie(monkeypatch):
    """This app becomes an authenticated-request forwarder. It must present the
    caller's own cookie and nothing else, to a URL it took from the environment
    rather than the request."""
    calls = []
    _fake_auth(monkeypatch, [], calls=calls)
    directory.roster(_Req(cookie="session=abc123"))
    (req,) = calls
    assert req.full_url == "https://auth.example.org/users"
    assert req.get_header("Cookie") == "session=abc123"
    assert set(req.headers) == {"Cookie"}


@pytest.mark.parametrize("boom", [
    urllib.error.URLError("down"),
    OSError("refused"),
    TimeoutError("slow"),
    ValueError("not json"),
])
def test_auth_failure_degrades_to_the_volume(monkeypatch, boom):
    userdata.user_dir("alice@berkeley.edu")
    monkeypatch.setenv("AUTH_USERS_URL", "https://auth.example.org")

    def explode(req, timeout=None):
        raise boom

    monkeypatch.setattr(directory.urllib.request, "urlopen", explode)
    assert [u["email"] for u in directory.roster(_Req())] == ["alice@berkeley.edu"]


@pytest.mark.parametrize("garbage", [{"not": "a list"}, ["a string"], [{"no": "email"}]])
def test_malformed_auth_response_is_ignored(monkeypatch, garbage):
    userdata.user_dir("alice@berkeley.edu")
    _fake_auth(monkeypatch, garbage)
    assert [u["email"] for u in directory.roster(_Req())] == ["alice@berkeley.edu"]


def test_roster_is_cached(monkeypatch):
    calls = []
    _fake_auth(monkeypatch, [{"email": "dana@berkeley.edu", "name": "Dana"}], calls=calls)
    directory.roster(_Req())
    directory.roster(_Req())
    assert len(calls) == 1, "listing designs must not be a network call per request"


def test_display_names_maps_slugs(monkeypatch):
    _fake_auth(monkeypatch, [{"email": "Alice@Berkeley.edu", "name": "Alice Adams"}])
    assert directory.display_names(_Req())["alice@berkeley.edu"] == "Alice Adams"
