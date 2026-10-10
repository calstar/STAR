"""The DAQ box: the boards a drawing's symbols are cabled to.

The real stand declares its wiring in the DAQ's config: every actuator is a
name on a board and a channel (``[actuator_roles]``), every transducer a name
on a sensor board (``sensor_roles_<board>``), and the state table opens
*names*. The twin's hookup keeps the same three things as ``channels``
(feedtwin.session.hookup.Channel). This module is the app's half: which
boards there are, what each takes, and -- for a hookup nobody has wired yet
-- where the twin's own matching would have put each cable.

The boards are the ones on the stand's box, by what they take. Each takes one
kind of symbol: a solenoid board any valve the state table can drive (a
solenoid, a pneumatic ball valve, a motorised valve, a GSE vent disconnect),
a PT board a pressure transducer, the RTD and TC boards their sensors. 12 V
and 24 V, low and high pressure, are the person's to tell apart: the drawing
holds no voltage, and a transducer's range only suggests which board it is on.
Gauges, load cells, hand valves and regulators are not on the DAQ.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from feedtwin.session.gauge import psig
from feedtwin.session.hookup import Channel, Hookup
from feedtwin.session.hookup import binding as hookup_binding
from feedtwin.session.hookup import valves as hookup_valves
from feedtwin.session.model import Model
from feedtwin.session.statemachine import StateMachine

#: Connectors per row on every board, as the box is drawn.
PER_ROW = 5
#: Rows a board shows before anybody adds one.
ROWS = 2


@dataclass(frozen=True, slots=True)
class Board:
    id: str
    label: str
    kind: str
    """What plugs in: ``valve``, ``pt``, ``rtd`` or ``tc``."""


BOARDS: tuple[Board, ...] = (
    Board("sol12", "Solenoids 12V", "valve"),
    Board("sol24", "Solenoids 24V", "valve"),
    Board("pt_low", "Low press PT", "pt"),
    Board("pt_high", "High press PT", "pt"),
    Board("rtd", "RTDs", "rtd"),
    Board("tc", "TCs", "tc"),
)
KIND_OF_BOARD = {b.id: b.kind for b in BOARDS}

#: A transducer whose drawn range is above this goes on the high-pressure
#: board unless somebody moves it [psig]. The palette's two transducers are
#: 1,000 and 5,000 psi.
HIGH_RANGE_PSIG = 1500.0

#: The DAQ's own cabling (``[actuator_roles]``), copied beside its tables.
REFERENCE = Path(__file__).parent / "statemachines" / "diablo_channels.json"


@dataclass(frozen=True, slots=True)
class Symbol:
    id: str
    label: str
    type: str
    page: str
    kind: str
    board: str
    """Where it goes unless somebody says otherwise."""
    ground: bool


#: Drawn types the valve list can hold that no DAQ cable goes to.
NOT_CABLED = frozenset({"QD"})


def symbols(model: Model) -> list[Symbol]:
    """Everything on the drawing a connector can take, valves first."""
    built = model.built
    nodes = {n.id: n for n in model.diagram.nodes}
    ground = (
        frozenset()
        if built.vehicle is None
        else frozenset(n.id for n in model.diagram.nodes if n.id not in built.vehicle)
    )
    out: list[Symbol] = []
    for v in hookup_valves(model):
        node = nodes.get(v.id)
        # A disconnect is a fitting, not a solenoid: no cable runs to it. A
        # capped one stands in for the cart's vent rocket only (the binding's
        # stand-in, not a connector); the cart's vent valve is what is cabled.
        if node is not None and node.type in NOT_CABLED:
            continue
        out.append(
            Symbol(
                id=v.id,
                label=v.label,
                type=node.type if node is not None else "",
                page=v.page,
                kind="valve",
                board="sol24" if v.id in ground else "sol12",
                ground=v.id in ground,
            )
        )
    sensors = {"PT": "pt", "RTD": "rtd", "TC": "tc"}
    for inst in sorted(built.instruments, key=lambda i: i.id):
        kind = sensors.get(inst.type)
        node = nodes.get(inst.id)
        if kind is None or node is None:
            continue
        board = kind
        if kind == "pt":
            drawn = node.params.get("range_max")
            high = drawn is not None and psig(drawn.si) > HIGH_RANGE_PSIG
            board = "pt_high" if high else "pt_low"
        out.append(
            Symbol(
                id=inst.id,
                label=node.label or inst.id,
                type=inst.type,
                page=node.page or "Main",
                kind=kind,
                board=board,
                ground=inst.id in ground,
            )
        )
    order = {"valve": 0, "pt": 1, "rtd": 2, "tc": 3}
    return sorted(out, key=lambda s: (order[s.kind], s.ground, s.page, s.label))


def _reference() -> dict[str, tuple[str, int]]:
    """Actuator name -> (board, connector) on the DAQ's box."""
    try:
        raw: dict[str, Any] = json.loads(REFERENCE.read_text())
    except (OSError, ValueError):
        return {}
    boards = {str(k): str(v) for k, v in (raw.get("boards") or {}).items()}
    out: dict[str, tuple[str, int]] = {}
    for name, (slot, board) in (raw.get("actuators") or {}).items():
        if str(board) in boards:
            out[str(name)] = (boards[str(board)], int(slot))
    return out


def wiring(hookup: Hookup, model: Model, machine: StateMachine) -> Hookup:
    """``hookup`` as a box. A wired hookup is itself. One that is not -- the
    twin's suggestion, or pins from before the box -- gets the box its
    matching amounts to: each row the twin binds on a solenoid connector of
    its name (where the DAQ cables that row, when it says), and every
    transducer, RTD and thermocouple on its board under its console name. It
    binds exactly as the matching did, so saving it changes nothing."""
    if hookup.channels is not None:
        return hookup
    bound = hookup_binding(model, machine, hookup).to_symbol
    wanted = {s.id: s for s in symbols(model)}
    reference = _reference()
    taken: set[tuple[str, int]] = set()
    used: set[str] = set()
    channels: list[Channel] = []

    def free(board: str) -> int:
        slot = 1
        while (board, slot) in taken:
            slot += 1
        return slot

    def unique(name: str) -> str:
        out, n = name, 2
        while out.casefold() in used:
            out, n = f"{name} ({n})", n + 1
        return out

    def plug(board: str, slot: int, name: str, symbol: str) -> None:
        taken.add((board, slot))
        used.add(name.casefold())
        channels.append(Channel(board=board, slot=slot, name=name, symbol=symbol))

    # The rows first, at the DAQ's own connectors where it says.
    for actuator in machine.actuators:
        symbol = bound.get(actuator, "")
        if symbol not in wanted:
            continue
        board, slot = reference.get(actuator, (wanted[symbol].board, 0))
        if slot < 1 or (board, slot) in taken:
            slot = free(board)
        plug(board, slot, unique(actuator), symbol)
    for s in wanted.values():
        if s.kind == "valve":
            continue
        plug(s.board, free(s.board), unique(hookup.aliases.get(s.id) or s.label), s.id)
    rows = {
        board: max(
            ROWS, math.ceil(max(slot for b, slot in taken if b == board) / PER_ROW)
        )
        for board in {b for b, _ in taken}
    }
    return replace(hookup, channels=tuple(channels), rows=rows)


def problems(hookup: Hookup, model: Model) -> list[str]:
    """What a box cannot be on this drawing: a board the box does not have, a
    cable to a symbol that is not on the drawing or cannot go on that board."""
    wanted = {s.id: s for s in symbols(model)}
    nodes = {n.id: n for n in model.diagram.nodes}
    out: list[str] = []
    for c in hookup.channels or ():
        kind = KIND_OF_BOARD.get(c.board)
        label = next((b.label for b in BOARDS if b.id == c.board), c.board)
        if kind is None:
            out.append(f"{c.name}: there is no board {c.board!r}.")
        elif c.symbol in nodes and nodes[c.symbol].type in NOT_CABLED:
            out.append(
                f"{c.name}: {nodes[c.symbol].label or c.symbol} is a disconnect, "
                "which no DAQ cable goes to. Cable the valve behind it."
            )
        elif c.symbol not in wanted:
            out.append(
                f"{c.name}: {c.symbol} is not on this drawing, or is not something "
                "the DAQ can read or drive."
            )
        elif wanted[c.symbol].kind != kind:
            out.append(
                f"{c.name}: {wanted[c.symbol].label} is a {wanted[c.symbol].type}, "
                f"which does not plug into {label}."
            )
    return out
