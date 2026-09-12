"""The stand's state machine, read from the same tables the DAQ runs on.

The DAQ does not have a state machine written in code; it has two CSVs, and the
firmware and the GUI both read them. So does this. Copying the *behaviour* into
Python would have created a second source of truth that drifts silently the
first time somebody adds a state -- and the whole point of the twin is that it
does what the stand does.

``state_machine_actuators.csv``
    A matrix. One row per actuator, one column per state, ``OPEN`` or ``CLOSE``
    in each cell. This is what a state *is* on this stand: a column.

``state_transitions.csv``
    Which moves are legal, as a square 0/1 matrix. Idle cannot go straight to
    Fire; it goes through Armed and the press states. Enforcing that here means
    the twin refuses the same sequences the stand refuses, which is most of what
    makes it useful for training somebody.

Matching actuators to a drawing
-------------------------------
The tables name actuators the way the crew does -- "LOX Main", "Fuel Vent". A
P&ID names them however the person drawing it typed them -- "MV-OX", "MVO",
"SV-FUEL-VENT". So the join is fuzzy and, more importantly, *reported*: a run
says which actuators matched a symbol and which did not, because an unmatched
"LOX Main" means the main valve is not being commanded at all and the trace
would look like a very smooth start.
"""

from __future__ import annotations

import csv
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping, Sequence

#: Shipped tables, copied verbatim from daq-server/config.
TABLES = Path(__file__).parent / "statemachines"

#: Prefixes that say how a valve is actuated, not what it does. A solenoid and
#: a ball valve in the same place are the same actuator to a state machine.
_NOISE = {"valve", "sv", "bv", "nv", "av", "act", "the"}

#: Drawing vocabulary to table vocabulary. Two kinds live here and both matter.
#:
#: The **function** prefixes are the ones an outsider would drop as noise and
#: must not: on a P&ID "MV" is a *main valve* and "MV-OX" is exactly the table's
#: "LOX Main". Treating it as noise leaves the main valves unbound, which is
#: silent and catastrophic -- the mains are what a Fire state opens.
#:
#: The **fluid** synonyms are the ordinary half.
_SYNONYM = {
    # function
    "mv": "main",
    "mov": "main",
    "main": "main",
    "vent": "vent",
    "fill": "fill",
    "dump": "dump",
    "press": "press",
    "pressurisation": "press",
    "pressurization": "press",
    # fluid
    "ox": "lox",
    "oxidiser": "lox",
    "oxidizer": "lox",
    "oxygen": "lox",
    "o": "lox",
    "o2": "lox",
    "fu": "fuel",
    "eth": "fuel",
    "ethanol": "fuel",
    "etoh": "fuel",
    "f": "fuel",
    "n2": "gn2",
    "gn": "gn2",
    "nitrogen": "gn2",
    # The table says GN2 because the stand presses on nitrogen; a drawing
    # pressed on helium names the same valves HE. It is the pressurant either
    # way, and "GN2 Vent" has to find "SV-HE-VENT" or the helium stand's
    # pressurant vent is never commanded.
    "he": "gn2",
    "helium": "gn2",
    "ghe": "gn2",
    "press_gas": "gn2",
    "pressurant": "gn2",
}

#: Words that name a propellant. Two names that disagree on one of these are
#: different actuators however much else they share -- "LOX Vent" must never
#: bind to a fuel valve just because both are vents.
_FLUIDS = frozenset({"lox", "fuel", "gn2"})


def _split(token: str) -> list[str] | None:
    """Break a run-together tag into known words, or ``None``.

    A drawing writes the same valve as ``MV-OX`` or ``MVO``, and the second is
    one token that matches nothing. Splitting it into ``mv`` + ``o`` -- both of
    which the table understands -- is the difference between the LOX main being
    commanded and it being silently left out of every state.

    Only splits where *both* halves are known words, so an ordinary tag is not
    shredded into coincidences.
    """
    for cut in range(2, len(token)):
        left, right = token[:cut], token[cut:]
        if left in _SYNONYM and right in _SYNONYM:
            return [_SYNONYM[left], _SYNONYM[right]]
    return None


def _words(text: str) -> frozenset[str]:
    """Normalise a name to the set of words that identify it."""
    parts = re.split(r"[^a-z0-9]+", text.lower())
    out: set[str] = set()
    for part in parts:
        if not part or part in _NOISE:
            continue
        if part in _SYNONYM:
            out.add(_SYNONYM[part])
            continue
        pieces = _split(part)
        out.update(pieces if pieces is not None else [part])
    return frozenset(out)


@dataclass(frozen=True, slots=True)
class StateMachine:
    """States, the actuator positions each one commands, and the legal moves."""

    name: str
    states: tuple[str, ...]
    actuators: tuple[str, ...]
    #: ``positions[state][actuator]`` is True for open.
    positions: Mapping[str, Mapping[str, bool]]
    #: ``allowed[state]`` is the set of states reachable from it.
    allowed: Mapping[str, frozenset[str]]
    warnings: tuple[str, ...] = ()
    """Problems in the tables themselves. Reported rather than repaired: only
    whoever maintains the CSV knows which column a short row is missing."""

    def can_go(self, current: str, target: str) -> bool:
        """Whether the stand would accept this transition.

        A state with no row in the transition table is unconstrained rather than
        stuck: a table that lists fewer states than the actuator matrix is a
        table somebody is still filling in, and refusing every move out of a
        half-written state helps nobody.

        Abort is always reachable, whatever the table says. That is a rule about
        stands rather than an inference about this file, and it exists because
        the failure it guards against is asymmetric: a spurious abort path costs
        an operator one confused moment, and a missing one costs an abort.
        """
        if current == target or _is_abort(target):
            return True
        reachable = self.allowed.get(current)
        if reachable is None:
            # FAIL CLOSED for a state with no row at all. A state the table
            # never mentions constrains nothing, and treating that as "allow
            # everything" is worse than no state machine, because the operator
            # believes an interlock is watching. Short rows are a different
            # case and are read the way the DAQ reads them -- see load_machine.
            return False
        return target in reachable

    def targets(self, current: str) -> list[str]:
        return [s for s in self.states if s != current and self.can_go(current, s)]

    def open_actuators(self, state: str) -> frozenset[str]:
        row = self.positions.get(state, {})
        return frozenset(name for name, is_open in row.items() if is_open)


@dataclass(frozen=True, slots=True)
class Binding:
    """How the machine's actuators map onto one drawing's symbols."""

    #: Table actuator name -> drawing symbol id.
    to_symbol: Mapping[str, str] = field(default_factory=dict)
    #: Actuators with no symbol on this drawing. Not an error -- a stand has
    #: fill and dump valves a feed drawing need not show -- but a "LOX Main"
    #: in here means the main valve is never commanded, which is.
    unmatched: tuple[str, ...] = ()
    #: Drawing valves the machine never commands. They keep whatever position
    #: the operator last set by hand.
    uncommanded: tuple[str, ...] = ()

    def positions_for(self, machine: StateMachine, state: str) -> dict[str, float]:
        """Commanded positions keyed by drawing symbol id, for the solver."""
        row = machine.positions.get(state, {})
        out: dict[str, float] = {}
        for actuator, is_open in row.items():
            symbol = self.to_symbol.get(actuator)
            if symbol:
                out[symbol] = 1.0 if is_open else 0.0
        return out


def _is_abort(state: str) -> bool:
    return "abort" in state.lower()


def _read_matrix(path: Path) -> tuple[list[str], list[str], list[list[str]]]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        rows = [r for r in csv.reader(handle) if any(cell.strip() for cell in r)]
    if not rows:
        raise ValueError(f"{path.name} is empty")
    header = [c.strip() for c in rows[0][1:]]
    labels = [r[0].strip() for r in rows[1:]]
    body = [[c.strip() for c in r[1:]] for r in rows[1:]]
    return header, labels, body


def load_machine(
    name: str = "diablo",
    *,
    actuators: Path | None = None,
    transitions: Path | None = None,
) -> StateMachine:
    """Read a machine from its two tables."""
    act_path = actuators or TABLES / f"{name}_actuators.csv"
    trans_path = transitions or TABLES / f"{name}_transitions.csv"

    states, actuator_names, body = _read_matrix(act_path)
    positions: dict[str, dict[str, bool]] = {s: {} for s in states}
    for actuator, row in zip(actuator_names, body):
        for state, cell in zip(states, row):
            positions[state][actuator] = cell.upper().startswith("OPEN")

    warnings: list[str] = []
    # Positions that cannot be what anybody meant, read exactly as the DAQ
    # reads them. A main valve is only ever open with the engine lit, and a
    # cold, de-energised stand has nothing open at all; the shipped table
    # says otherwise in four places.
    #
    # Idle is the one place the twin does NOT do as the table says. Idle is
    # the de-energised state -- what the panel is in before anybody arms
    # anything and what every solenoid falls back to unpowered -- and OPEN in
    # that column cannot be a position a normally-closed solenoid holds. Read
    # literally it opened LOX Press, and once a bottle could be full at
    # start-up it pressed the LOX tank to 550 psig before the operator had
    # touched a thing. Transitions stay faithful to the byte (an interlock
    # the stand lacks must be missing here too); a valve position that
    # pressurises a cold stand is not an interlock, it is a typo, and the
    # warning below says exactly what the table claimed.
    mains = [a for a in actuator_names if "main" in a.lower()]
    for state in states:
        opened = sorted(a for a in actuator_names if positions[state].get(a))
        if state.lower() == "idle" and opened:
            warnings.append(
                f"Idle commands {', '.join(opened)} OPEN in {act_path.name} as "
                "the DAQ reads it. A cold, de-energised stand has nothing "
                "open, so the twin holds Idle shut; the stand's table is what "
                "needs fixing."
            )
            for actuator in opened:
                positions[state][actuator] = False
        wrong = [a for a in mains if positions[state].get(a)]
        if wrong and state.lower() not in ("fire", "idle"):
            warnings.append(
                f"{state} commands {', '.join(wrong)} OPEN in {act_path.name} "
                "as the DAQ reads it. Only Fire should open a main; the "
                "stand's table is what needs fixing."
            )
    allowed: dict[str, frozenset[str]] = {}
    if trans_path.exists():
        columns, sources, moves = _read_matrix(trans_path)
        ragged: list[str] = []
        for source, row in zip(sources, moves):
            if len(row) != len(columns):
                # A short row is read LEFT-ALIGNED, because that is how the
                # stand reads it. The DAQ's own parser
                # (diablo_server/backend/src/legacy/state-transitions.ts) maps
                # row[j] onto headers[j-1] and stops at the end of the row, so
                # a 20-cell row simply never speaks about the last column.
                # This twin used to refuse every move out of such a state on
                # the grounds that the alignment was unknowable -- but it is
                # not unknowable, it is whatever the DAQ does, and an operator
                # rehearsing on the twin must find the same doors open and shut
                # as on the stand. Including the wrong ones: see the second
                # warning below.
                ragged.append(f"{source} ({len(row)} of {len(columns)})")
            allowed[source] = frozenset(
                column for column, cell in zip(columns, row) if cell.strip() == "1"
            )
        if ragged:
            warnings.append(
                f"{trans_path.name} has {len(ragged)} row(s) with the wrong "
                f"number of columns: {', '.join(ragged)}. Read left-aligned, "
                "exactly as the Diablo DAQ reads them, so the twin permits and "
                "refuses the same moves as the stand. Fix the file and both "
                "tools change together."
            )
        # The consequence worth shouting about. Only Ready and Fire should be
        # able to reach Fire; if the alignment hands Fire to anything else, the
        # stand has an unguarded ignition path and so, faithfully, does this.
        for source, targets in allowed.items():
            if "Fire" in targets and source not in ("Ready", "Fire"):
                warnings.append(
                    f"{source} -> Fire is permitted by {trans_path.name} as the "
                    "DAQ reads it. That is an ignition path that bypasses "
                    "Ready. The twin allows it so a rehearsal matches the "
                    "stand; the stand's table is what needs fixing."
                )

    return StateMachine(
        name=name,
        states=tuple(states),
        actuators=tuple(actuator_names),
        positions=positions,
        allowed=allowed,
        warnings=tuple(warnings),
    )


def bind(machine: StateMachine, valves: Mapping[str, str]) -> Binding:
    """Join the machine's actuators to a drawing's valves by name.

    ``valves`` is drawing symbol id -> its label. Matching is on word overlap
    after normalising away the noise that differs between a crew's vocabulary
    and a draughtsman's: "MV-OX" and "LOX Main" share "lox" and "main" once
    "mv" is dropped and "ox" is mapped to "lox".

    Ties are broken by overlap size then by label, so the result does not depend
    on dict ordering -- a binding that changed between two runs of the same
    drawing would be the worst possible bug here.
    """
    table = {name: _words(name) for name in machine.actuators}
    drawn = {sid: _words(label) for sid, label in valves.items()}

    to_symbol: dict[str, str] = {}
    taken: set[str] = set()
    for actuator in machine.actuators:
        wanted = table[actuator]
        if not wanted:
            continue
        best: tuple[int, str, str] | None = None
        for sid, words in drawn.items():
            if sid in taken:
                continue
            # A disagreement about the propellant is disqualifying however much
            # else matches.
            if (
                (wanted & _FLUIDS)
                and (words & _FLUIDS)
                and not (wanted & words & _FLUIDS)
            ):
                continue
            overlap = len(wanted & words)
            # Every identifying word of the actuator has to appear, or "LOX
            # Vent" happily binds to "LOX Main" on a drawing with no vent.
            if overlap < len(wanted):
                continue
            score = (overlap, valves[sid], sid)
            if best is None or score > best:
                best = score
        if best is not None:
            to_symbol[actuator] = best[2]
            taken.add(best[2])

    return Binding(
        to_symbol=to_symbol,
        unmatched=tuple(a for a in machine.actuators if a not in to_symbol),
        uncommanded=tuple(sorted(set(valves) - taken)),
    )


def available() -> list[str]:
    """Machines shipped with the app."""
    if not TABLES.is_dir():
        return []
    return sorted(p.stem[: -len("_actuators")] for p in TABLES.glob("*_actuators.csv"))
