/**
 * The one save bar for the hookup, wherever it is being edited: the P&ID's
 * side panel (Symbols and DAQ box), the State machine tab, the Knobs page.
 * They share one draft (lib/useHookup), so the bar says the same thing on
 * each -- and an edit made on one tab is still waiting to be saved on the
 * next.
 */

import { Link } from 'react-router-dom';
import { badge } from '../lib/daqDrag';
import { useHookup } from '../lib/useHookup';
import { useStand } from '../stand';

const SAVE =
  'rounded bg-blue-600 px-2.5 py-0.5 text-[11px] font-semibold text-white hover:bg-blue-500 disabled:opacity-40';

export function HookupSaveBar({ compact = false }: { compact?: boolean }) {
  const hookup = useHookup();
  const { data, draft, dirty } = hookup;
  // Nothing saved and nothing changed: the twin's suggestion, which the
  // console does not narrow to until somebody keeps it.
  const suggested = Boolean(data && draft && !data.saved && !dirty);
  // A load that failed is the panel's own message; this is the save's.
  const error = draft ? hookup.error : '';
  // What the backend would refuse, said before Save rather than after: a
  // cable to a symbol a later drawing dropped, a knob on a regulator gone.
  const lost = draft ? draft.channels.filter((c) => !hookup.symbol(c.symbol)) : [];
  const known = new Set((data?.regulators ?? []).map((r) => r.id));
  const stray = draft ? [...new Set(draft.knobs.flatMap((k) => k.regulators))].filter((r) => !known.has(r)) : [];
  const problems = [
    ...lost.map((c) => `${c.name} (${badge(c)}) goes to ${c.symbol}, which this drawing no longer has: unplug it.`),
    ...(stray.length ? [`Knobs set regulators this drawing no longer has (${stray.join(', ')}): take them off.`] : []),
  ];
  if (!dirty && !suggested && !error && !problems.length) return null;
  const saveTitle = hookup.locked
    ? 'Take the stand (top bar) to change its hookup'
    : hookup.onStand
      ? 'Kept with the stand: Save the stand to keep it for good'
      : 'Kept for this drawing, for everyone';
  const discard = () => {
    // A name is one keystroke to put back; wiring, a table and knobs on
    // three tabs are not.
    if (
      !hookup.namesOnly &&
      !window.confirm('Discard the unsaved hookup? Every change not yet saved on the P&ID, State machine and Knobs tabs goes.')
    )
      return;
    hookup.discard();
  };
  return (
    <div className={compact ? 'mt-1.5' : ''}>
      {(dirty || suggested) && (
        <div
          className={`flex items-center gap-2 rounded-md border ${
            dirty ? 'border-blue-900/70 bg-blue-950/30' : 'border-[var(--line)] bg-white/[0.02]'
          } ${compact ? 'px-2 py-1' : 'px-3 py-2'}`}
        >
          <span
            className={`flex-1 ${dirty ? 'text-blue-200' : 'text-gray-400'} ${compact ? 'text-[11px]' : 'text-[12px]'}`}
            title={
              suggested
                ? 'The twin matched this by name. Until it is saved the console shows every valve and transducer; saved, only what is on the DAQ box.'
                : undefined
            }
          >
            {suggested
              ? 'Suggested · not saved'
              : hookup.namesOnly
                ? 'Unsaved names'
                : 'Unsaved hookup — saving restarts the stand'}
          </span>
          {dirty && (
            <button
              type="button"
              onClick={discard}
              className="rounded px-1.5 py-0.5 text-[11px] text-gray-400 hover:text-white"
            >
              Discard
            </button>
          )}
          <button
            type="button"
            disabled={hookup.busy || hookup.locked}
            onClick={hookup.save}
            title={suggested ? `Keep the suggestion as this hookup. ${saveTitle}; the stand restarts.` : saveTitle}
            className={SAVE}
          >
            {hookup.busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
      {problems.map((p) => (
        <p key={p} className="mt-1 text-[11px] text-red-300" title="Saving is refused until it is fixed">
          {p}
        </p>
      ))}
      {error && <p className="mt-1 text-[11px] text-red-300">{error}</p>}
    </div>
  );
}

/** Where the hookup stands, as a chip beside a panel's heading: what the
 *  draft is, not only what was last saved -- "Saved" over a waiting edit
 *  would contradict the bar at the foot. */
export function HookupStatus() {
  const hookup = useHookup();
  const data = hookup.data;
  if (!data) return null;
  const [text, tone, title] = hookup.dirty
    ? [
        'Unsaved',
        'bg-blue-950/60 text-blue-200',
        'Changed here and not saved yet: Save or Discard in the bar below.',
      ]
    : data.saved
      ? [
          'Saved',
          'bg-emerald-900/40 text-emerald-300',
          hookup.onStand ? 'The stand’s own hookup.' : 'Saved for this drawing.',
        ]
      : [
          'Suggested',
          'bg-gray-800 text-gray-300',
          'The twin’s suggestion, matched by name: not saved. Until it is, the console shows every valve and transducer.',
        ];
  return (
    <span className={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold ${tone}`} title={title}>
      {text}
    </span>
  );
}

/** The same words everywhere for a stand somebody else has. */
export function ReadOnly() {
  const { locked } = useHookup();
  if (!locked) return null;
  return (
    <span className="shrink-0 text-[11px] text-[var(--color-warning)]" title="Take the stand (top bar) to edit">
      Read only
    </span>
  );
}

/** What a hookup page says before there is a hookup to show. */
export function NoHookup({ error }: { error: string }) {
  const { where } = useStand();
  if (error) return <p className="p-6 text-sm text-red-400">{error}</p>;
  if (!where.diagram) {
    return (
      <p className="p-6 text-sm text-text-muted">
        No drawing.{' '}
        <Link to="/library" className="text-blue-400 hover:underline">
          Pick one in Library →
        </Link>
      </p>
    );
  }
  return <p className="p-6 text-sm text-text-muted">Loading…</p>;
}

/** The confirm in front of "Back to suggested", the same wherever it is. */
export function confirmReset(onStand: boolean): boolean {
  return window.confirm(
    `Go back to the twin’s own matching? This forgets the whole hookup saved for this ${
      onStand ? 'stand' : 'drawing'
    }: the DAQ box, the edited state table and the knobs, straight away.`,
  );
}
