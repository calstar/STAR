"""Phase 01's speed gate, and the thread confinement that makes it safe.

Speed is a correctness property here, not a nicety. A transient on a sixty-node
network evaluates properties millions of times over Jacobian assembly; at
CoolProp's convenience API (184 us/call) that solve does not finish, so the
whole layer exists to make it 0.1 us. A regression would not break a test
anywhere else -- it would just quietly make the simulator unusable, months
later, with no obvious culprit.

Thresholds are deliberately loose against the measured numbers so shared CI
runners do not produce flakes. They are ceilings on the *design*, not
benchmarks: the point is to catch someone accidentally routing the hot path
through PropsSI or rebuilding a backend per call, which costs 10-1000x, not to
notice a 20% drift.
"""

from __future__ import annotations

import os
import threading
import time

import pytest

from feedtwin.props import Fluid

# Two kinds of assertion below, and the distinction matters more than either
# number.
#
# *Ratios* are the sharp instrument. A shared CI runner can be two or three
# times slower than a laptop, but it is slower at everything, so "the tables
# beat the equation of state by 3x" and "PropsSI is 10x our worst case" hold
# on any machine. Those are the tests that would actually catch a regression.
#
# *Absolute ceilings* are the blunt one, and are set to catch the catastrophic
# case -- someone routing the hot path through PropsSI, or rebuilding a backend
# per call, which cost 10-1000x -- without flaking when a runner is loaded.
# They are deliberately several times the measured values rather than snug
# around them; a snug absolute threshold on a shared runner is a test that
# fails for reasons unrelated to the code.

#: Measured on the development host, nitrogen via the tabulated backend:
#: accessor 0.63 us, get 0.96 us, state 5.0 us (twelve reads).
#: Phase 01's design target is the sub-microsecond accessor; these ceilings are
#: what CI can assert without becoming a coin flip.
HOT_PATH_BUDGET_US = 3.0
CONVENIENCE_BUDGET_US = 5.0

#: Set FEEDTWIN_STRICT_PERF=1 to assert the design targets instead of the
#: CI-safe ceilings. Worth running on a quiet machine after touching the hot
#: path -- the loose ceilings above would not notice a 3x regression, and that
#: is exactly the size of mistake a refactor introduces.
if os.environ.get("FEEDTWIN_STRICT_PERF") == "1":  # pragma: no cover - opt-in
    HOT_PATH_BUDGET_US = 1.0
    CONVENIENCE_BUDGET_US = 1.5

#: Enough to swamp timer noise; small enough to stay quick in CI.
ITERATIONS = 20_000


#: Temperature step between successive timed calls [K].
#:
#: The calls have to walk, not repeat. :meth:`Fluid.get` and the accessor share
#: a per-thread memo, so twenty thousand reads of one state point measure the
#: memo -- microseconds of dictionary lookup -- and say nothing at all about
#: the backend underneath. Everything asserted in this file is about that
#: backend: whether the tables are being used, whether somebody has routed the
#: hot path through PropsSI. So each call moves the state.
#:
#: A microkelvin is small enough that every point stays in the same phase and
#: the same table cell, and large enough to be a distinct cache key. It is also
#: what a solve does: a Newton iteration walks pressures and never asks twice
#: for exactly the same point.
_STEP_K = 1.0e-6


def _time_us(call: object, n: int = ITERATIONS) -> float:
    """Mean microseconds per call, after a warm-up that excludes table build.

    ``call`` takes the iteration index and is expected to use it to move the
    state point -- see :data:`_STEP_K`.
    """
    fn = call  # type: ignore[assignment]
    fn(0)  # type: ignore[operator]
    started = time.perf_counter()
    for i in range(n):
        fn(i)  # type: ignore[operator]
    return (time.perf_counter() - started) / n * 1e6


@pytest.mark.parametrize("prop", ["rho", "mu", "cp", "Z"])
def test_get_is_within_the_convenience_budget(prop: str) -> None:
    """The ergonomic API stays close to a microsecond."""
    n2 = Fluid("nitrogen")
    elapsed = _time_us(lambda i: n2.get(prop, p=1.0e7, T=300.0 + i * _STEP_K))
    assert elapsed < CONVENIENCE_BUDGET_US, f"Fluid.get({prop!r}) took {elapsed:.3f} us"


@pytest.mark.parametrize("prop", ["rho", "mu", "cp", "Z"])
def test_the_hot_path_meets_the_phase_budget(prop: str) -> None:
    """The accessor -- what a solve loop uses -- stays fast.

    Phase 01's design target is under a microsecond, met at 0.63 us on the
    development host. What is asserted here is the looser ceiling above, so the
    test means the same thing on a loaded runner; run with
    FEEDTWIN_STRICT_PERF=1 to hold the real target.

    Z is included deliberately: it is the gas-side workhorse (COPV, ullage) and
    is derived from several reads rather than being one, so it is the property
    most likely to drift over.
    """
    read = Fluid("nitrogen").accessor(prop, "p", "T")
    elapsed = _time_us(lambda i: read(1.0e7, 300.0 + i * _STEP_K))
    assert elapsed < HOT_PATH_BUDGET_US, f"accessor({prop!r}) took {elapsed:.3f} us"


@pytest.mark.parametrize("prop", ["rho", "mu"])
def test_accessor_is_faster_than_get(prop: str) -> None:
    """The bound accessor is the loop API, and must earn that claim.

    It hoists everything invariant -- state-pair resolution, which backends
    support the property, keyword unpacking -- out of the call. If it ever
    stopped being faster, the extra API would be complexity for nothing.
    """
    n2 = Fluid("nitrogen")
    read = n2.accessor(prop, "p", "T")

    bound = _time_us(lambda i: read(1.0e7, 300.0 + i * _STEP_K))
    convenient = _time_us(lambda i: n2.get(prop, p=1.0e7, T=300.0 + i * _STEP_K))

    assert bound < HOT_PATH_BUDGET_US
    assert bound < convenient


def test_tables_are_dramatically_faster_than_the_equation_of_state() -> None:
    """The reason the chain is ordered the way it is.

    A loose 3x floor against a measured 10-30x: enough to prove the tabulated
    path is actually being taken, without failing on a noisy runner.
    """
    fast = Fluid("nitrogen", chain=["bicubic"]).accessor("rho", "p", "T")
    exact = Fluid("nitrogen", chain=["heos"]).accessor("rho", "p", "T")

    speedup = _time_us(lambda i: exact(1.0e7, 300.0 + i * _STEP_K)) / _time_us(
        lambda i: fast(1.0e7, 300.0 + i * _STEP_K)
    )
    assert speedup > 3.0, f"tables only {speedup:.1f}x faster than the EOS"


def test_propssi_would_be_far_slower() -> None:
    """The measurement behind the ban in test_property_call_discipline.

    That test forbids ``PropsSI`` in library code on the strength of a number.
    This is the number, re-measured, so the rule keeps a live justification
    rather than a comment citing a benchmark nobody runs. Tests are exempt from
    the ban precisely so this comparison can exist.
    """
    import CoolProp.CoolProp as CP

    n2 = Fluid("nitrogen").accessor("rho", "p", "T")

    convenient = _time_us(
        lambda i: CP.PropsSI("D", "T", 300.0 + i * _STEP_K, "P", 1.0e7, "Nitrogen"),
        n=2_000,
    )
    ours = _time_us(lambda i: n2(1.0e7, 300.0 + i * _STEP_K))

    assert convenient / ours > 10.0, (
        f"PropsSI {convenient:.1f} us vs Fluid {ours:.3f} us -- the gap that "
        "justifies the ban has narrowed; re-check the rule."
    )


def test_backends_are_confined_to_their_thread() -> None:
    """Threads must not share a backend cursor.

    Backends wrap a mutable cursor: ``update`` moves it, ``value`` reads it.
    Two threads sharing one would interleave -- each reading the other's state
    point -- and produce plausible wrong numbers with no exception anywhere.

    Each thread here queries a *different* state point in a tight loop and
    checks its own answer every time. Interleaving would show up as a wrong
    density, not as a crash, which is exactly why it needs asserting.
    """
    n2 = Fluid("nitrogen")
    expected = {
        T: Fluid("nitrogen").get("rho", p=1.0e7, T=T) for T in (250.0, 300.0, 350.0)
    }
    failures: list[str] = []
    barrier = threading.Barrier(len(expected))

    def hammer(T: float) -> None:
        barrier.wait()
        for _ in range(2_000):
            got = n2.get("rho", p=1.0e7, T=T)
            if got != pytest.approx(expected[T], rel=1e-12):
                failures.append(f"T={T}: got {got}, expected {expected[T]}")
                return

    threads = [threading.Thread(target=hammer, args=(T,)) for T in expected]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not failures, failures[:5]


def test_a_shared_tabulated_backend_is_also_thread_safe() -> None:
    """One measured table, many threads.

    Unlike the CoolProp backends, a tabulated one cannot be rebuilt per thread
    -- it is parameterised by its data, not by a species name -- so the single
    instance is shared and only its cursor is thread-local. This asserts that
    actually holds.
    """
    import numpy as np

    from feedtwin.props import TabulatedProperties

    p_grid = np.array([1.0e6, 2.0e6, 3.0e6])
    T_grid = np.array([280.0, 300.0, 320.0])
    values = np.array([[p * T for T in T_grid] for p in p_grid])
    tab = TabulatedProperties(p_grid, T_grid, {"rho": values}, source="unit-test")

    fluid = Fluid("nitrogen", chain=[tab])
    failures: list[str] = []
    barrier = threading.Barrier(3)

    def hammer(p: float, T: float) -> None:
        barrier.wait()
        for _ in range(2_000):
            if fluid.get("rho", p=p, T=T) != pytest.approx(p * T, rel=1e-9):
                failures.append(f"p={p} T={T}")
                return

    threads = [
        threading.Thread(target=hammer, args=args)
        for args in [(1.0e6, 280.0), (2.0e6, 300.0), (3.0e6, 320.0)]
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not failures, failures[:5]


def test_the_memo_returns_exactly_what_the_backend_would() -> None:
    """The property memo is an *exact* cache, and has to stay one.

    No rounding, no tolerance, no quantised state -- a hit returns the number
    the backend would have returned, and the only thing saved is asking again.
    That is what makes it safe to put in front of a solve: it cannot move an
    answer, only shorten the path to it.

    Checked against a fluid with no memo of its own, so the comparison is
    against the backend rather than against another cache.
    """
    warm = Fluid("nitrogen")
    for prop in ("rho", "mu", "cp", "Z"):
        first = warm.get(prop, p=1.0e7, T=300.0)
        again = warm.get(prop, p=1.0e7, T=300.0)
        cold = Fluid("nitrogen").get(prop, p=1.0e7, T=300.0)
        assert again == first, f"{prop}: memo returned a different number"
        assert first == cold, f"{prop}: memo diverged from the backend"

    # And it must not merge neighbours. Rounding the key would be a tempting
    # way to raise the hit rate -- it was measured, and buys 3 points -- but it
    # turns the cache into an approximation, which is a different thing to have
    # in front of a solve. Two states a millikelvin apart have genuinely
    # different densities, and the memo has to keep them apart.
    #
    # Checked by walking, not by one pair: a key rounded coarsely enough to
    # collide somewhere will collide across a sweep, and a single hand-picked
    # point can miss it entirely.
    walked = Fluid("nitrogen")
    values = [walked.get("rho", p=1.0e7, T=300.0 + i * 1.0e-3) for i in range(64)]
    assert len(set(values)) == len(
        values
    ), "the memo merged distinct state points; the key is being rounded"
    fresh = Fluid("nitrogen")
    assert values == [
        fresh.get("rho", p=1.0e7, T=300.0 + i * 1.0e-3) for i in range(64)
    ], "a walked sweep disagreed with a cold one"


def test_get_and_the_accessor_share_one_entry() -> None:
    """Otherwise the accessor -- the API this module tells people to use in a
    loop -- would be the slower of the two for a repeated point, and its own
    advice would be wrong."""
    n2 = Fluid("nitrogen")
    read = n2.accessor("rho", "p", "T")
    n2._local.memo = {}

    from_get = n2.get("rho", p=1.0e7, T=300.0)
    assert len(n2._local.memo) == 1
    from_accessor = read(1.0e7, 300.0)

    assert from_accessor == from_get
    assert len(n2._local.memo) == 1, "the accessor filled a second entry"

    # ...and the caller's argument order is still honoured, not the table's.
    flipped = Fluid("nitrogen").accessor("rho", "T", "p")
    assert flipped(300.0, 1.0e7) == from_get


def test_the_memo_is_bounded() -> None:
    """It is cleared wholesale rather than evicted one at a time, so the only
    thing that must hold is that it cannot grow without limit."""
    from feedtwin.props.fluid import _MEMO_ENTRIES

    n2 = Fluid("nitrogen")
    n2._local.memo = {}
    for i in range(_MEMO_ENTRIES * 3):
        n2.get("rho", p=1.0e7, T=300.0 + i * 1.0e-3)
    assert len(n2._local.memo) <= _MEMO_ENTRIES
