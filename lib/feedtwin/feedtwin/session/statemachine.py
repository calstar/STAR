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
from typing import Any, Mapping, Sequence

#: Bumped whenever the stored form of an edited table changes meaning.
MACHINE_SCHEMA = 1

#: States the session and the cockpit find by name: the stand opens in Idle,
#: T-0 primes in Ready, Fire is the burn, burnout vents to Vent, the console's
#: ENG ABORT goes to Engine Abort. An edited table without one is warned.
KEYED_STATES = ("Idle", "Ready", "Fire", "Vent", "Engine Abort")

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

#: A stand's line prefixes, each standing for more than one word. "FV-SOL" is
#: the fuel vent solenoid and "FF-SOL-Vent" the fuel *fill* (transfer tank)
#: vent; "HPC_SOL" is the high press control solenoid the table calls "GSE High
#: Press Control". "OF" is the ox-fill *line*, so it names the propellant only:
#: OF-MOT-Dump is the dump on that line, not its fill valve.
_EXPAND: dict[str, tuple[str, ...]] = {
    "fv": ("fuel", "vent"),
    "ff": ("fuel", "fill"),
    "ov": ("lox", "vent"),
    "of": ("lox",),
    "hpc": ("high", "press", "control"),
    "hp": ("high", "press"),
    "lp": ("low", "press"),
    "mp": ("med", "press"),
    "ctrl": ("control",),
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
        if part in _EXPAND:
            out.update(_EXPAND[part])
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
    table: Mapping[str, Mapping[str, bool]] | None = None
    """The positions as the table writes them, before the twin holds Idle
    shut -- what an editor shows and a download writes. ``None``: the same as
    ``positions``."""
    layout: Mapping[str, tuple[int, int]] = field(default_factory=dict)
    """Where each state sits on the panel, ``(row, col)`` -- the DAQ's
    ``panel_row``/``panel_col``. A state not here is not placed."""
    aborts: frozenset[str] | None = None
    """The abort states, as the DAQ flags them (``is_abort``). ``None``: any
    state with "abort" in its name, which is what the twin always assumed."""

    def is_abort(self, state: str) -> bool:
        return state in self.aborts if self.aborts is not None else _is_abort(state)

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
        if current == target or self.is_abort(target):
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

    def to_dict(self) -> dict[str, Any]:
        """The tables as an editor holds them: the states in column order with
        their place on the panel, the rows, which rows each state opens *as
        written* (Idle's OPEN cells included -- the twin's hold is applied
        again on reading), and the legal moves. A state with no entry in
        ``allowed`` has no row in the transition table, and fails closed."""
        written = self.table if self.table is not None else self.positions
        return {
            "schema": MACHINE_SCHEMA,
            "name": self.name,
            "states": [
                {
                    "name": s,
                    "row": self.layout[s][0] if s in self.layout else None,
                    "col": self.layout[s][1] if s in self.layout else None,
                    "abort": self.is_abort(s),
                }
                for s in self.states
            ],
            "actuators": list(self.actuators),
            "open": {
                s: [a for a in self.actuators if written.get(s, {}).get(a)]
                for s in self.states
            },
            "allowed": {
                s: [t for t in self.states if t in self.allowed[s]]
                for s in self.states
                if s in self.allowed
            },
        }


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
    #: Actuators bound by what the valve does rather than by its name -- see
    #: ``roles`` on :func:`bind`. Listed so a stand can say so.
    by_role: tuple[str, ...] = ()
    #: Actuators a person pinned (``overrides`` on :func:`bind`), bound or
    #: deliberately left unbound. Everything else was matched automatically.
    by_user: tuple[str, ...] = ()

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
    tables: Path | None = None,
) -> StateMachine:
    """Read a machine from its two tables.

    Either name both files, or name the directory holding
    ``<name>_actuators.csv`` and ``<name>_transitions.csv``. The library ships
    no tables of its own: they are the DAQ's files, and the feed-twin app keeps
    the copy (its ``backend/statemachine.py`` supplies that directory).
    """
    if (actuators is None or transitions is None) and tables is None:
        raise ValueError(
            f"load_machine({name!r}) needs the table directory or both table "
            "paths; feedtwin ships no state machines of its own"
        )
    act_path = actuators or Path(str(tables)) / f"{name}_actuators.csv"
    trans_path = transitions or Path(str(tables)) / f"{name}_transitions.csv"

    states, actuator_names, body = _read_matrix(act_path)
    positions: dict[str, dict[str, bool]] = {s: {} for s in states}
    for actuator, row in zip(actuator_names, body):
        for state, cell in zip(states, row):
            positions[state][actuator] = cell.upper().startswith("OPEN")
    table = {s: dict(row) for s, row in positions.items()}

    warnings = _hold_idle(states, actuator_names, positions, act_path.name)
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
        warnings.extend(_fire_bypasses(allowed, trans_path.name))

    layout, aborts = _read_panel(
        Path(str(tables)) / f"{name}_states.csv" if tables is not None else None,
        states,
    )
    return StateMachine(
        name=name,
        states=tuple(states),
        actuators=tuple(actuator_names),
        positions=positions,
        allowed=allowed,
        warnings=tuple(warnings),
        table=table,
        layout=layout,
        aborts=aborts,
    )


def _hold_idle(
    states: Sequence[str],
    actuators: Sequence[str],
    positions: dict[str, dict[str, bool]],
    source: str,
) -> list[str]:
    """Hold Idle shut in ``positions`` and say what the table claimed; flag a
    main valve opened outside Fire. Shared by the CSV and the edited table, so
    a table reads the same whichever way it arrives.

    Positions that cannot be what anybody meant, read exactly as the DAQ
    reads them. A main valve is only ever open with the engine lit, and a
    cold, de-energised stand has nothing open at all; the shipped table says
    otherwise in four places.

    Idle is the one place the twin does NOT do as the table says. Idle is the
    de-energised state -- what the panel is in before anybody arms anything
    and what every solenoid falls back to unpowered -- and OPEN in that column
    cannot be a position a normally-closed solenoid holds. Read literally it
    opened LOX Press, and once a bottle could be full at start-up it pressed
    the LOX tank to 550 psig before the operator had touched a thing.
    Transitions stay faithful to the byte (an interlock the stand lacks must
    be missing here too); a valve position that pressurises a cold stand is
    not an interlock, it is a typo, and the warning says exactly what the
    table claimed.
    """
    warnings: list[str] = []
    mains = [a for a in actuators if "main" in a.lower()]
    for state in states:
        opened = sorted(a for a in actuators if positions[state].get(a))
        if state.lower() == "idle" and opened:
            warnings.append(
                f"Idle commands {', '.join(opened)} OPEN in {source} as "
                "the DAQ reads it. A cold, de-energised stand has nothing "
                "open, so the twin holds Idle shut; the stand's table is what "
                "needs fixing."
            )
            for actuator in opened:
                positions[state][actuator] = False
        wrong = [a for a in mains if positions[state].get(a)]
        if wrong and state.lower() not in ("fire", "idle"):
            warnings.append(
                f"{state} commands {', '.join(wrong)} OPEN in {source} "
                "as the DAQ reads it. Only Fire should open a main; the "
                "stand's table is what needs fixing."
            )
    return warnings


def _fire_bypasses(allowed: Mapping[str, frozenset[str]], source: str) -> list[str]:
    """The consequence worth shouting about. Only Ready and Fire should be able
    to reach Fire; if the table hands Fire to anything else, the stand has an
    unguarded ignition path and so, faithfully, does this."""
    return [
        f"{state} -> Fire is permitted by {source} as the "
        "DAQ reads it. That is an ignition path that bypasses "
        "Ready. The twin allows it so a rehearsal matches the "
        "stand; the stand's table is what needs fixing."
        for state, targets in allowed.items()
        if "Fire" in targets and state not in ("Ready", "Fire")
    ]


def _read_panel(
    path: Path | None, states: Sequence[str]
) -> tuple[dict[str, tuple[int, int]], frozenset[str] | None]:
    """Where each state sits on the panel and which are aborts, from
    ``<name>_states.csv`` (``name,row,col,abort``: the DAQ's ``[[states]]``
    ``panel_row``/``panel_col``/``is_abort``). With no such file the panel is
    the console's own and aborts go by name, as before. A state the file
    does not list is an abort only by its name."""
    if path is None or not path.exists():
        return {}, None
    with path.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    layout: dict[str, tuple[int, int]] = {}
    flagged: set[str] = set()
    listed: set[str] = set()
    for row in rows:
        state = (row.get("name") or "").strip()
        if state not in states:
            continue
        listed.add(state)
        place = (row.get("row") or "").strip(), (row.get("col") or "").strip()
        if all(place):
            layout[state] = (int(place[0]), int(place[1]))
        if _flag(row.get("abort")):
            flagged.add(state)
    flagged |= {s for s in states if s not in listed and _is_abort(s)}
    return layout, frozenset(flagged)


def _flag(value: Any) -> bool:
    """A yes/no a person or a file wrote: ``True``, ``1``, ``"1"``,
    ``"true"``, ``"yes"``. Anything else -- ``"0"`` and ``"false"`` included
    -- is no: an abort flag read loosely is an unguarded path into it."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value == 1
    return str(value or "").strip().lower() in ("1", "true", "yes")


def machine_from_dict(raw: Mapping[str, Any]) -> StateMachine:
    """An edited table (:meth:`StateMachine.to_dict`'s shape), read as the CSVs
    are: Idle held shut and the same warnings. Refused outright when it
    contradicts itself -- a state or row named twice, a cell naming a state or
    row the table does not have -- because a half-understood table would
    command valves nobody chose."""
    schema = int(raw.get("schema", MACHINE_SCHEMA))
    if schema != MACHINE_SCHEMA:
        raise ValueError(
            f"state table schema {schema}; this feedtwin reads {MACHINE_SCHEMA}"
        )
    rows = raw.get("states") or []
    states = [str((s or {}).get("name") or "").strip() for s in rows]
    if not states:
        raise ValueError("the state table has no states")
    if "" in states:
        raise ValueError("a state has no name")
    if len(set(states)) != len(states):
        raise ValueError("two states share a name")
    actuators = [str(a or "").strip() for a in raw.get("actuators") or []]
    if "" in actuators:
        raise ValueError("an actuator row has no name")
    if len({a.casefold() for a in actuators}) != len(actuators):
        raise ValueError("two actuator rows share a name")
    known_states, known_rows = set(states), set(actuators)

    opened: Mapping[str, Any] = raw.get("open") or {}
    for state, names in opened.items():
        if state not in known_states:
            raise ValueError(
                f"the table opens valves in {state!r}, which is not a state"
            )
        stray = sorted(set(map(str, names or [])) - known_rows)
        if stray:
            raise ValueError(f"{state} opens {', '.join(stray)}, which have no row")
    positions = {
        s: {a: a in set(map(str, opened.get(s) or [])) for a in actuators}
        for s in states
    }
    table = {s: dict(row) for s, row in positions.items()}

    moves: Mapping[str, Any] = raw.get("allowed") or {}
    allowed: dict[str, frozenset[str]] = {}
    for state, targets in moves.items():
        if state not in known_states:
            raise ValueError(f"the transitions name {state!r}, which is not a state")
        stray = sorted(set(map(str, targets or [])) - known_states)
        if stray:
            raise ValueError(
                f"{state} may go to {', '.join(stray)}, which are not states"
            )
        allowed[state] = frozenset(map(str, targets or []))

    layout: dict[str, tuple[int, int]] = {}
    for row in rows:
        r, c = row.get("row"), row.get("col")
        if r is not None and c is not None and r != "" and c != "":
            layout[str(row["name"]).strip()] = (int(r), int(c))
    aborts = frozenset(
        str(row["name"]).strip() for row in rows if _flag(row.get("abort"))
    )

    source = "the edited table"
    warnings = _hold_idle(states, actuators, positions, source)
    warnings.extend(_fire_bypasses(allowed, source))
    missing = [s for s in KEYED_STATES if s not in known_states]
    if missing:
        warnings.append(
            f"The table has no {', '.join(missing)}: the twin keys on "
            f"{'that state' if len(missing) == 1 else 'those states'} by name "
            "(a stand opens in Idle, T-0 primes in Ready, Fire burns, a dry "
            "tank vents to Vent, ENG ABORT goes to Engine Abort)."
        )
    return StateMachine(
        name=str(raw.get("name") or "edited"),
        states=tuple(states),
        actuators=tuple(actuators),
        positions=positions,
        allowed=allowed,
        warnings=tuple(warnings),
        table=table,
        layout=layout,
        aborts=aborts,
    )


def bind(
    machine: StateMachine,
    valves: Mapping[str, str],
    roles: Mapping[str, frozenset[str]] | None = None,
    overrides: Mapping[str, str] | None = None,
) -> Binding:
    """Join the machine's actuators to a drawing's valves by name.

    ``valves`` is drawing symbol id -> its label. Matching is on word overlap
    after normalising away the noise that differs between a crew's vocabulary
    and a draughtsman's: "MV-OX" and "LOX Main" share "lox" and "main" once
    "mv" is dropped and "ox" is mapped to "lox".

    Ties are broken by overlap size then by label, so the result does not depend
    on dict ordering -- a binding that changed between two runs of the same
    drawing would be the worst possible bug here.

    ``roles`` (drawing id -> what the valve does, e.g. ``{"fuel", "press"}``,
    from :attr:`feedtwin.pid.network.BuiltNetwork.valve_roles`) is the fallback
    for the actuators no name matched: a drawing that tags its fuel press
    solenoid "FU_SOL_R" still has it plumbed between the regulator and the fuel
    tank's ullage, and that is what "Fuel Press" means. An actuator is bound by
    role only when exactly one unbound valve does exactly its job; names always
    win, and without ``roles`` the binding is what it always was.

    ``overrides`` (actuator -> drawing id) is what a person decided, and wins
    over both: those valves are taken first, and the automatic match works
    around them. An empty id leaves that actuator unbound on purpose. A pin
    naming a valve no longer on the drawing is ignored and the actuator is
    matched automatically again -- a drawing that lost a valve must not leave a
    main valve silently uncommanded. Without ``overrides`` nothing changes.
    """
    table = {name: _words(name) for name in machine.actuators}
    drawn = {sid: _words(label) for sid, label in valves.items()}

    to_symbol: dict[str, str] = {}
    taken: set[str] = set()
    decided: set[str] = set()
    for actuator, sid in (overrides or {}).items():
        if actuator not in machine.actuators:
            continue
        if not sid:
            decided.add(actuator)
        elif sid in valves and sid not in taken:
            to_symbol[actuator] = sid
            taken.add(sid)
            decided.add(actuator)
    for actuator in machine.actuators:
        wanted = table[actuator]
        if not wanted or actuator in decided:
            continue
        # The plumbing outranks a name it contradicts: when exactly one free
        # valve does this actuator's job, a name match that does not is passed
        # over. A cart's LOX vent drawn on a disconnect nobody paired goes
        # nowhere, while the tank-top disconnect is the vent that works.
        doers = [
            sid
            for sid in valves
            if sid not in taken and roles is not None and roles.get(sid) == wanted
        ]
        best: tuple[int, int, str, str] | None = None
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
            if (
                roles is not None
                and len(doers) == 1
                and doers[0] != sid
                and roles.get(sid) != wanted
            ):
                continue
            # The closest name wins: "Fuel Vent" is FV-SOL, not FF-SOL-Vent,
            # which has every word of it and "fill" besides.
            score = (overlap, -len(words - wanted), valves[sid], sid)
            if best is None or score > best:
                best = score
        if best is not None:
            to_symbol[actuator] = best[3]
            taken.add(best[3])

    by_role: list[str] = []
    for actuator in machine.actuators:
        if (
            actuator in to_symbol
            or actuator in decided
            or not roles
            or not table[actuator]
        ):
            continue
        fits = [
            sid
            for sid in sorted(valves)
            if sid not in taken and roles.get(sid) == table[actuator]
        ]
        if len(fits) == 1:
            to_symbol[actuator] = fits[0]
            taken.add(fits[0])
            by_role.append(actuator)

    return Binding(
        to_symbol=to_symbol,
        unmatched=tuple(a for a in machine.actuators if a not in to_symbol),
        uncommanded=tuple(sorted(set(valves) - taken)),
        by_role=tuple(by_role),
        by_user=tuple(a for a in machine.actuators if a in decided),
    )


def available(tables: Path) -> list[str]:
    """Machines whose tables are in ``tables``."""
    if not tables.is_dir():
        return []
    return sorted(p.stem[: -len("_actuators")] for p in tables.glob("*_actuators.csv"))
