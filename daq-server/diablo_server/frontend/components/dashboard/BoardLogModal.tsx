'use client'

import { useEffect, useRef, useState } from 'react';
import { getWebSocketClient, getApiBaseUrl } from '@/lib/websocket';
import { MessageType, BoardLogLine, BoardLogPayload } from '@/lib/types';

interface Props {
  /** Board id to show logs for; null closes the modal. */
  boardId: number | null;
  /** Display title (e.g. "PT · Board 1"); falls back to the id. */
  title?: string;
  onClose: () => void;
}

// Cap the on-screen buffer (backfill + live). The board sends ~1 line/s.
const MAX_LINES = 2000;

/**
 * In-app overlay showing one board's diagnostic log stream: backfilled from
 * GET /api/board-logs on open, then live-appended from the BOARD_LOG WS feed.
 * Reuses the flash-page console look (mono, dark, autoscroll-to-bottom).
 */
export default function BoardLogModal({ boardId, title, onClose }: Props) {
  const [lines, setLines] = useState<BoardLogLine[]>([]);
  const [truncated, setTruncated] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  // Esc closes.
  useEffect(() => {
    if (boardId == null) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [boardId, onClose]);

  // Live subscription + one-shot history backfill, self-contained per open board.
  useEffect(() => {
    if (boardId == null) return;
    setLines([]);
    setTruncated(false);

    const ws = getWebSocketClient();
    const off = ws.on(MessageType.BOARD_LOG, (p: unknown) => {
      const pl = p as BoardLogPayload;
      if (pl.boardId !== boardId) return;
      if (pl.truncated) setTruncated(true);
      setLines((prev) => {
        const add: BoardLogLine[] = pl.lines.map((line) => ({ boardId: pl.boardId, ts: pl.ts, line }));
        const next = prev.concat(add);
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    });

    let cancelled = false;
    fetch(`${getApiBaseUrl()}/api/board-logs?board=${boardId}&limit=500`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { lines?: BoardLogLine[]; truncated?: boolean } | null) => {
        if (cancelled || !data?.lines) return;
        if (data.truncated) setTruncated(true);
        // History is older → prepend it ahead of any live lines already collected.
        setLines((prev) => data.lines!.concat(prev).slice(-MAX_LINES));
      })
      .catch(() => {});

    return () => { cancelled = true; off(); };
  }, [boardId]);

  // Autoscroll to the newest line.
  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  if (boardId == null) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-4xl max-h-[85vh] flex flex-col rounded-xl border border-gray-700 bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700">
          <div className="flex items-center gap-3 min-w-0">
            <h3 className="text-lg font-bold text-text truncate">{title ?? `Board ${boardId}`} — logs</h3>
            {truncated && (
              <span className="text-xs px-2 py-0.5 rounded bg-amber-900/60 text-amber-200 font-semibold uppercase tracking-wide flex-shrink-0">
                truncated
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-white text-xl leading-none px-2 flex-shrink-0"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <pre
          ref={preRef}
          className="flex-1 overflow-auto p-3 m-0 bg-gray-900 text-xs text-gray-300 font-mono whitespace-pre-wrap break-words"
        >
          {lines.length === 0 ? 'No logs yet for this board.' : lines.map((l) => l.line).join('\n')}
        </pre>
        <div className="px-5 py-2 border-t border-gray-700 text-xs text-text-muted font-mono">
          {lines.length} line{lines.length === 1 ? '' : 's'} shown
        </div>
      </div>
    </div>
  );
}
