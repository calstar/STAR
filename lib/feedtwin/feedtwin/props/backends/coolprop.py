"""CoolProp-backed properties: Helmholtz equations of state, and tables over them.

One class serves both. ``HEOS`` evaluates the Helmholtz energy directly and
covers everything the equation of state is defined over; ``BICUBIC&HEOS``
interpolates precomputed tables over the same equation and is 10-30x faster
inside a bounded region. They differ by a backend string, not by a code path,
which is what keeps "fast where possible, exact where necessary" from turning
into two implementations that drift.

Measured on the development host, nitrogen, per call (update + read):

=============  ========  ===========  =========
property         HEOS      BICUBIC     speedup
=============  ========  ===========  =========
density         3.17 us     0.128 us     24.8x
viscosity       3.39 us     0.129 us     26.2x
conductivity    4.25 us     0.127 us     33.5x
cp              3.35 us     0.188 us     17.8x
speed of sound  3.16 us     0.331 us      9.6x
=============  ========  ===========  =========

Two behaviours of the tabulated backend shape the design:

**It refuses rather than extrapolates.** Outside its envelope it raises
``ValueError: inputs are not in range`` instead of returning a plausible wrong
number. That is the good failure, and it is what makes the fallback chain in
:mod:`feedtwin.props.fluid` sound -- translated here into :class:`OutOfRange`.

**It does not implement every property.** ``compressibility_factor`` is missing
on BICUBIC. Rather than special-case that, Z is *derived* here for every backend
as ``p / (rho . R_specific . T)``, which reproduces CoolProp's own value to
3e-6. Deriving it means one definition of Z regardless of backend.

Building tables costs 2-3 s per fluid on first use and about 17 MB on disk, in
CoolProp's own cache. See :func:`warm_tables`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Callable, NoReturn

import CoolProp.CoolProp as CP

from feedtwin.props.backend import PropertyBackend, StatePair, register_backend
from feedtwin.props.errors import OutOfRange, UnsupportedProperty
from feedtwin.props.state import Phase

if TYPE_CHECKING:  # pragma: no cover - types only
    from feedtwin.props.species import SpeciesSpec

#: Universal gas constant [J/(mol.K)], CODATA 2018 -- the value CoolProp uses.
R_UNIVERSAL = 8.31446261815324

#: Our neutral state pairs, mapped onto CoolProp's input constants.
#: Adding a pair is an entry here, not a branch.
#:
#: `Any` rather than `int` because CoolProp changed what these are between the
#: versions this package supports: 7.2 ships no type information and they are
#: plain ints, while 8.0 gives them a nominal `input_pairs` type that
#: `AbstractState.update` then demands. They are ints at runtime either way --
#: declaring `int` made the 8.0 stubs reject the very call this table exists to
#: feed, and declaring the 8.0 name would not resolve on 7.2.
_INPUT_PAIRS: dict[StatePair, Any] = {
    StatePair.PT: CP.PT_INPUTS,
    StatePair.PH: CP.HmassP_INPUTS,
    StatePair.PS: CP.PSmass_INPUTS,
    StatePair.PQ: CP.PQ_INPUTS,
    StatePair.TQ: CP.QT_INPUTS,
    StatePair.PD: CP.DmassP_INPUTS,
    StatePair.HS: CP.HmassSmass_INPUTS,
    StatePair.DT: CP.DmassT_INPUTS,
    StatePair.DU: CP.DmassUmass_INPUTS,
}

#: CoolProp orders the arguments of some pairs the other way round from how the
#: pair is named. Listed explicitly rather than discovered, because getting it
#: silently backwards produces a valid-looking state at the wrong point.
_SWAPPED: frozenset[StatePair] = frozenset({StatePair.PH, StatePair.TQ, StatePair.PD})

#: CoolProp's phase integers, mapped onto our backend-neutral enum.
_PHASES: dict[int, Phase] = {
    CP.iphase_liquid: Phase.LIQUID,
    CP.iphase_gas: Phase.GAS,
    CP.iphase_twophase: Phase.TWO_PHASE,
    CP.iphase_supercritical: Phase.SUPERCRITICAL,
    CP.iphase_supercritical_gas: Phase.SUPERCRITICAL_GAS,
    CP.iphase_supercritical_liquid: Phase.SUPERCRITICAL_LIQUID,
    CP.iphase_critical_point: Phase.CRITICAL_POINT,
}

#: Direct reads. Everything else in PROPERTIES is derived below.
_GETTERS: dict[str, Callable[[Any], float]] = {
    "p": lambda s: float(s.p()),
    "T": lambda s: float(s.T()),
    "rho": lambda s: float(s.rhomass()),
    "h": lambda s: float(s.hmass()),
    "s": lambda s: float(s.smass()),
    "u": lambda s: float(s.umass()),
    "cp": lambda s: float(s.cpmass()),
    "cv": lambda s: float(s.cvmass()),
    "mu": lambda s: float(s.viscosity()),
    "k": lambda s: float(s.conductivity()),
    "a": lambda s: float(s.speed_sound()),
    "molar_mass": lambda s: float(s.molar_mass()),
}

#: Substrings CoolProp uses when a state point is outside a backend's envelope.
#: Matched rather than pattern-parsed: the message is not a stable API, so the
#: check stays broad, and anything unrecognised propagates as a real error
#: instead of being silently reinterpreted as "just out of range".
_OUT_OF_RANGE_MARKERS = ("not in range", "outside", "out of range")

_UNSUPPORTED_MARKERS = ("is not implemented", "not implemented for this backend")


class CoolPropBackend:
    """Properties for one species from one CoolProp backend.

    Stateful and **not thread-safe** -- it wraps a single ``AbstractState`` that
    :meth:`update` moves around. :class:`~feedtwin.props.fluid.Fluid` gives each
    thread its own; never share an instance across threads.
    """

    def __init__(self, species: SpeciesSpec, backend: str, name: str) -> None:
        self._species = species
        self._backend = backend
        self._name = name
        self._state = CP.AbstractState(backend, species.backend_fluid)
        # Learned, not declared: a property is assumed available until the
        # backend says otherwise, and then remembered. Avoids both a hardcoded
        # per-backend capability list and a probe at construction that would
        # need a state point known to be inside an envelope we cannot predict.
        self._unsupported: set[str] = set()
        # Specific gas constant, cached on first use of Z. A property of the
        # substance, not of any state point, so it never needs recomputing.
        self._r_specific: float | None = None

    @property
    def name(self) -> str:
        return self._name

    def supports(self, prop: str) -> bool:
        if prop in self._unsupported:
            return False
        return prop in _GETTERS or prop in ("Z", "gamma")

    def update(self, pair: StatePair, v1: float, v2: float) -> None:
        try:
            inputs = _INPUT_PAIRS[pair]
        except KeyError:  # pragma: no cover - StatePair is closed
            raise UnsupportedProperty(self._name, f"state pair {pair.value}") from None

        a, b = (v2, v1) if pair in _SWAPPED else (v1, v2)
        try:
            self._state.update(inputs, a, b)
        except Exception as exc:
            self._reraise(exc, f"{pair.value}=({v1:.6g}, {v2:.6g})")

    def value(self, prop: str) -> float:
        if prop == "Z":
            return self._compressibility()
        if prop == "gamma":
            return self.value("cp") / self.value("cv")

        getter = _GETTERS.get(prop)
        if getter is None or prop in self._unsupported:
            raise UnsupportedProperty(self._name, prop)

        try:
            return getter(self._state)
        except Exception as exc:
            self._reraise(exc, prop, prop=prop)

    def constants(self) -> dict[str, float]:
        """Constants of the substance, not of any state point.

        Critical pressure and temperature are needed by the IEC 60534 choked
        liquid correlation, and they are properties of the fluid rather than of
        where it happens to be -- so they are read once, from the same backend
        that answers everything else, rather than through a convenience call.
        """
        return {
            "p_critical": float(self._state.p_critical()),
            "T_critical": float(self._state.T_critical()),
            "molar_mass": float(self._state.molar_mass()),
        }

    def phase(self) -> Phase:
        try:
            return _PHASES.get(int(self._state.phase()), Phase.UNKNOWN)
        except Exception:
            return Phase.UNKNOWN

    def quality(self) -> float | None:
        """Vapour fraction, or ``None`` when the state is not two-phase.

        CoolProp signals "not applicable" with an out-of-band number, and uses
        more than one: -1 for a subcooled liquid, -1000 for a supercritical
        state. Anything outside [0, 1] is therefore treated as "no quality"
        rather than matched against those two values specifically.
        """
        try:
            q = float(self._state.Q())
        except Exception:
            return None
        return q if 0.0 <= q <= 1.0 else None

    def _compressibility(self) -> float:
        """Z = p / (rho . R_specific . T), derived rather than read.

        BICUBIC does not implement ``compressibility_factor``. Deriving it from
        density gives one definition of Z on every backend, and it agrees with
        CoolProp's own to ~3e-6.
        """
        # Read straight off the state rather than through value(): Z needs four
        # of them, and four rounds of dict lookup and dispatch cost more than
        # the arithmetic. Molar mass is a constant of the substance, so it is
        # fetched once per backend rather than per state point.
        state = self._state
        rho = float(state.rhomass())
        T = float(state.T())
        if rho <= 0.0 or T <= 0.0:
            raise UnsupportedProperty(self._name, "Z")
        if self._r_specific is None:
            molar_mass = float(state.molar_mass())
            if molar_mass <= 0.0:
                raise UnsupportedProperty(self._name, "Z")
            self._r_specific = R_UNIVERSAL / molar_mass
        return float(state.p()) / (rho * self._r_specific * T)

    def _reraise(
        self, exc: Exception, detail: str, prop: str | None = None
    ) -> NoReturn:
        """Translate a CoolProp failure into the layer's own vocabulary.

        ``prop`` is given only when the failure came from reading a named
        property, and is what gets remembered as unsupported -- a failed
        ``update`` says nothing about any property's availability, so passing
        the state-pair description here would poison the capability cache.
        """
        message = str(exc)
        lowered = message.lower()

        if any(marker in lowered for marker in _OUT_OF_RANGE_MARKERS):
            raise OutOfRange(self._name, self._species.name, f"{detail}: {message}")

        if any(marker in lowered for marker in _UNSUPPORTED_MARKERS):
            if prop is not None:
                self._unsupported.add(prop)
            raise UnsupportedProperty(self._name, detail)

        raise exc


def warm_tables(species: SpeciesSpec) -> float:
    """Build this species' interpolation tables now instead of on first use.

    Returns the seconds spent. Costs 2-3 s and ~17 MB per fluid the first time
    on a machine, then loads from CoolProp's cache.

    Worth calling explicitly in a worker process, for the same reason
    EngineDesign's accelerator front-loads its JIT: paying it lazily means the
    cost lands inside whatever call happens to be first, which is usually a
    solve someone is timing.
    """
    import time

    started = time.perf_counter()
    state = CP.AbstractState("BICUBIC&HEOS", species.backend_fluid)
    # A state point every fluid we ship is fluid at; only the table build
    # matters, not this particular answer.
    state.update(CP.PT_INPUTS, 1.0e6, 300.0)
    return time.perf_counter() - started


def _heos(species: SpeciesSpec) -> PropertyBackend:
    return CoolPropBackend(species, "HEOS", "heos")


def _bicubic(species: SpeciesSpec) -> PropertyBackend:
    return CoolPropBackend(species, "BICUBIC&HEOS", "bicubic")


register_backend("heos", _heos)
register_backend("bicubic", _bicubic)
