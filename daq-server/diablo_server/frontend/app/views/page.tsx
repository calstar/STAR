'use client'

import { NavLink } from 'react-router-dom';
import { ACTIVE_NAV_ITEMS, DEPRECATED_NAV_ITEMS, resolveTabItems, type NavItem } from '@/lib/nav-items';
import { useGuiConfig } from '@/lib/gui-config';

// ── Single view card — navigates to the view's canonical route ───────────────
function ViewCard({ item, muted, pinned }: { item: NavItem; muted?: boolean; pinned?: boolean }) {
  return (
    <NavLink
      to={item.path}
      className={`relative overflow-hidden backdrop-blur-md rounded-xl border transition-all duration-300 text-left group
                  hover:bg-white/[0.06] hover:shadow-xl hover:-translate-y-0.5
                  ${muted ? 'bg-white/[0.01] border-white/5 opacity-70 hover:opacity-100' : 'bg-white/[0.02] border-white/5'}`}
    >
      <div className="absolute left-0 top-0 bottom-0 w-1.5 rounded-l-lg" style={{ backgroundColor: item.accent }} />
      <div className="px-4 py-3 pl-5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-bold tracking-wide text-gray-200 group-hover:text-white transition-colors">
            {item.name}
          </span>
          {item.deprecated ? (
            <span className="text-[10px] font-semibold text-amber-400/80 flex-shrink-0 uppercase tracking-wider">Deprecated</span>
          ) : pinned ? (
            <span className="text-[10px] font-semibold text-white flex-shrink-0 uppercase tracking-wider">Pinned</span>
          ) : null}
        </div>
        <div className="text-[11px] font-semibold text-gray-400 mt-1 leading-relaxed line-clamp-2 group-hover:text-gray-300 transition-colors">
          {item.description}
        </div>
      </div>
    </NavLink>
  );
}

function SectionHeader({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-1.5 h-5 rounded-full" style={{ backgroundColor: color }} />
      <h2 className="text-sm font-bold tracking-widest text-text-muted uppercase">{children}</h2>
    </div>
  );
}

// ── All Views: full grid of every navigable view, active + deprecated ────────
export default function AllViewsPage() {
  // Which views are "Pinned" is driven by config.toml [gui].tabs (same source as the
  // TabBar), not the static nav-items `common` flag — so it updates when config changes.
  const { tabs } = useGuiConfig();
  const pinnedIds = new Set(resolveTabItems(tabs).map((i) => i.id));
  return (
    <main className="flex-1 bg-background text-text flex flex-col overflow-auto">
      <div className="w-full px-4 py-4 flex flex-col gap-3">
        <SectionHeader color="#22C55E">All Views</SectionHeader>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2">
          {ACTIVE_NAV_ITEMS.map((item) => (
            <ViewCard key={item.id} item={item} pinned={pinnedIds.has(item.id)} />
          ))}
        </div>

        {DEPRECATED_NAV_ITEMS.length > 0 && (
          <>
            <div className="mt-4">
              <SectionHeader color="#F59E0B">Deprecated</SectionHeader>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2">
              {DEPRECATED_NAV_ITEMS.map((item) => (
                <ViewCard key={item.id} item={item} muted />
              ))}
            </div>
          </>
        )}

        <p className="text-sm text-gray-200 mt-2">
          Tip: open any view, then use the “Open in popup” button (bottom-right) to pop it out onto a TV.
        </p>
      </div>
    </main>
  );
}
