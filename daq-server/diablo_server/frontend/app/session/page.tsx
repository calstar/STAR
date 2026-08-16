'use client'

import { useEffect, useState } from 'react';
import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { useControlMode } from '@/lib/control-mode';

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

export default function SessionPage() {
  const session = useSensorStore((s) => s.session);
  const { controlEnabled } = useControlMode();
  const ws = getWebSocketClient();

  const [keepData, setKeepData] = useState(true); // Save is the safe default
  const [simulated, setSimulated] = useState(false); // Live data is the safe default
  const [durationMin, setDurationMin] = useState(60);
  const [addMin, setAddMin] = useState(15);

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

  const active = session.active;
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
                  onClick={() => setKeepData(true)}
                  className={`rounded-md px-3 py-1.5 text-sm font-semibold ${keepData ? 'bg-white text-black' : 'text-gray-300 hover:bg-white/10'}`}
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setKeepData(false)}
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
                  onClick={() => setSimulated(false)}
                  className={`rounded-md px-3 py-1.5 text-sm font-semibold ${!simulated ? 'bg-white text-black' : 'text-gray-300 hover:bg-white/10'}`}
                >
                  Real
                </button>
                <button
                  type="button"
                  onClick={() => setSimulated(true)}
                  className={`rounded-md px-3 py-1.5 text-sm font-semibold ${simulated ? 'bg-purple-500 text-white' : 'text-gray-300 hover:bg-white/10'}`}
                >
                  Simulated
                </button>
              </div>
            </div>

            <div>
              <div className="text-sm uppercase tracking-widest text-gray-300 mb-2">Auto-stop after (min)</div>
              <input
                type="number"
                min={1}
                value={durationMin}
                onChange={(e) => setDurationMin(Math.max(1, parseInt(e.target.value || '0', 10) || 0))}
                className="w-28 rounded-md border border-gray-700 bg-black/60 px-3 py-1.5 text-sm text-white"
              />
            </div>

            <button
              type="button"
              disabled={!controlEnabled}
              title={lockedNote}
              onClick={() => send({ commandType: 'session_start', data: { keepData, durationMs: durationMin * 60000, simulated } })}
              className="rounded-lg border border-green-600 bg-green-800/70 px-5 py-2 text-sm font-bold uppercase tracking-wider text-white hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Start run
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
              disabled={!controlEnabled}
              title={lockedNote}
              onClick={() => {
                if (confirm(`Stop this run? Its data will be ${session.keepData ? 'KEPT' : 'DISCARDED'}.`)) {
                  send({ commandType: 'session_stop', data: {} });
                }
              }}
              className="ml-auto rounded-lg border border-red-600 bg-red-800/70 px-5 py-2 text-sm font-bold uppercase tracking-wider text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Stop run
            </button>
          </div>
        </div>
      )}

      {lockedNote && <p className="mt-4 text-sm text-yellow-400">{lockedNote}</p>}
      </div>
    </main>
  );
}
