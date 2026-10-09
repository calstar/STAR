import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from '../ui';
import { layerx, type OverrideEntry, type ParameterRow } from '../../api/layerx';
import { sig } from './format';

/**
 * Every number on the drawing, where it came from, and a place to restate it.
 *
 * A restatement is an override (engine/layerx/measurements.py): it replaces the drawing's value
 * for this person's burns, with its source and, for a measurement, its uncertainty. The
 * uncertainty sweep uses it in place of the default range. The drawing itself is not edited; a
 * value that should be permanent belongs on the drawing in pid-designer.
 */

const SOURCE_MARK: Record<string, { mark: string; color: string; title: string }> = {
  measured: { mark: '●', color: 'var(--color-success)', title: 'Measured on the hardware' },
  manufacturer: { mark: '○', color: 'var(--color-text-secondary)', title: 'Manufacturer datasheet' },
  estimated: { mark: '◇', color: 'var(--color-warning)', title: 'Estimated from a correlation or engineering judgement' },
  default: { mark: '◆', color: 'var(--color-danger)', title: 'Library default; not specified on the drawing' },
};

type Draft = { value: string; unc: string; source: string; provenance: OverrideEntry['provenance']; date: string };

const key = (r: { target: string; parameter: string }) => `${r.target}.${r.parameter}`;

export function ParametersPanel({ drawingId, open, onClose, onSaved }: {
  drawingId: string; open: boolean; onClose: () => void; onSaved: (count: number) => void;
}) {
  const [rows, setRows] = useState<ParameterRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [assumedOnly, setAssumedOnly] = useState(true);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Restatements for elements this revision of the drawing no longer has: kept on save, not dropped.
  const [orphans, setOrphans] = useState<OverrideEntry[]>([]);

  useEffect(() => {
    if (!open || !drawingId) return;
    layerx.parameters(drawingId).then((r) => {
      if (r.error || !r.data) { setError(r.error ?? 'Could not read the drawing.'); return; }
      setError(null);
      setRows(r.data.rows);
      const present = new Set(r.data.rows.map((row) => key(row)));
      setOrphans(r.data.overrides.filter((o) => !present.has(key(o))));
      const d: Record<string, Draft> = {};
      for (const o of r.data.overrides) {
        if (!present.has(key(o))) continue;
        d[key(o)] = { value: String(o.value), unc: o.uncertainty == null ? '' : String(o.uncertainty), source: o.source,
                      provenance: o.provenance, date: o.date ?? '' };
      }
      setDrafts(d);
    });
  }, [open, drawingId]);

  const shown = useMemo(() => rows.filter((r) => {
    const k = key(r);
    if (assumedOnly && !(r.source === 'default' || r.source === 'estimated' || drafts[k])) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return `${r.label} ${r.type} ${r.parameter}`.toLowerCase().includes(q);
  }), [rows, assumedOnly, query, drafts]);

  const restated = Object.entries(drafts).filter(([, d]) => d.value.trim() !== '');
  const incomplete = restated.filter(([, d]) => d.source.trim() === '');
  const isNum = (t: string) => t.trim() !== '' && Number.isFinite(Number(t));
  const malformed = restated.filter(([, d]) => !isNum(d.value) || (d.unc.trim() !== '' && !isNum(d.unc)));

  const save = async () => {
    const byKey = new Map(rows.map((r) => [key(r), r]));
    const overrides: OverrideEntry[] = [...orphans];
    for (const [k, d] of restated) {
      const row = byKey.get(k);
      if (!row) continue;
      overrides.push({ target: row.target, parameter: row.parameter, value: Number(d.value), unit: row.unit,
                       source: d.source.trim(), provenance: d.provenance,
                       uncertainty: d.unc.trim() === '' ? null : Number(d.unc), date: d.date || null });
    }
    setBusy(true);
    const r = await layerx.putMeasurements(drawingId, overrides);
    setBusy(false);
    if (r.error) { setError(r.error); return; }
    onSaved(overrides.length - orphans.length);
    onClose();
  };

  const cell = 'w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-1.5 py-0.5 text-[12px] tabular-nums text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]';
  const blank: Draft = { value: '', unc: '', source: '', provenance: 'measured', date: '' };
  const set = (k: string, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [k]: { ...(d[k] ?? blank), ...patch } }));

  // Portalled to the body: rendered in place, the rail's sticky stacking context capped the modal
  // under the main column's positioned elements, which then painted through it.
  return createPortal(
    <Modal open={open} onClose={onClose} width="w-[min(1100px,96vw)]" title="Drawing parameters"
           footer={
             <div className="flex w-full items-center gap-3">
               <span className="text-[12px] text-[var(--color-text-muted)]">
                 {restated.length} restated{orphans.length ? <span className="text-[var(--color-warning)]"> · {orphans.length} for elements no longer on the drawing (kept)</span> : null}{incomplete.length ? <span className="text-[var(--color-warning)]"> · each needs its source</span> : null}
                 {malformed.length ? <span className="text-[var(--color-warning)]"> · {malformed.length} not a number</span> : null}
               </span>
               {error && <span className="text-[12px] text-[var(--color-danger)]">{error}</span>}
               <button type="button" onClick={onClose} className="ml-auto rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-secondary)]">Close</button>
               <button type="button" onClick={save} disabled={busy || incomplete.length > 0 || malformed.length > 0}
                       className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-sm text-white disabled:opacity-40">{busy ? 'Saving' : 'Save'}</button>
             </div>
           }>
      <div className="space-y-3" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
        <p className="text-[12px] leading-snug text-[var(--color-text-muted)] max-w-3xl">
          Restate a parameter to use your number in place of the drawing's, for your burns only. A measurement with its
          ± replaces the default range in the uncertainty sweep. To make it permanent, put it on the drawing in pid-designer.
        </p>
        <div className="flex items-center gap-4">
          <input className={`${cell} max-w-xs`} placeholder="Filter: component or parameter" value={query} onChange={(e) => setQuery(e.target.value)} />
          <label className="flex items-center gap-2 text-[12px] text-[var(--color-text-secondary)]">
            <input type="checkbox" checked={assumedOnly} onChange={(e) => setAssumedOnly(e.target.checked)} /> assumed only
          </label>
          <span className="ml-auto text-[12px] text-[var(--color-text-muted)]">{shown.length} of {rows.length}</span>
        </div>
        <div className="max-h-[60vh] overflow-auto rounded border border-[var(--color-border)]">
          <table className="w-full text-[12px] tabular-nums">
            <thead className="sticky top-0 z-10 bg-[var(--color-bg-secondary)] text-left text-[var(--color-text-muted)]">
              <tr>
                <th className="px-2 py-1.5 font-normal">Component</th>
                <th className="px-2 py-1.5 font-normal">Parameter</th>
                <th className="px-2 py-1.5 font-normal text-right">Drawing</th>
                <th className="px-2 py-1.5 font-normal">Basis</th>
                <th className="px-2 py-1.5 font-normal w-24">Your value</th>
                <th className="px-2 py-1.5 font-normal w-16" title="One standard uncertainty, in the row's unit">± (1σ)</th>
                <th className="px-2 py-1.5 font-normal w-28">As</th>
                <th className="px-2 py-1.5 font-normal w-56">Source</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const k = key(r);
                const d = drafts[k];
                const mark = SOURCE_MARK[r.source] ?? SOURCE_MARK.estimated;
                return (
                  <tr key={k} className="border-t border-[var(--color-border)]/50 align-top">
                    <td className="px-2 py-1 text-[var(--color-text-secondary)]">{r.label}<span className="text-[var(--color-text-muted)]"> {r.type}</span></td>
                    <td className="px-2 py-1 text-[var(--color-text-secondary)]">{r.parameter}</td>
                    <td className="px-2 py-1 text-right text-[var(--color-text-primary)] whitespace-nowrap">{sig(r.value)} <span className="text-[var(--color-text-muted)]">{r.unit}</span></td>
                    <td className="px-2 py-1 text-[var(--color-text-muted)] max-w-[16rem]">
                      <span title={mark.title} style={{ color: mark.color }}>{mark.mark}</span> {r.source}
                      {r.reference && <span className="block truncate" title={r.reference}>{r.reference}</span>}
                    </td>
                    <td className="px-2 py-1"><input className={cell} inputMode="decimal" value={d?.value ?? ''} placeholder="—" aria-label={`${r.label} ${r.parameter}, measured value`}
                      onChange={(e) => set(k, { value: e.target.value.replace(/[^0-9.eE-]/g, '') })} /></td>
                    <td className="px-2 py-1"><input className={cell} inputMode="decimal" value={d?.unc ?? ''} placeholder="—" aria-label={`${r.label} ${r.parameter}, one-sigma uncertainty`}
                      onChange={(e) => set(k, { unc: e.target.value.replace(/[^0-9.eE-]/g, '') })} /></td>
                    <td className="px-2 py-1">
                      <select className={cell} aria-label={`${r.label} ${r.parameter}, basis`} value={d?.provenance ?? 'measured'} onChange={(e) => set(k, { provenance: e.target.value as Draft['provenance'] })}>
                        <option value="measured">measured</option><option value="manufacturer">datasheet</option><option value="estimated">estimate</option>
                      </select>
                    </td>
                    <td className="px-2 py-1"><input className={cell} aria-label={`${r.label} ${r.parameter}, source`} value={d?.source ?? ''} placeholder="test, rig, date"
                      onChange={(e) => set(k, { source: e.target.value })} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>,
    document.body,
  );
}
