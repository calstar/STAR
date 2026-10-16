import { type Counts, type StatEvent, type StatWindow, type UserStats, aggregateStats } from "@/lib/stats";

// The Leaderboard tab's pure logic: how a task's points split between the
// people on it, who is listed (members, never admins), and the sortable order.
// leaderboard-data.ts does the queries; this file is what the tests pin.

export type LeaderSort = "points" | "completed" | "created" | "forward" | "total";
export type SortDir = "asc" | "desc";

export const LEADER_SORTS = ["points", "completed", "created", "forward", "total"] as const satisfies readonly LeaderSort[];
export const DEFAULT_SORT: LeaderSort = "points";
export const DEFAULT_DIR: SortDir = "desc";

/** The page's `?sort=`: one of LEADER_SORTS, anything else is the default. */
export function parseSort(s: string | undefined | null): LeaderSort {
  return (LEADER_SORTS as readonly string[]).includes(s ?? "") ? (s as LeaderSort) : DEFAULT_SORT;
}

/** The page's `?dir=`: "asc" or the default, descending. */
export function parseDir(s: string | undefined | null): SortDir {
  return s === "asc" ? "asc" : DEFAULT_DIR;
}

/** A done task as the split needs it. `completedAt` is null unless it is done. */
export type PointsTask = { points: number | null; completedAt: Date | null; assigneeIds: string[] };

/**
 * What a finished task is worth when no admin has set its points: 1, so every
 * completed task counts for something. An admin's explicit number (0 included)
 * always wins. One constant so the default can change in one place.
 */
export const DEFAULT_TASK_POINTS = 1;

/** A task's points for the Leaderboard: its own, or the default when unset. */
export const effectivePoints = (points: number | null): number => points ?? DEFAULT_TASK_POINTS;

/**
 * Each member's share of the points on tasks completed since `since` (null =
 * all time). A task with no points set is worth DEFAULT_TASK_POINTS. A task's
 * points split evenly between its assignees who are not
 * admins; admins get nothing and do not dilute the others' share. A task with
 * no member on it gives its points to nobody. Shares are kept exact (10 split
 * three ways is 10/3 each); only formatPoints rounds.
 */
export function splitPoints(
  tasks: PointsTask[],
  isAdminId: (id: string) => boolean,
  since: Date | null,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tasks) {
    const value = effectivePoints(t.points);
    if (value <= 0 || !t.completedAt) continue;
    if (since && t.completedAt < since) continue;
    const members = [...new Set(t.assigneeIds)].filter((id) => !isAdminId(id));
    if (members.length === 0) continue;
    const share = value / members.length;
    for (const id of members) out.set(id, (out.get(id) ?? 0) + share);
  }
  return out;
}

export type LeaderRow = Counts & { userId: string; name: string; points: number; total: number };

/**
 * One row per member who earned points or made a counted change in the window.
 * `total` is completed + created + moved forward; points stay separate so the
 * two kinds of credit read on their own.
 */
export function buildLeaderRows(
  stats: UserStats[],
  points: Map<string, number>,
  names: Map<string, string>,
  isAdminId: (id: string) => boolean,
): LeaderRow[] {
  const byId = new Map(stats.map((s) => [s.actorId, s] as const));
  const ids = new Set([...byId.keys(), ...points.keys()]);
  const rows: LeaderRow[] = [];
  for (const id of ids) {
    if (isAdminId(id)) continue;
    const s = byId.get(id);
    const completed = s?.completed ?? 0;
    const created = s?.created ?? 0;
    const forward = s?.forward ?? 0;
    rows.push({
      userId: id,
      name: names.get(id) ?? id,
      points: points.get(id) ?? 0,
      completed,
      created,
      forward,
      total: completed + created + forward,
    });
  }
  return rows;
}

/**
 * Order rows by one column. `dir` flips only that column; ties always fall
 * back to most total changes, then name A–Z, so the order is stable.
 */
export function sortLeaderRows(rows: LeaderRow[], sort: LeaderSort, dir: SortDir): LeaderRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort(
    (a, b) =>
      sign * (a[sort] - b[sort]) || b.total - a.total || a.name.localeCompare(b.name),
  );
}

/** A points value for display: one decimal at most, "3.3", "10", "0". */
export function formatPoints(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Object.is(r, -0) ? "0" : String(r);
}

/** A task's points split between its member assignees, for "10 each" labels. */
export function shareLabel(points: number | null, memberCount: number): string | null {
  if (!points || memberCount === 0) return null;
  return memberCount === 1 ? null : `${formatPoints(points / memberCount)} each`;
}

// ---- Split by subteam ------------------------------------------------------

/** `?team=<subteam id>` → the one subteam to show; missing or blank → null (All). */
export function parseTeam(s: string | undefined | null): string | null {
  const id = (s ?? "").trim();
  return id === "" ? null : id;
}

/** The sections to show: every one for All (null), or just the chosen subteam's. */
export function filterSections(sections: SubteamSection[], team: string | null): SubteamSection[] {
  return team === null ? sections : sections.filter((s) => s.subteamId === team);
}

export type SubteamSection = {
  subteamId: string;
  name: string;
  color: string | null;
  rows: LeaderRow[];
};

/**
 * One leaderboard per subteam. Subteams tag tasks, not people, so a section
 * counts only that subteam's tasks: points from its finished tasks and the
 * changes made to them. Someone who works across subteams is in each section
 * they earned something in. A task with no subteam (or one whose subteam was
 * deleted) is in no section, so it doesn't count. Sections with nobody in them
 * are left out; the order is the subteam list's (by name).
 */
export function buildSubteamSections(input: {
  events: (StatEvent & { subteamId: string | null })[];
  tasks: (PointsTask & { subteamId: string | null })[];
  subteams: { id: string; name: string; color: string | null }[];
  names: Map<string, string>;
  isAdminId: (id: string) => boolean;
  window: StatWindow;
  now: Date;
  since: Date | null;
  sort: LeaderSort;
  dir: SortDir;
}): SubteamSection[] {
  const out: SubteamSection[] = [];
  for (const g of input.subteams.map((s) => ({ subteamId: s.id, name: s.name, color: s.color }))) {
    const events = input.events.filter((e) => e.subteamId === g.subteamId);
    const tasks = input.tasks.filter((t) => t.subteamId === g.subteamId);
    const stats = aggregateStats(events, input.window, input.now);
    const points = splitPoints(tasks, input.isAdminId, input.since);
    const rows = buildLeaderRows(stats.users, points, input.names, input.isAdminId);
    if (rows.length > 0) out.push({ ...g, rows: sortLeaderRows(rows, input.sort, input.dir) });
  }
  return out;
}

/**
 * The Leaderboard ranks by points only, so it lists only people who have some:
 * each section keeps its members with points, and a section left empty goes.
 */
export function withPoints(sections: SubteamSection[]): SubteamSection[] {
  return sections
    .map((s) => ({ ...s, rows: s.rows.filter((r) => r.points > 0) }))
    .filter((s) => s.rows.length > 0);
}
