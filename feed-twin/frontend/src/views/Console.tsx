/**
 * The console: the stand, run from one screen.
 *
 * Above the fold, sized to the window and nothing else. A short strip along
 * the top, as the DAQ's top bar is: the transducers as bars, the vessels in
 * brief, and the Command stack (FIRE, the abort, pause, reset, T-0). Under
 * it, the room goes to what an operator watches: the live pressure plot, and
 * the valves with the state machine beneath them. The pad sequence runs along
 * the bottom edge.
 *
 * Below the fold, for when you want it: the engine -- live while it burns,
 * the last burn totalled after -- and the stand's notes.
 *
 * Colour is identity. A pressure bar fills in its channel's trace colour, so
 * the bar and its line on the plot are one thing; a vessel wears its fluid's.
 * Amber and red still mean past NOP and past MEOP, and nothing else is either.
 *
 * Nothing here is set by typing a number. The regulators are knobs on the
 * GSE tab; the model switches are on Configuration.
 *
 * A big stand overfills the strip, so Pressure, Tanks and Actuators each have
 * a ⋯ that hides what is not being watched (lib/shown.ts). A hidden
 * transducer leaves the plot too, and comes back by itself past NOP.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { channelColor, fixed, limitsFor, type Burn, type EngineState, type TankState } from '../api';
import ActuatorGrid from '../components/ActuatorGrid';
import { DaqPlot, type Channel } from '../components/DaqPlot';
import PadSequence from '../components/PadSequence';
import PanelMenu from '../components/PanelMenu';
import PressureBar from '../components/PressureBar';
import StateMachineDiagram, { OFF_GRID } from '../components/StateMachineDiagram';
import { useStand } from '../stand';
import { groupByPage } from '../lib/pages';
import { NONE, readHidden, setAll, toggle, visible, writeHidden, type Hidden, type Panel } from '../lib/shown';

const WINDOWS = [
  { label: '10s', seconds: 10 },
  { label: '30s', seconds: 30 },
  { label: '60s', seconds: 60 },
  { label: '5min', seconds: 300 },
];

/** A vessel's colour: the trace colour of the channels on its leg, so the
 *  tank, its bars and its lines on the plot agree. */
const LOX = channelColor('PT-OX-UP');
const FUEL = channelColor('PT-FU-UP');
const GN2 = channelColor('PT-GN2-HI');
const tankColour = (t: TankState) =>
  (t.side ? t.side === 'lox' : /lox|ox/i.test(t.label)) ? LOX : FUEL;

/** A vessel, in one compact block: name and size, pressure, a thin fill bar,
 *  and what it holds. Small on purpose -- the plot gets the room. */
function Vessel({
  label,
  litres,
  pressurePsi,
  fill,
  mass,
  temperature,
  colour,
  chilling = false,
  onSkipChill,
}: {
  label: string;
  litres?: number;
  pressurePsi: number;
  fill: number;
  mass: number;
  temperature: number;
  colour: string;
  chilling?: boolean;
  /** Skip the load's chilldown: the wall goes where it would end up. */
  onSkipChill?: () => void;
}) {
  const pct = Math.min(Math.max(fill, 0), 1) * 100;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="h-2 w-2 flex-shrink-0" style={{ background: colour }} />
          <span className="truncate font-mono text-[12px] font-semibold uppercase tracking-[0.1em] text-[var(--ink)]">
            {label}
          </span>
        </span>
        <span className="flex-shrink-0 font-mono">
          <span className="text-[17px] leading-none tabular-nums" style={{ color: colour }}>
            {fixed(pressurePsi, 1)}
          </span>
          <span className="ml-1 text-[10px] uppercase text-[var(--ink-3)]">psig</span>
        </span>
      </div>
      <div
        className="relative mt-1.5 h-1 overflow-hidden"
        style={{ background: `${colour}26` }}
        title={`${fixed(fill * 100, 1)}% full`}
      >
        <div
          className="absolute inset-y-0 left-0 transition-[width] duration-200"
          style={{ width: `${pct}%`, background: colour }}
        />
      </div>
      <div className="mt-1 truncate font-mono text-[11px] tabular-nums text-[var(--ink-3)]">
        {litres !== undefined && litres > 0 && `${fixed(litres, litres < 10 ? 1 : 0)} L · `}
        {fixed(mass, 2)} kg · {fixed(fill * 100, 0)}% · {fixed(temperature, 0)} K
      </div>
      {/* A line of its own: the one above truncates in a narrow column. */}
      {chilling && (
        <div className="mt-0.5 flex items-baseline gap-2 font-mono text-[11px] uppercase tracking-[0.1em]">
          <span
            style={{ color: colour }}
            title="The wall is still warm: LOX poured in flashes off and vents, and nothing collects until the metal is at saturation."
          >
            chilling
          </span>
          {onSkipChill && (
            <button
              type="button"
              onClick={onSkipChill}
              className="uppercase tracking-[0.1em] text-[var(--ink-2)] underline decoration-dotted underline-offset-2 hover:text-[var(--ink)]"
              title="Skip the chilldown: put the wall where the chill leaves it (saturation at atmosphere) and let the pour collect from now. On the stand it takes ~10 minutes."
            >
              skip
            </button>
          )}
        </div>
      )}
    </div>
  );
}

type Reading = readonly [label: string, value: number, unit: string, places: number, colour?: string];

/** One reading, large: the engine card's unit. */
function Big({ label, value, unit, places, colour }: { label: string; value: number; unit: string; places: number; colour?: string }) {
  return (
    <div className="min-w-0 border-l border-[var(--line)] px-6 first:border-l-0 first:pl-0">
      <div className="caps text-[11px]">{label}</div>
      <div className="mt-2 font-mono text-[30px] leading-none tabular-nums" style={{ color: colour ?? 'var(--ink)' }}>
        {fixed(value, places)}
        {unit && <span className="ml-1.5 text-[12px] uppercase tracking-[0.08em] text-[var(--ink-3)]">{unit}</span>}
      </div>
    </div>
  );
}

function Readings({ items }: { items: readonly Reading[] }) {
  return (
    <div className="grid" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
      {items.map(([label, value, unit, places, colour]) => (
        <Big key={label} label={label} value={value} unit={unit} places={places} colour={colour} />
      ))}
    </div>
  );
}

/** The engine, below the fold: live while it burns, the last burn after. */
function EngineCard({
  engine,
  lit,
  attached,
  simplified,
  name,
  lastBurn,
}: {
  engine: EngineState | null;
  lit: boolean;
  attached: boolean;
  simplified: boolean;
  name: string;
  lastBurn: Burn | null;
}) {
  return (
    <section className="border border-[var(--line)] px-8 py-6">
      <div className="mb-6 flex flex-wrap items-baseline gap-x-5 gap-y-1">
        <h2 className="caps">Engine</h2>
        {name && <span className="font-mono text-[13px] text-[var(--ink-2)]">{name}</span>}
        {lit ? (
          <span className="flex items-center gap-2 font-mono text-[12px] uppercase tracking-[0.16em] text-[var(--color-danger)]">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-danger)]" />
            Burning
          </span>
        ) : (
          lastBurn && !lastBurn.burning && <span className="caps text-[11px]">Last burn</span>
        )}
        {simplified && (
          <span
            className="font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--color-warning)]"
            title="feedtwin's simplified engine, not EngineDesign's: no engine card. Build one in Library."
          >
            simplified model
          </span>
        )}
        <Link to="/engine" className="ml-auto font-mono text-[12px] text-[var(--ink-3)] hover:text-[var(--ink)]">
          Traces and O/F on Engine →
        </Link>
      </div>

      {engine && lit ? (
        <Readings
          items={[
            ['Chamber', engine.chamber_psi, 'psig', 0, channelColor('PC')],
            ['Thrust', engine.thrust_N, 'N', 0],
            ['O/F', engine.mixture_ratio, '', 2, channelColor('O/F')],
            ['Isp', engine.isp_s, 's', 0, '#4ade80'],
            ['LOX flow', engine.mdot_ox, 'kg/s', 3, LOX],
            ['Fuel flow', engine.mdot_fuel, 'kg/s', 3, FUEL],
          ]}
        />
      ) : !attached ? (
        <Link
          to="/library"
          title="Without an engine the chamber is a fixed pressure: nothing burns, so there is no thrust to report."
          className="font-mono text-[13px] text-[var(--ink-3)] hover:text-[var(--ink)]"
        >
          No engine on this stand. Pick one in Library →
        </Link>
      ) : lastBurn && !lastBurn.burning ? (
        <Readings
          items={[
            ['Impulse', lastBurn.impulse_Ns, 'N·s', 0],
            ['Thrust', lastBurn.thrust_mean_N, 'N', 0],
            ['Burn', lastBurn.duration_s, 's', 2],
            ['Chamber', lastBurn.pc_mean_psi, 'psig', 0, channelColor('PC')],
            ['O/F', lastBurn.of_mean, '', 2, channelColor('O/F')],
            ['Isp', lastBurn.isp_s, 's', 0, '#4ade80'],
          ]}
        />
      ) : (
        <p className="font-mono text-[13px] text-[var(--ink-3)]">Not lit. Fire from Command and the burn shows here.</p>
      )}
    </section>
  );
}

export function Console() {
  const {
    model,
    machine,
    live,
    history,
    burns,
    hidden,
    toggleChannel,
    go,
    toggleValve,
    release,
    setup,
    busy,
    running,
    setRunning,
    restart,
    jumpToT0,
    skipChill,
  } = useStand();
  const [window, setWindow] = useState(60);

  // What the ⋯ menus hide, for this stand. Re-read when the drawing changes.
  const diagramId = model?.diagram_id ?? '';
  const [hiddenBy, setHiddenBy] = useState<Hidden>(NONE);
  useEffect(() => {
    setHiddenBy(diagramId ? readHidden(diagramId) : NONE);
  }, [diagramId]);
  const change = (next: Hidden) => {
    setHiddenBy(next);
    if (diagramId) writeHidden(diagramId, next);
  };
  const menuFor = (panel: Panel, ids: string[]) => ({
    hidden: hiddenBy[panel],
    onToggle: (id: string) => change(toggle(hiddenBy, panel, id)),
    onAll: (show: boolean) => change(setAll(hiddenBy, panel, ids, show)),
  });

  // A transducer past NOP is drawn, bar and trace, whatever the menu says.
  const pressures = live?.pressure_psi;
  const chamber = live?.engine?.chamber_psi;
  const pastNop = useMemo(() => {
    const out = new Set<string>();
    for (const c of history?.channels ?? []) {
      const v = c.id === 'engine.pc' ? chamber : pressures?.[c.id];
      if (v !== undefined && v !== null && v > limitsFor(c.tag).nop) out.add(c.id);
    }
    return out;
  }, [history, pressures, chamber]);
  const ptShown = (id: string) => visible(hiddenBy, 'pts', id, pastNop.has(id));

  const plot = useMemo(() => {
    if (!history) return { times: [] as number[], channels: [] as Channel[] };
    const cutoff = (history.times_s[history.times_s.length - 1] ?? 0) - window;
    const from = history.times_s.findIndex((t) => t >= cutoff);
    const start = from < 0 ? 0 : from;
    return {
      times: history.times_s.slice(start),
      channels: history.channels
        .filter((c) => (c.unit || 'psig') === 'psig' && !hidden[c.id] && ptShown(c.id))
        .map((c): Channel => ({
          key: c.id,
          tag: c.tag,
          values: c.values.slice(start),
          color: channelColor(c.tag),
        })),
    };
  }, [history, hidden, window, hiddenBy, pastNop]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pressure bars only. A thermocouple in a bar scaled to MEOP is
  // meaningless -- temperature lives in its own panel on Pressure.
  const allGauges = useMemo(
    () => (history?.channels ?? []).filter((c) => (c.unit || 'psig') === 'psig'),
    [history],
  );
  const gauges = allGauges.filter((c) => ptShown(c.id));
  // The menus list items by sheet; the panels themselves do not split.
  const gaugeList = groupByPage(allGauges, allGauges, (c) => c.id, model?.pages);
  const vessels = [...(live?.tanks ?? []), ...(live?.bottles ?? [])];
  const vesselList = groupByPage(vessels, vessels, (v) => v.id, model?.pages);

  if (!model || !live) {
    return <p className="caps p-8">Bringing the stand up…</p>;
  }
  const engine = live.engine;
  const lit = engine !== null && engine.chamber_psi > 5;
  const attached = Object.keys(model.engine).length > 0;
  const simplified = model.engine.engine_model === 'simplified';
  const engineName = typeof model.engine.name === 'string' ? model.engine.name : '';
  const lastBurn = burns?.burns.length ? burns.burns[burns.burns.length - 1] : null;
  const locked = Boolean(live.tripped);
  const state = live.state;
  const reachable = live.reachable;
  const firing = /^fire$/i.test(state);
  const canFire = !busy && !locked && (reachable.includes('Fire') || firing);
  // Whatever the table can reach that the grid does not draw and the stack
  // has no button for -- the GSE and emergency aborts, a debug state. Before,
  // these were only in a "Go to…" dropdown; they must not become unreachable.
  const others = reachable.filter((s) => OFF_GRID.test(s) && !/^fire$/i.test(s) && s !== 'Engine Abort');

  const gauge = (c: (typeof gauges)[number]) => {
    const { nop, meop } = limitsFor(c.tag);
    const silent = hidden[c.id];
    // The engine's own chamber channel is not a drawn instrument: it reads
    // off the live engine, so a stand with no PC transducer still shows
    // chamber pressure while it burns.
    const value = c.id === 'engine.pc' ? (engine?.chamber_psi ?? null) : live.pressure_psi[c.id];
    return (
      <button
        key={c.id}
        type="button"
        title={silent ? `Show ${c.tag} on the plot` : `Hide ${c.tag} from the plot`}
        onClick={() => toggleChannel(c.id)}
        aria-pressed={!silent}
        className={`h-full min-h-0 min-w-0 transition-opacity ${silent ? 'opacity-35' : 'opacity-100'}`}
      >
        <PressureBar
          label={c.tag.replace(/^PT-/, '')}
          value={value ?? null}
          nop={nop}
          meop={meop}
          tint={channelColor(c.tag)}
          compact
        />
      </button>
    );
  };

  return (
    // h-full is the scroll area's height: the fold below is exactly one
    // window, and what follows it overflows into the scroll.
    <div className="h-full px-8">
      <div className="flex h-full min-h-[720px] flex-col">
        {/* ── The strip: transducers, vessels, command. Short, as the DAQ's
            top bar is, so the plot and the state machine get the height. ── */}
        <div
          className="grid flex-shrink-0 grid-cols-[minmax(0,1fr)_minmax(220px,260px)_minmax(260px,300px)] border-b border-[var(--line)]"
          style={{ height: 'clamp(190px, 24vh, 250px)' }}
        >
          <section className="flex min-h-0 min-w-0 flex-col py-4 pr-8">
            <div className="mb-2 flex flex-shrink-0 items-baseline justify-between">
              <h2 className="caps text-[11px]">Pressure · psig</h2>
              <PanelMenu
                title="Pressure"
                items={gaugeList.flatMap((g) =>
                  g.items.map((c) => ({
                    id: c.id,
                    label: c.tag,
                    forced: pastNop.has(c.id) ? 'Past NOP, so it shows anyway' : undefined,
                    page: g.page,
                  })),
                )}
                {...menuFor('pts', allGauges.map((c) => c.id))}
              />
            </div>
            {gauges.length > 0 ? (
              <div
                className="grid min-h-0 flex-1 gap-x-2"
                style={{ gridTemplateColumns: `repeat(${gauges.length}, minmax(0, 1fr))` }}
              >
                {gauges.map(gauge)}
              </div>
            ) : (
              <p className="font-mono text-[12px] text-[var(--ink-3)]">
                {allGauges.length > 0 ? 'Every transducer hidden. Show some from ⋯.' : 'Waiting for the first samples…'}
              </p>
            )}
          </section>

          <section className="flex min-h-0 min-w-0 flex-col border-l border-[var(--line)] px-6 py-4">
            <div className="mb-2 flex flex-shrink-0 items-baseline justify-between">
              <h2 className="caps text-[11px]">Tanks</h2>
              <PanelMenu
                title="Tanks"
                items={vesselList.flatMap((g) => g.items.map((v) => ({ id: v.id, label: v.label, page: g.page })))}
                {...menuFor('tanks', [...live.tanks, ...live.bottles].map((v) => v.id))}
              />
            </div>
            <div className="flex min-h-0 flex-1 flex-col justify-around gap-2 overflow-y-auto">
              {live.tanks.filter((t) => visible(hiddenBy, 'tanks', t.id)).map((t: TankState) => (
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
                  onSkipChill={() => skipChill(t.id)}
                  colour={tankColour(t)}
                />
              ))}
              {live.bottles.filter((b) => visible(hiddenBy, 'tanks', b.id)).map((b) => (
                <Vessel
                  key={b.id}
                  label={b.label}
                  litres={b.volume_L}
                  pressurePsi={b.pressure_psi}
                  fill={b.fill_fraction}
                  mass={b.liquid_mass_kg}
                  temperature={b.ullage_temperature_K}
                  colour={GN2}
                />
              ))}
            </div>
          </section>

          <section className="flex min-h-0 min-w-0 flex-col gap-2 border-l border-[var(--line)] py-4 pl-6">
            {/* FIRE is a state you enter, not a canned run you play. It holds
                until you leave it, exactly as the stand does. */}
            <button
              type="button"
              onClick={() => go('Fire')}
              disabled={!canFire || firing}
              title={firing ? 'Firing' : reachable.includes('Fire') ? 'Go to Fire' : `Fire is not reachable from ${state}`}
              className={`ctl min-h-0 flex-[1.4] text-[17px] tracking-[0.42em] ${
                firing
                  ? '!border-[var(--color-danger-solid)] !bg-[var(--color-danger-solid)] !text-white'
                  : 'hover:!border-[var(--color-danger)] hover:!bg-[var(--color-danger-solid)] hover:text-white'
              }`}
            >
              Fire
            </button>
            <button
              type="button"
              onClick={() => go('Engine Abort')}
              disabled={busy}
              className="ctl min-h-0 flex-[1.2] border-[var(--color-danger)] text-[15px] tracking-[0.34em] text-[var(--color-danger)] hover:!border-[var(--color-danger)] hover:!bg-[var(--color-danger-solid)] hover:text-white"
            >
              Eng Abort
            </button>
            <div className="grid min-h-0 flex-1 grid-cols-3 gap-2">
              <button type="button" onClick={() => setRunning(!running)} className="ctl text-[11px]">
                {running ? 'Pause' : 'Run'}
              </button>
              <button type="button" onClick={restart} title="Empty the tanks and start over" className="ctl text-[11px]">
                Reset
              </button>
              <button
                type="button"
                onClick={jumpToT0}
                disabled={busy}
                title="Skip the pad: both tanks loaded, the bottle charged to the COPV target, every tank at the lockup its regulator gives at the knobs as set, in Ready. Fire from here."
                className="ctl text-[11px] tracking-[0.08em]"
              >
                T-0
              </button>
            </div>
          </section>
        </div>

        {/* ── The room: the live plot, and the valves over the state machine ── */}
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <section className="flex min-h-0 min-w-0 flex-col py-5 pr-8">
            <div className="mb-3 flex flex-shrink-0 items-baseline justify-between gap-4">
              <h2 className="caps">Pressure History</h2>
              <div className="flex items-baseline gap-1">
                {WINDOWS.map((w) => (
                  <button
                    key={w.label}
                    type="button"
                    onClick={() => setWindow(w.seconds)}
                    aria-pressed={window === w.seconds}
                    className={`border-b px-3 pb-1.5 font-mono text-[13px] transition-colors ${
                      window === w.seconds
                        ? 'border-[var(--ink)] text-[var(--ink)]'
                        : 'border-transparent text-[var(--ink-3)] hover:text-[var(--ink-2)]'
                    }`}
                  >
                    {w.label}
                  </button>
                ))}
              </div>
            </div>
            {/* Absolutely placed so the plot takes exactly what the panel
                has, however tall the window makes it. */}
            <div className="relative min-h-[200px] flex-1">
              <div className="absolute inset-0">
                {plot.times.length > 1 ? (
                  <DaqPlot times={plot.times} channels={plot.channels} yLabel="" xLabel="" fill lineWidth={2} />
                ) : (
                  <p className="font-mono text-[12px] text-[var(--ink-3)]">Waiting for the first samples…</p>
                )}
              </div>
            </div>
          </section>

          <div className="flex min-h-0 min-w-0 flex-col border-l border-[var(--line)] pl-8">
            <section className="flex-shrink-0 border-b border-[var(--line)] py-5">
              <ActuatorGrid
                model={model}
                machine={machine}
                live={live}
                locked={locked}
                onSet={(id, want) => {
                  if (want !== (live.open[id] ?? false)) toggleValve(id);
                }}
                onRelease={release}
                hidden={hiddenBy.actuators}
                onToggleHidden={menuFor('actuators', []).onToggle}
                onAllHidden={(show) =>
                  change(setAll(hiddenBy, 'actuators', model.actuators.map((a) => a.id), show))
                }
              />
            </section>
            <section className="flex min-h-0 flex-1 flex-col py-5">
              {machine ? (
                <StateMachineDiagram
                  machine={machine}
                  live={live}
                  go={go}
                  locked={locked}
                  actions={others.map((s) => (
                    // The states the grid does not draw and Command has no
                    // button for: the GSE and emergency aborts, a debug
                    // state. They must not become unreachable.
                    <button
                      key={s}
                      type="button"
                      onClick={() => go(s)}
                      disabled={busy || locked}
                      className={`ctl h-7 px-2.5 text-[10px] ${/abort/i.test(s) ? 'text-[var(--color-danger)]' : ''}`}
                    >
                      {s}
                    </button>
                  ))}
                />
              ) : (
                <>
                  <h2 className="caps">State Machine</h2>
                  <p className="mt-4 font-mono text-[12px] text-[var(--ink-3)]">No state machine bound.</p>
                </>
              )}
            </section>
          </div>
        </div>

        {machine && (
          <div className="flex-shrink-0 border-t border-[var(--line)] py-3">
            <PadSequence live={live} machine={machine} setup={setup} go={go} hasEngine={engine !== null} compact />
          </div>
        )}
      </div>

      {/* ── Below the fold ── */}
      <div className="flex flex-col gap-6 pb-10 pt-6">
        <EngineCard
          engine={engine}
          lit={lit}
          attached={attached}
          simplified={simplified}
          name={engineName}
          lastBurn={lastBurn}
        />

        {(live.notes.length > 0 || (machine?.warnings.length ?? 0) > 0) && (
          <section className="border border-[var(--line)] px-8 py-5 font-mono">
            <h2 className="caps mb-3">Notes</h2>
            {live.notes.map((n) => (
              <p key={n} className="text-[12px] leading-relaxed text-[var(--color-warning)]">
                {n}
              </p>
            ))}
            {(machine?.warnings ?? []).map((w) => (
              <p key={w} className="text-[12px] leading-relaxed text-[var(--color-warning)] opacity-60">
                {w}
              </p>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
