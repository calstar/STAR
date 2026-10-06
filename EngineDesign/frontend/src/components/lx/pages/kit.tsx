import { useId, useMemo, type CSSProperties, type ReactNode } from 'react';
import { Chart, type ChartProps } from '../charts/Chart';
import { SIDE_VAR, SIDE_WORD, type SideKey } from './side';
import { NotComputed, Panel, Popover, STATUS_GLYPH, STATUS_VAR, STATUS_WORD, useHover, type Status } from '../ui';

/**
 * Small pieces the Layer X pages share. Nothing here explains anything on the page: words go in
 * hover cards (Hint, or a glossary Term), numbers on the page.
 */

export type Theme = 'dark' | 'light';

/** A hover card with the page's own words (the glossary's Term is for named quantities). */
export function Hint({ text, children, className = '' }: { text: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  const { open, anchor, handlers } = useHover({ openDelay: 250 });
  if (text === null || text === undefined || text === '') return <>{children}</>;
  return (
    <>
      <span tabIndex={0} aria-describedby={id} {...handlers}
            className={`cursor-help rounded-[2px] underline decoration-[var(--lx-text-3)] decoration-dotted decoration-1 underline-offset-[3px] ${className}`}>
        {children}
      </span>
      <span id={id} hidden>{typeof text === 'string' ? text : null}</span>
      <Popover open={open} anchor={anchor} ariaHidden className="pointer-events-none">
        <span className="block w-[min(340px,calc(100vw-16px))] px-3 py-2.5 text-[12px] leading-[1.45] text-[var(--lx-text-2)]">{text}</span>
      </Popover>
    </>
  );
}

/**
 * The old Layer X blocks (layerx/*.tsx) drawn inside the new console until each is rebuilt: their
 * app colour tokens remapped onto the Layer X ones, so they follow the theme toggle. The accent is
 * a step darker in the dark theme because the old blocks put white text on it.
 */
export function Legacy({ theme, children, className = '' }: { theme: Theme; children: ReactNode; className?: string }) {
  const style = useMemo(() => ({
    '--color-bg-primary': 'var(--lx-bg)',
    '--color-bg-secondary': 'var(--lx-surface)',
    '--color-bg-tertiary': 'var(--lx-surface-2)',
    '--color-border': 'var(--lx-line)',
    '--color-text-primary': 'var(--lx-text)',
    '--color-text-secondary': 'var(--lx-text-2)',
    '--color-text-muted': 'var(--lx-text-3)',
    '--color-accent': theme === 'dark' ? '#5b67d8' : 'var(--lx-accent)',
    '--color-accent-hover': theme === 'dark' ? '#5360cc' : 'var(--lx-accent)',
    '--color-success': 'var(--lx-ok)',
    '--color-warning': 'var(--lx-warn)',
    '--color-danger': 'var(--lx-bad)',
    '--color-lox': 'var(--lx-lox)',
    '--color-fuel': 'var(--lx-fuel)',
  }) as CSSProperties, [theme]);
  return <div className={`min-w-0 ${className}`} style={style}>{children}</div>;
}

/** A chart in its own panel, or the quiet placeholder when the run does not carry it. */
export function ChartPanel({ title, chartTitle, right, className = '', empty, ...chart }: Omit<ChartProps, 'title'> & {
  title: ReactNode; chartTitle?: string; right?: ReactNode; className?: string; empty?: boolean;
}) {
  return (
    <Panel title={title} right={right} className={className} bodyClassName="!pt-1">
      {empty ? <NotComputed height={chart.height - 24} /> : <Chart {...chart} title={chartTitle ?? (typeof title === 'string' ? title : undefined)} />}
    </Panel>
  );
}

/** A status glyph and word, then a label, a value and its limit: a graded check with no scale. */
export function StatusRow({ status, label, value, limit, hint }: { status: Status; label: string; value: string; limit: string; hint?: string }) {
  return (
    <div className="grid grid-cols-[minmax(7rem,1fr)_auto_auto] items-baseline gap-x-4 rounded-[6px] px-2 py-1.5">
      <span className="flex min-w-0 items-baseline gap-2">
        <span aria-label={STATUS_WORD[status]} className="w-3 shrink-0 text-center text-[12px] font-semibold" style={{ color: STATUS_VAR[status] }}>
          {STATUS_GLYPH[status]}
        </span>
        <span className="truncate text-[13px] text-[var(--lx-text)]">{hint ? <Hint text={hint}>{label}</Hint> : label}</span>
      </span>
      <span className="lx-num whitespace-nowrap text-[13px] text-[var(--lx-text)]">{value}</span>
      <span className="whitespace-nowrap text-[11px] text-[var(--lx-text-3)]">{limit}</span>
    </div>
  );
}

/** A limit graded "info" (max-Q): shown with its value, never a status colour. */
export function InfoRow({ label, value, note, hint }: { label: string; value: string; note?: string; hint?: string }) {
  return (
    <div className="grid grid-cols-[minmax(7rem,1fr)_auto_auto] items-baseline gap-x-4 rounded-[6px] px-2 py-1.5">
      <span className="flex min-w-0 items-baseline gap-2">
        <span aria-hidden className="w-3 shrink-0 text-center text-[12px] text-[var(--lx-text-3)]">·</span>
        <span className="truncate text-[13px] text-[var(--lx-text)]">{hint ? <Hint text={hint}>{label}</Hint> : label}</span>
      </span>
      <span className="lx-num whitespace-nowrap text-[13px] text-[var(--lx-text)]">{value}</span>
      <span className="whitespace-nowrap text-[11px] text-[var(--lx-text-3)]">{note ?? 'for information'}</span>
    </div>
  );
}

/** Label / value pairs, two columns, for a record. */
export function Pairs({ rows, className = '' }: { rows: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={`grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-[12px] ${className}`}>
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="truncate text-[var(--lx-text-3)]">{k}</dt>
          <dd className="lx-num min-w-0 truncate text-right text-[var(--lx-text-2)]" title={typeof v === 'string' ? v : undefined}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A compact table: hairline rows, mono numbers, a sticky head when it scrolls. */
export function Table({ head, rows, align, maxHeight, caption }: {
  /** A column's heading; `{ sr }` names a column that shows no heading (a row label column). */
  head: (ReactNode | { sr: string })[];
  rows: ReactNode[][];
  /** 'r' right-aligns a column (numbers). */
  align?: ('l' | 'r')[];
  maxHeight?: number;
  caption?: string;
}) {
  const a = (i: number) => (align?.[i] === 'r' ? 'text-right' : 'text-left');
  return (
    // A region that scrolls is a Tab stop, so the keyboard can scroll it too.
    <div className="min-w-0 overflow-auto" style={maxHeight ? { maxHeight } : undefined}
         tabIndex={maxHeight ? 0 : undefined} role={maxHeight ? 'region' : undefined} aria-label={maxHeight ? caption : undefined}>
      <table className="w-full border-collapse text-[12px]">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="sticky top-0 bg-[var(--lx-surface)]">
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col" className={`whitespace-nowrap border-b border-[var(--lx-line)] px-2 pb-1.5 pt-0.5 font-normal text-[11px] text-[var(--lx-text-3)] ${a(i)}`}>
                {h !== null && typeof h === 'object' && 'sr' in h ? <span className="sr-only">{h.sr}</span> : h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, k) => (
            <tr key={k} className="border-b border-[var(--lx-line)] last:border-b-0">
              {r.map((c, i) => (
                <td key={i} className={`px-2 py-1 align-baseline ${i === 0 ? 'text-[var(--lx-text-2)]' : 'lx-num text-[var(--lx-text)]'} ${a(i)}`}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Figures in a row that wraps cleanly: never overlapping, each at least 9 rem. */
export function FigureRow({ children, min = '9rem' }: { children: ReactNode; min?: string }) {
  return <div className="grid gap-x-6 gap-y-5" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${min}, 1fr))` }}>{children}</div>;
}

/** A side's name in its own colour: LOX blue, fuel tan, gas teal. */
export function SideName({ side, children }: { side: SideKey | null | undefined; children?: ReactNode }) {
  if (!side) return <>{children}</>;
  return <span style={{ color: SIDE_VAR[side] }}>{children ?? SIDE_WORD[side]}</span>;
}

/** A row of label/value figures inside a panel, small: the numbers at the cursor. */
export function Readout({ items }: { items: { label: ReactNode; value: string; title?: string }[] }) {
  return (
    <dl className="grid gap-x-5 gap-y-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(6.5rem, 1fr))' }}>
      {items.map((x, k) => (
        <div key={k} className="min-w-0">
          <dt className="truncate text-[11px] text-[var(--lx-text-3)]">{x.label}</dt>
          <dd className="lx-num truncate text-[13px] text-[var(--lx-text)]" title={x.title ?? x.value}>{x.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The panels a run does not carry yet, named in one quiet line instead of a wall of empty panels.
 * A block that failed keeps its own panel and says why; one that is merely absent goes here.
 */
export function NotYet({ items, className = 'lg:col-span-12' }: { items: string[]; className?: string }) {
  if (!items.length) return null;
  return (
    <div className={`flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 rounded-[6px] border border-dashed border-[var(--lx-line)] px-4 py-3 text-[12px] text-[var(--lx-text-3)] ${className}`}>
      <span>Not computed for this run:</span>
      {items.map((x, k) => <span key={x} className="text-[var(--lx-text-2)]">{x}{k < items.length - 1 ? <span className="text-[var(--lx-text-3)]"> ·</span> : null}</span>)}
    </div>
  );
}
