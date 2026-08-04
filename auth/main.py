"""Central auth service for STAR internal tools.

Handles Google OAuth, mints a JWT stored in a .starberkeley.org domain cookie,
and restricts access to @berkeley.edu accounts.

Run with:
    cd auth
    flask run --port 5000

Required env vars (see .env.example):
    GOOGLE_CLIENT_ID
    GOOGLE_CLIENT_SECRET
    JWT_SECRET          -- shared with all apps that verify the cookie
    FLASK_SECRET_KEY    -- used by Flask for session state during OAuth flow
"""

import os
import datetime

import jwt
from authlib.integrations.flask_client import OAuth
from dotenv import load_dotenv
from flask import Flask, make_response, redirect, request

load_dotenv()

app = Flask(__name__)
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
IS_PROD = os.environ.get("FLASK_ENV", "production") == "production"

oauth = OAuth(app)
google = oauth.register(
    name="google",
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid email profile"},
)


def _is_prod_request() -> bool:
    """Check if the current request is coming through the production domain."""
    host = request.headers.get("X-Forwarded-Host", request.host).split(":")[0]
    return host.endswith("starberkeley.org")


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


@app.route("/login")
def login():
    """Redirect to Google OAuth. Passes the destination URL as OAuth state."""
    next_url = request.args.get("next", "/")
    redirect_uri = _callback_url()
    return google.authorize_redirect(redirect_uri, state=next_url)


@app.route("/callback")
def callback():
    """Google redirects here after login. Validates email, mints JWT, sets cookie."""
    try:
        token = google.authorize_access_token()
    except Exception:
        # OAuth flow failed (expired code, bad state, user cancelled, etc.)
        return redirect("/login")

    email = token["userinfo"]["email"]

    if not email.endswith(f"@{ALLOWED_DOMAIN}"):
        return (
            f"<h2>Access denied</h2><p>{email} is not a @{ALLOWED_DOMAIN} account.</p>",
            403,
        )

    payload = {
        "email": email,
        "name": token["userinfo"].get("name", ""),
        "exp": datetime.datetime.utcnow() + datetime.timedelta(days=TOKEN_TTL_DAYS),
        "iat": datetime.datetime.utcnow(),
    }
    session_jwt = jwt.encode(payload, JWT_SECRET, algorithm="HS256")

    next_url = request.args.get("state", "/")
    # Reject open redirects — only allow relative paths or same-domain URLs
    if next_url.startswith("http") and COOKIE_DOMAIN.lstrip(".") not in next_url:
        next_url = "/"

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
    """
    Lightweight token check for use with Caddy forward_auth or health checks.
    Returns 200 if valid, 401 if missing/expired.
    Does NOT redirect — callers should redirect to /login on 401.
    """
    token = request.cookies.get("session")
    if not token:
        return "Unauthorized", 401
    try:
        jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        return "OK", 200
    except jwt.ExpiredSignatureError:
        return "Token expired", 401
    except jwt.InvalidTokenError:
        return "Invalid token", 401


@app.route("/")
def index():
    """Quick sanity-check page — shows who's logged in."""
    token = request.cookies.get("session")
    if not token:
        return redirect("/login")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        return (
            f"<h2>✅ Logged in</h2>"
            f"<p><b>Email:</b> {payload['email']}</p>"
            f"<p><b>Name:</b> {payload.get('name', '—')}</p>"
            f"<p><a href='/logout'>Log out</a></p>"
        )
    except jwt.PyJWTError:
        return redirect("/login")


def _callback_url() -> str:
    if _is_prod_request():
        return "https://auth.starberkeley.org/callback"
    scheme = "https" if request.is_secure else "http"
    return f"{scheme}://{request.host}/callback"


if __name__ == "__main__":
    app.run(port=5000, debug=True)
