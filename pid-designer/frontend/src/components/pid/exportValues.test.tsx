import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import type { ComponentType } from 'react';
import { notChromeOrValue } from './exportImage';
import type { ParamValue } from './params';
import { TankNode } from './nodes/TankNode';
import { EngineNode } from './nodes/EngineNode';
import { PRNode } from './nodes/PRNode';
import { RVNode } from './nodes/RVNode';
import { SupplyNode } from './nodes/SupplyNode';

const psia = (value: number) => ({ value, unit: 'psia', source: 'test' }) as unknown as ParamValue;
const kelvin = (value: number) => ({ value, unit: 'K', source: 'test' }) as unknown as ParamValue;

/**
 * The markup as html-to-image clones it for the stand picture: an element the
 * filter refuses is left out with everything inside it.
 */
function asExported(html: string): string {
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const tag = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>/g;
  let out = '';
  let at = 0;
  let skipping = 0;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    if (!skipping) out += html.slice(at, m.index);
    at = tag.lastIndex;
    const [whole, close, name, attrText, selfClose] = m;
    const leaf = Boolean(selfClose) || VOID.has(name.toLowerCase());
    if (skipping) {
      if (close) skipping--;
      else if (!leaf) skipping++;
      continue;
    }
    if (!close) {
      const attrs = new Map([...attrText.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)].map((a) => [a[1], a[2] ?? '']));
      const classes = (attrs.get('class') ?? '').split(/\s+/);
      const el = {
        hasAttribute: (a: string) => attrs.has(a),
        getAttribute: (a: string) => attrs.get(a) ?? null,
        classList: { contains: (c: string) => classes.includes(c) },
      } as unknown as HTMLElement;
      if (!notChromeOrValue(el)) {
        if (!leaf) skipping = 1;
        continue;
      }
    }
    out += whole;
  }
  return out + (skipping ? '' : html.slice(at));
}

const render = (Node: ComponentType<NodeProps>, data: Record<string, unknown>) =>
  renderToStaticMarkup(
    <ReactFlowProvider>
      <Node {...({ id: 'n', type: 't', data: { label: 'TAG-1', ...data }, selected: false } as unknown as NodeProps)} />
    </ReactFlowProvider>,
  );

describe("the stand picture leaves out each symbol's printed value", () => {
  // A value left in ends up on the DAQ's screen beside the live reading, as if
  // it were one. Each value below is one nothing else on the symbol prints.
  const cases: [string, ComponentType<NodeProps>, Record<string, unknown>, string[]][] = [
    ['TankNode', TankNode, { params: { pressure: psia(512.3), temperature: kelvin(90.2) } }, ['512.3 psia', '90.2 K']],
    ['EngineNode', EngineNode, { params: { chamber_pressure: psia(385.4), chamber_temperature: kelvin(3412) } }, ['385.4 psia', '3412 K']],
    ['PRNode', PRNode, { params: { setpoint: psia(514.7) } }, ['514.7 psia']],
    ['RVNode', RVNode, { params: { set_pressure: psia(614.7) } }, ['600 psi']],
    ['SupplyNode', SupplyNode, { componentType: 'COPV', params: { pressure: psia(4514.7) } }, ['4514.7 psia']],
  ];

  it.each(cases)('%s', (_name, Node, data, printed) => {
    const html = render(Node, data);
    for (const v of printed) expect(html).toContain(v);
    const exported = asExported(html);
    for (const v of printed) expect(exported).not.toContain(v);
    expect(exported).toContain('TAG-1');
  });
});
