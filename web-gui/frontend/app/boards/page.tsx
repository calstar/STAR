'use client'

import { useCallback, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, BoardStatusPayload, BoardStatus, engineStateCodeToLabel } from '@/lib/types';

function formatConfigSentAt(ms: number | undefined): string {
  if (ms == null) return '';
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Subtle accent hues per card (left border + light tint)
const CARD_ACCENTS = [
  'border-l-emerald-500/70 bg-emerald-950/10',
  'border-l-blue-500/70 bg-blue-950/10',
  'border-l-violet-500/70 bg-violet-950/10',
  'border-l-amber-500/70 bg-amber-950/10',
  'border-l-rose-500/70 bg-rose-950/10',
  'border-l-cyan-500/70 bg-cyan-950/10',
] as const;

export default function BoardsPage() {
  const updateBoards = useSensorStore((s) => s.updateBoards);
  const boardsMap = useSensorStore((s) => s.boards as Record<number, BoardStatus>);
  const sensorData = useSensorStore((s) => s.sensorData);
  const ws = getWebSocketClient();

  const TYPE_ORDER = ['ACTUATOR', 'PT', 'LC', 'TC', 'RTD', 'ENCODER'];

  const boardsByType = useMemo(() => {
    const map = boardsMap ?? {};
    const enabled = Object.values(map).filter((b) => b.expected === true);
    const groups: Record<string, BoardStatus[]> = {};
    for (const b of enabled) {
      const t = b.type || 'OTHER';
      if (!groups[t]) groups[t] = [];
      groups[t].push(b);
    }
    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) => {
        const an = a.boardNumber ?? Number.MAX_SAFE_INTEGER;
        const bn = b.boardNumber ?? Number.MAX_SAFE_INTEGER;
        if (an !== bn) return an - bn;
        return a.id - b.id;
      });
    }
    return groups;
  }, [boardsMap]);

  const orderedTypes = useMemo(() => {
    const present = Object.keys(boardsByType);
    return TYPE_ORDER.filter((t) => present.includes(t)).concat(present.filter((t) => !TYPE_ORDER.includes(t)));
  }, [boardsByType]);

  useEffect(() => {
    ws.connect();
    const unsub = ws.on(MessageType.BOARD_STATUS_UPDATE, (p: unknown) => {
      const payload = p as BoardStatusPayload;
      if (payload?.boards) updateBoards(payload.boards as BoardStatus[]);
    });
    return () => unsub();
  }, [ws, updateBoards]);

  const handleResendConfig = useCallback(() => {
    getWebSocketClient().send({
      type: MessageType.RESEND_CONFIG,
      timestamp: Date.now(),
      payload: {},
    });
  }, []);

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-auto p-8 md:p-10">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-4xl font-bold text-text mb-2 tracking-tight">Boards / Heartbeats</h1>
          <p className="text-lg text-text-muted max-w-2xl">
            Boards enabled in config, grouped by type. Heartbeat and config status per board.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleResendConfig}
            className="min-h-[48px] px-8 py-3 text-lg font-bold rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity shadow-lg"
          >
            Resend config
          </button>
        </div>
      </div>

      {orderedTypes.length === 0 ? (
        <div className="rounded-xl border border-gray-700 bg-card p-12 text-center text-text-muted text-lg">
          No boards enabled in config. Enable boards in config.toml to see them here.
        </div>
      ) : (
        <div className="flex flex-col gap-10">
          {orderedTypes.map((boardType) => {
            const boards = boardsByType[boardType];
            if (!boards?.length) return null;
            return (
              <section key={boardType}>
                <h2 className="text-lg font-bold text-text-muted uppercase tracking-wider mb-4">
                  {boardType}
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                  {boards.map((b, index) => {
                    const testKeys = Object.keys(sensorData).filter((k) => k.startsWith(`SELF_TEST.BOARD_${b.id}.`));
                    let testStatus: 'Untested' | 'Passed' | 'Failed' = 'Untested';
                    if (testKeys.length > 0) {
                      testStatus = testKeys.every(k => sensorData[k] === 1) ? 'Passed' : 'Failed';
                    }
                    const accent = CARD_ACCENTS[index % CARD_ACCENTS.length];
                    const freq =
                      b.frequencyHz != null && isFinite(b.frequencyHz)
                        ? `${b.frequencyHz.toFixed(1)} Hz`
                        : '---';
                    let boardStateLabel = 'Unknown';
                    if (b.boardState === 1) boardStateLabel = 'Setup';
                    else if (b.boardState === 2) boardStateLabel = 'Active';
                    else if (b.boardState === 3) boardStateLabel = 'Abort';
                    else if (b.boardState === 4) boardStateLabel = 'Abort done';
                    const engineLabel = engineStateCodeToLabel(b.engineState);
                    const nameParts = [];
                    if (b.type) nameParts.push(b.type);
                    if (b.boardNumber != null) nameParts.push(`Board ${b.boardNumber}`);
                    const title = nameParts.join(' · ') || `ID ${b.id}`;
                    return (
                      <div
                        key={b.id}
                        className={`rounded-xl border-l-4 p-6 border border-gray-700 transition-colors min-h-[200px] flex flex-col bg-card hover:border-gray-600 ${accent}`}
                      >
                        <div className="flex items-center justify-between mb-4">
                          <h3 className="text-xl font-bold tracking-wider text-text uppercase truncate pr-3">
                            {title}
                          </h3>
                        </div>
                        <div className="flex flex-wrap gap-4 mb-3 text-lg">
                          <div className="flex-1 min-w-0">
                            <div className="text-text-muted mb-1.5 text-sm uppercase tracking-wider">Status</div>
                            <div className={`flex items-center gap-2.5 ${!(b.operational ?? b.connected) ? 'text-red-400' : 'text-green-400'}`}>
                              <div
                                className={`w-3.5 h-3.5 rounded-full flex-shrink-0 ${!(b.operational ?? b.connected) ? 'bg-red-500' : 'bg-green-500'}`}
                              />
                              <span className="font-mono font-bold text-lg truncate">
                                {(b.operational ?? b.connected) ? 'CONNECTED' : 'DISCONNECTED'}
                              </span>
                            </div>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-text-muted mb-1.5 text-sm uppercase tracking-wider">State</div>
                            <div className="flex items-center gap-2.5 text-text">
                              <div
                                className={`w-3.5 h-3.5 rounded-full flex-shrink-0 ${boardStateLabel === 'Active' ? 'bg-green-500' :
                                  boardStateLabel === 'Setup' ? 'bg-blue-500' :
                                    boardStateLabel === 'Abort' || boardStateLabel === 'Abort done' ? 'bg-red-500' : 'bg-gray-500'
                                  }`}
                              />
                              <span className="font-mono font-bold text-lg truncate">
                                {boardStateLabel.toUpperCase()}
                              </span>
                            </div>
                          </div>
                        </div>
                        <div className="text-sm text-text-muted font-mono mb-2">
                          Engine: {engineLabel}
                        </div>
                        {b.configured !== undefined && (
                          <div className="flex items-center gap-2 mb-2">
                            <span
                              className={`text-xs px-2 py-1 rounded font-semibold uppercase tracking-wide font-mono ${b.configured ? 'bg-emerald-900/60 text-emerald-200' : 'bg-gray-800 text-gray-500'
                                }`}
                            >
                              {b.configured ? 'Config sent' : 'Unconfigured'}
                            </span>
                            {b.configured && b.configLastSentAt != null && (
                              <span className="text-xs text-emerald-400/90 font-mono">
                                at {formatConfigSentAt(b.configLastSentAt)}
                              </span>
                            )}
                          </div>
                        )}
                        {b.configError && (
                          <div className="text-xs text-red-400 font-mono mb-2" title={b.configError}>
                            Config error: {b.configError}
                          </div>
                        )}
                        <div className="flex items-center gap-2 mb-2 font-mono">
                          <span className="text-text-muted text-sm uppercase tracking-wider">Self Test:</span>
                          <span className={`text-sm font-bold ${testStatus === 'Passed' ? 'text-green-400' :
                            testStatus === 'Failed' ? 'text-red-400' : 'text-gray-500'
                            }`}>
                            {testStatus === 'Passed' ? 'ALL PASSED' : testStatus === 'Failed' ? 'FAILED' : 'UNTESTED'}
                          </span>
                        </div>
                        <div className="text-base text-text-muted font-mono mb-2">
                          Heartbeat: {freq}
                        </div>
                        <div className="flex items-center justify-between gap-2 mt-auto pt-3">
                          <span className="text-sm text-gray-500 font-mono truncate" title={b.ip}>
                            ID {b.id} · {b.ip}
                          </span>
                          <Link
                            href={`/flash?ip=${encodeURIComponent(b.ip)}&boardId=${b.id}`}
                            className="text-xs px-2 py-1 rounded bg-cyan-900/50 text-cyan-300 hover:bg-cyan-800/60 font-semibold"
                          >
                            Flash
                          </Link>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <div className="mt-12">
        <h2 className="text-2xl font-bold text-text mb-4 tracking-tight">Self Tests</h2>
        {(() => {
          const testedBoards = Object.values(boardsMap ?? {}).filter(b =>
            Object.keys(sensorData).some(k => k.startsWith(`SELF_TEST.BOARD_${b.id}.`))
          );
          if (testedBoards.length === 0) {
            return <div className="text-text-muted italic">No self test data available yet.</div>;
          }
          return (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {testedBoards.map(b => {
                const testKeys = Object.keys(sensorData).filter((k) => k.startsWith(`SELF_TEST.BOARD_${b.id}.`));
                const allPassed = testKeys.every(k => sensorData[k] === 1);
                return (
                  <div key={b.id} className={`rounded-xl border p-5 ${allPassed ? 'border-green-900/50 bg-green-950/10' : 'border-red-900/50 bg-red-950/10'}`}>
                    <h3 className="text-lg font-bold mb-3">{b.type || 'BOARD'} {b.boardNumber} (ID {b.id})</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
                      {testKeys.map(k => {
                        const sensorMatch = k.match(/sensor_(\d+)/);
                        const sensorId = sensorMatch ? sensorMatch[1] : '?';
                        const passed = sensorData[k] === 1;
                        return (
                          <div key={k} className="flex items-center justify-between bg-black/20 px-3 py-2 rounded border border-white/5">
                            <span className="font-mono text-sm text-text-muted">CH {sensorId}</span>
                            <span className={`font-bold text-sm ${passed ? 'text-green-400' : 'text-red-400'}`}>{passed ? 'PASS' : 'FAIL'}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>
    </main>
  );
}
