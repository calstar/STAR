import { useMemo, useState } from 'react';
import { useReadOnly } from '@stardesign-ui';
import {
  FITTING_KINDS, FITTING_LABELS, LOSS_METHODS,
  fittingCount, knownK, methodOf, nextRowId, nextSegmentId, transitionsOf,
} from './segments';
import type { FittingRow, LineSegment, LossMethod } from './segments';
import { STANDARDS, TUBE_SIZES, DASH_SIZES, NPT_SIZES, cutLength, loadCatalog, suggestBore, tubeOdForSize } from './catalog';
import type { Standard } from './catalog';
import type { ParamValue } from './params';

/**
 * What a line is made of, and how its loss is known.
 *
 * The method selector is the point of this panel. A feed system's resistance is
 * known differently at different stages -- itemised while it is being designed,
 * measured once it has been flowed -- and both have to be first-class with no
 * ambiguity about which is in force. Choosing one hides the others' fields
 * rather than leaving a pile of inputs where the precedence is a guess.
 *
 * Flat: a segment is a row and its fittings are rows under it. No accordions.
 */

const field =
  'rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]';
const muted = 'text-[10px] text-[var(--color-text-muted)]';

const numOf = (p?: ParamValue) => (p === undefined ? '' : String(p.value));

export function SegmentPanel({ segments, onChange }: {
  segments: LineSegment[];
  onChange: (next: LineSegment[]) => void;
}) {
  const readOnly = useReadOnly();
  const catalog = useMemo(() => loadCatalog(), []);
  const transitions = useMemo(() => transitionsOf(segments), [segments]);

  const patch = (i: number, next: Partial<LineSegment>) =>
    onChange(segments.map((s, j) => (j === i ? { ...s, ...next } : s)));

  const setNum = (i: number, key: 'bore' | 'length' | 'K', raw: string, unit: string) => {
    const v = raw.trim();
    if (v === '') { patch(i, { [key]: undefined } as Partial<LineSegment>); return; }
    const value = Number(v);
    if (Number.isFinite(value)) {
      patch(i, { [key]: { value, unit, source: 'estimated' } } as Partial<LineSegment>);
    }
  };

  const addSegment = () =>
    onChange([...segments, { id: nextSegmentId(), method: 'itemised', fittings: [], standard: 'tube' }]);

  /** Picking a size fills the bore in, and records where it came from. */
  const pickSize = (i: number, standard: Standard, size: string) => {
    if (!size) { patch(i, { standard, tubeSize: undefined }); return; }
    const s = suggestBore(standard, size, catalog);
    patch(i, {
      standard, tubeSize: size,
      ...(s ? { bore: { value: s.mm, unit: 'mm', source: 'default', reference: s.reference } } : {}),
    });
  };

  return (
    <div className="space-y-2 border-t border-[var(--color-border)] pt-2.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">Segments</span>
        {segments.length === 0 && (
          <span className={muted}>optional — the line uses its own bore and length</span>
        )}
      </div>

      {segments.map((seg, i) => {
        const method = methodOf(seg);
        const standard = (seg.standard as Standard) ?? 'tube';
        const sizes =
          standard === 'tube' ? TUBE_SIZES.map(t => t.label)
          : standard === 'NPT' ? [...NPT_SIZES]
          : DASH_SIZES.map(d => `-${d}`);
        const boreKnown = seg.bore !== undefined;
        const od = tubeOdForSize(standard, (seg.tubeSize ?? '').replace(/^-/, ''));

        return (
          <div key={seg.id}>
            <div className="rounded border border-[var(--color-border)] p-2">
              {/* size · length · bore */}
              <div className="flex items-center gap-1.5">
                <span className="w-4 shrink-0 text-center font-mono text-[11px] text-[var(--color-text-muted)]">{i + 1}</span>
                <select value={standard} disabled={readOnly}
                  onChange={e => pickSize(i, e.target.value as Standard, '')}
                  className={`${field} w-[92px] shrink-0`}>
                  {STANDARDS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
                <select value={seg.tubeSize ?? ''} disabled={readOnly}
                  onChange={e => pickSize(i, standard, e.target.value)}
                  className={`${field} w-[104px] shrink-0`}>
                  <option value="">size…</option>
                  {sizes.map(z => <option key={z} value={z}>{z}</option>)}
                </select>
                <input inputMode="decimal" placeholder="length" value={numOf(seg.length)}
                  readOnly={readOnly} onChange={e => setNum(i, 'length', e.target.value, 'm')}
                  className={`${field} w-[62px] shrink-0`} />
                <select value={seg.lengthBasis ?? 'tube'} disabled={readOnly}
                  onChange={e => patch(i, { lengthBasis: e.target.value as 'tube' | 'overall' })}
                  className={`${field} w-[78px] shrink-0`}
                  title="Tube: the straight piece you cut. Overall: measured end to end.">
                  <option value="tube">m tube</option>
                  <option value="overall">m overall</option>
                </select>
                <input inputMode="decimal" placeholder="bore" value={numOf(seg.bore)}
                  readOnly={readOnly} onChange={e => setNum(i, 'bore', e.target.value, 'mm')}
                  className={`${field} w-[62px] shrink-0`}
                  title="Flow diameter — never the thread size" />
                <span className={muted}>mm</span>
                <button disabled={readOnly} onClick={() => onChange(segments.filter((_, j) => j !== i))}
                  className="ml-auto shrink-0 rounded px-1.5 text-[13px] leading-none text-[var(--color-text-muted)] hover:text-red-400"
                  title="Remove segment">×</button>
              </div>

              {/* Why the bore says what it says, and the trap when it says nothing. */}
              {seg.tubeSize && (
                <p className={`${muted} mt-1 pl-6`}>
                  {boreKnown
                    ? seg.bore?.reference ?? 'bore set by hand'
                    : od
                      ? `no catalogue bore for ${standard} ${seg.tubeSize} — type it. Thread size is not flow diameter.`
                      : 'type the bore'}
                </p>
              )}

              {/* How the loss is known */}
              <div className="mt-2 flex items-center gap-1.5 pl-6">
                <span className={muted}>loss from</span>
                <select value={method} disabled={readOnly}
                  onChange={e => patch(i, { method: e.target.value as LossMethod })}
                  className={`${field} w-[128px] shrink-0`}>
                  {LOSS_METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
                <span className={muted}>{LOSS_METHODS.find(m => m.id === method)?.note}</span>
              </div>

              {(method === 'measured_K' || method === 'lumped_K') && (
                <div className="mt-1.5 flex items-center gap-1.5 pl-6">
                  <span className={muted}>K</span>
                  <input inputMode="decimal" placeholder="—" value={numOf(seg.K)}
                    readOnly={readOnly} onChange={e => setNum(i, 'K', e.target.value, '-')}
                    className={`${field} w-[72px]`} />
                  {method === 'measured_K' && (
                    <span className={muted}>supersedes any fittings below</span>
                  )}
                </div>
              )}

              {method === 'curve' && (
                <p className={`${muted} mt-1.5 pl-6`}>
                  Δp against ṁ, entered in feed-twin against the run that produced it.
                </p>
              )}

              {method === 'itemised' && (
                <FittingRows
                  rows={seg.fittings ?? []}
                  readOnly={readOnly}
                  segmentBore={seg.bore?.value}
                  onChange={rows => patch(i, { fittings: rows })}
                />
              )}

              <CutList seg={seg} />
            </div>

            {transitions[i] && (
              <p className="py-1 pl-6 text-[10px] text-[var(--color-text-muted)]">
                ↓ {transitions[i]!.kind === 'contraction' ? 'reducer' : 'expander'}{' '}
                {transitions[i]!.fromMm.toFixed(2)} → {transitions[i]!.toMm.toFixed(2)} mm
                <span className="ml-2 text-[var(--color-text-secondary)]">
                  derived, K {transitions[i]!.K.toFixed(2)}
                </span>
              </p>
            )}
          </div>
        );
      })}

      <button disabled={readOnly} onClick={addSegment}
        className="w-full rounded border border-dashed border-[var(--color-border)] py-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
        + add segment
      </button>
    </div>
  );
}

/**
 * The straight tube to cut, when the run was measured end to end.
 *
 * Shown only when it can be answered: every fitting needs a length, because a
 * partial subtraction is a mis-cut part rather than an approximate one.
 */
function CutList({ seg }: { seg: LineSegment }) {
  if (seg.lengthBasis !== 'overall' || !seg.length) return null;
  const overallMm = seg.length.value * (seg.length.unit === 'm' ? 1000 : 1);
  const flat = (seg.fittings ?? []).flatMap(r => Array.from({ length: r.count }, () => r));
  const cut = cutLength(overallMm, flat);
  return (
    <p className={`${muted} mt-1.5 pl-6`}>
      {cut === null
        ? 'cut length needs a body length on every fitting'
        : `cut ${(cut / 1000).toFixed(3)} m of tube · fittings occupy ${((overallMm - cut) / 1000).toFixed(3)} m`}
    </p>
  );
}

/** The fittings in a segment: ordered rows, each with a count. */
function FittingRows({ rows, readOnly, segmentBore, onChange }: {
  rows: FittingRow[];
  readOnly: boolean;
  segmentBore?: number;
  onChange: (rows: FittingRow[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [openRow, setOpenRow] = useState<string | null>(null);

  const matches = FITTING_KINDS.filter(k =>
    FITTING_LABELS[k].toLowerCase().includes(query.trim().toLowerCase()));

  const set = (id: string, patch: Partial<FittingRow>) =>
    onChange(rows.map(r => (r.id === id ? { ...r, ...patch } : r)));

  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  const numField = (v: number | undefined, onSet: (n: number | undefined) => void, ph: string) => (
    <input
      inputMode="decimal" placeholder={ph} value={v === undefined ? '' : String(v)}
      readOnly={readOnly}
      onChange={e => {
        const t = e.target.value.trim();
        onSet(t === '' ? undefined : Number.isFinite(Number(t)) ? Number(t) : undefined);
      }}
      className={`${field} w-[62px]`}
    />
  );

  return (
    <div className="mt-1.5 space-y-1 pl-6">
      {rows.map((r, i) => (
        <div key={r.id}>
          <div className="flex items-center gap-1.5">
            <span className="flex shrink-0 flex-col leading-none">
              <button disabled={readOnly || i === 0} onClick={() => move(i, -1)}
                className="text-[9px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-30" title="Move up">▲</button>
              <button disabled={readOnly || i === rows.length - 1} onClick={() => move(i, 1)}
                className="text-[9px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-30" title="Move down">▼</button>
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-secondary)]">
              {FITTING_LABELS[r.kind]}
              {r.boreMm !== undefined && r.boreMm !== segmentBore && (
                <span className={muted}> · {r.boreMm} mm</span>
              )}
              {r.K !== undefined && <span className="text-[var(--color-accent)]"> · K {r.K}</span>}
            </span>
            <button disabled={readOnly} onClick={() => set(r.id, { count: r.count + 1 })}
              className="shrink-0 font-mono text-[11px] text-[var(--color-text-primary)] hover:text-[var(--color-accent)]"
              title="One more">×{r.count}</button>
            <button disabled={readOnly}
              onClick={() => (r.count <= 1 ? onChange(rows.filter(x => x.id !== r.id)) : set(r.id, { count: r.count - 1 }))}
              className="shrink-0 text-[11px] text-[var(--color-text-muted)] hover:text-red-400" title="One fewer">−</button>
            <button onClick={() => setOpenRow(openRow === r.id ? null : r.id)}
              className="shrink-0 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
              title="Bore, length, measured K">⋮</button>
          </div>

          {openRow === r.id && (
            <div className="mb-1 ml-5 flex flex-wrap items-center gap-1.5 rounded bg-[var(--color-bg-primary)] p-1.5">
              <span className={muted}>bore</span>
              {numField(r.boreMm, v => set(r.id, { boreMm: v }), segmentBore ? String(segmentBore) : 'mm')}
              <span className={muted}>body</span>
              {numField(r.lengthMm, v => set(r.id, { lengthMm: v }), 'mm')}
              <span className={muted}>engages</span>
              {numField(r.engagementMm, v => set(r.id, { engagementMm: v }), 'mm')}
              <span className={muted}>K</span>
              {numField(r.K, v => set(r.id, { K: v }), 'meas.')}
            </div>
          )}
        </div>
      ))}

      {adding ? (
        <span className="relative block">
          <input autoFocus value={query} placeholder="fitting…" readOnly={readOnly}
            onChange={e => setQuery(e.target.value)}
            onBlur={() => window.setTimeout(() => { setAdding(false); setQuery(''); }, 120)}
            className={`${field} w-[150px]`} />
          <span className="absolute left-0 top-full z-10 mt-1 max-h-40 w-[210px] overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-xl">
            {matches.map(k => (
              <button key={k} disabled={readOnly}
                onMouseDown={() => {
                  onChange([...rows, { id: nextRowId(), kind: k, count: 1 }]);
                  setAdding(false); setQuery('');
                }}
                className="block w-full px-2 py-1 text-left text-[11px] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)]">
                {FITTING_LABELS[k]}
              </button>
            ))}
            {matches.length === 0 && <span className={`block px-2 py-1 ${muted}`}>nothing matches</span>}
          </span>
        </span>
      ) : (
        <button disabled={readOnly} onClick={() => setAdding(true)}
          className="rounded text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
          + add fitting
        </button>
      )}
    </div>
  );
}

export { fittingCount, knownK };
