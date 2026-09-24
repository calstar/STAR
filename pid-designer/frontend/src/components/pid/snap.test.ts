import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { dropShift, snapOnDrop, SNAP_TOLERANCE } from './snap';
import type { Port, PortsOf } from './snap';

describe('dropping a symbol with no line on an axis lines its ports up with free ports on it', () => {
  /** Symbols whose ports are where each case says, from the symbol's corner. */
  const layout: Record<string, Port[]> = {};
  const part = (id: string, x: number, y: number, ports: Port[]): Node => {
    layout[id] = ports;
    return { id, type: 'MAN', position: { x, y }, data: { componentType: 'MAN', label: id, page: 'Main' } };
  };
  const where: PortsOf = n => layout[n.id].map(p => ({ ...p, x: n.position.x + p.x, y: n.position.y + p.y }));
  const up = (x: number): Port => ({ id: `t${x}`, x, y: 0, side: 'top' });
  const down = (x: number): Port => ({ id: `b${x}`, x, y: 60, side: 'bottom' });
  const left = (y: number): Port => ({ id: `l${y}`, x: 0, y, side: 'left' });
  const right = (y: number): Port => ({ id: `r${y}`, x: 60, y, side: 'right' });
  const shift = (nodes: Node[], id: string) => dropShift(nodes, [], new Set([id]), where);

  it('closes the gap the grid cannot', () => {
    // The reported case, in numbers. A rotary valve is 60 wide so its centre
    // port is 30 from the origin; an engine is 72, so its top port is at 36.
    // Both origins snap to 10, so the ports are always 6 out — at every
    // position, forever.
    expect(shift([part('ROT', 100, 200, [down(30)]), part('ENG', 100, 400, [up(36)])], 'ENG')).toEqual({ dx: -6, dy: 0 });
  });

  it('leaves a symbol alone when its ports already line up', () => {
    expect(shift([part('a', 100, 200, [down(30)]), part('b', 100, 400, [up(30)])], 'b')).toEqual({ dx: 0, dy: 0 });
  });

  it('will not drag something across a deliberate offset', () => {
    // One grid square across is a decision, not a near miss.
    expect(shift([part('a', 100, 200, [down(30)]), part('b', 110, 400, [up(30)])], 'b').dx).toBe(0);
  });

  it('reaches every pair there can be, from the nearest square, and the tolerance itself', () => {
    // Both origins sit on the ten grid, so whatever two symbols' port offsets
    // are, the nearest square leaves them at most five apart. The tolerance
    // has to cover five and stop short of ten; a pair exactly the tolerance
    // apart is the case it was sized for.
    for (let residual = 0; residual <= SNAP_TOLERANCE; residual++) {
      const { dx } = shift([part('o', 100, 0, [down(30)]), part('m', 100, 200, [up(30 + residual)])], 'm');
      expect(dx + residual, `residual ${residual}`).toBe(0);
    }
    for (let gap = SNAP_TOLERANCE + 1; gap <= 30; gap++) {
      expect(shift([part('o', 100, 0, [down(30 + gap)]), part('m', 100, 200, [up(30)])], 'm').dx, `gap ${gap}`).toBe(0);
    }
  });

  it('takes the nearest alignment, not the first one found', () => {
    const nodes = [part('far', 100, 0, [down(37)]), part('near', 200, 0, [down(-68)]), part('m', 100, 200, [up(34)])];
    // far's port at 137, near's at 132, the moved one's at 134.
    expect(shift(nodes, 'm').dx).toBe(-2);
  });

  it('decides each axis on its own', () => {
    // Lined up vertically with one neighbour, horizontally with another --
    // which is what a real bay looks like.
    const nodes = [part('above', 103, 0, [down(30)]), part('beside', 900, 267, [left(30)]), part('m', 100, 270, [up(30), right(30)])];
    expect(shift(nodes, 'm')).toEqual({ dx: 3, dy: -3 });
  });

  it('considers every port, not just the first', () => {
    // A tank's third outlet is what lines up, not its first.
    expect(shift([part('t', 200, 300, [up(20)]), part('tank', 170, 0, [down(10), down(30), down(53)])], 'tank').dx).toBe(-3);
  });

  it('does nothing when there is nothing to line up with', () => {
    expect(shift([part('m', 100, 270, [up(30)])], 'm')).toEqual({ dx: 0, dy: 0 });
  });

  it('takes less than half a pixel out of line for the measuring, and leaves it', () => {
    // A port measured a hundred-thousandth of a pixel off, at a zoom that is
    // not one: shifted to meet it, the symbol went off the grid by as much.
    expect(shift([part('o', 100, 0, [down(30.0000036)]), part('m', 100, 200, [up(30)])], 'm')).toEqual({ dx: 0, dy: 0 });
  });
});

// ── Lining up along connections ──────────────────────────────────────────────

/** A 60 px symbol with a port on each side, facing out; a tee is a 10 px dot. */
const sym = (id: string, x: number, y: number, page = 'Main'): Node =>
  ({ id, type: 'MAN', position: { x, y }, data: { componentType: 'MAN', label: id, page } });
const tee = (id: string, cx: number, cy: number, along?: { in: string; out: string }): Node =>
  ({ id, type: 'JUNCTION', position: { x: cx - 5, y: cy - 5 }, data: { componentType: 'JUNCTION', label: id, page: 'Main', ...(along ? { along: { t: 0.5, ...along } } : {}) } });
const ports: PortsOf = n => {
  const { x, y } = n.position;
  const out: Port[] = [
    { id: 'l', x, y: y + 30, side: 'left' }, { id: 'r', x: x + 60, y: y + 30, side: 'right' },
    { id: 't', x: x + 30, y, side: 'top' }, { id: 'b', x: x + 30, y: y + 60, side: 'bottom' },
  ];
  return out;
};
const line = (s: string, sh: string, t: string, th: string, data: Record<string, unknown> = {}): Edge =>
  ({ id: `${s}.${sh}-${t}.${th}`, source: s, sourceHandle: sh, target: t, targetHandle: th, data });
const moved = (...ids: string[]) => new Set(ids);

describe('dropping a symbol lines it up along its connections', () => {
  it('lines a port up with the far end of its own line, and with nothing it is not wired to', () => {
    // V is wired to M's bottom port, 5 px off; a neighbour N below has a free
    // top port only 3 px off V's. The neighbour is not V's business.
    const V = sym('V', 205, 200), M = sym('M', 200, 0), N = sym('N', 208, 400);
    const edges = [line('M', 'b', 'V', 't')];
    expect(dropShift([V, M, N], edges, moved('V'), ports)).toEqual({ dx: -5, dy: 0 });
  });

  it('takes a tee by its centre, not the face its line is on', () => {
    // Faces are three pixels either side of the tee's column.
    const J = tee('J', 203, 100, { in: 'l', out: 'r' }), V = sym('V', 170, 200);
    expect(dropShift([J, V], [line('J', 'b', 'V', 't')], moved('V'), ports)).toEqual({ dx: 3, dy: 0 });
  });

  it('lines up only two ends facing along the same axis', () => {
    // V's bottom port goes to W's left port, 4 px across from it: an L
    // whatever is done, so nothing is lined up.
    const V = sym('V', 0, 0), W = sym('W', 34, 62);
    expect(dropShift([V, W], [line('V', 'b', 'W', 'l')], moved('V'), ports)).toEqual({ dx: 0, dy: 0 });
    // Two ports facing each other across a gap do line up.
    const X = sym('X', 200, 4);
    expect(dropShift([V, X], [line('V', 'r', 'X', 'l')], moved('V'), ports)).toEqual({ dx: 0, dy: 4 });
  });

  it('falls back to the free ports on the page on an axis it has no connection on, never a port in use', () => {
    const V = sym('V', 0, 0), F = sym('F', 4, 300), U = sym('U', 2, -300), Q = sym('Q', 500, 1);
    // F's top port is free and 4 off; U's ports up and down are 2 off, and both have their lines.
    const edges = [line('U', 'b', 'Q', 't'), line('Q', 'b', 'U', 't')];
    expect(dropShift([V, F, U, Q], edges, moved('V'), ports).dx).toBe(4);
    // Wired on that axis, the free ports are not looked at.
    const W = sym('W', 30, 200);
    expect(dropShift([V, F, U, Q, W], [...edges, line('V', 'b', 'W', 't')], moved('V'), ports).dx).toBe(0);
  });

  it('does not line a riding tee up by the lines of its own pipe', () => {
    // Both ends of its pipe are 4 px below it; the pipe, not the drop, decides where it sits.
    const A = sym('A', 0, 104), B = sym('B', 400, 104), J = tee('J', 200, 130, { in: 'l', out: 'r' });
    const edges = [line('A', 'r', 'J', 'l'), line('J', 'r', 'B', 'l')];
    expect(dropShift([A, B, J], edges, moved('J'), ports)).toEqual({ dx: 0, dy: 0 });
  });

  it('lines a pipe with a tee on it up by the pipe\'s two ends, wherever the tee is', () => {
    // A.r -> J -> B.l, A dropped dy off B's level. The tee rides the pipe, so
    // it is on A's leg of the Z (level with A), on B's leg, or halfway where
    // the router straightened a small offset -- and none of those is where
    // the pipe is straight. B is.
    for (const dy of [-6, -5, -3, 3, 5, 6]) {
      for (const [where, cy] of [['on A\'s leg', 30 + dy], ['on B\'s leg', 30], ['halfway', 30 + dy / 2]] as const) {
        const A = sym('A', 0, dy), B = sym('B', 400, 0), J = tee('J', 200, cy, { in: 'l', out: 'r' });
        const edges = [line('A', 'r', 'J', 'l'), line('J', 'r', 'B', 'l')];
        expect(dropShift([A, B, J], edges, moved('A'), ports), `dy ${dy}, tee ${where}`).toEqual({ dx: 0, dy: -dy });
      }
    }
  });

  it('lines a pipe up by its ends through any number of tees, and a pipe ending on a tee by that tee\'s centre', () => {
    const A = sym('A', 0, 4), J = tee('J', 150, 34, { in: 'l', out: 'r' }), K = tee('K', 250, 30, { in: 'l', out: 'r' });
    const B = sym('B', 400, 0), L = tee('L', 520, 30);
    const run = [line('A', 'r', 'J', 'l'), line('J', 'r', 'K', 'l'), line('K', 'r', 'B', 'l')];
    expect(dropShift([A, J, K, B], run, moved('A'), ports)).toEqual({ dx: 0, dy: -4 });
    // The same pipe ending on a free junction's face: its centre is the far end.
    const toTee = [line('A', 'r', 'J', 'l'), line('J', 'r', 'K', 'l'), line('K', 'r', 'L', 'l')];
    expect(dropShift([A, J, K, L], toTee, moved('A'), ports)).toEqual({ dx: 0, dy: -4 });
  });

  it('lines up the port a pipe leaves by with the port it arrives at, not another port of either symbol', () => {
    // Two regulators with the outlet 24 px lower than the inlet. A's outlet
    // is 3 px above R's inlet, and either symbol's other port is 27 px from
    // the other's.
    const skew: PortsOf = n => (n.type === 'REG'
      ? [{ id: 'l', x: n.position.x, y: n.position.y + 20, side: 'left' }, { id: 'r', x: n.position.x + 60, y: n.position.y + 44, side: 'right' }]
      : ports(n));
    const reg = (id: string, x: number, y: number): Node => ({ ...sym(id, x, y), type: 'REG' });
    const A = reg('A', 0, -27), R = reg('R', 400, 0), J = tee('J', 200, 17, { in: 'l', out: 'r' });
    const edges = [line('A', 'r', 'J', 'l'), line('J', 'r', 'R', 'l')];
    expect(dropShift([A, R, J], edges, moved('A'), skew)).toEqual({ dx: 0, dy: 3 });
    expect(dropShift([A, R, J], edges, moved('R'), skew)).toEqual({ dx: 0, dy: -3 });
  });

  it('looks at nothing on another page', () => {
    const V = sym('V', 0, 0), M = sym('M', 3, -200, 'GSE');
    expect(dropShift([V, M], [line('M', 'b', 'V', 't')], moved('V'), ports, 'Main')).toEqual({ dx: 0, dy: 0 });
    expect(dropShift([V, M], [], moved('V'), ports, 'Main')).toEqual({ dx: 0, dy: 0 });
  });

  it('gives a group one shift, the smallest', () => {
    const V = sym('V', 0, 0), W = sym('W', 100, 0), M = sym('M', 4, 200), N = sym('N', 102, 200);
    const edges = [line('V', 'b', 'M', 't'), line('W', 'b', 'N', 't')];
    expect(dropShift([V, W, M, N], edges, moved('V', 'W'), ports)).toEqual({ dx: 2, dy: 0 });
  });
});

describe('snapOnDrop', () => {
  it('moves what belongs to the moved symbols with them: corners between them, probes on them', () => {
    const V = sym('V', 0, 0), W = sym('W', 200, 0), M = sym('M', 3, 200);
    const probe: Node = { id: 'P', type: 'PT', position: { x: 10, y: -50 }, data: { componentType: 'PT', attachedTo: 'V' } };
    const hand = line('V', 'r', 'W', 'l', { waypoints: [{ x: 76, y: 30 }, { x: 76, y: 90 }, { x: 184, y: 90 }, { x: 184, y: 30 }] });
    const edges = [hand, line('V', 'b', 'M', 't', { waypoints: [{ x: 30, y: 100 }] })];
    const r = snapOnDrop([V, W, M, probe], edges, moved('V', 'W'), ports);
    expect(r.shift).toEqual({ dx: 3, dy: 0 });
    expect(r.nodes.find(n => n.id === 'P')!.position).toEqual({ x: 13, y: -50 });
    expect((r.edges[0].data as { waypoints: unknown[] }).waypoints).toEqual([{ x: 79, y: 30 }, { x: 79, y: 90 }, { x: 187, y: 90 }, { x: 187, y: 30 }]);
    // A line with one end left behind keeps its corners where they were put.
    expect(r.edges[1]).toBe(edges[1]);
  });

  it('hands back the same arrays when nothing lines up', () => {
    const nodes = [sym('V', 0, 0), sym('M', 20, 200)];
    const edges = [line('V', 'b', 'M', 't')];
    const r = snapOnDrop(nodes, edges, moved('V'), ports);
    expect(r.nodes).toBe(nodes);
    expect(r.edges).toBe(edges);
  });
});
