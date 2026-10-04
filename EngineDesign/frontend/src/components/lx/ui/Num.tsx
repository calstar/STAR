import type { ReactNode } from 'react';
import { NBSP, partsQ, type Quantity } from '../units';

/**
 * A number and its unit: the number in mono, tabular; the unit 11 px, text-3; joined by a
 * no-break space so the unit never orphans. Give `q` (from useUnits) or `num` + `unit`.
 */
export function Num({ q, num, unit, className = '', numClassName = '' }: {
  q?: Quantity | null;
  num?: ReactNode;
  unit?: string;
  className?: string;
  numClassName?: string;
}) {
  const p = q !== undefined ? partsQ(q) : { num: num ?? '—', unit: unit ?? '' };
  return (
    <span className={`whitespace-nowrap ${className}`}>
      <span className={`lx-num ${numClassName}`}>{p.num}</span>
      {p.unit && <>{NBSP}<span className="lx-unit">{p.unit}</span></>}
    </span>
  );
}
