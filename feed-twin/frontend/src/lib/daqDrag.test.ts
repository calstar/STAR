import { describe, expect, it, vi } from 'vitest';
import type { BoardDef, HookupSymbol, MachineDef } from '../api';
import {
  type Hit,
  badge,
  badgeLabel,
  badgeRoom,
  badgeWidth,
  boardOption,
  canDropRow,
  cellOf,
  clashNote,
  connectorUnder,
  createStore,
  dropFreshRow,
  pastClick,
  sameKind,
  slotAt,
  slotsOf,
  symbolUnder,
  verdict,
} from './daqDrag';
import { type Draft, opensIn, rename, setRows, unwire, wire } from './hookupDraft';

const TABLE: MachineDef = {
  states: [
    { name: 'Idle', row: 0, col: 0, abort: false },
    { name: 'Fire', row: 5, col: 0, abort: false },
  ],
  actuators: ['LOX Main'],
  open: { Idle: [], Fire: ['LOX Main'] },
  allowed: { Idle: ['Idle', 'Fire'], Fire: ['Fire'] },
};

const SOL12: BoardDef = { id: 'sol12', label: 'Solenoids 12V', kind: 'valve' };
const SOL24: BoardDef = { id: 'sol24', label: 'Solenoids 24V', kind: 'valve' };
const PTL: BoardDef = { id: 'pt_low', label: 'Low press PT', kind: 'pt' };
const RTD: BoardDef = { id: 'rtd', label: 'RTDs', kind: 'rtd' };

const OM: HookupSymbol = { id: 'OM-R', label: 'OM-R', type: 'ROT', page: 'Rocket', kind: 'valve', board: 'sol12', ground: false };
const PT: HookupSymbol = { id: 'PT1', label: 'FU-PT-R', type: 'PT', page: 'Rocket', kind: 'pt', board: 'pt_low', ground: false };
const TEMP: HookupSymbol = { id: 'T1', label: 'OX-RTD', type: 'RTD', page: 'Rocket', kind: 'rtd', board: 'rtd', ground: false };

const empty = (): Draft => ({ valves: {}, knobs: [], aliases: {}, channels: [], rows: {}, machine: TABLE });

describe('the grid', () => {
  it('numbers connectors in reading order, five to a row', () => {
    expect(slotAt(0, 0)).toBe(1);
    expect(slotAt(0, 4)).toBe(5);
    expect(slotAt(1, 0)).toBe(6);
    expect(cellOf(1)).toEqual({ row: 0, col: 0 });
    expect(cellOf(5)).toEqual({ row: 0, col: 4 });
    expect(cellOf(6)).toEqual({ row: 1, col: 0 });
    for (let s = 1; s <= 30; s += 1) expect(slotAt(cellOf(s).row, cellOf(s).col)).toBe(s);
  });

  it('shows two rows to begin with, and enough for the highest cable', () => {
    expect(slotsOf(empty(), 'sol12')).toHaveLength(10);
    expect(slotsOf(wire(empty(), OM, 'sol12', 13), 'sol12')).toHaveLength(15);
  });

  it('lists a board with what is used of what it shows', () => {
    const d = wire(wire(empty(), OM, 'sol12'), PT, 'pt_low');
    expect(boardOption(d, SOL12)).toBe('Solenoids 12V · 1/10');
    expect(boardOption(d, SOL24)).toBe('Solenoids 24V · 0/10');
    expect(boardOption(setRows(d, 'sol24', 4), SOL24)).toBe('Solenoids 24V · 0/20');
  });

  it('takes away only an empty last row, and never one of the first two', () => {
    expect(canDropRow(empty(), 'sol12')).toBe(false);
    const three = setRows(empty(), 'sol12', 3);
    expect(canDropRow(three, 'sol12')).toBe(true);
    expect(canDropRow(wire(three, OM, 'sol12', 11), 'sol12')).toBe(false);
    expect(canDropRow(wire(three, OM, 'sol12', 7), 'sol12')).toBe(true);
  });

  it('badges a connector by its board and number', () => {
    expect(badge({ board: 'sol12', slot: 3 })).toBe('S12·3');
    expect(badge({ board: 'pt_low', slot: 2 })).toBe('PT-L·2');
  });

  it('moves a cable only between boards that take the same thing', () => {
    expect(sameKind(SOL12, SOL24)).toBe(true);
    expect(sameKind(SOL12, PTL)).toBe(false);
    expect(sameKind(SOL12, undefined)).toBe(false);
  });

  it('calls a press a drag only past a few pixels', () => {
    expect(pastClick(2, 2)).toBe(false);
    expect(pastClick(5, 0)).toBe(true);
  });
});

describe('what may plug in, and why not', () => {
  it('takes a valve on either solenoid board, a PT on a PT board', () => {
    expect(verdict(SOL12, OM)).toEqual({ ok: true });
    expect(verdict(SOL24, OM)).toEqual({ ok: true });
    expect(verdict(PTL, PT)).toEqual({ ok: true });
  });

  it('says what the symbol is and where it goes', () => {
    expect(verdict(SOL12, PT)).toEqual({ ok: false, why: 'FU-PT-R is a PT — it plugs into a PT board' });
    expect(verdict(PTL, OM)).toEqual({ ok: false, why: 'OM-R is a valve — it plugs into a solenoid board' });
    expect(verdict(SOL12, TEMP)).toEqual({ ok: false, why: 'OX-RTD is an RTD — it plugs into the RTD board' });
    expect(verdict(RTD, TEMP).ok).toBe(true);
  });

  it('refuses what the box takes nothing from, by its drawn tag', () => {
    expect(verdict(SOL12, undefined, { tag: 'LOX tank', type: 'TANK' })).toEqual({
      ok: false,
      why: "LOX tank (TANK) doesn't plug into the DAQ box",
    });
  });
});

/** A fake page: each element knows its classes, attributes and parent. */
interface FakeEl {
  attrs: Record<string, string>;
  classes: string[];
  parent: FakeEl | null;
}
const el = (attrs: Record<string, string>, classes: string[], parent: FakeEl | null = null): FakeEl => ({
  attrs,
  classes,
  parent,
});
type FakeHit = Hit & { fake: FakeEl };
function hit(e: FakeEl | null): FakeHit | null {
  if (!e) return null;
  const matches = (x: FakeEl, sel: string) =>
    sel.startsWith('.') ? x.classes.includes(sel.slice(1)) : sel.slice(1, -1).split('][').every((a) => a in x.attrs);
  return {
    fake: e,
    closest: (sel) => {
      for (let x: FakeEl | null = e; x; x = x.parent) if (matches(x, sel)) return hit(x);
      return null;
    },
    getAttribute: (name) => e.attrs[name] ?? null,
  };
}
const at = (e: FakeEl | null) => ({ elementFromPoint: () => hit(e) });

describe('what is under the pointer', () => {
  const drawing = el({}, ['pid-drawing']);
  const valve = el({ 'data-id': 'OM-R' }, ['react-flow__node'], drawing);
  const valveArt = el({}, ['symbol-art'], valve);
  const region = el({ 'data-id': 'R1' }, ['react-flow__node'], drawing);
  const elsewhere = el({ 'data-id': 'X' }, ['react-flow__node'], null);
  const types: Record<string, string> = { 'OM-R': 'ROT', R1: 'REGION', X: 'PT' };
  const typeOf = (id: string) => types[id];
  const inDrawing = (h: Hit) => {
    for (let x: FakeEl | null = (h as FakeHit).fake; x; x = x.parent) if (x === drawing) return true;
    return false;
  };

  it('finds the symbol whose art the pointer is over', () => {
    expect(symbolUnder(at(valveArt), 0, 0, inDrawing, typeOf)).toBe('OM-R');
  });

  it('ignores section boxes, notes and tees, and anything off the drawing', () => {
    expect(symbolUnder(at(region), 0, 0, inDrawing, typeOf)).toBeNull();
    expect(symbolUnder(at(elsewhere), 0, 0, inDrawing, typeOf)).toBeNull();
    expect(symbolUnder(at(drawing), 0, 0, inDrawing, typeOf)).toBeNull();
    expect(symbolUnder(at(null), 0, 0, inDrawing, typeOf)).toBeNull();
  });

  it('reads a connector off its cell', () => {
    const cell = el({ 'data-daq-board': 'sol24', 'data-daq-slot': '7' }, []);
    const glyph = el({}, [], cell);
    expect(connectorUnder(at(glyph), 0, 0)).toEqual({ board: 'sol24', slot: 7 });
    expect(connectorUnder(at(el({}, [])), 0, 0)).toBeNull();
  });
});

describe('the row a cable makes for its tag', () => {
  it('goes when the connector is named onto a row the table had', () => {
    // As the panels do it: just plugged, so the name is the twin's guess and
    // the rename does not carry; then the blank row the plug made is dropped.
    const plugged = wire(empty(), OM, 'sol12', 1);
    expect(plugged.machine.actuators).toEqual(['LOX Main', 'OM-R']);
    const named = rename(plugged, 'OM-R', 'lox main', false);
    expect(named.machine.actuators).toEqual(['LOX Main', 'OM-R']);
    const clean = dropFreshRow(named, { symbol: 'OM-R', row: 'OM-R' });
    expect(clean.machine.actuators).toEqual(['LOX Main']);
    expect(clean.channels).toEqual([{ board: 'sol12', slot: 1, name: 'LOX Main', symbol: 'OM-R' }]);
  });

  it('is the only row that goes: a renamed connector leaves the DAQ’s all-CLOSE row it had', () => {
    // Named a while ago, so not fresh: the panels rename with carry and drop
    // nothing. The shipped row opens nowhere and is still the DAQ's.
    const table: MachineDef = { ...TABLE, actuators: ['LOX Main', 'Fuel Fill Vent'] };
    const d = wire({ ...empty(), machine: table }, OM, 'sol12', 1, 'Fuel Fill Vent');
    expect(opensIn(d.machine, 'Fuel Fill Vent')).toEqual([]);
    const named = rename(d, 'OM-R', 'LOX Main');
    expect(named.machine.actuators).toEqual(['LOX Main', 'Fuel Fill Vent']);
    // Nothing is fresh, so the panels' clean-up leaves it too.
    expect(dropFreshRow(named, null)).toBe(named);
  });

  it('goes when the cable is pulled straight out', () => {
    const d = unwire(wire(empty(), OM, 'sol12', 1), 'OM-R');
    expect(dropFreshRow(d, { symbol: 'OM-R', row: 'OM-R' }).machine.actuators).toEqual(['LOX Main']);
  });

  it('stays while a connector goes by it, or once a state opens it', () => {
    const d = wire(empty(), OM, 'sol12', 1);
    expect(dropFreshRow(d, { symbol: 'OM-R', row: 'OM-R' })).toBe(d);
    const opened = { ...unwire(d, 'OM-R'), machine: { ...d.machine, open: { ...d.machine.open, Fire: ['LOX Main', 'OM-R'] } } };
    expect(dropFreshRow(opened, { symbol: 'OM-R', row: 'OM-R' })).toBe(opened);
    expect(dropFreshRow(d, null)).toBe(d);
  });
});

describe('a name another connector has', () => {
  it('says which connector has it and where it goes', () => {
    const d = wire(empty(), OM, 'sol12', 1, 'LOX Main');
    const tag = (id: string) => ({ 'OM-R': 'OM-R' })[id] ?? id;
    expect(clashNote(d, 'lox main', 'OU', tag)).toBe('LOX Main is S12·1 → OM-R');
    expect(clashNote(d, 'LOX Main', 'OM-R', tag)).toBeNull();
    expect(clashNote(d, 'Fuel Main', 'OU', tag)).toBeNull();
    expect(clashNote(d, '  ', 'OU', tag)).toBeNull();
  });
});

describe('the badge on the drawing', () => {
  const ch = { board: 'sol12' as const, slot: 1, name: 'LOX Main', symbol: 'OM-R' };

  it('carries the name when there is room, cut short when only some fits, and the connector alone when less', () => {
    expect(badgeLabel(ch, 200)).toBe('S12·1 LOX Main');
    expect(badgeLabel(ch, badgeWidth('S12·1 LOX Main'))).toBe('S12·1 LOX Main');
    expect(badgeLabel(ch, badgeWidth('S12·1 LOX Main') - 1)).toBe('S12·1 LOX Ma…');
    expect(badgeLabel(ch, badgeWidth('S12·1 LOX…'))).toBe('S12·1 LOX…');
    expect(badgeLabel(ch, badgeWidth('S12·1 LO…'))).toBe('S12·1');
    expect(badgeLabel(ch, 0)).toBe('S12·1');
  });

  it('has the room the nearest badge on its line leaves, and no more than the most', () => {
    const at = { x: 100, y: 50 };
    expect(badgeRoom(at, [])).toBe(180);
    expect(badgeRoom(at, [], 90)).toBe(90);
    // 80 apart on the same line: each may be 80 less the gap wide.
    expect(badgeRoom(at, [{ x: 180, y: 52 }])).toBe(74);
    expect(badgeRoom(at, [{ x: 180, y: 52 }, { x: 60, y: 45 }])).toBe(34);
    // One on another line takes nothing.
    expect(badgeRoom(at, [{ x: 105, y: 120 }])).toBe(180);
  });

  it('two neighbours given their room never overlap', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 90, y: 4 };
    const wa = badgeWidth(badgeLabel(ch, badgeRoom(a, [b])));
    const wb = badgeWidth(badgeLabel({ ...ch, name: 'Fuel Main' }, badgeRoom(b, [a])));
    expect(wa / 2 + wb / 2).toBeLessThanOrEqual(90);
  });
});

describe('the shared store', () => {
  it('tells subscribers of a change, and only of a change', () => {
    const s = createStore({ a: 1, b: 'x' as string | null });
    const heard = vi.fn();
    const stop = s.subscribe(heard);
    s.set({ a: 1 });
    expect(heard).not.toHaveBeenCalled();
    s.set({ a: 2 });
    s.set((x) => ({ b: x.b === 'x' ? null : 'x' }));
    expect(heard).toHaveBeenCalledTimes(2);
    expect(s.get()).toEqual({ a: 2, b: null });
    stop();
    s.set({ a: 3 });
    expect(heard).toHaveBeenCalledTimes(2);
  });
});
