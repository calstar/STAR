import { describe, expect, it } from "vitest";

import {
  type BoardTask,
  type WorkspaceTask,
  groupByStatus,
  midpointOrder,
  toRowData,
} from "@/lib/board";

function task(over: Partial<BoardTask>): BoardTask {
  return {
    id: "t",
    title: "Task",
    status: "todo",
    boardOrder: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    startDate: null,
    dueDate: null,
    assignee: null,
    blockedBy: [],
    ...over,
  } as unknown as BoardTask;
}

describe("midpointOrder", () => {
  it("returns 0 for an empty column", () => {
    expect(midpointOrder(undefined, undefined)).toBe(0);
  });
  it("places before the first item", () => {
    expect(midpointOrder(undefined, 5)).toBe(4);
  });
  it("places after the last item", () => {
    expect(midpointOrder(5, undefined)).toBe(6);
  });
  it("places between two items (fractional, no reindex)", () => {
    expect(midpointOrder(2, 4)).toBe(3);
    expect(midpointOrder(2, 3)).toBe(2.5);
  });
});

describe("groupByStatus", () => {
  it("buckets tasks by status", () => {
    const cols = groupByStatus([
      task({ id: "a", status: "todo" }),
      task({ id: "b", status: "done" }),
      task({ id: "c", status: "todo" }),
    ]);
    expect(cols.todo.map((t) => t.id)).toEqual(["a", "c"]);
    expect(cols.done.map((t) => t.id)).toEqual(["b"]);
    expect(cols.backlog).toEqual([]);
    expect(cols.in_progress).toEqual([]);
  });

  it("orders each column by boardOrder then createdAt", () => {
    const cols = groupByStatus([
      task({ id: "later", status: "todo", boardOrder: 2 }),
      task({ id: "earlier", status: "todo", boardOrder: 1 }),
      task({
        id: "tie-old",
        status: "todo",
        boardOrder: 1,
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
    ]);
    // boardOrder 1 before 2; within boardOrder 1, older createdAt first.
    expect(cols.todo.map((t) => t.id)).toEqual(["tie-old", "earlier", "later"]);
  });
});

describe("toRowData", () => {
  const base = (over: Partial<WorkspaceTask>): WorkspaceTask =>
    ({
      ...task({}),
      projectName: "Avionics",
      subteamName: "",
      assigneeName: "Ada L.",
      ...over,
    }) as unknown as WorkspaceTask;

  it("formats the due date as YYYY-MM-DD and flags overdue", () => {
    const row = toRowData(
      base({ dueDate: new Date("2020-01-02T00:00:00Z"), status: "todo" }),
    );
    expect(row.due).toBe("2020-01-02");
    expect(row.overdue).toBe(true);
  });

  it("never marks a done task overdue", () => {
    const row = toRowData(
      base({ dueDate: new Date("2020-01-02T00:00:00Z"), status: "done" }),
    );
    expect(row.overdue).toBe(false);
  });

  it("leaves due empty and not overdue when there is no due date", () => {
    const row = toRowData(base({ dueDate: null }));
    expect(row.due).toBe("");
    expect(row.overdue).toBe(false);
  });

  it("reports blocked when a blocker is not done", () => {
    const blocked = toRowData(
      base({
        blockedBy: [{ blockedByTask: { id: "x", title: "X", status: "todo" } }],
      }),
    );
    const unblocked = toRowData(
      base({
        blockedBy: [{ blockedByTask: { id: "x", title: "X", status: "done" } }],
      }),
    );
    expect(blocked.blocked).toBe(true);
    expect(unblocked.blocked).toBe(false);
  });

  it("defaults subproject to null", () => {
    expect(toRowData(base({})).subproject).toBeNull();
  });
});
