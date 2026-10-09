/**
 * Configuration: every number the twin assumes, in one place.
 *
 * A simulator earns trust by saying what it assumed. The backend keeps a
 * table of its knobs -- what each stands in for, its unit, its bounds, its
 * default, and whether the running stand takes a change at once or on the
 * next Reset -- and this tab renders it, grouped. Rest on a row for two
 * seconds and it says what the number accounts for. Edit it and the stand
 * uses the new value; the default is always shown so nobody loses it.
 *
 * What the *drawing* assumed (a defaulted volume, an estimated bore) is a
 * different list and lives on the Report tab.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CHARGE_KNOB, DOME_KNOB, getTunables, type StandSetup, type Tunable } from '../api';
import { useStand } from '../stand';

/** How long a hand has to rest on a row before it explains itself. */
const HOVER_MS = 2000;
/** Typing pauses this long before the stand hears the new number. */
const COMMIT_MS = 400;

function Explain({ text, children }: { text: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const arm = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), HOVER_MS);
  };
  const disarm = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setOpen(false);
  };
  useEffect(() => () => disarm(), []);
  return (
    <div className="relative" onPointerEnter={arm} onPointerLeave={disarm} onFocus={arm} onBlur={disarm}>
      {children}
      {open && (
        <div
          role="tooltip"
          className="absolute left-0 top-full z-30 mt-1 w-[26rem] max-w-[80vw] rounded-lg border border-gray-700 bg-black/95 px-3 py-2 text-[12px] leading-relaxed text-gray-200 shadow-xl"
        >
          {text}
        </div>
      )}
    </div>
  );
}

/** The value as it is, to the step's places at least: a step of 5 printed
 *  the COPV charge time of 9.7 s as "10", and the row lied about the number
 *  the stand ran on. */
function fmt(v: number, step: number): string {
  const stepPlaces = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));
  const own = (String(Number(v)).split('.')[1] ?? '').length;
  const places = Math.min(Math.max(stepPlaces, own), 6);
  return Number(v).toFixed(places).replace(/\.?0+$/, (m) => (m.startsWith('.') ? '' : m));
}

/** A row; ``drawn``: its default is the drawing's (a regulator's setting),
 *  not the library's. */
type Row = Tunable & { drawn?: boolean };

/** The Setup fields a drawn regulator sets, by knob. */
const DRAWN: Record<string, string> = { dome: DOME_KNOB, copv_target: CHARGE_KNOB };

function Row({
  t,
  value,
  onChange,
  disabled,
}: {
  t: Row;
  value: number | boolean;
  onChange: (v: number | boolean) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState<string>(typeof value === 'number' ? fmt(value, t.step) : '');
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (typeof value === 'number' && timer.current === null) setDraft(fmt(value, t.step));
  }, [value, t.step]);
  const commit = useCallback(
    (raw: string) => {
      setDraft(raw);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        const n = Number(raw);
        if (Number.isFinite(n)) onChange(Math.min(t.high, Math.max(t.low, n)));
      }, COMMIT_MS);
    },
    [onChange, t.high, t.low],
  );
  const changed = typeof value === 'boolean' ? value !== t.default : Math.abs(Number(value) - Number(t.default)) > 1e-9;
  const explain = (
    <>
      <div className="mb-1 font-semibold text-white">{t.label}</div>
      <div>{t.explains}</div>
      <div className="mt-1.5 font-mono text-[11px] text-gray-400">
        default {typeof t.default === 'boolean' ? (t.default ? 'on' : 'off') : `${fmt(Number(t.default), t.step)} ${t.unit}`}
        {t.drawn && ', the drawing\'s setting'}
        {t.kind === 'number' && ` · ${fmt(t.low, t.step)} to ${fmt(t.high, t.step)}`}
        {t.applies === 'reset' && ' · takes effect on Reset'}
      </div>
    </>
  );
  return (
    <Explain text={explain}>
      <div
        className={`grid grid-cols-[minmax(0,1fr)_9rem_7rem_5rem] items-center gap-3 border-b border-gray-800/60 px-3 py-1.5 text-[12px] hover:bg-white/[0.03] ${
          changed ? 'bg-blue-950/20' : ''
        }`}
      >
        <div className="min-w-0">
          <span className={`truncate ${changed ? 'text-blue-200' : 'text-gray-200'}`}>{t.label}</span>
          {t.applies === 'reset' && (
            <span className="ml-2 rounded border border-gray-700 px-1 py-px font-mono text-[9px] uppercase tracking-wider text-gray-500">
              on reset
            </span>
          )}
        </div>
        <div>
          {t.kind === 'flag' ? (
            <label className="flex items-center gap-2 text-gray-300">
              <input
                type="checkbox"
                checked={Boolean(value)}
                disabled={disabled}
                onChange={(e) => onChange(e.target.checked)}
                className="accent-blue-500"
              />
              {value ? 'on' : 'off'}
            </label>
          ) : (
            <input
              type="number"
              value={draft}
              step={t.step}
              min={t.low}
              max={t.high}
              disabled={disabled}
              onChange={(e) => commit(e.target.value)}
              className="w-full rounded-md border border-gray-700 bg-black/60 px-2 py-1 font-mono text-[12px] tabular-nums text-white focus:border-blue-500 focus:outline-none disabled:opacity-50"
            />
          )}
        </div>
        <div className="truncate text-[11px] text-gray-500">{t.unit}</div>
        <div className="text-right">
          {changed && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(t.default)}
              title={`Back to ${typeof t.default === 'boolean' ? (t.default ? 'on' : 'off') : fmt(Number(t.default), t.step)}${t.drawn ? ', the drawing\'s setting' : ''}`}
              className="rounded px-1.5 py-0.5 font-mono text-[10px] text-blue-300 hover:bg-blue-900/40"
            >
              default
            </button>
          )}
        </div>
      </div>
    </Explain>
  );
}

export function Config() {
  const { live, setup, setSetup, locked: readOnly, model } = useStand();
  const [tunables, setTunables] = useState<Tunable[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    getTunables()
      .then(setTunables)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  // Tripped, or a stand you have not taken: the settings are the stand's.
  const locked = Boolean(live?.tripped) || readOnly;
  // Sixty-odd rows: find one by any word in its name or what it accounts for,
  // or see only what differs from the default.
  const [query, setQuery] = useState('');
  const [changedOnly, setChangedOnly] = useState(false);
  // The dome and the COPV charge default to what the drawing sets them to:
  // 'default' on a 535 psig drawn dome went back to the library's 500.
  const rows: Row[] = tunables.map((t) => {
    const drawn = DRAWN[t.key] !== undefined ? model?.drawn_knobs?.[DRAWN[t.key]] : undefined;
    return drawn === undefined ? t : { ...t, default: drawn, drawn: true };
  });
  const valueOf = (t: Tunable) => (setup as StandSetup)[t.key] ?? t.default;
  const isChanged = (t: Tunable) => {
    const v = valueOf(t);
    return typeof v === 'boolean' ? v !== t.default : Math.abs(Number(v) - Number(t.default)) > 1e-9;
  };
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = rows.filter(
    (t) =>
      (!changedOnly || isChanged(t)) &&
      words.every((w) => `${t.label} ${t.key} ${t.explains} ${t.group}`.toLowerCase().includes(w)),
  );
  const groups = Array.from(new Set(shown.map((t) => t.group)));

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="max-w-3xl">
        <h2 className="caps">Every number the twin assumes</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-gray-500">
          Rest on a row for two seconds and it says what the number accounts for and where it came from. Edit
          a value and the running stand uses it; rows marked <span className="font-mono text-[10px] uppercase">on reset</span>{' '}
          are built into the vessels and take effect on the next Reset. Changed rows are tinted and carry a
          way back to the default. What the <em>drawing</em> left unsaid — a defaulted volume, an estimated
          bore — is on the <Link to="/report" className="text-blue-400 hover:underline">Checks</Link> tab.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a setting — e.g. dome, chill, tolerance"
          className="w-80 rounded-md border border-gray-700 bg-black/60 px-3 py-1.5 text-[12.5px] text-white placeholder:text-gray-600 focus:border-blue-500 focus:outline-none"
        />
        <label className="flex cursor-pointer items-center gap-2 text-[12px] text-gray-400">
          <input
            type="checkbox"
            checked={changedOnly}
            onChange={(e) => setChangedOnly(e.target.checked)}
            className="accent-blue-500"
          />
          Changed from the default only ({rows.filter(isChanged).length})
        </label>
        {shown.length === 0 && tunables.length > 0 && (
          <span className="text-[12px] text-gray-500">Nothing matches.</span>
        )}
      </div>
      {error && <p className="text-[12px] text-red-300">{error}</p>}
      <div className="grid gap-4 xl:grid-cols-2">
        {groups.map((g) => (
          <section key={g} className="bg-card overflow-hidden rounded-xl border border-gray-800">
            <h3 className="border-b border-gray-800 px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-text-muted">
              {g}
            </h3>
            {shown
              .filter((t) => t.group === g)
              .map((t) => (
                <Row
                  key={t.key}
                  t={t}
                  value={(setup as StandSetup)[t.key] ?? t.default}
                  disabled={locked}
                  onChange={(v) => setSetup({ [t.key]: v } as Partial<StandSetup>)}
                />
              ))}
          </section>
        ))}
      </div>
    </div>
  );
}
