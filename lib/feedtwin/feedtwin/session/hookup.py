"""How a stand's controls reach its drawing: which valve each state-machine
actuator drives, and which knob sets which regulator.

A drawing says what is plumbed; it does not say what the operator's panel
calls it. The DAQ's table commands "LOX Press" and "Fuel Main"; the drawing
has OU_SOL_R and FM-R. The GSE page has a hand-loaded regulator or three; the
drawing has PR symbols on two pages. Matching those up by name works for most
of a drawing (:func:`feedtwin.session.statemachine.bind`) and fails quietly for
the rest -- a main valve nothing commands, a cart regulator nothing turns.

A :class:`Hookup` is that matching written down, per drawing, by whoever knows
the stand. :func:`suggest` fills it the way the twin always matched -- names,
then what each valve is plumbed to do, and the one dome knob -- so an imported
drawing works at once and the person only has to fix what the names got wrong:

* ``valves``: actuator -> drawing id, only for what a person pinned. An empty
  id means "this actuator has no valve here". Everything not pinned is matched
  automatically, every time, so a drawing that grows a valve picks it up.
* ``knobs``: each a dial on the GSE page and the regulators it sets. A knob on
  a dome loader (the hand-loaded control regulator) sets that loader, and the
  dome follows through it as it always did; on a dome-loaded regulator with no
  loader drawn it sets the dome; on a plain regulator it sets the setpoint. A
  regulator on no knob holds what the drawing says. The knob with id
  :data:`DOME` is the session's ``Setup.dome_psi`` -- the cockpit's dome knob
  and Layer X's lockup solve keep driving it.

Gauge pressures throughout, as on the panel.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

from feedtwin.session.gauge import psig
from feedtwin.session.model import Model
from feedtwin.session.statemachine import Binding, StateMachine, bind

#: Bumped whenever the stored form changes meaning.
SCHEMA = 1

#: The knob the session's ``Setup.dome_psi`` drives.
DOME = "dome"


@dataclass(frozen=True, slots=True)
class Knob:
    """One dial on the GSE page, and the regulators it sets."""

    id: str
    label: str
    regulators: tuple[str, ...] = ()
    """Drawing ids of the PR symbols this knob sets."""
    psig: float = 500.0
    """Where it starts [psig]."""
    low: float = 0.0
    high: float = 1000.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "regulators": list(self.regulators),
            "psig": self.psig,
            "low": self.low,
            "high": self.high,
        }

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "Knob":
        return cls(
            id=str(raw["id"]),
            label=str(raw.get("label") or raw["id"]),
            regulators=tuple(str(r) for r in raw.get("regulators") or ()),
            psig=float(raw.get("psig", 500.0)),
            low=float(raw.get("low", 0.0)),
            high=float(raw.get("high", 1000.0)),
        )


@dataclass(frozen=True, slots=True)
class Hookup:
    """What a person decided about one drawing's controls."""

    valves: Mapping[str, str] = field(default_factory=dict)
    """Pinned actuators: table name -> drawing id ("" = no valve here)."""
    knobs: tuple[Knob, ...] = ()

    def knob_for(self, regulator: str) -> Knob | None:
        return next((k for k in self.knobs if regulator in k.regulators), None)

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": SCHEMA,
            "valves": dict(self.valves),
            "knobs": [k.to_dict() for k in self.knobs],
        }

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "Hookup":
        schema = int(raw.get("schema", SCHEMA))
        if schema != SCHEMA:
            raise ValueError(f"hookup schema {schema}; this feedtwin reads {SCHEMA}")
        knobs = tuple(Knob.from_dict(k) for k in raw.get("knobs") or ())
        ids = [k.id for k in knobs]
        if len(set(ids)) != len(ids):
            raise ValueError("two knobs share an id")
        owned = [r for k in knobs for r in k.regulators]
        if len(set(owned)) != len(owned):
            raise ValueError("a regulator is on two knobs; it can only be set once")
        return cls(
            valves={str(a): str(s or "") for a, s in (raw.get("valves") or {}).items()},
            knobs=knobs,
        )


@dataclass(frozen=True, slots=True)
class RegulatorInfo:
    """A PR symbol on the drawing, as a knob sees it."""

    id: str
    label: str
    kind: str
    """``loader`` (sets another's dome), ``dome`` (dome-loaded, no loader
    drawn) or ``plain`` (a hand-loaded setpoint)."""
    page: str
    drawn_psig: float | None
    """What the drawing sets it to [psig], if it says."""
    signal: str
    """The signal a knob drives (``<label>.dome``); for a loader, the loaded
    regulator's."""


@dataclass(frozen=True, slots=True)
class ValveInfo:
    id: str
    label: str
    page: str
    role: tuple[str, ...]
    """What the topology says it does (``("fuel", "press")``), if it settles it."""


def valves(model: Model) -> list[ValveInfo]:
    """Every valve a state-machine actuator could drive."""
    built = model.built
    by_id = {n.id: n for n in model.diagram.nodes}
    out = []
    for sid, signal in built.actuators.items():
        if signal.endswith(".dome") or sid not in by_id:
            continue
        node = by_id[sid]
        out.append(
            ValveInfo(
                id=sid,
                label=node.label or sid,
                page=node.page or "Main",
                role=tuple(sorted(built.valve_roles.get(sid, frozenset()))),
            )
        )
    return sorted(out, key=lambda v: (v.page, v.label))


def regulators(model: Model) -> list[RegulatorInfo]:
    """Every regulator on the drawing a knob could set."""
    built = model.built
    loaded = {loader.signal for loader in built.dome_loaders.values()}
    out = []
    for node in model.diagram.nodes:
        if node.type != "PR":
            continue
        if f"{node.label or node.id}.dome" in loaded:
            continue  # its dome comes from the loader drawn on it: turn that
        if node.id in built.dome_loaders:
            kind, signal = "loader", built.dome_loaders[node.id].signal
            param = node.params.get("setpoint")
        elif node.options.get("domeLoaded") == "yes":
            kind, signal = "dome", f"{node.label or node.id}.dome"
            param = node.params.get("dome_pressure")
        else:
            kind, signal = "plain", f"{node.label or node.id}.dome"
            param = node.params.get("setpoint")
        if node.id not in built.dome_loaders and node.id not in built.network.branches:
            continue  # not built: a regulator with nothing plumbed to it
        out.append(
            RegulatorInfo(
                id=node.id,
                label=node.label or node.id,
                kind=kind,
                page=node.page or "Main",
                drawn_psig=psig(param.si) if param is not None else None,
                signal=signal,
            )
        )
    return sorted(out, key=lambda r: (r.page, r.label))


def suggest(model: Model, dome_psig: float = 500.0) -> Hookup:
    """The hookup the twin used before anyone wrote one down, exactly.

    No pinned valves (names and roles decide). One knob, :data:`DOME`, on
    every dome loader -- or, with none drawn, on the first dome-loaded
    regulator -- which is what the session's single dome knob always drove.
    Every other regulator holds its drawn setting until someone gives it a knob.
    """
    built = model.built
    loaders = sorted(built.dome_loaders)
    if loaders:
        owned: tuple[str, ...] = tuple(loaders)
    else:
        first = next(
            (sid for sid, s in built.actuators.items() if s.endswith(".dome")), ""
        )
        owned = (first,) if first else ()
    if not owned:
        return Hookup()
    labels = {n.id: n.label or n.id for n in model.diagram.nodes}
    return Hookup(
        knobs=(
            Knob(
                id=DOME,
                label=(
                    "Dome control regulator"
                    if len(owned) != 1
                    else f"Dome control regulator ({labels.get(owned[0], owned[0])})"
                ),
                regulators=owned,
                psig=dome_psig,
                low=0.0,
                high=1000.0,
            ),
        )
    )


def binding(model: Model, machine: StateMachine, hookup: Hookup | None) -> Binding:
    """The machine bound to the drawing's valves, pins first."""
    # Valves only: a regulator's dome signal is a knob's, not the table's.
    labels = {
        node.id: node.label or node.id
        for node in model.diagram.nodes
        if node.id in model.built.actuators
        and not model.built.actuators[node.id].endswith(".dome")
    }
    return bind(
        machine,
        labels,
        roles=model.built.valve_roles,
        overrides=dict(hookup.valves) if hookup is not None else None,
    )
