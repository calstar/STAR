"""The He/GN2 COPV benchmark study: fixed drawings, fixed T-0, fixed numerics.

This is not the Study tab. The Study tab (:mod:`backend.study`) runs whatever
stand the cockpit has open, at its own settings. This is the reproducible
comparison ``docs/PHYSICS-BENCHMARK.md`` Tier 2.1/2.2 is stated against: the
``copv_study_gn2``/``copv_study_he`` drawings, primed at the regulator's lockup
off a 4,500 psig bottle (dome 500 + bias 50 - 17 x 4.5 = 473.5 psig), with the benchmark scheme (:func:`burn_setup`). Its numbers
only mean what the benchmark says while every one of those stays put, which is
why they are constants here and nowhere a person sets them. Run it with
:func:`run_study`.

What it asks
------------
Whether the stand's pressurant bottle can hold the propellant tanks at their
regulated pressure for a whole burn, and how that answer differs between
nitrogen and helium. It runs the real drawings -- the same P&IDs the console
flies -- puts them at T-0 directly, and burns.

Why it is not a live session
----------------------------
Accuracy here costs wall clock. The regulator and the ullage it feeds form an
RC pair whose time constant is about a millisecond on helium, and the coupling
has to step below that or the trace fills with tick-rate noise that reads as
physics (see :data:`feedtwin`-side notes and ``Session._coupling_timescale``).
So a burn runs at roughly a minute of compute per case, with the latency budget
off and a generous Newton allowance. That is fine for a study and impossible for
a panel, which is why this is a job you start and collect rather than a view
that updates.

What comes back
---------------
Traces at the as-built bottle -- tank and COPV pressure against time -- plus, on
request, a bigger-bottle comparison, the ullage-collapse pair, and a sweep of
bottle volume against the pressure floor it holds. Every sample carries whether
its solve converged; a tick that did not is not a measurement and callers are
expected to drop it rather than plot it.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Callable, Literal, Sequence

from feedtwin.session.burn import BurnPlan, burn, burn_setup, open_session, prime_at_t0

from backend.assembly import Model, assemble
from backend.library import Library
from backend.run import psig
from backend.session import PAD_HOLD_S, Session
from backend.statemachine import load_machine

#: Drawing name per gas. Two P&IDs that differ only in what is in the bottle,
#: so the comparison is the gas and nothing else.
DIAGRAMS = {"gn2": "copv_study_gn2", "he": "copv_study_he"}

GAS_LABEL = {"gn2": "GN2", "he": "Helium"}


def _slug(name: str) -> str:
    """A library name, reduced to what identifies it.

    The import endpoint spells underscores as spaces, so a drawing uploaded
    through the Library tab arrives as "copv study gn2" while the same file
    added directly is "copv_study_gn2". Matching on the raw string means the
    study cannot find a drawing the operator can plainly see in the library.
    """
    return "".join(c for c in name.lower() if c.isalnum())


def find_diagram(library: Library, gas: str) -> str | None:
    """Newest study drawing for ``gas``, however it was named on the way in."""
    wanted = _slug(DIAGRAMS[gas])
    for artifact in library.list("diagram"):
        if _slug(artifact.name) == wanted:
            return artifact.id
    return None


#: Where the prime starts [psig] before it is put at the regulator's lockup,
#: which reads the bottle: dome 500 + the 1092-50's 50 - 17 x 4.5 = 473.5
#: (:func:`feedtwin.session.burn.prime_at_t0`). Gauge, like every number an
#: operator sets or reads; the session converts.
TANK_PSI = 473.5
DOME_PSI = 500.0
COPV_PSI = 4500.0
FILL_FRACTION = 0.95

#: How the T-0 settle decides it has settled: every tank within this many psi
#: of lockup for this many consecutive 50 ms steps, after at least SETTLE_MIN_S
#: (so a quiet adiabatic stand still records the same two seconds it always
#: did), giving up at SETTLE_MAX_S.
#:
#: The band is wider than the regulator's own dead band on purpose. The
#: regulator shuts within 0.5% of its setpoint (2.75 psi at 550) and a
#: collapsing ullage then cycles inside that band, so a settle criterion
#: tighter than it never fires and every collapse case burns the full
#: SETTLE_MAX_S -- on helium, five minutes of compute for nothing.
SETTLE_BAND = 4.0
SETTLE_STEPS = 10
SETTLE_MIN_S = 2.0
SETTLE_MAX_S = 10.0

#: Seconds of mains-shut hold recorded before ignition.
#:
#: The datum the ignition step is measured from. Without it a trace opens
#: mid-step and the drop is invisible, which is exactly how an early version of
#: this study came to report a *rise* at ignition.
LEAD_IN = 0.5

#: Bottle volumes for the sweep [L]. Brackets the as-built cylinder, which is
#: inserted at its real volume so the knee can be read against it.
SWEEP_LITRES = (2.0, 3.0, 4.0, 6.0, 8.0)

#: The bigger-bottle comparison [L]. Well past the knee, to show that it is.
BIGGER_LITRES = 8.0

#: Below this the tank is dry and the run is over [kg].
DRY = 0.06

#: Ignore the first of the burn when reporting a floor [s]. The sweep asks
#: whether the bottle can *hold* the tanks; the 50 ms dip as droop and line loss
#: appear the instant there is flow is a different question, answered by the
#: traces.
SETTLED_AFTER = 0.3


@dataclass(frozen=True, slots=True)
class StudyRequest:
    """What to run. Every option costs about a minute of compute per gas."""

    gases: tuple[str, ...] = ("gn2", "he")
    bigger: bool = False
    collapse: bool = False
    sweep: bool = False
    vapour: bool = False
    """Propellant vapour in the ullage. Applies to every case in the run, so a
    trace is comparable across gases -- unlike `collapse`, which adds its own
    extra case precisely so you can see the difference it makes."""
    chilldown: float = 0.0
    """Liquid-to-wall conductance [W/(m^2.K)], 0 to disable. Same scope."""
    line_walls: bool = False
    """Heat the tube and its fittings give back to the gas flowing through
    them. Same scope. Off by default because it needs `wall_thickness` and
    `fitting_mass` on the drawing to do anything at all."""
    dt: float = 0.05
    horizon: float = 14.0

    def cases(self) -> int:
        """Burn cases this request implies -- the unit of progress."""
        per_gas = (
            1
            + int(self.bigger)
            + int(self.collapse)
            + (len(SWEEP_LITRES) if self.sweep else 0)
        )
        return max(len(self.gases) * per_gas, 1)

    def key(self) -> str:
        return "|".join(
            [
                ",".join(sorted(self.gases)),
                f"b{int(self.bigger)}",
                f"c{int(self.collapse)}",
                f"s{int(self.sweep)}",
                f"v{int(self.vapour)}",
                f"w{self.chilldown:g}",
                f"m{int(self.line_walls)}",
                f"{self.dt:g}",
                f"{self.horizon:g}",
            ]
        )


@dataclass(frozen=True, slots=True)
class Trace:
    """One burn, sampled."""

    key: str
    gas: str
    label: str
    litres: float
    collapse: bool
    t: list[float]
    ox_psi: list[float]
    fuel_psi: list[float]
    copv_psi: list[float]
    chamber_psi: list[float]
    thrust_n: list[float]
    converged: list[bool]
    depleted_s: float | None
    failed_ticks: int


@dataclass(frozen=True, slots=True)
class SweepPoint:
    gas: str
    litres: float
    cubic_inches: float
    floor_psi: float
    burn_s: float | None
    failed_ticks: int


@dataclass(frozen=True, slots=True)
class StudyResult:
    bottle_litres: float
    bottle_cubic_inches: float
    traces: list[Trace] = field(default_factory=list)
    sweep: list[SweepPoint] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


Progress = Callable[[int, int, str], None]


def _bottle_litres(session: Session) -> float:
    bottle = next(iter(session.bottles.values()))
    return float(bottle.volume.volume) * 1e3


def _plan(litres: float | None, dt: float = 0.05, horizon: float = 14.0) -> BurnPlan:
    """The study's T-0 and burn, as the library's burn reads them."""
    return BurnPlan(
        tank_psi=TANK_PSI,
        copv_psi=COPV_PSI,
        fill_fraction=FILL_FRACTION,
        bottle_litres=litres,
        hold_s=PAD_HOLD_S,
        settle_band_psi=SETTLE_BAND,
        settle_steps=SETTLE_STEPS,
        settle_min_s=SETTLE_MIN_S,
        settle_max_s=SETTLE_MAX_S,
        lead_in_s=LEAD_IN,
        dt=dt,
        horizon_s=horizon,
        dry_kg=DRY,
        tanks=("OXT", "FUT"),
    )


def _stand(
    library: Library,
    gas: str,
    engine_id: str,
    cea_cache: str,
    *,
    litres: float | None,
    collapse: bool,
    vapour: bool = False,
    chilldown: float = 0.0,
    line_walls: bool = False,
) -> Session:
    """A stand at T-0: tanks loaded and at lockup, bottle charged, mains shut.

    Primed directly rather than flown through fills and presses. Pressing the
    tanks draws on the same bottle the study is about, so rehearsing the pad
    would mean an undersized COPV failed for two reasons at once and the trace
    could not say which. The priming and the settle to lockup are the library's
    (:func:`feedtwin.session.burn.prime_at_t0`), shared with EngineDesign's
    Layer X so both burn from the same T-0.
    """
    artifact_id = find_diagram(library, gas)
    if artifact_id is None:
        raise LookupError(f"no {DIAGRAMS[gas]!r} drawing in the library")
    model: Model = assemble(
        library, artifact_id, engine_id=engine_id, cea_cache=cea_cache
    )
    session = open_session(
        model,
        load_machine(),
        # The study's numerics (feedtwin.session.burn.burn_setup): no latency
        # budget, a generous Newton allowance, and the cockpit's newer thermal
        # closures off so docs/PHYSICS-BENCHMARK.md 2.x keeps meaning what it
        # meant.
        setup=burn_setup(
            dome_psi=DOME_PSI,
            ullage_collapse=collapse,
            ullage_vapour=vapour,
            chilldown=chilldown,
            line_walls=line_walls,
        ),
    )
    prime_at_t0(session, _plan(litres))
    return session


def _burn(
    session: Session,
    *,
    key: str,
    gas: str,
    label: str,
    collapse: bool,
    dt: float,
    horizon: float,
    cancelled: Callable[[], bool] = lambda: False,
) -> Trace:
    ox = session.tanks["OXT"]
    fuel = session.tanks["FUT"]
    bottle = next(iter(session.bottles.values()))
    litres = _bottle_litres(session)

    t: list[float] = []
    ox_psi: list[float] = []
    fuel_psi: list[float] = []
    copv_psi: list[float] = []
    chamber_psi: list[float] = []
    thrust: list[float] = []
    ok: list[bool] = []

    def record(now: float, sample: object, firing: bool) -> None:
        chamber = getattr(sample, "chamber", None)
        t.append(round(now, 3))
        ox_psi.append(psig(ox.pressure))
        fuel_psi.append(psig(fuel.pressure))
        copv_psi.append(psig(bottle.pressure))
        chamber_psi.append(psig(chamber.pressure) if (firing and chamber) else 0.0)
        thrust.append((chamber.thrust) if (firing and chamber) else 0.0)
        ok.append(bool(getattr(sample, "converged", True)))

    end = burn(session, _plan(None, dt, horizon), record, cancelled=cancelled)

    return Trace(
        key=key,
        gas=gas,
        label=label,
        litres=round(litres, 3),
        collapse=collapse,
        t=t,
        ox_psi=[round(v, 2) for v in ox_psi],
        fuel_psi=[round(v, 2) for v in fuel_psi],
        copv_psi=[round(v, 1) for v in copv_psi],
        chamber_psi=[round(v, 1) for v in chamber_psi],
        thrust_n=[round(v, 1) for v in thrust],
        converged=ok,
        depleted_s=end.depleted_s,
        failed_ticks=sum(1 for c in ok if not c),
    )


def _floor(trace: Trace) -> float:
    """Lowest tank pressure once the ignition transient has settled [psi].

    Converged samples only. A tick whose solve failed is not a measurement of
    anything, and one spurious dip poisons a minimum.
    """
    settled = [
        min(a, b)
        for a, b, when, good in zip(
            trace.ox_psi, trace.fuel_psi, trace.t, trace.converged
        )
        if when > SETTLED_AFTER and good
    ]
    return round(min(settled), 1) if settled else 0.0


def run_study(
    library: Library,
    engine_id: str,
    cea_cache: str,
    request: StudyRequest,
    *,
    progress: Progress | None = None,
    cancelled: Callable[[], bool] = lambda: False,
) -> StudyResult:
    """Run the study and return everything it produced.

    ``progress`` is called as ``(done, total, stage)`` after each burn case, so
    a caller can show how far along a job that takes minutes has got.
    """
    total = request.cases()
    done = 0
    traces: list[Trace] = []
    sweep: list[SweepPoint] = []
    notes: list[str] = []
    as_built = 0.0

    def tick(stage: str) -> None:
        nonlocal done
        done += 1
        if progress is not None:
            progress(done, total, stage)

    for gas in request.gases:
        if gas not in DIAGRAMS:
            notes.append(f"no drawing for {gas!r}; skipped")
            continue
        name = GAS_LABEL[gas]

        session = _stand(
            library,
            gas,
            engine_id,
            cea_cache,
            litres=None,
            collapse=False,
            vapour=request.vapour,
            chilldown=request.chilldown,
            line_walls=request.line_walls,
        )
        as_built = _bottle_litres(session)
        traces.append(
            _burn(
                session,
                key=f"{gas}_asbuilt",
                gas=gas,
                label=f"{name} · as built",
                collapse=False,
                dt=request.dt,
                horizon=request.horizon,
                cancelled=cancelled,
            )
        )
        tick(f"{name}: as-built burn")
        if cancelled():
            break

        if request.bigger:
            session = _stand(
                library,
                gas,
                engine_id,
                cea_cache,
                litres=BIGGER_LITRES,
                collapse=False,
            )
            traces.append(
                _burn(
                    session,
                    key=f"{gas}_bigger",
                    gas=gas,
                    label=f"{name} · {BIGGER_LITRES:g} L",
                    collapse=False,
                    dt=request.dt,
                    horizon=request.horizon,
                    cancelled=cancelled,
                )
            )
            tick(f"{name}: {BIGGER_LITRES:g} L burn")
            if cancelled():
                break

        if request.collapse:
            session = _stand(
                library,
                gas,
                engine_id,
                cea_cache,
                litres=None,
                collapse=True,
                vapour=request.vapour,
                chilldown=request.chilldown,
                line_walls=request.line_walls,
            )
            traces.append(
                _burn(
                    session,
                    key=f"{gas}_collapse",
                    gas=gas,
                    label=f"{name} · collapse on",
                    collapse=True,
                    dt=request.dt,
                    horizon=request.horizon,
                    cancelled=cancelled,
                )
            )
            tick(f"{name}: ullage collapse")
            if cancelled():
                break

        if request.sweep:
            for litres in SWEEP_LITRES:
                if cancelled():
                    break
                session = _stand(
                    library,
                    gas,
                    engine_id,
                    cea_cache,
                    litres=litres,
                    collapse=False,
                    vapour=request.vapour,
                    chilldown=request.chilldown,
                    line_walls=request.line_walls,
                )
                trace = _burn(
                    session,
                    key=f"{gas}_sweep_{litres:g}",
                    gas=gas,
                    label=f"{name} · {litres:g} L",
                    collapse=False,
                    dt=request.dt,
                    horizon=request.horizon,
                    cancelled=cancelled,
                )
                sweep.append(
                    SweepPoint(
                        gas=gas,
                        litres=litres,
                        cubic_inches=round(litres * 61.0237, 1),
                        floor_psi=_floor(trace),
                        burn_s=trace.depleted_s,
                        failed_ticks=trace.failed_ticks,
                    )
                )
                tick(f"{name}: sweep at {litres:g} L")

    if request.sweep and as_built:
        # The as-built bottle belongs on the sweep, at its real volume, so the
        # knee can be read against the hardware rather than interpolated to it.
        for trace in traces:
            if trace.key.endswith("_asbuilt"):
                sweep.append(
                    SweepPoint(
                        gas=trace.gas,
                        litres=round(as_built, 3),
                        cubic_inches=round(as_built * 61.0237, 1),
                        floor_psi=_floor(trace),
                        burn_s=trace.depleted_s,
                        failed_ticks=trace.failed_ticks,
                    )
                )
        sweep.sort(key=lambda p: (p.gas, p.litres))

    bad = sum(t.failed_ticks for t in traces)
    if bad:
        notes.append(f"{bad} tick(s) did not converge and are excluded from the plots")

    return StudyResult(
        bottle_litres=round(as_built, 3),
        bottle_cubic_inches=round(as_built * 61.0237, 1),
        traces=traces,
        sweep=sweep,
        notes=notes,
    )


class StudyRunner:
    """One study at a time, on a worker thread, with progress and cancel.

    One at a time deliberately: each case pins a core for a minute and running
    two would only make both slower and the progress meaningless.
    """

    def __init__(self) -> None:
        self.running = False
        self.progress = 0.0
        self.stage = ""
        self.error = ""
        self.request: StudyRequest | None = None
        self.result: StudyResult | None = None
        #: The engine the current or last run fired: ``{"id", "name"}``.
        self.engine: dict[str, str] = {}
        self._cancel = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

    def start(
        self,
        library: Library,
        engine_id: str,
        cea_cache: str,
        request: StudyRequest,
        engine_name: str = "",
    ) -> bool:
        """Begin a run. False if one is already going."""
        with self._lock:
            if self.running:
                return False
            self.running = True
            self.progress = 0.0
            self.stage = "starting"
            self.error = ""
            self.request = request
            self.result = None
            self.engine = {"id": engine_id, "name": engine_name or engine_id}
            self._cancel.clear()

        def work() -> None:
            try:

                def on_progress(done: int, total: int, stage: str) -> None:
                    self.progress = done / max(total, 1)
                    self.stage = stage

                result = run_study(
                    library,
                    engine_id,
                    cea_cache,
                    request,
                    progress=on_progress,
                    cancelled=self._cancel.is_set,
                )
                self.result = result
                self.stage = "cancelled" if self._cancel.is_set() else "done"
            except Exception as exc:  # noqa: BLE001 - reported, not swallowed
                self.error = f"{type(exc).__name__}: {exc}"
                self.stage = "failed"
            finally:
                self.running = False
                self.progress = 1.0

        self._thread = threading.Thread(target=work, daemon=True, name="copv-study")
        self._thread.start()
        return True

    def cancel(self) -> None:
        self._cancel.set()
