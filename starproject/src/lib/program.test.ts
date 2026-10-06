import { describe, expect, it } from "vitest";

import {
  DEFAULT_PHASES,
  biggestTask,
  clampPhase,
  cleanLink,
  phasesOf,
  programPhase,
  relativeDays,
  rollupSegments,
  type RankableTask,
} from "./program";

const task = (id: string, over: Partial<RankableTask> = {}): RankableTask => ({
  id,
  status: "todo",
  priority: null,
  dueDate: null,
  blocking: [],
  ...over,
});
const blocks = (...statuses: RankableTask["status"][]) =>
  statuses.map((status) => ({ task: { status } }));

describe("phasesOf", () => {
  it("falls back to the default list only when none is set", () => {
    expect(phasesOf({ phases: [] })).toEqual(DEFAULT_PHASES);
    expect(phasesOf({ phases: ["A", "B"] })).toEqual(["A", "B"]);
  });
});

describe("clampPhase", () => {
  it("pulls an index past a shortened list back to 'complete'", () => {
    expect(clampPhase(7, 4)).toBe(4);
    expect(clampPhase(-1, 4)).toBe(0);
    expect(clampPhase(2, 4)).toBe(2);
  });
});

describe("rollupSegments / programPhase", () => {
  it("counts subteams past and in each phase", () => {
    // three subteams: in phase 0, in phase 2, complete (3 of 3)
    const r = rollupSegments([0, 2, 3], 3);
    expect(r[0]).toEqual({ done: 2, active: 1, total: 3 });
    expect(r[1]).toEqual({ done: 2, active: 0, total: 3 });
    expect(r[2]).toEqual({ done: 1, active: 1, total: 3 });
  });
  it("is as far along as the slowest subteam", () => {
    expect(programPhase([4, 1, 3], 5)).toBe(1);
    expect(programPhase([], 5)).toBe(0);
  });
});

describe("biggestTask", () => {
  it("prefers the task blocking the most open work", () => {
    const pick = biggestTask([
      task("high", { priority: "high" }),
      task("blocker", { blocking: blocks("todo", "in_progress") }),
    ]);
    expect(pick?.id).toBe("blocker");
  });
  it("ignores blocked tasks that are already done", () => {
    const pick = biggestTask([
      task("stale", { blocking: blocks("done", "done") }),
      task("high", { priority: "high" }),
    ]);
    expect(pick?.id).toBe("high");
  });
  it("breaks ties by priority, then soonest due date", () => {
    const pick = biggestTask([
      task("later", { priority: "high", dueDate: new Date("2026-12-01") }),
      task("undated", { priority: "high" }),
      task("sooner", { priority: "high", dueDate: new Date("2026-11-01") }),
      task("low", { priority: "low", dueDate: new Date("2026-10-06") }),
    ]);
    expect(pick?.id).toBe("sooner");
  });
  it("never returns a done task", () => {
    expect(biggestTask([task("x", { status: "done", priority: "high" })])).toBeNull();
  });
});

describe("relativeDays", () => {
  it("compares calendar days, not instants", () => {
    const d = new Date("2026-10-08T00:00:00.000Z");
    expect(relativeDays(d, "2026-10-08")).toBe("today");
    expect(relativeDays(d, "2026-10-07")).toBe("tomorrow");
    expect(relativeDays(d, "2026-10-05")).toBe("in 3 days");
    expect(relativeDays(d, "2026-10-10")).toBe("2 days ago");
  });
});

describe("cleanLink", () => {
  it("treats blank as no link", () => {
    expect(cleanLink("")).toBeNull();
    expect(cleanLink("   ")).toBeNull();
    expect(cleanLink(null)).toBeNull();
  });
  it("keeps http(s) links and adds https:// to bare ones", () => {
    expect(cleanLink("https://docs.google.com/presentation/d/abc")).toBe(
      "https://docs.google.com/presentation/d/abc",
    );
    expect(cleanLink("  docs.google.com/x  ")).toBe("https://docs.google.com/x");
  });
  it("refuses anything that could run script or isn't a link", () => {
    expect(() => cleanLink("javascript:alert(1)")).toThrow();
    expect(() => cleanLink("JavaScript:alert(1)")).toThrow();
    expect(() => cleanLink("data:text/html,hi")).toThrow();
    expect(() => cleanLink("not a link")).toThrow();
  });
});
