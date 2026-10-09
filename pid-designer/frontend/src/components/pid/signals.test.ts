// The dotted lines out of a 5/2 solenoid manifold's outlets (signals.ts): what
// one ends on, how it is stored, and where it is drawn. The canvas's own drag
// into one is in dropWiring.test.ts.
import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import { isSignalPort, setSignal, signalLines, signalPaths, signalTo, signalsOf } from './signals';
import { bankPort } from './nodes/ValveBankNode';
import type { Pt } from './route';

const bank = (signals?: Record<string, unknown>, extra: Partial<Node> = {}): Node => ({
  id: 'VB', type: 'VALVE_BANK', position: { x: 100, y: 100 },
  data: { componentType: 'VALVE_BANK', label: 'VB-1', options: { outlets: '3' }, ...(signals ? { signals } : {}) },
  ...extra,
}) as Node;
const sym = (id: string, x: number, y: number, extra: Partial<Node> = {}): Node =>
  ({ id, type: 'ROT', position: { x, y }, data: { componentType: 'ROT', label: id }, ...extra }) as Node;

/** The path's points, in order. */
const corners = (d: string): Pt[] =>
  [...d.matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)].map(m => ({ x: Number(m[1]), y: Number(m[2]) }));

describe('a solenoid manifold outlet', () => {
  it('is a signal port; its supply, and every other symbol, are not', () => {
    expect(isSignalPort(bank(), 'p')).toBe(true);
    expect(isSignalPort(bank(), 'p3')).toBe(true);
    expect(isSignalPort(bank(), 'in')).toBe(false);
    expect(isSignalPort(sym('V', 0, 0), 'p')).toBe(false);
  });
});

describe('where a dotted line ends', () => {
  const nodes = [bank(), sym('V', 300, 300),
    { id: 'R', type: 'REGION', position: { x: 0, y: 0 }, data: { componentType: 'REGION', label: 'Section' } } as Node];

  it('on a symbol, at the spot it was let go on, kept from the symbol\'s corner', () => {
    expect(signalTo('VB', { x: 312, y: 345 }, { node: 'V' }, nodes)).toEqual({ to: 'V', at: { x: 12, y: 45 } });
  });
  it('on a line, at how far along it', () => {
    const line = { id: 'L', at: { x: 150, y: 0 }, points: [{ x: 100, y: 0 }, { x: 300, y: 0 }] };
    expect(signalTo('VB', { x: 150, y: 2 }, { line }, nodes)).toEqual({ to: 'L', along: 0.25 });
  });
  it('on a section box or the canvas, where it was let go', () => {
    expect(signalTo('VB', { x: 40, y: 50 }, { node: 'R' }, nodes)).toEqual({ at: { x: 40, y: 50 } });
    expect(signalTo('VB', { x: 40, y: 50 }, {}, nodes)).toEqual({ at: { x: 40, y: 50 } });
  });
  it('back on its own manifold, nowhere', () => {
    expect(signalTo('VB', { x: 110, y: 120 }, { node: 'VB' }, nodes)).toBeNull();
  });
});

describe('storing one', () => {
  it('sets, replaces and takes away one outlet\'s line, leaving the rest', () => {
    let nodes = [bank(), sym('V', 300, 300)];
    nodes = setSignal(nodes, 'VB', 'p', { to: 'V', at: { x: 0, y: 0 } });
    nodes = setSignal(nodes, 'VB', 'p2', { at: { x: 5, y: 5 } });
    nodes = setSignal(nodes, 'VB', 'p', { at: { x: 9, y: 9 } });
    expect(signalsOf(nodes[0])).toEqual({ p: { at: { x: 9, y: 9 } }, p2: { at: { x: 5, y: 5 } } });
    nodes = setSignal(setSignal(nodes, 'VB', 'p', null), 'VB', 'p2', null);
    expect('signals' in nodes[0].data).toBe(false);
    expect(nodes[1]).toBe(nodes[1]);
  });
});

describe('drawing one', () => {
  const out = bankPort(3, 'p2')!.along;

  it('leaves its outlet straight up, then turns once to where it ends', () => {
    const [path] = signalPaths([bank({ p2: { at: { x: 400, y: 20 } } })], new Map());
    const pts = corners(path.d);
    expect(pts[0]).toEqual({ x: 100 + out, y: 97 });
    expect(pts[1]).toEqual({ x: 100 + out, y: 87 });
    expect(pts[pts.length - 1]).toEqual({ x: 400, y: 20 });
    // Every leg level or plumb.
    for (let i = 1; i < pts.length; i++) expect(pts[i].x === pts[i - 1].x || pts[i].y === pts[i - 1].y).toBe(true);
    expect(path.lands).toBe(false);
  });

  it('follows the symbol it ends on when that moves', () => {
    const signals = { p: { to: 'V', at: { x: 10, y: 20 } } };
    const at = (v: Node) => signalPaths([bank(signals), v], new Map())[0].end;
    expect(at(sym('V', 300, 300))).toEqual({ x: 310, y: 320 });
    expect(at(sym('V', 500, 0))).toEqual({ x: 510, y: 20 });
  });

  it('lands on a line where the line is drawn', () => {
    const route = new Map([['L', [{ x: 0, y: 400 }, { x: 200, y: 400 }, { x: 200, y: 600 }]]]);
    const [path] = signalPaths([bank({ p: { to: 'L', along: 0.75 } })], route);
    expect(path.end).toEqual({ x: 200, y: 500 });
    expect(path.lands).toBe(true);
  });

  it('is not drawn when its manifold or what it ends on is hidden or gone', () => {
    const signals = { p: { to: 'V', at: { x: 0, y: 0 } }, p2: { to: 'gone', along: 0.5 } };
    expect(signalPaths([bank(signals), sym('V', 0, 0, { hidden: true })], new Map())).toEqual([]);
    expect(signalPaths([bank(signals, { hidden: true }), sym('V', 0, 0)], new Map())).toEqual([]);
  });

  it('asks to follow only the lines it ends on', () => {
    expect(signalLines([bank({ p: { to: 'V', at: { x: 0, y: 0 } }, p2: { to: 'L' } }), sym('V', 0, 0)])).toEqual(['L']);
  });
});
