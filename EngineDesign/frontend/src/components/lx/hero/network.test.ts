import { describe, expect, it } from 'vitest';
import { STAND_DOC } from './__fixtures__/stand';
import { standResult } from './__fixtures__/result';
import { parseDrawing } from './drawing';
import { bottleOf, buildNetView, liquidPath, outflow, tankSides } from './network';

const d = parseDrawing(STAND_DOC);
const PSI_ATM = 101325 / 6894.757293168361;

describe('roles on the drawing', () => {
  it('takes the run\'s own roles and bottle', () => {
    const r = standResult();
    expect([...tankSides(d, r)]).toEqual([['OXT', 'ox'], ['FUT', 'fuel']]);
    expect(bottleOf(d, r)?.id).toBe('KB1');
  });

  it('falls back to the tanks\' fluids without them', () => {
    const r = standResult();
    (r.provenance as unknown as { derived: object }).derived = {};
    expect(tankSides(d, r).get('OXT')).toBe('ox');
    expect(tankSides(d, r).get('FUT')).toBe('fuel');
  });

  it('walks a tank\'s liquid side to the engine, through its main valve, not its fill', () => {
    const p = liquidPath(d, d.byId.get('OXT')!);
    expect(p?.lines.map((l) => l.id)).toEqual(['l_ox1', 'l_ox2']);
    expect(p?.via.map((s) => s.id)).toEqual(['MVO']);
  });

  it('outflow is the falling mass\'s rate, never negative', () => {
    expect(outflow([0, 1, 2, 3], [10, 8, 6, 7])).toEqual([2, 2, 0.5, 0]);
  });
});

describe('buildNetView from the series (no network recorded)', () => {
  const r = standResult();
  const v = buildNetView(d, r);
  const line = (id: string) => v.lines.get(id)!;
  const i = 10;

  it('says where it came from', () => expect(v.source).toBe('series'));

  it('puts the bottle on the supply lines, the regulator on its outlet manifold', () => {
    expect(line('l_kb').p).toBe(r.series.copv_psia);
    expect(line('l_reg').p).toBe(r.series.copv_psia);
    expect(line('l_ctrl').p).toBe(r.series.copv_psia);
    expect(line('l_reg_out').p).toBe(r.series.regulators.PR_D.outlet_psia);
    expect(line('l_oxpress_in').p).toBe(r.series.regulators.PR_D.outlet_psia);
    expect(line('l_gn2vent').p).toBe(r.series.regulators.PR_D.outlet_psia);
  });

  it('gives the bottle\'s outflow to the trunk only, not to lines past a split', () => {
    const out = line('l_kb').mdot!;
    expect(out[i]).toBeCloseTo((0.9 - 0.3) / 5, 6);
    expect(line('l_reg').mdot).toEqual(out);
    expect(line('l_reg_out').mdot).toEqual(out);
    expect(line('l_ctrl').mdot).toBeNull(); // the dome loader's feed
    expect(line('l_oxpress_in').mdot).toBeNull();
  });

  it('puts each tank on its gas lines and its outlet and inlet either side of the main valve', () => {
    expect(line('l_oxpress').p).toBe(r.series.ox.tank_psia);
    expect(line('l_oxvent').p).toBe(r.series.ox.tank_psia);
    expect(line('l_ox1').p).toBe(r.series.ox.outlet_psia);
    expect(line('l_ox2').p).toBe(r.series.ox.inlet_psia);
    expect(line('l_fu2').p).toBe(r.series.fuel.inlet_psia);
    expect(line('l_ox1').mdot).toBe(r.series.ox.mdot);
    expect(line('l_fu1').mdot).toBe(r.series.fuel.mdot);
    expect(line('l_oxfill').p).toBe(r.series.ox.outlet_psia); // a dead leg at the tank outlet
  });

  it('holds the dome line at the run\'s dome pressure', () => {
    expect(line('l_dome').p?.[i]).toBeCloseTo(514 + PSI_ATM, 6);
  });

  it('leaves what no series speaks for unread', () => {
    expect(line('l_gn2vent2')).toEqual({});
    expect(line('l_oxvent2')).toEqual({});
  });

  it('reads the tanks, the main valves and the engine', () => {
    const ox = v.symbols.get('OXT')!;
    expect(ox.level).toBe(r.series.ox.fill_fraction);
    expect(ox.loadedKg).toBe(6.6);
    expect(ox.T).toBe(r.series.ox.ullage_K);
    const mv = v.symbols.get('MVO')!;
    expect(mv.state?.[0]).toBeNull(); // no flow: not known shut
    expect(mv.state?.[i]).toBe(1);
    const eng = v.symbols.get('ENG')!;
    expect(eng.p?.[0]).toBeNull();
    expect(eng.p?.[i]).toBe(396);
    expect(eng.mdot?.[i]).toBeCloseTo(3.2, 9);
    expect(v.symbols.get('PT_OXU')?.reading?.unit).toBe('psia');
  });

  it('spans the bottle to the atmosphere, and knows the largest flow', () => {
    expect(v.pRange?.[1]).toBe(4510);
    expect(v.pRange?.[0]).toBeCloseTo(14.7, 6);
    expect(v.mdotMax).toBe(1.9);
    expect(v.ullageRange?.[0]).toBe(272);
  });
});

describe('buildNetView from a recorded network', () => {
  const r = standResult({ network: true, diagnostics: true });
  const v = buildNetView(d, r);

  it('reads each line from the branch of its own id', () => {
    expect(v.source).toBe('network');
    const l = v.lines.get('l_oxpress_in')!;
    expect(l.mdot?.[3]).toBe(0.017);
    expect(l.p?.[3]).toBe((598 + 597) / 2);
    expect(v.lines.get('l_ox1')?.sat?.[0]).toBe(420);
  });

  it('reads a valve\'s state and both sides', () => {
    const sv = v.symbols.get('SV_LOX_PRESS')!;
    expect(sv.state?.[0]).toBe(0);
    expect(sv.state?.[20]).toBe(1);
    expect(sv.pIn?.[0]).toBe(597);
    expect(sv.pOut?.[0]).toBe(581);
  });

  it('reads a tank from its own state (as every figure and chart does), not the network node', () => {
    const ox = v.symbols.get('OXT')!;
    expect(ox.p).toBe(r.series.ox.tank_psia);
    expect(ox.T).toBe(r.series.ox.ullage_K);
    expect(ox.liquidT?.[0]).toBe(91);
    expect(ox.level).toBe(r.series.ox.fill_fraction);
    expect(ox.sat?.[0]).toBe(420);
  });

  it('reads the bottle from its own state, not the network node a sub-step earlier', () => {
    const kb = [...v.symbols.entries()].find(([id]) => /KB|COPV|BOT/i.test(id));
    expect(kb?.[1].p).toBe(r.series.copv_psia);
  });

  it('reads the chamber node for the engine', () => {
    expect(v.symbols.get('ENG')?.p?.[0]).toBe(400);
  });

  it('puts the regulator\'s capacity on the series clock (none before it starts)', () => {
    const use = v.symbols.get('PR_D')!.use!;
    expect(use).toHaveLength(r.series.t.length);
    expect(use[0]).toBeNull();
    expect(use[20]).toBe(0.62);
  });

  it('leaves a line neither the network nor the series speaks for unread', () => {
    expect(v.lines.get('l_gn2vent2')).toEqual({});
  });

  it('fills what the network does not model from the series: the dome loader and its lines', () => {
    // The real network has no branch for PR-CTRL, l_ctrl or l_dome (they set the dome, pass no flow).
    const net = (r as unknown as { network: { branches: Record<string, unknown> } }).network;
    expect(net.branches.l_dome).toBeUndefined();
    const domeAbs = (r.provenance.derived as { dome_psig: number }).dome_psig + PSI_ATM;
    expect(v.lines.get('l_dome')?.p?.[0]).toBeCloseTo(domeAbs, 6);
    expect(v.symbols.get('PR_C')?.p?.[0]).toBeCloseTo(domeAbs, 6);
    // ...and never over a reading the network gives.
    expect(v.lines.get('l_oxpress_in')?.mdot?.[3]).toBe(0.017);
  });

  it('gives the engine no temperature: the chamber node carries the arriving liquids\' (DATA-CONTRACT 2)', () => {
    expect(v.symbols.get('ENG')?.T ?? null).toBeNull();
  });

  it('ignores a network on another clock', () => {
    const bad = standResult({ network: true });
    (bad as unknown as { network: { t: number[] } }).network.t = [0, 1];
    expect(buildNetView(d, bad).source).toBe('series');
  });

  it('ignores a failed block', () => {
    const bad = standResult();
    (bad as unknown as { network: object }).network = { available: false, error: 'boom' };
    expect(buildNetView(d, bad).source).toBe('series');
  });
});
