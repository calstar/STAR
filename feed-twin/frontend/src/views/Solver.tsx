/**
 * The solver: residuals, continuity, chamber closure and the mass balance,
 * tick by tick -- what a CFD code shows beside every answer.
 *
 * A run that converges and plots smoothly is not evidence by itself
 * (docs/PHYSICS-BENCHMARK.md). This page is how a person checks the
 * arithmetic under a trace before believing it: did every solve converge, how
 * far from balanced did it stop, and did the stand keep its mass.
 */

import { useEffect, useMemo, useState } from 'react';
import { fixed, sessionSolver, type SolverTrace } from '../api';
import { DaqPlot, fmtReading, type Channel } from '../components/DaqPlot';
import { useStand } from '../stand';

/** Guards correcting more than this, per million of throughput, read amber. */
const GUARD_PPM_OK = 1000;

/** Continuity below this [kg/s] is rounding on a converged solve. */
const CONTINUITY_FLOOR = 1e-12;

/** Plot height inside each panel [px]; the panel grows to fit it and its pills. */
const PLOT_HEIGHT = 230;

/** Mass kept to this many parts per million of throughput reads as kept. */
const MASS_PPM_OK = 10;

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

  const panels = useMemo(() => {
    if (!trace || trace.t.length < 2) return [];
    const line = (key: string, tag: string, values: number[], color: string): Channel => ({ key, tag, values, color });
    return [
      {
        title: 'Newton residual (scaled)',
        hint: 'Worst scaled residual norm of the network solves in each tick. Each solve stops below the network tolerance.',
        log: true,
        minSpan: 1e-9,
        channels: [line('residual', 'residual', trace.residual, '#F39C12')],
      },
      {
        title: 'Iterations',
        hint: 'Newton iterations summed over the tick, and the most any one solve took. Couplings: network solves per tick.',
        log: false,
        minSpan: 5,
        channels: [
          line('iterations', 'iterations', trace.iterations, '#3498DB'),
          line('max', 'worst solve', trace.iterations_max, '#9B59B6'),
          line('couplings', 'couplings', trace.couplings, '#94A3B8'),
        ],
      },
      {
        title: 'Continuity (kg/s)',
        hint: 'Worst net mass imbalance at any free node of the network: the solve’s own conservation.',
        log: true,
        minSpan: 1e-12,
        // Below 1e-12 kg/s is double-precision rounding on a converged
        // solve, not imbalance; drawn as the zero it is.
        channels: [
          line(
            'continuity',
            'continuity',
            trace.continuity.map((v) => (v < CONTINUITY_FLOOR ? 0 : v)),
            '#27AE60',
          ),
        ],
      },
      {
        title: 'Chamber closure (psi)',
        hint: '|g(p) − p| the chamber root-solve left: how far the flow the network delivers and the chamber pressure it makes still disagree.',
        log: true,
        minSpan: 1e-6,
        channels: [line('chamber', 'chamber', trace.chamber_residual_psi, '#EC4899')],
      },
      {
        title: 'Mass balance (kg, cumulative)',
        hint: 'Unexplained: mass no vessel booked and no boundary carried -- a leak in the model; it should sit at zero. Guards: what the vessels’ floors and clamps added or removed, booked so they can be told from a leak. Both restart from zero when the stand is put somewhere directly (Jump to T-0, a rewind), since nothing crossed the boundary to get it there.',
        log: false,
        minSpan: 1e-9,
        channels: [
          line(
            'unexplained',
            'unexplained',
            trace.mass_error_kg.map((e, i) => e - (trace.guard_kg[i] ?? 0)),
            '#EF4444',
          ),
          line('guard_kg', 'guards', trace.guard_kg, '#F59E0B'),
        ],
      },
      {
        title: 'Guard energy (J, cumulative)',
        hint: 'Ullage energy the vessels’ guards added or removed beyond what their rates said.',
        log: false,
        minSpan: 1e-6,
        channels: [line('guard_J', 'guards', trace.guard_J, '#F59E0B')],
      },
    ];
  }, [trace]);

  if (error) return <p className="p-6 text-sm text-red-400">{error}</p>;
  if (!trace) return <p className="p-6 text-sm text-text-muted">Reading the solver…</p>;

  const s = trace.summary;
  const unexplainedPpm = s.unexplained_ppm ?? s.mass_error_ppm ?? 0;
  const kept = Math.abs(unexplainedPpm) <= MASS_PPM_OK;
  const clean = (s.unconverged ?? 0) === 0;

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="bg-card flex flex-wrap items-center gap-x-8 gap-y-2 rounded-lg border border-gray-800 px-4 py-3">
        <Stat
          label="Converged"
          value={clean ? 'every tick' : `${fixed(s.unconverged, 0)} of ${fixed(s.ticks, 0)} ticks failed`}
          good={clean}
          hint="A tick that did not converge holds the last good flows; its frame is an extrapolation."
        />
        <Stat
          label="Unexplained mass"
          value={`${fixed(unexplainedPpm, 2)} ppm`}
          good={kept}
          hint={`Mass no vessel booked and no boundary carried: ${(s.unexplained_kg ?? 0).toExponential(2)} kg against ${fixed(s.throughput_kg ?? 0, 3)} kg through the boundary. Under ${MASS_PPM_OK} ppm reads as kept; anything more is a leak in the model.`}
        />
        <Stat label="Worst residual" value={(s.worst_residual ?? 0).toExponential(1)} hint="Scaled; the network tolerance is what a solve stops under." />
        <Stat label="Worst continuity" value={`${(s.worst_continuity ?? 0).toExponential(1)} kg/s`} />
        <Stat label="Worst chamber closure" value={`${(s.worst_chamber_psi ?? 0).toExponential(1)} psi`} />
        <Stat
          label="Guards"
          value={`${fmtReading(s.guard_kg ?? 0)} kg (${fixed(s.guard_ppm ?? 0, 0)} ppm) · ${fmtReading(s.guard_J ?? 0)} J`}
          good={Math.abs(s.guard_ppm ?? 0) <= GUARD_PPM_OK ? undefined : false}
          hint={`What the vessels' floors and clamps changed, booked so the balance can tell them from a leak. Each is physics (a vent cannot pull below atmosphere), but over ${GUARD_PPM_OK} ppm of throughput they are doing a model's work, and that is worth a look.`}
        />
      </div>
      {panels.length === 0 ? (
        <p className="text-sm text-text-muted">The record starts with the stand's first ticks.</p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {panels.map((p) => (
            <div key={p.title} className="bg-card relative min-w-0 overflow-hidden rounded-lg border border-gray-800 p-3" title={p.hint}>
              <div className="mb-1 flex items-baseline gap-2">
                <span className="caps text-[11px]">{p.title}</span>
                {/* An all-zero trace is a result, not a missing plot: say so in
                    the title, where it cannot sit on the axis. */}
                {p.channels.every((c) => c.values.every((v) => v === 0)) && (
                  <span className="font-mono text-[11px] text-emerald-300/80">zero on every tick</span>
                )}
              </div>
              <DaqPlot
                times={trace.t}
                channels={p.channels}
                yLabel=""
                height={PLOT_HEIGHT}
                minSpan={p.minSpan}
                initialLog={p.log}
                allowLog
                lineWidth={1.5}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, good, hint }: { label: string; value: string; good?: boolean; hint?: string }) {
  return (
    <div title={hint}>
      <div className="caps text-[10px]">{label}</div>
      <div
        className={`font-mono text-[14px] tabular-nums ${
          good === undefined ? 'text-text' : good ? 'text-emerald-300' : 'text-amber-300'
        }`}
      >
        {value}
      </div>
    </div>
  );
}
