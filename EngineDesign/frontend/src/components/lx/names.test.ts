import { describe, expect, it } from 'vitest';
import { isRawId, nodeWords, partName, scrubIds, type NetNames } from './names';

/** The LE4 (6) burn's recorded network, the parts the ladder and acoustics name (run 20261017-091134). */
const NET: NetNames = {
  nodes: {
    node_1: { label: 'COPV', kind: 'bottle', p_psia: [] },
    node_15: { label: 'Eth-Tank ullage', kind: 'tank', p_psia: [] },
    'node_15.out': { label: 'Eth-Tank outlet', kind: 'tank_outlet', p_psia: [] },
    junc_49: { label: 'junc_49', kind: 'junction', p_psia: [] },
    node_22: { label: 'LOX-Tank ullage', kind: 'tank', p_psia: [] },
    'node_2.out': { label: 'DPR_HP outlet', kind: 'port', p_psia: [] },
    'node_23.in': { label: 'OU_SOL_R inlet', kind: 'port', p_psia: [] },
    'node_38.in': { label: 'FM-R inlet', kind: 'port', p_psia: [] },
    'node_38.out': { label: 'FM-R outlet', kind: 'port', p_psia: [] },
    'node_36.fuel': { label: 'Injector inlet (fuel)', kind: 'injector_inlet', p_psia: [] },
    'node_36.chamber': { label: 'Chamber', kind: 'chamber', p_psia: [] },
  },
  branches: {
    node_38: { label: 'FM-R', kind: 'valve', from: 'node_38.in', to: 'node_38.out', mdot: [], dp_psi: [] },
  },
};

describe('feed parts by the names on the drawing', () => {
  it('names each line by the drawn tags at its ends, never by graph ids', () => {
    expect(partName(NET, { id: 'node_2-junc_49', label: 'node_2-junc_49', kind: 'line', from: 'node_2.out', to: 'junc_49' })).toBe('DPR_HP → tee');
    expect(partName(NET, { id: 'junc_49-junc_48', label: 'junc_49-junc_48', kind: 'line', from: 'junc_49', to: 'node_23.in' })).toBe('tee → OU_SOL_R');
    expect(partName(NET, { id: 'node_15-node_38', label: 'node_15-node_38', kind: 'line', from: 'node_15.out', to: 'node_38.in' })).toBe('Eth-Tank → FM-R');
    expect(partName(NET, { id: 'node_38-node_36', label: 'node_38-node_36', kind: 'line', from: 'node_38.out', to: 'node_36.fuel' })).toBe('FM-R → injector');
  });

  it('names a line from its id alone (the acoustics table carries no ends)', () => {
    expect(partName(NET, { label: 'node_38-node_36' })).toBe('FM-R → injector');
    expect(partName(NET, { label: 'node_15 outlet -> injector (whole path)' })).toBe('Eth-Tank outlet → injector (whole path)');
  });

  it('keeps a tag the drawing gives, and words the injector halves', () => {
    expect(partName(NET, { id: 'node_37', label: 'OM-R', kind: 'valve' })).toBe('OM-R');
    expect(partName(NET, { id: 'x:dump', label: 'ox injector manifold dump (Borda exit)', kind: 'dump' })).toBe('Into the manifold');
    expect(partName(NET, { id: 'x:orifice', label: 'ox injector orifices (manifold -> chamber)', kind: 'orifice' })).toBe('Injector orifices');
  });

  it('never lets an id through, even with no network to read', () => {
    for (const s of [partName(null, { label: 'node_2-junc_49', kind: 'line' }), nodeWords(null, 'node_99'), scrubIds(null, 'vented through node_8')]) {
      expect(s).not.toMatch(/\b(?:node|junc)_\d/);
    }
    expect(isRawId('node_15')).toBe(true);
    expect(isRawId('LOX-Tank')).toBe(false);
  });
});
