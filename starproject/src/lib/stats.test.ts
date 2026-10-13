import type { TaskStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  ALL_TIME_WEEKS,
  type StatClass,
  type StatEvent,
  aggregateStats,
  classifyActivity,
  dayKey,
  emptyBuckets,
  labelToStatus,
  mondayOf,
  parseWindow,
  shiftKey,
  sortUserStats,
  windowStart,
  zoneMidnight,
} from "@/lib/stats";
import { STATUS_LABEL } from "@/lib/tasks";

// Every clock in this file is fixed. Oct 12 2026 13:00 PDT is a Monday.
const NOW = new Date("2026-10-12T20:00:00Z");
const NOW_PST = new Date("2026-01-20T20:00:00Z");

const STATUSES = Object.keys(STATUS_LABEL) as TaskStatus[];

function statusChange(from: TaskStatus | null, to: TaskStatus | null, over: Partial<StatEvent> = {}): StatEvent {
  return {
    actorId: "u1",
    kind: "updated",
    field: "status",
    fromValue: from === null ? null : STATUS_LABEL[from],
    toValue: to === null ? null : STATUS_LABEL[to],
    createdAt: NOW,
    ...over,
  };
}

function created(actorId: string, createdAt: Date, over: Partial<StatEvent> = {}): StatEvent {
  return { actorId, kind: "created", field: null, fromValue: null, toValue: null, createdAt, ...over };
}

function daysAgo(n: number, from = NOW): Date {
  return new Date(from.getTime() - n * 86_400_000);
}

describe("labelToStatus", () => {
  it("inverts every STATUS_LABEL entry", () => {
    for (const [key, label] of Object.entries(STATUS_LABEL)) {
      expect(labelToStatus(label)).toBe(key);
    }
  });

  it("is null for anything that is not a label", () => {
    expect(labelToStatus("")).toBeNull();
    expect(labelToStatus(null)).toBeNull();
    expect(labelToStatus(undefined)).toBeNull();
    expect(labelToStatus("Finished")).toBeNull();
    expect(labelToStatus("done")).toBeNull(); // the enum key, not the label
  });
});

describe("classifyActivity", () => {
  // The whole 5x5 transition table, spelled out so a change to the rule has to
  // change a line here.
  const expected: Record<TaskStatus, Record<TaskStatus, StatClass | null>> = {
    backlog: { backlog: null, todo: "forward", in_progress: "forward", done: "completed", blocked: null },
    todo: { backlog: null, todo: null, in_progress: "forward", done: "completed", blocked: null },
    in_progress: { backlog: null, todo: null, in_progress: null, done: "completed", blocked: null },
    done: { backlog: null, todo: null, in_progress: null, done: null, blocked: null },
    blocked: { backlog: null, todo: null, in_progress: null, done: null, blocked: null },
  };

  it("covers all 25 status pairs", () => {
    let pairs = 0;
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        pairs++;
        expect(classifyActivity(statusChange(from, to)), `${from} -> ${to}`).toBe(expected[from][to]);
      }
    }
    expect(pairs).toBe(25);
  });

  it("yields exactly three completions, three forward moves and nothing else across the table", () => {
    const all = STATUSES.flatMap((from) => STATUSES.map((to) => classifyActivity(statusChange(from, to))));
    expect(all.filter((c) => c === "completed")).toHaveLength(3);
    expect(all.filter((c) => c === "forward")).toHaveLength(3);
    expect(all.filter((c) => c === null)).toHaveLength(19);
  });

  it("counts a creation whatever its field says", () => {
    expect(classifyActivity(created("u1", NOW))).toBe("created");
    expect(classifyActivity(created("u1", NOW, { field: "title", toValue: "x" }))).toBe("created");
  });

  it("ignores updates to other fields and every other kind", () => {
    expect(classifyActivity(statusChange("todo", "done", { field: "priority" }))).toBeNull();
    expect(classifyActivity(statusChange("todo", "done", { field: null }))).toBeNull();
    for (const kind of ["assigned", "unassigned", "deleted", "blocker_added", "blocker_removed", "renamed"]) {
      expect(classifyActivity(statusChange("todo", "done", { kind })), kind).toBeNull();
    }
  });

  it("ignores labels that are not statuses", () => {
    expect(classifyActivity(statusChange("todo", "done", { fromValue: "Finished" }))).toBeNull();
    expect(classifyActivity(statusChange("todo", "done", { toValue: "Finished" }))).toBeNull();
    expect(classifyActivity(statusChange("backlog", "todo", { fromValue: "" }))).toBeNull();
    expect(classifyActivity(statusChange("todo", null))).toBeNull();
  });

  it("treats a missing from-status as completed when the move lands on Done, and nothing otherwise", () => {
    // No prior status recorded: moving to Done is still a completion...
    expect(classifyActivity(statusChange(null, "done"))).toBe("completed");
    // ...but there is no rank to compare against, so it is not a forward move.
    expect(classifyActivity(statusChange(null, "in_progress"))).toBeNull();
    expect(classifyActivity(statusChange(null, "todo"))).toBeNull();
  });
});

describe("parseWindow", () => {
  it("passes the three windows through", () => {
    expect(parseWindow("7d")).toBe("7d");
    expect(parseWindow("30d")).toBe("30d");
    expect(parseWindow("all")).toBe("all");
  });

  it("falls back to 30d for anything else", () => {
    expect(parseWindow(undefined)).toBe("30d");
    expect(parseWindow(null)).toBe("30d");
    expect(parseWindow("")).toBe("30d");
    expect(parseWindow("90d")).toBe("30d");
    expect(parseWindow("7D")).toBe("30d");
    expect(parseWindow(" 7d")).toBe("30d");
  });
});

describe("dayKey", () => {
  it("is the Berkeley calendar day, across midnight in PDT", () => {
    expect(dayKey(new Date("2026-10-12T06:30:00Z"))).toBe("2026-10-11"); // 23:30 PDT Oct 11
    expect(dayKey(new Date("2026-10-12T07:30:00Z"))).toBe("2026-10-12"); // 00:30 PDT Oct 12
  });

  it("is the Berkeley calendar day, across midnight in PST", () => {
    expect(dayKey(new Date("2026-01-15T07:30:00Z"))).toBe("2026-01-14"); // 23:30 PST Jan 14
    expect(dayKey(new Date("2026-01-15T08:30:00Z"))).toBe("2026-01-15"); // 00:30 PST Jan 15
  });

  it("honours another zone when asked", () => {
    expect(dayKey(new Date("2026-10-12T23:30:00Z"), "UTC")).toBe("2026-10-12");
    expect(dayKey(new Date("2026-10-12T23:30:00Z"), "Asia/Tokyo")).toBe("2026-10-13");
  });
});

describe("shiftKey / mondayOf / zoneMidnight", () => {
  it("steps across month and year boundaries", () => {
    expect(shiftKey("2026-10-12", -6)).toBe("2026-10-06");
    expect(shiftKey("2026-10-12", -29)).toBe("2026-09-13");
    expect(shiftKey("2026-01-03", -5)).toBe("2025-12-29");
    expect(shiftKey("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("finds the Monday of a week", () => {
    expect(mondayOf("2026-10-12")).toBe("2026-10-12"); // a Monday maps to itself
    expect(mondayOf("2026-10-11")).toBe("2026-10-05"); // Sunday -> previous Monday
    expect(mondayOf("2026-10-17")).toBe("2026-10-12"); // Saturday
    expect(mondayOf("2026-10-13")).toBe("2026-10-12"); // Tuesday
  });

  it("is local midnight in PDT, PST and on the DST-change day", () => {
    expect(zoneMidnight("2026-10-06").toISOString()).toBe("2026-10-06T07:00:00.000Z");
    expect(zoneMidnight("2026-01-14").toISOString()).toBe("2026-01-14T08:00:00.000Z");
    // DST ends 2026-11-01 02:00 PDT: that day still begins at 00:00 PDT.
    expect(zoneMidnight("2026-11-01").toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(zoneMidnight("2026-11-02").toISOString()).toBe("2026-11-02T08:00:00.000Z");
    // DST starts 2026-03-08 02:00 PST: that day begins at 00:00 PST.
    expect(zoneMidnight("2026-03-08").toISOString()).toBe("2026-03-08T08:00:00.000Z");
    expect(zoneMidnight("2026-03-09").toISOString()).toBe("2026-03-09T07:00:00.000Z");
    expect(zoneMidnight("2026-10-06", "UTC").toISOString()).toBe("2026-10-06T00:00:00.000Z");
  });

  it("re-checks the offset when the first guess straddles a DST change (east of UTC)", () => {
    // Sydney moves 02:00 AEST -> 03:00 AEDT on 2026-10-04. The first guess
    // (00:00Z) is already AEDT, +11, but midnight local that day is still AEST,
    // +10: the one-shot answer would be 23:00 the night before.
    expect(zoneMidnight("2026-10-04", "Australia/Sydney").toISOString()).toBe("2026-10-03T14:00:00.000Z");
    expect(zoneMidnight("2026-10-03", "Australia/Sydney").toISOString()).toBe("2026-10-02T14:00:00.000Z");
    expect(zoneMidnight("2026-10-05", "Australia/Sydney").toISOString()).toBe("2026-10-04T13:00:00.000Z");
  });
});

describe("windowStart", () => {
  it("is Berkeley midnight six / twenty-nine days back in PDT", () => {
    expect(windowStart("7d", NOW)?.toISOString()).toBe("2026-10-06T07:00:00.000Z");
    expect(windowStart("30d", NOW)?.toISOString()).toBe("2026-09-13T07:00:00.000Z");
  });

  it("is Berkeley midnight in PST", () => {
    expect(windowStart("7d", NOW_PST)?.toISOString()).toBe("2026-01-14T08:00:00.000Z");
  });

  it("spans the November DST change correctly", () => {
    // Nov 5 is PST; six days back, Oct 30, was PDT, so midnight there is 07:00Z.
    expect(windowStart("7d", new Date("2026-11-05T20:00:00Z"))?.toISOString()).toBe("2026-10-30T07:00:00.000Z");
  });

  it("is open-ended for all time", () => {
    expect(windowStart("all", NOW)).toBeNull();
  });
});

describe("aggregateStats window edges", () => {
  const start = windowStart("7d", NOW)!;

  it("excludes an event 1 ms before the start and includes one exactly at it", () => {
    const before = created("u1", new Date(start.getTime() - 1));
    const at = created("u1", start);
    expect(aggregateStats([before], "7d", NOW).totals.created).toBe(0);
    expect(aggregateStats([at], "7d", NOW).totals.created).toBe(1);
    expect(aggregateStats([before, at], "7d", NOW).users).toEqual([
      { actorId: "u1", completed: 0, created: 1, forward: 0 },
    ]);
  });

  it("buckets a 23:59 Berkeley event on day -6 into day -6, not the UTC day after", () => {
    // 2026-10-07T06:59Z is 23:59 PDT on Oct 6, the first day of the window.
    const late = created("u1", new Date("2026-10-07T06:59:00Z"));
    const s = aggregateStats([late], "7d", NOW);
    expect(s.totals.created).toBe(1);
    expect(s.buckets[0].key).toBe("2026-10-06");
    expect(s.buckets[0].created).toBe(1);
    expect(s.buckets[1].created).toBe(0);
  });

  it("applies the same cut to 30d", () => {
    const start30 = windowStart("30d", NOW)!;
    const s = aggregateStats(
      [created("u1", new Date(start30.getTime() - 1)), created("u1", start30)],
      "30d",
      NOW,
    );
    expect(s.totals.created).toBe(1);
    expect(s.since).toEqual(start30);
  });
});

describe("bucket shape", () => {
  it("7d is seven consecutive Berkeley days ending today, all zero for no input", () => {
    const s = aggregateStats([], "7d", NOW);
    expect(s.buckets).toHaveLength(7);
    expect(s.buckets.map((b) => b.key)).toEqual([
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
      "2026-10-12",
    ]);
    expect(s.buckets.at(-1)!.key).toBe(dayKey(NOW));
    expect(s.buckets.map((b) => b.label)).toEqual(["Oct 6", "Oct 7", "Oct 8", "Oct 9", "Oct 10", "Oct 11", "Oct 12"]);
    for (const b of s.buckets) expect(b).toMatchObject({ completed: 0, created: 0, forward: 0 });
  });

  it("30d is thirty consecutive days ending today", () => {
    const s = aggregateStats([], "30d", NOW);
    expect(s.buckets).toHaveLength(30);
    expect(s.buckets[0].key).toBe("2026-09-13");
    expect(s.buckets.at(-1)!.key).toBe("2026-10-12");
    for (let i = 1; i < s.buckets.length; i++) {
      expect(shiftKey(s.buckets[i - 1].key, 1)).toBe(s.buckets[i].key);
    }
  });

  it("uses the Berkeley day for 'today' even when UTC has moved on", () => {
    // 23:30 PDT Oct 11 is already Oct 12 in UTC; the last bucket must be Oct 11.
    const s = aggregateStats([], "7d", new Date("2026-10-12T06:30:00Z"));
    expect(s.buckets.at(-1)!.key).toBe("2026-10-11");
  });

  it("all is 52 weekly buckets keyed by Monday, ending with this week", () => {
    const s = aggregateStats([], "all", NOW);
    expect(s.buckets).toHaveLength(ALL_TIME_WEEKS);
    expect(ALL_TIME_WEEKS).toBe(52);
    for (const b of s.buckets) {
      expect(mondayOf(b.key), b.key).toBe(b.key);
    }
    expect(s.buckets.at(-1)!.key).toBe("2026-10-12");
    expect(s.buckets[0].key).toBe(shiftKey("2026-10-12", -7 * 51));
    for (let i = 1; i < s.buckets.length; i++) {
      expect(shiftKey(s.buckets[i - 1].key, 7)).toBe(s.buckets[i].key);
    }
    expect(s.since).toBeNull();
  });

  it("this week's bucket is the Monday even when now is a Sunday", () => {
    const sunday = new Date("2026-10-11T20:00:00Z");
    const s = aggregateStats([], "all", sunday);
    expect(s.buckets.at(-1)!.key).toBe("2026-10-05");
  });

  it("lands a Sunday event in the bucket of the preceding Monday", () => {
    // 2026-10-11 is a Sunday in Berkeley (and in UTC at this hour).
    const s = aggregateStats([created("u1", new Date("2026-10-11T20:00:00Z"))], "all", NOW);
    const week = s.buckets.find((b) => b.key === "2026-10-05")!;
    expect(week.created).toBe(1);
    expect(s.buckets.find((b) => b.key === "2026-10-12")!.created).toBe(0);
  });

  it("counts a 60-week-old event in totals and users but draws it in no bucket", () => {
    const s = aggregateStats([created("u1", daysAgo(60 * 7))], "all", NOW);
    expect(s.totals.created).toBe(1);
    expect(s.users).toEqual([{ actorId: "u1", completed: 0, created: 1, forward: 0 }]);
    expect(s.buckets.reduce((n, b) => n + b.created, 0)).toBe(0);
  });

  it("draws an event stamped after now (database clock ahead) in the last bucket", () => {
    // Postgres sets createdAt with its own now(); a row a few seconds "in the
    // future" must still be a bar, or the histogram no longer sums to totals.
    const future = created("u1", new Date(NOW.getTime() + 5_000));
    for (const window of ["7d", "30d", "all"] as const) {
      const s = aggregateStats([future], window, NOW);
      expect(s.totals.created, window).toBe(1);
      expect(s.buckets.at(-1)!.created, window).toBe(1);
      expect(s.buckets.reduce((n, b) => n + b.created, 0), window).toBe(1);
    }
    // Even a whole day / week ahead lands in today's bar rather than nowhere.
    const nextDay = created("u1", new Date("2026-10-13T20:00:00Z"));
    expect(aggregateStats([nextDay], "7d", NOW).buckets.at(-1)!.created).toBe(1);
    const nextWeek = created("u1", new Date("2026-10-20T20:00:00Z"));
    expect(aggregateStats([nextWeek], "all", NOW).buckets.at(-1)!.created).toBe(1);
  });

  it("emptyBuckets is what aggregateStats starts from", () => {
    expect(aggregateStats([], "30d", NOW).buckets).toEqual(emptyBuckets("30d", NOW));
  });
});

describe("disjointness", () => {
  const mixed: StatEvent[] = [
    created("u1", daysAgo(1)),
    created("u2", daysAgo(2)),
    statusChange("todo", "done", { actorId: "u1", createdAt: daysAgo(1) }),
    statusChange("backlog", "in_progress", { actorId: "u2", createdAt: daysAgo(3) }),
    statusChange("in_progress", "todo", { actorId: "u2", createdAt: daysAgo(3) }), // backward
    statusChange("done", "done", { actorId: "u3", createdAt: daysAgo(0) }),
    statusChange("blocked", "done", { actorId: "u3", createdAt: daysAgo(0) }),
    statusChange("todo", "done", { actorId: "u3", createdAt: daysAgo(4), field: "priority" }),
    { actorId: "u3", kind: "assigned", field: null, fromValue: null, toValue: "Ada", createdAt: daysAgo(4) },
    statusChange(null, "done", { actorId: "u3", createdAt: daysAgo(5) }),
  ];

  it("totals equal the number of classified events, and bucket sums equal totals", () => {
    const classified = mixed.filter((e) => classifyActivity(e) !== null).length;
    expect(classified).toBe(5);
    for (const window of ["7d", "30d"] as const) {
      const s = aggregateStats(mixed, window, NOW);
      expect(s.totals.completed + s.totals.created + s.totals.forward).toBe(classified);
      expect(s.totals).toEqual({ completed: 2, created: 2, forward: 1 });
      const sum = s.buckets.reduce(
        (acc, b) => ({
          completed: acc.completed + b.completed,
          created: acc.created + b.created,
          forward: acc.forward + b.forward,
        }),
        { completed: 0, created: 0, forward: 0 },
      );
      expect(sum).toEqual(s.totals);
    }
  });

  it("per-user rows sum to the totals", () => {
    const s = aggregateStats(mixed, "7d", NOW);
    const sum = s.users.reduce(
      (acc, u) => ({
        completed: acc.completed + u.completed,
        created: acc.created + u.created,
        forward: acc.forward + u.forward,
      }),
      { completed: 0, created: 0, forward: 0 },
    );
    expect(sum).toEqual(s.totals);
  });
});

describe("windows are monotonic", () => {
  const events: StatEvent[] = [
    created("u1", daysAgo(2)),
    statusChange("todo", "done", { createdAt: daysAgo(2) }),
    created("u1", daysAgo(20)),
    statusChange("backlog", "todo", { createdAt: daysAgo(20) }),
    created("u1", daysAgo(200)),
    statusChange("in_progress", "done", { createdAt: daysAgo(200) }),
  ];

  it("7d <= 30d <= all, with the exact numbers", () => {
    const s7 = aggregateStats(events, "7d", NOW);
    const s30 = aggregateStats(events, "30d", NOW);
    const sAll = aggregateStats(events, "all", NOW);
    expect(s7.totals).toEqual({ completed: 1, created: 1, forward: 0 });
    expect(s30.totals).toEqual({ completed: 1, created: 2, forward: 1 });
    expect(sAll.totals).toEqual({ completed: 2, created: 3, forward: 1 });
    for (const k of ["completed", "created", "forward"] as const) {
      expect(s7.totals[k]).toBeLessThanOrEqual(s30.totals[k]);
      expect(s30.totals[k]).toBeLessThanOrEqual(sAll.totals[k]);
    }
    // 200 days is inside the 52-week chart, so every all-time event is drawn.
    expect(sAll.buckets.reduce((n, b) => n + b.completed + b.created + b.forward, 0)).toBe(6);
  });
});

describe("leaderboard", () => {
  it("has no row for a user whose only events are outside the window or unclassified", () => {
    const s = aggregateStats(
      [
        created("old", daysAgo(10)),
        statusChange("in_progress", "backlog", { actorId: "backwards", createdAt: daysAgo(1) }),
        { actorId: "assigner", kind: "assigned", field: null, fromValue: null, toValue: "x", createdAt: daysAgo(1) },
        created("fresh", daysAgo(1)),
      ],
      "7d",
      NOW,
    );
    expect(s.users.map((u) => u.actorId)).toEqual(["fresh"]);
  });

  it("sorts by completed, then created, then forward, then id", () => {
    const s = aggregateStats(
      [
        // b: 1 completed, 0 created
        statusChange("todo", "done", { actorId: "b", createdAt: daysAgo(1) }),
        // a: 1 completed, 1 created -> above b
        statusChange("todo", "done", { actorId: "a", createdAt: daysAgo(1) }),
        created("a", daysAgo(1)),
        // c: 0 completed, 3 created, 0 forward -> below both
        created("c", daysAgo(1)),
        created("c", daysAgo(1)),
        created("c", daysAgo(1)),
        // d: 0 completed, 3 created, 1 forward -> above c
        created("d", daysAgo(1)),
        created("d", daysAgo(1)),
        created("d", daysAgo(1)),
        statusChange("backlog", "todo", { actorId: "d", createdAt: daysAgo(1) }),
        // e and f: identical counts -> alphabetical
        statusChange("backlog", "in_progress", { actorId: "f", createdAt: daysAgo(1) }),
        statusChange("backlog", "in_progress", { actorId: "e", createdAt: daysAgo(1) }),
      ],
      "7d",
      NOW,
    );
    expect(s.users.map((u) => u.actorId)).toEqual(["a", "b", "d", "c", "e", "f"]);
    expect(s.users[0]).toEqual({ actorId: "a", completed: 1, created: 1, forward: 0 });
    expect(s.users[2]).toEqual({ actorId: "d", completed: 0, created: 3, forward: 1 });
  });

  it("sortUserStats breaks final ties on the given label without touching the input", () => {
    const rows = [
      { actorId: "2", name: "Zed", completed: 1, created: 0, forward: 0 },
      { actorId: "1", name: "Ada", completed: 1, created: 0, forward: 0 },
      { actorId: "3", name: "Bob", completed: 2, created: 0, forward: 0 },
    ];
    const sorted = sortUserStats(rows, (u) => u.name);
    expect(sorted.map((u) => u.name)).toEqual(["Bob", "Ada", "Zed"]);
    expect(rows.map((u) => u.name)).toEqual(["Zed", "Ada", "Bob"]);
  });
});

describe("empty input", () => {
  it("has no users, zero totals and a full zero-filled histogram in every window", () => {
    for (const window of ["7d", "30d", "all"] as const) {
      const s = aggregateStats([], window, NOW);
      expect(s.window).toBe(window);
      expect(s.users).toEqual([]);
      expect(s.totals).toEqual({ completed: 0, created: 0, forward: 0 });
      expect(s.buckets.length).toBe(window === "7d" ? 7 : window === "30d" ? 30 : 52);
      expect(s.buckets.every((b) => b.completed === 0 && b.created === 0 && b.forward === 0)).toBe(true);
    }
  });
});
