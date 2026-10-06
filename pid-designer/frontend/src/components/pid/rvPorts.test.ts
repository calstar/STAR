// The relief valve's two ports, turned. Both were pinned at top: 50%, so a
// quarter turn -- which puts them on the top and the bottom -- drew them in
// the middle of the valve, one over the other.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { RVNode } from './nodes/RVNode';

/** Each port: the side React Flow puts it on, and any position pinned on it. */
function ports(rotation: number): Record<string, { side: string; style: string }> {
  const html = renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(RVNode, {
    id: 'RV', type: 'RV', selected: false, dragging: false, zIndex: 0, isConnectable: true,
    positionAbsoluteX: 0, positionAbsoluteY: 0,
    data: { componentType: 'RV', label: 'RV-1', rotation },
  } as unknown as NodeProps)));
  const out: Record<string, { side: string; style: string }> = {};
  for (const [tag] of html.matchAll(/<div data-handleid="[^"]+"[^>]*>/g)) {
    const id = /data-handleid="([^"]+)"/.exec(tag)![1];
    out[id] = { side: /data-handlepos="([^"]+)"/.exec(tag)![1], style: /style="([^"]*)"/.exec(tag)?.[1] ?? '' };
  }
  return out;
}

describe('a relief valve turned', () => {
  it('has its ports on opposite sides at every quarter turn', () => {
    const opposite: Record<string, string> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
    for (const rotation of [0, 90, 180, 270]) {
      const p = ports(rotation);
      expect(opposite[p.l.side], `turned ${rotation}`).toBe(p.r.side);
    }
    expect([ports(90).l.side, ports(90).r.side].sort()).toEqual(['bottom', 'top']);
  });

  it('leaves where along its side each port sits to the side it is on, as the other valves do', () => {
    // A top or bottom port pinned at top: 50% is a port in the middle of the symbol.
    for (const rotation of [0, 90, 180, 270]) {
      for (const port of Object.values(ports(rotation))) expect(port.style).not.toMatch(/top:\s*50%/);
    }
  });
});
