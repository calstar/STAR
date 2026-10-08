"""Request + memory logging for the heavy model routes.

The API runs in a container with a hard memory cap and no swap. When a request
pushes it over, the kernel kills uvicorn: no traceback, no 500, Caddy answers 502
and the container restarts. The only trace left in ``docker logs`` is what was
written *before* the kill, so every heavy request logs a start line and a done
line with the container's memory. The last ``start`` with no ``done`` before a
``startup`` line is the request that took the process down.
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path

log = logging.getLogger("openrocket")
if not log.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s openrocket: %(message)s"))
    log.addHandler(_h)
    log.setLevel(logging.INFO)
    log.propagate = False

#: Paths worth a start/done pair: anything under a built model (mesh walks,
#: Barrowman sweeps, flight solves). Static assets of a model are not.
_PREFIX = "/api/models/"
_QUIET_SUFFIXES = (".glb", ".gltf", "/manifest.json")


def _cgroup_mb(name: str) -> float | None:
    """A cgroup v2 memory figure in MB (``memory.current``/``memory.max``), if readable."""
    try:
        raw = Path("/sys/fs/cgroup", name).read_text().strip()
    except OSError:
        return None
    return None if raw == "max" else int(raw) / 2**20


def _proc_mb(field: str) -> float | None:
    """``VmRSS`` / ``VmHWM`` (peak RSS) of this process in MB."""
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith(field + ":"):
                return int(line.split()[1]) / 1024
    except OSError:
        pass
    return None


def memory_summary() -> str:
    cur, cap = _cgroup_mb("memory.current"), _cgroup_mb("memory.max")
    rss, peak = _proc_mb("VmRSS"), _proc_mb("VmHWM")
    parts = []
    if cur is not None:
        parts.append(f"cgroup {cur:.0f}" + (f"/{cap:.0f} MB" if cap is not None else " MB"))
    if rss is not None:
        parts.append(f"rss {rss:.0f} MB")
    if peak is not None:
        parts.append(f"peak {peak:.0f} MB")
    return ", ".join(parts) or "memory n/a"


def log_startup() -> None:
    log.info("startup pid=%d (%s)", os.getpid(), memory_summary())


class RequestLogMiddleware:
    """Log start/done (status, seconds, memory) for heavy ``/api/models/...`` requests."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "") if scope["type"] == "http" else ""
        if not path.startswith(_PREFIX) or path.endswith(_QUIET_SUFFIXES):
            await self.app(scope, receive, send)
            return

        what = f"{scope.get('method', '?')} {path}"
        status = {"code": None}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
            await send(message)

        log.info("start %s (%s)", what, memory_summary())
        t0 = time.monotonic()
        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            log.exception("fail  %s after %.1fs (%s)", what, time.monotonic() - t0, memory_summary())
            raise
        log.info(
            "done  %s -> %s in %.1fs (%s)", what, status["code"], time.monotonic() - t0, memory_summary()
        )


def log_fin_planform(
    what: str,
    *,
    n: int,
    root: float | None,
    tip: float | None,
    sweep: float | None,
    span: float | None,
    body_length: float | None,
    body_radius: float | None,
    azimuths: list[float] | None = None,
    symmetric: bool | None = None,
) -> None:
    """One line per computed fin set, and a WARNING when it cannot be a real fin.

    A broken extraction does not raise: it returns a planform kilometres long and
    a 200, and the viewer draws it at infinity. Bound it by the rocket itself --
    no fin is longer than the body or spans more than a few body radii.
    """
    vals = {"root": root, "tip": tip, "sweep": sweep, "span": span}
    line = f"{what}: n={n} " + " ".join(
        f"{k}={v:.4g}" if v is not None else f"{k}=None" for k, v in vals.items()
    )
    if azimuths is not None:
        line += f" az={[round(a) for a in azimuths]}"
    if symmetric is not None:
        line += f" symmetric={symmetric}"

    problems = []
    for k, v in vals.items():
        if v is None or v != v or v in (float("inf"), float("-inf")):
            problems.append(f"{k} is not finite")
    if body_length:
        for k in ("root", "tip", "sweep"):
            v = vals[k]
            if v is not None and abs(v) > body_length:
                problems.append(f"|{k}| {abs(v):.4g} m exceeds the body length {body_length:.4g} m")
    if root is not None and root <= 0:
        problems.append("root chord is not positive")
    if body_radius and span is not None and span > 10 * body_radius:
        problems.append(f"span {span:.4g} m exceeds 10 body radii")
    if azimuths is not None and len(azimuths) != n:
        problems.append(f"{len(azimuths)} fin outlines for {n} fins")

    if problems:
        log.warning("%s -- implausible fin planform: %s", line, "; ".join(problems))
    else:
        log.info("%s", line)
