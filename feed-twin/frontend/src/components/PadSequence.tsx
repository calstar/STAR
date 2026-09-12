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
 */

import { useEffect, useRef, useState } from 'react';
import { fixed, type SessionState, type StandSetup, type StateMachine, type TankState } from '../api';

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
}

/** Where a fill stops: the session's FULL_FRACTION -- a 5 % ullage, which is
 *  how the stand is loaded (6.5 kg of ethanol plus 5 %). */
const FULL = 0.95;
/** Loaded means the fill has all but stopped. Strictly under FULL, because
 *  the fill lands *at* FULL and a threshold equal to it never fires. */
const LOADED = 0.9;
/** At pressure means at the dome setting. The regulator's spring bias locks
 *  the tank up *above* the dome, so this is reached with margin; 95% was not
 *  enough -- the guide moved on while the tank was still climbing, and the
 *  hot pressurant then collapsed onto the liquid with the solenoid shut. */
const PRESSED = 1.0;
/** Charged means within 3% of the bottle target. */
const CHARGED = 0.97;

/** A wetted wall this far above its liquid is still chilling down. Shut the
 *  vent on it and the LOX it touches boils at kilowatts into a two-litre
 *  ullage; the load is not done until the frost has formed. */
const WARM_WALL_K = 30;
const CRYOGENIC_K = 150;

const isOx = (t: TankState) => /lox|ox/i.test(t.id) || /lox|ox/i.test(t.label);
const chilled = (t: TankState | undefined) =>
  t === undefined ||
  t.liquid_temperature_K >= CRYOGENIC_K ||
  t.wall_temperature_K === undefined ||
  t.wall_temperature_K - t.liquid_temperature_K < WARM_WALL_K;
/** 0..1 through the load: the fill first, then the chilldown. */
const loadProgress = (t: TankState | undefined) => {
  if (!t) return 0;
  const fill = Math.min(t.fill_fraction / FULL, 1);
  if (fill < 1 || chilled(t)) return fill;
  const excess = (t.wall_temperature_K ?? t.liquid_temperature_K) - t.liquid_temperature_K;
  // 293 K wall on 90 K LOX is the start of the chilldown; WARM_WALL_K the end.
  return Math.min(Math.max(1 - (excess - WARM_WALL_K) / (293 - t.liquid_temperature_K - WARM_WALL_K), 0), 1);
};
const oxTank = (live: SessionState) => live.tanks.find(isOx) ?? live.tanks[0];
const fuelTank = (live: SessionState) => live.tanks.find((t) => !isOx(t)) ?? live.tanks[1];
const bottle = (live: SessionState) => live.bottles[0];

const PHASES: Phase[] = [
  {
    key: 'ox',
    label: 'Load LOX',
    target: 'Ox Fill',
    waiting: 'LOX arriving from the tanker, then the wall chilling down — keep venting until it is cold',
    done: (l) => (oxTank(l)?.fill_fraction ?? 1) >= LOADED && chilled(oxTank(l)),
    progress: (l) => loadProgress(oxTank(l)),
  },
  {
    key: 'fuel',
    label: 'Load fuel',
    target: 'Fuel Fill',
    waiting: 'fuel arriving from the tanker',
    done: (l) => (fuelTank(l)?.fill_fraction ?? 1) >= LOADED && chilled(fuelTank(l)),
    progress: (l) => loadProgress(fuelTank(l)),
  },
  {
    key: 'charge',
    label: 'Charge COPV',
    target: 'GN2 High Press',
    waiting: 'bottle charging from the GSE cart',
    done: (l, s) => (bottle(l)?.pressure_psi ?? Infinity) >= CHARGED * s.copv_target,
    progress: (l, s) => (bottle(l)?.pressure_psi ?? 0) / s.copv_target,
  },
  {
    key: 'oxpress',
    label: 'Press LOX',
    target: 'Ox Press',
    waiting: 'LOX tank coming up through the regulator',
    done: (l, s) => (oxTank(l)?.pressure_psi ?? Infinity) >= PRESSED * s.dome,
    progress: (l, s) => (oxTank(l)?.pressure_psi ?? 0) / s.dome,
  },
  {
    key: 'fuelpress',
    label: 'Press fuel',
    target: 'Fuel Press',
    waiting: 'fuel tank coming up through the regulator',
    done: (l, s) => (fuelTank(l)?.pressure_psi ?? Infinity) >= PRESSED * s.dome,
    progress: (l, s) => (fuelTank(l)?.pressure_psi ?? 0) / s.dome,
  },
  {
    key: 'topup',
    label: 'Top up COPV',
    target: 'GN2 High Press',
    waiting: 'bottle back to target after pressing',
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

/** States the guide never routes through on its own. */
const NEVER_VIA = (s: string) => /fire|abort|vent/i.test(s);

/** Past the point of no return on the table: from here the only ways back to
 *  a fill or a press go through Vent or an abort, so the loading phases are
 *  taken as read and the guide stops re-checking them. A tank that has sagged
 *  since is reported, not routed back to. */
const COMMITTED = (s: string) => /^(calibrate|ready|fire)$/i.test(s);

/**
 * First hop of the shortest legal path from `from` to `to`, or '' if there is
 * none that avoids Fire, Vent and the aborts. The target itself may be Fire —
 * that is the last step — but nothing is routed *through* it.
 */
function firstHop(machine: StateMachine, from: string, to: string): string {
  if (from === to) return '';
  const prev = new Map<string, string>([[from, '']]);
  const queue = [from];
  while (queue.length) {
    const here = queue.shift() as string;
    for (const next of machine.transitions[here] ?? []) {
      if (prev.has(next)) continue;
      if (next !== to && NEVER_VIA(next)) continue;
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

interface Props {
  live: SessionState;
  machine: StateMachine;
  setup: StandSetup;
  go: (state: string) => void;
  hasEngine: boolean;
  /** One line along the bottom of the console rather than a section. */
  compact?: boolean;
}

export default function PadSequence({ live, machine, setup, go, hasEngine, compact = false }: Props) {
  const [auto, setAuto] = useState(false);
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
  const sagged =
    committed && live.state !== 'Fire'
      ? phases.filter((p) => !p.done(live, setup) && p.key !== 'ready' && p.key !== 'fire')
      : [];

  // Where the stand is, relative to the current phase.
  const inTarget = current !== undefined && live.state === current.target;
  const hop = current && !inTarget ? firstHop(machine, live.state, current.target) : '';
  const legal = hop !== '' && live.reachable.includes(hop);
  const progress = current?.progress?.(live, setup);

  // Auto-sequence: take each legal hop as it comes, wait out the waits, and
  // stop at Ready. Fire is the operator's. One command per distinct stand
  // state, so a slow round trip does not double-command.
  const commanded = useRef('');
  useEffect(() => {
    if (!auto) {
      commanded.current = '';
      return;
    }
    if (!current || current.key === 'fire') {
      setAuto(false);
      return;
    }
    if (inTarget || !legal || live.computing) return;
    const stamp = `${live.state}>${hop}`;
    if (commanded.current === stamp) return;
    commanded.current = stamp;
    go(hop);
  }, [auto, current, inTarget, legal, hop, live.state, live.computing, go]);

  return (
    <section>
      {!compact && (
        <div className="mb-2 flex flex-wrap items-baseline gap-3">
          <h2 className="text-sm font-bold uppercase tracking-wider text-text-muted">
            Pad sequence
          </h2>
          <span className="text-[11px] text-gray-600">
            read off the stand, not a script — a tank you filled by hand counts
          </span>
        </div>
      )}

      {!hasEngine && (
        <p className="mb-2 rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-[12px] leading-relaxed text-amber-300">
          No engine is attached to this stand. Without one the chamber is a
          boundary: the tanks will load and press, but Fire lights nothing. Pick
          an engine in the Library tab.
        </p>
      )}

      <div className={`bg-card rounded-lg border border-gray-800 ${compact ? 'flex flex-wrap items-center gap-x-5 gap-y-1 px-3 py-1.5' : 'px-4 py-3'}`}>
        {compact && (
          <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted">Sequence</span>
        )}
        <ol className={`flex flex-wrap ${compact ? 'gap-x-3 gap-y-1' : 'gap-x-5 gap-y-2'}`}>
          {phases.map((p, i) => {
            const state = i < index ? 'done' : i === index ? 'active' : 'pending';
            return (
              <li
                key={p.key}
                className={`flex items-center gap-1.5 text-[12px] ${
                  state === 'done'
                    ? 'text-green-400'
                    : state === 'active'
                      ? 'font-semibold text-white'
                      : 'text-gray-600'
                }`}
              >
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    state === 'done'
                      ? 'bg-green-500'
                      : state === 'active'
                        ? 'bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.9)]'
                        : 'bg-gray-700'
                  }`}
                />
                {p.label}
              </li>
            );
          })}
        </ol>

        {sagged.length > 0 && (
          <p className="mt-2 text-[12px] text-amber-300">
            Since the stand was committed: {sagged.map((p) => p.label.toLowerCase()).join(', ')}{' '}
            {sagged.length === 1 ? 'has' : 'have'} dropped below the mark. Fire as it
            stands, or Vent and go round again.
          </p>
        )}

        <div className={`flex flex-wrap items-center gap-3 ${compact ? '' : 'mt-3'}`}>
          {current === undefined ? (
            <span className="text-[12px] text-green-300">
              Sequence complete — the stand is in {live.state}.
            </span>
          ) : inTarget ? (
            <>
              <span className="text-[12px] text-text">
                {current.key === 'fire' ? 'Burning.' : `In ${live.state}: ${current.waiting}.`}
              </span>
              {progress !== undefined && (
                <span className="flex items-center gap-2">
                  <span className="relative h-1.5 w-40 overflow-hidden rounded bg-black/50">
                    <span
                      className="absolute inset-y-0 left-0 rounded bg-blue-500 transition-[width] duration-200"
                      style={{ width: `${Math.min(Math.max(progress, 0), 1) * 100}%` }}
                    />
                  </span>
                  <span className="font-mono text-[11px] tabular-nums text-text-muted">
                    {fixed(Math.min(progress, 1) * 100, 0)}%
                  </span>
                </span>
              )}
            </>
          ) : hop ? (
            <>
              <span className="text-[12px] text-text-muted">
                Next, to {current.label.toLowerCase()}:
              </span>
              <button
                type="button"
                disabled={!legal || live.computing}
                onClick={() => go(hop)}
                title={legal ? undefined : `${hop} is not reachable from ${live.state} right now`}
                className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-all ${
                  current.key === 'fire'
                    ? 'bg-red-700 text-white hover:bg-red-600'
                    : 'bg-blue-600 text-white hover:bg-blue-500'
                } disabled:cursor-not-allowed disabled:bg-gray-800 disabled:text-gray-500`}
              >
                {hop}
                {hop !== current.target && (
                  <span className="ml-1.5 font-normal text-blue-200/80">→ {current.target}</span>
                )}
              </button>
            </>
          ) : (
            <span className="text-[12px] text-amber-300">
              No legal route from {live.state} to {current.target} without an abort or a
              vent. Take the stand back by hand.
            </span>
          )}

          {current !== undefined && current.key !== 'fire' && (
            <label className="ml-auto flex items-center gap-1.5 text-[11px] text-text-muted">
              <input
                type="checkbox"
                checked={auto}
                onChange={(e) => setAuto(e.target.checked)}
                className="accent-blue-500"
              />
              Run the sequence to Ready
            </label>
          )}
        </div>
      </div>
    </section>
  );
}
