'use client'

import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { NAV_ITEMS, navItemByPath, resolveTabItems } from '@/lib/nav-items';
import { useGuiConfig } from '@/lib/gui-config';

/** One view in the line: mono, quiet until it is the one, a hairline under it then. */
function tabClass(active: boolean): string {
  return [
    'relative flex-shrink-0 whitespace-nowrap pb-1.5 font-mono text-[13px] tracking-[0.04em] transition-colors',
    active ? 'text-ink' : 'text-ink-3 hover:text-ink-2',
  ].join(' ');
}

function ActiveRule() {
  return <span className="absolute inset-x-0 bottom-0 h-px bg-ink" />;
}

/**
 * The header's first line, as feed-twin draws it: the brand and the views.
 *
 * Pinned views come from config.toml [gui].tabs (falling back to nav-items
 * `common` flags); the rest live behind All Views -- a grid page plus a
 * quick-pick dropdown. The All Views control sits OUTSIDE the horizontal
 * scroller, since an `overflow-x` box also clips vertical overflow and would
 * hide the dropdown. Route-based: each view is a real subpath, so it
 * deep-links, supports back/forward, and can be popped out.
 *
 * The brand is drawn as Hotbench's header draws its own (lib/stardesign-ui
 * SuiteSwitcher): the wordmark, "a STAR project" under it, and a hairline
 * between it and the views. The DAQ is not one of Hotbench's apps, so it has
 * no switcher -- only the same face.
 *
 * In a popup (`nav={false}`) the line keeps the brand and names the one view
 * the window holds.
 */
export default function TabBar({ nav = true }: { nav?: boolean }) {
  const { pathname } = useLocation();
  const { tabs } = useGuiConfig();
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);

  const pinnedItems = resolveTabItems(tabs);
  const pinnedIds = new Set(pinnedItems.map((i) => i.id));
  const overflowItems = NAV_ITEMS.filter((i) => !pinnedIds.has(i.id) && !i.deprecated);

  // Close the overflow dropdown on outside click / route change.
  useEffect(() => setOverflowOpen(false), [pathname]);
  useEffect(() => {
    if (!overflowOpen) return;
    const onDown = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setOverflowOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [overflowOpen]);

  const onAllViews = pathname === '/views';
  // A view reached through the dropdown is still the one you are on: say so.
  const current = navItemByPath(pathname);
  const offLine = current && !pinnedIds.has(current.id) ? current : undefined;

  return (
    <div className="relative z-40 flex min-w-0 flex-nowrap items-center gap-7 px-8 pt-3 max-[1400px]:gap-5 max-[1400px]:px-5">
      <span className="flex flex-shrink-0 flex-col whitespace-nowrap border-r border-line pb-1.5 pr-7 font-mono leading-none max-[1400px]:pr-5">
        <span
          className="text-[15px] font-bold uppercase tracking-[0.34em] text-ink"
          title="Diablo DAQ: the stand's data acquisition and control. A STAR project."
        >
          Diablo DAQ
        </span>
        <span className="mt-1 text-[9px] tracking-[0.08em] text-ink-3">a STAR project</span>
      </span>

      {!nav ? (
        current && (
          <span className="relative self-end pb-1.5 font-mono text-[13px] tracking-[0.04em] text-ink">
            {current.name}
            <ActiveRule />
          </span>
        )
      ) : (
        <>
          {/* On a laptop the views no longer fit: the nav scrolls on its own
              rather than wrapping onto a second row or the page sideways. */}
          <nav className="flex min-w-0 flex-1 flex-nowrap items-baseline gap-x-6 self-end overflow-x-auto [scrollbar-width:none] max-[1400px]:gap-x-4">
            {pinnedItems.map((item) => (
              <NavLink key={item.id} to={item.path} title={item.description} className={({ isActive }) => tabClass(isActive)}>
                {({ isActive }) => (
                  <>
                    {item.name}
                    {isActive && <ActiveRule />}
                  </>
                )}
              </NavLink>
            ))}
            {offLine && (
              <span className={tabClass(true)} title={offLine.description}>
                {offLine.name}
                <ActiveRule />
              </span>
            )}
          </nav>

          <div className="relative flex flex-shrink-0 items-baseline gap-2 self-end" ref={overflowRef}>
            <NavLink to="/views" className={() => tabClass(onAllViews)}>
              All Views
              {onAllViews && <ActiveRule />}
            </NavLink>
            <button
              type="button"
              aria-label="Quick-pick another view"
              aria-expanded={overflowOpen}
              onClick={() => setOverflowOpen((v) => !v)}
              className={`pb-1.5 font-mono text-[12px] transition-colors ${
                overflowOpen ? 'text-ink' : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              ▾
            </button>

            {overflowOpen && (
              <div className="absolute right-0 top-full z-50 mt-2 max-h-[70vh] w-60 overflow-y-auto border border-line-strong bg-black py-1">
                {overflowItems.map((item) => {
                  const active = pathname === item.path;
                  return (
                    <NavLink
                      key={item.id}
                      to={item.path}
                      title={item.description}
                      className={`flex items-center gap-2.5 px-3 py-1.5 font-mono text-[12px] tracking-[0.04em] ${
                        active ? 'bg-white/[0.06] text-ink' : 'text-ink-2 hover:bg-white/[0.04] hover:text-ink'
                      }`}
                    >
                      <span className="h-1.5 w-1.5 flex-shrink-0" style={{ backgroundColor: item.accent }} />
                      <span className="truncate">{item.name}</span>
                    </NavLink>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
