import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { GLOSSARY, type GlossaryKey } from '../glossary';
import { useHover } from './hover';
import { directionWords, sortWorstFirst, thinLabels, type MarginScale, type Zone } from './margin';
import { Popover } from './Popover';
import { STATUS_GLYPH, STATUS_VAR, STATUS_WORD, type Status } from './status';

const ZONE_BG: Record<Zone['status'], string> = { ok: 'transparent', warn: 'var(--lx-warn-zone)', bad: 'var(--lx-bad-zone)' };

/** Inside a MarginList: the bar takes the list's columns, so every value and track line up. */
const InList = createContext(false);

/**
 * One graded limit as a horizontal bar (docs/layerx/GUI-SPEC.md, MarginBar):
 *
 *   ✓ Chug margin            1.33   ├─────────▌────█───────────┤
 *     > 1                    worst at T+0.04 s   1.0  1.2
 *
 * The track is coloured by grade from `scale` (lx/ui/margin.ts: marginScale): amber band, the
 * region past the red line, the red line itself, and the value's marker. Click, Enter or Space
 * calls `onJump` (the time store sets the cursor to the worst moment). The hover card carries the
 * reasoning behind the threshold and the direction in words.
 */
export function MarginBar({ label, value, status, scale, worstText, limitText, onJump, termKey, hint, className = '' }: {
  label: string;
  /** The value, formatted with its unit: "1.33", "35.6 %", "564 psig". */
  value: string;
  status: Status;
  scale: MarginScale;
  /** "worst at T+0.04 s" */
  worstText?: string;
  /** "> 1", "≤ 1,000 psi MAWP" */
  limitText?: string;
  onJump?: () => void;
  termKey?: GlossaryKey;
  /** Why the threshold is where it is: the old verdict hints. */
  hint?: ReactNode;
  className?: string;
}) {
  const cardId = useId();
  const { open, anchor, handlers } = useHover({ openDelay: 300 });
  const entry = termKey ? GLOSSARY[termKey] : undefined;
  const inList = useContext(InList);
  const direction = directionWords(scale);
  const name = [`${label} ${value}`, STATUS_WORD[status], worstText, limitText && `limit ${limitText}`].filter(Boolean).join(', ');

  const body = (
    <>
      {/* Row 1: status and label, value, track. */}
      <span className="flex min-w-0 items-center gap-2">
        <span aria-hidden className="w-3 shrink-0 text-center text-[12px] font-semibold leading-none" style={{ color: STATUS_VAR[status] }}>
          {STATUS_GLYPH[status]}
        </span>
        {/* A long label is cut with an ellipsis; its whole text is in the tooltip and the name. */}
        <span title={label} className={`min-w-0 truncate text-[13px] text-[var(--lx-text)] ${entry ? 'underline decoration-[var(--lx-text-3)] decoration-dotted decoration-1 underline-offset-[3px]' : ''}`}>
          {label}
        </span>
      </span>
      <span className="lx-num whitespace-nowrap text-right text-[13px] text-[var(--lx-text)]">{value}</span>
      <Track scale={scale} />
      {/* Row 2: the limit, when the worst was, the edge values under the track. */}
      <span title={limitText} className="min-w-0 truncate pl-5 text-[11px] leading-4 text-[var(--lx-text-3)]">{limitText}</span>
      <span title={worstText} className="lx-num min-w-0 truncate whitespace-nowrap text-right text-[11px] leading-4 text-[var(--lx-text-3)]">{worstText}</span>
      <TickLabels scale={scale} />
    </>
  );

  // Alone, the bar's own columns (the value's wide enough for "1,234 psig"); in a list, the list's,
  // where the value column is as wide as the widest value, so none is cut and all line up.
  const cols = inList ? 'col-span-full grid-cols-subgrid' : 'grid-cols-[minmax(7rem,1fr)_minmax(7.5rem,max-content)_minmax(8rem,1.5fr)]';
  const grid = `grid w-full min-w-0 ${cols} items-center gap-x-4 gap-y-0.5 rounded-[6px] px-2 py-1.5 text-left ${className}`;

  return (
    <>
      {onJump ? (
        <button type="button" onClick={onJump} aria-label={`${name}. Jump to the worst moment.`} aria-describedby={cardId} {...handlers}
                className={`${grid} cursor-pointer transition-[color,background-color,border-color] duration-100 hover:bg-[var(--lx-surface-2)]`}>
          {body}
        </button>
      ) : (
        <div role="group" tabIndex={0} aria-label={name} aria-describedby={cardId} {...handlers} className={grid}>
          {body}
        </div>
      )}
      <span id={cardId} hidden>{[direction + '.', typeof hint === 'string' ? hint : '', entry?.short].filter(Boolean).join(' ')}</span>
      <Popover open={open} anchor={anchor} ariaHidden className="pointer-events-none">
        <span className="block w-[min(340px,calc(100vw-16px))] px-3 py-2.5">
          <span className="flex items-baseline justify-between gap-3">
            <span className="text-[13px] font-medium text-[var(--lx-text)]">{label}</span>
            <span className="text-[11px] font-medium" style={{ color: STATUS_VAR[status] }}>
              {STATUS_GLYPH[status]} {STATUS_WORD[status]}
            </span>
          </span>
          {hint && <span className="mt-1 block text-[12px] leading-[1.45] text-[var(--lx-text-2)]">{hint}</span>}
          {entry && <span className="mt-1.5 block text-[12px] leading-[1.45] text-[var(--lx-text-2)]">{entry.short}</span>}
          <span className="mt-2 block text-[11px] text-[var(--lx-text-3)]">
            {direction}{limitText ? ` · limit ${limitText}` : ''}{onJump ? ' · click to jump to the worst moment' : ''}
          </span>
        </span>
      </Popover>
    </>
  );
}

/** The bar itself: zones, the edges, the value's marker. Decorative to a screen reader: the
 * button's name carries the value and the grade. */
function Track({ scale }: { scale: MarginScale }) {
  const pct = (x: number) => `${(x * 100).toFixed(3)}%`;
  return (
    <span aria-hidden className="relative block h-4 min-w-0">
      <span className="absolute inset-x-0 top-1/2 block h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-[var(--lx-line)]">
        {scale.zones.filter((z) => z.status !== 'ok').map((z) => (
          <span key={`${z.from}-${z.status}`} className="absolute inset-y-0 block" style={{ left: pct(z.from), width: pct(z.to - z.from), background: ZONE_BG[z.status] }} />
        ))}
      </span>
      {scale.ticks.map((t) => {
        const red = t.kind === 'limit' || t.kind === 'far-limit';
        return (
          <span key={t.kind} className="absolute top-[1px] bottom-[1px] block -translate-x-1/2"
                style={{ left: pct(Math.min(1, Math.max(0, t.pos))), width: red ? 2 : 1, background: red ? 'var(--lx-bad)' : 'var(--lx-warn)' }} />
        );
      })}
      {scale.pos !== null && (
        <span className="absolute top-1/2 block h-4 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-[1px] bg-[var(--lx-text)]"
              style={{ left: pct(scale.pos), boxShadow: '0 0 0 2px var(--lx-surface)' }} />
      )}
      {scale.clamped && (
        <span className={`absolute top-1/2 -translate-y-1/2 text-[10px] leading-none text-[var(--lx-text)] ${scale.clamped === 'above' ? '-right-2.5' : '-left-2.5'}`}>
          {scale.clamped === 'above' ? '›' : '‹'}
        </span>
      )}
    </span>
  );
}

/** The labelled edges under the track: "1.0", "1.2". Kept inside the track's width at its ends,
 * and thinned at the width the track is actually drawn. */
function TickLabels({ scale }: { scale: MarginScale }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const ticks = width === null ? scale.ticks : thinLabels(scale.ticks, width);
  return (
    <span ref={ref} aria-hidden className="relative block h-4 min-w-0">
      {ticks.filter((t) => t.label).map((t) => {
        const x = Math.min(1, Math.max(0, t.pos));
        const shift = x < 0.06 ? '0' : x > 0.94 ? '-100%' : '-50%';
        return (
          <span key={t.kind} className="lx-num absolute top-0 whitespace-nowrap text-[11px] leading-4 text-[var(--lx-text-3)]"
                style={{ left: `${(x * 100).toFixed(3)}%`, transform: `translateX(${shift})` }}>
            {t.text}
          </span>
        );
      })}
    </span>
  );
}

export interface MarginItem {
  key: string;
  label: string;
  value: string;
  status: Status;
  scale: MarginScale;
  worstText?: string;
  limitText?: string;
  onJump?: () => void;
  termKey?: GlossaryKey;
  hint?: ReactNode;
}

/**
 * Every graded limit as margin bars, worst first (bad, then amber, then ok; nearest its edge first
 * within a grade), in one grid so the labels, values and tracks line up down the list and no value
 * is ever cut or wrapped.
 */
export function MarginList({ items, sort = true, className = '' }: { items: readonly MarginItem[]; sort?: boolean; className?: string }) {
  const rows = sort ? sortWorstFirst(items) : items;
  return (
    <div className={`grid min-w-0 grid-cols-[minmax(7rem,1fr)_max-content_minmax(8rem,1.5fr)] gap-y-0.5 ${className}`}>
      <InList.Provider value>
        {rows.map(({ key, ...bar }) => <MarginBar key={key} {...bar} />)}
      </InList.Provider>
    </div>
  );
}
