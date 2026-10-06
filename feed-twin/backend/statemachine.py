"""The stand's state machine: the shipped DAQ tables, read by the library.

Reading the tables and binding their actuators to a drawing moved to
:mod:`feedtwin.session.statemachine` when the marching session became library
code (EngineDesign's Layer X runs it in-process). What stays here is the one
thing that belongs to this app: the copy of the DAQ's tables it ships, in
``statemachines/`` -- see ``NEEDS-REPAIR.md`` there.
"""

from __future__ import annotations

from pathlib import Path

from feedtwin.session import statemachine as _machines
from feedtwin.session.statemachine import Binding, StateMachine, bind

__all__ = ["TABLES", "Binding", "StateMachine", "available", "bind", "load_machine"]

#: Shipped tables, copied verbatim from daq-server/config.
TABLES = Path(__file__).parent / "statemachines"


def load_machine(
    name: str = "diablo",
    *,
    actuators: Path | None = None,
    transitions: Path | None = None,
) -> StateMachine:
    """Read a machine from its two tables, the shipped copy unless told otherwise."""
    machine: StateMachine = _machines.load_machine(
        name, actuators=actuators, transitions=transitions, tables=TABLES
    )
    return machine


def available() -> list[str]:
    """Machines shipped with the app."""
    # Annotated: the app's mypy run cannot see into the editable feedtwin
    # install, so the library call reads as Any here (see backend/run.py).
    machines: list[str] = _machines.available(TABLES)
    return machines
