'use client'

import { useMemo } from 'react';
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

  const items = useMemo(() => notifications, [notifications]);

  return (
    <div className="h-full flex flex-col min-w-[260px] max-w-sm">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-bold tracking-widest text-gray-500 uppercase">Notifications</span>
      </div>
      <div className="flex-1 min-h-0 rounded-lg border border-gray-800 bg-black/40 overflow-hidden">
        <div className="h-full overflow-y-auto divide-y divide-gray-800/70">
          {items.length === 0 ? (
            <div className="px-3 py-2 text-xs text-gray-600">No recent notifications.</div>
          ) : (
            items.map((n, idx) => {
              const { emoji, color } = categoryStyle(n.category);
              return (
                <div
                  key={n.key ?? idx}
                  className={`px-3 py-1.5 flex items-center gap-2 ${
                    n.isCurrent ? 'bg-gray-900/70' : 'bg-transparent'
                  }`}
                >
                  <div className="flex items-center justify-center w-6">
                    <span className={`${color} text-base leading-none`}>{emoji}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-gray-200 truncate">{n.message}</div>
                    <div className="text-[10px] text-gray-500 flex items-center gap-2">
                      <span className="tabular-nums">{formatTime(n.timestampMs)}</span>
                      {n.isCurrent && <span className="px-1.5 py-0.5 rounded-full bg-emerald-900/60 text-[9px] text-emerald-300 font-semibold">current</span>}
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
