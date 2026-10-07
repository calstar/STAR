/**
 * The hookup: which valve on the drawing each state-machine actuator drives,
 * and which knob on the GSE page sets which regulator.
 *
 * An imported drawing -- a new GSE page, somebody else's stand -- arrives with
 * its own tags. The twin matches what it can (names, then what each valve is
 * plumbed to do) and puts the stand's one dome knob where it always went; this
 * page is where a person fixes the rest without editing the drawing or asking
 * anyone: pin an actuator to a valve, make a knob, put regulators on it. Kept
 * per drawing (by where it comes from, so saving the drawing again keeps it).
 */

import { useEffect, useMemo, useState } from 'react';
import {
  DOME_KNOB,
  getHookup,
  resetHookup,
  saveHookup,
  type Hookup as HookupData,
  type HookupBody,
  type KnobDef,
} from '../api';
import { useStand } from '../stand';

const AUTO = '__auto__';
const NONE = '__none__';

export function Hookup() {
  const { where, restart, standDoc, standHookup, setStandHookup, locked } = useStand();
  // On a stand, the hookup is the stand's: kept and shared with it, saved by
  // the stand's Save. Off one, it is the drawing's own, kept in the library.
  const onStand = Boolean(standDoc);
  const [data, setData] = useState<HookupData | null>(null);
  const [draft, setDraft] = useState<HookupBody | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!where.diagram) return;
    setError('');
    getHookup(where)
      .then((h) => {
        const own = standHookup as unknown as HookupBody | null;
        const shown = own ? { ...h, hookup: own, saved: true } : h;
        setData(shown);
        setDraft(structuredClone(shown.hookup));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [where.diagram, where.engine, standHookup]);

  const dirty = useMemo(
    () => Boolean(data && draft && JSON.stringify(data.hookup) !== JSON.stringify(draft)),
    [data, draft],
  );

  if (error) return <p className="p-6 text-sm text-red-400">{error}</p>;
  if (!data || !draft) return <p className="p-6 text-sm text-text-muted">Reading the drawing…</p>;

  const valveLabel = (id: string) => {
    const v = data.valves.find((x) => x.id === id);
    return v ? `${v.label}${data.pages.length > 1 ? ` · ${v.page}` : ''}` : id;
  };
  const owner = (id: string) => draft.knobs.find((k) => k.regulators.includes(id));

  const keep = (hookup: HookupBody) => {
    if (!data) return;
    setData({ ...data, hookup, saved: true });
    setDraft(structuredClone(hookup));
    setStandHookup(hookup as unknown as Record<string, unknown>);
  };

  const act = async (run: () => Promise<HookupData>) => {
    setBusy(true);
    setError('');
    try {
      const h = await run();
      setData(h);
      setDraft(structuredClone(h.hookup));
      restart(); // the stand reopens bound the new way
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const setPin = (actuator: string, value: string) => {
    const valves = { ...draft.valves };
    if (value === AUTO) delete valves[actuator];
    else valves[actuator] = value === NONE ? '' : value;
    setDraft({ ...draft, valves });
  };

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
            onClick={() => (onStand ? keep(data.suggested) : void act(() => resetHookup(where)))}
            title="Forget what was saved and go back to the twin's own matching."
            className="rounded bg-gray-700 px-3 py-1 text-[12px] font-semibold text-white hover:bg-gray-600 disabled:opacity-40"
          >
            Back to suggestions
          </button>
          <button
            type="button"
            disabled={busy || (!dirty && data.saved) || locked}
            onClick={() => (onStand ? keep(draft) : void act(() => saveHookup(where, draft)))}
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

      <div className="bg-card rounded-lg border border-gray-800">
        <h2 className="border-b border-gray-800 px-4 py-2.5 caps">
          Valves
          <span className="ml-2 font-normal normal-case tracking-normal text-gray-600">
            what each state-machine actuator opens on this drawing
          </span>
        </h2>
        <table className="w-full text-[12.5px]">
          <tbody>
            {data.actuators.map((actuator) => {
              const pinned = actuator in draft.valves;
              const value = pinned ? (draft.valves[actuator] === '' ? NONE : draft.valves[actuator]) : AUTO;
              const auto = data.bound[actuator];
              const how = pinned
                ? 'yours'
                : auto
                  ? data.by_role.includes(actuator)
                    ? 'by what it does'
                    : 'by name'
                  : '';
              const missing = !pinned && !auto;
              return (
                <tr key={actuator} className="border-t border-gray-800/60">
                  <td className="w-1/3 px-4 py-1.5">{actuator}</td>
                  <td className="px-4 py-1.5">
                    <select
                      value={value}
                      onChange={(e) => setPin(actuator, e.target.value)}
                      className="w-full max-w-sm rounded border border-gray-700 bg-black/60 px-2 py-1 text-[12.5px]"
                    >
                      <option value={AUTO}>{auto ? `Automatic: ${valveLabel(auto)}` : 'Automatic: nothing matched'}</option>
                      <option value={NONE}>No valve on this drawing</option>
                      {data.valves.map((v) => (
                        <option key={v.id} value={v.id}>
                          {valveLabel(v.id)}
                          {v.role.length ? ` (${v.role.join(' ')})` : ''}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className={`w-40 px-4 py-1.5 text-[11px] ${missing ? 'text-amber-300' : 'text-text-muted'}`}>
                    {missing ? 'never commanded' : how}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {data.uncommanded.length > 0 && (
          <p className="border-t border-gray-800 px-4 py-2 text-[12px] text-text-muted" title="These keep whatever position they are put in by hand on the Console.">
            Nothing in the table drives: {data.uncommanded.map(valveLabel).join(', ')}
          </p>
        )}
      </div>

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
