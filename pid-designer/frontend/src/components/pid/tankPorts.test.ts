import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { TankNode, endPortOffsets } from './nodes/TankNode';

/** Each handle's id and its offset along its edge, as the tank renders it. */
function handles(rotation: number, options: Record<string, string>): Record<string, number> {
  const props = {
    id: 'T', type: 'TANK', selected: false, dragging: false, zIndex: 0, isConnectable: true,
    positionAbsoluteX: 0, positionAbsoluteY: 0,
    data: { componentType: 'TANK', label: 'T', rotation, options },
  } as unknown as NodeProps;
  const html = renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(TankNode, props)));
  const out: Record<string, number> = {};
  for (const m of html.matchAll(/<div data-handleid="([^"]+)"[^>]*?style="([^"]*)"/g)) {
    const at = /(?:^|;)(?:left|top):(-?[\d.]+)px/.exec(m[2]);
    if (at) out[m[1]] = Number(at[1]);
  }
  return out;
}

describe('ports across a tank end', () => {
  it('sit on the 10 px grid on the 60 px tank', () => {
    // A partner standing on the grid can then be dead in line with any of
    // them. Evenly spaced, three sat at 15 and 45 and four at 12/24/36/48.
    expect(endPortOffsets(1, 60)).toEqual([30]);
    expect(endPortOffsets(2, 60)).toEqual([20, 40]);
    expect(endPortOffsets(3, 60)).toEqual([10, 30, 50]);
    expect(endPortOffsets(4, 60)).toEqual([10, 20, 40, 50]);
  });

  it('stay symmetric, so a tank turned half a turn still has them on the grid', () => {
    for (const w of [60, 80, 100, 120]) {
      for (const n of [1, 2, 3, 4]) {
        const at = endPortOffsets(n, w);
        expect(at.every(a => a % 10 === 0), `${n} on ${w}: ${at}`).toBe(true);
        expect([...at].reverse().map(a => w - a), `${n} on ${w}`).toEqual(at);
      }
    }
  });

  it('keep even spacing on an end too narrow to give each its own grid line', () => {
    expect(endPortOffsets(4, 30)).toEqual([6, 12, 18, 24]);
  });

  it('are where the tank draws its lid and bottom ports, turned or not', () => {
    expect(handles(0, { portsTop: '3', portsBottom: '4' })).toMatchObject({
      t: 10, t2: 30, t3: 50, b: 10, b2: 20, b3: 40, b4: 50,
    });
    // Half a turn puts the lid at the bottom, measured from the other end.
    expect(handles(180, { portsTop: '3' })).toMatchObject({ t: 50, t2: 30, t3: 10 });
  });
});
