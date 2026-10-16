"use client";

import Link from "next/link";

export type DockView = "list" | "board" | "gantt" | "bom";

const ICON = {
  list: (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  ),
  board: (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
      <path d="M5 4v16M12 4v12M19 4v9" />
    </svg>
  ),
  gantt: (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" aria-hidden>
      <path d="M3 6h8M9 12h10M5 18h8" />
    </svg>
  ),
  bom: (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
    </svg>
  ),
} as const;

const LABEL: Record<DockView, string> = { list: "List", board: "Board", gantt: "Timeline", bom: "BOM" };
const TASK_VIEWS: DockView[] = ["list", "board", "gantt"];

// Mobile-only bottom dock for switching between the task views. Fixed to the
// viewport bottom below `sm`; pages that render it must add matching bottom
// padding (e.g. pb-24) so content can scroll clear of it. Link mode (`hrefs`)
// serves the server-rendered detail pages; `onSelect` serves client state.
export function ViewDock({
  active,
  hrefs,
  onSelect,
}: {
  active: DockView;
  /** With a `bom` href (project pages), the dock gets a fourth BOM button. */
  hrefs?: Partial<Record<DockView, string>> & Record<"list" | "board" | "gantt", string>;
  onSelect?: (v: DockView) => void;
}) {
  const views: DockView[] = hrefs?.bom ? [...TASK_VIEWS, "bom"] : TASK_VIEWS;
  const cls = (isActive: boolean) =>
    `flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${
      isActive
        ? "text-neutral-900 dark:text-neutral-100"
        : "text-neutral-400 dark:text-neutral-500"
    }`;

  return (
    <nav
      aria-label="Task view"
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-neutral-200 bg-white pb-[env(safe-area-inset-bottom)] dark:border-neutral-800 dark:bg-neutral-900 sm:hidden"
    >
      {views.map((v) =>
        hrefs ? (
          <Link key={v} href={hrefs[v] ?? hrefs.list} aria-current={active === v ? "page" : undefined} className={cls(active === v)}>
            {ICON[v]}
            {LABEL[v]}
          </Link>
        ) : (
          <button
            key={v}
            type="button"
            onClick={() => onSelect?.(v)}
            aria-current={active === v ? "page" : undefined}
            className={cls(active === v)}
          >
            {ICON[v]}
            {LABEL[v]}
          </button>
        ),
      )}
    </nav>
  );
}
