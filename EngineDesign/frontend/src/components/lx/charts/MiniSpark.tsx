import { useEffect, useMemo, useRef } from 'react';
import { useOptionalTimeStore } from '../time/hooks';
import { nearestIndex } from '../time/search';
import type { TimeStore } from '../time/store';
import { cssColor } from './color';
import { sparkGeometry } from './spark';

export interface MiniSparkProps {
  t: readonly number[];
  values: readonly (number | null)[];
  /** Token or CSS colour; default the neutral text colour. */
  color?: string;
  width?: number;
  height?: number;
  /** A design value or range to show as a faint band (the "design assumed" of the ledger). */
  band?: { lo: number; hi: number } | null;
  /** Default the page's TimeProvider; null hides the cursor dot. */
  store?: TimeStore | null;
  /** Read out for a screen reader; without it the sparkline is decorative. */
  title?: string;
}

/**
 * A tiny line for a ledger row: no axes, no labels, a dot at the cursor. The dot follows the
 * TimeStore by subscription; the line is drawn once per data change.
 */
export function MiniSpark({ t, values, color = '--lx-text', width = 96, height = 22, band, store, title }: MiniSparkProps) {
  const pageStore = useOptionalTimeStore();
  const active = store === undefined ? pageStore : store;
  const dotRef = useRef<SVGCircleElement>(null);
  const lo = band ? Math.min(band.lo, band.hi) : null;
  const hi = band ? Math.max(band.lo, band.hi) : null;
  const geom = useMemo(
    () => sparkGeometry(t, values, width, height, { include: lo !== null && hi !== null ? [lo, hi] : [] }),
    [t, values, width, height, lo, hi],
  );

  useEffect(() => {
    const dot = dotRef.current;
    if (!dot || !active) return;
    let last = -2;
    const sync = () => {
      const n = t.length;
      const now = active.get().t;
      const spacing = n > 1 ? (t[n - 1] - t[0]) / (n - 1) : 0;
      const i = n === 0 || now < t[0] - spacing || now > t[n - 1] + spacing ? -1 : nearestIndex(t, now);
      if (i === last) return;
      last = i;
      const v = i >= 0 ? values[i] : null;
      if (v === null || v === undefined || !Number.isFinite(v)) {
        dot.style.display = 'none';
        return;
      }
      dot.style.display = '';
      dot.setAttribute('cx', geom.x(t[i]).toFixed(1));
      dot.setAttribute('cy', geom.y(v).toFixed(1));
    };
    sync();
    return active.subscribe(sync);
  }, [active, geom, t, values]);

  const stroke = cssColor(color);
  const bandRect = lo !== null && hi !== null ? { y: geom.y(hi), h: Math.max(1, geom.y(lo) - geom.y(hi)) } : null;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="lx-spark"
         role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}
         style={{ display: 'block', overflow: 'visible' }}>
      {bandRect && <rect x={0} y={bandRect.y} width={width} height={bandRect.h} fill="var(--lx-text-3)" opacity={0.14} />}
      <path d={geom.d} fill="none" stroke={stroke} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
      <circle ref={dotRef} r={2.5} fill={stroke} stroke="var(--lx-surface)" strokeWidth={1} style={{ display: 'none' }} />
    </svg>
  );
}
