import { useMemo, useState } from 'react';
import { useReadOnly } from '@stardesign-ui';
import {
  FITTING_KINDS, FITTING_LABELS, LOSS_METHODS,
  cutTubeOf, endsOf, fittingCount, joinFamilyOf, joinSizeOf, jointsForRow,
  jointFaultsOf, jointsOf, knownK, methodOf, needsOwnSize, needsThreadLength,
  nextRowId, nextSegmentId, overlapOf, transitionsOf,
} from './segments';
import type { PartDepths } from './segments';
import type { FittingRow, LineSegment, LossMethod } from './segments';
import { FAMILY_LABELS, MAKEUP, THREAD_PROMPT, isMissing } from './terminations';
import type { Family, Gender, Termination } from './terminations';
import { STANDARDS, TUBE_SIZES, DASH_SIZES, NPT_SIZES, loadCatalog, suggestBore, tubeOdForSize } from './catalog';
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
  // A swage insertion depth is the manufacturer's figure for that series, so
  // it comes from the catalogue entry the fitting was picked from -- not from
  // the user, and not from a table in this app pretending to know.
  const depths = useMemo<PartDepths>(() => {
    const by = new Map(catalog.map(p => [p.id, p.engagementMm]));
    return (partId: string) => by.get(partId);
  }, [catalog]);
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
    onChange([...segments, { id: nextSegmentId(segments), method: 'itemised', fittings: [], standard: 'tube' }]);

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

              {/* ── How the fittings join ──────────────────────────────
                  One answer for the run, because a run is built to one joint
                  standard. Every fitting inherits it and the overlap at every
                  joint follows, so nobody types an engagement. Four of the
                  five line standards *are* joint families, and for those this
                  is already answered by the size row above. */}
              <JoinBy segment={seg} readOnly={readOnly}
                onChange={joinBy => patch(i, { joinBy })}
                onSize={joinSize => patch(i, { joinSize })}
                onThread={joinThreadMm => patch(i, { joinThreadMm })} />

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
                  segment={seg}
                  depths={depths}
                  onChange={rows => patch(i, { fittings: rows })}
                />
              )}

              <Summary seg={seg} depths={depths} />
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
function Summary({ seg, depths }: { seg: LineSegment; depths: PartDepths }) {
  const bits: string[] = [];
  const lenMm = mmOf(seg.length);
  if (lenMm !== null) {
    bits.push(`${(lenMm / 1000).toFixed(3)} m ${seg.lengthBasis === 'overall' ? 'end to end' : 'of tube'}`);
  }
  const n = fittingCount(seg);
  if (n) bits.push(`${n} fitting${n === 1 ? '' : 's'}`);
  const k = knownK(seg);
  if (k) bits.push(`K ${k.toFixed(2)}`);

  // How much the joints take out of the sum of the parts -- worked out from
  // the standard and the seal, never typed. See `terminations.ts`.
  //
  // A run with no joints yet (one fitting, or none) is not missing anything, so
  // it says nothing. A run that *has* joints but cannot price them says which
  // answer is missing, because silence there reads as "no overlap" and sends
  // somebody to the bandsaw with a figure that is long by every joint.
  const overlap = overlapOf(seg, depths);
  const joints = jointsOf(seg, depths);
  if (overlap && overlap.mm > 0) {
    bits.push(`joints overlap ${overlap.mm.toFixed(1)} mm`);
  }

  if (seg.lengthBasis === 'overall' && lenMm !== null) {
    const cut = cutTubeOf(seg, lenMm, depths);
    bits.push('needs' in cut
      ? `cut length needs ${cut.needs}`
      : `cut ${(cut.mm / 1000).toFixed(3)} m`);
  }

  const faults = jointFaultsOf(seg, depths);
  const unpriced = !overlap && faults.length === 0 && joints.length > 0
    ? joints.map(j => j.engagement).find(isMissing)?.needs ?? null
    : null;
  if (bits.length === 0 && faults.length === 0 && !unpriced) return null;
  return (
    <div className="space-y-0.5 border-t border-[var(--color-border)] pt-1.5">
      {bits.length > 0 && (
        <p className="text-[10px] text-[var(--color-text-secondary)]">{bits.join(' · ')}</p>
      )}
      {/* A figure nobody has checked against the standard says so. The number
          is still used -- absent would be worse -- but a cut list built on it
          should not look like a citation. */}
      {overlap && overlap.unverified > 0 && (
        <p className="text-[10px] text-amber-500/90">
          {overlap.unverified} joint{overlap.unverified === 1 ? '' : 's'} using an
          unchecked NPT engagement — see terminations.ts
        </p>
      )}
      {unpriced && (
        <p className="text-[10px] text-amber-500/90">
          the joints are not accounted for yet — needs {unpriced}
        </p>
      )}
      {/* One line per distinct fault, with how many joints it hits. Three
          identical elbows used to print the same complaint three times. */}
      {faults.map(f => (
        <p key={f.why} className="text-[10px] text-red-400">
          {f.why}{f.joints > 1 && ` — at ${f.joints} joints`}
        </p>
      ))}
    </div>
  );
}

/** The fittings in a run: a chip each, with the common ones one click away. */
function Fittings({ rows, readOnly, segmentBore, segment, depths, onChange }: {
  rows: FittingRow[];
  readOnly: boolean;
  segmentBore?: number;
  segment: LineSegment;
  depths: PartDepths;
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
    else onChange([...rows, { id: nextRowId(rows), kind, count: 1 }]);
  };

  const numField = (
    v: number | undefined,
    onSet: (n: number | undefined) => void,
    ph: string,
    title?: string,
  ) => (
    <input
      inputMode="decimal" placeholder={ph} value={v === undefined ? '' : String(v)}
      readOnly={readOnly} title={title}
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
          className="ml-[3.25rem] space-y-1.5 rounded bg-[var(--color-bg-primary)] p-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-[var(--color-text-secondary)]">{FITTING_LABELS[r.kind]}</span>
            <span className={muted}>· bore</span>
            {numField(r.boreMm, v => set(r.id, { boreMm: v }), segmentBore ? String(segmentBore.toFixed(2)) : 'mm')}
            <span className={muted}>mm · body</span>
            {numField(r.lengthMm, v => set(r.id, { lengthMm: v }), 'mm')}
            <span className={muted}>mm · K</span>
            {numField(r.K, v => set(r.id, { K: v }), '—',
              "This fitting's own K, if it was measured. Left blank it adds no loss of its own.")}
          </div>
          <Ends row={r} segment={segment} readOnly={readOnly} depths={depths}
            onChange={ends => set(r.id, { ends })}
            onThread={mm => set(r.id, { threadMm: mm })}
            onSame={() => set(r.id, { ends: undefined })} />
        </div>
      ))}
    </div>
  );
}

export { fittingCount, knownK };

const GENDERS: Gender[] = ['male', 'female'];

/** The families somebody actually builds a run out of, in that order. */
const JOIN_CHOICES: Family[] = ['NPT', 'JIC', 'AN', 'ORB', 'swage', 'weld'];

/**
 * How the fittings on this run join, asked once.
 *
 * This is the control that makes engagement automatic. Answer it and every
 * joint on the run has an overlap -- from the standard for NPT, from the seal
 * for a cone or a boss, zero for a weld -- with nothing typed per fitting.
 *
 * When the line standard is itself a joint family there is nothing to ask, so
 * this states the answer instead of offering it. That is the common case: a
 * JIC run is JIC throughout.
 */
function JoinBy({ segment, readOnly, onChange, onSize, onThread }: {
  segment: LineSegment;
  readOnly: boolean;
  onChange: (family: Family | undefined) => void;
  onSize: (size: string | undefined) => void;
  onThread: (mm: number | undefined) => void;
}) {
  const implied = joinFamilyOf({ ...segment, joinBy: undefined });
  const chosen = joinFamilyOf(segment);
  const size = joinSizeOf(segment);

  // The line standard already named the family, so there is nothing to ask.
  // An NPT line is NPT throughout at the size in the row above.
  // The length a cone or a shoulder closes on, asked once for the run. It is
  // a measurement, not a table lookup, so it has to be asked -- but once.
  const thread = needsThreadLength(chosen ?? 'unset') && (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className={`${muted} w-12 shrink-0`} />
      <input inputMode="decimal" placeholder="mm" readOnly={readOnly}
        value={segment.joinThreadMm === undefined ? '' : String(segment.joinThreadMm)}
        onChange={e => {
          const t = e.target.value.trim();
          onThread(t === '' ? undefined : Number.isFinite(Number(t)) ? Number(t) : undefined);
        }}
        className={`${field} w-[58px] shrink-0`}
        title="The male thread length this family closes on, in mm. Set once for the run." />
      <span className={muted}>
        mm {chosen ? THREAD_PROMPT[chosen] ?? 'of engagement' : 'of engagement'}
      </span>
    </div>
  );

  if (implied && !segment.joinBy) {
    return (
      <div className="space-y-1">
        <p className={muted}>
          joins by <span className="text-[var(--color-text-secondary)]">{FAMILY_LABELS[implied]}</span>
          {' — '}{MAKEUP[implied].note}
          {thread ? ', which closes on:' : ', so the overlap at every joint is worked out'}
        </p>
        {thread}
      </div>
    );
  }

  // A thread size is not the tube size, and a run of 1/2 tube into 1/4 NPT is
  // an ordinary thing to build -- so a thread gets asked. A swage fitting
  // grips the tube and takes the tube's size, so it does not.
  const threaded = chosen !== undefined && needsOwnSize(chosen);

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
      <span className={`${muted} w-12 shrink-0`}>Joins by</span>
      <select value={segment.joinBy ?? ''} disabled={readOnly}
        onChange={e => onChange((e.target.value || undefined) as Family | undefined)}
        className={`${field} w-[148px] shrink-0`}
        title="How the fittings on this run screw together. Set once; every fitting follows.">
        <option value="">how do they join?…</option>
        {JOIN_CHOICES.map(f => <option key={f} value={f}>{FAMILY_LABELS[f]}</option>)}
      </select>
      {threaded && (
        <select value={size} disabled={readOnly}
          onChange={e => onSize(e.target.value || undefined)}
          className={`${field} w-[100px] shrink-0`}
          title="The thread size, which is not the tube size">
          <option value="">thread size…</option>
          {(chosen === 'NPT' ? [...NPT_SIZES] : DASH_SIZES.map(d => `-${d}`))
            .map(z => <option key={z} value={z}>{z}</option>)}
        </select>
      )}
      <span className={muted}>
        {!chosen ? 'until this is answered the cut tube cannot be worked out'
          : threaded && !size ? 'the thread size, which is not the tube size'
          : thread ? `${MAKEUP[chosen].note}, which closes on:`
          : `${MAKEUP[chosen].note} — the overlap follows from that`}
      </span>
      </div>
      {thread}
    </div>
  );
}

/**
 * One fitting's two ends, and the joints they make with their neighbours.
 *
 * Almost always nothing to do: a fitting is the run's joint family at the
 * run's size, male into female so the next one screws on, and the engagement
 * is derived. Saying that per fitting would be sixty entries of the obvious,
 * so it is stated in one line with a way in for the case it exists for -- an
 * adapter, where the two ends genuinely differ and the whole question of which
 * ID to measure from turns on which half is male.
 *
 * The joints shown are against the *neighbours*, not between this fitting's
 * own two ends. An elbow's inlet and outlet do not screw into each other.
 */
function Ends({ row, segment, readOnly, depths, onChange, onThread, onSame }: {
  row: FittingRow;
  segment: LineSegment;
  readOnly: boolean;
  depths: PartDepths;
  onChange: (ends: { a: Termination; b: Termination }) => void;
  onThread: (mm: number | undefined) => void;
  onSame: () => void;
}) {
  const ends = endsOf(row, segment);
  const custom = row.ends !== undefined;
  const { inlet, outlet } = jointsForRow(segment, row.id, depths);

  const set = (which: 'a' | 'b', next: Partial<Termination>) =>
    onChange({ ...ends, [which]: { ...ends[which], ...next } });

  const sizesFor = (family: Family) =>
    family === 'tube' ? TUBE_SIZES.map(t => t.label)
    : family === 'NPT' ? [...NPT_SIZES]
    : DASH_SIZES.map(d => `-${d}`);

  // Only a male end can owe a thread length: it is the half that goes in, so
  // it is the half whose length is the depth. A female's thread is the hole.
  const wantsThread = [ends.a, ends.b]
    .some(e => e.gender === 'male' && needsThreadLength(e.family));

  const endRow = (which: 'a' | 'b', label: string) => {
    const e = ends[which];
    return (
      <div className="flex flex-wrap items-center gap-1">
        <span className={`${muted} w-8 shrink-0`}>{label}</span>
        <select value={e.family} disabled={readOnly}
          onChange={ev => set(which, { family: ev.target.value as Family })}
          className={`${field} w-[92px] shrink-0`}>
          {JOIN_CHOICES.concat('tube').map(f => (
            <option key={f} value={f}>{FAMILY_LABELS[f]}</option>
          ))}
        </select>
        <select value={e.size} disabled={readOnly}
          onChange={ev => set(which, { size: ev.target.value })}
          className={`${field} w-[96px] shrink-0`}>
          <option value="">size…</option>
          {sizesFor(e.family).map(z => <option key={z} value={z}>{z}</option>)}
        </select>
        <select value={e.gender} disabled={readOnly}
          onChange={ev => set(which, { gender: ev.target.value as Gender })}
          className={`${field} w-[72px] shrink-0`}>
          {GENDERS.map(g => <option key={g} value={g}>{g}</option>)}
        </select>
      </div>
    );
  };

  /** A joint, said in one line: what meets what, and how far in it goes. */
  const jointLine = (label: string, joint: ReturnType<typeof jointsForRow>['inlet']) => {
    if (!joint) return null;
    const { engagement, mismatch, restricting } = joint;
    return (
      <p className={muted} key={label}>
        <span className="text-[var(--color-text-secondary)]">{label}</span>{' '}
        {mismatch
          ? <span className="text-red-400">{mismatch}</span>
          : isMissing(engagement)
            ? <span className="text-amber-500/90">needs {engagement.needs}</span>
            : <>
                closes{' '}
                <span className="font-mono text-[var(--color-text-secondary)]">
                  {engagement.mm.toFixed(2)}
                </span> mm
                {!engagement.verified && <span className="text-amber-500/90"> (unchecked)</span>}
                {' · '}bore from the {restricting.gender} side
              </>}
      </p>
    );
  };

  return (
    <div className="space-y-1 border-t border-[var(--color-border)] pt-1.5">
      {!custom ? (
        <p className={muted}>
          ends: {FAMILY_LABELS[ends.a.family]}{ends.a.size ? ` ${ends.a.size}` : ''}, male
          into female — same as the run.{' '}
          <button disabled={readOnly} onClick={() => onChange(ends)}
            className="underline decoration-dotted hover:text-[var(--color-text-primary)]"
            title="For an adapter, where the two ends differ">it's an adapter</button>
        </p>
      ) : (
        <>
          {endRow('a', 'in')}
          {endRow('b', 'out')}
          <button disabled={readOnly} onClick={onSame}
            className={`${muted} underline decoration-dotted hover:text-[var(--color-text-primary)]`}>
            back to the run's ends
          </button>
        </>
      )}

      {/* Only for a fitting whose ends were overridden -- otherwise the run's
          own figure covers it, and this would be the same number twice. */}
      {wantsThread && custom && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`${muted} w-8 shrink-0`}>thread</span>
          <input inputMode="decimal" placeholder="mm" readOnly={readOnly}
            value={row.threadMm === undefined ? '' : String(row.threadMm)}
            onChange={ev => {
              const t = ev.target.value.trim();
              onThread(t === '' ? undefined : Number.isFinite(Number(t)) ? Number(t) : undefined);
            }}
            className={`${field} w-[58px]`} />
          <span className={muted}>
            mm {THREAD_PROMPT[ends.a.gender === 'male' ? ends.a.family : ends.b.family]
              ?? 'of engagement'}
            {segment.joinThreadMm !== undefined && ' — blank uses the run\u2019s'}
          </span>
        </div>
      )}

      {jointLine('in:', inlet)}
      {jointLine('out:', outlet)}
    </div>
  );
}
