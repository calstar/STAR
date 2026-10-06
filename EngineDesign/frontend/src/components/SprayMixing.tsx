import { useState } from 'react';
import { getSprayReport } from '../api/client';
import type { SprayReport, SprayRow } from '../api/client';

/**
 * Spray and mixing of the injector at the design's own tank pressures: each jet from orifice to
 * burnt gas, every number beside the band it is judged against and its source, and how the
 * answer moves across the inputs the literature leaves open. All numbers come from
 * engine/core/injectors/spray_report.py; this only lays them out. It solves the engine, so it
 * runs when asked, not on every render.
 */

const COLOR: Record<SprayRow['status'], string> = {
  ok: 'var(--color-text-secondary)', info: 'var(--color-text-secondary)', warn: '#fbbf24', bad: '#f87171',
};
const MARK: Record<SprayRow['status'], string> = { ok: '✓', info: '·', warn: '!', bad: '✗' };

export function fmtValue(v: SprayRow['value']): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e4 || a < 1e-2)) return v.toPrecision(3);
  return a >= 100 ? v.toFixed(1) : a >= 1 ? v.toFixed(3).replace(/\.?0+$/, '') : v.toFixed(4);
}

export function SprayMixingView({ report }: { report: SprayReport }) {
  const d = report.design;
  const base = report.sensitivity?.[0];
  return (
    <div className="space-y-3 text-[11px] leading-5 font-mono text-[var(--color-text-secondary)]">
      <div>
        at {d.P_tank_O_psi.toFixed(1)} / {d.P_tank_F_psi.toFixed(1)} psi tanks: {d.F.toFixed(0)} N, Pc {d.Pc_psia.toFixed(1)} psia,
        O/F {d.OF.toFixed(3)}, Isp {d.Isp.toFixed(1)} s
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {report.sections.map((s) => (
          <div key={s.title}>
            <div className="text-[var(--color-text-primary)] font-semibold">{s.title}</div>
            {s.rows.map((r) => (
              <div key={r.label} style={{ color: COLOR[r.status] }} title={r.source}>
                {MARK[r.status]} {r.label} <span className="text-[var(--color-text-primary)]">{fmtValue(r.value)}</span> {r.unit}
                {r.band && <span className="opacity-70"> [{r.band}]</span>}
                {r.note && <span className="opacity-70"> — {r.note}</span>}
              </div>
            ))}
          </div>
        ))}
      </div>
      {report.sensitivity && base && (
        <div>
          <div className="text-[var(--color-text-primary)] font-semibold">What it rests on — re-solved as written, same tanks and holes</div>
          <table className="w-full text-left">
            <thead>
              <tr className="opacity-70">
                <th className="font-normal">case</th><th className="font-normal text-right">F N</th>
                <th className="font-normal text-right">Isp s</th><th className="font-normal text-right">Pc psia</th>
                <th className="font-normal text-right">η c*</th><th className="font-normal text-right">η vap</th>
                <th className="font-normal text-right">η mix</th><th className="font-normal text-right">fuel vap</th>
              </tr>
            </thead>
            <tbody>
              {report.sensitivity.map((c) => (
                <tr key={c.case} title={c.why}>
                  <td className={c.case === base.case ? 'text-[var(--color-text-primary)]' : ''}>
                    {c.case}{!c.applied && <span style={{ color: COLOR.bad }}> (not applied)</span>}
                  </td>
                  {c.error ? <td colSpan={7} style={{ color: COLOR.bad }}>did not solve: {c.error}</td> : (
                    <>
                      <td className="text-right">{c.F!.toFixed(0)}{c !== base && <span className="opacity-60"> {(c.F! - base.F! >= 0 ? '+' : '')}{(c.F! - base.F!).toFixed(0)}</span>}</td>
                      <td className="text-right">{c.Isp!.toFixed(1)}</td>
                      <td className="text-right">{c.Pc_psia!.toFixed(1)}</td>
                      <td className="text-right">{c.eta_cstar!.toFixed(4)}</td>
                      <td className="text-right">{c.eta_vap!.toFixed(4)}</td>
                      <td className="text-right">{c.eta_mix!.toFixed(4)}</td>
                      <td className="text-right">{(100 * c.vap_F!).toFixed(1)}%</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="opacity-70">Hover a case for where its range comes from. A cold-flow E_m and a measured D32 replace these ranges with numbers.</div>
        </div>
      )}
    </div>
  );
}

export function SprayMixing() {
  const [report, setReport] = useState<SprayReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    const r = await getSprayReport(true);
    setBusy(false);
    if (r.error) setError(r.error);
    else setReport(r.data ?? null);
  };
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3">
      <div className="flex items-baseline justify-between mb-2">
        <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">Spray and mixing</h4>
        <button type="button" onClick={run} disabled={busy}
                className="text-[11px] px-2 py-0.5 rounded bg-rose-600 text-white disabled:opacity-40">
          {busy ? 'Solving… (~20 s)' : report ? 'Re-run' : 'Analyse'}
        </button>
      </div>
      {!report && !busy && !error && (
        <div className="text-[11px] text-[var(--color-text-secondary)]">
          Solves the engine at its tank pressures, then once per open input (SMD transfer, Rupe E_m).
        </div>
      )}
      {error && <div className="text-[11px] text-[#f87171] font-mono break-words">{error}</div>}
      {report && <SprayMixingView report={report} />}
    </div>
  );
}

export default SprayMixing;
