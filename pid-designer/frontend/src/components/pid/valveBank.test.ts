// The 5/2 solenoid manifold: one supply in, 1 to 10 outlets, each on its own
// valve station. Its ports are listed three times -- `portsOf` (the checks and
// the dialog), the node's own handles, and `unmeasuredEnd` (anything placing a
// port before the canvas measures it) -- and the three have to agree.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Position, ReactFlowProvider } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import { VALVE_BANK_MAX, portsOf } from './ports';
import { COMPONENT_DEFS } from './types';
import { COMPONENT_SPECS } from './spec';
import { unmeasuredEnd } from './unmeasured';
import { ValveBankNode, bankPort, bankPortIds, bankWidth } from './nodes/ValveBankNode';

const bank = (outlets?: string, extra: Record<string, unknown> = {}, at = { x: 0, y: 0 }): Node =>
  ({ id: 'VB', type: 'VALVE_BANK', position: at,
     data: { componentType: 'VALVE_BANK', label: 'VB-1', options: outlets ? { outlets } : {}, ...extra } }) as unknown as Node;

/** Each handle the block renders: its id, the side it is on, and how far along. */
function handles(n: Node): Record<string, { side: string; along: number | null }> {
  const props = {
    id: n.id, type: 'VALVE_BANK', selected: false, dragging: false, zIndex: 0, isConnectable: true,
    positionAbsoluteX: 0, positionAbsoluteY: 0, data: n.data,
  } as unknown as NodeProps;
  const html = renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(ValveBankNode, props)));
  const out: Record<string, { side: string; along: number | null }> = {};
  for (const [tag] of html.matchAll(/<div data-handleid="[^"]+"[^>]*>/g)) {
    const id = /data-handleid="([^"]+)"/.exec(tag)![1];
    const side = /data-handlepos="([^"]+)"/.exec(tag)![1];
    const at = /style="[^"]*?(?:^|;|")(?:left|top):(-?[\d.]+)px/.exec(tag);
    out[id] = { side, along: at ? Number(at[1]) : null };
  }
  return out;
}

describe('the 5/2 solenoid manifold', () => {
  it('is on the palette, with a dialog that offers 1 to 10 outlets', () => {
    expect(COMPONENT_DEFS.some(d => d.type === 'VALVE_BANK')).toBe(true);
    const outlets = COMPONENT_SPECS.VALVE_BANK!.options!.find(o => o.key === 'outlets')!;
    expect(outlets.choices.map(c => c.value)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    expect(VALVE_BANK_MAX).toBe(10);
  });

  it('has one supply port and as many outlets as asked, four if nothing says', () => {
    expect(portsOf(bank())).toEqual(['in', 'p', 'p2', 'p3', 'p4']);
    expect(portsOf(bank('1'))).toEqual(['in', 'p']);
    expect(portsOf(bank('10'))).toHaveLength(11);
    // More than a block is drawn with is the most it is drawn with.
    expect(portsOf(bank('14'))).toHaveLength(11);
  });

  it('draws every port its table lists, and no other, at the place it says', () => {
    for (let n = 1; n <= VALVE_BANK_MAX; n++) {
      const drawn = handles(bank(String(n)));
      expect(Object.keys(drawn).sort()).toEqual([...portsOf(bank(String(n)))].sort());
      expect(bankPortIds(n)).toEqual(portsOf(bank(String(n))));
      for (const id of bankPortIds(n)) {
        const want = bankPort(n, id)!;
        expect(drawn[id].side).toBe(want.side);
        expect(drawn[id].along).toBe(want.along);
      }
    }
  });

  it('puts the supply on the left end and the outlets along the top, all on the 10 px grid', () => {
    const n = 6;
    expect(bankPort(n, 'in')!.side).toBe(Position.Left);
    const alongs = bankPortIds(n).slice(1).map(id => bankPort(n, id)!);
    expect(alongs.every(p => p.side === Position.Top)).toBe(true);
    for (const p of [bankPort(n, 'in')!, ...alongs]) expect(p.along % 10).toBe(0);
    expect(bankWidth(n) % 10).toBe(0);
    // Evenly spaced, in order, inside the block.
    const xs = alongs.map(p => p.along);
    expect(new Set(xs.slice(1).map((x, i) => x - xs[i])).size).toBe(1);
    expect(xs[xs.length - 1]).toBeLessThan(bankWidth(n));
  });

  it('does not draw a plugged outlet', () => {
    const drawn = handles(bank('3', { ports: { p2: { kind: 'plug' } } }));
    expect(Object.keys(drawn).sort()).toEqual(['in', 'p', 'p3']);
  });

  it('is placed before it is measured where it will be drawn', () => {
    const n = bank('3', {}, { x: 100, y: 200 });
    expect(unmeasuredEnd(n, 'in')).toMatchObject({ x: 97, y: 200 + bankPort(3, 'in')!.along, side: Position.Left });
    expect(unmeasuredEnd(n, 'p2')).toMatchObject({ x: 100 + bankPort(3, 'p2')!.along, y: 197, side: Position.Top });
    expect(unmeasuredEnd(n, 'p4')).toBeNull();
  });
});
