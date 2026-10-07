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
import { useStand } from '../stand';
import { StandBar } from './StandBar';

export interface View {
  path: string;
  label: string;
  hint: string;
}

/** Mission time, the way a pad clock reads it. */
export function elapsed(t: number): string {
  const whole = Math.max(Math.floor(t), 0);
  const m = Math.floor(whole / 60);
  const sec = whole % 60;
  return `T+${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** What the solver is doing, in the words the status line uses, and the dot. */
function health(stand: ReturnType<typeof useStand>): { text: string; dot: string; pulse: boolean; title: string } {
  const { live, busy, running, speed } = stand;
  if (live?.tripped) return { text: 'Stopped · overpressure', dot: 'var(--color-danger)', pulse: true, title: live.tripped };
  if (busy) return { text: 'Starting', dot: 'var(--color-warning)', pulse: true, title: 'Opening the stand' };
  if (live?.computing) {
    const pct = Math.round((live.progress ?? 0) * 100);
    return { text: `Running sim · ${pct}%`, dot: 'var(--color-warning)', pulse: true, title: 'Integrating ahead for replay' };
  }
  if (!running) return { text: 'Paused', dot: 'var(--ink-3)', pulse: false, title: 'The stand clock is stopped' };
  if (live?.replaying) return { text: 'Replaying', dot: 'var(--ink)', pulse: false, title: 'Playing back a run integrated ahead' };
  if (!(live?.converged ?? false)) {
    return { text: 'Solver struggling', dot: 'var(--color-danger)', pulse: false, title: 'The last step did not converge' };
  }
  const slow = speed !== undefined && speed < 0.85;
  return {
    text: slow ? `Running · ×${speed.toFixed(2)}` : 'Running',
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
  return (
    <span
      className="border px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-[0.18em]"
      style={{
        borderColor: ok ? 'var(--color-success)' : 'var(--color-warning)',
        color: ok ? 'var(--color-success)' : 'var(--color-warning)',
      }}
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
      {validation.status}
    </span>
  );
}

export function TopBar({ views }: { views: readonly View[] }) {
  const stand = useStand();
  const { pathname } = useLocation();
  const { live, model, busy } = stand;
  const warnings = model?.report.warnings.length ?? 0;

  const [clock, setClock] = useState('');
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString('en-US', { hour12: true }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const h = health(stand);
  const state = live?.state ?? '—';
  const onConsole = pathname === '/';
  const title = model ? `${model.title}${model.report.coupled ? ' · coupled' : ''}` : '—';

  return (
    <header className="relative z-30 flex-shrink-0 select-none border-b border-[var(--line)] px-8 pt-4">
      <div className="flex min-w-0 items-baseline gap-10">
        <span className="flex-shrink-0 font-mono text-[17px] font-bold uppercase tracking-[0.42em] text-[var(--ink)]">
          Feed Twin
        </span>
        <nav className="flex min-w-0 items-baseline gap-x-6 gap-y-1 overflow-x-auto">
          {views.map((v) => {
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
                {v.path === '/report' && warnings > 0 && (
                  <span className="ml-1.5 font-mono text-[10px] text-[var(--color-warning)]">{warnings}</span>
                )}
                {active && <span className="absolute inset-x-0 bottom-0 h-px bg-[var(--ink)]" />}
              </Link>
            );
          })}
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
        {/* Mission time, not wall clock: how long this stand has been up. It
            stops when the sim is paused. */}
        <span className="font-semibold tabular-nums text-[var(--ink)]" title="Stand time since it was opened">
          {elapsed(live?.t ?? 0)}
        </span>
        <span className="tabular-nums text-[var(--ink-3)]">{clock}</span>
        <span className="max-w-[260px] truncate text-[var(--ink-2)]" title={title}>
          {title}
        </span>
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
