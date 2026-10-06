import type { ReactNode } from 'react';

/** A key, as the shortcut sheet and hover hints show it. */
export function Kbd({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={`lx-num inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-[var(--lx-line-strong)] bg-[var(--lx-surface-2)] px-1 text-[11px] font-normal leading-none text-[var(--lx-text-2)] ${className}`}>
      {children}
    </kbd>
  );
}
