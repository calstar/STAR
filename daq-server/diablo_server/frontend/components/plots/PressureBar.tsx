'use client'

import { useMemo, memo } from 'react';

interface PressureBarProps {
  label: string;
  value: number | null;
  nop?: number;
  meop?: number;
  color?: string;
  unit?: string;
  showLabels?: boolean; // Show NOP/MEOP labels on this bar (default true)
  compact?: boolean;    // Reduced font sizes for use in tight spaces (e.g. TopBar)
}

function fmtPressure(v: number): string {
  if (!isFinite(v)) return '---';
  const abs = Math.abs(v);
  if (abs > 99999) return '---';
  // Values >= 1e21 make toFixed() return "1e+21" etc — avoid scientific notation
  if (abs >= 1e21) return '---';
  let s: string;
  if (abs >= 1000) s = v.toFixed(0);
  else if (abs >= 100) s = v.toFixed(0);
  else if (abs >= 1) s = v.toFixed(1);
  else s = v.toFixed(2);
  return s.includes('e') ? '---' : s;
}

/**
 * Non-linear piecewise scaling so the bar expands faster near NOP/MEOP.
 * Gives the operator much better visual resolution near operating limits.
 *
 *   0  →  70% NOP   ⟶   0% –  35%  bar  (compressed — safe zone)
 *  70% NOP → NOP    ⟶  35% –  60%  bar  (expanding — approaching limit)
 *  NOP → MEOP       ⟶  60% –  85%  bar  (fast — critical zone)
 *  MEOP → maxVal    ⟶  85% – 100%  bar  (over-pressure)
 */
function nonLinearPct(value: number, nop: number, meop: number, maxVal: number): number {
  // Handle negative values - clamp to 0 for display purposes
  // Negative pressures should show as minimal bar (not going below baseline)
  // Use absolute value for calculation, but ensure result is always >= 0
  const clampedValue = Math.max(0, value);
  if (clampedValue <= 0) return 0;
  if (clampedValue >= maxVal) return 100;

  const safeEdge = nop * 0.7;
  const safePct = 35;
  const warningPct = 60;
  const dangerPct = 85;

  if (clampedValue <= safeEdge) {
    return (clampedValue / safeEdge) * safePct;
  } else if (clampedValue <= nop) {
    const frac = (clampedValue - safeEdge) / (nop - safeEdge);
    return safePct + frac * (warningPct - safePct);
  } else if (clampedValue <= meop) {
    const frac = (clampedValue - nop) / (meop - nop);
    return warningPct + frac * (dangerPct - warningPct);
  } else {
    const frac = (clampedValue - meop) / (maxVal - meop);
    return dangerPct + frac * (100 - dangerPct);
  }
}

/** Grey. A no-data bar must never wear a threshold colour: green on an empty bar reads
 *  as "0 psi and safe", which on a pressurised rig is the most dangerous thing this
 *  component can draw. */
export const NO_DATA_COLOR = '#6B7280';

/**
 * Everything about how one bar draws, as a pure function so the safety property can be
 * asserted directly (see __tests__/pressure-bar.test.ts) rather than through the DOM.
 *
 * `value === null` means "no fresh reading", which is NOT the same as a reading of zero.
 * This used to start with `value ?? 0`, so a stale sensor produced an empty bar with the
 * green (below-NOP) colour on both the bar and the readout — indistinguishable from a
 * genuinely vented tank. Now the null case is carried through as `noData` and coloured
 * neutral, and the caller hatches the track so it reads as "no data" at a glance.
 */
export function pressureBarVisual(
  value: number | null,
  nop: number,
  meop: number,
  color?: string,
): {
  noData: boolean; sane: boolean; valuePct: number; nopPct: number;
  meopPct: number; displayHeight: number; barColor: string;
} {
  const maxVal = Math.max(meop * 1.3, 1000);
  const noData = value === null || !Number.isFinite(value);
  // Derived from `value`, never from `value ?? 0` — that substitution is the whole bug.
  const sane = !noData && Math.abs(value as number) < 100000;
  const clamped = sane ? Math.max(0, value as number) : 0;
  const valuePct = sane ? Math.min(Math.max(nonLinearPct(clamped, nop, meop, maxVal), 0), 100) : 0;
  const nopPct = nonLinearPct(nop, nop, meop, maxVal);
  const meopPct = nonLinearPct(meop, nop, meop, maxVal);
  const minVisibleHeight = 2;
  const displayHeight = sane && value !== 0 ? Math.max(valuePct, minVisibleHeight) : valuePct;
  const barColor = noData
    ? NO_DATA_COLOR
    : (color || (sane && (value as number) > meop ? '#E74C3C'
      : sane && (value as number) > nop ? '#F39C12' : '#27AE60'));

  return { noData, sane, valuePct, nopPct, meopPct, displayHeight, barColor };
}

/** Width kept to the right of the capsule for the limit numbers [px] -- as in
 *  feed-twin's copy: laid over a narrow capsule the number vanished into the
 *  fill, so the capsule shares its column with a gutter and they live there. */
const GUTTER = 30;

/**
 * The drawing is feed-twin's console capsule: an outlined tube in the app's
 * monochrome, the limit rules across the tube with their numbers off its right
 * edge, and the reading under it. Everything that decides what an operator sees
 * -- the scale, the rule positions, the fill colour and the no-data hatch -- is
 * pressureBarVisual's, unchanged. What the capsule adds is the edge and the
 * readout turning amber past NOP and red past MEOP, whatever the trace colour.
 */
function PressureBar({
  label,
  value,
  nop = 500,
  meop = 700,
  color,
  unit = 'psig',
  showLabels = true,
  compact = false,
}: PressureBarProps) {
  const { noData, sane, nopPct, meopPct, displayHeight, barColor } =
    useMemo(() => pressureBarVisual(value, nop, meop, color), [value, nop, meop, color]);

  const v = value as number;
  const level = !sane ? 'none' : v > meop ? 'meop' : v > nop ? 'nop' : 'ok';
  const edge = level === 'meop' ? '#ef4444' : level === 'nop' ? '#e5b53a' : 'var(--line-strong)';
  const readout = noData
    ? NO_DATA_COLOR
    : level === 'meop' ? '#f87171' : level === 'nop' ? '#e5b53a' : 'var(--ink)';
  const gutter = showLabels ? GUTTER : 0;

  // A rule across the capsule, and its number just outside the capsule's right
  // edge, centred on the rule.
  const limit = (pct: number, lim: number, tone: string) => (
    <div className="pointer-events-none absolute inset-x-0" style={{ bottom: `${pct.toFixed(2)}%` }}>
      <div className="border-t border-dashed" style={{ borderColor: tone, opacity: 0.75 }} />
      {showLabels && (
        <span
          className="absolute left-full -translate-y-1/2 whitespace-nowrap pl-1 font-mono leading-none tabular-nums"
          style={{ color: tone, top: 0, fontSize: compact ? 'clamp(8px, 0.95vh, 11px)' : '11px' }}
        >
          {isFinite(lim) && Math.abs(lim) < 1e21 ? lim.toFixed(0) : lim}
        </span>
      )}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 w-full select-none flex-col overflow-visible">
      {/* The tag and the reading centre on the capsule, not on the column. */}
      <div
        className="flex-shrink-0 truncate text-center font-mono uppercase leading-none tracking-[0.08em] text-ink-2"
        style={{
          paddingRight: gutter,
          paddingBottom: compact ? 'clamp(4px, 0.8vh, 12px)' : 12,
          fontSize: compact ? 'clamp(9px, 1.1vh, 13px)' : 'clamp(12px, 1.5vh, 18px)',
        }}
        title={label}
      >
        {label}
      </div>

      <div className="relative min-h-0 w-full flex-1">
        <div className="absolute inset-y-0 left-0 flex justify-center" style={{ right: gutter }}>
          <div className="relative h-full w-[72%] max-w-[52px]">
            <div
              className="absolute inset-0 overflow-hidden border"
              style={{
                borderRadius: 9,
                borderColor: edge,
                // A faint wash of the channel's colour, so an empty bar still
                // says which trace it is.
                background: !noData && color ? `${color}14` : 'transparent',
              }}
            >
              {sane && !noData && (
                <div
                  className="absolute bottom-0 w-full"
                  style={{
                    height: `${displayHeight}%`,
                    background: barColor,
                    minHeight: value !== 0 ? '2px' : '0px',
                    transition: 'height 0.05s ease-out',
                    opacity: value !== 0 ? 0.85 : 0.3,
                  }}
                />
              )}

              {/* No data: hatch the whole track. An empty bar and a zero bar are the same
                  picture, so the absence of a reading has to be drawn, not implied. */}
              {noData && (
                <div
                  className="pointer-events-none absolute inset-0"
                  style={{
                    background:
                      'repeating-linear-gradient(45deg, rgba(163,163,163,0.20) 0 6px, transparent 6px 12px)',
                  }}
                />
              )}
            </div>
            {limit(meopPct, meop, '#ef4444')}
            {limit(nopPct, nop, '#e5b53a')}
          </div>
        </div>
      </div>

      <div
        className="flex-shrink-0 whitespace-nowrap text-center font-mono leading-none tabular-nums"
        style={{
          color: readout,
          paddingRight: gutter,
          paddingTop: compact ? 'clamp(4px, 0.8vh, 12px)' : 12,
          fontSize: compact ? 'clamp(12px, 1.7vh, 22px)' : 'clamp(16px, 1.9vh, 28px)',
        }}
        title={unit}
      >
        {value !== null ? fmtPressure(value) : '---'}
      </div>
    </div>
  );
}

export default memo(PressureBar);
