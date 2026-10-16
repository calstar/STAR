import Link from "next/link";

/**
 * The app's tab look (the List / Board / Timeline strip in DetailView): a
 * filled pill when active, a quiet hover otherwise. Shared by the Leaderboard /
 * History / Stats tabs and their window pickers so they cannot drift apart.
 */
export function tabClass(active: boolean, extra = ""): string {
  return `inline-flex items-center rounded px-3 py-1 text-sm ${
    active
      ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
      : "text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
  }${extra ? ` ${extra}` : ""}`;
}

/** A podium (2nd, 1st, 3rd) with a star over the winner, drawn like the
 * sidebar icons: 24-unit grid, 2px round stroke, currentColor. */
export function IconLeaderboard({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 20.5h18M4 20.5v-6h5M9 20.5V10h6v10.5M15 15.5h5v5" />
      <path d="M12 1.9l.68 1.77 1.89.1-1.48 1.19.5 1.82L12 5.75l-1.59 1.03.5-1.82-1.48-1.19 1.89-.1Z" />
    </svg>
  );
}

type ActivityTab = "history" | "leaderboard" | "stats";

const TABS: { key: ActivityTab; href: string; label: string; icon?: boolean }[] = [
  { key: "leaderboard", href: "/activity/leaderboard", label: "Leaderboard", icon: true },
  { key: "history", href: "/activity", label: "History" },
  { key: "stats", href: "/activity/stats", label: "Stats" },
];

// The Leaderboard / History / Stats strip under the Activity heading.
export function ActivityTabs({ active }: { active: ActivityTab }) {
  return (
    <div className="mt-4 flex items-center gap-1">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={tabClass(active === t.key, t.icon ? "gap-1.5" : "")}
          aria-current={active === t.key ? "page" : undefined}
        >
          {t.icon && <IconLeaderboard />}
          {t.label}
        </Link>
      ))}
    </div>
  );
}
