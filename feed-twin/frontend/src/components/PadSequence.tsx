/**
 * The pad sequence, as a checklist the stand fills in.
 *
 * The state buttons say what is *legal*; nothing said what to do. A cold stand
 * has two empty tanks and a flat bottle, and the route from there to a lit
 * engine is thirteen state changes, four of which are waits — for a tank to
 * load, for the bottle to charge, for a tank to come up to pressure. An
 * operator who knows the Diablo table walks it from memory; nobody else could
 * find it, and the twin read as broken.
 *
 * This reads the sequence off the stand's physical state rather than off a
 * script. Each phase names the state it wants the stand in and the condition
 * that says the phase is finished — LOX loaded, bottle charged, tank at
 * regulator pressure — so leaving and coming back lands on the right step,
 * and a tank that was filled by hand counts as filled. The next state to
 * command is the first hop of the shortest legal path to the phase's state,
 * skipping Fire, Vent and the aborts, so a table with a Press Standby -> Fire
 * bypass in it does not have the guide suggesting it.
 *
 * Fire is never taken automatically. The auto-sequence stops at Ready.
 *
 * Drawn inside the State Machine panel (2026-10-09): the state to press is
 * ringed on the grid and one line says what is happening. It used to be a
 * strip along the bottom of the console with its own button for the next
 * state -- a second state machine, one button wide.
 */

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { fixed, type Burn, type SessionState, type StandSetup, type StateMachine, type TankState } from '../api';

interface Phase {
  key: string;
  /** What the operator sees on the checklist. */
  label: string;
  /** The state this phase wants the stand in. */
  target: string;
  /** What is happening while the stand sits in the target. */
  waiting: string;
  /** Finished, as read from the stand. */
  done: (live: SessionState, setup: StandSetup) => boolean;
  /** 0..1 while waiting, if the wait has a size. */
  progress?: (live: SessionState, setup: StandSetup) => number;
  /** A phase with no such state on this machine is left out. */
  optional?: boolean;
  /** Why the wait cannot finish as the stand stands, or '' (said instead). */
  blocked?: (live: SessionState) => string;
}

/** Where a fill stops: the session's FULL_FRACTION -- a 5 % ullage, which is
 *  how the stand is loaded (6.5 kg of ethanol plus 5 %). */
const FULL = 0.95;
/** Loaded means the load has all but stopped: this share of what it fills
 *  the tank to. Strictly under 1, because the load lands *at* its target and
 *  a threshold equal to it never fires. */
const LOADED_OF_TARGET = 0.95;
/** At pressure means within this of the lockup its regulator gives now [psi]:
 *  dome + bias less the supply effect of the bottle behind it, which with a
 *  full COPV sits *below* the dome. Close, not 95 %: the guide once moved on
 *  while the tank was still climbing, and the hot pressurant then collapsed
 *  onto the liquid with the solenoid shut. */
const PRESSED_PSI = 3;

/** What a tank presses up to: its regulator's lockup now, or the dome when the
 *  stand does not say. */
const pressTarget = (t: TankState | undefined, dome: number) =>
  t?.lockup_psi ?? dome;
/** A regulator feeds the tank (it has a lockup range at the knob's dome) but
 *  gives no lockup now: its dome is not loaded, so it is shut. */
const domeUnloaded = (t: TankState | undefined) =>
  t !== undefined &&
  ((t.lockup_range_psi != null && t.lockup_psi == null) ||
    // An older server gave the unloaded regulator's sub-atmospheric number.
    (t.lockup_psi != null && t.lockup_psi <= 0));
/** Pressed: within PRESSED_PSI of the lockup, and never with the dome
 *  unloaded -- the guide reached Ready on tanks at 15 and 34 psia because an
 *  unloaded dome's "lockup" sat under atmosphere. */
const pressed = (t: TankState | undefined, dome: number) =>
  t === undefined || (!domeUnloaded(t) && t.pressure_psi >= pressTarget(t, dome) - PRESSED_PSI);
/** Far under its lockup -- or with nothing on its dome -- as FIRE asks before
 *  it lights a stand that was never pressed: SLIP under, the same margin the
 *  guide calls a slip. A missing tank is not. */
export const underPressed = (t: TankState | undefined, dome: number) =>
  t !== undefined && (domeUnloaded(t) || t.pressure_psi < (1 - SLIP) * pressTarget(t, dome));
/** The press wait that cannot end: a shut regulator presses nothing. */
const unloaded = (t: TankState | undefined) =>
  domeUnloaded(t) ? 'dome not loaded, so the regulator is shut; open the dome line on the P&ID tab' : '';
/** Charged means within 3% of the bottle target. */
const CHARGED = 0.97;

/** How far under a done phase may slip after the stand is committed before
 *  the guide says so, as a share of what it reached. The press solenoids shut
 *  at Ready and the pressurant collapses onto the LOX: a T-0'd LOX tank sits
 *  ~12 % under lockup a second later, and an amber "has slipped" stood over
 *  FIRE after every T-0. Past this it is worth a look. */
const SLIP = 0.15;

/** A wetted wall this far above its liquid is still chilling down. Shut the
 *  vent on it and the LOX it touches boils at kilowatts into a two-litre
 *  ullage; the load is not done until the frost has formed. */
const WARM_WALL_K = 30;
const CRYOGENIC_K = 150;

/** By what the tank holds; the label only when the backend did not say. LE4's
 *  tanks are TK-2 and TK-3, and matching "ox" in a label watched the empty fuel
 *  tank for the LOX load forever. */
const isOx = (t: TankState) =>
  t.side ? t.side === 'lox' : /lox|ox/i.test(t.id) || /lox|ox/i.test(t.label);
const chilled = (t: TankState | undefined) =>
  t === undefined ||
  t.liquid_temperature_K >= CRYOGENIC_K ||
  t.wall_temperature_K === undefined ||
  t.wall_temperature_K - t.liquid_temperature_K < WARM_WALL_K;
/** How far through its load a tank is, 0..1: against what the load fills it
 *  to (the engine's fire load, which T-0 and the pad load), or the full
 *  fraction from an older server. A 6.75 kg fire load is 73 % of LE4's LOX
 *  tank; read against 90 %, every T-0 "slipped". */
const loaded = (t: TankState) =>
  t.load_kg && t.load_kg > 0 ? Math.min(t.liquid_mass_kg / t.load_kg, 1) : Math.min(t.fill_fraction / FULL, 1);
/** 0..1 through the load: the fill first, then the chilldown. */
const loadProgress = (t: TankState | undefined) => {
  if (!t) return 0;
  const fill = loaded(t);
  if (fill < 1 || chilled(t)) return fill;
  const excess = (t.wall_temperature_K ?? t.liquid_temperature_K) - t.liquid_temperature_K;
  // 293 K wall on 90 K LOX is the start of the chilldown; WARM_WALL_K the end.
  return Math.min(Math.max(1 - (excess - WARM_WALL_K) / (293 - t.liquid_temperature_K - WARM_WALL_K), 0), 1);
};
/** Where a chilldown ends [K]: the wall within WARM_WALL_K of the liquid, or
 *  of LOX at one atmosphere while none has collected yet. */
const LOX_NBP_K = 90.2;
export const chillEndK = (t: TankState) =>
  (t.liquid_temperature_K < CRYOGENIC_K ? t.liquid_temperature_K : LOX_NBP_K) + WARM_WALL_K;
/** 0..1 through a chilldown, by the wall: from where it started to where it
 *  ends. The pad read 0 % for the ten minutes of a chill, because the bar was
 *  the liquid collected and nothing collects until the wall is cold. */
export const chillFraction = (wallK: number, startK: number, endK: number) =>
  startK - endK <= 0 ? 1 : Math.min(Math.max((startK - wallK) / (startK - endK), 0), 1);
/** Seconds of stand time left on a chill at the rate the wall is cooling
 *  [K/s, positive], or null when it is not cooling measurably. */
export const chillLeftS = (wallK: number, endK: number, rateKs: number) =>
  rateKs > 1e-4 ? Math.max(wallK - endK, 0) / rateKs : null;

const oxTank = (live: SessionState) => live.tanks.find(isOx) ?? live.tanks[0];
const fuelTank = (live: SessionState) => live.tanks.find((t) => !isOx(t)) ?? live.tanks[1];
const bottle = (live: SessionState) => live.bottles[0];

const PHASES: Phase[] = [
  {
    key: 'ox',
    label: 'Load LOX',
    target: 'Ox Fill',
    waiting: 'LOX loading; the wall chills first, so keep venting',
    done: (l) => (oxTank(l) ? loaded(oxTank(l) as TankState) : 1) >= LOADED_OF_TARGET && chilled(oxTank(l)),
    progress: (l) => loadProgress(oxTank(l)),
  },
  {
    key: 'fuel',
    label: 'Load fuel',
    target: 'Fuel Fill',
    waiting: 'fuel loading',
    done: (l) => (fuelTank(l) ? loaded(fuelTank(l) as TankState) : 1) >= LOADED_OF_TARGET && chilled(fuelTank(l)),
    progress: (l) => loadProgress(fuelTank(l)),
  },
  {
    key: 'charge',
    label: 'Charge COPV',
    target: 'GN2 High Press',
    waiting: 'COPV charging',
    done: (l, s) => (bottle(l)?.pressure_psi ?? Infinity) >= CHARGED * s.copv_target,
    progress: (l, s) => (bottle(l)?.pressure_psi ?? 0) / s.copv_target,
  },
  {
    key: 'oxpress',
    label: 'Press LOX',
    target: 'Ox Press',
    waiting: 'LOX tank pressing up to lockup',
    done: (l, s) => pressed(oxTank(l), s.dome),
    blocked: (l) => unloaded(oxTank(l)),
    progress: (l, s) =>
      (oxTank(l)?.pressure_psi ?? 0) / pressTarget(oxTank(l), s.dome),
  },
  {
    key: 'fuelpress',
    label: 'Press fuel',
    target: 'Fuel Press',
    waiting: 'fuel tank pressing up to lockup',
    done: (l, s) => pressed(fuelTank(l), s.dome),
    blocked: (l) => unloaded(fuelTank(l)),
    progress: (l, s) =>
      (fuelTank(l)?.pressure_psi ?? 0) / pressTarget(fuelTank(l), s.dome),
  },
  {
    key: 'topup',
    label: 'Top up COPV',
    target: 'GN2 High Press',
    waiting: 'COPV back up to its charge',
    done: (l, s) => (bottle(l)?.pressure_psi ?? Infinity) >= CHARGED * s.copv_target,
    progress: (l, s) => (bottle(l)?.pressure_psi ?? 0) / s.copv_target,
  },
  {
    key: 'ready',
    label: 'Ready',
    target: 'Ready',
    waiting: 'holding at Ready',
    done: (l) => l.state === 'Ready' || l.state === 'Fire',
  },
  {
    key: 'fire',
    label: 'Fire',
    target: 'Fire',
    waiting: 'burning',
    // A burn ends in Vent on its own when a tank runs dry; that is the
    // sequence completing, not leaving it.
    done: (l) => l.state === 'Fire' || l.notes.some((n) => /burnout/i.test(n)),
  },
];

/** Has a phase done before commit slipped past SLIP since? Presses by
 *  pressure against a loaded lockup, charges and loads by what they hold. */
function slipped(p: Phase, live: SessionState, setup: StandSetup): boolean {
  if (p.done(live, setup)) return false;
  const under = (have: number, want: number) => want > 0 && have < (1 - SLIP) * want;
  switch (p.key) {
    case 'oxpress':
    case 'fuelpress': {
      const t = p.key === 'oxpress' ? oxTank(live) : fuelTank(live);
      return domeUnloaded(t) || under(t?.pressure_psi ?? 0, pressTarget(t, setup.dome));
    }
    case 'charge':
    case 'topup':
      return under(bottle(live)?.pressure_psi ?? Infinity, setup.copv_target);
    default:
      return (p.progress?.(live, setup) ?? 1) < 1 - SLIP;
  }
}

/** A wait in stand time, as a person says it: "40 s", "6 min", "1 h 5 min". */
export function waitText(seconds: number): string {
  if (seconds < 90) return `${Math.max(Math.round(seconds / 5) * 5, 5)} s`;
  const min = Math.round(seconds / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** States the guide never routes through on its own. */
const NEVER_VIA = (s: string) => /fire|abort|vent/i.test(s);

/** The aborts. The table's only way out of one is often through another
 *  (Engine Abort reaches GSE Abort, and only GSE Abort reaches Idle), so the
 *  guide walks abort to abort on the way out -- never into one. */
const ABORT = (s: string) => /abort/i.test(s);

/** Past the point of no return on the table: from here the only ways back to
 *  a fill or a press go through Vent or an abort, so the loading phases are
 *  taken as read and the guide stops re-checking them. A tank that has sagged
 *  since is reported, not routed back to. */
const COMMITTED = (s: string) => /^(calibrate|ready|fire)$/i.test(s);

/**
 * First hop of the shortest legal path from `from` to `to`, or '' if there is
 * none that avoids Fire, Vent and the aborts. The target itself may be Fire —
 * that is the last step — but nothing is routed *through* it. From inside an
 * abort the path may step to another abort, which is how the table leaves one.
 */
function firstHop(machine: StateMachine, from: string, to: string): string {
  if (from === to) return '';
  const prev = new Map<string, string>([[from, '']]);
  const queue = [from];
  while (queue.length) {
    const here = queue.shift() as string;
    for (const next of machine.transitions[here] ?? []) {
      if (prev.has(next)) continue;
      if (next !== to && NEVER_VIA(next) && !(ABORT(here) && ABORT(next))) continue;
      prev.set(next, here);
      if (next === to) {
        let hop = to;
        while (prev.get(hop) !== from) hop = prev.get(hop) as string;
        return hop;
      }
      queue.push(next);
    }
  }
  return '';
}

/** Where the stand is on the pad, read off its physical state. */
export interface PadGuide {
  phases: Phase[];
  /** Index of the phase being worked; `phases.length` when all are done. */
  index: number;
  current: Phase | undefined;
  /** The stand is sitting in the current phase's state, waiting it out. */
  inTarget: boolean;
  /** The state to press next, '' when none (waiting, done or no route). */
  hop: string;
  legal: boolean;
  /** 0..1 through the current wait, when it has a size. */
  progress: number | undefined;
  /** Why the current wait cannot finish, or ''. */
  blocked: string;
  /** Phases done before the stand was committed that have since slipped
   *  further than SLIP. */
  sagged: Phase[];
  /** The LOX tank's chilldown while it runs: how far, the wall, and the
   *  stand seconds left at the rate it is cooling (null until measurable). */
  chill: { fraction: number; wallK: number; endK: number; leftS: number | null } | null;
  auto: boolean;
  setAuto: (on: boolean) => void;
}

/**
 * The pad sequence as state for a panel to draw: which phase, what to press
 * next, how far through a wait. The auto-sequence runs here, so it keeps
 * running whatever draws it.
 */
export function usePadGuide(
  stand: SessionState | null,
  machine: StateMachine | null,
  setup: StandSetup,
  go: (state: string) => void,
  /** Drawing ids of the ground support: its dewar and K-bottles are where a
   *  load comes from, not the tank being loaded. */
  ground: ReadonlySet<string> = new Set(),
): PadGuide | null {
  const [auto, setAuto] = useState(false);
  const commanded = useRef('');
  const live = stand && {
    ...stand,
    tanks: stand.tanks.filter((t) => !ground.has(t.id)),
    bottles: stand.bottles.filter((b) => !ground.has(b.id)),
  };
  const guide = (() => {
    if (!live || !machine) return null;
    const phases = PHASES.filter((p) => machine.states.includes(p.target));
    const committed = COMMITTED(live.state);
    const current = phases.find(
      (p) => !p.done(live, setup) && !(committed && p.key !== 'ready' && p.key !== 'fire'),
    );
    const index = current ? phases.indexOf(current) : phases.length;
    // What has sagged since the stand was committed. Hot pressurant collapsing
    // onto a cryogen after the press solenoid shuts is physical and is exactly
    // what an operator watches for at Ready; the guide names it rather than
    // pretending the checklist is still green.
    // Not during a burn: tanks emptying into an engine have not "sagged".
    // Only past SLIP: a few percent of sag after T-0 is the physics, not news.
    const sagged =
      committed && live.state !== 'Fire'
        ? phases.filter((p) => p.key !== 'ready' && p.key !== 'fire' && slipped(p, live, setup))
        : [];
    const inTarget = current !== undefined && live.state === current.target;
    const hop = current && !inTarget ? firstHop(machine, live.state, current.target) : '';
    const legal = hop !== '' && live.reachable.includes(hop);
    const progress = current?.progress?.(live, setup);
    const blocked = current?.blocked?.(live) ?? '';
    return { phases, index, current, inTarget, hop, legal, progress, blocked, sagged };
  })();

  // The chilldown, read off the LOX tank's wall: how far, and how long to go
  // at the rate it is cooling (measured over the last ~20 s of stand time).
  const ox = live ? oxTank(live) : undefined;
  const wallK = ox?.wall_temperature_K;
  const chilling = Boolean(
    ox && wallK !== undefined && (ox.chilling || (loaded(ox) >= LOADED_OF_TARGET && !chilled(ox))),
  );
  const trail = useRef<{ id: string; startK: number; samples: { t: number; k: number }[] }>({
    id: '',
    startK: 0,
    samples: [],
  });
  if (live && ox && wallK !== undefined && chilling) {
    const key = `${live.id}:${ox.id}`;
    if (trail.current.id !== key) trail.current = { id: key, startK: Math.max(wallK, chillEndK(ox) + 1), samples: [] };
    const samples = trail.current.samples;
    if (!samples.length || live.t > samples[samples.length - 1].t) samples.push({ t: live.t, k: wallK });
    while (samples.length > 2 && live.t - samples[0].t > 20) samples.shift();
  } else if (!chilling && trail.current.id) {
    trail.current = { id: '', startK: 0, samples: [] };
  }
  const chill = (() => {
    if (!chilling || !ox || wallK === undefined) return null;
    const endK = chillEndK(ox);
    const s = trail.current.samples;
    const span = s.length > 1 ? s[s.length - 1].t - s[0].t : 0;
    const rate = span > 1 ? (s[0].k - s[s.length - 1].k) / span : 0;
    return {
      fraction: chillFraction(wallK, trail.current.startK, endK),
      wallK,
      endK,
      leftS: span > 1 ? chillLeftS(wallK, endK, rate) : null,
    };
  })();

  // Auto-sequence: take each legal hop as it comes, wait out the waits, and
  // stop at Ready. Fire is the operator's. One command per distinct stand
  // state, so a slow round trip does not double-command.
  const stamp = guide && live ? `${live.state}>${guide.hop}` : '';
  // Nor does it lead the stand out of an abort: that is the operator's call,
  // and an auto-sequence that resumed a fill after someone hit abort would be
  // the worst thing on the page.
  // Nor waits on something only the operator can change (an unloaded dome).
  const stop =
    !guide?.current ||
    guide.current.key === 'fire' ||
    Boolean(live && ABORT(live.state)) ||
    Boolean(guide.inTarget && guide.blocked);
  const act = Boolean(guide && !guide.inTarget && guide.legal);
  useEffect(() => {
    if (!auto) {
      commanded.current = '';
      return;
    }
    if (stop) {
      setAuto(false);
      return;
    }
    if (!act || !guide) return;
    if (commanded.current === stamp) return;
    commanded.current = stamp;
    go(guide.hop);
  }, [auto, stop, act, stamp]); // eslint-disable-line react-hooks/exhaustive-deps

  return guide ? { ...guide, chill, auto, setAuto } : null;
}

/**
 * The guide as one line over the state machine's grid: the checklist as dots, what
 * is happening or what to press, and the auto-sequence. The state to press is
 * ringed on the grid itself; the strip of buttons that used to sit along the
 * bottom of the console repeated the grid (the operator, 2026-10-09).
 */
export function PadGuideLine({
  guide,
  state,
  hasEngine,
  burn,
  clock = null,
  burnout = '',
  coldFlow = '',
  abortNote = '',
}: {
  guide: PadGuide;
  state: string;
  hasEngine: boolean;
  /** The stand's latest burn, live while it burns. */
  burn?: Burn;
  /** The console's burn clock [s] -- the BURN tile's, from the first lit
   *  tick -- or null while nothing is lit. While it burns the line reads this
   *  one clock and leaves thrust and Isp to the tiles: the burn record is
   *  fetched behind the tick, so its time and mean read 0.5 s and 130 N off
   *  the tiles beside them (2.13 s against 1.64 s). */
  clock?: number | null;
  /** The stand's burnout note, while it stands (it clears on the next state). */
  burnout?: string;
  /** The stand's "Not lit: cold flow" note: Fire with nothing burning. */
  coldFlow?: string;
  /** The stand's note that this abort's table row leaves a main open. */
  abortNote?: string;
}) {
  const { phases, index, current, inTarget, hop, legal, progress, blocked, sagged, chill, auto, setAuto } = guide;
  // While the LOX wall chills nothing collects: the bar is the chill, by the
  // wall's temperature, and the line says how long to go.
  const chilling = inTarget && current?.key === 'ox' && chill !== null;
  const shown = chilling && chill ? chill.fraction : progress;
  // During a burn and in the Vent it ends in, the line is the burn: what
  // someone watching wants then is how it went, not that the tanks are empty
  // and the next thing is a LOX load.
  const burning = state === 'Fire';
  const burned = !burning && Boolean(burnout) && burn !== undefined && !burn.burning;
  if (burning && coldFlow) {
    return (
      <div className="flex min-w-0 items-center gap-x-4 font-mono text-[12px]">
        <span className="min-w-0 flex-1 truncate text-[var(--color-warning)]" title={coldFlow}>
          {coldFlow}
        </span>
      </div>
    );
  }
  // In Fire, only the burn going on now: the last one's totals read as this
  // one's while the valves were still opening.
  if (((burning && burn?.burning) || burned) && burn) {
    const why = burnout.match(/: (.+? ran dry)/)?.[1];
    // With no engine on the stand Fire is a flow test, and nothing lit is a
    // cold flow: neither is a "burn" (a no-engine Fire was "Burnout").
    const lit = hasEngine && burn.thrust_mean_N >= 1;
    const what = !hasEngine ? 'Flow test' : !lit ? 'Not lit: cold flow' : burned ? 'Burned' : 'Burning';
    // A lit burn going on now is on the tiles: one clock, theirs, and no
    // second thrust beside their live one.
    const onTiles = lit && !burned;
    const time = onTiles ? clock : burn.duration_s;
    return (
      <div className="flex min-w-0 items-center gap-x-4 font-mono text-[12px]">
        <span
          className={`min-w-0 flex-1 truncate ${
            !lit ? 'text-[var(--color-warning)]' : burned ? 'text-[var(--color-success)]' : 'text-[var(--ink)]'
          }`}
        >
          {what}
          {time !== null && (
            <>
              {' '}
              <span className="tabular-nums">{fixed(time, 2)} s</span>
            </>
          )}
          {!onTiles && (
            <span className="text-[var(--ink-2)]">
              {' · '}
              {lit ? (
                <>
                  <span className="tabular-nums">{Math.round(burn.thrust_mean_N).toLocaleString()} N</span> mean
                </>
              ) : (
                'no thrust'
              )}
              {lit && burn.isp_s > 0 && (
                <>
                  {' · Isp '}
                  <span className="tabular-nums">{fixed(burn.isp_s, 0)} s</span>
                </>
              )}
              {burned && why && ` — ${why}`}
            </span>
          )}
        </span>
        {burned && (
          <span className="flex flex-shrink-0 gap-3 text-[11px]">
            <Link to="/engine" className="text-[var(--ink-2)] underline-offset-2 hover:text-[var(--ink)] hover:underline">
              Engine
            </Link>
            <Link to="/runs" className="text-[var(--ink-2)] underline-offset-2 hover:text-[var(--ink)] hover:underline">
              Runs
            </Link>
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 font-mono text-[12px]">
      <div className="flex min-w-0 items-center gap-x-4">
        <span
          className="flex flex-shrink-0 items-center gap-1"
          title={phases
            .map((p, i) => `${i < index ? '✓' : i === index ? '▸' : '·'} ${p.label}`)
            .join('\n')}
        >
          {phases.map((p, i) => (
            <span
              key={p.key}
              className="inline-block h-1.5 w-3"
              style={{
                background:
                  i < index ? 'var(--color-success)' : i === index ? 'var(--ink)' : 'var(--line-strong)',
              }}
            />
          ))}
          <span className="ml-1.5 text-[11px] text-[var(--ink-3)]">
            {Math.min(index, phases.length)}/{phases.length}
          </span>
        </span>
        {current === undefined ? (
          <span className="min-w-0 flex-1 truncate text-[var(--color-success)]">Pad complete — the stand is in {state}.</span>
        ) : inTarget && blocked ? (
          <span className="min-w-0 flex-1 truncate text-[var(--color-warning)]" title={blocked}>
            {current.label}: {blocked}.
          </span>
        ) : inTarget ? (
          <span className="flex min-w-0 flex-1 items-center gap-2 text-[var(--ink-2)]">
            <span
              className="truncate"
              title={
                chilling && chill
                  ? `The wall is at ${fixed(chill.wallK, 0)} K and the LOX collects once it is near ${fixed(chill.endK, 0)} K. Until then every gram poured flashes off and vents. On the stand this takes about ten minutes: skip it on the LOX tank card, or jump to T-0.`
                  : undefined
              }
            >
              {current.key === 'fire'
                ? 'Burning.'
                : chilling && chill
                  ? `${current.label}: chilling the wall, ${fixed(chill.wallK, 0)} K → ${fixed(chill.endK, 0)} K${
                      chill.leftS !== null ? `, about ${waitText(chill.leftS)} to go` : ''
                    }.`
                  : `${current.label}: ${current.waiting}.`}
            </span>
            {shown !== undefined && (
              <>
                <span className="relative h-1 w-24 flex-shrink-0 overflow-hidden bg-[var(--line)]">
                  <span
                    className="absolute inset-y-0 left-0 bg-[var(--ink-2)] transition-[width] duration-200"
                    style={{ width: `${Math.min(Math.max(shown, 0), 1) * 100}%` }}
                  />
                </span>
                <span className="tabular-nums text-[var(--ink-3)]">{fixed(Math.min(shown, 1) * 100, 0)}%</span>
              </>
            )}
          </span>
        ) : hop && ABORT(state) ? (
          <span className="min-w-0 flex-1 truncate text-[var(--ink-2)]">
            Out of {state}: press{' '}
            <span className={legal ? 'font-semibold text-[var(--ink)]' : 'text-[var(--ink-3)]'}>{hop}</span>
            <span className="text-[var(--ink-3)]"> → … → {current.target}</span>
          </span>
        ) : hop ? (
          <span className="min-w-0 flex-1 truncate text-[var(--ink-2)]">
            Next, {current.label.toLowerCase()}: press{' '}
            <span className={legal ? 'font-semibold text-[var(--ink)]' : 'text-[var(--ink-3)]'}>{hop}</span>
            {hop !== current.target && <span className="text-[var(--ink-3)]"> → {current.target}</span>}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[var(--color-warning)]">
            No route from {state} to {current.target} without a vent or an abort.
          </span>
        )}
        {current !== undefined && current.key !== 'fire' && !ABORT(state) && (
          <label
            className="ml-auto flex flex-shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-[var(--ink-3)]"
            title="Press each state as it comes and wait out the loads and presses, stopping at Ready. Fire stays yours."
          >
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => setAuto(e.target.checked)}
              className="accent-[var(--ink-2)]"
            />
            Auto to Ready
          </label>
        )}
      </div>
      {sagged.length > 0 && (
        <span
          className="text-[var(--color-warning)]"
          title="Some sag after the press valves shut is expected: the pressurant cools onto the propellant. This much is worth a look before Fire."
        >
          Since commit, {sagged.map((p) => p.label.toLowerCase()).join(', ')}{' '}
          {sagged.length === 1 ? 'has' : 'have'} slipped more than {Math.round(SLIP * 100)} %. Fire as it stands, or
          Vent and go round again.
        </span>
      )}
      {!hasEngine && (
        <span className="text-[var(--color-warning)]">
          No engine on this stand: tanks load and press, but Fire lights nothing. Pick one in Library.
        </span>
      )}
      {abortNote && (
        // The DAQ's table, run as the DAQ reads it (NEEDS-REPAIR.md): an abort
        // that feeds the engine is said where the operator is looking.
        <span className="leading-snug text-[var(--color-warning)]" title={abortNote}>
          {abortNote}
        </span>
      )}
    </div>
  );
}
