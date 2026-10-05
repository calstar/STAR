import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LayerXResult, SweepResult } from '../../../api/layerx';
import { withContract } from '../dev/contractFixture';
import { result } from '../dev/testRun';
import { TimeProvider } from '../time/TimeProvider';
import { createTimeStore } from '../time/store';
import { DEFAULT_SYSTEM, UnitsProvider } from '../units';
import type { LayerXJob } from '../useLayerXJob';
import { deriveRunData } from '../useRunData';
import { Engine } from './Engine';
import { Feed } from './Feed';
import { Flight } from './Flight';
import { Hardware } from './Hardware';
import { Overview, type PageProps } from './Overview';
import { Record as RecordPage } from './Record';
import { Stand } from './Stand';
import { Uncertainty } from './Uncertainty';

/**
 * Every Burn page drawn (on the server: no DOM, no effects) for an old run that carries none of the
 * DATA-CONTRACT keys and for one that carries all of them: neither may throw, an old run shows the
 * quiet placeholders, a full one the panels, and a failed block its own reason.
 */

// FeedFit pulls in the shared design-tool UI, which this suite's config does not alias; the Record
// page's injector-feed block is the old one, drawn inside a Legacy wrapper, and not under test here.
vi.mock('../../layerx/FeedFit', () => ({ FeedFitView: () => null, FeedFitSummary: () => null }));

const PAGES: [string, (p: PageProps) => ReactElement][] = [
  ['overview', (p) => <Overview {...p} />], ['feed', (p) => <Feed {...p} />], ['engine', (p) => <Engine {...p} />],
  ['hardware', (p) => <Hardware {...p} />], ['flight', (p) => <Flight {...p} />], ['stand', (p) => <Stand {...p} />],
  ['uncertainty', (p) => <Uncertainty {...p} />], ['record', (p) => <RecordPage {...p} />],
];

function jobOf(over: Partial<LayerXJob> = {}): LayerXJob {
  return {
    run: { id: 'r1', status: 'done', stage: '', progress: 1, error: null, started: 0, finished: 1, design: '', settings: {}, meta: null },
    sweep: null, sweepLive: false, sweepResult: null, sweepError: null, activeJob: null, activeWord: 'run', exportError: null,
    designMoved: false, designUnknown: false, whatIf: null,
    startSweep: async () => {}, printTestCard: async () => {}, annotate: async () => null, deleteRun: async () => null,
    exportCsv: () => {}, exportEng: async () => {},
    ...over,
  } as unknown as LayerXJob;
}

function draw(page: (p: PageProps) => ReactElement, r: LayerXResult, t = 0.15, job = jobOf()): string {
  const data = deriveRunData(r);
  const store = createTimeStore();
  store.setSeries(data.t);
  store.setT(t);
  store.flush();
  return renderToStaticMarkup(
    <UnitsProvider initial={DEFAULT_SYSTEM} persist={false}>
      <TimeProvider store={store}>{page({ data, vs: null, vsLabel: null, job, theme: 'dark' })}</TimeProvider>
    </UnitsProvider>,
  );
}

describe('the Burn pages', () => {
  it.each(PAGES)('%s draws an old run and a full one', (_name, page) => {
    expect(() => draw(page, result())).not.toThrow();
    expect(() => draw(page, withContract(result()))).not.toThrow();
  });

  it('Feed: an old run names what it lacks in one line; a full run draws the panels', () => {
    const feed = PAGES[1][1];
    const old = draw(feed, result());
    expect(old).toContain('Not computed for this run:');
    expect(old).toContain('press solenoids');
    expect(old).toContain('coarse: lockup to chamber');
    const full = draw(feed, withContract(result()));
    expect(full).toContain('Press solenoids');
    expect(full).toContain('Opening surge');
    expect(full).not.toContain('press solenoids');
    expect(full).not.toContain('coarse: lockup to chamber');
    // The ladder from the diagnostics, bottle first.
    expect(full).toContain('Regulator outlet');
  });

  it('Feed: a failed block keeps its panel and says why', () => {
    const html = draw(PAGES[1][1], withContract(result(), { failed: ['water_hammer', 'ladder'] }));
    expect(html).toContain('Not computed: fixture: water_hammer failed on purpose');
    // The ladder falls back to the recorded network's path rather than vanishing...
    expect(html).not.toContain('coarse: lockup to chamber');
    expect(html).toContain('LOX tank');
    // ...and to the coarse one with no network either.
    const bare = withContract(result(), { failed: ['ladder'] }) as unknown as Record<string, unknown>;
    delete bare.network;
    expect(draw(PAGES[1][1], bare as unknown as LayerXResult)).toContain('coarse: lockup to chamber');
  });

  it('Engine: the stability panels only with the diagnostics', () => {
    const engine = PAGES[2][1];
    const old = draw(engine, result());
    expect(old).not.toContain('Nyquist locus of the chug loop');
    expect(old).toContain('chug frequency, Nyquist locus, lag sensitivity and line acoustics');
    const full = draw(engine, withContract(result()));
    expect(full).toContain('Nyquist locus of the chug loop');
    expect(full).toContain('Line acoustics');
    expect(full).toContain('Start and shutdown');
    expect(full).toContain('Where the Isp goes');
  });

  it('Overview: the trip is the verdict', () => {
    const r = withContract(result()) as unknown as Record<string, unknown>;
    r.tripped = { vessel: 'LOX tank', t: 0.2, p_psia: 1100, mawp_psia: 1014.7 };
    const html = draw(PAGES[0][1], r as unknown as LayerXResult);
    expect(html).toContain('The stand tripped');
    expect(html).toContain('LOX tank at 1,100');
  });

  it('Stand: the cold-flow modes wait on the backend until a run carries a test mode', () => {
    const stand = PAGES[5][1];
    expect(draw(stand, result())).toContain('cold flow: backend pending');
    const r = result() as unknown as Record<string, unknown>;
    r.test_mode = 'coldflow_ln2';
    const html = draw(stand, r as unknown as LayerXResult);
    expect(html).not.toContain('cold flow: backend pending');
    expect(html).toMatch(/aria-checked="true"[^>]*>LOX \/ LN2 cold flow/);
  });

  it('Uncertainty: names the input to measure next and the cases that break a limit', () => {
    const sweep = {
      nominal: {}, nominal_thrust: [], band: {}, notes: [], cases: 4, workers: 2, wall_s: 60, basis: '',
      factors: [
        { key: 'cd_f', label: 'Fuel orifice Cd', group: 'engine', basis: '', cases: {}, swing: { fuel_stiffness_min: 0.04 } },
        { key: 'droop', label: 'Regulator droop', group: 'feed', basis: '', cases: {}, swing: { fuel_stiffness_min: 0.01, copv_end_psia: 80 } },
      ],
      crossings: [{ factor: 'cd_f', side: 'low', case: 'Cd −3 %', breaks: ['fuel ΔP/Pc'] }],
    } as unknown as SweepResult;
    const html = draw(PAGES[6][1], result(), 0.15, jobOf({ sweepResult: sweep }));
    expect(html).toContain('Measure this next');
    // The test run's closest sweepable limit is the fuel ΔP/Pc; the Cd moves it most.
    expect(html.indexOf('Fuel orifice Cd')).toBeLessThan(html.indexOf('Regulator droop'));
    expect(html).toContain('Cd −3 %');
  });
});
