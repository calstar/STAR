// The motorized valve (MOV): configured exactly as the rotary and solenoid
// valves are, normally open or closed, and told apart on sight by an M where
// they carry a P or an S.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import { COMPONENT_DEFS } from './types';
import { COMPONENT_SPECS } from './spec';
import { portsOf } from './ports';
import { isInline } from './attach';
import { ValveNode } from './nodes/ValveNode';
import { nodeTypes } from './nodes';

const render = (type: string, options: Record<string, string> = {}) => renderToStaticMarkup(createElement(
  ReactFlowProvider, null, createElement(ValveNode, {
    id: 'V', type, selected: false, dragging: false, zIndex: 0, isConnectable: true,
    positionAbsoluteX: 0, positionAbsoluteY: 0,
    data: { componentType: type, label: 'V', options },
  } as unknown as NodeProps)));
/** The actuator box's letter: the one-character text in the symbol. */
const letter = (html: string) => [...html.matchAll(/<text[^>]*>([A-Z])<\/text>/g)].map(m => m[1]);

describe('the motorized valve', () => {
  it('is on the palette among the valves, drawn by the valve symbol', () => {
    expect(COMPONENT_DEFS.find(d => d.type === 'MOV')).toMatchObject({ group: 'Valves', fullName: 'Motorized valve' });
    expect(nodeTypes.MOV).toBe(ValveNode);
  });

  it('is configured as the rotary and solenoid valves are, normally closed unless set open', () => {
    expect(COMPONENT_SPECS.MOV).toEqual(COMPONENT_SPECS.ROT);
    expect(COMPONENT_SPECS.MOV!.options!.find(o => o.key === 'failState')!.default).toBe('closed');
  });

  it('is plumbed inline, a port each side', () => {
    expect(portsOf({ id: 'V', position: { x: 0, y: 0 }, data: { componentType: 'MOV' } } as Node)).toEqual(['l', 'r']);
    expect(isInline('MOV')).toBe(true);
  });

  it('carries an M where the others carry a P or an S, and says which way it fails', () => {
    expect(letter(render('MOV'))).toContain('M');
    expect(letter(render('ROT'))).toContain('P');
    expect(letter(render('SOL'))).toContain('S');
    expect(render('MOV', { failState: 'open' })).toMatch(/NO/);
    expect(render('MOV', { failState: 'closed' })).toMatch(/NC/);
  });
});
