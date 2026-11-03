import { MeasuredView } from '../../layerx/Measured';
import { testModeOf, type TestMode } from '../contract';
import { Button, Panel } from '../ui';
import { Hint, Legacy } from './kit';
import type { PageProps } from './Overview';

/**
 * Stand asks "What should the stand read, and did it?": which kind of test the run is (hot fire,
 * LOX/LN2 cold flow, water and nitrogen), its test card, and each instrument on the drawing against
 * its DAQ channel, predicted then measured (layerx/Measured.tsx, until it is rebuilt here).
 */

const MODES: { value: TestMode; label: string }[] = [
  { value: 'hotfire', label: 'Hot fire' },
  { value: 'coldflow_ln2', label: 'LOX / LN2 cold flow' },
  { value: 'coldflow_water', label: 'Water + N2' },
];

export function Stand({ data, job, theme }: PageProps) {
  // Which test this run is. Every run is a hot fire until the rail can set a cold flow, so the page
  // names the run's own mode and offers no choice it cannot act on.
  const mode: TestMode = testModeOf(data.result) ?? 'hotfire';
  const instruments = Object.keys(data.result.series.instruments ?? {}).length;
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      <Panel ariaLabel="Test card" className="lg:col-span-12">
        <div className="flex flex-wrap items-center gap-3">
          <Hint text="The test this run predicts: what the stand is loaded with and what it fires.">
            <span className="text-[13px] font-medium text-[var(--lx-text)]">{MODES.find((m) => m.value === mode)?.label ?? 'Hot fire'}</span>
          </Hint>
          <span className="ml-auto flex flex-wrap items-center gap-3">
            {job.exportError && <span role="alert" className="text-[12px] text-[var(--lx-bad)]">{job.exportError}</span>}
            <Button variant="primary" onClick={() => { void job.printTestCard(); }}
                    title="What to dial, what each channel should read and when, and the lines not to cross. One page.">
              Print test card
            </Button>
          </span>
        </div>
      </Panel>
      <Panel title={<Hint text="Each transducer on the drawing: what it should read at T-0, one second into the burn and at burnout. Pick the DAQ channel that records it, load a DAQ export, and each row shows the measured reading against the prediction.">Measured against predicted</Hint>}
             className="lg:col-span-12"
             right={<span className="lx-num">{instruments} instruments on the drawing</span>}>
        <Legacy theme={theme} className="lx-measured">
          <MeasuredView result={data.result} />
        </Legacy>
      </Panel>
    </div>
  );
}
