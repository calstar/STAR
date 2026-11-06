// A line's right-click menu is where a hand-routed pipe is given back to the
// router. It was a double-click on a grip, which took the double-click that
// opens the line's dialog (BranchableEdge).
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react', async (orig) => {
  const R = await orig<typeof import('react')>();
  const { hooks } = await import('./hookRuntime');
  return { ...R, ...hooks, default: { ...R, ...hooks } };
});

import { find, rt, textOf } from './hookRuntime';
import { ColorMenu } from './ColorMenu';

beforeEach(() => rt.reset());

const menu = (onReroute?: () => void) => {
  const calls = { closed: 0 };
  const tree = rt.settle(() => ColorMenu({
    x: 0, y: 0, onPick: () => {}, onClear: () => {}, onClose: () => { calls.closed++; }, onReroute,
  }));
  const reroute = find(tree, e => e.type === 'button' && textOf(e).includes('Let it route itself'))[0];
  return { reroute, calls };
};

describe('the line menu\'s re-route', () => {
  it('is offered for a hand-routed pipe, and re-routes it', () => {
    const fn = vi.fn();
    const { reroute, calls } = menu(fn);
    expect(reroute).toBeDefined();
    (reroute.props.onClick as () => void)();
    expect(fn).toHaveBeenCalledOnce();
    expect(calls.closed).toBe(1);
  });

  it('is not offered when there is nothing routed by hand', () => {
    expect(menu().reroute).toBeUndefined();
  });
});
