import { describe, expect, it } from 'vitest';
import type { ChangeList } from '../../../../api/layerx';
import { DEFAULT_SYSTEM, makeUnits } from '../../units';
import { changeListFilename, changeListJson, changeRows, effectRows, figureDelta, plainText, rowEffect, worstCad } from './changes';

const u = makeUnits(DEFAULT_SYSTEM);
const effect = { mean_thrust_N: 186.09, of_mean: -0.000567, burn_time_s: -0.0761, copv_end_psia: -931.9 };

/** The LE4 he set point at 7,200 N (scratchpad api/setpoint.json, 2026-10-03), trimmed. */
const SETPOINT: ChangeList = {
  schema: 'layerx.change-list/1', tool: 'setpoint',
  changes: [
    { component: 'Dome loader (the dial)', pid_node_id: 'PR_C', field: 'dome_psig', before: 513.55, after: 516.05, unit: 'psig', provenance: 'solved',
      effect, cad_impact: 'setting only', target: 'op:dome_psig', domain: 'operation', label: 'Dome loader (the dial) dome_psig', source: 'solved' },
    { component: 'Bottle fill', pid_node_id: 'KB1', field: 'copv_psig', before: 4500, after: 3482.74, unit: 'psig', provenance: 'solved',
      effect, cad_impact: 'setting only', target: 'op:copv_psig', domain: 'operation', source: 'solved' },
  ],
  effects: [
    { key: 'mean_thrust_N', label: 'Mean thrust', unit: 'N', before: 7013.38, after: 7199.47, delta: 186.09 },
    { key: 'of_mean', label: 'O/F', unit: '', before: 1.52109, after: 1.52053, delta: -0.000567 },
    { key: 'burn_time_s', label: 'Burn time', unit: 's', before: 3.4562, after: 3.3801, delta: -0.0761 },
    { key: 'ox_stiffness_min', label: 'LOX injector ΔP/Pc, lowest', unit: '', before: 0.36344, after: 0.37177, delta: 0.0083 },
    { key: 'copv_end_psia', label: 'Bottle at burnout', unit: 'psia', before: 1646.3, after: 714.35, delta: -931.9 },
    { key: 'dome_psig', label: 'Dome dial', unit: 'psig', before: 513.55, after: 516.05, delta: 2.5 },
  ],
  exports: { settings_patch: { tank_pressure_psia: 597.79, copv_pressure_psig: 3482.74 } },
};

describe('the change list as a diff', () => {
  it('prints each change in the units the stand reads, with its sign, its node and its CAD impact', () => {
    const rows = changeRows(SETPOINT);
    expect(rows.map((r) => [r.component, r.node, r.field, r.before, r.after, r.change, r.cad])).toEqual([
      ['Dome loader (the dial)', 'PR_C', 'dome dial', '513.6 psig', '516.1 psig', '+2.500 psig', 'setting only'],
      ['Bottle fill', 'KB1', 'bottle fill', '4,500 psig', '3,483 psig', '−1,017 psig', 'setting only'],
    ]);
  });

  it('reads a unit-free field without a unit, and a component from a label that carries its field', () => {
    const r = changeRows({ changes: [{ ...SETPOINT.changes[0], component: '', label: 'Trim orifice in l_ox1 K_minor', field: 'K_minor', before: 0.5, after: 0.7196, unit: '-', pid_node_id: null }] })[0];
    expect(r.component).toBe('Trim orifice in l_ox1');
    expect(r.after).toBe('0.7196');
    expect(r.node).toBeNull();
  });

  it('names the worst CAD impact on the list', () => {
    expect(worstCad(SETPOINT)).toBe('setting only');
    expect(worstCad({ changes: [...SETPOINT.changes, { ...SETPOINT.changes[0], cad_impact: 'new part' }] })).toBe('new part');
    expect(worstCad({ changes: [] })).toBeNull();
  });

  it('gives the figures in the page units, the dials left to the rows', () => {
    const e = effectRows(u, SETPOINT);
    expect(e.map((x) => x.key)).not.toContain('dome_psig');
    const thrust = e.find((x) => x.key === 'mean_thrust_N')!;
    expect([thrust.before, thrust.after, thrust.change]).toEqual(['7,013 N', '7,199 N', '+186 N']);
    expect(e.find((x) => x.key === 'ox_stiffness_min')!.after).toBe('37.2 %');
    expect(e.find((x) => x.key === 'copv_end_psia')!.change).toBe('−932 psia');
    // In SI the same figure reads in bar: the list follows the page's units.
    const si = makeUnits({ ...DEFAULT_SYSTEM, pressure: 'bar' });
    expect(effectRows(si, SETPOINT).find((x) => x.key === 'copv_end_psia')!.after).toMatch(/bar/);
  });

  it('writes a row\'s effect on the key figures, signed, at their resolution', () => {
    expect(rowEffect(u, SETPOINT, SETPOINT.changes[0])).toBe('+186 N · ±0.00 O/F · −0.08 s');
    expect(figureDelta(u, 'mean_thrust_N', 'N', null, 1)).toBe('—');
  });

  it('exports the list as the backend wrote it, with where it came from', () => {
    const j = JSON.parse(changeListJson(SETPOINT, { runId: 'r1', tool: 'setpoint', design: 'Ethalox 7200N Doublet', drawing: 'copv_study_he' }));
    expect(j.schema).toBe('layerx.change-list/1');
    expect(j.changes).toHaveLength(2);
    expect(j.source).toEqual({ run: 'r1', tool: 'setpoint', design: 'Ethalox 7200N Doublet', drawing: 'copv_study_he' });
    expect(changeListFilename('setpoint', 'r1')).toBe('layerx-setpoint-changes-r1.json');
    expect(plainText(null)).toBe('—');
  });
});
