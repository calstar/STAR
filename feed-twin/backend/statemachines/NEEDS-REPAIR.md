# `diablo_transitions.csv` — 10 rows are one cell short, and the stand reads them anyway

This file was byte-identical to `daq-server/config/state_transitions.csv` until the
twin-side edits listed at the end of this note. The header
declares 21 columns (a label plus 20 states); these 10 rows carry 20:

    Armed, Fuel Fill, Ox Fill, Press Standby, GN2 Low Press,
    GN2 Low Vent, Fuel Press, Fuel Vent, Ox Press, Ox Vent

## How the stand reads them

The DAQ's parser (`daq-server/diablo_server/backend/src/legacy/state-transitions.ts`)
maps `row[j]` onto `headers[j-1]` and stops at the end of the row. A short row is
therefore read **left-aligned**: it never says anything about `Emergency Abort`, and
every cell before that lands on the column its position names.

The twin reads the rows the same way, on purpose. An operator rehearsing here must find
the same doors open and shut as on the pad. `load_machine()` names the short rows in
its warnings.

## What that alignment permits — and why it is flagged, not hidden

Read left-aligned, seven rows put a `1` under **Fire**:

    Press Standby, GN2 Low Press, GN2 Low Vent, Fuel Press, Fuel Vent, Ox Press, Ox Vent

Each is an ignition path that bypasses `Ready`. The twin **permits** each one, because
the stand does, and emits one warning per path so the operator sees it on the console
and so whoever owns the CSV knows exactly which rows to fix. Faithfulness is the safety
property here: a twin that refused a move the stand allows would train an operator to
trust an interlock that is not there.

Absent rows are a different case and still fail closed — a state the table never
mentions constrains nothing, and "constrains nothing" is not "allows everything".

## How to repair

Rewrite the 10 rows with 21 cells each **in the DAQ's copy**, then copy it here (or
better, have the twin read the DAQ's file). Almost certainly each row is missing a `0`
in the `Fire` column — every well-formed row except `Ready` and `Fire` has one — but
that is an inference, and the fix belongs in the file the stand reads, with the DAQ
team's eyes on it. `pytest tests/test_statemachine.py` asserts the flagged paths exist
today and will need its expectations updated when they are gone; that is the point.

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

Four rows in the twin's copy now differ from the DAQ's file, at the operator's direction.
They describe how the stand is actually run and belong in the DAQ's file too:

| row | change |
|---|---|
| `Press Standby` | rewritten with 21 cells: adds `Ready` and `Emergency Abort`, drops the left-aligned `1` under `Fire` (the ignition bypass) |
| `Ready` | adds `Calibrate` |
| `Calibrate` | adds `Fire` |
| `Fire` | adds `Vent` -- the twin goes there on its own at burnout (`Session._burnout_check`, `Setup.auto_vent`) |

The intended path is `Press Standby -> Ready -> Calibrate -> Fire -> Vent`. The other six
ragged rows are untouched and still carry the stand's bypass, flagged as above.
