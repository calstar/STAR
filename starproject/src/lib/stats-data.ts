import { prisma } from "@/lib/db";
import { displayNameOf } from "@/lib/names";
import {
  type ContributionStats,
  type StatWindow,
  type UserStats,
  aggregateStats,
  sortUserStats,
  windowStart,
} from "@/lib/stats";

// The one loader behind the /activity/stats page and the contribution_stats
// MCP tool: pulls the Activity rows that can possibly count (creations and
// status changes), folds them with the pure aggregateStats, and names the rows.

export type NamedUserStats = UserStats & { name: string };

export type NamedContributionStats = Omit<ContributionStats, "users"> & {
  users: NamedUserStats[];
};

export async function loadContributionStats(
  window: StatWindow,
  now: Date = new Date(),
): Promise<NamedContributionStats> {
  // Every row that classifyActivity could count, from the window's start on
  // (aggregateStats applies the same cut again, so the two can never disagree).
  const since = windowStart(window, now);
  const rows = await prisma.activity.findMany({
    where: {
      OR: [{ kind: "created" }, { kind: "updated", field: "status" }],
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    select: {
      kind: true,
      field: true,
      fromValue: true,
      toValue: true,
      actorId: true,
      createdAt: true,
      actor: { select: { id: true, name: true, email: true, displayName: true } },
    },
  });

  const names = new Map<string, string>();
  for (const r of rows) {
    if (!names.has(r.actorId)) names.set(r.actorId, displayNameOf(r.actor));
  }

  const stats = aggregateStats(rows, window, now);
  const users = sortUserStats(
    stats.users.map((u) => ({ ...u, name: names.get(u.actorId) ?? u.actorId })),
    (u) => u.name,
  );
  return { ...stats, users };
}
