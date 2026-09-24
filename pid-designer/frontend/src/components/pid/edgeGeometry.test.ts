// Where the lines are drawn, and who is told when that changes (edgeGeometry.ts).
//
// Each line publishes the route it routed itself and reads back how it is to
// be drawn -- moved a grid step off a line it would lie on (tracks.ts) -- and
// the drawn routes near it, which it hops. What is pinned here is who hears
// of a change: the lines it could matter to, and no others, and nobody at all
// when a line draws itself again as it was told. The hooks are run through
// the small hook runtime in hookRuntime.ts, as there is no DOM here.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Position } from '@xyflow/react';

vi.mock('react', async (orig) => {
  const R = await orig<typeof import('react')>();
  const { hooks } = await import('./hookRuntime');
  return { ...R, ...hooks, default: { ...R, ...hooks } };
});

import { rt } from './hookRuntime';
import {
  drawnCorners, lineView, passes, publishEdge, publishedLines, unpublishEdge, useDrawnRoutes, useLineView, watchLine, watchRoute,
} from './edgeGeometry';
import type { LineInfo } from './edgeGeometry';
import { BoxGrid } from './routeGrid';
import { pathPoints, routeOrthogonal, segmentEntersBox } from './route';
import type { Box, End, Pt } from './route';

const P = (x: number, y: number): Pt => ({ x, y });
const R = (x: number, y: number): End => ({ x, y, side: Position.Right });
const L = (x: number, y: number): End => ({ x, y, side: Position.Left });

/** A line that routes itself, as a line publishes it: its route and its ends. */
function routed(a: End, b: End): { pts: Pt[]; info: LineInfo } {
  return { pts: pathPoints(routeOrthogonal(a, b).d), info: { a, b, free: true } };
}

/** Everything a test published, taken away again after it. */
const published = new Set<string>();
function publish(id: string, line: { pts: Pt[]; info?: LineInfo }) {
  published.add(id);
  publishEdge(id, line.pts, line.info);
}
afterEach(async () => {
  for (const id of published) unpublishEdge(id);
  published.clear();
  rt.reset();
  await settled();
});

/** The lines are told in a microtask; this waits until they have been. */
const settled = () => new Promise(r => setTimeout(r, 0));

/** How many times each id's listener has been called since it was watched. */
function watch(ids: string[], on = watchLine) {
  const calls = new Map(ids.map(id => [id, 0]));
  const offs = ids.map(id => on(id, () => calls.set(id, calls.get(id)! + 1)));
  return { calls, stop: () => offs.forEach(f => f()) };
}

// Two feeds between two columns, dropping further than they are apart: alone
// each is a Z with its crossbar at x = 180; together the second turns a grid
// step earlier.
const feed1 = () => routed(R(63, 30), L(297, 150));
const feed2 = () => routed(R(63, 130), L(297, 250));

describe('who is told', () => {
  it('a line far from a change is neither told nor looked at again', async () => {
    publish('A', routed(R(63, 30), L(297, 150)));
    publish('C', { pts: [P(200, 0), P(200, 300)] });          // crosses A's crossbar... and its legs
    publish('B', routed(R(5063, 5030), L(5297, 5150)));       // far away
    await settled();
    const farView = lineView('B');
    const w = watch(['A', 'B', 'C']);
    // A moves: its crossbar down the sheet a little.
    publish('A', routed(R(63, 40), L(297, 160)));
    await settled();
    expect(w.calls.get('B')).toBe(0);
    expect(lineView('B')).toBe(farView);
    // C hops A, so C hears of it.
    expect(w.calls.get('C')).toBe(1);
    expect(lineView('C')!.near).toEqual([lineView('A')!.pts]);
    // A itself drew its new route beside the same neighbour when it
    // rendered, which is exactly what it is to draw: nothing to tell it.
    expect(w.calls.get('A')).toBe(0);
    expect(lineView('A')!.pts).toBe(lineView('A')!.base);
    w.stop();
  });

  it('a line the pass moves is told where to go, and the line it moved off is told of it', async () => {
    publish('HV1', feed1());
    await settled();
    const w = watch(['HV1', 'HV2']);
    publish('HV2', feed2());
    await settled();
    // HV2 drew its own route when it rendered; it is to draw it a step over.
    expect(w.calls.get('HV2')).toBe(1);
    expect(lineView('HV2')!.pts.map(p => p.x)).toEqual([63, 170, 170, 297]);
    // HV1 has a new neighbour to hop, or not: told, and drawn where it was.
    expect(w.calls.get('HV1')).toBe(1);
    expect(lineView('HV1')!.pts).toBe(lineView('HV1')!.base);
    w.stop();
  });

  it('whatever lands on a line hears when it is drawn somewhere new, even when only another line moved', async () => {
    publish('HV2', feed2());
    await settled();
    const w = watch(['HV2'], watchRoute);
    publish('HV1', feed1());
    await settled();
    expect(w.calls.get('HV2')).toBe(1);
    expect(drawnCorners().get('HV2')![1].x).toBe(170);
    unpublishEdge('HV1');
    await settled();
    expect(w.calls.get('HV2')).toBe(2);
    expect(drawnCorners().get('HV2')![1].x).toBe(180);
    w.stop();
  });

  it('a line the pass moved is drawn as it was, and nobody told, when something far away changes', async () => {
    publish('HV1', feed1());
    publish('HV2', feed2());
    await settled();
    const moved = lineView('HV2')!;
    expect(moved.pts).not.toBe(moved.base);
    const w = watch(['HV1', 'HV2']);
    const r = watch(['HV1', 'HV2'], watchRoute);
    publish('far', routed(R(5063, 5030), L(5297, 5150)));
    await settled();
    expect(lineView('HV2')).toBe(moved);
    expect(drawnCorners().get('HV2')).toBe(moved.pts);
    expect([...w.calls.values(), ...r.calls.values()]).toEqual([0, 0, 0, 0]);
    w.stop();
    r.stop();
  });

  it('a line published again with nothing about its drawing changed leaves its neighbours\' views as they were', async () => {
    const A = routed(R(63, 30), L(297, 150));
    publish('A', A);
    publish('C', { pts: [P(200, 0), P(200, 300)] });
    await settled();
    const view = lineView('C');
    // The same route and ends; only what it would hand the pass to keep
    // out of symbols is new.
    publish('A', { pts: A.pts, info: { ...A.info, sheet: () => undefined } });
    await settled();
    expect(lineView('C')).toBe(view);
  });

  it('a line taken off the page leaves its neighbours to hop nothing', async () => {
    publish('A', routed(R(63, 30), L(297, 150)));
    publish('C', { pts: [P(100, 0), P(100, 300)] });
    await settled();
    expect(lineView('C')!.near).toHaveLength(1);
    const w = watch(['C']);
    unpublishEdge('A');
    await settled();
    expect(w.calls.get('C')).toBe(1);
    expect(lineView('C')!.near).toEqual([]);
    expect(lineView('A')).toBeNull();
    expect(drawnCorners().has('A')).toBe(false);
    w.stop();
  });
});

describe('what a line says of itself', () => {
  it('a line that becomes a person\'s is no longer moved, and the one beside it moves off it instead', async () => {
    publish('HV1', feed1());
    publish('HV2', feed2());
    await settled();
    expect(lineView('HV2')!.pts[1].x).toBe(170);
    const w = watch(['HV1', 'HV2']);
    // Its corners are its own now: the same route, drawn as it is.
    publish('HV2', { pts: feed2().pts, info: { ...feed2().info, free: false } });
    await settled();
    expect(lineView('HV2')!.pts[1].x).toBe(180);
    expect(lineView('HV1')!.pts[1].x).toBe(190);
    expect(w.calls.get('HV1')).toBe(1);
    expect(w.calls.get('HV2')).toBe(1);
    w.stop();
  });

  it('keeps a moved segment out of the symbols the line says are on the page', async () => {
    // A valve standing where the second line would otherwise turn, at x = 170.
    const valve = { x: 115, y: 150, w: 60, h: 60 };
    const sheet = () => ({ overlapping: () => [valve] });
    publish('HV1', feed1());
    publish('HV2', { pts: feed2().pts, info: { ...feed2().info, sheet } });
    await settled();
    expect(lineView('HV2')!.pts[1].x).toBe(190);
  });
});

describe('the page\'s symbols', () => {
  /**
   * The canvas's sheet as the lines lend it: filed afresh for every change
   * to the canvas's nodes, as React Flow's store hands out a new array of
   * them, and a way to be told of each change.
   */
  function canvas(boxes: Box[] = []) {
    const listeners = new Set<() => void>();
    const c = {
      grid: new BoxGrid(boxes),
      listeners,
      sheet: () => c.grid,
      watchSheet: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
      /** The nodes changed: a sheet filed afresh, and everyone listening told. */
      change(next: Box[]) { c.grid = new BoxGrid(next); for (const l of [...listeners]) l(); },
    };
    return c;
  }
  const lend = (line: { pts: Pt[]; info: LineInfo }, c: ReturnType<typeof canvas>) =>
    ({ pts: line.pts, info: { ...line.info, sheet: c.sheet, watchSheet: c.watchSheet } });
  const runsInto = (pts: Pt[], b: Box) => pts.some((p, i) => i + 1 < pts.length && segmentEntersBox(p, pts[i + 1], b, 1));

  it('a symbol put down on a moved segment moves the line off it at once, though no line published', async () => {
    const c = canvas();
    publish('HV1', lend(feed1(), c));
    publish('HV2', lend(feed2(), c));
    await settled();
    expect(lineView('HV2')!.pts[1].x).toBe(170);
    const w = watch(['HV1', 'HV2']);
    // An instrument dropped on the moved crossbar, clear of both lines as
    // they route themselves at x = 180: no line's route changes.
    const gauge = { x: 158, y: 180, w: 20, h: 20 };
    c.change([gauge]);
    await settled();
    const moved = lineView('HV2')!.pts;
    expect(runsInto(moved, gauge)).toBe(false);
    expect(moved[1].x).toBe(150);
    expect(w.calls.get('HV2')).toBe(1);
    // Taken away again, the line goes back.
    c.change([]);
    await settled();
    expect(lineView('HV2')!.pts[1].x).toBe(170);
    w.stop();
  });

  it('the same symbols on a sheet filed afresh -- a selection, a drag of something else -- run no pass and tell nobody', async () => {
    const valve = { x: 115, y: 150, w: 60, h: 60 };
    const c = canvas([valve]);
    publish('HV1', lend(feed1(), c));
    publish('HV2', lend(feed2(), c));
    await settled();
    const w = watch(['HV1', 'HV2']);
    const ran = passes();
    for (let i = 0; i < 5; i++) c.change([{ ...valve }]);
    await settled();
    expect(passes()).toBe(ran);
    expect([...w.calls.values()]).toEqual([0, 0]);
    // A sheet that cannot say what is on it is known by what it is: told of
    // a change with the same sheet in hand, nothing has changed.
    const bare = { overlapping: (x0: number, y0: number, x1: number, y1: number) => c.grid.overlapping(x0, y0, x1, y1) };
    const tell = new Set<() => void>();
    publish('HV1', { ...feed1(), info: { ...feed1().info, sheet: () => bare, watchSheet: l => { tell.add(l); return () => { tell.delete(l); }; } } });
    await settled();
    const now = passes();
    for (const l of tell) l();
    await settled();
    expect(passes()).toBe(now);
    w.stop();
  });

  it('is listened to once, however many lines lend it, and not at all with no line left that may move', async () => {
    const c = canvas();
    // Lines that lend a sheet but no way to hear of it, then the same lines lending both.
    publish('HV1', { ...feed1(), info: { ...feed1().info, sheet: c.sheet } });
    publish('HV2', { ...feed2(), info: { ...feed2().info, sheet: c.sheet } });
    await settled();
    expect(c.listeners.size).toBe(0);
    publish('HV1', lend(feed1(), c));
    publish('HV2', lend(feed2(), c));
    await settled();
    expect(c.listeners.size).toBe(1);
    // The line whose sheet was read leaves: the sheet is still heard, through the other.
    unpublishEdge('HV1');
    await settled();
    expect(c.listeners.size).toBe(1);
    const ran = passes();
    c.change([{ x: 158, y: 180, w: 20, h: 20 }]);
    await settled();
    expect(passes()).toBe(ran + 1);
    // The last line that could move becomes a person's: nothing is left to keep out of anything.
    publish('HV2', { pts: feed2().pts, info: { ...lend(feed2(), c).info, free: false } });
    await settled();
    expect(c.listeners.size).toBe(0);
  });

  it('hands out the lines as they published themselves, in id order, for a preview to separate with its own', async () => {
    publish('HV2', feed2());
    publish('HV1', feed1());
    publish('C', { pts: [P(200, 0), P(200, 300)] });
    await settled();
    const lines = publishedLines();
    expect(lines.map(l => l.id)).toEqual(['C', 'HV1', 'HV2']);
    expect(lines[2]).toMatchObject({ pts: feed2().pts, a: feed2().info.a, b: feed2().info.b, free: true });
    expect(lines[0].free).toBeUndefined();
  });
});

describe('nothing loops', () => {
  it('a line drawn again as it was told publishes the same route, and nothing moves and nobody is told', async () => {
    publish('HV1', feed1());
    publish('HV2', feed2());
    await settled();
    const table = drawnCorners();
    const views = ['HV1', 'HV2'].map(lineView);
    const w = watch(['HV1', 'HV2']);
    const r = watch(['HV1', 'HV2'], watchRoute);
    const ran = passes();
    // What a line does on every render: read its view, draw it, and publish
    // the route it routed -- a new array each time, the same points.
    for (let k = 0; k < 5; k++) {
      for (const id of ['HV1', 'HV2']) {
        const v = lineView(id)!;
        publishEdge(id, v.base.map(p => ({ ...p })), id === 'HV1' ? feed1().info : feed2().info);
      }
      await settled();
    }
    expect([...w.calls.values(), ...r.calls.values()]).toEqual([0, 0, 0, 0]);
    // Not so much as worked out again.
    expect(passes()).toBe(ran);
    expect(['HV1', 'HV2'].map(lineView)).toEqual(views);
    ['HV1', 'HV2'].forEach((id, i) => expect(lineView(id)).toBe(views[i]));
    for (const [id, pts] of drawnCorners()) if (table.has(id)) expect(pts).toBe(table.get(id));
    w.stop();
    r.stop();
  });

  it('works from the routes lines published, never from where it drew them', async () => {
    publish('HV1', feed1());
    publish('HV2', feed2());
    await settled();
    const moved = lineView('HV2')!.pts;
    expect(moved).not.toBe(lineView('HV2')!.base);
    // Its base is still the route it routed, not the one drawn.
    expect(lineView('HV2')!.base.map(p => p.x)).toEqual([63, 180, 180, 297]);
  });
});

describe('the order lines are drawn in', () => {
  const lines = {
    A1: routed(R(63, 30), L(297, 150)),
    A2: routed(R(63, 110), L(297, 230)),
    A3: routed(R(63, 190), L(297, 310)),
    V: { pts: [P(120, 0), P(120, 400)] },
  };
  const ids = Object.keys(lines) as (keyof typeof lines)[];

  async function drawIn(order: (keyof typeof lines)[], readBetween: boolean) {
    for (const id of order) {
      publish(id, lines[id]);
      // A line rendering before the rest have published reads the store then.
      if (readBetween) lineView(id);
    }
    await settled();
    const out = new Map(ids.map(id => [id, lineView(id)!.pts.map(p => ({ ...p }))]));
    for (const id of ids) unpublishEdge(id);
    await settled();
    return out;
  }

  it('changes nothing about where they end up', async () => {
    const first = await drawIn(['A1', 'A2', 'A3', 'V'], false);
    expect(first.get('A2')![1].x).not.toBe(180);
    expect(await drawIn(['V', 'A3', 'A2', 'A1'], true)).toEqual(first);
    expect(await drawIn(['A2', 'V', 'A1', 'A3'], true)).toEqual(first);
  });

  it('is caught up with by anything that asks before the lines are told', () => {
    publish('HV1', feed1());
    publish('HV2', feed2());
    // No microtask yet: the table is worked out when read.
    expect(drawnCorners().get('HV2')![1].x).toBe(170);
    expect(lineView('HV2')!.pts[1].x).toBe(170);
  });
});

describe('the hooks', () => {
  it('useLineView is nothing before the line has published, and its view after', () => {
    expect(rt.render(() => useLineView('Q'))).toBeNull();
    publish('Q', feed1());
    expect(rt.render(() => useLineView('Q'))!.pts).toEqual(feed1().pts);
  });

  it('useDrawnRoutes keeps one map until one of its lines is drawn somewhere new', () => {
    publish('HV2', feed2());
    const first = rt.render(() => useDrawnRoutes(['HV2']));
    expect(first.get('HV2')![1].x).toBe(180);
    publish('X', { pts: [P(5000, 0), P(5000, 10)] });
    expect(rt.render(() => useDrawnRoutes(['HV2']))).toBe(first);
    // A line it knows nothing of moves it: a new map.
    publish('HV1', feed1());
    const second = rt.render(() => useDrawnRoutes(['HV2']));
    expect(second).not.toBe(first);
    expect(second.get('HV2')![1].x).toBe(170);
  });
});
