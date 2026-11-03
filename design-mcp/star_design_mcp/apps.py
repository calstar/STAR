"""Calls into the STAR apps, as the person whose token this request carries.

The apps implement no auth of their own: on the box, Caddy's gate sets
``X-Auth-Email`` and the apps trust it. This server reaches them on the compose
network, around Caddy, so it sets that header itself -- from the verified token
and nothing else. That is only safe because the app containers publish no ports;
the one way to an app's API from outside the box is through Caddy, which strips
any client-sent X-Auth-* (deploy/caddy/Caddyfile, ``(protected)``).

Every app decides for itself what that person may see; nothing here widens it.
"""

from __future__ import annotations

from typing import Any

import httpx
from mcp.server.mcpserver.exceptions import ToolError

from . import identity
from .settings import APP_URL_VARS

#: Generous: a slow call runs inside a job (jobs.py), not on the request.
DEFAULT_TIMEOUT_S = 600.0


class Apps:
    def __init__(self, urls: dict[str, str], *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._urls = dict(urls)
        self._client = httpx.AsyncClient(timeout=DEFAULT_TIMEOUT_S, transport=transport)

    def configured(self) -> dict[str, str]:
        return dict(self._urls)

    def base(self, app: str) -> str:
        url = self._urls.get(app)
        if not url:
            raise ToolError(f"{app} is not configured on this server ({APP_URL_VARS.get(app, '?')} is unset).")
        return url

    async def request(
        self,
        app: str,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any = None,
        timeout: float | None = None,
    ) -> httpx.Response:
        who = identity.current()
        clean = {k: v for k, v in (params or {}).items() if v is not None}
        try:
            r = await self._client.request(
                method,
                self.base(app) + path,
                params=clean,
                json=json,
                headers={"X-Auth-Email": who.email, "X-Auth-User": who.name or who.email},
                timeout=timeout or DEFAULT_TIMEOUT_S,
            )
        except httpx.TimeoutException as exc:
            raise ToolError(f"{app} did not answer {method} {path} in time.") from exc
        except httpx.HTTPError as exc:
            raise ToolError(f"{app} could not be reached ({exc.__class__.__name__}).") from exc
        if r.status_code >= 400:
            raise ToolError(f"{app} answered {r.status_code} to {method} {path}: {_detail(r)}")
        return r

    async def get_json(self, app: str, path: str, **params: Any) -> Any:
        return (await self.request(app, "GET", path, params=params)).json()

    async def post_json(self, app: str, path: str, body: Any, *, timeout: float | None = None, **params: Any) -> Any:
        return (await self.request(app, "POST", path, params=params, json=body, timeout=timeout)).json()

    async def stream_to(
        self, app: str, path: str, sink, *, params: dict[str, Any] | None = None, method: str = "GET", json: Any = None
    ) -> httpx.Headers:
        """Stream a response body into ``sink`` (a binary file) without holding it in memory."""
        who = identity.current()
        clean = {k: v for k, v in (params or {}).items() if v is not None}
        try:
            async with self._client.stream(
                method,
                self.base(app) + path,
                params=clean,
                json=json,
                headers={"X-Auth-Email": who.email, "X-Auth-User": who.name or who.email},
            ) as r:
                if r.status_code >= 400:
                    await r.aread()
                    raise ToolError(f"{app} answered {r.status_code} to {method} {path}: {_detail(r)}")
                async for chunk in r.aiter_bytes():
                    sink.write(chunk)
                return r.headers
        except httpx.HTTPError as exc:
            raise ToolError(f"{app} failed while sending {path} ({exc.__class__.__name__}).") from exc

    async def aclose(self) -> None:
        await self._client.aclose()


def _detail(r: httpx.Response) -> str:
    try:
        body = r.json()
    except ValueError:
        return r.text[:500] or r.reason_phrase
    if isinstance(body, dict) and "detail" in body:
        return str(body["detail"])[:500]
    return str(body)[:500]
