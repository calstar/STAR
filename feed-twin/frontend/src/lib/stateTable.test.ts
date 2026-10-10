import { describe, expect, it } from 'vitest';
import type { ChannelDef, MachineDef } from '../api';
import { addState, canGo, isOpen, setAllowed, toActuatorCsv, toTransitionCsv } from './hookupDraft';
import {
  applyCsvFiles,
  csvKind,
  groupTableWarnings,
  heldShut,
  panelGrid,
  rowGroups,
  skippedDelays,
  withoutAbort,
} from './stateTable';

const TABLE: MachineDef = {
  states: [
    { name: 'Idle', row: 0, col: 0, abort: false },
    { name: 'Ox Press', row: 2, col: 3, abort: false },
    { name: 'Fire', row: 5, col: 0, abort: false },
    { name: 'Engine Abort', row: null, col: null, abort: true },
  ],
  actuators: ['LOX Press', 'LOX Main'],
  open: { Idle: [], 'Ox Press': ['LOX Press'], Fire: ['LOX Press', 'LOX Main'], 'Engine Abort': ['LOX Main'] },
  allowed: { Idle: ['Idle', 'Ox Press'], 'Ox Press': ['Ox Press', 'Fire'], Fire: ['Fire'] },
};

describe('csvKind', () => {
  it('tells the two DAQ files apart by their cells, not their names', () => {
    expect(csvKind(toActuatorCsv(TABLE), 'state_transitions.csv')).toBe('actuators');
    expect(csvKind(toTransitionCsv(TABLE), 'state_machine_actuators.csv')).toBe('transitions');
  });

  it('reads a quoted name with a comma, a BOM and CRLF', () => {
    expect(csvKind('\uFEFF,Idle,Fire\r\n"Main, LOX",CLOSE,OPEN\r\n')).toBe('actuators');
    expect(csvKind(',Idle,"Idle, cold"\r\n"Idle, cold",1,0\r\n')).toBe('transitions');
  });

  it('never takes the DAQ’s delay table, whatever its cells', () => {
    // Its zeros read like a transition table's.
    const delays = ',Idle,Fire\nFuel Fill Vent,0,0\nFuel Main,0,0.080\n';
    expect(csvKind(delays, 'state_machine_actuator_delays.csv')).toBeNull();
    expect(csvKind(',Idle,Fire\n', 'state_machine_actuator_delays.csv')).toBeNull();
  });

  it('takes a 0/1 table as transitions only when its rows are states of its own first row', () => {
    expect(csvKind(',Idle,Fire\nIdle,1,1\nFire,0,1\n')).toBe('transitions');
    expect(csvKind(',Idle,Fire\nFuel Fill Vent,0,0\nFuel Main,0,0\n', 'renamed.csv')).toBeNull();
    expect(csvKind(',Idle,Fire\nIdle,1,1\nLOX Main,0,0\n')).toBeNull();
  });

  it('falls back to the file name only when there is no data row', () => {
    expect(csvKind(',Idle,Fire\n', 'diablo_transitions.csv')).toBe('transitions');
    expect(csvKind(',Idle,Fire\n', 'notes.csv')).toBeNull();
    // A data row that is neither is refused whatever the file is called: read
    // as transitions it would wipe every move.
    expect(csvKind('a,b\nfoo,bar\n', 'state_transitions.csv')).toBeNull();
  });
});

describe('applyCsvFiles', () => {
  it('takes both files in either order', () => {
    const edited: MachineDef = { ...TABLE, open: { ...TABLE.open, Idle: ['LOX Main'] } };
    const files = [
      { name: 'b.csv', text: toTransitionCsv(edited) },
      { name: 'a.csv', text: toActuatorCsv(edited) },
    ];
    const out = applyCsvFiles(TABLE, files);
    expect(isOpen(out, 'LOX Main', 'Idle')).toBe(true);
    expect(canGo(out, 'Idle', 'Ox Press')).toBe(true);
    expect(canGo(out, 'Ox Press', 'Idle')).toBe(false);
  });

  it('with only the transition file keeps the actuator table', () => {
    const t = ',Idle,Ox Press,Fire,Engine Abort\nIdle,1,0,1,0\n';
    const out = applyCsvFiles(TABLE, [{ name: 'state_transitions.csv', text: t }]);
    expect(out.actuators).toEqual(TABLE.actuators);
    expect(out.open.Fire).toEqual(TABLE.open.Fire);
    expect(out.allowed).toEqual({ Idle: ['Idle', 'Fire'] });
  });

  it('refuses the delay table by name rather than read its zeros as moves', () => {
    const delays = ',Idle,Ox Press,Fire,Engine Abort\nLOX Main,0,0,0,0\n';
    expect(() => applyCsvFiles(TABLE, [{ name: 'state_machine_actuator_delays.csv', text: delays }])).toThrow(
      /state_machine_actuator_delays\.csv: the DAQ's actuator delays/,
    );
  });

  it('passes over the delay table picked with the state tables, the natural pick from the DAQ folder', () => {
    const delays = ',Idle,Ox Press,Fire,Engine Abort\nLOX Main,0,0,0,0\n';
    const edited: MachineDef = { ...TABLE, open: { ...TABLE.open, Idle: ['LOX Main'] } };
    const files = [
      { name: 'state_machine_actuators.csv', text: toActuatorCsv(edited) },
      { name: 'state_transitions.csv', text: toTransitionCsv(edited) },
      { name: 'state_machine_actuator_delays.csv', text: delays },
    ];
    expect(skippedDelays(files)).toEqual(['state_machine_actuator_delays.csv']);
    expect(isOpen(applyCsvFiles(TABLE, files), 'LOX Main', 'Idle')).toBe(true);
    // Alone, it is still refused, with why.
    expect(skippedDelays([files[2]])).toEqual([]);
  });

  it('says why a 0/1 table whose rows are not its states is refused', () => {
    const t = ',Idle,Ox Press,Fire,Engine Abort\nLOX Main,0,0,0,0\nLOX Press,0,0,0,0\n';
    expect(() => applyCsvFiles(TABLE, [{ name: 'copy.csv', text: t }])).toThrow(
      /copy\.csv: rows LOX Main, LOX Press are not states in its first row/,
    );
  });

  it('refuses a file that is neither, and two of one kind', () => {
    expect(() => applyCsvFiles(TABLE, [{ name: 'x.csv', text: 'a,b\nc,d\n' }])).toThrow(/x\.csv/);
    const a = toActuatorCsv(TABLE);
    expect(() =>
      applyCsvFiles(TABLE, [
        { name: '1.csv', text: a },
        { name: '2.csv', text: a },
      ]),
    ).toThrow(/Two actuator/);
  });
});

describe('withoutAbort', () => {
  it('lists the states whose own cells go to no abort', () => {
    // TABLE flags Engine Abort and no row goes to it; Engine Abort has no row.
    expect(withoutAbort(TABLE)).toEqual(['Idle', 'Ox Press', 'Fire']);
    expect(withoutAbort(setAllowed(TABLE, 'Idle', 'Engine Abort', true))).toEqual(['Ox Press', 'Fire']);
  });

  it('does not ask an abort, nor a table with none flagged', () => {
    expect(withoutAbort(TABLE)).not.toContain('Engine Abort');
    const none: MachineDef = { ...TABLE, states: TABLE.states.map((s) => ({ ...s, abort: false })) };
    expect(withoutAbort(none)).toEqual([]);
  });

  it('a state added on the tab can abort', () => {
    expect(withoutAbort(addState(TABLE, 'Purge'))).not.toContain('Purge');
  });
});

describe('panelGrid', () => {
  it('places states by row and column, lists the rest, and finds clashes', () => {
    const g = panelGrid([...TABLE.states, { name: 'Ox Vent', row: 2, col: 3, abort: false }]);
    expect(g.placed.map((s) => s.name)).toEqual(['Idle', 'Ox Press', 'Fire', 'Ox Vent']);
    expect(g.off).toEqual(['Engine Abort']);
    expect(g.rows).toBe(6);
    expect(g.cols).toBe(5);
    expect(g.clash.get('Ox Press')).toEqual(['Ox Vent']);
    expect(g.clash.has('Idle')).toBe(false);
  });

  it('widens past five columns rather than drop a state', () => {
    expect(panelGrid([{ name: 'Far', row: 0, col: 7, abort: false }]).cols).toBe(8);
  });

  it('keeps a state with only a row off the grid', () => {
    const g = panelGrid([{ name: 'Half', row: 1, col: null, abort: false }]);
    expect(g.placed).toEqual([]);
    expect(g.off).toEqual(['Half']);
  });
});

describe('rowGroups', () => {
  const sol = (name: string, symbol: string, slot = 1): ChannelDef => ({ board: 'sol12', slot, name, symbol });

  it('wires a row to the solenoid connector of its name, case ignored', () => {
    const g = rowGroups(TABLE.actuators, [sol('lox main', 'OM-R')]);
    expect(g.wired).toEqual([{ name: 'LOX Main', channel: sol('lox main', 'OM-R') }]);
    expect(g.unwired.map((r) => r.name)).toEqual(['LOX Press']);
  });

  it('a transducer by the same name drives nothing', () => {
    const pt: ChannelDef = { board: 'pt_low', slot: 1, name: 'LOX Main', symbol: 'PT1' };
    expect(rowGroups(TABLE.actuators, [pt]).wired).toEqual([]);
  });
});

describe('heldShut', () => {
  it('is Idle only', () => {
    expect(heldShut('Idle')).toBe(true);
    expect(heldShut(' idle ')).toBe(true);
    expect(heldShut('Idle Vent')).toBe(false);
  });
});

describe('groupTableWarnings', () => {
  it('folds the "X -> Fire" warnings into one line and keeps the first sentence of the rest', () => {
    const out = groupTableWarnings([
      'Idle commands LOX Press OPEN in diablo_actuators.csv as the DAQ reads it. A cold stand has nothing open.',
      'Ox Press -> Fire is permitted by diablo_transitions.csv, bypassing Ready.',
      'Fuel Press -> Fire is permitted by diablo_transitions.csv, bypassing Ready.',
    ]);
    expect(out.map((w) => w.text)).toEqual([
      '2 states can go straight to Fire without Ready: Ox Press, Fuel Press.',
      'Idle commands LOX Press OPEN in diablo_actuators.csv as the DAQ reads it.',
    ]);
    expect(out[1].detail).toContain('A cold stand');
  });
});
