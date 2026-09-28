import { useEffect, useState } from 'react';
import { useReadOnly } from '@stardesign-ui';
import { getConfig, getInjectorLayout, updateConfig } from '../api/client';
import type { EngineConfig, InjectorHoleCd } from '../api/client';
import { GROUPS, cdBasis, cdChange, draftFromConfig, mergeDeep, updatesFromDraft } from '../lib/injectorHardware';
import type { Draft } from '../lib/injectorHardware';

type HoleCd = Record<'O' | 'F', InjectorHoleCd | null>;
const holeCd = (l: { passages: Record<'O' | 'F', { cd: InjectorHoleCd | null }> }): HoleCd =>
  ({ O: l.passages.O.cd, F: l.passages.F.cd });
const pct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(100 * x).toFixed(1)}%`;

/**
 * The injector plug as machined: face contour, back channels, igniter port, and each hole's
 * L/d and inlet -- which set its Cd. Every field feeds engine/core/injectors/layout.py (the
 * drawings) and the solver's discharge model; the Cd each hole will have is shown as you type,
 * from the backend's own model, with what the change does to the injector drop.
 *
 * The generic Configuration editor cannot create a block that is currently null
 * (injector.igniter, .interface, .plate), which is why these have a form of their own.
 * Lengths are entered in mm and stored in metres.
 */

export function InjectorHardware({ onSaved }: { onSaved?: (c: EngineConfig) => void }) {
  const readOnly = useReadOnly();
  const [base, setBase] = useState<Draft | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [cfg, setCfg] = useState<EngineConfig | null>(null);
  const [cdNow, setCdNow] = useState<HoleCd | null>(null);
  const [cdDraft, setCdDraft] = useState<HoleCd | null>(null);

  useEffect(() => {
    let live = true;
    getConfig().then((r) => {
      if (!live || !r.data?.config) return;
      const d = draftFromConfig(r.data.config);
      setCfg(r.data.config);
      setBase(d);
      setDraft(d);
    });
    return () => { live = false; };
  }, []);

  // The Cd each hole has now, and the Cd it would have with the draft applied: the same layout
  // call the drawing uses, on the config with the draft laid over it.
  useEffect(() => {
    if (!cfg) return;
    let live = true;
    getInjectorLayout(cfg as unknown as Record<string, unknown>).then((r) => { if (live && r.data) setCdNow(holeCd(r.data)); });
    return () => { live = false; };
  }, [cfg]);
  useEffect(() => {
    if (!cfg || !draft) return;
    let live = true;
    const t = setTimeout(() => {
      getInjectorLayout(mergeDeep(cfg, updatesFromDraft(draft)) as unknown as Record<string, unknown>)
        .then((r) => { if (live) setCdDraft(r.data ? holeCd(r.data) : null); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [cfg, draft]);

  if (!draft || !base) return null;
  const dirty = Object.keys(draft).some((k) => draft[k] !== base[k]);

  const save = async () => {
    setSaving(true);
    setError(null);
    const r = await updateConfig(updatesFromDraft(draft) as Partial<EngineConfig>);
    setSaving(false);
    if (r.error) { setError(r.error); return; }
    if (r.data?.config) {
      const d = draftFromConfig(r.data.config);
      setCfg(r.data.config);
      setBase(d);
      setDraft(d);
      onSaved?.(r.data.config);
    }
  };

  return (
    <fieldset disabled={readOnly} className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3">
      <div className="flex items-baseline justify-between mb-2">
        <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">Injector hardware</h4>
        <div className="flex gap-2">
          <button type="button" disabled={!dirty || saving || readOnly} onClick={() => setDraft(base)}
                  className="text-[11px] px-2 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-text-secondary)] disabled:opacity-40">
            Discard
          </button>
          <button type="button" disabled={!dirty || saving || readOnly} onClick={save}
                  className="text-[11px] px-2 py-0.5 rounded bg-rose-600 text-white disabled:opacity-40">
            {saving ? 'Saving' : 'Apply'}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {GROUPS.map((g) => (
          <div key={g.title} className="space-y-1.5">
            <div className="text-[11px] font-semibold text-[var(--color-text-primary)]">{g.title}</div>
            {g.fields.filter((f) => !f.show || f.show(draft)).map((f) => (
              <label key={f.key} className="flex items-center justify-between gap-2 text-[11px] text-[var(--color-text-secondary)]"
                     title={f.hint}>
                <span className="truncate">{f.label}{f.unit ? ` (${f.unit})` : ''}</span>
                {f.kind === 'select' ? (
                  <select value={draft[f.key]} disabled={readOnly}
                          onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                          className="w-28 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded px-1 py-0.5 text-[var(--color-text-primary)]">
                    {f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : (
                  <input value={draft[f.key]} disabled={readOnly} inputMode="decimal" placeholder={f.hint ? '—' : ''}
                         onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value.replace(/[^0-9.eE-]/g, '') })}
                         className="w-28 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded px-1 py-0.5 text-right text-[var(--color-text-primary)]" />
                )}
              </label>
            ))}
          </div>
        ))}
      </div>
      {cdDraft && (
        <div className="mt-2 text-[11px] leading-5 font-mono text-[var(--color-text-secondary)]">
          {(['O', 'F'] as const).map((k) => {
            const ch = cdChange(cdNow?.[k] ?? null, cdDraft[k]);
            const moved = ch && Math.abs(ch.after - ch.before) > 5e-5;
            return (
              <div key={k}>
                {k === 'O' ? 'LOX' : 'fuel'} {cdBasis(cdDraft[k])}
                {moved && (
                  <span className="text-[var(--color-text-primary)]">
                    {' '}— was {ch.before.toFixed(3)}: injector Δp {pct(ch.dpSameFlow)} at the same flow, or flow {pct(ch.flowSameDp)} at the same Δp
                  </span>
                )}
              </div>
            );
          })}
          {(['O', 'F'] as const).some((k) => { const c = cdChange(cdNow?.[k] ?? null, cdDraft[k]); return c && Math.abs(c.after - c.before) > 5e-5; }) && (
            <div className="opacity-70">
              A forward solve holds the tank pressures, so it lands between the two; Layer 1 re-sizes the holes to keep Δp/Pc in its band.
            </div>
          )}
        </div>
      )}
      {error && <div className="mt-2 text-[11px] text-[#f87171] font-mono break-words">{error}</div>}
    </fieldset>
  );
}

export default InjectorHardware;
