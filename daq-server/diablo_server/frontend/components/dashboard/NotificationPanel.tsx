'use client'

import { useEffect, useRef, useState } from 'react';
import { useSensorStore, type NotificationEntry } from '@/lib/store';

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

export default function NotificationPanel() {
  const notifications = useSensorStore((s) => s.notifications);
  const clearNotifications = useSensorStore((s) => s.clearNotifications);

  const items = notifications;

  return (
    <div className="h-full flex flex-col w-full min-w-[150px] flex-shrink-0">
      <div className="flex items-center justify-between gap-2 mb-1.5 px-1">
        <div className="text-[10px] font-bold uppercase tracking-widest text-gray-500">Notifications</div>
        <button
          type="button"
          onClick={clearNotifications}
          className="px-2 py-0.5 rounded border border-gray-700 text-xs font-semibold text-gray-300 hover:bg-gray-800 active:bg-gray-700"
        >
          Clear
        </button>
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
