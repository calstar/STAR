import { z } from "zod";

import { STAT_WINDOWS } from "@/lib/stats";
import { loadContributionStats } from "@/lib/stats-data";

import { READ, defineTool, type ToolModule } from "./_shared";

// The /activity/stats tab, read-only: who completed, created and moved forward
// the most tasks, with the same window and histogram the page shows. Goes
// through the page's own loader so the two can never disagree.

/** The page's `?window=`: 7d, 30d or all, defaulting to 30d like the page does. */
export const windowSchema = z
  .enum(STAT_WINDOWS)
  .default("30d")
  .describe("7d (today and the 6 days before, Berkeley time), 30d (default) or all");

export const statsTools: ToolModule = (server) => {
  defineTool(
    server,
    "contribution_stats",
    {
      description:
        "Who completed, created and moved forward the most tasks: the /activity/stats leaderboard. Counts the actor of each change, not the assignee. `window` is 7d, 30d (default) or all, in Berkeley calendar days. Returns totals, per-user rows (sorted completed, then created, then forward) and the histogram buckets the page draws (daily for 7d/30d; weekly, Monday-start, last 52 weeks for all -- all-time totals are not capped).",
      inputSchema: { window: windowSchema },
      annotations: READ,
    },
    async ({ window }) => {
      const s = await loadContributionStats(window);
      return {
        window: s.window,
        since: s.since ? s.since.toISOString() : null,
        totals: s.totals,
        users: s.users.map((u) => ({
          actorId: u.actorId,
          name: u.name,
          completed: u.completed,
          created: u.created,
          forward: u.forward,
        })),
        buckets: s.buckets,
      };
    },
  );
};
