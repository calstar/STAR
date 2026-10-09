import type { ReactNode } from 'react';
import type { GlossaryKey } from '../glossary';
import { NBSP, partsQ, type Quantity } from '../units';
import { DeltaChip } from './DeltaChip';
import { Term } from './Term';

const SIZE = { sm: 'text-[16px]', md: 'text-[22px]', lg: 'text-[28px]' } as const;

/**
 * A headline figure: label (12 px, text-2), the value in mono with its unit, an optional delta
 * chip against the compared run, and a sub-line. The value never wraps; the chip sits beside it in
 * the verdict strip and under it elsewhere; the sub truncates and keeps its full text in a tooltip.
 * 22 px in figures, 28 px for the verdict strip.
 */
export function Figure({ label, q, value, unit, delta, deltaTitle, sub, size = 'md', termKey, className = '' }: {
  label: string;
  /** The value from useUnits; or give `value` and `unit` already formatted. */
  q?: Quantity | null;
  value?: string;
  unit?: string;
  /** From `deltaText`. */
  delta?: string | null;
  deltaTitle?: string;
  sub?: ReactNode;
  size?: keyof typeof SIZE;
  termKey?: GlossaryKey;
  className?: string;
}) {
  const p = q !== undefined ? partsQ(q) : { num: value ?? '—', unit: unit ?? '' };
  const subTitle = typeof sub === 'string' ? sub : undefined;
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="truncate text-[12px] leading-4 text-[var(--lx-text-2)]">
        {termKey ? <Term k={termKey}>{label}</Term> : label}
      </div>
      {/* The verdict's wide figures keep the chip beside the value (it wraps under it rather than
          run into the next figure). In a row of narrower figures it always sits under the value, so
          the row reads level instead of some chips beside and some under. */}
      <div className={`mt-1.5 flex items-baseline gap-x-2 gap-y-1 ${size === 'lg' ? 'flex-wrap' : 'flex-col !items-start'}`}>
        <span className="whitespace-nowrap">
          <span className={`lx-num font-medium leading-none tracking-[-0.01em] text-[var(--lx-text)] ${SIZE[size]}`}>{p.num}</span>
          {p.unit && <>{NBSP}<span className="text-[11px] text-[var(--lx-text-3)]">{p.unit}</span></>}
        </span>
        <DeltaChip text={delta} title={deltaTitle} className={size === 'lg' ? 'self-center' : ''} />
      </div>
      {sub !== undefined && sub !== null && sub !== '' && (
        <div className="lx-num mt-1.5 truncate text-[11px] leading-4 text-[var(--lx-text-3)]" title={subTitle}>{sub}</div>
      )}
    </div>
  );
}
