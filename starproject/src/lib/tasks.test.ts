import { describe, expect, it } from "vitest";

import { archivedForStatusChange } from "@/lib/tasks";

describe("archivedForStatusChange", () => {
  it("archives when a task enters Done", () => {
    expect(archivedForStatusChange("in_progress", "done")).toEqual({ archived: true });
    expect(archivedForStatusChange("todo", "done")).toEqual({ archived: true });
  });

  it("unarchives when a task leaves Done", () => {
    expect(archivedForStatusChange("done", "in_progress")).toEqual({ archived: false });
    expect(archivedForStatusChange("done", "todo")).toEqual({ archived: false });
  });

  it("leaves archived untouched when the transition doesn't cross Done", () => {
    expect(archivedForStatusChange("todo", "in_progress")).toEqual({});
    expect(archivedForStatusChange("backlog", "blocked")).toEqual({});
  });

  it("no-ops when the status is unchanged (e.g. reordering a Done card)", () => {
    expect(archivedForStatusChange("done", "done")).toEqual({});
    expect(archivedForStatusChange("todo", "todo")).toEqual({});
  });
});
