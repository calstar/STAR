/**
 * The solver: can the numbers on the other pages be trusted?
 *
 * Laid out the way a CFD code shows a run (Fluent's residual monitor): one
 * plot of every residual against time, each divided by its own convergence
 * criterion so a single dashed line at 1 means "converged below here"; the
 * iteration log beside it, a row per tick, newest at the bottom; and the
 * report monitors -- iterations, the mass balance, the guards -- small along
 * the bottom. A verdict across the top says it in words first.
 *
 * It used to be six separate plots in six units, which a person had to read
 * all of to learn that everything was fine (the operator, 2026-10-09: "a
 * bunch of plots ... ansys style would help me understand better").
 *
 * A run that converges and plots smoothly is still not evidence by itself
 * (docs/PHYSICS-BENCHMARK.md). This page is how a person checks the arithmetic
 * under a trace before believing it.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { fixed, sessionSolver, type SolverTrace } from '../api';
import { DaqPlot, fmtReading, type Channel } from '../components/DaqPlot';
import { useStand } from '../stand';

/** Guards correcting more than this, per million of throughput, read amber. */
const GUARD_PPM_OK = 1000;

/** Mass kept to this many parts per million of throughput reads as kept. */
const MASS_PPM_OK = 10;

/** The continuity a converged solve is held to on this page [kg/s]: a
 *  milligram a second at the worst node. The solve itself stops on its scaled
 *  residual (the network tolerance); this is the display's line, not the
 *  solver's, and a converged network sits many decades under it. */
const CONTINUITY_CRITERION = 1e-6;

/** Series colours: one per equation, the same in the plot, the log and the
 *  verdict. */
const COLOURS = {
  newton: '#F39C12',
  continuity: '#27AE60',
  chamber: '#EC4899',
  mass: '#60A5FA',
  criterion: '#8a8a8a',
};

const exp = (v: number) => (v === 0 ? '0' : v.toExponential(2));

export function Solver() {
  const { live } = useStand();
  const [trace, setTrace] = useState<SolverTrace | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!live?.id) return undefined;
    const pull = () =>
      sessionSolver(live.id)
        .then((s) => {
          setTrace(s);
          setError('');
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    pull();
    const id = window.setInterval(pull, 2000);
    return () => window.clearInterval(id);
  }, [live?.id]);

  const networkTol = Number(live?.setup?.network_tolerance ?? 1e-4) || 1e-4;
  const chamberTol = Number(live?.setup?.chamber_tolerance_psi ?? 0.5) || 0.5;

  // Each residual over its criterion, per tick: the monitor's lines and the
  // log's columns.
  const rows = useMemo(() => {
    if (!trace) return null;
    const ppm = trace.t.map((_, i) => {
      const unexplained = (trace.mass_error_kg[i] ?? 0) - (trace.guard_kg[i] ?? 0);
      const scale = Math.max(trace.crossed_kg?.[i] ?? 0, trace.inventory_kg[i] ?? 0, 1e-9);
      return (unexplained / scale) * 1e6;
    });
    return {
      ppm,
      newton: trace.residual.map((v) => v / networkTol),
      continuity: trace.continuity.map((v) => v / CONTINUITY_CRITERION),
      chamber: trace.chamber_residual_psi.map((v) => v / chamberTol),
      mass: ppm.map((v) => Math.abs(v) / MASS_PPM_OK),
    };
  }, [trace, networkTol, chamberTol]);

  if (error) return <p className="p-6 text-sm text-red-400">{error}</p>;
  if (!trace || !rows) return <p className="p-6 text-sm text-text-muted">Reading the solver…</p>;

  const s = trace.summary;
  const unexplainedPpm = s.unexplained_ppm ?? s.mass_error_ppm ?? 0;
  const failed = s.unconverged ?? 0;
  const lastFail = (() => {
    for (let i = trace.converged.length - 1; i >= 0; i -= 1) if (!trace.converged[i]) return trace.t[i];
    return null;
  })();
  const checks = [
    {
      key: 'newton',
      ok: failed === 0,
      label: 'Every solve converged',
      bad:
        `${fixed(failed, 0)} of ${fixed(s.ticks ?? 0, 0)} ticks did not converge` +
        (lastFail !== null ? `, the last at ${fixed(lastFail, 1)} s` : ''),
      hint: 'A tick that does not converge holds the last good flows; its frame is an extrapolation, not a solution.',
    },
    {
      key: 'mass',
      ok: Math.abs(unexplainedPpm) <= MASS_PPM_OK,
      label: `Mass kept · ${fixed(Math.abs(unexplainedPpm), 2)} ppm unexplained`,
      bad: `Mass not kept · ${fixed(unexplainedPpm, 1)} ppm unexplained`,
      hint: `Mass no vessel booked and no boundary carried: ${(s.unexplained_kg ?? 0).toExponential(2)} kg against ${fixed(s.throughput_kg ?? 0, 3)} kg through the boundary. Under ${MASS_PPM_OK} ppm reads as kept; more is a leak in the model.`,
    },
    {
      key: 'chamber',
      ok: (s.worst_chamber_psi ?? 0) <= chamberTol,
      label: `Chamber closed · worst ${exp(s.worst_chamber_psi ?? 0)} psi`,
      bad: `Chamber left open · worst ${exp(s.worst_chamber_psi ?? 0)} psi (tolerance ${chamberTol} psi)`,
      hint: 'How far the flow the feed delivers and the chamber pressure it makes were left apart. Zero without an engine lit.',
    },
    {
      key: 'guards',
      ok: Math.abs(s.guard_ppm ?? 0) <= GUARD_PPM_OK,
      label: `Guards quiet · ${fixed(Math.abs(s.guard_ppm ?? 0), 0)} ppm`,
      bad: `Guards busy · ${fixed(s.guard_ppm ?? 0, 0)} ppm of throughput`,
      hint: `What the vessels' floors and clamps changed (${fmtReading(s.guard_kg ?? 0)} kg, ${fmtReading(s.guard_J ?? 0)} J), booked so the balance can tell them from a leak. Each is physics -- a vent cannot pull below atmosphere -- but past ${GUARD_PPM_OK} ppm they are doing a model's work.`,
    },
  ];
  const trusted = checks.every((c) => c.ok);

  const monitor: Channel[] = [
    {
      key: 'newton',
      tag: 'network (Newton)',
      values: rows.newton,
      color: COLOURS.newton,
      hint: `Worst scaled residual of the network solves in the tick ÷ the network tolerance (${networkTol}). Each solve stops below 1.`,
    },
    {
      key: 'continuity',
      tag: 'continuity',
      values: rows.continuity,
      color: COLOURS.continuity,
      hint: `Worst net mass imbalance at any node of the network ÷ ${CONTINUITY_CRITERION} kg/s (a milligram a second).`,
    },
    {
      key: 'chamber',
      tag: 'chamber closure',
      values: rows.chamber,
      color: COLOURS.chamber,
      hint: `|flow-implied minus solved| chamber pressure ÷ the chamber tolerance (${chamberTol} psi). Absent while the engine is cold.`,
    },
    {
      key: 'mass',
      tag: 'mass balance',
      values: rows.mass,
      color: COLOURS.mass,
      hint: `Unexplained mass, ppm of what crossed the boundary, ÷ ${MASS_PPM_OK} ppm.`,
    },
    {
      key: 'criterion',
      tag: 'criterion',
      values: trace.t.map(() => 1),
      color: COLOURS.criterion,
      dash: [6, 4],
      hint: 'Every line is its residual divided by its own criterion: below this line is converged.',
    },
  ];

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* The verdict, in words, before any plot. */}
      <div
        className={`flex flex-wrap items-center gap-x-8 gap-y-2 border px-5 py-3 ${
          trusted ? 'border-emerald-900/70 bg-emerald-950/20' : 'border-amber-900/70 bg-amber-950/20'
        }`}
      >
        <div>
          <div className={`font-mono text-[15px] font-semibold ${trusted ? 'text-emerald-300' : 'text-amber-300'}`}>
            {trusted ? 'The arithmetic holds' : 'Read the traces with care'}
          </div>
          <div className="text-[11px] text-text-muted">
            {fixed(s.ticks ?? 0, 0)} ticks · last {fixed(trace.t[trace.t.length - 1] ?? 0, 1)} s
          </div>
        </div>
        {checks.map((c) => (
          <span key={c.key} className="flex items-center gap-2 font-mono text-[12px]" title={c.hint}>
            <span className={c.ok ? 'text-emerald-400' : 'text-amber-400'}>{c.ok ? '✓' : '✗'}</span>
            <span className={c.ok ? 'text-[var(--ink-2)]' : 'text-amber-300'}>{c.ok ? c.label : c.bad}</span>
          </span>
        ))}
      </div>

      {trace.t.length < 2 ? (
        <p className="text-sm text-text-muted">The record starts with the stand's first ticks.</p>
      ) : (
        <>
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
            <section className="bg-card min-w-0 border border-gray-800 p-3">
              <div className="mb-1 flex flex-wrap items-baseline gap-x-3">
                <span className="caps text-[11px]">Residuals</span>
                <span className="text-[11px] text-text-muted">
                  each ÷ its criterion — under the dashed line is converged. Spikes at a valve or a state change are
                  normal; they should come back down.
                </span>
              </div>
              <DaqPlot
                times={trace.t}
                channels={monitor}
                yLabel="residual ÷ criterion"
                xLabel="stand time (s)"
                height={340}
                minSpan={1}
                initialLog
                allowLog
                lineWidth={1.5}
              />
            </section>
            <IterationLog trace={trace} rows={rows} />
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <Monitor
              title="Iterations per tick"
              hint="Newton iterations summed over the tick, the most any one solve took, and the network solves (couplings) the tick needed. A climb is the solver working harder, usually at a state change."
              times={trace.t}
              channels={[
                { key: 'iterations', tag: 'iterations', values: trace.iterations, color: '#3498DB' },
                { key: 'max', tag: 'worst solve', values: trace.iterations_max, color: '#9B59B6' },
                { key: 'couplings', tag: 'solves', values: trace.couplings, color: '#94A3B8' },
              ]}
              minSpan={5}
            />
            <Monitor
              title="Mass balance (kg, cumulative)"
              hint="Unexplained: mass no vessel booked and no boundary carried -- a leak in the model; it should sit at zero. Guards: what the vessels' floors and clamps added or removed, booked so they can be told from a leak. Both restart when the stand is put somewhere directly (T-0)."
              times={trace.t}
              channels={[
                {
                  key: 'unexplained',
                  tag: 'unexplained',
                  values: trace.mass_error_kg.map((e, i) => e - (trace.guard_kg[i] ?? 0)),
                  color: '#EF4444',
                },
                { key: 'guard_kg', tag: 'guards', values: trace.guard_kg, color: '#F59E0B' },
              ]}
              minSpan={1e-9}
            />
            <Monitor
              title="Guard energy (J, cumulative)"
              hint="Ullage energy the vessels' guards added or removed beyond what their rates said."
              times={trace.t}
              channels={[{ key: 'guard_J', tag: 'guards', values: trace.guard_J, color: '#F59E0B' }]}
              minSpan={1e-6}
            />
          </div>
        </>
      )}
    </div>
  );
}

/** One report monitor: a small plot with its title and a hover that says what
 *  it is. */
function Monitor({
  title,
  hint,
  times,
  channels,
  minSpan,
}: {
  title: string;
  hint: string;
  times: number[];
  channels: Channel[];
  minSpan: number;
}) {
  const flat = channels.every((c) => c.values.every((v) => v === 0));
  return (
    <section className="bg-card min-w-0 border border-gray-800 p-3" title={hint}>
      <div className="mb-1 flex items-baseline gap-2">
        <span className="caps text-[11px]">{title}</span>
        {flat && <span className="font-mono text-[11px] text-emerald-300/80">zero throughout</span>}
      </div>
      <DaqPlot times={times} channels={channels} yLabel="" xLabel="stand time (s)" height={150} minSpan={minSpan} lineWidth={1.5} />
    </section>
  );
}

/**
 * The iteration log: a row per tick, newest at the bottom, in the residual
 * monitor's colours -- the text a CFD console prints while it runs. A tick
 * that did not converge is red. Follows the newest row unless scrolled up.
 */
function IterationLog({
  trace,
  rows,
}: {
  trace: SolverTrace;
  rows: { newton: number[]; continuity: number[]; chamber: number[]; ppm: number[] };
}) {
  const box = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const n = trace.t.length;
  const from = Math.max(0, n - 300);
  useEffect(() => {
    const el = box.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [n, trace]);

  const head = 'px-2 py-1 text-right font-normal';
  const cell = 'px-2 py-0.5 text-right tabular-nums';
  return (
    <section className="bg-card flex min-h-0 min-w-0 flex-col border border-gray-800 p-3" style={{ maxHeight: 430 }}>
      <div className="mb-1 flex items-baseline gap-2">
        <span className="caps text-[11px]">Iteration log</span>
        <span className="text-[11px] text-text-muted">÷ criterion, newest last</span>
      </div>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="min-h-0 flex-1 overflow-auto"
      >
        <table className="w-full font-mono text-[11px]">
          <thead className="sticky top-0 bg-[#0d0d0d] text-[10px] uppercase tracking-wider text-gray-500">
            <tr>
              <th className={head} title="Stand time [s]">t</th>
              <th className={head} title="Network solves the tick took / Newton iterations">solves/it</th>
              <th className={head} style={{ color: COLOURS.newton }} title="Network residual ÷ tolerance">network</th>
              <th className={head} style={{ color: COLOURS.continuity }} title="Continuity ÷ 1 mg/s">contin.</th>
              <th className={head} style={{ color: COLOURS.chamber }} title="Chamber closure ÷ tolerance">chamber</th>
              <th className={head} style={{ color: COLOURS.mass }} title="Unexplained mass [ppm of throughput]">mass ppm</th>
            </tr>
          </thead>
          <tbody>
            {trace.t.slice(from).map((t, k) => {
              const i = from + k;
              const ok = trace.converged[i];
              return (
                <tr key={i} className={ok ? 'text-[var(--ink-2)]' : 'bg-red-950/40 text-red-300'}>
                  <td className={cell}>{fixed(t, 2)}</td>
                  <td className={cell}>
                    {trace.couplings[i]}/{trace.iterations[i]}
                  </td>
                  <td className={cell}>{exp(rows.newton[i] ?? 0)}</td>
                  <td className={cell}>{exp(rows.continuity[i] ?? 0)}</td>
                  <td className={cell}>{exp(rows.chamber[i] ?? 0)}</td>
                  <td className={cell}>{fixed(rows.ppm[i] ?? 0, 2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
