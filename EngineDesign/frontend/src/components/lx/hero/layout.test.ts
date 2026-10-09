import { describe, expect, it } from 'vitest';
import { STAND_DOC } from './__fixtures__/stand';
import { axisOf, domeLoaders, isLiquidLine, parseDrawing } from './drawing';
import {
  boxOf, boxesMeet, candidates, layoutSchematic, overlapLength, route, routeCost, segmentHitsBox, simplify,
  type Box, type End, type SchematicLayout,
} from './layout';

const d = parseDrawing(STAND_DOC);
const label = (s: { label: string; kind: string }) => (['tank', 'bottle', 'engine', 'regulator', 'solenoid', 'valve'].includes(s.kind)
  ? { w: s.label.length * 6.5, h: s.kind === 'tank' || s.kind === 'bottle' || s.kind === 'engine' ? 28 : 14 } : null);
const lay = (width = 900, maxHeight = 380) => layoutSchematic(d, { width, maxHeight, labelSize: label });

const segments = (L: SchematicLayout) => L.lines.flatMap((l) => l.pts.slice(1).map((q, k) => ({ id: l.line.id, p: l.pts[k], q })));

describe('parseDrawing', () => {
  it('reads the stand: symbols with kinds, plumbing lines only, instruments by their clip', () => {
    expect(d.symbols).toHaveLength(30);
    expect(d.lines).toHaveLength(20);
    expect(d.byId.get('KB1')?.kind).toBe('bottle');
    expect(d.byId.get('PR_D')?.kind).toBe('regulator');
    expect(d.byId.get('MVO')?.kind).toBe('solenoid');
    expect(d.byId.get('TC_OXD')).toMatchObject({ kind: 'instrument', attachedTo: 'MVO' });
    expect(d.byId.get('OXT')?.params.volume).toEqual({ value: 15.1, unit: 'L' });
  });

  it('drops what it cannot place and lines to symbols that are not there', () => {
    const p = parseDrawing({
      nodes: [
        { id: 'a', position: { x: 0, y: 0 }, data: { componentType: 'TANK' } },
        { id: 'b', data: { componentType: 'TANK' } },
        { id: 't', position: { x: 0, y: 0 }, data: { componentType: 'TEXT' } },
        { id: 'pt', position: { x: 0, y: 0 }, data: { componentType: 'PT' } },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b' }, { id: 'e2', source: 'a', target: 'pt' }, { id: 'e3', source: 'a', target: 'a' }],
    });
    expect(p.symbols.map((s) => s.id)).toEqual(['a', 'pt']);
    expect(p.lines).toEqual([]);
  });

  it('knows a tank\'s liquid side from the fluid at the other end', () => {
    const ox = d.byId.get('OXT')!;
    const line = (id: string) => d.lines.find((l) => l.id === id)!;
    expect(isLiquidLine(d, ox, line('l_ox1'))).toBe(true); // to MV-OX, oxygen
    expect(isLiquidLine(d, ox, line('l_oxfill'))).toBe(true); // LOX fill
    expect(isLiquidLine(d, ox, line('l_oxpress'))).toBe(false); // nitrogen press
    expect(isLiquidLine(d, ox, line('l_oxvent'))).toBe(false);
  });

  it('finds the dome loader and each valve\'s axis', () => {
    expect([...domeLoaders(d)]).toEqual([['PR_C', 'PR_D']]);
    expect(axisOf(d, d.byId.get('SV_GN2_VENT')!)).toBe('v');
    expect(axisOf(d, d.byId.get('SV_LOX_PRESS')!)).toBe('h');
    expect(axisOf(d, d.byId.get('MVO')!)).toBe('h');
  });
});

describe('geometry helpers', () => {
  const box: Box = { x0: 10, y0: 10, x1: 20, y1: 20 };
  it('segmentHitsBox: through, beside, and touching an edge only', () => {
    expect(segmentHitsBox({ x: 0, y: 15 }, { x: 30, y: 15 }, box)).toBe(true);
    expect(segmentHitsBox({ x: 0, y: 25 }, { x: 30, y: 25 }, box)).toBe(false);
    expect(segmentHitsBox({ x: 0, y: 15 }, { x: 9, y: 15 }, box)).toBe(false);
    expect(segmentHitsBox({ x: 0, y: 10 }, { x: 30, y: 10 }, box)).toBe(false);
  });
  it('overlapLength: collinear runs only', () => {
    expect(overlapLength({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 1 }, { x: 20, y: 1 })).toBe(5);
    expect(overlapLength({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }, { x: 20, y: 8 })).toBe(0);
    expect(overlapLength({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: -5 }, { x: 5, y: 5 })).toBe(0);
  });
  it('simplify drops repeats and collinear corners', () => {
    expect(simplify([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }]))
      .toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }]);
  });
  it('simplify keeps a point where the route turns straight back', () => {
    const back = [{ x: 0, y: 0 }, { x: 0, y: 12 }, { x: 0, y: -40 }];
    expect(simplify(back)).toEqual(back);
  });
});

describe('route', () => {
  const end = (x: number, y: number, extra: Partial<End> = {}): End => ({ at: { x, y }, box: { x0: x - 5, y0: y - 5, x1: x + 5, y1: y + 5 }, ...extra });

  it('keeps aligned ends straight', () => {
    expect(route(end(0, 0), end(100, 0), [], [])).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  });

  it('goes around a symbol in the way', () => {
    const block: Box = { x0: 40, y0: -10, x1: 60, y1: 10 };
    const pts = route(end(0, 0), end(100, 40), [], [block]);
    for (let k = 0; k + 1 < pts.length; k++) expect(segmentHitsBox(pts[k], pts[k + 1], block)).toBe(false);
  });

  it('leaves a valve along its axis', () => {
    const pts = route(end(0, 0, { axis: 'h' }), end(100, 60), [], []);
    expect(pts[1].y).toBe(0);
  });

  it('takes a port stub first and never doubles back through its own symbol', () => {
    const tank = end(100, 50, { stub: 'up', box: { x0: 87, y0: 50, x1: 113, y1: 110 } });
    const pts = route(end(0, 80, { axis: 'h' }), tank, [], []);
    expect(pts[pts.length - 1]).toEqual({ x: 100, y: 50 });
    expect(pts[pts.length - 2]).toEqual({ x: 100, y: 38 });
    for (let k = 0; k + 2 < pts.length; k++) expect(segmentHitsBox(pts[k], pts[k + 1], tank.box)).toBe(false);
  });

  it('prefers a route off one already drawn', () => {
    const drawn = [{ pts: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: -40 }] }];
    const pts = route(end(0, 0), end(100, 40), drawn, []);
    let overlap = 0;
    for (let k = 0; k + 1 < pts.length; k++) overlap += overlapLength(pts[k], pts[k + 1], drawn[0].pts[0], drawn[0].pts[1]);
    expect(overlap).toBe(0);
  });

  it('every candidate is orthogonal', () => {
    for (const c of candidates(end(0, 0), end(73, 41))) {
      for (let k = 0; k + 1 < c.length; k++) expect(c[k].x === c[k + 1].x || c[k].y === c[k + 1].y).toBe(true);
    }
    expect(routeCost([{ x: 0, y: 0 }, { x: 10, y: 0 }], end(0, 0), end(10, 0), [], [])).toBeCloseTo(0.1);
  });
});

describe('layoutSchematic on the stand', () => {
  const L = lay();

  it('fits the drawing: one scale both ways, nothing flipped', () => {
    const p = (id: string) => L.symbols.get(id)!;
    const sx = (p('ENG').cx - p('KB1').cx) / (950 - 40);
    const sy = (p('FUT').cy - p('OXT').cy) / (400 - 210);
    expect(sx).toBeGreaterThan(0);
    expect(Math.abs(sx - sy)).toBeLessThan(0.01);
    expect(L.width).toBe(900);
    expect(L.height).toBeLessThanOrEqual(380);
  });

  it('routes every plumbing line orthogonally, clear of other symbols', () => {
    expect(L.lines).toHaveLength(20);
    for (const { id, p, q } of segments(L)) {
      expect(p.x === q.x || p.y === q.y, id).toBe(true);
      const line = d.lines.find((l) => l.id === id)!;
      for (const s of L.symbols.values()) {
        if (s.s.id === line.from || s.s.id === line.to) continue;
        expect(segmentHitsBox(p, q, boxOf(s)), `${id} through ${s.s.id}`).toBe(false);
      }
    }
  });

  it('does not run two lines along each other, at any panel width', () => {
    for (const width of [620, 715, 900, 1013]) {
      const segs = segments(lay(width, 360));
      let worst = 0;
      for (const a of segs) for (const b of segs) if (a.id < b.id) worst = Math.max(worst, overlapLength(a.p, a.q, b.p, b.q, 6));
      expect(worst, `at ${width} px`).toBe(0);
    }
  });

  it('never routes a tank\'s line back through the tank', () => {
    for (const l of L.lines) {
      for (const id of [l.line.from, l.line.to]) {
        const s = L.symbols.get(id)!;
        if (s.s.kind !== 'tank') continue;
        const box = boxOf(s, -1);
        const inner = l.pts.slice(1).map((q, k) => [l.pts[k], q] as const);
        // The stub at the tank's own end is the only segment that touches it.
        const crossing = inner.filter(([p, q]) => segmentHitsBox(p, q, box));
        expect(crossing, `${l.line.id} through ${id}`).toHaveLength(0);
      }
    }
  });

  it('names a valve on the side away from the middle of the drawing', () => {
    const N = layoutSchematic(d, { width: 715, maxHeight: 360, labelSize: (s) => (s.id === 'MVO' || s.id === 'MVF' ? { w: 40, h: 14 } : null) });
    expect(N.labels.get('MVO')!.y).toBeLessThan(N.symbols.get('MVO')!.cy);
    expect(N.labels.get('MVF')!.y).toBeGreaterThan(N.symbols.get('MVF')!.cy);
  });

  it('takes a tank\'s gas in its upper half and its liquid in its lower', () => {
    for (const id of ['OXT', 'FUT']) {
      const t = L.symbols.get(id)!;
      for (const l of L.lines) {
        const end = l.line.from === id ? l.pts[0] : l.line.to === id ? l.pts[l.pts.length - 1] : null;
        if (!end) continue;
        if (l.liquid) expect(end.y, `${l.line.id} at ${id}`).toBeGreaterThan(t.cy);
        else expect(end.y, `${l.line.id} at ${id}`).toBeLessThanOrEqual(t.cy + 2);
      }
    }
    // The vent valve is above the LOX tank: through its top.
    const vent = L.lines.find((l) => l.line.id === 'l_oxvent')!.pts;
    expect(vent[0].y).toBe(L.symbols.get('OXT')!.cy - L.symbols.get('OXT')!.h / 2);
  });

  it('runs a tank\'s line to a valve level with its lower half straight across', () => {
    // At 715 px (the 1440 layout) MV-OX sits level with the LOX tank's lower half.
    const ox1 = lay(715, 360).lines.find((l) => l.line.id === 'l_ox1')!;
    expect(ox1.liquid).toBe(true);
    expect(new Set(ox1.pts.map((p) => p.y)).size).toBe(1);
  });

  it('puts labels where they cover no symbol and no other label', () => {
    const labels = [...L.labels.values()];
    expect(labels.length).toBeGreaterThanOrEqual(10);
    for (const a of labels) {
      for (const b of labels) if (a.id < b.id) expect(boxesMeet(a.box, b.box), `${a.id} / ${b.id}`).toBe(false);
      for (const s of L.symbols.values()) if (s.s.id !== a.id) expect(boxesMeet(a.box, boxOf(s)), `${a.id} on ${s.s.id}`).toBe(false);
      expect(a.box.x0).toBeGreaterThanOrEqual(0);
      expect(a.box.x1).toBeLessThanOrEqual(L.width);
    }
  });

  it('puts each instrument by its host and clear of symbols', () => {
    expect(L.tags).toHaveLength(11);
    for (const t of L.tags) {
      const host = L.symbols.get(t.host)!;
      expect(Math.hypot(t.cx - host.cx, t.cy - host.cy)).toBeLessThan(90);
      const b = { x0: t.cx - t.r, y0: t.cy - t.r, x1: t.cx + t.r, y1: t.cy + t.r };
      for (const s of L.symbols.values()) expect(boxesMeet(b, boxOf(s)), `${t.s.id} on ${s.s.id}`).toBe(false);
    }
  });

  it('scales to a narrow panel without losing the fit', () => {
    const N = lay(520, 300);
    expect(N.width).toBe(520);
    expect(N.scale).toBeLessThan(L.scale);
  });
});
