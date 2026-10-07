/**
 * The console: the DAQ's unified dashboard, on a simulated stand.
 *
 * Laid out as `daq-server/.../components/dashboard/UnifiedDashboard.tsx`
 * lays it out, because it is the same job and the same people: the pressure
 * bars in the top bar; the pressure history on the left with the DAQ's
 * window buttons; the 4x4 actuator grid and the state machine diagram
 * on the right. What a twin has that a stand does not -- propellant levels,
 * a bottle you can see empty, the engine while it burns -- sits in one row
 * along the top, small; the guide through the sequence along the bottom.
 *
 * Nothing here is set by typing a number. The regulators are knobs on the
 * GSE tab; the model switches are folded away there too.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { channelColor, fixed, type TankState } from '../api';
import ActuatorGrid from '../components/ActuatorGrid';
import { DaqPlot, type Channel } from '../components/DaqPlot';
import PadSequence from '../components/PadSequence';
import StateMachineDiagram from '../components/StateMachineDiagram';
import { useStand } from '../stand';

const WINDOWS = [
  { label: '10s', seconds: 10 },
  { label: '30s', seconds: 30 },
  { label: '60s', seconds: 60 },
  { label: '5min', seconds: 300 },
];

const TANK_COLOUR = (t: TankState) =>
  (t.side ? t.side === 'lox' : /lox|ox/i.test(t.label)) ? 'var(--color-lox)' : 'var(--color-fuel)';

/** A vessel, drawn as the thing it is: a column of liquid, to scale. */
function Vessel({
  label,
  litres,
  pressurePsi,
  fill,
  mass,
  temperature,
  colour,
  gas = false,
  chilling = false,
}: {
  label: string;
  litres?: number;
  pressurePsi: number;
  fill: number;
  mass: number;
  temperature: number;
  colour: string;
  gas?: boolean;
  chilling?: boolean;
}) {
  return (
    <div className="bg-card flex min-w-[150px] flex-1 gap-2.5 rounded-lg border border-gray-800 px-3 py-2">
      <div className="relative h-[54px] w-5 shrink-0 overflow-hidden rounded border border-white/10 bg-black/40">
        <div
          className="absolute bottom-0 w-full transition-[height] duration-200"
          style={{ height: `${Math.min(Math.max(fill, 0), 1) * 100}%`, background: colour, opacity: gas ? 0.5 : 0.8 }}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[10px] font-bold uppercase tracking-wider text-text-muted">
          {label}
          {litres !== undefined && litres > 0 && (
            <span className="ml-1.5 font-normal normal-case tracking-normal text-gray-600">
              {fixed(litres, litres < 10 ? 1 : 0)} L
            </span>
          )}
        </div>
        <div className="font-mono text-lg font-bold leading-tight tabular-nums" style={{ color: colour }}>
          {fixed(pressurePsi, 1)}
          <span className="ml-1 text-[9px] font-normal text-text-muted">PSIG</span>
        </div>
        <div className="font-mono text-[10px] leading-snug tabular-nums text-text-muted">
          {fixed(mass, 2)} kg · {fixed(fill * 100, 0)}% · {fixed(temperature, 0)} K
          {chilling && (
            <span
              className="ml-1 text-sky-400"
              title="The wall is still warm: LOX poured in flashes off and vents, and nothing collects until the metal is at saturation."
            >
              chilling
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function Console() {
  const { model, machine, live, history, burns, hidden, go, toggleValve, release, setup } = useStand();
  const [window, setWindow] = useState(60);

  const plot = useMemo(() => {
    if (!history) return { times: [] as number[], channels: [] as Channel[] };
    const cutoff = (history.times_s[history.times_s.length - 1] ?? 0) - window;
    const from = history.times_s.findIndex((t) => t >= cutoff);
    const start = from < 0 ? 0 : from;
    return {
      times: history.times_s.slice(start),
      channels: history.channels
        .filter((c) => (c.unit || 'psig') === 'psig' && !hidden[c.id])
        .map((c): Channel => ({
          key: c.id,
          tag: c.tag,
          values: c.values.slice(start),
          color: channelColor(c.tag),
        })),
    };
  }, [history, hidden, window]);

  if (!model || !live) {
    return <p className="p-6 text-sm text-text-muted">Bringing the stand up…</p>;
  }
  const engine = live.engine;
  const lit = engine !== null && engine.chamber_psi > 5;
  const attached = Object.keys(model.engine).length > 0;
  const simplified = model.engine.engine_model === 'simplified';
  const lastBurn = burns?.burns.length ? burns.burns[burns.burns.length - 1] : null;
  const locked = Boolean(live.tripped);

  return (
    <div className="flex min-h-full flex-col gap-2 p-3">
      {/* The pressures are the bars in the top bar, as on the DAQ. What the
          DAQ cannot show -- how full the tanks are, how much gas is left, the
          engine while it burns -- goes first, where the eye lands. */}
      <div className="flex flex-shrink-0 flex-wrap items-stretch gap-2">
        {live.tanks.map((t) => (
          <Vessel
            key={t.id}
            label={t.label}
            litres={t.volume_L}
            pressurePsi={t.pressure_psi}
            fill={t.fill_fraction}
            mass={t.liquid_mass_kg}
            // Until liquid collects, what there is to watch is the metal.
            temperature={
              t.liquid_mass_kg > 0.001 || t.wall_temperature_K === undefined
                ? t.liquid_temperature_K
                : t.wall_temperature_K
            }
            chilling={t.chilling}
            colour={TANK_COLOUR(t)}
          />
        ))}
        {live.bottles.map((b) => (
          <Vessel
            key={b.id}
            label={b.label}
            litres={b.volume_L}
            pressurePsi={b.pressure_psi}
            fill={b.fill_fraction}
            mass={b.liquid_mass_kg}
            temperature={b.ullage_temperature_K}
            colour="var(--color-gn2)"
            gas
          />
        ))}
        {engine && lit && (
          <div className="bg-card flex min-w-[260px] flex-[1.4] items-center gap-4 rounded-lg border border-red-900/60 px-3 py-2">
            <span className="h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-red-500" />
            {(
              [
                ['Chamber', engine.chamber_psi, 'psig', '#F39C12', 0],
                ['Thrust', engine.thrust_N, 'N', '#e2e2e2', 0],
                ['O/F', engine.mixture_ratio, '', '#9B59B6', 2],
                ['Isp', engine.isp_s, 's', '#27AE60', 0],
              ] as const
            ).map(([label, value, unit, color, places]) => (
              <div key={label} className="min-w-0">
                <div className="text-[9px] font-semibold uppercase tracking-wider text-text-muted">{label}</div>
                <div className="font-mono text-base font-bold tabular-nums leading-tight" style={{ color }}>
                  {fixed(value, places)}
                  {unit && <span className="ml-1 text-[9px] font-normal text-text-muted">{unit}</span>}
                </div>
              </div>
            ))}
            {simplified && (
              <span
                className="ml-auto self-start rounded bg-amber-900/50 px-1.5 py-0.5 text-[9px] font-semibold text-amber-300"
                title="feedtwin's simplified engine, not EngineDesign's: no engine card. Build one in Library."
              >
                simplified
              </span>
            )}
          </div>
        )}
        {!lit && lastBurn && !lastBurn.burning && (
          <Link
            to="/engine"
            title="The last burn, totalled. Open the Engine page for the traces."
            className="bg-card flex min-w-[260px] flex-[1.4] items-center gap-4 rounded-lg border border-gray-800 px-3 py-2 hover:border-gray-600"
          >
            <span className="text-[9px] font-semibold uppercase tracking-wider text-text-muted">Last burn</span>
            {(
              [
                ['Impulse', lastBurn.impulse_Ns, 'N·s', '#e2e2e2', 0],
                ['Thrust', lastBurn.thrust_mean_N, 'N', '#e2e2e2', 0],
                ['Burn', lastBurn.duration_s, 's', '#e2e2e2', 2],
                ['O/F', lastBurn.of_mean, '', '#9B59B6', 2],
                ['Isp', lastBurn.isp_s, 's', '#27AE60', 0],
              ] as const
            ).map(([label, value, unit, color, places]) => (
              <div key={label} className="min-w-0">
                <div className="text-[9px] font-semibold uppercase tracking-wider text-text-muted">{label}</div>
                <div className="font-mono text-sm font-bold tabular-nums leading-tight" style={{ color }}>
                  {fixed(value, places)}
                  {unit && <span className="ml-1 text-[9px] font-normal text-text-muted">{unit}</span>}
                </div>
              </div>
            ))}
          </Link>
        )}
        {!attached && (
          <Link
            to="/library"
            title="Without an engine the chamber is a fixed pressure: nothing burns, so there is no thrust to report. Pick an engine in Library."
            className="bg-card flex items-center rounded-lg border border-dashed border-gray-700 px-3 py-2 text-[11px] text-text-muted hover:border-gray-500"
          >
            No engine on this stand
          </Link>
        )}
      </div>

      {/* The DAQ assumes a control-room monitor. On anything smaller the page
          scrolls rather than crushing the plot and the diagram. */}
      <div className="flex min-h-[400px] flex-1 gap-3">
        <section className="bg-card flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-gray-800 p-3">
          <div className="mb-2 flex flex-shrink-0 items-center justify-between">
            <h2 className="text-[11px] font-bold uppercase tracking-widest text-text-muted">Pressure history</h2>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-medium text-text-muted">Window:</span>
              {WINDOWS.map((w) => (
                <button
                  key={w.label}
                  type="button"
                  onClick={() => setWindow(w.seconds)}
                  className={`rounded px-2 py-0.5 text-[11px] font-semibold transition-all ${
                    window === w.seconds
                      ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/30'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-300'
                  }`}
                >
                  {w.label}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {plot.times.length > 1 ? (
              <DaqPlot times={plot.times} channels={plot.channels} yLabel="Pressure (psig)" fill />
            ) : (
              <p className="p-4 text-[12px] text-text-muted">Waiting for the first samples…</p>
            )}
          </div>
        </section>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          <section className="bg-card flex-shrink-0 rounded-xl border border-gray-800 p-2">
            <ActuatorGrid
              model={model}
              machine={machine}
              live={live}
              locked={locked}
              onSet={(id, want) => {
                if (want !== (live.open[id] ?? false)) toggleValve(id);
              }}
              onRelease={release}
            />
          </section>
          <section className="bg-card min-h-[260px] flex-1 overflow-hidden rounded-xl border border-gray-800 p-2">
            {machine ? (
              <StateMachineDiagram machine={machine} live={live} go={go} locked={locked} />
            ) : (
              <p className="p-4 text-[12px] text-text-muted">No state machine bound.</p>
            )}
          </section>
        </div>
      </div>

      {machine && (
        <div className="flex-shrink-0">
          <PadSequence live={live} machine={machine} setup={setup} go={go} hasEngine={engine !== null} compact />
        </div>
      )}

      {(live.notes.length > 0 || (machine?.warnings.length ?? 0) > 0) && (
        <div className="max-h-16 flex-shrink-0 overflow-auto">
          {live.notes.map((n) => (
            <p key={n} className="text-[11px] leading-snug text-amber-300">
              {n}
            </p>
          ))}
          {(machine?.warnings ?? []).map((w) => (
            <p key={w} className="text-[10px] leading-snug text-amber-300/60">
              {w}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
