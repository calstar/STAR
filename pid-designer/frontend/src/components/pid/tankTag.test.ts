// Where a tank's tag stands, against the lines its ports are drawn with.
//
// A tag is part of the node, and the nodes are drawn above the lines -- the
// anchor a line's end is picked up by included. A tag left over a port's line
// end hides the first stretch of the line and takes every press aimed at that
// anchor: a tank's tag under the barrel sat on its bottom port, and the line
// from it could not be carried to another port.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { TankNode } from './nodes/TankNode';
import { CARRY_RADIUS } from './BranchableEdge';
import { STUB } from './route';

interface Rect { x0: number; y0: number; x1: number; y1: number }

/** A tank as it renders: its box, its ports' line ends and which way each faces, and where its tag's box starts. */
function tank(rotation: number, options: Record<string, string>, label: string) {
  const props = {
    id: 'T', type: 'TANK', selected: false, dragging: false, zIndex: 0, isConnectable: true,
    positionAbsoluteX: 0, positionAbsoluteY: 0,
    data: { componentType: 'TANK', label, rotation, options },
  } as unknown as NodeProps;
  const html = renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(TankNode, props)));
  const box = /^<div style="position:relative;width:(\d+)px;height:(\d+)px"/.exec(html)!;
  const w = Number(box[1]), h = Number(box[2]);
  // A handle is centred on the side it is on, and a line meets its outer
  // edge three pixels out (`handleEnd`).
  const ports = [...html.matchAll(/<div data-handleid="([^"]+)" data-handlepos="([a-z]+)"[^>]*?style="([^"]*)"/g)].map(m => {
    const along = Number(/(?:left|top):(-?[\d.]+)px/.exec(m[3])![1]);
    const side = m[2];
    const end = side === 'top' ? { x: along, y: -3 } : side === 'bottom' ? { x: along, y: h + 3 }
      : side === 'left' ? { x: -3, y: along } : { x: w + 3, y: along };
    const out = side === 'top' ? { x: 0, y: -1 } : side === 'bottom' ? { x: 0, y: 1 } : side === 'left' ? { x: -1, y: 0 } : { x: 1, y: 0 };
    return { id: m[1], end, out };
  });
  const at = /transform:translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(html)!;
  return { w, h, ports, tag: { x: Number(at[1]), y: Number(at[2]) } };
}

/**
 * The tag's box, generously: the grip, the gap and the text in the canvas's
 * small type, ten pixels a letter and its padding, and a line of it high.
 * (Rendered, "MAN-1" takes 52 by 17, and "TK-1" 37 by 17.)
 */
const tagBox = (tag: { x: number; y: number }, label: string): Rect =>
  ({ x0: tag.x, y0: tag.y, x1: tag.x + 14 + 2 + 8 + 10 * label.length, y1: tag.y + 18 });

/**
 * What a port's line end takes presses over: the anchor its end is carried
 * by, CARRY_RADIUS round a point that far out, and the line's first stretch,
 * straight out of the port for its stub, a press's reach either side.
 */
function lineEnd(p: { end: { x: number; y: number }; out: { x: number; y: number } }): Rect {
  const far = { x: p.end.x + p.out.x * STUB, y: p.end.y + p.out.y * STUB };
  return {
    x0: Math.min(p.end.x, far.x) - CARRY_RADIUS, y0: Math.min(p.end.y, far.y) - CARRY_RADIUS,
    x1: Math.max(p.end.x, far.x) + CARRY_RADIUS, y1: Math.max(p.end.y, far.y) + CARRY_RADIUS,
  };
}

const overlap = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

describe("a tank's tag", () => {
  const label = 'TK-12';
  for (const rotation of [0, 90, 180, 270]) {
    it(`stands clear of every line end at its ports, turned ${rotation} degrees, with one to four ports a head`, () => {
      for (const n of [1, 2, 3, 4]) {
        const t = tank(rotation, { portsTop: String(n), portsBottom: String(n) }, label);
        expect(t.ports).toHaveLength(2 * n);
        const tag = tagBox(t.tag, label);
        const under = t.ports.filter(p => overlap(tag, lineEnd(p))).map(p => p.id);
        expect(under, `${n} a head`).toEqual([]);
      }
    });
  }

  it('stays off the barrel, and close enough beside or under it to read as its tag', () => {
    for (const rotation of [0, 90]) {
      const t = tank(rotation, {}, label);
      const tag = tagBox(t.tag, label);
      // Not over the symbol itself...
      expect(overlap(tag, { x0: 0, y0: 0, x1: t.w, y1: t.h }), `turned ${rotation}`).toBe(false);
      // ...and touching its box grown by a grid step or so.
      expect(overlap(tag, { x0: -12, y0: -12, x1: t.w + 12, y1: t.h + 12 }), `turned ${rotation}`).toBe(true);
    }
  });
});
