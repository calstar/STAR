"""The server: an MCP endpoint at /mcp and file downloads at /files/{token}.

    POST /mcp            Streamable HTTP, stateless, JSON responses (like
                         STARProject's /api/mcp). Needs `Authorization: Bearer sp_…`,
                         a STARProject token with the "design" scope.
    GET  /files/{token}  a signed, short-lived download (files.py). No bearer: the
                         link is the credential, so an agent's sandbox can curl it.
    GET  /healthz        liveness, no auth, says nothing about anyone.
    GET  /.well-known/oauth-protected-resource[/mcp]
                         RFC 9728 metadata naming STARProject as the OAuth
                         authorization server, for clients that cannot send a
                         header token (claude.ai connectors). Every 401 points here.

Everything else answers 404.
"""

from __future__ import annotations

import contextlib
import json
import logging
from typing import Any

from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.types import ASGIApp, Receive, Scope, Send

from . import identity
from .apps import Apps
from .files import FileStore
from .jobs import Jobs
from .settings import Settings
from .tables import Tables
from .tokens import DevVerifier, Identity, Refusal, TokenVerifier
from .tools import Ctx, register_all

log = logging.getLogger(__name__)

INSTRUCTIONS = """\
STAR design tools: read-only access to the team's design apps as the token's owner -- saved designs
(EngineDesign, pid-designer, star-openrocket), Layer X burns, feed-twin run records, DAQ test-stand
runs, and star-openrocket simulations.

Results are kept small on purpose. Start from summaries; ask table_series / daq_series for a
window of a few signals; table_plot / daq_plot to look at one; and take files (exports, parquet,
.ork, .glb) as short-lived download links -- curl them, never ask for raw bytes. A slow call comes
back as a job_id: poll job_status.
"""


class BearerAuth:
    """Admit /mcp only with a token STARProject vouches for; bind its owner for the tools."""

    def __init__(
        self, app: ASGIApp, verifier: TokenVerifier | DevVerifier, resource_metadata: str | None = None
    ) -> None:
        self.app = app
        self.verifier = verifier
        challenge = 'Bearer realm="star-design-mcp"'
        if resource_metadata:
            challenge += f', resource_metadata="{resource_metadata}"'
        self.challenge = challenge.encode()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith("/mcp"):
            await self.app(scope, receive, send)
            return
        headers = {k.decode().lower(): v.decode() for k, v in scope["headers"]}
        token = _bearer(headers.get("authorization"))
        answer = await self.verifier.check(token)
        if isinstance(answer, Refusal):
            status = 503 if answer.reason == "unavailable" else 401
            body = json.dumps({"error": "unauthorized", "reason": answer.reason, "hint": answer.message}).encode()
            await send(
                {
                    "type": "http.response.start",
                    "status": status,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"www-authenticate", self.challenge),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})
            return
        assert isinstance(answer, Identity)
        bound = identity.bind(answer)
        try:
            await self.app(scope, receive, send)
        finally:
            identity.unbind(bound)


def _bearer(header: str | None) -> str | None:
    parts = (header or "").split()
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1]
    return None


def build(settings: Settings, *, apps: Apps | None = None, verifier: Any = None) -> Starlette:
    files = FileStore(
        settings.cache_dir,
        key=settings.file_key,
        public_url=settings.public_url,
        max_bytes=settings.cache_max_bytes,
        ttl_s=settings.link_ttl_s,
    )
    ctx = Ctx(
        settings=settings,
        apps=apps or Apps(settings.app_urls),
        files=files,
        tables=Tables(files),
        jobs=Jobs(settings.job_concurrency, settings.job_inline_wait_s),
    )
    if verifier is None:
        if settings.dev_email:
            log.warning("DEV SERVER: no token checks; every request is %s", settings.dev_email)
            verifier = DevVerifier(settings.dev_email)
        else:
            assert settings.verify_url and settings.verify_secret
            verifier = TokenVerifier(settings.verify_url, settings.verify_secret, cache_s=settings.token_cache_s)

    server = MCPServer("star-design", instructions=INSTRUCTIONS)
    register_all(server, ctx)
    mcp_app = server.streamable_http_app(
        streamable_http_path="/mcp",
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(
            allowed_hosts=[
                settings.public_host,
                "localhost",
                "127.0.0.1",
                "localhost:*",
                "127.0.0.1:*",
                "design-mcp:*",
                "design-mcp",
            ],
        ),
    )

    async def healthz(request: Request) -> Response:
        return JSONResponse({"ok": True})

    metadata_url = f"{settings.public_url}/.well-known/oauth-protected-resource/mcp" if settings.auth_server else None

    async def protected_resource(request: Request) -> Response:
        if not settings.auth_server:
            return JSONResponse({"error": "not_found"}, status_code=404)
        return JSONResponse(
            {
                "resource": f"{settings.public_url}/mcp",
                "authorization_servers": [settings.auth_server],
                "scopes_supported": ["design"],
                "bearer_methods_supported": ["header"],
            },
            headers={"Access-Control-Allow-Origin": "*"},
        )

    @contextlib.asynccontextmanager
    async def lifespan(app: Starlette):
        async with mcp_app.router.lifespan_context(mcp_app):
            yield
        await ctx.apps.aclose()

    app = Starlette(
        routes=[
            Route("/healthz", healthz),
            Route("/.well-known/oauth-protected-resource", protected_resource),
            Route("/.well-known/oauth-protected-resource/mcp", protected_resource),
            Route("/files/{token}", files.serve, methods=["GET", "HEAD"]),
            Mount("/", app=mcp_app),
        ],
        lifespan=lifespan,
    )
    app.add_middleware(BearerAuth, verifier=verifier, resource_metadata=metadata_url)
    app.state.ctx = ctx
    return app
