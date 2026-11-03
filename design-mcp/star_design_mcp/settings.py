"""Everything the server reads from the environment, read once and checked at start.

There are no defaults that describe the deployment. The compose file
(docker-compose.yml, service ``design-mcp``) says where each app lives; a server
started without it refuses rather than guessing a host. An app whose URL is unset
is simply absent: its tools answer "not configured" instead of calling somewhere
plausible.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

#: The apps this server reads, and the env var naming each one's API base URL
#: (inside the compose network, e.g. http://engine-design-api:8000).
APP_URL_VARS: dict[str, str] = {
    "engine-design": "ENGINE_DESIGN_URL",
    "pid-designer": "PID_DESIGNER_URL",
    "openrocket": "OPENROCKET_URL",
    "feed-twin": "FEED_TWIN_URL",
    "daq-viewer": "DAQ_VIEWER_URL",
}


class SettingsError(RuntimeError):
    """The environment does not describe a server that can run."""


@dataclass(frozen=True)
class Settings:
    #: Where clients reach this server, e.g. https://mcp.starberkeley.org. File
    #: links are built on it, and its host is the only Host header accepted.
    public_url: str
    #: STARProject's token check (POST, see starproject/src/app/api/mcp/verify).
    verify_url: str | None
    verify_secret: str | None
    #: Development only: every request is this user and no token is checked.
    dev_email: str | None
    #: HMAC key for file links. Separate from every other secret on purpose: a
    #: leaked link key lets someone forge downloads, nothing more.
    file_key: bytes
    cache_dir: Path
    cache_max_bytes: int
    link_ttl_s: int
    #: How long a token check is trusted before asking STARProject again. This is
    #: also how long a revoked token keeps working here.
    token_cache_s: float
    #: Simultaneous exports/simulations across all users, so an agent cannot
    #: starve the web apps on the same box.
    job_concurrency: int
    #: How long a tool waits on a job before handing back its id instead. Kept
    #: well under Cloudflare's ~100 s origin timeout.
    job_inline_wait_s: float
    app_urls: dict[str, str] = field(default_factory=dict)

    @property
    def public_host(self) -> str:
        return urlparse(self.public_url).netloc


def _need(env: dict[str, str], name: str) -> str:
    value = env.get(name, "").strip()
    if not value:
        raise SettingsError(f"{name} is not set")
    return value


def load(env: dict[str, str] | None = None) -> Settings:
    env = dict(os.environ if env is None else env)
    public_url = _need(env, "DESIGN_MCP_PUBLIC_URL").rstrip("/")
    if urlparse(public_url).scheme not in ("http", "https") or not urlparse(public_url).netloc:
        raise SettingsError(f"DESIGN_MCP_PUBLIC_URL must be an http(s) URL, got {public_url!r}")

    verify_url = env.get("DESIGN_MCP_VERIFY_URL", "").strip() or None
    verify_secret = env.get("DESIGN_MCP_VERIFY_SECRET", "").strip() or None
    dev_email = env.get("DESIGN_MCP_DEV_EMAIL", "").strip().lower() or None
    if dev_email and verify_url:
        raise SettingsError(
            "DESIGN_MCP_DEV_EMAIL and DESIGN_MCP_VERIFY_URL are both set; a server either "
            "checks tokens or is a dev server, never both"
        )
    if not dev_email:
        if not verify_url or not verify_secret:
            raise SettingsError(
                "DESIGN_MCP_VERIFY_URL and DESIGN_MCP_VERIFY_SECRET are required "
                "(or DESIGN_MCP_DEV_EMAIL for a local dev server)"
            )

    file_key = _need(env, "DESIGN_MCP_FILE_KEY")
    if len(file_key) < 32:
        raise SettingsError("DESIGN_MCP_FILE_KEY must be at least 32 characters (openssl rand -hex 32)")

    def number(name: str, default: float, *, minimum: float) -> float:
        raw = env.get(name, "").strip()
        try:
            value = float(raw) if raw else default
        except ValueError as exc:
            raise SettingsError(f"{name} must be a number, got {raw!r}") from exc
        if value < minimum:
            raise SettingsError(f"{name} must be at least {minimum}, got {value}")
        return value

    app_urls = {app: env[var].strip().rstrip("/") for app, var in APP_URL_VARS.items() if env.get(var, "").strip()}
    return Settings(
        public_url=public_url,
        verify_url=verify_url,
        verify_secret=verify_secret,
        dev_email=dev_email,
        file_key=file_key.encode(),
        cache_dir=Path(_need(env, "DESIGN_MCP_CACHE_DIR")),
        cache_max_bytes=int(number("DESIGN_MCP_CACHE_MAX_BYTES", 5e9, minimum=1e6)),
        link_ttl_s=int(number("DESIGN_MCP_LINK_TTL_S", 900, minimum=30)),
        token_cache_s=number("DESIGN_MCP_TOKEN_CACHE_S", 60, minimum=0),
        job_concurrency=int(number("DESIGN_MCP_JOB_CONCURRENCY", 2, minimum=1)),
        job_inline_wait_s=number("DESIGN_MCP_JOB_INLINE_WAIT_S", 25, minimum=0),
        app_urls=app_urls,
    )
