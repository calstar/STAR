import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Position } from '@xyflow/react';
import { perimeterPoint, nearestFraction, defaultPositions, drawnGeometry, ManifoldEditor } from './ManifoldEditor';
import type { ManifoldGeometry } from './ManifoldEditor';
import { ConfigDialog } from './ConfigDialog';
import { manifoldLayout, manifoldShift } from './nodes/ManifoldNode';
import { turnPlacement } from './route';
import type { PIDNodeData } from './types';

describe('a port is a fraction of the way round the block', () => {
  const w = 100, h = 40;

  it('walks clockwise from the top-left', () => {
    const per = 2 * (w + h);
    expect(perimeterPoint(0, w, h)).toMatchObject({ x: 0, y: 0, side: 'top' });
    // Sampled mid-edge, not on a corner: a corner belongs to both sides and
    // which one it reports is a float's business, not a behaviour to pin.
    expect(perimeterPoint((w / 2) / per, w, h).side).toBe('top');
    expect(perimeterPoint((w + h / 2) / per, w, h)).toMatchObject({ x: w, side: 'right' });
    expect(perimeterPoint((w + h + w / 2) / per, w, h).side).toBe('bottom');
    expect(perimeterPoint((2 * w + h + h / 2) / per, w, h)).toMatchObject({ x: 0, side: 'left' });
  });

  it('puts a corner on the block, whichever side it claims', () => {
    const per = 2 * (w + h);
    for (const d of [0, w, w + h, 2 * w + h]) {
      const p = perimeterPoint(d / per, w, h);
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(-1e-6);
      expect(p.x).toBeLessThanOrEqual(w + 1e-6);
      expect(p.y).toBeGreaterThanOrEqual(-1e-6);
      expect(p.y).toBeLessThanOrEqual(h + 1e-6);
    }
  });

  it('wraps rather than running off the end', () => {
    expect(perimeterPoint(1.25, w, h)).toEqual(perimeterPoint(0.25, w, h));
    expect(perimeterPoint(-0.25, w, h)).toEqual(perimeterPoint(0.75, w, h));
  });

  it('survives a resize with the ports still on the block', () => {
    // The reason a fraction is stored rather than an (x, y): halve the block
    // and a port is still a quarter of the way round it, not hanging off.
    const t = 0.3;
    for (const [ww, hh] of [[100, 40], [50, 20], [220, 80]]) {
      const p = perimeterPoint(t, ww, hh);
      expect(p.x).toBeGreaterThanOrEqual(-1e-9);
      expect(p.x).toBeLessThanOrEqual(ww + 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(-1e-9);
      expect(p.y).toBeLessThanOrEqual(hh + 1e-9);
    }
  });
});

describe('dragging a port', () => {
  const w = 100, h = 40;

  it('snaps to the nearest edge, so it never lands inside the block', () => {
    const t = nearestFraction(50, 5, w, h);            // near the top edge
    expect(perimeterPoint(t, w, h).side).toBe('top');
  });

  it('lands on the side the pointer is nearest', () => {
    expect(perimeterPoint(nearestFraction(98, 20, w, h), w, h).side).toBe('right');
    expect(perimeterPoint(nearestFraction(50, 38, w, h), w, h).side).toBe('bottom');
    expect(perimeterPoint(nearestFraction(2, 20, w, h), w, h).side).toBe('left');
  });

  it('clamps a pointer dragged outside the block back onto it', () => {
    const t = nearestFraction(-40, -40, w, h);
    const p = perimeterPoint(t, w, h);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeGreaterThanOrEqual(0);
  });

  it('round-trips: a point on an edge maps back to itself', () => {
    const t = 0.42;
    const p = perimeterPoint(t, w, h);
    expect(nearestFraction(p.x, p.y, w, h)).toBeCloseTo(t, 6);
  });
});

describe('the default layout', () => {
  it('spaces every port evenly, and gives each a distinct place', () => {
    const pos = defaultPositions(['in', 'p', 'p2', 'p3']);
    const values = Object.values(pos);
    expect(new Set(values).size).toBe(4);
    expect(Math.min(...values)).toBeGreaterThan(0);
    expect(Math.max(...values)).toBeLessThan(1);
  });
});

describe('the manifold as drawn', () => {
  it('puts the feed mid-way across the near end and the outlets down the long side', () => {
    const h = manifoldLayout(4, 'horizontal');
    expect({ w: h.width, h: h.height }).toEqual({ w: 118, h: 26 });
    expect(h.ports.in).toEqual({ side: 'left', along: 13 });
    expect(['p', 'p2', 'p3', 'p4'].map(id => h.ports[id])).toEqual(
      [14, 40, 66, 92].map(along => ({ side: 'bottom', along })));

    const v = manifoldLayout(4, 'vertical');
    expect({ w: v.width, h: v.height }).toEqual({ w: 26, h: 118 });
    expect(v.ports.in).toEqual({ side: 'top', along: 13 });
    expect(v.ports.p4).toEqual({ side: 'right', along: 92 });
  });

  it('takes a saved layout over the default', () => {
    const g: ManifoldGeometry = { width: 100, height: 40, positions: { in: 50 / 280, p: (100 + 20) / 280 } };
    const l = manifoldLayout(1, 'horizontal', g);
    expect(l.width).toBe(100);
    expect(l.ports.in.side).toBe('top');
    expect(l.ports.in.along).toBeCloseTo(50, 9);
    expect(l.ports.p.side).toBe('right');
    expect(l.ports.p.along).toBeCloseTo(20, 9);
  });
});

describe('the Geometry editor opens on the manifold as drawn', () => {
  for (const orientation of ['horizontal', 'vertical']) {
    for (const outlets of [1, 4, 7]) {
      it(`${orientation}, ${outlets} outlet(s): saving the opening layout moves nothing`, () => {
        const drawn = manifoldLayout(outlets, orientation);
        const seed = drawnGeometry(outlets, orientation);
        const saved = manifoldLayout(outlets, orientation, seed);
        expect({ w: saved.width, h: saved.height }).toEqual({ w: drawn.width, h: drawn.height });
        for (const [id, port] of Object.entries(drawn.ports)) {
          expect(saved.ports[id].side, id).toBe(port.side);
          expect(Math.abs(saved.ports[id].along - port.along), id).toBeLessThan(1e-9);
        }
      });
    }
  }

  it('hands a saved layout back exactly as it was saved', () => {
    const g: ManifoldGeometry = { width: 118, height: 26, positions: { in: 0.9, p: 0.55, p2: 0.6, p3: 0.65, p4: 0.7 } };
    expect(drawnGeometry(4, 'horizontal', g)).toEqual(g);
  });

  it('puts a port the saved layout does not mention where the drawing puts it', () => {
    const g: ManifoldGeometry = { width: 118, height: 26, positions: { in: 0.9, p: 0.55 } };
    const seeded = drawnGeometry(2, 'horizontal', g);
    expect(seeded.positions).toEqual({ in: 0.9, p: 0.55, p2: defaultPositions(['in', 'p', 'p2']).p2 });
    expect(manifoldLayout(2, 'horizontal', seeded)).toEqual(manifoldLayout(2, 'horizontal', g));
  });

  it('shows "Saved", not a lit "Save layout", when nothing has been moved', () => {
    const html = renderToStaticMarkup(createElement(ManifoldEditor, {
      outlets: 4, orientation: 'vertical', geometry: undefined, ports: {}, onSave: () => {},
    }));
    const button = /<button[^>]*>(Save layout|Saved)<\/button>/.exec(html)!;
    expect(button[1]).toBe('Saved');
    expect(button[0]).toContain('disabled');
    // And the block it shows is the one drawn: 26 wide, 118 long.
    expect(html).toContain('value="26"');
    expect(html).toContain('value="118"');
  });

  it('is not mounted until the dialog holds the manifold it is editing', () => {
    // The dialog fills its fields from the node in an effect, after its first
    // render. An editor mounted on that first render started its draft from
    // nothing, and the draft is only read on mount.
    const data = { componentType: 'MANIFOLD', label: 'MF-1', options: { outlets: '6', orientation: 'vertical' } } as unknown as PIDNodeData;
    const html = renderToStaticMarkup(createElement(ConfigDialog, {
      open: true, kind: 'node', data, readOnly: false, onClose: () => {}, onSave: () => {},
    }));
    expect(html).toContain('MF-1');
    expect(html).not.toContain('viewBox="0 0 260 190"');
  });
});

describe('a turned manifold given more or fewer outlets', () => {
  /** Every port's flow position for a manifold whose top-left is at `at`. */
  function portsAt(at: { x: number; y: number }, rotation: number, options: Record<string, string>) {
    const outlets = Number(options.outlets);
    const l = manifoldLayout(outlets, options.orientation);
    const quarter = rotation % 180 === 90;
    const bw = quarter ? l.height : l.width, bh = quarter ? l.width : l.height;
    const side = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };
    const out: Record<string, { x: number; y: number }> = {};
    for (const [id, p] of Object.entries(l.ports)) {
      const t = turnPlacement(side[p.side], p.along, l.width, l.height, rotation);
      const across = t.side === Position.Top || t.side === Position.Bottom;
      out[id] = {
        x: at.x + (across ? t.along : t.side === Position.Left ? 0 : bw),
        y: at.y + (!across ? t.along : t.side === Position.Top ? 0 : bh),
      };
    }
    return out;
  }

  for (const orientation of ['horizontal', 'vertical']) {
    for (const rotation of [0, 90, 180, 270]) {
      for (const [from, to] of [['4', '6'], ['6', '3'], ['2', '8']]) {
        it(`${orientation} turned ${rotation}: ${from} -> ${to} leaves the feed and the old outlets where they were`, () => {
          const before = { rotation, options: { outlets: from, orientation } };
          const after = { rotation, options: { outlets: to, orientation } };
          const at = { x: 200, y: 300 };
          const shift = manifoldShift(before, after) ?? { x: 0, y: 0 };
          const was = portsAt(at, rotation, before.options);
          const now = portsAt({ x: at.x + shift.x, y: at.y + shift.y }, rotation, after.options);
          for (const id of Object.keys(was)) {
            if (!now[id]) continue;
            expect(Math.hypot(now[id].x - was[id].x, now[id].y - was[id].y), id).toBeLessThan(1e-9);
          }
        });
      }
    }
  }

  it('does not move an unturned manifold, which already grows away from its feed', () => {
    expect(manifoldShift({ rotation: 0, options: { outlets: '4' } }, { rotation: 0, options: { outlets: '6' } })).toBeNull();
  });

  it('keeps the feed put when the direction changes', () => {
    const before = { rotation: 180, options: { outlets: '4', orientation: 'horizontal' } };
    const after = { rotation: 180, options: { outlets: '4', orientation: 'vertical' } };
    const shift = manifoldShift(before, after)!;
    const was = portsAt({ x: 0, y: 0 }, 180, before.options).in;
    const now = portsAt(shift, 180, after.options).in;
    expect(now).toEqual(was);
  });

  it('leaves a manifold alone when the edit saves a new layout', () => {
    // Somebody placing the feed by hand meant to move it.
    const geometry = { width: 118, height: 26, positions: { in: 0.5 } };
    expect(manifoldShift({ rotation: 180, options: { outlets: '4' } }, { rotation: 180, options: { outlets: '4' }, geometry })).toBeNull();
    // A saved layout fixes the block's size, so the count changes nothing.
    expect(manifoldShift({ rotation: 180, options: { outlets: '4' }, geometry }, { rotation: 180, options: { outlets: '6' }, geometry })).toBeNull();
  });
});
