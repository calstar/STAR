'use client'

import { useEffect, useRef, useState } from 'react';
import { useSensorStore, type NotificationEntry } from '@/lib/store';

const MIN_FONT_PX = 10;
const MAX_FONT_PX = 14;

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
      className="overflow-hidden whitespace-nowrap font-mono leading-tight text-ink"
      style={{ fontSize: fontSizePx }}
    >
      {message}
    </div>
  );
}

/** A notification's mark: a square in the colour its category means. */
function categoryStyle(category: NotificationEntry['category']): { label: string; color: string } {
  switch (category) {
    case 'error':
      return { label: 'Error', color: 'bg-red-400' };
    case 'warning':
      return { label: 'Warning', color: 'bg-amber-300' };
    case 'info':
    default:
      return { label: 'Info', color: 'bg-ink-3' };
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
    <div className="flex h-full w-full min-w-[150px] flex-shrink-0 flex-col">
      <div className="mb-2 flex flex-shrink-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <h2 className="caps text-[11px]">Notifications</h2>
        <button
          type="button"
          onClick={clearNotifications}
          disabled={items.length === 0}
          className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3 hover:text-ink disabled:opacity-40"
        >
          Clear
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col divide-y divide-line overflow-y-auto">
        {items.length === 0 ? (
          <p className="font-mono text-[12px] text-ink-3">No board notifications.</p>
        ) : (
          items.map((n, idx) => {
            const { label, color } = categoryStyle(n.category);
            return (
              <div
                key={n.key ?? idx}
                className={`flex items-start gap-2 py-1.5 ${n.isCurrent ? 'bg-white/[0.04]' : ''}`}
              >
                <span className={`mt-1.5 h-1.5 w-1.5 flex-shrink-0 ${color}`} title={label} aria-label={label} />
                <div className="min-w-0 flex-1 overflow-hidden">
                  <ScaledMessage message={n.message} />
                  <div className="flex items-center gap-2 font-mono text-[11px] text-ink-3">
                    <span className="tabular-nums">{formatTime(n.timestampMs)}</span>
                    {n.isCurrent && (
                      <span className="uppercase tracking-[0.12em] text-emerald-400">current</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
