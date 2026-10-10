import { describe, expect, it } from 'vitest';
import type { HookupSymbol, MachineDef } from '../api';
import {
  type Draft,
  addState,
  channelOf,
  fromCsv,
  move,
  opensIn,
  removeState,
  rename,
  renameState,
  rowsOf,
  sameMachine,
  setAllowed,
  setOpen,
  tableIssues,
  toActuatorCsv,
  toTransitionCsv,
  unwire,
  unwiredRows,
  wire,
} from './hookupDraft';

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

const OM: HookupSymbol = { id: 'OM-R', label: 'OM-R', type: 'ROT', page: 'Rocket', kind: 'valve', board: 'sol12', ground: false };
const OU: HookupSymbol = { id: 'OU', label: 'OU_SOL_R', type: 'SOL', page: 'Rocket', kind: 'valve', board: 'sol12', ground: false };
const PT: HookupSymbol = { id: 'PT1', label: 'OU-PT-R', type: 'PT', page: 'Rocket', kind: 'pt', board: 'pt_low', ground: false };

const empty = (): Draft => ({ valves: {}, knobs: [], aliases: {}, channels: [], rows: {}, machine: TABLE });

describe('wiring a symbol to the DAQ box', () => {
  it('cables a valve to the first free connector and names it by its tag', () => {
    const d = wire(empty(), OM, 'sol12');
    expect(channelOf(d, 'OM-R')).toEqual({ board: 'sol12', slot: 1, name: 'OM-R', symbol: 'OM-R' });
    // A new name on a solenoid board is a new row, opening nowhere yet.
    expect(d.machine.actuators).toContain('OM-R');
    expect(opensIn(d.machine, 'OM-R')).toEqual([]);
  });

  it('joins a row the table already has, in the table’s spelling, so it opens where that row does', () => {
    const d = wire(empty(), OM, 'sol24', 3, 'lox main');
    expect(channelOf(d, 'OM-R')?.name).toBe('LOX Main');
    expect(d.machine.actuators).toEqual(['LOX Press', 'LOX Main']);
    expect(opensIn(d.machine, 'LOX Main')).toEqual(['Fire', 'Engine Abort']);
  });

  it('does not make a transducer a row', () => {
    const d = wire(empty(), PT, 'pt_low', undefined, 'LOX tank');
    expect(d.machine.actuators).toEqual(TABLE.actuators);
    expect(channelOf(d, 'PT1')?.name).toBe('LOX tank');
  });

  it('never puts two cables in one connector', () => {
    const d = wire(empty(), OM, 'sol12', 1);
    expect(wire(d, OU, 'sol12', 1)).toBe(d);
  });

  it('moves a symbol already on the box, keeping its name', () => {
    const d = wire(wire(empty(), OM, 'sol12', 1, 'LOX Main'), OM, 'sol24', 4);
    expect(d.channels).toEqual([{ board: 'sol24', slot: 4, name: 'LOX Main', symbol: 'OM-R' }]);
  });

  it('keeps names apart: a second connector asking for a taken name gets its own', () => {
    const d = wire(wire(empty(), OM, 'sol12', 1, 'LOX Main'), OU, 'sol12', 2, 'LOX Main');
    expect(channelOf(d, 'OU')?.name).toBe('LOX Main (2)');
    expect(d.machine.actuators).toContain('LOX Main (2)');
  });

  it('unplugging leaves the row in the table, wired to nothing', () => {
    const d = unwire(wire(empty(), OM, 'sol12', 1, 'LOX Main'), 'OM-R');
    expect(d.channels).toEqual([]);
    expect(unwiredRows(d)).toEqual(['LOX Press', 'LOX Main']);
  });

  it('swaps two cables dropped on each other', () => {
    const d = move(wire(wire(empty(), OM, 'sol12', 1), OU, 'sol12', 2), { board: 'sol12', slot: 1 }, { board: 'sol12', slot: 2 });
    expect(channelOf(d, 'OM-R')?.slot).toBe(2);
    expect(channelOf(d, 'OU')?.slot).toBe(1);
  });

  it('shows enough rows for the highest cable, and two at least', () => {
    expect(rowsOf(empty(), 'sol12')).toBe(2);
    expect(rowsOf(wire(empty(), OM, 'sol12', 13), 'sol12')).toBe(3);
  });
});

describe('renaming a connector carries its row', () => {
  it('renames the row with it, so it still opens where it did', () => {
    const d = rename(wire(empty(), OU, 'sol12', 1, 'LOX Press'), 'OU', 'LOX Press Sol');
    expect(channelOf(d, 'OU')?.name).toBe('LOX Press Sol');
    expect(d.machine.actuators).toEqual(['LOX Press Sol', 'LOX Main']);
    expect(opensIn(d.machine, 'LOX Press Sol')).toEqual(['Ox Press', 'Fire']);
  });

  it('joins a row it is renamed onto; the blank row its tag made goes', () => {
    const d = rename(wire(empty(), OM, 'sol12', 1), 'OM-R', 'LOX MAIN');
    expect(channelOf(d, 'OM-R')?.name).toBe('LOX Main');
    expect(d.machine.actuators).toEqual(['LOX Press', 'LOX Main']);
  });

  it('keeps a row it leaves when a state opens it', () => {
    const wired = wire(empty(), OM, 'sol12', 1, 'Lox valve');
    const ticked = { ...wired, machine: setOpen(wired.machine, 'Lox valve', 'Fire', true) };
    const d = rename(ticked, 'OM-R', 'LOX Main');
    expect(d.machine.actuators).toContain('Lox valve');
  });

  it('changes only the connector for a change of case, leaving the table the DAQ’s', () => {
    const d = rename(wire(empty(), OM, 'sol12', 1, 'LOX Main'), 'OM-R', 'Lox Main');
    expect(channelOf(d, 'OM-R')?.name).toBe('Lox Main');
    expect(d.machine).toBe(TABLE);
  });

  it('corrects a guessed name without taking the table’s row with it', () => {
    // The twin guessed "LOX Main" for the cable just plugged; the person says
    // it is something else. LOX Main keeps its row and its states.
    const d = rename(wire(empty(), OM, 'sol12', 1, 'LOX Main'), 'OM-R', 'Dome Ctrl', false);
    expect(channelOf(d, 'OM-R')?.name).toBe('Dome Ctrl');
    expect(d.machine.actuators).toEqual(['LOX Press', 'LOX Main', 'Dome Ctrl']);
    expect(opensIn(d.machine, 'LOX Main')).toEqual(['Fire', 'Engine Abort']);
    expect(opensIn(d.machine, 'Dome Ctrl')).toEqual([]);
  });

  it('refuses a name another connector has', () => {
    const d = wire(wire(empty(), OM, 'sol12', 1, 'LOX Main'), OU, 'sol12', 2, 'LOX Press');
    expect(rename(d, 'OU', 'lox main')).toBe(d);
  });
});

describe('editing the table', () => {
  it('opens and shuts one cell', () => {
    const m = setOpen(TABLE, 'LOX Main', 'Ox Press', true);
    expect(opensIn(m, 'LOX Main')).toEqual(['Ox Press', 'Fire', 'Engine Abort']);
    expect(opensIn(setOpen(m, 'LOX Main', 'Ox Press', false), 'LOX Main')).toEqual(['Fire', 'Engine Abort']);
  });

  it('adds a state that opens nothing and goes only to itself, in a free spot', () => {
    const m = addState(TABLE, 'Purge');
    expect(m.states.at(-1)).toEqual({ name: 'Purge', row: 0, col: 1, abort: false });
    expect(m.open.Purge).toEqual([]);
    expect(m.allowed.Purge).toEqual(['Purge']);
  });

  it('renames a state in every table that names it', () => {
    const m = renameState(TABLE, 'Ox Press', 'LOX Press State');
    expect(m.open['LOX Press State']).toEqual(['LOX Press']);
    expect(m.allowed.Idle).toEqual(['Idle', 'LOX Press State']);
    expect(m.allowed['LOX Press State']).toEqual(['Ox Press', 'Fire'].map((s) => (s === 'Ox Press' ? 'LOX Press State' : s)));
    expect(renameState(TABLE, 'Ox Press', 'fire')).toBe(TABLE);
  });

  it('removes a state from every table', () => {
    const m = removeState(TABLE, 'Ox Press');
    expect(m.states.map((s) => s.name)).toEqual(['Idle', 'Fire', 'Engine Abort']);
    expect(m.allowed.Idle).toEqual(['Idle']);
    expect('Ox Press' in m.open).toBe(false);
  });

  it('gives a state with no transition row one the first time it is given a move', () => {
    const m = setAllowed(TABLE, 'Engine Abort', 'Idle', true);
    expect(m.allowed['Engine Abort']).toEqual(['Idle', 'Engine Abort']);
  });

  it('says what the DAQ would: rows wired to nothing, valve connectors with no row', () => {
    const d = wire(empty(), OU, 'sol12', 1, 'Igniter purge');
    const issues = tableIssues({ ...d, machine: { ...d.machine, actuators: TABLE.actuators } });
    expect(issues.unwired).toEqual(['LOX Press', 'LOX Main']);
    expect(issues.rowless.map((c) => c.name)).toEqual(['Igniter purge']);
  });
});

describe('the DAQ’s CSVs', () => {
  it('writes and reads back the same table', () => {
    const back = fromCsv(TABLE, toActuatorCsv(TABLE), toTransitionCsv(TABLE));
    expect(sameMachine(back, TABLE)).toBe(true);
  });

  it('reads a short transition row left-aligned, as the DAQ does', () => {
    const t = ',Idle,Ox Press,Fire,Engine Abort\nIdle,1,1\n';
    const m = fromCsv(TABLE, toActuatorCsv(TABLE), t);
    expect(m.allowed.Idle).toEqual(['Idle', 'Ox Press']);
    expect('Fire' in m.allowed).toBe(false);
  });

  it('writes OPEN and CLOSE in the DAQ’s layout', () => {
    expect(toActuatorCsv(TABLE).split('\n')[2]).toBe('LOX Main,CLOSE,CLOSE,OPEN,OPEN');
  });
});
