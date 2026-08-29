import { describe, expect, it } from "vitest";

import type { BoardTask } from "@/lib/board";
import { toGanttTasks } from "@/lib/gantt";

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
    startDate: start ? new Date(`${start}T00:00:00Z`) : null,
    dueDate: start ? new Date(`${start}T00:00:00Z`) : null,
    blockedBy,
  } as unknown as BoardTask;
}

const blocks = (id: string): Blocker => ({
  blockedByTask: { id, title: id, status: "todo" },
});

describe("toGanttTasks", () => {
  it("counts tasks without dates as unscheduled and drops them", () => {
    const { scheduled, unscheduled } = toGanttTasks([
      task("a", "2026-01-01"),
      task("b", null),
      task("c", null),
    ]);
    expect(scheduled.map((t) => t.id)).toEqual(["a"]);
    expect(unscheduled).toBe(2);
  });

  it("keeps blocker-connected tasks adjacent, ordered by start within a group", () => {
    // b is blocked by a; c is unrelated. By raw start date the order would be
    // b, c, a — but grouping keeps {a,b} together (sorted by start: b, a).
    const { scheduled } = toGanttTasks([
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
    const { scheduled } = toGanttTasks([
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
    const { scheduled } = toGanttTasks([
      task("a", "2026-01-02", [blocks("ghost")]),
      task("ghost", null),
    ]);
    expect(scheduled.map((t) => t.id)).toEqual(["a"]);
    expect(scheduled[0].dependencies).toBe("");
  });
});
