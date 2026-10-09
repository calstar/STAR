"""Runs: every burn the cockpit fires, kept as a record that can be read a year on.

A run record is what a burn was *and* everything it depended on:

* **inputs** -- the drawing and engine (library artifact ids: content hashes,
  so they name exact bytes), the fluid set, the state machine, every
  Configuration-tab setting, the hookup and its knobs, and T-0 (each tank's
  pressure, load and temperature, each bottle's pressure, at the last sample
  before ignition);
* **code** -- the app and library versions and the git commit, dirty or not;
* **the stand** it ran on, when the session was opened from one, with its
  version;
* **outcome** -- the burn totalled the way the Engine tab totals it;
* **solver** -- the residual, continuity, chamber-closure and mass-balance
  summary over the burn's own ticks, so a record says whether its numbers
  were converged;
* **series** -- thrust, chamber pressure, O/F and the tanks, thinned.

Two records diff by input and by outcome (:func:`diff`). Which input moved the
answer is a separate question -- one a diff cannot answer, because inputs
interact -- and :class:`Explainer` answers it by re-running: each run's T-0
replayed headless, then one input group at a time swapped from the first run
to the second. What is left over after the single swaps is the interaction,
reported as such rather than spread across the groups.

Records live in the stardesign user-data volume, ``<root>/<user>/runs``: on a
stand, in the stand owner's folder, so everyone the stand is shared with sees
its runs; otherwise in the runner's own. They are evidence, so they are never
edited; an owner may delete one.
"""

from __future__ import annotations

import json
import math
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from backend import userdata

#: Record layout version. Bump on a change a reader must know about.
SCHEMA = 1

#: The ``<app>`` segment run records live under, beside ``stand``.
APP = "runs"

#: Points kept per series on a record.
SERIES_POINTS = 600

#: The outcome numbers a diff compares and the ladder attributes, with units.
OUTCOME_KEYS: tuple[tuple[str, str, str], ...] = (
    ("thrust_mean_N", "Mean thrust", "N"),
    ("impulse_Ns", "Impulse", "N·s"),
    ("duration_s", "Duration", "s"),
    ("pc_mean_psi", "Mean Pc", "psig"),
    ("of_mean", "O/F", ""),
    ("isp_s", "Isp", "s"),
    ("oxidiser_kg", "LOX used", "kg"),
    ("fuel_kg", "Fuel used", "kg"),
)

_ID = re.compile(r"^[0-9]{8}T[0-9]{6}-[0-9a-f]{6}$")


def new_id(now: float | None = None) -> str:
    """Sortable by time, unique by suffix: ``20261006T171502-3fa9c1``."""
    stamp = datetime.fromtimestamp(now or time.time(), tz=timezone.utc)
    return f"{stamp:%Y%m%dT%H%M%S}-{uuid.uuid4().hex[:6]}"


def stride_indices(n: int, points: int = SERIES_POINTS) -> list[int]:
    """Evenly spaced indices into ``n`` samples, first and last always kept."""
    if n <= points:
        return list(range(n))
    step = (n - 1) / (points - 1)
    return sorted({min(int(round(i * step)), n - 1) for i in range(points)})


# ---------------------------------------------------------------------- store


class RunStore:
    """Run records on the user-data volume, one JSON file each."""

    def folder(self, user: str, *, create: bool = True) -> Path:
        folder: Path = userdata.store.user_dir(user, APP, create=create)
        return folder

    def save(self, user: str, record: dict[str, Any]) -> dict[str, Any]:
        run_id = str(record.get("id") or new_id())
        record = {**record, "id": run_id, "owner": user}
        path = self.folder(user) / f"{run_id}.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(record, indent=1, default=_jsonable))
        tmp.replace(path)
        return record

    def get(self, user: str, run_id: str) -> dict[str, Any] | None:
        if not _ID.match(run_id):
            return None
        path = self.folder(user, create=False) / f"{run_id}.json"
        if not path.is_file():
            return None
        loaded: dict[str, Any] = json.loads(path.read_text())
        return loaded

    def list(
        self, users: Iterable[str], *, stand: str | None = None
    ) -> list[dict[str, Any]]:
        """Summaries, newest first, across ``users``' folders."""
        out: list[dict[str, Any]] = []
        for user in dict.fromkeys(users):
            folder = self.folder(user, create=False)
            if not folder.is_dir():
                continue
            for path in folder.glob("*.json"):
                try:
                    record = json.loads(path.read_text())
                except (OSError, ValueError):
                    continue
                ref = record.get("stand") or {}
                if stand is not None and ref.get("id") != stand:
                    continue
                out.append(summary(record))
        out.sort(key=lambda r: str(r["id"]), reverse=True)
        return out


def summary(record: Mapping[str, Any]) -> dict[str, Any]:
    outcome = record.get("outcome") or {}
    solver = record.get("solver") or {}
    inputs = record.get("inputs") or {}
    setup = inputs.get("setup") or {}
    return {
        "id": record.get("id"),
        "owner": record.get("owner"),
        "user": record.get("user"),
        "created": record.get("created"),
        "label": record.get("label", ""),
        "stand": record.get("stand"),
        "engine_model": outcome.get("engine_model", ""),
        # What it ran on, so a list of runs says which are comparable: the
        # drawing and engine (library ids) and whether the GSE was cut away.
        "diagram": inputs.get("diagram", ""),
        "engine": inputs.get("engine", ""),
        "rocket_only": bool(setup.get("ignore_gse", False)),
        "outcome": {k: outcome.get(k) for k, _, _ in OUTCOME_KEYS},
        "converged": not solver.get("unconverged"),
        # Unexplained mass where the record has it (error less the guards'
        # booked corrections); older records carry only the mass error.
        "mass_error_ppm": solver.get("unexplained_ppm", solver.get("mass_error_ppm")),
        "code": record.get("code"),
    }


def _jsonable(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if hasattr(value, "to_dict"):
        return value.to_dict()
    return str(value)


store = RunStore()


# ----------------------------------------------------------------------- diff


def flatten(value: Any, prefix: str = "") -> dict[str, Any]:
    """``{"a": {"b": 1}}`` -> ``{"a.b": 1}``; lists stay whole."""
    if isinstance(value, Mapping):
        out: dict[str, Any] = {}
        for key, item in value.items():
            out.update(flatten(item, f"{prefix}.{key}" if prefix else str(key)))
        return out
    return {prefix: value}


def _same(a: Any, b: Any) -> bool:
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return math.isclose(float(a), float(b), rel_tol=1e-9, abs_tol=1e-12)
    return bool(a == b)


def diff(a: Mapping[str, Any], b: Mapping[str, Any]) -> dict[str, Any]:
    """What differs between two runs: inputs, code and stand, then outcome.

    ``inputs`` lists every changed leaf with its group (:func:`group_of`), so a
    reader sees "setup.vapour: false -> true" rather than "the setup changed".
    """
    fa = flatten(a.get("inputs") or {})
    fb = flatten(b.get("inputs") or {})
    changed = [
        {"key": key, "group": group_of(key), "a": fa.get(key), "b": fb.get(key)}
        for key in sorted(set(fa) | set(fb))
        if not _same(fa.get(key), fb.get(key))
    ]
    code_a, code_b = a.get("code") or {}, b.get("code") or {}
    code = [
        {"key": key, "a": code_a.get(key), "b": code_b.get(key)}
        for key in sorted(set(code_a) | set(code_b))
        if code_a.get(key) != code_b.get(key)
    ]
    oa, ob = a.get("outcome") or {}, b.get("outcome") or {}
    outcome = []
    for key, label, unit in OUTCOME_KEYS:
        va, vb = oa.get(key), ob.get(key)
        delta = (
            float(vb) - float(va)
            if isinstance(va, (int, float)) and isinstance(vb, (int, float))
            else None
        )
        pct = (
            delta / float(va) * 100.0
            if delta is not None and isinstance(va, (int, float)) and va
            else None
        )
        outcome.append(
            {
                "key": key,
                "label": label,
                "unit": unit,
                "a": va,
                "b": vb,
                "delta": delta,
                "pct": pct,
            }
        )
    return {
        "a": summary(a),
        "b": summary(b),
        "inputs": changed,
        "groups": sorted({c["group"] for c in changed}),
        "code": code,
        "stand": {"a": a.get("stand"), "b": b.get("stand")},
        "outcome": outcome,
    }


#: Input groups, in the order the ladder swaps them, and the keys each owns.
GROUPS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("drawing", ("diagram", "hookup", "multiphase")),
    ("engine", ("engine",)),
    ("fluids", ("fluid_set",)),
    ("state machine", ("machine",)),
    ("regulator knobs", ("knobs",)),
    ("T-0", ("t0",)),
    ("settings", ("setup",)),
)


def group_of(key: str) -> str:
    head = key.split(".", 1)[0]
    for name, keys in GROUPS:
        if head in keys:
            return f"setting: {key.split('.', 1)[1]}" if head == "setup" else name
    return head


# ---------------------------------------------------------------- the ladder


@dataclass
class Rung:
    """One re-run: which group it took from the second run, and what it gave."""

    label: str
    swapped: tuple[str, ...]
    outcome: dict[str, float] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)
    error: str = ""
    wall_s: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "swapped": list(self.swapped),
            "outcome": self.outcome,
            "notes": self.notes,
            "error": self.error,
            "wall_s": round(self.wall_s, 1),
        }


#: Re-runs one set of inputs headless and returns its outcome numbers.
Replay = Callable[
    [Mapping[str, Any], Callable[[], bool]], tuple[dict[str, float], list[str]]
]

#: More changed settings than this and they go in as one rung.
MAX_SETTING_RUNGS = 6


def swaps(
    a: Mapping[str, Any], b: Mapping[str, Any]
) -> list[tuple[str, tuple[str, ...]]]:
    """The rungs between two runs' inputs: one per changed group, and one per
    changed setting while there are few enough to afford it."""
    fa, fb = flatten(a), flatten(b)
    changed = {k for k in set(fa) | set(fb) if not _same(fa.get(k), fb.get(k))}
    out: list[tuple[str, tuple[str, ...]]] = []
    for name, keys in GROUPS:
        if name == "settings":
            settings = sorted(k for k in changed if k.startswith("setup."))
            if 0 < len(settings) <= MAX_SETTING_RUNGS:
                out.extend((f"setting: {k[6:]}", (k,)) for k in settings)
            elif settings:
                out.append(("settings", ("setup",)))
            continue
        if any(k.split(".", 1)[0] in keys for k in changed):
            out.append((name, keys))
    return out


def with_swapped(
    a: Mapping[str, Any], b: Mapping[str, Any], keys: tuple[str, ...]
) -> dict[str, Any]:
    """``a``'s inputs with ``keys`` (top-level or ``setup.<field>``) from ``b``."""
    out: dict[str, Any] = json.loads(json.dumps(a))
    for key in keys:
        if key.startswith("setup."):
            name = key[6:]
            out.setdefault("setup", {})
            if name in (b.get("setup") or {}):
                out["setup"][name] = b["setup"][name]
            else:
                out["setup"].pop(name, None)
        elif key in b:
            out[key] = json.loads(json.dumps(b[key]))
        else:
            out.pop(key, None)
    return out


def attribute(
    base: Mapping[str, float], full: Mapping[str, float], rungs: list[Rung]
) -> list[dict[str, Any]]:
    """Per outcome: the change, each rung's share, and the interaction left."""
    out = []
    for key, label, unit in OUTCOME_KEYS:
        if key not in base or key not in full:
            continue
        total = full[key] - base[key]
        deltas = [
            (r.label, r.outcome[key] - base[key]) for r in rungs if key in r.outcome
        ]
        parts = [{"label": name, "delta": delta} for name, delta in deltas]
        explained = sum(delta for _, delta in deltas)
        out.append(
            {
                "key": key,
                "label": label,
                "unit": unit,
                "a": base[key],
                "b": full[key],
                "total": total,
                "parts": parts,
                "interaction": total - explained,
            }
        )
    return out


class Explainer:
    """One attribution at a time, in a thread, polled.

    Each rung is a full headless burn (tens of seconds), so this is a job, not
    a request. A second start while one runs is refused, not queued: a person
    who wants the second answer cancels the first.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._cancel = False
        self.state: dict[str, Any] = {"running": False}

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def cancel(self) -> None:
        self._cancel = True

    def start(self, a: Mapping[str, Any], b: Mapping[str, Any], replay: Replay) -> bool:
        with self._lock:
            if self.running:
                return False
            self._cancel = False
            plan = swaps(a["inputs"], b["inputs"])
            self.state = {
                "running": True,
                "a": a["id"],
                "b": b["id"],
                "stage": "starting",
                "done": 0,
                "total": len(plan) + 2,
                "rungs": [],
                "error": "",
            }
            self._thread = threading.Thread(
                target=self._run, args=(a, b, plan, replay), daemon=True
            )
            self._thread.start()
            return True

    def _run(
        self,
        a: Mapping[str, Any],
        b: Mapping[str, Any],
        plan: list[tuple[str, tuple[str, ...]]],
        replay: Replay,
    ) -> None:
        cancelled = lambda: self._cancel  # noqa: E731
        state = self.state

        def one(
            label: str, inputs: Mapping[str, Any], swapped: tuple[str, ...]
        ) -> Rung:
            state["stage"] = label
            rung = Rung(label=label, swapped=swapped)
            started = time.perf_counter()
            try:
                rung.outcome, rung.notes = replay(inputs, cancelled)
            except Exception as exc:  # noqa: BLE001 - reported on the rung
                rung.error = str(exc) or type(exc).__name__
            rung.wall_s = time.perf_counter() - started
            state["done"] += 1
            return rung

        try:
            base = one("first run, replayed", a["inputs"], ())
            state["base"] = base.to_dict()
            if self._cancel:
                raise _Cancelled
            full = one("second run, replayed", b["inputs"], ())
            state["full"] = full.to_dict()
            rungs: list[Rung] = []
            for label, keys in plan:
                if self._cancel:
                    raise _Cancelled
                rung = one(label, with_swapped(a["inputs"], b["inputs"], keys), keys)
                rungs.append(rung)
                state["rungs"] = [r.to_dict() for r in rungs]
            if base.error or full.error:
                state["error"] = base.error or full.error
            else:
                state["attribution"] = attribute(
                    base.outcome, full.outcome, [r for r in rungs if not r.error]
                )
                state["reproduction"] = _reproduction(a, b, base, full)
            state["stage"] = "done"
        except _Cancelled:
            state["stage"] = "cancelled"
        except Exception as exc:  # noqa: BLE001 - surfaced on the job
            state["error"] = str(exc) or type(exc).__name__
            state["stage"] = "failed"
        finally:
            state["running"] = False


class _Cancelled(Exception):
    pass


def _reproduction(
    a: Mapping[str, Any], b: Mapping[str, Any], base: Rung, full: Rung
) -> list[dict[str, Any]]:
    """How far each headless replay landed from the burn it replays.

    The ladder is internally consistent -- every rung on the same scheme -- but
    a cockpit burn is flown by a person (holds, the moment Fire was pressed,
    when it was aborted), and a replay from T-0 is not. A large gap here says
    the attribution explains the replay, and the replay is not the burn.
    """
    out = []
    for name, record, rung in (("first", a, base), ("second", b, full)):
        recorded = record.get("outcome") or {}
        for key in ("thrust_mean_N", "of_mean", "pc_mean_psi"):
            if key in rung.outcome and isinstance(recorded.get(key), (int, float)):
                out.append(
                    {
                        "run": name,
                        "key": key,
                        "recorded": recorded[key],
                        "replayed": rung.outcome[key],
                    }
                )
    return out
