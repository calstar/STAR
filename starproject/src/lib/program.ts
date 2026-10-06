import type { TaskPriority, TaskStatus } from "@prisma/client";

/** The phase list a featured project uses until someone edits it. Hardware
 * flows roughly this way for every subteam; Procurement and Integration sit
 * where long-lead parts and stand assembly actually eat the schedule. */
export const DEFAULT_PHASES = [
  "Design",
  "Design review",
  "Procurement",
  "Manufacturing",
  "Integration",
  "Testing",
];

export function phasesOf(project: { phases: string[] }): string[] {
  return project.phases.length > 0 ? project.phases : DEFAULT_PHASES;
}

/** A stored phase index, clamped into [0, phases.length] — the list can be
 * shortened after a subteam was set past its new end. `phases.length` = done. */
export function clampPhase(phase: number, phaseCount: number): number {
  return Math.max(0, Math.min(phase, phaseCount));
}

/** One segment of the program-wide line: how many tracked subteams are past
 * this phase (`done`) and how many are in it right now (`active`). */
export type SegmentRollup = { done: number; active: number; total: number };

export function rollupSegments(
  subteamPhases: number[],
  phaseCount: number,
): SegmentRollup[] {
  const total = subteamPhases.length;
  return Array.from({ length: phaseCount }, (_, i) => ({
    done: subteamPhases.filter((p) => p > i).length,
    active: subteamPhases.filter((p) => p === i).length,
    total,
  }));
}

/** The program is only as far along as its slowest subteam. */
export function programPhase(subteamPhases: number[], phaseCount: number): number {
  if (subteamPhases.length === 0) return 0;
  return Math.min(phaseCount, ...subteamPhases);
}

export type RankableTask = {
  id: string;
  status: TaskStatus;
  priority: TaskPriority | null;
  dueDate: Date | null;
  /** Statuses of the tasks this one blocks. */
  blocking: { task: { status: TaskStatus } }[];
};

const PRIORITY_RANK: Record<TaskPriority, number> = { high: 3, medium: 2, low: 1 };

/** Open tasks this one is holding up. */
export function openBlockedCount(t: RankableTask): number {
  return t.blocking.filter((b) => b.task.status !== "done").length;
}

/** What decides which task is "biggest": open work it blocks, priority, due. */
export type BigKey = { blocks: number; priority: TaskPriority | null; due: number | null };

/** Sort comparator, biggest first: most open tasks blocked, then priority,
 * then the soonest due date (undated last). */
export function compareBig(a: BigKey, b: BigKey): number {
  const rank = (p: TaskPriority | null) => (p ? PRIORITY_RANK[p] : 0);
  const due = (d: number | null) => d ?? Number.POSITIVE_INFINITY;
  return (
    b.blocks - a.blocks ||
    rank(b.priority) - rank(a.priority) ||
    (due(a.due) === due(b.due) ? 0 : due(a.due) < due(b.due) ? -1 : 1)
  );
}

/**
 * The single task a subteam's card leads with. "Biggest" = the one whose
 * slipping costs the most (see compareBig). Done tasks never win.
 */
export function biggestTask<T extends RankableTask>(tasks: T[]): T | null {
  const key = (t: T): BigKey => ({
    blocks: openBlockedCount(t),
    priority: t.priority,
    due: t.dueDate?.getTime() ?? null,
  });
  const open = tasks.filter((t) => t.status !== "done");
  return [...open].sort((a, b) => compareBig(key(a), key(b)))[0] ?? null;
}

/** "in 3 days", "today", "2 days ago" — deadlines read better relative.
 * Dates are stored as UTC midnight of the picked day, so compare that calendar
 * day against `today` (YYYY-MM-DD in the team's own time zone). */
export function relativeDays(date: Date, today: string): string {
  const diff = Math.round(
    (Date.parse(date.toISOString().slice(0, 10)) - Date.parse(today)) / 86_400_000,
  );
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  return diff > 0 ? `in ${diff} days` : `${-diff} days ago`;
}

/** A milestone's optional link (slides, a doc), cleaned for storage. Blank
 * means none; a bare "docs.google.com/…" gets https://. Only http(s) is
 * accepted, so a pasted `javascript:` URL can never become a clickable link.
 * Throws with a message fit to show the person typing it. */
export function cleanLink(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (s.length > 2000) throw new Error("That link is too long");
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("That doesn't look like a link");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Links must start with http:// or https://");
  }
  if (!url.hostname.includes(".") && url.hostname !== "localhost") {
    throw new Error("That doesn't look like a link");
  }
  return url.toString();
}
