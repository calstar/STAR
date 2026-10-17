/**
 * A typed pressure: read and typed in psia, kept in gauge.
 *
 * The number in the box is absolute; what it hands back is the gauge number
 * the wire takes (lib/pressure.ts), snapped to the field's detent in psia.
 * It commits a moment after the typing stops, and on Enter or leaving the
 * box -- not on every keystroke, because a keystroke snapped to a 5 psi
 * detent turns "1" into "0" before the "15" can be typed.
 */

import { useEffect, useRef, useState } from 'react';
import { psiaEntry, snapPsia } from '../lib/pressure';

/** Typing pauses this long before the stand hears the new number [ms]. */
const COMMIT_MS = 400;

export function PsiaInput({
  value,
  step,
  onCommit,
  low,
  high,
  disabled = false,
  title,
  className,
  ariaLabel,
}: {
  /** Gauge, as on the wire. */
  value: number;
  /** The detent [psi], in psia: what a typed value snaps to and the arrows step by. */
  step: number;
  /** The gauge number to keep. Called only when it changed. */
  onCommit: (gauge: number) => void;
  /** Bounds, gauge, as the wire states them. */
  low?: number;
  high?: number;
  disabled?: boolean;
  title?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState(() => psiaEntry(value));
  const editing = useRef(false);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!editing.current) setDraft(psiaEntry(value));
  }, [value]);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  /** The gauge number `raw` stands for, or null when it is not a number. */
  const parse = (raw: string): number | null => {
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n)) return null;
    return snapPsia(n, step, low, high);
  };
  const flush = (raw: string) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const gauge = parse(raw);
    if (gauge !== null && Math.abs(gauge - value) > 1e-9) onCommit(gauge);
    return gauge;
  };

  return (
    <input
      type="number"
      inputMode="decimal"
      value={draft}
      step={step}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      onFocus={() => {
        editing.current = true;
      }}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => flush(raw), COMMIT_MS);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          const gauge = flush(draft);
          setDraft(psiaEntry(gauge ?? value));
        }
      }}
      onBlur={() => {
        editing.current = false;
        const gauge = flush(draft);
        setDraft(psiaEntry(gauge ?? value));
      }}
      className={className}
    />
  );
}
