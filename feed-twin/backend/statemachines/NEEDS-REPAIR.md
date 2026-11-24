# `diablo_transitions.csv` — the short rows, repaired (pending DAQ team confirmation)

The header declares 21 columns (a label plus 20 states). Until 2026-11-23 ten rows of
the DAQ's `state_transitions.csv` (`daq-server/config/profiles/default/` and
`profiles/server/`) carried 20, and nine of this copy did (`Press Standby` had already
been rewritten here, below):

    Armed, Fuel Fill, Ox Fill, Press Standby, GN2 Low Press,
    GN2 Low Vent, Fuel Press, Fuel Vent, Ox Press, Ox Vent

## What the short rows did

Both of the stand's parsers (the sequencer's `StateMachine::load` and the backend's
`state-csv/state-transitions.ts`) mapped `row[j]` onto `headers[j-1]` and stopped at the
end of the row: a short row was read **left-aligned**. Read that way, seven rows put a
`1` under **Fire** -- an ignition path that bypasses `Ready` -- and all ten said
nothing about `Emergency Abort`, so the stand refused an emergency abort from them. The
twin read the rows the same way, on purpose, and warned on each path.

## The repair (daq-server PR "Fail-fast config", #40 / C2-8)

Each short row was missing the `0` under `Fire`: every well-formed row except `Ready`
and `Fire` has one there, and inserting it puts the row's last three cells under
`Vent`, `GSE Abort` and `Emergency Abort` like every other press/vent row. That `0` was
inserted in all ten rows of the DAQ's copy and in the nine here. Per row the edges that
change are: the `Fire` bypass and `Engine Abort` go (`Engine Abort` was the shifted
`GSE Abort`/`Emergency Abort` pair), and `Vent` (press/vent rows only) and
`Emergency Abort` come in. **This is still an inference, and the DAQ team is asked to
confirm it on the PR.**

Both of the stand's parsers now refuse a table with any row whose cell count differs
from the header's, so a short row cannot be read left-aligned again. This copy's
`load_machine()` still reads and warns rather than refuses; with no short rows left it
has nothing to warn about.

This copy differs from the DAQ's in exactly the four operator rows listed under
"Twin-side edits" below. Those were not copied over the DAQ's file; they describe how
the stand is run and are for the DAQ team to adopt or not.

Absent rows still fail closed — a state the table never mentions constrains nothing,
and "constrains nothing" is not "allows everything".

## The actuator table has its own problems

`diablo_actuators.csv` is well-formed (21 cells per row) and is read exactly as
written. Four cells cannot be what anybody meant:

| state | commands OPEN | why it is wrong |
|---|---|---|
| `Idle` | `Fuel Main`, `LOX Press` | a cold, de-energised stand has nothing open; a main valve open in Idle would drain a loaded fuel tank into the engine |
| `Engine Abort` | `Fuel Main`, `LOX Main` (and both press) | an engine abort shuts the mains; this table opens them |
| `Emergency Abort` | `Fuel Main`, `LOX Main` (and both press, and every vent) | same |

`load_machine()` warns on each. The aborts are obeyed as written — an abort that opens
the mains is a hazard the rehearsal should show. **Idle is not**: it is the
de-energised state, OPEN there cannot be a position a normally-closed solenoid holds,
and read literally a full bottle pressed the LOX tank to 550 psig before anybody had
armed anything. The twin holds Idle shut and says what the table claimed.

Two consequences an operator will meet:

1. Until 2026-09-11 the console showed `MV-FU` and `SV-LOX-PRESS` **open** in Idle.
   Shutting them by hand was the obvious move — and a hand position then outlived every
   later state, so `Ox Press` pressed nothing and `Fire` opened no fuel main, with
   nothing to say why beyond a small HELD badge. A state transition now takes command
   back of every valve the table knows, the way the DAQ writes all actuators on a
   transition; valves the table never commands keep the hand's position.
2. Aborting with propellant loaded opens both mains. Rehearse an abort on the twin
   before trusting the table on the pad.

Check the DAQ's copy: either the file is wrong, or OPEN/CLOSE mean something other
than valve position in those columns (a normally-open valve's *coil* state, say). The
twin cannot tell which; the DAQ team can.

## Twin-side edits (operator, 2026-09-11)

Four rows in the twin's copy differ from the DAQ's file, at the operator's direction.
They describe how the stand is actually run and belong in the DAQ's file too:

| row | change |
|---|---|
| `Press Standby` | against the repaired DAQ row: adds `Ready` and `Engine Abort` |
| `Ready` | adds `Calibrate` |
| `Calibrate` | adds `Fire` |
| `Fire` | adds `Vent` -- the twin goes there on its own at burnout (`Session._burnout_check`, `Setup.auto_vent`) |

The intended path is `Press Standby -> Ready -> Calibrate -> Fire -> Vent`.
