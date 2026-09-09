import { useMemo, useState } from 'react';
import { useReadOnly } from '@stardesign-ui';
import { FITTING_KINDS, FITTING_LABELS, fittingCount, nextSegmentId, transitionsOf } from './segments';
import type { FittingKind, LineSegment } from './segments';
import { TUBE_SIZES, suggestBore } from './tubing';
import type { ParamValue } from './params';

/**
 * What a line is made of: ordered segments, a bag of fittings in each.
 *
 * Flat on purpose -- no accordions, no wizard, no tabs. A segment is a row and
 * its fittings are a strip under it, because that is the shape of the thing
 * being described and anything cleverer gets in the way of typing four numbers.
 *
 * Two things are deliberately not asked for:
 *
 * **Where a fitting sits.** At one bore, rearranging fittings moves the answer
 * by 0.003%. Adding one is a count.
 *
 * **The transition between segments.** Two adjacent bores *are* a reducer, so
 * it is drawn as a consequence with its K, not as a row somebody can forget.
 */

const field =
  'rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]';

const num = (p?: ParamValue) => (p === undefined ? '' : String(p.value));

export function SegmentPanel({ segments, onChange }: {
  segments: LineSegment[];
  onChange: (next: LineSegment[]) => void;
}) {
  const readOnly = useReadOnly();
  const transitions = useMemo(() => transitionsOf(segments), [segments]);

  const patch = (i: number, next: Partial<LineSegment>) =>
    onChange(segments.map((s, j) => (j === i ? { ...s, ...next } : s)));

  const setParam = (i: number, key: 'bore' | 'length', raw: string, unit: string) => {
    const v = raw.trim();
    if (v === '') { patch(i, { [key]: undefined } as Partial<LineSegment>); return; }
    const value = Number(v);
    if (!Number.isFinite(value)) return;
    patch(i, { [key]: { value, unit, source: 'estimated' } } as Partial<LineSegment>);
  };

  const addSegment = () =>
    onChange([...segments, { id: nextSegmentId(), fittings: {} }]);

  const removeSegment = (i: number) =>
    onChange(segments.filter((_, j) => j !== i));

  /** Picking a tube size fills the bore in, and says where it came from. */
  const pickTube = (i: number, label: string) => {
    if (!label) { patch(i, { tubeSize: undefined }); return; }
    const s = suggestBore('tube', label);
    patch(i, {
      tubeSize: label,
      ...(s ? { bore: { value: s.mm, unit: 'mm', source: 'default', reference: s.reference } } : {}),
    });
  };

  return (
    <div className="space-y-2 border-t border-[var(--color-border)] pt-2.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
          Segments
        </span>
        {segments.length === 0 && (
          <span className="text-[10px] text-[var(--color-text-muted)]">
            optional — the line uses its bore and length without them
          </span>
        )}
      </div>

      {segments.map((seg, i) => (
        <div key={seg.id}>
          <div className="rounded border border-[var(--color-border)] p-2">
            <div className="flex items-center gap-1.5">
              <span className="w-4 shrink-0 text-center font-mono text-[11px] text-[var(--color-text-muted)]">
                {i + 1}
              </span>
              <select
                value={seg.tubeSize ?? ''}
                disabled={readOnly}
                onChange={e => pickTube(i, e.target.value)}
                className={`${field} w-[112px] shrink-0`}
                title="Tube size — the bore follows from OD minus two walls"
              >
                <option value="">size…</option>
                {TUBE_SIZES.map(t => <option key={t.label} value={t.label}>{t.label}</option>)}
              </select>
              <input
                inputMode="decimal"
                placeholder="length"
                value={num(seg.length)}
                readOnly={readOnly}
                onChange={e => setParam(i, 'length', e.target.value, 'm')}
                className={`${field} w-[62px] shrink-0`}
              />
              <span className="text-[10px] text-[var(--color-text-muted)]">m</span>
              <input
                inputMode="decimal"
                placeholder="bore"
                value={num(seg.bore)}
                readOnly={readOnly}
                onChange={e => setParam(i, 'bore', e.target.value, 'mm')}
                className={`${field} w-[62px] shrink-0`}
                title="Flow diameter — not the thread size"
              />
              <span className="text-[10px] text-[var(--color-text-muted)]">mm</span>
              <button
                disabled={readOnly}
                onClick={() => removeSegment(i)}
                title="Remove this segment"
                className="ml-auto shrink-0 rounded px-1.5 text-[13px] leading-none text-[var(--color-text-muted)] hover:text-red-400"
              >
                ×
              </button>
            </div>

            <FittingBag
              fittings={seg.fittings ?? {}}
              readOnly={readOnly}
              onChange={f => patch(i, { fittings: f })}
            />
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
      ))}

      <button
        disabled={readOnly}
        onClick={addSegment}
        className="w-full rounded border border-dashed border-[var(--color-border)] py-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
      >
        + add segment
      </button>
    </div>
  );
}

/** The fittings in one segment: kind and count, nothing about placement. */
function FittingBag({ fittings, readOnly, onChange }: {
  fittings: Partial<Record<FittingKind, number>>;
  readOnly: boolean;
  onChange: (f: Partial<Record<FittingKind, number>>) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');

  const present = (Object.keys(fittings) as FittingKind[]).filter(k => (fittings[k] ?? 0) > 0);
  const matches = FITTING_KINDS.filter(k =>
    FITTING_LABELS[k].toLowerCase().includes(query.trim().toLowerCase()));

  const bump = (k: FittingKind, by: number) => {
    const n = (fittings[k] ?? 0) + by;
    const next = { ...fittings };
    if (n <= 0) delete next[k];
    else next[k] = n;
    onChange(next);
  };

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-6">
      {present.map(k => (
        <span
          key={k}
          className="inline-flex items-center gap-1 rounded bg-[var(--color-bg-primary)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)]"
        >
          {FITTING_LABELS[k]}
          <button
            disabled={readOnly}
            onClick={() => bump(k, 1)}
            title="One more"
            className="font-mono text-[var(--color-text-primary)] hover:text-[var(--color-accent)]"
          >
            ×{fittings[k]}
          </button>
          <button
            disabled={readOnly}
            onClick={() => bump(k, -1)}
            title="One fewer"
            className="text-[var(--color-text-muted)] hover:text-red-400"
          >
            −
          </button>
        </span>
      ))}

      {adding ? (
        <span className="relative">
          <input
            autoFocus
            value={query}
            placeholder="fitting…"
            readOnly={readOnly}
            onChange={e => setQuery(e.target.value)}
            onBlur={() => window.setTimeout(() => { setAdding(false); setQuery(''); }, 120)}
            className={`${field} w-[128px]`}
          />
          <span className="absolute left-0 top-full z-10 mt-1 max-h-40 w-[196px] overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-xl">
            {matches.map(k => (
              <button
                key={k}
                disabled={readOnly}
                onMouseDown={() => { bump(k, 1); setAdding(false); setQuery(''); }}
                className="block w-full px-2 py-1 text-left text-[11px] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)]"
              >
                {FITTING_LABELS[k]}
              </button>
            ))}
            {matches.length === 0 && (
              <span className="block px-2 py-1 text-[11px] text-[var(--color-text-muted)]">
                nothing matches
              </span>
            )}
          </span>
        </span>
      ) : (
        <button
          disabled={readOnly}
          onClick={() => setAdding(true)}
          className="rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
        >
          + add fitting
        </button>
      )}
    </div>
  );
}

export { fittingCount };
