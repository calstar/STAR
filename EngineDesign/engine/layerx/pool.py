"""The worker pool every multi-burn Layer X job uses: the optimiser, the trade study and the sweep.

Each job used to build its own ``ProcessPoolExecutor`` with its own copy of the setup, the card
seeding and the shutdown, and two of the three waited for a burn to finish (one to two minutes
flown) before noticing a cancel. One pool here: spawned workers seeded with the parent's engine
cards, a map that wakes every half second to look for a cancel, and a shutdown that terminates
the workers on one.
"""

from __future__ import annotations

import os
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple


class Cancelled(RuntimeError):
    """The job was cancelled. Raised, never returned; the router reports it as cancelled and any
    other exception as a failure."""

    def __init__(self, message: str = "cancelled") -> None:
        super().__init__(message)


#: How often a wait looks for a cancel [s].
POLL_S = 0.5


def _init_worker(cards: List[Tuple[Any, Any]]) -> None:
    """Seed this process's card cache with the parent's cards, so a worker reuses them."""
    from engine.layerx import card as _card

    for key, value in cards:
        _card._CACHE[key] = value


def default_workers(tasks: int, cap: Optional[int] = None) -> int:
    """One per core less one for the server, never more than there are tasks."""
    return max(1, min(cap or max((os.cpu_count() or 2) - 1, 1), max(tasks, 1)))


class WorkerPool:
    """Spawned workers for whole burns. ``with WorkerPool(n) as pool: pool.map(fn, args, ...)``.

    With one worker, or where processes cannot be spawned (a sandbox), it runs in this process.
    """

    def __init__(self, workers: int) -> None:
        from concurrent.futures import ProcessPoolExecutor
        from multiprocessing import get_context

        from engine.layerx import card as _card

        self.workers = max(1, int(workers))
        self._executor: Any = None
        if self.workers > 1:
            try:
                self._executor = ProcessPoolExecutor(max_workers=self.workers, mp_context=get_context("spawn"),
                                                     initializer=_init_worker, initargs=(list(_card._CACHE.items()),))
            except (PermissionError, OSError):
                self._executor = None
        self._cancelled = False

    @property
    def parallel(self) -> bool:
        return self._executor is not None

    def map(self, fn: Callable[[Any], Dict[str, Any]], args: Sequence[Any], *,
            cancelled: Callable[[], bool] = lambda: False,
            on_result: Optional[Callable[[int, Dict[str, Any]], None]] = None) -> List[Dict[str, Any]]:
        """``fn`` over ``args``, results in order. ``on_result(done_count, result)`` as each lands.
        Raises :class:`Cancelled` within ``POLL_S`` of ``cancelled()`` turning true."""
        out: List[Optional[Dict[str, Any]]] = [None] * len(args)
        if self._executor is None:
            for k, a in enumerate(args):
                if cancelled():
                    self._cancelled = True
                    raise Cancelled()
                out[k] = fn(a)
                if on_result:
                    on_result(k + 1, out[k])  # type: ignore[arg-type]
            return out  # type: ignore[return-value]
        from concurrent.futures import FIRST_COMPLETED, wait

        futures = {self._executor.submit(fn, a): k for k, a in enumerate(args)}
        pending = set(futures)
        done_count = 0
        while pending:
            finished, pending = wait(pending, timeout=POLL_S, return_when=FIRST_COMPLETED)
            for fut in finished:
                k = futures[fut]
                out[k] = fut.result()
                done_count += 1
                if on_result:
                    on_result(done_count, out[k])  # type: ignore[arg-type]
            if pending and cancelled():
                for fut in pending:
                    fut.cancel()
                self._cancelled = True
                raise Cancelled()
        return out  # type: ignore[return-value]

    def close(self, cancelled: bool = False) -> None:
        """Shut the workers down. On a cancel they are terminated: a burn in flight is 30-60 s,
        and leaving it running after the job released its slot stacks the next job on top of it."""
        ex, self._executor = self._executor, None
        if ex is None:
            return
        if cancelled or self._cancelled:
            for proc in list((getattr(ex, "_processes", None) or {}).values()):
                try:
                    proc.terminate()
                except Exception:  # noqa: BLE001 - already gone
                    pass
            ex.shutdown(wait=False, cancel_futures=True)
        else:
            ex.shutdown(wait=True)

    def __enter__(self) -> "WorkerPool":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        # Any exception ends the job: terminate rather than wait out burns nobody will read.
        self.close(cancelled=exc_type is not None)
