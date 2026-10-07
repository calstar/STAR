import { describe, expect, it, vi } from 'vitest';
import { nextJunctionId, nextNodeId } from './ids';

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
    for (const id of ids) expect(id).toMatch(/^node_[0-9a-z]{8}$/);
    expect(nextJunctionId()).toMatch(/^junc_[0-9a-z]{8}$/);
  });
});
