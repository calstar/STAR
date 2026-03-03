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

  const lastTimestampRef = useRef<number | null>(null);
  const [pulses, setPulses] = useState<number[]>([]);

  useEffect(() => {
    if (!items.length) return;
    const newestTs = items[0]?.timestampMs ?? null;
    if (!newestTs) return;

    if (!lastTimestampRef.current || newestTs > lastTimestampRef.current) {
      lastTimestampRef.current = newestTs;
      setPulses((prev) => [...prev, newestTs]);
      const timeout = setTimeout(() => {
        setPulses((prev) => prev.filter((ts) => ts !== newestTs));
      }, 50); // single, very fast pulse per notification
      return () => clearTimeout(timeout);
    }
  }, [items]);

  return (
    <div className="h-full flex flex-col min-w-[700px] max-w-3xl relative">
      <div className="absolute top-3 right-1 pointer-events-none">
        <span className="relative flex h-5 w-5">
          {/* Red pulses for each incoming notification */}
          {pulses.map((id) => (
            <span
              key={id}
              className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-80"
            />
          ))}
          {/* Idle halo */}
          {!pulses.length && (
            <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400/40 blur-sm" />
          )}
          {/* Core indicator: green when idle, red when pulsing */}
          <span
            className={`relative inline-flex rounded-full h-3 w-3 ${
              pulses.length ? 'bg-red-500' : 'bg-emerald-400'
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

