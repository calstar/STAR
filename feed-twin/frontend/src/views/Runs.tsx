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
import {
  diffRuns,
  explainCancel,
  explainRuns,
  explainStatus,
  fixed,
  getRun,
  listRuns,
  when,
  type ExplainState,
  type RunDiff,
  type RunRecord,
  type RunSummary,
} from '../api';
import { DaqPlot, type Channel } from '../components/DaqPlot';
import { useStand } from '../stand';

const COLUMNS: { key: string; label: string; unit: string; places: number }[] = [
  { key: 'thrust_mean_N', label: 'Thrust', unit: 'N', places: 0 },
  { key: 'impulse_Ns', label: 'Impulse', unit: 'N·s', places: 0 },
  { key: 'duration_s', label: 'Burn', unit: 's', places: 2 },
  { key: 'pc_mean_psi', label: 'Pc', unit: 'psig', places: 1 },
  { key: 'of_mean', label: 'O/F', unit: '', places: 3 },
  { key: 'isp_s', label: 'Isp', unit: 's', places: 1 },
];

const A_COLOR = '#3498DB';
const B_COLOR = '#F39C12';

const show = (v: unknown) =>
  typeof v === 'number' ? fixed(v, Math.abs(v) >= 100 ? 1 : 3) : v === undefined ? '—' : JSON.stringify(v);

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
  const { standDoc } = useStand();
  const [scope, setScope] = useState<'stand' | 'mine'>(standDoc ? 'stand' : 'mine');
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [records, setRecords] = useState<Record<string, RunRecord>>({});
  const [diff, setDiff] = useState<RunDiff | null>(null);
  const [explain, setExplain] = useState<ExplainState | null>(null);
  const [error, setError] = useState('');

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

  return (
    <div className="space-y-4 p-4 text-[13px] text-gray-200">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-semibold">Runs</h2>
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
          {runs.length} recorded · pick two to compare
        </span>
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
        {error && <span className="text-red-400">{error}</span>}
      </div>

      <table className="w-full border-collapse font-mono text-[12px]">
        <thead>
          <tr className="border-b border-gray-800 text-left text-gray-500">
            <th className="w-6" />
            <th className="py-1 pr-3 font-normal">When</th>
            <th className="pr-3 font-normal">By</th>
            {COLUMNS.map((c) => (
              <th key={c.key} className="pr-3 text-right font-normal">
                {c.label} {c.unit && <span className="text-gray-600">{c.unit}</span>}
              </th>
            ))}
            <th className="pr-3 font-normal" title="Every network solve in the burn converged, and how much mass the burn's steps cannot account for, per million of what moved">
              Solver
            </th>
            <th className="font-normal" title="App and library version, commit; * means uncommitted changes">
              Code
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const on = picked.indexOf(key(r));
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
                <td className="pr-3 text-gray-400">{r.user}</td>
                {COLUMNS.map((c) => {
                  const v = r.outcome[c.key];
                  return (
                    <td key={c.key} className="pr-3 text-right">
                      {typeof v === 'number' ? fixed(v, c.places) : '—'}
                    </td>
                  );
                })}
                <td className="pr-3">
                  <span className={r.converged ? 'text-green-400' : 'text-amber-400'}>{r.converged ? 'conv' : 'UNCONV'}</span>
                  {typeof r.mass_error_ppm === 'number' && (
                    <span className={Math.abs(r.mass_error_ppm) > 100 ? ' text-amber-400' : ' text-gray-500'}>
                      {' '}
                      {fixed(r.mass_error_ppm, 0)} ppm
                    </span>
                  )}
                </td>
                <td className="text-gray-500" title={r.code ? `app ${r.code.app}, library ${r.code.library}, ${r.code.commit}` : ''}>
                  {r.code ? `${r.code.app} ${r.code.commit.slice(0, 7)}${r.code.dirty ? '*' : ''}` : ''}
                </td>
              </tr>
            );
          })}
          {runs.length === 0 && (
            <tr>
              <td colSpan={COLUMNS.length + 5} className="py-6 text-center text-gray-500">
                No runs yet. A burn is recorded here when it ends.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {shown.length > 0 && <Traces records={shown} />}
      {diff && <DiffPanel diff={diff} />}
      {chosen.length === 2 && (
        <ExplainPanel
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
  const panel = (field: 'thrust_N' | 'pc_psig' | 'of'): Channel[] =>
    records.map((rec, i) => ({
      key: `${rec.id}.${field}`,
      tag: records.length > 1 ? (i === 0 ? 'A' : 'B') : field,
      values: i === 0 ? rec.series[field] : resample(rec, rec.series[field]),
      color: colors[i],
    }));
  return (
    <div className="grid grid-cols-3 gap-3">
      <div>
        <h3 className="mb-1 text-[12px] text-gray-400">Thrust</h3>
        <DaqPlot times={base} channels={panel('thrust_N')} yLabel="N" height={180} xLabel="s from ignition" />
      </div>
      <div>
        <h3 className="mb-1 text-[12px] text-gray-400">Chamber pressure</h3>
        <DaqPlot times={base} channels={panel('pc_psig')} yLabel="psig" height={180} xLabel="s from ignition" />
      </div>
      <div>
        <h3 className="mb-1 text-[12px] text-gray-400">O/F</h3>
        <DaqPlot times={base} channels={panel('of')} yLabel="O/F" height={180} minSpan={0.2} xLabel="s from ignition" />
      </div>
    </div>
  );
}

function DiffPanel({ diff }: { diff: RunDiff }) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <h3 className="mb-1 text-[12px] text-gray-400">Outcome, A → B</h3>
        <table className="w-full font-mono text-[12px]">
          <tbody>
            {diff.outcome.map((o) => (
              <tr key={o.key} className="border-b border-gray-900">
                <td className="py-0.5 text-gray-400">
                  {o.label} {o.unit && <span className="text-gray-600">{o.unit}</span>}
                </td>
                <td className="text-right">{show(o.a)}</td>
                <td className="text-right">{show(o.b)}</td>
                <td className={`text-right ${o.delta && o.delta < 0 ? 'text-red-300' : 'text-green-300'}`}>
                  {o.delta === null ? '' : `${o.delta >= 0 ? '+' : ''}${show(o.delta)}`}
                </td>
                <td className="text-right text-gray-500">{o.pct === null ? '' : `${o.pct >= 0 ? '+' : ''}${o.pct.toFixed(2)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <h3 className="mb-1 text-[12px] text-gray-400">
          What changed <span className="text-gray-600">({diff.inputs.length} inputs)</span>
        </h3>
        <table className="w-full font-mono text-[12px]">
          <tbody>
            {diff.inputs.map((c) => (
              <tr key={c.key} className="border-b border-gray-900" title={c.group}>
                <td className="py-0.5 pr-2 text-gray-400">{c.key}</td>
                <td className="pr-2 text-right" style={{ color: A_COLOR }}>
                  {show(c.a)}
                </td>
                <td className="text-right" style={{ color: B_COLOR }}>
                  {show(c.b)}
                </td>
              </tr>
            ))}
            {diff.code.map((c) => (
              <tr key={`code.${c.key}`} className="border-b border-gray-900 text-amber-300" title="The code differs: not attributable by re-running">
                <td className="py-0.5 pr-2">code.{c.key}</td>
                <td className="pr-2 text-right">{show(c.a)}</td>
                <td className="text-right">{show(c.b)}</td>
              </tr>
            ))}
            {diff.inputs.length === 0 && diff.code.length === 0 && (
              <tr>
                <td className="py-1 text-gray-500">Nothing: the same inputs and code.</td>
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
}: {
  explain: ExplainState | null;
  busy: boolean;
  onStart: () => void;
  onCancel: () => void;
}) {
  const running = explain?.running;
  return (
    <div className="space-y-2 rounded border border-gray-800 p-3">
      <div className="flex items-center gap-3">
        <h3 className="text-[12px] font-semibold text-gray-300">Which input moved it</h3>
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
        {explain?.error && <span className="text-red-400">{explain.error}</span>}
      </div>
      {explain?.attribution && explain.attribution.length > 0 && (
        <div className="grid grid-cols-3 gap-4">
          {explain.attribution
            .filter((a) => ['thrust_mean_N', 'of_mean', 'pc_mean_psi', 'impulse_Ns', 'duration_s', 'isp_s'].includes(a.key))
            .map((a) => (
              <Waterfall key={a.key} a={a} />
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
        <p className="text-[11px] text-amber-300">
          {explain.rungs
            .filter((r) => r.error)
            .map((r) => `${r.label}: ${r.error}`)
            .join(' · ')}
        </p>
      )}
    </div>
  );
}

function Waterfall({ a }: { a: { label: string; unit: string; a: number; b: number; total: number; parts: { label: string; delta: number }[]; interaction: number } }) {
  const rows = [...a.parts, { label: 'interaction', delta: a.interaction }];
  // Bars are to scale with each other, but never wider than the change is
  // worth: a floor of 0.5 % of the first run's value keeps a -0.001 O/F
  // shift from drawing as a full-length bar.
  const scale = Math.max(...rows.map((r) => Math.abs(r.delta)), Math.abs(a.total), 0.005 * Math.abs(a.a), 1e-12);
  const places = Math.abs(a.a) >= 100 ? 1 : 3;
  return (
    <div>
      <h4 className="mb-1 text-[12px] text-gray-400">
        {a.label} {a.unit && <span className="text-gray-600">{a.unit}</span>}:{' '}
        <span className="font-mono text-gray-300">
          {fixed(a.a, places)} → {fixed(a.b, places)} ({a.total >= 0 ? '+' : ''}
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
                  background: r.label === 'interaction' ? '#64748B' : r.delta >= 0 ? '#27AE60' : '#E74C3C',
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
