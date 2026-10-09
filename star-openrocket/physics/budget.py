"""A CPU budget one request may spend in `physics/`, and the checkpoints that spend it.

Why this exists
---------------
`solver.DERIV_BUDGET` bounds ONE integration. Nothing bounded a request. The
routes multiply: `/api/simulate` runs 4 cases, `/api/simulate/both` 8,
`/api/study` up to 21, `/api/sweep` up to 65 -- each previously entitled to a
full, fresh budget. A config that costs a budget per run therefore cost minutes
in a single request, and the GUI re-runs simulate + drift + crosscheck on every
keystroke, so a one-worker dev server had nothing left for `/api/health` and the
UI concluded the backend was down.

What it guarantees, and what it does not
----------------------------------------
This is a COOPERATIVE budget: it bounds code that calls `checkpoint()`. It
cannot interrupt a single opaque C call -- `np.linspace` over twenty million
samples, `seg.sol(grid)`, RocketPy's `Flight`. Those have to be refused BEFORE
they are entered, which is what `solver.MAX_LOAD_SAMPLES` does. So the promise
is "no request runs unbounded, and the paths that cannot be polled are
individually capped", not "nothing can ever hang whatever anyone writes next".
A guarantee that survives arbitrary C would need a subprocess and a hard kill.

Three design choices worth keeping
----------------------------------
1. **A budget, not a deadline.** Storing an absolute instant would charge a
   request for time it spent queued behind other work, which is not its fault
   and not its cost. The clock starts at the first checkpoint actually reached.

2. **`time.thread_time()`, not `time.monotonic()`.** The work is CPU-bound and
   single-threaded within a worker. Wall clock would make a legitimate 32-corner
   sweep fail whenever the box happened to be busy -- the budget would measure
   the neighbours, not the run. Thread CPU time measures the run. A wall-clock
   backstop still belongs at the edge, for a genuinely stuck syscall, but that
   is the middleware's job and not this one's.

3. **One mutable object in the ContextVar, not several vars.** FastAPI runs a
   sync `def` route via `anyio.to_thread.run_sync`, which does `copy_context()`
   and then `context.run(...)` in the worker thread. The copy is one-way: the
   worker sees what the request set, but anything the worker `.set()`s is
   discarded when it finishes. Mutating one shared object is therefore the only
   way a count made in the worker (evaluations spent, say) can survive to be
   logged. `tests/recovery/test_budget.py` pins that propagation, so an anyio
   upgrade that stopped copying context fails the suite instead of silently
   turning every guarantee in this file off.

Unset is the normal state for the library, the CLI and most tests: `checkpoint()`
is then a single `is None` against a ContextVar read, which is nanoseconds.
"""

import time
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field


@dataclass
class Budget:
    """What one request may spend, and what it has spent so far."""

    #: Seconds of thread CPU time this request is allowed inside `physics/`.
    seconds: float
    #: What the label should call this, in the refusal message.
    what: str = "this request"
    #: Set at the first checkpoint reached, NOT at construction -- see the
    #: module docstring on queueing.
    started: float | None = field(default=None)
    #: Derivative evaluations spent. Mutated from the worker thread; see (3).
    evaluations: int = 0

    def spent(self) -> float:
        """Thread CPU seconds since the first checkpoint. 0.0 before that."""
        if self.started is None:
            return 0.0
        return time.thread_time() - self.started

    def remaining(self) -> float:
        return self.seconds - self.spent()


_budget: ContextVar[Budget | None] = ContextVar("physics_budget", default=None)


class BudgetExceeded(ValueError):
    """Raised when a request runs out of CPU budget.

    A `ValueError` deliberately, and not a new exception hierarchy: every router
    in `backend/recovery/` already maps `ValueError` to a 422 with the message,
    because a config the physics cannot answer is a real answer ABOUT that
    config. A fresh type would arrive as a 500 -- "the server broke" -- until
    every call site learned about it, and the ones that never did would be
    exactly the paths nobody tested.
    """


def current() -> Budget | None:
    """The budget in force, or None when nothing installed one."""
    return _budget.get()


def checkpoint(what: str | None = None) -> None:
    """Spend nothing, but refuse to continue past an exhausted budget.

    Call this at the top of any loop that can run long. It is free when no
    budget is installed, which is the library and CLI case.
    """
    b = _budget.get()
    if b is None:
        return
    if b.started is None:
        b.started = time.thread_time()
        return
    spent = time.thread_time() - b.started
    if spent > b.seconds:
        raise BudgetExceeded(
            "%s ran out of its %.1f s compute budget after %.1f s%s. That is "
            "far more work than any real recovery configuration needs, so the "
            "inputs are almost certainly not physical -- check the canopy "
            "sizes (CdS, D0), the vehicle mass and apogee, and the pad "
            "temperature and pressure."
            % (b.what, b.seconds, spent, "" if what is None else " in %s" % what)
        )


@contextmanager
def budget(seconds: float, what: str = "this request"):
    """Install a budget for the duration of the block, then restore.

    Reset via the token rather than by setting None, so nesting restores the
    outer budget instead of silently removing it.
    """
    token = _budget.set(Budget(seconds=seconds, what=what))
    try:
        yield _budget.get()
    finally:
        _budget.reset(token)
