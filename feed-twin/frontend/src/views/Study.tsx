/**
 * The COPV study, on a button.
 *
 * This ran for a week as a scratchpad script and it decided a piece of
 * hardware — so it is a view now, because a number worth quoting six months
 * later has to be reproducible by pressing a button rather than by finding the
 * right file in /tmp.
 *
 * It is the one view that is not live. A burn resolved honestly costs about a
 * minute of wall clock per case (see `backend/study.py` for why), so the run
 * happens on a worker and this polls it. The trade is stated rather than
 * hidden: you wait, and in exchange the traces have no numerical noise in them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cancelStudy,
  getStudy,
  startStudy,
  type StudyState,
  type StudyTrace,
} from '../api';
import { StudyChart, type Series } from '../components/StudyChart';

/** Gas colours, carried everywhere: the pills, the plots, the table.
 *
 *  Green and purple rather than the obvious green/amber — the pair was checked
 *  for colour-vision separation (ΔE 19 under deuteranopia, 32 normal) because
 *  GN2-against-helium *is* the comparison this view exists to make, and a
 *  reader who cannot tell the two traces apart has no view at all.
 *
 *  One hue per gas, and the *tank* is carried by line style — solid ox, dashed
 *  fuel. A lighter tint of the same hue was the earlier answer and it was the
 *  wrong one: four tints of two hues is four things to tell apart at a glance,
 *  where two hues and two line styles is two. It also means nothing here is
 *  identified by colour alone. */
const GAS = {
  gn2: { label: 'GN2', hue: '#27AE60' },
  he: { label: 'Helium', hue: '#9B59B6' },
} as const;

type GasKey = keyof typeof GAS;

const isGas = (k: string): k is GasKey => k === 'gn2' || k === 'he';

/** Samples whose solve did not converge are dropped, not drawn.
 *
 *  A tick that failed is not a measurement of anything, and a single spurious
 *  dip is enough to make a reader mistrust a plot that is otherwise exact. */
function clean(trace: StudyTrace, field: 'ox_psi' | 'fuel_psi' | 'copv_psi' | 'chamber_psi') {
  const t: number[] = [];
  const v: number[] = [];
  trace.t.forEach((when, i) => {
    if (!trace.converged[i]) return;
    t.push(when);
    v.push(trace[field][i]);
  });
  return { t, v };
}

function Check({
  on,
  onChange,
  label,
  hint,
  accent,
  disabled,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  accent?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      title={hint}
      className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-[13px] font-semibold transition-colors ${
        on
          ? 'border-white/15 bg-white/10 text-white'
          : 'border-white/5 bg-black/20 text-gray-500 hover:text-gray-300'
      } ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
    >
      <span
        aria-hidden
        className={`grid h-3.5 w-3.5 flex-shrink-0 place-items-center rounded-[3px] border ${
          on ? 'border-transparent' : 'border-gray-600'
        }`}
        style={{ background: on ? (accent ?? '#3498DB') : 'transparent' }}
      >
        {on && (
          <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" fill="none" stroke="#0d0d12" strokeWidth="2">
            <path d="M1.5 5.2 4 7.6 8.6 2.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      {label}
    </button>
  );
}

export function Study() {
  const [gases, setGases] = useState<Record<GasKey, boolean>>({ gn2: true, he: true });
  const [bigger, setBigger] = useState(false);
  const [collapse, setCollapse] = useState(false);
  const [sweep, setSweep] = useState(false);
  const [vapour, setVapour] = useState(false);
  const [chilldown, setChilldown] = useState(false);
  const [lineWalls, setLineWalls] = useState(false);
  const [study, setStudy] = useState<StudyState | null>(null);
  const [error, setError] = useState('');
  const timer = useRef(0);

  const poll = useCallback(async () => {
    try {
      setStudy(await getStudy());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void poll();
  }, [poll]);

  // Poll only while something is in flight; a finished study is static.
  useEffect(() => {
    if (!study?.running) return undefined;
    timer.current = window.setInterval(() => void poll(), 700);
    return () => window.clearInterval(timer.current);
  }, [study?.running, poll]);

  const chosen = (Object.keys(gases) as GasKey[]).filter((g) => gases[g]);

  const run = async () => {
    try {
      setError('');
      setStudy(
        await startStudy({
          gases: chosen,
          bigger,
          collapse,
          sweep,
          vapour,
          // A bare stainless tank in film boiling is 50-200 W/(m^2.K). The
          // checkbox picks the low end deliberately: it is the conservative
          // member of the range, and naming the number in the label beats a
          // tick box that silently means something.
          chilldown: chilldown ? 50 : 0,
          line_walls: lineWalls,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const stop = async () => {
    try {
      setStudy(await cancelStudy());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const running = study?.running ?? false;
  const traces = study?.traces ?? [];
  const shown = useMemo(
    () => traces.filter((t) => isGas(t.gas) && gases[t.gas as GasKey]),
    [traces, gases],
  );
  const asBuilt = shown.filter((t) => t.key.endsWith('_asbuilt'));
  const others = shown.filter((t) => !t.key.endsWith('_asbuilt'));

  /** Tank pressure: ox and fuel, per gas, on the as-built bottle. */
  const tank = useMemo<Series[]>(
    () =>
      asBuilt.flatMap((t) => {
        const g = GAS[t.gas as GasKey];
        const ox = clean(t, 'ox_psi');
        const fuel = clean(t, 'fuel_psi');
        return [
          { key: `${t.key}-ox`, label: `${g.label} ox`, color: g.hue, ...ox },
          { key: `${t.key}-fu`, label: `${g.label} fuel`, color: g.hue, dashed: true, ...fuel },
        ];
      }),
    [asBuilt],
  );

  const copv = useMemo<Series[]>(
    () =>
      asBuilt.map((t) => ({
        key: `${t.key}-copv`,
        label: GAS[t.gas as GasKey].label,
        color: GAS[t.gas as GasKey].hue,
        ...clean(t, 'copv_psi'),
      })),
    [asBuilt],
  );

  const chamber = useMemo<Series[]>(
    () =>
      asBuilt.map((t) => ({
        key: `${t.key}-pc`,
        label: GAS[t.gas as GasKey].label,
        color: GAS[t.gas as GasKey].hue,
        ...clean(t, 'chamber_psi'),
      })),
    [asBuilt],
  );

  /** The other bottles, tank pressure only, so the comparison is one line each. */
  const compare = useMemo<Series[]>(
    () =>
      others.map((t) => ({
        key: `${t.key}-ox`,
        label: t.label,
        color: GAS[t.gas as GasKey].hue,
        dashed: t.collapse,
        ...clean(t, 'ox_psi'),
      })),
    [others],
  );

  /** Floor against bottle volume — the sizing curve. */
  const sizing = useMemo<Series[]>(() => {
    const points = (study?.sweep ?? []).filter((p) => isGas(p.gas) && gases[p.gas as GasKey]);
    const byGas = new Map<GasKey, { t: number[]; v: number[] }>();
    for (const p of points) {
      const g = p.gas as GasKey;
      if (!byGas.has(g)) byGas.set(g, { t: [], v: [] });
      byGas.get(g)!.t.push(p.cubic_inches);
      byGas.get(g)!.v.push(p.floor_psi);
    }
    return [...byGas.entries()].map(([g, s]) => ({
      key: `sweep-${g}`,
      label: GAS[g].label,
      color: GAS[g].hue,
      ...s,
    }));
  }, [study?.sweep, gases]);

  const summary = asBuilt.map((t) => {
    const good = t.ox_psi.filter((_, i) => t.converged[i] && t.t[i] > 0.3);
    const start = t.ox_psi[0];
    const step = Math.min(...t.ox_psi.filter((_, i) => t.t[i] > 0 && t.t[i] < 0.25 && t.converged[i]));
    return {
      gas: t.gas as GasKey,
      start,
      step: start - step,
      floor: Math.min(...good),
      peak: Math.max(...good),
      end: t.ox_psi[t.ox_psi.length - 1],
      burn: t.depleted_s,
      copvLeft: t.copv_psi[t.copv_psi.length - 1],
    };
  });

  return (
    // The one view that produces a *document* rather than a live reading, so it
    // gets document treatment: a ground that falls away at the edges, glass
    // cards, and a column narrow enough to read. The live views stay identical
    // to the DAQ on purpose (see index.css) -- this one is what gets exported,
    // screenshotted and put in front of a review, and it should look it.
    <div
      className="flex flex-col gap-6 px-4 py-7"
      style={{
        background:
          'radial-gradient(ellipse 900px 520px at 50% -8%, #1e1e28 0%, #171720 38%, var(--background) 78%)',
        minHeight: '100%',
      }}
    >
      <header>
        <h2 className="text-lg font-semibold text-white">COPV sizing study</h2>
        <p className="mt-1 max-w-[86ch] text-[13px] leading-relaxed text-gray-400">
          Can the pressurant bottle hold the tanks at their regulated pressure for a whole burn, and
          does the answer differ between nitrogen and helium? Runs the real study drawings, primed to
          T&#8209;0, and burns.{' '}
          {study && study.bottle_litres > 0 && (
            <span className="text-gray-300">
              Bottle: {study.bottle_litres} L / {study.bottle_cubic_inches} in³.
            </span>
          )}
        </p>
      </header>

      <section className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-gray-800 bg-card px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Gas</span>
          <Check on={gases.gn2} onChange={(v) => setGases((g) => ({ ...g, gn2: v }))} label="GN2" accent={GAS.gn2.hue} />
          <Check on={gases.he} onChange={(v) => setGases((g) => ({ ...g, he: v }))} label="Helium" accent={GAS.he.hue} />
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Also</span>
          <Check
            on={bigger}
            onChange={setBigger}
            label="8 L bottle"
            hint="A bottle well past the knee, to show the as-built one already is"
            disabled={running}
          />
          <Check
            on={collapse}
            onChange={setCollapse}
            label="Ullage collapse"
            hint="Transient conduction into the cold liquid. A lower bound — condensation is not modelled"
            disabled={running}
          />
          <Check
            on={sweep}
            onChange={setSweep}
            label="Volume sweep"
            hint="Five more bottles per gas. Slow — this is the one that takes ten minutes"
            disabled={running}
          />
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            Thermal
          </span>
          <Check
            on={vapour}
            onChange={setVapour}
            label="Ullage vapour"
            hint="Propellant boils into the ullage and carries its own partial pressure. Changes the shape of a cryogenic vent; negligible for a storable. Off by default — it is the more fragile model"
            disabled={running}
          />
          <Check
            on={lineWalls}
            onChange={setLineWalls}
            label="Line walls"
            hint="The tube and its fittings give the gas their own heat on the way past. Worth ~50 psi of tank pressure late in a nitrogen burn, and a much fuller bottle on either gas. Needs wall thickness and fitting mass on the drawing"
            disabled={running}
          />
          <Check
            on={chilldown}
            onChange={setChilldown}
            label="Chilldown 50 W/m²K"
            hint="The wetted face of the tank wall. A warm wall dumps heat into the liquid, which with ullage vapour on is what boils a cryogen off during a load"
            disabled={running}
          />
        </div>

        <div className="ml-auto flex items-center gap-3">
          {running ? (
            <>
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-yellow-500" />
                <span className="text-[13px] font-semibold text-gray-300">
                  {study?.stage || 'running'} · {Math.round((study?.progress ?? 0) * 100)}%
                </span>
              </div>
              <div className="h-1.5 w-40 overflow-hidden rounded-full bg-black/40">
                <div
                  className="h-full rounded-full bg-yellow-500 transition-[width] duration-500"
                  style={{ width: `${Math.round((study?.progress ?? 0) * 100)}%` }}
                />
              </div>
              <button
                type="button"
                onClick={() => void stop()}
                className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-1.5 text-[13px] font-semibold text-red-300 hover:bg-red-950/70"
              >
                Stop
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void run()}
              disabled={!chosen.length}
              className="rounded-md bg-blue-600 px-5 py-2 text-[13px] font-bold uppercase tracking-wide text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Run study
            </button>
          )}
        </div>

        <p className="w-full text-[12px] text-gray-500">
          About a minute of compute per case
          {chosen.length > 0 && (
            <>
              {' '}— this run is{' '}
              <span className="text-gray-300">
                {chosen.length * (1 + (bigger ? 1 : 0) + (collapse ? 1 : 0) + (sweep ? 5 : 0))} case
                {chosen.length * (1 + (bigger ? 1 : 0) + (collapse ? 1 : 0) + (sweep ? 5 : 0)) === 1 ? '' : 's'}
              </span>
            </>
          )}
          . The coupling steps below the regulator–ullage time constant, which is what keeps the
          traces free of tick-rate noise and what makes it slow.
        </p>
      </section>

      {(error || study?.error) && (
        <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-2 text-[13px] text-red-300">
          {error || study?.error}
        </p>
      )}

      {study?.notes?.map((n) => (
        <p key={n} className="rounded-lg border border-amber-900/50 bg-amber-950/30 px-4 py-2 text-[13px] text-amber-300">
          {n}
        </p>
      ))}

      {!traces.length && !running && (
        <p className="rounded-lg border border-dashed border-gray-800 px-4 py-10 text-center text-[13px] text-gray-500">
          No run yet. Pick the gases and press Run study.
        </p>
      )}

      {summary.length > 0 && (
        <section className="overflow-x-auto rounded-lg border border-gray-800 bg-card">
          <table className="w-full text-[13px] tabular-nums">
            <thead>
              <tr className="border-b border-gray-800 text-left text-[11px] uppercase tracking-wider text-gray-500">
                <th className="px-4 py-2 font-semibold">As built</th>
                <th className="px-4 py-2 text-right font-semibold">Lockup</th>
                <th className="px-4 py-2 text-right font-semibold">Ignition step</th>
                <th className="px-4 py-2 text-right font-semibold">Floor</th>
                <th className="px-4 py-2 text-right font-semibold">Peak</th>
                <th className="px-4 py-2 text-right font-semibold">At depletion</th>
                <th className="px-4 py-2 text-right font-semibold">Burn</th>
                <th className="px-4 py-2 text-right font-semibold">COPV left</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((r) => (
                <tr key={r.gas} className="border-b border-white/5 last:border-0">
                  <td className="px-4 py-2 font-semibold" style={{ color: GAS[r.gas].hue }}>
                    {GAS[r.gas].label}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-300">{r.start.toFixed(0)} psig</td>
                  <td className="px-4 py-2 text-right text-gray-300">−{r.step.toFixed(0)} psig</td>
                  <td className="px-4 py-2 text-right text-gray-300">{r.floor.toFixed(0)} psig</td>
                  <td className="px-4 py-2 text-right text-gray-300">{r.peak.toFixed(0)} psig</td>
                  <td className="px-4 py-2 text-right text-gray-300">{r.end.toFixed(0)} psig</td>
                  <td className="px-4 py-2 text-right text-gray-300">{r.burn ? `${r.burn} s` : '—'}</td>
                  <td className="px-4 py-2 text-right text-gray-300">{r.copvLeft.toFixed(0)} psig</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <StudyChart
        title="Tank pressure"
        caption="Half a second of mains-shut hold first, so the ignition step has a datum. The tanks sit at lockup; the mains crack and pressure steps down as regulator droop and press-line loss appear together; then it climbs as the bottle decays and the regulator's supply-pressure effect lifts the dome with it."
        series={tank}
        yLabel="tank psig"
        rules={[
          { y: 550, label: '550 psig lockup' },
          { x: 0, label: 'mains open' },
        ]}
      />

      <StudyChart
        title="COPV blowdown"
        caption="What is left in the bottle. Both gases hold the same number of moles at 4500 psi within half a percent, so this is a picture of demand, not of capacity."
        series={copv}
        yLabel="bottle psig"
        area
      />

      <StudyChart
        title="Chamber pressure"
        caption="What the tank pressure buys. Zero during the mains-shut lead-in, then the burn."
        series={chamber}
        yLabel="chamber psig"
        area
      />

      {compare.length > 0 && (
        <StudyChart
          title="Other bottles and options"
          caption="LOX tank pressure only, one line per case, so the comparison against the as-built run above is a single trace each."
          series={compare}
          yLabel="psig"
        />
      )}

      {sizing.length > 0 && (
        <StudyChart
          title="Bottle size against the floor it holds"
          caption="Lowest tank pressure once the ignition transient has settled, against COPV volume at a fixed 4500 psi charge. The as-built cylinder is included at its real volume, so the knee can be read against the hardware rather than interpolated to it."
          series={sizing}
          yLabel="psig"
          xLabel="COPV volume (in³)"
        />
      )}
    </div>
  );
}
