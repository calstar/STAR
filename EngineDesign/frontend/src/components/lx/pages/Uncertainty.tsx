import { useMemo } from 'react';
import type { SweepFactor, SweepMetric } from '../../../api/layerx';
import { UncertaintyView } from '../../layerx/Uncertainty';
import { Badge, Button, NotComputed, Panel, STATUS_GLYPH, STATUS_VAR } from '../ui';
import { NBSP, useUnits, type Units } from '../units';
import { Hint, Legacy, NotYet, Table } from './kit';
import { measureNext } from './measure';
import type { PageProps } from './Overview';

/**
 * Uncertainty asks "What don't we know, and does it matter?": the cases that break a limit at the
 * end of their range, the input to measure next (the one that moves the closest limit most),
 * and each unmeasured input swept low and high on this burn's settings (layerx/Uncertainty.tsx
 * draws the tornado until it is rebuilt here).
 */

/** A sweep output's swing in the page's units. */
function swingText(u: Units, metric: SweepMetric, v: number): string {
  switch (metric) {
    case 'ox_stiffness_min':
    case 'fuel_stiffness_min': return u.fmt(u.pct(v));
    case 'copv_end_psia': return u.fmt(u.gap(v));
    case 'ox_min_psia':
    case 'fuel_min_psia':
    case 'pc_mean_psia': return u.fmt(u.dp(v));
    case 'mean_thrust_N': return u.fmt(u.f(v));
    case 'total_impulse_Ns': return u.fmt(u.impulse(v));
    case 'burn_time_s': return u.fmt(u.time(v));
    case 'of_mean': return u.fmt(u.of(v));
  }
}

export function Uncertainty({ data, job, theme }: PageProps) {
  const u = useUnits();
  const { sweep, sweepLive, sweepResult } = job;
  const busy = !!job.activeJob;
  const next = useMemo(() => (sweepResult ? measureNext(data.limits, sweepResult) : null), [sweepResult, data.limits]);
  const labelOf = useMemo(() => {
    const m = new Map<string, SweepFactor>((sweepResult?.factors ?? []).map((f) => [f.key, f]));
    return (k: string) => m.get(k)?.label ?? k;
  }, [sweepResult]);
  const crossings = sweepResult?.crossings ?? [];
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      <Panel ariaLabel="Sweep" className="lg:col-span-12">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant={sweepResult ? 'ghost' : 'primary'} onClick={() => { void job.startSweep(); }} disabled={sweepLive || busy || !job.run}
                  title={busy ? `A ${job.activeWord} is going; the backend runs one at a time.` : undefined}>
            {sweepLive ? 'Sweeping…' : sweepResult ? 'Sweep again' : 'Sweep the unmeasured inputs'}
          </Button>
          <span className="text-[12px] text-[var(--lx-text-3)]">
            <Hint text="Each unmeasured input low and high, one at a time, in parallel. Sweeps this burn's settings on the pad and without the erosion replay, so its nominal is not this burn's headline: the band and the ranking are what to read.">
              about a minute
            </Hint>
          </span>
          {sweepLive && sweep && (
            <span className="flex min-w-[12rem] flex-1 items-center gap-3">
              <span className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--lx-line)]" role="progressbar" aria-label="Sweep progress"
                    aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(sweep.progress * 100)}>
                <span className="block h-full bg-[var(--lx-accent)] transition-[width] duration-300" style={{ width: `${Math.max(sweep.progress, 0.02) * 100}%` }} />
              </span>
              <span className="lx-num text-[12px] text-[var(--lx-text-2)]">{Math.round(sweep.progress * 100)}{NBSP}%</span>
            </span>
          )}
          {job.sweepError && <span role="alert" className="text-[12px] text-[var(--lx-bad)]">{job.sweepError}</span>}
          {sweep?.status === 'failed' && <span role="alert" className="text-[12px] text-[var(--lx-bad)]">{sweep.error}</span>}
        </div>
      </Panel>

      {sweepResult && (
        <>
          <Panel title={<Hint text="Of the limits the sweep can speak to, the closest one, and the unmeasured inputs that move it most. Measuring the top one shrinks the band where it matters.">Measure this next</Hint>}
                 className="lg:col-span-5">
            {next ? (
              <>
                <div className="text-[12px] text-[var(--lx-text-3)]">
                  for <span className="text-[var(--lx-text-2)]">{next.limit.label}</span>, the closest limit the sweep moves
                </div>
                <ol className="mt-3 space-y-2">
                  {next.factors.slice(0, 3).map(({ factor, swing }, k) => (
                    <li key={factor.key} className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-baseline gap-x-3">
                      <span className="lx-num text-[12px] text-[var(--lx-text-3)]">{k + 1}</span>
                      <Hint text={factor.basis} className={k === 0 ? 'text-[15px] text-[var(--lx-text)]' : 'text-[13px] text-[var(--lx-text-2)]'}>{factor.label}</Hint>
                      <span className="lx-num whitespace-nowrap text-[13px] text-[var(--lx-text)]">±{swingText(u, next.metric, swing)}</span>
                    </li>
                  ))}
                </ol>
              </>
            ) : <NotComputed height={96}>No graded limit moves with the swept inputs</NotComputed>}
          </Panel>
          <Panel title={<Hint text="Inputs that, at the end of their uncertainty range, push the burn past a limit. Each is a reason to measure that input before the test.">Cases that break a limit</Hint>}
                 right={<span className="lx-num">{crossings.length}</span>} className="lg:col-span-7">
            {crossings.length ? (
              <Table caption="Swept cases that break a limit" head={[{ sr: 'Input' }, 'End', 'Case', 'Breaks']} align={['l', 'l', 'l', 'l']}
                     rows={crossings.map((c) => [
                       <span key="f" className="flex items-baseline gap-2">
                         <span aria-hidden className="font-semibold" style={{ color: STATUS_VAR.bad }}>{STATUS_GLYPH.bad}</span>{labelOf(c.factor)}
                       </span>,
                       <span key="s" className="font-sans">{c.side}</span>,
                       <span key="c" className="font-sans text-[var(--lx-text-2)]">{c.case}</span>,
                       <span key="b" className="font-sans">{c.breaks.join(', ')}</span>,
                     ])} />
            ) : (
              <div className="flex min-h-[96px] items-center justify-center"><Badge status="ok">No swept case breaks a limit</Badge></div>
            )}
          </Panel>
        </>
      )}

      <Panel title="What moves the burn" className="lg:col-span-12">
        {sweepResult
          ? <Legacy theme={theme}><UncertaintyView sweep={sweepResult} /></Legacy>
          : <NotComputed>{sweepLive ? `Sweeping: ${sweep?.stage ?? ''}` : 'Not swept yet'}</NotComputed>}
      </Panel>
      <NotYet items={['off-nominal scenario presets, each graded (backend pending)']} />
    </div>
  );
}
