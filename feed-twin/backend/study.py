"""The Study tab: the stand you have open, burned from T-0 once per case.

A case is the stand as the cockpit has it -- drawing, engine, every setting on
the Configuration tab, the hookup, where the knobs sit, the COPV fill target --
with whatever the case changes on top: the bottle's charge, a knob, the
bottle's volume, the load, the pressurant, any Configuration row. Nothing here
is a number of its own. A sweep is cases the view writes out, one per value.

T-0 is the cockpit's Jump to T-0 (:func:`feedtwin.session.burn.jump_to_t0`):
tanks loaded to the fill, the bottle at the charge, every tank at the lockup
its regulator gives at the knobs as set. Then Fire, to depletion or the
horizon, on the cockpit's own numerics (``LIVE_STEP``, the session's Newton
allowance), so a case is the burn the console would fly from that T-0.

A case costs a burn's worth of compute (tens of seconds to a few minutes), so
a study is a job you start and collect: one at a time, on a worker, with
progress and cancel. The He/GN2 benchmark the physics regimen is stated
against is :mod:`backend.benchmark_study`, not this.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Sequence

from feedtwin.session.burn import BurnPlan, jump_to_t0, run_burn
from feedtwin.session.gauge import psig
from feedtwin.session.hookup import CHARGE, DOME

from backend.session import LIVE_STEP, Session

_log = logging.getLogger("feed-twin.study")

#: What a case can swap the bottle's gas for, by the fluid name drawings use.
PRESSURANTS = ("helium", "nitrogen")

#: Points kept per trace for the view. A 20 s burn on the 20 ms grid is 1,000.
MAX_POINTS = 600


@dataclass(frozen=True, slots=True)
class StudyCase:
    """One burn: the stand, with these changes."""

    label: str
    copv_psi: float | None = None
    """Bottle at T-0 [psig]; ``None`` is the stand's COPV fill target. A fuller
    bottle locks the tanks up lower: the supply effect is ``-S x inlet``."""
    knobs: Mapping[str, float] = field(default_factory=dict)
    """Knob id -> setting [psig], over the stand's."""
    bottle_litres: float | None = None
    """Every bottle's volume [L]; ``None`` keeps the drawing's."""
    fill_fraction: float | None = None
    """Liquid over tank volume at T-0; ``None`` is the stand's full fraction."""
    pressurant: str | None = None
    """``"helium"`` or ``"nitrogen"`` in the bottle and press lines; ``None``
    keeps the drawing's."""
    setup: Mapping[str, Any] = field(default_factory=dict)
    """Configuration rows, by key, over the stand's."""
    x: float | None = None
    """This case's value of the swept quantity, for the sweep plot."""

    @staticmethod
    def parse(raw: Mapping[str, Any], index: int) -> "StudyCase":
        def number(key: str) -> float | None:
            value = raw.get(key)
            if value is None or value == "":
                return None
            out = float(value)
            if out != out or out in (float("inf"), float("-inf")):
                raise ValueError(f"case {index + 1}: {key} is not a number")
            return out

        pressurant = raw.get("pressurant") or None
        if pressurant is not None and pressurant not in PRESSURANTS:
            raise ValueError(
                f"case {index + 1}: pressurant {pressurant!r}; "
                f"known: {', '.join(PRESSURANTS)}"
            )
        copv = number("copv_psi")
        if copv is not None and not 0.0 < copv <= 10000.0:
            raise ValueError(f"case {index + 1}: COPV {copv:g} psig is out of range")
        litres = number("bottle_litres")
        if litres is not None and not 0.0 < litres <= 500.0:
            raise ValueError(f"case {index + 1}: bottle {litres:g} L is out of range")
        fill = number("fill_fraction")
        if fill is not None and not 0.0 < fill <= 1.0:
            raise ValueError(f"case {index + 1}: fill {fill:g} is not in (0, 1]")
        knobs = {str(k): float(v) for k, v in dict(raw.get("knobs") or {}).items()}
        return StudyCase(
            label=str(raw.get("label") or f"Case {index + 1}"),
            copv_psi=copv,
            knobs=knobs,
            bottle_litres=litres,
            fill_fraction=fill,
            pressurant=pressurant,
            setup=dict(raw.get("setup") or {}),
            x=number("x"),
        )


@dataclass(frozen=True, slots=True)
class StudyRequest:
    """What to run: the stand's inputs once, and the cases on top of them."""

    base: Mapping[str, Any]
    """The stand as a run record keeps it (``diagram``, ``engine``,
    ``fluid_set``, ``machine``, ``multiphase``, ``setup``, ``hookup``,
    ``knobs``)."""
    cases: Sequence[StudyCase]
    horizon_s: float = 20.0
    sweep: str = ""
    """What the cases' ``x`` is, when they are a sweep."""
    stand: str = ""
    """Who to say this ran on: the stand's name, or the drawing's."""
    engine_name: str = ""


@dataclass(frozen=True, slots=True)
class CaseResult:
    label: str
    x: float | None
    changes: list[str]
    """What this case changed from the stand, in words."""
    t0: dict[str, Any]
    """Where it started: ``copv_psi``, ``tank_psi``, ``lockup_psi`` per tank,
    ``fill_fraction``, ``bottle_litres``."""
    t: list[float]
    tanks: dict[str, list[float]]
    """Tank label -> pressure [psig]."""
    bottles: dict[str, list[float]]
    chamber_psi: list[float]
    thrust_n: list[float]
    converged: list[bool]
    outcome: dict[str, Any]
    """The burn totalled as the Engine tab and a run record total it."""
    depleted_s: float | None
    tripped: str
    failed_ticks: int
    notes: list[str]
    error: str = ""


@dataclass(frozen=True, slots=True)
class StudyResult:
    cases: list[CaseResult] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


#: Builds the session a case burns on: the stand's inputs, the case's setup
#: and knobs merged in, and a pressurant to swap the bottle's gas for.
Build = Callable[[Mapping[str, Any], str | None], Session]
#: Totals the burn the session has just run, as a run record does.
Outcome = Callable[[Session], dict[str, Any]]
Progress = Callable[[int, int, str], None]


def case_inputs(base: Mapping[str, Any], case: StudyCase) -> dict[str, Any]:
    """The stand's inputs with the case's changes in them."""
    setup = {**dict(base.get("setup") or {}), **dict(case.setup)}
    if case.copv_psi is not None:
        # The charge is also the datum the regulators are set against.
        setup["copv_target"] = case.copv_psi
    if case.fill_fraction is not None:
        setup["full_fraction"] = case.fill_fraction
    knobs = {**dict(base.get("knobs") or {})}
    for knob, value in case.knobs.items():
        if knob == DOME:
            # The dome knob is the Configuration's dome setting, as on GSE.
            setup["dome"] = value
        elif knob == CHARGE:
            # The COPV fill knob is the Configuration's COPV target.
            setup["copv_target"] = value
        else:
            knobs[knob] = value
    return {**dict(base), "setup": setup, "knobs": knobs}


def describe(base: Mapping[str, Any], case: StudyCase) -> list[str]:
    """What the case changes, in a sentence each, for the results table."""
    out: list[str] = []
    if case.copv_psi is not None:
        out.append(f"COPV {case.copv_psi:.0f} psig")
    stand_knobs = dict(base.get("knobs") or {})
    stand_knobs[DOME] = dict(base.get("setup") or {}).get("dome")
    stand_knobs[CHARGE] = dict(base.get("setup") or {}).get("copv_target")
    for knob, value in case.knobs.items():
        if (
            stand_knobs.get(knob) is None
            or abs(float(stand_knobs[knob]) - value) > 1e-9
        ):
            out.append(f"{knob} {value:.0f} psig")
    if case.bottle_litres is not None:
        out.append(f"bottle {case.bottle_litres:g} L")
    if case.fill_fraction is not None:
        out.append(f"fill {case.fill_fraction * 100:.0f} %")
    if case.pressurant:
        out.append(case.pressurant)
    stand_setup = dict(base.get("setup") or {})
    for key, value in case.setup.items():
        if stand_setup.get(key) != value:
            out.append(f"{key} = {value}")
    return out or ["the stand as set"]


def _thin(n: int) -> list[int]:
    if n <= MAX_POINTS:
        return list(range(n))
    stride = -(-n // MAX_POINTS)
    keep = list(range(0, n, stride))
    if keep[-1] != n - 1:
        keep.append(n - 1)
    return keep


def run_case(
    request: StudyRequest,
    case: StudyCase,
    build: Build,
    outcome: Outcome,
    cancelled: Callable[[], bool] = lambda: False,
) -> CaseResult:
    """Build the case's stand, put it at T-0, and fire it."""
    session = build(case_inputs(request.base, case), case.pressurant)
    if case.bottle_litres is not None:
        for bottle in session.bottles.values():
            bottle.volume.volume = case.bottle_litres / 1e3
    copv = session.setup.copv_target_psi
    fill = session.setup.full_fraction
    t0 = jump_to_t0(session, copv_psi=copv, fill_fraction=fill)
    litres = [b.volume.volume * 1e3 for b in session.bottles.values()]
    plan = BurnPlan(
        tank_psi=t0.tank_psi,
        copv_psi=copv,
        fill_fraction=fill,
        # The fire load T-0 loaded. Left out, the burn's own prime reloaded
        # every tank to the fill fraction: a study case burned ~8.9 kg of LOX
        # against the 6.75 kg the cockpit's T-0 and the engine's config load,
        # and ran a second longer than the same stand on the console.
        loads=t0.loads or None,
        bottle_litres=case.bottle_litres,
        dt=LIVE_STEP,
        horizon_s=request.horizon_s,
        end_on_depletion=True,
    )
    trace = run_burn(session, plan, cancelled=cancelled)
    keep = _thin(len(trace.t))
    labels = {sim.id: sim.label for sim in session.tanks.values()}
    bottle_labels = {b.id: b.label for b in session.bottles.values()}

    def column(values: Sequence[float], places: int = 2) -> list[float]:
        return [round(float(values[i]), places) for i in keep]

    end = trace.end
    try:
        totals = outcome(session)
    except Exception as exc:  # noqa: BLE001 - the traces still stand
        totals = {}
        trace.notes.append(f"Not totalled: {exc}")
    return CaseResult(
        label=case.label,
        x=case.x,
        changes=describe(request.base, case),
        t0={
            "copv_psi": round(copv, 1),
            "tank_psi": t0.tank_psi,
            "lockup_psi": {labels.get(k, k): v for k, v in t0.lockup_psi.items()},
            "fill_fraction": round(fill, 4),
            "bottle_litres": round(litres[0], 3) if litres else None,
            # What each tank held at ignition, off the trace: what was burned.
            "loads_kg": {
                labels.get(k, k): round(v["liquid_mass_kg"][0], 3)
                for k, v in trace.tank.items()
                if v.get("liquid_mass_kg")
            },
        },
        t=column(trace.t, 3),
        tanks={
            labels.get(k, k): column([psig(p) for p in v["pressure_Pa"]])
            for k, v in trace.tank.items()
        },
        bottles={
            bottle_labels.get(k, k): column([psig(p) for p in v["pressure_Pa"]], 1)
            for k, v in trace.bottle.items()
        },
        chamber_psi=column(
            [
                psig(p) if on else 0.0
                for p, on in zip(
                    trace.chamber.get("pressure_Pa", [0.0] * len(trace.t)),
                    trace.firing,
                )
            ],
            1,
        ),
        thrust_n=column(
            [
                f if on else 0.0
                for f, on in zip(
                    trace.chamber.get("thrust_N", [0.0] * len(trace.t)), trace.firing
                )
            ],
            1,
        ),
        converged=[bool(trace.converged[i]) for i in keep],
        outcome=totals,
        depleted_s=end.depleted_s if end else None,
        tripped=(end.tripped.message if end and end.tripped else ""),
        failed_ticks=end.failed_steps if end else 0,
        notes=list(dict.fromkeys(trace.notes))[-12:],
    )


def run_study(
    request: StudyRequest,
    build: Build,
    outcome: Outcome,
    *,
    progress: Progress | None = None,
    cancelled: Callable[[], bool] = lambda: False,
    on_case: Callable[[CaseResult], None] | None = None,
) -> StudyResult:
    """Every case in turn. A case that fails says why and the rest still run."""
    result = StudyResult()
    total = len(request.cases)
    for index, case in enumerate(request.cases):
        if cancelled():
            break
        if progress is not None:
            progress(index, total, f"{case.label} ({index + 1} of {total})")
        try:
            done = run_case(request, case, build, outcome, cancelled)
        except Exception as exc:  # noqa: BLE001 - reported on the case
            # The case carries the type and message; the traceback stays in the
            # server log, or a crash in the physics has to be reproduced to be
            # found.
            _log.exception("study case %r failed", case.label)
            detail = getattr(exc, "detail", None) or str(exc)
            done = CaseResult(
                label=case.label,
                x=case.x,
                changes=describe(request.base, case),
                t0={},
                t=[],
                tanks={},
                bottles={},
                chamber_psi=[],
                thrust_n=[],
                converged=[],
                outcome={},
                depleted_s=None,
                tripped="",
                failed_ticks=0,
                notes=[],
                error=f"{type(exc).__name__}: {detail}",
            )
        result.cases.append(done)
        if on_case is not None:
            on_case(done)
    bad = sum(c.failed_ticks for c in result.cases)
    if bad:
        result.notes.append(
            f"{bad} step(s) did not converge; they are greyed on the plots"
        )
    if progress is not None:
        progress(len(result.cases), total, "done")
    return result


class StudyRunner:
    """One study at a time, on a worker thread, with progress and cancel.

    One at a time deliberately: each case pins a core, and two would only make
    both slower and the progress meaningless. Cases appear in :attr:`partial`
    as they finish, so the view can plot the first while the rest run.
    """

    def __init__(self) -> None:
        self.running = False
        self.progress = 0.0
        self.stage = ""
        self.error = ""
        self.request: StudyRequest | None = None
        self.result: StudyResult | None = None
        self.partial: list[CaseResult] = []
        self._cancel = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

    def start(self, request: StudyRequest, build: Build, outcome: Outcome) -> bool:
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
            self.partial = []
            self._cancel.clear()

        def work() -> None:
            try:

                def on_progress(done: int, total: int, stage: str) -> None:
                    self.progress = done / max(total, 1)
                    self.stage = stage

                self.result = run_study(
                    request,
                    build,
                    outcome,
                    progress=on_progress,
                    cancelled=self._cancel.is_set,
                    on_case=self.partial.append,
                )
                self.stage = "cancelled" if self._cancel.is_set() else "done"
            except Exception as exc:  # noqa: BLE001 - reported, not swallowed
                _log.exception("study failed")
                self.error = f"{type(exc).__name__}: {exc}"
                self.stage = "failed"
            finally:
                self.running = False
                self.progress = 1.0

        self._thread = threading.Thread(target=work, daemon=True, name="study")
        self._thread.start()
        return True

    def cancel(self) -> None:
        self._cancel.set()

    def wait(self, timeout: float | None = None) -> None:
        if self._thread is not None:
            self._thread.join(timeout)
