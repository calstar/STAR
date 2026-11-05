"""Large results leave as links, never as bytes in a tool result.

A tool that produces a file (an export, a parquet, a GLB) stores it here and
hands back a *file handle*::

    {"url": ".../files/<token>", "expires_at": ..., "filename", "size", "sha256", "mime"}

The token is ``<payload>.<hmac>``: the payload names the file, the person it was
issued to and an expiry, and is signed with ``DESIGN_MCP_FILE_KEY``. Anyone
holding the link can download until it expires -- that is what lets an agent in a
sandbox ``curl`` it with no token -- so links are short-lived and every download
is logged with the person it was issued to.

Bytes are kept once per content hash under ``cache_dir/blobs``, with a size cap
enforced oldest-first. A cache entry is only ever reached through a key that
includes the person it was produced for (``memo_key``), so a cached export is
never a way around the app's own permission check.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import IO, Any, Callable

from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response

log = logging.getLogger(__name__)

_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


@dataclass(frozen=True)
class StoredFile:
    sha256: str
    filename: str
    mime: str
    size: int


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def safe_filename(name: str) -> str:
    cleaned = _SAFE_NAME.sub("_", name).strip("._") or "file"
    return cleaned[:120]


class FileStore:
    def __init__(
        self,
        root: Path,
        *,
        key: bytes,
        public_url: str,
        max_bytes: int,
        ttl_s: int,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.root = root
        self._blobs = root / "blobs"
        self._memo = root / "memo"
        self._tmp = root / "tmp"
        for d in (self._blobs, self._memo, self._tmp):
            d.mkdir(parents=True, exist_ok=True)
        self._key = key
        self._public_url = public_url.rstrip("/")
        self._max_bytes = max_bytes
        self._ttl_s = ttl_s
        self._clock = clock

    # ── storing ──────────────────────────────────────────────────────────

    def new_temp(self) -> tuple[IO[bytes], Path]:
        """A temp file on the cache volume, to stream a large body into."""
        fd, name = tempfile.mkstemp(dir=self._tmp)
        return os.fdopen(fd, "wb"), Path(name)

    def adopt(self, path: Path, filename: str, mime: str) -> StoredFile:
        """Move a finished temp file into the store under its content hash."""
        digest = hashlib.sha256()
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                digest.update(chunk)
        sha = digest.hexdigest()
        blob = self._blobs / sha
        if blob.exists():
            path.unlink()
        else:
            os.replace(path, blob)
        os.utime(blob)
        self._evict()
        return StoredFile(sha256=sha, filename=safe_filename(filename), mime=mime, size=blob.stat().st_size)

    def put_bytes(self, data: bytes, filename: str, mime: str) -> StoredFile:
        f, path = self.new_temp()
        with f:
            f.write(data)
        return self.adopt(path, filename, mime)

    def path_of(self, stored: StoredFile) -> Path | None:
        blob = self._blobs / stored.sha256
        return blob if blob.exists() else None

    def read_bytes(self, stored: StoredFile) -> bytes | None:
        path = self.path_of(stored)
        return path.read_bytes() if path else None

    # ── memo: "this export, for this person, is that file" ───────────────

    @staticmethod
    def memo_key(email: str, *parts: Any) -> str:
        return hashlib.sha256(json.dumps([email, *parts], sort_keys=True, default=str).encode()).hexdigest()

    def memo_get(self, key: str) -> StoredFile | None:
        path = self._memo / f"{key}.json"
        try:
            stored = StoredFile(**json.loads(path.read_text()))
        except (OSError, ValueError, TypeError):
            return None
        if self.path_of(stored) is None:
            return None
        os.utime(self._blobs / stored.sha256)
        return stored

    def memo_put(self, key: str, stored: StoredFile) -> None:
        (self._memo / f"{key}.json").write_text(json.dumps(asdict(stored)))

    # ── links ────────────────────────────────────────────────────────────

    def link(self, stored: StoredFile, email: str) -> dict[str, Any]:
        expires = int(self._clock()) + self._ttl_s
        payload = _b64(
            json.dumps(
                {"h": stored.sha256, "n": stored.filename, "m": stored.mime, "u": email, "e": expires},
                separators=(",", ":"),
            ).encode()
        )
        token = f"{payload}.{self._sign(payload)}"
        return {
            "url": f"{self._public_url}/files/{token}",
            "expires_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(expires)),
            "filename": stored.filename,
            "size": stored.size,
            "sha256": stored.sha256,
            "mime": stored.mime,
            "note": "A short-lived link: download it with curl/wget (no auth header needed) before it expires.",
        }

    def _sign(self, payload: str) -> str:
        return _b64(hmac.new(self._key, payload.encode(), hashlib.sha256).digest())

    def open_link(self, token: str) -> tuple[Path, dict[str, Any]] | str:
        """The file a link names, or why it cannot be served."""
        payload, _, sig = token.partition(".")
        if not payload or not sig or not hmac.compare_digest(sig, self._sign(payload)):
            return "invalid link"
        try:
            claims = json.loads(_unb64(payload))
        except ValueError:
            return "invalid link"
        if int(claims.get("e", 0)) < self._clock():
            return "link expired"
        blob = self._blobs / str(claims.get("h", ""))
        if not re.fullmatch(r"[0-9a-f]{64}", str(claims.get("h", ""))) or not blob.exists():
            return "file no longer cached; ask the tool for it again"
        return blob, claims

    async def serve(self, request: Request) -> Response:
        opened = self.open_link(request.path_params["token"])
        if isinstance(opened, str):
            status = 410 if opened.startswith(("link expired", "file no longer")) else 403
            return JSONResponse({"error": opened}, status_code=status)
        blob, claims = opened
        os.utime(blob)
        log.info(
            "download %s (%s, %d bytes) issued to %s range=%s",
            claims["n"],
            claims["h"][:12],
            blob.stat().st_size,
            claims["u"],
            request.headers.get("range", "-"),
        )
        return FileResponse(blob, media_type=claims["m"], filename=claims["n"])

    # ── size cap ─────────────────────────────────────────────────────────

    def _evict(self) -> None:
        blobs = [(p.stat().st_mtime, p.stat().st_size, p) for p in self._blobs.iterdir() if p.is_file()]
        total = sum(size for _, size, _ in blobs)
        if total <= self._max_bytes:
            return
        for _, size, path in sorted(blobs):
            if total <= self._max_bytes:
                break
            try:
                path.unlink()
                total -= size
            except OSError:
                pass
        # Stale temp files from a crashed export.
        cutoff = self._clock() - 3600
        for p in self._tmp.iterdir():
            try:
                if p.stat().st_mtime < cutoff:
                    p.unlink()
            except OSError:
                pass
