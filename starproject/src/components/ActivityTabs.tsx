import Link from "next/link";

/**
 * The app's tab look (the List / Board / Timeline strip in DetailView): a
 * filled pill when active, a quiet hover otherwise. Shared by the Feed / Stats
 * tabs and the Stats page's window picker so they cannot drift apart.
 */
export function tabClass(active: boolean, extra = ""): string {
  return `inline-flex items-center rounded px-3 py-1 text-sm ${
    active
      ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
      : "text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
  }${extra ? ` ${extra}` : ""}`;
}

// The Feed / Stats strip under the Activity heading.
export function ActivityTabs({ active }: { active: "feed" | "stats" }) {
  return (
    <div className="mt-4 flex items-center gap-1">
      <Link
        href="/activity"
        className={tabClass(active === "feed")}
        aria-current={active === "feed" ? "page" : undefined}
      >
        Feed
      </Link>
      <Link
        href="/activity/stats"
        className={tabClass(active === "stats")}
        aria-current={active === "stats" ? "page" : undefined}
      >
        Stats
      </Link>
    </div>
  );
}
