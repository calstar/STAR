/**
 * The solver: can the numbers on the other pages be trusted?
 *
 * Laid out the way a CFD code shows a run (Fluent's residual monitor): one
 * plot of every residual against time, each divided by its own convergence
 * criterion so a single dashed line at 1 means "converged below here"; the
 * iteration log beside it, a row per tick, newest at the bottom; and the
 * report monitors -- iterations, the mass balance, the clamps -- small along
 * the bottom. Five checks across the top, PASS or FAIL, numbers on hover (the
 * operator, 2026-10-09: "just make it checks ... no bloat").
 *
 * It used to be six separate plots in six units, which a person had to read
 * all of to learn that everything was fine (the operator, 2026-10-09: "a
 * bunch of plots ... ansys style would help me understand better").
 *
 * A run that converges and plots smoothly is still not evidence by itself
 * (docs/PHYSICS-BENCHMARK.md). This page is how a person checks the arithmetic
 * under a trace before believing it.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fixed, sessionRepro, sessionSolver, type SolverTrace, type WatchFlag } from '../api';
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

/** Where the Advanced fold was left, for this viewer. */
const ADVANCED_KEY = 'feedtwin.solver.advanced';

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

  if (error) return <p className="p-6 text-sm text-[var(--bad)]">{error}</p>;
  if (!trace || !rows) return <p className="p-6 text-sm text-text-muted">Reading the solver…</p>;

  const s = trace.summary;
  const unexplainedPpm = s.unexplained_ppm ?? s.mass_error_ppm ?? 0;
  const failed = s.unconverged ?? 0;
  const lastFail = (() => {
    for (let i = trace.converged.length - 1; i >= 0; i -= 1) if (!trace.converged[i]) return trace.t[i];
    return null;
  })();
  const flags = trace.flags ?? [];
  const openFlags = flags.filter((f) => f.open).length;
  // Five checks, a word and PASS or FAIL each; the numbers are in the hover.
  const checks = [
    {
      key: 'newton',
      label: 'Converged',
      ok: failed === 0,
      hint:
        failed === 0
          ? `All ${fixed(s.ticks ?? 0, 0)} ticks converged.`
          : `${fixed(failed, 0)} of ${fixed(s.ticks ?? 0, 0)} ticks did not converge` +
            (lastFail !== null ? `, the last at ${fixed(lastFail, 1)} s.` : '.'),
    },
    {
      key: 'mass',
      label: 'Mass balance',
      ok: Math.abs(unexplainedPpm) <= MASS_PPM_OK,
      hint: `${fixed(unexplainedPpm, 2)} ppm of the mass that moved is unaccounted for (limit ${MASS_PPM_OK}).`,
    },
    {
      key: 'chamber',
      label: 'Chamber',
      ok: (s.worst_chamber_psi ?? 0) <= chamberTol,
      hint: `Worst chamber pressure mismatch ${exp(s.worst_chamber_psi ?? 0)} psi (limit ${chamberTol}).`,
    },
    {
      key: 'clamps',
      label: 'Clamps',
      ok: Math.abs(s.guard_ppm ?? 0) <= GUARD_PPM_OK,
      hint: `The tank model's clamps changed ${fixed(Math.abs(s.guard_ppm ?? 0), 0)} ppm of the mass that moved (${fmtReading(s.guard_kg ?? 0)} kg, ${fmtReading(s.guard_J ?? 0)} J; limit ${GUARD_PPM_OK}).`,
    },
    {
      key: 'watch',
      label: 'Watch',
      ok: flags.length === 0,
      hint:
        flags.length === 0
          ? 'No law broken: no gas made in a sealed tank, no line stuck at the solver\'s guess, no pressure held against an open path, no liquid from nowhere, no mass unaccounted for.'
          : `${flags.length} flag${flags.length === 1 ? '' : 's'}${openFlags ? `, ${openFlags} still open` : ''}. Listed below.`,
    },
  ];

  const monitor: Channel[] = [
    {
      key: 'newton',
      tag: 'network solve',
      values: rows.newton,
      color: COLOURS.newton,
      hint: `Worst scaled residual of the network solves in the tick (Newton) ÷ the network tolerance (${networkTol}). Each solve stops below 1.`,
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

  // Nothing has been solved while the stand sits idle with nothing flowing:
  // every residual is zero, which a log axis cannot draw, and the monitor
  // showed only its dashed criterion, as if the lines had gone missing.
  // (The mass balance is no sign of a solve: its round-off reads 1e-12.)
  const solved = monitor.slice(0, 3).some((c) => c.values.some((v) => v > 0));
  return (
    <div className="flex flex-col gap-3 p-4">
      <h2 className="caps">Solver</h2>
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 border border-gray-800 px-5 py-3">
        {checks.map((c) => (
          <span key={c.key} className="flex items-center gap-2 font-mono text-[12.5px]" title={c.hint}>
            <span className="text-[var(--ink-2)]">{c.label}</span>
            <span
              className={`rounded px-1.5 py-px text-[11px] font-semibold ${
                c.ok ? 'bg-[var(--ok)]/10 text-[var(--ok)]' : 'bg-[var(--bad)]/10 text-[var(--bad)]'
              }`}
            >
              {c.ok ? 'PASS' : 'FAIL'}
            </span>
          </span>
        ))}
      </div>

      {flags.length > 0 && <Flags flags={flags} />}

      {trace.t.length < 2 ? (
        <p className="text-sm text-text-muted">The record starts with the stand's first ticks.</p>
      ) : (
        <>
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
            <section className="bg-card min-w-0 border border-gray-800 p-3">
              <div className="mb-1">
                <span className="caps text-[11px]" title="Each residual divided by its own limit: below the dashed line is converged.">
                  Residuals
                </span>
              </div>
              {solved ? (
                <DaqPlot
                  times={trace.t}
                  channels={monitor}
                  yLabel="residual ÷ criterion"
                  xLabel="stand time (s)"
                  height={340}
                  minSpan={1}
                  initialLog
                  allowLog
                  logCeil={10}
                  lineWidth={1.5}
                />
              ) : (
                <div className="flex h-[340px] flex-col items-center justify-center gap-1 text-center">
                  <p className="text-[13px] text-[var(--ink-2)]">No solve yet</p>
                  <p className="max-w-sm text-[12px] text-[var(--ink-3)]">
                    The stand is idle: nothing flows, so there is nothing to solve. The residuals start with the
                    first valve that opens.
                  </p>
                </div>
              )}
            </section>
            <IterationLog trace={trace} rows={rows} />
          </div>
        </>
      )}
      <Advanced>
        {trace.t.length >= 2 && (
          <div className="grid gap-3 lg:grid-cols-3">
            <Monitor
              title="Steps per tick"
              hint="Newton steps summed over the tick, the most any one solve took, and the network solves (couplings) the tick needed. A climb is the solver working harder, usually at a state change."
              times={trace.t}
              channels={[
                { key: 'iterations', tag: 'steps', values: trace.iterations, color: '#3498DB' },
                { key: 'max', tag: 'worst solve', values: trace.iterations_max, color: '#9B59B6' },
                { key: 'couplings', tag: 'solves', values: trace.couplings, color: '#94A3B8' },
              ]}
              minSpan={5}
            />
            <Monitor
              title="Mass balance (kg)"
              hint="Unexplained: mass nothing accounts for -- it should stay at zero. Clamps: mass the tank model added or removed to keep a tank valid. Both restart at T-0."
              times={trace.t}
              channels={[
                {
                  key: 'unexplained',
                  tag: 'unexplained',
                  values: trace.mass_error_kg.map((e, i) => e - (trace.guard_kg[i] ?? 0)),
                  color: '#EF4444',
                },
                { key: 'guard_kg', tag: 'clamps', values: trace.guard_kg, color: '#F59E0B' },
              ]}
              minSpan={1e-9}
            />
            <Monitor
              title="Clamp energy (J)"
              hint="Energy the tank model added to or removed from the ullages to keep a tank valid (e.g. never below atmosphere). It should stay near zero."
              times={trace.t}
              channels={[{ key: 'guard_J', tag: 'clamps', values: trace.guard_J, color: '#F59E0B' }]}
              minSpan={1e-6}
            />
          </div>
        )}
        {live?.id && <ExportRepro id={live.id} />}
      </Advanced>
    </div>
  );
}

/** What a person checking the solver's arithmetic wants and nobody else
 *  does: the work per tick, the tank model's clamps, the repro export.
 *  Folded, and left as this viewer left it. */
function Advanced({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(() => {
    try {
      return window.localStorage.getItem(ADVANCED_KEY) === 'open';
    } catch {
      return false;
    }
  });
  const flip = () => {
    setOpen((was) => {
      try {
        window.localStorage.setItem(ADVANCED_KEY, was ? 'closed' : 'open');
      } catch {
        // Storage can be unavailable; the fold still works for this visit.
      }
      return !was;
    });
  };
  return (
    <section className="flex flex-col gap-3">
      <button
        type="button"
        onClick={flip}
        aria-expanded={open}
        className="caps self-start hover:text-[var(--ink)]"
        title="Steps per tick, the mass balance, the clamps, and the repro export"
      >
        {open ? '−' : '+'} Advanced
      </button>
      {open && children}
    </section>
  );
}

/** The watcher's flags: what broke, on what, when; the numbers on hover. */
function Flags({ flags }: { flags: WatchFlag[] }) {
  return (
    <section className="bg-card border border-[var(--color-danger-solid)]/60 p-3">
      <div className="caps mb-2 text-[11px]" title="Laws a correct stand cannot break, checked every tick (feedtwin.session.watch). One row per episode.">
        Flags
      </div>
      <div className="flex flex-col gap-1 font-mono text-[12px]">
        {[...flags].reverse().map((f) => (
          <div key={`${f.check}-${f.subject}-${f.started}`} className="flex items-baseline gap-3" title={f.detail}>
            <span className="w-[9.5rem] shrink-0 tabular-nums text-[var(--ink-2)]">
              {fixed(f.started, 1)}–{f.open ? 'now' : `${fixed(f.last, 1)} s`}
            </span>
            <span className={f.open ? 'text-[var(--bad)]' : 'text-[var(--warn)]/80'}>{f.title}</span>
            <span className="truncate text-[var(--ink-2)]">{f.subject}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Downloads everything needed to run this stand again elsewhere. Out of the
 *  way on purpose: it is for sending a problem to whoever fixes the twin. */
function ExportRepro({ id }: { id: string }) {
  const [note, setNote] = useState('');
  const save = () => {
    setNote('…');
    sessionRepro(id)
      .then((repro) => {
        const opened = (repro.opened ?? {}) as { drawing_name?: string };
        const end = (repro.end ?? {}) as { t?: number };
        const name = `repro-${(opened.drawing_name || 'stand').replace(/[^\w.-]+/g, '_')}-t${Math.round(end.t ?? 0)}s.json`;
        const url = URL.createObjectURL(new Blob([JSON.stringify(repro)], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
        setNote('');
      })
      .catch((e) => setNote(e instanceof Error ? e.message : String(e)));
  };
  return (
    <div className="flex justify-end gap-2 pt-2 text-[10.5px] text-gray-600">
      {note && <span>{note}</span>}
      <button
        type="button"
        onClick={save}
        className="hover:text-[var(--ink-2)]"
        title="Download this stand's drawing, setup, hookup and every command, to send with a problem. scripts/replay_repro.py plays it."
      >
        export repro
      </button>
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
        {flat && <span className="font-mono text-[11px] text-[var(--ok)]/80">zero throughout</span>}
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
  // Following the newest row, scrolled to a whole row: the header is
  // sticky, and a scroll that stopped mid-row left the top row half under it.
  // The spacer row at the foot gives the last whole-row stop room.
  useEffect(() => {
    const el = box.current;
    if (!el || !following.current) return;
    const rh = (el.querySelector('tbody tr') as HTMLElement | null)?.offsetHeight ?? 0;
    const end = el.scrollHeight - el.clientHeight;
    el.scrollTop = rh > 0 ? Math.max(0, Math.ceil((end - rh) / rh) * rh) : end;
  }, [n, trace]);

  const head = 'px-2 py-1 text-right font-normal';
  const cell = 'px-2 py-0.5 text-right tabular-nums';
  return (
    <section className="bg-card flex min-h-0 min-w-0 flex-col border border-gray-800 p-3" style={{ maxHeight: 430 }}>
      <div className="mb-1 flex items-baseline gap-2">
        <span className="caps text-[11px]">Iteration log</span>
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
          <thead className="sticky top-0 z-[1] bg-[var(--color-bg-secondary)] text-[10px] uppercase tracking-wider text-gray-500">
            <tr>
              <th className={head} title="Stand time [s]">t</th>
              <th className={head} title="Network solves the tick took / Newton steps">solves/steps</th>
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
                <tr key={i} className={ok ? 'text-[var(--ink-2)]' : 'bg-[var(--bad)]/10 text-[var(--bad)]'}>
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
            <tr aria-hidden>
              <td className={cell} colSpan={6}>
                &#160;
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
