import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { panelId, tabId } from './ids';

export interface TabSpec<K extends string> {
  key: K;
  label: ReactNode;
  /** After the label: a status glyph, a count. */
  badge?: ReactNode;
  disabled?: boolean;
  title?: string;
}

/**
 * Page tabs: Overview, Feed, Engine... A tablist with one Tab stop; ←/→/Home/End move and select.
 * The page's question sits under them in `subtitle` ("Will it work?"). Give each page panel
 * `tabPanelProps(idPrefix, key)` so the tab names it.
 */
export function Tabs<K extends string>({ tabs, value, onChange, ariaLabel, idPrefix = 'lx', subtitle, right, className = '' }: {
  tabs: TabSpec<K>[];
  value: K;
  onChange: (k: K) => void;
  ariaLabel: string;
  idPrefix?: string;
  subtitle?: ReactNode;
  /** At the tab row's right: page-level controls. */
  right?: ReactNode;
  className?: string;
}) {
  const refs = useRef(new Map<K, HTMLButtonElement>());
  const live = tabs.filter((t) => !t.disabled).map((t) => t.key);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = live.indexOf(value);
    let next: K | undefined;
    if (e.key === 'ArrowRight') next = live[(i + 1) % live.length];
    else if (e.key === 'ArrowLeft') next = live[(i - 1 + live.length) % live.length];
    else if (e.key === 'Home') next = live[0];
    else if (e.key === 'End') next = live[live.length - 1];
    if (next === undefined) return;
    e.preventDefault();
    onChange(next);
    refs.current.get(next)?.focus();
  };

  return (
    <div className={className}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 border-b border-[var(--lx-line)]">
        <div role="tablist" aria-label={ariaLabel} onKeyDown={onKeyDown} className="-mb-px flex min-w-0 gap-1 overflow-x-auto">
          {tabs.map((t) => {
            const on = t.key === value;
            return (
              <button key={t.key} ref={(el) => { if (el) refs.current.set(t.key, el); else refs.current.delete(t.key); }}
                      type="button" role="tab" id={tabId(idPrefix, t.key)} aria-selected={on} aria-controls={panelId(idPrefix, t.key)}
                      tabIndex={on ? 0 : -1} disabled={t.disabled} title={t.title} onClick={() => onChange(t.key)}
                      className={`inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 focus-visible:-outline-offset-2 text-[13px] transition-[color,background-color,border-color] duration-100 disabled:cursor-not-allowed disabled:opacity-45 ${
                        on ? 'border-[var(--lx-accent)] text-[var(--lx-text)]' : 'border-transparent text-[var(--lx-text-2)] hover:text-[var(--lx-text)]'}`}>
                {t.label}
                {t.badge}
              </button>
            );
          })}
        </div>
        {right && <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 pb-1">{right}</div>}
      </div>
      {subtitle && <div className="mt-2 text-[12px] text-[var(--lx-text-3)]">{subtitle}</div>}
    </div>
  );
}
