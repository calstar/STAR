/**
 * The hookup's regulator knobs: which dial on GSE Controls sets which
 * regulator on the drawing.
 *
 * An imported drawing arrives with its own regulators. The twin gives every
 * hand-loaded one a knob (the stand's dome, the COPV charge, one each for the
 * rest); this page is where a person regroups them -- a knob, the regulators
 * on it, where it starts -- without editing the drawing. Kept per drawing (by
 * where it comes from, so saving the drawing again keeps it), and with a stand
 * when one is open.
 *
 * Which valve each state-machine actuator drives, and what the console shows
 * and calls each valve and transducer, are set on the P&ID tab's symbol panel
 * (the operator, 2026-10-09: "this looks way better than the hookup page").
 */

import { Link } from 'react-router-dom';
import { DOME_KNOB, type KnobDef } from '../api';
import { useHookup } from '../lib/useHookup';
import { useStand } from '../stand';

export function Hookup() {
  const { standHookup } = useStand();
  const { data, draft, setDraft, error, busy, dirty, onStand, locked, save, reset } = useHookup();

  if (error) return <p className="p-6 text-sm text-red-400">{error}</p>;
  if (!data || !draft) return <p className="p-6 text-sm text-text-muted">Reading the drawing…</p>;

  const owner = (id: string) => draft.knobs.find((k) => k.regulators.includes(id));

  const setKnob = (index: number, patch: Partial<KnobDef>) => {
    const knobs = draft.knobs.map((k, i) => (i === index ? { ...k, ...patch } : k));
    setDraft({ ...draft, knobs });
  };

  const toggleRegulator = (index: number, id: string) => {
    // A regulator is set by one knob: taking it here takes it off any other.
    const knobs = draft.knobs.map((k, i) => {
      if (i === index) {
        if (k.regulators.includes(id)) return { ...k, regulators: k.regulators.filter((r) => r !== id) };
        // The first regulator on a knob sets where it starts: its drawn setting,
        // so linking a regulator to a knob does not move it.
        const drawn = data.regulators.find((r) => r.id === id)?.drawn_psig;
        const psig = k.regulators.length === 0 && drawn != null ? Math.round(drawn) : k.psig;
        return { ...k, psig, regulators: [...k.regulators, id] };
      }
      return { ...k, regulators: k.regulators.filter((r) => r !== id) };
    });
    setDraft({ ...draft, knobs });
  };

  const addKnob = () => {
    let n = draft.knobs.length + 1;
    while (draft.knobs.some((k) => k.id === `knob-${n}`)) n += 1;
    setDraft({
      ...draft,
      knobs: [...draft.knobs, { id: `knob-${n}`, label: `Regulator knob ${n}`, regulators: [], psig: 500, low: 0, high: 1000 }],
    });
  };

  const unknobbed = data.regulators.filter((r) => !owner(r.id));

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-3 p-4">
      <div className="bg-card flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-gray-800 px-4 py-3">
        <div className="min-w-0">
          <div className="caps text-[10px]">Hookup</div>
          <div className="truncate text-[13px]" title="Kept for every version of this drawing, by where it comes from.">
            {data.lineage}
          </div>
        </div>
        <span className="text-[12px] text-text-muted" title="pid-designer pages on this drawing; paired disconnects join them.">
          {data.pages.length} page{data.pages.length === 1 ? '' : 's'}: {data.pages.join(', ')}
          {data.mated.length > 0 && ` · ${data.mated.length} mated disconnect${data.mated.length === 1 ? '' : 's'}`}
        </span>
        <span
          className={`rounded px-2 py-0.5 text-[11px] font-semibold ${
            data.saved ? 'bg-emerald-900/40 text-emerald-300' : 'bg-gray-800 text-gray-300'
          }`}
          title={
            onStand
              ? "The stand's own hookup."
              : data.saved
                ? 'Saved for this drawing.'
                : 'Nothing saved: this is what the twin matched by itself.'
          }
        >
          {onStand && standHookup ? 'On the stand' : data.saved ? 'Saved' : 'Suggested'}
        </span>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            disabled={busy || !data.saved || locked}
            onClick={reset}
            title="Forget what was saved and go back to the twin's own matching."
            className="rounded bg-gray-700 px-3 py-1 text-[12px] font-semibold text-white hover:bg-gray-600 disabled:opacity-40"
          >
            Back to suggestions
          </button>
          <button
            type="button"
            disabled={busy || (!dirty && data.saved) || locked}
            onClick={save}
            title={
              locked
                ? 'Take the stand to change its hookup'
                : onStand
                  ? "Keep this hookup with the stand (the stand's Save writes it). The cockpit restarts with it."
                  : 'Keep this hookup for the drawing. The cockpit restarts with it.'
            }
            className="rounded bg-blue-600 px-3 py-1 text-[12px] font-semibold text-white hover:bg-blue-500 disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <p className="text-[12px] text-text-muted">
        Valves and transducers — what drives them, whether the console shows them, what it calls them — are set on the{' '}
        <Link to="/pid" className="text-blue-400 hover:underline">
          P&amp;ID
        </Link>{' '}
        tab.
      </p>

      <div className="bg-card rounded-lg border border-gray-800">
        <h2 className="flex items-baseline border-b border-gray-800 px-4 py-2.5 caps">
          Knobs
          <span className="ml-2 font-normal normal-case tracking-normal text-gray-600">
            each a dial on the GSE page, and the regulators it sets
          </span>
          <button
            type="button"
            onClick={addKnob}
            className="ml-auto rounded bg-gray-700 px-2 py-0.5 text-[11px] font-semibold normal-case tracking-normal text-white hover:bg-gray-600"
          >
            Add knob
          </button>
        </h2>
        {data.vehicle_only && (
          <p
            className="border-b border-gray-800 px-4 py-2 text-[12px] text-text-muted"
            title="With the drawn GSE ignored the cart's regulators are not simulated: the dome knob turns the rocket's dome-loaded regulator itself, and the COPV fill is the built-in charge to this knob's setting. The knobs here are the whole drawing's, kept for when the GSE is simulated again; GSE Controls shows the ones the stand turns now."
          >
            Rocket only — the dome knob turns the rocket's regulator directly; these are the whole drawing's knobs.
          </p>
        )}
        <div className="flex flex-col divide-y divide-gray-800/60">
          {draft.knobs.map((knob, index) => (
            <div key={knob.id} className="flex flex-wrap items-start gap-4 px-4 py-3">
              <div className="flex min-w-[220px] flex-col gap-1.5">
                <input
                  value={knob.label}
                  onChange={(e) => setKnob(index, { label: e.target.value })}
                  className="rounded border border-gray-700 bg-black/60 px-2 py-1 text-[13px] font-semibold"
                />
                <div className="flex items-center gap-2 text-[11px] text-text-muted">
                  {(['psig', 'low', 'high'] as const).map((key) => (
                    <label key={key} className="flex items-center gap-1" title={key === 'psig' ? 'Where it starts' : key === 'low' ? 'Lowest setting' : 'Highest setting'}>
                      {key === 'psig' ? 'start' : key}
                      <input
                        type="number"
                        value={knob[key]}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v)) setKnob(index, { [key]: v });
                        }}
                        className="w-16 rounded border border-gray-700 bg-black/60 px-1 py-0.5 font-mono"
                      />
                    </label>
                  ))}
                  <span>psig</span>
                </div>
                {knob.id === DOME_KNOB && (
                  <span className="text-[11px] text-text-muted" title="Layer X's lockup solve and the Configuration tab's dome setting drive this one.">
                    the stand's dome setting
                  </span>
                )}
              </div>
              <div className="flex flex-1 flex-wrap gap-1.5">
                {data.regulators.map((r) => {
                  const on = knob.regulators.includes(r.id);
                  const elsewhere = !on && owner(r.id);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => toggleRegulator(index, r.id)}
                      title={
                        (r.kind === 'loader'
                          ? 'Control regulator: sets another regulator\'s dome'
                          : r.kind === 'dome'
                            ? 'Dome-loaded regulator: the knob sets its dome'
                            : 'Hand-loaded regulator: the knob sets its setpoint') +
                        (r.drawn_psig != null ? `. Drawn at ${r.drawn_psig} psig.` : '.') +
                        (elsewhere ? ` On "${elsewhere.label}" now; clicking moves it here.` : '')
                      }
                      className={`rounded border px-2 py-0.5 text-[12px] ${
                        on
                          ? 'border-blue-500 bg-blue-600/30 text-white'
                          : elsewhere
                            ? 'border-gray-800 text-gray-600'
                            : 'border-gray-700 text-gray-300 hover:border-gray-500'
                      }`}
                    >
                      {r.label}
                      {data.pages.length > 1 && <span className="ml-1 text-[10px] text-gray-500">{r.page}</span>}
                    </button>
                  );
                })}
                {data.regulators.length === 0 && (
                  <span className="text-[12px] text-text-muted">No regulators on this drawing.</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setDraft({ ...draft, knobs: draft.knobs.filter((_, i) => i !== index) })}
                aria-label={`Remove ${knob.label}`}
                className="px-1 text-[13px] text-gray-500 hover:text-red-400"
              >
                ×
              </button>
            </div>
          ))}
          {draft.knobs.length === 0 && (
            <p className="px-4 py-3 text-[12px] text-text-muted">No knobs: every regulator holds its drawn setting.</p>
          )}
        </div>
        {unknobbed.length > 0 && (
          <p className="border-t border-gray-800 px-4 py-2 text-[12px] text-text-muted">
            Held at the drawing's setting: {unknobbed.map((r) => r.label).join(', ')}
          </p>
        )}
        {!draft.knobs.some((k) => k.id === 'charge') && (
          <p
            className="border-t border-gray-800 px-4 py-2 text-[12px] text-text-muted"
            title="The GSE page's COPV knob is the twin's own fill. Draw the cart's high-press regulator and its line to the COPV, and that regulator gets the knob."
          >
            The COPV fill knob on GSE Controls is the twin's built-in fill: no regulator on this
            drawing charges the COPV.
          </p>
        )}
      </div>
    </div>
  );
}
