/**
 * The stand's top bar, laid out like the DAQ's.
 *
 * Same regions in the same places: brand and clock on the left, the pressure
 * bars filling the middle, state and the abort stack on the right. An operator
 * who knows where to look on the real software knows where to look here, which
 * is the entire argument for not designing this screen freshly.
 *
 * Two things differ, and both are because this is a twin rather than a stand.
 * There is no connection state to a board, so that slot carries the solver's
 * instead — converged or not, and how long it took. And FIRE is a button that
 * runs a burn rather than a state you sit in, because nothing here is burning
 * propellant while you look at it.
 */

import { useEffect, useState } from 'react';
import PressureBar from './PressureBar';
import { limitsFor, type Channel, type SessionState } from '../api';

/** Colours the DAQ gives particular states. */
const STATE_COLOR: Record<string, string> = {
  Fire: 'text-red-400',
  'Engine Abort': 'text-red-500',
  'GSE Abort': 'text-red-500',
  'Emergency Abort': 'text-red-500',
  Vent: 'text-yellow-400',
  Ready: 'text-green-400',
  Armed: 'text-blue-400',
  Idle: 'text-gray-400',
};

interface Props {
  live: SessionState | null;
  onState: (next: string) => void;
  onAbort: () => void;
  running: boolean;
  onRunning: (on: boolean) => void;
  onRestart: () => void;
  busy: boolean;
  /** Stand seconds per wall second; shown when the solver is not keeping up. */
  speed?: number;
  channels: Channel[];
  hidden: Record<string, boolean>;
  onToggleChannel: (id: string) => void;
  title: string;
}

/** Mission time, the way a pad clock reads it. */
function elapsed(t: number): string {
  const whole = Math.max(Math.floor(t), 0);
  const m = Math.floor(whole / 60);
  const sec = whole % 60;
  return `T+${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function TopBar({
  live,
  onState,
  onAbort,
  running,
  onRunning,
  onRestart,
  busy,
  speed,
  channels,
  hidden,
  onToggleChannel,
  title,
}: Props) {
  const [clock, setClock] = useState('');
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString('en-US', { hour12: true }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const state = live?.state ?? '—';
  const converged = live?.converged ?? false;
  const computing = live?.computing ?? false;
  const replaying = live?.replaying ?? false;
  const progress = Math.round((live?.progress ?? 0) * 100);
  const stateColor = STATE_COLOR[state] ?? 'text-text';
  const reachable = live?.reachable ?? [];

  return (
    <div
      className="relative z-30 bg-card border-b border-gray-800 select-none flex-shrink-0"
      style={{ height: '18vh', minHeight: 176, maxHeight: 260 }}
    >
      <div className="flex items-stretch h-full px-4 gap-2 py-2">
        {/* Left: brand, solver health, clock, what is loaded */}
        <div className="flex flex-col justify-start gap-1 flex-shrink-0 pr-3 border-r border-gray-800/60">
          <span className="text-3xl font-bold tracking-widest text-blue-400 uppercase leading-none">
            FEED TWIN
          </span>
          <div className="flex items-center gap-2">
            <div
              className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                live?.tripped
                  ? 'bg-red-500 animate-pulse'
                  : busy || computing
                  ? 'bg-yellow-500 animate-pulse'
                  : replaying
                    ? 'bg-blue-400'
                    : converged
                      ? 'bg-green-500'
                      : 'bg-red-500'
              }`}
            />
            <span className="text-sm text-gray-300 font-semibold">
              {live?.tripped
                ? 'Stopped, overpressure'
                : busy
                ? 'Starting'
                : computing
                  ? `Running sim… ${progress}%`
                  : !running
                    ? 'Paused'
                    : replaying
                      ? 'Replaying'
                      : converged
                        ? speed !== undefined && speed < 0.85
                          ? `Running, slow motion ×${speed.toFixed(2)}`
                          : 'Running'
                        : 'Solver struggling'}
            </span>
          </div>
          {/* Mission time, not wall clock: what matters is how long this stand
              has been up, and it stops when the sim is paused. */}
          <span className="text-2xl font-mono text-white tabular-nums font-bold leading-tight">
            {elapsed(live?.t ?? 0)}
          </span>
          <span className="text-[11px] font-mono text-gray-500 tabular-nums">{clock}</span>
          <span className="text-xs text-gray-500 truncate max-w-[220px]">{title}</span>
        </div>

        {/* Centre: the bars. Click one to silence its trace, as on the DAQ. */}
        <div
          className="flex-[2] flex items-stretch justify-end gap-4 sm:gap-6 lg:gap-8 min-w-0"
          style={{ maxWidth: '62vw' }}
        >
          {/* Pressure bars only. A thermocouple in a bar scaled to MEOP is
              meaningless -- temperature lives in its own panel on Plots. */}
          {channels.filter((c) => (c.unit || 'psig') === 'psig').map((c) => {
            const { nop, meop } = limitsFor(c.tag);
            const silent = hidden[c.id];
            const value = live?.pressure_psi[c.id];
            return (
              <button
                key={c.id}
                type="button"
                title={silent ? 'Show on the plot' : 'Hide from the plot'}
                onClick={() => onToggleChannel(c.id)}
                className={`min-w-0 h-full flex-1 text-left rounded-lg transition-opacity hover:opacity-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/80 ${
                  silent ? 'opacity-45' : 'opacity-100'
                }`}
                style={{ minWidth: '6%', maxWidth: '14%' }}
              >
                <PressureBar
                  label={c.tag.replace(/^PT-/, '')}
                  value={value ?? null}
                  nop={nop}
                  meop={meop}
                  compact
                />
              </button>
            );
          })}
        </div>

        {/* Right: state, transitions, fire and abort */}
        <div className="w-full max-w-[420px] min-w-[300px] flex items-stretch justify-between gap-2 flex-shrink-0 pl-3 border-l border-gray-800/60 ml-auto">
          <div className="flex flex-col justify-center items-center gap-1 flex-1 min-w-0">
            <span className="text-[10px] xl:text-xs text-gray-400 uppercase tracking-widest font-bold">
              State
            </span>
            <span
              className={`text-lg xl:text-2xl font-bold font-mono tracking-wider text-center leading-tight ${stateColor}`}
            >
              {state.toUpperCase()}
            </span>
            <select
              value=""
              onChange={(e) => e.target.value && onState(e.target.value)}
              disabled={busy || reachable.length === 0}
              aria-label="Transition to state"
              className="mt-1 w-full rounded-md border border-gray-700 bg-black/60 px-2 py-1 text-[11px] text-gray-200 disabled:opacity-40"
            >
              <option value="">Go to…</option>
              {reachable.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col justify-center gap-2 flex-1 min-w-[8rem] border-l border-gray-800/60 pl-2">
            {/* FIRE is a state you enter, not a canned run you play. It holds
                until you leave it, exactly as the stand does. */}
            <button
              onClick={() => onState('Fire')}
              disabled={busy || !(reachable.includes('Fire') || state === 'Fire')}
              title={
                reachable.includes('Fire')
                  ? 'Go to Fire'
                  : `Fire is not reachable from ${state}`
              }
              className="w-full py-3 xl:py-4 bg-red-700 hover:bg-red-600 active:bg-red-800 border border-red-500
                         text-white font-bold text-xs xl:text-sm rounded-xl tracking-widest transition-colors
                         shadow-[0_0_6px_rgba(239,68,68,0.4)] disabled:bg-gray-800 disabled:border-gray-700
                         disabled:text-gray-500 disabled:shadow-none disabled:cursor-not-allowed"
            >
              FIRE
            </button>
            <button
              onClick={onAbort}
              disabled={busy}
              className="w-full py-2 xl:py-3 bg-amber-800 hover:bg-amber-700 active:bg-amber-900 border border-amber-600
                         text-white font-semibold text-[10px] xl:text-xs rounded-xl tracking-wider transition-colors
                         disabled:opacity-50 disabled:cursor-not-allowed"
            >
              ENG ABORT
            </button>
            <div className="grid grid-cols-2 gap-1">
              <button
                onClick={() => onRunning(!running)}
                className="rounded-lg border border-gray-700 bg-gray-900 py-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-300 hover:bg-gray-800"
              >
                {running ? 'Pause' : 'Run'}
              </button>
              <button
                onClick={onRestart}
                title="Empty the tanks and start over"
                className="rounded-lg border border-gray-700 bg-gray-900 py-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-300 hover:bg-gray-800"
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
