import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Position, ReactFlowProvider } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import { nodeTypes } from './nodes';
import { unmeasuredEnd } from './unmeasured';

/**
 * Where a symbol's ports are, read off the symbol as it renders: its box,
 * and each handle's offset along its side -- the `left` or `top` it is
 * given, or the middle of the side for a handle given neither, which is
 * where React Flow's own stylesheet puts it.
 */
function drawn(componentType: string, rotation: number, options: Record<string, string> = {}) {
  const Comp = (nodeTypes as Record<string, (p: NodeProps) => unknown>)[componentType];
  const props = {
    id: 'X', type: componentType, selected: false, dragging: false, zIndex: 0, isConnectable: true,
    positionAbsoluteX: 0, positionAbsoluteY: 0,
    data: { componentType, label: 'X', rotation, options },
  } as unknown as NodeProps;
  const html = renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(Comp as never, props)));
  const box = /position:relative;width:(-?[\d.]+)px;height:(-?[\d.]+)px/.exec(html)!;
  const w = Number(box[1]), h = Number(box[2]);
  const ports: Record<string, { side: string; x: number; y: number }> = {};
  for (const m of html.matchAll(/<div data-handleid="([^"]+)" data-handlepos="([^"]+)"[^>]*?style="([^"]*)"/g)) {
    const side = m[2];
    const across = side === Position.Top || side === Position.Bottom;
    const set = new RegExp(`(?:^|;)${across ? 'left' : 'top'}:(-?[\\d.]+)px`).exec(m[3]);
    const along = set ? Number(set[1]) : (across ? w : h) / 2;
    ports[m[1]] = {
      side,
      x: across ? along : side === Position.Left ? 0 : w,
      y: across ? (side === Position.Top ? 0 : h) : along,
    };
  }
  return { w, h, ports };
}

const onGrid = (v: number) => Math.abs(v - Math.round(v / 10) * 10) < 1e-9;

const SHAPES: [string, Record<string, string>][] = [
  ['KBOTTLE', {}],
  ['DEWAR', {}],
  ...['horizontal', 'vertical'].flatMap(orientation =>
    ['1', '2', '3', '4', '6', '8'].map(outlets => ['MANIFOLD', { outlets, orientation }] as [string, Record<string, string>])),
];

describe('a supply or a manifold standing on the grid', () => {
  for (const [type, options] of SHAPES) {
    for (const rotation of [0, 90, 180, 270]) {
      it(`${type} ${JSON.stringify(options)} turned ${rotation}: has every port on the grid`, () => {
        // Its box a whole number of grid steps, since a turned symbol's port
        // is measured from the far end of its side; and every port a whole
        // number of steps along it.
        const { w, h, ports } = drawn(type, rotation, options);
        expect(onGrid(w) && onGrid(h), `${w} x ${h}`).toBe(true);
        expect(Object.keys(ports).length).toBeGreaterThan(0);
        for (const [id, p] of Object.entries(ports)) {
          expect(onGrid(p.x) && onGrid(p.y), `${id} at (${p.x}, ${p.y})`).toBe(true);
        }
      });
    }
  }

  it('lines the bottle\'s outlet up with a regulator standing on the grid beside it', () => {
    // KB-1 at (100, 100) fed PR-1 at (300, 100) through a line that jogged
    // 8 px halfway, from the outlet at y = 122 to the regulator's inlet at 130.
    const bottle = drawn('KBOTTLE', 0);
    expect(bottle.ports.r).toEqual({ side: Position.Right, x: 40, y: 20 });
    expect(bottle.ports.t).toEqual({ side: Position.Top, x: 20, y: 0 });
  });

  it('keeps a manifold\'s outlets evenly spaced, the feed in the middle of the near end', () => {
    const h = drawn('MANIFOLD', 0, { outlets: '4', orientation: 'horizontal' });
    expect({ w: h.w, h: h.h }).toEqual({ w: 120, h: 20 });
    expect(h.ports.in).toMatchObject({ side: Position.Left, x: 0, y: 10 });
    expect(['p', 'p2', 'p3', 'p4'].map(id => h.ports[id].x)).toEqual([10, 40, 70, 100]);
    for (const outlets of ['2', '3', '6', '8']) {
      const at = Object.entries(drawn('MANIFOLD', 0, { outlets }).ports)
        .filter(([id]) => id !== 'in').map(([, p]) => p.x).sort((a, b) => a - b);
      const gaps = new Set(at.slice(1).map((x, i) => x - at[i]));
      expect([...gaps], `${outlets} outlets at ${at}`).toEqual([30]);
    }
  });

  it('moves no port of a drawing made before it more than a few pixels across its line', () => {
    // Where the old boxes put each port, unturned and turned half a turn,
    // against where they are now: the distance a line into it moves sideways.
    // A four-outlet manifold's last outlet has the furthest to go, since the
    // outlets are spaced four pixels wider than they were.
    const before: Record<string, { limit: number; ports: Record<string, [number, number]> }> = {
      KBOTTLE: { limit: 4, ports: { r: [22, 74], t: [22, 22] } },
      DEWAR: { limit: 4, ports: { r: [38, 38], t: [36, 36], b: [36, 36] } },
      MANIFOLD: { limit: 8, ports: { in: [13, 13], p: [14, 104], p2: [40, 78], p3: [66, 52], p4: [92, 26] } },
    };
    for (const [type, { limit, ports }] of Object.entries(before)) {
      for (const [i, rotation] of [0, 180].entries()) {
        const now = drawn(type, rotation, type === 'MANIFOLD' ? { outlets: '4' } : {}).ports;
        for (const [id, was] of Object.entries(ports)) {
          const p = now[id];
          const across = p.side === Position.Top || p.side === Position.Bottom ? p.x : p.y;
          expect(Math.abs(across - was[i]), `${type}.${id} turned ${rotation}`).toBeLessThanOrEqual(limit);
        }
      }
    }
  });

  it('is placed where it draws by the table a drawing is opened with, before anything is measured', () => {
    // `unmeasuredEnd` reads the same constants; three pixels out from the
    // handle is where React Flow anchors a line.
    for (const [type, options] of SHAPES) {
      for (const rotation of [0, 90, 180, 270]) {
        const node = { id: 'X', type, position: { x: 200, y: 300 }, data: { componentType: type, label: 'X', rotation, options } } as unknown as Node;
        for (const [id, p] of Object.entries(drawn(type, rotation, options).ports)) {
          const end = unmeasuredEnd(node, id)!;
          const out = { top: [0, -3], bottom: [0, 3], left: [-3, 0], right: [3, 0] }[p.side]!;
          expect({ x: end.x, y: end.y, side: end.side }, `${type} ${id} turned ${rotation}`)
            .toEqual({ x: 200 + p.x + out[0], y: 300 + p.y + out[1], side: p.side });
        }
      }
    }
  });
});
