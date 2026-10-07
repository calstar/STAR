import { describe, expect, it, vi } from 'vitest';
import { freshEdgeId, nextJunctionId, nextNodeId, withoutSpendingIds } from './ids';

describe('a line id nothing else has', () => {
  it('is the natural name when that is free', () => {
    expect(freshEdgeId('a-b', new Set(['a-c']))).toBe('a-b');
  });

  it('numbers past every name already taken', () => {
    expect(freshEdgeId('a-b', new Set(['a-b', 'a-b-2']))).toBe('a-b-3');
  });

  it('asks a question when handed one, so a caller can count ids it has not written yet', () => {
    const minted = new Set(['a-b']);
    expect(freshEdgeId('a-b', id => id === 'a-b' || id === 'a-b-2' || minted.has(id))).toBe('a-b-3');
  });
});

/** A fresh copy of the module: a different person's tab, counters at zero. */
async function freshTab() {
  vi.resetModules();
  return import('./ids');
}

describe('new node ids', () => {
  it('differ between two copies of the same diagram', async () => {
    // Two people copy main (node_1..node_12) and each draw one valve in their
    // own tab. With counter ids both got node_13; a merge back into main would
    // read two different valves as one.
    const main = Array.from({ length: 12 }, (_, i) => ({ id: `node_${i + 1}` }));
    const alice = await freshTab();
    alice.seedIdsFrom(main as never);
    const bob = await freshTab();
    bob.seedIdsFrom(main as never);
    expect(alice.nextNodeId()).not.toBe(bob.nextNodeId());
    expect(alice.nextJunctionId()).not.toBe(bob.nextJunctionId());
  });

  it('keep their prefixes and stay unique', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => nextNodeId()));
    expect(ids.size).toBe(5000);
    for (const id of ids) expect(id).toMatch(/^node_[0-9a-z]{6}_\d+$/);
    expect(nextJunctionId()).toMatch(/^junc_[0-9a-z]{6}_\d+$/);
  });

  it('are the same in a preview as in the drop it shows', () => {
    const previewed = withoutSpendingIds(() => [nextNodeId(), nextJunctionId()]);
    expect([nextNodeId(), nextJunctionId()]).toEqual(previewed);
  });
});
