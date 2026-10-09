import type { ReactNode } from 'react';
import { STATUS_GLYPH, STATUS_VAR, STATUS_WORD, type Status } from './status';

/**
 * A status: glyph and word in the status colour, so colour is never the only signal. No fill:
 * the amber word on an amber wash fails contrast in the light theme.
 */
export function Badge({ status, children, size = 'md', title, className = '' }: {
  status: Status;
  /** The word; defaults to "Within limits" / "Worth a look" / "Fails". */
  children?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  title?: string;
  className?: string;
}) {
  const text = size === 'lg' ? 'text-[15px]' : size === 'sm' ? 'text-[11px]' : 'text-[12px]';
  return (
    <span title={title} className={`inline-flex items-baseline gap-1.5 whitespace-nowrap font-medium ${text} ${className}`} style={{ color: STATUS_VAR[status] }}>
      <span aria-hidden className="font-semibold">{STATUS_GLYPH[status]}</span>
      <span>{children ?? STATUS_WORD[status]}</span>
    </span>
  );
}
