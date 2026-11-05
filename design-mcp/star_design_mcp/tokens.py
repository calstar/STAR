"""Token checks, answered by STARProject.

People mint one token in STARProject (Settings -> API tokens, "Design tools"
ticked); this server holds none. For each token it asks
``POST {verify_url}`` with the shared secret and caches the answer:

- a yes for ``token_cache_s`` (60 s): the cost is that a revoked token keeps
  working here for up to that long;
- a no for a few seconds, so a client retrying a bad token does not become a
  stream of requests to EC2.

If STARProject cannot be reached the request is refused. There is no "last good
answer" grace: a token we cannot check is a token we do not honour.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from dataclasses import dataclass

import httpx

from .identity import Identity

log = logging.getLogger(__name__)

SCOPE = "design"
NEGATIVE_CACHE_S = 5.0
MAX_CACHE_ENTRIES = 10_000


@dataclass(frozen=True)
class Refusal:
    #: missing | malformed | unknown | revoked | scope | unavailable
    reason: str

    @property
    def message(self) -> str:
        return {
            "missing": "Send `Authorization: Bearer sp_…`, a STARProject token with Design tools ticked.",
            "malformed": "That is not a STARProject token (sp_…).",
            "unknown": "STARProject does not know that token.",
            "revoked": "That token was revoked in STARProject.",
            "scope": "That token does not open the design tools. Mint one in STARProject → Settings → "
            "API tokens with Design tools ticked.",
            "unavailable": "STARProject could not be reached to check the token; try again shortly.",
        }.get(self.reason, "The token was refused.")


def _key(token: str) -> str:
    # The cache never holds a token, only its hash.
    return hashlib.sha256(token.encode()).hexdigest()


class TokenVerifier:
    def __init__(
        self,
        verify_url: str,
        secret: str,
        *,
        cache_s: float,
        client: httpx.AsyncClient | None = None,
        clock=time.monotonic,
    ) -> None:
        self._url = verify_url
        self._secret = secret
        self._cache_s = cache_s
        self._client = client or httpx.AsyncClient(timeout=10.0)
        self._clock = clock
        self._cache: dict[str, tuple[float, Identity | Refusal]] = {}
        self._lock = asyncio.Lock()

    async def check(self, token: str | None) -> Identity | Refusal:
        if not token:
            return Refusal("missing")
        if not token.startswith("sp_") or len(token) < 20:
            return Refusal("malformed")
        key = _key(token)
        now = self._clock()
        hit = self._cache.get(key)
        if hit is not None and hit[0] > now:
            return hit[1]

        answer = await self._ask(token)
        if not (isinstance(answer, Refusal) and answer.reason == "unavailable"):
            ttl = self._cache_s if isinstance(answer, Identity) else NEGATIVE_CACHE_S
            async with self._lock:
                if len(self._cache) >= MAX_CACHE_ENTRIES:
                    self._cache = {k: v for k, v in self._cache.items() if v[0] > now}
                    if len(self._cache) >= MAX_CACHE_ENTRIES:
                        self._cache.clear()
                self._cache[key] = (now + ttl, answer)
        return answer

    async def _ask(self, token: str) -> Identity | Refusal:
        try:
            r = await self._client.post(
                self._url,
                json={"token": token, "scope": SCOPE},
                headers={"X-Internal-Secret": self._secret},
            )
        except httpx.HTTPError as exc:
            log.warning("token check: STARProject unreachable: %s", exc)
            return Refusal("unavailable")
        if r.status_code == 200:
            try:
                body = r.json()
                return Identity(
                    email=str(body["email"]).strip().lower(),
                    name=str(body.get("name") or ""),
                    token_id=str(body["tokenId"]),
                )
            except (ValueError, KeyError, TypeError):
                log.error("token check: unreadable 200 from STARProject: %r", r.text[:200])
                return Refusal("unavailable")
        if r.status_code == 401:
            try:
                return Refusal(str(r.json().get("reason") or "unknown"))
            except ValueError:
                return Refusal("unknown")
        # 403 means *our* secret is wrong: a deployment fault, said loudly, and
        # never cached as the token's fault.
        log.error("token check: STARProject answered %s: %r", r.status_code, r.text[:200])
        return Refusal("unavailable")


class DevVerifier:
    """A dev server: everyone is DESIGN_MCP_DEV_EMAIL, no token needed."""

    def __init__(self, email: str) -> None:
        self._who = Identity(email=email, name=email.split("@")[0], token_id="dev")

    async def check(self, token: str | None) -> Identity | Refusal:
        return self._who
