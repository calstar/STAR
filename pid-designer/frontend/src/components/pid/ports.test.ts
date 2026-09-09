import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import { portId, portIds, portsOf, drawnPortsOf, portKind } from './ports';
import { COMPONENT_DEFS } from './types';
import { COMPONENT_SPECS } from './spec';

const node = (componentType: string, data: Record<string, unknown> = {}): Node =>
  ({ id: 'n', position: { x: 0, y: 0 }, data: { componentType, label: 'n', ...data } }) as unknown as Node;

describe('port ids', () => {
  it('keeps the bare prefix for the first port', () => {
    // Not cosmetic: an edge drawn to `t` when a tank had one port must still
    // find `t` after the count is raised. Renaming it orphans the line, and an
    // orphaned line is saved and never drawn.
    expect(portId('t', 0)).toBe('t');
    expect(portIds('t', 1)).toEqual(['t']);
    expect(portIds('t', 3)).toEqual(['t', 't2', 't3']);
  });

  it('does not rename port zero when the count changes', () => {
    expect(portIds('p', 1)[0]).toBe(portIds('p', 6)[0]);
  });
});

describe('what ports a component has', () => {
  it('grows a tank’s ends with its counts', () => {
    const t = node('TANK', { options: { portsTop: '3', portsBottom: '2' } });
    expect(portsOf(t)).toEqual(['t', 't2', 't3', 'b', 'b2']);
  });

  it('gives a manifold a feed plus its outlets', () => {
    const m = node('MANIFOLD', { options: { outlets: '3' } });
    expect(portsOf(m)).toEqual(['in', 'p', 'p2', 'p3']);
  });

  it('adds the dome port only to a dome-loaded regulator', () => {
    expect(portsOf(node('PR'))).toEqual(['l', 'r']);
    expect(portsOf(node('PR', { options: { domeLoaded: 'yes' } }))).toContain('dome');
  });

  it('falls back to sane counts when an option is missing or junk', () => {
    expect(portsOf(node('TANK'))).toEqual(['t', 'b']);
    expect(portsOf(node('MANIFOLD', { options: { outlets: 'x' } }))).toHaveLength(5);
  });

  it('gives annotation no ports at all', () => {
    expect(portsOf(node('TEXT'))).toEqual([]);
    expect(portsOf(node('REGION'))).toEqual([]);
  });
});

describe('plugged ports', () => {
  it('are not drawn, because a P&ID does not draw plugs', () => {
    const m = node('MANIFOLD', {
      options: { outlets: '3' },
      ports: { p2: { kind: 'plug' } },
    });
    expect(portsOf(m)).toContain('p2');
    expect(drawnPortsOf(m)).toEqual(['in', 'p', 'p3']);
  });

  it('treat an unmarked port as a flow port', () => {
    expect(portKind(node('MANIFOLD').data as never, 'p')).toBe('flow');
  });

  it('keep instrument ports drawn — they are real hardware', () => {
    const m = node('MANIFOLD', { options: { outlets: '2' }, ports: { p2: { kind: 'instrument' } } });
    expect(drawnPortsOf(m)).toContain('p2');
  });
});

describe('the port table covers what the palette can drop', () => {
  it('gives every droppable component at least one port, or none by design', () => {
    // Guards the duplication between `portsOf` and what each symbol renders:
    // a component added to the palette without a row here would silently have
    // no ports as far as the checks and the config are concerned.
    const noPorts = new Set(['TEXT', 'REGION']);
    for (const def of COMPONENT_DEFS) {
      const ports = portsOf(node(def.type, { options: def.preset ?? {} }));
      if (noPorts.has(def.type)) expect(ports).toEqual([]);
      else expect(ports.length, `${def.id} (${def.type}) has no ports`).toBeGreaterThan(0);
    }
  });

  it('declares a port group only where the count option exists', () => {
    for (const [type, spec] of Object.entries(COMPONENT_SPECS)) {
      for (const group of spec?.portGroups ?? []) {
        const known = (spec?.options ?? []).some(o => o.key === group.countOption);
        expect(known, `${type}: portGroup counts ${group.countOption}, which is not an option`).toBe(true);
      }
    }
  });
});
