// Lines drawn on top of each other are drawn a grid step apart (tracks.ts).
//
// Each line here is routed as the canvas routes it, from ends placed where
// React Flow measures a port (a 6 px handle centred on the symbol's edge, so
// 3 px out), and the lines are then separated together. What is pinned is
// what a reader sees: no two lines along each other, no two turning at one
// point, a line moved only in its middle and never into a symbol, and the
// same drawing whatever order the lines arrived in.
import { describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
// junctions.ts first, as the designer loads it: it reaches tracks.ts (through
// attach.ts and edgeGeometry.ts) before its own constants are set, so
// anything tracks.ts works out from them when it loads comes out wrong here.
import { J_END, isJunction, junctionEnd } from './junctions';
import type { EndLookup, Face } from './junctions';
import { APART, dotReach, drawnAfter, drawnScene, separate, trackLineOf } from './tracks';
import { GRID } from './route';
import type { TrackLine } from './tracks';
import { STUB, pathPoints, routeOrthogonal, segmentEntersBox, simplifyPoints } from './route';
import type { Box, End, Pt } from './route';
import { crossingsOf } from './hops';
import { routeAuto } from './routeGrid';

const P = (x: number, y: number): Pt => ({ x, y });
const SIDE = { l: Position.Left, r: Position.Right, t: Position.Top, b: Position.Bottom } as const;

/** A port of a `w` x `h` symbol at (x, y), `along` its side from the side's start. */
function port(x: number, y: number, s: keyof typeof SIDE, along?: number, w = 60, h = 60, extra: Partial<End> = {}): End {
  const at = along ?? (s === 'l' || s === 'r' ? h / 2 : w / 2);
  switch (s) {
    case 'l': return { x: x - 3, y: y + at, side: SIDE.l, ...extra };
    case 'r': return { x: x + w + 3, y: y + at, side: SIDE.r, ...extra };
    case 't': return { x: x + at, y: y - 3, side: SIDE.t, ...extra };
    default: return { x: x + at, y: y + h + 3, side: SIDE.b, ...extra };
  }
}

/** A line that routes itself, as the canvas routes it. */
const line = (id: string, a: End, b: End, free = true): TrackLine =>
  ({ id, a, b, free, pts: pathPoints(routeOrthogonal(a, b).d) });

// ── What a reader sees ──────────────────────────────────────────────────────
const EPS = 1e-6;
const segs = (pts: Pt[]) => pts.slice(0, -1).map((p, i) => [p, pts[i + 1]] as const);
const isH = (p: Pt, q: Pt) => Math.abs(p.y - q.y) < EPS && Math.abs(p.x - q.x) > EPS;
const isV = (p: Pt, q: Pt) => Math.abs(p.x - q.x) < EPS && Math.abs(p.y - q.y) > EPS;

/** Length two different lines are drawn along each other, anywhere. */
function overlap(drawn: Map<string, Pt[]>): number {
  const ids = [...drawn.keys()];
  let total = 0;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    for (const [p1, p2] of segs(drawn.get(ids[i])!)) for (const [q1, q2] of segs(drawn.get(ids[j])!)) {
      if (isH(p1, p2) && isH(q1, q2) && Math.abs(p1.y - q1.y) < EPS) {
        total += Math.max(0, Math.min(Math.max(p1.x, p2.x), Math.max(q1.x, q2.x)) - Math.max(Math.min(p1.x, p2.x), Math.min(q1.x, q2.x)));
      } else if (isV(p1, p2) && isV(q1, q2) && Math.abs(p1.x - q1.x) < EPS) {
        total += Math.max(0, Math.min(Math.max(p1.y, p2.y), Math.max(q1.y, q2.y)) - Math.max(Math.min(p1.y, p2.y), Math.min(q1.y, q2.y)));
      }
    }
  }
  return total;
}

/** Interior corners two different lines both turn at. */
function sharedCorners(drawn: Map<string, Pt[]>): number {
  const ids = [...drawn.keys()];
  let n = 0;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const q = drawn.get(ids[j])!.slice(1, -1);
    for (const c of drawn.get(ids[i])!.slice(1, -1)) if (q.some(d => Math.abs(c.x - d.x) < EPS && Math.abs(c.y - d.y) < EPS)) n++;
  }
  return n;
}

/** Two lines on one line, end to end nearer than half a grid step: a joint to the eye. */
function endToEnd(drawn: Map<string, Pt[]>): number {
  const ids = [...drawn.keys()];
  let n = 0;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    for (const [p1, p2] of segs(drawn.get(ids[i])!)) for (const [q1, q2] of segs(drawn.get(ids[j])!)) {
      const h = isH(p1, p2) && isH(q1, q2) && Math.abs(p1.y - q1.y) < EPS;
      const v = isV(p1, p2) && isV(q1, q2) && Math.abs(p1.x - q1.x) < EPS;
      if (!h && !v) continue;
      const k = h ? 'x' : 'y';
      const gap = Math.max(Math.min(p1[k], p2[k]), Math.min(q1[k], q2[k])) - Math.min(Math.max(p1[k], p2[k]), Math.max(q1[k], q2[k]));
      if (gap >= 0 && gap < APART) n++;
    }
  }
  return n;
}

function hops(drawn: Map<string, Pt[]>): number {
  let n = 0;
  for (const [id, pts] of drawn) n += crossingsOf(pts, [...drawn].filter(([k]) => k !== id).map(([, v]) => v)).length;
  return n;
}

/** What a moved line must still be: the same ends, the same turns, its legs out of the ports no shorter than their stubs. */
function sameShape(l: TrackLine, drawn: Pt[]): string | null {
  const p = simplifyPoints(l.pts);
  if (drawn.length !== p.length) return `${p.length} corners became ${drawn.length}`;
  const at = (u: Pt, v: Pt) => u.x === v.x && u.y === v.y;
  if (!at(drawn[0], p[0]) || !at(drawn[drawn.length - 1], p[p.length - 1])) return 'an end moved';
  const way = (u: Pt, v: Pt) => `${Math.sign(Math.round(v.x - u.x))},${Math.sign(Math.round(v.y - u.y))}`;
  for (let i = 0; i + 1 < p.length; i++) if (way(drawn[i], drawn[i + 1]) !== way(p[i], p[i + 1])) return `segment ${i} turned round`;
  const len = (u: Pt, v: Pt) => Math.abs(u.x - v.x) + Math.abs(u.y - v.y);
  const n = p.length - 1;
  if (len(drawn[0], drawn[1]) < Math.min(l.a?.stub ?? STUB, len(p[0], p[1])) - EPS) return 'the leg out of its start is short of its stub';
  if (len(drawn[n - 1], drawn[n]) < Math.min(l.b?.stub ?? STUB, len(p[n - 1], p[n])) - EPS) return 'the leg into its end is short of its stub';
  return null;
}

const draw = (lines: TrackLine[], sheet?: Box[]) => separate(lines, sheet);

// ── Between two columns ────────────────────────────────────────────────────

describe('parallel lines between two columns', () => {
  // A column of two valves on the left, a column of two on the right placed
  // lower: each line alone is a Z with its crossbar at the midpoint, x = 180.
  const feeds = (drop: number) => [
    line('HV1-SV1', port(0, 0, 'r'), port(300, drop, 'l')),
    line('HV2-SV2', port(0, 100, 'r'), port(300, 100 + drop, 'l')),
  ];

  it('are not drawn on top of each other when each drops further than they are apart', () => {
    const lines = feeds(120);
    expect(overlap(new Map(lines.map(l => [l.id, l.pts])))).toBe(20);
    const drawn = draw(lines);
    expect(overlap(drawn)).toBe(0);
    expect(hops(drawn)).toBe(0);
    // One of them keeps its route (the very array it came with), the other
    // turns a grid step earlier: a staircase.
    expect(drawn.get('HV1-SV1')).toBe(lines[0].pts);
    expect(drawn.get('HV2-SV2')!.map(p => p.x)).toEqual([63, 170, 170, 297]);
  });

  it('do not share a corner, nor meet end to end, when each drops exactly as far as they are apart', () => {
    const lines = feeds(100);
    const before = new Map(lines.map(l => [l.id, l.pts]));
    expect(sharedCorners(before)).toBe(1);
    const drawn = draw(lines);
    expect(sharedCorners(drawn)).toBe(0);
    expect(overlap(drawn)).toBe(0);
    // Turned one step early, the second line's first leg stops a grid step
    // short of the first line's last: two lines, not a four-way cross.
    expect(endToEnd(drawn)).toBe(0);
    expect(hops(drawn)).toBe(0);
  });

  it('step down one after another, the one whose near end is further along turning first', () => {
    const lines = [
      line('A1-B1', port(0, 0, 'r'), port(300, 120, 'l')),
      line('A2-B2', port(0, 80, 'r'), port(300, 200, 'l')),
      line('A3-B3', port(0, 160, 'r'), port(300, 280, 'l')),
    ];
    const drawn = draw(lines);
    expect(overlap(drawn)).toBe(0);
    expect(hops(drawn)).toBe(0);
    const bars = lines.map(l => drawn.get(l.id)![1].x);
    expect(bars).toEqual([180, 170, 160]);
  });

  it('the same, for crossbars across: tank bottoms to valve tops further along', () => {
    const lines = [
      line('T1-V1', port(0, 0, 'b', 30, 60, 100), port(120, 300, 't')),
      line('T2-V2', port(100, 0, 'b', 30, 60, 100), port(220, 300, 't')),
    ];
    const drawn = draw(lines);
    expect(overlap(drawn)).toBe(0);
    expect(hops(drawn)).toBe(0);
  });
});

// ── Out of one side of one symbol ─────────────────────────────────────────

describe('lines leaving the same side of one symbol', () => {
  // A tank's lid at y = 297, ports at x = 420 and 440; a vent valve beside
  // the tank, a relief valve further out.
  const lid = () => [
    line('T.t-VV', port(400, 300, 't', 20, 60, 100), port(240, 310, 'r')),
    line('T.t2-RV', port(400, 300, 't', 40, 60, 100), port(140, 330, 'r')),
  ];

  it('nest: the line from the port further back goes further out, over the other\'s stub, not across it', () => {
    const lines = lid();
    expect(overlap(new Map(lines.map(l => [l.id, l.pts])))).toBe(101);
    const drawn = draw(lines);
    expect(overlap(drawn)).toBe(0);
    expect(hops(drawn)).toBe(0);
    expect(drawn.get('T.t-VV')).toBe(lines[0].pts);
    // Out of the lid 26 px instead of 16: its first leg runs a grid step above the other's.
    expect(drawn.get('T.t2-RV')![1]).toEqual(P(440, 271));
  });

  it('nest the same way whichever line has the lower id', () => {
    const [inner, outer] = lid();
    const lines = [{ ...inner, id: 'z-inner' }, { ...outer, id: 'a-outer' }];
    const drawn = draw(lines);
    expect(overlap(drawn)).toBe(0);
    expect(hops(drawn)).toBe(0);
    expect(drawn.get('z-inner')).toBe(lines[0].pts);
    expect(drawn.get('a-outer')![1]).toEqual(P(440, 271));
  });

  it('three bottom ports to a row of valves below: the inner line keeps its stub, the next goes a step lower', () => {
    const tank = (i: number) => port(200, 0, 'b', 15 * (i + 1), 60, 100);
    const lines = [
      line('T.b-V1', tank(0), port(100, 200, 'l')),
      line('T.b2-V2', tank(1), port(200, 200, 'l')),
      line('T.b3-V3', tank(2), port(300, 200, 'l')),
    ];
    const drawn = draw(lines);
    expect(overlap(drawn)).toBe(0);
    expect(hops(drawn)).toBe(0);
    expect(drawn.get('T.b2-V2')![1]).toEqual(P(230, 129));
  });

  it('a manifold\'s outlets nest the same way', () => {
    const outlet = (i: number) => port(0, 0, 'b', 14 + 26 * i, 118, 26);
    const lines = [0, 1, 2, 3].map(i => line(`M.${i}`, outlet(i), port(-120 + 100 * i, 200, 'l')));
    const drawn = draw(lines);
    expect(overlap(drawn)).toBe(0);
    expect(hops(drawn)).toBe(0);
  });

  it('a pair that has to cross once is drawn with one hop, not along each other', () => {
    // Two bottom ports going up-left to a column: the port further along the
    // tank feeds the valve further up, so the two cannot nest at both ends.
    const lines = [
      line('T.b-A', port(300, 0, 'b', 20, 60, 100), port(100, 20, 'r')),
      line('T.b2-B', port(300, 0, 'b', 40, 60, 100), port(100, -60, 'r')),
    ];
    expect(overlap(new Map(lines.map(l => [l.id, l.pts])))).toBe(210);
    const drawn = draw(lines);
    expect(overlap(drawn)).toBe(0);
    expect(hops(drawn)).toBe(1);
  });
});

// ── Tees ───────────────────────────────────────────────────────────────────

describe('branches off tees on one header', () => {
  it('fan out in a staircase instead of sharing one crossbar', () => {
    // Tees at y = 150, 190, 230 on a header at x = 30, their branches
    // leaving the right-hand face for a column of valves on a 100 px pitch.
    const tee = (y: number): End => ({ ...junctionEnd(P(25, y - 5), 'r'), ...J_END });
    const header: TrackLine = { id: 'hdr', pts: [P(30, 103), P(30, 327)] };
    const lines = [
      header,
      line('t1-V1', tee(150), port(200, 160, 'l')),
      line('t2-V2', tee(190), port(200, 260, 'l')),
      line('t3-V3', tee(230), port(200, 360, 'l')),
    ];
    const drawn = draw(lines);
    expect(overlap(drawn)).toBe(0);
    expect(sharedCorners(drawn)).toBe(0);
    expect(hops(drawn)).toBe(0);
    // A branch's leg out of its tee is never shorter than the tee's own stub.
    for (const l of lines.slice(1)) expect(sameShape(l, drawn.get(l.id)!)).toBeNull();
  });

  it('are moved off by a feed whose crossbar fell on a branch\'s first leg, whichever is placed first', () => {
    // A tee at (200, 100) on a header; its branch leaves the bottom face and
    // runs down x = 200 to a Z's crossbar halfway to a valve's top. A feed
    // between two valves has its own crossbar down x = 200 in the middle of
    // that leg. The branch cannot move a leg out of its tee; the feed moves.
    const tee: End = { ...junctionEnd(P(195, 95), 'b'), ...J_END };
    const header: TrackLine = { id: 'hdr', pts: [P(63, 100), P(192, 100)] };
    const feed = line('feed', port(0, 120, 'r'), port(340, 220, 'l'));
    const branch = line('branch', tee, port(300, 430, 't'));
    expect(feed.pts[1].x).toBe(200);
    expect(branch.pts.slice(0, 2)).toEqual([P(200, 108), P(200, 267.5)]);
    for (const [f, b] of [['a-feed', 'b-branch'], ['b-feed', 'a-branch']]) {
      const lines = [header, { ...feed, id: f }, { ...branch, id: b }];
      const drawn = draw(lines);
      expect(overlap(drawn), `${f} and ${b}`).toBe(0);
      expect(drawn.get(f), `${f} and ${b}`).not.toBe(lines[1].pts);
      expect(sameShape(lines[1], drawn.get(f)!), `${f} and ${b}`).toBeNull();
    }
  });
});

// ── What never moves, and how far anything may ─────────────────────────────

describe('what may move', () => {
  const two = (): TrackLine[] => [
    line('HV1-SV1', port(0, 0, 'r'), port(300, 120, 'l')),
    line('HV2-SV2', port(0, 100, 'r'), port(300, 220, 'l')),
  ];

  it('a line with corners of its own, or a pipe\'s, is drawn as it is, and the line beside it moves instead', () => {
    const [a, b] = two();
    // The one that would have moved is a person's: now the other one does.
    const drawn = draw([a, { ...b, free: false }]);
    expect(drawn.get(b.id)).toBe(b.pts);
    expect(drawn.get(a.id)).not.toBe(a.pts);
    expect(overlap(drawn)).toBe(0);
  });

  it('two lines neither of which may move stay where they are, on top of each other', () => {
    const [a, b] = two();
    const drawn = draw([{ ...a, free: false }, { ...b, free: false }]);
    expect(drawn.get(a.id)).toBe(a.pts);
    expect(drawn.get(b.id)).toBe(b.pts);
  });

  it('a line without its ends is never moved', () => {
    const [a, b] = two();
    const drawn = draw([a, { id: b.id, pts: b.pts, free: true }]);
    expect(drawn.get(b.id)).toBe(b.pts);
    expect(overlap(drawn)).toBe(0);
  });

  it('a straight line or an L has no middle to move, and is drawn as routed', () => {
    const lines = [
      line('straight', port(0, 0, 'r'), port(300, 0, 'l')),
      line('L', port(100, -100, 'b'), port(300, 100, 'l')),
      line('Z', port(0, 30, 'r'), port(300, 0, 'l')),
    ];
    const drawn = draw(lines);
    expect(drawn.get('straight')).toBe(lines[0].pts);
    expect(drawn.get('L')).toBe(lines[1].pts);
  });

  it('never moves a crossbar out of the gap between the two stubs, even to clear another line', () => {
    // Ports 43 px apart: the crossbar may sit anywhere from 16 px out of one
    // to 16 px short of the other -- eleven pixels, less than a grid step.
    const lines = [
      line('a', port(0, 0, 'r'), port(106, 100, 'l')),
      line('b', port(0, 60, 'r'), port(106, 160, 'l')),
    ];
    const drawn = draw(lines);
    for (const l of lines) {
      expect(drawn.get(l.id)).toBe(l.pts);
      expect(sameShape(l, drawn.get(l.id)!)).toBeNull();
    }
  });

  it('keeps out of a symbol, moving the other way or not at all', () => {
    // The step that clears the other line most cheaply, to x = 170, would
    // run through a valve standing there.
    const valve: Box = { x: 150, y: 180, w: 30, h: 60 };
    const drawn = draw(two(), [valve]);
    expect(overlap(drawn)).toBe(0);
    for (const pts of drawn.values()) {
      expect(segs(pts).some(([p, q]) => segmentEntersBox(p, q, valve, 1))).toBe(false);
    }
  });

  it('places a line afresh when what is near it changes, though the line has not', () => {
    const [a, b] = two();
    expect(draw([a, b]).get(b.id)![1].x).toBe(170);
    // The same two lines, and a person's line down x = 170 between the
    // two, clear of both as they were routed: only the step there meets it.
    const wall: TrackLine = { id: 'wall', pts: [P(170, 160), P(170, 220)] };
    const moved = draw([a, b, wall]).get(b.id)!;
    expect(moved[1].x).not.toBe(170);
    expect(overlap(new Map([[b.id, moved], ['wall', wall.pts]]))).toBe(0);
  });

  it('takes lines a few pixels apart for one line, and moves them apart', () => {
    // A crossbar at x = 183 beside one at 180: three pixels apart reads as one line.
    const lines = [
      line('HV1-SV1', port(0, 0, 'r'), port(300, 120, 'l')),
      line('HV2-SV2', port(0, 100, 'r'), port(306, 220, 'l')),
    ];
    expect(lines[1].pts[1].x).toBe(183);
    const drawn = draw(lines);
    const bars = [...drawn.values()].map(p => p[1].x);
    expect(Math.abs(bars[0] - bars[1])).toBeGreaterThanOrEqual(APART);
  });

  it('never moves a line\'s ends, though moving one would clear another line', () => {
    // A long first leg with a person's line lying on the middle of it, out
    // of reach of anything the crossbar can do.
    const long = line('HV2-SV2', port(0, 100, 'r'), port(620, 220, 'l'));
    const lying: TrackLine = { id: 'W', pts: [P(150, 130), P(250, 130)] };
    const drawn = draw([long, lying]);
    expect(drawn.get(long.id)).toBe(long.pts);
  });

  it('never turns a leg round, though that would clear another line', () => {
    // Out 16, down 50, across 10, down 50, out: the short leg across is a
    // grid step, and a person's line lies on the leg after it.
    const a = port(0, -30, 'r'), b = port(103, 70, 'l');
    const stepped: TrackLine = {
      id: 'S', a, b, free: true, pts: [P(63, 0), P(79, 0), P(79, 50), P(89, 50), P(89, 100), P(100, 100)],
    };
    const lying: TrackLine = { id: 'W', pts: [P(89, 40), P(89, 110)] };
    const drawn = draw([stepped, lying]).get('S')!;
    expect(sameShape(stepped, drawn)).toBeNull();
  });

  it('never makes a leg between two corners shorter than a grid step', () => {
    // Out 16, down 50, across 15, down 50, out 16: moving the last leg down
    // off the line lying on it would leave the leg across five pixels long.
    const a = port(0, -30, 'r'), b = port(113, 70, 'l');
    const stepped: TrackLine = {
      id: 'S', a, b, free: true, pts: [P(63, 0), P(79, 0), P(79, 50), P(94, 50), P(94, 100), P(110, 100)],
    };
    const lying: TrackLine = { id: 'W', pts: [P(94, 40), P(94, 110)] };
    const drawn = draw([stepped, lying]).get('S')!;
    for (let i = 1; i + 2 < drawn.length; i++) {
      expect(Math.abs(drawn[i + 1].x - drawn[i].x) + Math.abs(drawn[i + 1].y - drawn[i].y)).toBeGreaterThanOrEqual(GRID);
    }
  });

  it('leaves a line that only crosses others where it is: a hop is not a fault', () => {
    // A short line of a person's across the second feed's first leg, a few
    // pixels before its crossbar: turning a step earlier would miss it.
    const [a, b] = two();
    const across: TrackLine = { id: 'X', pts: [P(175, 120), P(175, 140)] };
    const drawn = draw([b, across]);
    expect(drawn.get(b.id)).toBe(b.pts);
    void a;
  });

  it('places a line with no room to move first, so the one beside it gives way', () => {
    // B's ports are 34 px apart: its crossbar may sit only between x = 179
    // and 181, so it cannot move a grid step. A, lower in the order, lies
    // along the middle of it, clear of B's stubs.
    const B = line('b', port(100, 100, 'r'), port(200, 220, 'l'));
    const A = line('a', port(0, 130, 'r'), port(300, 190, 'l'));
    expect(B.pts[1].x).toBe(180);
    expect(A.pts[1].x).toBe(180);
    const drawn = draw([A, B]);
    expect(drawn.get('b')).toBe(B.pts);
    expect(overlap(drawn)).toBe(0);
  });

  it('moves a segment by whole grid steps, and no further than three', () => {
    const lines = two();
    const drawn = draw(lines);
    const moved = drawn.get('HV2-SV2')!;
    const dx = moved[1].x - lines[1].pts[1].x;
    expect(Math.abs(dx) % GRID).toBe(0);
    expect(Math.abs(dx)).toBeLessThanOrEqual(3 * GRID);
  });
});

// ── Always the same answer ─────────────────────────────────────────────────

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** A bay of symbols on a lattice, joined port to port at random, each line routed round the symbols as the canvas routes it. */
function bay(seed: number): { lines: TrackLine[]; boxes: Box[] } {
  const r = rng(seed);
  const ports: Record<string, (keyof typeof SIDE)[]> = { V: ['l', 'r'], R: ['l', 'r', 't'], T: ['t', 'b'] };
  const syms: { id: string; kind: string; x: number; y: number; h: number }[] = [];
  const cols = 3 + Math.floor(r() * 3), rows = 3 + Math.floor(r() * 3);
  for (let c = 0; c < cols; c++) for (let k = 0; k < rows; k++) {
    if (r() < 0.2) continue;
    const kind = ['V', 'V', 'R', 'T'][Math.floor(r() * 4)];
    syms.push({ id: `N${c}_${k}`, kind, x: c * 200 + Math.round(r() * 4) * 10, y: k * 160 + Math.round(r() * 4) * 10, h: kind === 'T' ? 100 : 60 });
  }
  const boxes = syms.map(s => ({ x: s.x, y: s.y, w: 60, h: s.h }));
  const used = new Set<string>();
  const lines: TrackLine[] = [];
  for (let k = 0; k < syms.length * 1.2; k++) {
    const a = syms[Math.floor(r() * syms.length)], b = syms[Math.floor(r() * syms.length)];
    if (a === b) continue;
    const pa = ports[a.kind][Math.floor(r() * ports[a.kind].length)], pb = ports[b.kind][Math.floor(r() * ports[b.kind].length)];
    if (used.has(a.id + pa) || used.has(b.id + pb)) continue;
    used.add(a.id + pa); used.add(b.id + pb);
    const ea = port(a.x, a.y, pa, undefined, 60, a.h), eb = port(b.x, b.y, pb, undefined, 60, b.h);
    lines.push({ id: `${a.id}.${pa}-${b.id}.${pb}`, a: ea, b: eb, free: true, pts: pathPoints(routeAuto(ea, eb, boxes).d) });
  }
  return { lines, boxes };
}

function shuffled<T>(xs: T[], r: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const entered = (pts: Pt[], boxes: Box[]) => boxes.filter(bx => {
  const inside = (p: Pt) => p.x > bx.x + 1 && p.x < bx.x + bx.w - 1 && p.y > bx.y + 1 && p.y < bx.y + bx.h - 1;
  return !inside(pts[0]) && !inside(pts[pts.length - 1]) && segs(pts).some(([p, q]) => segmentEntersBox(p, q, bx, 1));
}).length;

describe('over a hundred random bays', () => {
  it('draws the same whatever order the lines came in, moves only middles, never into a symbol, and leaves less lying on less', () => {
    let before = 0, after = 0, moved = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const { lines, boxes } = bay(seed);
      const drawn = draw(lines, boxes);
      const again = draw(shuffled(lines, rng(seed + 7)), boxes);
      before += overlap(new Map(lines.map(l => [l.id, l.pts])));
      after += overlap(drawn);
      for (const l of lines) {
        const d = drawn.get(l.id)!;
        expect(again.get(l.id)).toEqual(d);
        if (d === l.pts) continue;
        moved++;
        expect(sameShape(l, d), `seed ${seed} ${l.id}`).toBeNull();
        expect(entered(d, boxes)).toBeLessThanOrEqual(entered(l.pts, boxes));
      }
    }
    expect(moved).toBeGreaterThan(50);
    expect(after).toBeLessThan(before / 50);
  });

  it('draws the same drawing twice as the same arrays: a line moved once is moved to the same place', () => {
    const { lines, boxes } = bay(3);
    const first = draw(lines, boxes), second = draw(lines, boxes);
    for (const l of lines) expect(second.get(l.id)).toEqual(first.get(l.id));
  });
});

// ── A whole drawing ────────────────────────────────────────────────────────

describe('drawnScene', () => {
  const sym = (id: string, x: number, y: number, page?: string): Node =>
    ({ id, type: 'MAN', position: { x, y }, measured: { width: 60, height: 60 }, data: { componentType: 'MAN', label: id, ...(page ? { page } : {}) } });
  // As the designer measures a port: where the handle is and which way it
  // faces, a tee's face included -- what a tee's end is, the drawing adds.
  const endOf: EndLookup = (node, handle) => {
    if (!isJunction(node)) return port(node.position.x, node.position.y, handle as keyof typeof SIDE);
    if (!handle) return null;
    const { x, y, side } = junctionEnd(node.position, handle as Face);
    return { x, y, side };
  };
  const edge = (s: string, t: string, data: Record<string, unknown> = {}): Edge =>
    ({ id: `${s}-${t}`, source: s, sourceHandle: 'r', target: t, targetHandle: 'l', data });

  it('separates the lines of a page', () => {
    const nodes = [sym('HV1', 0, 0), sym('HV2', 0, 100), sym('SV1', 300, 120), sym('SV2', 300, 220)];
    const drawn = drawnScene(nodes, [edge('HV1', 'SV1'), edge('HV2', 'SV2')], endOf);
    expect(overlap(drawn)).toBe(0);
  });

  it('leaves a line with corners of its own where they are', () => {
    const nodes = [sym('HV1', 0, 0), sym('HV2', 0, 100), sym('SV1', 300, 120), sym('SV2', 300, 220)];
    const hand = edge('HV2', 'SV2', { waypoints: [P(180, 130), P(180, 250)] });
    const drawn = drawnScene(nodes, [edge('HV1', 'SV1'), hand], endOf);
    expect(drawn.get('HV2-SV2')!.map(p => p.x)).toEqual([63, 180, 180, 297]);
    expect(overlap(drawn)).toBe(0);
  });

  it('gives a tee\'s end a tee\'s stub: branches off tees near a valve column step down as far as the tees allow', () => {
    // Three free tees on a header at x = 30, their branches leaving the
    // right-hand face for valves only 60 px across: alone, each crossbar is at
    // x = 67.5, and the third can step down only because a tee's stub is six
    // pixels, not a symbol's sixteen.
    const tee = (id: string, y: number): Node =>
      ({ id, type: 'JUNCTION', position: { x: 25, y: y - 5 }, data: { componentType: 'JUNCTION' } });
    const nodes = [tee('t1', 150), tee('t2', 190), tee('t3', 230), sym('V1', 100, 160), sym('V2', 100, 260), sym('V3', 100, 360)];
    const branch = (t: string, v: string): Edge => ({ id: `${t}-${v}`, source: t, sourceHandle: 'r', target: v, targetHandle: 'l', data: {} });
    const drawn = drawnScene(nodes, [branch('t1', 'V1'), branch('t2', 'V2'), branch('t3', 'V3')], endOf);
    expect(overlap(drawn)).toBe(0);
    expect(hops(drawn)).toBe(0);
    expect([...drawn.values()].map(p => p[1].x).sort((u, v) => u - v)).toEqual([47.5, 57.5, 67.5]);
  });

  it('does not move a line for one on another page, which shares the plane but not the sheet', () => {
    const nodes = [sym('HV1', 0, 0), sym('HV2', 0, 100, 'GSE'), sym('SV1', 300, 120), sym('SV2', 300, 220, 'GSE')];
    const drawn = drawnScene(nodes, [edge('HV1', 'SV1'), edge('HV2', 'SV2')], endOf);
    expect(drawn.get('HV1-SV1')![1].x).toBe(180);
    expect(drawn.get('HV2-SV2')![1].x).toBe(180);
  });

  it('keeps a line it moves out of what it is told is on the page, and out of the page\'s symbols when not told', () => {
    // A narrow symbol standing where the second line's crossbar would step
    // to, x = 170, and clear of both lines as they route themselves.
    const X: Node = { ...sym('X', 150, 180), measured: { width: 25, height: 60 } };
    const x: Box = { x: 150, y: 180, w: 25, h: 60 };
    const nodes = [sym('HV1', 0, 0), sym('HV2', 0, 100), sym('SV1', 300, 120), sym('SV2', 300, 220), X];
    const edges = [edge('HV1', 'SV1'), edge('HV2', 'SV2')];
    const enters = (d: Map<string, Pt[]>) => [...d.values()].some(pts => segs(pts).some(([p, q]) => segmentEntersBox(p, q, x, 1)));
    const told = drawnScene(nodes, edges, endOf, [x]);
    expect(overlap(told)).toBe(0);
    expect(enters(told)).toBe(false);
    expect(drawnScene(nodes, edges, endOf)).toEqual(told);
    expect(drawnScene(nodes, edges, endOf, page => (page === 'Main' ? [x] : []))).toEqual(told);
    // Told there is nothing there, it steps where it would with nothing there.
    const bare = drawnScene(nodes, edges, endOf, []);
    expect(bare.get('HV2-SV2')!.map(p => p.x)).toEqual([63, 170, 170, 297]);
    expect(enters(bare)).toBe(true);
  });
});

// ── Dots ────────────────────────────────────────────────────────────────────

describe('a tee\'s dot, or an open end\'s', () => {
  /** A tee's face, as the canvas gives a line's end on it: where the face is, and a tee's routing. */
  const face = (cx: number, cy: number, f: Face, dx = 0, dy = 0): End =>
    ({ ...junctionEnd({ x: cx - 5 + dx, y: cy - 5 + dy }, f), ...J_END });
  /** A header from far left to far right with a tee riding it at (cx, cy): its two halves, a pipe's, which never move. */
  const header = (cx: number, cy: number, dx = 0): TrackLine[] => [
    { id: 'A-t', a: port(-200, cy - 30, 'r'), b: face(cx, cy, 'l', dx), pts: [P(-137, cy), P(cx - 8 + dx, cy)], free: false },
    { id: 't-B', a: face(cx, cy, 'r'), b: port(500, cy - 30, 'l'), pts: [P(cx + 8, cy), P(497, cy)], free: false },
  ];
  /** How near a line passes the centre of the dot at c, anywhere along it. */
  const nearest = (pts: Pt[], c: Pt) => Math.min(...segs(pts).map(([p, q]) => {
    const x = Math.max(Math.min(p.x, q.x), Math.min(Math.max(p.x, q.x), c.x));
    const y = Math.max(Math.min(p.y, q.y), Math.min(Math.max(p.y, q.y), c.y));
    return Math.hypot(x - c.x, y - c.y);
  }));

  it('is never passed through by a line moved off another: two feeds whose crossbars meet over a tee', () => {
    // Alone, each feed's crossbar is at x = 180, ten pixels from the tee at
    // (170, 200); together the second would move a grid step earlier --
    // straight through the gap the header leaves round the dot, crossing
    // nothing, with no hop.
    const feeds = [line('HV1-SV1', port(0, 0, 'r'), port(300, 300, 'l')), line('HV2-SV2', port(0, 100, 'r'), port(300, 400, 'l'))];
    expect(feeds.map(l => l.pts[1].x)).toEqual([180, 180]);
    const drawn = draw([...header(170, 200), ...feeds]);
    for (const f of feeds) expect(nearest(drawn.get(f.id)!, P(170, 200)), f.id).toBeGreaterThanOrEqual(dotReach());
    expect(overlap(drawn)).toBe(0);
    // Each crosses the header where it is hopped, and the hop is clear of the dot.
    for (const f of feeds) {
      const at = crossingsOf(drawn.get(f.id)!, [...drawn].filter(([k]) => k !== f.id).map(([, v]) => v));
      expect(at, f.id).toHaveLength(1);
      expect(Math.abs(at[0].x - 170), f.id).toBeGreaterThanOrEqual(dotReach());
    }
  });

  it('moves a line routed through a dot off it, though nothing else is in its way, and leaves one clear of it', () => {
    // The crossbar's midpoint is the tee's centre.
    const through = line('HV-SV', port(0, 0, 'r'), port(280, 300, 'l'));
    expect(through.pts[1].x).toBe(170);
    const moved = draw([...header(170, 200), through]).get(through.id)!;
    expect(nearest(moved, P(170, 200))).toBeGreaterThanOrEqual(dotReach());
    // A step either way is still ten pixels from the centre: under the dot's hop.
    expect(moved[1].x).toBe(150);
    // Thirteen pixels off, it was clear to begin with.
    const clear = line('HV-SV', port(0, 0, 'r'), port(306, 300, 'l'));
    expect(clear.pts[1].x).toBe(183);
    expect(draw([...header(170, 200), clear]).get(clear.id)).toBe(clear.pts);
  });

  it('the same for an open end: a line is not drawn through the dot at the end of another', () => {
    // A line from a valve ends in an open end at (200, 300), its dot beyond
    // the line's last pixel; a feed's crossbar falls on it.
    const open: TrackLine = { id: 'V-o', a: port(0, 270, 'r'), b: face(200, 300, 'l'), pts: [P(63, 300), P(192, 300)], free: true };
    const feed = line('HV-SV', port(47, 220, 'r'), port(293, 320, 'l'));
    expect(feed.pts[1].x).toBe(200);
    const drawn = draw([open, feed]);
    expect(nearest(drawn.get(feed.id)!, P(200, 300))).toBeGreaterThanOrEqual(dotReach());
  });

  it('places a line afresh when a dot comes near it, though no line near it has moved', () => {
    // A short line ends at (152, 190). Drawn to a symbol's port, it has no
    // dot and the second feed steps back to x = 170 as ever; ended in an
    // open end instead -- the same line, point for point -- its dot is ten
    // pixels from there, and the feed steps the other way.
    const feeds = [line('HV1-SV1', port(0, 0, 'r'), port(300, 120, 'l')), line('HV2-SV2', port(0, 100, 'r'), port(300, 220, 'l'))];
    const stub = (b: End): TrackLine => ({ id: 'Y', a: port(-3, 160, 'r'), b, pts: [P(60, 190), P(152, 190)], free: false });
    const plain = draw([...feeds, stub({ x: 152, y: 190, side: Position.Left })]);
    expect(plain.get('HV2-SV2')!.map(p => p.x)).toEqual([63, 170, 170, 297]);
    const dotted = draw([...feeds, stub(face(160, 190, 'l'))]);
    expect(dotted.get('HV2-SV2')!.map(p => p.x)).toEqual([63, 190, 190, 297]);
  });

  it('is passed by the lines that end on it, and one measured a fraction of a pixel off is the same dot', () => {
    // A branch off the tee's bottom face crosses one short line on its way
    // to a valve. A crossing is not a fault, so it is drawn as routed -- as
    // it would not be if the branch counted its own tee's dot against
    // itself, or took the run's ends, measured a little off, for another
    // tee's: then it would be moved to clear the crossing as well.
    const tee = P(100.5, 100);
    const lines: TrackLine[] = [
      ...header(tee.x, tee.y, -0.4),
      { ...line('t-V', face(tee.x, tee.y, 'b', 0.2), port(220, 300, 't')), free: true },
      { id: 'X', pts: [P(175, 190), P(175, 220)], a: port(145, 127, 'b'), b: port(145, 223, 't'), free: true },
    ];
    const branch = lines.find(l => l.id === 't-V')!;
    expect(branch.pts.map(p => p.y)).toEqual([108, 202.5, 202.5, 297]);
    expect(draw(lines).get('t-V')).toBe(branch.pts);
  });
});

describe('drawnAfter', () => {
  const sym = (id: string, x: number, y: number, page?: string): Node =>
    ({ id, type: 'MAN', position: { x, y }, measured: { width: 60, height: 60 }, data: { componentType: 'MAN', label: id, ...(page ? { page } : {}) } });
  const endOf: EndLookup = (node, handle) => port(node.position.x, node.position.y, handle as keyof typeof SIDE);
  const edge = (s: string, t: string): Edge => ({ id: `${s}-${t}`, source: s, sourceHandle: 'r', target: t, targetHandle: 'l', data: {} });
  const nodes = [sym('HV1', 0, 0), sym('HV2', 0, 100), sym('SV1', 300, 120), sym('SV2', 300, 220)];
  const first = edge('HV1', 'SV1'), second = edge('HV2', 'SV2');
  /** The page as the canvas published it: each line as it routed itself there. */
  const published = (ns: Node[], es: Edge[]) => es.map(e => trackLineOf(e, new Map(ns.map(n => [n.id, n])), endOf, [])!);

  it('draws a new line moved off the lines the page has, as the page will', () => {
    const before = { nodes, edges: [first] };
    const after = { nodes, edges: [first, second] };
    const drawn = drawnAfter(before, after, 'Main', endOf, [], published(nodes, [first]));
    expect(drawn.get(second.id)!.map(p => p.x)).toEqual([63, 170, 170, 297]);
    expect(drawn).toEqual(drawnScene(after.nodes, after.edges, endOf, []));
  });

  it('takes a line the change did not touch as the page published it, not as it would be routed now', () => {
    // The canvas measured HV1's port a pixel lower than the drawing has it:
    // that is where the line is, and where the new one has to keep off.
    const page = published(nodes, [first]).map(l => ({ ...l, pts: l.pts.map(p => ({ x: p.x, y: p.y + 1 })) }));
    const drawn = drawnAfter({ nodes, edges: [first] }, { nodes, edges: [first, second] }, 'Main', endOf, [], page);
    expect(drawn.get(first.id)).toBe(page[0].pts);
  });

  it('routes afresh a line one of whose ends has moved, though the line is the same', () => {
    // SV1 slid down: the line object is the one the drawing had, its end is not.
    const page = published(nodes, [first, second]);
    const slid = nodes.map(n => (n.id === 'SV1' ? sym('SV1', 300, 160) : n));
    const drawn = drawnAfter({ nodes, edges: [first, second] }, { nodes: slid, edges: [first, second] }, 'Main', endOf, [], page);
    expect(drawn.get(first.id)![drawn.get(first.id)!.length - 1]).toEqual(P(297, 190));
    expect(drawn).toEqual(drawnScene(slid, [first, second], endOf, []));
  });

  it('keeps a new line out of what it is told is on the page, and out of the page\'s symbols when not told', () => {
    const X: Node = { ...sym('X', 150, 180), measured: { width: 25, height: 60 } };
    const x: Box = { x: 150, y: 180, w: 25, h: 60 };
    const all = [...nodes, X];
    const before = { nodes: all, edges: [first] }, after = { nodes: all, edges: [first, second] };
    const page = published(all, [first]);
    const told = drawnAfter(before, after, 'Main', endOf, [x], page);
    expect(told.get(second.id)!.map(p => p.x)).not.toEqual([63, 170, 170, 297]);
    expect(drawnAfter(before, after, 'Main', endOf, undefined, page)).toEqual(told);
    expect(drawnAfter(before, after, 'Main', endOf, [], page).get(second.id)!.map(p => p.x)).toEqual([63, 170, 170, 297]);
  });

  it('leaves out a line the change took away, and the lines of other pages', () => {
    const other = [sym('GV1', 0, 100, 'GSE'), sym('GV2', 300, 220, 'GSE')];
    const across = edge('GV1', 'GV2');
    const all = [...nodes, ...other];
    const drawn = drawnAfter({ nodes: all, edges: [first, across] }, { nodes: all, edges: [second, across] }, 'Main', endOf, [], published(all, [first, across]));
    expect([...drawn.keys()]).toEqual([second.id]);
    expect(drawn.get(second.id)!.map(p => p.x)).toEqual([63, 180, 180, 297]);
  });
});
