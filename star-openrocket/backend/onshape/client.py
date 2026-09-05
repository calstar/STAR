"""Rate-limited, disk-cached HTTP client for the Onshape REST API.

Every response is written to disk before it is parsed. A rebuild of the same
document microversion therefore issues zero API calls, which matters because
tessellation responses are multi-megabyte and the rate limit is real.

Credentials come from the environment and are never written to the cache, the
manifest, or anything the browser can reach.
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence, TypeVar

import httpx

# Pinned per orkv2.md 4.2. Mixing API versions across endpoints produces subtle
# schema differences, so this is the single place the version is chosen.
DEFAULT_BASE_URL = "https://starberkeley.onshape.com/api/v12"

# Onshape starts shedding load well before the limit actually hits zero, so back
# off while there is still headroom rather than waiting for a 429.
RATE_LIMIT_FLOOR = 20
MAX_CONCURRENCY = 4
MAX_RETRIES = 5

T = TypeVar("T")


class OnshapeError(RuntimeError):
    """An Onshape API call failed in a way retrying will not fix."""


class MissingCredentials(OnshapeError):
    pass


def _redact(text: str) -> str:
    """Strip credentials out of anything headed for a log or an exception."""
    for var in ("ONSHAPE_ACCESS_KEY", "ONSHAPE_SECRET_KEY"):
        secret = os.environ.get(var)
        if secret:
            text = text.replace(secret, f"<{var}>")
    return text


class OnshapeClient:
    """Thread-safe Onshape client with a request-keyed disk cache.

    Args:
        cache_dir: directory for raw JSON responses. ``None`` disables caching,
            which is only appropriate for tests.
        offline: refuse to make network calls; serve cache or raise. Used by the
            "a rebuild issues zero API calls" check.
    """

    def __init__(
        self,
        cache_dir: Path | None = None,
        base_url: str | None = None,
        offline: bool = False,
    ) -> None:
        self.base_url = (base_url or os.environ.get("ONSHAPE_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.cache_dir = cache_dir
        self.offline = offline

        self._lock = threading.Lock()
        self.call_count = 0
        self.cache_hits = 0
        self.retry_count = 0
        self._rate_remaining: int | None = None
        self._client: httpx.Client | None = None

        if cache_dir is not None:
            cache_dir.mkdir(parents=True, exist_ok=True)

    # -- credentials ----------------------------------------------------------

    @staticmethod
    def _auth() -> tuple[str, str]:
        access = os.environ.get("ONSHAPE_ACCESS_KEY")
        secret = os.environ.get("ONSHAPE_SECRET_KEY")
        if not access or not secret:
            raise MissingCredentials(
                "ONSHAPE_ACCESS_KEY and ONSHAPE_SECRET_KEY must be set. "
                "Get a key pair from https://dev-portal.onshape.com and put them "
                "in the stack's .env (the shared root .env, alongside JWT_SECRET "
                "and the AWS_* keys), then recreate the container; or export them."
            )
        return access, secret

    def _http(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(
                auth=self._auth(),
                headers={"Accept": "application/json"},
                # Tessellation responses run to tens of MB on real assemblies.
                timeout=httpx.Timeout(30.0, read=300.0),
                follow_redirects=True,
            )
        return self._client

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    def __enter__(self) -> "OnshapeClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- caching --------------------------------------------------------------

    def _cache_path(self, path: str, params: dict[str, Any] | None) -> Path | None:
        if self.cache_dir is None:
            return None
        # The digest covers the full request so that two calls differing only by
        # a query parameter (massAsGroup, configuration, ...) never collide.
        canonical = path + "?" + urllib.parse.urlencode(sorted((params or {}).items()), doseq=True)
        digest = hashlib.sha256(canonical.encode()).hexdigest()[:16]

        # Keep a human-readable stem so the cache can be inspected by hand. The
        # endpoint name is the last segment and is the most useful part of it,
        # so truncation has to preserve it -- otherwise an assembly definition
        # and its massproperties response produce identical stems.
        segments = path.strip("/").split("/")
        stem = "_".join(segments)
        if len(stem) > 80:
            stem = f"{stem[:60]}_{segments[-1]}"
        return self.cache_dir / f"{stem}__{digest}.json"

    # -- requests -------------------------------------------------------------

    def get_json(self, path: str, params: dict[str, Any] | None = None) -> Any:
        """GET an API path relative to the pinned base URL, with caching.

        `params` values that are ``None`` are dropped, so callers can pass
        optional arguments like ``linkDocumentId`` unconditionally.
        """
        params = {k: v for k, v in (params or {}).items() if v is not None}
        cache_path = self._cache_path(path, params)

        if cache_path is not None and cache_path.exists():
            with self._lock:
                self.cache_hits += 1
            return json.loads(cache_path.read_text())

        if self.offline:
            raise OnshapeError(f"offline=True but {path} is not cached")

        payload = self._get_with_retry(path, params)

        if cache_path is not None:
            # Write via a temp file so an interrupted build cannot leave a
            # truncated response behind that later looks like a valid cache hit.
            tmp = cache_path.with_suffix(".partial")
            tmp.write_text(json.dumps(payload))
            tmp.replace(cache_path)

        return payload

    def _get_with_retry(self, path: str, params: dict[str, Any]) -> Any:
        url = f"{self.base_url}/{path.lstrip('/')}"
        client = self._http()

        for attempt in range(MAX_RETRIES):
            self._throttle()
            try:
                response = client.get(url, params=params)
            except httpx.RequestError as exc:
                if attempt == MAX_RETRIES - 1:
                    raise OnshapeError(_redact(f"GET {path} failed: {exc}")) from exc
                self._sleep_backoff(attempt)
                continue

            with self._lock:
                self.call_count += 1
                remaining = response.headers.get("X-Rate-Limit-Remaining")
                if remaining is not None:
                    try:
                        self._rate_remaining = int(remaining)
                    except ValueError:
                        pass

            if response.status_code == 429 or response.status_code >= 500:
                if attempt == MAX_RETRIES - 1:
                    raise OnshapeError(
                        _redact(f"GET {path} -> HTTP {response.status_code} after {MAX_RETRIES} attempts")
                    )
                with self._lock:
                    self.retry_count += 1
                self._sleep_backoff(attempt, response.headers.get("Retry-After"))
                continue

            if response.status_code >= 400:
                raise OnshapeError(
                    _redact(f"GET {path} -> HTTP {response.status_code}: {response.text[:400]}")
                )

            return response.json()

        raise OnshapeError(f"GET {path} exhausted retries")

    def _throttle(self) -> None:
        """Slow down while the remaining-call budget is low."""
        with self._lock:
            remaining = self._rate_remaining
        if remaining is not None and remaining < RATE_LIMIT_FLOOR:
            time.sleep(1.0 + random.random())

    @staticmethod
    def _sleep_backoff(attempt: int, retry_after: str | None = None) -> None:
        if retry_after:
            try:
                time.sleep(min(float(retry_after), 60.0))
                return
            except ValueError:
                pass
        # Exponential with jitter, so parallel workers do not resynchronise on
        # the same retry instant and re-trigger the limit together.
        time.sleep(min(2.0**attempt, 30.0) + random.random())

    # -- parallelism ----------------------------------------------------------

    def map_parallel(self, fn: Callable[[T], Any], items: Sequence[T]) -> list[Any]:
        """Apply `fn` across `items` with the concurrency cap, preserving order."""
        if not items:
            return []
        workers = min(MAX_CONCURRENCY, len(items))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            return list(pool.map(fn, items))

    # -- reporting ------------------------------------------------------------

    def stats(self) -> dict[str, int | None]:
        with self._lock:
            return {
                "apiCalls": self.call_count,
                "cacheHits": self.cache_hits,
                "retries": self.retry_count,
                "rateLimitRemaining": self._rate_remaining,
            }
