// A hand valve that stands open. feed-twin rests every hand valve shut until
// somebody opens it, unless the drawing says `normalPosition: open` (ADR
// 0006) -- and its warning told the user to draw that, which pid-designer
// offered no way to do.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { COMPONENT_SPECS } from './spec';
import { ValveNode } from './nodes/ValveNode';

const render = (options: Record<string, string> = {}) => renderToStaticMarkup(createElement(
  ReactFlowProvider, null, createElement(ValveNode, {
    id: 'V', type: 'MAN', selected: false, dragging: false, zIndex: 0, isConnectable: true,
    positionAbsoluteX: 0, positionAbsoluteY: 0,
    data: { componentType: 'MAN', label: 'V', options },
  } as unknown as NodeProps)));
/** The bowtie's fill: hollow is an open bore. */
const body = (html: string) => /<polygon points="8,10 52,46 52,10 8,46"[^>]*fill="([^"]*)"/.exec(html)![1];

describe('a hand valve that stands open', () => {
  it('is offered on the hand valve, shut unless set open, in the values feed-twin reads', () => {
    const o = COMPONENT_SPECS.MAN!.options!.find(x => x.key === 'normalPosition');
    expect(o?.default).toBe('closed');
    expect(o?.choices.map(c => c.value)).toEqual(['closed', 'open']);
  });

  it('is drawn hollow and marked NO, as a normally-open actuated valve is', () => {
    expect(body(render({ normalPosition: 'open' }))).toBe('none');
    expect(render({ normalPosition: 'open' })).toMatch(/>NO</);
  });

  it('is drawn as it always was when it rests shut, with no mark', () => {
    for (const options of [{}, { normalPosition: 'closed' }] as Record<string, string>[]) {
      const html = render(options);
      expect(body(html)).not.toBe('none');
      expect(html).not.toMatch(/>N[OC]</);
    }
  });
});
