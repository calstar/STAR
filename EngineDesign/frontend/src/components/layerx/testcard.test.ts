import { describe, expect, it } from 'vitest';
import type { LayerXResult, RunView } from '../../api/layerx';
import { EMPTY_SERIES, PSI } from './format';
import { testCardHtml } from './testcard';

function result(): LayerXResult {
  const series = {
    ...EMPTY_SERIES, t: [-0.05, 0.5, 1.0, 2.0, 3.5], firing: [false, true, true, true, true],
    chamber: { ...EMPTY_SERIES.chamber, thrust_N: [0, 6700, 6720, 6750, 6900] },
    instruments: { PT_OXD: { tag: 'PT-OX-DN', type: 'PT', unit: 'psia' as const, values: [14.696, 560, 559, 557, 550] } },
  };
  return {
    series,
    summary: { burn_time_s: 3.5, depleted_side: 'oxidiser', total_impulse_Ns: 24000, mean_thrust_N: 6700, pc_mean_psia: 382,
               of_mean: 1.52, isp_mean_s: 224, copv_end_psia: 1200,
               ox: { peak_psia: 600, dp_injector_min_psi: 135 }, fuel: { peak_psia: 601, dp_injector_min_psi: 128 } },
    provenance: { drawing: { id: 'd', name: 'stand', sha256: 'abc' }, config_sha256: 'f'.repeat(64),
                  settings: { dry_kg: 0.001, ullage_collapse: false, ullage_vapour: false, line_walls: false },
                  derived: { gauge_zero_pa: 14.696 * PSI, ambient_pa: 13.6 * PSI, target_lockup_psia: 578, dome_psig: 513.6, copv_psig: 4500,
                             roles: { oxidiser: 'OXT', fuel: 'FUT' }, tank_mawp_psi: { OXT: 1000, FUT: 1000 }, loads_kg: { OXT: 6.61, FUT: 4.4 },
                             stiffness_band: { oxidiser: [0.2, 0.4], fuel: [0.2, 0.4] } } },
  } as unknown as LayerXResult;
}

describe('the test card', () => {
  const html = testCardHtml(result(), { id: 'r1', started: 0, settings: {}, meta: { name: 'Hotfire 3 <prediction>' } } as unknown as RunView, { PT_OXD: 'PT_ODP' });

  it('says what to dial, as the gauges read', () => {
    expect(html).toContain('513.6 psig');                   // dome
    expect(html).toContain('563.3 psig');                   // lockup 578 psia less 14.696
    expect(html).toContain('4,500 psig');
  });

  it('pairs each instrument with its DAQ channel and gives its readings in gauge', () => {
    expect(html).toMatch(/PT-OX-DN<\/td><td>PT_ODP<\/td><td class="u">psig<\/td><td class="n">0<\/td><td class="n">545<\/td>/);
  });

  it('draws the lines from the drawing and the design, and escapes what people typed', () => {
    expect(html).toContain('≥ 663 psig');                   // bottle: lockup + 100 psi, gauge
    expect(html).toContain('999 psig');                     // MAWP 1000 across the wall at 13.6 psia ambient: 1013.6 psia, 998.9 psig
    expect(html).toContain('Hotfire 3 &lt;prediction&gt;');
  });
});
