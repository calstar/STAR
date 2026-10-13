import { describe, expect, it } from "vitest";

import type { BoardTask } from "@/lib/board";
import { dayOf, toGanttTasks, toTimeline } from "@/lib/gantt";

type Blocker = { blockedByTask: { id: string; title: string; status: "todo" } };

function task(
  id: string,
  start: string | null,
  blockedBy: Blocker[] = [],
): BoardTask {
  return {
    id,
    title: id,
    status: "todo",
    projectId: "p",
    assignees: [],
    startDate: start ? new Date(`${start}T00:00:00Z`) : null,
    dueDate: start ? new Date(`${start}T00:00:00Z`) : null,
    blockedBy,
  } as unknown as BoardTask;
}

const blocks = (id: string): Blocker => ({
  blockedByTask: { id, title: id, status: "todo" },
});

const flat = (ts: BoardTask[]) =>
  toTimeline(ts).groups.flatMap((g) => g.items);

describe("toTimeline", () => {
  it("counts tasks without dates as unscheduled and drops them", () => {
    const { groups, unscheduled } = toTimeline([
      task("a", "2026-01-01"),
      task("b", null),
      task("c", null),
    ]);
    expect(groups.flatMap((g) => g.items).map((t) => t.id)).toEqual(["a"]);
    expect(unscheduled.map((t) => t.id)).toEqual(["b", "c"]);
  });

  it("keeps blocker-connected tasks adjacent, ordered by start within a group", () => {
    // b is blocked by a; c is unrelated. By raw start date the order would be
    // b, c, a — but grouping keeps {a,b} together (sorted by start: b, a).
    const scheduled = flat([
      task("a", "2026-01-10"),
      task("b", "2026-01-01", [blocks("a")]),
      task("c", "2026-01-05"),
    ]);
    const ids = scheduled.map((t) => t.id);
    expect(ids).toEqual(["b", "a", "c"]);
    // a and b end up in adjacent rows.
    expect(Math.abs(ids.indexOf("a") - ids.indexOf("b"))).toBe(1);
  });

  it("groups transitive blocker chains together", () => {
    // Chain: c blocked by b blocked by a, plus an unrelated early task d.
    const scheduled = flat([
      task("a", "2026-02-01"),
      task("b", "2026-02-02", [blocks("a")]),
      task("c", "2026-02-03", [blocks("b")]),
      task("d", "2026-01-01"),
    ]);
    const ids = scheduled.map((t) => t.id);
    // d (earliest) leads; the a-b-c chain stays contiguous after it.
    expect(ids[0]).toBe("d");
    expect(ids.slice(1)).toEqual(["a", "b", "c"]);
  });

  it("ignores blocker edges to tasks that aren't on the chart", () => {
    // a's blocker has no dates, so it's unscheduled; a becomes a singleton.
    const scheduled = flat([
      task("a", "2026-01-02", [blocks("ghost")]),
      task("ghost", null),
    ]);
    expect(scheduled.map((t) => t.id)).toEqual(["a"]);
    expect(scheduled[0].deps).toEqual([]);
  });
});

describe("toTimeline groups and markers", () => {
  it("groups by subproject, else project, ordered by earliest start", () => {
    const sub = (id: string, start: string, name: string) =>
      ({ ...task(id, start), subproject: { name, color: "#f00" } }) as BoardTask;
    const { groups } = toTimeline([
      task("own", "2026-03-01"),
      sub("m1", "2026-02-01", "Machining"),
      sub("m2", "2026-02-05", "Machining"),
      sub("t1", "2026-01-01", "Thrust Chamber"),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Thrust Chamber", "Machining", "Tasks"]);
    expect(groups[1].items.map((t) => t.id)).toEqual(["m1", "m2"]);
    expect(groups[1].color).toBe("#f00");
  });

  it("marks due-only tasks and overdue open tasks", () => {
    const due = {
      ...task("d", null),
      dueDate: new Date("2026-01-05T00:00:00Z"),
    } as BoardTask;
    const done = { ...task("x", "2026-01-01"), status: "done" } as BoardTask;
    const [x, d] = toTimeline([due, done], dayOf("2026-02-01")).groups[0].items;
    expect(d).toMatchObject({ dueOnly: true, overdue: true });
    expect(d.start).toBe(d.end);
    expect(x).toMatchObject({ dueOnly: false, overdue: false });
  });
});

describe("toTimeline grouping", () => {
  it("'none' puts every task in one chronological group", () => {
    const sub = (id: string, start: string, name: string) =>
      ({ ...task(id, start), subproject: { name, color: null } }) as BoardTask;
    const ts = [
      sub("m", "2026-02-01", "Machining"),
      sub("t", "2026-01-01", "Thrust Chamber"),
      task("own", "2026-01-15"),
    ];
    expect(toTimeline(ts, 0, "subproject").groups).toHaveLength(3);
    const { groups } = toTimeline(ts, 0, "none");
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((t) => t.id)).toEqual(["t", "own", "m"]);
  });
});

describe("toGanttTasks (MCP gantt tool shape)", () => {
  it("flattens to frappe-style rows with comma-joined dependencies", () => {
    const { scheduled, unscheduled } = toGanttTasks([
      task("a", "2026-01-10"),
      task("b", "2026-01-01", [blocks("a")]),
      task("c", null),
    ]);
    expect(unscheduled).toBe(1);
    expect(scheduled).toEqual([
      { id: "b", name: "b", start: "2026-01-01", end: "2026-01-01", progress: 0, dependencies: "a", custom_class: "status-todo" },
      { id: "a", name: "a", start: "2026-01-10", end: "2026-01-10", progress: 0, dependencies: "", custom_class: "status-todo" },
    ]);
  });
});
