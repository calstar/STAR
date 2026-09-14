"""The per-request compute budget, and the one assumption it rests on.

`physics.budget` bounds a request by setting a ContextVar on the event loop and
reading it from a worker thread. That only works because anyio copies the
context into the thread, which is a property of a dependency rather than of
this code -- so it is pinned here. If an upgrade ever stops copying, every
budget in the app silently stops applying and nothing else in the suite notices.
"""

import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.deadline import (
    DEFAULT_BUDGET,
    ROUTE_BUDGETS,
    ComputeBudgetMiddleware,
    budget_for,
)
from physics.budget import Budget, BudgetExceeded, budget, checkpoint, current


def test_checkpoint_is_free_when_no_budget_is_installed():
    """The library, the CLI and most tests never install one."""
    assert current() is None
    checkpoint()          # must not raise
    checkpoint("naming a phase")
    assert current() is None


def test_an_exhausted_budget_refuses_at_the_next_checkpoint():
    with budget(seconds=0.0, what="a test request"):
        checkpoint()                      # first call only starts the clock
        b = current()
        b.started = time.thread_time() - 5.0   # pretend 5 s of CPU went by
        with pytest.raises(BudgetExceeded, match="compute budget"):
            checkpoint()


def test_a_healthy_budget_lets_work_through():
    with budget(seconds=30.0):
        for _ in range(1000):
            checkpoint()


def test_the_refusal_is_a_ValueError_so_routers_map_it_to_422():
    """Every recovery router already turns ValueError into a 422 with the
    message. A fresh exception type would arrive as a 500 until every call site
    learned about it -- and the ones that never did would be the untested ones."""
    assert issubclass(BudgetExceeded, ValueError)


def test_the_budget_is_restored_rather_than_cleared_on_exit():
    """Nesting must not silently remove an outer budget."""
    with budget(seconds=10.0, what="outer"):
        outer = current()
        with budget(seconds=1.0, what="inner"):
            assert current().what == "inner"
        assert current() is outer
    assert current() is None


def test_spent_is_zero_before_the_first_checkpoint():
    """The clock starts when work starts, not when the request was accepted --
    otherwise a request queued behind other work is charged for the wait."""
    b = Budget(seconds=5.0)
    assert b.spent() == 0.0
    assert b.remaining() == 5.0


# --- the contract with anyio ------------------------------------------------


def test_the_budget_survives_run_in_threadpool():
    """The load-bearing assumption of the whole design.

    FastAPI runs a sync `def` route via `anyio.to_thread.run_sync`, which does
    `copy_context()` and then `context.run(...)` in the worker. If that ever
    stops happening, the middleware keeps setting a budget the physics can no
    longer see, every checkpoint becomes a no-op, and the app goes back to
    hanging -- with the whole suite still green. So assert it directly.
    """
    app = FastAPI()
    app.add_middleware(ComputeBudgetMiddleware)

    @app.get("/api/simulate")
    def route():                      # sync def ON PURPOSE -- this is the path
        b = current()                 # ...that runs in the threadpool
        return {
            "installed": b is not None,
            "seconds": None if b is None else b.seconds,
        }

    body = TestClient(app).get("/api/simulate").json()
    assert body["installed"], (
        "the request budget did not reach the worker thread -- anyio is no "
        "longer copying context into the threadpool, so every compute budget "
        "in this app is silently inert"
    )
    assert body["seconds"] == ROUTE_BUDGETS["/api/simulate"]


def test_the_budget_does_not_leak_between_requests():
    app = FastAPI()
    app.add_middleware(ComputeBudgetMiddleware)

    @app.get("/api/simulate")
    def burn():
        current().started = time.thread_time() - 1000.0   # exhaust it
        return {"ok": True}

    @app.get("/api/drift")
    def fresh():
        checkpoint()
        return {"remaining": current().remaining()}

    client = TestClient(app)
    assert client.get("/api/simulate").json()["ok"]
    # A leaked budget would arrive already spent and raise here.
    assert client.get("/api/drift").json()["remaining"] > 0


# --- the policy table -------------------------------------------------------


def test_every_unlisted_route_still_gets_a_budget():
    """The reason this is middleware and not a per-route decorator: a route
    nobody thought about must still be bounded."""
    assert budget_for("/api/some/route/invented/next/year") == DEFAULT_BUDGET
    assert budget_for("") == DEFAULT_BUDGET


def test_exact_matches_win_over_prefixes():
    assert budget_for("/api/simulate") == ROUTE_BUDGETS["/api/simulate"]
    assert budget_for("/api/simulate/both") == ROUTE_BUDGETS["/api/simulate/both"]


def test_every_budget_clears_a_real_run_of_that_route_by_a_wide_margin():
    """The backstop must never be what fires on work somebody meant.

    A legitimate 32-corner sweep costs 3.3 s of thread CPU on this fixture. An
    earlier draft gave /api/sweep 4.0 s -- 1.2x that -- and the canonical-corner
    tests failed intermittently. Pin the headroom so nobody tightens these back
    down thinking they are the primary guard; the deterministic DERIV_BUDGET
    and MAX_LOAD_SAMPLES are, and they fire first with a better message.
    """
    measured = {                   # thread CPU, worked_example.json
        "/api/drift": 0.02,
        "/api/simulate": 0.07,
        "/api/crosscheck": 0.10,
        "/api/simulate/both": 0.14,
        "/api/sweep": 3.30,
        "/api/study": 2.00,
    }
    for path, cost in measured.items():
        assert budget_for(path) >= 5.0 * cost, (
            "%s has %.1f s for work that really costs %.2f s -- under 5x "
            "headroom, this will fire on a legitimate run" % (
                path, budget_for(path), cost)
        )
