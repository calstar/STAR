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
    assignees: [],
    blockedBy: [],
    ...over,
  } as unknown as BoardTask;
}

describe("groupByStatus sort options", () => {
  const todos = [
    task({ id: "low-old", priority: "low", createdAt: new Date("2026-01-01"), title: "Zebra", boardOrder: 2 }),
    task({ id: "high-new", priority: "high", createdAt: new Date("2026-03-01"), title: "Apple", boardOrder: 1 }),
    task({ id: "mid", priority: "medium", createdAt: new Date("2026-02-01"), title: "Mango", boardOrder: 0 }),
  ];

  it("priority: high → medium → low", () => {
    expect(groupByStatus(todos, "priority").todo.map((t) => t.id)).toEqual([
      "high-new", "mid", "low-old",
    ]);
  });

  it("created: newest first", () => {
    expect(groupByStatus(todos, "created").todo.map((t) => t.id)).toEqual([
      "high-new", "mid", "low-old",
    ]);
  });

  it("title: A→Z (Apple, Mango, Zebra)", () => {
    expect(groupByStatus(todos, "title").todo.map((t) => t.id)).toEqual([
      "high-new", "mid", "low-old",
    ]);
  });

  it("manual: by boardOrder", () => {
    expect(groupByStatus(todos, "manual").todo.map((t) => t.id)).toEqual([
      "mid", "high-new", "low-old",
    ]);
  });
});

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

  it("orders non-done columns by soonest due date first, undated last", () => {
    const cols = groupByStatus([
      task({ id: "soon", status: "todo", dueDate: new Date("2026-02-01") }),
      task({ id: "overdue", status: "todo", dueDate: new Date("2020-01-01") }),
      task({ id: "later", status: "todo", dueDate: new Date("2026-06-01") }),
      task({ id: "undated", status: "todo", dueDate: null }),
    ]);
    // Overdue/soonest float to the top; the task with no due date sinks last.
    expect(cols.todo.map((t) => t.id)).toEqual([
      "overdue",
      "soon",
      "later",
      "undated",
    ]);
  });

  it("orders the done column by most-recently-due first, undated last", () => {
    const cols = groupByStatus([
      task({ id: "old", status: "done", dueDate: new Date("2026-01-01") }),
      task({ id: "recent", status: "done", dueDate: new Date("2026-06-01") }),
      task({ id: "undated", status: "done", dueDate: null }),
    ]);
    expect(cols.done.map((t) => t.id)).toEqual(["recent", "old", "undated"]);
  });

  it("breaks ties on equal or absent due dates by boardOrder then createdAt", () => {
    const cols = groupByStatus([
      task({ id: "later", status: "todo", boardOrder: 2, dueDate: null }),
      task({ id: "earlier", status: "todo", boardOrder: 1, dueDate: null }),
      task({
        id: "tie-old",
        status: "todo",
        boardOrder: 1,
        dueDate: null,
        createdAt: new Date("2025-01-01T00:00:00Z"),
      }),
    ]);
    // Same (absent) due date → boardOrder 1 before 2; within 1, older createdAt first.
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

  it("carries every assignee id and the joined name", () => {
    const row = toRowData(
      base({
        assignees: [
          { id: "u1", name: "Ada Lovelace", email: "a@x", displayName: null },
          { id: "u2", name: "Grace Hopper", email: "g@x", displayName: null },
        ],
        assigneeName: "Ada L., Grace H.",
      }),
    );
    expect(row.assigneeIds).toEqual(["u1", "u2"]);
    expect(row.assigneeName).toBe("Ada L., Grace H.");
  });
});
