'use client'

import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { NAV_ITEMS, resolveTabItems } from '@/lib/nav-items';
import { useGuiConfig } from '@/lib/gui-config';

/** Shared classes for a single tab pill. */
function tabClass(active: boolean): string {
  return [
    'relative px-3 py-1 text-sm font-bold uppercase tracking-wider whitespace-nowrap rounded-md transition-colors',
    active
      ? 'text-white bg-white/[0.06]'
      : 'text-gray-400 hover:text-gray-200 hover:bg-white/[0.03]',
  ].join(' ');
}

/** Coloured underline shown on the active tab (accent per view). */
function ActiveRail({ accent }: { accent: string }) {
  return (
    <span
      className="absolute left-2 right-2 -bottom-[7px] h-0.5 rounded-full"
      style={{ backgroundColor: accent }}
    />
  );
}

/**
 * Row of tabs under the header. Common views scroll inline; the rest live behind
 * the "All Views" tab (a dedicated page/grid) plus a quick-pick dropdown. The
 * All Views control sits OUTSIDE the horizontal scroller — an `overflow-x` box
 * also clips vertical overflow, which would otherwise hide the dropdown.
 * Route-based — each tab is a real subpath, so it deep-links, supports
 * back/forward, and can be popped out.
 */
export default function TabBar() {
  const { pathname } = useLocation();
  const { tabs } = useGuiConfig();
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);

  // Pinned tabs + order come from config.toml [gui].tabs (falls back to nav-items
  // `common` flags). The dropdown lists everything else that isn't deprecated.
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

  return (
    <div className="relative z-20 w-full bg-card border-b border-gray-800 flex-shrink-0">
      <div className="flex items-stretch py-1 gap-1">
        {/* Pinned common views (Single Pane first) — wraps to fit, never scrolls */}
        <div className="flex flex-wrap items-center content-center gap-1 px-3 flex-1 min-w-0">
          {pinnedItems.map((item) => (
            <NavLink key={item.id} to={item.path} className={({ isActive }) => tabClass(isActive)}>
              {({ isActive }) => (
                <>
                  {item.name}
                  {isActive && <ActiveRail accent={item.accent} />}
                </>
              )}
            </NavLink>
          ))}
        </div>

        {/* All Views: link to the grid page + dropdown of the less-used views.
            Kept out of the scroller above so the dropdown isn't clipped. */}
        <div className="relative flex items-stretch flex-shrink-0 gap-0.5 px-2 border-l border-gray-800/60" ref={overflowRef}>
          <NavLink to="/views" className={() => tabClass(onAllViews)}>
            All Views
            {onAllViews && <ActiveRail accent="#9CA3AF" />}
          </NavLink>
          <button
            type="button"
            aria-label="Quick-pick another view"
            aria-expanded={overflowOpen}
            onClick={() => setOverflowOpen((v) => !v)}
            className={`px-1.5 rounded-md text-xs transition-colors ${
              overflowOpen ? 'text-white bg-white/[0.06]' : 'text-gray-400 hover:text-gray-200 hover:bg-white/[0.03]'
            }`}
          >
            ▾
          </button>

          {overflowOpen && (
            <div className="absolute right-0 top-full mt-1 z-50 w-56 max-h-[70vh] overflow-y-auto bg-background border border-gray-700 rounded-lg shadow-xl py-1">
              {overflowItems.map((item) => {
                const active = pathname === item.path;
                return (
                  <NavLink
                    key={item.id}
                    to={item.path}
                    className={`flex items-center gap-2 px-3 py-1.5 text-xs font-semibold ${
                      active ? 'text-white bg-white/[0.06]' : 'text-gray-300 hover:bg-white/[0.04]'
                    }`}
                  >
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: item.accent }} />
                    <span className="truncate">{item.name}</span>
                  </NavLink>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
