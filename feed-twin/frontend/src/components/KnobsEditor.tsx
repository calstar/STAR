/**
 * The hookup's regulator knobs: which dial on GSE Controls sets which
 * regulator on the drawing. At the foot of GSE Controls, under the dials it
 * sets up (it was a tab of its own).
 *
 * An imported drawing arrives with its own regulators. The twin gives every
 * hand-loaded one a knob (the stand's dome, the COPV charge, one each for the
 * rest); this is where a person regroups them -- a knob, the regulators on
 * it, where it starts -- without editing the drawing. Kept per drawing (by
 * where it comes from, so saving the drawing again keeps it), and with a stand
 * when one is open.
 *
 * The rest of the hookup -- the DAQ box (which connector each valve and
 * transducer is wired to, and the name it goes by) and the state table -- is
 * on the P&ID and State machine tabs. All of it is one draft (lib/useHookup),
 * saved from any of them.
 */

import { DOME_KNOB, type KnobDef } from '../api';
import { useHookup } from '../lib/useHookup';
import { HookupSaveBar, HookupStatus, ReadOnly } from './HookupSaveBar';

const BTN =
  'rounded border border-[var(--line-strong)] px-2 py-0.5 text-[11px] text-[var(--ink-2)] hover:text-[var(--ink)] disabled:opacity-40';

export function KnobsEditor() {
  const { data, draft, setDraft, error, locked } = useHookup();

  if (!data || !draft) {
    return error ? <p className="text-[12px] text-red-400">{error}</p> : null;
  }

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
    <section id="knobs">
      <h2
        className="mb-1 flex items-center gap-2 caps"
        title="Each dial above, and the regulators on the drawing it sets. Kept for every version of this drawing (by where it comes from). Valves and transducers go on the DAQ box (P&ID tab); what each state opens is on the State machine tab."
      >
        Which knob turns which regulator
        <HookupStatus />
        <ReadOnly />
      </h2>
      <div className="mb-1.5 empty:hidden">
        <HookupSaveBar compact />
      </div>
      <div className="bg-card rounded-xl border border-gray-800">
        <div className="flex items-center border-b border-gray-800 px-4 py-2">
          <span className="text-[12px] text-text-muted" title="pid-designer pages on this drawing; paired disconnects join them.">
            {data.pages.length} page{data.pages.length === 1 ? '' : 's'}: {data.pages.join(', ')}
            {data.mated.length > 0 && ` · ${data.mated.length} mated disconnect${data.mated.length === 1 ? '' : 's'}`}
          </span>
          <button type="button" onClick={addKnob} disabled={locked} className={`ml-auto ${BTN}`}>
            Add knob
          </button>
        </div>
        {data.vehicle_only && (
          <p
            className="border-b border-gray-800 px-4 py-2 text-[12px] text-text-muted"
            title="With the drawn GSE ignored the cart's regulators are not simulated: the dome knob turns the rocket's dome-loaded regulator itself, and the COPV fill is the built-in charge to this knob's setting. The knobs here are the whole drawing's, kept for when the GSE is simulated again; the dials above are the ones the stand turns now."
          >
            Rocket only: the dome knob turns the rocket's regulator.
          </p>
        )}
        <div className="flex flex-col divide-y divide-gray-800/60">
          {draft.knobs.map((knob, index) => (
            <div key={knob.id} className="flex flex-wrap items-start gap-4 px-4 py-3">
              <div className="flex min-w-[220px] flex-col gap-1.5">
                <input
                  value={knob.label}
                  disabled={locked}
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
                        disabled={locked}
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
                      disabled={locked}
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
                disabled={locked}
                onClick={() => setDraft({ ...draft, knobs: draft.knobs.filter((_, i) => i !== index) })}
                aria-label={`Remove ${knob.label}`}
                title={`Remove ${knob.label}`}
                className="px-1 text-[13px] text-gray-500 hover:text-red-400 disabled:opacity-40"
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
            COPV fill: built-in. No drawn regulator charges the COPV.
          </p>
        )}
      </div>
    </section>
  );
}
