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
 * transducer leaves the plot too, and comes back by itself past NOP. What is
 * hidden is the team's, kept by the backend per drawing and also set from the
 * P&ID tab, so every browser shows the same console. The cart's transducers,
 * tanks and valves start hidden; its K-bottles and dewars are not on the
 * console at all. Bars and tank cards are dragged into the order wanted.
 */

import { useMemo, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { channelColor, fixed, limitsOf, type Burn, type EngineState, type TankState } from '../api';
import ActuatorGrid from '../components/ActuatorGrid';
import { DaqPlot, type Channel } from '../components/DaqPlot';
import { PadGuideLine, usePadGuide } from '../components/PadSequence';
import PanelMenu from '../components/PanelMenu';
import PressureBar from '../components/PressureBar';
import StateMachineDiagram, { OFF_GRID } from '../components/StateMachineDiagram';
import { useStand } from '../stand';
import { groupByPage } from '../lib/pages';
import { moveTo, ordered, visible, type Hidden, type Panel } from '../lib/shown';

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
          {/* On the name line, not a line of its own: the third vessel used to
              drop off the strip while a LOX load chilled. */}
          {chilling && (
            <span className="flex flex-shrink-0 items-baseline gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em]">
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
            </span>
          )}
        </span>
        <span className="flex-shrink-0 font-mono">
          <span className="text-[17px] leading-none tabular-nums" style={{ color: colour }}>
            {fixed(pressurePsi, 1)}
          </span>
          <span className="ml-1 text-[10px] uppercase text-[var(--ink-3)]">psig</span>
        </span>
      </div>
      {/* The fill bar and what it holds share a line: three vessels fit the
          strip without a scroll (the third used to hang off the bottom). */}
      <div
        className="mt-1 flex items-center gap-2"
        title={`${litres !== undefined && litres > 0 ? `${fixed(litres, litres < 10 ? 1 : 0)} L · ` : ''}${fixed(fill * 100, 1)}% full`}
      >
        <div className="relative h-1 min-w-[24px] flex-1 overflow-hidden" style={{ background: `${colour}26` }}>
          <div
            className="absolute inset-y-0 left-0 transition-[width] duration-200"
            style={{ width: `${pct}%`, background: colour }}
          />
        </div>
        <span className="flex-shrink-0 font-mono text-[11px] tabular-nums text-[var(--ink-3)]">
          {fixed(mass, 2)} kg · {fixed(fill * 100, 0)}% · {fixed(temperature, 0)} K
        </span>
      </div>
    </div>
  );
}

/**
 * The state table's warnings, grouped: the seven "X -> Fire is permitted ...
 * bypasses Ready" sentences become one line naming the states, and every
 * other warning shows its first sentence with the rest on hover.
 */
function groupTableWarnings(warnings: readonly string[]): { text: string; detail: string }[] {
  const bypass: string[] = [];
  const out: { text: string; detail: string }[] = [];
  let bypassDetail = '';
  for (const w of warnings) {
    const m = /^(.+?) -> Fire is permitted/.exec(w);
    if (m) {
      bypass.push(m[1]);
      bypassDetail = w.replace(/^.+? -> /, 'X -> ');
      continue;
    }
    const first = w.split(/(?<=\.)\s/)[0] ?? w;
    out.push({ text: first, detail: w });
  }
  if (bypass.length) {
    out.unshift({
      text: `${bypass.length} state${bypass.length === 1 ? '' : 's'} can go straight to Fire without Ready: ${bypass.join(', ')}.`,
      detail: bypassDetail,
    });
  }
  return out;
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
        <p className="font-mono text-[13px] text-[var(--ink-3)]">Not lit. Press FIRE (top right) and the burn shows here.</p>
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
    consoleHidden,
    hideOnConsole,
    consoleOrder: order,
    setConsoleOrder: changeOrder,
    nameOf,
  } = useStand();
  const [window, setWindow] = useState(60);

  // What the ⋯ menus hide, for this stand and everyone on it (the cart until
  // somebody shows it). Node ids are unique across the panels, so one shared
  // list serves all three.
  const hiddenBy = useMemo<Hidden>(() => {
    const ids = Object.keys(consoleHidden).filter((id) => consoleHidden[id]);
    return { pts: ids, tanks: ids, actuators: ids };
  }, [consoleHidden]);
  const ground = useMemo(() => new Set(model?.ground ?? []), [model]);
  // The pad sequence, read off the stand: the state to press is ringed on the
  // grid and one line under it says what is happening.
  const guide = usePadGuide(live, machine, setup, go, ground);
  // The order the strip draws transducers and tanks in: dragged into place,
  // shared like what is hidden.
  const dragging = useRef<{ panel: 'pts' | 'tanks'; id: string } | null>(null);
  const dragProps = (panel: 'pts' | 'tanks', id: string, ids: string[]) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      dragging.current = { panel, id };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
    },
    onDragOver: (e: DragEvent) => {
      if (dragging.current?.panel === panel) e.preventDefault();
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const from = dragging.current;
      dragging.current = null;
      if (from && from.panel === panel) changeOrder({ ...order, [panel]: moveTo(ids, from.id, id) });
    },
    onDragEnd: () => {
      dragging.current = null;
    },
  });
  const menuFor = (panel: Panel, ids: string[]) => ({
    hidden: hiddenBy[panel],
    onToggle: (id: string) => hideOnConsole([id], !consoleHidden[id]),
    onAll: (show: boolean) => hideOnConsole(ids, !show),
  });

  // A transducer past NOP is drawn, bar and trace, whatever the menu says.
  // Not the cart's: its limits are guessed from the tag against the rocket's
  // tanks, and a 6K bank line is always "past" 550. A vessel over its MAWP
  // trips the stand whichever side it is on.
  const pressures = live?.pressure_psi;
  const chamber = live?.engine?.chamber_psi;
  const pastNop = useMemo(() => {
    const out = new Set<string>();
    for (const c of history?.channels ?? []) {
      if (ground.has(c.id)) continue;
      const v = c.id === 'engine.pc' ? chamber : pressures?.[c.id];
      if (v !== undefined && v !== null && v > limitsOf(c).nop) out.add(c.id);
    }
    return out;
  }, [history, pressures, chamber, ground]);
  const ptShown = (id: string) => visible(hiddenBy, 'pts', id, pastNop.has(id));

  const plot = useMemo(() => {
    if (!history) return { times: [] as number[], channels: [] as Channel[] };
    const cutoff = (history.times_s[history.times_s.length - 1] ?? 0) - window;
    const from = history.times_s.findIndex((t) => t >= cutoff);
    const start = from < 0 ? 0 : from;
    return {
      times: history.times_s.slice(start),
      channels: ordered(history.channels, order.pts, (c) => c.id)
        .filter((c) => (c.unit || 'psig') === 'psig' && !hidden[c.id] && ptShown(c.id))
        .map((c): Channel => ({
          key: c.id,
          tag: nameOf(c.id, c.tag),
          values: c.values.slice(start),
          color: channelColor(c.tag),
        })),
    };
  }, [history, hidden, window, hiddenBy, pastNop, live?.aliases, order]); // eslint-disable-line react-hooks/exhaustive-deps

  // The stand's state changes as rules across the plot, keyed by content: a
  // new array on every history pull would rebuild the chart and lose the
  // cursor.
  const eventsKey = (history?.events ?? []).map((e) => `${e.t}:${e.label}`).join('|');
  const marks = useMemo(() => history?.events ?? [], [eventsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pressure bars only. A thermocouple in a bar scaled to MEOP is
  // meaningless -- temperature lives in its own panel on Pressure.
  const allGauges = useMemo(
    () => ordered((history?.channels ?? []).filter((c) => (c.unit || 'psig') === 'psig'), order.pts, (c) => c.id),
    [history, order],
  );
  const gauges = allGauges.filter((c) => ptShown(c.id));
  // The menus list items by sheet; the panels themselves do not split.
  const gaugeList = groupByPage(allGauges, allGauges, (c) => c.id, model?.pages);
  // The cart's K-bottles and dewars are not on the console at all: nobody
  // reads their level on the pad. Its tanks (the fuel transfer tank) are, off
  // until shown.
  const unwatched = new Set(model?.ground_bottles ?? []);
  const tanks = (live?.tanks ?? []).filter((t) => !unwatched.has(t.id));
  const bottles = (live?.bottles ?? []).filter((b) => !unwatched.has(b.id));
  const bottleIds = new Set(bottles.map((b) => b.id));
  const vessels = ordered([...tanks, ...bottles], order.tanks, (v) => v.id);
  const gaugeIds = allGauges.map((c) => c.id);
  const vesselIds = vessels.map((v) => v.id);
  const vesselList = groupByPage(vessels, vessels, (v) => v.id, model?.pages);

  if (!model || !live) {
    return <p className="caps p-8">Bringing the stand up…</p>;
  }
  const tableIssues = groupTableWarnings(machine?.warnings ?? []);
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
    const { nop, meop } = limitsOf(c);
    const silent = hidden[c.id];
    // The engine's own chamber channel is not a drawn instrument: it reads
    // off the live engine, so a stand with no PC transducer still shows
    // chamber pressure while it burns.
    const value = c.id === 'engine.pc' ? (engine?.chamber_psi ?? null) : live.pressure_psi[c.id];
    return (
      <button
        key={c.id}
        type="button"
        {...dragProps('pts', c.id, gaugeIds)}
        title={`${nameOf(c.id, c.tag)}${nameOf(c.id, c.tag) !== c.tag ? ` (${c.tag} on the P&ID)` : ''}\nAmber over ${fixed(nop, 0)}, red over ${fixed(meop, 0)} psig${c.limits ? ` — ${c.limits}` : ' (guessed from the tag)'}\nClick to ${silent ? 'show on' : 'hide from'} the plot, drag to reorder`}
        onClick={() => toggleChannel(c.id)}
        aria-pressed={!silent}
        className={`h-full min-h-0 min-w-0 transition-opacity ${silent ? 'opacity-35' : 'opacity-100'}`}
      >
        <PressureBar
          label={nameOf(c.id, c.tag.replace(/^PT-/, ''))}
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
                    label: nameOf(c.id, c.tag),
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

          <section className="flex min-h-0 min-w-0 flex-col border-l border-[var(--line)] px-6 py-3">
            <div className="mb-1.5 flex flex-shrink-0 items-baseline justify-between">
              <h2 className="caps text-[11px]">Tanks</h2>
              <PanelMenu
                title="Tanks"
                items={vesselList.flatMap((g) => g.items.map((v) => ({ id: v.id, label: v.label, page: g.page })))}
                {...menuFor('tanks', vessels.map((v) => v.id))}
              />
            </div>
            <div className="flex min-h-0 flex-1 flex-col justify-around gap-1.5 overflow-y-auto">
              {vessels.filter((v) => visible(hiddenBy, 'tanks', v.id)).map((v) => (
                <div key={v.id} {...dragProps('tanks', v.id, vesselIds)} className="cursor-grab" title="Drag to reorder">
                  {bottleIds.has(v.id) ? (
                    <Vessel
                      label={v.label}
                      litres={v.volume_L}
                      pressurePsi={v.pressure_psi}
                      fill={v.fill_fraction}
                      mass={v.liquid_mass_kg}
                      temperature={v.ullage_temperature_K}
                      colour={GN2}
                    />
                  ) : (
                    <Vessel
                      label={v.label}
                      litres={v.volume_L}
                      pressurePsi={v.pressure_psi}
                      fill={v.fill_fraction}
                      mass={v.liquid_mass_kg}
                      // Until liquid collects, what there is to watch is the metal.
                      temperature={
                        v.liquid_mass_kg > 0.001 || v.wall_temperature_K === undefined
                          ? v.liquid_temperature_K
                          : v.wall_temperature_K
                      }
                      chilling={v.chilling}
                      onSkipChill={() => skipChill(v.id)}
                      colour={tankColour(v as TankState)}
                    />
                  )}
                </div>
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
              title={
                firing
                  ? 'Firing'
                  : reachable.includes('Fire')
                    ? state === 'Ready'
                      ? 'Go to Fire'
                      : `Go to Fire — the stand's table lets ${state} go straight to Fire, skipping Ready`
                    : `Fire is not reachable from ${state}`
              }
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
        {/* One row, exactly the room left: sized to its content, a long valve
            list grew it past the window and the state machine went with it. */}
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]">
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
                  <DaqPlot times={plot.times} channels={plot.channels} yLabel="" xLabel="" fill lineWidth={2} marks={marks} />
                ) : (
                  <p className="font-mono text-[12px] text-[var(--ink-3)]">Waiting for the first samples…</p>
                )}
              </div>
            </div>
          </section>

          <div className="flex min-h-0 min-w-0 flex-col border-l border-[var(--line)] pl-8">
            {/* The valves take what they need up to 40 % of the column and
                scroll past it; the state machine has the rest. Grown without a
                limit, a long valve list pushed it off the page. */}
            <section className="flex max-h-[40%] min-h-0 flex-shrink-0 flex-col border-b border-[var(--line)] py-5">
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
                ground={ground}
                aliases={live.aliases}
                onToggleHidden={menuFor('actuators', []).onToggle}
                // "all" is everything the menu lists: the rocket's valves and
                // the cart's already on the console. The rest of the cart
                // stays off until the Hookup tab puts it on.
                onAllHidden={(show) =>
                  show
                    ? hideOnConsole(
                        model.actuators.filter((a) => !ground.has(a.id)).map((a) => a.id),
                        false,
                      )
                    : hideOnConsole(model.actuators.map((a) => a.id), true)
                }
              />
            </section>
            {/* The rest of the column. On a window too short for every row of
                states it scrolls inside itself rather than spill into the
                sequence strip below. */}
            <section className="flex min-h-0 flex-1 flex-col overflow-y-auto py-5">
              {machine ? (
                <StateMachineDiagram
                  machine={machine}
                  live={live}
                  go={go}
                  locked={locked}
                  next={guide?.legal ? guide.hop : undefined}
                  guide={guide ? <PadGuideLine guide={guide} state={state} hasEngine={attached} /> : undefined}
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

        {(live.notes.length > 0 || tableIssues.length > 0) && (
          <section className="border border-[var(--line)] px-8 py-5 font-mono">
            <h2 className="caps mb-3">Notes</h2>
            {live.notes.map((n) => (
              <p key={n} className="text-[12px] leading-relaxed text-[var(--ink-2)]">
                · {n}
              </p>
            ))}
            {tableIssues.length > 0 && (
              // The stand's own table: true on every run, so folded away
              // rather than repeated at the operator in amber every time.
              <details className="mt-3">
                <summary className="cursor-pointer text-[12px] text-[var(--color-warning)]">
                  The stand's state table has {tableIssues.length} issue{tableIssues.length === 1 ? '' : 's'}{' '}
                  <span className="text-[var(--ink-3)]">— diablo_*.csv, read as the DAQ reads it; fix it there</span>
                </summary>
                <ul className="mt-2 flex flex-col gap-1 pl-4">
                  {tableIssues.map((w) => (
                    <li key={w.text} className="text-[12px] leading-relaxed text-[var(--ink-2)]" title={w.detail}>
                      {w.text}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
