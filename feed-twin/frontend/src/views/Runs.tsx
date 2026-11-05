/**
 * Runs: every burn the cockpit has fired, kept with what it ran on.
 *
 * Pick one to see its traces; pick two to see what differs -- every input
 * that changed, the code, and the outcome -- and ask which input moved the
 * answer. That last is a re-run, not a diff: both runs replayed from their
 * T-0, then the first with one input group at a time taken from the second.
 * Whatever the single swaps do not add up to is the interaction, and is shown
 * as such.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  diffRuns,
  explainCancel,
  explainRuns,
  explainStatus,
  fixed,
  getRun,
  getTunables,
  listRuns,
  when,
  type ExplainState,
  type RunDiff,
  type RunRecord,
  type RunSummary,
  type Tunable,
} from '../api';
import { DaqPlot, type Channel } from '../components/DaqPlot';
import { PRESSURE_UNIT, fmtP, isGaugeInput, isGaugeTunable, isGaugeUnit, psiaText, toPsia, unitLabel } from '../lib/pressure';
import { useStand } from '../stand';

/** The record's outcome columns. A run record keeps Pc gauge, as the wire
 *  does; `pressure` columns are shown psia. */
const COLUMNS: { key: string; label: string; unit: string; places: number; pressure?: boolean }[] = [
  { key: 'thrust_mean_N', label: 'Thrust', unit: 'N', places: 0 },
  { key: 'impulse_Ns', label: 'Impulse', unit: 'N·s', places: 0 },
  { key: 'duration_s', label: 'Burn', unit: 's', places: 2 },
  { key: 'pc_mean_psi', label: 'Pc', unit: PRESSURE_UNIT, places: 1, pressure: true },
  { key: 'of_mean', label: 'O/F', unit: '', places: 3 },
  { key: 'isp_s', label: 'Isp', unit: 's', places: 1 },
];

const A_COLOR = '#3498DB';
const B_COLOR = '#F39C12';

/** A number at the precision the table shows it. */
const num = (v: number) => fixed(v, Math.abs(v) >= 100 ? 1 : Math.abs(v) >= 10 ? 2 : 3);

/** A value as a person reads it: a number, on/off, a name. Never JSON. */
const show = (v: unknown): string => {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return num(v);
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'string') return v === '' ? '(none)' : v;
  return brief(v);
};

/** The gas that pressed a burn, as the stand says it. */
const GAS: Record<string, string> = { helium: 'He', nitrogen: 'GN2' };

/** A run as the list has it, with what the record keeps beside the outcome:
 *  the gas and the burned tanks at T-0 [psig on the wire]. */
type Listed = RunSummary & { pressurant?: string; t0_tanks?: Record<string, number | null> };

/** Whether a run ever made thrust. A sequence stepped through without a
 *  light -- Fire then abort, a rehearsal -- is recorded as a burn of 0 N·s. */
const lit = (r: RunSummary) => (r.outcome.impulse_Ns ?? 0) >= 1;

/** The code a run ran on, short: version, commit, * for local changes. */
const software = (c: RunSummary['code']) => (c ? `${c.app} ${c.commit.slice(0, 7)}${c.dirty ? '*' : ''}` : '—');

/** A changed input's value, short: a list or an object is summarised (the
 *  whole of it on hover) rather than printed as JSON that runs off the page. */
const brief = (v: unknown): string => {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) {
    const named = v.every((x) => x && typeof x === 'object' && 'label' in (x as object));
    return named
      ? (v as { label: string }[]).map((x) => x.label).join(', ') || '(none)'
      : `${v.length} item${v.length === 1 ? '' : 's'}`;
  }
  if (v && typeof v === 'object') return `${Object.keys(v).length} fields`;
  return String(v);
};

/** A recorded value as shown: absolute when its unit is gauge on the wire. */
const absolute = (v: number | null, unit: string) => (v !== null && isGaugeUnit(unit) ? toPsia(v) : v);

/** Where a recorded input's unit comes from when it is not a setting: the
 *  last part of its key. */
const UNIT_BY_KEY: [RegExp, string][] = [
  [/_kg$/, 'kg'],
  [/_K$/, 'K'],
  [/_s$/, 's'],
  [/_litres$/, 'L'],
];

const WORDS: Record<string, string> = {
  t0: 'T-0',
  setup: 'setting',
  hookup: 'hookup',
  knobs: 'knob',
  bottles: 'bottle',
  tanks: 'tank',
  // A vessel's pressure at T-0, keyed by the wire's gauge field; shown psia.
  psig: 'pressure',
  liquid_kg: 'liquid',
  liquid_K: 'liquid temperature',
  ullage_K: 'ullage temperature',
  fluid_set: 'fluids',
  diagram: 'drawing',
  machine: 'state machine',
};

const key = (r: RunSummary) => `${r.owner}/${r.id}`;

/** The whole record as a file: inputs, code, stand version, outcome, solver
 *  summary and traces -- what a test review needs to reproduce the run. */
const download = (rec: RunRecord) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(rec, null, 1)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `run-${rec.id}${rec.label ? `-${rec.label.replace(/[^\w.-]+/g, '_')}` : ''}.json`;
  a.click();
  URL.revokeObjectURL(url);
};

export function Runs() {
  const { standDoc, artifacts } = useStand();
  const named = (id?: string) => (id ? (artifacts.find((a) => a.id === id)?.name ?? id) : '');
  const [scope, setScope] = useState<'stand' | 'mine'>(standDoc ? 'stand' : 'mine');
  const [runs, setRuns] = useState<Listed[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [records, setRecords] = useState<Record<string, RunRecord>>({});
  const [diff, setDiff] = useState<RunDiff | null>(null);
  const [explain, setExplain] = useState<ExplainState | null>(null);
  const [error, setError] = useState('');
  const [tunables, setTunables] = useState<Tunable[]>([]);
  // Runs that never lit are kept, as every burn is, and out of the way.
  const [showUnlit, setShowUnlit] = useState(false);
  // Who fired it and on what code: there when asked for.
  const [details, setDetails] = useState(false);
  useEffect(() => {
    getTunables().then(setTunables).catch(() => undefined);
  }, []);

  const onStand = scope === 'stand' && standDoc !== null;

  const pull = useCallback(() => {
    listRuns(onStand ? standDoc.ref : null)
      .then((list) => {
        setRuns(list);
        setError('');
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [onStand, standDoc]);

  useEffect(() => {
    pull();
    const id = window.setInterval(pull, 5000);
    return () => window.clearInterval(id);
  }, [pull]);

  // Opened from the Engine tab on one burn: pick it once it is in the list.
  const [params, setParams] = useSearchParams();
  const wanted = params.get('run');
  useEffect(() => {
    if (!wanted) return;
    const found = runs.find((r) => r.id === wanted);
    if (!found) return;
    setPicked([key(found)]);
    setParams({}, { replace: true });
  }, [wanted, runs, setParams]);

  const chosen = useMemo(
    () => picked.map((k) => runs.find((r) => key(r) === k)).filter((r): r is RunSummary => !!r),
    [picked, runs],
  );

  // Keyed on which runs are picked, not on the list: the list is re-pulled
  // every few seconds, and a record or diff refetched on each pull flickers.
  const chosenKey = chosen.map(key).join('|');
  useEffect(() => {
    for (const r of chosen) {
      if (records[key(r)]) continue;
      getRun(r.id, r.owner)
        .then((rec) => setRecords((m) => ({ ...m, [key(r)]: rec })))
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenKey]);
  useEffect(() => {
    setDiff(null);
    if (chosen.length !== 2) return;
    diffRuns(chosen[0], chosen[1])
      .then(setDiff)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenKey]);

  // The ladder runs on the server; follow it while it does.
  useEffect(() => {
    explainStatus().then(setExplain).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!explain?.running) return undefined;
    const id = window.setInterval(() => {
      explainStatus().then(setExplain).catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(id);
  }, [explain?.running]);

  const toggle = (r: RunSummary) =>
    setPicked((p) => (p.includes(key(r)) ? p.filter((k) => k !== key(r)) : [...p, key(r)].slice(-2)));

  const shown = chosen.map((r) => records[key(r)]).filter((r): r is RunRecord => !!r);
  const unlit = runs.filter((r) => !lit(r)).length;
  const listed = showUnlit ? runs : runs.filter((r) => lit(r) || picked.includes(key(r)));

  return (
    <div className="space-y-4 p-4 text-[13px] text-[var(--ink)]">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="caps">Runs</h2>
        <div className="flex overflow-hidden rounded border border-gray-700 text-[12px]">
          <button
            className={`px-2.5 py-1 ${onStand ? 'bg-gray-700 text-white' : 'text-gray-400'}`}
            disabled={!standDoc}
            onClick={() => setScope('stand')}
            title={standDoc ? `Every run fired on ${standDoc.name}, by anyone it is shared with` : 'Open a stand to see its runs'}
          >
            This stand
          </button>
          <button
            className={`px-2.5 py-1 ${!onStand ? 'bg-gray-700 text-white' : 'text-gray-400'}`}
            onClick={() => setScope('mine')}
            title="Runs fired off any stand document, in your own folder"
          >
            Mine
          </button>
        </div>
        <span className="text-gray-500" title="A run is recorded when a burn ends. Pick one for its traces, two to compare them.">
          {runs.length - unlit} burn{runs.length - unlit === 1 ? '' : 's'} · pick two to compare
        </span>
        {unlit > 0 && (
          <button
            className="text-[12px] text-gray-500 underline decoration-dotted underline-offset-2 hover:text-gray-300"
            onClick={() => setShowUnlit((v) => !v)}
            title="Sequences run without a light -- Fire then abort, a rehearsal -- are recorded too, at 0 N·s"
          >
            {showUnlit ? `hide ${unlit} that never lit` : `${unlit} never lit`}
          </button>
        )}
        <button
          className="text-[12px] text-gray-500 underline decoration-dotted underline-offset-2 hover:text-gray-300"
          onClick={() => setDetails((v) => !v)}
          title="Who fired each run, and the software it ran on"
        >
          {details ? 'fewer columns' : 'details'}
        </button>
        {shown.map((rec, i) => (
          <button
            key={rec.id}
            className="rounded border border-gray-700 px-2 py-0.5 text-[12px] hover:bg-white/5"
            onClick={() => download(rec)}
            title="The whole record: inputs, code, stand version, outcome, solver summary and traces"
          >
            Download {shown.length > 1 ? (i === 0 ? 'A' : 'B') : 'record'}
          </button>
        ))}
        {error && <span className="text-[var(--bad)]">{error}</span>}
      </div>

      <table className="w-full border-collapse font-mono text-[12px]">
        <thead>
          <tr className="border-b border-gray-800 text-left text-gray-500">
            <th className="w-6" />
            <th className="py-1 pr-3 font-normal">When</th>
            <th
              className="pr-3 font-normal"
              title="The drawing and the engine it burned, from the library. Rocket only: the drawn GSE was cut away. Simplified: feedtwin's own engine fired, not an EngineDesign card."
            >
              Ran on
            </th>
            <th className="pr-3 font-normal" title="The gas that pressed the tanks">
              Gas
            </th>
            <th className="pr-3 text-right font-normal" title="The tanks the engine burned from, at T-0">
              T-0 tanks <span className="text-gray-600">{PRESSURE_UNIT}</span>
            </th>
            {COLUMNS.map((c) => (
              <th key={c.key} className="pr-3 text-right font-normal">
                {c.label} {c.unit && <span className="text-gray-600">{c.unit}</span>}
              </th>
            ))}
            <th className="pr-3 font-normal" title="Every network solve in the burn converged, and how much mass the burn's steps cannot account for, per million of what moved">
              Solver
            </th>
            {details && (
              <>
                <th className="pr-3 font-normal">By</th>
                <th className="font-normal" title="App version and commit; * means the burn ran with local changes not yet committed">
                  Software
                </th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {listed.map((r) => {
            const on = picked.indexOf(key(r));
            const tanks = Object.entries(r.t0_tanks ?? {}).filter((e): e is [string, number] => typeof e[1] === 'number');
            const t0 = [...new Set(tanks.map(([, v]) => psiaText(v)))];
            return (
              <tr
                key={key(r)}
                onClick={() => toggle(r)}
                className={`cursor-pointer border-b border-gray-900 hover:bg-white/5 ${on >= 0 ? 'bg-white/5' : ''}`}
              >
                <td>
                  {on >= 0 && (
                    <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: on === 0 ? A_COLOR : B_COLOR }} />
                  )}
                </td>
                <td className="py-1 pr-3" title={r.created}>
                  {when(r.created)} {r.label && <span className="text-gray-400">· {r.label}</span>}
                </td>
                <td className="max-w-[22rem] truncate pr-3 text-gray-400" title={`${named(r.diagram)} · ${named(r.engine)}`}>
                  {r.diagram ? (
                    <>
                      {named(r.diagram)}
                      {r.engine && <span className="text-gray-600"> · {named(r.engine)}</span>}
                    </>
                  ) : (
                    '—'
                  )}
                  {r.rocket_only && <span className="ml-1.5 text-[10px] uppercase tracking-wider text-gray-500">rocket only</span>}
                  {r.engine_model === 'simplified' && (
                    <span className="ml-1.5 text-[10px] uppercase tracking-wider text-[var(--warn)]/80">simplified</span>
                  )}
                </td>
                <td className="pr-3" title={r.pressurant ? r.pressurant : 'Not recorded: a run from before the gas was kept, on the drawing\'s own'}>
                  {r.pressurant ? (GAS[r.pressurant] ?? r.pressurant) : <span className="text-gray-600">—</span>}
                </td>
                <td
                  className="pr-3 text-right"
                  title={tanks.map(([name, v]) => `${name} ${fmtP(v, 1)}`).join(' · ')}
                >
                  {t0.length ? t0.join(' / ') : '—'}
                </td>
                {COLUMNS.map((c) => {
                  const v = r.outcome[c.key];
                  return (
                    <td key={c.key} className="pr-3 text-right">
                      {typeof v === 'number' ? fixed(c.pressure ? toPsia(v) : v, c.places) : '—'}
                    </td>
                  );
                })}
                <td
                  className="pr-3"
                  title={`${r.converged ? 'Every solve converged' : 'Some solves did not converge'}${
                    typeof r.mass_error_ppm === 'number' ? `; ${fixed(r.mass_error_ppm, 0)} ppm of the mass moved is unaccounted for` : ''
                  }`}
                >
                  <span className={r.converged ? 'text-gray-500' : 'text-[var(--warn)]'}>{r.converged ? 'ok' : 'not converged'}</span>
                  {typeof r.mass_error_ppm === 'number' && Math.abs(r.mass_error_ppm) > 100 && (
                    <span className="text-[var(--warn)]"> {fixed(r.mass_error_ppm, 0)} ppm</span>
                  )}
                </td>
                {/* Said in full on hover: a burn run from a working tree is
                    commit X plus changes not yet committed, and is recorded
                    as that, not passed off as X. */}
                {details && (
                  <>
                    <td className="pr-3 text-gray-400">{r.user}</td>
                    <td className="text-gray-500" title={r.code ? `app ${r.code.app}, library ${r.code.library}, commit ${r.code.commit}${r.code.dirty ? ' plus local changes not yet committed' : ''}` : ''}>
                      {software(r.code)}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
          {listed.length === 0 && (
            <tr>
              <td colSpan={COLUMNS.length + 8} className="py-6 text-center text-gray-500">
                {runs.length ? 'No burns that lit. ' : 'No runs yet. '}A burn is recorded here when it ends.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {shown.length > 0 && <Traces records={shown} />}
      {diff && (
        <DiffPanel
          diff={diff}
          tunables={tunables}
          named={Object.assign({}, ...chosen.map((r) => namesIn(records[key(r)])))}
        />
      )}
      {chosen.length === 2 && (
        <ExplainPanel
          tunables={tunables}
          explain={explain && explain.a === chosen[0].id && explain.b === chosen[1].id ? explain : null}
          busy={!!explain?.running}
          onStart={() =>
            explainRuns(chosen[0], chosen[1])
              .then(setExplain)
              .catch((e) => setError(e instanceof Error ? e.message : String(e)))
          }
          onCancel={() => explainCancel().then(setExplain).catch(() => undefined)}
        />
      )}
    </div>
  );
}

function Traces({ records }: { records: RunRecord[] }) {
  const colors = [A_COLOR, B_COLOR];
  // Two runs share one time base only if they were thinned alike; plot each on
  // the first's clock by nearest sample, which is close enough at 600 points.
  const base = records[0].series.t;
  const resample = (rec: RunRecord, values: number[]) =>
    base.map((t) => {
      const ts = rec.series.t;
      let i = 0;
      while (i < ts.length - 1 && ts[i + 1] <= t) i += 1;
      return t < ts[0] || t > ts[ts.length - 1] ? NaN : values[i];
    });
  // The record's chamber trace is gauge; the panel draws it absolute. O/F is
  // a gap outside the burn, not a 0: two zero flows have no ratio.
  const panel = (name: string, read: (s: RunRecord['series']) => number[]): Channel[] =>
    records.map((rec, i) => ({
      key: `${rec.id}.${name}`,
      tag: records.length > 1 ? (i === 0 ? 'A' : 'B') : name,
      values: i === 0 ? read(rec.series) : resample(rec, read(rec.series)),
      color: colors[i],
    }));
  return (
    <div className="grid grid-cols-3 gap-3">
      <div>
        <h3 className="caps mb-1">Thrust</h3>
        <DaqPlot times={base} channels={panel('Thrust', (s) => s.thrust_N)} yLabel="N" height={180} xLabel="s from ignition" />
      </div>
      <div>
        <h3 className="caps mb-1">Chamber pressure</h3>
        <DaqPlot
          times={base}
          channels={panel('Pc', (s) => s.pc_psig.map(toPsia))}
          yLabel={PRESSURE_UNIT}
          height={180}
          xLabel="s from ignition"
          floor={0}
        />
      </div>
      <div>
        <h3 className="caps mb-1">O/F</h3>
        <DaqPlot times={base} channels={panel('O/F', (s) => s.of.map((v) => (v > 0 ? v : NaN)))} yLabel="O/F" height={180} minSpan={0.2} xLabel="s from ignition" />
      </div>
    </div>
  );
}

/** What a record calls the ids its inputs are keyed by: its vessels (the
 *  traces' labels) and its knobs (the hookup's, so "knob · node 90" reads
 *  "knob · LP-PR"). */
function namesIn(rec: RunRecord | undefined): Record<string, string> {
  if (!rec) return {};
  const out: Record<string, string> = { ...(rec.series?.labels ?? {}) };
  const hookup = rec.inputs?.hookup as { knobs?: { id?: string; label?: string }[] } | undefined;
  for (const k of hookup?.knobs ?? []) if (k.id && k.label && k.label !== k.id) out[k.id] = k.label;
  return out;
}

function DiffPanel({
  diff,
  named = {},
  tunables,
}: {
  diff: RunDiff;
  named?: Record<string, string>;
  tunables: Tunable[];
}) {
  const settings = useMemo(() => new Map(tunables.map((t) => [`setup.${t.key}`, t])), [tunables]);
  // Which setting rows are gauge on the wire (the dome, the COPV charge, the
  // dewar): their two values read absolute, like every other pressure here.
  const gaugeSetup = useMemo(
    () => new Set(tunables.filter(isGaugeTunable).map((t) => `setup.${t.key}`)),
    [tunables],
  );
  const gauge = (key: string, v: unknown): v is number => typeof v === 'number' && isGaugeInput(key, gaugeSetup);
  /** A recorded input as the screen says it: with its unit, a setting's
   *  choice by its name, a flag on or off. */
  const value = (key: string, v: unknown): string => {
    if (gauge(key, v)) return fmtP(v, 1);
    const t = settings.get(key);
    if (typeof v === 'string' && t?.choices) return t.choices.find((c) => c.value === v)?.label ?? show(v);
    if (key === 'setup.pressurant' && v === '') return 'as drawn';
    if (typeof v !== 'number') return show(v);
    const unit = t ? t.unit : UNIT_BY_KEY.find(([re]) => re.test(key))?.[1];
    return unit ? `${num(v)} ${unit}` : num(v);
  };
  const hover = (key: string, v: unknown) => (gauge(key, v) ? fmtP(v, 3) : typeof v === 'number' ? String(v) : show(v));
  // The records name their vessels (traces' labels, and `<...>.label` rows
  // where they differ): use those to name the rest, and leave the label rows
  // themselves out.
  const labels: Record<string, string> = { ...named };
  for (const c of diff.inputs) {
    const m = /\.([^.]+)\.label$/.exec(c.key);
    const v = typeof c.a === 'string' ? c.a : typeof c.b === 'string' ? c.b : '';
    if (m && v) labels[m[1]] = v;
  }
  const changed = diff.inputs
    .filter((c) => !c.key.endsWith('.label'))
    .map((c) => ({
      ...c,
      name:
        settings.get(c.key)?.label ??
        c.key
          .split('.')
          .map((part) => labels[part] ?? WORDS[part] ?? part.replace(/_/g, ' '))
          .join(' · '),
    }));
  // A change smaller than the table shows is not one a reader can see:
  // "498.5 -> 498.5 psia" said the inputs differed and showed them the same.
  const inputs = changed.filter((c) => value(c.key, c.a) !== value(c.key, c.b));
  const unseen = changed.length - inputs.length;
  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <h3 className="caps mb-1">Outcome, A → B</h3>
        <table className="w-full font-mono text-[12px]">
          <tbody>
            {diff.outcome.map((o) => (
              <tr key={o.key} className="border-b border-gray-900">
                <td className="py-0.5 text-gray-400">
                  {o.label} {o.unit && <span className="text-gray-600">{unitLabel(o.unit)}</span>}
                </td>
                {/* A gauge outcome's two values read absolute; the change
                    between them is the same psi either way. */}
                <td className="text-right">{show(absolute(o.a, o.unit))}</td>
                <td className="text-right">{show(absolute(o.b, o.unit))}</td>
                <td className="text-right text-[var(--ink-2)]">
                  {o.delta === null ? '' : `${o.delta >= 0 ? '+' : ''}${show(o.delta)}`}
                </td>
                <td className="text-right text-gray-500">{o.pct === null ? '' : `${o.pct >= 0 ? '+' : ''}${o.pct.toFixed(2)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <h3 className="caps mb-1">
          What changed{' '}
          <span className="text-gray-600" title={unseen ? `${unseen} more differ by less than shown` : undefined}>
            ({inputs.length} input{inputs.length === 1 ? '' : 's'})
          </span>
        </h3>
        <table className="w-full font-mono text-[12px]">
          <tbody>
            {inputs.map((c) => (
              <tr key={c.key} className="border-b border-gray-900 align-top" title={c.group}>
                <td className="py-0.5 pr-2 text-gray-400">{c.name}</td>
                <td className="max-w-[14rem] break-words pr-2 text-right" style={{ color: A_COLOR }} title={hover(c.key, c.a)}>
                  {value(c.key, c.a)}
                </td>
                <td className="max-w-[14rem] break-words text-right" style={{ color: B_COLOR }} title={hover(c.key, c.b)}>
                  {value(c.key, c.b)}
                </td>
              </tr>
            ))}
            {/* The software is not an input: one quiet row says whether it
                differs, and the hover says how. */}
            {diff.code.length > 0 && (
              <tr
                className="border-b border-gray-900 text-gray-500"
                title={`Different software: not attributable by re-running.\n${diff.code
                  .map((c) => `${c.key}: ${show(c.a)} → ${show(c.b)}`)
                  .join('\n')}`}
              >
                <td className="py-0.5 pr-2">software version</td>
                <td className="pr-2 text-right">{software(diff.a.code)}</td>
                <td className="text-right">{software(diff.b.code)}</td>
              </tr>
            )}
            {inputs.length === 0 && diff.code.length === 0 && (
              <tr>
                <td className="py-1 text-gray-500">Nothing: the same inputs and software.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ExplainPanel({
  explain,
  busy,
  onStart,
  onCancel,
  tunables,
}: {
  tunables: Tunable[];
  explain: ExplainState | null;
  busy: boolean;
  onStart: () => void;
  onCancel: () => void;
}) {
  const running = explain?.running;
  // A rung that swapped one setting is named for it, as Configuration names it.
  const settingNames = useMemo(() => new Map(tunables.map((t) => [t.key, t.label])), [tunables]);
  const rungName = (label: string) => {
    const m = /^setting: (.+)$/.exec(label);
    return m ? (settingNames.get(m[1]) ?? m[1].replace(/_/g, ' ')) : label;
  };
  return (
    <div className="space-y-2 rounded border border-gray-800 p-3">
      <div className="flex items-center gap-3">
        <h3 className="caps">Which input moved it</h3>
        {!running && (
          <button
            className="rounded border border-gray-700 px-2.5 py-1 text-[12px] hover:bg-white/5 disabled:opacity-40"
            onClick={onStart}
            disabled={busy}
            title="Replay both runs from their T-0, then A with one input group at a time taken from B. Each rung is a headless burn."
          >
            Explain
          </button>
        )}
        {running && (
          <>
            <span className="text-gray-400">
              {explain?.stage} · {explain?.done}/{explain?.total}
            </span>
            <button className="rounded border border-gray-700 px-2 py-0.5 text-[12px]" onClick={onCancel}>
              Cancel
            </button>
          </>
        )}
        {explain?.error && <span className="text-[var(--bad)]">{explain.error}</span>}
      </div>
      {explain?.attribution && explain.attribution.length > 0 && (
        <div className="grid grid-cols-3 gap-4">
          {explain.attribution
            .filter((a) => ['thrust_mean_N', 'of_mean', 'pc_mean_psi', 'impulse_Ns', 'duration_s', 'isp_s'].includes(a.key))
            .map((a) => (
              <Waterfall key={a.key} a={a} name={rungName} />
            ))}
        </div>
      )}
      {explain?.reproduction && explain.reproduction.length > 0 && (
        <p className="text-[11px] text-gray-500" title="A cockpit burn is flown by a person; a replay from T-0 is not. A large gap means the attribution explains the replay rather than the burn.">
          Replay vs recorded:{' '}
          {explain.reproduction
            .filter((r) => r.key === 'thrust_mean_N')
            .map((r) => `${r.run} ${fixed(r.replayed, 0)} vs ${fixed(r.recorded, 0)} N`)
            .join(' · ')}
        </p>
      )}
      {explain?.rungs?.some((r) => r.error) && (
        <p className="text-[11px] text-[var(--warn)]">
          {explain.rungs
            .filter((r) => r.error)
            .map((r) => `${rungName(r.label)}: ${r.error}`)
            .join(' · ')}
        </p>
      )}
    </div>
  );
}

function Waterfall({
  a,
  name,
}: {
  a: { label: string; unit: string; a: number; b: number; total: number; parts: { label: string; delta: number }[]; interaction: number };
  name: (label: string) => string;
}) {
  const rows = [...a.parts.map((p) => ({ ...p, label: name(p.label) })), { label: 'interaction', delta: a.interaction }];
  // Bars are to scale with each other, but never wider than the change is
  // worth: a floor of 0.5 % of the first run's value keeps a -0.001 O/F
  // shift from drawing as a full-length bar.
  const scale = Math.max(...rows.map((r) => Math.abs(r.delta)), Math.abs(a.total), 0.005 * Math.abs(a.a), 1e-12);
  const places = Math.abs(a.a) >= 100 ? 1 : 3;
  return (
    <div>
      <h4 className="mb-1 text-[12px] text-gray-400">
        {a.label}
        {a.unit ? <span className="text-gray-600"> {unitLabel(a.unit)}</span> : null}:{' '}
        <span className="font-mono text-gray-300">
          {fixed(absolute(a.a, a.unit) ?? a.a, places)} → {fixed(absolute(a.b, a.unit) ?? a.b, places)} ({a.total >= 0 ? '+' : ''}
          {fixed(a.total, places)})
        </span>
      </h4>
      <div className="space-y-0.5 font-mono text-[11px]">
        {rows.map((r) => (
          <div key={r.label} className="grid grid-cols-[9rem_1fr_4.5rem] items-center gap-2">
            <span className={`truncate ${r.label === 'interaction' ? 'text-gray-500' : 'text-gray-300'}`} title={r.label}>
              {r.label}
            </span>
            <div className="relative h-2.5 bg-white/5">
              <div
                className="absolute top-0 h-full"
                style={{
                  left: r.delta >= 0 ? '50%' : `${50 - (50 * Math.abs(r.delta)) / scale}%`,
                  width: `${(50 * Math.abs(r.delta)) / scale}%`,
                  background: r.label === 'interaction' ? 'var(--ink-4)' : r.delta >= 0 ? 'var(--ok)' : 'var(--bad)',
                }}
              />
              <div className="absolute left-1/2 top-0 h-full w-px bg-gray-600" />
            </div>
            <span className="text-right">
              {r.delta >= 0 ? '+' : ''}
              {fixed(r.delta, places)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
