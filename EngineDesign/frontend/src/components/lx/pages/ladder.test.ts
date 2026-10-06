import { describe, expect, it } from 'vitest';
import { anchorToVessel, ladderView, rungsFromDiag, rungsFromNetwork, type Rung } from './ladder';

const R = (key: string, kind: string, dp: number | null): Rung => ({ key, label: key, kind, dp });

describe('ladderView', () => {
  it('lists the regulator as supply and scales the waterfall from its outlet to the chamber', () => {
    const v = ladderView(
      [R('reg', 'regulator', 3000), R('sol', 'solenoid', 10), R('line', 'line', 30), R('inj', 'injector', 160)],
      { label: 'Bottle', p: 3800 }, { label: 'Chamber', p: 600 },
    );
    expect(v.supply.map((r) => r.key)).toEqual(['reg']);
    expect(v.top.p).toBe(800);
    expect(v.span).toBe(200);
    expect(v.rungs.map((r) => r.share)).toEqual([0.05, 0.15, 0.8]);
    // A waterfall: each bar starts where the one before it ended.
    expect(v.rungs.map((r) => [r.x0, r.x1])).toEqual([[0, 0.05], [0.05, 0.2], [0.2, 1]]);
  });

  it('draws a gain (liquid head) backwards and keeps every bar on the track', () => {
    const v = ladderView([R('sag', 'tank', 20), R('head', 'tank', -10), R('line', 'line', 30), R('inj', 'injector', 160)],
      { label: 'Lockup', p: 578 }, { label: 'Chamber', p: 378 });
    expect(v.supply).toEqual([]);
    expect(v.top).toEqual({ label: 'Lockup', p: 578 });
    expect(v.span).toBe(200);
    const head = v.rungs[1];
    expect(head.x0).toBeCloseTo(10 / 200);
    expect(head.x1).toBeCloseTo(20 / 200);
    expect(head.share).toBeCloseTo(-0.05);
    for (const r of v.rungs) {
      expect(r.x0).toBeGreaterThanOrEqual(0);
      expect(r.x1).toBeLessThanOrEqual(1);
    }
  });

  it('gives no shares when a drop is unknown, and no outlet pressure when the supply is unknown', () => {
    const v = ladderView([R('reg', 'regulator', null), R('line', 'line', 30), R('inj', 'injector', null)],
      { label: 'Bottle', p: 3800 }, { label: 'Chamber', p: null });
    expect(v.top.p).toBeNull();
    expect(v.span).toBeNull();
    expect(v.rungs.every((r) => r.share === null)).toBe(true);
  });
});

describe('rungsFromDiag', () => {
  it('reads one side at one step', () => {
    const ladder = {
      t: [0, 1],
      ox: { elements: [{ id: 'a', label: 'A', kind: 'line', dp_psi: [1, 2] }, { id: 'b', label: 'B', kind: 'injector', dp_psi: [null, 5] }], total_psi: [10, 7] },
    };
    expect(rungsFromDiag(ladder, 'ox', 1)).toEqual({ rungs: [{ key: 'a', label: 'A', kind: 'line', dp: 2 }, { key: 'b', label: 'B', kind: 'injector', dp: 5 }], total: 7 });
    expect(rungsFromDiag(ladder, 'ox', 0)?.rungs[1].dp).toBeNull();
    expect(rungsFromDiag(ladder, 'fuel', 0)).toBeNull();
    expect(rungsFromDiag(ladder, 'ox', -1)).toBeNull();
  });
});

describe('rungsFromNetwork', () => {
  const net = {
    t: [0, 1],
    nodes: { b: { label: 'Bottle', kind: 'bottle', p_psia: [4000, 3000] }, t: { label: 'Tank', kind: 'tank', p_psia: [578, 570] } },
    branches: {
      reg: { label: 'Regulator', kind: 'regulator', from: 'b', to: 'm', mdot: [0, 0], dp_psi: [3400, 2420] },
      line: { label: 'LOX line', kind: 'line', from: 't', to: 'c', mdot: [0, 2], dp_psi: [0, 20] },
    },
    paths: { ox: ['reg', 'line'] },
  };
  it('walks the side\'s path in order, starting at its first node', () => {
    const r = rungsFromNetwork(net, 'ox', 1)!;
    expect(r.start).toBe(3000);
    expect(r.startLabel).toBe('Bottle');
    expect(r.rungs.map((x) => [x.key, x.kind, x.dp])).toEqual([['reg', 'regulator', 2420], ['line', 'line', 20]]);
  });
  it('gives nothing for a side with no path or a path through an unknown branch', () => {
    expect(rungsFromNetwork(net, 'fuel', 1)).toBeNull();
    expect(rungsFromNetwork({ ...net, paths: { ox: ['reg', 'nope'] } }, 'ox', 1)).toBeNull();
  });
});

describe('anchorToVessel', () => {
  const rungs = [
    { key: 'l_kb', label: 'l_kb', kind: 'line', dp: 0.4 },
    { key: 'reg', label: 'PR-DOME', kind: 'regulator', dp: 1056.0 },
    { key: 'l1', label: 'l1', kind: 'line', dp: 15.7 },
  ];
  it('starts at the vessel and gives the sub-step difference to the regulator, so the outlet is unchanged', () => {
    const a = anchorToVessel(rungs, 1655.8, 1648.4);
    expect(a.start).toBe(1648.4);
    expect(a.rungs[1].dp).toBeCloseTo(1056.0 - 7.4, 9);
    expect(a.rungs[0].dp).toBe(0.4);
    const outlet = (start: number, rs: { dp: number | null }[]) => start - (rs[0].dp as number) - (rs[1].dp as number);
    expect(outlet(a.start as number, a.rungs)).toBeCloseTo(outlet(1655.8, rungs), 9);
  });
  it('leaves the ladder alone without a vessel pressure', () => {
    expect(anchorToVessel(rungs, 1655.8, null)).toEqual({ rungs, start: 1655.8 });
  });
});
