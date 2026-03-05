'use client'

import { useCallback, useEffect, useMemo } from 'react';
import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, BoardStatusPayload, BoardStatus, engineStateCodeToLabel, CommandPayload } from '@/lib/types';

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
  const ws = getWebSocketClient();

  const boards = useMemo(() => {
    const map = boardsMap ?? {};
    return Object.values(map).sort((a, b) => {
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      const an = a.boardNumber ?? Number.MAX_SAFE_INTEGER;
      const bn = b.boardNumber ?? Number.MAX_SAFE_INTEGER;
      if (an !== bn) return an - bn;
      return a.id - b.id;
    });
  }, [boardsMap]);

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

  const handleClearAbort = useCallback(() => {
    const cmd: CommandPayload = { commandType: 'clear_abort', data: {} };
    getWebSocketClient().sendCommand(cmd);
  }, []);

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-auto p-8 md:p-10">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-4xl font-bold text-text mb-2 tracking-tight">Boards / Heartbeats</h1>
          <p className="text-lg text-text-muted max-w-2xl">
            Discovered boards and heartbeat status. Unexpected boards are highlighted.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleClearAbort}
            className="min-h-[48px] px-6 py-3 text-base font-bold rounded-lg border border-red-500/70 bg-red-950/40 text-red-200 hover:bg-red-900/50 transition-colors"
          >
            Clear ABORT
          </button>
          <button
            type="button"
            onClick={handleResendConfig}
            className="min-h-[48px] px-8 py-3 text-lg font-bold rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity shadow-lg"
          >
            Resend config
          </button>
        </div>
      </div>

      {boards.length === 0 ? (
        <div className="rounded-xl border border-gray-700 bg-card p-12 text-center text-text-muted text-lg">
          No boards configured or discovered yet. Ensure the backend is running and broadcasting SERVER_HEARTBEAT.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {boards.map((b, index) => {
            const unexpected = !b.expected;
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
                className={`rounded-xl border-l-4 p-6 border border-gray-700 transition-colors min-h-[200px] flex flex-col
                  ${unexpected ? 'bg-yellow-950/40 border-yellow-600 border-l-yellow-500' : `bg-card hover:border-gray-600 ${accent}`}`}
              >
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-xl font-bold tracking-wider text-text uppercase truncate pr-3">
                    {title}
                  </h3>
                  {unexpected && (
                    <span className="text-sm font-bold text-yellow-400 uppercase tracking-wider flex-shrink-0">
                      UNEXPECTED
                    </span>
                  )}
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
                        className={`w-3.5 h-3.5 rounded-full flex-shrink-0 ${
                          boardStateLabel === 'Active' ? 'bg-green-500' :
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
                      className={`text-xs px-2 py-1 rounded font-semibold uppercase tracking-wide font-mono ${
                        b.configured ? 'bg-emerald-900/60 text-emerald-200' : 'bg-gray-800 text-gray-500'
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
                <div className="text-base text-text-muted font-mono mb-2">
                  Heartbeat: {freq}
                </div>
                <div className="text-sm text-gray-500 font-mono mt-auto pt-3 truncate" title={b.ip}>
                  ID {b.id} · {b.ip}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
