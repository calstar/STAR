import Link from "next/link";

import { ActivityTabs, tabClass } from "@/components/ActivityTabs";
import { type LeaderView, SubteamFilter, SubteamLeaderboards, leaderboardHref } from "@/components/Leaderboard";
import { filterSections, parseTeam, withPoints } from "@/lib/leaderboard";
import { loadSubteamLeaderboard } from "@/lib/leaderboard-data";
import { STAT_WINDOWS, type StatWindow, parseWindow } from "@/lib/stats";
import { getCurrentDbUser } from "@/lib/user";

export const dynamic = "force-dynamic";

const WINDOW_LABEL: Record<StatWindow, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  all: "All time",
};

export default async function ActivityLeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string; team?: string }>;
}) {
  const sp = await searchParams;
  const view: LeaderView = {
    window: parseWindow(sp.window),
    team: parseTeam(sp.team),
  };
  const [board, me] = await Promise.all([loadSubteamLeaderboard(view.window, "points", "desc"), getCurrentDbUser()]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="text-2xl font-semibold">Activity</h1>

      <ActivityTabs active="leaderboard" />

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <SubteamFilter subteams={board.subteams} view={view} />
        <div className="flex items-center gap-1" role="group" aria-label="Time window">
          {STAT_WINDOWS.map((w) => (
            <Link
              key={w}
              href={leaderboardHref({ ...view, window: w })}
              className={tabClass(w === view.window, "min-h-11 sm:min-h-0")}
              aria-current={w === view.window ? "page" : undefined}
            >
              {WINDOW_LABEL[w]}
            </Link>
          ))}
        </div>
      </div>

      <SubteamLeaderboards sections={filterSections(withPoints(board.sections), view.team)} view={view} meId={me.id} />
    </div>
  );
}
