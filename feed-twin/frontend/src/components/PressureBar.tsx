/**
 * Copied from the DAQ (diablo_server/frontend/components/plots/PressureBar.tsx).
 *
 * Verbatim in every part that decides what an operator sees: the non-linear
 * scale, where the NOP and MEOP lines sit, the thresholds at which the bar
 * changes colour. A re-implementation would drift on exactly those. What is
 * not the DAQ's is the drawing: an outlined capsule in the console's
 * monochrome, neutral below NOP, amber above it, red above MEOP. The limit
 * rules cross the capsule only, and each number sits against the capsule's
 * edge at its rule (the operator, 2026-10-08: rules across the whole column
 * and numbers off at its side read as belonging to the neighbour).
 *
 * Not the DAQ's either: a bar with no limits. The DAQ's sensor config gives
 * every channel a NOP and MEOP; the twin has only what the drawing says, and a
 * transducer on a dome line or manifold reads no vessel's MAWP. Such a bar is
 * linear to a round full scale and draws no rules -- the 550/700 it used to
 * guess from the tag was worse than none.
 *
 * Three of its props are declared there and never read — `unit`, `showLabels`,
 * and one derived value. They are wired up here rather than deleted, because
 * deleting them would make the two files diverge in signature and the next
 * person to copy a fix across would have to notice.
 */

import { useMemo, memo } from 'react';

interface PressureBarProps {
  label: string;
  value: number | null;
  nop?: number;
  meop?: number;
  color?: string;
  /** The fill while the reading is under NOP -- the channel's trace colour,
   *  so a bar and its line on the plot are the same thing. Above NOP the
   *  DAQ's amber and red still take over; `color` overrides even those. */
  tint?: string;
  unit?: string;
  showLabels?: boolean; // Show NOP/MEOP labels on this bar (default true)
  compact?: boolean;    // Reduced font sizes for use in tight spaces
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

/** A bar with no limits reads to the first of these its value fits under. */
const FULL_SCALES = [1000, 5000, 10000];

function PressureBar({
  label,
  value,
  nop: drawnNop,
  meop: drawnMeop,
  color,
  tint = '#d9d9d9',
  unit = 'psig',
  showLabels = true,
  compact = false,
}: PressureBarProps) {
  const displayValue = value ?? 0;
  const bare = drawnMeop === undefined;
  // A red line alone (the drawing's operating pressure is not under it): the
  // DAQ's scale still wants an amber knee, so it sits where the DAQ's would.
  const meop = drawnMeop ?? 0;
  const nop = drawnNop ?? meop * 0.85;

  const { sane, nopPct, meopPct, displayHeight, barColor, level } = useMemo(() => {
    if (bare) {
      const sane = isFinite(displayValue) && Math.abs(displayValue) < 100000;
      const full = FULL_SCALES.find((f) => displayValue <= f) ?? FULL_SCALES[FULL_SCALES.length - 1];
      const pct = sane ? Math.min(Math.max(displayValue / full, 0), 1) * 100 : 0;
      const displayHeight = sane && value !== null && value !== 0 ? Math.max(pct, 2) : pct;
      return { sane, nopPct: 0, meopPct: 0, displayHeight, barColor: color || tint, level: 'ok' as const };
    }
    const maxVal = Math.max(meop * 1.3, 1000);
    const sane = isFinite(displayValue) && Math.abs(displayValue) < 100000;
    const clampedDisplayValue = Math.max(0, displayValue);
    const valuePct = sane ? Math.min(Math.max(nonLinearPct(clampedDisplayValue, nop, meop, maxVal), 0), 100) : 0;
    const nopPct = nonLinearPct(nop, nop, meop, maxVal);
    const meopPct = nonLinearPct(meop, nop, meop, maxVal);
    const minVisibleHeight = 2;
    const displayHeight = sane && value !== null && value !== 0
      ? Math.max(valuePct, minVisibleHeight)
      : valuePct;
    const level = sane && displayValue > meop ? 'meop' : sane && displayValue > nop ? 'nop' : 'ok';
    const barColor = color || (level === 'meop' ? '#ef4444' : level === 'nop' ? '#e5b53a' : tint);

    return { sane, nopPct, meopPct, displayHeight, barColor, level };
  }, [displayValue, value, nop, meop, color, tint, bare]);

  const readout = level === 'meop' ? '#f87171' : level === 'nop' ? '#e5b53a' : 'var(--ink)';
  /** Width kept to the right of the capsule for the limit numbers [px].
   *  Seven bars leave a column too narrow to set "4500" beside a centred
   *  capsule; laid over it, the number vanished into the fill. So the
   *  capsule shares its column with a gutter, and the numbers live there. */
  const GUTTER = showLabels ? 32 : 0;

  // A rule across the capsule, and its number just outside the capsule's
  // right edge, centred on the rule.
  const limit = (pct: number, v: number, tone: string) => (
    <div className="pointer-events-none absolute inset-x-0" style={{ bottom: `${pct.toFixed(2)}%` }}>
      <div className="border-t border-dashed" style={{ borderColor: tone, opacity: 0.75 }} />
      {showLabels && (
        <span
          className="absolute left-full -translate-y-1/2 whitespace-nowrap pl-1 font-mono text-[10px] leading-none tabular-nums"
          style={{ color: tone, top: 0 }}
        >
          {isFinite(v) && Math.abs(v) < 1e21 ? v.toFixed(0) : v}
        </span>
      )}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 w-full select-none flex-col">
      {/* The tag and the reading centre on the capsule, not on the column. */}
      <div
        className={`flex-shrink-0 truncate pb-3 text-center font-mono uppercase tracking-[0.08em] text-[var(--ink-2)] ${
          compact ? 'text-[11px]' : 'text-[12px]'
        }`}
        style={{ paddingRight: GUTTER }}
        title={label}
      >
        {label}
      </div>

      <div className="relative min-h-0 w-full flex-1">
        {/* The capsule. Its fill is inside the outline, so the limit rules,
            which are laid out against the full column height, sit where the
            DAQ puts them to within the outline's pixel. */}
        <div className="absolute inset-y-0 left-0 flex justify-center" style={{ right: GUTTER }}>
          {/* The capsule's own box: the rules span it and their numbers hang
              off its right edge, so they move with it. */}
          <div className="relative h-full w-[72%] max-w-[52px]">
            <div
              className="absolute inset-0 overflow-hidden border"
              style={{
                borderRadius: 9,
                borderColor: level === 'meop' ? '#ef4444' : level === 'nop' ? '#e5b53a' : 'var(--line-strong)',
                // A faint wash of the channel's colour, so an empty bar still
                // says which trace it is.
                background: color ? undefined : `${tint}12`,
              }}
            >
              {sane && value !== null && (
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
            </div>
            {!bare && limit(meopPct, meop, '#ef4444')}
            {!bare && drawnNop !== undefined && limit(nopPct, nop, '#e5b53a')}
          </div>
        </div>
      </div>

      <div
        className={`flex-shrink-0 whitespace-nowrap pt-3 text-center font-mono leading-none tabular-nums ${compact ? 'text-[18px]' : 'text-[clamp(16px,1.35vw,24px)]'}`}
        style={{ color: readout, paddingRight: GUTTER }}
        title={`${unit}`}
      >
        {value !== null ? fmtPressure(value) : '---'}
      </div>
    </div>
  );
}

export default memo(PressureBar);
