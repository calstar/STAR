import { listAdmins } from "@/lib/admins";
import { prisma } from "@/lib/db";
import {
  type LeaderRow,
  type LeaderSort,
  type SortDir,
  type SubteamSection,
  buildLeaderRows,
  buildSubteamSections,
  sortLeaderRows,
  splitPoints,
} from "@/lib/leaderboard";
import { displayNameOf } from "@/lib/names";
import { type StatWindow, windowStart } from "@/lib/stats";
import { loadContributionStats } from "@/lib/stats-data";
import { getSubteams } from "@/lib/subteams";

// The one loader behind the /activity/leaderboard page and the leaderboard MCP
// tool: the Stats tab's counts plus each member's share of the points on tasks
// completed in the window, with every admin left out.

export type Leaderboard = {
  window: StatWindow;
  since: Date | null;
  sort: LeaderSort;
  dir: SortDir;
  rows: LeaderRow[];
};

export async function loadLeaderboard(
  window: StatWindow,
  sort: LeaderSort,
  dir: SortDir,
  now: Date = new Date(),
): Promise<Leaderboard> {
  const since = windowStart(window, now);
  const [stats, tasks, admins] = await Promise.all([
    loadContributionStats(window, now),
    // completedAt is set exactly while a task is done, so a task reopened since
    // drops out here until it is done again.
    prisma.task.findMany({
      where: {
        status: "done",
        // Unset points count as DEFAULT_TASK_POINTS; an explicit 0 counts nothing.
        OR: [{ points: null }, { points: { gt: 0 } }],
        completedAt: since ? { gte: since } : { not: null },
      },
      select: { points: true, completedAt: true, assignees: { select: { id: true } } },
    }),
    listAdmins(),
  ]);

  const { isAdminId, names } = await whoIs(
    [...stats.users.map((u) => u.actorId), ...tasks.flatMap((t) => t.assignees.map((a) => a.id))],
    admins,
  );

  const points = splitPoints(
    tasks.map((t) => ({ points: t.points, completedAt: t.completedAt, assigneeIds: t.assignees.map((a) => a.id) })),
    isAdminId,
    since,
  );
  const rows = sortLeaderRows(buildLeaderRows(stats.users, points, names, isAdminId), sort, dir);
  return { window, since, sort, dir, rows };
}

/** Display names for these users, and which of them are admins. */
async function whoIs(ids: string[], admins: { email: string }[]) {
  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, name: true, email: true, displayName: true },
  });
  const adminEmails = new Set(admins.map((a) => a.email));
  const adminIds = new Set(users.filter((u) => adminEmails.has(u.email.toLowerCase())).map((u) => u.id));
  return {
    isAdminId: (id: string) => adminIds.has(id),
    names: new Map(users.map((u) => [u.id, displayNameOf(u)] as const)),
  };
}

export type SubteamLeaderboard = Omit<Leaderboard, "rows"> & {
  sections: SubteamSection[];
  /** Every subteam, sections or not, for the page's filter chips. */
  subteams: { id: string; name: string; color: string | null }[];
};

/**
 * The board split by subteam, as the Leaderboard tab shows it: each section
 * counts only the tasks tagged with that subteam, by the subteam a task has now.
 */
export async function loadSubteamLeaderboard(
  window: StatWindow,
  sort: LeaderSort,
  dir: SortDir,
  now: Date = new Date(),
): Promise<SubteamLeaderboard> {
  const since = windowStart(window, now);
  const [events, tasks, subteams, admins] = await Promise.all([
    // The rows the Stats tab counts (stats-data.ts), with their task's subteam.
    prisma.activity.findMany({
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
        task: { select: { subteamId: true } },
      },
    }),
    prisma.task.findMany({
      where: {
        status: "done",
        // Unset points count as DEFAULT_TASK_POINTS; an explicit 0 counts nothing.
        OR: [{ points: null }, { points: { gt: 0 } }],
        completedAt: since ? { gte: since } : { not: null },
      },
      select: { points: true, completedAt: true, subteamId: true, assignees: { select: { id: true } } },
    }),
    getSubteams(),
    listAdmins(),
  ]);

  const { isAdminId, names } = await whoIs(
    [...events.map((e) => e.actorId), ...tasks.flatMap((t) => t.assignees.map((a) => a.id))],
    admins,
  );
  const list = subteams.map((s) => ({ id: s.id, name: s.name, color: s.color }));
  const sections = buildSubteamSections({
    events: events.map(({ task, ...e }) => ({ ...e, subteamId: task?.subteamId ?? null })),
    tasks: tasks.map((t) => ({
      points: t.points,
      completedAt: t.completedAt,
      subteamId: t.subteamId,
      assigneeIds: t.assignees.map((a) => a.id),
    })),
    subteams: list,
    names,
    isAdminId,
    window,
    now,
    since,
    sort,
    dir,
  });
  return { window, since, sort, dir, sections, subteams: list };
}
