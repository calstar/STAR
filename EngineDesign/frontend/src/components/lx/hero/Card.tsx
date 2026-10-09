import { useLayoutEffect, useRef } from 'react';
import { NBSP } from '../units';
import type { Row } from './readout';

/**
 * The hero's hover card: a name, the cursor time, and the numbers at that time. Placed beside the
 * point it was opened at, inside the hero's box (flipped left or up when it would leave it), and
 * never under the pointer, so it does not steal the hover.
 */
export function HoverCard({ x, y, bounds, title, sub, time, rows, id }: {
  x: number;
  y: number;
  /** The box it must stay inside [px], relative to the same origin as x, y. */
  bounds: { w: number; h: number };
  title: string;
  sub?: string;
  time: string;
  rows: readonly Row[];
  id?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const gap = 14;
    let left = x + gap;
    if (left + w > bounds.w - 4) left = Math.max(4, x - gap - w);
    let top = y + gap;
    if (top + h > bounds.h - 4 && y - gap - h >= 4) top = y - gap - h;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.visibility = 'visible';
  });
  return (
    <div ref={ref} id={id} role="tooltip"
         className="pointer-events-none absolute z-20 w-max min-w-[180px] rounded-[6px] border border-[var(--lx-line)] bg-[var(--lx-surface)] px-3 py-2"
         // As wide as its rows, never wider than the box it sits in: a long row wraps its label
         // instead of running out past the card's right edge.
         style={{ left: 0, top: 0, maxWidth: Math.max(180, Math.min(360, bounds.w - 8)), visibility: 'hidden', boxShadow: 'var(--lx-shadow-pop)' }}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-[12px] font-medium text-[var(--lx-text)]">{title}</span>
        <span className="lx-num shrink-0 text-[11px] text-[var(--lx-text-3)]">{time}</span>
      </div>
      {sub && <div className="truncate text-[11px] text-[var(--lx-text-3)]">{sub}</div>}
      {rows.length > 0
        ? (
          <table className="mt-1.5 w-full border-collapse text-[12px]">
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <th scope="row" className="py-0.5 pr-3 text-left align-top font-normal leading-snug text-[var(--lx-text-2)]">{r.label}</th>
                  <td className="whitespace-nowrap py-0.5 text-right align-top">
                    <span className="lx-num text-[var(--lx-text)]">{r.num}</span>
                    {r.unit && <>{NBSP}<span className="text-[11px] text-[var(--lx-text-3)]">{r.unit}</span></>}
                    {r.note && <span className="lx-num text-[11px] text-[var(--lx-text-3)]">{NBSP}{r.note}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
        : <div className="mt-1 text-[11px] text-[var(--lx-text-3)]">Not recorded for this run</div>}
    </div>
  );
}
