'use client'

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { useControlMode } from '@/lib/control-mode';
import { MessageType, type SessionStartBlockedPayload } from '@/lib/types';
import { groupIssuesByPage, type ConfigIssue } from '@/lib/config-validation';

function formatRemaining(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '--:--:--';
  if (ms <= 0) return '00:00:00';
  const totalSecs = Math.floor(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}`;
}

function formatGB(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  return `${(bytes / 1e9).toFixed(1)} GB free`;
}

/**
 * The config problems that refused this run, grouped by the editor page that fixes each one.
 *
 * Everything shown here was decided by the backend: it validated the profile it was about to
 * deploy, refused to start anything, and sent this list. Nothing on this page re-derives, filters
 * or ranks it — the whole point is that the browser is not the thing deciding whether a config is
 * fit to run. Pressing Start again sends `force`, which is the operator overruling it on purpose.
 */
function ConfigIssuePanel({ blocked }: { blocked: SessionStartBlockedPayload }) {
  const groups = groupIssuesByPage(blocked.issues as ConfigIssue[]);
  const counts = [
    blocked.errors ? `${blocked.errors} error${blocked.errors === 1 ? '' : 's'}` : null,
    blocked.warnings ? `${blocked.warnings} warning${blocked.warnings === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' and ');

  return (
    <div className="rounded-xl border border-red-700/70 bg-red-950/30 p-5 mb-6">
      <h2 className="text-xl font-semibold text-red-200 mb-1">Run not started — check the config</h2>
      <p className="text-sm text-red-200/80 mb-4">
        Config profile <strong>{blocked.profile}</strong> has {counts}. Nothing was started and the
        deployed config is unchanged. Fix these in the config editor, or press{' '}
        <strong>Start anyway</strong> to run this config as it is.
      </p>

      <div className="space-y-4">
        {groups.map((group) => (
          <div key={group.page}>
            <div className="flex items-baseline gap-3 mb-2">
              <h3 className="text-base font-semibold text-white">{group.label}</h3>
              <Link
                to={`/config?tab=${group.page}`}
                className="text-sm text-blue-300 hover:text-blue-200 underline underline-offset-2"
              >
                Open {group.label} →
              </Link>
            </div>
            <ul className="space-y-2">
              {group.issues.map((issue, i) => (
                <li
                  key={`${group.page}-${i}`}
                  className={`flex items-start gap-2 px-3 py-2 rounded-md border text-sm ${
                    issue.level === 'warn'
                      ? 'border-yellow-600/70 bg-yellow-900/25 text-yellow-200'
                      : 'border-red-600/70 bg-red-900/25 text-red-200'
                  }`}
                >
                  <span aria-hidden className="mt-px leading-none">⚠</span>
                  <span className="min-w-0">{issue.message}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function SessionPage() {
  const session = useSensorStore((s) => s.session);
  const { controlEnabled } = useControlMode();
  const ws = getWebSocketClient();

  const [keepData, setKeepData] = useState(true); // Save is the safe default
  const [simulated, setSimulated] = useState(false); // Live data is the safe default
  const [durationMin, setDurationMin] = useState(60);
  const [addMin, setAddMin] = useState(15);

  // While a start/stop is in flight the backend is tearing down / bringing up the
  // pipeline (which now blocks until it's a clean slate). Gate the buttons on this
  // so a rapid stop→start can't race the teardown. Cleared when session.active
  // settles to the expected value, or after a timeout if the command never lands.
  const [pending, setPending] = useState<null | 'start' | 'stop'>(null);
  const active = !!session?.active;
  useEffect(() => {
    if (pending === 'start' && active) setPending(null);
    if (pending === 'stop' && !active) setPending(null);
  }, [pending, active]);

  // The backend refused a start because the profile it was about to deploy has config issues.
  // Holding the payload is also what arms the override: while it is set, Start sends force:true.
  const [blocked, setBlocked] = useState<SessionStartBlockedPayload | null>(null);
  useEffect(() => ws.on(MessageType.SESSION_START_BLOCKED, (payload) => {
    setBlocked(payload as SessionStartBlockedPayload);
    setPending(null); // nothing was started, so stop waiting for a SESSION_UPDATE that won't come
  }), [ws]);
  // A run that did start, or one that stopped, retires the list — it described a start attempt
  // that is over.
  useEffect(() => { if (active) setBlocked(null); }, [active]);
  useEffect(() => {
    if (!pending) return;
    const id = setTimeout(() => setPending(null), 30000); // failsafe
    return () => clearTimeout(id);
  }, [pending]);

  // 1 Hz tick so the live countdown re-renders even when no WS update arrives.
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Recompute every render (the 1 Hz tick above drives re-renders) so the
  // countdown ticks live — do NOT memoize on deadlineMs or it freezes.
  const remainingMs = session?.deadlineMs != null ? session.deadlineMs - Date.now() : null;

  const send = (command: Parameters<typeof ws.sendCommand>[0]) => {
    if (!controlEnabled) return;
    ws.sendCommand(command);
  };

  /**
   * Changing what you are asking for retires the override: the issue list described the *previous*
   * request, and a primed "Start anyway" that outlives it would let a different run slip past the
   * gate on a press the operator thinks is their first. The next press re-asks the backend.
   */
  const resetOverride = () => setBlocked(null);

  // session is null until the first SESSION_UPDATE arrives over the WebSocket.
  // Distinguish "haven't heard yet" from "backend says disabled" — conflating
  // them makes a correctly-configured server look like a launch-site laptop when
  // the real problem is the WebSocket never connected.
  if (!session) {
    return (
      <main className="h-full bg-background text-text overflow-auto p-8">
        <h1 className="text-3xl font-bold mb-3">Session control</h1>
        <p className="text-lg text-gray-200 max-w-2xl leading-relaxed">
          Connecting… (waiting for the backend WebSocket). If this persists, the live data
          connection isn’t reaching the browser.
        </p>
      </main>
    );
  }

  if (!session.enabled) {
    return (
      <main className="h-full bg-background text-text overflow-auto p-8">
        <h1 className="text-3xl font-bold mb-3">Session control</h1>
        <p className="text-lg text-gray-200 max-w-2xl leading-relaxed">
          Session control is disabled in this deployment — the stack runs until the process is
          stopped manually. (This is the expected behavior on a launch-site laptop with no
          server.)
        </p>
      </main>
    );
  }

  const lockedNote = controlEnabled ? undefined : 'Viewer mode: unlock as an operator to control runs.';

  return (
    <main className="h-full bg-background text-text overflow-auto">
      <div className="p-6 sm:p-8 max-w-3xl mx-auto w-full">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Session control</h1>
        <span
          className={`rounded-full px-4 py-1.5 text-base font-bold uppercase tracking-wider ${
            active ? 'bg-green-900/50 text-green-300' : 'bg-gray-800 text-gray-400'
          }`}
        >
          {active ? 'Running' : 'Stopped'}
        </span>
      </div>

      {/* Status card */}
      <div className="rounded-xl border border-gray-800 bg-card p-5 mb-6 grid grid-cols-2 gap-4">
        <div>
          <div className="text-sm uppercase tracking-widest text-gray-300 mb-2">Time remaining</div>
          <div className={`text-3xl font-mono tabular-nums font-bold ${remainingMs != null && remainingMs <= 5 * 60000 ? 'text-red-400' : 'text-white'}`}>
            {active ? formatRemaining(remainingMs) : '—'}
          </div>
        </div>
        <div>
          <div className="text-sm uppercase tracking-widest text-gray-300 mb-2">Disk</div>
          <div className="text-3xl font-mono tabular-nums font-bold text-white">{formatGB(session.freeDiskBytes)}</div>
        </div>
        <div className="col-span-2">
          <div className="text-sm uppercase tracking-widest text-gray-300 mb-2">Run store</div>
          <div className="text-base font-mono text-gray-200 break-all">
            {session.dbDir ?? '—'}
            {active && <span className="ml-2 text-gray-400">({session.keepData ? 'Save' : 'Discard'})</span>}
          </div>
        </div>
      </div>

      {/* Why the last start attempt was refused. Above the controls, because it is the reason the
          button below now says something different. */}
      {!active && blocked && <ConfigIssuePanel blocked={blocked} />}

      {/* Controls */}
      {!active ? (
        <div className="rounded-xl border border-gray-800 bg-card p-5">
          <h2 className="text-xl font-semibold mb-4">Start a run</h2>

          <div className="flex flex-wrap items-end gap-6">
            <div>
              <div className="text-sm uppercase tracking-widest text-gray-300 mb-2">On stop, data is…</div>
              <div className="flex rounded-lg border border-gray-700 bg-gray-900 p-0.5">
                <button
                  type="button"
                  onClick={() => { setKeepData(true); resetOverride(); }}
                  className={`rounded-md px-3 py-1.5 text-sm font-semibold ${keepData ? 'bg-white text-black' : 'text-gray-300 hover:bg-white/10'}`}
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => { setKeepData(false); resetOverride(); }}
                  className={`rounded-md px-3 py-1.5 text-sm font-semibold ${!keepData ? 'bg-white text-black' : 'text-gray-300 hover:bg-white/10'}`}
                >
                  Discard
                </button>
              </div>
            </div>

            <div>
              <div className="text-sm uppercase tracking-widest text-gray-300 mb-2">Data source</div>
              <div className="flex rounded-lg border border-gray-700 bg-gray-900 p-0.5">
                <button
                  type="button"
                  onClick={() => { setSimulated(false); resetOverride(); }}
                  className={`rounded-md px-3 py-1.5 text-sm font-semibold ${!simulated ? 'bg-white text-black' : 'text-gray-300 hover:bg-white/10'}`}
                >
                  Real
                </button>
                <button
                  type="button"
                  onClick={() => { setSimulated(true); resetOverride(); }}
                  className={`rounded-md px-3 py-1.5 text-sm font-semibold ${simulated ? 'bg-purple-500 text-white' : 'text-gray-300 hover:bg-white/10'}`}
                >
                  Simulated
                </button>
              </div>
              {/* "Config applies at session start" is not true for sim, and someone testing that
                  behaviour in sim would reasonably conclude it is broken. Sim deliberately runs
                  the committed config_base.toml overlay rather than the active profile, so a sim
                  run behaves the same on every box regardless of what is drafted locally. */}
              {simulated && (
                <div className="mt-2 text-xs text-purple-300/90 max-w-xs">
                  Simulated runs use the committed sim config, not your config profile — config
                  edits will not appear in this run.
                </div>
              )}
            </div>

            <div>
              <div className="text-sm uppercase tracking-widest text-gray-300 mb-2">Auto-stop after (min)</div>
              <input
                type="number"
                min={1}
                value={durationMin}
                onChange={(e) => { setDurationMin(Math.max(1, parseInt(e.target.value || '0', 10) || 0)); resetOverride(); }}
                className="w-28 rounded-md border border-gray-700 bg-black/60 px-3 py-1.5 text-sm text-white"
              />
            </div>

            {/* Second press = `force`, which is the only thing that gets past the backend's config
                gate. The button says so, because "Start anyway" is a different decision from
                "Start run" and should not look like the same one. */}
            <button
              type="button"
              disabled={!controlEnabled || pending !== null}
              title={pending
                ? 'Waiting for the pipeline to settle…'
                : blocked
                  ? 'Run this config despite the issues listed above'
                  : lockedNote}
              onClick={() => {
                setPending('start');
                send({
                  commandType: 'session_start',
                  data: { keepData, durationMs: durationMin * 60000, simulated, force: !!blocked },
                });
              }}
              className={`rounded-lg border px-5 py-2 text-sm font-bold uppercase tracking-wider text-white disabled:opacity-40 disabled:cursor-not-allowed ${
                blocked
                  ? 'border-amber-500 bg-amber-700/70 hover:bg-amber-600'
                  : 'border-green-600 bg-green-800/70 hover:bg-green-700'
              }`}
            >
              {pending === 'start' ? 'Starting…' : blocked ? 'Start anyway' : 'Start run'}
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-800 bg-card p-5">
          <h2 className="text-xl font-semibold mb-4">Manage run</h2>
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <div className="text-sm uppercase tracking-widest text-gray-300 mb-2">Add time (min)</div>
              <input
                type="number"
                min={1}
                value={addMin}
                onChange={(e) => setAddMin(Math.max(1, parseInt(e.target.value || '0', 10) || 0))}
                className="w-24 rounded-md border border-gray-700 bg-black/60 px-3 py-1.5 text-sm text-white"
              />
            </div>
            <button
              type="button"
              disabled={!controlEnabled}
              title={lockedNote}
              onClick={() => send({ commandType: 'session_extend', data: { addMs: addMin * 60000 } })}
              className="rounded-lg border border-blue-600 bg-blue-800/70 px-4 py-2 text-sm font-bold uppercase tracking-wider text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Add time
            </button>
            <div className="flex gap-2">
              {[15, 30].map((n) => (
                <button
                  key={n}
                  type="button"
                  disabled={!controlEnabled}
                  onClick={() => send({ commandType: 'session_extend', data: { addMs: n * 60000 } })}
                  className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  +{n}
                </button>
              ))}
            </div>
            <button
              type="button"
              disabled={!controlEnabled || pending !== null}
              title={pending ? 'Tearing down the pipeline…' : lockedNote}
              onClick={() => {
                if (confirm(`Stop this run? Its data will be ${session.keepData ? 'KEPT' : 'DISCARDED'}.`)) {
                  setPending('stop'); send({ commandType: 'session_stop', data: {} });
                }
              }}
              className="ml-auto rounded-lg border border-red-600 bg-red-800/70 px-5 py-2 text-sm font-bold uppercase tracking-wider text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {pending === 'stop' ? 'Stopping…' : 'Stop run'}
            </button>
          </div>
        </div>
      )}

      {lockedNote && <p className="mt-4 text-sm text-yellow-400">{lockedNote}</p>}
      </div>
    </main>
  );
}
