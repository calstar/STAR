import { describe, expect, it } from 'vitest';
import { resolveTab, TABS, visibleTabs, wantsAdvanced } from './tabs';

describe('the tab strip', () => {
  it('lists the prototypes only with ?advanced=1', () => {
    const plain = visibleTabs(wantsAdvanced('')).map((t) => t.id);
    expect(plain).not.toContain('controller');
    expect(plain).not.toContain('demo');
    expect(plain).not.toContain('plotter');
    expect(plain).toContain('layerx');
    expect(plain).toContain('config');
    expect(visibleTabs(wantsAdvanced('?lx=2&advanced=1')).map((t) => t.id)).toEqual(TABS.map((t) => t.id));
  });
  it('reads only an explicit yes', () => {
    expect(wantsAdvanced('?advanced=0')).toBe(false);
    expect(wantsAdvanced('?advanced=true')).toBe(true);
  });
  it('never opens on a tab the strip does not list', () => {
    expect(resolveTab('demo', false)).toBe('forward');
    expect(resolveTab('demo', true)).toBe('demo');
    expect(resolveTab('layerx', false)).toBe('layerx');
    expect(resolveTab('nonsense' as never, false)).toBe('forward');
  });
});
