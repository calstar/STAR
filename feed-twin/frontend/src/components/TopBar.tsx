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
 * struggling, or stopped on an overpressure.
 */

import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
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

/** What the solver is doing, in the words the status line uses, and the dot. */
function health(stand: ReturnType<typeof useStand>): { text: string; dot: string; pulse: boolean; title: string } {
  const { live, busy, running, speed } = stand;
  if (live?.tripped) return { text: 'Stopped · overpressure', dot: 'var(--color-danger)', pulse: true, title: live.tripped };
  if (busy) return { text: 'Starting', dot: 'var(--color-warning)', pulse: true, title: 'Opening the stand' };
  if (!running) return { text: 'Paused', dot: 'var(--ink-3)', pulse: false, title: 'The stand clock is stopped' };
  if (!(live?.converged ?? false)) {
    return { text: 'Solver struggling', dot: 'var(--color-danger)', pulse: false, title: 'The last step did not converge' };
  }
  const slow = speed !== undefined && speed < 0.85 * stand.warp;
  return {
    text: slow || stand.warp > 1 ? `Running · ×${speed.toFixed(speed < 1 ? 2 : 1)}` : 'Running',
    dot: 'var(--color-success)',
    pulse: false,
    title: slow
      ? `Slow motion: ${speed.toFixed(2)} stand seconds per wall second. The stand is too stiff to integrate in real time at the study's step; it runs slower rather than coarser.`
      : 'Integrating in real time',
  };
}

function ValidationBadge() {
  const [validation, setValidation] = useState<Validation | null>(null);
  useEffect(() => {
    getVersion()
      .then((v) => setValidation(v.validation))
      .catch(() => undefined);
  }, []);
  if (!validation) return null;
  const ok = validation.status === 'validated';
  // Quiet on purpose: it says what this build of the twin has been checked
  // against, which matters when reading a result, not every second of a run.
  return (
    <span
      className="cursor-help font-mono text-[11px] normal-case tracking-normal"
      style={{ color: ok ? 'var(--color-success)' : 'var(--ink-3)' }}
      title={[
        validation.label,
        '',
        'Checked:',
        ...validation.checked.map((c) => `  • ${c}`),
        '',
        'Not yet checked:',
        ...validation.not_checked.map((c) => `  • ${c}`),
      ].join('\n')}
    >
      {ok ? 'validated' : 'not validated'}
    </span>
  );
}

export function TopBar({ views }: { views: readonly View[] }) {
  const stand = useStand();
  const { pathname } = useLocation();
  const { live, model, busy } = stand;
  // Only what is worth fixing: most of the assembly's sentences say how the
  // drawing was read (lib/checks.ts).
  const warnings = checksToFix(model?.report.warnings ?? []);

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
  const h = health(stand);
  const state = live?.state ?? '—';
  const onConsole = pathname === '/';
  const engineName = stand.artifacts.find((a) => a.id === stand.where.engine)?.name ?? '';
  const title = model ? (engineName ? `${model.title} · ${engineName}` : model.title) : '—';
  // Only when the cut left something out: on a drawing of the rocket alone
  // the setting changes nothing, and the badge said otherwise.
  const cut = live?.setup?.ignore_gse ? (model?.ground_cut ?? []) : [];
  const rocketOnly = cut.length > 0;
  const groups = views.reduce<{ name: string; views: View[] }[]>((out, v) => {
    const last = out[out.length - 1];
    if (last && last.name === v.group) last.views.push(v);
    else out.push({ name: v.group, views: [v] });
    return out;
  }, []);

  return (
    <header className="relative z-30 flex-shrink-0 select-none border-b border-[var(--line)] px-8 pt-4">
      <div className="flex min-w-0 items-baseline gap-8">
        <span className="flex-shrink-0 font-mono text-[17px] font-bold uppercase tracking-[0.42em] text-[var(--ink)]">
          Feed Twin
        </span>
        <nav className="flex min-w-0 flex-wrap items-baseline gap-x-5 gap-y-1">
          {groups.map((g, i) => (
            <span
              key={g.name}
              className={`flex flex-shrink-0 items-baseline gap-x-3.5 min-[1400px]:gap-x-4 ${i > 0 ? 'border-l border-[var(--line)] pl-4 min-[1400px]:pl-5' : ''}`}
            >
              {/* The group's name where there is room; the divider says it
                  on a laptop, where the names wrapped the nav onto two rows. */}
              <span className="caps hidden pb-1.5 text-[9px] text-[var(--ink-4)] min-[1400px]:inline">{g.name}</span>
              {g.views.map((v) => {
                const active = pathname === v.path;
                return (
                  <Link
                    key={v.path}
                    to={v.path}
                    title={v.hint}
                    className={`relative flex-shrink-0 whitespace-nowrap pb-1.5 font-mono text-[13px] tracking-[0.06em] transition-colors ${
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

      <div className="flex min-h-[44px] flex-wrap items-center gap-x-7 gap-y-1 py-2 font-mono text-[13px] uppercase tracking-[0.08em]">
        <span className="flex items-center gap-2 text-[var(--ink-2)]" title={h.title}>
          <span
            className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${h.pulse ? 'animate-pulse' : ''}`}
            style={{ background: h.dot }}
          />
          {h.text}
        </span>
        <span
          className="flex items-center border border-[var(--line)] normal-case tracking-normal"
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
        {/* The stand clock, not the wall clock: how long this stand has been
            up. It stops when the sim is paused. */}
        <span
          className="flex items-baseline gap-2 font-semibold tabular-nums text-[var(--ink)]"
          title="Stand clock: time since this stand was opened. It stops while paused."
        >
          <span className="caps text-[10px] font-normal">Stand</span>
          {elapsed(live?.t ?? 0)}
        </span>
        <span className="tabular-nums text-[var(--ink-3)]" title="Wall clock">
          {clock}
        </span>
        <span
          className="max-w-[340px] truncate normal-case tracking-normal text-[var(--ink-2)]"
          title={`Drawing · engine${model?.engine?.engine_model === 'simplified' ? " (feedtwin's simplified engine)" : ''}`}
        >
          {title}
        </span>
        {rocketOnly && (
          <Link
            to="/gse"
            className="border border-[var(--line-strong)] px-2 py-0.5 text-[10px] tracking-[0.14em] text-[var(--ink-2)] hover:text-[var(--ink)]"
            title={`The drawn GSE is ignored: the rocket alone, filled by the built-in fills at the GSE Controls settings. Left out: ${cut.join(', ')} and the rest of the cart. Change it on GSE Controls.`}
          >
            Rocket only
          </Link>
        )}
        <ValidationBadge />

        <div className="ml-auto flex items-center gap-4 normal-case tracking-normal">
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
                disabled={busy}
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
