import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface SegmentOption<T extends string> { value: T; label: ReactNode; title?: string; disabled?: boolean }

/**
 * A one-of-few choice: psi | bar, hot fire | cold flow. A radio group: one Tab stop, arrows move
 * and select, as a native radio group does.
 */
export function Segmented<T extends string>({ value, options, onChange, ariaLabel, disabled = false, size = 'md', className = '' }: {
  value: T;
  options: SegmentOption<T>[];
  onChange: (v: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.map((o, i) => (o.disabled || disabled ? -1 : i)).filter((i) => i >= 0);
  const current = options.findIndex((o) => o.value === value);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    let next: number | undefined;
    if (step !== undefined) {
      const k = enabled.indexOf(current);
      next = enabled[(k + step + enabled.length) % enabled.length];
    } else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    if (next === undefined) return;
    e.preventDefault();
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  const h = size === 'sm' ? 'h-6' : 'h-7';
  return (
    <div role="radiogroup" aria-label={ariaLabel} aria-disabled={disabled || undefined} onKeyDown={onKeyDown}
         className={`inline-flex ${h} items-stretch gap-[2px] rounded-[6px] border border-[var(--lx-line-strong)] bg-[var(--lx-surface-2)] p-[2px] ${className}`}>
      {options.map((o, i) => {
        const on = o.value === value;
        // The selected one is the Tab stop; with nothing selected, the first.
        const stop = on || (current < 0 && i === enabled[0]);
        return (
          <button key={o.value} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={on}
                  tabIndex={stop ? 0 : -1} disabled={disabled || o.disabled} title={o.title} onClick={() => onChange(o.value)}
                  className={`cursor-pointer whitespace-nowrap rounded-[4px] px-2.5 text-[12px] leading-none transition-[color,background-color,border-color] duration-100 disabled:cursor-not-allowed disabled:opacity-45 ${
                    on ? 'bg-[var(--lx-raised)] font-medium text-[var(--lx-text)] shadow-[0_0_0_1px_var(--lx-line-strong)]'
                       : 'text-[var(--lx-text-2)] hover:text-[var(--lx-text)]'}`}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
