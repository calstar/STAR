import Link from "next/link";

import { ActivityTabs, tabClass } from "@/components/ActivityTabs";
import { ContributionStats } from "@/components/ContributionStats";
import { STAT_WINDOWS, type StatWindow, parseWindow } from "@/lib/stats";
import { loadContributionStats } from "@/lib/stats-data";

export const dynamic = "force-dynamic";

const WINDOW_LABEL: Record<StatWindow, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  all: "All time",
};

export default async function ActivityStatsPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  const sp = await searchParams;
  const window = parseWindow(sp.window);
  const stats = await loadContributionStats(window);

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="text-2xl font-semibold">Activity</h1>

      <ActivityTabs active="stats" />

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Counts the person who made each change.
        </p>
        <div className="flex items-center gap-1" role="group" aria-label="Time window">
          {STAT_WINDOWS.map((w) => (
            <Link
              key={w}
              href={w === "30d" ? "/activity/stats" : `/activity/stats?window=${w}`}
              className={tabClass(w === window, "min-h-11 sm:min-h-0")}
              aria-current={w === window ? "page" : undefined}
            >
              {WINDOW_LABEL[w]}
            </Link>
          ))}
        </div>
      </div>

      <ContributionStats stats={stats} />
    </div>
  );
}
