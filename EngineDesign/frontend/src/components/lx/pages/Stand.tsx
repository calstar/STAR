import { MeasuredView } from '../../layerx/Measured';
import { testModeOf, type TestMode } from '../contract';
import { Button, Panel, Segmented } from '../ui';
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
  const mode = testModeOf(data.result);
  // The backend writes result.test_mode once it can run the cold-flow modes; until then every run
  // is a hot fire and the other modes wait on it. A run's mode is set before it runs, so the
  // choice here shows what this run is rather than changing it.
  const supported = mode !== null;
  const value: TestMode = mode ?? 'hotfire';
  const instruments = Object.keys(data.result.series.instruments ?? {}).length;
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      <Panel ariaLabel="Test card" className="lg:col-span-12">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented ariaLabel="Test mode" value={value} onChange={() => {}}
                     options={MODES.map((m) => ({
                       ...m,
                       disabled: m.value !== value,
                       title: m.value === value ? 'This run' : supported ? 'Set before the run, in the rail' : 'Backend pending',
                     }))} />
          {!supported && (
            <span className="text-[12px] text-[var(--lx-text-3)]">
              <Hint text="The feed model runs hot fires today. LOX/LN2 and water cold flows need the backend's test modes (result.test_mode); the choice opens when a run carries one.">
                cold flow: backend pending
              </Hint>
            </span>
          )}
          <span className="ml-auto flex flex-wrap items-center gap-3">
            {job.exportError && <span role="alert" className="text-[12px] text-[var(--lx-bad)]">{job.exportError}</span>}
            <Button variant="primary" onClick={() => { void job.printTestCard(); }}
                    title="What to dial, what each channel should read and when, and the lines not to cross. One page.">
              Print test card
            </Button>
          </span>
        </div>
      </Panel>
      <Panel title="Measured against predicted" className="lg:col-span-12"
             right={(
               <>
                 <span className="lx-num">{instruments} instruments on the drawing</span>
                 <Button size="sm" disabled title="Fit the model's unmeasured inputs to a measured run: backend pending">Calibrate</Button>
               </>
             )}>
        <Legacy theme={theme} className="lx-measured">
          <MeasuredView result={data.result} />
        </Legacy>
      </Panel>
    </div>
  );
}
