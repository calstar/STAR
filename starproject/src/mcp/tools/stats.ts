import { z } from "zod";

import { LEADER_SORTS } from "@/lib/leaderboard";
import { loadLeaderboard, loadSubteamLeaderboard } from "@/lib/leaderboard-data";
import { STAT_WINDOWS } from "@/lib/stats";
import { loadContributionStats } from "@/lib/stats-data";

import { READ, defineTool, type ToolModule } from "./_shared";

// The /activity/stats and /activity/leaderboard tabs, read-only: who completed,
// created and moved forward the most tasks (with the histogram the Stats page
// draws), and the Leaderboard's points ranking. Each goes through its page's
// own loader so the two can never disagree.

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
        "Who completed, created and moved forward the most tasks: the counts behind /activity/stats. Counts the actor of each change, not the assignee. `window` is 7d, 30d (default) or all, in Berkeley calendar days. Returns totals, per-user rows (sorted completed, then created, then forward) and the histogram buckets the page draws (daily for 7d/30d; weekly, Monday-start, last 52 weeks for all -- all-time totals are not capped).",
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

  defineTool(
    server,
    "leaderboard",
    {
      description:
        "Points ranking behind /activity/leaderboard. Each member's points (the points on tasks completed in `window`, split evenly between " +
        "the task's non-admin assignees) beside their completed / created / moved-forward counts. Admins are never listed. " +
        "`sort` is points (default), completed, created, forward or total; `dir` desc (default) or asc; ties go to total, then name. " +
        "`bySubteam: true` is what the page shows: one ranking per subteam (sorted by name), each counting " +
        "only tasks tagged with that subteam, so a person can appear in several; tasks with no subteam count in none. Without it, one ranking across every task.",
      inputSchema: {
        window: windowSchema,
        sort: z.enum(LEADER_SORTS).default("points"),
        dir: z.enum(["asc", "desc"]).default("desc"),
        bySubteam: z.boolean().default(false),
      },
      annotations: READ,
    },
    async ({ window, sort, dir, bySubteam }) => {
      if (bySubteam) {
        const s = await loadSubteamLeaderboard(window, sort, dir);
        return {
          window: s.window,
          since: s.since ? s.since.toISOString() : null,
          sort: s.sort,
          dir: s.dir,
          sections: s.sections.map((sec) => ({ ...sec, rows: sec.rows.map((r, i) => ({ rank: i + 1, ...r })) })),
        };
      }
      const b = await loadLeaderboard(window, sort, dir);
      return {
        window: b.window,
        since: b.since ? b.since.toISOString() : null,
        sort: b.sort,
        dir: b.dir,
        rows: b.rows.map((r, i) => ({ rank: i + 1, ...r })),
      };
    },
  );
};
