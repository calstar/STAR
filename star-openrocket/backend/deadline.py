"""Per-request compute budgets, installed once for every route.

`physics.budget` owns the budget and the checkpoints; this owns the policy --
which route gets how long, and making sure a route that nobody thought about
still gets *something*. That default is the point. A guard you have to remember
to apply to each new endpoint is a guard that covers the endpoints written
before someone forgot.

Pure ASGI, not `BaseHTTPMiddleware`
-----------------------------------
`BaseHTTPMiddleware` runs the downstream app in a child task and wraps the
response in a stream. Context still propagates, but it complicates exception
propagation for no gain here: this middleware only sets a ContextVar and never
produces a response of its own. The refusal surfaces the ordinary way, as the
`ValueError` the routers already turn into a 422.

Registration order matters: `add_middleware` inserts at position 0 and the stack
wraps in reverse, so the LAST added is outermost. CORS must stay outermost, or a
422 that escaped it reaches the browser as an opaque network error instead of
the message naming the field -- which would undo the fix that stopped the GUI
blaming an absent backend for a bad number.
"""

from physics.budget import budget

#: Seconds of thread CPU time inside `physics/`, per route.
#:
#: Sized at ~10x the MEASURED cost of a real run of that route, so the backstop
#: never fires on work somebody meant. The measurements, on the worked example:
#: one integration 0.02 s, `/api/simulate`'s four cases 0.07 s, and a 32-corner
#: sweep 3.3 s of thread CPU. That last one matters -- an earlier draft of this
#: table gave `/api/sweep` 4.0 s, which is 1.2x a legitimate sweep, and it
#: failed the canonical-corner tests intermittently. A backstop tight enough to
#: fire on real work is not a backstop, it is a second bug.
#:
#: These are intentionally well above the 6 s at which the browser gives up
#: (`frontend/src/recovery/api/client.ts`), because they are NOT the guard that
#: is supposed to fire. `DERIV_BUDGET` and `MAX_LOAD_SAMPLES` are: they are
#: deterministic, they refuse a bad config in about two seconds, and they can
#: say WHICH field is wrong. This table exists for whatever those two do not
#: describe, and for routes nobody has thought of yet.
#:
#: Note `/api/sweep` legitimately outruns the browser's 6 s at 3.3 s plus
#: serialising ~1 MB of trajectories -- which is why it is user-triggered
#: rather than fired on every edit, unlike simulate and drift.
ROUTE_BUDGETS = {
    "/api/drift": 10.0,
    "/api/simulate": 20.0,
    "/api/crosscheck": 15.0,
    "/api/simulate/both": 30.0,
    "/api/sweep": 20.0,
    "/api/study": 20.0,
    # RocketPy is a 6-DOF ascent solve and legitimately takes seconds.
    "/api/models": 60.0,
}

#: For any route not named above, including every route added after this file.
DEFAULT_BUDGET = 25.0


def budget_for(path: str) -> float:
    """The budget for `path`: exact match, then longest prefix, then default."""
    if path in ROUTE_BUDGETS:
        return ROUTE_BUDGETS[path]
    best = None
    for prefix, seconds in ROUTE_BUDGETS.items():
        if path.startswith(prefix) and (best is None or len(prefix) > len(best[0])):
            best = (prefix, seconds)
    return DEFAULT_BUDGET if best is None else best[1]


class ComputeBudgetMiddleware:
    """Install a `physics.budget` budget for the duration of each HTTP request."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        seconds = budget_for(path)
        # Set here, on the event loop; read in the worker thread. FastAPI runs a
        # sync `def` route through `anyio.to_thread.run_sync`, which copies the
        # context into the worker -- so the budget set here is what the physics
        # sees. `tests/recovery/test_budget.py` pins that, because if an anyio
        # upgrade ever stopped copying, nothing else here would fail.
        with budget(seconds, what=path or "this request"):
            await self.app(scope, receive, send)
