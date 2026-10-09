import { describe, expect, it } from "vitest";

import { toFormData } from "./_shared";
import { boardOrderFor, createTaskFields, updateTaskFields } from "./tasks-write";

// The input→FormData mapping is what createTask / updateTask read, so a key
// that goes missing or a null that stops clearing would silently change what
// the UI and the MCP tool write. The board-order arithmetic mirrors Board.tsx.

const entries = (fd: FormData) => Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]));

describe("createTaskFields", () => {
  it("maps every create field and joins assignees as CSV", () => {
    const fd = toFormData(
      createTaskFields({
        projectId: "p1",
        title: "Order fittings",
        description: "AN-6",
        priority: "high",
        assigneeIds: ["u1", "u2"],
        subteamId: "s1",
        startDate: "2026-10-01",
        dueDate: "2026-10-15",
      }),
    );
    expect(entries(fd)).toEqual({
      projectId: "p1",
      title: "Order fittings",
      description: "AN-6",
      priority: "high",
      assigneeIds: "u1,u2",
      subteamId: "s1",
      startDate: "2026-10-01",
      dueDate: "2026-10-15",
    });
  });

  it("omits optional fields that were not given", () => {
    const fd = toFormData(createTaskFields({ projectId: "p1", title: "Bare" }));
    expect(entries(fd)).toEqual({ projectId: "p1", title: "Bare" });
    expect(fd.has("priority")).toBe(false);
    expect(fd.has("assigneeIds")).toBe(false);
  });

  it("sends an empty assignee list as an empty CSV (no assignees)", () => {
    const fd = toFormData(createTaskFields({ projectId: "p1", title: "Bare", assigneeIds: [] }));
    expect(fd.get("assigneeIds")).toBe("");
  });
});

describe("updateTaskFields", () => {
  it("renames taskId to id and includes only the keys given", () => {
    const fd = toFormData(updateTaskFields({ taskId: "t1", title: "New", status: "in_progress" }));
    expect(entries(fd)).toEqual({ id: "t1", title: "New", status: "in_progress" });
    // Presence is what updateTask keys on: an absent field is left alone.
    expect(fd.has("priority")).toBe(false);
    expect(fd.has("dueDate")).toBe(false);
    expect(fd.has("assigneeIds")).toBe(false);
  });

  it("sends null as an empty string, which is how the UI clears a field", () => {
    const fd = toFormData(
      updateTaskFields({ taskId: "t1", priority: null, subteamId: null, dueDate: null, startDate: null, description: null }),
    );
    expect(entries(fd)).toEqual({ id: "t1", priority: "", subteamId: "", dueDate: "", startDate: "", description: "" });
  });

  it("replaces the assignee set, including with nobody", () => {
    expect(toFormData(updateTaskFields({ taskId: "t1", assigneeIds: ["u1", "u2"] })).get("assigneeIds")).toBe("u1,u2");
    expect(toFormData(updateTaskFields({ taskId: "t1", assigneeIds: [] })).get("assigneeIds")).toBe("");
  });

  it("passes projectId and blockedNote through", () => {
    const fd = toFormData(updateTaskFields({ taskId: "t1", projectId: "p2", blockedNote: "waiting on vendor" }));
    expect(entries(fd)).toEqual({ id: "t1", projectId: "p2", blockedNote: "waiting on vendor" });
  });
});

describe("boardOrderFor", () => {
  const column = [
    { id: "a", boardOrder: 0 },
    { id: "b", boardOrder: 1 },
    { id: "c", boardOrder: 3 },
  ];

  it("uses an explicit boardOrder as given", () => {
    expect(boardOrderFor(column, { boardOrder: 2.5 })).toBe(2.5);
    expect(boardOrderFor(column, { boardOrder: -4, afterTaskId: "a" })).toBe(-4);
  });

  it("appends to the end of the column by default", () => {
    expect(boardOrderFor(column, {})).toBe(4);
  });

  it("lands at 0 in an empty column", () => {
    expect(boardOrderFor([], {})).toBe(0);
  });

  it("slots between the anchor and its next neighbour for afterTaskId", () => {
    expect(boardOrderFor(column, { afterTaskId: "b" })).toBe(2);
    expect(boardOrderFor(column, { afterTaskId: "a" })).toBe(0.5);
    // After the last card: one past it.
    expect(boardOrderFor(column, { afterTaskId: "c" })).toBe(4);
  });

  it("slots between the previous neighbour and the anchor for beforeTaskId", () => {
    expect(boardOrderFor(column, { beforeTaskId: "c" })).toBe(2);
    expect(boardOrderFor(column, { beforeTaskId: "b" })).toBe(0.5);
    // Before the first card: one before it.
    expect(boardOrderFor(column, { beforeTaskId: "a" })).toBe(-1);
  });

  it("refuses an anchor that is not in the column", () => {
    expect(() => boardOrderFor(column, { afterTaskId: "zzz" })).toThrow(/not in the target column/);
  });

  it("refuses both anchors at once", () => {
    expect(() => boardOrderFor(column, { afterTaskId: "a", beforeTaskId: "b" })).toThrow(/not both/);
  });
});
