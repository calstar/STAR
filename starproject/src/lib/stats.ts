import type { TaskStatus } from "@prisma/client";

import { STATUS_LABEL } from "@/lib/tasks";

// Contribution stats: who completed, created and moved forward the most tasks,
// read off the Activity log. Pure functions only -- no Prisma, no React -- so
// every rule here is unit-tested with fixed clocks. src/lib/stats-data.ts loads
// the rows and calls aggregateStats; the /activity/stats page and the
// contribution_stats MCP tool both go through it.
//
// Attribution is the ACTOR of each Activity row -- whoever made the change --
// not the task's assignee. "Completed" means you moved the task to Done, even
// if it was assigned to someone else.

export const BERKELEY_TZ = "America/Los_Angeles";

export type StatEvent = {
  actorId: string;
  kind: string;
  field: string | null;
  fromValue: string | null;
  toValue: string | null;
  createdAt: Date;
};

export type StatClass = "created" | "completed" | "forward";

export type StatWindow = "7d" | "30d" | "all";

export const STAT_WINDOWS = ["7d", "30d", "all"] as const satisfies readonly StatWindow[];

/** `?window=` from the URL; anything that is not a known window is 30d. */
export function parseWindow(s: string | undefined | null): StatWindow {
  return (STAT_WINDOWS as readonly string[]).includes(s ?? "") ? (s as StatWindow) : "30d";
}

// Activity rows store status changes as display labels ("To do", "Done"), the
// strings STATUS_LABEL produced at write time; the row carries no status key.
// The inverse is built from today's table, so rows written under a label that
// has since been renamed stop matching: a rename needs its old label added to
// this map (or a migration) or those older moves silently drop out of the
// stats. Nothing has been renamed so far.
const LABEL_TO_STATUS = new Map<string, TaskStatus>(
  (Object.entries(STATUS_LABEL) as [TaskStatus, string][]).map(([k, v]) => [v, k]),
);

export function labelToStatus(label: string | null | undefined): TaskStatus | null {
  if (label == null) return null;
  return LABEL_TO_STATUS.get(label) ?? null;
}

// The pipeline order a task moves along. `blocked` is deliberately absent: it
// is a side state, so a move into or out of it is neither progress nor regress.
const RANK: Partial<Record<TaskStatus, number>> = {
  backlog: 0,
  todo: 1,
  in_progress: 2,
  done: 3,
};

/**
 * Which of the three classes an Activity row counts toward, or null when it
 * counts toward none. The classes are disjoint, so a stacked histogram of them
 * sums to the number of classified events.
 *
 *   created   -- kind "created", whatever its field
 *   completed -- a status change into Done from a ranked status (or from no
 *                recorded status at all); Done -> Done and Blocked -> Done are nothing
 *   forward   -- a status change between two ranked statuses that goes up the
 *                ladder and does not reach Done (those are "completed")
 *
 * Anything else -- other kinds, other fields, backward moves, anything touching
 * Blocked, a from/to label that is not one of STATUS_LABEL's -- is null.
 */
export function classifyActivity(
  e: Pick<StatEvent, "kind" | "field" | "fromValue" | "toValue">,
): StatClass | null {
  if (e.kind === "created") return "created";
  if (e.kind !== "updated" || e.field !== "status") return null;

  const to = labelToStatus(e.toValue);
  if (to === null) return null;
  // A null fromValue is "no prior status recorded" and is tolerated; a non-null
  // string that is not a status label is bad data and counts for nothing.
  const from = e.fromValue == null ? null : labelToStatus(e.fromValue);
  if (e.fromValue != null && from === null) return null;

  if (to === "done") {
    if (from === "done" || from === "blocked") return null;
    return "completed";
  }
  if (from === null) return null;
  const oldRank = RANK[from];
  const newRank = RANK[to];
  if (oldRank === undefined || newRank === undefined) return null;
  return newRank > oldRank ? "forward" : null;
}

// ---- Calendar arithmetic in a time zone, without a tz library -------------

// Intl.DateTimeFormat construction is the expensive part of formatting, and
// aggregateStats formats once per event, so formatters are cached per zone.
const DAY_KEY_FMT = new Map<string, Intl.DateTimeFormat>();
const LOCAL_PARTS_FMT = new Map<string, Intl.DateTimeFormat>();

function cached(cache: Map<string, Intl.DateTimeFormat>, tz: string, make: () => Intl.DateTimeFormat) {
  let fmt = cache.get(tz);
  if (!fmt) {
    fmt = make();
    cache.set(tz, fmt);
  }
  return fmt;
}

/** YYYY-MM-DD of the instant `d` on the calendar of `tz`. */
export function dayKey(d: Date, tz: string = BERKELEY_TZ): string {
  return cached(
    DAY_KEY_FMT,
    tz,
    () => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }),
  ).format(d);
}

/** Split a YYYY-MM-DD key into numbers. */
function splitKey(key: string): [number, number, number] {
  const [y, m, d] = key.split("-").map(Number);
  return [y, m, d];
}

/** Noon UTC of the key's calendar date: a safe anchor for weekday and labels. */
function keyNoonUtc(key: string): Date {
  const [y, m, d] = splitKey(key);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

/** The key `days` calendar days after `key` (negative to go back). */
export function shiftKey(key: string, days: number): string {
  const [y, m, d] = splitKey(key);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The wall-clock time of `d` in `tz`, re-encoded as if it were UTC. */
function localAsUtc(d: Date, tz: string): number {
  const parts = cached(
    LOCAL_PARTS_FMT,
    tz,
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
  ).formatToParts(d);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
}

/**
 * The UTC instant at which the calendar day `key` begins (00:00) in `tz`.
 * Start from the key as if it were UTC midnight, subtract the zone's offset at
 * that moment, then re-check the offset at the result once so a DST change
 * between the guess and the answer is absorbed.
 */
export function zoneMidnight(key: string, tz: string = BERKELEY_TZ): Date {
  const [y, m, d] = splitKey(key);
  const guess = Date.UTC(y, m - 1, d);
  const offset1 = localAsUtc(new Date(guess), tz) - guess;
  let candidate = guess - offset1;
  const offset2 = localAsUtc(new Date(candidate), tz) - candidate;
  if (offset2 !== offset1) candidate = guess - offset2;
  return new Date(candidate);
}

const WINDOW_DAYS: Record<Exclude<StatWindow, "all">, number> = { "7d": 7, "30d": 30 };

/**
 * The inclusive lower bound of a window: midnight in `tz` at the start of the
 * N-th day counting back from today (today plus N-1 preceding days). `all` has
 * no lower bound.
 */
export function windowStart(window: StatWindow, now: Date, tz: string = BERKELEY_TZ): Date | null {
  if (window === "all") return null;
  const today = dayKey(now, tz);
  return zoneMidnight(shiftKey(today, -(WINDOW_DAYS[window] - 1)), tz);
}

/** Monday of the ISO week containing the calendar day `key`. */
export function mondayOf(key: string): string {
  const dow = keyNoonUtc(key).getUTCDay(); // 0 = Sunday
  return shiftKey(key, -((dow + 6) % 7));
}

const LABEL_FMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** "Oct 3" for a YYYY-MM-DD key. */
export function keyLabel(key: string): string {
  return LABEL_FMT.format(keyNoonUtc(key));
}

// ---- Aggregation ---------------------------------------------------------

export type Counts = { completed: number; created: number; forward: number };

/** One histogram bar. `key` is the day (7d/30d) or the week's Monday (all). */
export type Bucket = Counts & { key: string; label: string };

export type UserStats = Counts & { actorId: string };

export type ContributionStats = {
  window: StatWindow;
  since: Date | null;
  totals: Counts;
  users: UserStats[];
  buckets: Bucket[];
};

/** The all-time histogram shows only this many weeks; its totals are not capped. */
export const ALL_TIME_WEEKS = 52;

function zeroCounts(): Counts {
  return { completed: 0, created: 0, forward: 0 };
}

/** The zero-filled buckets a window shows, oldest first, ending today. */
export function emptyBuckets(window: StatWindow, now: Date, tz: string = BERKELEY_TZ): Bucket[] {
  const today = dayKey(now, tz);
  const out: Bucket[] = [];
  if (window === "all") {
    const thisMonday = mondayOf(today);
    for (let i = ALL_TIME_WEEKS - 1; i >= 0; i--) {
      const key = shiftKey(thisMonday, -7 * i);
      out.push({ key, label: keyLabel(key), ...zeroCounts() });
    }
  } else {
    for (let i = WINDOW_DAYS[window] - 1; i >= 0; i--) {
      const key = shiftKey(today, -i);
      out.push({ key, label: keyLabel(key), ...zeroCounts() });
    }
  }
  return out;
}

/**
 * Leaderboard order: most completed, then most created, then most moved
 * forward, then by `label` ascending so ties are stable. aggregateStats sorts
 * by actorId; stats-data re-sorts with display names once it has them.
 */
export function sortUserStats<T extends UserStats>(users: T[], label: (u: T) => string): T[] {
  return [...users].sort(
    (a, b) =>
      b.completed - a.completed ||
      b.created - a.created ||
      b.forward - a.forward ||
      label(a).localeCompare(label(b)),
  );
}

/**
 * Fold Activity rows into a window's totals, per-user rows and histogram.
 * Events before the window's start are ignored entirely. For `all`, every
 * event counts toward `totals` and `users`, but `buckets` only covers the last
 * ALL_TIME_WEEKS weeks: an older event is counted but not drawn. An event
 * stamped after `now` (the database's clock running ahead of the app's) is
 * drawn in the last bucket, so for 7d/30d the bars always sum to the totals.
 */
export function aggregateStats(
  events: StatEvent[],
  window: StatWindow,
  now: Date,
  tz: string = BERKELEY_TZ,
): ContributionStats {
  const since = windowStart(window, now, tz);
  const buckets = emptyBuckets(window, now, tz);
  const bucketIndex = new Map(buckets.map((b, i) => [b.key, i] as const));
  const totals = zeroCounts();
  const byUser = new Map<string, UserStats>();

  for (const e of events) {
    if (since && e.createdAt < since) continue;
    const cls = classifyActivity(e);
    if (!cls) continue;

    totals[cls]++;
    let row = byUser.get(e.actorId);
    if (!row) {
      row = { actorId: e.actorId, ...zeroCounts() };
      byUser.set(e.actorId, row);
    }
    row[cls]++;

    const day = dayKey(e.createdAt, tz);
    const key = window === "all" ? mondayOf(day) : day;
    const last = buckets[buckets.length - 1];
    // ISO keys compare as strings; anything past today lands in today's bar.
    const idx = key > last.key ? buckets.length - 1 : bucketIndex.get(key);
    if (idx !== undefined) buckets[idx][cls]++;
  }

  return {
    window,
    since,
    totals,
    users: sortUserStats([...byUser.values()], (u) => u.actorId),
    buckets,
  };
}
