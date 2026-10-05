import { useId, type ReactNode } from 'react';

/**
 * A panel: surface, 1 px hairline, 6 px radius, a title and an optional right slot. Panels do not
 * nest; group inside one with spacing, not another border.
 */
export function Panel({ title, right, children, className = '', bodyClassName = '', flush = false, ariaLabel, headingLevel = 2, id }: {
  title?: ReactNode;
  /** Controls or a caption at the title's right: a segmented choice, "worst at T+0.04 s". */
  right?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** No body padding: a chart or table that runs to the panel's edges. */
  flush?: boolean;
  /** The region's name when there is no title. */
  ariaLabel?: string;
  headingLevel?: 2 | 3 | 4;
  id?: string;
}) {
  const hid = useId();
  const H = `h${headingLevel}` as 'h2' | 'h3' | 'h4';
  const head = title !== undefined || right !== undefined;
  return (
    <section id={id} aria-labelledby={title !== undefined ? hid : undefined} aria-label={title === undefined ? ariaLabel : undefined}
             className={`min-w-0 rounded-[6px] border border-[var(--lx-line)] bg-[var(--lx-surface)] ${className}`}>
      {head && (
        <div className="flex min-h-[40px] items-center justify-between gap-3 px-4 pt-3">
          {title !== undefined ? <H id={hid} className="min-w-0 truncate text-[13px] font-medium leading-5 text-[var(--lx-text)]">{title}</H> : <span />}
          {right !== undefined && <div className="flex shrink-0 items-center gap-2 text-[12px] text-[var(--lx-text-3)]">{right}</div>}
        </div>
      )}
      <div className={`${flush ? '' : head ? 'px-4 pb-4 pt-3' : 'p-4'} ${bodyClassName}`}>{children}</div>
    </section>
  );
}

/** Data this run does not carry yet: quiet, never an error. */
export function NotComputed({ children = 'Not computed for this run', height = 96 }: { children?: ReactNode; height?: number }) {
  return (
    <div className="flex items-center justify-center text-[12px] text-[var(--lx-text-3)]" style={{ minHeight: height }}>
      {children}
    </div>
  );
}
