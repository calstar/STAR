"""Slow work runs as a job, so no tool call blocks past Cloudflare's timeout.

The box is reachable only through a Cloudflare tunnel, which gives up on an origin
that has not started answering in ~100 s (a 524). An export of a multi-GB DAQ run
or a 6-DOF flight can take longer than that, so such a tool submits a job, waits
up to ``job_inline_wait_s`` for it, and if it is still running hands back
``{"job_id", "status"}`` for ``job_status`` to collect.

At most ``job_concurrency`` jobs run at once across everyone -- the apps on this
box serve the web UI from the same CPU. Jobs live in this process only: a restart
loses them, and the tool is simply called again.
"""

from __future__ import annotations

import asyncio
import contextvars
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from mcp.server.mcpserver.exceptions import ToolError

from . import identity

KEEP_FINISHED_S = 3600.0
MAX_JOBS_PER_PERSON = 20


@dataclass
class Job:
    id: str
    owner: str
    kind: str
    started: float
    status: str = "queued"  # queued | running | done | error
    finished: float | None = None
    result: Any = None
    error: str | None = None
    task: asyncio.Task | None = field(default=None, repr=False)

    def view(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "job_id": self.id,
            "kind": self.kind,
            "status": self.status,
            "elapsed_s": round((self.finished or time.time()) - self.started, 1),
        }
        if self.status == "done":
            out["result"] = self.result
        elif self.status == "error":
            out["error"] = self.error
        else:
            out["next"] = "Call job_status with this job_id in a little while."
        return out


class Jobs:
    def __init__(self, concurrency: int, inline_wait_s: float) -> None:
        self._gate = asyncio.Semaphore(concurrency)
        self._inline_wait_s = inline_wait_s
        self._jobs: dict[str, Job] = {}

    async def run(self, kind: str, work: Callable[[], Awaitable[Any]]) -> Any:
        """Start ``work`` as a job and wait for it briefly. Finished in time: its result, exactly
        as the work returned it (or its error, raised). Still going: ``{"job_id", "status", ...}``."""
        job = self.submit(kind, work)
        view = await self.wait(job.id, self._inline_wait_s)
        if job.status == "done":
            return job.result
        if job.status == "error":
            raise ToolError(job.error or "the job failed")
        return view

    def submit(self, kind: str, work: Callable[[], Awaitable[Any]]) -> Job:
        self._prune()
        who = identity.current()
        live = [j for j in self._jobs.values() if j.owner == who.email and j.status in ("queued", "running")]
        if len(live) >= MAX_JOBS_PER_PERSON:
            raise ToolError(f"You already have {len(live)} jobs running; wait for some to finish.")
        job = Job(id="job_" + secrets.token_urlsafe(9), owner=who.email, kind=kind, started=time.time())

        async def body() -> None:
            async with self._gate:
                job.status = "running"
                try:
                    job.result = await work()
                    job.status = "done"
                except ToolError as exc:
                    job.status, job.error = "error", str(exc)
                except Exception as exc:  # noqa: BLE001 -- reported to the caller, not swallowed
                    job.status, job.error = "error", f"{exc.__class__.__name__}: {exc}"
                finally:
                    job.finished = time.time()

        # The identity contextvar travels with the task, so the work calls the
        # apps as the person who asked.
        job.task = asyncio.get_running_loop().create_task(body(), context=contextvars.copy_context())
        self._jobs[job.id] = job
        return job

    async def wait(self, job_id: str, timeout: float) -> dict[str, Any]:
        job = self.get(job_id)
        if job.task is not None and not job.task.done() and timeout > 0:
            try:
                await asyncio.wait_for(asyncio.shield(job.task), timeout)
            except asyncio.TimeoutError:
                pass
        return job.view()

    def get(self, job_id: str) -> Job:
        job = self._jobs.get(job_id)
        # Someone else's job is reported exactly like a job that does not exist.
        if job is None or job.owner != identity.current().email:
            raise ToolError(f"No job {job_id!r} (jobs are kept for an hour after they finish).")
        return job

    def mine(self) -> list[dict[str, Any]]:
        who = identity.current().email
        return [
            {k: v for k, v in j.view().items() if k != "result"}
            for j in sorted(self._jobs.values(), key=lambda j: -j.started)
            if j.owner == who
        ]

    def _prune(self) -> None:
        cutoff = time.time() - KEEP_FINISHED_S
        for jid in [j.id for j in self._jobs.values() if j.finished and j.finished < cutoff]:
            del self._jobs[jid]
