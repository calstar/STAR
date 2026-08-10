"""Central auth service for STAR internal tools.

Handles Google OAuth, mints a JWT stored in a .starberkeley.org domain cookie,
and restricts access to @berkeley.edu accounts.

Apps do not implement auth themselves. Caddy calls /verify ahead of every
request to a protected site (forward_auth); this service decides whether to let
it through, and where to send the browser if not. See deploy/Caddyfile.

Run locally:
    cd auth
    flask --app main run --port 5000

Required env vars (see .env.example):
    GOOGLE_CLIENT_ID
    GOOGLE_CLIENT_SECRET
    JWT_SECRET          -- shared with all apps that verify the cookie
    FLASK_SECRET_KEY    -- used by Flask for session state during OAuth flow
"""

import datetime
import os
import secrets
from urllib.parse import urlencode, urlparse

import jwt
from authlib.integrations.flask_client import OAuth
from dotenv import load_dotenv
from flask import Flask, make_response, redirect, request, session
from markupsafe import escape

import allowlist
from shared_auth import verify_session

load_dotenv()

# A verify-only node validates cookies but never runs the OAuth login -- that is
# centralized on the one public auth at AUTH_PUBLIC_URL. Such a node (the auth
# container that runs next to the apps on another machine) needs only JWT_SECRET,
# not the Google client secret, which keeps that secret on the login box alone.
VERIFY_ONLY = os.environ.get("AUTH_VERIFY_ONLY", "false").lower() == "true"

app = Flask(__name__)
# FLASK_SECRET_KEY secures the OAuth state during login. A verify-only node runs
# no login, so it is optional there (an ephemeral key is fine); a login node MUST
# set it, and consistently, or OAuth state fails to validate across workers.
if VERIFY_ONLY:
    app.secret_key = os.environ.get("FLASK_SECRET_KEY") or secrets.token_hex(32)
else:
    app.secret_key = os.environ["FLASK_SECRET_KEY"]

# Flask's own session cookie is named "session" by default -- the same name we
# use for the JWT. Authlib keeps the OAuth state in the Flask session and pops
# it in /callback, which makes Flask emit a *second* Set-Cookie for "session"
# after ours (an expiry, since the session is then empty). The browser applies
# the last header, so the JWT was being deleted the instant it was set and every
# login bounced straight back to /login. Give Flask a different cookie name.
app.config["SESSION_COOKIE_NAME"] = "oauth_state"

JWT_SECRET = os.environ["JWT_SECRET"]
COOKIE_DOMAIN = os.environ.get("COOKIE_DOMAIN", ".starberkeley.org")
ALLOWED_DOMAIN = os.environ.get("ALLOWED_EMAIL_DOMAIN", "berkeley.edu")
TOKEN_TTL_DAYS = int(os.environ.get("TOKEN_TTL_DAYS", "30"))

# Bare domain that owns every app, e.g. "starberkeley.org". Used both to decide
# whether a request arrived through production and to bound redirect targets.
BASE_DOMAIN = COOKIE_DOMAIN.lstrip(".")

# Public URL of this service, used to build login links for other sites.
AUTH_PUBLIC_URL = os.environ.get("AUTH_PUBLIC_URL", f"https://auth.{BASE_DOMAIN}").rstrip("/")

# Google OAuth is only wired on a login node. A verify-only node skips it, and so
# does not require the Google credentials to boot.
google = None
if not VERIFY_ONLY:
    oauth = OAuth(app)
    google = oauth.register(
        name="google",
        client_id=os.environ["GOOGLE_CLIENT_ID"],
        client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
        server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile"},
    )


# ── Request helpers ────────────────────────────────────────────────────────


def _forwarded_host() -> str:
    """Host the *browser* asked for, which behind Caddy is not request.host.

    X-Forwarded-Host can be a comma-separated list when several proxies are
    chained; the first entry is the original client-facing one.
    """
    raw = request.headers.get("X-Forwarded-Host") or request.host
    return raw.split(",")[0].strip()


def _host_is_ours(host: str) -> bool:
    """True for BASE_DOMAIN itself and any subdomain of it.

    Written as an exact match plus a dotted-suffix match on purpose: a plain
    substring or `endswith(BASE_DOMAIN)` test would accept
    `starberkeley.org.evil.com`.
    """
    host = host.split(":")[0].lower()
    return host == BASE_DOMAIN or host.endswith(f".{BASE_DOMAIN}")


def _is_prod_request() -> bool:
    """Check if the current request is coming through the production domain."""
    return _host_is_ours(_forwarded_host())


def _requested_app() -> str:
    """The app being accessed, as the leftmost label of the forwarded host.

    `onshape-viewer.starberkeley.org` -> `onshape-viewer`; the bare domain ->
    `""`. This is what /verify uses to look up a per-app allowlist. Off
    production (localhost dev) Caddy is not in the loop, so this is not reached.
    """
    host = _forwarded_host().split(":")[0].lower()
    if host == BASE_DOMAIN:
        return ""
    suffix = f".{BASE_DOMAIN}"
    if host.endswith(suffix):
        return host[: -len(suffix)]
    return host


def _safe_next(raw: str | None) -> str:
    """Bound a post-login redirect target to sites we own.

    Returns "/" for anything unrecognised rather than raising, so a malformed
    `next` degrades to the landing page instead of failing the login.
    """
    if not raw:
        return "/"

    parsed = urlparse(raw)

    # Relative path: no scheme and no authority. Note that "//evil.com/x" parses
    # with netloc="evil.com" and lands in the absolute branch below, where its
    # empty scheme rejects it -- browsers would otherwise treat it as absolute.
    if not parsed.scheme and not parsed.netloc:
        return raw if raw.startswith("/") else "/"

    if parsed.scheme not in ("http", "https"):
        return "/"

    host = (parsed.hostname or "").lower()
    if _host_is_ours(host):
        return raw
    # Outside production the apps live on localhost, so allow that too -- this
    # is how the flow is exercised on a dev box.
    if not _is_prod_request() and host in ("localhost", "127.0.0.1", "::1"):
        return raw
    return "/"


def _cookie_kwargs(max_age: int) -> dict:
    """Build cookie options. Uses domain=.starberkeley.org + secure only in production."""
    is_prod = _is_prod_request()
    kwargs = {
        "max_age": max_age,
        "httponly": True,
        "samesite": "Lax",
        "secure": is_prod or request.is_secure,
    }
    if is_prod:
        kwargs["domain"] = COOKIE_DOMAIN
    return kwargs


def _callback_url() -> str:
    if _is_prod_request():
        return f"{AUTH_PUBLIC_URL}/callback"
    scheme = "https" if request.is_secure else "http"
    return f"{scheme}://{request.host}/callback"


# ── Routes ─────────────────────────────────────────────────────────────────


@app.route("/login")
def login():
    """Redirect to Google OAuth.

    The destination is stashed in the Flask session rather than passed as the
    OAuth `state`. Overriding `state` would replace Authlib's random nonce with
    a value an attacker controls, which is precisely the CSRF defence the
    parameter exists to provide.
    """
    if VERIFY_ONLY:
        # This node runs no OAuth; hand off to the central login, preserving next.
        qs = request.query_string.decode()
        return redirect(f"{AUTH_PUBLIC_URL}/login" + (f"?{qs}" if qs else ""))
    session["next"] = _safe_next(request.args.get("next"))
    return google.authorize_redirect(_callback_url())


@app.route("/callback")
def callback():
    """Google redirects here after login. Validates email, mints JWT, sets cookie."""
    if VERIFY_ONLY:
        # Google never calls a verify-only node; nothing to complete here.
        return redirect("/")
    try:
        # Also validates the state nonce against the Flask session.
        token = google.authorize_access_token()
    except Exception:
        # OAuth flow failed (expired code, bad state, user cancelled, etc.)
        return redirect("/login")

    email = token["userinfo"]["email"]

    if not email.endswith(f"@{ALLOWED_DOMAIN}"):
        return (
            f"<h2>Access denied</h2>"
            f"<p>{escape(email)} is not a @{ALLOWED_DOMAIN} account.</p>",
            403,
        )

    now = datetime.datetime.now(datetime.timezone.utc)
    payload = {
        "email": email,
        "name": token["userinfo"].get("name", ""),
        "exp": now + datetime.timedelta(days=TOKEN_TTL_DAYS),
        "iat": now,
    }
    session_jwt = jwt.encode(payload, JWT_SECRET, algorithm="HS256")

    next_url = _safe_next(session.pop("next", "/"))

    resp = make_response(redirect(next_url))
    resp.set_cookie(
        "session",
        session_jwt,
        **_cookie_kwargs(max_age=TOKEN_TTL_DAYS * 24 * 60 * 60),
    )
    return resp


@app.route("/logout")
def logout():
    """Clears the session cookie and redirects to login."""
    resp = make_response(redirect("/login"))
    resp.set_cookie("session", "", **_cookie_kwargs(max_age=0))
    return resp


@app.route("/verify")
def verify():
    """Access decision for Caddy's forward_auth, and a plain token check.

    Caddy treats only a 2xx as "allow"; any other response is copied verbatim to
    the browser. That is what makes the redirect below work -- an unauthenticated
    person browsing to an app gets bounced here, then to Google, then back to the
    page they originally asked for.

    A 302 would be useless to a fetch()/WebSocket caller, though (it cannot
    complete an interactive login, and cross-origin it would surface as an
    opaque CORS error), so non-navigation requests get a 401 to handle.
    """
    claims = verify_session(request.cookies.get("session") or "")

    if claims:
        email = claims.get("email", "")
        app = _requested_app()

        # Authentication passed (valid @berkeley.edu session). Some apps add an
        # authorization step -- a named allowlist -- on top. A denied user is
        # already logged in, so this is a 403, never a login bounce: re-logging
        # in would not change the answer.
        if not allowlist.is_approved(app, email):
            if _wants_interactive_login():
                return _not_approved_page(email, app), 403
            return "Forbidden", 403

        resp = make_response("OK", 200)
        # Caddy copies these upstream via copy_headers, so apps can identify the
        # caller without parsing the JWT themselves.
        resp.headers["X-Auth-Email"] = email
        resp.headers["X-Auth-User"] = claims.get("name", "")
        return resp

    if _wants_interactive_login():
        return redirect(f"{AUTH_PUBLIC_URL}/login?{urlencode({'next': _original_url()})}")
    return "Unauthorized", 401


def _not_approved_page(email: str, app: str) -> str:
    """Shown to an authenticated user who is not on an app's allowlist."""
    return (
        f"<h2>Access restricted</h2>"
        f"<p>You're signed in as {escape(email)}, but "
        f"<b>{escape(app)}</b> is limited to an approved list of users.</p>"
        f"<p>Ask an admin to add you, then reload this page.</p>"
        f"<p><a href='/logout'>Log out</a></p>"
    )


def _wants_interactive_login() -> bool:
    """True when the original request was a browser navigating to a page."""
    method = request.headers.get("X-Forwarded-Method", request.method).upper()
    if method not in ("GET", "HEAD"):
        return False
    if request.headers.get("Upgrade", "").lower() == "websocket":
        return False
    return "text/html" in request.headers.get("Accept", "")


def _original_url() -> str:
    """Rebuild the URL the browser asked for, from Caddy's forwarded headers."""
    proto = request.headers.get("X-Forwarded-Proto", "https")
    host = _forwarded_host()
    uri = request.headers.get("X-Forwarded-Uri", "/")
    return f"{proto}://{host}{uri}"


@app.route("/healthz")
def healthz():
    """Liveness probe — no auth, no dependencies."""
    return "OK", 200


@app.route("/")
def index():
    """Quick sanity-check page — shows who's logged in."""
    claims = verify_session(request.cookies.get("session") or "")
    if not claims:
        return redirect("/login")
    # Escaped: `name` is whatever the Google profile says, not something we control.
    return (
        f"<h2>✅ Logged in</h2>"
        f"<p><b>Email:</b> {escape(claims.get('email', ''))}</p>"
        f"<p><b>Name:</b> {escape(claims.get('name') or '—')}</p>"
        f"<p><a href='/logout'>Log out</a></p>"
    )


if __name__ == "__main__":
    app.run(port=5000, debug=True)
