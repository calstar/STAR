/**
 * The study: the stand you have open, burned from T-0 once per case.
 *
 * Every case starts from the cockpit as it is -- drawing, engine, the
 * Configuration tab, the hookup, the knobs, the COPV fill target -- and changes
 * only what its row says. A blank cell is the stand's own value, shown grey.
 * A sweep writes the rows for you, one per value. Nothing here is a number of
 * the view's own.
 *
 * T-0 is Jump to T-0's: tanks loaded, bottle at the charge, each tank at the
 * lockup its regulator gives at the knobs. A case is the burn the console
 * would fly from there, on the console's own numerics.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  cancelStudy,
  fixed,
  getStudy,
  getTunables,
  startStudy,
  type StudyCaseIn,
  type StudyCaseOut,
  type StudyState,
  type Tunable,
} from '../api';
import { StudyChart, type Series } from '../components/StudyChart';
import { useStand } from '../stand';

/** Case colours, in this order and never cycled: the dataviz reference
 *  palette's dark steps, validated on this surface (CVD ΔE 8.4, normal 19.3). */
const CASE_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

/** A sweep is a magnitude: one hue, light to dark. */
function ramp(i: number, n: number): string {
  const a = [0x9e, 0xc5, 0xf7];
  const b = [0x1a, 0x4f, 0x9c];
  const f = n > 1 ? i / (n - 1) : 0;
  return `rgb(${a.map((c, k) => Math.round(c + (b[k] - c) * f)).join(',')})`;
}

const colorOf = (i: number, n: number, sweep: boolean) =>
  sweep || n > CASE_COLORS.length ? ramp(i, n) : CASE_COLORS[i];

type SweepVar = 'copv_psi' | 'bottle_litres' | 'fill_fraction' | `knob:${string}`;

const STORE = 'feedtwin.study.cases';

interface Saved {
  cases: StudyCaseIn[];
  sweep: string;
  horizon: number;
}

const load = (): Saved => {
  try {
    const raw = window.localStorage.getItem(STORE);
    if (raw) return JSON.parse(raw) as Saved;
  } catch {
    /* a fresh list */
  }
  return { cases: [{ label: 'As set' }], sweep: '', horizon: 20 };
};

const save = (state: Saved) => {
  try {
    window.localStorage.setItem(STORE, JSON.stringify(state));
  } catch {
    /* per-viewer convenience only */
  }
};

/** A number cell: blank is the stand's value, shown as the placeholder. */
function NumberCell({
  value,
  placeholder,
  onChange,
  width = 'w-20',
  title,
}: {
  value: number | null | undefined;
  placeholder: string;
  onChange: (v: number | null) => void;
  width?: string;
  title?: string;
}) {
  const [text, setText] = useState(value == null ? '' : String(value));
  useEffect(() => setText(value == null ? '' : String(value)), [value]);
  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      placeholder={placeholder}
      title={title}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const t = text.trim();
        if (!t) return onChange(null);
        const v = Number(t);
        if (Number.isFinite(v)) onChange(v);
        else setText(value == null ? '' : String(value));
      }}
      className={`${width} rounded border border-gray-700 bg-transparent px-1.5 py-0.5 text-right font-mono text-[12.5px] tabular-nums placeholder:text-gray-600 focus:border-blue-500 focus:outline-none`}
    />
  );
}

export function Study() {
  const { live, setup, artifacts, where, standDoc } = useStand();
  const [study, setStudy] = useState<StudyState | null>(null);
  const [tunables, setTunables] = useState<Tunable[]>([]);
  const [error, setError] = useState('');
  const initial = useRef(load());
  const [cases, setCases] = useState<StudyCaseIn[]>(initial.current.cases);
  const [sweepLabel, setSweepLabel] = useState(initial.current.sweep);
  const [horizon, setHorizon] = useState(initial.current.horizon);

  useEffect(() => save({ cases, sweep: sweepLabel, horizon }), [cases, sweepLabel, horizon]);

  useEffect(() => {
    getTunables().then(setTunables).catch(() => undefined);
  }, []);

  // Poll while a run is going; once otherwise, to pick up the last result.
  useEffect(() => {
    let stop = false;
    let timer = 0;
    const tick = async () => {
      try {
        const next = await getStudy();
        if (stop) return;
        setStudy(next);
        if (next.running) timer = window.setTimeout(tick, 1500);
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [study?.running]);

  const knobs = live?.knobs ?? [];
  const engine = artifacts.find((a) => a.id === where.engine);
  const drawing = artifacts.find((a) => a.id === where.diagram);
  const bottle = live?.bottles[0];
  const standName = standDoc?.name ?? drawing?.name ?? 'no stand';
  const knobValue = (id: string) => (id === 'dome' ? setup.dome : knobs.find((k) => k.id === id)?.psig);
  const fill = Number(setup.full_fraction ?? 0.95);

  const edit = (i: number, patch: Partial<StudyCaseIn>) =>
    setCases((all) => all.map((c, k) => (k === i ? { ...c, ...patch } : c)));

  const run = async () => {
    if (!live) return;
    setError('');
    try {
      setStudy(await startStudy({ session: live.id, cases, horizon_s: horizon, sweep: sweepLabel || undefined }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const running = Boolean(study?.running);
  const blocked = !live
    ? 'Open a stand in the cockpit first.'
    : !engine
      ? 'No engine on this stand: pick one in Library.'
      : '';

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-3 p-4">
      <section className="bg-card rounded-lg border border-gray-800">
        <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-gray-800 px-4 py-2.5">
          <h2 className="caps">Study</h2>
          <span className="text-[13px]" title="Every case starts from this stand as the cockpit has it now.">
            on <b>{standName}</b> · {engine?.name ?? 'no engine'}
          </span>
          <span className="text-[12px] text-text-muted" title="The stand's own values. A blank cell in a case is this value.">
            COPV {fixed(Number(setup.copv_target), 0)} psig ·{' '}
            {knobs.length
              ? knobs.map((k) => `${k.label} ${fixed(knobValue(k.id) ?? k.psig, 0)} psig`).join(' · ')
              : `dome ${fixed(Number(setup.dome), 0)} psig`}{' '}
            · fill {fixed(fill * 100, 0)} % · {bottle?.label ?? 'bottle'} as drawn
          </span>
          <div className="ml-auto flex items-center gap-2">
            <label className="text-[12px] text-text-muted" title="A case stops here if no tank has run dry.">
              Horizon <NumberCell value={horizon} placeholder="20" width="w-14" onChange={(v) => setHorizon(v ?? 20)} /> s
            </label>
            {running ? (
              <button
                type="button"
                onClick={() => cancelStudy().then(setStudy)}
                className="rounded border border-gray-600 px-3 py-1 text-[13px] hover:bg-gray-800"
              >
                Cancel
              </button>
            ) : (
              <button
                type="button"
                onClick={run}
                disabled={Boolean(blocked) || cases.length === 0}
                title={blocked || `Burn ${cases.length} case${cases.length === 1 ? '' : 's'} from T-0`}
                className="rounded bg-blue-600 px-3 py-1 text-[13px] font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Run {cases.length} case{cases.length === 1 ? '' : 's'}
              </button>
            )}
          </div>
        </header>

        <CaseTable
          cases={cases}
          knobs={knobs.map((k) => ({ id: k.id, label: k.label, psig: knobValue(k.id) ?? k.psig }))}
          setup={setup}
          fill={fill}
          tunables={tunables}
          bottleLabel={bottle?.label ?? 'Bottle'}
          onEdit={edit}
          onRemove={(i) => setCases((all) => all.filter((_, k) => k !== i))}
        />
        <div className="flex flex-wrap items-center gap-2 border-t border-gray-800 px-4 py-2">
          <button
            type="button"
            onClick={() => {
              setCases((all) => [...all, { label: `Case ${all.length + 1}` }]);
              setSweepLabel('');
            }}
            className="rounded border border-gray-700 px-2.5 py-0.5 text-[12.5px] hover:bg-gray-800"
          >
            + Case
          </button>
          <SweepBuilder
            knobs={knobs.map((k) => ({ id: k.id, label: k.label }))}
            onBuild={(built, label) => {
              setCases(built);
              setSweepLabel(label);
            }}
          />
          {cases.length > 1 && (
            <button
              type="button"
              onClick={() => {
                setCases([{ label: 'As set' }]);
                setSweepLabel('');
              }}
              className="ml-auto text-[12px] text-text-muted hover:text-red-400"
            >
              Clear cases
            </button>
          )}
        </div>
      </section>

      {(error || study?.error) && (
        <div className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-[13px] text-red-300">
          {error || study?.error}
        </div>
      )}

      {study && (running || study.cases.length > 0) && <Results study={study} />}
    </div>
  );
}

function CaseTable({
  cases,
  knobs,
  setup,
  fill,
  tunables,
  bottleLabel,
  onEdit,
  onRemove,
}: {
  cases: StudyCaseIn[];
  knobs: { id: string; label: string; psig: number }[];
  setup: Record<string, number | boolean>;
  fill: number;
  tunables: Tunable[];
  bottleLabel: string;
  onEdit: (i: number, patch: Partial<StudyCaseIn>) => void;
  onRemove: (i: number) => void;
}) {
  const th = 'px-2 py-1.5 text-left font-semibold whitespace-nowrap';
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12.5px]">
        <thead className="text-text-muted">
          <tr>
            <th className={th}>Case</th>
            <th className={th} title="Bottle at T-0. Also the charge the regulators are taken as set against.">
              COPV (psig)
            </th>
            {knobs.map((k) => (
              <th key={k.id} className={th} title={`Knob: ${k.label}`}>
                {k.label.replace(/\s*\(.*\)$/, '')} (psig)
              </th>
            ))}
            <th className={th} title={`${bottleLabel} volume`}>
              Bottle (L)
            </th>
            <th className={th} title="Liquid over tank volume at T-0">
              Fill (%)
            </th>
            <th className={th} title="The gas in the bottle and press lines">
              Pressurant
            </th>
            <th className={th} title="Any row of the Configuration tab, changed for this case">
              Settings
            </th>
            <th />
          </tr>
        </thead>
        <tbody>
          {cases.map((c, i) => (
            <tr key={i} className="border-t border-gray-800/60 align-top">
              <td className="px-2 py-1">
                <input
                  value={c.label}
                  onChange={(e) => onEdit(i, { label: e.target.value })}
                  className="w-36 rounded border border-gray-700 bg-transparent px-1.5 py-0.5 focus:border-blue-500 focus:outline-none"
                />
              </td>
              <td className="px-2 py-1">
                <NumberCell
                  value={c.copv_psi}
                  placeholder={fixed(Number(setup.copv_target), 0)}
                  onChange={(v) => onEdit(i, { copv_psi: v })}
                />
              </td>
              {knobs.map((k) => (
                <td key={k.id} className="px-2 py-1">
                  <NumberCell
                    value={c.knobs?.[k.id]}
                    placeholder={fixed(k.psig, 0)}
                    onChange={(v) => {
                      const next = { ...(c.knobs ?? {}) };
                      if (v == null) delete next[k.id];
                      else next[k.id] = v;
                      onEdit(i, { knobs: next });
                    }}
                  />
                </td>
              ))}
              <td className="px-2 py-1">
                <NumberCell
                  value={c.bottle_litres}
                  placeholder="drawn"
                  width="w-16"
                  onChange={(v) => onEdit(i, { bottle_litres: v })}
                />
              </td>
              <td className="px-2 py-1">
                <NumberCell
                  value={c.fill_fraction == null ? null : Math.round(c.fill_fraction * 1000) / 10}
                  placeholder={fixed(fill * 100, 0)}
                  width="w-14"
                  onChange={(v) => onEdit(i, { fill_fraction: v == null ? null : v / 100 })}
                />
              </td>
              <td className="px-2 py-1">
                <select
                  value={c.pressurant ?? ''}
                  onChange={(e) =>
                    onEdit(i, { pressurant: (e.target.value || null) as StudyCaseIn['pressurant'] })
                  }
                  className="rounded border border-gray-700 bg-[#1e1e1e] px-1 py-0.5"
                >
                  <option value="">as drawn</option>
                  <option value="helium">helium</option>
                  <option value="nitrogen">nitrogen</option>
                </select>
              </td>
              <td className="px-2 py-1">
                <SettingsCell
                  value={c.setup ?? {}}
                  setup={setup}
                  tunables={tunables}
                  onChange={(next) => onEdit(i, { setup: next })}
                />
              </td>
              <td className="px-2 py-1 text-right">
                <button
                  type="button"
                  onClick={() => onRemove(i)}
                  aria-label={`Remove ${c.label}`}
                  className="px-1 text-gray-500 hover:text-red-400"
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Rows the case table has its own columns for. */
const OWN_COLUMNS = ['dome', 'copv_target', 'full_fraction'];

function SettingsCell({
  value,
  setup,
  tunables,
  onChange,
}: {
  value: Record<string, number | boolean>;
  setup: Record<string, number | boolean>;
  tunables: Tunable[];
  onChange: (next: Record<string, number | boolean>) => void;
}) {
  const byKey = useMemo(() => new Map(tunables.map((t) => [t.key, t])), [tunables]);
  const free = tunables.filter((t) => !(t.key in value) && !OWN_COLUMNS.includes(t.key));
  return (
    <div className="flex flex-wrap items-center gap-1">
      {Object.entries(value).map(([key, v]) => {
        const t = byKey.get(key);
        return (
          <span
            key={key}
            title={t?.explains}
            className="inline-flex items-center gap-1 rounded border border-gray-700 px-1.5 py-0.5 text-[11.5px]"
          >
            {t?.label ?? key}
            {t?.kind === 'flag' ? (
              <input
                type="checkbox"
                checked={Boolean(v)}
                onChange={(e) => onChange({ ...value, [key]: e.target.checked })}
              />
            ) : (
              <NumberCell
                value={Number(v)}
                placeholder={String(setup[key] ?? '')}
                width="w-16"
                onChange={(n) => onChange({ ...value, [key]: n ?? Number(setup[key] ?? 0) })}
              />
            )}
            {t?.unit ? <span className="text-gray-500">{t.unit}</span> : null}
            <button
              type="button"
              aria-label={`Drop ${key}`}
              onClick={() => {
                const next = { ...value };
                delete next[key];
                onChange(next);
              }}
              className="text-gray-500 hover:text-red-400"
            >
              ×
            </button>
          </span>
        );
      })}
      <select
        value=""
        onChange={(e) => {
          const t = byKey.get(e.target.value);
          if (t) onChange({ ...value, [t.key]: setup[t.key] ?? t.default });
        }}
        className="max-w-[9rem] rounded border border-gray-700 bg-[#1e1e1e] px-1 py-0.5 text-[11.5px] text-text-muted"
        title="Change a Configuration row for this case"
      >
        <option value="">+ setting</option>
        {free.map((t) => (
          <option key={t.key} value={t.key}>
            {t.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function SweepBuilder({
  knobs,
  onBuild,
}: {
  knobs: { id: string; label: string }[];
  onBuild: (cases: StudyCaseIn[], label: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [what, setWhat] = useState<SweepVar>('copv_psi');
  const [values, setValues] = useState('3000, 3500, 4000, 4500');
  const options: { key: SweepVar; label: string; unit: string }[] = [
    { key: 'copv_psi', label: 'COPV charge', unit: 'psig' },
    ...knobs.map((k) => ({
      key: `knob:${k.id}` as SweepVar,
      label: k.label.replace(/\s*\(.*\)$/, ''),
      unit: 'psig',
    })),
    { key: 'bottle_litres', label: 'Bottle volume', unit: 'L' },
    { key: 'fill_fraction', label: 'Fill', unit: '%' },
  ];
  const chosen = options.find((o) => o.key === what) ?? options[0];
  const parsed = values.trim()
    ? values
        .split(/[,\s]+/)
        .filter(Boolean)
        .map(Number)
        .filter((v) => Number.isFinite(v))
    : [];
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border border-gray-700 px-2.5 py-0.5 text-[12.5px] hover:bg-gray-800"
        title="Write one case per value of one quantity"
      >
        Sweep…
      </button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2 rounded border border-gray-700 px-2 py-1 text-[12.5px]">
      Sweep
      <select
        value={what}
        onChange={(e) => setWhat(e.target.value as SweepVar)}
        className="rounded border border-gray-700 bg-[#1e1e1e] px-1 py-0.5"
      >
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label} ({o.unit})
          </option>
        ))}
      </select>
      over
      <input
        value={values}
        onChange={(e) => setValues(e.target.value)}
        className="w-56 rounded border border-gray-700 bg-transparent px-1.5 py-0.5 font-mono"
        title="Values, separated by commas or spaces"
      />
      <button
        type="button"
        disabled={parsed.length === 0}
        onClick={() => {
          onBuild(
            parsed.map((v): StudyCaseIn => {
              const base: StudyCaseIn = { label: `${chosen.label} ${v} ${chosen.unit}`, x: v };
              if (what === 'copv_psi') return { ...base, copv_psi: v };
              if (what === 'bottle_litres') return { ...base, bottle_litres: v };
              if (what === 'fill_fraction') return { ...base, fill_fraction: v / 100 };
              return { ...base, knobs: { [what.slice(5)]: v } };
            }),
            `${chosen.label} (${chosen.unit})`,
          );
          setOpen(false);
        }}
        className="rounded bg-gray-700 px-2 py-0.5 hover:bg-gray-600 disabled:opacity-40"
      >
        Write {parsed.length} cases
      </button>
      <button type="button" onClick={() => setOpen(false)} className="text-gray-500 hover:text-gray-300">
        ×
      </button>
    </span>
  );
}

/** Lowest tank pressure once the ignition step has passed, converged steps only. */
const lowOf = (c: StudyCaseOut): number | null => {
  const settled = c.t.map((t, i) => (t > 0.3 && c.converged[i] ? i : -1)).filter((i) => i >= 0);
  let low = Infinity;
  for (const v of Object.values(c.tanks)) for (const i of settled) low = Math.min(low, v[i]);
  return Number.isFinite(low) ? low : null;
};

function Results({ study }: { study: StudyState }) {
  const done = study.cases;
  const sweep = Boolean(study.sweep);
  const n = Math.max(study.planned, done.length);
  const colors = done.map((_, i) => colorOf(i, n, sweep));

  const series = (pick: (c: StudyCaseOut) => [string, number[]][]): Series[] =>
    done.flatMap((c, i) =>
      c.error
        ? []
        : pick(c).map(([name, values], k): Series => {
            const t: number[] = [];
            const v: number[] = [];
            c.t.forEach((when, j) => {
              if (!c.converged[j]) return;
              t.push(when);
              v.push(values[j]);
            });
            return {
              key: `${i}.${name}`,
              label: name ? `${c.label} · ${name}` : c.label,
              // Endpoint text: the swept value, or the case's name, short.
              tag: `${sweep && c.x != null ? String(c.x) : c.label.slice(0, 16)}${name ? ` ${name.slice(0, 3)}` : ''}`,
              color: colors[i],
              dashed: k > 0,
              t,
              v,
            };
          }),
    );

  const tankNames = Object.keys(done.find((c) => !c.error)?.tanks ?? {});
  const headers = [
    '',
    'Case',
    'Changed',
    'T-0 tanks (psig)',
    'Burn (s)',
    'Impulse (N·s)',
    'Thrust (N)',
    'Tank low (psig)',
    'COPV end (psig)',
    'O/F',
    '',
  ];

  return (
    <>
      {study.running && (
        <div className="bg-card rounded-lg border border-gray-800 px-4 py-2 text-[13px]">
          <div className="mb-1 flex justify-between text-text-muted">
            <span>{study.stage}</span>
            <span>
              {done.length} of {study.planned}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded bg-gray-800">
            <div className="h-full bg-blue-500 transition-all" style={{ width: `${study.progress * 100}%` }} />
          </div>
        </div>
      )}

      {done.length > 0 && (
        <section className="bg-card overflow-x-auto rounded-lg border border-gray-800">
          <h2 className="border-b border-gray-800 px-4 py-2.5 caps">
            Results{' '}
            <span className="font-normal normal-case tracking-normal text-gray-600">
              on {study.stand} · {study.engine_name}
            </span>
          </h2>
          <table className="w-full text-[12.5px]">
            <thead className="text-text-muted">
              <tr>
                {headers.map((h, i) => (
                  <th key={i} className={`px-3 py-1.5 font-semibold ${i < 3 || i === 10 ? 'text-left' : 'text-right'}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {done.map((c, i) => {
                const bottle = Object.values(c.bottles)[0];
                const low = lowOf(c);
                return (
                  <tr key={i} className="border-t border-gray-800/60">
                    <td className="px-3 py-1">
                      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: colors[i] }} />
                    </td>
                    <td className="px-3 py-1">{c.label}</td>
                    <td className="px-3 py-1 text-text-muted">{c.changes.join(', ')}</td>
                    <td
                      className="px-3 py-1 text-right font-mono"
                      title="Where the tanks start: the lockup their regulator gives at T-0"
                    >
                      {c.t0.tank_psi != null ? fixed(c.t0.tank_psi, 0) : '–'}
                    </td>
                    <td
                      className="px-3 py-1 text-right font-mono"
                      title={c.depleted_s == null ? 'Reached the horizon with no tank dry' : 'To the first tank dry'}
                    >
                      {c.depleted_s != null ? fixed(c.depleted_s, 2) : c.error ? '–' : `>${fixed(study.horizon_s, 0)}`}
                    </td>
                    <td className="px-3 py-1 text-right font-mono">{fixed(c.outcome.impulse_Ns ?? NaN, 0)}</td>
                    <td className="px-3 py-1 text-right font-mono">{fixed(c.outcome.thrust_mean_N ?? NaN, 0)}</td>
                    <td className="px-3 py-1 text-right font-mono" title="Lowest tank pressure after the first 0.3 s">
                      {low != null ? fixed(low, 0) : '–'}
                    </td>
                    <td className="px-3 py-1 text-right font-mono">
                      {bottle?.length ? fixed(bottle[bottle.length - 1], 0) : '–'}
                    </td>
                    <td className="px-3 py-1 text-right font-mono">{fixed(c.outcome.of_mean ?? NaN, 3)}</td>
                    <td className="px-3 py-1 text-[12px]">
                      {c.error ? (
                        <span className="text-red-400" title={c.error}>
                          failed
                        </span>
                      ) : c.tripped ? (
                        <span className="text-amber-400" title={c.tripped}>
                          tripped
                        </span>
                      ) : c.failed_ticks ? (
                        <span className="text-amber-400" title={`${c.failed_ticks} step(s) did not converge`}>
                          {c.failed_ticks} unconverged
                        </span>
                      ) : (
                        <span title={c.notes.join('\n')} className="cursor-help text-gray-500">
                          notes
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {study.notes.length > 0 && (
            <p className="border-t border-gray-800 px-4 py-2 text-[12px] text-text-muted">{study.notes.join(' ')}</p>
          )}
        </section>
      )}

      {done.some((c) => !c.error) && (
        <div className="grid gap-3 xl:grid-cols-2">
          <Figure>
            <StudyChart
              title="Tank pressure"
              caption={tankNames.length > 1 ? `${tankNames[0]} solid, ${tankNames.slice(1).join(', ')} dashed` : ''}
              yLabel="psig"
              series={series((c) => Object.entries(c.tanks))}
            />
          </Figure>
          <Figure>
            <StudyChart
              title="COPV pressure"
              caption=""
              yLabel="psig"
              series={series((c) =>
                Object.values(c.bottles)
                  .slice(0, 1)
                  .map((v): [string, number[]] => ['', v]),
              )}
            />
          </Figure>
          <Figure>
            <StudyChart title="Thrust" caption="" yLabel="N" series={series((c) => [['', c.thrust_n]])} />
          </Figure>
          <Figure>
            <StudyChart
              title="Chamber pressure"
              caption=""
              yLabel="psig"
              series={series((c) => [['', c.chamber_psi]])}
            />
          </Figure>
        </div>
      )}

      {sweep && done.filter((c) => !c.error && c.x != null).length > 1 && <SweepFigures study={study} />}
    </>
  );
}

function Figure({ children }: { children: ReactNode }) {
  return <div className="bg-card rounded-lg border border-gray-800 p-3">{children}</div>;
}

function SweepFigures({ study }: { study: StudyState }) {
  const points = study.cases
    .filter((c) => !c.error && c.x != null)
    .sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
  const one = (label: string, read: (c: StudyCaseOut) => number | null | undefined): Series => {
    const t: number[] = [];
    const v: number[] = [];
    for (const c of points) {
      const y = read(c);
      if (y == null || !Number.isFinite(y)) continue;
      t.push(c.x as number);
      v.push(y);
    }
    return { key: label, label, color: CASE_COLORS[0], t, v };
  };
  return (
    <div className="grid gap-3 xl:grid-cols-3">
      <Figure>
        <StudyChart
          title="Lowest tank pressure"
          caption="after the first 0.3 s"
          yLabel="psig"
          xLabel={study.sweep}
          series={[one('Tank low', lowOf)]}
        />
      </Figure>
      <Figure>
        <StudyChart
          title="Impulse"
          caption=""
          yLabel="N·s"
          xLabel={study.sweep}
          series={[one('Impulse', (c) => c.outcome.impulse_Ns)]}
        />
      </Figure>
      <Figure>
        <StudyChart
          title="Burn time"
          caption="to the first tank dry"
          yLabel="s"
          xLabel={study.sweep}
          series={[one('Burn', (c) => c.depleted_s)]}
        />
      </Figure>
    </div>
  );
}
