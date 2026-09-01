"""Tests for the auth service.

Focused on the two things that are easy to get subtly wrong and expensive to get
wrong: bounding post-login redirects, and the access decision /verify hands to
Caddy.

Run with:
    cd auth && python -m pytest test_main.py
"""

import datetime
import json
import os
import threading

import jwt
import pytest

os.environ.setdefault("FLASK_SECRET_KEY", "test-flask-secret-0123456789abcdef")
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-0123456789abcdefghij")
os.environ.setdefault("GOOGLE_CLIENT_ID", "test-client-id")
os.environ.setdefault("GOOGLE_CLIENT_SECRET", "test-client-secret")

import main  # noqa: E402
import users as user_directory  # noqa: E402


@pytest.fixture
def client():
    main.app.config["TESTING"] = True
    with main.app.test_client() as c:
        yield c


def _token(email="someone@berkeley.edu", name="Someone", ttl_days=30):
    now = datetime.datetime.now(datetime.timezone.utc)
    return jwt.encode(
        {
            "email": email,
            "name": name,
            "iat": now,
            "exp": now + datetime.timedelta(days=ttl_days),
        },
        main.JWT_SECRET,
        algorithm="HS256",
    )


# ── _host_is_ours ──────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "host,expected",
    [
        ("starberkeley.org", True),
        ("daq-server.starberkeley.org", True),
        ("DAQ-SERVER.STARBERKELEY.ORG", True),
        ("daq-server.starberkeley.org:443", True),
        # The bypasses a substring or bare endswith() check would let through.
        ("starberkeley.org.evil.com", False),
        ("evilstarberkeley.org", False),
        ("evil.com", False),
        ("", False),
    ],
)
def test_host_is_ours(host, expected):
    assert main._host_is_ours(host) is expected


# ── _safe_next ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw,expected",
    [
        # Allowed: relative paths and our own sites.
        ("/boards", "/boards"),
        ("/plots/lox?range=5m", "/plots/lox?range=5m"),
        ("https://daq-server.starberkeley.org/boards", "https://daq-server.starberkeley.org/boards"),
        ("https://starberkeley.org/", "https://starberkeley.org/"),
        # Rejected: everything that would send someone off-site.
        ("https://evil.com/phish", "/"),
        ("https://starberkeley.org.evil.com/", "/"),
        ("//evil.com/phish", "/"),  # protocol-relative: browsers treat as absolute
        ("javascript:alert(1)", "/"),
        ("data:text/html,<script>alert(1)</script>", "/"),
        ("boards", "/"),  # not rooted, would resolve against the auth host
        (None, "/"),
        ("", "/"),
    ],
)
def test_safe_next_in_production(raw, expected):
    with main.app.test_request_context("/login", headers={"X-Forwarded-Host": "auth.starberkeley.org"}):
        assert main._safe_next(raw) == expected


def test_safe_next_allows_localhost_off_production():
    with main.app.test_request_context("/login", base_url="http://localhost:5000"):
        assert main._safe_next("http://localhost:3000/boards") == "http://localhost:3000/boards"


def test_safe_next_rejects_localhost_in_production():
    with main.app.test_request_context("/login", headers={"X-Forwarded-Host": "auth.starberkeley.org"}):
        assert main._safe_next("http://localhost:3000/boards") == "/"


# ── /login ─────────────────────────────────────────────────────────────────


def test_login_does_not_put_next_in_oauth_state(client):
    """The `next` destination must not become the OAuth state nonce.

    Overriding state with a caller-supplied value defeats the CSRF protection
    the parameter exists for.
    """
    resp = client.get("/login?next=/boards")
    assert resp.status_code == 302

    location = resp.headers["Location"]
    assert "accounts.google.com" in location

    from urllib.parse import parse_qs, urlparse

    state = parse_qs(urlparse(location).query).get("state", [""])[0]
    assert state, "Authlib should still send a state nonce"
    assert state != "/boards"
    assert "boards" not in state


# ── /verify ────────────────────────────────────────────────────────────────


def test_verify_allows_valid_token_and_reports_identity(client):
    client.set_cookie("session", _token())
    resp = client.get("/verify")
    assert resp.status_code == 200
    assert resp.headers["X-Auth-Email"] == "someone@berkeley.edu"
    assert resp.headers["X-Auth-User"] == "Someone"


def test_verify_401s_without_a_token(client):
    resp = client.get("/verify")
    assert resp.status_code == 401


def test_verify_401s_on_expired_token(client):
    client.set_cookie("session", _token(ttl_days=-1))
    assert client.get("/verify").status_code == 401


def test_verify_401s_on_token_signed_with_another_key(client):
    now = datetime.datetime.now(datetime.timezone.utc)
    forged = jwt.encode(
        {"email": "someone@berkeley.edu", "exp": now + datetime.timedelta(days=1)},
        "not-the-real-secret",
        algorithm="HS256",
    )
    client.set_cookie("session", forged)
    assert client.get("/verify").status_code == 401


def test_verify_redirects_a_browser_navigation_back_to_the_original_url(client):
    """Caddy copies a non-2xx verbatim, so this 302 is what bounces the user."""
    resp = client.get(
        "/verify",
        headers={
            "Accept": "text/html,application/xhtml+xml",
            "X-Forwarded-Method": "GET",
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "daq-server.starberkeley.org",
            "X-Forwarded-Uri": "/plots/lox?range=5m",
        },
    )
    assert resp.status_code == 302

    from urllib.parse import parse_qs, urlparse

    location = urlparse(resp.headers["Location"])
    assert location.netloc == "auth.starberkeley.org"
    assert location.path == "/login"
    assert parse_qs(location.query)["next"] == [
        "https://daq-server.starberkeley.org/plots/lox?range=5m"
    ]


def test_verify_401s_an_xhr_rather_than_redirecting(client):
    """A fetch() cannot complete an interactive login; it needs a status to handle."""
    resp = client.get(
        "/verify",
        headers={
            "Accept": "application/json",
            "X-Forwarded-Method": "GET",
            "X-Forwarded-Host": "daq-server.starberkeley.org",
            "X-Forwarded-Uri": "/api/config",
        },
    )
    assert resp.status_code == 401


def test_verify_401s_a_websocket_upgrade_rather_than_redirecting(client):
    resp = client.get(
        "/verify",
        headers={
            "Accept": "text/html",
            "Upgrade": "websocket",
            "X-Forwarded-Method": "GET",
            "X-Forwarded-Host": "daq-server.starberkeley.org",
            "X-Forwarded-Uri": "/ws",
        },
    )
    assert resp.status_code == 401


def test_verify_401s_a_mutating_request_rather_than_redirecting(client):
    """Redirecting a POST to a login page would silently drop the body."""
    resp = client.get(
        "/verify",
        headers={
            "Accept": "text/html",
            "X-Forwarded-Method": "POST",
            "X-Forwarded-Host": "daq-server.starberkeley.org",
            "X-Forwarded-Uri": "/api/actuator",
        },
    )
    assert resp.status_code == 401


# ── Per-app allowlist (openrocket / STAR OpenRocket) ──────────────────────────────────────


def _onshape_headers(accept="text/html", uri="/", method="GET"):
    return {
        "Accept": accept,
        "X-Forwarded-Method": method,
        "X-Forwarded-Host": "openrocket.starberkeley.org",
        "X-Forwarded-Uri": uri,
    }


#: A path that spends the Onshape key pair -- the only kind the allowlist gates.
_ONSHAPE_PATH = "/api/onshape/documents"


def test_verify_allows_an_approved_user_on_a_protected_path(client, monkeypatch):
    monkeypatch.setattr(main.allowlist, "is_approved", lambda app, email: True)
    client.set_cookie("session", _token(email="ok@berkeley.edu"))
    resp = client.get("/verify", headers=_onshape_headers(uri=_ONSHAPE_PATH))
    assert resp.status_code == 200
    assert resp.headers["X-Auth-Email"] == "ok@berkeley.edu"


def test_verify_403s_a_valid_but_unapproved_user_on_a_protected_path(client, monkeypatch):
    """Authenticated but not authorized for the Onshape calls: a 403, not a login
    redirect -- re-logging in would not change the answer."""
    monkeypatch.setattr(main.allowlist, "is_approved", lambda app, email: False)
    client.set_cookie("session", _token(email="nope@berkeley.edu"))
    resp = client.get("/verify", headers=_onshape_headers(uri=_ONSHAPE_PATH))
    assert resp.status_code == 403
    assert "Location" not in resp.headers  # not bounced to login


def test_verify_403s_an_unapproved_xhr_on_build(client, monkeypatch):
    monkeypatch.setattr(main.allowlist, "is_approved", lambda app, email: False)
    client.set_cookie("session", _token(email="nope@berkeley.edu"))
    resp = client.get(
        "/verify", headers=_onshape_headers(accept="application/json", uri="/api/build")
    )
    assert resp.status_code == 403


def test_verify_lets_an_unapproved_user_use_the_rest_of_the_app(client, monkeypatch):
    """The whole point of the change: a signed-in but unapproved user can open the
    app and use every cache-first feature; only the Onshape paths are gated."""
    monkeypatch.setattr(main.allowlist, "is_approved", lambda app, email: False)
    client.set_cookie("session", _token(email="nope@berkeley.edu"))
    for uri in ("/", "/api/models", "/api/simulate", "/api/models/abc/stability"):
        resp = client.get("/verify", headers=_onshape_headers(uri=uri))
        assert resp.status_code == 200, uri
        assert resp.headers["X-Auth-Email"] == "nope@berkeley.edu"


def test_verify_unrestricted_apps_ignore_the_allowlist(client, monkeypatch):
    """A denying allowlist must not affect apps that don't use one."""
    monkeypatch.setattr(main.allowlist, "is_approved", lambda app, email: app != "openrocket")
    client.set_cookie("session", _token())
    resp = client.get(
        "/verify", headers={"X-Forwarded-Host": "engine-design.starberkeley.org"}
    )
    assert resp.status_code == 200


def test_path_needs_approval_gates_only_the_onshape_key_paths():
    from allowlist import path_needs_approval

    assert path_needs_approval("openrocket", "/api/onshape/documents") is True
    assert path_needs_approval("openrocket", "/api/build") is True
    assert path_needs_approval("openrocket", "/api/build/abc123") is True
    assert path_needs_approval("openrocket", "/api/build?force=1") is True  # query ignored
    assert path_needs_approval("openrocket", "/api/models") is False
    assert path_needs_approval("openrocket", "/") is False
    # An app with no protected paths never consults the allowlist.
    assert path_needs_approval("engine-design", "/api/onshape/documents") is False


def test_allowlist_file_is_read_and_matches_case_insensitively(tmp_path):
    f = tmp_path / "onshape.txt"
    f.write_text("# approved\nAidan@Berkeley.edu\n\n# comment line\n")
    from allowlist import _load

    emails = _load(str(f))
    assert "aidan@berkeley.edu" in emails
    assert "someoneelse@berkeley.edu" not in emails


def test_allowlist_fails_closed_when_file_missing(tmp_path):
    from allowlist import _load

    assert _load(str(tmp_path / "does-not-exist.txt")) == frozenset()


# ── Cookie shape ───────────────────────────────────────────────────────────


def test_logout_clears_the_cookie_on_the_shared_domain(client):
    resp = client.get("/logout", base_url="https://auth.starberkeley.org")
    set_cookie = resp.headers["Set-Cookie"]
    assert "session=" in set_cookie
    # Werkzeug strips the leading dot (RFC 6265); Domain=starberkeley.org is
    # already sent to every subdomain, which is the property we need.
    assert "Domain=starberkeley.org" in set_cookie
    assert "Secure" in set_cookie
    assert "HttpOnly" in set_cookie


def test_cookie_is_not_domain_scoped_or_secure_in_local_dev(client):
    resp = client.get("/logout", base_url="http://localhost:5000")
    set_cookie = resp.headers["Set-Cookie"]
    assert "Domain=" not in set_cookie
    assert "Secure" not in set_cookie


# ── Health ─────────────────────────────────────────────────────────────────


def test_healthz_needs_no_auth(client):
    assert client.get("/healthz").status_code == 200


# ── Verify-only mode ─────────────────────────────────────────────────────────


def test_verify_only_boots_without_google_credentials():
    """A verify-only node (the auth next to the apps on another machine) must
    boot with only JWT_SECRET -- no Google client secret, no Flask secret -- and
    still validate cookies. Run in a subprocess so it is a clean import with a
    stripped environment, independent of this module's already-imported `main`."""
    import subprocess
    import sys
    import textwrap

    script = textwrap.dedent(
        """
        import datetime, jwt, main
        assert main.VERIFY_ONLY is True
        assert main.google is None                 # OAuth never wired
        c = main.app.test_client()
        assert c.get("/healthz").status_code == 200
        now = datetime.datetime.now(datetime.timezone.utc)
        tok = jwt.encode({"email": "a@berkeley.edu", "name": "A",
                          "iat": now, "exp": now + datetime.timedelta(days=1)},
                         main.JWT_SECRET, algorithm="HS256")
        c.set_cookie("session", tok)
        r = c.get("/verify")
        assert r.status_code == 200 and r.headers["X-Auth-Email"] == "a@berkeley.edu"
        # /login bounces to the central login rather than touching a Google client
        r = c.get("/login?next=/x")
        assert r.status_code == 302 and "auth.starberkeley.org/login" in r.headers["Location"]
        print("VERIFY_ONLY_OK")
        """
    )
    env = {
        "PATH": os.environ.get("PATH", ""),
        "AUTH_VERIFY_ONLY": "true",
        "JWT_SECRET": "verify-only-jwt-secret-0123456789abcdef",
        "AUTH_PUBLIC_URL": "https://auth.starberkeley.org",
        # deliberately NO GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / FLASK_SECRET_KEY
    }
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=os.path.dirname(os.path.abspath(__file__)),
        env=env, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "VERIFY_ONLY_OK" in result.stdout


# ── the login roster (/users) ──────────────────────────────────────────────
#
# Sharing designs needs a list of people, and this service is the only thing
# that ever meets one. The properties that matter are not "it returns rows" but
# that it cannot break a login and cannot lose one.


@pytest.fixture
def roster(tmp_path, monkeypatch):
    """Point the roster at a scratch file for the duration of one test."""
    path = tmp_path / "users.json"
    monkeypatch.setattr(user_directory, "USERS_FILE", str(path))
    return path


def test_users_requires_a_session(client, roster):
    assert client.get("/users").status_code == 401


def test_users_rejects_a_forged_token(client, roster):
    client.set_cookie("session", "not-a-jwt", domain="localhost")
    assert client.get("/users").status_code == 401


def test_login_is_recorded_and_served(client, roster):
    user_directory.record_login("Alice@berkeley.edu", "Alice Adams")
    user_directory.record_login("bob@berkeley.edu", "Bob Brown")

    client.set_cookie("session", _token(), domain="localhost")
    assert client.get("/users").get_json() == [
        {"email": "Alice@berkeley.edu", "name": "Alice Adams"},
        {"email": "bob@berkeley.edu", "name": "Bob Brown"},
    ]


def test_repeat_login_updates_rather_than_duplicates(client, roster):
    user_directory.record_login("alice@berkeley.edu", "A. Adams")
    user_directory.record_login("ALICE@berkeley.edu", "Alice Adams")

    rows = user_directory.list_users()
    assert len(rows) == 1
    assert rows[0]["name"] == "Alice Adams"


def test_last_login_is_recorded_but_not_served(roster):
    user_directory.record_login("alice@berkeley.edu", "Alice")
    assert "lastLogin" in json.loads(roster.read_text())[0]
    assert set(user_directory.list_users()[0]) == {"email", "name"}


def test_an_unwritable_roster_never_breaks_a_login(tmp_path, monkeypatch):
    """A full disk, a read-only mount or a bad permission costs a missing name
    in a share picker. It must never stop anyone signing in."""
    unwritable = tmp_path / "ro"
    unwritable.mkdir()
    unwritable.chmod(0o500)
    monkeypatch.setattr(user_directory, "USERS_FILE", str(unwritable / "users.json"))
    try:
        user_directory.record_login("alice@berkeley.edu", "Alice")  # must not raise
        assert user_directory.list_users() == []
    finally:
        unwritable.chmod(0o700)


def test_a_corrupt_roster_reads_as_empty(roster):
    roster.write_text("{ not json")
    assert user_directory.list_users() == []
    # ...and the next login repairs it rather than compounding the damage.
    user_directory.record_login("alice@berkeley.edu", "Alice")
    assert [r["email"] for r in user_directory.list_users()] == ["alice@berkeley.edu"]


def test_concurrent_logins_do_not_lose_records(roster):
    """gunicorn runs two workers and Flask is threaded, so read-modify-write
    without a lock silently drops one of two simultaneous logins."""
    emails = [f"user{i}@berkeley.edu" for i in range(24)]
    threads = [
        threading.Thread(target=user_directory.record_login, args=(e, f"User {i}"))
        for i, e in enumerate(emails)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert sorted(r["email"] for r in user_directory.list_users()) == sorted(emails)


def test_verify_only_node_says_so_instead_of_lying(client, roster, monkeypatch):
    """An empty list would look like "nobody to share with". A 503 says the
    AUTH_USERS_URL is pointed at the wrong node."""
    monkeypatch.setattr(main, "VERIFY_ONLY", True)
    client.set_cookie("session", _token(), domain="localhost")
    resp = client.get("/users")
    assert resp.status_code == 503
    assert main.AUTH_PUBLIC_URL in resp.get_json()["error"]
