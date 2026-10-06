import { useState, type ReactNode } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import type { TimeSeriesData } from '../../api/client';
import type { ForwardReport, Quantity, Section, Status, Verdict } from '../../lib/forwardReport';
import { burnRange, fmt, sectionSummary, MEASURABLE } from '../../lib/forwardReport';
import type { MeasuredValue } from '../../lib/forwardReport';
import { Hint } from '../Hint';

/**
 * Forward mode's result. Everything on it is engine/pipeline/forward_report.py's: this lays it out
 * and never computes or grades a number.
 *
 *   headline   six numbers; the burn's range beneath when a Time-Series run exists
 *   verdicts   the four checks the backend graded
 *   burn       the Time-Series run over time, one shared cursor
 *   sections   one line each, open for the rest; Stability opens onto the full panel
 *
 * ◇ marks a number that rests on an input nobody has measured; hovering says which.
 */

const STATUS_COLOR: Record<Status, string> = {
  ok: 'var(--color-success)',
  warn: 'var(--color-warning)',
  bad: 'var(--color-danger)',
  unknown: 'var(--color-text-secondary)',
};

const SANS = { fontFamily: 'Inter, system-ui, sans-serif' };

/** ◇ when a number rests on an input nobody has measured; ● when everything under it is measured. */
function Assumed({ keys, calibration }: { keys: string[]; calibration: ForwardReport['calibration'] }) {
  if (!keys.length) return null;
  const open = keys.filter((k) => calibration[k]?.state !== 'measured');
  if (!open.length) {
    return (
      <Hint text={<>Measured: {keys.map((k) => calibration[k]?.label ?? k).join(', ')}.</>}>
        <span className="ml-1 text-[9px] leading-none text-[var(--color-success)] cursor-help" aria-label="measured inputs">●</span>
      </Hint>
    );
  }
  return (
    <Hint text={<>Rests on {open.map((k) => calibration[k]?.label ?? k).join(', ')}: not measured yet.</>}>
      <span className="ml-1 text-[11px] leading-none text-[var(--color-text-secondary)] cursor-help" aria-label="rests on unmeasured inputs">◇</span>
    </Hint>
  );
}

function Headline({ report, burn }: { report: ForwardReport; burn: TimeSeriesData | null }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-x-8 gap-y-6">
      {report.headline.map((q) => {
        const r = burnRange(q.key, burn);
        return (
          <div key={q.key} className="min-w-0">
            <Hint text={q.basis}>
              <span className="text-xs text-[var(--color-text-secondary)]">{q.label}</span>
            </Hint>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-[2rem] leading-none font-semibold tracking-tight text-[var(--color-text-primary)] tabular-nums">
                {fmt(q.value, q.digits)}
              </span>
              {q.unit && <span className="text-sm text-[var(--color-text-secondary)]">{q.unit}</span>}
              <Assumed keys={q.assumed} calibration={report.calibration} />
            </div>
            {r && (
              <div className="mt-1.5 text-[11px] text-[var(--color-text-muted)] tabular-nums">
                over the burn {fmt(r[0], q.digits)}–{fmt(r[1], q.digits)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Verdicts({ verdicts, calibration }: { verdicts: Verdict[]; calibration: ForwardReport['calibration'] }) {
  return (
    <div className="flex flex-wrap gap-x-7 gap-y-2">
      {verdicts.map((v) => (
        <Hint key={v.key} text={<>{v.basis}. Passes at {v.threshold}.</>}>
          <span className="inline-flex items-center gap-2 text-sm">
            <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[v.status] }} />
            <span className="text-[var(--color-text-secondary)]">{v.label}</span>
            <span className="tabular-nums font-medium" style={{ color: v.status === 'ok' ? 'var(--color-text-primary)' : STATUS_COLOR[v.status] }}>
              {fmt(v.value, v.digits)}{v.unit && v.unit !== '×' ? ` ${v.unit}` : v.unit}
            </span>
            <Assumed keys={v.assumed} calibration={calibration} />
          </span>
        </Hint>
      ))}
    </div>
  );
}

const BURN_PLOTS: { key: keyof TimeSeriesData; label: string; unit: string; digits: number; also?: keyof TimeSeriesData }[] = [
  { key: 'P_tank_O_psi', also: 'P_tank_F_psi', label: 'Tank pressure', unit: 'psi', digits: 0 },
  { key: 'Pc_psi', label: 'Chamber pressure', unit: 'psia', digits: 0 },
  { key: 'MR', label: 'O/F', unit: '', digits: 3 },
  { key: 'thrust_kN', label: 'Thrust', unit: 'kN', digits: 2 },
];

function Burn({ burn, when }: { burn: TimeSeriesData; when: number | null }) {
  const rows = burn.time.map((t, i) => {
    const row: Record<string, number> = { t };
    for (const p of BURN_PLOTS) {
      row[p.key as string] = (burn[p.key] as number[])[i];
      if (p.also) row[p.also as string] = (burn[p.also] as number[])[i];
    }
    return row;
  });
  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <span className="text-sm font-medium text-[var(--color-text-primary)]">Over the burn</span>
        <span className="text-[11px] text-[var(--color-text-muted)]">
          from the Time-Series tab{when ? `, run ${new Date(when).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5">
        {BURN_PLOTS.map((p) => (
          <div key={p.key as string}>
            <div className="text-xs text-[var(--color-text-secondary)] mb-1">
              {p.label}{p.unit ? <span className="text-[var(--color-text-muted)]"> {p.unit}</span> : null}
              {p.also && <span className="text-[var(--color-text-muted)]"> · <span style={{ color: '#7dd3fc' }}>LOX</span> <span style={{ color: '#fdba74' }}>fuel</span></span>}
            </div>
            <ResponsiveContainer width="100%" height={112}>
              <LineChart data={rows} syncId="burn" margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickCount={4} axisLine={false} tickLine={false}
                       tick={{ fill: 'var(--color-text-muted)', fontSize: 10 }} tickFormatter={(v: number) => `${fmt(v, 0)} s`} height={18} />
                <YAxis domain={['auto', 'auto']} width={38} tick={{ fill: 'var(--color-text-muted)', fontSize: 10 }}
                       tickFormatter={(v: number) => fmt(v, p.digits > 1 ? 1 : 0)} axisLine={false} tickLine={false} tickCount={3} />
                <Tooltip
                  cursor={{ stroke: 'var(--color-text-secondary)', strokeWidth: 1 }}
                  contentStyle={{ background: 'var(--color-bg-tertiary)', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 11 }}
                  labelFormatter={(t: number) => `t = ${fmt(t, 2)} s`}
                  formatter={(v: number, name: string) => [fmt(v, p.digits), name === p.also ? 'fuel' : p.also ? 'LOX' : p.label]}
                />
                <Line type="monotone" dataKey={p.key as string} dot={false} strokeWidth={1.6}
                      stroke={p.also ? '#7dd3fc' : 'var(--color-text-primary)'} isAnimationActive={false} />
                {p.also && <Line type="monotone" dataKey={p.also as string} dot={false} strokeWidth={1.6} stroke="#fdba74" isAnimationActive={false} />}
              </LineChart>
            </ResponsiveContainer>
          </div>
        ))}
      </div>
    </div>
  );
}

function QuantityCell({ q, calibration }: { q: Quantity; calibration: ForwardReport['calibration'] }) {
  const warn = q.status && q.status !== 'ok' && q.status !== 'unknown';
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <Hint text={q.basis || q.label}>
        <span className="text-[13px] text-[var(--color-text-secondary)]">{q.label}</span>
      </Hint>
      <span className="text-[13px] tabular-nums whitespace-nowrap" style={{ color: warn ? STATUS_COLOR[q.status!] : 'var(--color-text-primary)' }}>
        {fmt(q.value, q.digits)}
        {q.unit && <span className="ml-1 text-[var(--color-text-muted)]">{q.unit}</span>}
        <Assumed keys={q.assumed} calibration={calibration} />
      </span>
    </div>
  );
}

function SectionRow({ section, calibration, open, onToggle, children }: {
  section: Section; calibration: ForwardReport['calibration']; open: boolean; onToggle: () => void; children?: ReactNode;
}) {
  // The summary line stays in view when open, so the grid carries everything else: one click
  // opens the whole section.
  const shown = section.quantities.filter((q) => !section.summary.includes(q.key));
  return (
    <div className="border-t border-[var(--color-border)]">
      <button type="button" onClick={onToggle} aria-expanded={open}
              className="flex w-full items-center gap-6 py-3.5 text-left focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--color-accent)]">
        <span className="w-40 shrink-0 text-sm font-medium text-[var(--color-text-primary)]">{section.title}</span>
        <span className="flex min-w-0 flex-1 flex-wrap gap-x-6 gap-y-1">
          {sectionSummary(section).map((q) => (
            <span key={q.key} className="text-[13px] whitespace-nowrap">
              <span className="text-[var(--color-text-muted)]">{q.label} </span>
              <span className="tabular-nums" style={{ color: q.status && q.status !== 'ok' && q.status !== 'unknown' ? STATUS_COLOR[q.status] : 'var(--color-text-primary)' }}>
                {fmt(q.value, q.digits)}{q.unit ? ` ${q.unit}` : ''}
              </span>
              <Assumed keys={q.assumed} calibration={calibration} />
            </span>
          ))}
        </span>
        <svg className={`h-4 w-4 shrink-0 text-[var(--color-text-muted)] transition-transform ${open ? 'rotate-90' : ''}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M6 4l4 4-4 4" />
        </svg>
      </button>
      {open && (
        <div className="pb-5 pl-0 sm:pl-46">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12">
            {shown.map((q) => <QuantityCell key={q.key} q={q} calibration={calibration} />)}
          </div>
          {children && <div className="mt-5">{children}</div>}
        </div>
      )}
    </div>
  );
}

function IndependentCheck({ hc }: { hc: NonNullable<ForwardReport['handcheck']> }) {
  return (
    <table className="w-full text-[12px] tabular-nums">
      <thead>
        <tr className="text-left text-[var(--color-text-muted)]">
          <th className="py-1 font-normal">Quantity</th>
          <th className="py-1 font-normal text-right">Model</th>
          <th className="py-1 font-normal text-right">By hand / bound</th>
          <th className="py-1 font-normal text-right">Difference</th>
          <th className="py-1 pl-6 font-normal">Source</th>
        </tr>
      </thead>
      <tbody>
        {hc.rows.map((r) => (
          <tr key={r.quantity} className="border-t border-[var(--color-border)]/50">
            <td className="py-1 text-[var(--color-text-secondary)]">{r.quantity}</td>
            <td className="py-1 text-right text-[var(--color-text-primary)]">{r.model}</td>
            <td className="py-1 text-right text-[var(--color-text-secondary)]">{r.hand}</td>
            <td className="py-1 text-right" style={{ color: r.ok ? 'var(--color-text-secondary)' : STATUS_COLOR.bad }}>{r.diff}</td>
            <td className="py-1 pl-6 text-[var(--color-text-muted)]">{r.source}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type Measurements = Record<string, MeasuredValue | null | undefined>;

/** Every assumed input behind this result, and where to enter what has been measured. */
function Inputs({ calibration, measurements, readOnly, onSave }: {
  calibration: ForwardReport['calibration'];
  measurements: Measurements;
  readOnly: boolean;
  onSave?: (patch: Record<string, MeasuredValue | null>) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState<Record<string, { value: string; unc: string; source: string }>>(() =>
    Object.fromEntries(MEASURABLE.map((m) => {
      const mv = measurements[m.key];
      return [m.key, { value: mv ? String(mv.value) : '', unc: mv?.uncertainty != null ? String(mv.uncertainty) : '', source: mv?.source ?? '' }];
    })));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const changed = MEASURABLE.filter((m) => {
    const mv = measurements[m.key];
    const d = draft[m.key];
    return (mv ? String(mv.value) : '') !== d.value || (mv?.source ?? '') !== d.source
      || (mv?.uncertainty != null ? String(mv.uncertainty) : '') !== d.unc;
  });
  const incomplete = changed.filter((m) => draft[m.key].value !== '' && draft[m.key].source.trim() === '');
  const save = async () => {
    if (!onSave) return;
    const patch: Record<string, MeasuredValue | null> = {};
    for (const m of changed) {
      const d = draft[m.key];
      patch[m.key] = d.value === '' ? null
        : { value: Number(d.value), uncertainty: d.unc === '' ? null : Number(d.unc), source: d.source.trim(), date: new Date().toISOString().slice(0, 10) };
    }
    setBusy(true);
    setErr(await onSave(patch));
    setBusy(false);
  };
  const cell = 'rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-[13px] text-[var(--color-text-primary)] tabular-nums';
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12">
        {Object.entries(calibration).map(([k, c]) => (
          <div key={k} className="flex items-baseline justify-between gap-4 py-1.5">
            <Hint text={<>{c.basis}{c.sources?.length ? <><br />{c.sources.join('; ')}</> : null}</>}>
              <span className="text-[13px] text-[var(--color-text-secondary)]">{c.label}</span>
            </Hint>
            <span className="text-[13px]" style={{ color: c.state === 'measured' ? 'var(--color-success)' : 'var(--color-text-muted)' }}>
              {c.state === 'measured' ? '● measured' : c.state === 'partial' ? '◇ partly measured' : '◇'}
            </span>
          </div>
        ))}
      </div>
      <fieldset disabled={readOnly || !onSave} className="space-y-2">
        <div className="text-[13px] text-[var(--color-text-primary)]">Measurements</div>
        <div className="grid grid-cols-[minmax(9rem,1fr)_6rem_5rem_minmax(12rem,2fr)] items-center gap-x-3 gap-y-1.5">
          <span className="text-[11px] text-[var(--color-text-muted)]" />
          <span className="text-[11px] text-[var(--color-text-muted)]">value</span>
          <span className="text-[11px] text-[var(--color-text-muted)]">±</span>
          <span className="text-[11px] text-[var(--color-text-muted)]">source (required)</span>
          {MEASURABLE.map((m) => (
            <div key={m.key} className="contents">
              <span className="text-[13px] text-[var(--color-text-secondary)]">{m.label}{m.unit ? <span className="text-[var(--color-text-muted)]"> {m.unit}</span> : null}</span>
              <input className={cell} inputMode="decimal" value={draft[m.key].value} placeholder="—"
                     onChange={(e) => setDraft({ ...draft, [m.key]: { ...draft[m.key], value: e.target.value.replace(/[^0-9.eE-]/g, '') } })} />
              <input className={cell} inputMode="decimal" value={draft[m.key].unc} placeholder="—"
                     onChange={(e) => setDraft({ ...draft, [m.key]: { ...draft[m.key], unc: e.target.value.replace(/[^0-9.eE-]/g, '') } })} />
              <input className={cell} value={draft[m.key].source} placeholder="e.g. cold flow, water, 2026-10-02"
                     onChange={(e) => setDraft({ ...draft, [m.key]: { ...draft[m.key], source: e.target.value } })} />
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 pt-1">
          <button type="button" onClick={save} disabled={busy || !changed.length || incomplete.length > 0}
                  className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-sm text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40">
            {busy ? 'Saving' : 'Save and re-evaluate'}
          </button>
          {incomplete.length > 0 && <span className="text-xs text-[var(--color-warning)]">Each measurement needs its source.</span>}
          {err && <span className="text-xs text-[var(--color-danger)]">{err}</span>}
        </div>
      </fieldset>
    </div>
  );
}

export function ForwardView({ report, burn, burnWhen, extras = {}, measurements = {}, readOnly = false, onSaveMeasurements }: {
  report: ForwardReport;
  burn: TimeSeriesData | null;
  burnWhen: number | null;
  /** Charts shown under a section when it is open, by section key (stability, spray). */
  extras?: Record<string, ReactNode>;
  /** The config's measurements block, and how to save changes to it. */
  measurements?: Record<string, MeasuredValue | null | undefined>;
  readOnly?: boolean;
  onSaveMeasurements?: (patch: Record<string, MeasuredValue | null>) => Promise<string | null>;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const hc = report.handcheck;
  const hcBad = hc ? hc.rows.filter((r) => !r.ok).length : 0;
  const worstDiff = hc
    ? Math.max(0, ...hc.rows.filter((r) => r.kind === 'compare').map((r) => parseFloat(r.diff) || 0))
    : 0;
  const nAssumed = Object.values(report.calibration).filter((c) => c.state !== 'measured').length;
  const nMeasured = Object.keys(report.calibration).length - nAssumed;

  return (
    <div className="space-y-9" style={SANS}>
      <Headline report={report} burn={burn} />
      <Verdicts verdicts={report.verdicts} calibration={report.calibration} />
      {burn && <Burn burn={burn} when={burnWhen} />}

      <div className="border-b border-[var(--color-border)]">
        {report.sections.map((s) => (
          <SectionRow key={s.key} section={s} calibration={report.calibration} open={!!open[s.key]} onToggle={() => toggle(s.key)}>
            {extras[s.key]}
          </SectionRow>
        ))}
        {hc && (
          <div className="border-t border-[var(--color-border)]">
            <button type="button" onClick={() => toggle('handcheck')} aria-expanded={!!open.handcheck}
                    className="flex w-full items-center gap-6 py-3.5 text-left">
              <span className="w-40 shrink-0 text-sm font-medium text-[var(--color-text-primary)]">Independent check</span>
              <span className="flex-1 text-[13px] text-[var(--color-text-muted)]">
                {hc.error
                  ? 'unavailable'
                  : hcBad
                    ? <span style={{ color: STATUS_COLOR.bad }}>{hcBad} row{hcBad > 1 ? 's' : ''} off</span>
                    : <>CEA and textbook relations agree within {worstDiff.toFixed(2)} %</>}
              </span>
              <svg className={`h-4 w-4 shrink-0 text-[var(--color-text-muted)] transition-transform ${open.handcheck ? 'rotate-90' : ''}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
                <path d="M6 4l4 4-4 4" />
              </svg>
            </button>
            {open.handcheck && !hc.error && <div className="pb-5"><IndependentCheck hc={hc} /></div>}
          </div>
        )}
        <div className="border-t border-[var(--color-border)]">
          <button type="button" onClick={() => toggle('inputs')} aria-expanded={!!open.inputs}
                  className="flex w-full items-center gap-6 py-3.5 text-left">
            <span className="w-40 shrink-0 text-sm font-medium text-[var(--color-text-primary)]">Inputs</span>
            <span className="flex-1 text-[13px] text-[var(--color-text-muted)]">
              ◇ {nAssumed} assumed{nMeasured ? <> · <span className="text-[var(--color-success)]">● {nMeasured} measured</span></> : null}
            </span>
            <svg className={`h-4 w-4 shrink-0 text-[var(--color-text-muted)] transition-transform ${open.inputs ? 'rotate-90' : ''}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <path d="M6 4l4 4-4 4" />
            </svg>
          </button>
          {open.inputs && (
            <div className="pb-6">
              <Inputs calibration={report.calibration} measurements={measurements} readOnly={readOnly} onSave={onSaveMeasurements} />
            </div>
          )}
        </div>
      </div>


    </div>
  );
}
