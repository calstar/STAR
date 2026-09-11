import { useMemo, useState } from 'react';
import { useReadOnly } from '@stardesign-ui';
import {
  FITTING_KINDS, FITTING_LABELS, LOSS_METHODS,
  fittingCount, knownK, methodOf, nextRowId, nextSegmentId, transitionsOf,
} from './segments';
import type { FittingRow, LineSegment, LossMethod } from './segments';
import { STANDARDS, TUBE_SIZES, DASH_SIZES, NPT_SIZES, cutLength, loadCatalog, suggestBore, tubeOdForSize } from './catalog';
import type { Standard } from './catalog';
import { UNITS } from './params';
import type { ParamValue } from './params';

/**
 * What a line is made of.
 *
 * Rebuilt around the three things somebody actually wants to say about a run,
 * in the order they want to say them: **what tube it is, how long it is, and
 * what is in it.** The version before this asked for a "segment" first, which
 * is a word for a thing nobody sets out to create, then offered a row of seven
 * unlabelled controls, then asked how the loss was known before letting anyone
 * name a fitting -- and putting three elbows in took five interactions and a
 * search box.
 *
 * The decisions behind the layout:
 *
 * **Size first, bore second-hand.** Picking `1/2 x 0.049` is the thing a
 * fabricator knows; the bore is arithmetic off it. So the size is a picker and
 * the bore is *stated back* rather than asked for, with a way in for the case
 * the catalogue cannot answer. A number nobody has to type is a number nobody
 * can mistype.
 *
 * **Length in the units it was measured in.** It used to be metres only, in an
 * app where every other length has a unit next to it, with the *basis* -- tube
 * or overall -- dressed up as the unit to save a control. Two ideas in one
 * select is one too many; they are separate now.
 *
 * **Fittings by clicking.** The five a stand is actually built from are
 * buttons, so three elbows is three clicks and no typing. The full list is
 * still there behind "more", searchable, for the other ten.
 *
 * **One line that says what it all came to.** Length, count and the K that is
 * knowable here, under the controls that produced them, so the panel answers
 * the question it just asked you.
 *
 * **The loss method got out of the way.** Five options, of which "itemised" is
 * the default and is right nearly always, on every segment. It is behind a
 * disclosure now; opening it is how you say you measured the line instead.
 */

const field =
  'rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]';
const muted = 'text-[10px] text-[var(--color-text-muted)]';
const chip =
  'rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text-primary)] disabled:opacity-40';

/**
 * The fittings a stand is mostly built from, in the order they come up.
 *
 * Buttons rather than a search box. Fifteen kinds is too many to list and far
 * too few to need searching -- so the handful that appear on every run are one
 * click, and the rest stay one click further away.
 */
const COMMON: readonly (typeof FITTING_KINDS)[number][] = [
  'elbow_90', 'tee_run', 'tee_branch', 'ball_valve_full', 'elbow_45',
];

const numOf = (p?: ParamValue) => (p === undefined ? '' : String(p.value));

/** Millimetres, for the summary line, whatever it was entered in. */
const TO_MM: Record<string, number> = {
  mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8,
};
const mmOf = (p?: ParamValue) =>
  p === undefined ? null : p.value * (TO_MM[p.unit] ?? 1);

export function SegmentPanel({ segments, onChange }: {
  segments: LineSegment[];
  onChange: (next: LineSegment[]) => void;
}) {
  const readOnly = useReadOnly();
  const catalog = useMemo(() => loadCatalog(), []);
  const transitions = useMemo(() => transitionsOf(segments), [segments]);
  const [showMethod, setShowMethod] = useState(false);
  /**
   * The unit chosen for a field nobody has typed a number into yet.
   *
   * Kept here rather than on the segment because a unit with no value is not
   * something the document can hold: `ParamValue` is a value *and* a unit. The
   * first version wrote `{ value: 0, unit }` to keep the select honest, which
   * put a zero bore on a line nobody had measured -- and a zero here reads as
   * "no hole", not as "not said". Absent means absent everywhere else in this
   * app and it means absent here too.
   */
  const [pending, setPending] = useState<Record<string, string>>({});
  const unitOf = (seg: LineSegment, key: 'bore' | 'length', fallback: string) =>
    seg[key]?.unit ?? pending[`${seg.id}:${key}`] ?? fallback;

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

  const setUnit = (i: number, key: 'bore' | 'length', unit: string) => {
    const seg = segments[i];
    setPending(u => ({ ...u, [`${seg.id}:${key}`]: unit }));
    // Only a field that already has a number gets rewritten. An empty one just
    // remembers the choice, and uses it when a number arrives.
    if (seg[key]) patch(i, { [key]: { ...seg[key]!, unit } } as Partial<LineSegment>);
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

  // Nothing said yet: one button, and no vocabulary to learn first.
  if (segments.length === 0) {
    return (
      <div className="space-y-1.5 border-t border-[var(--color-border)] pt-2.5">
        <button disabled={readOnly} onClick={addSegment}
          className="w-full rounded border border-dashed border-[var(--color-border)] py-1.5 text-[11px] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-text-primary)]">
          + tube and fittings
        </button>
        <p className={muted}>
          Optional. Without it the line uses the length and bore above.
        </p>
      </div>
    );
  }

  const many = segments.length > 1;

  return (
    <div className="space-y-2 border-t border-[var(--color-border)] pt-2.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
          {many ? 'The run, by size' : 'Tube and fittings'}
        </span>
        <button onClick={() => setShowMethod(v => !v)}
          className="text-[10px] text-[var(--color-text-muted)] underline decoration-dotted hover:text-[var(--color-text-primary)]">
          {showMethod ? 'hide' : 'measured instead?'}
        </button>
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
        const byHand = boreKnown && seg.bore?.source !== 'default';

        return (
          <div key={seg.id}>
            <div className="space-y-1.5 rounded border border-[var(--color-border)] p-2">
              {/* ── What it is ─────────────────────────────────────────── */}
              <div className="flex items-center gap-1.5">
                {many && (
                  <span className="w-3 shrink-0 font-mono text-[11px] text-[var(--color-text-muted)]">{i + 1}</span>
                )}
                <select value={standard} disabled={readOnly}
                  onChange={e => pickSize(i, e.target.value as Standard, '')}
                  className={`${field} w-[124px] shrink-0`}>
                  {STANDARDS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
                <select value={seg.tubeSize ?? ''} disabled={readOnly}
                  onChange={e => pickSize(i, standard, e.target.value)}
                  className={`${field} w-[112px] shrink-0`}>
                  <option value="">pick a size…</option>
                  {sizes.map(z => <option key={z} value={z}>{z}</option>)}
                </select>

                {/* The bore is arithmetic off the size, so it is told to you
                    rather than asked of you -- until the catalogue cannot
                    answer, or somebody means something else. */}
                {!byHand && boreKnown && (
                  <span className={`${muted} whitespace-nowrap`}>
                    bore <span className="font-mono text-[var(--color-text-secondary)]">
                      {seg.bore!.value.toFixed(2)}
                    </span> mm
                  </span>
                )}
                {!byHand && boreKnown && !readOnly && (
                  <button disabled={readOnly}
                    onClick={() => patch(i, { bore: { ...seg.bore!, source: 'estimated', reference: '' } })}
                    className="text-[10px] text-[var(--color-text-muted)] underline decoration-dotted hover:text-[var(--color-text-primary)]"
                    title="Use a different bore">set</button>
                )}
                {(byHand || !boreKnown) && (
                  <>
                    <span className={muted}>bore</span>
                    <input inputMode="decimal" placeholder="mm" value={numOf(seg.bore)}
                      readOnly={readOnly} onChange={e => setNum(i, 'bore', e.target.value, unitOf(seg, 'bore', 'mm'))}
                      className={`${field} w-[56px] shrink-0`}
                      title="Flow diameter — never the thread size" />
                    <select value={unitOf(seg, 'bore', 'mm')} disabled={readOnly}
                      onChange={e => setUnit(i, 'bore', e.target.value)}
                      className={`${field} w-[52px] shrink-0`}>
                      {UNITS.length.map(u => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </>
                )}

                <button disabled={readOnly} onClick={() => onChange(segments.filter((_, j) => j !== i))}
                  className="ml-auto shrink-0 rounded px-1.5 text-[13px] leading-none text-[var(--color-text-muted)] hover:text-red-400"
                  title={many ? 'Remove this size' : 'Remove'}>×</button>
              </div>

              {/* The trap: a thread size is not a flow diameter. */}
              {seg.tubeSize && !boreKnown && (
                <p className={`${muted} text-amber-500/90`}>
                  {od
                    ? `No catalogue bore for ${standard} ${seg.tubeSize}. Type the flow diameter — the thread size is not it.`
                    : 'Type the flow diameter.'}
                </p>
              )}

              {/* ── How long ───────────────────────────────────────────── */}
              <div className="flex items-center gap-1.5">
                <span className={`${muted} w-12 shrink-0`}>Length</span>
                <input inputMode="decimal" placeholder="—" value={numOf(seg.length)}
                  readOnly={readOnly} onChange={e => setNum(i, 'length', e.target.value, unitOf(seg, 'length', 'm'))}
                  className={`${field} w-[64px] shrink-0`} />
                <select value={unitOf(seg, 'length', 'm')} disabled={readOnly}
                  onChange={e => setUnit(i, 'length', e.target.value)}
                  className={`${field} w-[56px] shrink-0`}>
                  {UNITS.length.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
                {/* Two states, named. This used to masquerade as the unit
                    ("m tube" / "m overall"), which hid a real distinction
                    inside a control nobody reads twice. */}
                <span className="ml-1 flex overflow-hidden rounded border border-[var(--color-border)]">
                  {(['tube', 'overall'] as const).map(basis => (
                    <button key={basis} disabled={readOnly}
                      onClick={() => patch(i, { lengthBasis: basis })}
                      title={basis === 'tube'
                        ? 'The straight piece you cut'
                        : 'Measured end to end, fittings included'}
                      className={`px-1.5 py-0.5 text-[10px] ${
                        (seg.lengthBasis ?? 'tube') === basis
                          ? 'bg-[var(--color-accent)] text-white'
                          : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'}`}>
                      {basis === 'tube' ? 'tube only' : 'end to end'}
                    </button>
                  ))}
                </span>
              </div>

              {/* ── How the loss is known, when it is not the fittings ── */}
              {showMethod && (
                <div className="flex items-center gap-1.5">
                  <span className={`${muted} w-12 shrink-0`}>Loss</span>
                  <select value={method} disabled={readOnly}
                    onChange={e => patch(i, { method: e.target.value as LossMethod })}
                    className={`${field} w-[128px] shrink-0`}>
                    {LOSS_METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                  <span className={muted}>{LOSS_METHODS.find(m => m.id === method)?.note}</span>
                </div>
              )}

              {(method === 'measured_K' || method === 'lumped_K') && (
                <div className="flex items-center gap-1.5">
                  <span className={`${muted} w-12 shrink-0`}>K</span>
                  <input inputMode="decimal" placeholder="—" value={numOf(seg.K)}
                    readOnly={readOnly} onChange={e => setNum(i, 'K', e.target.value, '-')}
                    className={`${field} w-[64px]`} />
                  {method === 'measured_K' && (
                    <span className={muted}>supersedes the fittings</span>
                  )}
                </div>
              )}

              {method === 'curve' && (
                <p className={muted}>
                  Δp against ṁ, entered in feed-twin against the run that produced it.
                </p>
              )}

              {method === 'itemised' && (
                <Fittings
                  rows={seg.fittings ?? []}
                  readOnly={readOnly}
                  segmentBore={seg.bore?.value}
                  onChange={rows => patch(i, { fittings: rows })}
                />
              )}

              <Summary seg={seg} />
            </div>

            {transitions[i] && (
              <p className="py-1 pl-2 text-[10px] text-[var(--color-text-muted)]">
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

      {/* "Segment" is never the word. You add another *size*, which is the
          only reason a run is ever described in more than one piece. */}
      <button disabled={readOnly} onClick={addSegment}
        className="w-full rounded border border-dashed border-[var(--color-border)] py-1 text-[11px] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text-primary)]">
        + another size along this run
      </button>
    </div>
  );
}

/**
 * What it all came to, under the controls that produced it.
 *
 * The panel asked for a size, a length and a list; this is it answering. The
 * cut length only appears when it can be answered -- every fitting needs a
 * body length, because a partial subtraction is a mis-cut part rather than an
 * approximate one.
 */
function Summary({ seg }: { seg: LineSegment }) {
  const bits: string[] = [];
  const lenMm = mmOf(seg.length);
  if (lenMm !== null) {
    bits.push(`${(lenMm / 1000).toFixed(3)} m ${seg.lengthBasis === 'overall' ? 'end to end' : 'of tube'}`);
  }
  const n = fittingCount(seg);
  if (n) bits.push(`${n} fitting${n === 1 ? '' : 's'}`);
  const k = knownK(seg);
  if (k) bits.push(`K ${k.toFixed(2)}`);

  if (seg.lengthBasis === 'overall' && lenMm !== null) {
    const flat = (seg.fittings ?? []).flatMap(r => Array.from({ length: r.count }, () => r));
    const cut = cutLength(lenMm, flat);
    bits.push(cut === null
      ? 'cut length needs a body length on every fitting'
      : `cut ${(cut / 1000).toFixed(3)} m`);
  }

  if (bits.length === 0) return null;
  return (
    <p className="border-t border-[var(--color-border)] pt-1.5 text-[10px] text-[var(--color-text-secondary)]">
      {bits.join(' · ')}
    </p>
  );
}

/** The fittings in a run: a chip each, with the common ones one click away. */
function Fittings({ rows, readOnly, segmentBore, onChange }: {
  rows: FittingRow[];
  readOnly: boolean;
  segmentBore?: number;
  onChange: (rows: FittingRow[]) => void;
}) {
  const [more, setMore] = useState(false);
  const [query, setQuery] = useState('');
  const [openRow, setOpenRow] = useState<string | null>(null);

  const matches = FITTING_KINDS.filter(k =>
    FITTING_LABELS[k].toLowerCase().includes(query.trim().toLowerCase()));

  const set = (id: string, patch: Partial<FittingRow>) =>
    onChange(rows.map(r => (r.id === id ? { ...r, ...patch } : r)));

  /** One more of this kind, wherever it already is in the run. */
  const add = (kind: (typeof FITTING_KINDS)[number]) => {
    const existing = rows.find(r => r.kind === kind);
    if (existing) set(existing.id, { count: existing.count + 1 });
    else onChange([...rows, { id: nextRowId(), kind, count: 1 }]);
  };

  const numField = (v: number | undefined, onSet: (n: number | undefined) => void, ph: string) => (
    <input
      inputMode="decimal" placeholder={ph} value={v === undefined ? '' : String(v)}
      readOnly={readOnly}
      onChange={e => {
        const t = e.target.value.trim();
        onSet(t === '' ? undefined : Number.isFinite(Number(t)) ? Number(t) : undefined);
      }}
      className={`${field} w-[58px]`}
    />
  );

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1">
        <span className={`${muted} w-12 shrink-0`}>Fittings</span>
        {rows.length === 0 && <span className={muted}>none yet</span>}
        {rows.map(r => (
          <span key={r.id}
            className="flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] pl-1.5 text-[10px]">
            <span className="text-[var(--color-text-secondary)]">{FITTING_LABELS[r.kind]}</span>
            <span className="font-mono text-[var(--color-text-primary)]">×{r.count}</span>
            <button disabled={readOnly} title="One fewer"
              onClick={() => (r.count <= 1
                ? onChange(rows.filter(x => x.id !== r.id))
                : set(r.id, { count: r.count - 1 }))}
              className="px-1 text-[var(--color-text-muted)] hover:text-red-400">−</button>
            <button disabled={readOnly} title="One more"
              onClick={() => set(r.id, { count: r.count + 1 })}
              className="px-1 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]">+</button>
            <button title="Bore, body length, measured K"
              onClick={() => setOpenRow(openRow === r.id ? null : r.id)}
              className={`px-1 ${r.boreMm !== undefined || r.lengthMm !== undefined || r.K !== undefined
                ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'} hover:text-[var(--color-text-primary)]`}>⋮</button>
          </span>
        ))}
      </div>

      {/* Three elbows is three clicks. */}
      <div className="flex flex-wrap items-center gap-1 pl-[3.25rem]">
        {COMMON.map(k => (
          <button key={k} disabled={readOnly} onClick={() => add(k)} className={chip}>
            + {FITTING_LABELS[k]}
          </button>
        ))}
        <button disabled={readOnly} onClick={() => { setMore(v => !v); setQuery(''); }}
          className={chip}>{more ? 'less' : 'more…'}</button>
      </div>

      {more && (
        <div className="ml-[3.25rem] space-y-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-1.5">
          <input autoFocus value={query} placeholder="search fittings…" readOnly={readOnly}
            onChange={e => setQuery(e.target.value)} className={`${field} w-full`} />
          <div className="flex flex-wrap gap-1">
            {matches.map(k => (
              <button key={k} disabled={readOnly} onClick={() => add(k)} className={chip}>
                + {FITTING_LABELS[k]}
              </button>
            ))}
            {matches.length === 0 && <span className={muted}>nothing matches</span>}
          </div>
        </div>
      )}

      {rows.map(r => openRow === r.id && (
        <div key={`d-${r.id}`}
          className="ml-[3.25rem] flex flex-wrap items-center gap-1.5 rounded bg-[var(--color-bg-primary)] p-1.5">
          <span className={muted}>{FITTING_LABELS[r.kind]}</span>
          <span className={muted}>· bore</span>
          {numField(r.boreMm, v => set(r.id, { boreMm: v }), segmentBore ? String(segmentBore.toFixed(2)) : 'mm')}
          <span className={muted}>mm · body</span>
          {numField(r.lengthMm, v => set(r.id, { lengthMm: v }), 'mm')}
          <span className={muted}>mm · engages</span>
          {numField(r.engagementMm, v => set(r.id, { engagementMm: v }), 'mm')}
          <span className={muted}>mm · K</span>
          {numField(r.K, v => set(r.id, { K: v }), 'measured')}
        </div>
      ))}
    </div>
  );
}

export { fittingCount, knownK };
