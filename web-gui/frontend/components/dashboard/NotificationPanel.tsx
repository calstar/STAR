'use client'

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSensorStore, NotificationEntry } from '@/lib/store';

const MIN_FONT_PX = 10;
const MAX_FONT_PX = 18;

function ScaledMessage({ message }: { message: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [fontSizePx, setFontSizePx] = useState(MAX_FONT_PX);

  const scaleToFit = () => {
    const el = wrapRef.current;
    if (!el || !message || el.clientWidth <= 0) return;
    let fs = MAX_FONT_PX;
    el.style.fontSize = `${fs}px`;
    while (el.scrollWidth > el.clientWidth && fs > MIN_FONT_PX) {
      fs = Math.max(MIN_FONT_PX, Math.floor((fs * el.clientWidth) / el.scrollWidth));
      el.style.fontSize = `${fs}px`;
    }
    setFontSizePx(fs);
  };

  useEffect(() => {
    scaleToFit();
  }, [message]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => scaleToFit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [message]);

  return (
    <div
      ref={wrapRef}
      className="overflow-hidden whitespace-nowrap text-gray-200 leading-tight"
      style={{ fontSize: fontSizePx }}
    >
      {message}
    </div>
  );
}

function categoryStyle(category: NotificationEntry['category']): { emoji: string; color: string } {
  switch (category) {
    case 'error':
      return { emoji: '❌', color: 'text-red-400' };
    case 'warning':
      return { emoji: '⚠️', color: 'text-amber-300' };
    case 'info':
    default:
      return { emoji: 'ℹ️', color: 'text-blue-300' };
  }
}

function formatTime(ts: number): string {
  if (!ts || !isFinite(ts)) return '--:--:--';
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
}

/** True if this notification is board-related (heartbeat, connected, lost, stuck, unrecognized). */
function isBoardNotification(n: NotificationEntry): boolean {
  if (n.key && (n.key.startsWith('board_') || n.key.startsWith('setup_stuck_') || n.key.startsWith('unrecognized_'))) return true;
  return /Board \d+.*(connected|lost|stuck)|Unrecognized board/i.test(n.message);
}

export default function NotificationPanel() {
  const notifications = useSensorStore((s) => s.notifications);
  const clearNotifications = useSensorStore((s) => s.clearNotifications);

  const items = useMemo(() => notifications.filter(isBoardNotification), [notifications]);

  const lastMaxTsRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!items.length) return;
    const maxTs = Math.max(...items.map((n) => n.timestampMs));
    if (maxTs <= lastMaxTsRef.current) return;
    lastMaxTsRef.current = maxTs;

    setActive(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setActive(false);
      timerRef.current = null;
    }, 200);
  }, [items]);

  return (
    <div className="h-full flex flex-col w-full min-w-[150px] flex-shrink-0 relative">
      <div className="absolute top-1 right-1 pointer-events-none z-10">
        <span className="relative flex h-4 w-4 items-center justify-center">
          <span
            className={`absolute inline-flex rounded-full h-4 w-4 transition-colors duration-75 ${
              active ? 'bg-red-500/40' : 'bg-emerald-400/25'
            }`}
          />
          <span
            className={`relative inline-flex rounded-full h-2.5 w-2.5 transition-colors duration-75 ${
              active ? 'bg-red-500' : 'bg-emerald-400'
            }`}
          />
        </span>
      </div>
      <div className="flex flex-col gap-1 mb-1.5 pl-1 pr-6">
        <div className="text-[10px] font-bold uppercase tracking-widest text-gray-500">Board heartbeat</div>
        <div className="flex items-center justify-start">
          <button
            type="button"
            onClick={clearNotifications}
            className="px-2 py-1 rounded border border-gray-700 text-lg font-semibold text-gray-300 hover:bg-gray-800 active:bg-gray-700"
          >
            Clear
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 rounded border border-gray-800 bg-black/40 overflow-hidden flex flex-col">
        <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-gray-800/70 flex flex-col">
          {items.length === 0 ? (
            <div className="px-3 py-2 text-lg text-gray-600">No board notifications.</div>
          ) : (
            items.map((n, idx) => {
              const { emoji, color } = categoryStyle(n.category);
              return (
                <div
                  key={n.key ?? idx}
                  className={`px-2 py-1.5 flex items-start gap-2 ${
                    n.isCurrent ? 'bg-gray-900/70' : 'bg-transparent'
                  }`}
                >
                  <span className={`${color} text-lg leading-none mt-0.5 flex-shrink-0`}>{emoji}</span>
                  <div className="flex-1 min-w-0 overflow-hidden">
                    <ScaledMessage message={n.message} />
                    <div className="text-base text-gray-500 flex items-center gap-2">
                      <span className="tabular-nums">{formatTime(n.timestampMs)}</span>
                      {n.isCurrent && (
                        <span className="px-1.5 py-0.5 rounded-full bg-emerald-900/60 text-sm text-emerald-300 font-semibold">
                          current
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
