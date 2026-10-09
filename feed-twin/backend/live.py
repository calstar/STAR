"""A drawing's model with the stand's state machine bound to its valves.

What every session, hookup and state-machine view is opened on. The stand is
solved only in time, by a :class:`~feedtwin.session.core.Session`; the
quasi-static "solve it where it stands" and "march a burn with the tanks held"
endpoints this module used to back are gone (2026-10-08): nothing called them,
and they held the tanks at dome + bias, which no stand locks up at.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping

from backend.assembly import Model
from backend.statemachine import Binding, StateMachine
from feedtwin.session.hookup import Hookup


@dataclass(frozen=True, slots=True)
class Stand:
    """A model plus the state machine bound to it."""

    model: Model
    machine: StateMachine
    binding: Binding
    #: Which knob sets which regulator, and the valve pins the binding used
    #: (feedtwin.session.hookup). None: the session's old single dome knob.
    hookup: Hookup | None = None
    #: Where the drawing sets each knob [psig], by knob id
    #: (feedtwin.session.hookup.knob_starts): what a fresh stand's dome and
    #: COPV fill start at unless the operator has turned them. Read off the
    #: whole drawing, so a stand built on the rocket alone still charges to
    #: the cart regulator's setting.
    drawn: Mapping[str, float] = field(default_factory=dict)
    #: What the stand was built on that the operator should be told: a saved
    #: hookup that could not be read, and was replaced by the suggestion.
    notes: tuple[str, ...] = ()
