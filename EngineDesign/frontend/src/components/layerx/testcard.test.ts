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
                  derived: { gauge_zero_pa: 14.696 * PSI, ambient_pa: 13.6 * PSI, target_lockup_psia: 578, dome_psig: 513.6, dome_psia: 528.3, copv_psig: 4500, copv_psia: 4514.7,
                             roles: { oxidiser: 'OXT', fuel: 'FUT' }, tank_mawp_psi: { OXT: 764.696, FUT: 1000 }, loads_kg: { OXT: 6.61, FUT: 4.4 },
                             stiffness_band: { oxidiser: [0.2, 0.4], fuel: [0.2, 0.4] } } },
  } as unknown as LayerXResult;
}

describe('the test card', () => {
  const html = testCardHtml(result(), { id: 'r1', started: 0, settings: {}, meta: { name: 'Hotfire 3 <prediction>' } } as unknown as RunView, { PT_OXD: 'PT_ODP' });

  it('says what to dial in psia, with the DAQ\u2019s gauge figure beside it', () => {
    expect(html).toContain('528.3 psia');                   // dome
    expect(html).toContain('513.6 psig on the DAQ');
    expect(html).toContain('578.0 psia');                   // lockup
    expect(html).toContain('563.3 psig on the DAQ');        // 578 less 14.696
    expect(html).toContain('4,515 psia');
    expect(html).not.toMatch(/class="big">[^<]*psig/);     // nothing a person dials is headlined gauge
  });

  it('pairs each instrument with its DAQ channel, in psia with the gauge reading under it', () => {
    expect(html).toMatch(/PT-OX-DN<\/td><td>PT_ODP<\/td><td class="u">psia<\/td><td class="n">15<div class="g">0 g<\/div><\/td><td class="n">560<div class="g">545 g<\/div><\/td>/);
  });

  it('puts the tank redline at the drawing\u2019s MAWP, not 14.7 psi above it', () => {
    // A drawn "MAWP 750 psi" is gauge; prepare.py hands it over absolute: 764.696 psia. That is
    // where the twin trips the stand. It used to print as "765 psig" -- 14.7 psi over the limit.
    expect(html).toContain('<td class="n">764.7 psia</td><td>MAWP 750 psi on the drawing');
    expect(html).not.toContain('765 psig');
  });

  it('says when the trip is a burst rating over the safety factor, not an MAWP', () => {
    // LE4 (3) rates its tanks by burst pressure (1500 psi, estimated); the twin trips them at 1500/2
    // across the wall, 764.7 psia (prepare.vessel_trip). Calling that "MAWP 750 psi on the drawing" misread the drawing.
    const r = result();
    (r.provenance.derived as Record<string, unknown>).vessel_ratings = {
      OXT: { basis: 'burst', rating_psig: 1500, safety_factor: 2, source: 'estimated', trip_psia: 764.696 },
    };
    const card = testCardHtml(r, { id: 'r1', started: 0, settings: {}, meta: {} } as unknown as RunView, {});
    expect(card).toContain('<td class="n">764.7 psia</td><td>burst 1,500 psi on the drawing over a safety factor of 2.0 (estimated)');
    expect(card).toContain('<td class="n">1,000.0 psia</td><td>MAWP 985 psi on the drawing');   // the fuel tank: an MAWP
  });

  it('prints the graded chug margin, not the replay’s config-basis one', () => {
    // LE4 (3): graded 1.004 on the drawing's lines (diagnostics.stability), 1.21 on EngineDesign's feed_system.
    const r = result();
    (r as unknown as Record<string, unknown>).delivered = { summary: { chug_margin_min: 1.2057, chug_margin_min_t: 0.45 } };
    (r as unknown as Record<string, unknown>).limits = [{ key: 'chug_margin', label: 'Chug margin', value: 1.0043, t_worst: 0.3, grade: 'warn',
      basis: 'EngineDesign double-time-lag chug model, drawing feed basis, from the first full-flow step' }];
    const card = testCardHtml(r, { id: 'r1', started: 0, settings: {}, meta: {} } as unknown as RunView, {});
    expect(card).toContain('predicted lowest 1.00 at 0.30 s, on the drawing’s feed lines');
    expect(card).not.toContain('1.21');
    // A run with no graded margin says the replay's figure is EngineDesign's feed, not the drawing's.
    (r as unknown as Record<string, unknown>).limits = [];
    const old = testCardHtml(r, { id: 'r1', started: 0, settings: {}, meta: {} } as unknown as RunView, {});
    expect(old).toContain('predicted lowest 1.21 at 0.45 s, on EngineDesign’s feed_system');
  });

  it('draws the other lines in psia, and escapes what people typed', () => {
    expect(html).toContain('≥ 678 psia');                   // bottle: lockup + 100 psi
    expect(html).toContain('≥ 458 psia');                   // injector: 382 psia chamber x 1.2
    expect(html).not.toMatch(/\d psig<\/td>/);             // no redline in gauge
    expect(html).toContain('Hotfire 3 &lt;prediction&gt;');
  });
});
