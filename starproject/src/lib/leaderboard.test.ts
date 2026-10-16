import { describe, expect, it } from "vitest";

import {
  type LeaderRow,
  buildLeaderRows,
  buildSubteamSections,
  filterSections,
  parseTeam,
  withPoints,
  formatPoints,
  parseDir,
  parseSort,
  shareLabel,
  sortLeaderRows,
  splitPoints,
} from "@/lib/leaderboard";

const DONE = new Date("2026-10-10T12:00:00Z");
const ADMINS = new Set(["sam"]);
const isAdminId = (id: string) => ADMINS.has(id);

describe("splitPoints", () => {
  it("splits a task's points evenly between its assignees", () => {
    const m = splitPoints([{ points: 30, completedAt: DONE, assigneeIds: ["riley", "jordan", "casey"] }], isAdminId, null);
    expect(Object.fromEntries(m)).toEqual({ riley: 10, jordan: 10, casey: 10 });
  });

  it("keeps an uneven share exact", () => {
    const m = splitPoints([{ points: 10, completedAt: DONE, assigneeIds: ["a", "b", "c"] }], isAdminId, null);
    expect(m.get("a")).toBeCloseTo(10 / 3, 12);
    expect([...m.values()].reduce((x, y) => x + y)).toBeCloseTo(10, 12);
  });

  it("gives admins nothing and splits among the members only", () => {
    const m = splitPoints([{ points: 20, completedAt: DONE, assigneeIds: ["riley", "sam", "avery"] }], isAdminId, null);
    expect(Object.fromEntries(m)).toEqual({ riley: 10, avery: 10 });
  });

  it("gives the points to nobody when only admins or no one is assigned", () => {
    const m = splitPoints(
      [
        { points: 15, completedAt: DONE, assigneeIds: [] },
        { points: 15, completedAt: DONE, assigneeIds: ["sam"] },
      ],
      isAdminId,
      null,
    );
    expect(m.size).toBe(0);
  });

  it("counts a finished task with no points set as 1, split like any other", () => {
    const m = splitPoints(
      [
        { points: null, completedAt: DONE, assigneeIds: ["a"] },
        { points: null, completedAt: DONE, assigneeIds: ["a", "b"] },
      ],
      isAdminId,
      null,
    );
    expect(Object.fromEntries(m)).toEqual({ a: 1.5, b: 0.5 });
  });

  it("skips tasks that are not done, set to 0, or finished before the window", () => {
    const since = new Date("2026-10-01T00:00:00Z");
    const m = splitPoints(
      [
        { points: 10, completedAt: null, assigneeIds: ["a"] },
        { points: null, completedAt: null, assigneeIds: ["a"] },
        { points: 0, completedAt: DONE, assigneeIds: ["a"] },
        { points: 10, completedAt: new Date("2026-09-30T23:59:59Z"), assigneeIds: ["a"] },
        { points: 4, completedAt: since, assigneeIds: ["a"] },
      ],
      isAdminId,
      since,
    );
    expect(Object.fromEntries(m)).toEqual({ a: 4 });
  });

  it("counts a person listed twice once", () => {
    const m = splitPoints([{ points: 10, completedAt: DONE, assigneeIds: ["a", "a", "b"] }], isAdminId, null);
    expect(Object.fromEntries(m)).toEqual({ a: 5, b: 5 });
  });

  it("adds up shares across tasks", () => {
    const m = splitPoints(
      [
        { points: 10, completedAt: DONE, assigneeIds: ["a"] },
        { points: 6, completedAt: DONE, assigneeIds: ["a", "b"] },
      ],
      isAdminId,
      null,
    );
    expect(Object.fromEntries(m)).toEqual({ a: 13, b: 3 });
  });
});

describe("buildLeaderRows", () => {
  const names = new Map([
    ["a", "Alex"],
    ["b", "Blake"],
    ["sam", "Sam"],
  ]);

  it("merges activity counts and points, and never lists an admin", () => {
    const rows = buildLeaderRows(
      [
        { actorId: "a", completed: 2, created: 1, forward: 3 },
        { actorId: "sam", completed: 9, created: 9, forward: 9 },
      ],
      new Map([["b", 7]]),
      names,
      isAdminId,
    );
    expect(rows).toEqual([
      { userId: "a", name: "Alex", points: 0, completed: 2, created: 1, forward: 3, total: 6 },
      { userId: "b", name: "Blake", points: 7, completed: 0, created: 0, forward: 0, total: 0 },
    ]);
  });
});

describe("sortLeaderRows", () => {
  const row = (name: string, points: number, completed: number, created: number, forward: number): LeaderRow => ({
    userId: name,
    name,
    points,
    completed,
    created,
    forward,
    total: completed + created + forward,
  });
  const rows = [row("Cam", 5, 1, 1, 1), row("Ari", 20, 0, 4, 0), row("Bo", 5, 3, 0, 3), row("Dee", 12, 2, 0, 0)];
  const names = (r: LeaderRow[]) => r.map((x) => x.name);

  it("sorts by points, most first, by default direction", () => {
    expect(names(sortLeaderRows(rows, "points", "desc"))).toEqual(["Ari", "Dee", "Bo", "Cam"]);
  });

  it("sorts by any column and flips with dir", () => {
    expect(names(sortLeaderRows(rows, "created", "desc"))).toEqual(["Ari", "Cam", "Bo", "Dee"]);
    expect(names(sortLeaderRows(rows, "completed", "asc"))).toEqual(["Ari", "Cam", "Dee", "Bo"]);
  });

  it("breaks ties by total, then name", () => {
    // Bo and Cam both have 5 points: Bo has the larger total.
    expect(names(sortLeaderRows(rows, "points", "asc")).slice(0, 2)).toEqual(["Bo", "Cam"]);
    const tied = [row("Zed", 1, 1, 0, 0), row("Amy", 1, 1, 0, 0)];
    expect(names(sortLeaderRows(tied, "points", "desc"))).toEqual(["Amy", "Zed"]);
  });

  it("does not reorder its input", () => {
    const before = names(rows);
    sortLeaderRows(rows, "total", "desc");
    expect(names(rows)).toEqual(before);
  });
});

describe("parsing and formatting", () => {
  it("defaults an unknown sort to points and an unknown dir to desc", () => {
    expect(parseSort(undefined)).toBe("points");
    expect(parseSort("bogus")).toBe("points");
    expect(parseSort("forward")).toBe("forward");
    expect(parseDir("asc")).toBe("asc");
    expect(parseDir("sideways")).toBe("desc");
  });

  it("formats points to one decimal at most", () => {
    expect(formatPoints(10 / 3)).toBe("3.3");
    expect(formatPoints(20 / 3)).toBe("6.7");
    expect(formatPoints(10)).toBe("10");
    expect(formatPoints(0)).toBe("0");
    expect(formatPoints((10 / 3) * 3)).toBe("10");
  });

  it("labels a split only when there is more than one member", () => {
    expect(shareLabel(30, 3)).toBe("10 each");
    expect(shareLabel(10, 3)).toBe("3.3 each");
    expect(shareLabel(30, 1)).toBeNull();
    expect(shareLabel(30, 0)).toBeNull();
    expect(shareLabel(null, 2)).toBeNull();
  });
});

describe("buildSubteamSections", () => {
  const now = new Date("2026-10-12T20:00:00Z");
  const names = new Map([
    ["a", "Alex"],
    ["b", "Blake"],
    ["sam", "Sam"],
  ]);
  const subteams = [
    { id: "eng", name: "Engine", color: "#f00" },
    { id: "av", name: "Avionics", color: null },
    { id: "empty", name: "Empty", color: null },
  ].sort((x, y) => x.name.localeCompare(y.name));
  const done = (actorId: string, subteamId: string | null) => ({
    actorId,
    kind: "updated",
    field: "status",
    fromValue: "In progress",
    toValue: "Done",
    createdAt: new Date("2026-10-10T12:00:00Z"),
    subteamId,
  });
  const build = (over: Partial<Parameters<typeof buildSubteamSections>[0]> = {}) =>
    buildSubteamSections({
      events: [],
      tasks: [],
      subteams,
      names,
      isAdminId,
      window: "30d",
      now,
      since: null,
      sort: "points",
      dir: "desc",
      ...over,
    });

  it("ranks each subteam on its own tasks, listing a person in every subteam they worked in", () => {
    const sections = build({
      tasks: [
        { points: 30, completedAt: DONE, assigneeIds: ["a", "b"], subteamId: "eng" },
        { points: 8, completedAt: DONE, assigneeIds: ["a"], subteamId: "av" },
      ],
      events: [done("b", "eng")],
    });
    expect(sections.map((s) => [s.name, s.rows.map((r) => [r.name, r.points, r.completed])])).toEqual([
      ["Avionics", [["Alex", 8, 0]]],
      ["Engine", [["Blake", 15, 1], ["Alex", 15, 0]]],
    ]);
  });

  it("leaves out work with no subteam, or a deleted one: there is no No subteam section", () => {
    const sections = build({
      tasks: [
        { points: 5, completedAt: DONE, assigneeIds: ["a"], subteamId: null },
        { points: 5, completedAt: DONE, assigneeIds: ["a"], subteamId: "gone" },
        { points: 1, completedAt: DONE, assigneeIds: ["b"], subteamId: "eng" },
      ],
    });
    expect(sections.map((s) => s.name)).toEqual(["Engine"]);
    expect(sections[0].rows.map((r) => r.name)).toEqual(["Blake"]);
  });

  it("leaves out empty subteams and never lists an admin", () => {
    const sections = build({
      tasks: [{ points: 9, completedAt: DONE, assigneeIds: ["sam"], subteamId: "eng" }],
      events: [done("sam", "av")],
    });
    expect(sections).toEqual([]);
  });

});

describe("the subteam filter", () => {
  it("parses ?team= to one subteam, or null for All", () => {
    expect(parseTeam(undefined)).toBeNull();
    expect(parseTeam("")).toBeNull();
    expect(parseTeam("  ")).toBeNull();
    expect(parseTeam("prop")).toBe("prop");
  });

  it("shows every subteam for All and only the chosen one otherwise", () => {
    const sec = (subteamId: string) => ({ subteamId, name: subteamId, color: null, rows: [] });
    const sections = [sec("av"), sec("prop"), sec("ops")];
    expect(filterSections(sections, null).map((s) => s.subteamId)).toEqual(["av", "prop", "ops"]);
    expect(filterSections(sections, "prop").map((s) => s.subteamId)).toEqual(["prop"]);
    expect(filterSections(sections, "gone")).toEqual([]);
  });
});

describe("withPoints", () => {
  const row = (name: string, points: number): LeaderRow => ({
    userId: name,
    name,
    points,
    completed: 1,
    created: 0,
    forward: 0,
    total: 1,
  });

  it("keeps only people with points, and drops a subteam left with nobody", () => {
    const out = withPoints([
      { subteamId: "prop", name: "Propulsion", color: null, rows: [row("Riley", 55), row("Sam", 0)] },
      { subteamId: "ops", name: "Operations", color: null, rows: [row("Sam", 0)] },
    ]);
    expect(out.map((s) => [s.name, s.rows.map((r) => r.name)])).toEqual([["Propulsion", ["Riley"]]]);
  });
});
