'use client'

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSensorStore, NotificationEntry } from '@/lib/store';

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

export default function NotificationPanel() {
  const notifications = useSensorStore((s) => s.notifications);
  const clearNotifications = useSensorStore((s) => s.clearNotifications);

  const items = useMemo(() => notifications, [notifications]);

  const lastMaxTsRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!items.length) return;
    // Use the max timestamp across ALL items — the store sorts ongoing
    // notifications to the top, so items[0].timestampMs may be stale.
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
    <div className="h-full flex flex-col min-w-[700px] max-w-3xl relative">
      <div className="absolute top-3 right-1 pointer-events-none">
        <span className="relative flex h-5 w-5 items-center justify-center">
          {/* Outer glow ring */}
          <span
            className={`absolute inline-flex rounded-full h-5 w-5 transition-colors duration-75 ${
              active ? 'bg-red-500/40' : 'bg-emerald-400/25'
            }`}
          />
          {/* Core dot */}
          <span
            className={`relative inline-flex rounded-full h-3 w-3 transition-colors duration-75 ${
              active ? 'bg-red-500' : 'bg-emerald-400'
            }`}
          />
        </span>
      </div>
      <div className="mt-4 flex items-center justify-between mb-3 pr-10">
        <span className="text-2xl font-bold tracking-widest text-gray-500 uppercase">
          Notifications
        </span>
        <button
          type="button"
          onClick={clearNotifications}
          className="ml-4 px-3 py-1.5 rounded-md border border-gray-600 text-sm font-semibold text-gray-200 hover:bg-gray-800 active:bg-gray-700"
        >
          Clear
        </button>
      </div>
      <div className="flex-1 min-h-0 rounded-lg border border-gray-800 bg-black/40 overflow-hidden">
        <div className="h-full overflow-y-auto divide-y divide-gray-800/70">
          {items.length === 0 ? (
            <div className="px-6 py-5 text-2xl text-gray-600">No recent notifications.</div>
          ) : (
            items.map((n, idx) => {
              const { emoji, color } = categoryStyle(n.category);
              return (
                <div
                  key={n.key ?? idx}
                  className={`px-5 py-2.5 flex items-center gap-4 ${
                    n.isCurrent ? 'bg-gray-900/70' : 'bg-transparent'
                  }`}
                >
                  <div className="flex items-center justify-center w-8">
                    <span className={`${color} text-2xl leading-none`}>{emoji}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-2xl text-gray-200 truncate">{n.message}</div>
                    <div className="text-lg text-gray-500 flex items-center gap-3">
                      <span className="tabular-nums">{formatTime(n.timestampMs)}</span>
                      {n.isCurrent && (
                        <span className="px-3 py-1 rounded-full bg-emerald-900/60 text-base text-emerald-300 font-semibold">
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

