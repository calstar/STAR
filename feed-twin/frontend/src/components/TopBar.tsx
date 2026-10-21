/**
 * The header: the brand and the views on one line, the stand's vital signs on
 * the next.
 *
 * The pressure bars and the FIRE / abort stack used to live here, on every
 * view. They are the Console's now -- it is the one view an operator runs the
 * stand from -- but the abort is not: every other view keeps the state and an
 * ENG ABORT on the status line, because whatever page somebody is reading
 * when a tank climbs, the way out has to be one click from it.
 *
 * The slot the DAQ gives the board connection carries the solver's health,
 * since a twin has no board: running, paused, slow motion and by how much,
 * a step that keeps missing, or stopped on an overpressure.
 *
 * Hotbench is the suite (a STAR project); this app is its Twin. The left end
 * is the suite's switcher (lib/stardesign-ui), the same in every app.
 */

import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { SuiteSwitcher } from '@stardesign-ui';
import { getVersion, type Validation } from '../api';
import { checksToFix } from '../lib/checks';
import { useStand } from '../stand';
import { useHookup } from '../lib/useHookup';
import { StandBar } from './StandBar';

/** The tabs that edit the hookup's one draft. */
const HOOKUP_VIEWS = new Set(['/pid', '/statemachine', '/gse']);

export interface View {
  group: string;
  path: string;
  label: string;
  hint: string;
}

/** Time-warp settings: real time, and two speeds for waiting out the pad. */
const WARPS = [1, 5, 20] as const;

/** The stand clock: how long this stand has been up, mm:ss (h:mm:ss past an
 *  hour). Not "T+": to a rocket team that counts from ignition, and the stand
 *  was opened long before anyone fired it. */
export function elapsed(t: number): string {
  const whole = Math.max(Math.floor(t), 0);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const sec = whole % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

/** Consecutive ticks a step may miss convergence before the status line says
 *  so. One miss is a stiff step the next one recovers from -- every cold load
 *  had a few, and the bar flashed red "solver struggling" at an operator for
 *  nothing. Five ticks is about a second of a step that keeps failing. */
const STRUGGLING_TICKS = 5;

/** How many ticks in a row the solver has not converged. */
function useMissedSteps(live: ReturnType<typeof useStand>['live']): number {
  const [missed, setMissed] = useState(0);
  const seen = useRef('');
  useEffect(() => {
    if (!live) {
      seen.current = '';
      setMissed(0);
      return;
    }
    const stamp = `${live.id}:${live.t}`;
    if (stamp === seen.current) return;
    seen.current = stamp;
    setMissed((m) => (live.converged ? 0 : m + 1));
  }, [live]);
  return missed;
}

/** What the solver is doing, in the words the status line uses, and the dot. */
export function health(
  stand: Pick<ReturnType<typeof useStand>, 'live' | 'busy' | 'running' | 'speed' | 'warp' | 'noStand'>,
  missed = 0,
): { text: string; dot: string; pulse: boolean; title: string; ratio: string; slowStep: boolean } {
  const { live, busy, running, speed, noStand } = stand;
  const none = { ratio: '', slowStep: false };
  if (live?.tripped) return { text: 'Stopped · overpressure', dot: 'var(--color-danger)', pulse: true, title: live.tripped, ...none };
  if (!live) {
    if (noStand?.kind === 'empty') return { text: 'No stand', dot: 'var(--ink-3)', pulse: false, title: 'The library holds no drawing yet', ...none };
    if (noStand?.kind === 'failed') return { text: 'No stand', dot: 'var(--ink-3)', pulse: false, title: noStand.reason, ...none };
    if (noStand?.kind === 'unreachable') return { text: 'Offline', dot: 'var(--ink-3)', pulse: false, title: noStand.reason, ...none };
    return { text: 'Starting', dot: 'var(--ink-3)', pulse: true, title: 'Opening the stand', ...none };
  }
  if (busy) return { text: 'Starting', dot: 'var(--ink-3)', pulse: true, title: 'Opening the stand', ...none };
  if (!running) return { text: 'Paused', dot: 'var(--ink-3)', pulse: false, title: 'The sim clock is stopped', ...none };
  const slow = speed !== undefined && speed < 0.85 * stand.warp;
  const slowStep = missed >= STRUGGLING_TICKS;
  return {
    text: 'Running',
    dot: 'var(--color-success)',
    pulse: false,
    ratio: slow || stand.warp > 1 ? `×${speed.toFixed(speed < 1 ? 2 : 1)}` : '',
    slowStep,
    title: slow
      ? `Slow motion: ${speed.toFixed(2)} stand seconds per wall second. The stand is too stiff to integrate in real time at the study's step; it runs slower rather than coarser.`
      : stand.warp > 1
        ? `Time warp: ${speed.toFixed(1)} stand seconds per wall second.`
        : 'Integrating in real time',
  };
}

/** What this build of the twin has been checked against, for the Checks
 *  tab's hover. It used to be a grey "not validated" chip on every view. */
function useValidation(): string {
  const [validation, setValidation] = useState<Validation | null>(null);
  useEffect(() => {
    getVersion()
      .then((v) => setValidation(v.validation))
      .catch(() => undefined);
  }, []);
  if (!validation) return '';
  return [
    validation.label,
    'Checked:',
    ...validation.checked.map((c) => `  • ${c}`),
    'Not yet checked:',
    ...validation.not_checked.map((c) => `  • ${c}`),
  ].join('\n');
}

export function TopBar({ views }: { views: readonly View[] }) {
  const stand = useStand();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { live, model, busy } = stand;
  // Only what is worth fixing: most of the assembly's sentences say how the
  // drawing was read (lib/checks.ts).
  const warnings = checksToFix(model?.report.warnings ?? []);
  const validation = useValidation();

  const [clock, setClock] = useState('');
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString('en-US', { hour12: true }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // An unsaved hookup is one draft across three tabs: say so on each, so an
  // edit made on one is not forgotten on the way to another.
  const { dirty: unsavedHookup } = useHookup();
  const missed = useMissedSteps(live);
  const h = health(stand, missed);
  const state = live?.state ?? '—';
  const onConsole = pathname === '/';
  const engineName = stand.artifacts.find((a) => a.id === stand.where.engine)?.name ?? '';
  const title = model ? model.title : '';
  // Only when the cut left something out: on a drawing of the rocket alone
  // the setting changes nothing, and the badge said otherwise.
  const cut = live?.setup?.ignore_gse ? (model?.ground_cut ?? []) : [];
  const rocketOnly = cut.length > 0;
  // The gas in the bottle, always: swapped, or the drawing's own. The drawing's
  // is named when the server says which it is (`gas`).
  const swapped = String(live?.setup?.pressurant ?? '');
  const gasName = (g: string) => (/^he/i.test(g) ? 'Helium' : /n2|nitrogen/i.test(g) ? 'GN2' : g);
  const gas = swapped ? gasName(swapped) : live?.gas ? `${gasName(live.gas)} · drawing's` : live ? "Drawing's gas" : '';
  const norm = (g: string) => (/^he/i.test(g) ? 'helium' : /n2|nitrogen/i.test(g) ? 'nitrogen' : '');
  const drawnGas = norm(String(live?.gas ?? ''));
  const effective = norm(swapped) || drawnGas;
  // A LOX tank on the stand: by its tag, or by a cryogenic liquid in it.
  const hasLox = (live?.tanks ?? []).some(
    (t) => /lox|oxid/i.test(t.label) || (t.liquid_mass_kg > 0 && t.liquid_temperature_K < 130),
  );
  // Mid-burn the stand is not swapped out from under the operator.
  const running = /fire/i.test(String(live?.state ?? ''));
  const groups = views.reduce<{ name: string; views: View[] }[]>((out, v) => {
    const last = out[out.length - 1];
    if (last && last.name === v.group) last.views.push(v);
    else out.push({ name: v.group, views: [v] });
    return out;
  }, []);

  return (
    <header className="relative z-30 flex-shrink-0 select-none border-b border-[var(--line)] px-8 pt-3 max-[1400px]:px-5">
      <div className="flex min-w-0 flex-nowrap items-center gap-7 max-[1400px]:gap-5">
        {/* The suite's own end of the header, the same in every Hotbench
            app: the wordmark and Engine | P&ID | Twin. Twin goes to the Console.
            A hairline keeps its P&ID and Engine apart from this app's tabs. */}
        <SuiteSwitcher
          app="twin"
          onHome={() => navigate('/')}
          className="border-r border-[var(--line)] pb-1.5 pr-7 font-mono max-[1400px]:pr-5"
        />
        {/* Below ~1330 px (a 1280 projector) the tabs no longer fit even
            tightened: the nav scrolls on its own rather than the page
            sideways, which put Checks off screen. */}
        <nav className="flex min-w-0 flex-nowrap items-baseline gap-x-4 self-end overflow-x-auto [scrollbar-width:none] max-[1400px]:gap-x-3 min-[1600px]:gap-x-5">
          {groups.map((g, i) => (
            <span
              key={g.name}
              className={`flex flex-shrink-0 items-baseline gap-x-3.5 max-[1400px]:gap-x-2.5 min-[1600px]:gap-x-4 ${i > 0 ? 'border-l border-[var(--line)] pl-4 max-[1400px]:pl-3 min-[1600px]:pl-5' : ''}`}
            >
              {/* The group's name where there is room; the divider says it
                  on a laptop, where the names wrapped the nav onto two rows. */}
              <span className="caps hidden pb-1.5 text-[9px] text-[var(--ink-4)] min-[1700px]:inline">{g.name}</span>
              {g.views.map((v) => {
                const active = pathname === v.path;
                const hint = v.path === '/report' && validation ? `${v.hint}\n\n${validation}` : v.hint;
                return (
                  <Link
                    key={v.path}
                    to={v.path}
                    title={hint}
                    className={`relative flex-shrink-0 whitespace-nowrap pb-1.5 font-mono text-[13px] tracking-[0.04em] transition-colors ${
                      active ? 'text-[var(--ink)]' : 'text-[var(--ink-3)] hover:text-[var(--ink-2)]'
                    }`}
                  >
                    {v.label}
                    {unsavedHookup && HOOKUP_VIEWS.has(v.path) && (
                      <span
                        className="ml-1 text-[var(--color-warning)]"
                        title="Unsaved hookup: save it on the P&ID, State machine or GSE Controls tab"
                      >
                        •
                      </span>
                    )}
                    {v.path === '/report' && warnings > 0 && (
                      <span className="ml-1.5 font-mono text-[10px] text-[var(--color-warning)]">{warnings}</span>
                    )}
                    {active && <span className="absolute inset-x-0 bottom-0 h-px bg-[var(--ink)]" />}
                  </Link>
                );
              })}
            </span>
          ))}
        </nav>
      </div>

      {/* One row, never wrapped: the drawing's name gives way first (it
          truncates, whole on its hover), then the wall clock below 1600 px. */}
      <div className="flex min-h-[44px] flex-nowrap items-center gap-x-6 py-2 font-mono text-[13px] uppercase tracking-[0.08em]">
        <span className="flex flex-shrink-0 items-center gap-2 text-[var(--ink-2)]" title={h.title}>
          <span
            className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${h.pulse ? 'animate-pulse' : ''}`}
            style={{ background: h.dot }}
          />
          {h.text}
          {/* The speed has its own slot, held open whether or not there is a
              ratio to show: appearing at Fire, it shoved every item along. */}
          <span className="inline-block w-[4.2em] tabular-nums normal-case tracking-normal text-[var(--ink-3)]">
            {h.ratio}
          </span>
          {h.slowStep && (
            <span
              className="normal-case tracking-normal text-[var(--ink-3)]"
              title={`The solver has missed convergence on the last ${missed} steps; it keeps going at the study's step and tolerance. If it persists, the Solver tab shows where.`}
            >
              solver: slow step
            </span>
          )}
        </span>
        <span
          className="flex flex-shrink-0 items-center border border-[var(--line)] normal-case tracking-normal"
          title="Time warp: run the stand faster than real time, to wait out a load or a COPV charge. Fire always runs at ×1. The status shows the speed the machine actually reaches."
        >
          {WARPS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => stand.setWarp(w)}
              aria-pressed={stand.warp === w}
              className={`px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${
                stand.warp === w ? 'bg-[var(--ink)] text-black' : 'text-[var(--ink-3)] hover:text-[var(--ink)]'
              }`}
            >
              ×{w}
            </button>
          ))}
        </span>
        {/* The sim clock, not the wall clock: how long this stand has been
            up. It stops when the sim is paused. */}
        <span
          className="flex flex-shrink-0 items-baseline gap-2 font-semibold tabular-nums text-[var(--ink)]"
          title="Sim time: how long this stand has run since it was opened. It stops while paused and runs faster under time warp."
        >
          <span className="caps text-[10px] font-normal">Sim</span>
          {elapsed(live?.t ?? 0)}
        </span>
        <span className="hidden flex-shrink-0 tabular-nums text-[var(--ink-3)] min-[1600px]:inline" title="Wall clock">
          {clock}
        </span>
        {title && (
          <span
            className="min-w-0 truncate normal-case tracking-normal text-[var(--ink-2)]"
            title={`Drawing: ${title}${engineName ? `\nEngine: ${engineName}${model?.engine?.engine_model === 'simplified' ? " (feedtwin's simplified engine)" : ''}` : '\nNo engine'}`}
          >
            {title}
            {engineName && <span className="text-[var(--ink-3)]"> · {engineName}</span>}
          </span>
        )}
        {rocketOnly && (
          <Link
            to="/gse"
            className="flex-shrink-0 border border-[var(--line-strong)] px-2 py-0.5 text-[10px] tracking-[0.14em] text-[var(--ink-2)] hover:text-[var(--ink)]"
            title={`The drawn GSE is ignored: the rocket alone, filled by the built-in fills at the GSE Controls settings. Left out: ${cut.join(', ')} and the rest of the cart. Change it on GSE Controls.`}
          >
            Rocket only
          </Link>
        )}
        {gas && (
          // One click between the two gases, from any page: the team compares
          // helium and nitrogen on the same drawing (the user, 2026-10-20). The
          // drawing's own gas is marked; a swap opens a fresh stand, and each
          // burn's run record says which gas it ran on, so Runs compares them.
          <div
            role="group"
            aria-label="Pressurant"
            className="flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap text-[10px] tracking-[0.14em]"
            title={
              effective === 'nitrogen' && hasLox
                ? 'GN2 over LOX: nitrogen condenses into the LOX and on the cold wall above about 52 psia, which the twin does not model, so tank pressure and gas use read optimistic. Switching opens a fresh stand.'
                : "The gas in the bottles and press lines. The dot marks the drawing's own. Switching opens a fresh stand."
            }
          >
            <div className="flex overflow-hidden border border-[var(--line-strong)]">
              {(['nitrogen', 'helium'] as const).map((g) => {
                const on = effective === g;
                const drawn = drawnGas === g;
                return (
                  <button
                    key={g}
                    type="button"
                    aria-pressed={on}
                    disabled={stand.locked || (!on && running)}
                    onClick={() => !on && stand.setSetup({ pressurant: drawn ? '' : g })}
                    className={`px-2 py-0.5 disabled:opacity-50 ${
                      on ? 'bg-white/10 text-[var(--ink)]' : 'text-[var(--ink-3)] hover:text-[var(--ink)]'
                    }`}
                  >
                    {g === 'helium' ? 'HE' : 'GN2'}
                    {drawn ? <span aria-label=" (the drawing's)"> ·</span> : null}
                  </button>
                );
              })}
            </div>
            {effective === 'nitrogen' && hasLox ? (
              <span className="text-[var(--color-warning)]" aria-hidden>
                ⚠
              </span>
            ) : null}
          </div>
        )}

        <div className="ml-auto flex flex-shrink-0 items-center gap-4 normal-case tracking-normal">
          <StandBar />
          {!onConsole && (
            <span className="flex items-center gap-3 border-l border-[var(--line)] pl-4">
              <span className="caps text-[11px]">State</span>
              <span className="font-mono text-[13px] font-bold uppercase tracking-[0.12em] text-[var(--ink)]">
                {state}
              </span>
              <button
                type="button"
                onClick={() => stand.go('Engine Abort')}
                disabled={busy || !live}
                className="ctl h-7 border-[var(--color-danger)] px-3 text-[11px] text-[var(--color-danger)] hover:bg-[var(--color-danger-solid)] hover:text-white"
              >
                Eng Abort
              </button>
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
