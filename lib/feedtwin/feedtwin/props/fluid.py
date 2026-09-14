"""The caller-facing handle: a fluid you can ask for properties.

``Fluid`` is a thin thing over a *chain* of backends::

    n2 = Fluid("nitrogen")            # ["bicubic", "heos"]
    n2.get("rho", p=3.1e7, T=293.0)   # ~0.13 us, from tables
    n2.get("rho", p=5.0e9, T=293.0)   # tables refuse; the EOS answers

The chain is the whole design. "Fast where possible, exact where necessary,
measured where we have data" is a list, not a branch -- so adding a source means
adding an element, and no call site learns about it.

Threading
---------
Backends wrap mutable cursors: ``update`` moves them, ``value`` reads wherever
they were last moved. Two threads sharing one would interleave into nonsense
that never raises -- each would read the other's state point. Every backend is
therefore **thread-confined**: built per thread, on demand, and never handed
across. A ``Fluid`` is safe to share; the backends underneath it are not, and
never leave.
"""

from __future__ import annotations

import math
import threading
from typing import Any, Callable, Iterable, Sequence

from feedtwin.props.backend import (
    PropertyBackend,
    StatePair,
    get_backend_factory,
)
from feedtwin.props.errors import OutOfRange, PropertyError, UnsupportedProperty
from feedtwin.props.species import SpeciesSpec, get_species
from feedtwin.props.state import PROPERTIES, Phase, ThermoState

#: Which keyword arguments name which state pair, and in what order to pass
#: them. Data, so supporting a new pair is an entry here plus one in the
#: backend's own table -- not a chain of ``if "h" in kwargs``.
_PAIR_BY_KWARGS: dict[frozenset[str], tuple[StatePair, tuple[str, str]]] = {
    frozenset({"p", "T"}): (StatePair.PT, ("p", "T")),
    frozenset({"p", "h"}): (StatePair.PH, ("p", "h")),
    frozenset({"p", "s"}): (StatePair.PS, ("p", "s")),
    frozenset({"p", "q"}): (StatePair.PQ, ("p", "q")),
    frozenset({"T", "q"}): (StatePair.TQ, ("T", "q")),
    frozenset({"p", "rho"}): (StatePair.PD, ("p", "rho")),
    frozenset({"h", "s"}): (StatePair.HS, ("h", "s")),
    frozenset({"rho", "T"}): (StatePair.DT, ("rho", "T")),
    frozenset({"rho", "u"}): (StatePair.DU, ("rho", "u")),
}

#: The same table keyed by the *ordered* keyword names, both ways round.
#:
#: Derived, never hand-maintained. Building a frozenset to identify the pair
#: costs about as much as the property read it precedes, and ``tuple(state)`` on
#: a two-key dict is far cheaper -- so the ordered form is tried first and the
#: frozenset kept only as the fallback for anything unusual.
_PAIR_BY_ORDERED: dict[tuple[str, ...], tuple[StatePair, tuple[str, str]]] = {
    order: entry
    for keys, entry in _PAIR_BY_KWARGS.items()
    for order in ((tuple(sorted(keys))), tuple(reversed(sorted(keys))))
}

#: Fields of a ThermoState that are read from the backend, in order.
_SNAPSHOT_PROPS = ("p", "T", "rho", "h", "s", "u", "cp", "cv", "mu", "k", "a", "Z")

#: Physically impossible inputs, rejected before any backend is touched.
#:
#: Not defensive clutter: an equation of state handed a negative pressure does
#: not say "negative pressure", it fails somewhere inside a root find and
#: reports that its bracket does not contain a root. Catching it here turns an
#: unreadable numerical failure into the actual mistake -- and it is cheap,
#: because the chain would otherwise pay a failed solve on every backend.
_STRICTLY_POSITIVE: dict[str, str] = {
    "p": "pressure [Pa]",
    "T": "temperature [K]",
    "rho": "density [kg/m^3]",
}

_UNIT_FRACTION: dict[str, str] = {"q": "vapour quality [-]"}


def _validate(name: str, value: float) -> None:
    if not math.isfinite(value):
        raise ValueError(
            f"{name}={value} is not a finite number. A NaN reaching the property "
            "layer usually means an earlier solve diverged; it is rejected here "
            "rather than propagated as a plausible-looking density."
        )

    label = _STRICTLY_POSITIVE.get(name)
    if label is not None and value <= 0.0:
        raise ValueError(f"{label} must be > 0, got {name}={value:.6g}")

    label = _UNIT_FRACTION.get(name)
    if label is not None and not 0.0 <= value <= 1.0:
        raise ValueError(f"{label} must be within [0, 1], got {name}={value:.6g}")


#: A chain element: either a registered backend's name, or a ready instance
#: (which is how a measured-data backend, parameterised by its own data rather
#: than by a species, joins a chain).
ChainEntry = str | PropertyBackend


#: Property results held per fluid, per thread, before the cache is dropped.
#:
#: A solve asks the same handful of state points over and over -- one Newton
#: iteration evaluates every branch, several branches share a node, and each
#: node is re-asked across the four vessel sub-steps. Measured over a second of
#: burn: 466,000 calls, 63,000 of them distinct, and **a 256-entry cache hits
#: as often as an unbounded one** (86.5%). So the bound is not a compromise
#: between memory and hit rate; past a couple of hundred entries there is
#: nothing left to gain. Doubled from the measured knee for headroom on a
#: stand with more branches than this one.
_MEMO_ENTRIES = 512


class Fluid:
    """One species, backed by an ordered chain of property sources.

    Args:
        name: Species name or alias -- ``"nitrogen"``, ``"gn2"``, ``"LOX"``.
        chain: Backends to try in order. Defaults to the species' own chain
            from ``species.toml``, which defaults to ``("bicubic", "heos")``.
    """

    def __init__(self, name: str, chain: Sequence[ChainEntry] | None = None) -> None:
        self._species: SpeciesSpec = get_species(name)
        self._chain: tuple[ChainEntry, ...] = tuple(
            chain if chain is not None else self._species.chain
        )
        if not self._chain:
            raise ValueError(f"fluid {name!r} has an empty backend chain")
        self._local = threading.local()

    @property
    def name(self) -> str:
        return self._species.name

    @property
    def species(self) -> SpeciesSpec:
        return self._species

    @property
    def chain(self) -> tuple[str, ...]:
        """Names of the backends in this fluid's chain, in order."""
        return tuple(e if isinstance(e, str) else e.name for e in self._chain)

    # ---------------------------------------------------------------- queries

    def get(self, prop: str, **state: float) -> float:
        """One property at one state point. The solver's hot path.

        Specify the state with exactly two of ``p``, ``T``, ``h``, ``s``, ``q``,
        ``rho`` -- ``fluid.get("rho", p=..., T=...)``.

        Tries each backend in order, moving to the next on
        :class:`OutOfRange` or :class:`UnsupportedProperty`. Raises
        :class:`PropertyError` if the whole chain declines, with what each one
        said -- so a failure names the reason rather than the last exception to
        survive.
        """
        if prop not in PROPERTIES:
            raise KeyError(
                f"unknown property {prop!r}; known: {', '.join(sorted(PROPERTIES))}"
            )
        pair, v1, v2 = self._resolve(state)

        # Memoised on the *resolved* state: a flat `(str, pair, float, float)`
        # tuple, which is both canonical -- `get("rho", p=.., T=..)` and
        # `get("rho", T=.., p=..)` are one entry -- and cheap to build.
        #
        # Keying *before* the resolve was tried, to skip its validation on a
        # hit as well, and measured slower: `tuple(sorted(state.items()))`
        # allocates a nested tuple per call and costs more than `_resolve`
        # saves. 1.61 s of GN2 burn became 1.67 s. Left as it is.
        #
        # Exact: no rounding and no tolerance, so a hit returns the number the
        # backend would have returned, and the only thing saved is asking again.
        memo: dict[tuple[str, StatePair, float, float], float] | None = getattr(
            self._local, "memo", None
        )
        if memo is None:
            memo = self._local.memo = {}
        key = (prop, pair, v1, v2)
        cached = memo.get(key)
        if cached is not None:
            return cached

        backend, _ = self._settle(pair, v1, v2, needs=(prop,))
        value = backend.value(prop)
        # Cleared wholesale rather than evicted one at a time. Measured, the
        # repeats all live inside a Newton iteration and a vessel sub-step, so
        # the working set is tiny: a 256-entry cache captures the same 86.5% of
        # calls as an unbounded one, over 466k calls in a second of burn. An LRU
        # would spend more on bookkeeping than the eviction policy is worth.
        if len(memo) >= _MEMO_ENTRIES:
            memo.clear()
        memo[key] = value
        return value

    def state(self, **state: float) -> ThermoState:
        """A full immutable snapshot. For reports, frames and diagnostics.

        About eight backend reads rather than one, so prefer :meth:`get` inside
        a solve. Backends are moved once and read repeatedly, so this is
        cheaper than eight separate :meth:`get` calls.
        """
        pair, v1, v2 = self._resolve(state)
        backend, _ = self._settle(pair, v1, v2, needs=_SNAPSHOT_PROPS)
        values = {p: backend.value(p) for p in _SNAPSHOT_PROPS}
        return ThermoState(
            fluid=self._species.name,
            backend=backend.name,
            phase=backend.phase(),
            quality=backend.quality(),
            **values,
        )

    def constants(self) -> dict[str, float]:
        """Critical point and molar mass -- properties of the substance.

        Cached: they do not depend on a state point, so they are read once per
        fluid and never again. Components need the critical pressure for the
        IEC 60534 choking correlation, and this is how they get it without
        reaching past the property layer.

        Sought along the chain rather than taken from its head, for the same
        reason every other query is: a measured table has no critical point to
        report, and asking only the first backend meant that putting measured
        data in front -- the entire point of the feature -- broke every
        component evaluation downstream.
        """
        cached: dict[str, float] | None = getattr(self._local, "constants", None)
        if cached is None:
            declined: list[str] = []
            for entry in self._chain:
                backend = self._backend(entry)
                getter = getattr(backend, "constants", None)
                if getter is None:
                    declined.append(backend.name)
                    continue
                cached = dict(getter())
                break
            else:
                raise PropertyError(
                    f"no backend in {list(self.chain)} reports substance constants "
                    f"for {self._species.name} (asked: {', '.join(declined)}). A "
                    "measured table cannot supply a critical point; keep an "
                    "equation-of-state backend in the chain behind it."
                )
            self._local.constants = cached
        return cached

    @property
    def critical_pressure(self) -> float:
        """Thermodynamic critical pressure [Pa]."""
        return self.constants()["p_critical"]

    @property
    def critical_temperature(self) -> float:
        """Thermodynamic critical temperature [K]."""
        return self.constants()["T_critical"]

    def phase(self, **state: float) -> Phase:
        pair, v1, v2 = self._resolve(state)
        backend, _ = self._settle(pair, v1, v2, needs=())
        return backend.phase()

    def accessor(
        self, prop: str, first: str, second: str
    ) -> Callable[[float, float], float]:
        """A bound, positional getter for one property over one state pair.

            rho = n2.accessor("rho", "p", "T")
            rho(1.0e7, 300.0)

        Same answer as :meth:`get`, roughly three times faster, because
        everything that does not change between calls is done once: which state
        pair the inputs form, which properties the chain's backends support,
        and the keyword unpacking. In a solve those are loop invariants, and
        :meth:`get` re-derives all of them on every evaluation.

        Use this wherever a property is read in a loop -- assembling a Jacobian,
        marching a transient. Use :meth:`get` for one-off queries where clarity
        beats a few hundred nanoseconds.

        The returned callable is safe to share across threads; it resolves its
        backend through the same per-thread cache the rest of the class uses.
        """
        if prop not in PROPERTIES:
            raise KeyError(
                f"unknown property {prop!r}; known: {', '.join(sorted(PROPERTIES))}"
            )
        entry = _PAIR_BY_KWARGS.get(frozenset({first, second}))
        if entry is None:
            options = sorted("+".join(sorted(k)) for k in _PAIR_BY_KWARGS)
            raise TypeError(
                f"{first!r} and {second!r} do not form a state pair; "
                f"valid pairs: {', '.join(options)}"
            )
        pair, (a, _b) = entry
        # The caller's argument order, not the table's: accessor("rho", "T", "p")
        # must mean f(T, p), or a positional API is a trap.
        flip = first != a

        needs = (prop,)

        def read(v1: float, v2: float) -> float:
            x, y = (v2, v1) if flip else (v1, v2)

            # The same per-thread memo :meth:`get` uses, and the same key, so
            # the two share entries: a state point one of them has paid for is
            # free to the other. Without this the accessor would be the
            # *slower* of the two for a repeated point, which would make this
            # method's own advice -- use it in loops -- wrong.
            memo: dict[tuple[str, StatePair, float, float], float] | None = getattr(
                self._local, "memo", None
            )
            if memo is None:
                memo = self._local.memo = {}
            key = (prop, pair, x, y)
            cached = memo.get(key)
            if cached is not None:
                return cached

            _validate(first, v1)
            _validate(second, v2)
            # Straight at the preferred backend, which serves essentially every
            # call: the tables were chosen to cover the operating envelope, so
            # falling through is the exception. Anything it declines -- or any
            # surprise -- goes to the full chain walk, which reproduces the
            # attempt and reports properly if nothing can serve the point.
            preferred = self._eligible(needs)[0]
            try:
                preferred.update(pair, x, y)
                value = preferred.value(prop)
            except Exception:
                backend, _ = self._settle(pair, x, y, needs=needs)
                value = backend.value(prop)
            if len(memo) >= _MEMO_ENTRIES:
                memo.clear()
            memo[key] = value
            return value

        read.__name__ = f"{self._species.name}_{prop}_of_{first}{second}"
        read.__doc__ = (
            f"{PROPERTIES[prop].description} of {self._species.name} "
            f"[{PROPERTIES[prop].unit}] as a function of ({first}, {second})."
        )
        return read

    # ---------------------------------------------------------------- internals

    def _resolve(self, state: dict[str, float]) -> tuple[StatePair, float, float]:
        entry = _PAIR_BY_ORDERED.get(tuple(state))
        if entry is None:
            entry = _PAIR_BY_KWARGS.get(frozenset(state))
        if entry is None:
            options = sorted("+".join(sorted(k)) for k in _PAIR_BY_KWARGS)
            raise TypeError(
                f"cannot form a state from {sorted(state) or '()'}; "
                f"give exactly two of: {', '.join(options)}"
            )
        for name, value in state.items():
            _validate(name, float(value))
        pair, (first, second) = entry
        return pair, float(state[first]), float(state[second])

    def _settle(
        self,
        pair: StatePair,
        v1: float,
        v2: float,
        needs: Iterable[str],
    ) -> tuple[PropertyBackend, list[str]]:
        """Move the first backend that can serve this point and these properties.

        ``needs`` is checked *before* updating so a backend that could reach the
        state point but not answer the question is skipped rather than moved and
        then found wanting -- which would leave the chain's answer depending on
        the order the caller asked for properties.
        """
        required = tuple(needs)
        declined: list[str] = []
        last: Exception | None = None

        for backend in self._eligible(required):
            try:
                backend.update(pair, v1, v2)
            except (OutOfRange, UnsupportedProperty) as exc:
                declined.append(f"{backend.name}: {exc}")
                last = exc
                continue
            except Exception as exc:
                # An error this layer does not recognise. The next backend still
                # deserves a try -- one library's numerical failure says nothing
                # about another's -- but it is never swallowed: it lands in
                # `declined` and, if the chain runs out, is chained onto the
                # PropertyError as __cause__ so the traceback survives.
                declined.append(
                    f"{backend.name}: unexpected {type(exc).__name__}: {exc}"
                )
                last = exc
                continue
            return backend, declined

        raise PropertyError(
            f"no backend in {list(self.chain)} could serve {self._species.name} at "
            f"{pair.value}=({v1:.6g}, {v2:.6g}). " + "; ".join(declined)
        ) from last

    def _eligible(self, required: tuple[str, ...]) -> tuple[PropertyBackend, ...]:
        """This thread's chain, filtered to backends that can compute ``required``.

        Cached per thread and per property set. Which backends *can* compute a
        property depends only on the backends and the property -- never on the
        state point -- so this is a loop invariant, and recomputing it per call
        cost more than the property read it guarded.

        Filtering here rather than mid-chain also keeps the answer independent
        of the order properties were asked for: a backend that can reach the
        state point but not answer the question is skipped before it is moved,
        so it can never become the one that serves a later, easier property.
        """
        cache: dict[tuple[str, ...], tuple[PropertyBackend, ...]] | None
        cache = getattr(self._local, "eligible", None)
        if cache is None:
            cache = {}
            self._local.eligible = cache

        found = cache.get(required)
        if found is None:
            backends = [self._backend(e) for e in self._chain]
            found = tuple(b for b in backends if all(b.supports(p) for p in required))
            if not found:
                raise PropertyError(
                    f"no backend in {list(self.chain)} can compute "
                    f"{', '.join(required)} for {self._species.name}"
                )
            cache[required] = found
        return found

    def _backend(self, entry: ChainEntry) -> PropertyBackend:
        """This thread's instance of one chain entry, built on first use."""
        if not isinstance(entry, str):
            # A ready instance -- shared across threads by construction, so the
            # instance itself is responsible for being safe. TabulatedProperties
            # is; anything a project supplies must be too.
            return entry

        cache: dict[str, PropertyBackend] | None = getattr(self._local, "cache", None)
        if cache is None:
            cache = {}
            self._local.cache = cache

        backend = cache.get(entry)
        if backend is None:
            backend = get_backend_factory(entry)(self._species)
            cache[entry] = backend
        return backend

    def __repr__(self) -> str:
        return f"Fluid({self._species.name!r}, chain={list(self.chain)})"
